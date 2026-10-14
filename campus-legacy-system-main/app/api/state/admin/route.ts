import { q, one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { canEdit, clean, allRoles, LOCKED, BUILTIN } from '@/lib/perm';
import { listTrash, restore, purge, bin } from '@/lib/trash';
import type { Kind } from '@/lib/trash';
import { removeObject, listObjects, keyOf, r2Ready } from '@/lib/r2';
import { note } from '@/lib/log';

/**
 * Administration: the recycle bin, the roles, and clearing the project.
 *
 * Everything here needs `admin: edit`, which only the administrator's own
 * role has to begin with. The destructive parts additionally want the
 * project code typed out, because a button that empties a project should not
 * be one slip of a thumb away.
 */
const CODE = 'DIU-CL25-2026';

async function gate() {
  const me = await requireUser();
  if (!(await canEdit(me.role, 'admin')))
    throw new HttpError(403, 'Administration is not open to your role.');
  return me;
}

/* What a reset clears, parents before children so nothing is orphaned.

   The Chairman's reference is on the list. It was left off at first on the
   grounds that it is the original workbook rather than working data — which
   is true, and was also invisible: the page said "clear the project" and
   that table quietly stayed behind. It goes to the bin like everything
   else, and can be put back.

   Users, departments and the roles are not on the list. Without them there
   is no way back into the application. */
const WORK: { kind: Kind; table: string; order: string }[] = [
  { kind: 'task',        table: 'tasks',         order: 'parent_id nulls first, id' },
  { kind: 'budget',      table: 'budget_lines',  order: 'id' },
  { kind: 'approval',    table: 'approvals',     order: 'id' },
  { kind: 'milestone',   table: 'milestones',    order: 'id' },
  { kind: 'survey',      table: 'survey',        order: 'id' },
  { kind: 'team',        table: 'student_teams', order: 'id' },
  { kind: 'student_day', table: 'student_days',  order: 'id' },
  { kind: 'photo',       table: 'photos',        order: 'id' },
];

/* Rows with no id of their own, so they cannot go to the bin one at a time.
   They are cleared with the records they belong to and, where it matters,
   travel into the bin as part of them — task_roles goes with its task. */
const SIDE_TABLES = ['task_roles', 'chairman_reference', 'approval_steps'];

export async function GET() {
  try {
    await gate();
    return Response.json({
      trash: await listTrash(),
      roles: await allRoles(),
      locked: LOCKED,
      builtin: Object.keys(BUILTIN),
      counts: await counts(),
      link: await chairmanLink(),
    });
  } catch (e) { return fail(e); }
}

/* ------------------------------------------------- the Chairman's link --
   A read-only overview of the project behind an address with no sign-in, so
   it can be sent to somebody who will never hold an account here.

   The address is the whole of the protection, and it was chosen by hand
   rather than generated, so it is only as good as the words in it. It can be
   switched off from this page at any moment, and switching it off kills the
   link that is already out there.

   What the page serves is set out in app/c/[slug]/route.ts: roll-ups, gate
   dates and task titles. No email address, no telephone number, no money
   that is not already a project total, and nothing writable. */
export type ChairLink = { slug: string; on: boolean; setBy?: string; setAt?: string };

async function chairmanLink(): Promise<ChairLink> {
  const row = await one(`select value from settings where key='chairman_link'`);
  const v = (row && row.value) || {};
  return { slug: String(v.slug || ''), on: !!v.on, setBy: v.setBy || '', setAt: v.setAt || '' };
}

/** Letters, numbers, dashes and underscores. Nothing that could be a path. */
export function cleanSlug(s: string) {
  return String(s || '').trim().replace(/^\/+|\/+$/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
}

/* ------------------------------------------------------ what is stored --
   The bucket only ever grows, and nothing on screen could say why.

   A photograph taken off a task keeps its file deliberately: it was part
   of an audit record once, and those should not vanish because somebody
   pressed Remove. An upload interrupted halfway keeps its file too, for no
   reason at all — the browser closed before the record was written, so
   nothing will ever point at it and nobody can see it.

   Those two look identical in the bucket. This tells them apart by asking
   the register which keys it still knows about, and sorts every file into
   one of four piles so each can be dealt with on its own terms. */
type Pile = 'live' | 'removed' | 'bin' | 'orphan';

/** A file younger than this may be an upload still in flight. */
const SETTLE_MS = 24 * 60 * 60 * 1000;

function bothKeys(url: string): string[] {
  const k = keyOf(url);
  return k ? [k, k.replace(/\.jpg$/i, '_thumb.jpg')] : [];
}

async function storage() {
  if (!r2Ready()) return { ready: false };

  /* Every key the register can account for, and why. */
  const known = new Map<string, Pile>();
  const mark = (url: string, pile: Pile) => {
    for (const k of bothKeys(url)) if (!known.has(k)) known.set(k, pile);
  };
  for (const p of await q(`select url, deleted_at from photos`))
    mark(p.url, p.deleted_at ? 'removed' : 'live');
  /* Photographs inside a binned task travel with it and come back with it,
     so their files are in use even though no live row points at them. */
  for (const t of await q(`select row, children from trash`)) {
    if (t.row && t.row.url) mark(t.row.url, 'bin');
    for (const ch of (t.children || [])) if (ch.kind === 'photo' && ch.row?.url) mark(ch.row.url, 'bin');
  }

  const files = await listObjects();
  const now = Date.now();
  const tally: Record<Pile | 'young', { n: number; bytes: number }> = {
    live: { n: 0, bytes: 0 }, removed: { n: 0, bytes: 0 },
    bin: { n: 0, bytes: 0 }, orphan: { n: 0, bytes: 0 }, young: { n: 0, bytes: 0 },
  };
  const orphans: { key: string; size: number; at: string }[] = [];

  for (const f of files) {
    const pile = known.get(f.key);
    if (pile) { tally[pile].n++; tally[pile].bytes += f.size; continue; }
    /* Nothing points at it — but a file written in the last day may be an
       upload whose record is still on its way. */
    if (f.at && now - f.at.getTime() < SETTLE_MS) {
      tally.young.n++; tally.young.bytes += f.size; continue;
    }
    tally.orphan.n++; tally.orphan.bytes += f.size;
    if (orphans.length < 200)
      orphans.push({ key: f.key, size: f.size, at: f.at ? f.at.toISOString() : '' });
  }

  return {
    ready: true, total: files.length,
    bytes: files.reduce((a, f) => a + f.size, 0),
    tally, orphans, capped: files.length >= 10_000,
  };
}

/** Take a pile out of the bucket for good. */
async function sweep(me: any, which: 'orphan' | 'removed') {
  if (!r2Ready()) throw new HttpError(503, 'Photograph storage is not configured.');
  const now = Date.now();
  let gone = 0, bytes = 0;

  if (which === 'removed') {
    /* Files whose record says it was taken off the register. The rows stay
       — the trail of who removed what and why is the point — but the
       picture itself goes. */
    const rows = await q(`select id, url from photos where deleted_at is not null`);
    for (const r of rows) {
      for (const k of bothKeys(r.url)) { await removeObject(k).catch(() => {}); gone++; }
    }
    await tx(async (c) => {
      await c.query(`update photos set url='', thumb_url='' where deleted_at is not null`);
      await note(c, me, 'settings', 'storage',
        `deleted the files of ${rows.length} photograph${rows.length === 1 ? '' : 's'} `
        + `already off the register`);
    });
    return { gone, files: rows.length };
  }

  const s = await storage();
  if (!s.ready) throw new HttpError(503, 'Photograph storage is not configured.');
  for (const f of (s.orphans || [])) {
    if (f.at && now - Date.parse(f.at) < SETTLE_MS) continue;
    await removeObject(f.key).catch(() => {});
    gone++; bytes += f.size;
  }
  await tx(async (c) => {
    await note(c, me, 'settings', 'storage',
      `deleted ${gone} file${gone === 1 ? '' : 's'} that no record pointed at`);
  });
  return { gone, bytes };
}

async function counts() {
  const out: Record<string, number> = {};
  for (const w of WORK)
    out[w.kind] = Number((await one(`select count(*)::int as n from ${w.table}`))?.n || 0);
  out.trash = Number((await one(`select count(*)::int as n from trash`))?.n || 0);
  return out;
}

export async function POST(req: Request) {
  try {
    const me = await gate();
    const body = await req.json();
    const act = String(body.act || '');

    /* ---- the recycle bin ---- */
    if (act === 'restore') {
      const r = await restore(me, Number(body.id));
      return Response.json({ ok: true, restored: r });
    }
    if (act === 'purge') {
      const r = await purge(me, body.id ? Number(body.id) : undefined);
      return Response.json({ ok: true, purged: r });
    }

    /* ---- what is in the bucket ---- */
    if (act === 'storage') return Response.json({ ok: true, storage: await storage() });
    if (act === 'sweep') {
      const which = body.which === 'removed' ? 'removed' : 'orphan';
      if (String(body.confirm || '').trim().toUpperCase() !== CODE)
        throw new HttpError(400, `Type ${CODE} to confirm.`);
      return Response.json({ ok: true, swept: await sweep(me, which) });
    }

    /* ---- the Chairman's link ---- */
    if (act === 'link') {
      const on = !!body.on;
      const slug = cleanSlug(body.slug);
      if (on && !slug) throw new HttpError(400, 'Give the link an address first.');
      if (on && slug.length < 4)
        throw new HttpError(400, 'An address of three characters or fewer is found by accident. Make it longer.');
      const was = await chairmanLink();
      await tx(async (c) => {
        await c.query(
          `insert into settings (key, value, updated_by, updated_at)
             values ('chairman_link', $1::jsonb, $2, now())
           on conflict (key) do update set value=$1::jsonb, updated_by=$2, updated_at=now()`,
          [JSON.stringify({ slug, on, setBy: me.name, setAt: new Date().toISOString() }), me.id]);
        await note(c, me, 'settings', 'chairman_link',
          !on ? 'switched the Chairman\'s link off'
          : was.slug && was.slug !== slug ? `moved the Chairman's link to /c/${slug}`
          : `switched the Chairman's link on at /c/${slug}`);
      });
      return Response.json({ ok: true, link: await chairmanLink() });
    }

    /* ---- roles ---- */
    if (act === 'roles') {
      const list = Array.isArray(body.roles) ? body.roles.map(clean) : [];
      if (!list.length) throw new HttpError(400, 'No roles were sent.');
      if (list.some((r: any) => !r.key)) throw new HttpError(400, 'A role needs a key.');
      /* The administrator's own role is never rewritten from here. Lose it
         and nobody can grant it back. */
      const keep = list.filter((r: any) => !LOCKED.includes(r.key));
      await tx(async (c) => {
        await c.query(
          `insert into settings (key, value, updated_by, updated_at)
             values ('perms', $1::jsonb, $2, now())
           on conflict (key) do update set value=$1::jsonb, updated_by=$2, updated_at=now()`,
          [JSON.stringify({ roles: keep }), me.id]);
        await note(c, me, 'settings', 'perms',
          `changed what ${keep.length} role${keep.length === 1 ? '' : 's'} may reach`);
      });
      return Response.json({ ok: true, roles: await allRoles() });
    }

    /* ---- clearing the project ---- */
    if (act === 'reset' || act === 'erase') {
      if (String(body.confirm || '').trim().toUpperCase() !== CODE)
        throw new HttpError(400, `Type ${CODE} to confirm.`);

      if (act === 'reset') {
        /* Everything the project records goes to the bin, whole and
           restorable. Accounts, departments and roles stay. */
        let moved = 0, ref = 0;
        await tx(async (c) => {
          for (const w of WORK) {
            const rows = await c.query(`select id from ${w.table} order by ${w.order}`);
            for (const r of rows.rows) {
              const done = await bin(c, me, w.kind, String(r.id));
              if (done) moved++;
            }
          }
          /* The Chairman's reference has no id column, so it is kept whole
             as one bin entry rather than one per line. */
          const rows = (await c.query(`select * from chairman_reference order by task_id`)).rows;
          if (rows.length) {
            await c.query(
              `insert into trash (kind, record_id, label, row, children, deleted_by, deleted_name)
               values ('chairman_reference','chairman_reference',$1,'{}'::jsonb,$2::jsonb,$3,$4)
               on conflict (kind, record_id) do update
                 set children = $2::jsonb, deleted_at = now(), label = $1`,
              [`Chairman's tracker — ${rows.length} lines`,
               JSON.stringify(rows.map(r => ({ kind: 'chairman_reference', row: r }))),
               me.id, me.name]);
            await c.query(`delete from chairman_reference`);
            ref = rows.length;
          }
          await note(c, me, 'settings', 'project',
            `reset the register — ${moved} record${moved === 1 ? '' : 's'}`
            + (ref ? ` and the Chairman's tracker (${ref} lines)` : '')
            + ` moved to the recycle bin`);
        });
        return Response.json({ ok: true, moved, reference: ref });
      }

      /* Erase: the bin's photographs leave Cloudflare, then everything the
         project records is gone. There is no step after this one. */
      const keys: string[] = [];
      for (const p of await q(`select url from photos`)) {
        const k = String(p.url || '').split('/').slice(3).join('/');
        if (k) { keys.push(k); keys.push(k.replace(/\.jpg$/i, '_thumb.jpg')); }
      }
      for (const t of await q(`select row, children from trash`)) {
        const add = (r: any) => {
          const k = String((r && r.url) || '').split('/').slice(3).join('/');
          if (k) { keys.push(k); keys.push(k.replace(/\.jpg$/i, '_thumb.jpg')); }
        };
        add(t.row);
        for (const ch of (t.children || [])) if (ch.kind === 'photo') add(ch.row);
      }
      for (const k of keys) await removeObject(k).catch(() => {});

      let wiped = 0;
      await tx(async (c) => {
        await c.query(`delete from trash`);
        await c.query(`delete from approval_steps`);
        for (const w of WORK) {
          const r = await c.query(`delete from ${w.table}`);
          wiped += r.rowCount || 0;
        }
        await c.query(`delete from task_roles`);
        await c.query(`delete from chairman_reference`);
        /* The trail of what just happened is the one thing worth keeping. */
        await note(c, me, 'settings', 'project',
          `erased the project — ${wiped} record${wiped === 1 ? '' : 's'} and `
          + `${keys.length / 2} photograph file(s) deleted for good. `
          + `Accounts, departments and roles were kept.`);
      });
      return Response.json({ ok: true, wiped, files: keys.length / 2 });
    }

    throw new HttpError(400, 'That is not something this page does.');
  } catch (e) { return fail(e); }
}

import { gunzipSync } from 'node:zlib';
import { q, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { canEdit } from '@/lib/perm';
import { TABLES } from '@/lib/backup';
import { note } from '@/lib/log';

/**
 * Putting a backup back.
 * ---------------------------------------------------------------------------
 * This is the most destructive thing in the application: it empties every
 * table and refills them from a file. So it is built to be hard to do by
 * accident and impossible to do halfway.
 *
 *   read first    A file can be inspected without being applied. The page
 *                 shows what is in it beside what is live, so nobody restores
 *                 a week-old copy over a day's work without seeing the
 *                 numbers first.
 *
 *   all or none   Everything happens in one transaction. A foreign key that
 *                 will not take, a constraint the old file breaks, a
 *                 connection that drops — and the database is exactly as it
 *                 was. There is no state in which half the project is the
 *                 backup and half is today.
 *
 *   order         Tables are emptied children-first and filled parents-first,
 *                 which is the order in lib/backup. Referential integrity is
 *                 never suspended: if the file is inconsistent, the restore
 *                 fails rather than loading something that only looks right.
 *
 *   signed out    Every session ends. A tab left open was holding the project
 *                 as it was a minute ago, and its next write would have been
 *                 against rows that no longer exist.
 *
 * What it cannot do is bring back a photograph. The rows come back and name
 * their files; whether those files are still in R2 is a separate question,
 * and the page says so before anyone presses the button.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const CODE = 'DIU-CL25-2026';

async function gate() {
  const me = await requireUser();
  if (!(await canEdit(me.role, 'admin')))
    throw new HttpError(403, 'Restoring the project is not open to your role.');
  return me;
}

/** The file, whether it arrives gzipped or as plain text. */
function parse(raw: string): any {
  let text = raw;
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw.slice(0, 200)) && !raw.trimStart().startsWith('{')) {
    /* base64 of the .gz the download gives, which is what the browser sends
       when somebody picks the file they were given rather than unzipping it */
    try { text = gunzipSync(Buffer.from(raw, 'base64')).toString('utf8'); }
    catch { throw new HttpError(400, 'That file is not one of this system\'s backups.'); }
  }
  let d: any;
  try { d = JSON.parse(text); } catch {
    throw new HttpError(400, 'That file is not readable as a backup.');
  }
  if (!d || d.project !== 'DIU-CL25-2026' || !d.rows)
    throw new HttpError(400, 'That is a file, but not a backup of this project.');
  return d;
}

export async function POST(req: Request) {
  try {
    const me = await gate();
    const b = await req.json();
    const d = parse(String(b.file || ''));

    /* ---------------------------------------------------- look, don't touch */
    const live: Record<string, number> = {};
    for (const t of TABLES) {
      const r = await q(`select count(*)::int as n from ${t}`).catch(() => [{ n: -1 }]);
      live[t] = Number(r[0]?.n ?? -1);
    }
    const inFile: Record<string, number> =
      Object.fromEntries(TABLES.map(t => [t, (d.rows[t] || []).length]));

    if (b.act !== 'apply')
      return Response.json({ ok: true, preview: true, takenAt: d.takenAt, inFile, live });

    /* ------------------------------------------------------------ do it */
    if (String(b.code || '').trim().toUpperCase() !== CODE)
      throw new HttpError(400, `Type ${CODE} to confirm. Nothing has been changed.`);

    /* The file must at least be able to let somebody back in. A backup with
       no accounts in it would restore a project nobody can open. */
    if (!(d.rows.users || []).length)
      throw new HttpError(400, 'That backup holds no accounts, so nobody could sign in after it.');

    /* What kind of column each one is.
       --------------------------------------------------------------------
       A JSON value and a Postgres array are both a JavaScript array by the
       time they come out of the file, and the driver cannot tell them apart:
       handed an array it writes a Postgres array literal, so `children: []`
       destined for a jsonb column arrived as `{}` — an object, not a list —
       and the recycle bin then failed to count it. The database is asked
       which columns are jsonb, and those are written as text and cast. */
    const jsonb: Record<string, Set<string>> = {};
    for (const r of await q(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and data_type in ('jsonb','json')`)) {
      (jsonb[r.table_name] ||= new Set()).add(r.column_name);
    }

    const wrote: Record<string, number> = {};
    await tx(async (c) => {
      /* Children first, so nothing is ever orphaned mid-way. */
      for (const t of [...TABLES].reverse())
        await c.query(`delete from ${t}`).catch(() => { /* a table this database has not got */ });

      for (const t of TABLES) {
        let list: any[] = d.rows[t] || [];
        if (!list.length) { wrote[t] = 0; continue; }
        /* A file written before the backup learned to order these could hold
           a sub-task above its own parent, which is a foreign key violation
           on the way back in. Sorting here costs nothing and means an older
           backup still restores. */
        if (t === 'tasks') list = [...list].sort((a, b) =>
          (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0));
        /* The columns of the file, not of the code: a backup taken before a
           column existed still loads, and one taken after a column was
           dropped fails loudly rather than silently losing it. */
        const cols = Object.keys(list[0]);
        const js = jsonb[t] || new Set<string>();
        const quoted = cols.map(x => `"${x}"`).join(', ');
        const marks = cols.map((x, i) => js.has(x) ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ');
        for (const r of list)
          await c.query(`insert into ${t} (${quoted}) values (${marks})`,
            cols.map(x => {
              const v = r[x];
              if (v === undefined) return null;
              if (js.has(x)) return v === null ? null : JSON.stringify(v);
              return v;
            }));
        wrote[t] = list.length;
      }

      await c.query(`update sessions set active = false, ended_at = now() where active`)
        .catch(() => {});
      await note(c, me, 'settings', 'backup',
        `restored the project from a backup taken ${String(d.takenAt).slice(0, 16).replace('T', ' ')}`);
    });

    return Response.json({ ok: true, restored: true, takenAt: d.takenAt, wrote });
  } catch (e) { return fail(e); }
}

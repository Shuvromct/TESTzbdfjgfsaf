import { q, one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { requireOpenSite } from '@/lib/lock';
import { mayManage, mayUse } from '@/lib/roles';
import { bin } from '@/lib/trash';
import type { SectionKey } from '@/lib/roles';
import { note, say } from '@/lib/log';

/**
 * The plainer records: survey zones, student teams, student-days, departments.
 *
 * These are lists somebody keeps up to date, with none of the task register's
 * machinery — no separation of duties, no derived status, no chain. Three
 * near-identical routes would have been three times the code for the same
 * thing, so there is one, and the table below is the whole of what it allows.
 * Nothing reaches a column that is not named here.
 */
const TABLES: Record<string, { cols: string[]; mod: SectionKey; keeper?: boolean; log: any }> = {
  survey: {
    mod: 'survey', log: 'survey',
    cols: ['zone', 'location', 'observation', 'before_url', 'approx_size', 'condition',
           'hazard', 'access_clear', 'proposal', 'route', 'dept_id', 'task_id',
           'student_involvement', 'safety_class', 'confirmed', 'remarks'],
  },
  student_teams: {
    mod: 'students', log: 'settings',
    cols: ['leader_name', 'leader_sid', 'supervisor_id', 'members', 'task_ids', 'roster_url',
           'course_map', 'hours_planned', 'hours_verified', 'evidence_url',
           'induction_on', 'viva_on', 'remarks'],
  },
  student_days: {
    mod: 'students', log: 'settings',
    cols: ['activity', 'task_id', 'students', 'days', 'note'],
  },
  departments: {
    mod: 'users', keeper: true, log: 'settings',
    cols: ['name', 'responsibilities', 'focal_user_id', 'active'],
  },
};

const NUM = ['members', 'students', 'days', 'hours_planned', 'hours_verified'];
const BOOL = ['hazard', 'confirmed', 'active'];
const DATE = ['induction_on', 'viva_on'];
const ARR = ['task_ids'];
const NULLABLE = ['dept_id', 'task_id', 'supervisor_id', 'focal_user_id'];

export async function PATCH(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    const b = await req.json();
    const t = TABLES[String(b.table || '')];
    if (!t) throw new HttpError(400, 'That is not a record this system keeps.');
    if (t.keeper && !await mayManage(me.role))
      throw new HttpError(403, 'Only the Project Director can change that.');
    if (!(await mayUse(me.role, t.mod)))
      throw new HttpError(403, `You do not have the ${t.mod} module.`);

    const id = String(b.id || '');
    const changes = b.changes || {};
    const fields = Object.keys(changes);
    if (!id || !fields.length) throw new HttpError(400, 'Nothing to change.');
    for (const f of fields)
      if (!t.cols.includes(f)) throw new HttpError(400, `There is no field called ${f}.`);

    const table = String(b.table);
    const before = await one(`select * from ${table} where id=$1`, [id]);
    if (!before) throw new HttpError(404, 'No record with that ID.');

    const row = await tx(async (c) => {
      const sets: string[] = [], vals: any[] = [id];
      for (const f of fields) {
        let v = changes[f];
        if (NUM.includes(f)) v = v === '' || v === null ? null : Number(v);
        else if (BOOL.includes(f)) v = !!v;
        else if (DATE.includes(f)) v = v ? String(v).slice(0, 10) : null;
        else if (ARR.includes(f)) v = Array.isArray(v) ? v.map(String) : [];
        else if (NULLABLE.includes(f)) v = v ? String(v) : null;
        else v = String(v ?? '');
        vals.push(v);
        sets.push(`${f} = $${vals.length}`);
      }
      const r = (await c.query(
        `update ${table} set ${sets.join(', ')} where id=$1 returning *`, vals)).rows[0];
      for (const f of fields) {
        if (String(before[f] ?? '') === String(r[f] ?? '')) continue;
        const wasSaid = await say(c, f, before[f]);
        const nowSaid = await say(c, f, r[f]);
        await note(c, me, t.log, id, `set ${f.replace(/_/g, ' ')} to ${nowSaid}`,
          { field: f, was: wasSaid, now: nowSaid });
      }
      return r;
    });
    return Response.json({ ok: true, row });
  } catch (e) { return fail(e); }
}

/* ----------------------------------------------------------------- adding */
/* These four lists could be edited but never added to. The survey arrived
   with fifteen zones and the register with twelve student teams, and that
   was all there would ever be — which is not how a campus works.
   The id follows whatever pattern the table already uses, so SV15 is
   followed by SV16 and TEAM-12 by TEAM-13. */
const SHAPE: Record<string, { prefix: string; pad: number; what: string }> = {
  survey:        { prefix: 'SV',   pad: 2, what: 'zone' },
  student_teams: { prefix: 'TEAM-', pad: 2, what: 'team' },
  student_days:  { prefix: 'L',    pad: 1, what: 'activity' },
};

async function nextId(table: string) {
  const sh = SHAPE[table];
  if (!sh) return '';
  const rows = await q(`select id from ${table}`);
  const used = rows
    .map((r: any) => String(r.id))
    .filter((id: string) => id.startsWith(sh.prefix))
    .map((id: string) => Number(id.slice(sh.prefix.length)))
    .filter((n: number) => !isNaN(n));
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return sh.prefix + String(next).padStart(sh.pad, '0');
}

/** A department is named, not numbered, so its id comes from its name. */
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

export async function POST(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    const b = await req.json();
    const name = String(b.table || '');
    const t = TABLES[name];
    if (!t) throw new HttpError(400, 'That is not a record this system keeps.');
    if (t.keeper && !await mayManage(me.role))
      throw new HttpError(403, 'Only the Project Director can add that.');
    if (!(await mayUse(me.role, t.mod)))
      throw new HttpError(403, `Your role cannot change ${t.mod}.`);

    const given = b.values || {};
    for (const f of Object.keys(given))
      if (!t.cols.includes(f)) throw new HttpError(400, `There is no field called ${f}.`);

    let id = String(b.id || '').trim();
    if (!id) id = name === 'departments' ? slug(String(given.name || '')) : await nextId(name);
    if (!id) throw new HttpError(400, 'That record needs a name.');
    if (await one(`select id from ${name} where id=$1`, [id]))
      throw new HttpError(409, `${id} already exists.`);

    const cols = ['id'], vals: any[] = [id];
    for (const f of Object.keys(given)) {
      let v = given[f];
      if (NUM.includes(f)) v = v === '' || v === null ? null : Number(v);
      else if (BOOL.includes(f)) v = !!v;
      else if (DATE.includes(f)) v = v ? String(v).slice(0, 10) : null;
      else if (ARR.includes(f)) v = Array.isArray(v) ? v
        : String(v || '').split(/[,\s]+/).filter(Boolean);
      else if (NULLABLE.includes(f)) v = v || null;
      else v = v === null || v === undefined ? '' : String(v);
      cols.push(f); vals.push(v);
    }

    const row = await tx(async (c) => {
      const r = await c.query(
        `insert into ${name} (${cols.map(x => `"${x}"`).join(',')})
         values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`, vals);
      await note(c, me, t.log, id, `added a ${SHAPE[name]?.what || 'record'}`);
      return r.rows[0];
    });
    return Response.json({ ok: true, id, row });
  } catch (e) { return fail(e); }
}

/** To the recycle bin, like everything else that gets removed. */
export async function DELETE(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    const b = await req.json();
    const name = String(b.table || '');
    const t = TABLES[name];
    if (!t) throw new HttpError(400, 'That is not a record this system keeps.');
    if (!(await mayManage(me.role)))
      throw new HttpError(403, 'Removing a record is for a role that may act on other people\'s records.');

    const id = String(b.id || '');
    const row = await one(`select * from ${name} where id=$1`, [id]);
    if (!row) throw new HttpError(404, 'No record with that ID.');

    /* A department somebody still belongs to, or still leads work, cannot
       simply vanish — the references would break on the way out. */
    if (name === 'departments') {
      const users = await q('select id from users where dept_id=$1', [id]);
      const tasks = await q('select id from tasks where lead_dept_id=$1 and deleted_at is null', [id]);
      if (users.length || tasks.length)
        throw new HttpError(409,
          `${row.name} still has ${users.length} person${users.length === 1 ? '' : 's'} `
          + `and ${tasks.length} task${tasks.length === 1 ? '' : 's'} attached. Move those first.`);
    }

    let moved: any = null;
    await tx(async (c) => {
      moved = await bin(c, me, KIND[name], id);
      await note(c, me, t.log, id, 'moved to the recycle bin',
        { note: String(b.reason || '') });
    });
    return Response.json({ ok: true, moved });
  } catch (e) { return fail(e); }
}

const KIND: Record<string, any> = {
  survey: 'survey', student_teams: 'team', student_days: 'student_day',
  departments: 'department',
};

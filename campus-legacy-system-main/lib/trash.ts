import type { PoolClient } from 'pg';
import { q, one, tx } from './db';
import { removeObject } from './r2';
import { note } from './log';
import type { Session } from './auth';

/**
 * The recycle bin.
 * ---------------------------------------------------------------------------
 * Deleting anything writes the whole record into `trash` as JSON and takes it
 * out of its own table. Restoring puts the JSON back. Nothing about the nine
 * original tables had to change to support that, and a table added next year
 * works the same way.
 *
 * Two things this has to get right:
 *
 *   dependents   removing a task removes its sub-tasks, its budget lines, its
 *                decisions and its photographs. They travel with it in one
 *                bin entry and come back with it, or the restore would leave
 *                a task with its parts missing.
 *
 *   order        a record cannot be restored if what it points at is gone.
 *                The parent goes back before the child, and anything whose
 *                references are missing is reported rather than forced.
 */

export type Kind = 'task' | 'budget' | 'approval' | 'milestone' | 'survey'
                 | 'team' | 'student_day' | 'photo' | 'department' | 'user'
                 | 'step' | 'task_role' | 'chairman_reference';

const TABLE: Record<Kind, string> = {
  task: 'tasks', budget: 'budget_lines', approval: 'approvals',
  milestone: 'milestones', survey: 'survey', team: 'student_teams',
  student_day: 'student_days', photo: 'photos', department: 'departments',
  user: 'users', step: 'approval_steps', task_role: 'task_roles',
  chairman_reference: 'chairman_reference',
};

/* A row with no id of its own is matched on its whole key instead. */
const KEY: Partial<Record<Kind, string[]>> = {
  task_role: ['task_id', 'dept_id', 'role'],
  chairman_reference: ['task_id'],
};

/** What to call it in the listing. */
function labelOf(kind: Kind, row: any): string {
  switch (kind) {
    case 'task':        return row.title || row.id;
    case 'budget':      return row.item || row.id;
    case 'approval':    return row.item || row.id;
    case 'milestone':   return row.title || row.id;
    case 'survey':      return row.location || row.id;
    case 'team':        return row.name || row.id;
    case 'student_day': return row.activity || row.id;
    case 'photo':       return `${row.kind} photograph`;
    case 'department':  return row.name || row.id;
    case 'user':        return row.name || row.email || row.id;
    case 'chairman_reference': return row.deliverable || row.task_id;
    default:            return String(row.id ?? '');
  }
}

/* ------------------------------------------------------------- deleting */

/**
 * Move one record, and everything that hangs off it, into the bin.
 * Runs inside a transaction the caller owns, beside its own log entry.
 */
export async function bin(c: PoolClient, who: Session, kind: Kind, id: string) {
  const table = TABLE[kind];
  const row = (await c.query(`select * from ${table} where id = $1`, [id])).rows[0];
  if (!row) return null;

  const children: { kind: Kind; row: any }[] = [];
  const links: { table: string; column: string; id: string; was: string }[] = [];

  if (kind === 'task') {
    for (const [k, sql] of [
      ['task',      `select * from tasks where parent_id = $1`],
      ['budget',    `select * from budget_lines where task_id = $1`],
      ['approval',  `select * from approvals where task_id = $1`],
      ['photo',     `select * from photos where task_id = $1`],
      ['step',      `select * from approval_steps where task_id = $1`],
      /* The lead and supporting departments are a cascade on the foreign
         key: delete the task and they vanish without a trace, so a restored
         task would come back with nobody assigned to it. They are carried
         along like everything else. */
      ['task_role', `select * from task_roles where task_id = $1`],
    ] as const) {
      for (const r of (await c.query(sql, [id])).rows) children.push({ kind: k as Kind, row: r });
    }

    /* A zone and a student day point at a task but are not part of it. The
       pointer is cleared so the task can leave, and remembered so it can be
       put back when the task returns. */
    for (const [table, column] of [['survey', 'task_id'], ['student_days', 'task_id']] as const) {
      for (const r of (await c.query(`select id from ${table} where ${column} = $1`, [id])).rows) {
        links.push({ table, column, id: String(r.id), was: id });
        await c.query(`update ${table} set ${column} = null where id = $1`, [r.id]);
      }
    }
  }
  if (kind === 'approval') {
    for (const r of (await c.query(`select * from approval_steps where approval_id = $1`, [id])).rows)
      children.push({ kind: 'step', row: r });
  }

  await c.query(
    `insert into trash (kind, record_id, label, row, children, links, deleted_by, deleted_name)
     values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)
     on conflict (kind, record_id) do update
       set row = $4::jsonb, children = $5::jsonb, links = $6::jsonb, deleted_by = $7,
           deleted_name = $8, deleted_at = now(), label = $3`,
    [kind, id, labelOf(kind, row), JSON.stringify(row),
     JSON.stringify(children), JSON.stringify(links), who.id, who.name]);

  /* Children first, then the record itself: the other way round trips the
     foreign keys that point at it. */
  for (const ch of children) await del(c, ch.kind, ch.row);
  await c.query(`delete from ${table} where id = $1`, [id]);

  return { kind, id, label: labelOf(kind, row), children: children.length };
}

/* ------------------------------------------------------------ restoring */

/** Delete one row, by id or by its whole key where it has no id. */
async function del(c: PoolClient, kind: Kind, row: any) {
  const keys = KEY[kind];
  if (!keys) return void await c.query(`delete from ${TABLE[kind]} where id = $1`, [row.id]);
  const where = keys.map((k, i) => `"${k}" = $${i + 1}`).join(' and ');
  await c.query(`delete from ${TABLE[kind]} where ${where}`, keys.map(k => row[k]));
}

function insertSql(table: string, row: any) {
  const cols = Object.keys(row);
  const marks = cols.map((_, i) => `$${i + 1}`);
  return {
    text: `insert into ${table} (${cols.map(c => `"${c}"`).join(',')})
           values (${marks.join(',')}) on conflict do nothing`,
    /* A Postgres array comes back from JSON as a JavaScript array, and the
       driver turns that into an array again on the way in. Only a plain
       object is a jsonb column and needs re-encoding — stringifying both
       turned depends_on into the literal text ["CL25-01"], which Postgres
       will not read as an array. */
    values: cols.map(k => {
      const v = row[k];
      return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? JSON.stringify(v) : v;
    }),
  };
}

/** Put one bin entry back. Returns what happened, in words. */
export async function restore(who: Session, entryId: number) {
  return tx(async (c) => {
    const e = (await c.query(`select * from trash where id = $1 for update`, [entryId])).rows[0];
    if (!e) throw new Error('That is no longer in the recycle bin.');

    const kind = e.kind as Kind;
    const row = e.row;
    const children: { kind: Kind; row: any }[] = e.children || [];

    try {
      /* An entry whose own row is empty is a wrapper: the Chairman's tracker
         has no id column, so its lines are kept as children of one entry
         rather than as several hundred entries of their own. */
      if (row && Object.keys(row).length) {
        const a = insertSql(TABLE[kind], row);
        await c.query(a.text, a.values);
      }
      for (const ch of children) {
        const b = insertSql(TABLE[ch.kind], ch.row);
        await c.query(b.text, b.values);
      }
      /* And the pointers that were cleared so this record could leave. */
      for (const l of (e.links || []))
        await c.query(`update ${l.table} set ${l.column} = $1 where id = $2`, [l.was, l.id]);
    } catch (err: any) {
      /* 23503 is a foreign key: something this record points at is itself
         gone. Say which, rather than failing with a constraint name. */
      if (err && err.code === '23503')
        throw new Error(`${e.label} points at a record that has also been removed. `
          + `Restore that one first, or recreate it.`);
      throw err;
    }

    await c.query(`delete from trash where id = $1`, [entryId]);
    await note(c, who, kindSubject(kind), String(e.record_id),
      `restored ${e.label} from the recycle bin`);
    return { kind, id: e.record_id, label: e.label, children: children.length };
  });
}

const kindSubject = (k: Kind): any =>
  k === 'budget' ? 'budget' : k === 'approval' ? 'approval'
  : k === 'milestone' ? 'milestone' : k === 'photo' ? 'photo'
  : k === 'user' ? 'user' : k === 'task' ? 'task' : 'settings';

/* -------------------------------------------------------------- purging */

/** Photograph keys in an entry, so the bucket can be cleared with it. */
function photoKeys(e: any): string[] {
  const out: string[] = [];
  const add = (r: any) => {
    if (!r || !r.url) return;
    const key = String(r.url).split('/').slice(3).join('/');
    if (key) { out.push(key); out.push(key.replace(/\.jpg$/i, '_thumb.jpg')); }
  };
  if (e.kind === 'photo') add(e.row);
  for (const ch of (e.children || [])) if (ch.kind === 'photo') add(ch.row);
  return out;
}

/**
 * Empty the bin, or one entry of it, for good.
 * The photographs go from Cloudflare too — that is what "for good" means.
 */
export async function purge(who: Session, entryId?: number) {
  const rows = entryId
    ? await q(`select * from trash where id = $1`, [entryId])
    : await q(`select * from trash`);

  const keys = rows.flatMap(photoKeys);
  for (const k of keys) await removeObject(k).catch(() => {});

  await tx(async (c) => {
    if (entryId) await c.query(`delete from trash where id = $1`, [entryId]);
    else await c.query(`delete from trash`);
    await note(c, who, 'settings', 'trash',
      entryId ? `removed one item from the recycle bin for good`
              : `emptied the recycle bin — ${rows.length} item${rows.length === 1 ? '' : 's'}`,
      { note: keys.length ? `${keys.length / 2} photograph file(s) deleted from storage` : '' });
  });

  return { entries: rows.length, files: keys.length / 2 };
}

/** The listing. */
export async function listTrash() {
  return (await q(
    `select id, kind, record_id, label,
            jsonb_array_length(children) as children,
            deleted_name, deleted_at
       from trash order by deleted_at desc limit 500`))
    .map((r: any) => ({
      id: Number(r.id), kind: r.kind, recordId: r.record_id, label: r.label,
      children: Number(r.children), by: r.deleted_name, at: r.deleted_at,
    }));
}

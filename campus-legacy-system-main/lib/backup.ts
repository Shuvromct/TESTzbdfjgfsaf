import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { q } from './db';

/**
 * The project in a file.
 * ---------------------------------------------------------------------------
 * A database somebody else hosts is a database somebody else can lose. Neon
 * can wind itself back a few days, which covers a mistake but not an account
 * closed, a plan expired or a region gone — so the record also leaves the
 * building, on a schedule, as a file the project office holds.
 *
 * Two shapes, because they answer different questions:
 *
 *   JSON  what this system reads back. Every table as an array of rows, with
 *         a header saying when it was taken and what was in it. The Restore
 *         button takes this and nothing else.
 *
 *   SQL   the schema and every row, as statements any Postgres will accept.
 *         This is the one that does not need this application to exist: paste
 *         it into a fresh database and the project is there. It is how the
 *         record survives the software.
 *
 * Both are gzipped before they are sent. The whole project is a few hundred
 * kilobytes of text and about a tenth of that zipped, which matters when it
 * is going down a phone line twenty-four times a day.
 */

/* Parents before children, so a restore can insert in this order and never
   point at a row that is not there yet. The order is the contract: changing
   it without thinking about the foreign keys will break a restore and not a
   backup, which is the worse way round to find out. */
/* A table whose rows point at other rows of the same table has to come out in
   an order that can go back in. A sub-task read before its parent is a foreign
   key violation on restore, and `select *` promises no order at all. */
export const ORDER: Record<string, string> = {
  tasks: 'parent_id nulls first, id',
  approval_steps: 'step_no, id',
};

export const TABLES = [
  'settings',
  'departments',
  'users',
  'tasks',
  'task_roles',
  'budget_lines',
  'approvals',
  'approval_steps',
  'milestones',
  'photos',
  'survey',
  'student_teams',
  'student_days',
  'chairman_reference',
  'activity',
  'notices',
  'trash',
] as const;

export type Dump = {
  system: 'DIU Campus Legacy 25';
  project: 'DIU-CL25-2026';
  version: 1;
  takenAt: string;
  counts: Record<string, number>;
  rows: Record<string, any[]>;
};

/** Every table, every row, as it stands right now. */
export async function readAll(): Promise<Dump> {
  const rows: Record<string, any[]> = {};
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    /* A table the database has not got yet — an update not run — is not a
       reason to have no backup at all. It is recorded as absent instead. */
    try {
      const r = await q(`select * from ${t}${ORDER[t] ? ` order by ${ORDER[t]}` : ''}`);
      rows[t] = r;
      counts[t] = r.length;
    } catch {
      rows[t] = [];
      counts[t] = -1;
    }
  }
  return {
    system: 'DIU Campus Legacy 25',
    project: 'DIU-CL25-2026',
    version: 1,
    takenAt: new Date().toISOString(),
    counts,
    rows,
  };
}

/* ------------------------------------------------------------------ SQL */

/** A value as Postgres would want to read it back. */
function lit(v: any): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) {
    /* A text[] written the way Postgres writes one: array['a','b'] keeps its
       type without anybody having to guess at the cast. */
    if (!v.length) return `'{}'`;
    return `array[${v.map(x => lit(x === null ? null : String(x))).join(',')}]`;
  }
  if (typeof v === 'object') return `${lit(JSON.stringify(v))}::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * The schema, read from the file that built the database.
 *
 * Reading it rather than writing out a second copy here: two descriptions of
 * one schema drift apart, and the one in the backup would be the one nobody
 * notices is wrong until the day it is needed. next.config.mjs keeps this
 * file beside the function on Vercel.
 */
async function schema(): Promise<string> {
  const parts: string[] = [];
  try { parts.push(await readFile(join(process.cwd(), 'schema.sql'), 'utf8')); }
  catch { return ''; }        /* the dump then says to run schema.sql first */

  /* And then every update since, in order.
     ------------------------------------------------------------------
     schema.sql is the database as it was first built, not as it is: the
     columns added since live in migrations/. A dump carrying only the
     first of those produces a database the rows will not go into — which
     is exactly what a backup must not do, and is the kind of fault that
     is only discovered on the day it matters. */
  try {
    const dir = join(process.cwd(), 'migrations');
    const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) parts.push(`-- migrations/${f}\n` + await readFile(join(dir, f), 'utf8'));
  } catch { /* a deployment without the folder still gets the base schema */ }

  return parts.join('\n\n');
}

export async function toSql(d: Dump): Promise<string> {
  const out: string[] = [];
  out.push(`-- DIU Campus Legacy 25 — DIU-CL25-2026`);
  out.push(`-- A full copy of the project, taken ${d.takenAt}`);
  out.push(`--`);
  out.push(`-- To put it back: open a Postgres database and run this file whole.`);
  out.push(`-- It creates the tables if they are not there and loads every row.`);
  out.push(`-- Existing rows with the same id are left alone, so running it`);
  out.push(`-- against a database that already holds the project adds what is`);
  out.push(`-- missing rather than overwriting what is there.`);
  out.push(`--`);
  out.push(`-- Passwords are one-way hashes. They cannot be read, and everybody`);
  out.push(`-- can still sign in with the password they already know — so this`);
  out.push(`-- file is private, and does not belong in a repository.`);
  out.push('');

  const s = await schema();
  if (s) {
    out.push(`-- ============================================ the tables`);
    out.push(s.trim());
    out.push('');
  } else {
    out.push(`-- The schema could not be read on the server; run schema.sql first.`);
    out.push('');
  }

  out.push(`-- ============================================== the records`);
  out.push(`begin;`);
  for (const t of TABLES) {
    const list = d.rows[t] || [];
    if (!list.length) continue;
    out.push('');
    out.push(`-- ${t} — ${list.length}`);
    const cols = Object.keys(list[0]);
    const quoted = cols.map(c => `"${c}"`).join(', ');
    for (const r of list)
      out.push(`insert into ${t} (${quoted}) values (`
        + cols.map(c => lit(r[c])).join(', ')
        + `) on conflict do nothing;`);
  }
  out.push('');
  out.push(`commit;`);
  out.push('');
  return out.join('\n');
}

/* --------------------------------------------------------------- naming */

/** A name that sorts by itself in a folder of them. */
export function stamp(at = new Date()) {
  const z = (n: number) => String(n).padStart(2, '0');
  /* Dhaka, because whoever reads the name is in Dhaka. */
  const d = new Date(at.getTime() + 6 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())}`
       + `-${z(d.getUTCHours())}${z(d.getUTCMinutes())}`;
}

export const nameFor = (kind: 'json' | 'sql', at = new Date()) =>
  `CL25-backup-${stamp(at)}.${kind}.gz`;

export const zip = (text: string) => gzipSync(Buffer.from(text, 'utf8'), { level: 6 });

/** One line a person can read without opening anything. */
export function caption(d: Dump) {
  const n = (k: string) => (d.counts[k] >= 0 ? d.counts[k] : '?');
  return `<b>CL25 backup</b> · ${stamp(new Date(d.takenAt)).replace(/-(\d{4})$/, ' $1')}\n`
       + `${n('tasks')} tasks · ${n('budget_lines')} budget lines · `
       + `${n('approvals')} decisions · ${n('photos')} photographs · ${n('users')} people`;
}

/**
 * Has anything changed since the last copy went out?
 *
 * The hourly copy is skipped when nothing has, because a project office does
 * not need twenty-four identical files a day and the one that matters gets
 * lost among them. The answer is the newest moment anything was touched,
 * which is cheap to ask for and does not need the backup to be built first.
 */
export async function lastChange(): Promise<string> {
  const r = await q(`
    select max(at) as at from (
      select max(updated_at) as at from tasks
      union all select max(updated_at) from budget_lines
      union all select max(updated_at) from approvals
      union all select max(at)         from activity
    ) x`).catch(() => [{ at: null }]);
  return r[0]?.at ? new Date(r[0].at).toISOString() : '';
}

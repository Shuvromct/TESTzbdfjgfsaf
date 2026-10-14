import type { PoolClient } from 'pg';
import type { Session } from './auth';

/**
 * The trail.
 *
 * Never called on its own — always on the client inside a transaction, beside
 * the change it describes. Nothing writes to `activity` by hand, which is the
 * point: if the change happened, the row is there, and if the row is there the
 * change happened.
 *
 * The user's name is copied in rather than joined later. Accounts get disabled
 * and renamed; a record of who did what in October 2026 should still read
 * correctly in April.
 */
export async function note(
  c: PoolClient,
  who: Session,
  subject: 'task' | 'budget' | 'approval' | 'milestone' | 'photo' | 'user' | 'settings' | 'survey',
  subjectId: string,
  what: string,
  change?: { field?: string; was?: any; now?: any; note?: string },
) {
  const f = change || {};
  const was = f.was === undefined || f.was === null ? '' : String(f.was);
  const now = f.now === undefined || f.now === null ? '' : String(f.now);

  /* One edit, one entry.
   *
   * Since text fields save themselves as they are written, a paragraph typed
   * with four pauses used to arrive as four rows, each holding a half-finished
   * sentence. That is noise in the one record this project exists to keep.
   *
   * So a further change by the same person to the same field of the same
   * record, within a quarter of an hour, extends the entry already there: the
   * `was` stays as it was when they started, `now_` becomes what they have
   * written, and the time moves to the latest keystroke. Somebody else
   * touching the field, or a gap longer than that, starts a fresh entry —
   * so a handover is never swallowed into somebody else's row. */
  if (f.field) {
    const merged = await c.query(
      `update activity set now_ = $1, what = $2, at = now(), note = $3
         where id = (
           select id from activity
             where user_id = $4 and subject = $5 and subject_id = $6 and field = $7
               and at > now() - interval '15 minutes'
             order by at desc limit 1)
         and now_ <> $1
       returning id, was, now_`,
      [now, what, f.note || '', who.id, subject, subjectId, f.field]);
    if (merged.rowCount) {
      /* Back where it started.
         -------------------------------------------------------------------
         Somebody sets the approval to Returned, thinks again, and sets it
         back to Approved — inside the same quarter of an hour, so the two
         edits are one entry. That entry then read "set approval to Approved
         from Approved", which is not a change and not worth a line in the
         record. The entry goes, and the trail is left as it was before
         either edit. */
      const r = merged.rows[0];
      if (String(r.was ?? '') === String(r.now_ ?? ''))
        await c.query(`delete from activity where id = $1`, [r.id]);
      return;
    }
  }

  await c.query(
    `insert into activity (user_id, user_name, role, subject, subject_id, what, field, was, now_, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [who.id, who.name, who.role, subject, subjectId, what, f.field || '', was, now, f.note || ''],
  );
}

/* ---------------------------------------------------------- saying it ---
 * What a value looks like when it is read back.
 *
 * The trail used to print whatever the column held, which for half the
 * fields is not something a person can read:
 *
 *   verified by    fcf8f8b6-1259-4986-b9b7-93a75ca633b5
 *   deadline       Mon Oct 12 2026 00:00:00 GMT+0000 (Coordinated Universal Time)
 *   photographs    true
 *
 * The first is the account's own id, the second is what JavaScript makes of
 * a date column, and the third is a database answer to an English question.
 * None of them is wrong; all of them are useless to the person reading the
 * record in April. This turns each into what it means.
 */
const ID_FIELDS = ['owner_id', 'verifier_id', 'approver_id', 'verified_by',
                   'updated_by', 'decided_by', 'originator_id', 'supervisor_id',
                   'focal_user_id', 'uploaded_by'];
const DEPT_FIELDS = ['lead_dept_id', 'dept_id'];
const DATE_RE = /^(assigned|start|due|decided|submitted|verified|completed|achieved|induction|viva)_on$|^deadline$/;

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** A date column, as a person writes a date. Never a time zone. */
function sayDate(v: any): string {
  /* Dates come back from the driver as 'YYYY-MM-DD' (see lib/db.ts), which
     is a day and not a moment. Read the three numbers out of it rather than
     building a Date, because building one puts it in some zone and the zone
     can move it to the day before. */
  const s = String(v).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}`;
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(+d)) return String(v);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}

/**
 * One value, in words. Needs the client because a name has to be looked up.
 * Falls back to the raw value if the lookup finds nothing — a deleted
 * account should not turn a trail entry into an empty sentence.
 */
export async function say(c: PoolClient, field: string, v: any): Promise<string> {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(empty)';
  if (v instanceof Date || DATE_RE.test(field)) return sayDate(v);
  if (field === 'progress') return `${Math.round(Number(v) * 100)}%`;
  if (ID_FIELDS.includes(field)) {
    const r = await c.query('select name from users where id = $1', [String(v)]);
    return r.rows[0]?.name || String(v);
  }
  if (DEPT_FIELDS.includes(field)) {
    const r = await c.query('select name from departments where id = $1', [String(v)]);
    return r.rows[0]?.name || String(v);
  }
  return String(v);
}

/** Human wording for a field change, so the log reads like a sentence. */
export const LABELS: Record<string, string> = {
  status: 'status', progress: 'progress', deadline: 'deadline', start_on: 'start date',
  completed_on: 'completion date', verified_by: 'verified by', verified_on: 'verification date',
  approval_status: 'approval', owner_id: 'responsible person', verifier_id: 'verifier',
  approver_id: 'approval authority', lead_dept_id: 'lead department', evidence_ref: 'evidence',
  evidence_url: 'evidence link', remarks: 'remarks', phase: 'phase', route: 'route',
  assigned_on: 'assigned date', site: 'site', depends_on: 'prerequisites',
  photos_required: 'photographs required', acceptance: 'acceptance criteria',
  title: 'title', category: 'category', priority: 'priority',
};

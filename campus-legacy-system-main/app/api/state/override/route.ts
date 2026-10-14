import { one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { isSuper } from '@/lib/roles';
import { note } from '@/lib/log';
import { siteLock, mayEnter } from '@/lib/lock';

/**
 * Signing off on somebody else's behalf.
 * ---------------------------------------------------------------------------
 * Work stops when the person a task is waiting on is unreachable — away, ill,
 * or named on the tracker as a post nobody has an account for yet. The project
 * office then has a choice between a record that says the work is unverified
 * when it has been checked, and someone typing their own name into the chair.
 * This is the third option.
 *
 * What it does NOT do is move the sign-off to the person pressing the button.
 * The record still says the named verifier verified it, because that is what
 * happened; the trail carries a second line naming who recorded it and on
 * whose behalf. So the separation of duties survives intact — the check
 * constraints in the table are untouched, and they still refuse to write one
 * person into two chairs — and anyone reading the trail afterwards can see
 * exactly which sign-offs were recorded this way and by whom.
 *
 * Reached only by a role carrying the Super approve flag, which is its own
 * role rather than a level of any other.
 */
export async function POST(req: Request) {
  try {
    const me = await requireUser();
    if (!(await isSuper(me.role)))
      throw new HttpError(403, 'Recording a sign-off for somebody else needs the Super approve role.');

    const lock = await siteLock();
    if (lock.on && !mayEnter(me.role))
      throw new HttpError(423, lock.msg || 'The system is closed to changes.');

    const b = await req.json();
    const id = String(b.id || '');
    const what = String(b.what || '');
    const on = String(b.on || '').slice(0, 10);
    const why = String(b.why || '').trim().slice(0, 300);

    const t = await one(
      `select * from tasks where id = $1 and deleted_at is null`, [id]);
    if (!t) throw new HttpError(404, 'No task with that ID.');
    if (!why) throw new HttpError(400, 'Say why this is being recorded for somebody else.');

    /* Whose decision is being recorded. Not the caller's: the chair's. */
    if (what === 'verify') {
      if (!t.verifier_id)
        throw new HttpError(409, 'Nobody is named as the verifier on this task. Name one first.');
      if (t.verified_by)
        throw new HttpError(409, 'This task has already been verified.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) throw new HttpError(400, 'A date, please.');

      const who = await one('select name from users where id=$1', [t.verifier_id]);
      const row = await tx(async (c) => {
        const r = (await c.query(
          `update tasks set verified_by = $2, verified_on = $3, updated_by = $4
            where id = $1 returning *`, [id, t.verifier_id, on, me.id])).rows[0];
        await note(c, me, 'task', id,
          `recorded the verification on behalf of ${who?.name || t.verifier_id} — ${why}`);
        return r;
      });
      return Response.json({ ok: true, task: row });
    }

    if (what === 'approve') {
      const decision = String(b.decision || 'Approved');
      if (!['Approved', 'Rejected'].includes(decision))
        throw new HttpError(400, 'A decision is Approved or Rejected.');
      if (!t.approver_id)
        throw new HttpError(409, 'Nobody is named as the approval authority on this task. Name one first.');

      const who = await one('select name from users where id=$1', [t.approver_id]);
      const row = await tx(async (c) => {
        const r = (await c.query(
          `update tasks set approval_status = $2, updated_by = $3
            where id = $1 returning *`, [id, decision, me.id])).rows[0];
        await note(c, me, 'task', id,
          `recorded "${decision}" on behalf of ${who?.name || t.approver_id} — ${why}`);
        return r;
      });
      return Response.json({ ok: true, task: row });
    }

    throw new HttpError(400, 'Override a verification or an approval, nothing else.');
  } catch (e) { return fail(e); }
}

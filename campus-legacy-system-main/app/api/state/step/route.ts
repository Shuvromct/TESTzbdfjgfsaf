import { q, one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { requireOpenSite } from '@/lib/lock';
import { mayManage } from '@/lib/roles';
import { note } from '@/lib/log';

/**
 * The approval chain, one hand at a time.
 *
 * The tracker named a single authority per decision and a Yes/No for "goes to
 * the Chairman", which is not a chain. In practice an item passes through
 * several people and which people depends on the item, so the Director lays
 * the steps out per task and the server holds the order: step 2 cannot act
 * until step 1 has approved.
 */

const subject = (b: any) => {
  const taskId = b.taskId ? String(b.taskId) : null;
  const approvalId = b.approvalId ? String(b.approvalId) : null;
  if (!!taskId === !!approvalId)
    throw new HttpError(400, 'A step belongs to a task or to a decision, not both.');
  return { taskId, approvalId };
};
const where = (s: { taskId: string | null; approvalId: string | null }) =>
  s.taskId ? { col: 'task_id', val: s.taskId } : { col: 'approval_id', val: s.approvalId! };

/** Lay out the chain. Sending the whole list replaces it. */
export async function PUT(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    if (!await mayManage(me.role)) throw new HttpError(403, 'Only the Project Director sets the approval chain.');
    const b = await req.json();
    const s = subject(b);
    const w = where(s);
    const steps: any[] = Array.isArray(b.steps) ? b.steps : [];
    if (steps.length > 12) throw new HttpError(400, 'Twelve steps is already more than anyone will read.');
    for (const st of steps)
      if (!st.approverId && !String(st.post || '').trim())
        throw new HttpError(400, 'Every step needs a person or a post.');

    await tx(async (c) => {
      /* A step already decided is history: replacing the chain leaves it alone
         and only rewrites what has not happened yet. */
      const done = (await c.query(
        `select step_no from approval_steps where ${w.col}=$1 and status <> 'Pending'`, [w.val])).rows;
      if (done.length && steps.length < done.length)
        throw new HttpError(409, `${done.length} step(s) have already been decided — the chain cannot get shorter than that.`);
      await c.query(`delete from approval_steps where ${w.col}=$1 and status='Pending'`, [w.val]);
      for (let i = 0; i < steps.length; i++) {
        if (done.some((d: any) => d.step_no === i + 1)) continue;
        await c.query(
          `insert into approval_steps (${w.col}, step_no, approver_id, post)
           values ($1,$2,$3,$4)`,
          [w.val, i + 1, steps[i].approverId || null, String(steps[i].post || '')]);
      }
      await note(c, me, s.taskId ? 'task' : 'approval', w.val,
        steps.length ? `set an approval chain of ${steps.length} step(s)` : 'cleared the approval chain');
    });

    return Response.json({ ok: true, steps: await chain(w) });
  } catch (e) { return fail(e); }
}

/** Act on your step. */
export async function PATCH(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    const b = await req.json();
    const id = String(b.id || '');
    const decision = String(b.status || '');
    if (!['Approved', 'Returned', 'Rejected', 'Skipped'].includes(decision))
      throw new HttpError(400, 'A step is approved, returned, rejected or skipped.');

    const step = await one('select * from approval_steps where id=$1', [id]);
    if (!step) throw new HttpError(404, 'No such step.');
    if (step.status !== 'Pending') throw new HttpError(409, 'That step has been decided already.');

    const boss = await mayManage(me.role);
    /* A step naming a person is theirs. A step naming only a post is recorded
       by the Director, because most authorities here will never hold an
       account — and the trail says who recorded it. */
    if (step.approver_id ? step.approver_id !== me.id && !boss : !boss)
      throw new HttpError(403, step.approver_id
        ? 'That step belongs to someone else.'
        : 'Only the Project Director can record a decision for a post.');
    if (decision === 'Skipped' && !boss)
      throw new HttpError(403, 'Only the Project Director can skip a step.');

    const w = { col: step.task_id ? 'task_id' : 'approval_id', val: step.task_id || step.approval_id };
    const earlier = await q(
      `select step_no, status from approval_steps
        where ${w.col}=$1 and step_no < $2 order by step_no`, [w.val, step.step_no]);
    const waiting = earlier.find((e: any) => e.status === 'Pending');
    if (waiting) throw new HttpError(409, `Step ${waiting.step_no} has not been decided yet.`);

    await tx(async (c) => {
      await c.query(
        `update approval_steps set status=$2, decided_on=current_date, decided_by=$3, note=$4
          where id=$1`, [id, decision, me.id, String(b.note || '')]);
      await note(c, me, step.task_id ? 'task' : 'approval', w.val,
        `${decision.toLowerCase()} approval step ${step.step_no}`,
        { field: 'approval step', now: decision, note: String(b.note || '') });

      /* The last step approving is the approval. Anything else stops the chain
         where it stands — the Director decides what happens next. */
      const all = (await c.query(
        `select status from approval_steps where ${w.col}=$1 order by step_no`, [w.val])).rows;
      const done = all.every((r: any) => r.status === 'Approved' || r.status === 'Skipped');
      if (step.task_id) {
        if (done) await c.query(`update tasks set approval_status='Approved' where id=$1`, [w.val]);
        else if (decision !== 'Approved')
          await c.query(`update tasks set approval_status=$2 where id=$1`,
            [w.val, decision === 'Rejected' ? 'Rejected' : 'Returned']);
      } else {
        if (done) await c.query(
          `update approvals set decision='Approved', decided_on=current_date, decided_by=$2
            where id=$1`, [w.val, me.id]);
        else if (decision !== 'Approved')
          await c.query(`update approvals set decision=$2 where id=$1`,
            [w.val, decision === 'Rejected' ? 'Rejected' : 'Returned']);
      }
    });

    return Response.json({ ok: true, steps: await chain(w as any) });
  } catch (e) { return fail(e); }
}

async function chain(w: { col: string; val: string }) {
  return q(`select * from approval_steps where ${w.col}=$1 order by step_no`, [w.val]);
}

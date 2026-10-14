import { one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { requireOpenSite } from '@/lib/lock';
import { isKeeper } from '@/lib/perm';
import { note } from '@/lib/log';

/**
 * The others working on a task.
 * ---------------------------------------------------------------------------
 * Not a second responsible person. Ask who is accountable for CL25-19 and
 * there is still one name, which is what the column is for and what the
 * Chairman's tracker expects.
 *
 * What this fixes is narrower and real: a task done by three people had two
 * of them locked out. The task was not in their list, and the server refused
 * their writes, so the work was done by three and recorded by one — and the
 * record said something that was not true about who did it.
 *
 * They get what the responsible person has over the work itself: the task in
 * their list, and the right to move it along. They do not become the person
 * the project asks where it has got to.
 *
 * And they cannot sign their own work off. Whoever is named here is barred
 * from verifying or approving the same task, exactly as the owner is —
 * enforced in writableTask, and refused here when the person is already the
 * verifier or the approval authority.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    const b = await req.json();
    const taskId = String(b.taskId || '');
    const userId = String(b.userId || '');

    const t = await one(
      `select t.*, u.dept_id as caller_dept from tasks t
         left join users u on u.id = $2
        where t.id = $1 and t.deleted_at is null`, [taskId, me.id]);
    if (!t) throw new HttpError(404, 'No task with that ID.');

    const mine = t.owner_id === me.id
      || (!!t.lead_dept_id && t.lead_dept_id === t.caller_dept)
      || await isKeeper(me.role);
    if (!mine)
      throw new HttpError(403, 'Only the person responsible for this task can say who else is on it.');

    const u = await one('select id, name from users where id=$1 and active', [userId]);
    if (!u) throw new HttpError(404, 'No such account.');

    if (b.act === 'remove') {
      await tx(async (c) => {
        await c.query('delete from task_helpers where task_id=$1 and user_id=$2', [taskId, userId]);
        await note(c, me, 'task', taskId, `took ${u.name} off the people working on this`);
      });
      return Response.json({ ok: true });
    }

    /* The separation of duties, said at the moment somebody would break it
       rather than at the moment they try to sign. */
    if (t.verifier_id === userId)
      throw new HttpError(409,
        `${u.name} is the verifier on this task. Nobody verifies work they did themselves.`);
    if (t.approver_id === userId)
      throw new HttpError(409,
        `${u.name} is the approval authority on this task. Nobody approves work they did themselves.`);
    if (t.owner_id === userId)
      throw new HttpError(409, `${u.name} is already the responsible person.`);

    await tx(async (c) => {
      await c.query(
        `insert into task_helpers (task_id, user_id, added_by) values ($1,$2,$3)
         on conflict do nothing`, [taskId, userId, me.id]);
      await note(c, me, 'task', taskId, `added ${u.name} to the people working on this`);
    });
    return Response.json({ ok: true });
  } catch (e) { return fail(e); }
}

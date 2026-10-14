import { one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { requireOpenSite } from '@/lib/lock';
import { mayManage } from '@/lib/roles';
import { note } from '@/lib/log';

/**
 * Supporting departments.
 * ---------------------------------------------------------------------------
 * `task_roles` has been read since the first day — it is what the
 * responsibility matrix counts — and until now nothing could write to it.
 * The seed filled it, and a department that joined a task afterwards could
 * be typed into the free-text "Supporting" box and nowhere else, so the
 * matrix slowly stopped describing the project.
 *
 * Only the supporting letter is set here. The other three are not this
 * route's to give:
 *
 *   L   is the task's lead department, which lives on the task itself
 *   V   is read from the verifier's own department
 *   A   is read from the approval authority's own department
 *
 * Writing those here would mean two places telling different stories about
 * the same task.
 */
async function gate(taskId: string) {
  const me = await requireUser();
  await requireOpenSite(me.role);
  const t = await one('select * from tasks where id=$1 and deleted_at is null', [taskId]);
  if (!t) throw new HttpError(404, 'No task with that ID.');
  /* The person doing the work knows who is helping them; so does the
     project office. Nobody else writes it. */
  if (!(await mayManage(me.role)) && t.owner_id !== me.id)
    throw new HttpError(403, `Only ${taskId}'s responsible person or the project office can change who supports it.`);
  return { me, t };
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const taskId = String(b.taskId || '').trim();
    const deptId = String(b.deptId || '').trim();
    if (!taskId || !deptId) throw new HttpError(400, 'A task and a department, please.');

    const { me, t } = await gate(taskId);
    const d = await one('select * from departments where id=$1', [deptId]);
    if (!d) throw new HttpError(400, 'There is no department with that ID.');
    if (t.lead_dept_id === deptId)
      throw new HttpError(409, `${d.name} already leads ${taskId}. A department does not support itself.`);

    await tx(async (c) => {
      const r = await c.query(
        `insert into task_roles (task_id, dept_id, role) values ($1,$2,'S')
         on conflict do nothing`, [taskId, deptId]);
      if (r.rowCount)
        await note(c, me, 'task', taskId, `added ${d.name} as a supporting department`);
    });
    return Response.json({ ok: true, taskId, deptId, role: 'S' });
  } catch (e) { return fail(e); }
}

export async function DELETE(req: Request) {
  try {
    const b = await req.json();
    const taskId = String(b.taskId || '').trim();
    const deptId = String(b.deptId || '').trim();
    if (!taskId || !deptId) throw new HttpError(400, 'A task and a department, please.');

    const { me } = await gate(taskId);
    const d = await one('select * from departments where id=$1', [deptId]);

    await tx(async (c) => {
      const r = await c.query(
        `delete from task_roles where task_id=$1 and dept_id=$2 and role='S'`, [taskId, deptId]);
      if (r.rowCount)
        await note(c, me, 'task', taskId,
          `removed ${d ? d.name : deptId} from the supporting departments`);
    });
    return Response.json({ ok: true, taskId, deptId });
  } catch (e) { return fail(e); }
}

import { q, one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { requireOpenSite } from '@/lib/lock';
import { mayManage } from '@/lib/roles';
import { note } from '@/lib/log';

/**
 * Renumbering a task.
 * ---------------------------------------------------------------------------
 * A task ID is not a key the database chose: it is what the Chairman's
 * tracker calls that piece of work, and a tracker gets renumbered. CL25-19
 * becomes CL25-20 when something is inserted above it, and the register has
 * to be able to follow — otherwise the two drift apart and the whole point of
 * the system goes with them.
 *
 * Nine tables point at the ID and update-7 made every one of them follow a
 * rename, so one `update tasks set id` carries the budget lines, the
 * photographs, the decisions, the approval chain, the survey rows, the
 * student days, the departmental roles, the notices — and the sub-tasks,
 * through parent_id.
 *
 * Three places hold the ID as text with no reference behind it, and the
 * database cannot follow those. They are done here, in the same transaction:
 *
 *   tasks.depends_on        "waits for CL25-19", an array of IDs
 *   student_teams.task_ids  which tasks a team is working on
 *   activity.subject_id     the trail, which must keep pointing at the task
 *                           it describes or the task's own history empties
 *
 * The sub-tasks are renamed too, and not only re-pointed. CL25-19.1 under a
 * task now called CL25-20 would be a lie the register tells about itself, and
 * the naming rule in POST /task would refuse to create it. So they are
 * renumbered to match, one statement each, inside the same transaction.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    if (!(await mayManage(me.role)))
      throw new HttpError(403, 'Renumbering a task is for a role that may act on the register.');

    const b = await req.json();
    const from = String(b.from || '').trim();
    const to = String(b.to || '').trim();

    if (!from || !to) throw new HttpError(400, 'Which task, and what should it be called?');
    if (from === to) throw new HttpError(400, 'That is the number it already has.');
    if (to.length > 40) throw new HttpError(400, 'A task ID can be up to 40 characters.');
    if (/[\/\\]/.test(to)) throw new HttpError(400, 'A task ID cannot contain a slash.');
    if (/[\u0000-\u001f]/.test(to)) throw new HttpError(400, 'That ID contains something unprintable.');

    const t = await one('select * from tasks where id=$1 and deleted_at is null', [from]);
    if (!t) throw new HttpError(404, `There is no task ${from}.`);
    if (await one('select id from tasks where id=$1', [to]))
      throw new HttpError(409, `${to} is already taken. Give it a different number.`);

    /* A sub-task is named after its parent, so it can only be renumbered by
       renumbering the parent — otherwise CL25-19.1 could end up under
       CL25-20, which is a lie and which POST /task would refuse to create. */
    if (t.parent_id) {
      const want = new RegExp(`^${t.parent_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+$`);
      if (!want.test(to))
        throw new HttpError(400,
          `A sub-task of ${t.parent_id} is named ${t.parent_id}.1, ${t.parent_id}.2 and so on. `
          + `To move it elsewhere, renumber ${t.parent_id} instead.`);
    }

    const kids = await q(
      `select id from tasks where parent_id=$1 and deleted_at is null order by id`, [from]);

    const moved: [string, string][] = [[from, to]];
    for (const k of kids as any[]) {
      /* CL25-19.3 under CL25-20 becomes CL25-20.3: the tail is kept, because
         it is the number the tracker gave that piece of work. */
      const tail = String(k.id).slice(from.length);
      const want = to + tail;
      if (await one('select id from tasks where id=$1', [want]))
        throw new HttpError(409, `${want} is already taken, so ${k.id} has nowhere to go.`);
      moved.push([String(k.id), want]);
    }

    await tx(async (c) => {
      for (const [was, now_] of moved) {
        /* The nine tables that reference it follow by themselves. */
        await c.query('update tasks set id=$2, updated_at=now(), updated_by=$3 where id=$1',
          [was, now_, me.id]);

        /* And the three that cannot. */
        await c.query(
          `update tasks set depends_on = array_replace(depends_on, $1, $2)
            where $1 = any(depends_on)`, [was, now_]);
        await c.query(
          `update student_teams set task_ids = array_replace(task_ids, $1, $2)
            where $1 = any(task_ids)`, [was, now_]).catch(() => {});
        await c.query(
          `update activity set subject_id = $2
            where subject_id = $1 and subject in ('task','photo','budget','approval')`,
          [was, now_]);
      }

      await note(c, me, 'task', to,
        moved.length > 1
          ? `renumbered ${from} to ${to}, and its ${moved.length - 1} sub-task`
            + `${moved.length === 2 ? '' : 's'} with it`
          : `renumbered ${from} to ${to}`);
    });

    return Response.json({ ok: true, from, to, moved: moved.length });
  } catch (e) { return fail(e); }
}

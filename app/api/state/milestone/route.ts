import { one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { requireOpenSite } from '@/lib/lock';
import { mayManage } from '@/lib/roles';
import { note } from '@/lib/log';

/**
 * Gates.
 *
 * A gate is not a task and is deliberately not linked to one: G8 is reached
 * when the Pro-VC and the independent reviewers say the campus is ready, not
 * when some set of rows all read Completed. Recording that is the Director's,
 * and the evidence has to be named — an achieved gate with nothing attached
 * shows as "Achieved – add evidence" until it is.
 */
export async function PATCH(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    if (!await mayManage(me.role)) throw new HttpError(403, 'Only the Project Director records a gate.');

    const b = await req.json();
    const id = String(b.id || '');
    const m = await one('select * from milestones where id=$1', [id]);
    if (!m) throw new HttpError(404, 'No gate with that ID.');

    const status = String(b.status || m.status);
    if (!['Pending', 'Achieved', 'Missed'].includes(status))
      throw new HttpError(400, 'A gate is Pending, Achieved or Missed.');

    const row = await tx(async (c) => {
      const r = (await c.query(
        `update milestones set status=$2,
                achieved_on = case when $2='Achieved' then coalesce($3, achieved_on, current_date) else null end,
                evidence_url = coalesce(nullif($4,''), evidence_url),
                due_on = coalesce($5, due_on)
          where id=$1 returning *`,
        [id, status, b.achievedOn || null, String(b.evidenceUrl || ''), b.dueOn || null])).rows[0];
      if (m.status !== status)
        await note(c, me, 'milestone', id, `marked ${status.toLowerCase()}`,
          { field: 'status', was: m.status, now: status, note: m.title });
      else
        await note(c, me, 'milestone', id, 'updated the gate', { note: m.title });
      return r;
    });

    const state = await one('select * from milestone_state where id=$1', [id]);
    return Response.json({ ok: true, milestone: state || row });
  } catch (e) { return fail(e); }
}

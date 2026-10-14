import { one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { requireOpenSite } from '@/lib/lock';
import { mayManage } from '@/lib/roles';
import { canEdit } from '@/lib/perm';
import { bin } from '@/lib/trash';
import { note } from '@/lib/log';

/**
 * A decision, in three hands.
 *
 * The originator submits it, the named verifier checks it, and the approval
 * authority decides. Each of the three can only do their own part, and the
 * stage the item has reached is worked out in the view from what has actually
 * been filled in — never typed.
 *
 * Returning an item to its originator is deliberately available to both the
 * verifier and the approver: something that cannot be sent back is something
 * people route around.
 */
export async function PATCH(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    const b = await req.json();
    const id = String(b.id || '');
    const act = String(b.act || '');

    const a = await one('select * from approvals where id=$1', [id]);
    if (!a) throw new HttpError(404, 'No decision with that ID.');

    const boss = await mayManage(me.role);
    const isOriginator = a.originator_id === me.id;
    const isVerifier = a.verifier_id === me.id;
    const decided = ['Approved', 'Approved with conditions', 'Rejected'].includes(a.decision);

    const row = await tx(async (c) => {
      switch (act) {
        case 'submit': {
          if (!isOriginator && !boss) throw new HttpError(403, 'Only the originator submits this.');
          if (a.submitted_on) throw new HttpError(409, 'That was submitted already.');
          const r = (await c.query(
            `update approvals set submitted_on=current_date, decision='Submitted', updated_at=now()
              where id=$1 returning *`, [id])).rows[0];
          await note(c, me, 'approval', id, 'submitted the request', { note: a.item });
          return r;
        }
        case 'verify': {
          if (!isVerifier && !boss) throw new HttpError(403, 'Only the named verifier can verify this.');
          if (isOriginator && !boss) throw new HttpError(403, 'Nobody verifies their own request.');
          const ok = b.verified !== false;
          const r = (await c.query(
            `update approvals set verification=$2, verified_on=$3, updated_at=now()
              where id=$1 returning *`,
            [id, ok ? 'Verified' : 'Returned', ok ? new Date().toISOString().slice(0, 10) : null])).rows[0];
          await note(c, me, 'approval', id, ok ? 'verified it' : 'returned it to the originator',
            { note: String(b.note || '') });
          return r;
        }
        case 'decide': {
          /* The approval authority is recorded as a post — "Honorable Chairman",
             "Registrar / competent authority" — because most of them will never
             hold an account here. Somebody with the Director's authority records
             the decision and the trail says who did. */
          if (!boss && me.role !== 'APPROVER')
            throw new HttpError(403, 'Only an approval authority records a decision.');
          if (decided && !boss) throw new HttpError(409, 'That has been decided already.');
          const d = String(b.decision || '');
          if (!['Approved', 'Approved with conditions', 'Returned', 'Rejected'].includes(d))
            throw new HttpError(400, 'That is not a decision this system knows.');
          const r = (await c.query(
            `update approvals set decision=$2, decided_on=current_date, decided_by=$3,
                    conditions=$4, evidence_url=coalesce(nullif($5,''), evidence_url), updated_at=now()
              where id=$1 returning *`,
            [id, d, me.id, String(b.conditions || ''), String(b.evidenceUrl || '')])).rows[0];
          await note(c, me, 'approval', id, `recorded the decision: ${d}`,
            { field: 'decision', was: a.decision, now: d, note: String(b.conditions || '') });
          return r;
        }
        case 'edit': {
          if (!boss) throw new HttpError(403, 'Only the Project Director can edit a decision item.');
          const r = (await c.query(
            `update approvals set item=coalesce(nullif($2,''), item),
                    final_authority=coalesce(nullif($3,''), final_authority),
                    due_on=coalesce($4, due_on), chairman_needed=coalesce($5, chairman_needed),
                    originator_id=coalesce($6, originator_id), verifier_id=coalesce($7, verifier_id),
                    impact=coalesce(nullif($8,''), impact), updated_at=now()
              where id=$1 returning *`,
            [id, String(b.item || ''), String(b.finalAuthority || ''), b.dueOn || null,
             b.chairmanNeeded === undefined ? null : !!b.chairmanNeeded,
             b.originatorId || null, b.verifierId || null, String(b.impact || '')])).rows[0];
          await note(c, me, 'approval', id, 'edited the decision item');
          return r;
        }
        default:
          throw new HttpError(400, 'That is not something you can do to a decision.');
      }
    });

    const state = await one('select * from approval_state where id=$1', [id]);
    return Response.json({ ok: true, approval: state || row });
  } catch (e) { return fail(e); }
}

/**
 * A new decision.
 *
 * The workbook arrived with eighteen, D01 to D18, and no way to add the
 * nineteenth — which is what happens the first time something needs the
 * Chairman that nobody wrote down in September. The id comes from a sequence
 * that starts at D100, so a new one can never collide with the originals.
 */
export async function POST(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    if (!(await canEdit(me.role, 'approvals')))
      throw new HttpError(403, 'Your role cannot add a decision.');

    const b = await req.json();
    const item = String(b.item || '').trim();
    if (!item) throw new HttpError(400, 'A decision needs to say what is being decided.');

    /* Every decision in the tracker is a decision about a piece of work, and
       the table says so: task_id is not null. */
    const taskId = String(b.taskId || '').trim();
    if (!taskId) throw new HttpError(400, 'A decision has to be about a task. Choose one.');
    const against = await one('select id from tasks where id=$1 and deleted_at is null', [taskId]);
    if (!against) throw new HttpError(409, `There is no task ${taskId}.`);

    const n = await one(`select nextval('decision_seq') as n`);
    const id = `D${n!.n}`;

    const row = await tx(async (c) => {
      const r = await c.query(
        `insert into approvals
           (id, task_id, item, originator_id, verifier_id, final_authority,
            chairman_needed, due_on, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'added')
         returning *`,
        [id, taskId, item, me.id, b.verifierId || null,
         String(b.finalAuthority || '').slice(0, 200), !!b.chairmanNeeded,
         b.dueOn || null]);
      await note(c, me, 'approval', id, `added the decision "${item.slice(0, 60)}"`);
      return r.rows[0];
    });
    return Response.json({ ok: true, id, row });
  } catch (e) { return fail(e); }
}

/** To the recycle bin, with its approval steps. */
export async function DELETE(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    if (!(await mayManage(me.role)))
      throw new HttpError(403, 'Removing a decision is for a role that may act on other people\'s records.');

    const { id, reason } = await req.json();
    const a = await one('select * from approvals where id=$1', [String(id || '')]);
    if (!a) throw new HttpError(404, 'No decision with that ID.');
    if (['Approved', 'Approved with conditions', 'Rejected'].includes(a.decision)
        && !String(reason || '').trim())
      throw new HttpError(400, 'That decision has already been made. Say why it is being removed.');

    let moved: any = null;
    await tx(async (c) => {
      moved = await bin(c, me, 'approval', a.id);
      await note(c, me, 'approval', a.id, 'moved to the recycle bin',
        { note: String(reason || '') });
    });
    return Response.json({ ok: true, moved });
  } catch (e) { return fail(e); }
}

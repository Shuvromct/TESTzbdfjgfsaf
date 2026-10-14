import { q, one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { canRead, canEdit, isKeeper } from '@/lib/perm';
import { mailReady, sentBefore } from '@/lib/mail';
import { mailForApproval, mailTaskList, mailReturned } from '@/lib/notices';
import { note } from '@/lib/log';

/**
 * Raising a hand, and telling somebody where they stand.
 * ---------------------------------------------------------------------------
 * Two things a person decides to do, rather than things that happen to them:
 *
 *   approval   "This is ready — whoever is next, it is with you now." The
 *              responsible person presses it when the work is actually done,
 *              which is the point: an authority's attention is spent by a
 *              person who has judged it worth spending, not by the register.
 *
 *   tasklist   "Here is where you stand." The project office sends somebody
 *              their own open work, or sends everybody theirs at once before
 *              a meeting.
 *
 * Asking again
 * ------------
 * A second reminder to the same person about the same task needs a reason in
 * writing. Not to make it hard — to make it worth reading. A Vice-Chancellor
 * seeing "third reminder: the IAUP meeting is on the 15th and this is holding
 * up CL25-21" knows in one line why this one is different from the forty
 * others; an identical copy of yesterday's message tells him nothing, and
 * teaches him to ignore the next one. It is also, afterwards, a record of
 * which signatures the project had to chase.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const me = await requireUser();
    const b = await req.json();
    const act = String(b.act || '');

    if (!mailReady())
      throw new HttpError(400,
        'Email is not set up on the server. SMTP_HOST, SMTP_USER and SMTP_PASS go in the '
        + 'Vercel settings, then redeploy.');

    /* ------------------------------------------------- send for approval */
    if (act === 'approval') {
      const t = await one(
        `select * from tasks where id=$1 and deleted_at is null`, [String(b.id || '')]);
      if (!t) throw new HttpError(404, 'No task with that ID.');

      const caller = await one('select dept_id from users where id=$1', [me.id]);
      const mine = t.owner_id === me.id
        || (!!t.lead_dept_id && t.lead_dept_id === caller?.dept_id)
        || await isKeeper(me.role);
      if (!mine)
        throw new HttpError(403, 'Only the person responsible for this task can send it on.');

      /* Whoever is actually next. Verification first, because that is the
         order the project checks things in; once it is verified the same
         button reaches the approval authority instead. */
      const stage: 'verification' | 'approval' = t.verified_by ? 'approval' : 'verification';
      const toId = stage === 'verification' ? t.verifier_id : t.approver_id;
      if (!toId)
        throw new HttpError(409, stage === 'verification'
          ? 'Nobody is named as the verifier on this task.'
          : 'Nobody is named as the approval authority on this task.');
      if (toId === me.id)
        throw new HttpError(409, 'You are the one it is waiting on. There is nobody to tell.');

      const was = await sentBefore(t.id, toId, 'approval');
      const reason = String(b.reason || '').trim().slice(0, 300);
      if (was && !reason) {
        const who = await one('select name from users where id=$1', [toId]);
        return Response.json({
          ok: false, needReason: true,
          lastSent: was.toISOString(),
          to: who?.name || '',
          stage,
        });
      }

      const r = await tx(async (c) => {
        const out = await mailForApproval(c, me, t, toId, stage, reason, !!was);
        if (out.sent) {
          /* The register says so too, so somebody reading the task knows it
             has been sent on without having to open the trail. */
          if (stage === 'verification' && t.status !== 'Completed'
              && t.approval_status === 'Not required')
            await c.query(`update tasks set approval_status='Pending' where id=$1`, [t.id]);
          const who = await one('select name from users where id=$1', [toId]);
          await note(c, me, 'task', t.id,
            `sent to ${who?.name || 'the next authority'} for ${stage}`
            + (reason ? ` — ${reason}` : ''));
        }
        return out;
      });
      if (!r.sent) throw new HttpError(502, `It could not be sent — ${r.reason}`);

      const state = await one('select * from task_state where id=$1', [t.id]);
      return Response.json({ ok: true, stage, task: state });
    }

    /* ------------------------------------------------ returned to sender */
    if (act === 'returned') {
      const t = await one(
        `select * from tasks where id=$1 and deleted_at is null`, [String(b.id || '')]);
      if (!t) throw new HttpError(404, 'No task with that ID.');
      if (t.verifier_id !== me.id && t.approver_id !== me.id && !(await isKeeper(me.role)))
        throw new HttpError(403, 'Only the verifier or the approval authority can send this back.');
      const why = String(b.why || '').trim().slice(0, 300);
      if (!why) throw new HttpError(400, 'Say what needs fixing, or it cannot be acted on.');

      await tx(async (c) => {
        await mailReturned(c, me, t, why);
        await note(c, me, 'task', t.id, `returned it — ${why}`);
      });
      return Response.json({ ok: true });
    }

    /* -------------------------------------------- somebody's own tasks */
    if (act === 'tasklist' || act === 'tasklist-all') {
      if (!(await canEdit(me.role, 'users')) && !(await canRead(me.role, 'users')))
        throw new HttpError(403, 'Sending somebody their task list is for the project office.');

      const rows = await q(`select * from task_state where deleted_at is null`);
      const people = act === 'tasklist'
        ? await q(`select id, name, email from users where id=$1 and active`, [String(b.id || '')])
        : await q(`select id, name, email from users where active and email <> '' order by name`);
      if (!people.length) throw new HttpError(404, 'Nobody to send to.');

      const sent: string[] = [], skipped: string[] = [], failed: string[] = [];
      await tx(async (c) => {
        for (const p of people as any[]) {
          const r = await mailTaskList(c, me, p, rows);
          if (r.sent) sent.push(p.name);
          else if (r.nothing) skipped.push(p.name);
          else failed.push(`${p.name}: ${r.reason}`);
        }
        await note(c, me, 'user', people.length === 1 ? people[0].id : me.id,
          people.length === 1
            ? `emailed ${people[0].name} their task list`
            : `emailed ${sent.length} people their own task lists`);
      });

      return Response.json({ ok: failed.length === 0, sent, skipped, failed });
    }

    throw new HttpError(400, 'Send a task on, send it back, or send somebody their task list.');
  } catch (e) { return fail(e); }
}

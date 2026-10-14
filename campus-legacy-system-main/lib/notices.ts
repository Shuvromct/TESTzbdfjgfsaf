import type { PoolClient } from 'pg';
import { one } from './db';
import { record, taskUrl, day, when, mailReady,
         factCard, callout,
         sendLetter, taskCard, cardMeta, wideButton, SIGNATURE } from './mail';
import type { Session } from './auth';

/**
 * The four messages this project sends.
 * ---------------------------------------------------------------------------
 * Who hears about a task, and when, is the whole design — so it lives in one
 * file rather than being scattered through the route handlers that happen to
 * trigger it.
 *
 *   assigned   The person who has to do the work, the moment their name goes
 *              on it. Nobody else. The verifier and the approval authority
 *              are named on the task from the start, and telling them then
 *              would mean a Vice-Chancellor with forty tasks getting forty
 *              emails on the day the register is written — after which he
 *              reads none of them, including the one that matters.
 *
 *   approval   The next pair of hands, when the responsible person says the
 *              work is ready. This is the one that costs an authority's
 *              attention, so a person decides when it is spent, not the
 *              system.
 *
 *   verified   Signed off: the approval authority hears, without anybody
 *              having to remember to tell them. The chain should not need a
 *              second press to carry on moving.
 *
 *   returned   Sent back, with the reason, to the person who has to fix it.
 */

const nameOf = async (id: any) => {
  if (!id) return null;
  return await one('select id, name, email, cc_email from users where id=$1 and active', [id]);
};

/* ------------------------------------------------------- 1. a new task */
export async function mailAssigned(
  c: PoolClient, by: Session, task: any, ownerId: string,
) {
  if (!mailReady() || !ownerId || ownerId === by.id) return;
  const to = await nameOf(ownerId);
  if (!to?.email) return;

  const [verifier, approver] = await Promise.all([
    nameOf(task.verifier_id), nameOf(task.approver_id)]);

  const subject = `${task.id} — you are responsible for this`;
  const r = await sendLetter(to.email, subject, {
    kicker: 'A task is yours',
    name: to.name,
    lead: 'You have been named as the responsible person for this task.',
    body: `
      ${taskCard(0, taskUrl(task.id), task.title,
        cardMeta(task.id, task.deadline ? `due ${day(task.deadline)}` : ''))}
      ${factCard([
        ['Deadline', task.deadline
          ? `${day(task.deadline)} — ${when(task.deadline)}` : 'not set'],
        ['Priority', task.priority],
        ['Category', task.category],
        ['Site', task.site],
        ['Verified by', verifier?.name],
        ['Approved by', approver?.name],
      ])}
      ${task.photos_required ? callout('Before it can be closed',
        'This task needs an after photograph. Take it on site — the date and place are '
        + 'read from the picture itself.', 'blue') : ''}
      ${wideButton(taskUrl(task.id), 'Open the task')}
      ${SIGNATURE}`,
    foot: 'You are receiving this because you are named on this task.',
  });
  await record(c, { kind: 'assigned', taskId: task.id, toUser: to.id, toEmail: to.email,
                    subject, sentBy: by.id, r });
}

/* --------------------------------------------- 2. sent for a signature */
export async function mailForApproval(
  c: PoolClient, by: Session, task: any, toId: string,
  stage: 'verification' | 'approval', reason = '', again = false,
) {
  const to = await nameOf(toId);
  if (!to?.email) return { sent: false, reason: 'That person has no email address on file.' };

  const word = stage === 'verification' ? 'verification' : 'approval';
  const subject = `${task.id} — ${again ? 'second reminder, ' : ''}your ${word} is needed`;

  const owner = await nameOf(task.owner_id);
  const act = stage === 'verification' ? 'check' : 'sign off';
  const r = await sendLetter(to.email, subject, {
    kicker: `Your ${word} is needed`,
    name: to.name,
    lead: `${owner?.name || 'The responsible person'} says this work is finished `
        + 'and has sent it to you.',
    body: `
      ${taskCard(0, taskUrl(task.id), task.title,
        cardMeta(task.id, task.completed_on
          ? `completed ${day(task.completed_on)}` : String(task.status || '')))}
      ${factCard([
        ['Done by', owner?.name],
        ['Completed', day(task.completed_on)],
        ['Progress', `${Math.round((Number(task.progress) || 0) * 100)}%`],
        ['Status', task.status],
        ['Deadline', task.deadline
          ? `${day(task.deadline)} — ${when(task.deadline)}` : 'not set'],
      ])}
      ${callout('Sent again, because', reason, 'amber')}
      ${wideButton(taskUrl(task.id), `Open and ${act}`)}
      ${SIGNATURE}`,
    foot: `You are receiving this because you are the `
        + `${stage === 'verification' ? 'verifier' : 'approval authority'} for this task. `
        + 'Nobody signs off their own work — if this is not yours to decide, '
        + 'tell the project office.',
  });
  await record(c, { kind: 'approval', taskId: task.id, toUser: to.id, toEmail: to.email,
                    subject, reason, sentBy: by.id, r });
  return r;
}

/* ------------------------------------ 3. verified — the chain moves on */
export async function mailVerified(c: PoolClient, by: Session, task: any) {
  if (!mailReady() || !task.approver_id) return;
  const to = await nameOf(task.approver_id);
  if (!to?.email) return;

  const [who, owner] = await Promise.all([
    nameOf(task.verified_by), nameOf(task.owner_id)]);
  const subject = `${task.id} — verified, your approval is needed`;
  const r = await sendLetter(to.email, subject, {
    kicker: 'Verified — now yours',
    name: to.name,
    lead: `${who?.name || 'The verifier'} has checked this work. `
        + 'Nobody had to remember to tell you.',
    body: `
      ${taskCard(0, taskUrl(task.id), task.title,
        cardMeta(task.id, task.verified_on ? `verified ${day(task.verified_on)}` : ''))}
      ${factCard([
        ['Done by', owner?.name],
        ['Verified by', who?.name],
        ['Verified on', day(task.verified_on)],
        ['Site', task.site],
        ['Still to do', 'your approval'],
      ])}
      ${wideButton(taskUrl(task.id), 'Open and approve')}
      ${SIGNATURE}`,
    foot: 'You are receiving this because you are the approval authority for this task.',
  });
  await record(c, { kind: 'verified', taskId: task.id, toUser: to.id, toEmail: to.email,
                    subject, sentBy: by.id, r });
}

/* ------------------------------------------------- 4. sent back again */
export async function mailReturned(
  c: PoolClient, by: Session, task: any, why = '',
) {
  if (!mailReady() || !task.owner_id || task.owner_id === by.id) return;
  const to = await nameOf(task.owner_id);
  if (!to?.email) return;

  const subject = `${task.id} — returned to you`;
  const r = await sendLetter(to.email, subject, {
    kicker: 'Sent back',
    name: to.name,
    lead: `${by.name} has sent this back for more work.`,
    body: `
      ${taskCard(0, taskUrl(task.id), task.title,
        cardMeta(task.id, task.deadline ? `due ${day(task.deadline)}` : ''))}
      ${callout('Why it came back', why, 'red')}
      ${factCard([
        ['Sent back by', by.name],
        ['On', day(new Date().toISOString())],
        ['Deadline', task.deadline
          ? `${day(task.deadline)} — ${when(task.deadline)}` : 'not set'],
        ['Site', task.site],
      ])}
      ${wideButton(taskUrl(task.id), 'Open the task')}
      ${SIGNATURE}`,
    foot: 'You are receiving this because you are the responsible person for this task.',
  });
  await record(c, { kind: 'returned', taskId: task.id, toUser: to.id, toEmail: to.email,
                    subject, sentBy: by.id, r });
}

/* ----------------------------------------- 5. somebody's own task list */
export async function mailTaskList(
  c: PoolClient, by: Session, person: any, rows: any[],
): Promise<{ sent: boolean; reason: string; nothing?: boolean }> {
  const mine = rows.filter(t => t.owner_id === person.id);
  const toCheck = rows.filter(t =>
    t.verifier_id === person.id && t.status === 'Completed' && !t.verified_by);
  const toDecide = rows.filter(t =>
    t.approver_id === person.id && !['Approved', 'Not required'].includes(t.approval_status));

  const late = mine.filter(t => t.effective_status === 'Delayed')
    .map(t => ({ ...t, note: when(t.deadline) }));
  const soon = mine.filter(t => t.effective_status === 'Due soon')
    .map(t => ({ ...t, note: day(t.deadline) }));
  const rest = mine.filter(t => !['Delayed', 'Due soon', 'Completed'].includes(t.effective_status))
    .map(t => ({ ...t, note: t.deadline ? day(t.deadline) : '—' }));

  if (!late.length && !soon.length && !rest.length && !toCheck.length && !toDecide.length)
    return { sent: false, reason: `${person.name} has nothing open.`, nothing: true };

  /* One list, not five. The person opening this wants to know what is on
     them, in the order it falls due — being told which bucket each task sits
     in is the project office's way of reading the register, not theirs.
     Nearest deadline first; anything undated at the end, where it cannot
     push a dated task down the page. */
  const all = [...late, ...soon, ...rest,
               ...toCheck.map(t => ({ ...t, note: day(t.deadline) })),
               ...toDecide.map(t => ({ ...t, note: day(t.deadline) }))];
  const seen = new Set<string>();
  const list = all.filter(t => !seen.has(t.id) && seen.add(t.id))
    .sort((a, b) => (a.deadline ? Date.parse(a.deadline) : Infinity)
                  - (b.deadline ? Date.parse(b.deadline) : Infinity));

  const subject = `Your tasks on DIU Campus Legacy 25`;
  const body = `
    ${list.map((t, i) => taskCard(i + 1, taskUrl(t.id), t.title,
        cardMeta(t.id, day(t.deadline)))).join('')}
    ${wideButton(SITEHOME(), 'Open all your tasks')}
    ${SIGNATURE}`;

  const r = await sendLetter(person.email, subject, {
    kicker: 'Your task list',
    name: person.name,
    lead: `${list.length} task${list.length === 1 ? ' is' : 's are'} open in your name.`
        + ' Tap any one to open it.',
    body,
    foot: 'You are receiving this because you are named on these tasks.',
  });
  await record(c, { kind: 'tasklist', toUser: person.id, toEmail: person.email,
                    subject, sentBy: by.id, r });
  return r;
}

const SITEHOME = () => {
  const s = (process.env.PUBLIC_SITE_URL || '').replace(/\/+$/, '');
  return s ? `${s}/tasks?mine=1` : '';
};

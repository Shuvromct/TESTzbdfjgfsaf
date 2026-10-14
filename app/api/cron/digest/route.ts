import { q } from '@/lib/db';
import { sendTelegram, telegramReady } from '@/lib/notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * The morning note, at eight o'clock Dhaka time.
 *
 * What is late, what is due this week, what is waiting on a signature, and
 * which gate is next. It reads the same views the screens read, so the note and
 * the dashboard can never disagree.
 *
 * Vercel's scheduler sends CRON_SECRET; nothing else can fire this.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') || '';
    if (auth !== `Bearer ${secret}`) return new Response('no', { status: 401 });
  }

  try {
    const [late, soon, waiting, gates, gaps] = await Promise.all([
      q(`select id, title, delay_days, lead_dept_id from task_state
          where effective_status='Delayed' order by delay_days desc, deadline limit 12`),
      q(`select id, title, deadline from task_state
          where effective_status='Due soon' order by deadline limit 10`),
      q(`select id, item, stage, due_on, overdue from approval_state
          where decision in ('Pending','Submitted') order by overdue desc, due_on limit 10`),
      q(`select id, title, due_on, flag, days_left from milestone_state
          where status='Pending' and due_on >= current_date - 14 order by due_on limit 4`),
      q(`select count(*)::int as n from task_state where effective_status='Completed – evidence gap'`),
    ]);

    const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const L: string[] = [];
    L.push(`<b>DIU Campus Legacy 25</b> — ${new Date().toLocaleDateString('en-GB',
      { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' })}`);

    if (late.length) {
      L.push(`\n<b>Delayed (${late.length})</b>`);
      late.forEach((t: any) => L.push(`• ${esc(t.id)} — ${esc(t.title)} <i>(${t.delay_days}d)</i>`));
    }
    if (soon.length) {
      L.push(`\n<b>Due within three days</b>`);
      soon.forEach((t: any) => L.push(`• ${esc(t.id)} — ${esc(t.title)} <i>(${t.deadline})</i>`));
    }
    if (waiting.length) {
      L.push(`\n<b>Waiting on a decision</b>`);
      waiting.forEach((a: any) =>
        L.push(`• ${esc(a.id)} — ${esc(a.item)}${a.overdue ? ' <b>overdue</b>' : ''} <i>(${esc(a.stage)})</i>`));
    }
    if (gates.length) {
      L.push(`\n<b>Gates</b>`);
      gates.forEach((g: any) => L.push(`• ${esc(g.id)} ${esc(g.title)} — ${esc(g.flag)} <i>(${g.due_on})</i>`));
    }
    if (gaps[0]?.n) L.push(`\n${gaps[0].n} task(s) marked complete without the evidence to close them.`);
    if (L.length === 1) L.push('\nNothing late, nothing due, nothing waiting. Quiet day.');

    const text = L.join('\n');
    const res = telegramReady() ? await sendTelegram(text) : { sent: false, reason: 'not configured' };
    await q(`insert into activity (user_name, role, subject, subject_id, what, note)
             values ('system','SYSTEM','settings','digest',$1,$2)`,
      [res.sent ? 'sent the daily digest' : 'could not send the daily digest', res.reason]).catch(() => {});

    return Response.json({ ok: true, sent: res.sent, reason: res.reason,
                           counts: { late: late.length, soon: soon.length, waiting: waiting.length } });
  } catch (e: any) {
    console.error(e);
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

import nodemailer from 'nodemailer';
import type { PoolClient } from 'pg';
import { q } from './db';

/**
 * Email, as this project needs it.
 * ---------------------------------------------------------------------------
 * Everybody here has a @diu.edu.bd address on Google, so the mail goes out
 * through the project office's own account rather than a service with a
 * domain nobody recognises. A notice from a stranger's domain to a
 * university address is a notice in the spam folder, and a notice in the spam
 * folder is worse than no notice at all — people stop looking and the work
 * still stops.
 *
 * Without the settings nothing is sent and nothing breaks, exactly as with
 * Telegram: the buttons say so plainly instead of failing.
 *
 * The rule the whole design turns on
 * ----------------------------------
 * A Vice-Chancellor named as the approval authority on forty tasks does not
 * want forty emails the day the register is written. He wants one, on the
 * day his signature is actually the thing holding the work up. So being named
 * on a task sends nothing to the authorities; only the person who has to do
 * the work hears about it, and they decide when to raise their hand.
 */

export const mailReady = () =>
  !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

export const SITE = () =>
  (process.env.PUBLIC_SITE_URL || '').replace(/\/+$/, '');

function post() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

export const esc = (s: any) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ------------------------------------------------------------------ paper */
/**
 * The shape every message comes in.
 *
 * No images and no logo: the mail opens instantly on a phone at the far end
 * of the campus, and a message that is mostly text from a real university
 * address is the one that reaches the inbox rather than the spam folder.
 * Tables rather than modern CSS, because that is what mail clients have
 * agreed on and this has to look the same in Outlook as in Gmail.
 */
function paper(title: string, body: string, foot = '') {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f7fa">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="max-width:560px;background:#fff;border:1px solid #e1e6ee;border-radius:10px">
  <tr><td style="height:4px;background:#12306b;border-radius:10px 10px 0 0;font-size:0">&nbsp;</td></tr>
  <tr><td style="padding:20px 24px 0">
    <div style="font:600 13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;color:#12306b">
      DIU Campus Legacy 25</div>
  </td></tr>
  <tr><td style="padding:14px 24px 22px;
    font:15px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:#151b2b">
    ${body}
  </td></tr>
  <tr><td style="padding:0 24px 20px;border-top:1px solid #eef1f6">
    <div style="padding-top:14px;
      font:12px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:#68718a">
      ${foot || 'You are receiving this because you are named on this task.'}<br>
      Project DIU-CL25-2026 · Daffodil International University
    </div>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

export const button = (href: string, label: string) => href
  ? `<p style="margin:20px 0 4px"><a href="${esc(href)}"
      style="display:inline-block;background:#12306b;color:#fff;text-decoration:none;
      padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px"
      >${esc(label)} →</a></p>` : '';

/* ------------------------------------------------------------- the letter */
/**
 * A second shape, for a message somebody reads as a list rather than a
 * notification: a banded head, cards instead of table rows, and the project
 * office's signature at the foot. The parts are here rather than in
 * notices.ts so that the day the other four messages move across, they move
 * to something that already exists.
 *
 * Same constraints as `paper`. Tables and inline styles only — no <style>
 * block, no flexbox, no grid, no media queries. Outlook renders with Word's
 * engine and Gmail strips a stylesheet, so a layout that leans on any of
 * those falls apart in exactly the inbox that matters here.
 */
export const INK = '#0f1526', NAVY = '#12306b', MUTE = '#6b7488';
export const LINE = '#e4e9f2', WASH = '#f4f6fb', PAGE = '#eceff6';
export const SANS =
  `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
export const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

/**
 * One task, as a card. The whole card is the link. `n` numbers it when the
 * card is one of a list; pass 0 when the message is about a single task and
 * there is nothing to count.
 */
export const taskCard = (n: number, href: string, title: string, meta: string) => `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
    style="margin:0 0 10px">
    <tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;
      border-left:3px solid ${NAVY}">
      <a href="${esc(href)}" style="display:block;text-decoration:none;color:${INK};
         padding:14px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            ${n ? `<td width="30" valign="top" style="padding:1px 12px 0 0">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr><td align="center" width="26" height="26"
                  style="background:${WASH};border-radius:7px;
                  font:600 12px/26px ${SANS};color:${NAVY}">${n}</td></tr>
              </table>
            </td>` : ''}
            <td valign="top">
              <div style="font:600 15px/1.45 ${SANS};color:${INK}">${esc(title)}</div>
              <div style="padding-top:7px;font:12px/1 ${SANS};color:${MUTE}">${meta}</div>
            </td>
            <td width="18" valign="top" align="right"
              style="font:16px/1.3 ${SANS};color:#b7c0d4;padding-left:8px">&rsaquo;</td>
          </tr>
        </table>
      </a>
    </td></tr>
  </table>`;

/** The reference and date under a card's title. */
export const cardMeta = (ref: string, note: string) =>
  `<span style="font:600 11px/1 ${MONO};color:${MUTE};letter-spacing:.03em">${esc(ref)}</span>
   <span style="color:${LINE};padding:0 7px">|</span>
   <span style="color:${MUTE}">${esc(note || 'no date yet')}</span>`;

/** The facts under a single-task message. Two columns, nothing clever. */
export const factCard = (rows: [string, any][]) => {
  const keep = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  return !keep.length ? '' : `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
    style="margin:14px 0 0;background:#ffffff;border:1px solid ${LINE};border-radius:12px">
    <tr><td style="padding:6px 16px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        ${keep.map(([k, v], i) => `<tr>
          <td width="120" valign="top" style="padding:9px 14px 9px 0;font:13px/1.5 ${SANS};
            color:${MUTE};${i ? `border-top:1px solid ${WASH}` : ''}">${esc(k)}</td>
          <td valign="top" style="padding:9px 0;font:600 14px/1.5 ${SANS};color:${INK};
            ${i ? `border-top:1px solid ${WASH}` : ''}">${esc(v)}</td>
        </tr>`).join('')}
      </table>
    </td></tr>
  </table>`;
};

/**
 * Something the reader must not skim past: why the work came back, why they
 * are being asked a second time, what the task cannot close without. Given a
 * colour, because a returned task and a reminder are not the same news.
 */
export const callout = (
  label: string, text: string, tone: 'red' | 'amber' | 'blue' = 'blue',
) => {
  const t = tone === 'red' ? { bg: '#fdf1f1', line: '#f3d5d5', ink: '#a4262c' }
    : tone === 'amber' ? { bg: '#fdf7e8', line: '#f0e2bd', ink: '#8a6a12' }
      : { bg: WASH, line: LINE, ink: NAVY };
  return !text ? '' : `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:14px 0 0">
    <tr><td style="background:${t.bg};border:1px solid ${t.line};border-radius:12px;
      padding:14px 16px">
      <div style="font:600 11px/1.3 ${SANS};color:${t.ink};letter-spacing:.06em;
        text-transform:uppercase;padding-bottom:5px">${esc(label)}</div>
      <div style="font:15px/1.55 ${SANS};color:${INK}">${esc(text)}</div>
    </td></tr></table>`;
};

export const wideButton = (href: string, label: string) => href ? `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
    style="margin:18px 0 0"><tr><td align="center"
    style="background:${NAVY};border-radius:10px">
    <a href="${esc(href)}" style="display:block;padding:14px 20px;color:#ffffff;
      text-decoration:none;font:600 15px/1.2 ${SANS}">${esc(label)} &nbsp;&rarr;</a>
  </td></tr></table>` : '';

/**
 * Who the project office is. Fixed, not the name of whoever pressed the
 * button: the message leaves the project office's own address, so the foot
 * of it should say the same thing the From line does.
 */
export const SIGNATURE = `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
    style="margin:24px 0 0"><tr><td style="background:${WASH};border-radius:12px;
    padding:18px;font:13px/1.7 ${SANS};color:#4b5468">
    <div style="font:600 15px/1.4 ${SANS};color:${INK};padding-bottom:4px">
      Mizanur Rahman</div>
    Project Director, DIU Campus Legacy System<br>
    Assistant Professor<br>
    Department of Multimedia &amp; Creative Technology (MCT)<br>
    Convener, DIU Creative Park<br>
    Daffodil International University<br>
    <span style="color:${MUTE}">Contact:</span>
    <a href="tel:+8801711285050" style="color:${NAVY};text-decoration:none;font-weight:600"
      >01711285050</a>
  </td></tr></table>`;

/** The day in the project's own timezone, for the band. */
const today = () => {
  const d = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: process.env.PROJECT_TIMEZONE || 'Asia/Dhaka',
  });
  return d.replace(/(\d+) (\w+) (\d+)/, '$1 $2 $3');
};

function letter(o: { title: string; kicker: string; name: string;
                     lead: string; body: string; foot: string }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="x-ua-compatible" content="ie=edge">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-text-size-adjust:100%;
  -ms-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(o.lead)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="background:${PAGE}"><tr><td align="center" style="padding:28px 14px 36px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="max-width:600px;background:#ffffff;border-radius:14px;border:1px solid #dfe4ee">
  <tr><td style="background:${NAVY};border-radius:14px 14px 0 0;padding:22px 26px">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td style="font:700 16px/1.3 ${SANS};color:#ffffff;letter-spacing:-.01em">
          DIU Campus Legacy 25</td>
        <td align="right" style="font:12px/1.3 ${SANS};color:#9fb2d8;white-space:nowrap">
          ${esc(today())}</td>
      </tr>
      <tr><td colspan="2" style="padding-top:3px;font:13px/1.4 ${SANS};color:#9fb2d8"
        >${esc(o.kicker)}</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:24px 22px 6px">
    <div style="font:600 17px/1.4 ${SANS};color:${INK}">${esc(o.name)}</div>
    <div style="padding-top:5px;font:14px/1.6 ${SANS};color:${MUTE}">${esc(o.lead)}</div>
  </td></tr>
  <tr><td style="padding:18px 22px 22px">${o.body}</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="max-width:600px"><tr><td align="center"
  style="padding:16px 10px 0;font:12px/1.65 ${SANS};color:#97a0b5">
  ${o.foot}<br>Project DIU-CL25-2026 &middot; Daffodil International University
</td></tr></table>
</td></tr></table></body></html>`;
}

/** Send a message in the letter shape rather than the notification one. */
export async function sendLetter(to: string, subject: string, o: {
  kicker: string; name: string; lead: string; body: string; foot: string;
}): Promise<Sent> {
  return rawSend(to, subject, letter({ title: subject, ...o }));
}

export const facts = (rows: [string, any][]) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0">
    ${rows.filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `<tr>
      <td style="padding:3px 14px 3px 0;color:#68718a;font-size:13px;vertical-align:top">${esc(k)}</td>
      <td style="padding:3px 0;font-size:14px">${esc(v)}</td></tr>`).join('')}
  </table>`;

/* ------------------------------------------------------------------ send */
export type Sent = { sent: boolean; reason: string };

export async function send(to: string, subject: string, body: string, foot = ''): Promise<Sent> {
  return rawSend(to, subject, paper(subject, body, foot));
}

/** The one place a message actually leaves, whichever shape it came in. */
export async function rawSend(to: string, subject: string, html: string): Promise<Sent> {
  if (!mailReady()) return { sent: false, reason: 'Email is not set up on the server.' };
  if (!to || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to))
    return { sent: false, reason: 'That account has no usable email address.' };

  const from = process.env.SMTP_FROM
    || `DIU Campus Legacy 25 <${process.env.SMTP_USER}>`;
  try {
    await post().sendMail({ from, to, subject, html });
    return { sent: true, reason: '' };
  } catch (e: any) {
    return { sent: false, reason: String(e?.message || e).slice(0, 300) };
  }
}

/** Written down whether it went or not — a notice that failed is the one
    somebody will ask about. */
export async function record(c: PoolClient, n: {
  kind: string; taskId?: string | null; toUser?: string | null; toEmail: string;
  subject: string; reason?: string; sentBy?: string | null; r: Sent;
}) {
  await c.query(
    `insert into notices (kind, task_id, to_user, to_email, subject, reason, sent_by, ok, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [n.kind, n.taskId || null, n.toUser || null, n.toEmail, n.subject,
     n.reason || '', n.sentBy || null, n.r.sent, n.r.sent ? '' : n.r.reason]).catch(() => {});
}

/** Has this task been sent to this person for this reason before? */
export async function sentBefore(taskId: string, toUser: string, kind: string) {
  const r = await q(
    `select at from notices
      where task_id = $1 and to_user = $2 and kind = $3 and ok
      order by at desc limit 1`, [taskId, toUser, kind]).catch(() => []);
  return r[0]?.at ? new Date(r[0].at) : null;
}

/* ---------------------------------------------------------------- wording */
export const taskUrl = (id: string) =>
  SITE() ? `${SITE()}/tasks/${encodeURIComponent(id)}` : '';

export const day = (v: any) => {
  const s = String(v || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [y, m, d] = s.split('-');
  return `${Number(d)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    [Number(m) - 1]} ${y}`;
};

/** "in 26 days", "4 days late", "today" — the thing people actually want. */
export function when(deadline: any) {
  const s = String(deadline || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const days = Math.round((Date.parse(s + 'T00:00:00Z') - Date.parse(
    new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) / 86400000);
  if (days === 0) return 'today';
  if (days < 0) return `${-days} ${-days === 1 ? 'day' : 'days'} late`;
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

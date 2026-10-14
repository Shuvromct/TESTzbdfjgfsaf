import { requireUser, fail, HttpError } from '@/lib/auth';
import { canEdit } from '@/lib/perm';
import { readAll, toSql, nameFor, zip, caption } from '@/lib/backup';
import { sendTelegramFile, telegramChats, telegramReady } from '@/lib/notify';
import { q } from '@/lib/db';
import { note } from '@/lib/log';
import { tx } from '@/lib/db';

/**
 * Taking a copy of the project, by hand.
 *
 * The scheduled copy is in /api/cron/backup; this is the same two files on
 * demand — downloaded, or posted to Telegram now. Both need `admin: edit`,
 * because a backup is every row in the project including everybody's details,
 * and the one thing worse than having no copy is other people having one.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function gate() {
  const me = await requireUser();
  if (!(await canEdit(me.role, 'admin')))
    throw new HttpError(403, 'A backup is every row in the project. Your role cannot take one.');
  return me;
}

/** Download one. */
export async function GET(req: Request) {
  try {
    const me = await gate();
    const kind = new URL(req.url).searchParams.get('format') === 'sql' ? 'sql' : 'json';

    const dump = await readAll();
    const text = kind === 'sql' ? await toSql(dump) : JSON.stringify(dump);
    const body = zip(text);
    const name = nameFor(kind);

    await tx(async (c) => { await note(c, me, 'settings', 'backup', `downloaded a ${kind} backup`); })
      .catch(() => {});

    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e) { return fail(e); }
}

/** Send one now, or ask the bot which chats it can reach. */
export async function POST(req: Request) {
  try {
    const me = await gate();
    const b = await req.json();
    const act = String(b.act || '');

    if (act === 'chats') {
      const r = await telegramChats();
      return Response.json({ ok: r.ok, reason: r.reason, chats: r.chats,
                             using: process.env.TELEGRAM_CHAT_ID || '' });
    }

    if (act === 'send') {
      if (!telegramReady())
        throw new HttpError(400,
          'Telegram is not set up on the server. TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID '
          + 'go in the Vercel settings, then redeploy.');
      const kind = b.format === 'sql' ? 'sql' : 'json';
      const dump = await readAll();
      const text = kind === 'sql' ? await toSql(dump) : JSON.stringify(dump);
      const r = await sendTelegramFile(zip(text), nameFor(kind), caption(dump));
      if (!r.sent) throw new HttpError(502, `Telegram would not take it — ${r.reason}`);

      await tx(async (c) => {
        await note(c, me, 'settings', 'backup', `sent a ${kind} backup to Telegram`);
      }).catch(() => {});
      await q(`insert into settings (key, value) values ('backup_last', $1::jsonb)
               on conflict (key) do update set value = excluded.value`,
        [JSON.stringify({ at: dump.takenAt, by: me.name, how: 'by hand', format: kind })])
        .catch(() => {});

      return Response.json({ ok: true, name: nameFor(kind), counts: dump.counts });
    }

    throw new HttpError(400, 'Download a backup, send one, or find the channel.');
  } catch (e) { return fail(e); }
}

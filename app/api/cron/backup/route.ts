import { q } from '@/lib/db';
import { readAll, toSql, nameFor, zip, caption, lastChange } from '@/lib/backup';
import { sendTelegramFile, telegramReady } from '@/lib/notify';

/**
 * The copy that leaves the building, on its own.
 *
 * Two schedules reach this, and they are different on purpose:
 *
 *   hourly   from GitHub Actions, and only when something has changed since
 *            the last copy went out. A project office does not need
 *            twenty-four identical files a day, and the one that matters
 *            would be lost among them.
 *
 *   nightly  from Vercel's own scheduler, unconditional, both formats. This
 *            is the day's certain copy: if the hourly one has been quiet
 *            because nothing changed, or because GitHub was down, there is
 *            still one file a day with the date on it.
 *
 * Vercel's free plan runs a cron once a day, which is why the hourly one
 * comes from outside. Both are held shut by CRON_SECRET.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const url = new URL(req.url);
    const auth = req.headers.get('authorization') || '';
    /* Vercel sends the header; GitHub Actions can too, and a query parameter
       is kept for a scheduler that cannot set one. */
    if (auth !== `Bearer ${secret}` && url.searchParams.get('key') !== secret)
      return new Response('no', { status: 401 });
  }

  const url = new URL(req.url);
  const every = url.searchParams.get('every') || 'night';   /* 'hour' | 'night' */

  try {
    if (!telegramReady())
      return Response.json({ ok: false, sent: false, why: 'Telegram is not configured' });

    const last = await one('backup_last');
    const changed = await lastChange();

    /* The hourly copy stands down when the project has not moved. The nightly
       one goes regardless, because "nothing happened today" is itself worth
       having a file to prove. */
    if (every === 'hour' && last?.change && changed && last.change === changed)
      return Response.json({ ok: true, sent: false, why: 'nothing has changed since the last copy' });

    const dump = await readAll();
    const cap = caption(dump);

    const sent: string[] = [];
    const failed: string[] = [];

    const post = async (kind: 'json' | 'sql', text: string) => {
      const r = await sendTelegramFile(zip(text), nameFor(kind), cap);
      (r.sent ? sent : failed).push(r.sent ? kind : `${kind}: ${r.reason}`);
    };

    await post('json', JSON.stringify(dump));
    /* The SQL dump carries the schema and is several times the size, so the
       hourly copy leaves it out — the nightly one is where it belongs. */
    if (every !== 'hour') await post('sql', await toSql(dump));

    await q(`insert into settings (key, value) values ('backup_last', $1::jsonb)
             on conflict (key) do update set value = excluded.value`,
      [JSON.stringify({ at: dump.takenAt, how: every === 'hour' ? 'hourly' : 'nightly',
                        change: changed, sent, failed })]).catch(() => {});

    return Response.json({ ok: failed.length === 0, sent, failed, at: dump.takenAt });
  } catch (e: any) {
    console.error(e);
    return Response.json({ ok: false, error: 'The backup could not be taken.' }, { status: 500 });
  }
}

/** The note of the last copy, or nothing if there has never been one. */
async function one(key: string): Promise<any> {
  const r = await q(`select value from settings where key = $1`, [key]).catch(() => []);
  return r[0]?.value || null;
}

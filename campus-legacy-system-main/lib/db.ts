import { Pool, PoolClient, types } from 'pg';

/**
 * A date is a day, not a moment.
 * ---------------------------------------------------------------------------
 * A `date` column holds 7 November 2026 and nothing else — no hour, no zone.
 * The driver nonetheless hands it over as a JavaScript Date built at midnight
 * in whatever zone the server process happens to be running in, which turns
 * a plain day into a moment and then lets that moment drift:
 *
 *   process on UTC      7 Nov 2026 00:00Z   → reads back as the 7th
 *   process on Dhaka    6 Nov 2026 18:00Z   → reads back as the 6th
 *
 * The same deadline, a day apart, depending on a setting nobody meant to
 * make part of the record. It showed up in the trail — "set deadline to
 * 6 Nov 26" for a deadline of the 7th — and anywhere else a date was
 * formatted rather than passed straight through.
 *
 * So dates arrive as the text the database holds, 'YYYY-MM-DD', and stay a
 * day all the way to the screen. Timestamps are untouched: those really are
 * moments and the zone is part of what they mean.
 */
types.setTypeParser(1082, (v) => v);   // 1082 = date

const g = globalThis as unknown as { _pool?: Pool };
export const pool =
  g._pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('sslmode=disable')
      ? false
      : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10_000,
  });

/**
 * The clock this project runs on.
 *
 * Neon keeps its servers on UTC, and every status in the register is worked
 * out from `current_date`: delayed, due soon, days to deadline, days late.
 * Between six in the evening and midnight in Dhaka, UTC is still on yesterday
 * — so a task due today read as due tomorrow, and one that went overdue at
 * midnight stayed green until six the next morning. Six hours of every day,
 * including the evening when people actually fill this in.
 *
 * Setting the zone on each connection fixes every date expression in the
 * schema at once, without touching the views.
 */
export const ZONE = process.env.PROJECT_TIMEZONE || 'Asia/Dhaka';
pool.on('connect', (c) => { c.query(`set time zone '${ZONE}'`).catch(() => {}); });

if (process.env.NODE_ENV !== 'production') g._pool = pool;

export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}
export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/**
 * A change and its trail, together or not at all.
 *
 * This is the whole reason the project is leaving the spreadsheet. There, a
 * status change meant typing into the register and then remembering to add a
 * row to the Progress and Audit Log — two actions, by hand, in two places. They
 * drifted apart on the first day. Here every write that matters goes through
 * this function, and the log row is written on the same connection inside the
 * same transaction: either both land or neither does.
 */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

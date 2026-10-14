import { one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { mayManage } from '@/lib/roles';
import { note } from '@/lib/log';

/**
 * Project-wide switches.
 *
 * The site lock is the one that earns its keep: from 13 November until the IAUP
 * meeting ends, nothing disruptive is permitted on campus, and this is how that
 * is enforced rather than merely announced.
 */
export async function PUT(req: Request) {
  try {
    const me = await requireUser();
    if (!await mayManage(me.role)) throw new HttpError(403, 'Only the Project Director can change this.');
    const { key, value } = await req.json();
    const k = String(key || '');
    if (!['siteLock', 'roles', 'project'].includes(k))
      throw new HttpError(400, 'That is not a setting this system keeps.');

    const before = await one('select value from settings where key=$1', [k]);
    await tx(async (c) => {
      await c.query(
        `insert into settings (key, value, updated_by, updated_at) values ($1,$2::jsonb,$3,now())
         on conflict (key) do update set value=$2::jsonb, updated_by=$3, updated_at=now()`,
        [k, JSON.stringify(value ?? {}), me.id]);
      if (k === 'siteLock') {
        const on = !!(value && value.on);
        const was = !!(before && before.value && before.value.on);
        if (on !== was) await note(c, me, 'settings', k, on ? 'closed the site to the field' : 'reopened the site');
      } else {
        await note(c, me, 'settings', k, `updated ${k}`);
      }
    });
    return Response.json({ ok: true });
  } catch (e) { return fail(e); }
}

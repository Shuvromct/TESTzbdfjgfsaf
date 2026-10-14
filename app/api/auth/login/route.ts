import bcrypt from 'bcryptjs';
import { q, one } from '@/lib/db';
import { issue, fail, HttpError } from '@/lib/auth';
import { sessionRole } from '@/lib/roles';

export async function POST(req: Request) {
  try {
    const { email, password, device } = await req.json();
    const e = String(email || '').trim().toLowerCase();
    if (!e || !password) throw new HttpError(400, 'Email and password, please.');

    const u = await one('select * from users where lower(email)=$1', [e]);
    /* The same message either way: a wrong password and an account that does
       not exist must look identical from outside. */
    if (!u || !u.pw_hash || !(await bcrypt.compare(String(password), u.pw_hash)))
      throw new HttpError(401, 'That email and password do not match.');
    if (!u.active) throw new HttpError(403, 'This account is disabled.');

    /* Every role they hold, not just the first — see sessionRole. */
    const held = sessionRole(u);
    await issue({ id: u.id, role: held as any, name: u.name });

    const d = device || {};
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
    const s = await one(
      `insert into sessions (user_id, device_id, os, browser, mobile, ip)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [u.id, String(d.deviceId || ''), String(d.os || ''), String(d.browser || ''),
       !!d.mobile, ip]).catch(() => null);

    await q(`insert into activity (user_id,user_name,role,subject,subject_id,what)
             values ($1,$2,$3,'user',$1,'signed in')`, [u.id, u.name, held]).catch(() => {});

    return Response.json({ ok: true, sessionId: s?.id || null, mustChange: u.must_change });
  } catch (e) { return fail(e); }
}

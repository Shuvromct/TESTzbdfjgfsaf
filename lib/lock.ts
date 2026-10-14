import { one } from './db';
import { HttpError } from './auth';

/**
 * Closing the site for a while.
 *
 * This project has a window written into its own schedule: from gate G9 on 13
 * November until the IAUP meeting ends on the 21st, no disruptive work is
 * permitted on campus. Rather than trust everyone to remember, the Director can
 * close the system to the field and keep working.
 *
 * The switch is enforced here, on the server. A closed site refuses the request
 * too, so a bookmarked page or a tab left open on a phone cannot write anything.
 */
export type SiteLock = { on: boolean; msg: string };

export const DEFAULT_LOCK_MESSAGE =
  'The system is closed to changes just now. Please ask the Project Office.';

export async function siteLock(): Promise<SiteLock> {
  try {
    const row = await one(`select value from settings where key='siteLock'`);
    const v = (row && row.value) || {};
    return { on: !!v.on, msg: String(v.msg || '') };
  } catch { return { on: false, msg: '' }; }   // settings table not there yet
}

/** Who keeps working while the doors are shut. */
export const KEYHOLDERS = ['ADMIN', 'DIRECTOR'];
/* A session's role may name several — ADMIN+SUPER_APPROVE — so this asks
   whether a keyholding role is among them, not whether it is the whole
   string. Written as a plain split rather than an import, because this file
   is loaded by the middleware path and has no database call in it. */
export const mayEnter = (role: string) =>
  String(role || '').split('+').some(r => KEYHOLDERS.includes(r.trim()));

export async function requireOpenSite(role: string) {
  if (mayEnter(role)) return;
  const lock = await siteLock();
  if (lock.on) throw new HttpError(423, lock.msg || DEFAULT_LOCK_MESSAGE);
}

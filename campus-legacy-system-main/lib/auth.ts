import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { one } from './db';
import { levelOf, isKeeper, hasRole } from './perm';
import { sessionRole } from './roles';

const COOKIE = 'cl25_session';
const secret = () =>
  new TextEncoder().encode(process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me');

/* A role key, or several joined with plus signs — see rolesOf in lib/perm.
   It was a union of the original six; roles the administrator writes on the
   Roles page are not in that union, and neither is a person holding two. */
export type Role = string;
export type Session = { id: string; role: Role; name: string };

/**
 * How long a session survives without use.
 *
 * One idle hour. Every request pushes the hour back, so nobody working is ever
 * interrupted, and a tablet left on a site office desk stops being signed in
 * by itself. Re-signing on every request would be wasteful, so a few minutes
 * of slack is allowed before the cookie is refreshed.
 */
const IDLE_SECONDS = 60 * 60;
const REFRESH_AFTER = 5 * 60;

export async function issue(session: Session) {
  const token = await new SignJWT(session as any)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${IDLE_SECONDS}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: IDLE_SECONDS,
  });
}
export async function clear() {
  (await cookies()).set(COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}
export async function session(): Promise<(Session & { iat?: number }) | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return { id: payload.id as string, role: payload.role as Role, name: payload.name as string,
             iat: payload.iat as number | undefined };
  } catch {
    return null;                       // expired, tampered with, or signed elsewhere
  }
}

/** Throws a Response — callers just let it bubble to the route handler. */
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function requireUser(): Promise<Session> {
  const s = await session();
  if (!s) throw new HttpError(401, 'Not signed in.');
  const live = await one('select active, role, roles from users where id=$1', [s.id]);
  if (!live || live.active === false) throw new HttpError(401, 'This account is disabled.');

  /* The roles come from the table, not from the cookie.
     -----------------------------------------------------------------------
     A cookie lasts an idle hour, so a role taken away stayed in force for up
     to an hour after it was taken away — which is the wrong way round for a
     permission. The row is being read anyway to check the account is still
     active, so the roles are read with it and the cookie is only a cache. */
  const role = (sessionRole(live) || s.role) as Role;

  const age = s.iat ? Math.floor(Date.now() / 1000) - s.iat : Infinity;
  if (age > REFRESH_AFTER || role !== s.role) {
    try { await issue({ id: s.id, role, name: s.name }); }
    catch { /* a route that cannot set cookies must not fail because of this */ }
  }
  return { id: s.id, role, name: s.name };
}

export async function requireAdmin(): Promise<Session> {
  const s = await requireUser();
  /* The session's role may name several — ADMIN+SUPER_APPROVE — so this asks
     whether ADMIN is among them rather than whether it is the whole string. */
  if (!hasRole(s.role, 'ADMIN')) throw new HttpError(403, 'Administrators only.');
  return s;
}

/**
 * A task the caller may change, and which of its fields.
 *
 * The spreadsheet put this on the Guide tab as a sentence — "no one should
 * verify their own work" — with nothing to enforce it. Here the rule decides
 * what the server will accept:
 *
 *   the owner        moves status, progress, dates, photographs, evidence
 *   the lead dept    the same, for anyone in the department that leads it
 *   the verifier     signs the work off, and may not be the owner
 *   the approver     gives the final approval, and may not be the owner either
 *   the Director     may edit anything, because somebody has to be able to
 *   everyone else    reads
 *
 * The table carries the same rule as a check constraint, so even a direct
 * database write cannot put one person in two of those chairs.
 *
 * Being named on a task is itself the permission
 * ----------------------------------------------
 * A role's `tasks` level says what somebody may do to the register at large.
 * Being written into one of the four chairs on a particular task is a
 * separate thing, and it reaches further than the role does: a student with
 * no task permission at all, named as the responsible person on CL25-31, can
 * move CL25-31 along and nothing else. Their fields are still only their own
 * — the approval authority cannot move the deadline, and the responsible
 * person cannot sign off their own work — so the separation of duties is
 * untouched by it.
 */
const OWNER_FIELDS = ['status','progress','start_on','deadline','completed_on','site',
                      'evidence_ref','evidence_url','remarks','assigned_on','depends_on',
                      'photos_required','acceptance','title','category','priority',
                      'support_text','continuous'];
const VERIFY_FIELDS = ['verified_by','verified_on'];
const APPROVE_FIELDS = ['approval_status'];
const DIRECTOR_FIELDS = ['owner_id','verifier_id','approver_id','lead_dept_id','phase','route'];

/** Set by the server on every write, never sent by the client. */
export const STAMPED = ['updated_by'];

export async function writableTask(id: string, s: Session, fields: string[]) {
  /* The caller's own department comes back with the task, because whether
     they may touch it depends on both and two queries for one answer is one
     too many. */
  const t = await one(
    `select t.*, u.dept_id as caller_dept,
            exists (select 1 from task_helpers h
                     where h.task_id = t.id and h.user_id = $2) as caller_helps
       from tasks t left join users u on u.id = $2
      where t.id = $1 and t.deleted_at is null`, [id, s.id]);
  if (!t) throw new HttpError(404, 'No task with that ID.');

  /* Three questions, in order. May this role touch the register at all, is
     this person named on this particular task, and may the role touch
     records that are not its own? The first is a permission the
     administrator sets; the second is written on the task itself; the third
     is the keeper flag.

     None of them can grant the thing the project exists to prevent: the
     checks below that stop a person verifying or approving their own work
     run for everybody, keeper or not, and the table carries the same rule as
     a constraint underneath. */
  const isOwner    = !!t.owner_id    && t.owner_id    === s.id;
  const isVerifier = !!t.verifier_id && t.verifier_id === s.id;
  const isApprover = !!t.approver_id && t.approver_id === s.id;
  const inLeadDept = !!t.lead_dept_id && !!t.caller_dept && t.lead_dept_id === t.caller_dept;
  /* Named under "also working on this": the same hands on the same work, so
     the same reach over it — and the same bar on signing it off. */
  const helps = !!t.caller_helps;
  const named = isOwner || isVerifier || isApprover || inLeadDept || helps;

  const mayRegister = (await levelOf(s.role, 'tasks')) === 'edit';
  if (!mayRegister && !named)
    throw new HttpError(403, 'Your role cannot change the task register.');

  /* Whoever does the work — the named person, or anyone in the department
     that leads it — writes the work's own fields. */
  const doesTheWork = isOwner || inLeadDept || helps;

  const boss = await isKeeper(s.role);
  for (const f of fields) {
    if (boss && !VERIFY_FIELDS.includes(f) && !APPROVE_FIELDS.includes(f)) continue;
    if (boss && (VERIFY_FIELDS.includes(f) || APPROVE_FIELDS.includes(f))) {
      /* A keeper may sign off somebody else's work, but never their own —
         and work they had a hand in is their own. */
      if (t.owner_id === s.id || helps)
        throw new HttpError(403, VERIFY_FIELDS.includes(f)
          ? 'Nobody verifies their own work, whatever their role.'
          : 'Nobody approves their own work, whatever their role.');
      continue;
    }
    if (OWNER_FIELDS.includes(f)) {
      if (!doesTheWork)
        throw new HttpError(403, `${id} belongs to someone else. You can read it, but not change it.`);
    } else if (VERIFY_FIELDS.includes(f)) {
      if (!isVerifier)
        throw new HttpError(403, `Only the named verifier can sign off ${id}.`);
      if (isOwner || helps)
        throw new HttpError(403, 'Nobody verifies their own work.');
    } else if (APPROVE_FIELDS.includes(f)) {
      if (!isApprover)
        throw new HttpError(403, `Only the named approval authority can approve ${id}.`);
      if (isOwner || helps)
        throw new HttpError(403, 'Nobody approves their own work.');
    } else if (DIRECTOR_FIELDS.includes(f)) {
      throw new HttpError(403, 'Reassigning a task is for a role that may act on other people\'s records.');
    } else {
      throw new HttpError(400, `There is no field called ${f}.`);
    }
  }
  delete (t as any).caller_dept;      /* borrowed for the check, not part of the row */
  delete (t as any).caller_helps;
  return t;
}

export const WRITABLE_FIELDS = [...OWNER_FIELDS, ...VERIFY_FIELDS, ...APPROVE_FIELDS, ...DIRECTOR_FIELDS];

/**
 * The table's own rules, said in English.
 *
 * The check constraints in schema.sql are the last line of the separation of
 * duties, and they fire on writes this code did not think to guard. Postgres
 * reports them by constraint name, which is no use to the person who just
 * pressed a button — so each one has a sentence here.
 */
const CONSTRAINTS: Record<string, string> = {
  verifier_is_not_owner: 'The verifier cannot be the same person as the responsible person. Nobody verifies their own work.',
  approver_is_not_owner: 'The approval authority cannot be the same person as the responsible person.',
  verified_by_is_not_owner: 'Nobody signs off their own work.',
  sub_task_is_not_its_own_parent: 'A sub-task cannot be its own parent.',
  tasks_status_check: 'That is not a status this system knows.',
  tasks_progress_check: 'Progress is a fraction between 0 and 1.',
  tasks_phase_check: 'That is not one of the four phases.',
  tasks_route_check: 'That is not an implementation route this system knows.',
  photos_kind_check: 'A photograph is before, progress or after.',
  task_roles_role_check: 'A department leads, supports, verifies or approves — nothing else.',
  users_role_check: 'The database is still holding the original six roles. Run the latest update SQL in Neon.',
};

export function fail(e: unknown) {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });

  const pg = e as { code?: string; constraint?: string; detail?: string; column?: string };
  if (pg?.code === '23514' && pg.constraint && CONSTRAINTS[pg.constraint])
    return Response.json({ error: CONSTRAINTS[pg.constraint] }, { status: 409 });
  if (pg?.code === '23514')
    return Response.json({ error: 'That value is not one this record accepts.' }, { status: 409 });
  if (pg?.code === '23505')
    return Response.json({ error: 'Something with that ID is already here.' }, { status: 409 });
  if (pg?.code === '23503')
    return Response.json({ error: 'That points at something which does not exist.' }, { status: 409 });
  if (pg?.code === '23502')
    return Response.json({ error: `${pg.column || 'A required field'} cannot be empty.` }, { status: 400 });
  /* A column or table the code expects and the database has not got: the
     update SQL has not been run. Saying so beats "something went wrong". */
  if (pg?.code === '42703' || pg?.code === '42P01')
    return Response.json({
      error: 'The database is behind the code — run the latest update SQL in Neon, then reload.',
    }, { status: 503 });

  console.error(e);
  return Response.json({ error: 'Something went wrong on the server.' }, { status: 500 });
}

import bcrypt from 'bcryptjs';
import { q, one, tx } from '@/lib/db';
import { requireUser, requireAdmin, fail, HttpError, issue } from '@/lib/auth';
import { knownRoles, mayManage, heldRoles } from '@/lib/roles';
import { note } from '@/lib/log';

/**
 * The roles in a request, checked against the roles that exist.
 *
 * The client may send `roles` as a list or `role` as one string; an account
 * always ends up with both — the list, and its first entry in the old column
 * so that everything written against `users.role` still reads.
 */
async function wanted(b: any): Promise<string[] | null> {
  const raw = Array.isArray(b?.roles) ? b.roles
            : (typeof b?.role === 'string' && b.role ? [b.role] : null);
  if (!raw) return null;
  const list: string[] =
    [...new Set(raw.map((r: any) => String(r || '').trim()).filter(Boolean) as string[])];
  if (!list.length) throw new HttpError(400, 'Somebody needs at least one role.');
  const known = await knownRoles();
  for (const r of list)
    if (!known.includes(r)) throw new HttpError(400, `${r} is not a role this system knows.`);
  return list;
}

/** Is anybody else still an administrator? */
async function otherAdmins(exceptId: string) {
  return q(`select id from users
             where active and id <> $1
               and 'ADMIN' = any (coalesce(roles, array[role]))`, [exceptId]);
}

/** Change your own password. The one thing anybody may do to an account. */
export async function PUT(req: Request) {
  try {
    const me = await requireUser();
    const { current, next } = await req.json();
    const u = await one('select * from users where id=$1', [me.id]);
    if (!u) throw new HttpError(404, 'No such account.');
    if (u.pw_hash && !(await bcrypt.compare(String(current || ''), u.pw_hash)))
      throw new HttpError(403, 'That is not your current password.');
    const pw = String(next || '');
    if (pw.length < 8) throw new HttpError(400, 'A password needs at least eight characters.');

    await tx(async (c) => {
      await c.query('update users set pw_hash=$2, must_change=false where id=$1',
        [me.id, await bcrypt.hash(pw, 10)]);
      /* Everywhere else signed in as this person stops being signed in. */
      await c.query('update sessions set active=false, ended_at=now() where user_id=$1 and active', [me.id]);
      await note(c, me, 'user', me.id, 'changed their password');
    });
    await issue({ id: me.id, role: me.role, name: me.name });
    return Response.json({ ok: true });
  } catch (e) { return fail(e); }
}

/** Add somebody. */
export async function POST(req: Request) {
  try {
    const me = await requireAdmin();
    const b = await req.json();
    const email = String(b.email || '').trim().toLowerCase();
    const name = String(b.name || '').trim();
    if (!email || !name) throw new HttpError(400, 'A name and an email, please.');
    const roles = await wanted(b);
    if (!roles) throw new HttpError(400, 'Which role should they have?');
    if (await one('select id from users where lower(email)=$1', [email]))
      throw new HttpError(409, 'Somebody already has that email.');

    const pw = String(b.password || '');
    const row = await tx(async (c) => {
      const r = (await c.query(
        `insert into users (name, email, emp_id, phone, designation, dept_id, cc_email,
                            role, roles, ip_phone, pw_hash, must_change)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) returning *`,
        [name, email, String(b.empId || ''), String(b.phone || ''), String(b.designation || ''),
         b.deptId || null, String(b.ccEmail || ''), roles[0], roles,
         String(b.ipPhone || ''), pw ? await bcrypt.hash(pw, 10) : null])).rows[0];
      await note(c, me, 'user', r.id, `added ${name} as ${roles.join(' + ')}`);
      return r;
    });
    return Response.json({ ok: true, id: row.id });
  } catch (e) { return fail(e); }
}

/**
 * Take an account off the list.
 *
 * Only an account nothing in the record points at. A person who owns a
 * task, verified one, approved one, uploaded a photograph or appears in
 * the trail is part of what happened, and removing them would leave the
 * record saying a nameless somebody did the work. Those are disabled
 * instead, which is what the Active tick is for — they can no longer sign
 * in, and every entry with their name on it still reads correctly.
 */
/* The last column says which task the row belongs to, where there is one.
   "1 responsible for" tells somebody they cannot remove an account and
   leaves them to go and find out which task is holding it; naming the task
   is the difference between a refusal and an instruction. */
const POINTS_AT: [string, string, string, string | null][] = [
  ['tasks',         'owner_id',      'responsible for',                 'id'],
  ['tasks',         'verifier_id',   'named as verifier on',            'id'],
  ['tasks',         'approver_id',   'named as approval authority on',  'id'],
  ['tasks',         'verified_by',   'verified',                        'id'],
  ['task_helpers',  'user_id',       'also working on',                 'task_id'],
  ['photos',        'uploaded_by',   'added photographs to',            'task_id'],
  ['approvals',     'originator_id', 'raised',                          'task_id'],
  ['approvals',     'verifier_id',   'verified',                        'task_id'],
  ['approvals',     'decided_by',    'decided',                         'task_id'],
  ['approval_steps','approver_id',   'is a step of the chain on',       'task_id'],
  ['student_teams', 'supervisor_id', 'supervises',                      null],
  ['departments',   'focal_user_id', 'is the focal point of',           null],
  ['activity',      'user_id',       'entries in the trail',            null],
];

export async function DELETE(req: Request) {
  try {
    const me = await requireAdmin();
    const { id } = await req.json();
    const u = await one('select * from users where id=$1', [String(id || '')]);
    if (!u) throw new HttpError(404, 'No such account.');
    if (u.id === me.id) throw new HttpError(409, 'You cannot remove your own account.');
    if (heldRoles(u).includes('ADMIN') && !(await otherAdmins(u.id)).length)
      throw new HttpError(409, 'That is the only administrator left.');

    /* What is holding the account, and on which tasks. Sent as structured
       rows rather than one sentence, so the page can make each task a link
       and the person can go and hand the work to somebody else. */
    const holds: { says: string; n: number; tasks: string[] }[] = [];
    for (const [table, col, says, taskCol] of POINTS_AT) {
      const r = await q(`select count(*)::int as n from ${table} where ${col} = $1`, [u.id])
        .catch(() => [{ n: 0 }]);
      const n = Number(r[0]?.n || 0);
      if (!n) continue;
      let tasks: string[] = [];
      if (taskCol) {
        const ids = await q(
          `select distinct ${taskCol} as id from ${table}
            where ${col} = $1 and ${taskCol} is not null order by 1 limit 12`, [u.id])
          .catch(() => []);
        tasks = ids.map((x: any) => String(x.id));
      }
      holds.push({ says, n, tasks });
    }
    if (holds.length)
      return Response.json({
        error: `${u.name} is part of the record, so the account cannot be removed — the entries `
             + `would be left without a name. Open each task and name somebody else, or untick `
             + `Active instead: they can no longer sign in, and everything they did still reads `
             + `correctly.`,
        holds,
      }, { status: 409 });

    await tx(async (c) => {
      await c.query('delete from sessions where user_id=$1', [u.id]).catch(() => {});
      await c.query('delete from users where id=$1', [u.id]);
      await note(c, me, 'user', u.id, `removed the account ${u.name} (${u.email})`);
    });
    return Response.json({ ok: true });
  } catch (e) { return fail(e); }
}

/** Edit somebody, or set a password for them. */
export async function PATCH(req: Request) {
  try {
    const me = await requireAdmin();
    const b = await req.json();
    const id = String(b.id || '');
    const u = await one('select * from users where id=$1', [id]);
    if (!u) throw new HttpError(404, 'No such account.');
    const roles = await wanted(b);
    /* The last administrator may not demote or disable themselves out of the
       system — somebody has to be able to get back in. */
    const wasAdmin = heldRoles(u).includes('ADMIN');
    const losesAdmin = !!roles && !roles.includes('ADMIN');
    if (wasAdmin && (losesAdmin || b.active === false) && !(await otherAdmins(id)).length)
      throw new HttpError(409, 'That is the only administrator left.');

    /* Only what was sent is written.
       -----------------------------------------------------------------
       This used to be one statement of coalesce(), which meant an empty
       value read as "not sent": once somebody had a department there was no
       way to take it off again, and the form quietly did nothing. A field
       that appears in the request is written, blank included; a field that
       does not appear is left alone. */
    const sets: string[] = [], vals: any[] = [id];
    const put = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (typeof b.name === 'string' && b.name.trim()) put('name', b.name.trim());
    /* The address could be set when an account was made and never
       afterwards, so a person named in the tracker as a post — the one at
       @cl25.local — was stuck with it once they had a real one. */
    if (typeof b.email === 'string' && b.email.trim()) {
      const email = b.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email))
        throw new HttpError(400, 'That is not an email address.');
      if (email !== String(u.email).toLowerCase()
          && await one('select id from users where lower(email)=$1 and id<>$2', [email, id]))
        throw new HttpError(409, 'Somebody already has that email.');
      put('email', email);
    }
    if (b.empId !== undefined) put('emp_id', String(b.empId ?? ''));
    if (b.phone !== undefined) put('phone', String(b.phone ?? ''));
    if (b.ipPhone !== undefined) put('ip_phone', String(b.ipPhone ?? ''));
    if (b.designation !== undefined) put('designation', String(b.designation ?? ''));
    if (b.ccEmail !== undefined) put('cc_email', String(b.ccEmail ?? ''));
    if (b.deptId !== undefined) put('dept_id', b.deptId ? String(b.deptId) : null);
    if (roles) { put('role', roles[0]); put('roles', roles); }
    if (b.active !== undefined) put('active', !!b.active);

    await tx(async (c) => {
      if (sets.length) await c.query(`update users set ${sets.join(', ')} where id=$1`, vals);
      if (b.password) {
        await c.query('update users set pw_hash=$2, must_change=true where id=$1',
          [id, await bcrypt.hash(String(b.password), 10)]);
        await c.query('update sessions set active=false, ended_at=now() where user_id=$1 and active', [id]);
        await note(c, me, 'user', id, `set a new password for ${u.name}`);
      } else {
        await note(c, me, 'user', id, `edited ${u.name}'s account`);
      }
    });
    return Response.json({ ok: true });
  } catch (e) { return fail(e); }
}

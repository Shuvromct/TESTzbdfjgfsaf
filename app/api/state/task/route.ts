import { q, one, tx } from '@/lib/db';
import { requireUser, writableTask, fail, HttpError, WRITABLE_FIELDS } from '@/lib/auth';
import { requireOpenSite } from '@/lib/lock';
import { mayManage } from '@/lib/roles';
import { bin } from '@/lib/trash';
import { note, say, LABELS } from '@/lib/log';
import { mailAssigned, mailVerified } from '@/lib/notices';

/**
 * One field at a time.
 *
 * The course file system sent the whole file on every save, which was right
 * there: one teacher owns one file and nobody else may touch it. Here four
 * people have business with the same task — the owner moves it along, the
 * verifier signs it off, the approver approves, finance writes the money — and
 * sending whole records would mean the last save quietly undid the other three.
 *
 * So a change names its fields, the server checks each one against who is
 * asking, and the trail is written in the same transaction.
 */

const DATE_FIELDS = ['assigned_on','start_on','deadline','completed_on','verified_on'];

function clean(field: string, v: any) {
  if (DATE_FIELDS.includes(field)) return v ? String(v).slice(0, 10) : null;
  if (field === 'progress') {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1)
      throw new HttpError(400, 'Progress is a fraction between 0 and 1.');
    return n;
  }
  if (field === 'photos_required') return !!v;
  if (field === 'depends_on') return Array.isArray(v) ? v.map(String) : [];
  if (['owner_id','verifier_id','approver_id','lead_dept_id','verified_by'].includes(field))
    return v ? String(v) : null;
  return v === null || v === undefined ? '' : String(v);
}

export async function PATCH(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    const body = await req.json();
    const id = String(body.id || '');
    const changes = body.changes || {};
    const fields = Object.keys(changes);
    if (!id || !fields.length) throw new HttpError(400, 'Nothing to change.');
    for (const f of fields)
      if (!WRITABLE_FIELDS.includes(f)) throw new HttpError(400, `There is no field called ${f}.`);

    const before = await writableTask(id, me, fields);

    const out = await tx(async (c) => {
      const sets: string[] = [];
      const vals: any[] = [id];
      for (const f of fields) {
        vals.push(clean(f, changes[f]));
        sets.push(`${f} = $${vals.length}`);
      }
      vals.push(me.id);
      const row = (await c.query(
        `update tasks set ${sets.join(', ')}, updated_at = now(), updated_by = $${vals.length}
          where id = $1 returning *`, vals)).rows[0];

      for (const f of fields) {
        const was = before[f], now = row[f];
        if (String(was ?? '') === String(now ?? '')) continue;
        /* In words, not in column values: a name rather than an account id,
           a date rather than a time zone, yes rather than true. */
        const wasSaid = await say(c, f, was);
        const nowSaid = await say(c, f, now);
        await note(c, me, 'task', id,
          `set ${LABELS[f] || f} to ${nowSaid}`,
          { field: f, was: wasSaid, now: nowSaid });
      }

      /* Somebody new has to do this work, so somebody new is told. */
      if (fields.includes('owner_id') && row.owner_id && row.owner_id !== before.owner_id)
        await mailAssigned(c, me, row, row.owner_id);

      /* Verified just now: the chain carries on without anybody having to
         remember to tell the approval authority. */
      if (fields.includes('verified_by') && row.verified_by && !before.verified_by)
        await mailVerified(c, me, row);

      return row;
    });

    /* Read the derived columns back rather than working them out here — the
       view is the only place that logic exists. */
    const state = await one('select * from task_state where id=$1', [id]);
    return Response.json({ ok: true, task: state || out });
  } catch (e) { return fail(e); }
}

/** A new task or sub-task. Added at the end; nothing already there moves. */
export async function POST(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    if (!await mayManage(me.role)) throw new HttpError(403, 'Only the Project Director can add a task.');
    const b = await req.json();
    /* A task may be called whatever the project calls it — CL25-47, Lab-7,
       AB4-Wall. The only things it may not be are empty, absurdly long, or
       carrying a slash, which would cut its own address in half.

       A sub-task is the exception: it is named after its parent, and the
       parent is sent explicitly rather than guessed from the dots, because
       once the main ids are free "AB4.2" is a name and not a hierarchy. */
    const id = String(b.id || '').trim();
    const parent = b.parentId ? String(b.parentId).trim() : null;

    if (!id) throw new HttpError(400, 'A task needs an ID.');
    if (id.length > 40) throw new HttpError(400, 'A task ID can be up to 40 characters.');
    if (/[\/\\]/.test(id)) throw new HttpError(400, 'A task ID cannot contain a slash.');
    if (/[\u0000-\u001f]/.test(id)) throw new HttpError(400, 'That ID contains something unprintable.');

    if (await one('select id from tasks where id=$1', [id]))
      throw new HttpError(409, `${id} already exists. Give this one a different ID.`);

    if (parent) {
      if (!(await one('select id from tasks where id=$1 and deleted_at is null', [parent])))
        throw new HttpError(400, `There is no task ${parent} to put this under.`);
      if (await one('select parent_id from tasks where id=$1 and parent_id is not null', [parent]))
        throw new HttpError(409, `${parent} is itself a sub-task. The register goes two levels deep.`);
      if (!new RegExp(`^${parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+$`).test(id))
        throw new HttpError(400, `A sub-task of ${parent} is named ${parent}.1, ${parent}.2 and so on.`);
    }

    const row = await tx(async (c) => {
      const r = (await c.query(
        `insert into tasks (id, parent_id, title, category, phase, route, priority, site,
                            lead_dept_id, owner_id, verifier_id, approver_id,
                            assigned_on, start_on, deadline, photos_required, acceptance,
                            support_text, status, approval_status, remarks, updated_by,
                            continuous)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                 $23)
         returning *`,
        [id, parent, String(b.title || ''), String(b.category || ''), String(b.phase || ''),
         String(b.route || ''), String(b.priority || 'P2 – Medium'), String(b.site || ''),
         b.leadDeptId || null, b.ownerId || null, b.verifierId || null, b.approverId || null,
         b.assignedOn || null, b.startOn || null, b.deadline || null,
         !!b.photosRequired, String(b.acceptance || ''), String(b.supportText || ''),
         String(b.status || 'Pending'), String(b.approvalStatus || 'Not required'),
         String(b.remarks || ''), me.id, !!b.continuous])).rows[0];
      await note(c, me, 'task', id, parent ? `added as a sub-task of ${parent}` : 'added');
      /* Only the person who has to do the work. The verifier and the
         approval authority are named on the task from the start and hear
         nothing until somebody raises a hand — see lib/notices. */
      await mailAssigned(c, me, r, r.owner_id);
      return r;
    });
    return Response.json({ ok: true, task: row });
  } catch (e) { return fail(e); }
}

/**
 * To the recycle bin — the task and everything that hangs off it.
 *
 * This used to refuse a task that still had sub-tasks, so that one click
 * could not quietly take six records with it. The bin is a better answer to
 * that worry: the sub-tasks, budget lines, decisions and photographs travel
 * with the task as one entry and come back with it, and nothing is gone until
 * somebody empties the bin on purpose.
 */
export async function DELETE(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    if (!await mayManage(me.role))
      throw new HttpError(403, 'Removing a task is for a role that may act on other people\'s records.');
    const { id, reason } = await req.json();
    const t = await one('select * from tasks where id=$1 and deleted_at is null', [String(id || '')]);
    if (!t) throw new HttpError(404, 'No task with that ID.');

    let moved: any = null;
    await tx(async (c) => {
      moved = await bin(c, me, 'task', t.id);
      await note(c, me, 'task', t.id,
        moved && moved.children
          ? `moved to the recycle bin with ${moved.children} attached record${moved.children === 1 ? '' : 's'}`
          : 'moved to the recycle bin',
        { note: String(reason || '') });
    });
    return Response.json({ ok: true, moved });
  } catch (e) { return fail(e); }
}

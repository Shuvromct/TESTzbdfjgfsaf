import { randomUUID } from 'crypto';
import { one, q, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { requireOpenSite } from '@/lib/lock';
import { mayManage } from '@/lib/roles';
import { signPut, publicUrl, photoKey, removeObject, r2Ready } from '@/lib/r2';
import { note } from '@/lib/log';

/**
 * Before, during and after.
 *
 * Two steps, because the image never passes through this function: the browser
 * asks for somewhere to put it, uploads straight to R2 with the signed URL, and
 * then tells us it is there. A four-megabyte photograph on campus mobile data
 * would be slow through a serverless function and might not fit through it at
 * all.
 *
 * Both files are already resized by then — 1080 on the long edge, and a 400
 * thumbnail for lists. The place and the moment are read out of the EXIF before
 * the resize destroys it, and arrive here as plain fields.
 */
const KINDS = ['before', 'progress', 'after'];

/** Step one: somewhere to put it. */
export async function POST(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);

    const b = await req.json();
    const taskId = String(b.taskId || '');
    const kind = String(b.kind || '');
    /* What was asked for is checked before whether we can do it: a malformed
       request should hear that it is malformed, not that storage is unplugged. */
    if (!KINDS.includes(kind)) throw new HttpError(400, 'A photograph is before, progress or after.');
    if (!r2Ready())
      throw new HttpError(503, 'Photograph storage is not configured yet — see R2_* in .env.');

    const t = await one('select id, owner_id from tasks where id=$1 and deleted_at is null', [taskId]);
    if (!t) throw new HttpError(404, 'No task with that ID.');

    const id = randomUUID();
    const key = photoKey(taskId, kind, id);
    const thumbKey = photoKey(taskId, kind, id, true);
    const [put, putThumb] = await Promise.all([
      signPut(key, 'image/jpeg'),
      signPut(thumbKey, 'image/jpeg'),
    ]);
    return Response.json({ ok: true, id, put, putThumb,
                           url: publicUrl(key), thumbUrl: publicUrl(thumbKey) });
  } catch (e) { return fail(e); }
}

/** Step two: it is up there — write the row. */
export async function PUT(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    const b = await req.json();
    const id = String(b.id || '');
    const taskId = String(b.taskId || '');
    const kind = String(b.kind || '');
    if (!id || !KINDS.includes(kind)) throw new HttpError(400, 'That is not a photograph this system knows.');
    if (!(await one('select id from tasks where id=$1 and deleted_at is null', [taskId])))
      throw new HttpError(404, 'No task with that ID.');

    const src = b.source === 'upload' ? 'upload' : 'camera';
    const row = await tx(async (c) => {
      const r = (await c.query(
        `insert into photos (id, task_id, kind, url, thumb_url, caption, zone, source,
                             taken_at, lat, lng, bytes, width, height, uploaded_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
        [id, taskId, kind, String(b.url || ''), String(b.thumbUrl || ''),
         String(b.caption || ''), String(b.zone || ''), src,
         b.takenAt || null, b.lat ?? null, b.lng ?? null,
         b.bytes ?? null, b.width ?? null, b.height ?? null, me.id])).rows[0];
      await note(c, me, 'photo', taskId,
        `added a ${kind} photograph${src === 'upload' ? ' (uploaded, not taken here)' : ''}`,
        { note: String(b.caption || '') });
      return r;
    });
    return Response.json({ ok: true, photo: row });
  } catch (e) { return fail(e); }
}

/**
 * A caption.
 *
 * The column has been there since the first day and nothing could write to
 * it, so a task with twenty progress photographs was twenty dated squares
 * and no way to tell which was the render, which the first coat and which
 * the snag. It is not asked for at upload — a photograph taken on site
 * should be one tap — but it can be added afterwards by whoever added the
 * photograph, or by the project office.
 */
export async function PATCH(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    const b = await req.json();
    const p = await one('select * from photos where id=$1 and deleted_at is null',
      [String(b.id || '')]);
    if (!p) throw new HttpError(404, 'No photograph with that ID.');
    if (p.uploaded_by !== me.id && !await mayManage(me.role))
      throw new HttpError(403, 'Only the person who added it, or the Project Director, can caption it.');

    const caption = String(b.caption ?? '').slice(0, 200);
    if (caption === String(p.caption || '')) return Response.json({ ok: true, photo: p });

    const row = await tx(async (c) => {
      const r = (await c.query(
        'update photos set caption=$2 where id=$1 returning *', [p.id, caption])).rows[0];
      await note(c, me, 'photo', p.task_id,
        caption ? `captioned a ${p.kind} photograph — ${caption}`
                : `took the caption off a ${p.kind} photograph`,
        { field: `caption:${p.id}`, was: p.caption, now: caption });
      return r;
    });
    return Response.json({ ok: true, photo: row });
  } catch (e) { return fail(e); }
}

/**
 * Out of the record.
 *
 * The row is marked rather than removed and the file stays in the bucket: a
 * photograph that was once part of an audit record should not be able to
 * disappear without trace. Only the Director can do it, and the reason is kept.
 */
export async function DELETE(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    const { id, reason, purge } = await req.json();
    const p = await one('select * from photos where id=$1 and deleted_at is null', [String(id || '')]);
    if (!p) throw new HttpError(404, 'No photograph with that ID.');
    if (p.uploaded_by !== me.id && !await mayManage(me.role))
      throw new HttpError(403, 'Only the person who added it, or the Project Director, can remove it.');

    await tx(async (c) => {
      await c.query('update photos set deleted_at=now(), deleted_by=$2 where id=$1', [p.id, me.id]);
      await note(c, me, 'photo', p.task_id, `removed a ${p.kind} photograph`,
        { note: String(reason || '') });
    });

    /* Taking the file out of the bucket too is the administrator's call and
       cannot be undone, so it is never the default. */
    if (purge && await mayManage(me.role)) {
      const key = p.url.split('/').slice(3).join('/');
      await removeObject(key).catch(() => {});
      await removeObject(key.replace(/\.jpg$/, '_thumb.jpg')).catch(() => {});
    }
    return Response.json({ ok: true });
  } catch (e) { return fail(e); }
}

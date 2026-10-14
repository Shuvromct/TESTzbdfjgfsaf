import { q, one, tx } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { requireOpenSite } from '@/lib/lock';
import { mayManage, mayUse } from '@/lib/roles';
import { bin } from '@/lib/trash';
import { note, say } from '@/lib/log';

/**
 * Money.
 *
 * Quantities are measured on site, rates come from procurement, and the
 * approved figure is somebody's signature — so these are not the task owner's
 * to write. Anyone with the budget module may record a quantity or a rate; only
 * the Director or the administrator may set what has been approved or paid,
 * which is the line the audit will care about.
 */
const OPEN   = ['zone','item','unit','qty','rate','other_costs','forecast_rest','evidence_url','note'];
const SEALED = ['approved','committed','paid'];
const NUMS   = ['qty','rate','other_costs','approved','committed','paid','forecast_rest'];

const LABEL: Record<string,string> = {
  qty: 'quantity', rate: 'unit rate', other_costs: 'other costs', approved: 'approved budget',
  committed: 'committed', paid: 'actual paid', forecast_rest: 'forecast to complete',
  evidence_url: 'quote or approval link', note: 'note', item: 'item', unit: 'unit', zone: 'zone',
};

export async function PATCH(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    if (!(await mayUse(me.role, 'budget'))) throw new HttpError(403, 'You do not have the budget module.');

    const { id, changes } = await req.json();
    const lineId = String(id || '');
    const fields = Object.keys(changes || {});
    if (!lineId || !fields.length) throw new HttpError(400, 'Nothing to change.');

    const before = await one('select * from budget_lines where id=$1', [lineId]);
    if (!before) throw new HttpError(404, 'No budget line with that ID.');

    for (const f of fields) {
      if (SEALED.includes(f) && !await mayManage(me.role))
        throw new HttpError(403, 'Only the Project Director records an approved or paid amount.');
      if (!OPEN.includes(f) && !SEALED.includes(f))
        throw new HttpError(400, `There is no field called ${f}.`);
    }

    const row = await tx(async (c) => {
      const sets: string[] = [], vals: any[] = [lineId];
      for (const f of fields) {
        let v = changes[f];
        if (NUMS.includes(f)) {
          v = v === '' || v === null || v === undefined ? null : Number(v);
          if (v !== null && (!Number.isFinite(v) || v < 0))
            throw new HttpError(400, `${LABEL[f] || f} has to be a number, and not a negative one.`);
          if (f === 'other_costs' || f === 'paid') v = v ?? 0;
        } else v = String(v ?? '');
        vals.push(v);
        sets.push(`${f} = $${vals.length}`);
      }
      const r = (await c.query(
        `update budget_lines set ${sets.join(', ')}, updated_at=now() where id=$1 returning *`, vals)).rows[0];
      for (const f of fields) {
        if (String(before[f] ?? '') === String(r[f] ?? '')) continue;
        const wasSaid = await say(c, f, before[f]);
        const nowSaid = await say(c, f, r[f]);
        await note(c, me, 'budget', lineId,
          `set ${LABEL[f] || f} to ${nowSaid}`,
          { field: f, was: wasSaid, now: nowSaid, note: `task ${before.task_id}` });
      }
      return r;
    });
    return Response.json({ ok: true, line: row });
  } catch (e) { return fail(e); }
}

/* ------------------------------------------------------------- a new line */
/* The workbook arrived with B01–B25 and no twenty-sixth. A line belongs to a
   task — that is how money reaches the register, the department summary and
   the Dashboard — so the task is asked for and not guessed. */
async function nextId() {
  const rows = await q(`select id from budget_lines`);
  const used = rows
    .map((r: any) => String(r.id))
    .filter((id: string) => /^B\d+$/.test(id))
    .map((id: string) => Number(id.slice(1)));
  const n = (used.length ? Math.max(...used) : 0) + 1;
  return 'B' + String(n).padStart(2, '0');
}

export async function POST(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    if (!(await mayUse(me.role, 'budget'))) throw new HttpError(403, 'You do not have the budget module.');

    const b = await req.json();
    const taskId = String(b.taskId || '').trim();
    const item = String(b.item || '').trim();
    if (!taskId) throw new HttpError(400, 'A budget line belongs to a task.');
    if (!item) throw new HttpError(400, 'Say what the line is for.');
    if (!(await one('select id from tasks where id=$1 and deleted_at is null', [taskId])))
      throw new HttpError(400, `There is no task ${taskId}.`);

    const boss = await mayManage(me.role);
    const num = (v: any) => {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'A figure has to be a number, and not a negative one.');
      return n;
    };
    /* The approved figure is somebody's signature, so a new line cannot be
       born carrying one unless the person adding it may sign. */
    const approved = boss ? num(b.approved) : null;

    const id = String(b.id || '').trim() || await nextId();
    if (await one('select id from budget_lines where id=$1', [id]))
      throw new HttpError(409, `${id} already exists.`);

    const row = await tx(async (c) => {
      const r = (await c.query(
        `insert into budget_lines (id, task_id, zone, item, unit, qty, rate, other_costs,
                                   approved, note, evidence_url, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'project-office') returning *`,
        [id, taskId, String(b.zone || ''), item, String(b.unit || ''),
         num(b.qty), num(b.rate), num(b.otherCosts) ?? 0, approved,
         String(b.note || ''), String(b.evidenceUrl || '')])).rows[0];
      await note(c, me, 'budget', id, `added a budget line to ${taskId} — ${item}`);
      return r;
    });
    return Response.json({ ok: true, id, line: row });
  } catch (e) { return fail(e); }
}

/* ----------------------------------------------------------- and removing */
/* To the recycle bin, like everything else. A line that already carries an
   approved or a paid figure is part of the audit trail, so taking it out is
   the Director's and not the person who keeps the quantities. */
export async function DELETE(req: Request) {
  try {
    const me = await requireUser();
    await requireOpenSite(me.role);
    if (!(await mayUse(me.role, 'budget'))) throw new HttpError(403, 'You do not have the budget module.');

    const { id, reason } = await req.json();
    const lineId = String(id || '');
    const line = await one('select * from budget_lines where id=$1', [lineId]);
    if (!line) throw new HttpError(404, 'No budget line with that ID.');

    const signed = Number(line.approved || 0) > 0 || Number(line.paid || 0) > 0;
    if (signed && !(await mayManage(me.role)))
      throw new HttpError(403,
        `${lineId} already carries an approved or paid figure. Only the Project Director removes one of those.`);

    let moved: any = null;
    await tx(async (c) => {
      moved = await bin(c, me, 'budget', lineId);
      await note(c, me, 'budget', lineId, 'moved to the recycle bin',
        { note: String(reason || '') });
    });
    return Response.json({ ok: true, moved });
  } catch (e) { return fail(e); }
}

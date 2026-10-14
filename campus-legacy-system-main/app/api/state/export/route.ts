import ExcelJS from 'exceljs';
import { q, one } from '@/lib/db';
import { requireUser, fail, HttpError } from '@/lib/auth';
import { canRead, levelOf } from '@/lib/perm';

/**
 * The project, back as a workbook.
 * ---------------------------------------------------------------------------
 * The system replaced a Google Sheet, and the Chairman's office still works in
 * one. So this writes the record back out in the shape it came from: the same
 * tab per subject, and on the Tasks tab the same column headings, spelled the
 * way the tracker spells them.
 *
 * Which means a file taken out of here can be pasted back in — the headings
 * are exactly the ones "Paste from the tracker" reads, so a round trip is a
 * round trip and not a translation.
 *
 * The columns the sheet worked out with formulas — days to deadline, the
 * delay, the effective status, the audit check, the sub-task roll-up — are
 * written out filled, because the views have already worked them out and a
 * formula in a cell is one more thing that can quietly be wrong.
 *
 * What a person may take out is what they may see. Each tab is written only
 * if their role can read that section, and the Tasks tab carries the filters
 * the screen had when they pressed the button.
 */
export const dynamic = 'force-dynamic';

/* ------------------------------------------------------------------ paint */
const HEAD = 'FF12306B';                       /* the navy of the masthead */
const TINT: Record<string, string> = {
  Delayed: 'FFFBE9E9',
  'Due soon': 'FFFFF6E0',
  'Completed – evidence gap': 'FFFFF6E0',
  Completed: 'FFEFF8F1',
  Ongoing: 'FFEFF6F8',
};

type Col = { header: string; key: string; width: number };

function sheet(wb: ExcelJS.Workbook, name: string, cols: Col[]) {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],                    /* the headings stay put */
  });
  ws.columns = cols;
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
  h.alignment = { vertical: 'middle', wrapText: true };
  h.height = 28;
  return ws;
}

/** A date column holds a date, not the word for one, so Excel can sort it. */
const day = (v: any) => {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00Z') : null;
};
const yn = (v: any) => (v ? 'Yes' : 'No');
const num = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));

export async function GET(req: Request) {
  try {
    const me = await requireUser();
    const self = await one('select * from users where id=$1', [me.id]);
    const url = new URL(req.url);

    /* Named on a task with no register permission: the same narrow window the
       screen gives them, so the file cannot be a way around it. */
    const taskLevel = await levelOf(me.role, 'tasks');
    let scope: Set<string> | null = null;
    if (taskLevel === 'none') {
      const mine = await q(
        `select id from tasks where deleted_at is null
           and (owner_id = $1 or verifier_id = $1 or approver_id = $1
                or ($2::text is not null and lead_dept_id = $2))`,
        [self.id, self.dept_id || null]);
      const ids = mine.map((r: any) => String(r.id));
      const kids = ids.length ? await q(
        `select id from tasks where deleted_at is null and parent_id = any($1::text[])`, [ids]) : [];
      scope = new Set([...ids, ...kids.map((r: any) => String(r.id))]);
    }
    if (scope && scope.size === 0)
      throw new HttpError(403, 'There is nothing in the register for you to take out.');

    const [tasks, depts, users, roles, photos] = await Promise.all([
      q(`select * from task_state order by id`),
      q(`select * from departments order by name`),
      q(`select * from users order by name`),
      q(`select * from task_roles`),
      q(`select task_id, kind, url, caption, taken_at from photos
          where deleted_at is null order by task_id, kind, taken_at`),
    ]);

    const dept = (id: any) => (depts.find((d: any) => d.id === id) || {}).name || '';
    const who = (id: any) => (users.find((u: any) => u.id === id) || {}).name || '';
    const shot = (id: string, kind: string) =>
      photos.filter((p: any) => p.task_id === id && p.kind === kind)
        .map((p: any) => p.url).join('\n');

    /* ------------------------------------------------ the screen's filters */
    const g = (k: string) => (url.searchParams.get(k) || '').trim();
    const qText = g('q').toLowerCase();
    const phase = g('phase'), deptId = g('dept'), status = g('status');
    const mine = g('mine') === '1', late = g('late') === '1';

    let rows = tasks.filter((t: any) => !scope || scope.has(String(t.id)));
    if (phase && phase !== 'All') rows = rows.filter((t: any) => t.phase === phase);
    if (deptId && deptId !== 'All') rows = rows.filter((t: any) => t.lead_dept_id === deptId);
    if (status && status !== 'All') rows = rows.filter((t: any) => t.effective_status === status);
    if (mine) rows = rows.filter((t: any) =>
      t.owner_id === self.id || t.verifier_id === self.id || t.approver_id === self.id);
    if (late) rows = rows.filter((t: any) =>
      t.effective_status === 'Delayed' || t.effective_status === 'Due soon');
    if (qText) rows = rows.filter((t: any) =>
      `${t.id} ${t.title} ${t.site} ${t.category}`.toLowerCase().includes(qText));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'DIU Campus Legacy 25';
    wb.created = new Date();

    /* ================================================================ Tasks */
    const ws = sheet(wb, 'Tasks', [
      { header: 'Task ID', key: 'id', width: 13 },
      { header: 'Parent Task ID', key: 'parent', width: 13 },
      { header: 'Level', key: 'level', width: 8 },
      { header: 'Task / Sub-task', key: 'title', width: 52 },
      { header: 'Category', key: 'category', width: 16 },
      { header: 'Lead Department', key: 'lead', width: 24 },
      { header: 'Responsible Person', key: 'owner', width: 22 },
      { header: 'Supporting Department / Person', key: 'support', width: 26 },
      { header: 'Assigned Date', key: 'assigned', width: 13 },
      { header: 'Start Date', key: 'start', width: 13 },
      { header: 'Deadline', key: 'deadline', width: 13 },
      { header: 'Duration (Days)', key: 'duration', width: 11 },
      { header: 'Days to Deadline', key: 'daysTo', width: 11 },
      { header: 'Delay (Days)', key: 'delay', width: 10 },
      { header: 'Priority', key: 'priority', width: 15 },
      { header: 'Status', key: 'status', width: 15 },
      { header: '% Progress', key: 'progress', width: 11 },
      { header: 'Sub-tasks', key: 'subs', width: 10 },
      { header: 'Sub-task Roll-up %', key: 'rollup', width: 13 },
      { header: 'Effective Status', key: 'eff', width: 24 },
      { header: 'Audit Check', key: 'audit', width: 30 },
      { header: 'Verification By', key: 'verifier', width: 22 },
      { header: 'Verified By', key: 'verifiedBy', width: 22 },
      { header: 'Verification Date', key: 'verifiedOn', width: 13 },
      { header: 'Approval By', key: 'approver', width: 22 },
      { header: 'Approval Status', key: 'approval', width: 18 },
      { header: 'Completion Date', key: 'completed', width: 13 },
      { header: 'Phase', key: 'phase', width: 22 },
      { header: 'Implementation Route', key: 'route', width: 24 },
      { header: 'Site / Location', key: 'site', width: 18 },
      { header: 'Depends On', key: 'depends', width: 16 },
      { header: 'Photos Required', key: 'photosReq', width: 11 },
      { header: 'Before Photo Link', key: 'before', width: 28 },
      { header: 'Progress Photo Link', key: 'during', width: 28 },
      { header: 'After Photo Link', key: 'after', width: 28 },
      { header: 'Evidence / Document Reference', key: 'evRef', width: 26 },
      { header: 'Evidence / Document Link', key: 'evUrl', width: 28 },
      { header: 'Acceptance Criteria (Chairman)', key: 'acceptance', width: 40 },
      { header: 'Remarks', key: 'remarks', width: 40 },
      { header: 'Budget (BDT)', key: 'budget', width: 14 },
      { header: 'Actual Cost (BDT)', key: 'paid', width: 14 },
      { header: 'Last Updated', key: 'updatedAt', width: 18 },
      { header: 'Updated By', key: 'updatedBy', width: 20 },
    ]);

    for (const t of rows as any[]) {
      const r = ws.addRow({
        id: t.id,
        parent: t.parent_id || '',
        level: t.parent_id ? 'Sub-task' : 'Task',
        title: t.title,
        category: t.category,
        lead: dept(t.lead_dept_id),
        owner: who(t.owner_id),
        support: t.support_text,
        assigned: day(t.assigned_on),
        start: day(t.start_on),
        deadline: day(t.deadline),
        duration: num(t.duration_days),
        daysTo: t.continuous ? null : num(t.days_to_deadline),
        delay: num(t.delay_days),
        priority: t.priority,
        status: t.status,
        progress: num(t.progress),
        subs: num(t.sub_count),
        rollup: Number(t.sub_count) ? num(t.effective_progress) : null,
        eff: t.effective_status,
        /* The sheet's Audit Check said OK or named what was missing. */
        audit: (t.audit_gaps || []).length ? `Missing: ${(t.audit_gaps || []).join(', ')}`
             : t.status === 'Completed' ? 'OK' : '',
        verifier: who(t.verifier_id),
        verifiedBy: who(t.verified_by),
        verifiedOn: day(t.verified_on),
        approver: who(t.approver_id),
        approval: t.approval_status,
        completed: day(t.completed_on),
        phase: t.phase,
        route: t.route,
        site: t.site,
        depends: (t.depends_on || []).join(', '),
        photosReq: yn(t.photos_required),
        before: shot(t.id, 'before'),
        during: shot(t.id, 'progress'),
        after: shot(t.id, 'after'),
        evRef: t.evidence_ref,
        evUrl: t.evidence_url,
        acceptance: t.acceptance,
        remarks: t.remarks,
        budget: num(t.budget),
        paid: num(t.spent),
        updatedAt: t.updated_at ? new Date(t.updated_at) : null,
        updatedBy: who(t.updated_by),
      });

      /* A sub-task is set in from its task, the way the sheet indented them. */
      if (t.parent_id) r.getCell('title').alignment = { indent: 2 };

      const tint = TINT[t.effective_status];
      if (tint) r.getCell('eff').fill =
        { type: 'pattern', pattern: 'solid', fgColor: { argb: tint } };
    }

    ws.getColumn('progress').numFmt = '0%';
    ws.getColumn('rollup').numFmt = '0%';
    ws.getColumn('budget').numFmt = '#,##0.00';
    ws.getColumn('paid').numFmt = '#,##0.00';
    ws.getColumn('updatedAt').numFmt = 'dd mmm yy hh:mm';
    for (const k of ['assigned', 'start', 'deadline', 'verifiedOn', 'completed'])
      ws.getColumn(k).numFmt = 'dd-mmm-yy';
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };

    /* ====================================================== Responsibility */
    const seen = new Set(rows.map((t: any) => String(t.id)));
    const r2 = sheet(wb, 'Responsibility', [
      { header: 'Task ID', key: 'id', width: 13 },
      { header: 'Task / Sub-task', key: 'title', width: 52 },
      { header: 'Department', key: 'dept', width: 26 },
      { header: 'Role', key: 'role', width: 16 },
    ]);
    const ROLE_WORD: Record<string, string> = {
      L: 'Lead', S: 'Support', V: 'Verify', A: 'Approve',
    };
    for (const tr of roles as any[]) {
      if (!seen.has(String(tr.task_id))) continue;
      const t = tasks.find((x: any) => x.id === tr.task_id);
      r2.addRow({ id: tr.task_id, title: t ? t.title : '', dept: dept(tr.dept_id),
                  role: ROLE_WORD[tr.role] || tr.role });
    }

    /* =============================================================== Budget */
    if (await canRead(me.role, 'budget')) {
      const lines = await q(`select * from budget_lines order by id`);
      const b = sheet(wb, 'Budget', [
        { header: 'Line', key: 'id', width: 10 },
        { header: 'Task ID', key: 'task', width: 13 },
        { header: 'Zone', key: 'zone', width: 12 },
        { header: 'Item', key: 'item', width: 44 },
        { header: 'Unit', key: 'unit', width: 10 },
        { header: 'Qty', key: 'qty', width: 10 },
        { header: 'Rate', key: 'rate', width: 12 },
        { header: 'Other Costs', key: 'other', width: 12 },
        { header: 'Approved (BDT)', key: 'approved', width: 15 },
        { header: 'Committed (BDT)', key: 'committed', width: 15 },
        { header: 'Paid (BDT)', key: 'paid', width: 14 },
        { header: 'Forecast to Finish', key: 'rest', width: 15 },
        { header: 'Evidence Link', key: 'ev', width: 28 },
        { header: 'Note', key: 'note', width: 34 },
      ]);
      for (const l of lines as any[]) {
        if (scope && !scope.has(String(l.task_id))) continue;
        b.addRow({ id: l.id, task: l.task_id, zone: l.zone, item: l.item, unit: l.unit,
          qty: num(l.qty), rate: num(l.rate), other: num(l.other_costs),
          approved: num(l.approved), committed: num(l.committed), paid: num(l.paid),
          rest: num(l.forecast_rest), ev: l.evidence_url, note: l.note });
      }
      for (const k of ['rate', 'other', 'approved', 'committed', 'paid', 'rest'])
        b.getColumn(k).numFmt = '#,##0.00';
    }

    /* ============================================================ Decisions */
    if (await canRead(me.role, 'approvals')) {
      const [items, steps] = await Promise.all([
        q(`select * from approval_state order by id`),
        q(`select * from approval_steps order by approval_id, task_id, step_no`),
      ]);
      const d = sheet(wb, 'Decisions', [
        { header: 'Decision ID', key: 'id', width: 12 },
        { header: 'Task ID', key: 'task', width: 13 },
        { header: 'Item', key: 'item', width: 48 },
        { header: 'Raised By', key: 'orig', width: 22 },
        { header: 'Verification By', key: 'verifier', width: 22 },
        { header: 'Verification', key: 'verification', width: 14 },
        { header: 'Verification Date', key: 'verifiedOn', width: 13 },
        { header: 'Final Authority', key: 'authority', width: 26 },
        { header: 'Chairman Needed', key: 'chairman', width: 12 },
        { header: 'Submitted On', key: 'submitted', width: 13 },
        { header: 'Due On', key: 'due', width: 13 },
        { header: 'Decision', key: 'decision', width: 20 },
        { header: 'Decided On', key: 'decidedOn', width: 13 },
        { header: 'Decided By', key: 'decidedBy', width: 22 },
        { header: 'Chain', key: 'chain', width: 40 },
        { header: 'Conditions', key: 'conditions', width: 34 },
        { header: 'Impact', key: 'impact', width: 30 },
        { header: 'Evidence Link', key: 'ev', width: 28 },
      ]);
      for (const a of items as any[]) {
        if (scope && !scope.has(String(a.task_id))) continue;
        const chain = (steps as any[])
          .filter(s => s.approval_id === a.id)
          .map(s => `${s.step_no}. ${who(s.approver_id) || s.post || 'not named'} — ${s.status}`)
          .join('\n');
        d.addRow({ id: a.id, task: a.task_id, item: a.item, orig: who(a.originator_id),
          verifier: who(a.verifier_id), verification: a.verification,
          verifiedOn: day(a.verified_on), authority: a.final_authority,
          chairman: yn(a.chairman_needed), submitted: day(a.submitted_on), due: day(a.due_on),
          decision: a.decision, decidedOn: day(a.decided_on), decidedBy: who(a.decided_by),
          chain, conditions: a.conditions, impact: a.impact, ev: a.evidence_url });
      }
      for (const k of ['verifiedOn', 'submitted', 'due', 'decidedOn'])
        d.getColumn(k).numFmt = 'dd-mmm-yy';
    }

    /* ================================================================ Gates */
    if (await canRead(me.role, 'milestones')) {
      const gates = await q(`select * from milestone_state order by sort_order, due_on`);
      const g2 = sheet(wb, 'Gates', [
        { header: 'Gate', key: 'id', width: 10 },
        { header: 'Title', key: 'title', width: 48 },
        { header: 'Due On', key: 'due', width: 13 },
        { header: 'Days Left', key: 'left', width: 10 },
        { header: 'Responsible', key: 'resp', width: 26 },
        { header: 'Release Evidence', key: 'release', width: 40 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Standing', key: 'flag', width: 18 },
        { header: 'Achieved On', key: 'achieved', width: 13 },
        { header: 'Evidence Link', key: 'ev', width: 28 },
      ]);
      for (const m of gates as any[])
        g2.addRow({ id: m.id, title: m.title, due: day(m.due_on), left: num(m.days_left),
          resp: m.responsible, release: m.release_evidence, status: m.status,
          flag: m.flag, achieved: day(m.achieved_on), ev: m.evidence_url });
      g2.getColumn('due').numFmt = 'dd-mmm-yy';
      g2.getColumn('achieved').numFmt = 'dd-mmm-yy';
    }

    /* ================================================================ Zones */
    if (await canRead(me.role, 'survey')) {
      const zones = await q(`select * from survey order by id`);
      const z = sheet(wb, 'Zones', [
        { header: 'ID', key: 'id', width: 10 },
        { header: 'Zone', key: 'zone', width: 12 },
        { header: 'Location', key: 'location', width: 36 },
        { header: 'Observation', key: 'observation', width: 44 },
        { header: 'Approx Size', key: 'size', width: 14 },
        { header: 'Condition', key: 'condition', width: 14 },
        { header: 'Hazard', key: 'hazard', width: 9 },
        { header: 'Access Clear', key: 'access', width: 12 },
        { header: 'Proposal', key: 'proposal', width: 40 },
        { header: 'Route', key: 'route', width: 24 },
        { header: 'Department', key: 'dept', width: 26 },
        { header: 'Task ID', key: 'task', width: 13 },
        { header: 'Student Involvement', key: 'students', width: 18 },
        { header: 'Safety Class', key: 'safety', width: 14 },
        { header: 'Confirmed', key: 'confirmed', width: 11 },
        { header: 'Before Photo', key: 'before', width: 28 },
        { header: 'Remarks', key: 'remarks', width: 34 },
      ]);
      for (const s of zones as any[])
        z.addRow({ id: s.id, zone: s.zone, location: s.location, observation: s.observation,
          size: s.approx_size, condition: s.condition, hazard: yn(s.hazard),
          access: s.access_clear, proposal: s.proposal, route: s.route, dept: dept(s.dept_id),
          task: s.task_id || '', students: s.student_involvement, safety: s.safety_class,
          confirmed: yn(s.confirmed), before: s.before_url, remarks: s.remarks });
    }

    /* ======================================================= Student teams */
    if (await canRead(me.role, 'students')) {
      const teams = await q(`select * from student_teams order by id`);
      const s2 = sheet(wb, 'Student teams', [
        { header: 'Team', key: 'id', width: 12 },
        { header: 'Leader', key: 'leader', width: 24 },
        { header: 'Student ID', key: 'sid', width: 14 },
        { header: 'Faculty Supervisor', key: 'sup', width: 24 },
        { header: 'Members', key: 'members', width: 10 },
        { header: 'Tasks', key: 'tasks', width: 26 },
        { header: 'Course Mapping', key: 'course', width: 30 },
        { header: 'Hours Planned', key: 'planned', width: 12 },
        { header: 'Hours Verified', key: 'verified', width: 12 },
        { header: 'Induction On', key: 'induction', width: 13 },
        { header: 'Viva On', key: 'viva', width: 13 },
        { header: 'Roster Link', key: 'roster', width: 28 },
        { header: 'Evidence Link', key: 'ev', width: 28 },
        { header: 'Remarks', key: 'remarks', width: 34 },
      ]);
      for (const t of teams as any[])
        s2.addRow({ id: t.id, leader: t.leader_name, sid: t.leader_sid,
          sup: who(t.supervisor_id), members: num(t.members),
          tasks: (t.task_ids || []).join(', '), course: t.course_map,
          planned: num(t.hours_planned), verified: num(t.hours_verified),
          induction: day(t.induction_on), viva: day(t.viva_on),
          roster: t.roster_url, ev: t.evidence_url, remarks: t.remarks });
      s2.getColumn('induction').numFmt = 'dd-mmm-yy';
      s2.getColumn('viva').numFmt = 'dd-mmm-yy';
    }

    /* =============================================================== People */
    if (await canRead(me.role, 'users')) {
      const pp = sheet(wb, 'People', [
        { header: 'Name', key: 'name', width: 28 },
        { header: 'Designation', key: 'designation', width: 30 },
        { header: 'Department', key: 'dept', width: 26 },
        { header: 'Email', key: 'email', width: 34 },
        { header: 'Employee ID', key: 'emp', width: 14 },
        { header: 'Phone', key: 'phone', width: 16 },
        { header: 'IP Phone', key: 'ipPhone', width: 12 },
        { header: 'Roles', key: 'roles', width: 26 },
        { header: 'Active', key: 'active', width: 9 },
      ]);
      for (const u of users as any[])
        pp.addRow({ name: u.name, designation: u.designation, dept: dept(u.dept_id),
          email: u.email, emp: u.emp_id, phone: u.phone, ipPhone: u.ip_phone,
          roles: (u.roles && u.roles.length ? u.roles : [u.role]).join(', '),
          active: yn(u.active) });
    }

    const buf = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(buf as any, {
      headers: {
        'content-type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="CL25-${stamp}.xlsx"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e) { return fail(e); }
}

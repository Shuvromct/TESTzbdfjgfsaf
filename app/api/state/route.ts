import { gzipSync } from 'node:zlib';
import { headers } from 'next/headers';
import { q, one } from '@/lib/db';
import { requireUser, fail } from '@/lib/auth';
import { siteLock, mayEnter, DEFAULT_LOCK_MESSAGE } from '@/lib/lock';
import { mayManage, readableSections, rolesForClient, heldRoles, isSuper } from '@/lib/roles';
import { roleDef, levelOf, canEdit } from '@/lib/perm';

/**
 * The whole project, in one request.
 *
 * Seventy-eight tasks, twenty-five budget lines, eighteen decisions and
 * seventeen gates. All of it together is a few hundred kilobytes, so there is
 * nothing to gain by paging it and a great deal to lose: the client can filter,
 * sort and count without another round trip, which is what makes the thing
 * usable on a phone at the far end of the campus.
 *
 * The derived columns — delayed, due soon, the audit gaps, the roll-up — come
 * from the views, so this handler does no arithmetic at all.
 */
/**
 * The same JSON, compressed.
 *
 * The whole project is 179 KB of text and about 20 KB once zipped — the
 * difference between a quick load and a wait on a phone at the far end of the
 * campus. Next compresses the files it serves but not what a route handler
 * returns, so this does it here. Level 4 rather than the default 6: it is
 * three times faster to produce and within a kilobyte of the same size.
 */
async function json(payload: unknown) {
  const body = JSON.stringify(payload);
  const accepts = (await headers()).get('accept-encoding') || '';
  if (body.length < 4096 || !accepts.includes('gzip'))
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  const gz = gzipSync(body, { level: 4 });
  return new Response(gz, {
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(gz.length),
      'vary': 'accept-encoding',
    },
  });
}

export async function GET() {
  try {
    const me = await requireUser();

    const [self, lock] = await Promise.all([
      one('select * from users where id=$1', [me.id]),
      siteLock(),
    ]);

    /* Named on a task, with no task permission at all.
       --------------------------------------------------------------------
       Being written into one of the four chairs on a task is a permission
       in its own right (see writableTask). A student or an outside
       contractor can therefore be given CL25-31 and nothing else — but
       their role says the register is closed to them, so without this the
       task would not be in their copy of the project at all and there would
       be nothing on screen to edit.

       So: if the role says none and the person is named somewhere, the task
       register opens for them and carries exactly the tasks they are named
       on, plus the sub-tasks of those. The rest of the project does not
       travel with it. */
    const taskLevel = await levelOf(me.role, 'tasks');
    let scope: Set<string> | null = null;
    if (taskLevel === 'none') {
      const mine = await q(
        `select id from tasks
          where deleted_at is null
            and (owner_id = $1 or verifier_id = $1 or approver_id = $1
                 or ($2::text is not null and lead_dept_id = $2)
                 or id in (select task_id from task_helpers where user_id = $1))`,
        [self.id, self.dept_id || null]);
      const ids = mine.map((r: any) => String(r.id));
      if (ids.length) {
        const kids = await q(
          `select id from tasks where deleted_at is null and parent_id = any($1::text[])`, [ids]);
        scope = new Set([...ids, ...kids.map((r: any) => String(r.id))]);
      }
    }
    const inScope = (id: any) => !scope || scope.has(String(id));

    const sections = await readableSections(me.role);
    if (scope && !sections.includes('tasks')) sections.push('tasks');

    const mePayload = {
      id: self.id, name: self.name, email: self.email, role: me.role,
      roles: heldRoles(self),
      empId: self.emp_id || '', phone: self.phone || '', designation: self.designation || '',
      deptId: self.dept_id || '', active: self.active, mustChange: self.must_change,
      sections,
      perms: (await roleDef(me.role)).perms,
      keeper: await mayManage(me.role),
      /* Whether the sign-off-for-somebody-else buttons are drawn at all. The
         server checks it again on every such write; this only hides what the
         person cannot use. */
      superApprove: await isSuper(me.role),
      /* The screen says so plainly rather than looking like an empty project. */
      scoped: !!scope,
    };

    /* Doors shut: the notice and nothing else, so a stale tab has nothing to
       work with either. */
    if (lock.on && !mayEnter(me.role))
      return json({
        locked: true, lockMessage: lock.msg || DEFAULT_LOCK_MESSAGE, me: mePayload,
        users: [], departments: [], tasks: [], taskRoles: [], budget: [], approvals: [],
        milestones: [], photos: [], survey: [], teams: [], studentDays: [], activity: [],
        steps: [], reference: [], settings: {}, roles: [],
      });

    const keeper = await mayManage(me.role);

    /* eslint-disable prefer-const */
    let [users, departments, tasks, helpers, taskRoles, budget, approvals, milestones,
         photos, survey, teams, studentDays, activity, steps, reference, roles,
         settingsRows] =
      await Promise.all([
        q(`select id, name, email, emp_id, phone, ip_phone, designation, dept_id, cc_email,
                  role, roles, active,
                  (pw_hash is not null) as has_password, must_change
             from users order by case role when 'ADMIN' then 0 when 'DIRECTOR' then 1 else 2 end, name`),
        q(`select d.*, u.name as focal_name from departments d
             left join users u on u.id = d.focal_user_id order by d.name`),
        q(`select * from task_state order by id`),
        /* Who else is on each task. A separate query rather than a column on
           the view: a task has none most of the time, and the view is read by
           everything. */
        q(`select task_id, user_id from task_helpers`),
        q(`select * from task_roles`),
        q(`select b.*, (coalesce(b.qty,0) * coalesce(b.rate,0)) as base_cost from budget_lines b order by b.id`),
        q(`select * from approval_state order by id`),
        q(`select * from milestone_state order by sort_order, due_on`),
        q(`select * from photos where deleted_at is null order by uploaded_at desc`),
        q(`select * from survey order by id`),
        q(`select * from student_teams order by id`),
        q(`select * from student_days order by id`),
        /* The trail is long by design. The last few hundred entries answer
           "what happened this week", which is all any screen shows; the rest is
           read from the database when somebody is actually auditing. */
        q(`select * from activity order by at desc limit ${keeper ? 400 : 150}`),
        q(`select * from approval_steps order by coalesce(task_id, approval_id), step_no`).catch(() => []),
        /* The original, for comparison. Small, and everyone may read it. */
        q(`select * from chairman_reference order by task_id`).catch(() => []),
        rolesForClient().catch(() => []),
        q(`select key, value, updated_by, updated_at from settings`).catch(() => []),
      ]);

    /* A scoped copy carries the named tasks and what hangs off them, and
       nothing else. The lists that have no connection to a task — the
       survey, the student teams, the Chairman's tracker — do not travel;
       neither does the rest of the staff directory. */
    if (scope) {
      tasks      = tasks.filter((t: any) => inScope(t.id));
      taskRoles  = taskRoles.filter((r: any) => inScope(r.task_id));
      budget     = budget.filter((b: any) => inScope(b.task_id));
      approvals  = approvals.filter((a: any) => inScope(a.task_id));
      photos     = photos.filter((p: any) => inScope(p.task_id));
      steps      = steps.filter((s: any) => inScope(s.task_id) || s.task_id === null);
      studentDays = studentDays.filter((d: any) => d.task_id && inScope(d.task_id));
      activity   = activity.filter((a: any) =>
        a.user_id === self.id || (a.subject === 'task' && inScope(a.subject_id)));
      reference  = reference.filter((r: any) => inScope(r.task_id));
      survey = []; teams = [];
      /* Everyone who is on one of these tasks, so a name can be shown —
         without the directory of email addresses and telephone numbers. */
      const faces = new Set<string>([self.id]);
      for (const t of tasks as any[])
        for (const k of ['owner_id', 'verifier_id', 'approver_id', 'verified_by', 'updated_by'])
          if (t[k]) faces.add(String(t[k]));
      users = users.filter((u: any) => faces.has(String(u.id)))
        .map((u: any) => u.id === self.id ? u : ({ ...u, email: '', phone: '', cc_email: '' }));
    }

    const settings: Record<string, any> = {};
    settingsRows.forEach((r: any) => { settings[r.key] = r.value; });
    /* The Chairman's address is a password in all but name: whoever has it
       is in. It goes only to the roles that may set it. */
    if (!(await canEdit(me.role, 'admin'))) delete settings.chairman_link;

    return json({
      locked: false, me: mePayload, roles, settings, siteLock: lock,
      users: users.map((u: any) => ({
        id: u.id, name: u.name, email: u.email, empId: u.emp_id || '', phone: u.phone || '',
        ipPhone: u.ip_phone || '',
        ccEmail: u.cc_email || '',
        designation: u.designation || '', deptId: u.dept_id || '', role: u.role,
        roles: heldRoles(u),
        active: u.active, hasPassword: u.has_password, mustChange: u.must_change,
      })),
      departments: departments.map((d: any) => ({
        id: d.id, name: d.name, responsibilities: d.responsibilities,
        focalUserId: d.focal_user_id, focalName: d.focal_name || '', active: d.active,
      })),
      tasks: tasks.map((t: any) => ({
        helpers: (helpers as any[])
          .filter((h: any) => h.task_id === t.id).map((h: any) => h.user_id),
        id: t.id, parentId: t.parent_id, title: t.title, category: t.category,
        phase: t.phase, route: t.route, priority: t.priority, site: t.site,
        leadDeptId: t.lead_dept_id, ownerId: t.owner_id, verifierId: t.verifier_id,
        approverId: t.approver_id, assignedOn: t.assigned_on, startOn: t.start_on,
        deadline: t.deadline, completedOn: t.completed_on, status: t.status,
        progress: Number(t.progress), approvalStatus: t.approval_status,
        photosRequired: t.photos_required, evidenceRef: t.evidence_ref,
        evidenceUrl: t.evidence_url, acceptance: t.acceptance, remarks: t.remarks,
        verifiedBy: t.verified_by, verifiedOn: t.verified_on, dependsOn: t.depends_on || [],
        supportText: t.support_text || '', updatedBy: t.updated_by,
        continuous: !!t.continuous,
        isTask: t.is_task, subCount: Number(t.sub_count),
        effectiveProgress: Number(t.effective_progress),
        daysToDeadline: t.days_to_deadline, delayDays: Number(t.delay_days),
        auditGaps: t.audit_gaps || [], auditComplete: t.audit_complete,
        openWarning: t.open_warning, effectiveStatus: t.effective_status,
        durationDays: Number(t.duration_days),
        budget: Number(t.budget), spent: Number(t.spent),
        updatedAt: t.updated_at,
      })),
      taskRoles: taskRoles.map((r: any) => ({ taskId: r.task_id, deptId: r.dept_id, role: r.role })),
      budget: budget.map((b: any) => ({
        id: b.id, taskId: b.task_id, zone: b.zone, item: b.item, unit: b.unit,
        qty: b.qty === null ? null : Number(b.qty), rate: b.rate === null ? null : Number(b.rate),
        baseCost: Number(b.base_cost), otherCosts: Number(b.other_costs),
        approved: b.approved === null ? null : Number(b.approved),
        committed: b.committed === null ? null : Number(b.committed),
        paid: Number(b.paid),
        forecastRest: b.forecast_rest === null ? null : Number(b.forecast_rest),
        evidenceUrl: b.evidence_url, note: b.note, source: b.source,
      })),
      approvals: approvals.map((a: any) => ({
        id: a.id, taskId: a.task_id, item: a.item, originatorId: a.originator_id,
        verifierId: a.verifier_id, verification: a.verification, verifiedOn: a.verified_on,
        finalAuthority: a.final_authority, chairmanNeeded: a.chairman_needed,
        submittedOn: a.submitted_on, dueOn: a.due_on, decision: a.decision,
        decidedOn: a.decided_on, decidedBy: a.decided_by, conditions: a.conditions,
        impact: a.impact, evidenceUrl: a.evidence_url, source: a.source,
        stage: a.stage, daysOpen: a.days_open, overdue: a.overdue,
      })),
      milestones: milestones.map((m: any) => ({
        id: m.id, title: m.title, dueOn: m.due_on, responsible: m.responsible,
        releaseEvidence: m.release_evidence, status: m.status, achievedOn: m.achieved_on,
        evidenceUrl: m.evidence_url, sortOrder: m.sort_order,
        daysLeft: m.days_left, flag: m.flag,
      })),
      photos: photos.map((p: any) => ({
        id: p.id, taskId: p.task_id, kind: p.kind, url: p.url, thumbUrl: p.thumb_url,
        caption: p.caption, zone: p.zone, source: p.source, takenAt: p.taken_at,
        lat: p.lat === null ? null : Number(p.lat), lng: p.lng === null ? null : Number(p.lng),
        bytes: p.bytes, width: p.width, height: p.height,
        uploadedBy: p.uploaded_by, uploadedAt: p.uploaded_at,
      })),
      survey: survey.map((s: any) => ({
        id: s.id, zone: s.zone, location: s.location, observation: s.observation,
        beforeUrl: s.before_url, approxSize: s.approx_size, condition: s.condition,
        hazard: s.hazard, accessClear: s.access_clear, proposal: s.proposal,
        route: s.route, deptId: s.dept_id, taskId: s.task_id,
        studentInvolvement: s.student_involvement, safetyClass: s.safety_class,
        confirmed: s.confirmed, remarks: s.remarks,
      })),
      teams: teams.map((t: any) => ({
        id: t.id, leaderName: t.leader_name, leaderSid: t.leader_sid,
        supervisorId: t.supervisor_id, members: t.members, taskIds: t.task_ids || [],
        rosterUrl: t.roster_url, courseMap: t.course_map,
        hoursPlanned: t.hours_planned === null ? null : Number(t.hours_planned),
        hoursVerified: t.hours_verified === null ? null : Number(t.hours_verified),
        evidenceUrl: t.evidence_url, inductionOn: t.induction_on, vivaOn: t.viva_on,
        remarks: t.remarks,
      })),
      studentDays: studentDays.map((d: any) => ({
        id: d.id, activity: d.activity, taskId: d.task_id,
        students: d.students, days: d.days, note: d.note,
      })),
      steps: steps.map((s: any) => ({
        id: s.id, taskId: s.task_id, approvalId: s.approval_id, stepNo: s.step_no,
        approverId: s.approver_id, post: s.post, status: s.status,
        decidedOn: s.decided_on, decidedBy: s.decided_by, note: s.note,
      })),
      reference: reference.map((r: any) => ({
        taskId: r.task_id, workstream: r.workstream, deliverable: r.deliverable,
        priority: r.priority, owner: r.owner, support: r.support,
        startOn: r.start_on, dueOn: r.due_on, gates: r.gates,
        acceptance: r.acceptance, status: r.status,
      })),
      activity: activity.map((a: any) => ({
        id: a.id, at: a.at, userId: a.user_id, userName: a.user_name, role: a.role,
        subject: a.subject, subjectId: a.subject_id, what: a.what,
        field: a.field, was: a.was, now: a.now_, note: a.note,
      })),
    });
  } catch (e) { return fail(e); }
}

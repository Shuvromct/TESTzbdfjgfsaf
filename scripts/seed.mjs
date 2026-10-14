/**
 * Load the Chairman's Execution Tracker v1.0 into an empty database.
 *
 *   npm run db:seed
 *
 * Everything in seed.json was read out of the monitoring workbook: forty-six
 * work packages with their thirty-two sub-tasks, twenty-five budget lines,
 * eighteen decisions, seventeen gates, fifteen survey zones, twenty-two
 * departments and twelve student teams. No figures are included, because there
 * were none to include — the quantities are measured on site and the rates come
 * from procurement.
 *
 * People arrive as placeholder accounts with no password: the tracker names
 * them as posts ("Facilities Engineering Lead", "Architecture Lead [to
 * appoint]") rather than as people, and six of them had not been appointed when
 * the workbook was written. The administrator sets a real email and a password
 * as each one is named.
 *
 * Running it twice changes nothing: every insert is `on conflict do nothing`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'seed.json'), 'utf8'));

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const pool = new pg.Pool({
  connectionString: url,
  ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});

/** 'Facilities Engineering' -> 'facilities-engineering' */
const slug = (s) => String(s).toLowerCase()
  .replace(/[''']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** A person named in the tracker, as a placeholder account. */
const emailFor = (name) => `${slug(name).replace(/-to-appoint$/, '')}@cl25.local`;

const PHASES = {
  'Phase 1 – IAUP Readiness': 'Phase 1 – IAUP Readiness',
  'Event – IAUP Meeting': 'Event – IAUP Meeting',
  'Phase 2 – Silver Jubilee': 'Phase 2 – Silver Jubilee',
  'Closeout & Care': 'Closeout & Care',
};
const ROUTES = {
  'Recommended Intervention': 'Recommended Intervention',
  'Student-Led Creative Project': 'Student-Led Creative Project',
  'Mixed': 'Mixed',
  'Management / Approval': 'Management / Approval',
};

const c = await pool.connect();
let counts = {};
const bump = (k, n = 1) => { counts[k] = (counts[k] || 0) + n; };

try {
  await c.query('begin');

  /* ---- departments ---------------------------------------------------- */
  const deptId = {};
  for (const d of data.departments) {
    const id = slug(d.name);
    deptId[d.name] = id;
    const r = await c.query(
      `insert into departments (id, name, responsibilities) values ($1,$2,$3)
       on conflict (id) do nothing returning id`, [id, d.name, d.resp || '']);
    if (r.rowCount) bump('departments');
  }

  /* ---- people --------------------------------------------------------- */
  /* Everyone the tracker names in a Responsible Person, Verification By or
     Approval By cell, plus the contacts sheet. A post with nobody in it yet is
     still created, so the task has somewhere to point. */
  const names = new Set(data.contacts);
  for (const t of data.tasks) {
    [t.owner, t.verifier, t.approver].forEach((n) => {
      if (n) n.split(';').map((x) => x.trim()).filter(Boolean).forEach((x) => names.add(x));
    });
  }
  const userId = {};
  for (const name of [...names].sort()) {
    const email = emailFor(name);
    const existing = await c.query('select id from users where lower(email)=$1', [email]);
    if (existing.rows.length) { userId[name] = existing.rows[0].id; continue; }
    const vacant = /\[to appoint\]/i.test(name);
    const r = await c.query(
      `insert into users (name, email, role, designation, active, must_change)
       values ($1,$2,$3,$4,$5,true) returning id`,
      [name.replace(/\s*\[to appoint\]/i, ''), email,
       /Chairman|Vice-Chancellor|Pro-VC|Registrar|Treasurer/i.test(name) ? 'APPROVER' : 'MEMBER',
       name.replace(/\s*\[to appoint\]/i, ''), !vacant]);
    userId[name] = r.rows[0].id;
    bump('users');
  }
  const firstOf = (cell) => {
    if (!cell) return null;
    const n = cell.split(';')[0].trim();
    return userId[n] || null;
  };

  /* ---- tasks ---------------------------------------------------------- */
  /* Parents first, so a sub-task always has something to point at. */
  const ordered = [...data.tasks].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0));
  for (const t of ordered) {
    const owner = firstOf(t.owner);
    let verifier = firstOf(t.verifier);
    let approver = firstOf(t.approver);
    /* The table will not have one person in two chairs, and in the tracker a
       handful of rows name the same person twice. The ownership stands; the
       other seat is left empty for the Director to fill. */
    if (verifier && verifier === owner) verifier = null;
    if (approver && approver === owner) approver = null;

    const r = await c.query(
      `insert into tasks (id, parent_id, title, category, phase, route, priority, site,
                          lead_dept_id, owner_id, verifier_id, approver_id,
                          assigned_on, start_on, deadline, status, approval_status,
                          photos_required, acceptance, remarks, depends_on)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       on conflict (id) do nothing returning id`,
      [t.id, t.parent || null, t.title, t.category || '',
       PHASES[t.phase] || '', ROUTES[t.route] || '',
       t.priority || 'P2 – Medium', t.site || '',
       deptId[t.dept] || null, owner, verifier, approver,
       t.assigned, t.start, t.deadline,
       t.status || 'Pending', t.appstatus || 'Not required',
       !!t.photos, t.accept || '', t.remarks || '',
       t.depends ? t.depends.split(/[;,]/).map((x) => x.trim()).filter(Boolean) : []]);
    if (r.rowCount) bump('tasks');
  }

  /* ---- who else is involved ------------------------------------------- */
  /* The Responsibility Matrix, as rows instead of twenty-two columns of
     keyword search. Lead comes from the task; support from the supporting
     cell, which lists departments and people together separated by semicolons.
     A name that is not a department is skipped rather than guessed at. */
  const byName = {};
  Object.entries(deptId).forEach(([name, id]) => { byName[name.toLowerCase()] = id; });
  for (const t of data.tasks) {
    const seen = new Set();
    const add = async (id, role) => {
      if (!id || seen.has(id + role)) return;
      seen.add(id + role);
      const r = await c.query(
        `insert into task_roles (task_id, dept_id, role) values ($1,$2,$3)
         on conflict do nothing returning task_id`, [t.id, id, role]);
      if (r.rowCount) bump('task_roles');
    };
    await add(deptId[t.dept], 'L');
    for (const part of String(t.support || '').split(';')) {
      const key = part.trim().toLowerCase();
      if (byName[key]) await add(byName[key], 'S');
    }
  }

  /* ---- budget --------------------------------------------------------- */
  for (const b of data.budget) {
    const r = await c.query(
      `insert into budget_lines (id, task_id, zone, item, unit, source)
       values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing returning id`,
      [b.id, b.task, b.zone || '', b.item, b.unit || '',
       /Project Office/i.test(b.source || '') ? 'project-office' : 'tracker']);
    if (r.rowCount) bump('budget_lines');
  }

  /* ---- decisions ------------------------------------------------------ */
  for (const a of data.approvals) {
    const r = await c.query(
      `insert into approvals (id, task_id, item, originator_id, verifier_id,
                              final_authority, chairman_needed, due_on, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do nothing returning id`,
      [a.id, a.task, a.item, firstOf(a.orig), firstOf(a.verifier),
       a.authority || '', !!a.chairman, a.due,
       /Project Office/i.test(a.source || '') ? 'project-office' : 'tracker']);
    if (r.rowCount) bump('approvals');
  }

  /* ---- gates ---------------------------------------------------------- */
  let order = 0;
  for (const m of data.milestones) {
    const r = await c.query(
      `insert into milestones (id, title, due_on, responsible, release_evidence, sort_order)
       values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing returning id`,
      [m.id, m.title, m.due, m.resp || '', m.ev || '', order++]);
    if (r.rowCount) bump('milestones');
  }

  /* ---- survey --------------------------------------------------------- */
  for (const s of data.survey) {
    const r = await c.query(
      `insert into survey (id, zone, location, observation, proposal, route,
                           dept_id, task_id, student_involvement, safety_class)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (id) do nothing returning id`,
      [s.id, s.zone === '—' ? '' : (s.zone || ''), s.loc, s.obs || '', s.prop || '',
       s.route || '', deptId[s.dept] || null, s.task || null,
       s.inv || 'None', s.safety || '']);
    if (r.rowCount) bump('survey');
  }

  /* ---- students ------------------------------------------------------- */
  for (const t of data.teams) {
    const r = await c.query(
      `insert into student_teams (id, task_ids) values ($1,$2)
       on conflict (id) do nothing returning id`,
      [t.id, t.tasks ? t.tasks.split(/[;,]/).map((x) => x.trim()).filter(Boolean) : []]);
    if (r.rowCount) bump('student_teams');
  }
  for (const d of data.days) {
    const r = await c.query(
      `insert into student_days (id, activity, task_id) values ($1,$2,$3)
       on conflict (id) do nothing returning id`, [d.id, d.act, d.task || null]);
    if (r.rowCount) bump('student_days');
  }

  /* ---- the first line of the trail ------------------------------------ */
  await c.query(
    `insert into activity (user_name, role, subject, subject_id, what, note)
     values ('system','SYSTEM','settings','seed',$1,$2)`,
    ['loaded the baseline from the Chairman\'s Execution Tracker v1.0',
     'Allocation of 3 October 2026. Every task starts Pending and unverified.']);

  await c.query('commit');

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) {
    console.log('Everything was already there — nothing to add.');
  } else {
    console.log('Loaded:');
    Object.entries(counts).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));
    console.log('\nPeople are placeholder accounts with no password and a @cl25.local email.');
    console.log('Give each one a real DIU address and a password as they are named.');
  }
} catch (e) {
  await c.query('rollback').catch(() => {});
  console.error('\nSeeding failed, nothing was written:', e.message);
  process.exit(1);
} finally {
  c.release();
  await pool.end();
}

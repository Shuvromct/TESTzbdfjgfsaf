-- DIU Campus Legacy 25 — Implementation and Monitoring System
--
-- The spreadsheet this replaces keeps every task in one grid and every rule in
-- a formula that reads `Lists!B3`. The rules are the same here; what changes is
-- where they live. Anything a person decides is a column. Anything the system
-- works out — delayed, due soon, an audit gap — is a view, computed at the
-- moment it is read, so there is no stale date to remember to update.
--
-- Task IDs are the Honorable Chairman's own: CL25-01 to CL25-46, with sub-tasks
-- as CL25-22.1 and so on. They are the primary keys, not surrogate uuids,
-- because every memo, every meeting and every budget line already refers to a
-- task by that name. The same goes for B01–B25, D01–D18 and the gates.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ people
-- Carried over from the course file system, with the roles this project needs.
-- A role is a name plus a list of modules; the administrator can write more.
create table if not exists users (
  id            text primary key default gen_random_uuid()::text,
  name          text not null,
  email         text not null unique,
  emp_id        text,
  phone         text,
  designation   text,
  dept_id       text,
  cc_email      text not null default '',   -- copied in on this person's messages
  role          text not null default 'MEMBER'
                check (role in ('ADMIN','DIRECTOR','APPROVER','DEPT_HEAD','MEMBER','VIEWER')),
  pw_hash       text,
  must_change   boolean not null default true,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists users_email_idx on users (lower(email));
create index if not exists users_dept_idx  on users (dept_id) where active;

-- The twenty-two departments, as the Chairman's tracker names them. In the
-- sheet this list was typed out in four separate places and a rename in one of
-- them silently zeroed the counts in the other three.
create table if not exists departments (
  id            text primary key,          -- 'mct', 'facilities-eng', …
  name          text not null unique,      -- exactly as the tracker writes it
  responsibilities text not null default '',
  focal_user_id text references users(id),
  active        boolean not null default true
);
-- users and departments point at each other, so one of the two links has to be
-- added after both tables exist. Guarded, because this file is meant to be safe
-- to run again over a database that already has it.
do $$ begin
  alter table users add constraint users_dept_fk
    foreign key (dept_id) references departments(id) on delete set null;
exception when duplicate_object then null;
end $$;

-- ------------------------------------------------------------------- tasks
-- Forty-six work packages and their sub-tasks, in one table. A sub-task is a
-- row whose parent_id is filled; nothing else distinguishes them, which is why
-- adding one is just an insert and never disturbs anything already there.
create table if not exists tasks (
  id            text primary key,                   -- 'CL25-22', 'CL25-22.1'
  parent_id     text references tasks(id) on delete restrict,
  title         text not null,
  category      text not null default '',
  phase         text not null default ''
                check (phase in ('', 'Phase 1 – IAUP Readiness', 'Event – IAUP Meeting',
                                 'Phase 2 – Silver Jubilee', 'Closeout & Care')),
  route         text not null default ''            -- Recommended Intervention / Student-Led / Mixed
                check (route in ('', 'Recommended Intervention', 'Student-Led Creative Project',
                                 'Mixed', 'Management / Approval')),
  priority      text not null default 'P2 – Medium',
  site          text not null default '',           -- 'Z02', 'Z01–Z10', 'Campus-wide'

  lead_dept_id  text references departments(id),
  owner_id      text references users(id),          -- the Responsible Person
  verifier_id   text references users(id),          -- checks the work. Never the owner.
  approver_id   text references users(id),          -- final authority

  assigned_on   date,
  start_on      date,
  deadline      date,
  completed_on  date,

  -- What the owner types. The sheet called this Status; everything the system
  -- adds to it — delayed, due soon, an evidence gap — is worked out in the view
  -- below and is deliberately not stored.
  status        text not null default 'Pending'
                check (status in ('Pending','In Progress','Under Review','Approved',
                                  'Completed','On Hold')),
  progress      numeric not null default 0 check (progress between 0 and 1),

  approval_status text not null default 'Not required'
                check (approval_status in ('Not required','Pending','Submitted','Approved',
                                           'Approved with conditions','Returned','Rejected')),

  photos_required boolean not null default false,
  evidence_ref  text not null default '',
  evidence_url  text not null default '',
  acceptance    text not null default '',           -- the Chairman's acceptance criteria
  remarks       text not null default '',

  verified_by   text references users(id),          -- who actually signed it off
  verified_on   date,

  -- The supporting cell as the tracker wrote it. task_roles below carries the
  -- departments as rows, which is what the matrix counts, but the cell also
  -- names people and arrangements no column can hold — "IAUP Secretariat via
  -- Julian / Tashru / Lee / Deborah as directed" — and that is worth keeping.
  support_text  text not null default '',
  updated_by    text references users(id),

  -- Named prerequisites. The sheet carried this as free text nobody read; here
  -- it is a real list, so a task can say what it is waiting for.
  depends_on    text[] not null default '{}',

  deleted_at    timestamptz,
  deleted_by    text references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Separation of duties, written into the table rather than into a guideline
  -- nobody can enforce. Nobody verifies their own work, and nobody approves it
  -- either. The spreadsheet asked for this on the Guide tab and had no way to
  -- insist on it.
  constraint verifier_is_not_owner check (verifier_id is null or verifier_id <> owner_id),
  constraint approver_is_not_owner check (approver_id is null or approver_id <> owner_id),
  constraint verified_by_is_not_owner check (verified_by is null or verified_by <> owner_id),
  constraint sub_task_is_not_its_own_parent check (parent_id is null or parent_id <> id)
);
create index if not exists tasks_parent_idx   on tasks (parent_id);
create index if not exists tasks_owner_idx    on tasks (owner_id)    where deleted_at is null;
create index if not exists tasks_dept_idx     on tasks (lead_dept_id) where deleted_at is null;
create index if not exists tasks_deadline_idx on tasks (deadline)    where deleted_at is null;

-- Who else is involved, and how. In the sheet this was the Responsibility
-- Matrix: twenty-two columns of SEARCH() against a keyword, which quietly
-- counted Housekeeping as Facilities Engineering and found "HR" inside the name
-- "Tashru". A row here says the same thing and cannot mean anything else.
create table if not exists task_roles (
  task_id   text not null references tasks(id) on delete cascade,
  dept_id   text not null references departments(id),
  role      text not null check (role in ('L','S','V','A')),  -- Lead, Support, Verify, Approve
  primary key (task_id, dept_id, role)
);
create index if not exists task_roles_dept_idx on task_roles (dept_id, role);

-- ------------------------------------------------------------------ budget
-- B01–B25. Each line belongs to one task, which is how money reaches the task
-- register and the department summary. Nothing is pre-filled: the quantities
-- are measured on site and the rates come from procurement.
create table if not exists budget_lines (
  id            text primary key,                   -- 'B01'
  task_id       text not null references tasks(id),
  zone          text not null default '',
  item          text not null,
  unit          text not null default '',           -- 'm²', 'lot', 'unit', 'student-day'
  qty           numeric,
  rate          numeric,
  other_costs   numeric not null default 0,         -- tax, carriage, anything beside qty × rate
  approved      numeric,                            -- the authorized budget
  committed     numeric,
  paid          numeric not null default 0,
  forecast_rest numeric,                            -- still to spend to finish
  evidence_url  text not null default '',
  note          text not null default '',
  source        text not null default 'tracker',    -- 'tracker' | 'project-office'
  updated_at    timestamptz not null default now()
);
create index if not exists budget_task_idx on budget_lines (task_id);

-- ---------------------------------------------------------------- approvals
-- D01–D18. A decision moves through three stages: the request, the technical
-- verification, and the final word — which for some items has to travel through
-- the Vice-Chancellor to the Chairman.
--
-- This is the same shape as the evidence request in the course file system: one
-- person asks, another decides, and both halves are written down.
create table if not exists approvals (
  id              text primary key,                 -- 'D01'
  task_id         text not null references tasks(id),
  item            text not null,
  originator_id   text references users(id),
  verifier_id     text references users(id),
  verification    text not null default 'Pending'
                  check (verification in ('Pending','Verified','Returned')),
  verified_on     date,
  final_authority text not null default '',         -- a post, not always a user account
  chairman_needed boolean not null default false,
  submitted_on    date,                             -- until this is filled, it is still a draft
  due_on          date,
  decision        text not null default 'Pending'
                  check (decision in ('Pending','Submitted','Approved','Approved with conditions',
                                      'Returned','Rejected')),
  decided_on      date,
  decided_by      text references users(id),
  conditions      text not null default '',
  impact          text not null default '',         -- cost, time or academic consequence
  evidence_url    text not null default '',
  source          text not null default 'tracker',
  updated_at      timestamptz not null default now()
);
create index if not exists approvals_task_idx on approvals (task_id);
create index if not exists approvals_due_idx  on approvals (due_on)
  where decision in ('Pending','Submitted');

-- --------------------------------------------------------------- milestones
-- G0–G13 and the three event dates. These are the dates the whole programme is
-- judged against, so they are not linked to any one task: a gate is reached
-- when the Pro-VC or the Director says it is, with the evidence named.
create table if not exists milestones (
  id           text primary key,                    -- 'G8', 'E3'
  title        text not null,
  due_on       date not null,
  responsible  text not null default '',
  release_evidence text not null default '',        -- what must exist for this gate to pass
  status       text not null default 'Pending'
               check (status in ('Pending','Achieved','Missed')),
  achieved_on  date,
  evidence_url text not null default '',
  sort_order   int not null default 0
);

-- Who approves what, in what order.
--
-- The tracker named one authority per decision and a Yes/No for "goes to the
-- Chairman", which is not a chain at all — in practice an item travels through
-- several hands, and which hands depends on the item. A row here is one hand:
-- the Director sets them up per task, step 1, 2, 3, and step 2 cannot act
-- until step 1 has.
--
-- A step may name a person or only a post ("Authorized university selection
-- panel"), because most of the authorities in this project will never hold an
-- account here. A step with nobody named is recorded by the Director, and the
-- trail says who did it.
create table if not exists approval_steps (
  id          text primary key default gen_random_uuid()::text,
  task_id     text references tasks(id) on delete cascade,
  approval_id text references approvals(id) on delete cascade,
  step_no     int not null,
  approver_id text references users(id),
  post        text not null default '',        -- when it is a post, not a person
  status      text not null default 'Pending'
              check (status in ('Pending','Approved','Returned','Rejected','Skipped')),
  decided_on  date,
  decided_by  text references users(id),
  note        text not null default '',
  created_at  timestamptz not null default now(),
  -- a step belongs to a task or a decision, not both and not neither
  constraint step_has_one_subject check ((task_id is null) <> (approval_id is null))
);
create unique index if not exists approval_steps_task_idx on approval_steps (task_id, step_no)
  where task_id is not null;
create unique index if not exists approval_steps_appr_idx on approval_steps (approval_id, step_no)
  where approval_id is not null;

-- ------------------------------------------------------------------ photos
-- Before, during and after, for fifteen zones.
--
-- The image itself lives in Cloudflare R2; only the row is here. Two sizes are
-- kept: the photograph as it was taken, and a small version for lists.
--
-- A phone writes the place and the moment into the picture's own EXIF data, and
-- for a record someone will audit that is worth more than the picture alone —
-- it is the difference between a photograph of a wall and evidence that this
-- wall was photographed on that morning. Resizing destroys EXIF, so the reader
-- pulls it out first and it is kept here instead.
create table if not exists photos (
  id          text primary key default gen_random_uuid()::text,
  task_id     text not null references tasks(id) on delete cascade,
  kind        text not null check (kind in ('before','progress','after')),
  url         text not null,                        -- long edge 1080
  thumb_url   text not null default '',             -- long edge 400, for lists
  caption     text not null default '',
  zone        text not null default '',
  -- Taken with the camera here and now, or chosen from the device. Both are
  -- allowed; an auditor is entitled to know which, because a photograph picked
  -- off a phone days later proves rather less than one taken on the spot.
  source      text not null default 'camera' check (source in ('camera','upload')),
  taken_at    timestamptz,                          -- from EXIF where the file carries it
  lat         numeric,
  lng         numeric,
  bytes       int,
  width       int,
  height      int,
  uploaded_by text not null references users(id),
  uploaded_at timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  text references users(id)
);
create index if not exists photos_task_idx on photos (task_id, kind) where deleted_at is null;

-- ---------------------------------------------------------------- the trail
-- Every change to anything, written by the server in the same transaction as
-- the change itself.
--
-- The spreadsheet had a Progress and Audit Log, and it was append-only by
-- instruction only: a person had to remember to add the row, by hand, in a
-- second place, after already typing the change into the register. The two
-- drifted apart immediately and there was no way to tell which was right.
-- Nothing is typed into this table. If the change happened, the row exists.
create table if not exists activity (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    text references users(id),
  user_name  text not null default '',              -- kept flat: the trail outlives accounts
  role       text not null default '',
  subject    text not null,                         -- 'task' | 'budget' | 'approval' | …
  subject_id text not null default '',              -- 'CL25-22', 'B04', 'D02'
  what       text not null,                         -- 'set status to In Progress'
  field      text not null default '',
  was        text not null default '',
  now_       text not null default '',
  note       text not null default ''
);
create index if not exists activity_at_idx      on activity (at desc);
create index if not exists activity_subject_idx on activity (subject, subject_id, at desc);

-- ------------------------------------------------------------------ survey
-- The fifteen zones as they were found. Rows stay 'Indicative' until somebody
-- has actually walked the site.
create table if not exists survey (
  id           text primary key,                    -- 'SV01'
  zone         text not null default '',
  location     text not null,
  observation  text not null default '',
  before_url   text not null default '',
  approx_size  text not null default '',
  condition    text not null default 'Not surveyed'
               check (condition in ('Not surveyed','Good','Fair','Poor','Unsafe')),
  hazard       boolean not null default false,
  access_clear text not null default 'Pending' check (access_clear in ('Yes','No','Pending')),
  proposal     text not null default '',
  route        text not null default '',
  dept_id      text references departments(id),
  task_id      text references tasks(id),
  student_involvement text not null default 'None',
  safety_class text not null default '',
  confirmed    boolean not null default false,
  remarks      text not null default ''
);

-- ---------------------------------------------------------------- students
-- Twelve teams of seven or eight, each with a student leader and a named
-- faculty supervisor. Hazardous work stays with qualified contractors; this
-- table is about supervised design, documentation and low-risk making.
create table if not exists student_teams (
  id            text primary key,                   -- 'TEAM-01'
  leader_name   text not null default '',
  leader_sid    text not null default '',
  supervisor_id text references users(id),
  members       int not null default 0,
  task_ids      text[] not null default '{}',
  roster_url    text not null default '',
  course_map    text not null default '',           -- which course and credit this carries
  hours_planned numeric,
  hours_verified numeric,
  evidence_url  text not null default '',
  induction_on  date,                               -- safety induction: before any site work
  viva_on       date,
  remarks       text not null default ''
);

-- Meals, refreshments and transport are budgeted in student-days, and these
-- rows are what budget lines B23 and B24 multiply by their rate.
create table if not exists student_days (
  id        text primary key,                       -- 'L1'
  activity  text not null,
  task_id   text references tasks(id),
  students  int not null default 0,
  days      int not null default 0,
  note      text not null default ''
);

-- --------------------------------------------------------------- the rules
-- What the sheet worked out in columns AK to AU, and what the Dashboard counted.
--
-- A view rather than stored columns, because every one of these answers depends
-- on today's date. In the spreadsheet that date sat in Lists!B3, and a single
-- cell left on a meeting's date quietly made four hundred cells wrong. Here
-- there is nothing to set and nothing to put back.
--
-- Dropped and rebuilt rather than replaced: `create or replace` refuses to
-- reorder or rename a column, and this file has to survive being run again.
drop view if exists task_state;
create view task_state as
with roll as (
  select parent_id, avg(progress) as sub_progress, count(*) as sub_count
    from tasks where parent_id is not null and deleted_at is null
   group by parent_id
),
gaps as (
  select t.id,
         array_remove(array[
           case when t.completed_on is null then 'completion date' end,
           case when t.photos_required and not exists (
                  select 1 from photos p
                   where p.task_id = t.id and p.kind = 'after' and p.deleted_at is null)
                then 'after photo' end,
           -- An evidence reference is no longer demanded. Much of this work
           -- leaves its proof as a photograph or in the verifier's own sign-off,
           -- and a link nobody has is not worth holding a finished task open for.
           case when t.verified_by is null then 'verified by' end,
           case when t.verified_on is null then 'verification date' end,
           case when t.approval_status not in ('Approved','Approved with conditions','Not required')
                then 'approval' end
         ], null) as missing
    from tasks t where t.deleted_at is null
)
select
  t.*,
  (t.parent_id is null) as is_task,
  coalesce(r.sub_count, 0) as sub_count,
  -- a parent reports what its sub-tasks have done; a leaf reports its own
  case when coalesce(r.sub_count,0) > 0 then r.sub_progress else t.progress end as effective_progress,
  (t.deadline - current_date) as days_to_deadline,
  case when t.status = 'Completed'
       then greatest(coalesce(t.completed_on, current_date) - t.deadline, 0)
       else greatest(current_date - t.deadline, 0) end as delay_days,
  -- Only a finished task is audited. Listing what a task still owes while it is
  -- half done would be noise, and the spreadsheet did not do it either.
  case when t.status = 'Completed' then g.missing else '{}'::text[] end as audit_gaps,
  (t.status = 'Completed' and cardinality(g.missing) = 0) as audit_complete,
  -- What an open task is doing wrong right now: the first thing that applies,
  -- in the order the sheet checked them.
  case
    when t.status = 'Completed' then null
    when t.photos_required and t.progress > 0 and not exists (
           select 1 from photos p
            where p.task_id = t.id and p.kind = 'before' and p.deleted_at is null)
         then 'Before photo needed'
    when t.lead_dept_id is not null and t.owner_id is null then 'Assign responsible person'
    when (t.status = 'In Progress' or t.progress > 0) and t.assigned_on is null
         then 'Assigned date missing'
  end as open_warning,
  -- The order the spreadsheet checked things in, kept exactly. Completed only
  -- counts as completed when the evidence is all there; everything else is
  -- measured against today.
  case
    when t.status = 'Completed' and cardinality(g.missing) = 0 then 'Completed'
    when t.status = 'Completed'                                then 'Completed – evidence gap'
    when t.status = 'On Hold'                                  then 'On Hold'
    when t.deadline is not null and t.deadline < current_date  then 'Delayed'
    when t.deadline is not null and t.deadline - current_date <= 3
         and t.status in ('Pending','In Progress')             then 'Due soon'
    else t.status
  end as effective_status,
  -- duration in days, which is how progress is weighted across a phase
  case when t.start_on is not null and t.deadline is not null
       then (t.deadline - t.start_on) + 1 else 0 end as duration_days,
  (select coalesce(sum(b.approved), 0) from budget_lines b where b.task_id = t.id) as budget,
  (select coalesce(sum(b.paid), 0)     from budget_lines b where b.task_id = t.id) as spent
from tasks t
left join roll  r on r.parent_id = t.id
left join gaps  g on g.id = t.id
where t.deleted_at is null;

-- A gate's own standing, on the same principle.
drop view if exists milestone_state;
create view milestone_state as
select m.*,
       (m.due_on - current_date) as days_left,
       case
         when m.status = 'Achieved' and m.evidence_url = '' then 'Achieved – add evidence'
         when m.status = 'Achieved'                         then 'Achieved'
         when m.status = 'Missed'                           then 'Missed'
         when m.due_on < current_date                       then 'Overdue'
         when m.due_on - current_date <= 7                  then 'Within 7 days'
         else 'Upcoming'
       end as flag
  from milestones m;

-- Where a decision has got to, and whether it is late. The stages are the ones
-- the tracker named, in the order it checked them.
drop view if exists approval_state;
create view approval_state as
select a.*,
       case
         when a.decision in ('Approved','Approved with conditions','Rejected') then a.decision
         when a.decision = 'Returned' or a.verification = 'Returned' then 'Returned to originator'
         when a.submitted_on is null         then '1. Request / concept note pending'
         when a.verification <> 'Verified'   then '2. Awaiting verification'
         when a.chairman_needed              then '3. Awaiting Chairman (via VC)'
         else '3. Awaiting final approval'
       end as stage,
       case when a.decided_on is not null then a.decided_on - a.submitted_on
            when a.submitted_on is not null then current_date - a.submitted_on end as days_open,
       (a.decision not in ('Approved','Approved with conditions','Rejected')
        and a.due_on is not null and a.due_on < current_date) as overdue
  from approvals a;

-- ------------------------------------------------------- chairman reference
-- The Execution Tracker v1.0 exactly as the Honorable Chairman issued it.
-- Nothing writes to this table and nothing should: when the register and the
-- original disagree, this is what the original said.
create table if not exists chairman_reference (
  task_id      text primary key,
  workstream   text not null default '',
  deliverable  text not null default '',
  priority     text not null default '',
  owner        text not null default '',
  support      text not null default '',
  start_on     date,
  due_on       date,
  gates        text not null default '',
  acceptance   text not null default '',
  status       text not null default ''
);

-- ---------------------------------------------------------------- sessions
-- Unchanged from the course file system: a person can see everywhere they are
-- signed in, and so can the Director.
create table if not exists sessions (
  id         text primary key default gen_random_uuid()::text,
  user_id    text not null references users(id) on delete cascade,
  device_id  text not null default '',
  os         text not null default '',
  browser    text not null default '',
  mobile     boolean not null default false,
  ip         text not null default '',
  active     boolean not null default true,
  started_at timestamptz not null default now(),
  seen_at    timestamptz not null default now(),
  ended_at   timestamptz
);
create index if not exists sessions_user_idx on sessions (user_id, active);

-- Project-wide switches. The site lock lives here, and it earns its place
-- twice over on this project: from gate G9 on 13 November until the IAUP
-- meeting ends, no disruptive work is permitted on site, and the system can be
-- closed to everyone but the keyholders for exactly that window.
create table if not exists settings (
  key        text primary key,
  value      jsonb not null default '{}',
  updated_by text,
  updated_at timestamptz not null default now()
);

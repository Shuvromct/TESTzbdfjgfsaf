-- DIU Campus Legacy 25 — update 4
-- =========================================================================
-- Paste the whole file into Neon's SQL Editor and run it once. Running it
-- twice changes nothing.
--
-- It adds one column to `tasks` and rebuilds one view. No data is moved,
-- renamed or dropped, and every existing task keeps the behaviour it has
-- today — the new column is false until somebody turns it on.
--
-- Run update-3.sql first if you have not already.
-- =========================================================================


-- ------------------------------------------------- a continuous process --
-- Some work on this project does not finish on a date. Housekeeping on the
-- route, the site watch before the IAUP meeting, the photograph log — they
-- run until the project ends, and the register was calling them Delayed
-- every morning because their deadline had passed.
--
-- A continuous task is marked here. It keeps its start date and may still
-- carry a deadline for planning, but the register stops measuring it
-- against today: it is never Delayed and never Due soon, it reports
-- 'Ongoing', and it adds nothing to the delay count on the Dashboard.
alter table tasks add column if not exists continuous boolean not null default false;

comment on column tasks.continuous is
  'Runs until the project ends rather than finishing on a date. Never Delayed or Due soon.';


-- ------------------------------------------------------ roles are data --
-- The Administration page can create a role — Treasurer's assistant, Site
-- warden, whatever the project needs — and store what it may reach. The
-- users table did not know that: it still carried a check listing the six
-- the project started with, so giving somebody a role you had just made
-- failed with a constraint error and no explanation.
--
-- The list of roles lives in `settings` under 'perms' now, and the server
-- checks a role exists there before it writes one (see knownRoles()). The
-- column keeps its default, so nothing changes for the six.
alter table users drop constraint if exists users_role_check;


-- ------------------------------------------------- the register's view ---
-- Rebuilt rather than replaced: `create or replace view` refuses to add a
-- column in the middle, and `tasks.*` has just grown one. Dropping and
-- recreating is safe — a view holds no data of its own.
--
-- Only three lines differ from update-0: delay_days, effective_status and
-- open_warning now ask whether the task is continuous. Everything else is
-- character for character what it was.
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
           case when t.evidence_ref = '' and t.evidence_url = '' then 'evidence' end,
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
  -- A continuous process is never late: there is no date it was meant to
  -- have finished by.
  case when t.continuous then 0
       when t.status = 'Completed'
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
  -- The order the spreadsheet checked things in, kept exactly, with one
  -- addition at the top: a continuous process reports Ongoing instead of
  -- being measured against a deadline it was never going to meet.
  case
    when t.status = 'Completed' and cardinality(g.missing) = 0 then 'Completed'
    when t.status = 'Completed'                                then 'Completed – evidence gap'
    when t.status = 'On Hold'                                  then 'On Hold'
    when t.continuous                                          then 'Ongoing'
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


-- ----------------------------------------- the Chairman's link, stored ---
-- The read-only dashboard address lives in `settings` under the key
-- 'chairman_link', which already exists and already takes jsonb. Nothing to
-- add here; this comment is the record of where to look.

-- =========================================================================
-- Done. The application does the rest.
-- =========================================================================

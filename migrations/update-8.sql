-- update-8 · an evidence link is no longer required to close a task
--
-- Until now a Completed task stayed amber — "Completed – evidence gap" —
-- until somebody had typed an evidence reference or a link. That was the rule
-- the original spreadsheet kept, and it does not fit the work: most of it
-- proves itself with a photograph and the verifier's own sign-off, and a link
-- to a document nobody has is not a reason to hold a finished task open.
--
-- Nothing else about the audit changes. A completion date, the after
-- photograph where one is asked for, the verifier's name and date, and the
-- approval are all still counted. The Evidence and Remarks boxes stay where
-- they are; they are simply optional now.
--
-- This is update-4's view with one line taken out of the `gaps` list, so the
-- continuous-process rules it added are carried forward untouched. Run it
-- after update-4. (schema.sql still holds the older wording of this view;
-- the migrations run after it, so the newest file wins either way.)
--
-- Safe to run twice. It only replaces the view — no table, column or row is
-- touched, and no data is lost. A task already marked complete turns green on
-- the next page load if the link was the only thing it was missing.

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
           -- The evidence line that stood here is gone: a reference is no
           -- longer demanded. The after photograph below, and the verifier,
           -- are the proof this project actually keeps.
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


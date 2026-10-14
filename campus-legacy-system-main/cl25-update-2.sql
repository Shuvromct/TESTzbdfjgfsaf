-- DIU Campus Legacy 25 — update 2
--
-- Paste into the Neon SQL Editor and Run, as before. Safe to run twice.
--
-- Adds what the first version left out:
--   · the supporting cell's own words, which only survived as departments
--   · who touched a task last
--   · a CC address per person
--   · the approval chain, set per task, step by step
--   · the Chairman's Execution Tracker v1.0, kept beside the register

alter table tasks add column if not exists support_text text not null default '';
alter table tasks add column if not exists updated_by   text references users(id);
alter table users add column if not exists cc_email     text not null default '';

create table if not exists approval_steps (
  id          text primary key default gen_random_uuid()::text,
  task_id     text references tasks(id) on delete cascade,
  approval_id text references approvals(id) on delete cascade,
  step_no     int not null,
  approver_id text references users(id),
  post        text not null default '',
  status      text not null default 'Pending'
              check (status in ('Pending','Approved','Returned','Rejected','Skipped')),
  decided_on  date,
  decided_by  text references users(id),
  note        text not null default '',
  created_at  timestamptz not null default now(),
  constraint step_has_one_subject check ((task_id is null) <> (approval_id is null))
);
create unique index if not exists approval_steps_task_idx on approval_steps (task_id, step_no)
  where task_id is not null;
create unique index if not exists approval_steps_appr_idx on approval_steps (approval_id, step_no)
  where approval_id is not null;

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

-- A view's columns are fixed when it is created, so `t.*` cannot see a column
-- added afterwards. Rebuilt here, otherwise support_text and updated_by exist
-- in the table and are invisible to everything that reads it.
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


-- The supporting cell, as the tracker wrote it.

update tasks set support_text='Registrar; Pro-VC' where id='CL25-01' and support_text='';
update tasks set support_text='Architecture; MCT; Facilities; Security' where id='CL25-02' and support_text='';
update tasks set support_text='Architecture' where id='CL25-02.1' and support_text='';
update tasks set support_text='DSA / Campus Media' where id='CL25-02.2' and support_text='';
update tasks set support_text='Rasel Prodhania' where id='CL25-02.3' and support_text='';
update tasks set support_text='MCT; Facilities Engineering' where id='CL25-02.4' and support_text='';
update tasks set support_text='Registrar/legal reviewer; Accounts; Najim' where id='CL25-03' and support_text='';
update tasks set support_text='School administration; Proctor; Najim; Rasel' where id='CL25-04' and support_text='';
update tasks set support_text='Food service operators; Security; student observers' where id='CL25-05' and support_text='';
update tasks set support_text='Civil Engineering; Architecture; Najim' where id='CL25-06' and support_text='';
update tasks set support_text='Facilities engineer; Security; Registrar; Rasel' where id='CL25-07' and support_text='';
update tasks set support_text='Head MCT; Architecture; Branding; student leaders' where id='CL25-08' and support_text='';
update tasks set support_text='Architecture' where id='CL25-08.1' and support_text='';
update tasks set support_text='MCT' where id='CL25-08.2' and support_text='';
update tasks set support_text='Facilities Engineering' where id='CL25-08.3' and support_text='';
update tasks set support_text='MCT' where id='CL25-08.4' and support_text='';
update tasks set support_text='Facilities engineer; Procurement; student teams' where id='CL25-09' and support_text='';
update tasks set support_text='Procurement; Facilities; Project Director' where id='CL25-10' and support_text='';
update tasks set support_text='Head MCT; IQAC; Registrar; Controller; HRDI' where id='CL25-11' and support_text='';
update tasks set support_text='Mr. Salahuddin; DSA; HRDI; Medical Centre' where id='CL25-12' and support_text='';
update tasks set support_text='Registrar; Deans; independent selection reviewers; MCT' where id='CL25-13' and support_text='';
update tasks set support_text='Deans; selection reviewers' where id='CL25-13.1' and support_text='';
update tasks set support_text='Alumni Office' where id='CL25-13.2' and support_text='';
update tasks set support_text='MCT' where id='CL25-13.3' and support_text='';
update tasks set support_text='Alumni Office' where id='CL25-13.4' and support_text='';
update tasks set support_text='HR; relevant Deans; families; MCT' where id='CL25-14' and support_text='';
update tasks set support_text='IAUP Secretariat via Julian / Tashru / Lee / Deborah as directed; MCT' where id='CL25-15' and support_text='';
update tasks set support_text='Library; Architecture; MCT; DSA; Office of the Future' where id='CL25-16' and support_text='';
update tasks set support_text='Treasurer; Engineering; Project Director' where id='CL25-17' and support_text='';
update tasks set support_text='Qualified contractor; Najim; MCT colour review' where id='CL25-18' and support_text='';
update tasks set support_text='Qualified contractor; QA reviewer' where id='CL25-19' and support_text='';
update tasks set support_text='Hall administration; qualified contractor; Security' where id='CL25-20' and support_text='';
update tasks set support_text='Hall administration; qualified contractor; QA reviewer' where id='CL25-21' and support_text='';
update tasks set support_text='Student teams; Najim; Facilities; site custodian' where id='CL25-22' and support_text='';
update tasks set support_text='Contractor' where id='CL25-22.1' and support_text='';
update tasks set support_text='Facilities' where id='CL25-22.2' and support_text='';
update tasks set support_text='Facilities; site custodian' where id='CL25-22.3' and support_text='';
update tasks set support_text='Facilities Engineering' where id='CL25-22.4' and support_text='';
update tasks set support_text='Facilities Engineering; MCT; Engineering departments' where id='CL25-23' and support_text='';
update tasks set support_text='Facilities engineer; Najim; student teams' where id='CL25-24' and support_text='';
update tasks set support_text='MCT; Facilities; animal-care custodian; DSA' where id='CL25-25' and support_text='';
update tasks set support_text='Najim; Rasel; School administration; IT' where id='CL25-26' and support_text='';
update tasks set support_text='Security; Medical Centre; Architecture; accessibility users' where id='CL25-27' and support_text='';
update tasks set support_text='MCT; Alumni Office; Procurement; Facilities' where id='CL25-28' and support_text='';
update tasks set support_text='Registrar; MCT' where id='CL25-28.1' and support_text='';
update tasks set support_text='Architecture; contractor' where id='CL25-28.2' and support_text='';
update tasks set support_text='Architecture' where id='CL25-28.3' and support_text='';
update tasks set support_text='Registrar; HR; families; MCT; Facilities' where id='CL25-29' and support_text='';
update tasks set support_text='International Affairs; Architecture; IAUP Secretariat' where id='CL25-30' and support_text='';
update tasks set support_text='Registrar; Library; MCT; DSA; Engineering; Security' where id='CL25-31' and support_text='';
update tasks set support_text='MCT; Architecture; International Affairs; Event leads' where id='CL25-32' and support_text='';
update tasks set support_text='Finance; MCT; Registrar; Branding' where id='CL25-33' and support_text='';
update tasks set support_text='Student sponsorship team; MCT faculty; Alumni Office' where id='CL25-34' and support_text='';
update tasks set support_text='International Affairs; CDC; Convocation team; DSA; Security' where id='CL25-35' and support_text='';
update tasks set support_text='Student associates; MCT; Branding; International Affairs' where id='CL25-36' and support_text='';
update tasks set support_text='Independent QA; Engineering; Security; International Affairs; students' where id='CL25-37' and support_text='';
update tasks set support_text='Independent QA' where id='CL25-37.1' and support_text='';
update tasks set support_text='Medical Centre' where id='CL25-37.2' and support_text='';
update tasks set support_text='International Affairs; Alumni Office' where id='CL25-37.3' and support_text='';
update tasks set support_text='International Affairs; DSA guides' where id='CL25-37.4' and support_text='';
update tasks set support_text='Facilities; Security; cleaning; International Affairs' where id='CL25-38' and support_text='';
update tasks set support_text='Project Director; DSA; Facilities; Security; Medical Centre' where id='CL25-39' and support_text='';
update tasks set support_text='Housekeeping' where id='CL25-39.1' and support_text='';
update tasks set support_text='MCT' where id='CL25-39.2' and support_text='';
update tasks set support_text='Medical Centre' where id='CL25-39.3' and support_text='';
update tasks set support_text='Project Director; International Affairs; students; Finance' where id='CL25-40' and support_text='';
update tasks set support_text='MCT; Architecture; Facilities; Archives; DSA' where id='CL25-41' and support_text='';
update tasks set support_text='Faculty supervisors; IQAC; Controller; Dean FSIT' where id='CL25-42' and support_text='';
update tasks set support_text='Pro-VC; Security; Facilities; Anniversary team; students' where id='CL25-43' and support_text='';
update tasks set support_text='DSA; MCT; VC Office; Alumni; International Affairs' where id='CL25-44' and support_text='';
update tasks set support_text='DSA' where id='CL25-44.1' and support_text='';
update tasks set support_text='Registrar / Archives' where id='CL25-44.2' and support_text='';
update tasks set support_text='MCT; Business Development' where id='CL25-44.3' and support_text='';
update tasks set support_text='Treasurer; Procurement; Project Director; independent assurance' where id='CL25-45' and support_text='';
update tasks set support_text='Business Development' where id='CL25-45.1' and support_text='';
update tasks set support_text='Facilities Engineering' where id='CL25-45.2' and support_text='';
update tasks set support_text='Registrar / Archives' where id='CL25-45.3' and support_text='';
update tasks set support_text='Alumni Office; Archives; MCT; Security' where id='CL25-46' and support_text='';

-- The Chairman's Execution Tracker v1.0, read-only from here on.
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-01','Governance','Issue mandate; appoint one Project Director and delegated approvers','P0','Vice-Chancellor','Registrar; Pro-VC','2026-10-03','2026-10-04','','Signed mandate, named director, deputies, approval limits and reporting line issued','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-02','Survey','Survey all named zones; photos, measured areas and student-access constraints','P0','Mr. Najim / Nazim [identity to confirm]','Architecture; MCT; Facilities; Security','2026-10-03','2026-10-05','CL25-01','100% of named zones surveyed with zone IDs, condition photos, quantities and risk classification','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-03','Site control','Verify garment-site advance, lawful handover, boundaries and work authorization','P0','Mr. Rasel [identity to confirm]','Registrar/legal reviewer; Accounts; Najim','2026-10-03','2026-10-05','CL25-01','Payment evidence and written possession/access authorization reconciled; no assumption that advance alone grants access','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-04','Security','Put interim staffed entry controls near school and acquired-site boundary','P0','Security Head','School administration; Proctor; Najim; Rasel','2026-10-03','2026-10-07','CL25-01; CL25-03','Authorized zones controlled; resident/visitor ID process, emergency access and escalation tested','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-05','Cleaning','Clean restaurant, garment surroundings, drains and waste collection points','P0','Facilities / Housekeeping Lead','Food service operators; Security; student observers','2026-10-04','2026-10-10','CL25-02; CL25-03','Dated before/after checks; waste disposed through approved route; continuing cleaning roster assigned','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-06','Engineering','Assess Engineering Complex, AB4, Hall 1 and unplastered field wall','P0','Facilities Engineering Lead','Civil Engineering; Architecture; Najim','2026-10-04','2026-10-06','CL25-02','Signed substrate, dampness, crack and structural-risk assessment; unsafe areas isolated','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-07','Engineering','Decide retain/repair versus future removal of field wall','P0','Project Director [VC to appoint]','Facilities engineer; Security; Registrar; Rasel','2026-10-06','2026-10-08','CL25-06','Options note covers safety, perimeter, utilities, drainage, permissions and cost; written decision recorded','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-08','Design','Approve campus visual theme and zone-specific photograph mock-ups','P1','Mr. Salahuddin [MCT role to confirm]','Head MCT; Architecture; Branding; student leaders','2026-10-04','2026-10-08','CL25-02','Measured mock-ups, day/night views, palette, text and cost tier approved; Chairman reviews flagship concepts','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-09','Design','Build full-scale sample of coating, mural and display materials','P1','MCT Technical Lead [to appoint]','Facilities engineer; Procurement; student teams','2026-10-09','2026-10-10','CL25-06; CL25-08','Surface/coating sample and portrait/nameplate sample accepted before bulk purchase','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-10','Finance','Prepare measured bill of quantities and phase budgets','P0','Treasurer / delegated Finance Lead','Procurement; Facilities; Project Director','2026-10-06','2026-10-09','CL25-02; CL25-06','Approved quantities, current comparable quotes, taxes, contingencies and cash authorization; no assumed sponsor receipt','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-11','Academic','Approve 3-credit course mapping, workload, outcomes and assessment','P0','Dean FSIT','Head MCT; IQAC; Registrar; Controller; HRDI','2026-10-03','2026-10-07','CL25-01','Approved course/elective mapping, eligibility, credit hours, rubric and registration notice; no retroactive automatic credit','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-12','Student teams','Register 7–8-person teams, leaders, supervisors and safety induction','P0','Head MCT','Mr. Salahuddin; DSA; HRDI; Medical Centre','2026-10-08','2026-10-10','CL25-11','Every student has role, supervisor, schedule, induction, assessment pathway and accessible alternative work','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-13','Heritage','Select and verify 100 Proud Alumni profiles and permissions','P1','Alumni Office Lead','Registrar; Deans; independent selection reviewers; MCT','2026-10-05','2026-10-16','CL25-01','100 approved profiles with names, degree/year, evidence of contribution, approved portrait and publication permission','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-14','Heritage','Verify deceased-faculty memorial text and family consultation','P1','Registrar','HR; relevant Deans; families; MCT','2026-10-05','2026-10-12','CL25-01','Names, titles, service dates and death-in-service status verified; final respectful text and images approved','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-15','IAUP gallery','Obtain IAUP historical assets, permissions and approved chronology','P0','International Affairs Lead','IAUP Secretariat via Julian / Tashru / Lee / Deborah as directed; MCT','2026-10-04','2026-10-12','CL25-01','Written IAUP content/logo approval; distinguishes 1964 origins and 1965 first conference; no invented milestones','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-16','Heritage','Inventory and source-check DIU historical gallery material','P1','Registrar / Archive Custodian','Library; Architecture; MCT; DSA; Office of the Future','2026-10-05','2026-10-16','CL25-01','Object register, provenance, digitized backup; any 2000 pre-founding material separated from 2002 university establishment','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-17','Procurement','Release approved purchases and contractor work orders','P0','Procurement Lead','Treasurer; Engineering; Project Director','2026-10-11','2026-10-13','CL25-09; CL25-10','Signed orders, safe work methods, delivery schedule, inspection terms and warranty; staged release only after sample approval','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-18','Buildings','AB4: cleaning, substrate repairs and primer readiness','P0','Facilities Engineering Lead','Qualified contractor; Najim; MCT colour review','2026-10-13','2026-10-23','CL25-06; CL25-17','Specified elevations prepared and defects addressed; safe access scaffold/platform verified','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-19','Buildings','AB4: complete approved exterior repainting','P0','Facilities Engineering Lead','Qualified contractor; QA reviewer','2026-10-24','2026-11-07','CL25-18','Approved exterior scope completed with manufacturer-compatible system, uniform finish and handover photos','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-20','Buildings','Student Hall 1: resident-safe preparation and repairs','P0','Facilities Engineering Lead','Hall administration; qualified contractor; Security','2026-10-13','2026-10-23','CL25-06; CL25-17','Resident notice, protected routes/windows, substrate repairs and access controls accepted','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-21','Buildings','Student Hall 1: complete approved exterior repainting','P0','Facilities Engineering Lead','Hall administration; qualified contractor; QA reviewer','2026-10-24','2026-11-07','CL25-20','Full approved scope repainted; no blocked exits; resident complaints and defects resolved','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-22','Murals','Lake / RSG2 / Amin Mohammad-side boundary: heritage-and-future murals','P1','Mr. Salahuddin [MCT role to confirm]','Student teams; Najim; Facilities; site custodian','2026-10-13','2026-10-29','CL25-03; CL25-08; CL25-09; CL25-17','All allocated measured surfaces accepted; clean edges; source files and student credits recorded','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-23','Murals','Engineering Complex: targeted repairs, repainting and innovation panels','P1','Mr. Najim / Nazim [identity to confirm]','Facilities Engineering; MCT; Engineering departments','2026-10-13','2026-11-01','CL25-06; CL25-08; CL25-17','Approved zones cleaned and repaired; learning displays fact-checked; no paint hiding unresolved defects','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-24','Murals','Field wall: execute approved low-cost treatment','P1','Mr. Salahuddin [MCT role to confirm]','Facilities engineer; Najim; student teams','2026-10-13','2026-10-29','CL25-07; CL25-09; CL25-17','Retained wall treated only after engineering release; reversible solution where future removal is likely','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-25','Landscape','Deer enclosure road: install learning and sustainability display boards','P1','Architecture Lead [to appoint]','MCT; Facilities; animal-care custodian; DSA','2026-10-14','2026-11-02','CL25-08; CL25-17','Approved boards secured; sightlines/access preserved; no disturbance, glare or waste affecting wildlife','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-26','Security','Complete approved gate/checkpoint arrangements and visitor workflow','P0','Security Head','Najim; Rasel; School administration; IT','2026-10-07','2026-10-20','CL25-03; CL25-04; CL25-10','Staffed and tested access plan; approved ID/One Card use, visitor passes, emergency override and restricted records','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-27','Safety','Inspect lighting, emergency routes, accessible paths and gallery entry','P0','Facilities Engineering Lead','Security; Medical Centre; Architecture; accessibility users','2026-10-07','2026-11-05','CL25-02','100% designated visitor routes inspected; critical defects closed; restricted operational security maps kept private','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-28','Heritage','Fabricate and install the 100 Proud Alumni wall','P1','Architecture Lead [to appoint]','MCT; Alumni Office; Procurement; Facilities','2026-10-19','2026-11-05','CL25-09; CL25-13; CL25-17','100 approved modular portraits installed; secure mounting; legible labels; maintainable 10–12-year design-life brief','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-29','Heritage','Fabricate and install the faculty memorial','P1','Architecture Lead [to appoint]','Registrar; HR; families; MCT; Facilities','2026-10-15','2026-11-04','CL25-09; CL25-14; CL25-17','Final names/text signed off, durable materials, quiet respectful location and no commercial logo intrusion','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-30','IAUP gallery','Install the IAUP legacy display','P1','Mr. Salahuddin [MCT role to confirm]','International Affairs; Architecture; IAUP Secretariat','2026-10-15','2026-11-05','CL25-09; CL25-15; CL25-17','Approved chronology, captions and logos installed; printed content and optional digital copy match','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-31','Heritage','Restore and curate central gallery accessible from basement','P0','Architecture Lead [to appoint]','Registrar; Library; MCT; DSA; Engineering; Security','2026-10-18','2026-11-07','CL25-16; CL25-17','Moisture/electrical/fire/egress/access approval; collections protected; guided route rehearsed','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-32','Wayfinding','Install coordinated wayfinding and changeable event identity','P1','Branding Lead','MCT; Architecture; International Affairs; Event leads','2026-10-16','2026-11-05','CL25-08; CL25-35','DIU/IAUP/anniversary/convocation/job-fair panels coherent; dates/logos authorized; no unconfirmed events printed','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-33','Sponsorship','Approve paint-industry sponsorship proposition and recognition rules','P1','Business Development Lead [to appoint]','Finance; MCT; Registrar; Branding','2026-10-04','2026-10-08','CL25-01','Approved sponsor package; materials/specifications, benefits, authority, privacy and reward rules stated','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-34','Sponsorship','Student-led outreach to Berger, Elite and other approved prospects','P1','Business Development Lead [to appoint]','Student sponsorship team; MCT faculty; Alumni Office','2026-10-09','2026-10-20','CL25-33','Contact/offer register and written decisions; accepted cash/in-kind verified separately; DIU fallback never delayed','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-35','Events','Align IAUP, anniversary, convocation and job-fair master calendar','P0','Registrar / Event Coordination Lead','International Affairs; CDC; Convocation team; DSA; Security','2026-10-04','2026-10-07','CL25-01','Approved event interfaces, owners, routes and blackout dates; unknown event dates remain TBC','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-36','Communications','Capture before/after evidence and authentic student-led campus stories','P1','DSA / Campus Media Lead','Student associates; MCT; Branding; International Affairs','2026-10-05','2026-11-12','CL25-02; CL25-12','Every completed zone documented; consent-cleared outputs; separate public media and restricted security evidence','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-37','Readiness','Conduct two-tier inspections and IAUP route rehearsal','P0','Project Director [VC to appoint]','Independent QA; Engineering; Security; International Affairs; students','2026-11-08','2026-11-12','CL25-19; CL25-21; CL25-22; CL25-23; CL25-24; CL25-25; CL25-26; CL25-27; CL25-28; CL25-29; CL25-30; CL25-31; CL25-32','Signed IAUP-ready acceptance; 100% critical-route works accepted; zero open critical safety issues','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-38','Readiness','Hold no-disruptive-work period and close final minor defects','P0','Project Director [VC to appoint]','Facilities; Security; cleaning; International Affairs','2026-11-13','2026-11-18','CL25-37','No painting/scaffolding/noisy work on event routes; daily inspections; only authorized safe minor corrections','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-39','Events','Operate IAUP campus services, student guides and rapid-response support','P0','International Affairs Lead','Project Director; DSA; Facilities; Security; Medical Centre','2026-11-19','2026-11-21','CL25-38','Daily opening/closing checklist, safe guided route, logged issues and supported delegations','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-40','Review','Review IAUP results and approve anniversary improvement list','P1','Pro-Vice-Chancellor','Project Director; International Affairs; students; Finance','2026-11-22','2026-11-26','CL25-39','Evidence-based review with student/guest feedback, defects, costs and approved corrective actions','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-41','Legacy','Complete approved anniversary enhancements without redoing accepted work','P1','Project Director [VC to appoint]','MCT; Architecture; Facilities; Archives; DSA','2026-11-27','2026-12-31','CL25-40','Approved change list implemented; permanent assets maintained; no uncontrolled scope expansion','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-42','Academic','Complete individual portfolios, viva and course assessment','P1','Head MCT','Faculty supervisors; IQAC; Controller; Dean FSIT','2027-01-01','2027-01-15','CL25-12; CL25-41','Every registered student has assessed evidence; moderation complete; grade decisions independent of sponsorship','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-43','Readiness','Accept anniversary-ready campus and rehearse programme interfaces','P0','Project Director [VC to appoint]','Pro-VC; Security; Facilities; Anniversary team; students','2027-01-10','2027-01-15','CL25-41','Readiness certificate, zero open critical defects, maintenance coverage and accessibility checks','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-44','Events','Celebrate 25th anniversary with student-led demonstration and recognition','P0','Anniversary Programme Lead','DSA; MCT; VC Office; Alumni; International Affairs','2027-01-24','2027-01-24','CL25-42; CL25-43','Student demonstrations, approved certificates/awards and heritage interpretation delivered','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-45','Closeout','Reconcile finances, assets, sponsor obligations and source-file handover','P1','Registrar','Treasurer; Procurement; Project Director; independent assurance','2027-01-25','2027-02-07','CL25-44','Final cost statement, asset register, warranties, source files, sponsor receipts and maintenance responsibility signed','Unverified') on conflict (task_id) do nothing;
insert into chairman_reference (task_id,workstream,deliverable,priority,owner,support,start_on,due_on,gates,acceptance,status) values ('CL25-46','Maintenance','Carry out post-handover care and 90-day condition review','P1','Facilities / Asset Custodian','Alumni Office; Archives; MCT; Security','2027-01-25','2027-04-24','CL25-44','Cleaning/inspection logs and first condition report; defects assigned to contractor or custodian; recurring budget identified','Unverified') on conflict (task_id) do nothing;

select 'support_text filled' as what, count(*) from tasks where support_text <> ''
union all select 'chairman_reference', count(*) from chairman_reference
union all select 'approval_steps (empty, set per task)', count(*) from approval_steps;

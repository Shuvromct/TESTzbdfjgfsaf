-- DIU Campus Legacy 25 — update 3
-- =========================================================================
-- Paste the whole file into Neon's SQL Editor and run it once. Running it
-- twice changes nothing.
--
-- It adds one table. Nothing existing is altered, renamed or dropped.
-- =========================================================================

-- -------------------------------------------------------------- the bin --
-- Anything deleted anywhere in the application lands here first, whole, as
-- the row it was. One table rather than a deleted_at column on each of the
-- nine, because a column per table is nine migrations and still leaves the
-- next table out.
--
-- `row` is the complete record as JSON, so restoring is putting it back,
-- and nothing about the original table has to change to support this.
create table if not exists trash (
  id          bigserial primary key,
  kind        text not null,              -- 'task', 'budget', 'approval', …
  record_id   text not null,              -- its own id, for the listing
  label       text not null default '',   -- what to call it in the bin
  row         jsonb not null,             -- the record, entire
  children    jsonb not null default '[]'::jsonb,  -- rows deleted along with it
  links       jsonb not null default '[]'::jsonb,  -- references cleared, to put back
  deleted_by  text references users(id),
  deleted_name text not null default '',  -- copied, so a closed account still reads
  deleted_at  timestamptz not null default now(),
  constraint trash_kind_check check (kind in
    ('task','budget','approval','milestone','survey','team','student_day',
     'photo','department','user','step','task_role'))
);

-- An older copy of this file did not have `links`, nor the Chairman's
-- tracker among the kinds. Both are applied here, so the same file works
-- whether or not it has already been run.
alter table trash add column if not exists links jsonb not null default '[]'::jsonb;

alter table trash drop constraint if exists trash_kind_check;
alter table trash add constraint trash_kind_check check (kind in
  ('task','budget','approval','milestone','survey','team','student_day',
   'photo','department','user','step','task_role','chairman_reference'));

create index if not exists trash_kind_idx on trash (kind, deleted_at desc);
create index if not exists trash_when_idx on trash (deleted_at desc);

-- A record is in the bin once, not three times.
create unique index if not exists trash_one_per_record on trash (kind, record_id);


-- ------------------------------------------------------- decisions, new --
-- Decisions could be acted on but never created or removed from the
-- application. Creating one needs an id that does not clash with D01…D18,
-- and this is the sequence that gives it.
create sequence if not exists decision_seq start with 100;


-- ------------------------------------------------- permissions, stored ---
-- Role permissions live in `settings` under the key 'perms', which already
-- exists and already takes jsonb. Nothing to add here; this comment is the
-- record of where to look.

-- =========================================================================
-- Done. The application does the rest.
-- =========================================================================

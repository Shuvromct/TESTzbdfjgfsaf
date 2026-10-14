-- DIU Campus Legacy 25 — update 7
-- Run this in the Neon SQL Editor, then reload the site.
-- Safe to run more than once.
--
-- Two things: a task can be renumbered, and more than one person can be
-- working on it.

-- ------------------------------------------------- renumbering a task
-- A task ID is not a database key anybody chose for its own sake — it is
-- what the Chairman's tracker calls that piece of work, and the tracker gets
-- renumbered. Until now the ID could not be changed, because nine other
-- tables point at it and the database would refuse.
--
-- So every one of those is told to follow a rename. Postgres then does the
-- whole thing itself, in the same statement, and there is no moment where a
-- budget line points at a task that no longer exists. The sub-tasks come
-- with it through tasks.parent_id, which is on this list.
--
-- Three places hold a task ID without a foreign key — tasks.depends_on,
-- student_teams.task_ids and activity.subject_id, all of which are text
-- rather than references. Those are updated by the code that does the
-- rename, because the database has no way to follow them.
do $$
declare r record;
begin
  for r in
    select tc.constraint_name, tc.table_name, kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
      join information_schema.referential_constraints rc
        on rc.constraint_name = tc.constraint_name
     where tc.constraint_type = 'FOREIGN KEY'
       and ccu.table_name = 'tasks' and ccu.column_name = 'id'
       and rc.update_rule <> 'CASCADE'
  loop
    execute format('alter table %I drop constraint %I', r.table_name, r.constraint_name);
    /* The delete rule each one had is kept: a sub-task still refuses to let
       its parent be deleted out from under it, a photograph still goes with
       its task. Only the update rule changes. */
    if r.table_name = 'photos' or r.table_name = 'approval_steps' then
      execute format('alter table %I add constraint %I foreign key (%I)
                      references tasks(id) on update cascade on delete cascade',
                     r.table_name, r.constraint_name, r.column_name);
    elsif r.table_name = 'notices' then
      execute format('alter table %I add constraint %I foreign key (%I)
                      references tasks(id) on update cascade on delete set null',
                     r.table_name, r.constraint_name, r.column_name);
    else
      execute format('alter table %I add constraint %I foreign key (%I)
                      references tasks(id) on update cascade',
                     r.table_name, r.constraint_name, r.column_name);
    end if;
  end loop;
end $$;

-- --------------------------------------------- more than one pair of hands
-- One person is responsible for a task and that does not change: ask who is
-- accountable and there is one name, which is the whole point of the column.
-- But a task is often done by several people, and until now the others had
-- no way in — the task did not appear in their list and the server would not
-- let them touch it.
--
-- So: a second, separate thing. Not a second owner — a list of the people
-- also working on it. They can move the work along exactly as the
-- responsible person can; they are not the person the project asks when it
-- wants to know where the work has got to.
--
-- The separation of duties is untouched. Whoever verifies or approves still
-- may not be the one who did the work, and that now includes these people —
-- enforced in writableTask, as it is for the owner.
create table if not exists task_helpers (
  task_id text not null references tasks(id) on update cascade on delete cascade,
  user_id text not null references users(id) on delete cascade,
  added_by text references users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
create index if not exists task_helpers_user_idx on task_helpers (user_id);

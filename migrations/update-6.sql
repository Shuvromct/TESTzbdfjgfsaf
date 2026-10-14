-- DIU Campus Legacy 25 — update 6
-- Run this in the Neon SQL Editor, then reload the site.
-- Safe to run more than once.
--
-- Two things: an IP phone number on an account, and a record of every
-- notification the system sends.

-- ------------------------------------------------------------------ phones
-- Most people here have two numbers: a mobile, and an extension on the
-- campus IP network. The second is the one that works when somebody is at
-- their desk and the first is the one that works when they are on site, so
-- the record needs both rather than making people choose.
alter table users add column if not exists ip_phone text not null default '';

-- ------------------------------------------------------------- notices
-- Every email the system sends, kept.
--
-- Three reasons it is a table rather than a line in the trail. The screen
-- needs to know whether a task has been sent for approval before, so that
-- the second attempt can ask why. The project office needs to be able to
-- answer "did he ever actually get told?" — which is a different question
-- from "was it sent", and both are here. And a bounce or a refused login to
-- the mail server is recorded beside the message it belonged to, instead of
-- disappearing into a server log nobody reads.
create table if not exists notices (
  id        text primary key default gen_random_uuid()::text,
  kind      text not null
            check (kind in ('assigned','approval','verified','returned','tasklist')),
  task_id   text references tasks(id) on delete set null,
  -- The account may go; the record of what was sent does not. The address
  -- is kept as text beside it, so a notice still reads after the person it
  -- went to has left — and an account nobody needs any more can still be
  -- removed, which it could not if this held it.
  to_user   text references users(id) on delete set null,
  to_email  text not null,
  subject   text not null default '',
  -- why it was sent again, when somebody is reminding an authority a second
  -- time. Empty on a first send.
  reason    text not null default '',
  sent_by   text references users(id) on delete set null,
  ok        boolean not null default true,
  error     text not null default '',
  at        timestamptz not null default now()
);
create index if not exists notices_task_idx on notices (task_id, kind, at desc);
create index if not exists notices_user_idx on notices (to_user, at desc);

-- Re-runnable: a database that already has the table from an earlier run of
-- this file gets the two constraints replaced rather than left as they were.
-- Without this an account that had ever sent a notification could not be
-- removed, which is not a rule anybody meant to make.
alter table notices drop constraint if exists notices_to_user_fkey;
alter table notices add  constraint notices_to_user_fkey
  foreign key (to_user) references users(id) on delete set null;
alter table notices drop constraint if exists notices_sent_by_fkey;
alter table notices add  constraint notices_sent_by_fkey
  foreign key (sent_by) references users(id) on delete set null;

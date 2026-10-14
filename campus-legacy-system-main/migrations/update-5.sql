-- DIU Campus Legacy 25 — update 5
-- Run this in the Neon SQL Editor, then reload the site.
-- Safe to run more than once.
--
-- One change: a person can hold more than one role.
--
-- `users.role` stayed a single column because, at the start, one post meant
-- one role. It does not: the administrator is also the person who signs off
-- work when nobody else can, and that is a second authority rather than a
-- bigger version of the first. So the roles a person holds now live in an
-- array, and `role` keeps the first of them so that everything already
-- written against it still reads.

alter table users add column if not exists roles text[];

-- Everybody already in the table holds exactly the role they held before.
update users set roles = array[role] where roles is null or cardinality(roles) = 0;

-- The first of the array is what the old column means, from here on.
alter table users alter column roles set default array['MEMBER']::text[];

# Getting the project back

**DIU Campus Legacy 25 — DIU-CL25-2026**

Read this on the day something has gone wrong. It assumes nothing except that
you have a backup file and an internet connection.

There are two situations and they need different things. Work out which one you
are in first — it takes ten seconds and saves an hour.

| What has happened | Go to |
|---|---|
| The site works, but records are wrong or missing | [Situation A](#situation-a--the-site-works) |
| The site is down, or the database is gone | [Situation B](#situation-b--the-database-is-gone) |

---

## Where the backups are

In the Telegram channel the bot posts to. Two kinds of file:

- `CL25-backup-YYYY-MM-DD-HHMM.json.gz` — hourly, when something has changed
- `CL25-backup-YYYY-MM-DD-HHMM.sql.gz` — once a night

The time in the name is Dhaka time. Scroll back to just **before** things went
wrong and take the file from there.

A `.gz` file is a compressed file. Situation A does not need it unzipped.
Situation B does — right-click → Extract, with 7-Zip or WinRAR.

---

## Situation A — the site works

Use this when the site opens and people can sign in, but something in the
record is wrong: rows deleted by mistake, a bad import, a bulk edit that went
further than intended.

1. Sign in as the administrator.
2. **Administration → Backup → ↺ Restore from a JSON backup**
3. Choose the `.json.gz` file. Do not unzip it.
4. A table appears: every table, how many rows there are now, how many are in
   the file, and the difference. **Read it before going on.** This is the
   moment to notice that you have picked a file from the wrong day.
5. Type `DIU-CL25-2026` and press **Replace the project with this file**.

Everything is replaced in one go — it either all happens or none of it does.
Everybody is signed out afterwards, including you; sign in again.

### What this does not bring back

**Photographs.** The records come back and name their files, but the images
themselves live in Cloudflare R2. If a file has been deleted from storage, the
record will point at nothing. The pictures are not in the backup — they are too
large to send every hour.

**Anything done since the backup was taken.** That is the point of the table in
step 4. A file from this morning will undo this afternoon's work.

---

## Situation B — the database is gone

Use this when the database cannot be reached at all: the Neon account is
closed, the plan has lapsed, the data has been destroyed, or the project is
moving to another host.

You need the `.sql.gz` file. The site plays no part in this — that is why the
file exists.

### 1. Get a Postgres database

Any Postgres will do. A new free database at [neon.tech](https://neon.tech) is
the quickest; a server inside the university works the same way. Copy its
connection string — it looks like:

```
postgresql://user:password@host/dbname?sslmode=require
```

### 2. Load the file

Unzip the `.sql.gz`. You now have a `.sql` file — plain text, a few hundred
pages of it.

**In Neon:** open the SQL Editor, paste the whole file, press Run. If the
editor refuses so much text at once, split it: everything up to the line
`-- ============================================== the records` first, then the
rest.

**With a tool** (pgAdmin, DBeaver, psql): open the file and run it whole.

The file creates the tables and loads every row. It is one transaction: if
anything fails, nothing is written and you can try again.

### 3. Point the site at the new database

In Vercel → Settings → Environment Variables, change `DATABASE_URL` to the new
connection string. Then Deployments → the top one → ⋯ → **Redeploy**.

### 4. Sign in

Everyone's password still works — passwords are stored as one-way hashes, so
they survive the move.

If nobody can get in, run this in the SQL Editor to see the administrators:

```sql
select name, email from users where 'ADMIN' = any (coalesce(roles, array[role]));
```

### 5. The photographs

These are in Cloudflare R2 and were never in the database. As long as the R2
bucket and its keys are untouched, the pictures come back by themselves. If R2
is also gone, the records remain and the images do not.

---

## Keeping this working

- **Once a year, download a `.sql.gz` to a laptop or a USB stick.** Telegram
  and the database failing together is unlikely; it is not impossible.
- **Never put a backup file in GitHub**, private repository included. It holds
  every person's name, email and phone number, the budget, and the password
  hashes. This page is safe to keep there — the files are not.
- **The bot token is a key to all of it.** Anyone holding it can read every
  backup the bot has ever sent. If it is ever pasted somewhere it should not
  be, send `/revoke` to @BotFather, then put the new token in Vercel.

---

## If none of this works

The two files are plain text once unzipped. The JSON is every table as a list
of rows; the SQL is the schema and the rows as ordinary statements. Any
developer can read either without this application, which is the whole reason
the backup is kept in these two shapes rather than something clever.

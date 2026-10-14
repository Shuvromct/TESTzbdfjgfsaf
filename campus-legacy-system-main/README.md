# DIU Campus Legacy 25 — Implementation and Monitoring

Project **DIU-CL25-2026**. The monitoring workbook built on the Honorable
Chairman's Execution Tracker v1.0, rebuilt as a web application: forty-six work
packages and their sub-tasks, twenty-five budget lines, eighteen decisions,
seventeen gates and fifteen survey zones, with before-and-after photographs from
the site.

Next.js on Vercel · Postgres on Neon · photographs on Cloudflare R2.

---

## Setting it up

**1. Neon.** Make a project, copy the connection string.

**2. Cloudflare R2.** Make a bucket, then an API token with *Object Read &
Write* on it. Turn on public access for the bucket (Settings → Public
Development URL) or point a custom domain at it — that hostname is
`R2_PUBLIC_BASE`.

The browser uploads straight to R2, so the bucket needs to accept PUT from the
site. In the bucket's **CORS policy**:

```json
[{
  "AllowedOrigins": ["https://your-app.vercel.app", "http://localhost:3000"],
  "AllowedMethods": ["PUT", "GET"],
  "AllowedHeaders": ["content-type"],
  "MaxAgeSeconds": 3000
}]
```

**3. Environment.** Copy `.env.example` to `.env` and fill it in.

```bash
npm install
npm run db:setup     # tables, and the first administrator
npm run db:seed      # the tracker's baseline: 78 tasks, 25 budget lines, 18 decisions
npm run dev
```

Sign in with `ADMIN_EMAIL`. You will be asked to change the password.

**4. Vercel.** Import the repository, paste the same environment variables, and
deploy. `vercel.json` already schedules the digest for 02:00 UTC — eight in the
morning in Dhaka.

---

## How it works

**One request in, one field out.** `GET /api/state` returns the whole project in
a single response: at this size it is a few hundred kilobytes, so the client can
filter, sort and count without going back to the server. Changes go the other
way one field at a time, because four people have business with the same task —
the owner moves it along, the verifier signs it off, the approval authority
decides, finance writes the money — and sending whole records would have them
overwriting one another.

**The rules are views, not columns.** *Delayed*, *Due soon*, *Completed –
evidence gap*, the sub-task roll-up, days open, a gate's flag: all of it is
computed when read, from `current_date`. The workbook kept that date in
`Lists!B3`, and a single cell left on a meeting's date quietly made four hundred
cells wrong. There is nothing here to set and nothing to put back.

**The trail writes itself.** Every change goes through one transaction that
updates the row and writes the log line together. The workbook asked people to
type the change into the register and then remember to add a row to the Progress
and Audit Log, by hand, in a second place; the two drifted apart on the first
day. Here, if the change happened the row exists, and nothing can add a row by
itself.

**Nobody verifies their own work.** The workbook said so on the Guide tab and
had no way to insist. Here it is a check constraint on the table and a rule in
`lib/auth.ts`: the owner cannot be the verifier, the verifier cannot sign off
their own work, and not even the administrator can quietly become both.

**Photographs.** The browser reads the EXIF — where and when — then resizes to
1080 on the long edge, makes a 400px thumbnail, and uploads both straight to R2
with a signed URL. The image never passes through a serverless function. Taking
one with the camera and choosing one off the device are both allowed, and the
record says which: a photograph picked off a phone days later proves rather less
than one taken on the spot.

---

## Where things are

```
app/api/state/route.ts     the whole project, one GET
app/api/state/task/        field-level PATCH, and the trail beside it
app/api/state/photo/       sign an upload, then record it
app/api/state/approval/    submit → verify → decide
app/api/cron/digest/       the morning note to Telegram
lib/auth.ts                sessions, and who may change which field
lib/roles.ts               six built-in roles, plus any the administrator writes
lib/lock.ts                closing the site during the no-work period
lib/db.ts                  pg pool, and the transaction helper
lib/r2.ts                  signed uploads
public/app.js              the client, one file
schema.sql                 fourteen tables, three views
scripts/seed.mjs           the tracker's baseline
```

## Roles

| Role | Does |
|---|---|
| `ADMIN` | everything, plus accounts |
| `DIRECTOR` | the project: reassign, record gates, approve, set budgets, close the site |
| `APPROVER` | records decisions on items where they are the authority |
| `DEPT_HEAD` | their department's tasks, photographs and budget |
| `MEMBER` | their own tasks and photographs |
| `VIEWER` | reads |

A role is a name plus a list of modules, so the administrator can write more —
"the Treasurer's assistant, Budget only" is a row in `settings`, not a code
change.

## The site lock

Gate **G9** on 13 November starts the no-disruptive-work period, and it runs
until the IAUP meeting ends on the 21st. People → *Site closed to the field*
stops everybody but the Director and the administrator writing anything. It is
enforced on the server, so a bookmarked page or a tab left open on a phone
cannot write either.

## After seeding

People come in as the tracker names them — as posts, not persons
("Facilities Engineering Lead"), six of them still `[to appoint]`. They have no
password and a `@cl25.local` address. Give each one a real DIU address and a
password as they are appointed; the `[to appoint]` accounts arrive disabled.

Where the tracker named the same person as both the owner and the verifier of a
task, the seed keeps the ownership and leaves the verifier empty rather than
breaking the rule. Those are the Director's to fill in.

---

Project Office · Created by Md Shafikul Islam Shuvro

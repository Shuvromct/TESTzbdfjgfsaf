import { q } from '@/lib/db';
import { session, clear } from '@/lib/auth';

export async function POST(req: Request) {
  const s = await session();
  const { sessionId } = await req.json().catch(() => ({ sessionId: null }));
  if (sessionId)
    await q(`update sessions set active=false, ended_at=now() where id=$1`, [sessionId]).catch(() => {});
  if (s)
    await q(`insert into activity (user_id,user_name,role,subject,subject_id,what)
             values ($1,$2,$3,'user',$1,'signed out')`, [s.id, s.name, s.role]).catch(() => {});
  await clear();
  return Response.json({ ok: true });
}

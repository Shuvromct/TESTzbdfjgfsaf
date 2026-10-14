/**
 * Set somebody's password from the command line, for when nobody can get in.
 *
 *   npm run db:reset-password -- someone@diu.edu.bd NewPassword123
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run db:reset-password -- <email> <new password>');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: url,
  ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});
try {
  const { rowCount } = await pool.query(
    'update users set pw_hash=$2, must_change=true, active=true where lower(email)=$1',
    [email.trim().toLowerCase(), await bcrypt.hash(password, 10)]);
  if (!rowCount) { console.error(`No account with the email ${email}.`); process.exit(1); }
  await pool.query(
    `update sessions set active=false, ended_at=now()
      where user_id=(select id from users where lower(email)=$1) and active`,
    [email.trim().toLowerCase()]);
  console.log(`Done. ${email} can sign in with the new password and will be asked to change it.`);
} finally { await pool.end(); }

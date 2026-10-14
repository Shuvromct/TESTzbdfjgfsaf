/**
 * Create the tables and the first administrator.
 *
 *   npm run db:setup
 *
 * Safe to run again: the schema is written with `if not exists` throughout, and
 * an administrator who is already there is left alone.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: url,
  ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});

try {
  console.log('Creating tables…');
  await pool.query(readFileSync(join(here, '..', 'schema.sql'), 'utf8'));
  console.log('  schema is in place.');

  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!email || !pw) {
    console.log('\nNo ADMIN_EMAIL / ADMIN_PASSWORD, so no administrator was created.');
  } else {
    const { rows } = await pool.query('select id from users where lower(email)=$1', [email]);
    if (rows.length) {
      console.log(`\n${email} is already an account — left as it is.`);
    } else {
      await pool.query(
        `insert into users (name, email, role, pw_hash, must_change)
         values ($1,$2,'ADMIN',$3,true)`,
        ['Administrator', email, await bcrypt.hash(pw, 10)]);
      console.log(`\nAdministrator created: ${email}`);
      console.log('Sign in and change the password — you will be asked to.');
    }
  }
  console.log('\nNext: npm run db:seed');
} catch (e) {
  console.error('\nSetup failed:', e.message);
  process.exit(1);
} finally {
  await pool.end();
}

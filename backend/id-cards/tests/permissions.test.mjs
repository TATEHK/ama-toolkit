// Database tests for tick-box permissions (supabase/permissions.sql), in an embedded Postgres.
// Run: node tests/permissions.test.mjs   (needs @electric-sql/pglite; set PGLITE to its path if it isn't installed here)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { PGlite } = await import(process.env.PGLITE || '/home/claude/black-belt-prep-system/tests/node_modules/@electric-sql/pglite/dist/index.js');
const read = p => readFileSync(join(here, p), 'utf8');
const db = new PGlite();
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };
const rows = async (sql, p = []) => (await db.query(sql, p)).rows;
const one = async (sql, p = []) => (await rows(sql, p))[0];
async function as(email, fn) {
  await db.exec('set role authenticated');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })]);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false)`); }
}
const tryAs = async (email, sql, p = []) => { try { const r = await as(email, () => db.query(sql, p)); return { ok: true, n: /^\s*select/i.test(sql) ? r.rows.length : (r.affectedRows ?? 0), rows: r.rows }; } catch (e) { return { ok: false, err: e.message }; } };

console.log('Setting up');
await db.exec(read('supabase-stub.sql'));
await db.exec(`insert into auth.users (email) values ('owner@ama.test')`);
await db.exec(read('../supabase/setup.sql'));
await db.exec(read('../supabase/roles.sql'));
await db.exec(read('../supabase/printed.sql'));
// Old single roles before the update
await db.exec(`insert into auth.users (email) values ('appr@ama.test'), ('pho@ama.test'), ('view@ama.test'), ('station@ama.test'), ('none@ama.test');
  update staff_roles set role = 'approver' where email = 'appr@ama.test';
  update staff_roles set role = 'photos'   where email = 'pho@ama.test';
  update staff_roles set role = 'viewer'   where email = 'view@ama.test';
  update staff_roles set role = 'printer'  where email = 'station@ama.test';
  update staff_roles set role = 'pending'  where email = 'none@ama.test';`);
await db.exec(read('../supabase/permissions.sql'));
await db.exec(read('../supabase/permissions.sql'));
ok(true, 'permissions.sql runs twice without errors');

console.log('\nEveryone keeps what they could do');
const perms = async e => (await rows(`select permission from staff_permissions where email = $1 order by 1`, [e])).map(r => r.permission).join(',');
ok(await perms('owner@ama.test') === 'admin', 'Admin -> admin');
ok(await perms('appr@ama.test') === 'approve,delete,edit,send', 'Approver -> edit, delete, send, approve');
ok(await perms('pho@ama.test') === 'edit', 'Photos -> edit');
ok(await perms('view@ama.test') === 'viewer', 'Viewer -> viewer');
ok(await perms('station@ama.test') === 'printer', 'Print station -> printer');
ok(await perms('none@ama.test') === '', 'No access -> nothing');
ok((await as('appr@ama.test', () => one(`select my_permissions() p`))).p.join() === 'approve,delete,edit,send', 'my_permissions() lists your own');
ok((await as('appr@ama.test', () => one(`select my_role() r`))).r === 'approver' && (await as('pho@ama.test', () => one(`select my_role() r`))).r === 'photos', 'older app copies still get the nearest single role');
await db.exec(`delete from staff_permissions where email = 'pho@ama.test'; insert into staff_permissions values ('pho@ama.test', 'edit'), ('pho@ama.test', 'send')`);
await db.exec(read('../supabase/permissions.sql'));
ok(await perms('pho@ama.test') === 'edit,send', 'running it again does not overwrite changed permissions');

console.log('\nPeople');
const pid = (await one(`insert into people (name) values ('Kara Test') returning id`)).id;
ok((await tryAs('view@ama.test', `select * from people`)).n === 1, 'viewer can see people');
ok((await tryAs('station@ama.test', `select * from people`)).n === 0, 'print station cannot see people');
ok((await tryAs('none@ama.test', `select * from people`)).n === 0, 'no ticks = no access');
ok(!(await tryAs('view@ama.test', `insert into people (name) values ('X')`)).ok, 'viewer cannot add people');
ok((await tryAs('pho@ama.test', `insert into people (name) values ('Added By Edit')`)).ok, 'edit can add people');
ok((await tryAs('pho@ama.test', `update people set dan = '1st Dan' where id = $1`, [pid])).n === 1, 'edit can change details');
ok((await tryAs('pho@ama.test', `delete from people where id = $1`, [pid])).n === 0, 'edit alone cannot delete');
await db.exec(`insert into staff_permissions values ('view@ama.test', 'delete')`);
ok((await tryAs('view@ama.test', `delete from people where name = 'Added By Edit'`)).n === 1, 'delete permission can delete (ticks combine)');

console.log('\nPrinting');
const job = st => `insert into print_jobs (pdf_path, status) values ('jobs/x.pdf', '${st}') returning id`;
ok(!(await tryAs('view@ama.test', job('pending'))).ok, 'without send, cannot send to print');
ok((await tryAs('pho@ama.test', job('pending'))).ok, 'send can send a job for approval');
ok(!(await tryAs('pho@ama.test', job('approved'))).ok, 'send without approve cannot skip approval when approval is required');
await db.exec(`update settings set require_approval = false`);
ok((await tryAs('pho@ama.test', job('approved'))).ok, 'when approval is off, send goes straight to the printer');
await db.exec(`update settings set require_approval = true`);
ok((await tryAs('appr@ama.test', job('approved'))).ok, 'someone who can approve can send straight to the printer');
const jid = (await one(`select id from print_jobs where status = 'pending' limit 1`)).id;
ok((await tryAs('pho@ama.test', `update print_jobs set status = 'approved' where id = $1`, [jid])).n === 0, 'send alone cannot approve');
ok((await tryAs('appr@ama.test', `update print_jobs set status = 'approved' where id = $1`, [jid])).n === 1, 'approve can approve');
ok((await tryAs('station@ama.test', `update print_jobs set status = 'printed' where id = $1`, [jid])).n === 1, 'print station can mark jobs printed');
ok((await tryAs('station@ama.test', `update print_station set last_seen = now()`)).n === 1, 'print station reports its status');
ok((await tryAs('appr@ama.test', `update print_station set last_seen = now()`)).n === 0, 'others cannot pretend to be the print station');
ok((await tryAs('appr@ama.test', `delete from print_jobs`)).n === 0 && (await tryAs('owner@ama.test', `delete from print_jobs where status = 'printed'`)).n === 1, 'only admin deletes jobs');

console.log('\nFiles');
const canWrite = async (e, path) => (await as(e, () => one(`select can_write_card_file($1) c`, [path]))).c;
ok(await canWrite('pho@ama.test', 'photos/a.jpg') && !(await canWrite('view@ama.test', 'photos/a.jpg')), 'photos: edit only');
ok(await canWrite('pho@ama.test', 'jobs/a.pdf') && !(await canWrite('appr@ama.test', 'settings/sig.png')), 'print files: send; settings files: admin only');

console.log('\nSettings and permissions');
ok((await tryAs('appr@ama.test', `update settings set cert_text = 'x'`)).n === 0 && (await tryAs('owner@ama.test', `update settings set cert_text = 'x'`)).n === 1, 'only admin changes card settings');
ok((await tryAs('appr@ama.test', `select * from staff_permissions`)).n === 4, 'non-admins see only their own permissions');
ok(!(await tryAs('appr@ama.test', `insert into staff_permissions values ('appr@ama.test', 'admin')`)).ok, 'non-admins cannot give themselves permissions');
ok((await tryAs('owner@ama.test', `insert into staff_permissions values ('none@ama.test', 'viewer')`)).ok, 'admin can tick permissions');
ok(!(await tryAs('owner@ama.test', `delete from staff_permissions where email = 'owner@ama.test' and permission = 'admin'`)).ok, 'the last admin cannot be removed');
ok(!(await tryAs('owner@ama.test', `insert into staff_permissions values ('x@ama.test', 'superuser')`)).ok, 'unknown permissions are refused');

console.log('\nLogins created or removed in Supabase');
await db.exec(`update settings set default_new_role = 'photos'; insert into auth.users (email) values ('New@AMA.test')`);
ok(await perms('new@ama.test') === 'edit', 'new login gets the default chosen in the app');
await db.exec(`update settings set default_new_role = 'pending'; insert into auth.users (email) values ('later@ama.test')`);
ok(await perms('later@ama.test') === '', 'default "No access" gives nothing');
await db.exec(`delete from auth.users where email = 'appr@ama.test'`);
ok(await perms('appr@ama.test') === '', 'removing a login removes its permissions');
await db.exec(`delete from auth.users where email = 'owner@ama.test'`);
ok(await perms('owner@ama.test') === 'admin', 'removing the only admin login keeps the admin permission (nobody is locked out of settings)');

const noRls = await rows(`select relname from pg_class where relname = 'staff_permissions' and not relrowsecurity`);
ok(noRls.length === 0, 'row level security is on');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Tests the "staff" Edge Function against an in-memory stand-in for Supabase.
// Run: node tests/staff-function.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../supabase/functions/staff/index.ts'), 'utf8');
const tmp = join(mkdtempSync(join(tmpdir(), 'staff-')), 'staff.mjs');
writeFileSync(tmp, src);
const { handle } = await import(pathToFileURL(tmp).href);
const { makeDb } = await import('./mock-db.mjs');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

const db = makeDb();
// Starting state: Tate admin in both, Sam admin only in cards, Jo a viewer / instructor
for (const e of ['tate@ama.test', 'sam@ama.test', 'jo@ama.test']) await db.auth.admin.createUser({ email: e, password: 'password1' });
db._t.staff_permissions = [{ email: 'tate@ama.test', permission: 'admin' }, { email: 'sam@ama.test', permission: 'admin' }, { email: 'jo@ama.test', permission: 'viewer' }];
db._t.app_permissions = [{ email: 'tate@ama.test', app: 'bb', perm: 'admin' }, { email: 'tate@ama.test', app: 'cb', perm: 'admin' }, { email: 'tate@ama.test', app: 'awards', perm: 'admin' },
  { email: 'jo@ama.test', app: 'bb', perm: 'view' }, { email: 'jo@ama.test', app: 'bb', perm: 'readiness' }, { email: 'jo@ama.test', app: 'cb', perm: 'view' }, { email: 'jo@ama.test', app: 'cb', perm: 'readiness' }];
db._t.staff_admins = [{ email: 'tate@ama.test', added_by: 'seed' }];   // Tate can manage logins (Staff admin)
const TATE = db._login('tate@ama.test'), SAM = db._login('sam@ama.test'), JO = db._login('jo@ama.test');
const cardOf = e => db._t.staff_permissions.filter(x => x.email === e).map(x => x.permission).sort().join();
const appOf = app => e => db._t.app_permissions.filter(x => x.email === e && x.app === app).map(x => x.perm).sort().join();
const prepOf = appOf('bb'), cbOf = appOf('cb'), awOf = appOf('awards');

const call = async (token, body, method = 'POST') => {
  const res = await handle(new Request('https://x.test/functions/v1/staff', { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), db);
  return { status: res.status, body: method === 'OPTIONS' ? null : await res.json().catch(() => null), headers: res.headers };
};

console.log('\nWho can use it');
let r = await call(null, { action: 'list' });
ok(r.status === 401, 'not signed in is refused');
r = await call(JO, { action: 'list' });
ok(r.status === 403, 'a non-admin is refused');
r = await call(SAM, { action: 'list' });
ok(r.status === 403 && /Staff admin/.test(r.body.error), 'someone who is not a Staff admin is refused');
r = await call(TATE, {}, 'OPTIONS');
ok(r.status === 200 && r.headers.get('access-control-allow-origin') === '*', 'browser pre-check (CORS) is answered');
db._opts.permissionsMissing = true;
r = await call(TATE, { action: 'list' });
ok(r.status === 409 && /permissions\.sql/.test(r.body.error), 'explains that the ID Cards permissions update is needed first');
db._opts.permissionsMissing = false;

console.log('\nList');
r = await call(TATE, { action: 'list' });
const jo = r.body.users.find(u => u.email === 'jo@ama.test');
ok(r.status === 200 && r.body.users.length === 3 && r.body.me === 'tate@ama.test', 'lists every login');
ok(jo.card_perms.join() === 'viewer' && jo.bb_perms.join() === 'view,readiness' && jo.cb_perms.join() === 'view,readiness' && jo.aw_perms.join() === '' && jo.has_login, "shows each login's permissions in both apps");
ok(r.body.card_perms.length === 7, 'returns the 7 ID Cards permissions');
ok(r.body.cb_perms.length === 9 && r.body.bb_perms.length === 12 && r.body.aw_perms.length === 3, 'returns the feature lists for Coloured Belts, Black Belt Gradings and Awards');

console.log('\nAdd a login');
r = await call(TATE, { action: 'create', email: 'New@AMA.test', password: 'short', card_perms: ['edit'], bb_perms: ['attendance'] });
ok(r.status === 400 && /8 characters/.test(r.body.error), 'password needs at least 8 characters');
r = await call(TATE, { action: 'create', email: 'not-an-email', password: 'longenough' });
ok(r.status === 400 && /valid email/.test(r.body.error), 'email must be valid');
r = await call(TATE, { action: 'create', email: 'New@AMA.test', password: 'longenough', card_perms: ['edit', 'send', 'made-up'], bb_perms: ['attendance', 'payments', 'made-up'], cb_perms: ['payments'], aw_perms: ['admin', 'edit'] });
ok(r.status === 200 && !r.body.existed, 'login created');
ok(db._users.some(u => u.email === 'new@ama.test' && u.password === 'longenough'), 'email is saved in lower case with the starting password');
ok(cardOf('new@ama.test') === 'edit,send', 'ID Cards permissions ticked; unknown ones ignored');
ok(prepOf('new@ama.test') === 'attendance,payments,view', 'Black Belt Gradings ticks saved, with View added; unknown ones ignored');
ok(cbOf('new@ama.test') === 'payments,view' && awOf('new@ama.test') === 'admin', 'Coloured Belts ticks saved; Admin is kept on its own (it covers everything)');
r = await call(TATE, { action: 'create', email: 'jo@ama.test', password: '', card_perms: ['edit', 'approve'], bb_perms: ['readiness', 'grading'] });
ok(r.status === 200 && r.body.existed && db._users.find(u => u.email === 'jo@ama.test').password === 'password1' && cardOf('jo@ama.test') === 'approve,edit', 'adding an existing login sets its ticks and keeps the password');

console.log('\nPassword');
r = await call(TATE, { action: 'password', email: 'jo@ama.test', password: 'newpassword' });
ok(r.status === 200 && db._users.find(u => u.email === 'jo@ama.test').password === 'newpassword', 'password reset');
r = await call(TATE, { action: 'password', email: 'nobody@ama.test', password: 'newpassword' });
ok(r.status === 404, 'reset for an unknown email is refused');

console.log('\nPermissions');
r = await call(TATE, { action: 'roles', email: 'jo@ama.test', card_perms: ['viewer', 'send'], bb_perms: ['view'] });
ok(r.status === 200 && cardOf('jo@ama.test') === 'send,viewer' && prepOf('jo@ama.test') === 'view' && cbOf('jo@ama.test') === '', 'ticks changed; apps not sent are left alone');
r = await call(TATE, { action: 'roles', email: 'jo@ama.test', cb_perms: ['texts', 'results'] });
ok(r.status === 200 && cbOf('jo@ama.test') === 'results,texts,view', 'Coloured Belts ticks changed on their own');
r = await call(TATE, { action: 'roles', email: 'jo@ama.test', card_perms: [] });
ok(r.status === 200 && cardOf('jo@ama.test') === '' && prepOf('jo@ama.test') === 'view', 'all ID Cards access can be removed without touching Prep');
r = await call(TATE, { action: 'roles', email: 'tate@ama.test', card_perms: ['viewer'] });
ok(r.status === 400 && /your own admin/.test(r.body.error), "you can't remove your own admin access");

console.log('\nRemove');
r = await call(TATE, { action: 'remove', email: 'tate@ama.test' });
ok(r.status === 400 && /yourself/.test(r.body.error), "you can't remove yourself");
r = await call(TATE, { action: 'remove', email: 'new@ama.test' });
ok(r.status === 200 && !db._users.some(u => u.email === 'new@ama.test') && cardOf('new@ama.test') === '' && prepOf('new@ama.test') === '' && cbOf('new@ama.test') === '' && awOf('new@ama.test') === '', 'login and permissions in every app removed');
db._t.app_permissions.push({ email: 'sam@ama.test', app: 'bb', perm: 'admin' });
db._t.staff_admins.push({ email: 'sam@ama.test', added_by: 'seed' });   // now also a Staff admin, so Sam can manage logins
r = await call(SAM, { action: 'roles', email: 'tate@ama.test', bb_perms: ['view'] });
ok(r.status === 200, 'another admin can change your roles when an admin remains');
r = await call(SAM, { action: 'roles', email: 'sam@ama.test', bb_perms: ['view'] });
ok(r.status === 400, 'the last admin cannot be removed');

console.log('\nDojang TV');
const tvOf = e => db._t.tv_permissions.filter(x => x.email === e).map(x => x.permission).sort().join();
r = await call(SAM, { action: 'list' });
ok(r.body.tv_perms.join() === 'edit,slides,screens,party,remote' && Array.isArray(r.body.users[0].tv_perms), 'lists the TV permissions too');
r = await call(SAM, { action: 'create', email: 'tvonly@ama.test', password: 'longenough', card_perms: [], bb_perms: [], tv_perms: ['remote', 'bogus'] });
ok(r.status === 200 && tvOf('tvonly@ama.test') === 'remote' && cardOf('tvonly@ama.test') === '' && prepOf('tvonly@ama.test') === '', 'a login can have just the TV remote, and nothing in the other apps');
r = await call(SAM, { action: 'roles', email: 'tvonly@ama.test', tv_perms: ['party', 'remote'] });
ok(r.status === 200 && tvOf('tvonly@ama.test') === 'party,remote', 'party mode and the remote can be given together');
r = await call(SAM, { action: 'roles', email: 'tvonly@ama.test', tv_perms: ['edit', 'remote'] });
ok(r.status === 200 && tvOf('tvonly@ama.test') === 'edit', 'TV editor includes party mode and the remote, so it is kept on its own');
r = await call(SAM, { action: 'list' });
ok(r.body.users.find(u => u.email === 'tvonly@ama.test').tv_perms.join() === 'edit', 'and the list shows it');
r = await call(SAM, { action: 'roles', email: 'tvonly@ama.test', card_perms: ['viewer'] });
ok(r.status === 200 && tvOf('tvonly@ama.test') === 'edit' && cardOf('tvonly@ama.test') === 'viewer', "changing other apps leaves the TV ticks alone");
r = await call(SAM, { action: 'remove', email: 'tvonly@ama.test' });
ok(r.status === 200 && tvOf('tvonly@ama.test') === '', 'removing a login removes its TV access too');
db._opts.tvMissing = true;
r = await call(SAM, { action: 'list' });
ok(r.status === 200 && r.body.tv_perms === null, 'before the TV is set up, the TV section is left out');
r = await call(SAM, { action: 'create', email: 'later@ama.test', password: 'longenough', card_perms: ['viewer'], tv_perms: ['edit'] });
ok(r.status === 200 && cardOf('later@ama.test') === 'viewer', '...and logins can still be added');
db._opts.tvMissing = false;

console.log('\nHub mobile links');
r = await call(SAM, { action: 'hub', email: 'later@ama.test', mobile: '0412 345 678' });
ok(r.status === 200 && db._t.hub_logins.some(x => x.email === 'later@ama.test' && x.mobile9 === '412345678'), 'a login can be linked to a hub mobile (stored as its last 9 digits)');
r = await call(SAM, { action: 'list' });
ok(r.body.hub === true && r.body.users.find(u => u.email === 'later@ama.test').hub_mobile === '0412 345 678', 'the list shows the linked hub mobile');
r = await call(SAM, { action: 'hub', email: 'sam@ama.test', mobile: '+61412345678' });
ok(r.status === 400 && /already linked to later@ama\.test/.test(r.body.error), 'one mobile can only be linked to one login');
r = await call(SAM, { action: 'hub', email: 'nobody@ama.test', mobile: '0400000000' });
ok(r.status === 400 && /no login/.test(r.body.error), 'only existing logins can be linked');
r = await call(SAM, { action: 'hub', email: 'later@ama.test', mobile: '123' });
ok(r.status === 400, 'a short mobile is refused');
r = await call(SAM, { action: 'hub', email: 'later@ama.test', mobile: '' });
ok(r.status === 200 && !db._t.hub_logins.some(x => x.email === 'later@ama.test'), 'clearing the mobile removes the link');
await call(SAM, { action: 'hub', email: 'later@ama.test', mobile: '0412345678' });
r = await call(SAM, { action: 'remove', email: 'later@ama.test' });
ok(r.status === 200 && !db._t.hub_logins.some(x => x.email === 'later@ama.test'), 'removing a login removes its hub link');
db._opts.hubMissing = true;
r = await call(SAM, { action: 'list' });
ok(r.status === 200 && r.body.hub === false, 'before hub-login.sql is run, the list still works');
r = await call(SAM, { action: 'hub', email: 'sam@ama.test', mobile: '0400000000' });
ok(r.status === 409 && /hub-login\.sql/.test(r.body.error), '...and linking explains what to run');
db._opts.hubMissing = false;


console.log('\nNames, mobiles and logins without an email');
const userOf = e => db._users.find(u => u.email === e);
r = await call(SAM, { action: 'create', name: '  Alex   Kim ', mobile: '0433 111 222', bb_perms: ['attendance'] });
const alexEmail = 'hub-433111222@staff.amatoolkit.local';
ok(r.status === 200 && r.body.hub_only && userOf(alexEmail) && userOf(alexEmail).user_metadata.full_name === 'Alex Kim', 'a login can be made with just a name and mobile');
ok(db._t.hub_logins.some(x => x.email === alexEmail && x.mobile9 === '433111222') && prepOf(alexEmail) === 'attendance,view', '...linked to their hub mobile, with the permissions given');
r = await call(SAM, { action: 'list' });
const alexRow = r.body.users.find(u => u.email === alexEmail);
ok(alexRow.name === 'Alex Kim' && alexRow.hub_only === true && alexRow.hub_mobile === '0433 111 222', 'the list shows their name, mobile and that they sign in with the hub');
r = await call(SAM, { action: 'create', name: 'Copy Cat', mobile: '+61 433 111 222' });
ok(r.status === 400 && /already belongs to someone else/.test(r.body.error), 'the same mobile cannot make a second login');
r = await call(SAM, { action: 'create', mobile: '0433 999 888' });
ok(r.status === 400 && /name/.test(r.body.error), 'a name is needed');
r = await call(SAM, { action: 'create', name: 'No Contact' });
ok(r.status === 400 && /mobile, or an email/.test(r.body.error), 'without an email, a mobile is needed');
r = await call(SAM, { action: 'password', email: alexEmail, password: 'longenough' });
ok(r.status === 400 && /PIN/.test(r.body.error), 'no password for a hub-only login (their PIN is in the hub)');
r = await call(SAM, { action: 'link', email: alexEmail });
ok(r.status === 400, '...and no set-up link');
r = await call(SAM, { action: 'details', email: alexEmail, name: 'Alex Kimura', mobile: '0433 111 333' });
ok(r.status === 200 && userOf(alexEmail).user_metadata.full_name === 'Alex Kimura' && db._t.hub_logins.find(x => x.email === alexEmail).mobile9 === '433111333', 'name and mobile can be changed');
r = await call(SAM, { action: 'details', email: alexEmail, mobile: '' });
ok(r.status === 400 && db._t.hub_logins.some(x => x.email === alexEmail), 'a hub-only login keeps its mobile (it is how they sign in)');
r = await call(SAM, { action: 'hub', email: alexEmail, mobile: '' });
ok(r.status === 400, '...including through Unlink');
r = await call(SAM, { action: 'create', email: 'emailed@ama.test', password: 'longenough', name: 'Em Ailed', mobile: '0433 222 333' });
ok(r.status === 200 && userOf('emailed@ama.test').user_metadata.full_name === 'Em Ailed' && db._t.hub_logins.some(x => x.email === 'emailed@ama.test' && x.mobile9 === '433222333'), 'a login with an email can have a name and mobile too');
r = await call(SAM, { action: 'details', email: 'emailed@ama.test', mobile: '' });
ok(r.status === 200 && !db._t.hub_logins.some(x => x.email === 'emailed@ama.test'), 'a login with an email can have its mobile cleared');

console.log('\nAdd several');
r = await call(SAM, { action: 'bulk', people: [{ name: 'Pat One', mobile: '0444 000 001' }, { name: 'Pat Two', mobile: '0444000002' }, { name: 'Alex Again', mobile: '0433111333' },
  { name: 'Pat Dup', mobile: '0444000001' }, { name: '', mobile: '0444000003' }, { name: 'No Number', mobile: '' }] });
ok(r.status === 200 && r.body.added.join() === 'Pat One,Pat Two', 'several people are added at once');
ok(r.body.skipped.length === 4 && r.body.skipped.some(x => x.name === 'Alex Again' && /already/.test(x.why)) && r.body.skipped.some(x => x.name === 'Pat Dup' && /twice/.test(x.why)), 'people who already have a login, repeats and incomplete rows are skipped, with the reason');
const pat = 'hub-444000001@staff.amatoolkit.local';
ok(userOf(pat) && cardOf(pat) === '' && prepOf(pat) === '' && db._t.hub_logins.some(x => x.email === pat), 'they get no permissions, and sign in with their hub mobile');
r = await call(JO, { action: 'bulk', people: [{ name: 'Sneaky', mobile: '0444000009' }] });
ok(r.status === 403, 'only admins can add several');

console.log('\nThe owner (superadmin)');
await db.auth.admin.createUser({ email: 'boss@ama.test', password: 'password1' });
db._t.staff_permissions.push({ email: 'boss@ama.test', permission: 'admin' });
db._t.app_permissions.push({ email: 'boss@ama.test', app: 'bb', perm: 'admin' });
db._t.staff_admins.push({ email: 'boss@ama.test', added_by: 'seed' });   // Boss is a Staff admin too
const BOSS = db._login('boss@ama.test');
db._t.toolkit_owners = [{ email: 'tate@ama.test' }];
if (!db._t.staff_permissions.some(x => x.email === 'tate@ama.test' && x.permission === 'admin')) db._t.staff_permissions.push({ email: 'tate@ama.test', permission: 'admin' });
if (!db._t.app_permissions.some(x => x.email === 'tate@ama.test' && x.app === 'bb' && x.perm === 'admin')) db._t.app_permissions.push({ email: 'tate@ama.test', app: 'bb', perm: 'admin' });
const tateCard = cardOf('tate@ama.test'), tatePrep = prepOf('tate@ama.test');
r = await call(BOSS, { action: 'list' });
ok(r.body.users.find(u => u.email === 'tate@ama.test').owner === true && !r.body.users.find(u => u.email === 'boss@ama.test').owner, 'the list marks the owner');
for (const [body, what] of [[{ action: 'roles', email: 'tate@ama.test', card_perms: ['viewer'], bb_perms: ['view'] }, 'change their permissions'],
  [{ action: 'remove', email: 'tate@ama.test' }, 'remove their login'], [{ action: 'password', email: 'tate@ama.test', password: 'hijacked123' }, 'set their password'],
  [{ action: 'link', email: 'tate@ama.test' }, 'make a set-up link for them'], [{ action: 'details', email: 'tate@ama.test', name: 'Not Tate' }, 'rename them'],
  [{ action: 'hub', email: 'tate@ama.test', mobile: '0400999888' }, 'link a hub mobile to their login'],
  [{ action: 'create', email: 'tate@ama.test', password: 'hijacked123', card_perms: [], bb_perms: [] }, 'overwrite them with Add login']]) {
  r = await call(BOSS, body);
  ok(r.status === 403 && /owner/.test(r.body.error), 'another admin can\'t ' + what);
}
ok(cardOf('tate@ama.test') === tateCard && prepOf('tate@ama.test') === tatePrep && userOf('tate@ama.test'), "the owner's access and login are untouched");
r = await call(TATE, { action: 'details', email: 'tate@ama.test', name: 'Tate H' });
ok(r.status === 200, 'the owner can still change their own login');
r = await call(TATE, { action: 'roles', email: 'boss@ama.test', card_perms: ['admin', 'edit'], bb_perms: ['admin'] });
ok(r.status === 200, 'the owner can still manage everyone else');
db._t.toolkit_owners = [];

console.log('\nStaff admin permission');
r = await call(TATE, { action: 'list' });
ok(r.body.me_staff_admin === true && r.body.users.find(u => u.email === 'boss@ama.test').staff_admin === true && !r.body.users.find(u => u.email === 'jo@ama.test').staff_admin, 'the list marks who is a Staff admin');
r = await call(JO, { action: 'list' });
ok(r.status === 403, 'someone without Staff admin can\'t manage logins');
r = await call(TATE, { action: 'staff_admin', email: 'nobody@ama.test', on: true });
ok(r.status === 400 && /no login/.test(r.body.error), 'can\'t make someone a Staff admin before they have a login');
r = await call(TATE, { action: 'staff_admin', email: 'jo@ama.test', on: true });
ok(r.status === 200 && db._t.staff_admins.some(x => x.email === 'jo@ama.test'), 'grant Staff admin');
r = await call(JO, { action: 'list' });
ok(r.status === 200, 'the new Staff admin can now manage logins');
r = await call(TATE, { action: 'staff_admin', email: 'tate@ama.test', on: false });
ok(r.status === 400 && /your own/.test(r.body.error), 'you can\'t remove your own Staff admin access');
db._t.toolkit_owners = [{ email: 'boss@ama.test' }];
r = await call(TATE, { action: 'staff_admin', email: 'boss@ama.test', on: false });
ok(r.status === 403 && /owner/.test(r.body.error), 'the owner can\'t be removed as a Staff admin (owner-protected)');
db._t.toolkit_owners = [];
r = await call(TATE, { action: 'staff_admin', email: 'jo@ama.test', on: false });
ok(r.status === 200 && !db._t.staff_admins.some(x => x.email === 'jo@ama.test'), 'remove Staff admin');
r = await call(JO, { action: 'list' });
ok(r.status === 403, 'a removed Staff admin can no longer manage logins');

console.log('\nAudit log');
await call(TATE, { action: 'roles', email: 'jo@ama.test', card_perms: ['viewer'], bb_perms: ['readiness'] });
r = await call(TATE, { action: 'list' });
ok(Array.isArray(r.body.audit) && r.body.audit.length > 0, 'the log records changes');
ok(r.body.audit.some(e => e.action === 'roles' && e.target_email === 'jo@ama.test' && e.actor_email === 'tate@ama.test'), 'each entry has who did what to whom');

console.log('\nForce sign-out');
r = await call(TATE, { action: 'signout', email: 'jo@ama.test' });
ok(r.status === 200 && r.body.sessions === 1, 'force sign-out revokes the login\'s sessions');
r = await call(TATE, { action: 'signout', email: 'no-such@ama.test' });
ok(r.status === 404, 'force sign-out needs an existing login');
r = await call(JO, { action: 'signout', email: 'tate@ama.test' });
ok(r.status === 403, 'only a Staff admin can force sign-out');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

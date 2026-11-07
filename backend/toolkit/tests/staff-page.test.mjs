// Runs the Staff logins page in a headless browser at phone size, with the real staff function
// answering behind it (against the in-memory Supabase). Run: node tests/staff-page.test.mjs
// Needs Playwright and the supabase-js UMD file (set PLAYWRIGHT and SUPABASE_UMD if they live elsewhere).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeDb } from './mock-db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const UMD = readFileSync(process.env.SUPABASE_UMD || '/home/claude/black-belt-prep-system/tests/node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'utf8');
const tmp = join(mkdtempSync(join(tmpdir(), 'staff-')), 'staff.mjs');
writeFileSync(tmp, readFileSync(join(here, '../supabase/functions/staff/index.ts'), 'utf8'));
const { handle } = await import(pathToFileURL(tmp).href);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

const db = makeDb();
for (const e of ['tate@ama.test', 'jo@ama.test']) await db.auth.admin.createUser({ email: e, password: 'password1' });
db._t.staff_permissions = [{ email: 'tate@ama.test', permission: 'admin' }, { email: 'jo@ama.test', permission: 'viewer' }];
db._t.prep_roles = [{ email: 'tate@ama.test', role: 'admin' }, { email: 'jo@ama.test', role: 'instructor' }];
db._t.staff_admins = [{ email: 'tate@ama.test', added_by: 'seed' }];   // Tate can manage logins
let fnDeployed = true, oldFunction = false;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const errors = [];
await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: UMD }));
await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
await ctx.route('https://ptdrcxngaptcgswfbjhg.supabase.co/auth/v1/**', async r => {
  const url = r.request().url();
  if (url.includes('/token')) {
    const { email, password } = JSON.parse(r.request().postData() || '{}');
    const u = db._users.find(x => x.email === email && x.password === password);
    if (!u) return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }) });
    const tok = db._login(email);
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ access_token: tok, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: u.id, email, aud: 'authenticated', role: 'authenticated' } }) });
  }
  if (url.includes('/logout')) return r.fulfill({ status: 204, body: '' });
  return r.fulfill({ contentType: 'application/json', body: '{}' });
});
await ctx.route('https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/staff', async r => {
  if (oldFunction) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ me: 'tate@ama.test', users: [{ email: 'tate@ama.test', has_login: true, card_role: 'admin', prep_roles: ['admin'] }], card_roles: ['admin'], prep_roles: ['admin'] }) });
  if (!fnDeployed) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"NOT_FOUND","message":"Requested function was not found"}' });
  const q = r.request();
  const res = await handle(new Request(q.url(), { method: q.method(), headers: q.headers(), body: q.method() === 'POST' ? q.postData() : undefined }), db);
  return r.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
});
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
const toastText = async () => { await page.waitForSelector('#toast:not([hidden])'); return page.textContent('#toast'); };
const toastSays = async t => { await page.waitForFunction(x => { const el = document.querySelector('#toast'); return !el.hidden && el.textContent.includes(x); }, t, { timeout: 5000 }).catch(() => {}); return page.textContent('#toast'); };
const settle = () => page.waitForTimeout(250);

try {
  await page.goto(pathToFileURL(join(here, '../../../site/staff/index.html')).href);
  await page.waitForSelector('#signIn:not([hidden])');
  ok(true, 'sign-in shows when not signed in');
  ok(await page.isVisible('#homeBtn') && (await page.getAttribute('#homeBtn', 'href')) === '/', 'home button goes back to the AMA Toolkit');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'wrong'); await page.click('#siGo');
  ok((await toastText()).includes('Wrong email or password'), 'wrong password is explained');
  await page.fill('#siPass', 'password1'); await page.click('#siGo');
  await page.waitForSelector('#app:not([hidden]) #list [data-email]');
  const list = await page.textContent('#list');
  ok(list.includes('jo@ama.test') && list.includes('ID Cards: View only') && list.includes('Prep: Instructor'), 'list shows each login with roles in both apps');
  ok(list.includes('You') && (await page.textContent('#list [data-email="tate@ama.test"]')).includes('Admin'), 'you are marked, and admins get the gold Admin chip');

  // Staff admin: the activity log opens, and a login can be granted/removed Staff admin
  await page.click('#logBtn'); await page.waitForSelector('#dlg h3');
  ok((await page.textContent('#dlg')).includes('Activity log'), 'the Activity log opens');
  await page.evaluate(() => document.querySelector('#dlg').close());
  const toastHas = t => page.waitForFunction(x => { const el = document.querySelector('#toast'); return el && !el.hidden && el.textContent.includes(x); }, t, { timeout: 8000 });
  await page.click('#list [data-email="jo@ama.test"]'); await page.waitForSelector('#saToggle');
  ok(!(await page.isChecked('#saToggle')), 'a non-admin is not a Staff admin by default');
  await page.click('#saToggle'); await toastHas('Made a Staff admin');
  ok(db._t.staff_admins.some(x => x.email === 'jo@ama.test'), 'toggling Staff admin on grants it');
  ok((await page.textContent('#list [data-email="jo@ama.test"]')).includes('Staff admin'), 'the list marks the new Staff admin');
  await page.waitForSelector('#saToggle:checked');
  await page.click('#saToggle'); await toastHas('Removed Staff admin');
  ok(!db._t.staff_admins.some(x => x.email === 'jo@ama.test'), 'toggling it off removes it');
  await page.waitForSelector('#saToggle:not(:checked)');   // dialog has reopened after reload
  await page.evaluate(() => { const d = document.querySelector('#dlg'); if (d && d.open) d.close(); });

  // Add a login
  await page.click('#addBtn'); await page.fill('#addName', 'Coach Carter'); await page.fill('#addEmail', 'Coach@AMA.test');
  ok(await page.isChecked('input[name=addHow][value=email]') && await page.isHidden('#addPwRow'), 'a new login gets a welcome email by default (no password to type)');
  await page.check('#addHowPw'); await page.fill('#addPw', 'short'); await page.click('#addGo');
  ok((await toastText()).includes('8 characters'), 'short starting password is refused');
  await page.click('#addGen');
  const pw = await page.inputValue('#addPw');
  ok(pw.length === 12, '"Make one" fills in a 12-character password');
  await page.check('#cardChecks input[value="edit"]'); await page.check('#cardChecks input[value="send"]');
  await page.check('#prepChecks input[value="attendance"]'); await page.check('#prepChecks input[value="payments"]');
  await page.click('#addGo');
  await page.waitForSelector('#list [data-email="coach@ama.test"]');
  ok(db._users.some(u => u.email === 'coach@ama.test' && u.password === pw), 'login created with the starting password');
  ok((await page.textContent('#list [data-email="coach@ama.test"]')).includes('ID Cards: Edit people, Send to print') && (await page.textContent('#list [data-email="coach@ama.test"]')).includes('Attendance, Payments'), 'new login shows its roles');
  ok((await page.textContent('#list [data-email="coach@ama.test"]')).includes('Never signed in'), 'new login shows it has never signed in');
  ok((await page.textContent('#list [data-email="coach@ama.test"] strong')) === 'Coach Carter' && (await page.textContent('#list [data-email="coach@ama.test"]')).includes('coach@ama.test'), 'the list shows their name, with their email underneath');
  await page.screenshot({ path: process.env.SHOT_DIR ? join(process.env.SHOT_DIR, 'staff-list.png') : join(tmpdir(), 'staff-list.png') });

  // Set-up link instead of a password
  await page.click('#addBtn'); await page.fill('#addName', 'New Bee'); await page.fill('#addEmail', 'newbie@ama.test');
  ok((await page.textContent('#addForm')).includes('Give me a link'), 'adding a login offers a set-up link to send them');
  await page.check('#prepChecks input[value="instructor"]'); await page.check('#tvChecks input[value="party"]');
  await page.click('#addGo'); await page.waitForSelector('#linkText');
  const msg = await page.inputValue('#linkText');
  const made = db._mail.find(m => m.kind === 'invite' && m.email === 'newbie@ama.test');
  ok(made && msg.includes('https://app.train-ama.com/welcome/#token_hash=' + encodeURIComponent(made.hashed_token) + '&type=invite') && msg.includes('newbie@ama.test'), 'it shows a message with their set-up link, ready to copy or share');
  ok(made.data.apps === 'Black Belt Gradings and the dojang TV' && made.data.setup_pending === true && db._t.prep_roles.some(r => r.email === 'newbie@ama.test' && r.role === 'instructor'), 'their login and permissions are made, waiting for set-up');
  await page.click('#dlg [data-close]');
  await page.waitForSelector('#list [data-email="newbie@ama.test"]');
  ok((await page.textContent('#list [data-email="newbie@ama.test"]')).includes('Not set up yet'), 'the list shows they are not set up yet');
  await page.click('#list [data-email="newbie@ama.test"]'); await page.waitForSelector('#mailPw');
  ok((await page.textContent('#dlg .dlg-head')).includes('not set up yet'), 'and so does their login');
  await page.click('#mailPw'); await page.waitForSelector('#linkText');
  ok((await page.inputValue('#linkText')).includes('&type=recovery'), 'a new set-up link can be made from their login');
  await page.click('#dlg [data-close]');
  // They use the link: the welcome page marks them set up
  const nb = db._users.find(u => u.email === 'newbie@ama.test'); nb.user_metadata = { ...nb.user_metadata, setup_pending: false, setup_at: new Date().toISOString() };
  await page.click('#search'); await page.evaluate(() => load()); await page.waitForTimeout(400);
  ok((await page.textContent('#list [data-email="newbie@ama.test"]')).includes('Set up') && !(await page.textContent('#list [data-email="newbie@ama.test"]')).includes('Not set up'), 'once they have chosen a password, it shows Set up');

  // Change roles
  await page.click('#list [data-email="jo@ama.test"]'); await page.waitForSelector('#rolesForm');
  ok((await page.$$('#cardChecks input')).length === 7 && (await page.$$('#prepChecks input')).length === 8, 'both apps show tick boxes, laid out the same way');
  await page.uncheck('#cardChecks input[value="viewer"]'); await page.check('#cardChecks input[value="approve"]'); await page.check('#cardChecks input[value="edit"]');
  await page.check('#prepChecks input[value="grading"]'); await page.uncheck('#prepChecks input[value="instructor"]');
  await page.screenshot({ path: process.env.SHOT_DIR ? join(process.env.SHOT_DIR, 'staff-person.png') : join(tmpdir(), 'staff-person.png') });
  await page.click('#saveRoles'); await settle();
  await page.waitForFunction(() => document.querySelector('#list [data-email="jo@ama.test"]').textContent.includes('Approve prints'));
  ok(db._t.staff_permissions.filter(x => x.email === 'jo@ama.test').map(x => x.permission).sort().join() === 'approve,edit' && db._t.prep_roles.filter(x => x.email === 'jo@ama.test').map(x => x.role).join() === 'grading', 'roles saved in both apps');

  // Dojang TV
  ok((await page.textContent('#list [data-email="tate@ama.test"]')).includes('TV: Admin'), 'the list shows TV access (admins always have it)');
  await page.click('#addBtn'); await page.fill('#addName', 'Tv Only'); await page.fill('#addEmail', 'tvonly@ama.test'); await page.check('#addHowPw'); await page.click('#addGen');
  ok((await page.$$('#tvChecks input[type=checkbox]')).length === 5 && (await page.$$('#tvChecks input:checked')).length === 0, 'adding a login has Dojang TV tick boxes (Editor, Slides, Screens, Party mode, Remote), none ticked to start with');
  await page.check('#tvChecks input[value="remote"]'); await page.click('#addGo');
  await page.waitForSelector('#list [data-email="tvonly@ama.test"]');
  const tvRow = await page.textContent('#list [data-email="tvonly@ama.test"]');
  ok(tvRow.includes('TV: Remote') && tvRow.includes('ID Cards: No access') && tvRow.includes('Prep: No access'), 'a login can have just the TV remote and nothing else');
  await page.click('#list [data-email="tvonly@ama.test"]'); await page.waitForSelector('#tvChecks');
  ok(await page.isChecked('#tvChecks input[value="remote"]') && !(await page.isChecked('#tvChecks input[value="party"]')), 'their TV ticks show when opened');
  await page.check('#tvChecks input[value="party"]'); await page.click('#saveRoles');
  await page.waitForFunction(() => document.querySelector('#list [data-email="tvonly@ama.test"]').textContent.includes('TV: Party mode, Remote'));
  ok(db._t.tv_permissions.filter(x => x.email === 'tvonly@ama.test').map(x => x.permission).sort().join() === 'party,remote', 'party mode can be ticked on its own');
  await page.click('#list [data-email="tvonly@ama.test"]'); await page.waitForSelector('#tvChecks');
  await page.check('#tvChecks input[value="screens"]');
  ok(await page.isChecked('#tvChecks input[value="remote"]') && await page.isDisabled('#tvChecks input[value="remote"]'), 'ticking Screens ticks and locks the remote (Screens includes it)');
  await page.uncheck('#tvChecks input[value="screens"]');
  await page.check('#tvChecks input[value="edit"]');
  ok(await page.isChecked('#tvChecks input[value="party"]') && await page.isChecked('#tvChecks input[value="slides"]') && await page.isDisabled('#tvChecks input[value="remote"]'), 'ticking Editor ticks slides, party mode and the remote too');
  await page.screenshot({ path: process.env.SHOT_DIR ? join(process.env.SHOT_DIR, 'staff-tv.png') : join(tmpdir(), 'staff-tv.png') });
  await page.click('#saveRoles');
  await page.waitForFunction(() => document.querySelector('#list [data-email="tvonly@ama.test"]').textContent.includes('TV: Editor'));
  ok(db._t.tv_permissions.filter(x => x.email === 'tvonly@ama.test').map(x => x.permission).join() === 'edit', 'changed to the TV editor');
  db._opts.tvMissing = true;
  await page.reload(); await page.waitForSelector('#list [data-email]');
  await page.click('#list [data-email="tvonly@ama.test"]'); await page.waitForSelector('#rolesForm');
  ok((await page.textContent('#rolesForm')).includes('first run supabase/tv-setup.sql') && !(await page.$('#tvChecks')), 'before the TV is set up, it says what to run');
  await page.evaluate(() => document.querySelector('#dlg').close());
  db._opts.tvMissing = false;
  await page.reload(); await page.waitForSelector('#list [data-email]');

  // Password
  await page.click('#list [data-email="jo@ama.test"]'); await page.waitForSelector('#pwForm');
  await page.fill('#newPw', 'brandnewpass'); await page.click('#savePw');
  ok((await toastSays('Password set')).includes('Password set') && db._users.find(u => u.email === 'jo@ama.test').password === 'brandnewpass', 'new password set');

  // Details: name and mobile (the page also has the shared hub sign-in box, so these must not mix up)
  ok(await page.$('.hub-signin #hubForm'), 'the hub mobile and PIN sign-in option is on the page');
  await page.fill('#stName', 'Jo Bloggs'); await page.fill('#stMobile', '0412 345 678'); await page.click('#saveDetails');
  ok((await toastSays('Details saved')).includes('Details saved') && db._t.hub_logins.some(x => x.email === 'jo@ama.test' && x.mobile9 === '412345678') && db._users.find(u => u.email === 'jo@ama.test').user_metadata.full_name === 'Jo Bloggs', 'name and mobile are saved (no page reload)');
  await page.waitForSelector('#stName'); await page.fill('#stMobile', ''); await page.click('#saveDetails');
  for (let i = 0; i < 50 && db._t.hub_logins.some(x => x.email === 'jo@ama.test'); i++) await new Promise(r => setTimeout(r, 100));
  ok(!db._t.hub_logins.some(x => x.email === 'jo@ama.test'), 'clearing the mobile removes their hub sign-in');
  await page.waitForSelector('#stName');
  await page.evaluate(() => document.querySelector('#dlg').close());

  // A login with no email: name and mobile only
  await page.click('#addBtn'); await page.fill('#addName', 'Hub Person'); await page.fill('#addMobile', '0455 666 777');
  ok(await page.isHidden('#addEmailBits'), 'without an email, the password and set-up link choices are hidden');
  await page.check('#prepChecks input[value="viewer"]'); await page.click('#addGo');
  await page.waitForSelector('#list [data-email="hub-455666777@staff.amatoolkit.local"]');
  const hubRow = await page.textContent('#list [data-email="hub-455666777@staff.amatoolkit.local"]');
  ok(hubRow.includes('Hub Person') && hubRow.includes('0455 666 777') && hubRow.includes('Hub sign-in') && !hubRow.includes('staff.amatoolkit.local'), 'they show by name and mobile, marked as hub sign-in (no stand-in email shown)');
  await page.click('#list [data-email="hub-455666777@staff.amatoolkit.local"]'); await page.waitForSelector('#detailsForm');
  ok(!(await page.$('#pwForm')) && (await page.textContent('#dlg')).includes('hub mobile and PIN'), 'their login has no password section');
  await page.evaluate(() => document.querySelector('#dlg').close());

  // Add several
  await page.click('#bulkBtn'); await page.waitForSelector('#bulkText');
  await page.fill('#bulkText', 'Name\tMobile\tRole\nSam Lee\t0466 000 111\tstaff\nKim Ng, 0466000222\nHub Person\t0455 666 777\nnobody here');
  ok((await page.textContent('#bulkCount')).includes('3 people to add') && (await page.textContent('#bulkCount')).includes('1 line'), 'pasted lines are counted (header skipped, a line without a mobile flagged)');
  await page.click('#bulkGo'); await page.waitForSelector('#dlg h3:has-text("Added")');
  const res = await page.textContent('#dlg');
  ok(res.includes('Added 2') && res.includes('Sam Lee') && res.includes('Kim Ng') && res.includes('Skipped') && res.includes('already has a login'), 'Add several adds new people and skips anyone already set up');
  ok(db._users.some(u => u.email === 'hub-466000111@staff.amatoolkit.local' && u.user_metadata.full_name === 'Sam Lee') && !db._t.prep_roles.some(r => r.email === 'hub-466000111@staff.amatoolkit.local'), 'they are added with no permissions');
  await page.evaluate(() => document.querySelector('#dlg').close());
  await page.fill('#search', 'kim'); ok((await page.$$('#list [data-email]')).length === 1, 'search finds people by name');
  await page.fill('#search', '0466 000 1'); ok((await page.$$('#list [data-email]')).length === 1, '...and by mobile');
  await page.fill('#search', '');

  // Own admin
  await page.click('#rolesForm ~ * .x, #dlg [data-close]').catch(() => {});
  await page.evaluate(() => document.querySelector('#dlg').close());
  await page.click('#list [data-email="tate@ama.test"]'); await page.waitForSelector('#rolesForm');
  ok(!(await page.$('#removeBtn')), "you can't remove yourself (no Remove button)");
  await page.uncheck('#cardChecks input[value="admin"]'); await page.click('#saveRoles');
  ok((await toastSays('own admin')).includes('own admin'), "removing your own admin access is refused, with the reason shown above the window");
  ok(await page.evaluate(() => document.querySelector('#toast').matches(':popover-open')), 'messages show on top of the open window');
  await page.evaluate(() => document.querySelector('#dlg').close());

  // Remove
  await page.click('#list [data-email="coach@ama.test"]'); await page.waitForSelector('#removeBtn');
  await page.click('#removeBtn'); await page.waitForSelector('#cfYes');
  ok((await page.textContent('#dlg')).includes('no longer be able to sign in'), 'remove asks first');
  await page.click('#cfYes');
  await page.waitForFunction(() => !document.querySelector('#list [data-email="coach@ama.test"]'));
  ok(!db._users.some(u => u.email === 'coach@ama.test') && !db._t.prep_roles.some(x => x.email === 'coach@ama.test'), 'login and roles removed');

  // Search
  await page.fill('#search', 'jo');
  ok((await page.$$('#list [data-email]')).length === 1, 'search filters the list');
  await page.fill('#search', '');

  // Function not deployed
  fnDeployed = false;
  await page.reload(); await page.waitForSelector('#problem:not([hidden])');
  ok((await page.textContent('#problem')).includes('Deploy a new function'), 'explains how to set up the function if it is missing');
  fnDeployed = true;
  await page.click('#retry'); await page.waitForSelector('#app:not([hidden])');
  ok(true, 'Try again works once it is set up');

  // Older copy of the function deployed (single ID Cards role)
  oldFunction = true;
  await page.reload(); await page.waitForSelector('#problem:not([hidden])');
  ok((await page.textContent('#problem')).includes('older copy') && !(await page.textContent('#problem')).includes('undefined'), 'an older staff function is explained (update it), not a crash');
  oldFunction = false;
  await page.click('#retry'); await page.waitForSelector('#app:not([hidden])');

  // The owner's login: another admin can see it but not change it
  await db.auth.admin.createUser({ email: 'boss@ama.test', password: 'password1' });
  db._t.staff_permissions.push({ email: 'boss@ama.test', permission: 'admin' }); db._t.prep_roles.push({ email: 'boss@ama.test', role: 'admin' });
  db._t.staff_admins.push({ email: 'boss@ama.test', added_by: 'seed' });
  db._t.toolkit_owners = [{ email: 'tate@ama.test' }];
  await page.click('#signOut'); await page.waitForSelector('#signIn:not([hidden])');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'boss@ama.test'); await page.fill('#siPass', 'password1'); await page.click('#siGo');
  await page.waitForSelector('#app:not([hidden]) #list [data-email="tate@ama.test"]');
  ok((await page.textContent('#list [data-email="tate@ama.test"]')).includes('Owner'), 'the owner is marked in the list');
  await page.click('#list [data-email="tate@ama.test"]'); await page.waitForSelector('#ownerNote');
  ok(await page.evaluate(() => [...document.querySelectorAll('#dlg input, #dlg button:not([data-close])')].every(el => el.disabled)), "another admin can't change the owner's login (everything is locked)");
  await page.evaluate(() => document.querySelector('#dlg').close());
  db._t.toolkit_owners = [];

  // Not an admin in both
  await page.click('#signOut'); await page.waitForSelector('#signIn:not([hidden])');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'jo@ama.test'); await page.fill('#siPass', 'brandnewpass'); await page.click('#siGo');
  await page.waitForSelector('#problem:not([hidden])');
  ok((await page.textContent('#problem')).includes('Staff admin'), 'someone who is not a Staff admin is told why they cannot use it');

  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling at phone size');
  ok(errors.length === 0, 'no errors in the browser console' + (errors.length ? ': ' + errors.join(' / ') : ''));
} catch (e) {
  ok(false, 'stopped: ' + e.message.split('\n').slice(0, 3).join(' / '));
}
await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Browser test for tick-box permissions: runs the app at phone size against a local stand-in for
// Supabase (from the Black Belt Prep tests) holding this app's real database rules.
// Run: node tests/users.test.mjs   (set PREP_TESTS to the black-belt-prep-system/tests folder if it lives elsewhere)
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const PREP_TESTS = process.env.PREP_TESTS || '/home/claude/black-belt-prep-system/tests';
const { PGlite } = await import(join(PREP_TESTS, 'node_modules/@electric-sql/pglite/dist/index.js'));
const { startServer } = await import(pathToFileURL(join(PREP_TESTS, 'fake-supabase.mjs')).href);
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const read = p => readFileSync(p, 'utf8');
const SHOTS = process.env.SHOT_DIR || join(tmpdir(), 'ama-cards-shots'); mkdirSync(SHOTS, { recursive: true });

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// ---- Database: before the update, with old single roles ----
const db = new PGlite();
await db.exec(read(join(here, 'supabase-stub.sql')));
const emails = ['owner@ama.test', 'appr@ama.test', 'pho@ama.test', 'sender@ama.test', 'station@ama.test'];
await db.exec(`insert into auth.users (id, email) values ${emails.map((e, i) => `('00000000-0000-0000-0000-00000000000${i + 1}', '${e}')`).join(',')}`);
await db.exec(read(join(here, '../supabase/setup.sql')));
await db.exec(read(join(here, '../supabase/roles.sql')));
await db.exec(read(join(here, '../supabase/printed.sql')));
await db.exec(`update staff_roles set role = 'approver' where email = 'appr@ama.test'; update staff_roles set role = 'photos' where email in ('pho@ama.test', 'sender@ama.test');
  update staff_roles set role = 'printer' where email = 'station@ama.test';
  insert into people (name, dan) values ('Kara Lee', '1st Dan'), ('Sam Park', '2nd Dan');
  insert into print_jobs (pdf_path, status, card_count, people_names) values ('jobs/a.pdf', 'pending', 1, '{Kara Lee}');`);

const users = Object.fromEntries(emails.map((e, i) => [e, { id: `00000000-0000-0000-0000-00000000000${i + 1}`, password: 'pw' }]));
const server = await startServer({ db, appDir: join(here, '../../../site/ama-id-cards'), users, config: '' });
const BASE = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
const errors = [];

async function open(email) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(PREP_TESTS, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')) }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: `window.AMA_CONFIG = { SUPABASE_URL: '${BASE}', SUPABASE_ANON_KEY: 'test' };` }));
  // The notify function: adds and removes logins (permissions are then set by the app itself)
  await ctx.route('**/functions/v1/notify**', async r => {
    const b = JSON.parse(r.request().postData() || '{}');
    if (b.action === 'create') {
      const exists = (await db.query(`select 1 from auth.users where email = $1`, [b.email])).rows.length;
      if (!exists) await db.query(`insert into auth.users (email) values ($1)`, [b.email]);
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, existed: !!exists }) });
    }
    if (b.action === 'remove') {
      await db.query(`delete from staff_permissions where email = $1`, [b.email]).catch(() => {});
      await db.query(`delete from auth.users where email = $1`, [b.email]);
      return r.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    }
    return r.fulfill({ contentType: 'application/json', body: '{}' });
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/websocket|realtime|ERR_CONNECTION|Failed to load resource|storage/i.test(m.text())) errors.push(`${email}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${email}: ${e.message}`));
  await page.goto(BASE + '/');
  await page.fill('#loginEmail', email); await page.fill('#loginPassword', 'pw'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#appView').hidden || !document.querySelector('#noAccessView').hidden, null, { timeout: 10000 });
  return { ctx, page };
}
const toastSays = async (page, t) => { await page.waitForFunction(x => { const el = document.querySelector('#toast'); return !el.hidden && el.textContent.includes(x); }, t, { timeout: 6000 }).catch(() => {}); return page.textContent('#toast'); };
const visible = (page, sel) => page.isVisible(sel);
const openUsers = async page => { await page.click('.tab[data-view="more"]'); const g = await page.$('#usersGroup'); if (!(await g.getAttribute('open'))) await page.click('#usersGroup > summary'); };

try {
  console.log('Before permissions.sql is run');
  let { ctx, page } = await open('appr@ama.test');
  ok(await page.evaluate(() => document.body.classList.contains('can-approve') && document.body.classList.contains('can-print') && !document.body.classList.contains('can-admin')), 'old Approver role still works (send, approve, no admin)');
  await ctx.close();
  ({ ctx, page } = await open('owner@ama.test'));
  await openUsers(page);
  await page.waitForSelector('#rolesMissing', { state: 'visible', timeout: 5000 }).catch(() => {});
  ok((await page.textContent('#rolesMissing')).includes('permissions.sql') && await visible(page, '#rolesMissing') && !(await visible(page, '#addUserOpen')), 'Users explains to run permissions.sql first');
  await ctx.close();

  await db.exec(read(join(here, '../supabase/permissions.sql')));
  console.log('\nAfter permissions.sql');
  ({ ctx, page } = await open('owner@ama.test'));
  ok(await page.isVisible('#homeBtn') && (await page.getAttribute('#homeBtn', 'href')) === 'https://theggatonklenner.github.io/', 'home button goes back to the AMA Toolkit');
  await openUsers(page);
  await page.waitForSelector('#usersList [data-user="appr@ama.test"]');
  const list = await page.textContent('#usersList');
  ok(list.includes('Edit people, Delete people, Send to print, Approve prints') && list.includes('owner@ama.test') && list.includes('Admin') && list.includes('Print station'), 'Users lists everyone with their ticked permissions, like Prep');
  await page.screenshot({ path: join(SHOTS, 'cards-users.png') });
  if (process.env.SHOT_DIR) for (const v of ['people', 'queue', 'add', 'more']) { await page.click(`.tab[data-view="${v}"]`); await page.waitForTimeout(300); await page.screenshot({ path: join(SHOTS, `cards-tab-${v}.png`), fullPage: true }); }
  if (process.env.SHOT_DIR) await page.click(`.tab[data-view="more"]`);

  // Change ticks: sender gets Send but not Approve
  await page.click('#usersList [data-user="sender@ama.test"]'); await page.waitForSelector('#userDlg[open]');
  ok((await page.$$('#permList input')).length === 7 && await page.isChecked('#permList input[value="edit"]'), 'user sheet shows all 7 permissions as tick boxes, with theirs ticked');
  await page.check('#permList input[value="send"]');
  await page.screenshot({ path: join(SHOTS, 'cards-user-sheet.png') });
  await page.click('#userSave');
  await toastSays(page, 'Saved');
  ok((await db.query(`select permission from staff_permissions where email = 'sender@ama.test' order by 1`)).rows.map(r => r.permission).join() === 'edit,send', 'ticks saved (Edit people + Send to print)');

  // Add a user
  await page.click('#addUserOpen'); await page.waitForSelector('#userDlg[open]');
  await page.fill('#uEmail', 'Coach@AMA.test'); await page.fill('#uPassword', 'longenough');
  await page.uncheck('#permList input[value="edit"]'); await page.check('#permList input[value="viewer"]');
  await page.click('#userSave');
  await page.waitForSelector('#usersList [data-user="coach@ama.test"]');
  ok((await db.query(`select permission from staff_permissions where email = 'coach@ama.test'`)).rows.map(r => r.permission).join() === 'viewer', 'new user added with exactly the ticked permissions');

  // Last admin
  await page.click('#usersList [data-user="owner@ama.test"]'); await page.waitForSelector('#userDlg[open]');
  ok(!(await visible(page, '#userRemove')), "you can't remove yourself");
  await page.uncheck('#permList input[value="admin"]'); await page.check('#permList input[value="viewer"]'); await page.click('#userSave');
  await page.waitForSelector('#askDlg[open]'); await page.click('#askOk');
  ok((await toastSays(page, 'at least one admin')).includes('at least one admin'), 'the last admin cannot remove their own Admin');
  await page.evaluate(() => document.querySelector('#userDlg').open && document.querySelector('#userDlg').close());

  // Remove a user
  await page.click('#usersList [data-user="coach@ama.test"]'); await page.waitForSelector('#userDlg[open]');
  await page.click('#userRemove'); await page.waitForSelector('#askDlg[open]'); await page.click('#askOk');
  await page.waitForFunction(() => !document.querySelector('#usersList [data-user="coach@ama.test"]'));
  ok((await db.query(`select 1 from staff_permissions where email = 'coach@ama.test'`)).rows.length === 0, 'removing a user removes their login and permissions');
  await ctx.close();

  console.log('\nWhat each person sees');
  ({ ctx, page } = await open('sender@ama.test'));
  await page.click('.tab[data-view="queue"]').catch(() => {});
  await page.waitForTimeout(600);
  ok(await page.evaluate(() => document.body.classList.contains('can-print') && !document.body.classList.contains('can-approve')), 'Send without Approve: can send, cannot approve');
  ok(!(await page.isVisible('[data-a="approve"]')), 'no Approve button in the print queue without Approve prints');
  ok((await page.textContent('#myRoleTag').catch(() => '')).includes('Edit people, Send to print'), 'More shows your own permissions');
  await ctx.close();
  ({ ctx, page } = await open('appr@ama.test'));
  await page.click('.tab[data-view="queue"]').catch(() => {});
  await page.waitForSelector('[data-a="approve"]', { state: 'visible', timeout: 5000 }).catch(() => {});
  ok(await page.isVisible('[data-a="approve"]'), 'Approve prints shows the Approve button');
  await ctx.close();
  ({ ctx, page } = await open('station@ama.test'));
  ok(await page.isVisible('#noAccessView'), 'print station login cannot use the app');
  await ctx.close();
  await db.exec(`delete from staff_permissions where email = 'pho@ama.test'`);
  ({ ctx, page } = await open('pho@ama.test'));
  ok(await page.isVisible('#noAccessView'), 'no ticks = no access');
  await ctx.close();

  ok(errors.length === 0, 'no errors in the browser console' + (errors.length ? ': ' + errors.slice(0, 4).join(' / ') : ''));
} catch (e) {
  ok(false, 'stopped: ' + e.message.split('\n').slice(0, 3).join(' / '));
}
await browser.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

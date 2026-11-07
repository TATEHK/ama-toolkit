// Tests for Clipboard: the database rules (embedded Postgres) and the site in a headless browser at
// phone size, against a local stand-in for Supabase. Run: node tests/clipboard.test.mjs
// Uses the test tools from the Black Belt Prep repository (set PREP_TESTS if it lives elsewhere).
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
const SHOTS = process.env.SHOT_DIR || join(tmpdir(), 'clipboard-shots'); mkdirSync(SHOTS, { recursive: true });

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

const db = new PGlite();
await db.exec(read(join(PREP_TESTS, 'supabase-stub.sql')));
const users = { 'tate@ama.test': { id: '00000000-0000-0000-0000-000000000001', password: 'pw' }, 'sam@ama.test': { id: '00000000-0000-0000-0000-000000000002', password: 'pw' },
  'station@ama.test': { id: '00000000-0000-0000-0000-000000000003', password: 'pw' } };
await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'tate@ama.test'), ('00000000-0000-0000-0000-000000000002', 'sam@ama.test'), ('00000000-0000-0000-0000-000000000003', 'station@ama.test');
  -- The two apps' staff tables: Tate has ID Cards access, Sam a Black Belt Prep role, the print station neither
  create table public.staff_permissions (email text, permission text); create table public.prep_roles (email text, role text);
  insert into staff_permissions values ('tate@ama.test', 'admin'), ('station@ama.test', 'printer'); insert into prep_roles values ('sam@ama.test', 'instructor');`);

async function as(email, fn) {
  await db.exec('set role authenticated');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })]);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false)`); }
}

console.log('Database');
const SQL = read(join(here, '../supabase/clipboard-setup.sql'));
await db.exec(SQL); await db.exec(SQL);
ok(true, 'clipboard-setup.sql runs twice without errors');
await as('tate@ama.test', () => db.exec(`insert into clip_templates (title, body, owner) values ('Mine', 'hello', 'sam@ama.test')`));
ok((await db.query(`select owner from clip_templates where title = 'Mine'`)).rows[0].owner === 'tate@ama.test', 'a template always records who really added it');
await as('sam@ama.test', () => db.exec(`insert into clip_templates (title, body) values ('Sams', 'shared')`));
ok((await as('tate@ama.test', () => db.query(`select title from clip_templates order by 1`))).rows.map(r => r.title).join() === 'Mine,Sams', 'everyone on the staff sees every template, whoever made it');
ok((await as('sam@ama.test', () => db.query(`select title from clip_templates order by 1`))).rows.length === 2, 'including staff who only have a Black Belt Prep role');
const r1 = await as('tate@ama.test', () => db.query(`update clip_templates set body = 'changed' where title = 'Sams'`));
ok(r1.affectedRows === 1, "staff can edit each other's templates");
const sams = (await db.query(`select owner, updated_by from clip_templates where title = 'Sams'`)).rows[0];
ok(sams.owner === 'sam@ama.test' && sams.updated_by === 'tate@ama.test', 'it keeps who added it and records who changed it');
await as('tate@ama.test', () => db.exec(`update clip_templates set owner = 'tate@ama.test' where title = 'Sams'`));
ok((await db.query(`select owner from clip_templates where title = 'Sams'`)).rows[0].owner === 'sam@ama.test', '"added by" cannot be changed');
ok((await as('station@ama.test', () => db.query(`select * from clip_templates`))).rows.length === 0, 'logins that are not staff (e.g. the print station) see nothing');
let blocked = false; try { await as('station@ama.test', () => db.exec(`insert into clip_templates (title) values ('x')`)); } catch (e) { blocked = true; }
ok(blocked, 'and cannot add templates');
ok((await as('station@ama.test', () => db.query(`select clip_is_staff() s`))).rows[0].s === false && (await as('sam@ama.test', () => db.query(`select clip_is_staff() s`))).rows[0].s === true, 'clip_is_staff() tells the site who has access');
let failedInsert = false; try { await as('tate@ama.test', () => db.exec(`insert into clip_templates (title) values ('  ')`)); } catch (e) { failedInsert = true; }
ok(failedInsert, 'a template needs a name');
const id = (await db.query(`select id from clip_templates where title = 'Mine'`)).rows[0].id;
await as('tate@ama.test', () => db.query(`select clip_used($1)`, [id]));
await as('sam@ama.test', () => db.query(`select clip_used($1)`, [id]));
const used = (await db.query(`select use_count, updated_by from clip_templates where id = $1`, [id])).rows[0];
ok(used.use_count === 2 && used.updated_by === 'tate@ama.test', 'copies by anyone count towards "most used", without counting as a change');
await db.exec(`delete from clip_templates`);
ok((await db.query(`select relrowsecurity r from pg_class where relname = 'clip_templates'`)).rows[0].r, 'row level security is on');

console.log('\nSite');
const server = await startServer({ db, appDir: join(here, '..'), users, config: '' });
const BASE = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
const errors = [];
async function open(email, empty = false) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(PREP_TESTS, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')) }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: `window.CLIP_CONFIG = { SUPABASE_URL: '${BASE}', SUPABASE_KEY: 'test' };` }));
  // Clipboard access in a headless browser: record what is written
  await ctx.addInitScript(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied.push(t); } }, configurable: true }); });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|favicon/i.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/');
  if (email) {
    await page.waitForSelector('#signIn:not([hidden])');
    await page.fill('#siEmail', email); await page.fill('#siPass', 'pw'); await page.click('#siGo');
    await page.waitForSelector('#app:not([hidden]), #setup:not([hidden])');
  }
  return { ctx, page };
}
const toastSays = async (page, t) => { await page.waitForFunction(x => { const el = document.querySelector('#toast'); return !el.hidden && el.textContent.includes(x); }, t, { timeout: 5000 }).catch(() => {}); return page.textContent('#toast'); };
const copied = page => page.evaluate(() => window.__copied.slice());

try {
  let { ctx, page } = await open('tate@ama.test');
  ok(await page.isVisible('#app') && (await page.textContent('#list')).includes('No templates yet'), 'signed in with an empty list and a hint to add one');
  ok(await page.isVisible('#homeBtn') && (await page.getAttribute('#homeBtn', 'href')) === 'https://theggatonklenner.github.io/', 'home button goes back to the AMA Grading Toolkit');

  // Add templates
  await page.click('#newBtn'); await page.waitForSelector('#edForm');
  await page.fill('#edTitle', 'Grading fee reminder');
  await page.fill('#edBody', 'Hi {Name}, a reminder that the grading fee of {Amount} is due. Thanks, Tate ({date})');
  await page.fill('#edCat', 'Parents'); await page.check('#edPin');
  await page.click('#edSave'); await page.waitForSelector('#list [data-copy]');
  await page.click('#newBtn'); await page.waitForSelector('#edForm');
  await page.fill('#edTitle', 'Dojang address'); await page.press('#edTitle', 'Enter');
  ok(await page.evaluate(() => document.querySelector('#dlg').open && document.activeElement.id === 'edBody'), 'Enter in the name moves to the text box (the window stays open)'); await page.fill('#edBody', '123 Example St, Marrickville NSW'); await page.fill('#edCat', 'Admin');
  await page.click('#edSave'); await page.waitForFunction(() => document.querySelectorAll('#list .tpl').length === 2);
  await page.click('#newBtn'); await page.waitForSelector('#edForm');
  await page.fill('#edTitle', 'Session reminder'); await page.fill('#edBody', 'See you at prep this {day}!');
  await page.press('#edBody', 'Control+Enter'); await page.waitForFunction(() => document.querySelectorAll('#list .tpl').length === 3);
  ok((await db.query(`select count(*)::int n from clip_templates where owner = 'tate@ama.test'`)).rows[0].n === 3, 'templates saved to your account');
  ok((await page.textContent('#list .tpl:first-child')).includes('Grading fee reminder'), 'pinned template is at the top');
  ok((await page.textContent('#chips')).includes('Parents') && (await page.textContent('#chips')).includes('Admin'), 'categories show as filter buttons');
  await page.screenshot({ path: join(SHOTS, 'clipboard-list.png') });

  // One-tap copy
  await page.click('#list [data-copy]:has-text("Dojang address")');
  ok((await copied(page)).at(-1) === '123 Example St, Marrickville NSW', 'tapping a template copies it to the clipboard');
  ok((await toastSays(page, 'Copied')).includes('Copied: Dojang address'), 'shows "Copied"');
  await page.waitForTimeout(300);
  ok((await db.query(`select use_count from clip_templates where title = 'Dojang address'`)).rows[0].use_count === 1, 'copy is counted for "most used" ordering');

  // Automatic blanks
  await page.click('#list [data-copy]:has-text("Session reminder")');
  const day = new Date().toLocaleDateString('en-AU', { weekday: 'long' });
  ok((await copied(page)).at(-1) === `See you at prep this ${day}!`, '{day} fills itself in');

  // Fill-in blanks
  await page.click('#list .copy:has-text("Grading fee reminder")'); await page.waitForSelector('#blankForm');
  ok((await page.$$('#blankForm [data-blank]')).length === 2, 'asks for each blank ({Name}, {Amount})');
  await page.fill('#blankForm [data-blank="Name"]', 'Kara'); await page.fill('#blankForm [data-blank="Amount"]', '$150');
  ok((await page.textContent('#blPrev')).startsWith('Hi Kara, a reminder that the grading fee of $150 is due.'), 'preview updates as you type');
  await page.screenshot({ path: join(SHOTS, 'clipboard-blanks.png') });
  await page.focus('#blankForm [data-blank="Name"]'); await page.press('#blankForm [data-blank="Name"]', 'Enter');
  ok(await page.evaluate(() => document.querySelector('#dlg').open && document.activeElement.dataset.blank === 'Amount'), 'Enter in a blank moves to the next blank (the window stays open)');
  await page.press('#blankForm [data-blank="Amount"]', 'Enter');
  await page.waitForFunction(() => !document.querySelector('#dlg').open);
  const out = (await copied(page)).at(-1);
  ok(out.startsWith('Hi Kara, a reminder that the grading fee of $150 is due. Thanks, Tate (') && !out.includes('{'), 'copies the filled-in text, with {date} filled in');
  await page.click('#list .copy:has-text("Grading fee reminder")'); await page.waitForSelector('#blankForm');
  ok((await page.inputValue('#blankForm [data-blank="Name"]')) === 'Kara', 'remembers what you typed last time');
  await page.evaluate(() => document.querySelector('#dlg').close());

  // Search and filter
  await page.fill('#search', 'marrick');
  ok((await page.$$('#list .tpl')).length === 1, 'search finds templates by their text');
  await page.press('#search', 'Enter');
  ok((await copied(page)).at(-1) === '123 Example St, Marrickville NSW', 'Enter copies the top result');
  await page.fill('#search', ''); await page.dispatchEvent('#search', 'input');
  await page.click('#chips [data-cat="Parents"]');
  ok((await page.$$('#list .tpl')).length === 1, 'category filter');
  await page.click('#chips [data-cat=""]');

  // Edit, duplicate, delete
  await page.click('#list .tpl:has-text("Session reminder") [data-edit]'); await page.waitForSelector('#edForm');
  await page.fill('#edBody', 'See you at prep this {day} at 6pm!'); await page.click('#edSave'); await toastSays(page, 'Saved');
  ok((await db.query(`select body from clip_templates where title = 'Session reminder'`)).rows[0].body.includes('6pm'), 'editing saves');
  await page.click('#list .tpl:has-text("Session reminder") [data-edit]'); await page.waitForSelector('#edDup');
  await page.click('#edDup'); await page.waitForSelector('#edForm'); await page.click('#edSave');
  await page.waitForFunction(() => document.querySelectorAll('#list .tpl').length === 4);
  ok(true, 'duplicate makes a copy to change');
  await page.click('#list .tpl:has-text("Session reminder (copy)") [data-edit]'); await page.waitForSelector('#edDel');
  await page.click('#edDel'); await page.waitForSelector('#cfYes'); await page.click('#cfYes');
  await page.waitForFunction(() => document.querySelectorAll('#list .tpl').length === 3);
  ok(true, 'delete asks first, then removes it');

  // Sign out: someone else sees only theirs
  await page.click('#signOut'); await page.waitForSelector('#signIn:not([hidden])');
  await page.fill('#siEmail', 'sam@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('#list .tpl');
  ok((await page.$$('#list .tpl')).length === 3 && (await page.textContent('#list')).includes('Added by Tate'), 'another staff member sees the same templates, with who added them');
  await page.click('#list [data-copy]:has-text("Dojang address")');
  ok((await copied(page)).at(-1) === '123 Example St, Marrickville NSW', 'and can copy them');
  await page.click('#signOut'); await page.waitForSelector('#signIn:not([hidden])');
  await page.fill('#siEmail', 'station@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#noAccess:not([hidden])');
  ok((await page.textContent('#noAccess')).includes('for AMA staff'), 'a login that is not staff is told why it has no access');
  await ctx.close();

  // Offline: saved copy still lets you copy
  ({ ctx, page } = await open('tate@ama.test'));
  await page.waitForSelector('#list [data-copy]');
  await ctx.route(`${BASE}/rest/**`, r => r.abort());
  await page.reload(); await page.waitForSelector('#app:not([hidden])');
  ok(await page.isVisible('#offline') && (await page.$$('#list .tpl')).length === 3, 'with no connection, your saved copy still shows');
  await page.click('#list [data-copy]:has-text("Dojang address")');
  ok((await copied(page)).at(-1) === '123 Example St, Marrickville NSW', 'and you can still copy');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling at phone size');
  await ctx.close();

  // Table not set up yet
  await db.exec(`alter table clip_templates rename to clip_templates_x`);
  ({ ctx, page } = await open('tate@ama.test'));
  ok(await page.isVisible('#setup') && (await page.textContent('#setup')).includes('clipboard-setup.sql'), 'explains the setup if the table is missing');
  await db.exec(`alter table clip_templates_x rename to clip_templates`);
  await page.click('#retry'); await page.waitForSelector('#app:not([hidden])');
  ok(true, 'Try again works once it is set up');
  await ctx.close();

  ok(errors.length === 0, 'no errors in the browser console' + (errors.length ? ': ' + errors.slice(0, 3).join(' / ') : ''));
} catch (e) {
  ok(false, 'stopped: ' + e.message.split('\n').slice(0, 3).join(' / '));
}
await browser.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

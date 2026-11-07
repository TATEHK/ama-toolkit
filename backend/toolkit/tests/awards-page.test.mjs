// Long service awards page (/awards/), in a headless browser against a pretend Supabase holding the real database rules
// (supabase/long-service.sql). The browser's clock is set to 27 October 2026. Run: node tests/awards-page.test.mjs
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const PREP_TESTS = process.env.PREP_TESTS || '/home/claude/black-belt-prep-system/tests';
const PREP = join(PREP_TESTS, '..');
const CARD = process.env.CARD_REPO || '/home/claude/theggatonklenner/ama-id-cards';
const { PGlite } = await import(join(PREP_TESTS, 'node_modules/@electric-sql/pglite/dist/index.js'));
const { startServer } = await import(pathToFileURL(join(PREP_TESTS, 'fake-supabase.mjs')).href);
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const read = p => readFileSync(p, 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };
const SHOTS = process.env.SHOT_DIR; if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// ---- Database ----
const db = new PGlite();
await db.exec(read(join(PREP_TESTS, 'supabase-stub.sql')));
await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'tate@ama.test'), ('00000000-0000-0000-0000-000000000002', 'coach@ama.test'), ('00000000-0000-0000-0000-000000000003', 'desk@ama.test')`);
for (const f of ['setup.sql', 'roles.sql', 'printed.sql']) await db.exec(read(join(CARD, 'supabase', f)));
await db.exec(read(join(PREP, 'supabase/prep-setup.sql')));
for (let i = 1; i <= 14; i++) await db.exec(read(join(PREP, `supabase/prep-update-${String(i).padStart(2, '0')}.sql`)));
await db.exec(read(join(ROOT, 'supabase/long-service.sql')));
await db.exec(read(join(ROOT, 'supabase/long-service.sql')));   // safe to run twice
await db.exec(`insert into prep_roles (email, role) values ('tate@ama.test', 'admin') on conflict do nothing; delete from prep_roles where email <> 'tate@ama.test'; insert into prep_roles (email, role) values ('coach@ama.test', 'instructor'), ('desk@ama.test', 'attendance');`);
const q = async (s, p) => (await db.query(s, p)).rows;
// What the weekly EFC check would load: each person's enrolled date range (about a month)
const people = [
  ['a1', 'AU-023-101', 'Sam Lee', 'Marrickville', '2021-08-01', '2021-08-31'],     // 5 years in Aug 2026: to order
  ['a2', 'AU-023-102', 'Kim Ng', 'Marrickville', '2017-02-01', '2017-02-28'],      // 10 years in Feb 2027: in the leeway
  ['a3', 'AU-023-103', 'Jo Park', 'Marrickville', '2022-05-01', '2022-05-31'],     // 5 years in May 2027: next year
  ['a4', 'AU-023-104', 'Old Timer', 'Marrickville', '2001-11-01', '2001-11-30'],   // 25 years in Nov 2026
  ['a5', 'AU-023-105', 'Ann Last', 'Marrickville', '2021-01-01', '2021-01-31'],    // 5 years in Jan 2026: last year's round, not given
  ['a6', 'AU-023-106', 'Mar Edge', 'Marrickville', '2022-03-01', '2022-03-31'],    // 5 years in Mar 2027: just after the leeway
  ['b1', 'AU-256-201', 'Syd Kid', 'Sydenham', '2021-04-01', '2021-12-31']          // 5 years Apr-Dec 2026
].map(([id, ref, name, loc, from, to]) => ({ id, ref, name, loc, from, to }));
const loaded = (await q(`select lsa_load($1::jsonb) r`, [JSON.stringify(people)]))[0].r;
ok(loaded.found === 7 && loaded.added === 7, 'the weekly check loads people and records the run');
ok((await q(`select lsa_load($1::jsonb) r`, [JSON.stringify(people.slice(0, 1))]))[0].r.added === 0, 'loading the same person again adds no one');

const users = { 'tate@ama.test': { id: '00000000-0000-0000-0000-000000000001', password: 'pw' }, 'coach@ama.test': { id: '00000000-0000-0000-0000-000000000002', password: 'pw' }, 'desk@ama.test': { id: '00000000-0000-0000-0000-000000000003', password: 'pw' } };
const server = await startServer({ db, appDir: ROOT, users, config: '', maxRows: 1000 });
const BASE = `http://localhost:${server.address().port}`;
const configJs = `window.TOOLKIT_CONFIG = { SUPABASE_URL: '${BASE}', SUPABASE_KEY: 'test' };`;
const browser = await chromium.launch();
const errors = [];
async function open(email, viewport = { width: 1100, height: 900 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await ctx.clock.setFixedTime(new Date('2026-10-27T10:00:00+11:00'));
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(PREP_TESTS, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')) }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE + '/awards/index.html');
  await page.waitForSelector('#siForm', { state: 'attached' });
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', email); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForFunction(() => !document.querySelector('#app').hidden || !document.querySelector('#noAccess').hidden, null, { timeout: 10000 });
  return { ctx, page };
}
const text = (page, sel) => page.textContent(sel).then(t => (t || '').replace(/\s+/g, ' '));
const names = (page, sel) => page.$$eval(`${sel} .item .name`, ns => ns.map(n => n.textContent));
const toastSays = (page, t) => page.waitForFunction(x => { const el = document.querySelector('#toast'); return !el.hidden && el.textContent.includes(x); }, t, { timeout: 6000 }).catch(() => {});
const listAfter = id => `#${id} + .list, #${id} + .empty, #${id}`;

console.log('\nWho can see it');
let { ctx, page } = await open('desk@ama.test');
ok(await page.isVisible('#noAccess') && await page.isHidden('#app'), 'front desk (attendance only) is told to ask for access');
await ctx.close();

console.log('\nThis year (instructor)');
({ ctx, page } = await open('coach@ama.test'));
await page.waitForSelector('#roundTitle');
ok((await text(page, '#roundTitle')) === 'December 2026 awards', 'opens on December 2026');
ok((await text(page, '#window')).includes('28 Feb 2027') && (await text(page, '#window')).includes('2 months leeway'), 'says the cut-off with 2 months leeway (end of February)');
ok((await text(page, '#lastRun')).includes('EFC last checked'), 'says when EFC was last checked');
let todo = await names(page, '#g-todo + .list');
ok(['Sam Lee', 'Kim Ng', 'Old Timer', 'Syd Kid'].every(n => todo.includes(n)) && !todo.includes('Jo Park') && !todo.includes('Mar Edge') && !todo.includes('Ann Last'), `To order: Sam, Kim, Old Timer and Syd Kid (${todo.join(', ')})`);
ok(todo.indexOf('Sam Lee') < todo.indexOf('Old Timer') && todo.indexOf('Old Timer') < todo.indexOf('Kim Ng'), 'listed in date order: Aug, Nov, then February');
const kimRow = await text(page, '#g-todo + .list li[data-k="efc:a2"]');
ok(kimRow.includes('10') && kimRow.includes('Feb 2027') && kimRow.includes('In the leeway'), 'Kim shows 10 years, Feb 2027, in the leeway');
ok((await text(page, '#g-todo + .list li[data-k="efc:a4"]')).includes('25'), 'Old Timer gets the 25 year award');
ok((await names(page, '#g-next')).join() === 'Mar Edge,Jo Park', 'Next year: Mar Edge (just after the leeway), then Jo Park');
ok((await names(page, '#g-missed')).join() === 'Ann Last', 'Ann (January 2026, last year\'s order) shows under Not given last year');
ok((await text(page, '.tally .todo')).startsWith('4'), 'tally: 4 to order');
ok(await page.isHidden('#settingsBtn'), 'only admins see settings');
if (SHOTS) await page.screenshot({ path: join(SHOTS, 'awards-desktop.png'), fullPage: true });

// Ordered, then Given
await page.click('li[data-k="efc:a1"] [data-set="ordered"]'); await toastSays(page, 'ordered');
let aw = await q(`select status, done_by from lsa_awards where member_key = 'efc:a1' and years = 5`);
ok(aw[0] && aw[0].status === 'ordered' && aw[0].done_by === 'coach@ama.test', 'Ordered is saved, with who did it');
ok((await names(page, '#g-ordered + .list')).includes('Sam Lee') && !(await names(page, '#g-todo + .list')).includes('Sam Lee'), 'Sam moves to Ordered');
await page.click('#g-ordered + .list li[data-k="efc:a1"] [data-set="given"]'); await toastSays(page, 'given');
ok((await q(`select status from lsa_awards where member_key = 'efc:a1'`))[0].status === 'given', 'Given is saved');
ok((await page.$$eval('#g-given .item .name', ns => ns.map(n => n.textContent))).includes('Sam Lee'), 'Sam moves to Given');

// Filters
await page.selectOption('#fSchool', 'Sydenham');
ok((await names(page, '#g-todo + .list')).join() === 'Syd Kid', 'school filter');
await page.selectOption('#fSchool', '');
await page.selectOption('#fYears', '10');
ok((await names(page, '#g-todo + .list')).join() === 'Kim Ng', 'award filter (10 years)');
await page.selectOption('#fYears', '');
await page.fill('#q', 'old');
ok((await names(page, '#g-todo + .list')).join() === 'Old Timer', 'name search');
await page.fill('#q', '');

// Order list
await page.click('#copyBtn'); await page.waitForSelector('#olText');
const ol = await page.textContent('#olText');
ok(ol.includes('AMA long service awards, December 2026') && ol.includes('5 years (1)') && ol.includes('Syd Kid (Sydenham)') && ol.includes('10 years (1)') && ol.includes('25 years (1)') && !ol.includes('Sam Lee'), 'order list groups the awards still to order by years');
await page.click('#olMark'); await toastSays(page, 'marked as ordered');
ok(Number((await q(`select count(*) n from lsa_awards where status = 'ordered'`))[0].n) === 3, 'Mark all as ordered saves the 3 awards');
ok((await text(page, '.tally .todo')).startsWith('0') && (await page.isDisabled('#copyBtn')), 'nothing left to order');

// A person: change the start date, and take off a break
await page.click('#g-next'); await page.click('#g-next li[data-k="efc:a3"] [data-open]'); await page.waitForSelector('#pStart');
ok((await text(page, '#dlg')).includes('EFC enrolled') && (await text(page, '#dlg')).includes('May 2027'), 'person sheet shows when EFC says they enrolled and when they reach 5 years');
await page.fill('#pStart', '2021-09-15'); await page.fill('#pNote', 'Started before EFC'); await page.evaluate(() => { document.querySelector('#toast').textContent = ''; }); await page.click('#pSave'); await toastSays(page, 'Saved');
ok((await q(`select start_override::text s, note from lsa_members where member_key = 'efc:a3'`))[0].s === '2021-09-15', 'start date saved');
ok((await names(page, '#g-todo + .list')).includes('Jo Park'), 'with an earlier start, Jo is due this year');
await page.click('#g-todo + .list li[data-k="efc:a3"] [data-open]'); await page.waitForSelector('#pBreak');
await page.fill('#pBreak', '6'); await page.evaluate(() => { document.querySelector('#toast').textContent = ''; }); await page.click('#pSave'); await toastSays(page, 'Saved');
ok(!(await names(page, '#g-todo + .list')).includes('Jo Park') && (await page.$$eval('#g-next .item .name', ns => ns.map(n => n.textContent))).includes('Jo Park'), 'taking off a 6 month break moves Jo to next year (March 2027)');
const guard = await q(`select full_name, enrolled_from::text f from lsa_members where member_key = 'efc:a3'`);
ok(guard[0].full_name === 'Jo Park' && guard[0].f === '2022-05-01', "staff changes don't touch what EFC said");

// Not giving one
await page.click('#g-todo + .list li[data-k="efc:a4"] [data-open]').catch(async () => { await page.click('#g-ordered + .list li[data-k="efc:a4"] [data-open]'); });
await page.waitForSelector('#pChoice');
await page.click('#pChoice [data-s="skip"]'); await toastSays(page, 'not giving one');
ok((await q(`select status from lsa_awards where member_key = 'efc:a4' and years = 25`))[0].status === 'skip' && (await page.$$eval('#g-skip .item .name', ns => ns.map(n => n.textContent))).includes('Old Timer'), 'Not giving one is saved and listed on its own');

// Add someone EFC doesn't have
await page.click('#addBtn'); await page.waitForSelector('#aName');
await page.fill('#aName', 'Pat Early'); await page.selectOption('#aSchool', 'Concord'); await page.fill('#aStart', '2016-11-20'); await page.click('#aSave'); await toastSays(page, 'Added');
const pat = await q(`select member_key, location, added_by from lsa_members where full_name = 'Pat Early'`);
ok(pat[0] && pat[0].member_key.startsWith('manual:') && pat[0].location === 'Concord' && pat[0].added_by === 'coach@ama.test', 'someone added by hand is saved');
ok((await text(page, '#g-todo + .list')).includes('Pat Early'), 'and shows as due for 10 years in November');

// Double check flag (e.g. on the list but not enrolled in EFC)
await q(`update lsa_members set check_flag = 'Not enrolled in EFC' where full_name = 'Pat Early'`);
await page.reload(); await page.waitForSelector('#roundTitle');
ok((await text(page, '#g-todo + .list li:has-text("Pat Early")')).includes('Double check') && (await text(page, '#app .flagbox')).includes('1 to double check'), 'a flagged person shows Double check, with a count');
await page.click('#flagBtn');
ok((await names(page, '#g-todo + .list')).join() === 'Pat Early', 'Show only these lists just the flagged people');
await page.click('#flagBtn');
await page.click('#copyBtn'); await page.waitForSelector('#olText');
const ol2 = await page.textContent('#olText');
ok(ol2.includes('Double check first (1)') && ol2.includes('Pat Early (Concord), 10 years') && (await text(page, '#olMark')).includes('Mark all 0'), 'order list keeps flagged people separate and out of Mark all');
await page.click('#dlg [data-close]');
await page.click('#g-todo + .list li:has-text("Pat Early") [data-open]'); await page.waitForSelector('#pClear');
ok((await text(page, '#dlg')).includes('Not enrolled in EFC'), 'the person sheet says why');
await page.evaluate(() => { document.querySelector('#toast').textContent = ''; }); await page.click('#pClear'); await toastSays(page, 'checked');
ok((await q(`select check_flag from lsa_members where full_name = 'Pat Early'`))[0].check_flag === null && !(await page.$('#app .flagbox')), 'Checked, clear removes the flag');
await page.click('#g-todo + .list li:has-text("Pat Early") [data-open]'); await page.waitForSelector('#pFlag');
await page.fill('#pFlag', 'Ask about start date'); await page.evaluate(() => { document.querySelector('#toast').textContent = ''; }); await page.click('#pSave'); await toastSays(page, 'Saved');
ok((await q(`select check_flag from lsa_members where full_name = 'Pat Early'`))[0].check_flag === 'Ask about start date', 'staff can flag someone with a reason');
await q(`update lsa_members set check_flag = null where full_name = 'Pat Early'`);
await page.reload(); await page.waitForSelector('#roundTitle');

// Last year
await page.click('#prevRound');
ok((await text(page, '#roundTitle')) === 'December 2025 awards' && (await names(page, '#g-todo + .list')).includes('Ann Last'), 'the previous December shows Ann still to order');
await page.click('#nextRound');

// Move last year's award into this December
await page.click('#g-missed'); await page.click('#g-missed li[data-k="efc:a5"] [data-open]'); await page.waitForSelector('#pRound');
await page.selectOption('#pRound', '2026'); await toastSays(page, 'December 2026');
let mv = await q(`select status, round from lsa_awards where member_key = 'efc:a5' and years = 5`);
ok(mv[0] && mv[0].status === 'due' && mv[0].round === 2026, 'an award can be moved to this December');
ok((await names(page, '#g-todo + .list')).includes('Ann Last') && (await text(page, '#g-todo + .list li[data-k="efc:a5"]')).includes('Moved from 2025') && !(await page.$('#g-missed li[data-k="efc:a5"]')), 'it shows in To order, marked as moved, and not under last year');
await page.click('li[data-k="efc:a5"] [data-set="ordered"]'); await toastSays(page, 'ordered');
mv = await q(`select status, round from lsa_awards where member_key = 'efc:a5' and years = 5`);
ok(mv[0].status === 'ordered' && mv[0].round === 2026 && (await names(page, '#g-ordered + .list')).includes('Ann Last'), 'ordering it keeps it in this December');
await page.click('#g-ordered + .list li[data-k="efc:a5"] [data-open]'); await page.waitForSelector('#pChoice');
await page.click('#pChoice [data-s=""]'); await toastSays(page, 'back to To order');
mv = await q(`select status, round from lsa_awards where member_key = 'efc:a5' and years = 5`);
ok(mv[0].status === 'due' && mv[0].round === 2026 && (await names(page, '#g-todo + .list')).includes('Ann Last'), 'back to To order, it stays in this December');
await page.click('#g-todo + .list li[data-k="efc:a5"] [data-open]'); await page.waitForSelector('#pRound');
await page.selectOption('#pRound', '2025'); await toastSays(page, 'December 2025');
ok(!(await q(`select 1 from lsa_awards where member_key = 'efc:a5'`)).length && (await names(page, '#g-missed')).includes('Ann Last'), 'and can be moved back');
if (SHOTS) {
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS, 'awards-phone.png'), fullPage: true });
  await page.click('#g-ordered + .list li [data-open]'); await page.waitForSelector('#pChoice');
  await page.screenshot({ path: join(SHOTS, 'awards-person.png') });
  await page.keyboard.press('Escape');
}
await ctx.close();

console.log('\nRules');
const rls = async (email, sql) => { try { await db.exec(`set role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ email, role: 'authenticated' })}', false);`); return { rows: (await db.query(sql)).rows }; } catch (e) { return { error: e.message }; } finally { await db.exec("reset role; select set_config('request.jwt.claims', '', false)"); } };
let r = await rls('desk@ama.test', `select count(*) n from lsa_members`);
ok(r.error || Number(r.rows[0].n) === 0, 'front desk can\'t read the list');
r = await rls('coach@ama.test', `update lsa_settings set leeway_months = 5 where id = 1 returning id`);
ok(r.error || r.rows.length === 0, 'an instructor can\'t change the leeway');
r = await rls('coach@ama.test', `insert into lsa_members (member_key, full_name) values ('efc:fake', 'Fake') returning member_key`);
ok(!!r.error, 'staff can only add people by hand (not pretend EFC records)');
r = await rls('coach@ama.test', `select lsa_load('[]'::jsonb)`);
ok(!!r.error, 'only the weekly check can load EFC data');

console.log('\nSettings (admin)');
({ ctx, page } = await open('tate@ama.test'));
await page.waitForSelector('#roundTitle');
await page.click('#settingsBtn'); await page.waitForSelector('#sLeeway');
await page.selectOption('#sLeeway', '0'); await page.evaluate(() => { document.querySelector('#toast').textContent = ''; }); await page.click('#sSave'); await toastSays(page, 'Saved');
ok((await q(`select leeway_months from lsa_settings`))[0].leeway_months === 0, 'leeway saved');
ok((await text(page, '#window')).includes('31 Dec 2026'), 'with no leeway the cut-off is 31 December');
ok((await page.$$eval('#g-next .item .name', ns => ns.map(n => n.textContent))).includes('Kim Ng'), 'Kim (February) moves to next year');
await page.click('#settingsBtn'); await page.selectOption('#sLeeway', '2'); await page.evaluate(() => { document.querySelector('#toast').textContent = ''; }); await page.click('#sSave'); await toastSays(page, 'Saved');
const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#printBtn')]);
await popup.waitForLoadState();
const pt = await popup.textContent('body');
ok(pt.includes('AMA long service awards, December 2026') && pt.includes('Kim Ng') && pt.includes('Pat Early') && !pt.includes('Old Timer'), 'print list has this year\'s awards, without Not giving one');
await ctx.close();

console.log('\nPhone');
({ ctx, page } = await open('coach@ama.test', { width: 390, height: 844 }));
await page.waitForSelector('#roundTitle');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scrolling on a phone');
await ctx.close();

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Browser test: examiner scoring on a tablet, results, report card release, and the family's report card page.
// Run: node tests/scoring-page.test.mjs   (screenshots in tests/screenshots/scoring-*.png)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './fake-supabase.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const here = dirname(fileURLToPath(import.meta.url));
const CARD = process.env.CARD_REPO || join(here, '../../id-cards');
const SHOTS = join(here, 'screenshots'); mkdirSync(SHOTS, { recursive: true });
const read = p => readFileSync(p, 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

const db = new PGlite();
await db.exec(read(join(here, 'supabase-stub.sql')));
await db.exec(`insert into auth.users (email) values ('owner@ama.test')`);
for (const f of ['setup.sql', 'roles.sql', 'printed.sql']) await db.exec(read(join(CARD, 'supabase', f)));
await db.exec(read(join(here, '../supabase/prep-setup.sql')));
await db.exec(`create or replace function public.gen_random_bytes(n int) returns bytea language sql volatile as $$ select substring(decode(md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text), 'hex') from 1 for n) $$`);
for (let i = 1; i <= 22; i++) if (i !== 20) await db.exec(read(join(here, `../supabase/prep-update-${String(i).padStart(2, '0')}.sql`)));
await db.exec(read(join(here, '../supabase/prep-update-25.sql')));
await db.exec(`insert into prep_roles (email, role) values ('jo@ama.test','instructor');
  insert into prep_students (full_name, certificate_name, belt_rank) values ('Alex Smith','Alexandra Smith','Cho Dan Bo'), ('Ben Tran',null,'Probationary Black Belt'), ('Cara Lee',null,'1st Dan Level 1');
  insert into prep_cycles (name, start_date, end_date, status, grading_date) values ('December 2026', current_date - 60, current_date + 7, 'active', current_date + 7);`);
await db.exec(read(join(here, '../../toolkit/supabase/app-permissions.sql')));   // per-feature permissions (Staff logins), from the roles above
const cid = (await db.query(`select cycle_id from prep_cycles`)).rows[0].cycle_id;
await db.query(`insert into prep_enrolments (cycle_id, student_id, is_grading) select $1, student_id, true from prep_students`, [cid]);
await db.query(`insert into prep_grading (student_id, cycle_id, grading_event, current_rank, target_rank, eligibility_decision, decision_reason, status)
  select student_id, $1, 'December 2026 grading', belt_rank, case belt_rank when 'Cho Dan Bo' then 'Probationary Black Belt' when 'Probationary Black Belt' then '1st Dan Black Belt' else '2nd Dan' end, 'eligible', 'Test candidate', 'nominated' from prep_students`, [cid]);

const users = { 'owner@ama.test': { id: '00000000-0000-0000-0000-000000000001', password: 'pw', user_metadata: { full_name: 'Mark' } },
  'jo@ama.test': { id: '00000000-0000-0000-0000-000000000002', password: 'pw', user_metadata: { full_name: 'Jo Instructor' } } };
const server = await startServer({ db, appDir: join(here, '../../../site'), users, config: '' });
const BASE = `http://localhost:${server.address().port}`;
const configJs = `window.PREP_CONFIG = { SUPABASE_URL: '${BASE}', SUPABASE_ANON_KEY: 'test-anon-key' };`;
const browser = await chromium.launch();
const errors = [];
async function open(email, viewport = { width: 1024, height: 768 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: true, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(here, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')) }));
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/websocket|realtime|ERR_CONNECTION|Failed to load resource/i.test(m.text())) errors.push(`${email}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${email}: ${e.message}`));
  if (email) {
    await page.goto(BASE + '/Black-belt-prep-system/');
    await page.fill('#loginEmail', email); await page.fill('#loginPassword', 'pw'); await page.click('#loginBtn');
    await page.waitForFunction(() => !document.querySelector('#app').hidden);
    await page.waitForFunction(() => !document.querySelector('#view-dashboard').textContent.includes('Loading'));
  }
  return { ctx, page };
}
const toScoring = async page => {
  await page.evaluate(() => showView('grading'));
  await page.click('#view-grading [data-grpanel="scoring"]');
  await page.waitForSelector('#scList [data-sc]');
};
// wait for the "Saved" note that follows an action (hide any earlier one first, so a stale note never counts)
const saved = page => page.waitForFunction(() => { const s = document.querySelector('#scSaved'); return s && !s.hidden; });
const hideSaved = page => page.evaluate(() => { const s = document.querySelector('#scSaved'); if (s) s.hidden = true; });
const tap = async (page, sel) => { await hideSaved(page); await page.click(sel); await saved(page); };
const after = async (page, fn) => { await hideSaved(page); await fn(); await saved(page); };

try {
  console.log('Examiner 1 (instructor) on an iPad');
  let { ctx, page } = await open('jo@ama.test');
  await toScoring(page);
  ok((await page.$$('#scList [data-sc]')).length === 3, 'the Scoring panel lists everyone put forward');
  ok(!(await page.$('#scList [data-scres]')), 'an instructor scores but does not see the Results button');
  await page.screenshot({ path: join(SHOTS, 'scoring-list.png') });
  await page.click('#scList [data-sc="BB0001"]');
  await page.waitForSelector('#scoreDlg[open] [data-cat]');
  const cats = await page.$$eval('#scoreDlg [data-cat]', els => els.map(e => e.dataset.cat));
  ok(cats.join() === 'patterns,sparring,breaking,hands_kicks,self_defence,one_step', 'PBB sheet: patterns, sparring, breaking, hands and kicks, self defence, one step (no weapons)');
  ok((await page.textContent('#scoreDlg')).includes('Flexibility: side splits'), 'the PBB checks (side splits, meditation) are on the sheet');
  await tap(page, '#scoreDlg [data-cat="patterns"] [data-n="8"]');
  await tap(page, '#scoreDlg [data-cat="sparring"] [data-n="7"]');
  await after(page, () => page.check('#scoreDlg [data-cat="sparring"] [data-half]'));
  await page.fill('#scoreDlg [data-cat="patterns"] [data-note]', 'Crisp Taeguk 8'); await after(page, () => page.press('#scoreDlg [data-cat="patterns"] [data-note]', 'Tab'));
  for (const [k, n] of [['breaking', 9], ['hands_kicks', 8], ['self_defence', 6], ['one_step', 7]]) { await tap(page, `#scoreDlg [data-cat="${k}"] [data-n="${n}"]`); }
  await tap(page, '#scoreDlg [data-check="1"]');
  await page.fill('#scStr', 'Powerful kicks and great focus'); await page.fill('#scWork', 'Keep the guard up in sparring'); await after(page, () => page.press('#scWork', 'Tab'));
  ok((await page.textContent('#scMyAvg')) === '7.6', 'your average updates as you score (8, 7.5, 9, 8, 6, 7)');
  ok((await page.textContent('#scLeft')) === 'All sections scored', 'footer says when every section is scored');
  await page.evaluate(() => document.querySelector('#scoreDlg').scrollTo(0, 0));
  await page.screenshot({ path: join(SHOTS, 'scoring-sheet.png') });
  await page.evaluate(() => document.querySelector('#sc-sparring').scrollIntoView());
  await page.screenshot({ path: join(SHOTS, 'scoring-sheet-2.png') });
  let rows = (await db.query(`select category, score, examiner, examiner_name, note from prep_scores order by category`)).rows;
  ok(rows.length === 6 && rows.every(r => r.examiner === 'jo@ama.test' && r.examiner_name === 'Jo Instructor'), 'six scores saved under the examiner');
  ok(rows.find(r => r.category === 'sparring').score == 7.5 && rows.find(r => r.category === 'patterns').note === 'Crisp Taeguk 8', 'half points and section notes save');
  await tap(page, '#scoreDlg [data-cat="one_step"] [data-n="7"]');
  ok(!(await db.query(`select 1 from prep_scores where category = 'one_step'`)).rows.length, 'tapping the chosen score again clears it');
  await tap(page, '#scoreDlg [data-cat="one_step"] [data-n="7"]');
  await page.click('#scoreDlg [data-scmove="1"]');
  await page.waitForFunction(() => document.querySelector('#scoreDlg .sc-top h3').textContent === 'Ben Tran');
  ok((await page.$$eval('#scoreDlg [data-cat]', e => e.map(x => x.dataset.cat))).includes('weapons'), 'Next candidate goes straight to the next sheet (1st Dan has weapons)');
  await page.click('#scoreDlg [data-scclose]');
  await page.waitForFunction(() => document.querySelector('#scList [data-sc="BB0001"]').textContent.includes('You 6/6'));
  ok(true, 'the list shows your progress for each candidate');
  await ctx.close();

  console.log('\nExaminer 2 (admin, head of grading)');
  ({ ctx, page } = await open('owner@ama.test'));
  await toScoring(page);
  await page.click('#scList [data-sc="BB0001"]');
  await page.waitForSelector('#scoreDlg[open] [data-cat]');
  ok(!(await page.textContent('#scoreDlg [data-cat="patterns"] [data-val]')).match(/\d/), 'each examiner starts with a blank sheet (scores are their own)');
  await page.check('#scPeek');
  ok((await page.textContent('#scoreDlg [data-cat="patterns"] .sc-others')).includes('Jo Instructor: 8'), "grading staff can choose to see other examiners' scores");
  for (const [k, n] of [['patterns', 9], ['sparring', 8], ['breaking', 9], ['hands_kicks', 9], ['self_defence', 7], ['one_step', 8]]) { await tap(page, `#scoreDlg [data-cat="${k}"] [data-n="${n}"]`); }
  await tap(page, '#scoreDlg [data-check="0"]');
  await page.click('#scoreDlg [data-scclose]');
  await page.waitForSelector('#scList [data-scres="BB0001"]');
  await page.click('#scList [data-scres="BB0001"]');
  await page.waitForSelector('#sheet[open] .sc-table');
  const txt = await page.textContent('#sheet');
  ok(txt.includes('Jo Instructor') && txt.includes('Mark') && /Patterns\s*8\s*9\s*8\.5/.test(txt.replace(/\s+/g, ' ')), 'results: each examiner\'s score and the average per section');
  ok(txt.includes('Suggests pass: average 8'), 'suggests pass (every section 5+, average under the distinction mark)');
  ok(await page.getAttribute('#sheet [data-oc="pass"]', 'aria-pressed') === 'true', 'the suggestion is preselected, nothing saved yet');
  ok(!(await db.query(`select 1 from prep_report_cards`)).rows.length, 'nobody is passed automatically');
  await page.screenshot({ path: join(SHOTS, 'scoring-results.png') });
  await page.fill('#scSum', 'A strong grading. Welcome to the black belt family!');
  await page.click('#scConfirm');
  await page.waitForSelector('#scRelease');
  const rc = (await db.query(`select * from prep_report_cards`)).rows[0];
  ok(rc && rc.outcome === 'pass' && rc.summary.startsWith('A strong grading') && !rc.released_at, 'outcome confirmed, report card not released yet');
  ok((await db.query(`select result from prep_grading where student_id = 'BB0001'`)).rows[0].result === 'passed', '...and the grading result is recorded as passed');
  await page.click('#scRelease');
  await page.waitForSelector('#scUnrelease');
  ok((await db.query(`select released_at from prep_report_cards`)).rows[0].released_at, 'Release report card makes the family link work');
  await page.screenshot({ path: join(SHOTS, 'scoring-released.png') });
  await ctx.close();

  console.log('\nThe family opens the link on a phone');
  ({ ctx, page } = await open(null, { width: 390, height: 844 }));
  await page.goto(`${BASE}/report#${rc.token}`);
  await page.waitForSelector('.outcome');
  const card = await page.textContent('main');
  ok(card.includes('Alexandra Smith') && card.includes('Probationary Black Belt') && card.includes('Passed'), 'report card: certificate name, belt and outcome');
  ok(/Patterns\s*8\.5/.test(card.replace(/\s+/g, ' ')) && card.includes('Crisp Taeguk 8'), '...average score per section and the examiner\'s note');
  ok(card.includes('Powerful kicks') && card.includes('Keep the guard up') && card.includes('Jo Instructor') && !card.includes('@ama.test'), '...comments by examiner name, no emails');
  ok(card.includes('Flexibility: side splits') && card.includes('A strong grading'), '...requirements ticked and the panel summary');
  await page.screenshot({ path: join(SHOTS, 'scoring-report-card.png'), fullPage: true });
  await page.goto(`${BASE}/report#NOTAREALTOKEN123`); await page.reload();
  await page.waitForFunction(() => !document.querySelector('main').textContent.includes('Loading'));
  const wrong = await page.textContent('main'); ok(wrong.includes('not available'), 'a wrong link shows a friendly message' + (wrong.includes('not available') ? '' : ': ' + wrong.trim().slice(0, 120)));
  await ctx.close();
  ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) { failed++; console.log('  FAIL  ' + (e.stack || e)); errors.length && console.log(errors.join('\n')); }
await browser.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Browser tests for the Black Belt Gradings app (Stage 3: students, cycles, attendance).
// Runs the real app in headless Chromium at phone size, against a local stand-in for Supabase
// that uses the real database rules (card software SQL + prep-setup.sql).
//
//   cd tests && npm install && CARD_REPO=/path/to/ama-id-cards node app.test.mjs
// Screenshots are written to tests/screenshots/.

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './fake-supabase.mjs';
import { createRequire } from 'node:module';
const XLSX = createRequire(import.meta.url)('xlsx');

const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const here = dirname(fileURLToPath(import.meta.url));
const CARD = process.env.CARD_REPO || join(here, '../../id-cards');
const SHOTS = join(here, 'screenshots'); mkdirSync(SHOTS, { recursive: true });
const read = p => readFileSync(p, 'utf8');

// ---------- Database ----------
const db = new PGlite();
await db.exec(read(join(here, 'supabase-stub.sql')));
await db.exec(`insert into auth.users (email) values ('owner@ama.test')`);
for (const f of ['setup.sql', 'roles.sql', 'printed.sql']) await db.exec(read(join(CARD, 'supabase', f)));
await db.exec(read(join(here, '../supabase/prep-setup.sql')));
await db.exec(read(join(here, '../supabase/prep-update-01.sql')));
await db.exec(read(join(here, '../supabase/prep-update-02.sql')));
await db.exec(read(join(here, '../supabase/prep-update-03.sql')));
await db.exec(read(join(here, '../supabase/prep-update-04.sql')));
await db.exec(read(join(here, '../supabase/prep-update-05.sql')));
await db.exec(read(join(here, '../supabase/prep-update-06.sql')));
await db.exec(read(join(here, '../supabase/prep-update-07.sql')));
await db.exec(read(join(here, '../supabase/prep-update-08.sql')));
await db.exec(read(join(here, '../supabase/prep-update-09.sql')));
await db.exec(read(join(here, '../supabase/prep-update-10.sql')));
await db.exec(read(join(here, '../supabase/prep-update-11.sql')));
await db.exec(read(join(here, '../supabase/prep-update-12.sql')));
await db.exec(read(join(here, '../supabase/prep-update-13.sql')));
await db.exec(read(join(here, '../supabase/prep-update-14.sql')));
// Later updates the page now uses (polos, nurture, essays allowed late, scoring); 20 needs pg_cron, 23 and 24 need the coloured belt tables
await db.exec(`create or replace function public.gen_random_bytes(n int) returns bytea language sql volatile as $$ select substring(decode(md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text), 'hex') from 1 for n) $$`);   // pgcrypto stand-in
for (const i of [15, 16, 17, 18, 19, 21, 22, 25, 27]) await db.exec(read(join(here, `../supabase/prep-update-${i}.sql`)));
await db.exec(`insert into prep_roles (email, role) values ('att@ama.test','attendance'), ('view@ama.test','viewer');
  update prep_settings set default_session_fee = 120;
  insert into prep_dan_counters (target_rank, next_number) values ('Probationary Black Belt', 501), ('1st Dan Black Belt', 701);`);
await db.exec(read(join(here, '../../toolkit/supabase/app-permissions.sql')));   // per-feature permissions (Staff logins), from the roles above

const users = Object.fromEntries(['owner@ama.test', 'att@ama.test', 'view@ama.test', 'nobody@ama.test']
  .map((e, i) => [e, { id: `00000000-0000-0000-0000-00000000000${i + 1}`, password: 'pw' }]));
const server = await startServer({ db, appDir: join(here, '../../../site/Black-belt-prep-system'), users, config: '' });
const BASE = `http://localhost:${server.address().port}`;
const configJs = `window.PREP_CONFIG = { SUPABASE_URL: '${BASE}', SUPABASE_ANON_KEY: 'test-anon-key' };`;
const q = server.q;
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------- Browser ----------
const browser = await chromium.launch();
let passed = 0, failed = 0, shotN = 0;
const ok = (c, name) => { if (c) { passed++; console.log('  pass  ' + name); } else { failed++; console.log('  FAIL  ' + name); } };
const consoleErrors = [];

async function open(email) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(here, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')) }));
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/xlsx/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(here, 'node_modules/xlsx/dist/xlsx.full.min.js')) }));
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/websocket|realtime|ERR_CONNECTION|Failed to load resource/i.test(m.text())) consoleErrors.push(`${email}: ${m.text()}`); });
  page.on('pageerror', e => consoleErrors.push(`${email}: ${e.message}`));
  await page.goto(BASE + '/');
  if (email) {
    await page.fill('#loginEmail', email); await page.fill('#loginPassword', 'pw');
    await page.click('#loginBtn');
    await page.waitForFunction(() => !document.querySelector('#app').hidden || !document.querySelector('#noAccessView').hidden, null, { timeout: 8000 });
    // Wait for the data to finish loading
    await page.waitForFunction(() => !document.querySelector('#noAccessView').hidden || !document.querySelector('#view-dashboard').textContent.includes('Loading'), null, { timeout: 8000 });
  }
  return { ctx, page };
}
const shot = async (page, name) => page.screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`), fullPage: false });
const confirm = async page => { await page.waitForSelector('#askDlg[open]'); const t = await page.textContent('#askText'); await page.click('#askYes'); await page.waitForSelector('#askDlg:not([open])', { state: 'attached' }); return t; };
const tab = async (page, v) => {
  if (['cycles', 'payments', 'readiness', 'certificates', 'reports'].includes(v)) { await page.click('.tab[data-view="more"]'); await page.click(`[data-goto="${v}"]`); }
  else await page.click(`.tab[data-view="${v}"]`);
};
const settle = page => page.waitForTimeout(450);
const toastText = async page => { await page.waitForSelector('#toast:not([hidden])'); return page.textContent('#toast'); };

try {
  // ------------------------------------------------------------------
  console.log('Sign in');
  {
    const { ctx, page } = await open(null);
    ok(await page.isVisible('#authView'), 'sign-in screen shown when signed out');
    await page.fill('#loginEmail', 'owner@ama.test'); await page.fill('#loginPassword', 'wrong'); await page.click('#loginBtn');
    await page.waitForSelector('#loginError:not([hidden])');
    ok((await page.textContent('#loginError')).includes('Wrong email or password'), 'wrong password shows a clear message');
    await ctx.close();
    const n = await open('nobody@ama.test');
    ok(await n.page.isVisible('#noAccessView'), 'login without a prep role sees "No access yet"');
    await shot(n.page, 'no-access');
    await n.ctx.close();
  }

  // ------------------------------------------------------------------
  console.log('\nStudents');
  const { ctx, page } = await open('owner@ama.test');
  await page.waitForFunction(() => document.querySelector('#view-dashboard').textContent.includes('Dashboard'));
  ok(await page.isVisible('#view-dashboard') && (await page.textContent('#view-dashboard')).includes('No preparation cycle is active'), 'admin lands on the dashboard; no active cycle yet');
  await shot(page, 'dashboard-empty');
  ok(await page.isVisible('#homeBtn') && (await page.getAttribute('#homeBtn', 'href')) === '/', 'home button goes back to the AMA Toolkit');
  await tab(page, 'students');
  await page.click('#addStudentBtn');
  await page.fill('#fName', 'Alex Smith'); await page.selectOption('#fRank', 'Cho Dan Bo');
  ok(!(await page.$('#fDob')) && await page.isVisible('#fPhone') && await page.isVisible('#fEmail'), 'student form has no birth date; family mobile and email are optional (for texts)');
  await shot(page, 'add-student');
  await page.click('#fSave');
  ok((await toastText(page)).includes('as BB0001'), 'student added and given Student ID BB0001');
  await page.waitForSelector('#sheet #stEdit');
  await page.click('#sheet [data-close]');
  await page.click('#addStudentBtn');
  await page.fill('#fName', 'ALEX  smith'); await page.press('#fName', 'Enter');   // Enter saves, it doesn't close the window
  const dupText = await page.textContent('#askText', { timeout: 3000 }).catch(() => '');
  ok(dupText.includes('Alex Smith (BB0001'), 'pressing Enter in a form submits it (adding a matching name warns about a possible duplicate)');
  await page.click('#askNo'); await page.click('#sheet [data-close]');
  ok((await q(`select count(*)::int n from prep_students`))[0].n === 1, 'cancelled duplicate was not saved');

  await page.click('#importStudentsBtn');
  await page.fill('#impText', [
    'First name,Last name,Belt,Phone,Student ID',
    'Jordan,Lee,cho dan bo,0400 000 000,',
    'Taylor,Brown,3rd dan lvl 2,,',
    'alex,smith,,,',
    'Riley,Chen,Cho Dan Bo,,M-0042',
    'Jordan,Lee,,,',
    'Kim,Park,Blue belt,,'
  ].join('\n'));
  await page.waitForSelector('#impPreview table');
  const prev = await page.textContent('#impPreview');
  ok(prev.includes('3 to add') && prev.includes('3 skipped'), 'import preview: 3 to add, 3 skipped (extra columns such as Phone ignored)');
  ok(prev.includes('Already in the register') && prev.includes('Repeated in this list') && prev.includes('"Blue belt" is not in the list'),
     'preview explains each skipped row (existing, repeated, unknown belt)');
  await shot(page, 'import-preview');
  await page.click('#impGo'); await confirm(page); await settle(page);
  const imported = await q(`select student_id, full_name, contact_phone from prep_students order by student_id`);
  ok(imported.length === 4 && imported.some(s => s.student_id === 'M-0042'), 'import kept the supplied Student ID');
  ok(imported.some(s => s.contact_phone), 'a Mobile or Phone column in the file is kept as the family mobile (for texts)');
  const belts = Object.fromEntries((await q(`select full_name, belt_rank from prep_students`)).map(r => [r.full_name, r.belt_rank]));
  ok(belts['Jordan Lee'] === 'Cho Dan Bo' && belts['Taylor Brown'] === '3rd Dan Level 2', 'imported belts matched to the list ("cho dan bo", "3rd dan lvl 2")');
  const opts = await page.$$eval('#studentBelt option', os => os.map(o => o.textContent));
  ok(opts.slice(1, 4).join('|') === 'Cho Dan Bo|Probationary Black Belt|1st Dan Black Belt' && opts[opts.length - 1] === '9th Dan' && opts.length === 27 && opts.includes('5th Dan Level 5'), 'belt list is in grading order, Cho Dan Bo to 9th Dan');
  // The way the club's list is written: tab-separated, belts in words
  await page.click('#importStudentsBtn');
  await page.fill('#impText', 'Name\tBelt\nIvy Abbatantuono\tFirst Dan\nDali Connelly\tThird Dan Level 1\nPersia Dowling\tThird Dan Level 2\nMichael Esen\tThird Dan\nBillie-Rose Barton-Hall\tFirst Dan');
  await page.waitForSelector('#impPreview table');
  const wp = await page.textContent('#impPreview');
  ok(wp.includes('5 to add') && !wp.includes('not in the list'), 'belts written in words ("First Dan", "Third Dan Level 1") are recognised');
  await page.click('#sheet [data-close]');
  await page.click('#addStudentBtn'); await page.fill('#fName', 'Test Student'); await page.check('#fTest'); await page.click('#fSave'); await page.waitForSelector('#sheet #stEdit'); await page.click('#sheet [data-close]');
  ok((await page.textContent('#studentList')).includes('Test Student') === false, 'test records hidden from the list by default');
  await page.check('#studentShowTest');
  ok((await page.textContent('#studentList')).includes('Test Student'), '"Show test records" reveals them');
  await page.uncheck('#studentShowTest');
  await page.fill('#studentSearch', 'lee');
  ok((await page.$$('#studentList [data-student]')).length === 1, 'search filters the list');
  await page.fill('#studentSearch', '');
  await page.selectOption('#studentBelt', 'Cho Dan Bo');
  ok((await page.$$('#studentList [data-student]')).length === 3, 'belt filter works');
  await page.selectOption('#studentBelt', '');
  ok(!(await page.textContent('#view-students')).toLowerCase().includes('club'), 'no club or school shown');
  await shot(page, 'students');

  await page.click('#studentList [data-student="BB0002"]');
  await page.click('#stEdit'); await page.fill('#fCert', 'Jordan Michael Lee'); await page.click('#fSave'); await settle(page);
  ok((await q(`select certificate_name from prep_students where student_id = 'BB0002'`))[0].certificate_name === 'Jordan Michael Lee', 'student edited');
  await page.click('#stActive'); await confirm(page); await settle(page);
  ok((await q(`select is_active from prep_students where student_id = 'BB0002'`))[0].is_active === false, 'student deactivated (record kept)');
  await page.click('#stActive'); await settle(page);
  ok((await q(`select is_active from prep_students where student_id = 'BB0002'`))[0].is_active === true, 'student reactivated');
  await page.click('#sheet [data-close]');

  // ------------------------------------------------------------------
  console.log('\nPreparation cycles');
  await tab(page, 'cycles');
  await page.click('#newCycleBtn');
  await page.fill('#ncName', 'Term 4 2026');
  ok(!(await page.$('#ncStart')) && !(await page.$('#ncEnd')), 'no cycle start or end date, only session dates');
  ok(!(await page.$('#ncDue')), 'no payment due date for session fees');
  ok((await page.textContent('label[for=ncS4]')).includes('Sign-off'), 'session 4 is labelled as the sign-off');
  await page.fill('#ncS1', '2026-10-05'); await page.dispatchEvent('#ncS1', 'change');
  ok(await page.inputValue('#ncS2') === '2026-10-19' && await page.inputValue('#ncS4') === '2026-11-16', 'sessions 2 to 4 filled in every two weeks from session 1');
  ok(await page.inputValue('#ncGrade') === '2026-11-30', 'grading date filled in two weeks after the sign-off');
  ok(await page.inputValue('#ncFee') === '200.00' && await page.inputValue('#ncPer') === '60.00', 'fees default to $200 upfront and $60 per session');
  await shot(page, 'new-cycle');
  await page.click('#ncGo');
  const review = await confirm(page);
  ok(review.includes('4 students enrolled') && review.includes('becomes the active cycle') && review.includes('sign-off on') && review.includes('Grading on') && review.includes('$200 upfront or $60 per session'), 'review step summarises the cycle, sign-off, grading date and fees');
  await page.waitForSelector('#cyclePill:not([hidden])');
  ok((await page.textContent('#cyclePillText')) === 'Term 4 2026', 'new cycle is active and shown in the header');
  const c1 = (await q(`select cycle_id, status from prep_cycles where name = 'Term 4 2026'`))[0];
  ok(c1.status === 'active', 'cycle saved as active');
  ok((await q(`select count(*)::int n from prep_attendance where cycle_id = $1 and status = 'not_recorded'`, [c1.cycle_id]))[0].n === 16, 'fresh attendance created for 4 students x 4 sessions');
  const cyc = (await q(`select grading_date::text g, start_date::text s, end_date::text e from prep_cycles where cycle_id = $1`, [c1.cycle_id]))[0];
  ok(cyc.g === '2026-11-30' && cyc.s === '2026-10-05' && cyc.e === '2026-11-16', 'grading date saved; cycle span taken from the session dates');
  const dans = Object.fromEntries((await q(`select student_id, dan_number, target_rank from prep_dan_numbers`)).map(r => [r.student_id, r]));
  ok(dans.BB0001?.dan_number === 501 && dans.BB0002?.dan_number === 502 && dans['M-0042']?.dan_number === 503 && !dans.BB0003,
     'Dan numbers 501 to 503 given in name order to the Cho Dan Bo students; the 3rd Dan Level 2 student gets none');
  await page.click('#newCycleBtn'); await page.fill('#ncName', 'term 4 2026'); await page.fill('#ncS1', '2026-10-05'); await page.dispatchEvent('#ncS1', 'change');
  await page.click('#ncGo');
  ok((await toastText(page)).includes('already exists'), 'starting a cycle with the same name is stopped');
  await page.click('#sheet [data-close]');
  await page.click(`[data-cycle="${c1.cycle_id}"]`);
  await page.fill('#cySess2', '2026-10-13'); await page.click('#cySave'); await settle(page);
  ok((await q(`select session_date::text d from prep_sessions where cycle_id = $1 and session_number = 2`, [c1.cycle_id]))[0].d === '2026-10-13', 'session date edited');
  await shot(page, 'cycle-detail');
  await page.click('#sheet [data-close]');

  // ------------------------------------------------------------------
  console.log('\nAttendance');
  await tab(page, 'attendance');
  await page.click('#attBody [data-session="1"]');
  await page.click('.att button[data-id="BB0001"][data-s="present"]'); await settle(page);
  const a1 = (await q(`select a.status, a.recorded_by from prep_attendance a join prep_sessions s using (session_id) where s.cycle_id = $1 and s.session_number = 1 and a.student_id = 'BB0001'`, [c1.cycle_id]))[0];
  ok(a1.status === 'present' && a1.recorded_by === 'owner@ama.test', 'one tap marks a student present and records who did it');
  ok(await page.getAttribute('.att button[data-id="BB0001"][data-s="present"]', 'aria-pressed') === 'true', 'button shows the recorded status');
  await page.click('#attSelect');
  await page.check('[data-pick="BB0002"]'); await page.check('[data-pick="BB0003"]');
  await shot(page, 'attendance-select');
  await page.click('#selbar [data-bulk="absent"]');
  const absTxt = await confirm(page);
  ok(absTxt.includes('ABSENT') && absTxt.includes('Only the students you selected'), 'bulk absent asks for explicit confirmation');
  await settle(page);
  const s1 = await q(`select a.student_id, a.status from prep_attendance a join prep_sessions s using (session_id) where s.cycle_id = $1 and s.session_number = 1 order by 1`, [c1.cycle_id]);
  ok(s1.find(r => r.student_id === 'BB0002').status === 'absent' && s1.find(r => r.student_id === 'BB0003').status === 'absent', 'selected students marked absent');
  ok(s1.find(r => r.student_id === 'M-0042').status === 'not_recorded' && s1.find(r => r.student_id === 'BB0001').status === 'present', 'students not selected were not changed');
  ok(await page.isHidden('#selbar'), 'selection mode closes after a bulk change');
  await page.click('.att button[data-id="BB0002"][data-s="excused"]'); await settle(page);
  ok((await q(`select a.status from prep_attendance a join prep_sessions s using (session_id) where s.cycle_id = $1 and s.session_number = 1 and a.student_id = 'BB0002'`, [c1.cycle_id]))[0].status === 'excused', 'recorded attendance can be corrected');
  // Prepaying: Riley hasn't been marked for session 1 yet
  ok(!(await page.isDisabled('.att .pay[data-pay="M-0042"]')), '$ works before a student is marked present (prepaying)');
  await page.click('.att .pay[data-pay="M-0042"]'); await settle(page);
  const pre = await q(`select t.amount::text a from prep_payment_transactions t join prep_sessions s using (session_id) where s.cycle_id = $1 and s.session_number = 1 and t.student_id = 'M-0042'`, [c1.cycle_id]);
  ok(pre.length === 1 && pre[0].a === '60.00', 'prepaid $60 recorded against session 1');
  ok((await q(`select a.status from prep_attendance a join prep_sessions s using (session_id) where s.cycle_id = $1 and s.session_number = 1 and a.student_id = 'M-0042'`, [c1.cycle_id]))[0].status === 'not_recorded', 'prepaying does not mark attendance');
  await page.waitForFunction(() => document.querySelector('#attBody .counts')?.textContent.includes('1 prepaid'), null, { timeout: 5000 }).catch(() => {});
  ok((await page.textContent('#attBody .counts')).includes('1 prepaid'), 'session shows how many have prepaid');
  const credit = (await q(`select s.balance::text b, s.status from prep_payment_summary s where s.cycle_id = $1 and s.student_id = 'M-0042' and s.kind = 'sessions'`, [c1.cycle_id]))[0];
  ok(Number(credit.b) === -60 && credit.status === 'paid', 'before attending, the prepayment shows as a $60 credit');
  await page.click('.att .pay[data-pay="M-0042"]'); await confirm(page); await settle(page);
  await page.click('.att .pay[data-pay="BB0001"]'); await settle(page);
  const paidTx = await q(`select t.amount::text a, t.method, t.notes from prep_payment_transactions t join prep_sessions s using (session_id) where s.cycle_id = $1 and s.session_number = 1 and t.student_id = 'BB0001'`, [c1.cycle_id]);
  ok(paidTx.length === 1 && paidTx[0].a === '60.00' && paidTx[0].notes === 'Paid at session 1', 'one tap on $ records $60 paid at that session');
  await page.waitForFunction(() => document.querySelector('#attBody .counts')?.textContent.includes('1 of 1 present paid'), null, { timeout: 5000 }).catch(() => {});
  ok(await page.getAttribute('.att .pay[data-pay="BB0001"]', 'aria-pressed') === 'true' && (await page.textContent('#attBody .counts')).includes('1 of 1 present paid'), '$ shows as paid and the session count updates');
  await shot(page, 'attendance-paid');
  await page.click('.att .pay[data-pay="BB0001"]'); const undoTxt = await confirm(page); await settle(page);
  ok(undoTxt.includes('Undo') && Number((await q(`select amount_paid from prep_payment_summary p join prep_cycles c using (cycle_id) where c.cycle_id = $1 and p.student_id = 'BB0001'`, [c1.cycle_id]))[0].amount_paid) === 0, 'tapping $ again undoes the payment after confirming');
  await page.waitForFunction(() => document.querySelector('.att .pay[data-pay="BB0001"]')?.getAttribute('aria-pressed') === 'false', null, { timeout: 5000 }).catch(() => {});
  await page.click('.att .pay[data-pay="BB0001"]'); await settle(page);
  await page.waitForFunction(() => document.querySelector('.att .pay[data-pay="BB0001"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 5000 }).catch(() => {});

  await page.click('#attBody [data-session="2"]');
  await page.selectOption('#attBelt', 'Cho Dan Bo');
  await page.click('#attAllPresent'); const allTxt = await confirm(page); await settle(page);
  ok(/Mark 3 students present/.test(allTxt), '"Mark shown as present" only covers the filtered students (3 at Cho Dan Bo)');
  const s2 = await q(`select a.student_id, a.status from prep_attendance a join prep_sessions s using (session_id) where s.cycle_id = $1 and s.session_number = 2`, [c1.cycle_id]);
  ok(s2.filter(r => r.status === 'present').length === 3 && s2.find(r => r.student_id === 'BB0003').status === 'not_recorded', 'student on another belt left unrecorded');
  await page.selectOption('#attBelt', '');
  await shot(page, 'attendance');

  await page.click('#attImport');
  await page.fill('#impText', 'Student ID,Name,Session,Status\nBB0003,,2,P\n,Jordan Lee,3,absent\n,Nobody Here,3,P\nBB0001,,7,P\nBB0001,,3,maybe\nBB0001,,2,present\nZZ999,,2,P');
  await page.waitForSelector('#impPreview table');
  const ip = await page.textContent('#impPreview');
  ok(ip.includes('3 to record') && ip.includes('1 new student') && ip.includes('New student'), 'upload preview: a name not in the register becomes a new student');
  ok(ip.includes('Student ID ZZ999 not found') && ip.includes('No session 7') && ip.includes('not understood') && ip.includes('Already recorded'), 'upload preview flags unknown IDs, bad sessions, bad statuses and repeats');
  await shot(page, 'attendance-import');
  await page.click('#impGo'); await confirm(page); await settle(page);
  ok((await q(`select count(*)::int n from prep_attendance a join prep_sessions s using (session_id) where s.cycle_id = $1 and ((s.session_number = 2 and a.student_id = 'BB0003' and a.status = 'present') or (s.session_number = 3 and a.student_id = 'BB0002' and a.status = 'absent'))`, [c1.cycle_id]))[0].n === 2, 'uploaded attendance saved');
  const nobody = (await q(`select s.student_id, s.belt_rank, a.status from prep_students s join prep_attendance a using (student_id) join prep_sessions x using (session_id) where s.full_name = 'Nobody Here' and x.session_number = 3 and x.cycle_id = $1`, [c1.cycle_id]))[0];
  ok(nobody && nobody.status === 'present', 'new student created, added to the cycle and marked present for that session');

  // End of a session: upload a plain list of names (no heading row)
  await page.click('#attBody [data-session="3"]');
  await page.click('#attImport');
  await page.fill('#impText', 'Riley Chen\nBrand New,2nd Dan\nAlex Smith');
  await page.waitForSelector('#impPreview table');
  const ip2 = await page.textContent('#impPreview');
  ok(ip2.includes('3 to record') && ip2.includes('1 new student') && ip2.includes('2nd Dan'), 'plain list of names works; a belt next to a new name is used');
  await page.click('#impGo'); await confirm(page); await settle(page);
  const s3 = Object.fromEntries((await q(`select st.full_name, a.status, st.belt_rank from prep_attendance a join prep_sessions x using (session_id) join prep_students st using (student_id) where x.cycle_id = $1 and x.session_number = 3`, [c1.cycle_id])).map(r => [r.full_name, r]));
  ok(s3['Riley Chen'].status === 'present' && s3['Alex Smith'].status === 'present' && s3['Brand New']?.status === 'present' && s3['Brand New'].belt_rank === '2nd Dan', 'everyone on the list is marked present for session 3, including the new student');
  ok(s3['Taylor Brown'].status === 'not_recorded', 'people not on the list are not marked absent');

  ok((await page.textContent('#attBody [data-session="4"]')).includes('Sign-off'), 'attendance shows session 4 as the sign-off');
  await page.click('#attBody [data-session="4"]');
  ok((await page.textContent('#attBody')).includes('must be marked Present here to grade'), 'sign-off session explains the rule');
  await page.click('.att button[data-id="BB0002"][data-s="absent"]'); await settle(page);
  await page.click('#view-attendance [data-mode="summary"]');
  const sumTxt = await page.textContent('#attBody');
  ok(sumTxt.includes('present ÷ (present + absent)'), 'summary explains how the percentage is worked out');
  const alexPct = (await q(`select attendance_pct::text p from prep_attendance_summary where student_id = 'BB0001' and cycle_id = $1`, [c1.cycle_id]))[0].p;
  ok(alexPct === '100.0', 'unrecorded sessions do not lower the percentage (Alex 2 of 2 = 100%)');
  await shot(page, 'attendance-summary');
  await page.click('#view-attendance [data-mode="sessions"]');

  // ------------------------------------------------------------------
  console.log('\nDashboard');
  await tab(page, 'dashboard');
  const sel = await page.$$eval('.tab', ts => ts.map(t => t.dataset.view + '=' + t.getAttribute('aria-selected')).join(' '));
  ok(sel.includes('dashboard=true') && !sel.includes('attendance=true'), 'only the Dashboard tab is highlighted (' + sel + ')');
  const dash = await page.textContent('#view-dashboard');
  ok(dash.includes('Term 4 2026') && dash.includes('Needs attention'), 'dashboard shows the active cycle and a needs-attention list');
  ok(dash.includes('absence'), 'students with absences are listed for follow-up');
  ok(dash.includes('Missed the sign-off (absent)') && dash.includes('Grading · 30 Nov'), 'dashboard flags a missed sign-off and shows the grading date');
  // Classes attended
  ok(dash.includes('Classes attended') && await page.isVisible('#dashClasses'), 'the dashboard has a classes attended section with Record classes');
  await page.click('#dashClasses'); await page.waitForSelector('#clsForm [data-cls]');
  const firstCls = await page.getAttribute('#clsForm [data-cls]', 'data-cls');
  await page.fill(`#clsForm [data-cls="${firstCls}"]`, '9');
  await page.click(`#clsForm [data-cls-up="${firstCls}"]`); await page.click(`#clsForm [data-cls-up="${firstCls}"]`); await page.click(`#clsForm [data-cls-dn="${firstCls}"]`);
  await page.fill('#clsReq', '12');
  await page.click('#clsSave'); await page.waitForSelector('#clsForm', { state: 'detached', timeout: 5000 }).catch(() => {}); await page.waitForTimeout(400);
  const ce = await q(`select classes_attended from prep_enrolments where cycle_id = $1 and student_id = $2`, [c1.cycle_id, firstCls]);
  const cr = await q(`select classes_required from prep_cycles where cycle_id = $1`, [c1.cycle_id]);
  ok(ce[0].classes_attended === 10 && cr[0].classes_required === 12, 'classes are recorded for each student (typed, + and −), and the cycle can require a number');
  const dash2 = await page.textContent('#view-dashboard');
  ok(dash2.includes('Below the classes needed') && /0 of 12 classes|10 of 12 classes/.test(dash2), 'students below the classes required are counted and listed under Needs attention');
  await page.click('#view-dashboard .item:has-text("of 12 classes")'); await page.waitForSelector('#clsForm');
  ok((await page.$$('#clsForm [data-cls]')).length === 1, 'tapping one opens just that student');
  await page.click('#clsForm [data-close]'); await page.waitForSelector('#sheet:not([open])', { state: 'attached' }); await page.waitForTimeout(200);
  // Import: names (any order of first and last) with a number
  const enr = await q(`select s.student_id, s.full_name from prep_enrolments e join prep_students s using (student_id) where e.cycle_id = $1 order by s.full_name limit 2`, [c1.cycle_id]);
  const [fA, ...lA] = enr[0].full_name.split(' ');
  await page.click('#dashClassesImp'); await page.waitForSelector('#impText');
  await page.fill('#impText', `Name,Classes\n"${lA.join(' ')}, ${fA}",15\n${enr[1].full_name},7\nZed Unknown,3`);
  await page.waitForSelector('#impPreview table');
  const pv = await page.textContent('#impPreview');
  ok(pv.includes('2 to update') && pv.includes('Not in the register'), 'importing classes matches names (Last, First too) and skips unknown names');
  await page.click('#impPreview [data-clsmode="add"]');
  const pvAdd = await page.textContent('#impPreview');
  await page.click('#impPreview [data-clsmode="set"]');
  await page.click('#impGo'); await confirm(page); await page.waitForSelector('#impText', { state: 'detached', timeout: 5000 }).catch(() => {}); await page.waitForTimeout(400);
  const im = await q(`select student_id, classes_attended from prep_enrolments where cycle_id = $1 and student_id = any($2)`, [c1.cycle_id, enr.map(e => e.student_id)]);
  ok(im.find(r => r.student_id === enr[0].student_id).classes_attended === 15 && im.find(r => r.student_id === enr[1].student_id).classes_attended === 7, 'the imported numbers replace the totals');
  ok(/→/.test(pvAdd), 'or can be added to the totals');
  await page.click('#dashClassesImp'); await page.waitForSelector('#impText');
  await page.fill('#impText', `${enr[1].full_name}\t3`); await page.waitForSelector('#impPreview table');
  await page.click('#impPreview [data-clsmode="add"]'); await page.click('#impGo'); await confirm(page); await page.waitForTimeout(600);
  ok((await q(`select classes_attended from prep_enrolments where cycle_id = $1 and student_id = $2`, [c1.cycle_id, enr[1].student_id]))[0].classes_attended === 10, 'a pasted list without headings works, and Add to the totals adds');
  // Filters: enough and not enough classes (the cycle needs 12 here)
  await page.waitForSelector('#sheet:not([open])', { state: 'attached' }); await page.waitForTimeout(200);
  await page.click('#view-dashboard [data-clsgo="short"]'); await page.waitForSelector('#clsForm');
  const vis = async () => page.$$eval('#clsList li[data-name]', ls => ls.filter(l => !l.hidden).map(l => l.dataset.name));
  let shown = await vis();
  ok(shown.includes(enr[1].full_name.toLowerCase()) && !shown.includes(enr[0].full_name.toLowerCase()), '"Below the classes needed" opens the list showing just those without enough');
  await page.click('#clsForm [data-clsshow="enough"]'); shown = await vis();
  ok(shown.includes(enr[0].full_name.toLowerCase()) && !shown.includes(enr[1].full_name.toLowerCase()), 'and Enough classes shows the others');
  await page.click('#clsForm [data-close]'); await page.waitForSelector('#sheet:not([open])', { state: 'attached' }); await page.waitForTimeout(200);
  await tab(page, 'students');
  await page.selectOption('#studentClasses', 'short');
  let sl = await page.textContent('#studentList');
  ok(sl.includes(enr[1].full_name) && !sl.includes(enr[0].full_name) && sl.includes('10/12 classes'), 'the Students list filters by not enough classes, and shows each count');
  await page.selectOption('#studentClasses', 'enough'); sl = await page.textContent('#studentList');
  ok(sl.includes(enr[0].full_name) && !sl.includes(enr[1].full_name), 'and by enough classes');
  await page.selectOption('#studentClasses', '');
  // Sorting
  const names = async () => page.$$eval('#studentList .name', ns => ns.map(n => n.textContent));
  await page.selectOption('#studentSort', 'namez'); let nm = await names();
  ok(nm.join() === nm.slice().sort((a, b) => b.localeCompare(a)).join(), 'students can be sorted Z to A');
  await page.selectOption('#studentSort', 'clsmost'); nm = await names();
  ok(nm.indexOf(enr[0].full_name) < nm.indexOf(enr[1].full_name), 'and by most classes (15 before 10)');
  await page.selectOption('#studentSort', 'clsleast'); nm = await names();
  ok(nm.indexOf(enr[1].full_name) < nm.indexOf(enr[0].full_name), 'and by fewest classes');
  await page.selectOption('#studentSort', 'name');
  await tab(page, 'dashboard');
  await page.click('#dashClasses'); await page.waitForSelector('#clsSort');
  await page.fill(`#clsForm [data-cls="${enr[1].student_id}"]`, '40');
  await page.selectOption('#clsSort', 'clsmost');
  const first = await page.$eval('#clsList li[data-id]', li => li.dataset.id);
  ok(first === enr[1].student_id, 'the Record classes list sorts too, using the numbers typed in');
  await page.click('#clsForm [data-close]'); await page.waitForSelector('#sheet:not([open])', { state: 'attached' }); await page.waitForTimeout(200);
  await tab(page, 'students');
  ok((await page.textContent('#studentList')).includes('Dan no. 501'), 'student list shows Dan numbers');
  await tab(page, 'dashboard');
  await shot(page, 'dashboard');

  // ------------------------------------------------------------------
  console.log('\nNew cycle keeps history');
  const before = await q(`select attendance_id, status from prep_attendance where cycle_id = $1 order by 1`, [c1.cycle_id]);
  await tab(page, 'cycles');
  await page.click('#newCycleBtn');
  await page.fill('#ncName', 'Term 1 2027'); await page.fill('#ncS1', '2027-02-08'); await page.dispatchEvent('#ncS1', 'change');
  await page.check('[name=ncWho][value=pick]');
  await page.check('#ncList input[value="BB0001"]'); await page.check('#ncList input[value="M-0042"]');
  ok((await page.textContent('#ncActHint')).includes('Term 4 2026 will be marked Completed'), 'warns that the current cycle will be completed');
  await page.click('#ncGo'); const rv2 = await confirm(page);
  ok(rv2.includes('2 students enrolled') && rv2.includes('Term 4 2026 is marked Completed'), 'review lists chosen students and the cycle being completed');
  await page.waitForFunction(() => document.querySelector('#cyclePillText').textContent === 'Term 1 2027');
  const after = await q(`select attendance_id, status from prep_attendance where cycle_id = $1 order by 1`, [c1.cycle_id]);
  ok(JSON.stringify(before) === JSON.stringify(after), 'previous cycle attendance unchanged');
  ok((await q(`select status from prep_cycles where cycle_id = $1`, [c1.cycle_id]))[0].status === 'completed', 'previous cycle marked completed');
  await page.click('[data-cycle]:has-text("Term 1 2027")');
  await page.click('#cyEnrol'); await page.check('#enList input[value="BB0002"]'); await page.click('#enGo'); await settle(page);
  ok((await q(`select count(*)::int n from prep_attendance a join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and a.student_id = 'BB0002'`))[0].n === 4, 'student added mid-cycle gets attendance for every session');
  await page.click('[data-unenrol="BB0002"]'); await confirm(page); await settle(page);
  ok((await q(`select count(*)::int n from prep_enrolments e join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and e.student_id = 'BB0002'`))[0].n === 0, 'student added by mistake can be removed');
  await page.click('#sheet [data-close]');
  await tab(page, 'students'); await page.click('#studentList [data-student="BB0001"]');
  ok((await page.textContent('#sheet')).includes('Fee option'), 'student record shows the fee option');
  await page.selectOption('#sheet [data-plan]', 'upfront'); await settle(page);
  const t1 = (await q(`select c.cycle_id from prep_cycles c where c.name = 'Term 1 2027'`))[0].cycle_id;
  ok((await q(`select payment_plan, amount_due::text a from prep_payments where student_id = 'BB0001' and cycle_id = $1`, [t1]))[0].payment_plan === 'upfront', 'per session is the default; switched this student to upfront');
  const t4 = (await q(`select p.amount_due::text a from prep_payments p join prep_cycles c using (cycle_id) where c.name = 'Term 4 2026' and p.student_id = 'BB0001'`))[0].a;
  ok(t4 === '180.00', 'earlier cycle fee unchanged (per session: 3 sessions present x $60)');
  const hist = await page.textContent('#sheet');
  ok(hist.includes('Current cycle') && hist.includes('History') && hist.includes('Term 4 2026'), 'student record shows current cycle and history');
  await shot(page, 'student-detail');
  await page.click('#sheet [data-close]');

  // ------------------------------------------------------------------
  console.log('\nAddresses');
  await tab(page, 'students'); await tab(page, 'more');
  ok(page.url().endsWith('#more'), 'More has its own address (#more)');
  await page.goBack(); await page.waitForFunction(() => !document.querySelector('#view-students').hidden, null, { timeout: 5000 }).catch(() => {});
  ok(page.url().endsWith('#students') && await page.isVisible('#view-students'), 'the back button goes back to the last screen');
  await page.goto(BASE + '/#cycles'); await page.waitForSelector('#view-cycles:not([hidden])', { timeout: 8000 }).catch(() => {});
  ok(await page.isVisible('#view-cycles') && (await page.textContent('#view-cycles')).includes('Preparation cycles'), 'opening an address (#cycles) goes straight to that screen');
  await page.goto(BASE + '/#student/BB0001'); await page.waitForSelector('#sheet[open]', { timeout: 8000 }).catch(() => {});
  ok((await page.textContent('#sheet')).includes('Alex Smith') && page.url().includes('#student/BB0001'), 'a student has their own address too (#student/BB0001)');
  await page.click('#sheet [data-close]'); await page.waitForSelector('#sheet:not([open])', { state: 'attached' }); await page.waitForTimeout(200);
  ok(page.url().endsWith('#students'), 'closing the student goes back to the screen address');
  console.log('\nSettings and users');
  await tab(page, 'more');
  await page.waitForSelector('#auditList');
  ok(await page.inputValue('#setDan0') === '504' && await page.inputValue('#setDan1') === '701' && await page.inputValue('#setDan2') === '', 'settings show a next Dan number for each rank (Probationary 504, 1st Dan 701, 2nd Dan not set)');
  await page.fill('#setDan2', '301');
  ok(!(await page.$('#setInv')) && !(await page.$('#setFee')), 'old settings (fees due on joining, single session fee) are gone');
  await page.fill('#setReq', '3'); await page.click('#setForm button[type=submit]'); await settle(page);
  ok((await q(`select sessions_required from prep_settings`))[0].sessions_required === 3, 'settings saved');
  ok((await q(`select next_number from prep_dan_counters where target_rank = '2nd Dan'`))[0]?.next_number === 301, 'next number for 2nd Dan saved');
  // Classes needed for each belt
  const pick = await page.evaluate(cid => { for (const id of enrolledIds(cid)) { const s = student(id), nb = s && nextBelt(s.belt_rank); if (nb) return { id, name: s.full_name, nb, have: classesOf(cid, id) }; } return null; }, c1.cycle_id);
  ok(!!pick && (await page.$$('#setForm [data-creq]')).length > 20, 'settings list classes needed for each belt');
  if (pick) {
    if (!await page.isVisible(`#setForm [data-creq="${pick.nb}"]`)) await page.click('#setForm summary:has-text("Classes needed for each belt")');
    await page.fill(`#setForm [data-creq="${pick.nb}"]`, String(pick.have + 5)); await page.click('#setForm button[type=submit]'); await settle(page);
    ok((await q(`select classes from prep_class_requirements where target_rank = $1`, [pick.nb]))[0]?.classes === pick.have + 5, `the classes needed for ${pick.nb} are saved`);
    await tab(page, 'dashboard');
    ok((await page.textContent('#view-dashboard')).includes(`${pick.have} of ${pick.have + 5} classes`), `${pick.name} (going for ${pick.nb}) is measured against that belt's number, not the cycle's`);
    await tab(page, 'more');
  }
  ok((await page.getAttribute('#view-more a[href="/staff/"]', 'href')) === '/staff/', 'who can do what is set on Staff logins (linked from Settings)');
  await page.waitForSelector('#auditList table');
  const audit = await page.textContent('#auditList');
  ok(audit.includes('Attendance:') || audit.includes('Classes attended:'), 'recent changes list shows attendance changes');
  ok(audit.includes('Classes attended: 7 → 10'), 'and changes to classes attended');

  // ------------------------------------------------------------------
  console.log('\nEssays');
  {
    const PBB = '1st Dan Black Belt';   // essays are for the Dans (Probationary Black Belt has none)
    if (!await page.isVisible(`#setForm [data-eq="${PBB}"]`)) await page.click('#setForm summary:has-text("Essay questions")');
    await page.fill(`#setForm [data-eq="${PBB}"]`, 'What does being a black belt mean to you?');
    await page.fill(`#setForm [data-eqmin="${PBB}"]`, '5');
    await page.click('#setForm button[type=submit]'); await settle(page);
    const eq = (await q(`select question, min_words from prep_essay_questions where target_rank = $1`, [PBB]))[0];
    ok(eq && eq.question.startsWith('What does being') && eq.min_words === 5, 'admins set the essay question and minimum words for each belt');
    const escy = await page.evaluate(() => (currentCycle() || {}).cycle_id);
    await q(`update prep_cycles set essay_due = current_date + 5 where cycle_id = $1`, [escy]);
    await page.evaluate(() => loadAll());
    await page.click('[data-goto="essays"]'); await page.waitForSelector('#esList');
    const esText = await page.textContent('#view-essays');
    await q(`insert into prep_students (student_id, full_name, belt_rank) values ('ES-001', 'Essay Writer', 'Probationary Black Belt')`);
    await q(`insert into prep_enrolments (cycle_id, student_id) values ($1, 'ES-001')`, [escy]);
    await page.evaluate(() => loadAll().then(() => renderEssays()));
    const writer = { student_id: 'ES-001', full_name: 'Essay Writer' };
    const esText2 = await page.textContent('#view-essays');
    const choDanBo = (await q(`select s.full_name from prep_enrolments e join prep_students s using (student_id) where e.cycle_id = $1 and s.belt_rank = 'Cho Dan Bo' limit 1`, [escy]))[0];
    ok(esText2.includes(writer.full_name) && esText2.includes('Not handed in') && !esText2.includes('Taylor Brown') && (!choDanBo || !esText2.includes(choDanBo.full_name)), 'Essays lists the students going for a Dan (not Probationary Black Belt), not handed in yet');
    await page.click(`#esList [data-essay="${writer.student_id}"]`); await page.waitForSelector('#esMsg');
    ok(await page.evaluate(() => state.es.cycle) === escy, 'it opens on the active cycle');
    const tok = ((await q(`select token from prep_essays where cycle_id = $1 and student_id = $2`, [escy, writer.student_id]))[0] || {}).token;
    const url = await page.evaluate(t => essayUrl(t), tok);
    ok(/\/e\/#[A-Za-z0-9_-]{8,}$/.test(url) && (await page.textContent('#sheet')).includes('What does being a black belt mean to you?'), 'opening a student makes their personal link and shows the question');
    await page.click('#sheet [data-close]'); await page.waitForSelector('#sheet:not([open])', { state: 'attached' }); await page.waitForTimeout(200);
    // The student opens their link (no login)
    const st = await open(null), sp = st.page;
    const uploads = [];
    await st.ctx.route(`${BASE}/storage/v1/object/prep-essays/**`, r => { uploads.push(new URL(r.request().url()).pathname); return r.fulfill({ contentType: 'application/json', body: '{"Key":"x"}' }); });
    await sp.goto(BASE + '/essay/index.html#t=' + tok); await sp.waitForSelector('#essay:not([hidden])');
    const ep = await sp.textContent('#essay');
    ok(ep.includes('Hi ' + writer.full_name.split(' ')[0]) && ep.includes('What does being a black belt mean to you?') && ep.includes('At least 5 words') && ep.includes('5 days to go'), 'the link greets them and shows the question, minimum words and due date');
    await sp.fill('#body', 'Black belt means respect');
    ok((await sp.textContent('#count')).includes('4 words (at least 5)'), 'it counts the words as they type');
    await sp.fill('#body', 'Black belt means respect, courage and helping others');
    await sp.setInputFiles('#file', { name: 'my essay.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
    await sp.click('#go'); await sp.waitForSelector('#status .banner');
    ok((await sp.textContent('#status')).includes('Handed in') && uploads.some(u => u.includes('/prep-essays/' + tok + '/')), 'they hand in text and a file (uploaded into their own folder)');
    let row = (await q(`select status, word_count, file_name, version from prep_essays where token = $1`, [tok]))[0];
    ok(row.status === 'submitted' && row.word_count === 8 && row.file_name === 'my essay.pdf' && row.version === 1, 'it is saved as handed in, with the word count and file');
    await sp.goto('about:blank'); await sp.goto(BASE + '/essay/index.html#t=nope'); await sp.waitForSelector('#bad:not([hidden])');
    ok(true, 'a wrong link says it is not right');
    // Marking: send back with feedback
    await page.evaluate(() => loadAll().then(render));
    await page.click('#view-essays [data-esf="submitted"]'); await page.waitForSelector(`#esList [data-essay="${writer.student_id}"]`);
    await page.click(`#esList [data-essay="${writer.student_id}"]`); await page.waitForSelector('#esMark');
    ok((await page.textContent('#sheet')).includes('Black belt means respect, courage and helping others') && (await page.textContent('#sheet')).includes('Open file: my essay.pdf'), 'staff read the essay and can open the file');
    await page.click('#esBack');
    ok((await toastText(page)).includes('feedback'), 'sending back needs feedback');
    await page.fill('#esFeedback', 'Tell us about a time you showed courage'); await page.click('#esBack'); await settle(page);
    row = (await q(`select status, feedback, reviewed_by from prep_essays where token = $1`, [tok]))[0];
    ok(row.status === 'needs_changes' && row.feedback.startsWith('Tell us') && row.reviewed_by === 'owner@ama.test', 'it is sent back with feedback');
    await sp.goto('about:blank'); await sp.goto(BASE + '/essay/index.html#t=' + tok); await sp.waitForSelector('#status .banner');
    ok((await sp.textContent('#status')).includes('sent it back') && (await sp.textContent('#status')).includes('Tell us about a time you showed courage') && (await sp.inputValue('#body')).includes('helping others'), 'the student sees the feedback, with their essay ready to change');
    await sp.fill('#body', 'Black belt means respect, courage and helping others. Once I helped a new student.');
    await sp.click('#go'); await sp.waitForFunction(() => document.querySelector('#status').textContent.includes('Handed in'));
    row = (await q(`select status, version, file_name from prep_essays where token = $1`, [tok]))[0];
    ok(row.status === 'submitted' && row.version === 2 && row.file_name === 'my essay.pdf', 'they hand it in again (keeping the file)');
    // Marked
    await page.click('#sheet [data-close]'); await page.waitForSelector('#sheet:not([open])', { state: 'attached' }); await page.waitForTimeout(200);
    await page.evaluate(() => loadAll().then(render));
    await page.click('#view-essays [data-esf="submitted"]'); await page.click(`#esList [data-essay="${writer.student_id}"]`);
    await page.waitForSelector('#esMark');
    ok((await page.textContent('#sheet')).includes('Earlier versions (1)'), 'staff see the earlier version');
    // A nice PDF: AMA logo, their full name, the question, the essay, then their uploaded PDF
    {
      const { PDFDocument } = await import('pdf-lib');
      const up = await PDFDocument.create(); up.addPage([595, 842]).drawText('Their uploaded page', { x: 60, y: 760, size: 24 });
      const upBytes = Buffer.from(await up.save());
      const pctx = page.context();
      await pctx.route('https://cdnjs.cloudflare.com/ajax/libs/jspdf/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(here, 'node_modules/jspdf/dist/jspdf.umd.min.js')) }));
      await pctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(here, 'node_modules/pdf-lib/dist/pdf-lib.min.js')) }));
      await pctx.route(`${BASE}/storage/v1/object/sign/**`, r => r.request().method() === 'POST'
        ? r.fulfill({ contentType: 'application/json', body: JSON.stringify({ signedURL: '/object/sign/prep-essays/file?token=t' }) })
        : r.fulfill({ contentType: 'application/pdf', body: upBytes }));
      ok(await page.isVisible('#esPdf'), 'the essay has a PDF button');
      const b64 = await page.evaluate(async ([cid, sid]) => { const t = await pdfTools(); const d = await essayPdfBytes(cid, sid, t); const b = await d.save(); let s = ''; b.forEach(x => s += String.fromCharCode(x)); return btoa(s); }, [escy, writer.student_id]);
      const pdf = await PDFDocument.load(Buffer.from(b64, 'base64'));
      const { writeFileSync } = await import('node:fs'); writeFileSync(join(SHOTS, 'essay.pdf'), Buffer.from(b64, 'base64'));
      ok(pdf.getPageCount() === 2, 'the PDF has the essay page, then their uploaded PDF (' + pdf.getPageCount() + ' pages)');
      const raw = Buffer.from(b64, 'base64').toString('latin1');
      ok(raw.includes('/Image') || raw.includes('/XObject'), 'with the AMA logo');
      const popup = pctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
      await page.click('#esPdf'); const pp = await popup;
      ok(!!pp && (await toastText(page)).includes('PDF'), 'the PDF button opens it');
      if (pp) await pp.close();
    }
    await page.fill('#esMarkVal', 'Pass'); await page.fill('#esFeedback', 'Great improvement'); await page.click('#esDone'); await settle(page);
    await sp.goto('about:blank'); await sp.goto(BASE + '/essay/index.html#t=' + tok); await sp.waitForSelector('#status .banner');
    ok((await sp.textContent('#status')).includes('marked: Pass') && await sp.isDisabled('#body') && await sp.isDisabled('#go'), 'once marked, the student sees the mark and can no longer change it');
    await st.ctx.close();
    await page.click('#sheet [data-close]'); await page.waitForSelector('#sheet:not([open])', { state: 'attached' }); await page.waitForTimeout(200);
    await tab(page, 'dashboard');
    const d = await page.textContent('#view-dashboard');
    ok(d.includes('Essays') && d.includes('Not handed in') && d.includes('To mark') && d.includes('Marked'), 'the dashboard counts essays');
    await tab(page, 'students');
    ok((await page.textContent('#studentList [data-student="ES-001"]')).includes('Essay in'), 'the student list shows a green "Essay in" badge once the essay is marked');
    await tab(page, 'dashboard');
    await q(`update prep_essays set status = 'not_submitted' where student_id = 'ES-001'`).catch(() => {});
    await q(`alter table prep_essays disable trigger prep_essay_mark_guard`); await q(`update prep_essays set status = 'not_submitted' where student_id = 'ES-001'`); await q(`alter table prep_essays enable trigger prep_essay_mark_guard`);
    await page.evaluate(() => loadAll().then(render));
    ok((await page.textContent('#view-dashboard')).includes('Essay not handed in'), 'and lists those not handed in as the due date nears');
    await tab(page, 'students');
    ok(await page.$('#studentList [data-student="ES-001"] .tag.bad:has-text("No essay")'), '...and a red "No essay" badge when a student going for a Dan has not handed one in');
    await tab(page, 'more'); await page.waitForSelector('#auditList');
    for (const t of ['prep_dan_numbers', 'prep_enrolments', 'prep_students']) await q(`delete from ${t} where student_id = 'ES-001'`);
    await page.evaluate(() => loadAll().then(render)); await page.waitForSelector('#auditList');
  }
  await page.evaluate(() => document.querySelector('#setForm .section').scrollIntoView()); await shot(page, 'more');
  await ctx.close();

  // ------------------------------------------------------------------
  console.log('\nGrading fees');
  {
    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'more'); await page.waitForSelector('#setForm');
    ok((await page.$$('#setForm [data-gfee]')).length === 25, 'Settings has a grading fee for each belt (25)');
    await page.fill('[data-gfee="Probationary Black Belt"]', '150'); await page.fill('[data-gfee="1st Dan Level 1"]', '90');
    await page.click('#setForm button[type=submit]'); await settle(page);
    ok((await q(`select fee::text f from prep_grading_fee_rates where target_rank = 'Probationary Black Belt'`))[0]?.f === '150.00', 'grading fee saved for Probationary Black Belt');
    await tab(page, 'cycles'); await page.click('[data-cycle]:has-text("Term 1 2027")');
    ok((await page.textContent('#sheet')).includes('Decide who grades on the Grading screen'), 'cycle points to the Grading screen');
    await page.click('#cyGrading');
    await page.waitForSelector('#grListItems [data-gr="BB0001"]');
    await page.click('#grListItems [data-gr="BB0001"]');
    ok((await page.textContent('#sheet')).includes('Not met'), 'grading record shows what is not met (attendance, readiness)');
    ok(!(await page.$('[name=grDec]')) && !(await page.$('#grDecSave')), 'there is no separate eligibility step');
    await page.evaluate(() => toast('Layer check', 5000));
    const onTop = await page.evaluate(() => { const t = document.querySelector('#toast'), r = t.getBoundingClientRect();
      return t.matches(':popover-open') && document.querySelector('#sheet').open && r.left >= 0 && r.right <= innerWidth && r.top > innerHeight / 2 && r.bottom <= innerHeight; });
    ok(onTop, 'notifications show in the top layer, above an open window, near the bottom of the screen');
    ok((await page.textContent('#sheet')).includes('$150'), 'Put forward shows the grading fee it will charge');
    await page.click('#grPut');
    ok((await toastText(page)).includes('Give a reason'), 'putting forward without meeting requirements needs a reason');
    await page.fill('#grReason', 'Head instructor approved'); await page.click('#grPut'); await confirm(page); await settle(page);
    const dec = (await q(`select g.eligibility_decision, g.decision_reason, g.decided_by, g.attendance_eligible, g.target_rank from prep_grading g join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and g.student_id = 'BB0001'`))[0];
    ok(dec && dec.eligibility_decision === 'eligible' && dec.decision_reason === 'Head instructor approved' && dec.attendance_eligible === false && dec.target_rank === 'Probationary Black Belt',
       'one button marks them eligible, with the reason and the attendance at the time');
    const gf = (await q(`select p.amount_due::text a, p.due_date::text d, p.target_rank, c.grading_date::text g from prep_payments p join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and p.student_id = 'BB0001' and p.kind = 'grading'`))[0];
    ok(gf && gf.a === '150.00' && gf.target_rank === 'Probationary Black Belt', 'ticking a Cho Dan Bo student charges the Probationary grading fee ($150)');
    ok(gf && gf.d === addDaysIso(gf.g, -21), 'grading fee due 3 weeks before the grading date');
    await page.waitForSelector('#sheet [data-res="passed"]');
    ok((await page.textContent('#sheet')).includes('Put forward'), 'grading record shows they are put forward');
    await page.click('#sheet [data-close]');
    await tab(page, 'students'); await page.click('#studentList [data-student="BB0001"]');
    const rec = await page.textContent('#sheet');
    ok(rec.includes('Yes, to Probationary Black Belt') && rec.includes('Grading fee'), 'student record shows grading and the grading fee');
    await page.click('#sheet [data-gpay]'); await page.selectOption('#gpMethod', 'bank_transfer'); await page.click('#gpGo'); await settle(page);
    ok((await q(`select s.status from prep_payment_summary s join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and s.student_id = 'BB0001' and s.kind = 'grading'`))[0].status === 'paid', 'grading fee payment recorded; fee shows as paid');
    await shot(page, 'grading-fee');
    await page.click('#sheet [data-close]');
    await tab(page, 'dashboard');
    ok((await page.textContent('#view-dashboard')).includes('Grading'), 'dashboard shows how many are grading');
    await ctx.close();
  }

  console.log('\nUpfront payment from the attendance screen');
  {
    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'attendance');
    await page.click('#attBody [data-session="1"]');
    ok(!(await page.isDisabled('.att .pay[data-pay="BB0001"]')), 'upfront student can pay before attendance is recorded');
    await page.click('.att .pay[data-pay="BB0001"]');
    const upTxt = await confirm(page); await settle(page);
    ok(upTxt.includes('$200 upfront') && upTxt.includes('covers all 4 sessions'), 'tapping $ for an upfront student records the $200 upfront fee after confirming');
    const up = (await q(`select s.amount_paid::text p, s.status from prep_payment_summary s join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and s.student_id = 'BB0001' and s.kind = 'sessions'`))[0];
    ok(up.p === '200.00' && up.status === 'paid', 'upfront fee paid in full');
    for (const n of [2, 3, 4]) {
      await page.click(`#attBody [data-session="${n}"]`);
      if (await page.getAttribute('.att .pay[data-pay="BB0001"]', 'aria-pressed') !== 'true') { ok(false, `session ${n} shows paid`); break; }
    }
    ok(true, 'every session then shows as paid');
    ok((await q(`select count(*)::int n from prep_attendance a join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and a.student_id = 'BB0001' and a.status <> 'not_recorded'`))[0].n === 0, 'attendance is left to be recorded separately');
    await ctx.close();
  }

  console.log('\nMark several as paid');
  {
    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'attendance');
    await page.click('#attBody [data-session="2"]');
    // Term 1 2027 session 2: Riley and the Oops-free students; mark Riley present first (per session)
    await page.click('.att button[data-id="M-0042"][data-s="present"]'); await settle(page);
    await page.click('#attSelect');
    await page.click('#selAll');
    ok(await page.isVisible('#bulkPaid'), 'selection bar has a Paid button');
    await page.click('#bulkPaid');
    await page.waitForSelector('#askDlg[open]');
    const pt = await page.textContent('#askText');
    ok(pt.includes('1 × $60 for session 2') && pt.includes('Skipped') && pt.includes('already paid'), 'confirmation lists who is charged and who is skipped (Alex already paid upfront)');
    await page.click('#askYes'); await page.waitForSelector('#askDlg:not([open])', { state: 'attached' }); await settle(page);
    const rp = await q(`select count(*)::int n from prep_payment_transactions t join prep_sessions s using (session_id) join prep_cycles c on c.cycle_id = s.cycle_id where c.name = 'Term 1 2027' and s.session_number = 2 and t.student_id = 'M-0042' and t.type = 'payment'`);
    ok(rp[0].n === 1, 'Riley recorded as paid $60 for session 2');
    ok(await page.isHidden('#selbar'), 'selection closes after recording');
    await ctx.close();
  }

  console.log('\nQuick check-in');
  {
    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'attendance');
    await page.click('#attCheckin'); await page.waitForSelector('#view-checkin:not([hidden]) #ciSearch');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ciSearch', null, { timeout: 2000 }).catch(() => {});
    ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'ciSearch'), 'Check in opens with the search box ready to type');
    const s3 = (await q(`select s.session_id from prep_sessions s join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and s.session_number = 3`))[0].session_id;
    await page.selectOption('#ciSession', s3);
    const who = (await q(`select st.student_id, st.full_name from prep_attendance a join prep_students st using (student_id) where a.session_id = $1 and a.status <> 'present' order by st.full_name`, [s3]));
    ok(who.length >= 2, 'there are students to check in for session 3');
    const [first, last] = who[0].full_name.split(' ');
    await page.fill('#ciSearch', `${first.slice(0, 3)} ${last.slice(0, 2)}`);
    ok(new Set(await page.$$eval('#ciList [data-ci]', bs => bs.map(b => b.dataset.ci))).size === 1, 'typing part of a first and last name narrows to one person');
    await page.press('#ciSearch', 'Enter'); await settle(page);
    const st = async id => (await q(`select status from prep_attendance where session_id = $1 and student_id = $2`, [s3, id]))[0].status;
    ok(await st(who[0].student_id) === 'present', 'Enter checks in the only match');
    ok((await page.inputValue('#ciSearch')) === '' && await page.evaluate(() => document.activeElement.id === 'ciSearch'), 'search clears and is ready for the next person');
    ok((await page.textContent('#ciHere')).includes(who[0].full_name) && /\d+ of \d+/.test(await page.textContent('#ciCount')), 'they move to the Here list and the count goes up');
    await page.click(`#ciHere [data-ciundo="${who[0].student_id}"]`); await settle(page);
    ok(await st(who[0].student_id) === 'not_recorded', 'a check-in can be undone with one tap');
    const paidTx = async id => (await q(`select count(*)::int n from prep_payment_transactions where student_id = $1`, [id]))[0].n;
    const txBefore = await paidTx(who[1].student_id);
    await page.click(`#ciList [data-ci="${who[1].student_id}"][data-pay="0"]`); await settle(page);
    ok(await st(who[1].student_id) === 'present', 'tapping Unpaid on the list checks them in without typing');
    ok(await paidTx(who[1].student_id) === txBefore, 'Unpaid records no payment');
    // Paid: check in and record the payment in one tap
    await page.click(`#ciHere [data-ciundo="${who[1].student_id}"]`); await settle(page);
    await page.waitForSelector(`#ciList [data-ci="${who[1].student_id}"]`, { timeout: 5000 });
    const btns = await page.$$eval(`#ciList [data-ci="${who[1].student_id}"]`, bs => bs.map(b => b.dataset.pay + ':' + b.textContent.trim()));
    if (btns.some(b => b.startsWith('1:'))) {
      ok(btns.some(b => /^1:Paid\$\d+/.test(b)) && btns.some(b => b === '0:Unpaid'), 'each person has a Paid button (with the amount) and an Unpaid button');
      await shot(page, 'check-in-buttons');
      const before = await paidTx(who[1].student_id);
      await page.click(`#ciList [data-ci="${who[1].student_id}"][data-pay="1"]`); await settle(page);
      ok(await st(who[1].student_id) === 'present' && await paidTx(who[1].student_id) === before + 1, 'Paid checks them in and records the payment');
      await page.waitForSelector(`#ciHere [data-cipay="${who[1].student_id}"][aria-pressed="true"]`, { timeout: 5000 }).catch(() => {});
      ok(await page.isVisible(`#ciHere [data-cipay="${who[1].student_id}"][aria-pressed="true"]`), 'Here list shows them as paid');
      await page.click(`#ciHere [data-cipay="${who[1].student_id}"]`); await confirm(page); await settle(page);   // undo, so later payment checks are unchanged
    } else ok(btns.some(b => b.startsWith('0:Check in')), 'someone already paid gets a single Check in button');
    const outsider = (await q(`select st.student_id, st.full_name from prep_students st where st.is_active and not st.is_test and not exists (select 1 from prep_enrolments e join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and e.student_id = st.student_id) order by 1 limit 1`))[0];
    if (outsider) {
      await page.fill('#ciSearch', outsider.full_name.split(' ')[0]);
      await page.waitForSelector(`#ciList [data-ciadd="${outsider.student_id}"]`);
      ok((await page.textContent('#ciList')).includes('Not in this cycle'), 'someone not in the cycle shows as Not in this cycle');
      await page.click(`#ciList [data-ciadd="${outsider.student_id}"]`); await confirm(page); await settle(page);
      ok(await st(outsider.student_id) === 'present', 'an admin can add them to the cycle and check them in');
      await q(`delete from prep_enrolments e using prep_cycles c where c.cycle_id = e.cycle_id and c.name = 'Term 1 2027' and e.student_id = $1`, [outsider.student_id]); // leave the cycle as later tests expect
    }
    // Owing: shown for anyone with unpaid fees (admins and the Payments role only)
    const debtor = (await q(`select ps.student_id, st.full_name, sum(ps.balance)::numeric b from prep_payment_summary ps join prep_students st using (student_id)
      join prep_enrolments e on e.student_id = ps.student_id join prep_cycles c on c.cycle_id = e.cycle_id and c.name = 'Term 1 2027'
      where ps.balance > 0 and ps.status not in ('waived','refunded','not_invoiced') group by 1, 2 order by 2 limit 1`))[0];
    const paidUp = (await q(`select e.student_id from prep_enrolments e join prep_cycles c on c.cycle_id = e.cycle_id and c.name = 'Term 1 2027'
      where not exists (select 1 from prep_payment_summary ps where ps.student_id = e.student_id and ps.balance > 0 and ps.status not in ('waived','refunded','not_invoiced')) limit 1`))[0];
    await tab(page, 'attendance'); await page.click('#attCheckin'); await page.waitForSelector('#ciSearch');
    await page.selectOption('#ciSession', s3);
    ok(!!debtor, 'test data has someone owing fees');
    if (debtor) {
      const sel = `#view-checkin li:has([data-ci="${debtor.student_id}"]), #view-checkin li:has([data-ciundo="${debtor.student_id}"])`;
      await page.waitForSelector(sel);
      ok((await page.textContent(sel)).includes(`Owes $${Number(debtor.b)}`), `someone with unpaid fees shows "Owes $${Number(debtor.b)}" at check-in`);
    }
    if (paidUp) {
      const sel = `#view-checkin li:has([data-ci="${paidUp.student_id}"]), #view-checkin li:has([data-ciundo="${paidUp.student_id}"])`;
      if (await page.$(sel)) ok(!(await page.textContent(sel)).includes('Owes'), 'no owing note for someone fully paid');
    }
    await shot(page, 'check-in-owing');
    await ctx.close();
  }
  {
    const { ctx, page } = await open('att@ama.test');
    await tab(page, 'attendance');
    await page.click('#attCheckin'); await page.waitForSelector('#ciSearch');
    await page.fill('#ciSearch', 'zzz');
    ok(!(await page.$('#ciList [data-ciadd]')), 'attendance recorders can check people in but not add them to a cycle');
    await page.fill('#ciSearch', '');
    ok(!(await page.$('#view-checkin .owes')), 'attendance recorders never see what anyone owes');
    await ctx.close();
  }

  console.log('\nReadiness');
  {
    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'readiness');
    ok((await page.textContent('#view-readiness')).includes('Never marks anyone ready') || (await page.textContent('#view-readiness')).includes('never marks anyone ready'), 'readiness screen explains it is separate from attendance');
    ok((await page.$$('#rdList [data-rd]')).length >= 2, 'readiness lists the students in the active cycle');
    await page.click('#rdList [data-rd="M-0042"]'); await page.waitForSelector('#rdForm');
    await page.check('#rdForm [name=rdStatus][value=not_ready]');
    await page.click('#rdSave');
    ok((await toastText(page)).includes('Choose a reason'), 'flagging not ready requires a reason');
    ok((await page.$$eval('#rdReason option', os => os.map(o => o.textContent))).includes('Needs more time at current belt'), 'not ready can be because they need more time at their current belt');
    await page.selectOption('#rdReason', 'technique'); await page.fill('#rdNotes', 'Poomsae timing'); await page.fill('#rdNext', 'Extra class');
    await page.click('#rdSave'); await settle(page);
    const rr = (await q(`select r.status, r.reason, r.notes, r.next_action, r.reviewed_by from prep_readiness r join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and r.student_id = 'M-0042'`))[0];
    ok(rr.status === 'not_ready' && rr.reason === 'technique' && rr.notes === 'Poomsae timing' && rr.next_action === 'Extra class' && rr.reviewed_by === 'owner@ama.test', 'not ready saved with reason, notes, next action and reviewer');
    ok((await page.textContent('#rdList')).includes('Technique requires improvement'), 'list shows the reason');
    await tab(page, 'dashboard');
    const d = await page.textContent('#view-dashboard');
    ok(d.includes('Not ready for grading') && d.includes('Not ready for grading: technique requires improvement'), 'dashboard counts readiness and lists the not-ready student in Needs attention');
    await page.click('#view-dashboard .item:has-text("Riley Chen"):has-text("Not ready")');
    await page.waitForSelector('#rdForm');
    ok((await page.textContent('#sheet')).includes('Riley Chen'), 'Needs attention opens the readiness record');
    await page.check('#rdForm [name=rdStatus][value=on_track]'); await page.click('#rdSave'); await settle(page);
    await tab(page, 'readiness');
    await page.click('#rdList [data-rd="M-0042"]'); await page.waitForSelector('#rdForm');
    ok((await page.textContent('#sheet')).includes('History'), 'readiness history is shown after changes');
    await page.click('#sheet [data-close]');
    await page.click('#rdSelect'); await page.click('#rdSelAll');
    await page.click('#rdSetBtn'); await page.check('#rdForm [name=rdStatus][value=ready]'); await page.click('#rdSave');
    const bt = await confirm(page); await settle(page);
    ok(/Set \d+ students to "Ready for grading"/.test(bt), 'bulk readiness asks first');
    ok((await q(`select count(*)::int n from prep_readiness r join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and r.status <> 'ready'`))[0].n === 0, 'everyone selected set to ready');
    ok((await q(`select r.notes from prep_readiness r join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and r.student_id = 'M-0042'`))[0].notes === 'Poomsae timing', 'bulk update keeps each student\'s own notes when left blank');
    await shot(page, 'readiness');
    await ctx.close();
  }

  console.log('\nPayments');
  {
    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'payments');
    ok((await page.textContent('#view-payments')).includes('Outstanding'), 'Payments screen opens from More with an outstanding total');
    await page.click('#view-payments [data-pf="all"]');
    await page.click('#payList .item:has-text("Riley Chen")');
    await page.waitForSelector('#sheet [data-act="payment"]');
    ok((await page.textContent('#sheet')).includes('Paid at session 2'), 'payment record lists its transactions');
    await page.click('#sheet [data-act="oneoff"]'); await page.fill('#ooAmt', '100'); await page.fill('#ooWhy', 'Sibling discount'); await page.click('#ooF button[type=submit]'); await settle(page);
    let rp = (await q(`select s.* from prep_payment_summary s join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and s.student_id = 'M-0042' and s.kind = 'sessions'`))[0];
    ok(Number(rp.amount_due) === 100 && rp.fee_override !== null, 'one-off fee set with a reason');
    await page.click('#sheet [data-act="payment"]'); await page.fill('#txRef', 'R-77'); await page.selectOption('#txMethod', 'bank_transfer'); await page.click('#txGo'); await settle(page);
    rp = (await q(`select s.* from prep_payment_summary s join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and s.student_id = 'M-0042' and s.kind = 'sessions'`))[0];
    ok(Number(rp.amount_paid) === 100 && rp.status === 'paid', 'recording the balance ($40) makes it fully paid');
    await page.click('#sheet [data-act="payment"]'); await page.fill('#txAmt', '5'); await page.fill('#txRef', 'r-77'); await page.click('#txGo');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('already been used'), null, { timeout: 5000 }).catch(() => {});
    ok((await toastText(page)).includes('already been used'), 'same receipt number twice is refused with a clear message');
    await page.click('#txCancel');
    await page.click('#sheet [data-act="refund"]'); await page.fill('#txAmt', '10'); await page.click('#txGo');
    ok(await page.isVisible('#txF'), 'a refund needs a note');
    await page.fill('#txNotes', 'Missed session refunded'); await page.click('#txGo'); await settle(page);
    rp = (await q(`select s.* from prep_payment_summary s join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and s.student_id = 'M-0042' and s.kind = 'sessions'`))[0];
    ok(Number(rp.amount_paid) === 90 && Number(rp.balance) === 10, 'refund reduces the amount paid');
    await page.click('#sheet [data-act="status"]'); await page.selectOption('#stSel', 'waived'); await page.fill('#stWhy', 'Committee approved'); await page.click('#stF button[type=submit]'); await settle(page);
    ok((await q(`select s.status from prep_payment_summary s join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and s.student_id = 'M-0042' and s.kind = 'sessions'`))[0].status === 'waived', 'fee marked waived with a reason');
    await shot(page, 'payment-record');
    await page.click('#sheet [data-close]');
    await page.click('#view-payments [data-kind="grading"]');
    ok((await page.textContent('#payList')).includes('Grading to Probationary Black Belt'), 'grading fees can be shown on their own');
    await shot(page, 'payments');
    await ctx.close();
  }

  console.log('\nGrading results and lists');
  {
    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'grading');
    await page.click('#view-grading [data-grf="nominated"]');
    ok((await page.textContent('#grListItems')).includes('Alex Smith') && (await page.textContent('#grListItems')).includes('Cho Dan Bo → Probationary Black Belt'), 'Put forward list shows each student and the belt they are going to');
    await page.click('#grListItems [data-gr="BB0001"]'); await page.waitForSelector('#sheet [data-res="passed"]');
    await page.click('#sheet [data-res="passed"]'); await settle(page);
    ok((await q(`select g.result from prep_grading g join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and g.student_id = 'BB0001'`))[0].result === 'passed', 'result recorded as passed');
    ok((await q(`select belt_rank from prep_students where student_id = 'BB0001'`))[0].belt_rank === 'Cho Dan Bo', 'belt is not changed by a result');
    ok(!(await page.$('#grPromote')), 'there is no belt-update button');
    await page.click('#sheet [data-close]'); await page.waitForSelector('#sheet:not([open])', { state: 'attached' }); await page.waitForTimeout(200);
    // Texting families through GoHighLevel (the function is pretended here; it has its own tests)
    {
      const cyId = (await q(`select cycle_id from prep_cycles where name = 'Term 1 2027'`))[0].cycle_id;
      await q(`update prep_students set contact_phone = '0412 345 678' where student_id = 'BB0001'`);
      await q(`update prep_cycles set invite_link = 'https://ama.test/book' where cycle_id = $1`, [cyId]);
      const sent = [];
      await page.context().route(`${BASE}/functions/v1/ghl`, async r => {
        const b = JSON.parse(r.request().postData() || '{}');
        if (b.action === 'check') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ready: true }) });
        for (const it of b.items) { sent.push(it); await q(`insert into prep_messages (student_id, cycle_id, kind, body, status, sent_by) values ($1, $2, $3, $4, 'sent', 'owner@ama.test')`, [it.student_id, it.cycle_id, it.kind, it.body]); }
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ sent: b.items.length, results: b.items.map(it => ({ student_id: it.student_id, ok: true })) }) });
      });
      await page.evaluate(() => loadAll().then(render));
      await page.click('#grText'); await page.waitForSelector('#txBody');
      const inv = await page.textContent('#sheet');
      ok(inv.includes('Alex Smith') && inv.includes('0412 345 678') && inv.includes('Please book and pay here: https://ama.test/book'), 'Text families starts on grading invitations, with the booking link filled in');
      await page.click('#sheet [data-tk="congrats"]'); await page.waitForSelector('#sheet [data-tk="congrats"][aria-pressed="true"]');
      const cg = await page.textContent('#sheet');
      ok(cg.includes('Preview for Alex Smith') && cg.includes('Congratulations Alex! You passed your grading and are now a Probationary Black Belt'), 'Congratulations shows who passed, with a preview of their text');
      ok(await page.isChecked('#sheet [data-tx="BB0001"]'), 'students with a mobile are ticked');
      await page.fill('#txBody', 'Well done {first_name}, you are now a {belt}!'); await page.waitForTimeout(200);
      ok((await page.textContent('#sheet')).includes('Well done Alex, you are now a Probationary Black Belt!'), 'the wording can be changed before sending, and the preview follows');
      await page.click('#txGo'); await confirm(page); await page.waitForTimeout(800);
      ok(sent.length === 1 && sent[0].kind === 'congrats' && sent[0].student_id === 'BB0001' && sent[0].body === 'Well done Alex, you are now a Probationary Black Belt!', 'Send texts the filled-in message for each student');
      await page.click('#grText'); await page.waitForSelector('#txBody'); await page.click('#sheet [data-tk="congrats"]'); await page.waitForSelector('#sheet [data-tk="congrats"][aria-pressed="true"]');
      ok((await page.textContent('#sheet')).includes('Texted') && !(await page.isChecked('#sheet [data-tx="BB0001"]')), 'someone already texted shows when, and is not ticked again');
      await page.click('#sheet [data-close]'); await page.waitForSelector('#sheet:not([open])', { state: 'attached' }); await page.waitForTimeout(200);
    }
    await page.click('#view-grading [data-grf="all"]');
    await page.click('#grSelect'); await page.click('#grSelAll');
    ok(!(await page.$('#grSelbar [data-gbulk="promote"]')), 'bulk actions do not include updating belts');
    ok(!(await page.$('#grSelbar [data-gbulk="eligible"]')), 'bulk actions have no separate Eligible step');
    await page.click('#grSelbar [data-gbulk="put"]');
    await page.waitForSelector('#gpBulk');
    const bt = await page.textContent('#gpBulk');
    ok(bt.includes('Alex Smith (already put forward)') && bt.includes('marked eligible and charged'), 'bulk Put forward skips anyone already put forward and explains it marks eligible');
    const before = (await q(`select count(*)::int n from prep_enrolments e join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and e.is_grading`))[0].n;
    if (await page.$('#gpbReason')) {
      await page.click('#gpbGo');
      ok((await toastText(page)).includes('Give a reason') || (await page.isVisible('#gpBulk')) === false, 'students who have not met requirements need a reason');
    }
    if (await page.$('#gpbReason')) await page.fill('#gpbReason', 'Approved by head instructor');
    if (await page.$('#gpBulk')) { await page.click('#gpbGo'); await settle(page); }
    const after = (await q(`select count(*)::int n from prep_enrolments e join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and e.is_grading`))[0].n;
    const elig = (await q(`select count(*)::int n from prep_grading g join prep_cycles c using (cycle_id) where c.name = 'Term 1 2027' and g.eligibility_decision = 'eligible'`))[0].n;
    ok(after > before && elig === after, 'bulk Put forward marks them eligible and puts them forward in one go');
    await shot(page, 'grading');

    await page.click('#grList'); await page.waitForSelector('#lbPreview');
    await page.selectOption('#lbTpl', 'preset:instructor'); await page.selectOption('#lbF_who', 'all');
    const head = await page.textContent('#lbPreview tr');
    ok(head.includes('Name') && head.includes('Grading to') && head.includes('Sign-off') && !head.includes('owing'), 'instructor list has grading-to, attendance and no fees');
    ok(head.includes('Classes done') && head.includes('Enough classes'), 'the grading list includes classes done');
    const body = await page.textContent('#lbPreview');
    ok(body.includes('Alex Smith') && body.includes('Probationary Black Belt'), 'list shows the next belt for each student');
    await page.selectOption('#lbTpl', 'preset:admin'); await page.selectOption('#lbF_who', 'all');
    ok((await page.textContent('#lbPreview tr')).includes('Grading fee owing'), 'admin list adds fee columns');
    await page.click('#sheet details summary');
    await page.click('#lbCols input[data-col="notes"]'); await page.waitForSelector('#lbPreview');
    ok((await page.textContent('#lbPreview tr')).includes('Notes'), 'columns can be added');
    const dl = page.waitForEvent('download'); await page.click('#lbCsv'); const file = await dl;
    ok(/grading-list-term-1-2027-.*\.csv$/.test(file.suggestedFilename()), 'CSV downloads with a clear file name');
    await page.fill('#lbName', 'My admin list'); await page.click('#lbSave'); await settle(page);
    const t = (await q(`select name, audience, columns from prep_report_templates where name = 'My admin list'`))[0];
    ok(t && t.audience === 'admin' && t.columns.includes('notes'), 'template saved (marked admin because it has fees)');
    await shot(page, 'grading-list');
    await ctx.close();
  }

  console.log('\nCertificates');
  {
    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'dashboard');
    ok((await page.textContent('#view-dashboard')).includes('Certificates'), 'dashboard shows a certificates summary once someone has passed');
    await tab(page, 'certificates');
    await page.waitForSelector('#ceItems [data-ce="BB0001"]');
    ok((await page.textContent('#ceItems')).includes('Awaiting approval'), 'a student who passed shows as awaiting approval');
    await page.click('#ceItems [data-ce="BB0001"]'); await page.waitForSelector('#ceForm');
    ok(await page.inputValue('#ceName') === 'Alex Smith' && await page.inputValue('#ceRank') === 'Probationary Black Belt' && await page.inputValue('#ceNo') === '501',
       'certificate details filled in: name, awarded rank (the belt graded to) and Dan number');
    await page.fill('#ceName', 'Alexander James Smith');
    await page.click('#ceNext'); await settle(page);
    let ce = (await q(`select * from prep_certificates where student_id = 'BB0001'`))[0];
    ok(ce && ce.status === 'details_check' && ce.certificate_name === 'Alexander James Smith' && ce.certificate_number === '501' && ce.certificate_type === 'Dan certificate',
       'saving moves it to the next step (details to be checked) with the exact name');
    await page.click('#view-certificates [data-cef="all"]');
    await page.click('#ceItems [data-ce="BB0001"]'); await page.waitForSelector('#ceForm');
    await page.selectOption('#ceStatus', 'issued'); await page.click('#ceSave'); await settle(page);
    ce = (await q(`select status, issue_date::text d from prep_certificates where student_id = 'BB0001'`))[0];
    ok(ce.status === 'issued' && ce.d, 'marked issued; issue date filled in automatically');
    await page.click('#ceList'); await page.waitForSelector('#lbPreview');
    await page.selectOption('#lbTpl', 'preset:issued');
    ok((await page.textContent('#lbPreview')).includes('Alexander James Smith') && (await page.textContent('#lbPreview tr')).includes('Certificate number'), 'certificate list "Issued" shows the certificate');
    await page.selectOption('#lbTpl', 'preset:production');
    ok(!(await page.textContent('#lbPreview')).includes('Alexander'), '"Ready for production" list is separate and does not include issued certificates');
    const dl = page.waitForEvent('download'); await page.click('#lbCsv'); const file = await dl;
    ok(/certificate-list-term-1-2027-.*\.csv$/.test(file.suggestedFilename()), 'certificate list downloads as CSV');
    await page.fill('#lbName', 'Production run'); await page.click('#lbSave'); await settle(page);
    ok((await q(`select report_type from prep_report_templates where name = 'Production run'`))[0]?.report_type === 'certificate', 'certificate list templates are saved separately from grading lists');
    await page.selectOption('#lbTpl', 'preset:printer');
    const pHead = await page.$$eval('#lbPreview tr:first-child th', th => th.map(x => x.textContent));
    ok(pHead.join('|') === 'Name|Belt|Date|Dan number', '"For the printing company" has name, belt, date and Dan number');
    const pRow = await page.$$eval('#lbPreview tr:nth-child(2) td', td => td.map(x => x.textContent));
    ok(pRow[0] === 'Alexander James Smith' && pRow[3] === '501' && /^\d{1,2} [A-Z][a-z]+ \d{4}$/.test(pRow[2]), 'printer list shows the certificate name, Dan number and the date written out');
    let pdl = page.waitForEvent('download'); await page.click('#lbCsv'); let pf = await pdl;
    let csv = readFileSync(await pf.path(), 'utf8').replace(/^\uFEFF/, '');
    ok(csv.split('\r\n')[0] === 'Name,Belt,Date,Dan number', 'printer CSV starts with the column headings (no title rows)');
    await page.click('#lbFmt summary');
    await page.fill('#lbH_rank', 'Belt applying for');
    await page.waitForFunction(() => document.querySelector('#lbPreview tr').textContent.includes('Belt applying for'));
    await page.selectOption('#lbDate', 'numeric');
    ok(/^\d{2}\/\d{2}\/\d{4}$/.test(await page.textContent('#lbPreview tr:nth-child(2) td:nth-child(3)')), 'date format can be changed (14/11/2026)');
    await page.fill('#lbName', 'Printer AMA'); await page.click('#lbSave'); await settle(page);
    const pt = (await q(`select filters from prep_report_templates where name = 'Printer AMA'`))[0];
    ok(pt && pt.filters.headings.rank === 'Belt applying for' && pt.filters.dateFmt === 'numeric' && pt.filters.plain === true, 'renamed headings, date format and no title rows are saved with the template');
    await page.selectOption('#lbTpl', 'preset:all');
    ok(!(await page.textContent('#lbPreview tr')).includes('Belt applying for'), 'other templates keep the normal headings');
    await page.selectOption('#lbTpl', { label: 'Printer AMA' });
    ok((await page.textContent('#lbPreview tr')).includes('Belt applying for') && /^\d{2}\/\d{2}\/\d{4}$/.test(await page.textContent('#lbPreview tr:nth-child(2) td:nth-child(3)')), 'choosing the saved template brings its headings and date format back');
    await page.click('#lbFmt summary'); await page.click('#lbPlain');
    pdl = page.waitForEvent('download'); await page.click('#lbCsv'); pf = await pdl;
    csv = readFileSync(await pf.path(), 'utf8').replace(/^\uFEFF/, '');
    ok(csv.startsWith('Certificate list') && csv.includes('Belt applying for'), 'title rows can be switched back on');
    await page.click('#sheet [data-close]');
    await page.click('#ceSelect'); await page.click('#ceSelAll'); await page.click('#ceSetBtn');
    await page.selectOption('#cbStatus', 'reprint_required'); await page.click('#cbGo'); await confirm(page); await settle(page);
    ok((await q(`select status from prep_certificates where student_id = 'BB0001'`))[0].status === 'reprint_required', 'several certificates can be set at once (reprint required)');
    await shot(page, 'certificates');
    await ctx.close();
  }

  console.log('\nID cards printed in the card software');
  {
    // Riley and Jordan are going for 1st Dan (Probationary Black Belt); Cho Dan Bo students get no ID card
    await q(`update prep_students set belt_rank = 'Probationary Black Belt' where student_id in ('M-0042', 'BB0002')`);
    // In AMA ID Cards: Riley's card is added (name written differently) and printed
    await q(`insert into people (name, dan, photo_path) values ('RILEY  chen', '1st Dan', 'photos/r.jpg')`);
    await q(`insert into people (name, dan) values ('J. Lee', '1st Dan'), ('Taylor Brown', '3rd Dan')`);
    const rid = (await q(`select id, student_id from people where name = 'RILEY  chen'`))[0];
    ok(rid.student_id === 'M-0042', 'card added in the card software links itself to the student by name');
    const job = (await q(`insert into print_jobs (people_ids, card_count, pdf_path) values (array['${rid.id}']::uuid[], 1, 'jobs/r.pdf') returning id`))[0].id;
    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'attendance'); await page.waitForSelector('.att button');
    ok((await page.textContent('#attList')).includes('Card in print queue'), 'session list shows the card waiting in the print queue');
    await q(`update print_jobs set status = 'printed', printed_at = now() where id = '${job}'`);
    await page.reload(); await page.waitForFunction(() => !document.querySelector('#app').hidden && !document.querySelector('#view-dashboard').textContent.includes('Loading'));
    await tab(page, 'attendance'); await page.waitForSelector('.att button');
    const row = await page.textContent('#attList li:has-text("Riley Chen")');
    ok(row.includes('ID card printed'), 'once printed in the card software, the session list shows "ID card printed"');
    await shot(page, 'attendance-card-printed');
    await tab(page, 'students');
    ok((await page.textContent('#studentList li:has-text("Riley Chen")')).includes('Card'), 'student list marks students whose card is printed');
    await page.selectOption('#studentCard', 'notprinted');
    const np = await page.textContent('#studentList');
    ok(np.includes('Jordan Lee') && !np.includes('Riley Chen') && !np.includes('Alex Smith') && !np.includes('Taylor Brown'), '"No ID card printed" filter: Jordan (no card yet) shown; Riley (printed), Alex (Cho Dan Bo) and Taylor (not going for a Dan) left out');
    await page.selectOption('#studentCard', 'printed');
    ok((await page.textContent('#studentList')).includes('Riley Chen') && !(await page.textContent('#studentList')).includes('Jordan Lee'), '"ID card printed" filter shows Riley only');
    await page.selectOption('#studentCard', '');
    await tab(page, 'attendance'); await page.waitForSelector('#attCard');
    await page.selectOption('#attCard', 'notprinted');
    const anp = await page.textContent('#attList');
    ok(!anp.includes('Riley Chen') && !anp.includes('Alex Smith') && anp.includes('No one matches'), 'attendance list has the same "No ID card printed" filter (Riley printed, Alex is Cho Dan Bo)');
    await page.selectOption('#attCard', 'printed');
    ok((await page.textContent('#attList')).includes('Riley Chen'), 'attendance list "ID card printed" filter shows Riley');
    await page.selectOption('#attCard', '');
    await tab(page, 'students');
    await page.click('#studentList .item:has-text("Alex Smith")'); await page.waitForSelector('#sheet #stEdit');
    const alexRec = await page.textContent('#sheet');
    ok(alexRec.includes('Dan number') && !alexRec.includes('ID card'), 'Cho Dan Bo student (going for Probationary) has a Dan number but no ID card');
    await page.click('#sheet [data-close]');
    await page.click('#studentList .item:has-text("Taylor Brown")'); await page.waitForSelector('#sheet #stEdit');
    ok(!(await page.textContent('#sheet')).includes('ID card') && !(await page.$('#sheet [data-cardlink]')), 'no ID card shown for a student not going for a Dan (3rd Dan Level 2), even with a matching card');
    await page.click('#sheet [data-close]');
    await page.click('#studentList .item:has-text("Jordan Lee")'); await page.waitForSelector('#sheet [data-cardlink]');
    ok((await page.textContent('#sheet')).includes('No card linked'), 'student record shows when no card is linked');
    await page.click('#sheet [data-cardlink]'); await page.waitForSelector('#clList');
    await page.fill('#clSearch', 'lee');
    await page.click('#clList [data-person]:visible');
    await page.waitForSelector('#sheet [data-cardlink]');
    ok((await q(`select student_id from people where name = 'J. Lee'`))[0].student_id === 'BB0002', 'a card with a different name can be linked by hand');
    ok((await page.textContent('#sheet')).includes('Card not printed yet'), 'student record shows the linked card status');
    await ctx.close();
  }

  console.log('\nEFC Aquila links');
  {
    // The EFC copy (made-up people): Alex has one exact match, Jordan is spelled differently, Taylor has two namesakes
    await q(`insert into efc_members (member_key, full_name, efc_reference, phone, email, guardian_name, location, belt) values
      ('efc:1', 'ALEX smith', 'AU-023-0001', '0400 000 001', 'alex.family@example.test', 'Pat Smith', 'Marrickville', 'Cho Dan Bo'),
      ('efc:2', 'Jordan Leigh', 'AU-256-0002', '0400 000 002', 'leigh@example.test', 'Sam Leigh', 'Sydenham', 'Black Belt: First Dan'),
      ('efc:3', 'Taylor Brown', 'AU-257-0003', '0400 000 003', null, null, 'West', null),
      ('efc:4', 'Taylor Brown', 'AU-258-0004', '0400 000 004', null, null, 'Concord', null),
      ('efc:5', 'Morgan Quinn', 'AU-023-0005', '0400 000 005', 'quinn@example.test', 'Robin Quinn', 'Marrickville', null)`);
    const before = (await q(`select contact_phone from prep_students where student_id = 'BB0001'`))[0].contact_phone;
    const n = (await q(`select public.prep_efc_link_run(null) n`))[0].n;
    const alex = (await q(`select efc_ref, contact_phone, contact_email, contact_name from prep_students where student_id = 'BB0001'`))[0];
    ok(alex.efc_ref === 'AU-023-0001' && alex.contact_email === 'alex.family@example.test' && alex.contact_name === 'Pat Smith', 'a student is linked to the one EFC member with the same name and gets the email and parent name');
    ok(alex.contact_phone === (before || '0400 000 001'), 'a phone number already on the student is not overwritten');
    ok(n === 1 && !(await q(`select efc_ref from prep_students where full_name = 'Taylor Brown'`))[0].efc_ref, 'two EFC members with the same name: not linked automatically');
    await q(`insert into prep_students (full_name, belt_rank) values ('Morgan Quinn', 'Cho Dan Bo')`);
    ok((await q(`select efc_ref, contact_phone from prep_students where full_name = 'Morgan Quinn'`))[0].contact_phone === '0400 000 005', 'a new student links to EFC by themselves');

    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'students');
    const alexRow = await page.textContent('#studentList .item:has-text("Alex Smith")');
    ok(alexRow.includes('EFC') && !(await page.textContent('#studentList .item:has-text("Jordan Lee")')).includes('EFC'), 'the list shows an EFC badge on linked students only');
    await page.fill('#studentSearch', 'AU-023-0001');
    ok((await page.$$('#studentList [data-student]')).length === 1, 'search finds a student by EFC ref');
    await page.fill('#studentSearch', '');
    await page.click('#studentList .item:has-text("Alex Smith")'); await page.waitForSelector('#sheet #stEfc');
    const rec = await page.textContent('#sheet');
    ok(rec.includes('EFC profile') && rec.includes('Linked') && rec.includes('AU-023-0001') && rec.includes('Pat Smith'), 'student record shows the EFC link, ref and parent name');
    await page.click('#stEdit'); await page.waitForSelector('#fEfc');
    ok((await page.inputValue('#fEfc')) === 'AU-023-0001' && (await page.inputValue('#fParent')) === 'Pat Smith', 'edit form has EFC ref and parent fields');
    await page.click('#sheet [data-close]');
    await page.click('#studentList .item:has-text("Jordan Lee")'); await page.waitForSelector('#sheet #stEfc');
    ok((await page.textContent('#sheet')).includes('Not linked'), 'an unlinked student shows "Not linked"');
    await page.click('#stEfc'); await page.waitForSelector('#efcRes [data-ref]');
    ok((await page.textContent('#efcRes')).includes('Jordan Leigh'), 'Find in EFC tries the surname, then the first name, when the full name finds nothing');
    await page.click('#efcRes [data-ref="AU-256-0002"]'); await page.waitForSelector('#sheet #stEfc');
    const jl = (await q(`select efc_ref, contact_name from prep_students where student_id = 'BB0002'`))[0];
    ok(jl.efc_ref === 'AU-256-0002' && jl.contact_name === 'Sam Leigh' && (await page.textContent('#sheet')).includes('Linked'), 'a student with a different spelling can be linked by hand');
    await page.click('#stEfc'); await page.waitForSelector('#efcClear'); await page.click('#efcClear'); await page.waitForSelector('#sheet #stEfc');
    ok(!(await q(`select efc_ref from prep_students where student_id = 'BB0002'`))[0].efc_ref, 'Unlink removes the EFC ref and it stays unlinked');
    await q(`update prep_students set efc_ref = 'AU-999-9999' where student_id = 'BB0002'`);
    await ctx.close();
    const { ctx: ctx2, page: p2 } = await open('owner@ama.test');
    await tab(p2, 'students');
    ok((await p2.textContent('#studentList .item:has-text("Jordan Lee")')).includes('EFC?'), 'an EFC ref that is not in the EFC copy shows "EFC?"');
    await q(`update prep_students set efc_ref = null where student_id = 'BB0002'`);
    await q(`delete from prep_students where full_name = 'Morgan Quinn'`);
    await ctx2.close();
  }

  console.log('\nReports and exports');
  {
    const { ctx, page } = await open('owner@ama.test');
    const readXlsx = async dl => XLSX.readFile(await dl.path());
    await tab(page, 'reports');
    const rep = await page.textContent('#view-reports');
    ok(['Student register', 'Attendance by session', 'Attendance history', 'Readiness', 'Payments', 'Follow-up list', 'ID cards', 'Grading list', 'Certificate list'].every(t => rep.includes(t)), 'Reports screen lists every report');
    await page.click('[data-report="register"]'); await page.waitForSelector('#lbPreview');
    ok((await page.textContent('#lbPreview')).includes('Alex Smith') && (await page.textContent('#lbPreview tr')).includes('ID card'), 'student register shows students with their ID card status');
    const taylorRow = await page.textContent('#lbPreview tr:has-text("Taylor Brown")');
    ok(!taylorRow.includes('card'), 'register shows no card status for students not going for a Dan');
    ok((await page.textContent('#lbPreview tr')).includes('Classes done') && !!(await page.$('#lbF_cls')), 'the student register export includes classes done, with an enough / not enough filter');
    let dl = page.waitForEvent('download'); await page.click('#lbXlsx'); let f = await dl;
    let wb = await readXlsx(f), rowsX = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    ok(/student-register-.*\.xlsx$/.test(f.suggestedFilename()) && rowsX[0][0] === 'Student register' && rowsX.some(r => r.includes('Alex Smith')), 'Excel download contains the report with a title');
    await page.click('#sheet [data-close]');
    await page.click('[data-report="payments"]'); await page.waitForSelector('#lbPreview');
    ok((await page.textContent('#lbPreview tr')).includes('Balance'), 'payments report shows amounts');
    await page.selectOption('#lbTpl', 'preset:all');
    ok((await page.textContent('#lbPreview')).includes('Riley Chen'), 'payments report "All fees" lists fees');
    await page.click('#sheet [data-close]');
    await page.click('[data-report="attendance"]'); await page.waitForSelector('#lbPreview');
    const attHead = await page.textContent('#lbPreview tr');
    ok(attHead.includes('Classes done') && attHead.includes('Classes needed'), 'the attendance export includes classes done and needed');
    const whoOpts = await page.$$eval('#lbF_who option', os => os.map(o => o.value));
    ok(whoOpts.includes('clsok') && whoOpts.includes('clsshort'), 'and can show just those with enough, or not enough, classes');
    await page.click('#sheet [data-close]');
    await page.click('[data-report="cards"]'); await page.waitForSelector('#lbPreview');
    const cardsRep = await page.textContent('#lbPreview');
    ok(cardsRep.includes('Riley Chen') && !cardsRep.includes('Taylor Brown') && !cardsRep.includes('Brand New') && !cardsRep.includes('Alex Smith'), 'ID cards report lists only students going for 1st Dan or higher (not Cho Dan Bo)');
    await page.click('#sheet [data-close]');
    await page.click('[data-report="followup"]'); await page.waitForSelector('#lbPreview');
    ok((await page.textContent('#lbPreview tr')).includes('Issues'), 'follow-up list opens');
    await page.click('#sheet [data-close]');
    dl = page.waitForEvent('download'); await page.click('#exportAll'); f = await dl;
    wb = await readXlsx(f);
    ok(['Students', 'Cycles', 'Sessions', 'Attendance', 'Readiness', 'Grading', 'Certificates', 'Fees', 'Payment transactions'].every(n => wb.SheetNames.includes(n)), 'Export everything gives one workbook with a sheet per table');
    ok(XLSX.utils.sheet_to_json(wb.Sheets['Payment transactions']).length > 0, 'payment transactions are included for admins');
    await tab(page, 'attendance'); await page.waitForSelector('#attExport');
    await page.click('#attExport'); await page.waitForSelector('#lbPreview');
    const ah = await page.textContent('#lbPreview tr');
    ok(ah.includes('Session 1') && ah.includes('Sign-off') && ah.includes('Attendance %'), 'Export on the attendance screen gives attendance by session for that cycle');
    await page.click('#sheet [data-close]');
    await tab(page, 'students'); await page.click('#exportStudentsBtn'); await page.waitForSelector('#lbPreview');
    ok((await page.textContent('#sheet')).includes('Student register'), 'Export on the students screen opens the register');
    await shot(page, 'export');
    await ctx.close();
  }
  {
    const { ctx, page } = await open('view@ama.test');
    await tab(page, 'reports');
    const rep = await page.textContent('#view-reports');
    ok(!rep.includes('Session and grading fees') && !(await page.$('#exportAll')), 'viewers get no payments report and no Export everything');
    await page.click('[data-report="register"]'); await page.waitForSelector('#lbPreview');
    ok(await page.isVisible('#lbXlsx'), 'viewers can still export the register');
    await ctx.close();
  }

  console.log('\nSelect several students and delete');
  {
    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'students');
    await page.click('#importStudentsBtn');
    await page.fill('#impText', 'Name\tBelt\nOops One\tFirst Dan\nOops Two\tThird Dan\nOops Three\tFirst Dan');
    await page.waitForSelector('#impPreview table'); await page.click('#impGo'); await confirm(page); await settle(page);
    await page.click('#selectStudentsBtn');
    ok(await page.isVisible('#stuSelbar'), 'Select shows the selection bar');
    await page.fill('#studentSearch', 'oops');
    await page.click('#stuSelAll');
    ok((await page.textContent('#stuSelCount')) === '3 selected', '"Select all shown" selects the filtered students');
    await page.click('#stuSelbar [data-sbulk="enrol"]');
    await page.waitForSelector('#askDlg[open]');
    ok((await page.textContent('#askText')).includes('Add 3 students to Term 1 2027'), 'bulk "Add to cycle" asks first (only one open cycle, so no picker)');
    await page.click('#askYes'); await settle(page);
    ok((await q(`select count(*)::int n from prep_enrolments e join prep_students s using (student_id) join prep_cycles c using (cycle_id) where s.full_name like 'Oops%' and c.name = 'Term 1 2027'`))[0].n === 3, 'three students added to the cycle');
    await page.click('#selectStudentsBtn');
    await page.fill('#studentSearch', '');
    for (const n of ['Oops One', 'Oops Two', 'Alex Smith']) await page.click(`#studentList .item:has-text("${n}")`);
    ok((await page.textContent('#stuSelCount')) === '3 selected', 'tapping students selects them');
    await shot(page, 'students-selecting');
    await page.click('#stuSelbar [data-sbulk="delete"]');
    const delTxt = await confirm(page); await settle(page);
    ok(delTxt.includes('cannot be undone') && delTxt.includes('skipped'), 'delete warns it cannot be undone and that students with history are skipped');
    await page.waitForSelector('#sheet[open]');
    const kept = await page.textContent('#sheet');
    ok(kept.includes('2 deleted, 1 kept') && kept.includes('Alex Smith') && kept.includes('Has payments recorded'), 'students with history are kept and listed with the reason');
    const left = (await q(`select full_name from prep_students where full_name in ('Oops One','Oops Two','Oops Three','Alex Smith') order by 1`)).map(r => r.full_name);
    ok(left.join() === 'Alex Smith,Oops Three', 'the two mistaken imports are gone; Alex and Oops Three remain');
    ok(await page.isVisible('#delAnyway'), 'a Delete anyway button is offered for students with history');
    await page.click('#delAnyway');
    await page.waitForSelector('#askDlg[open]');
    const anyTxt = await page.textContent('#askText');
    ok(anyTxt.includes('Alex Smith') && anyTxt.includes('payments') && anyTxt.includes('cannot be undone'), 'Delete anyway asks again and warns payments go too');
    await page.click('#askNo'); await page.waitForSelector('#askDlg:not([open])', { state: 'attached' });
    ok((await q(`select count(*)::int n from prep_students where full_name = 'Alex Smith'`))[0].n === 1, 'cancelling Delete anyway keeps the student');
    await page.click('#sheet [data-close]');
    await page.click('#studentList .item:has-text("Oops Three")');
    await page.click('#stDelete'); await confirm(page); await settle(page);
    ok((await q(`select count(*)::int n from prep_students where full_name = 'Oops Three'`))[0].n === 0 && !(await page.isVisible('#sheet[open]')), 'Delete on a student record removes them and closes the record');
    await shot(page, 'students-select');
    await ctx.close();
  }

  console.log('\nGrading helpers');
  {
    // A student going for 4th Dan in the active cycle, and that cycle's three helper sessions
    const [c0] = await q(`select cycle_id from prep_cycles where status = 'active' order by created_at desc limit 1`);
    const [s0] = await q(`select e.student_id, s.full_name from prep_enrolments e join prep_students s using (student_id) where e.cycle_id = $1 order by s.full_name limit 1`, [c0.cycle_id]);
    await q(`update prep_enrolments set is_grading = true where cycle_id = $1 and student_id = $2`, [c0.cycle_id, s0.student_id]);
    await q(`insert into prep_grading (student_id, cycle_id, target_rank, current_rank, status) values ($2, $1, '4th Dan', '3rd Dan Level 3', 'nominated')
             on conflict (student_id, cycle_id) do update set target_rank = '4th Dan'`, [c0.cycle_id, s0.student_id]).catch(async () => { await q(`update prep_grading set target_rank = '4th Dan' where cycle_id = $1 and student_id = $2`, [c0.cycle_id, s0.student_id]); });
    await q(`insert into prep_helper_slots (cycle_id, label, grading_date, start_time, sort) values ($1, '8:00am session', '2026-12-05', '08:00', 1), ($1, '12:00pm session', '2026-12-05', '12:00', 2), ($1, '3:30pm session', '2026-12-05', '15:30', 3)`, [c0.cycle_id]);
    const { ctx, page } = await open('owner@ama.test');
    await tab(page, 'grading');
    await page.selectOption('#grCycle', c0.cycle_id).catch(() => {});
    await page.click('[data-grpanel="helpers"]'); await page.waitForSelector('#grHelpers .day-head', { timeout: 8000 }).catch(() => {});
    const txt = await page.textContent('#grHelpers');
    ok(/Grading helpers/.test(txt) && txt.includes(s0.full_name) && /8:00am session/.test(txt) && /3:30pm session/.test(txt) && /0 \/ 6/.test(txt), 'Helpers shows the 4th Dan+ students and the three sessions (max 6)');
    await page.selectOption(`[data-hset="${s0.student_id}"]`, { label: '12:00pm session (0/6)' }); await settle(page); await page.waitForTimeout(600);
    const hr = (await q(`select h.set_by, sl.label from prep_helpers h join prep_helper_slots sl using (slot_id) where h.student_id = $1`, [s0.student_id]))[0];
    ok(hr && hr.label === '12:00pm session' && hr.set_by === 'owner@ama.test', 'staff can put a helper into a session by hand');
    ok(/1 \/ 6/.test(await page.textContent('#grHelpers')), 'the session shows who is helping');
    await shot(page, 'grading-helpers');
    await ctx.close();
  }

  console.log('\nOther roles');
  {
    const { ctx, page } = await open('att@ama.test');
    await tab(page, 'students');
    ok(await page.isHidden('#addStudentBtn'), 'attendance recorder cannot add students');
    await tab(page, 'attendance');
    await page.waitForSelector('.att button', { timeout: 5000 }).catch(() => {});
    ok((await page.$$('.att button')).length > 0, 'attendance recorder can take attendance');
    ok((await page.$$('.att .pay')).length > 0, 'attendance recorder sees the $ button for per-session students');
    await tab(page, 'more');
    ok(await page.isHidden('#setForm') || !(await page.$('#setForm')), 'attendance recorder cannot change settings');
    ok(!(await page.$('[data-goto="payments"]')), 'attendance recorder has no Payments screen');
    await tab(page, 'readiness');
    ok((await page.textContent('#view-readiness')).includes('can view readiness but not change it'), 'attendance recorder sees readiness read-only');
    await ctx.close();
  }
  {
    const { ctx, page } = await open('view@ama.test');
    await tab(page, 'attendance');
    ok((await page.$$('.att button')).length === 0 && (await page.textContent('#attBody')).includes('can view attendance but not change it'), 'viewer sees attendance read-only');
    await tab(page, 'cycles');
    ok(await page.isHidden('#newCycleBtn'), 'viewer cannot start a cycle');
    await ctx.close();
  }
} catch (e) {
  failed++; console.log('  FAIL  stopped: ' + e.message.split('\n').slice(0, 4).join(' / '));
}

ok(consoleErrors.length === 0, 'no errors in the browser console' + (consoleErrors.length ? ': ' + consoleErrors.slice(0, 3).join(' | ') : ''));
await browser.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Browser test for coloured belt grading (/grading/coloured-belts/), the booking page and the /grading/ hub.
// Uses Black Belt Gradings's test stand-in for Supabase (a real Postgres in memory) with supabase/coloured-belts.sql.
// Run: node tests/coloured-belts-page.test.mjs   (needs ../black-belt-prep-system/tests with its node_modules, and Playwright)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const PREP_TESTS = process.env.PREP_TESTS || join(here, '../../black-belt-gradings/tests');
const PREP = join(PREP_TESTS, '..');
const CARD = process.env.CARD_REPO || join(here, '../../id-cards');
const { PGlite } = await import(join(PREP_TESTS, 'node_modules/@electric-sql/pglite/dist/index.js'));
const { startServer } = await import(pathToFileURL(join(PREP_TESTS, 'fake-supabase.mjs')).href);
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const read = p => readFileSync(p, 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// ---- Database ----
const db = new PGlite();
await db.exec(read(join(PREP_TESTS, 'supabase-stub.sql')));
await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'tate@ama.test'), ('00000000-0000-0000-0000-000000000002', 'coach@ama.test'), ('00000000-0000-0000-0000-000000000003', 'desk@ama.test')`);
for (const f of ['setup.sql', 'roles.sql', 'printed.sql']) await db.exec(read(join(CARD, 'supabase', f)));
await db.exec(read(join(PREP, 'supabase/prep-setup.sql')));
for (let i = 1; i <= 14; i++) await db.exec(read(join(PREP, `supabase/prep-update-${String(i).padStart(2, '0')}.sql`)));
await db.exec(read(join(ROOT, 'supabase/coloured-belts.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-2.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-3.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-4.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-5.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-6.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-7.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-8.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-9.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-10.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-11.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-12.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-14.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-15.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-16.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-17.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-18.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-19.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-20.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-21.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-22.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-23.sql'))); await db.exec(read(join(ROOT, 'supabase/coloured-belts-23.sql')));
await db.exec(`insert into prep_roles (email, role) values ('tate@ama.test', 'admin') on conflict do nothing; delete from prep_roles where email <> 'tate@ama.test'; insert into prep_roles (email, role) values ('coach@ama.test', 'instructor'), ('desk@ama.test', 'attendance');`);
// EFC students (made up): Sam and Kim have enough classes; Alex is overdue; Jo is at another school
await db.exec(`insert into efc_members (member_key, kind, full_name, guardian_name, phone, location, programme, belt, promoted_on, attended_since_promoted, efc_reference) values
  ('efc:m1', 'member', 'Sam Lee', 'Pat Lee', '0412 345 678', 'Marrickville', 'Taekwondo', 'Yellow Belt', current_date - 100, 30, 'AU-023-1'),
  ('efc:m2', 'member', 'Kim Ng', 'Jo Ng', '0412 000 111', 'Marrickville', 'Taekwondo', 'White Belt', current_date - 90, 26, 'AU-023-2'),
  ('efc:m3', 'member', 'Alex Kim', null, null, 'Marrickville', 'Taekwondo', 'Green Belt', current_date - 300, 5, 'AU-023-3'),
  ('efc:m4', 'member', 'Jo Bloggs', 'Mo Bloggs', '0412 000 222', 'Concord', 'Taekwondo', 'Red Three Belt', current_date - 95, 40, 'AU-258-4'),
  ('efc:m5', 'member', 'Black Belt', null, null, 'Marrickville', 'Taekwondo', 'Black Belt: First Dan', current_date - 95, 40, 'AU-023-5'),
  ('efc:m6', 'member', 'Little One', null, null, 'Marrickville', 'Taekwondo - Little Dragon', 'Yellow Belt', current_date - 95, 40, 'AU-023-6')`);
// Ages: Kim is the youngest, then Sam, then Jo
await db.exec(`update efc_members set date_of_birth = to_char(current_date - interval '11 years 2 months', 'YYYY-MM-DD') where member_key = 'efc:m1';
  update efc_members set date_of_birth = to_char(current_date - interval '8 years 1 month', 'YYYY-MM-DD') where member_key = 'efc:m2';
  update efc_members set date_of_birth = to_char(current_date - interval '14 years 3 months', 'YYYY-MM-DD') where member_key = 'efc:m4';`);

// Skip list (coloured-belts-15.sql): the hub's daily list of cancelled / on-hold students leaves them out of Who's ready
{
  const n0 = (await db.query(`select count(*)::int n from cb_students where member_key = 'efc:m3'`)).rows[0].n;
  const key = (await db.query(`select skip_key from cb_settings limit 1`)).rows[0].skip_key;
  let bad = null; try { await db.query(`select cb_skip_sync('wrong', '[]'::jsonb)`); } catch (e) { bad = e.message; }
  await db.query(`select cb_skip_sync($1, $2::jsonb)`, [key, JSON.stringify([{ efc_id: 'm3', name: 'Alex Kim', reason: 'Cancelled' }, { efc_id: 'm4', name: 'Jo Bloggs', reason: 'On hold', until: '2020-01-01' }])]);
  const n1 = (await db.query(`select count(*)::int n from cb_students where member_key = 'efc:m3'`)).rows[0].n;
  const n4 = (await db.query(`select count(*)::int n from cb_students where member_key = 'efc:m4'`)).rows[0].n;
  ok(n0 === 1 && n1 === 0 && n4 === 1 && /Wrong key/.test(bad || ''), 'the skip list (with its key) leaves cancelled students out of Who\'s ready; an ended hold does not');
  await db.query(`select cb_skip_sync($1, '[]'::jsonb)`, [key]);
  ok((await db.query(`select count(*)::int n from cb_students where member_key = 'efc:m3'`)).rows[0].n === 1, '...and the next day\'s list replaces it');
}
const users = { 'tate@ama.test': { id: '00000000-0000-0000-0000-000000000001', password: 'pw' }, 'coach@ama.test': { id: '00000000-0000-0000-0000-000000000002', password: 'pw' }, 'desk@ama.test': { id: '00000000-0000-0000-0000-000000000003', password: 'pw' } };
// 1,100 BJJ students at Sylvania whose names sort first: with Supabase's 1,000-row cap, the rest only load if the app fetches page by page
await db.exec(`insert into efc_members (member_key, kind, full_name, location, programme, belt, promoted_on, attended_since_promoted)
  select 'efc:f' || i, 'member', 'Aaa Filler ' || lpad(i::text, 4, '0'), 'Sylvania', 'BJJ', 'White Belt', current_date - 50, 3 from generate_series(1, 1100) i;
  insert into efc_grades (member_key, programme, belt, promoted_on, attended_since_promoted) select 'efc:f' || i, 'BJJ', 'White Belt', current_date - 50, 3 from generate_series(1, 1100) i on conflict do nothing`);
const server = await startServer({ db, appDir: join(here, '../../../site'), users, config: '', maxRows: 1000 });
const BASE = `http://localhost:${server.address().port}`;
const q = server.q;
const configJs = `window.TOOLKIT_CONFIG = { SUPABASE_URL: '${BASE}', SUPABASE_KEY: 'test' };`;
const fnCalls = [];
const uploads = [];   // grading photos sent to Supabase Storage
const browser = await chromium.launch();
async function open(email, path = '/grading/coloured-belts/index.html') {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(PREP_TESTS, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')) }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  // The "cb" function (tested on its own in cb-function.test.mjs): texts are recorded here
  await ctx.route('**/functions/v1/cb', async r => {
    const b = JSON.parse(r.request().postData() || '{}'); fnCalls.push(b);
    if (b.action === 'seq_test') return r.fulfill((/invite_email|ready_d4/.test(b.code) ? b.email : b.phone) ? { contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'test' }) } : { status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Enter your mobile to get the test text.' }) });
    if (b.action === 'seq_run') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, sent: 2, calls: 0, skipped: 1 }) });
    if (b.action === 'check') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ready: true, testing: true }) });
    if (b.action === 'send') {
      for (const it of b.items) if (b.kind === 'invite' && it.entry_id) await q(`update cb_entries set invited_at = now() where entry_id = '${it.entry_id}'`);
      for (const it of b.items) await q(`insert into cb_messages (entry_id, member_key, kind, body, status) values (${it.entry_id ? `'${it.entry_id}'` : 'null'}, '${it.member_key}', '${b.kind}', $1, 'test')`, [it.body]);
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ sent: b.items.length, results: b.items.map(() => ({ ok: true })), testing: true }) });
    }
    if (b.action === 'record_payment') { await q(`update cb_entries set paid = true, paid_at = now(), paid_how = $1 where entry_id = $2`, [b.how, b.entry_id]); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, booked: true }) }); }
    if (b.action === 'photo') return r.fulfill({ contentType: 'application/json', body: JSON.stringify(b.token === 'none' || b.code === 'none' ? { ok: true, first: 'Kim', photo: false, error: 'The photo isn\'t ready yet. Please check again soon.' } : { ok: true, first: 'Sam', belt_to: 'Orange Belt', school: 'Marrickville', date: '2030-11-14', photo: true, url: BASE + '/icons/black-belt-prep.png', download: BASE + '/icons/black-belt-prep.png', filename: 'Sam-Lee-AMA-grading.jpg' }) });
    // Card payments on the booking page: token "c...c" can pay by card, "e...e" has paid by card and is booked
    const base = { ok: true, first: 'Sam', belt_to: 'Orange Belt', date: '2026-11-14', time: '10:00', school: 'Marrickville', fee: 55, closed: false };
    if (b.token === 'c'.repeat(64) && b.action === 'info') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...base, card: true, booked: false, paid: false }) });
    if (b.token === 'c'.repeat(64) && b.action === 'pay') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, url: BASE + '/stripe-checkout-test' }) });
    if (b.token === '7'.repeat(64)) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...base, card: true, booked: false, paid: false, booking_closed: true, phone: '(02) 9569 1943' }) });
    if (b.token === 'e'.repeat(64)) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...base, card: true, booked: true, paid: true, paid_how: 'card' }) });
    if (b.action === 'info' || b.action === 'book') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, first: 'Sam', belt_to: 'Orange Belt', date: '2026-11-14', time: '10:00', school: 'Marrickville', fee: null, booked: b.action === 'book', closed: false }) });   // a grading with no fee: the link just books
    r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"?"}' });
  });
  // Supabase Storage (grading photos): uploads are recorded; signed links point at a test image
  await ctx.route('**/storage/v1/object/**', async r => {
    const u = new URL(r.request().url()), m = r.request().method();
    if (u.pathname.includes('/object/sign/')) { const b = JSON.parse(r.request().postData() || '{}'); return r.fulfill({ contentType: 'application/json', body: JSON.stringify((b.paths || []).map(p => ({ path: p, signedURL: '/icons/black-belt-prep.png?p=' + p, error: null }))) }); }
    if (m === 'POST' || m === 'PUT') { uploads.push({ path: u.pathname.replace(/^.*\/object\//, ''), type: r.request().headers()['content-type'], size: (r.request().postDataBuffer() || []).length, jpeg: String(r.request().postDataBuffer() || '').includes('image/jpeg') || /jpeg/.test(r.request().headers()['content-type'] || '') }); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ Key: u.pathname.replace(/^.*\/object\//, '') }) }); }
    if (m === 'DELETE') return r.fulfill({ contentType: 'application/json', body: '[]' });
    r.fulfill({ status: 404, body: '' });
  });
  // Like GitHub Pages: an address that isn't a file gets the site's 404.html
  await ctx.route(/\/grading\/coloured-belts\/(ready|grading-days|update-efc|dashboard|settings)(\/|$)/, r => r.fulfill({ status: 404, contentType: 'text/html', body: read(join(here, '../../../site/404.html')) }));
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('  page error: ' + e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE + path);
  if (email) {
    await page.waitForSelector('#siForm', { state: 'attached' });
    await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
    await page.fill('#siEmail', email); await page.fill('#siPass', 'pw'); await page.click('#siGo');
    await page.waitForFunction(() => !document.querySelector('#tabs').hidden || !document.querySelector('#noAccess').hidden);
  }
  return { ctx, page };
}
const toastSays = async (page, t) => { await page.waitForFunction(x => { const el = document.querySelector('#toast'); return !el.hidden && el.textContent.includes(x); }, t, { timeout: 5000 }).catch(() => {}); return page.textContent('#toast'); };
const settle = page => page.waitForTimeout(400);
// Close a dialog a slow reload may have reopened (e.g. a student's details after saving)
const noDialog = page => page.evaluate(() => { const d = document.querySelector('#dlg'); if (d && d.open) d.close(); });
const SHOTS = process.env.SHOT_DIR; const shot = (page, n) => SHOTS ? page.screenshot({ path: join(SHOTS, n + '.png'), fullPage: true }) : null;
// Desktop and phone pictures of the same screen (only when SHOT_DIR is set)
const shots = async (page, n) => { if (!SHOTS) return; await shot(page, n); await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(150); await shot(page, n + '-phone'); await page.setViewportSize({ width: 1100, height: 900 }); };
// Grading day buttons sit under Before / On the day / After: show the right one, then press the button
const pclick = async (page, sel) => { const st = await page.$eval(sel, el => (el.closest('[data-panel]') || {}).dataset?.panel).catch(() => null); if (st) await page.click(`[data-stage="${st}"]`).catch(() => {}); return page.click(sel); };
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

try {
  console.log('Who\'s ready');
  let { ctx, page } = await open('tate@ama.test');
  const loaded = await page.evaluate(() => ({ n: state.all.students.length, sam: state.all.students.some(s => s.member_key === 'efc:m1' && s.phone) }));
  ok(loaded.n > 1100 && loaded.sam, 'every student loads, even past Supabase\'s 1,000-row limit (so no one shows "No mobile" by mistake)');
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/ready', 'the first screen has its own address (/grading/coloured-belts/ready)');
  await shots(page, 'cb-ready');
  let list = await page.textContent('#readyList');
  ok(list.includes('Sam Lee') && list.includes('Kim Ng') && list.includes('Jo Bloggs') && !list.includes('Alex Kim'), 'students with enough classes are listed (24 by default); Alex (5 classes) is not');
  ok(!list.includes('Black Belt') && !list.includes('Little One'), 'black belts and Little Dragons are left out');
  ok((await page.textContent('#readyList [data-key="efc:m1"]')).includes('30/24 classes') && (await page.textContent('#readyList [data-key="efc:m1"]')).includes('Yellow to Orange'), 'each row shows classes against what the belt needs, and the belt they grade to');
  const order = async () => page.$$eval('#readyList [data-key]', bs => bs.map(b => b.dataset.key).join());
  ok(await order() === 'efc:m2,efc:m1,efc:m4', 'the list is in age order, youngest first (Kim 8, Sam 11, Jo 14)');
  ok((await page.textContent('#readyList [data-key="efc:m2"]')).includes('8 yrs'), 'each row shows the student\'s age');
  await page.selectOption('#fSort', 'age_desc');
  ok(await order() === 'efc:m4,efc:m1,efc:m2', 'or oldest first');
  await page.selectOption('#fSort', 'name');
  ok(await order() === 'efc:m4,efc:m2,efc:m1', 'or by name');
  await page.selectOption('#fSort', 'age');
  await page.selectOption('#fBelt', 'White Belt');
  ok(await order() === 'efc:m2', 'filter by belt');
  await page.selectOption('#fBelt', '');
  await page.selectOption('#fShow', 'overdue');
  ok((await page.textContent('#readyList')).includes('Alex Kim') && (await page.textContent('#readyList')).includes('Overdue'), 'Overdue shows students on their belt for twice the usual time');
  await page.selectOption('#fShow', 'all');
  { const t = await page.textContent('#readyList'); ok(/Not enough classes: \d+ to go/.test(t), 'students short on classes say "Not enough classes" and how many to go'); }
  await shots(page, 'cb-not-enough');
  await page.selectOption('#fShow', 'eligible'); await page.selectOption('#fSchool', 'Marrickville');
  ok(!(await page.textContent('#readyList')).includes('Jo Bloggs'), 'filter by school');
  // Black Belt Club (from the nightly EFC update)
  await q(`select cb_bbc_seen(array['m1'])`); await page.reload(); await page.waitForSelector('#readyList [data-key]');
  await page.selectOption('#fShow', 'eligible'); await page.selectOption('#fSchool', 'Marrickville');
  ok((await page.textContent('#readyList [data-key="efc:m1"]')).includes('Black Belt Club') && !(await page.textContent('#readyList [data-key="efc:m2"]')).includes('Black Belt Club'), 'students in Black Belt Club are tagged');
  await page.selectOption('#fBbc', 'yes'); let bbcL = await page.textContent('#readyList');
  ok(bbcL.includes('Sam Lee') && !bbcL.includes('Kim Ng'), 'and can be filtered to only Black Belt Club members');
  await page.selectOption('#fBbc', 'no'); bbcL = await page.textContent('#readyList');
  ok(!bbcL.includes('Sam Lee') && bbcL.includes('Kim Ng'), '...or only those not in it');
  await page.selectOption('#fBbc', '');
  await q(`update efc_members set bbc_seen_at = now() - interval '4 days' where member_key = 'efc:m2'`);
  ok((await q(`select black_belt_club from cb_students where member_key = 'efc:m2'`))[0].black_belt_club === false, 'someone not seen in EFC\'s Black Belt Club for 3 days drops off');
  await page.click('#readyList [data-key="efc:m1"]'); await page.waitForSelector('#apReady');
  await shots(page, 'cb-student');
  if (SHOTS) { await page.evaluate(() => { dlg.close(); openStudent('efc:m2', 'Taekwondo'); }); await page.waitForSelector('#dlg[open]'); await shots(page, 'cb-student-not-bbc'); await page.evaluate(() => { dlg.close(); openStudent('efc:m1', 'Taekwondo'); }); await page.waitForSelector('#apReady'); }
  ok((await page.textContent('#dlg')).includes('Black Belt Club') && (await page.textContent('#dlg')).includes('Enrolled'), 'the student screen says they are in Black Belt Club');
  await page.click('#apReady'); await toastSays(page, 'Marked ready');
  ok((await q(`select status, belt from cb_approvals where member_key = 'efc:m1'`))[0]?.status === 'ready', 'an instructor marks a student ready (for their current belt)');
  await settle(page);
  // Staff fix a mobile and email
  await page.click('#editContact'); await page.waitForSelector('#ecForm');
  await page.fill('#ecPhone', '123'); await page.click('#ecGo'); await page.waitForSelector('#ecErr:not([hidden])');
  ok((await page.textContent('#ecErr')).includes("doesn't look right"), 'a wrong mobile number is refused');
  await page.fill('#ecPhone', '+61 483 896 150'); await page.fill('#ecEmail', 'Pat@Example.com'); await page.click('#ecGo'); await page.waitForSelector('#apReady');
  const mc = (await q(`select phone, email, contact_edited_by from efc_members where member_key = 'efc:m1'`))[0];
  ok(mc.phone === '0483896150' && mc.email === 'pat@example.com' && mc.contact_edited_by === 'tate@ama.test' && (await page.textContent('#dlg')).includes('0483896150'), 'staff change a student\'s mobile and email (tidied up), and the student screen shows them');
  await q(`update efc_members set phone = '0412 345 678' where member_key = 'efc:m1'`);
  await settle(page); await page.click('#dlg [data-close]');
  await page.click('#readyList [data-key="efc:m2"]'); await page.waitForSelector('#apNot');
  await page.fill('#apNote', 'Practise your first pattern at home.'); await page.click('#apNot'); await toastSays(page, 'not yet');
  await page.waitForSelector('#apText'); await page.click('#apText'); await page.waitForSelector('#txPrev');
  const prev = await page.textContent('#txPrev');
  ok(prev.includes('Hi Jo') && prev.includes('Kim') && prev.includes('Practise your first pattern at home.'), '"Not yet" texts use the parent\'s name and the instructor\'s note');
  await page.click('#txGo'); await toastSays(page, 'sent');
  ok(fnCalls.some(c => c.action === 'send' && c.kind === 'not_ready' && c.items[0].member_key === 'efc:m2'), 'and are sent through the cb function');
  await q(`update efc_members set belt = 'Orange Belt' where member_key = 'efc:m2'`);
  ok(!(await q(`select approval from cb_students where member_key = 'efc:m2'`))[0].approval, 'a new belt in EFC starts the ready / not yet decision fresh');
  await q(`update efc_members set belt = 'White Belt' where member_key = 'efc:m2'`);

  console.log('\nGrading days');
  await page.click('.tab[data-view="days"]');
  await page.click('#newDay'); await page.waitForSelector('#dayForm');
  await page.selectOption('#dSchool', 'Marrickville');
  ok(await page.isChecked('#dFrom input[value="Marrickville"]') && await page.isChecked('#dFrom input[value="Sydenham"]') && !(await page.isChecked('#dFrom input[value="Concord"]')), 'a new Marrickville grading day takes Sydenham members too');
  await page.fill('#dDate', '2030-11-14'); await page.fill('#dTime', '10:00'); await page.fill('#dSess', 'Coloured Belt Grading');
  ok((await page.$$('#dBelts input:checked')).length === 10, 'a new grading day starts with every belt ticked');
  await page.click('#dNone'); await page.check('#dBelts input[value="White Belt"]'); await page.check('#dBelts input[value="Yellow Belt"]');
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/grading-days', 'Grading days is at /grading/coloured-belts/grading-days');
  await page.click('#dGo'); await page.waitForSelector('#addReady', { state: 'attached' });
  const dayId = (await q(`select day_id from cb_days`))[0].day_id;
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/grading-days/' + dayId, 'each grading day has its own address');
  ok((await page.textContent('#view-day')).includes('Marrickville') && (await page.textContent('#view-day')).includes('10:00am'), 'a grading day is added for a school, date and time');
  ok((await q(`select belts from cb_days`))[0].belts.join() === 'White Belt,Yellow Belt' && (await page.textContent('#view-day')).includes('White, Yellow'), 'and for the belts chosen (White and Yellow)');
  await q(`insert into cb_approvals (member_key, belt, status) values ('efc:m3', 'Green Belt', 'ready')`);   // Alex: Green, ready, but not a belt for this day
  await page.evaluate(() => loadAll().then(render)); await page.waitForSelector('#addReady', { state: 'attached' });
  await pclick(page, '#addReady'); await toastSays(page, 'Added');
  let entries = await q(`select full_name, belt_from, belt_to from cb_entries order by full_name`);
  ok(entries.length === 1 && entries[0].full_name === 'Sam Lee' && entries[0].belt_to === 'Orange Belt', '"Add everyone marked ready" adds only ready students at that school on the day\'s belts (Sam; Kim is "not yet", Alex is Green)');
  await pclick(page, '#addOne'); await page.fill('#psQ', 'Alex'); await page.waitForTimeout(200);
  ok((await page.textContent('#psList')).includes('No one matches'), 'adding by hand only offers students on the day\'s belts');
  await page.fill('#psQ', 'Kim'); await page.click('#psList [data-key="efc:m2"]');
  ok(await until(async () => (await q(`select count(*)::int n from cb_entries`))[0].n === 2), 'a student can also be added by hand');
  await page.waitForSelector('#entryList [data-entry]:has-text("Kim Ng")');
  ok((await page.$$eval('#entryList [data-entry] .name', ns => ns.map(n => n.textContent).join())) === 'Kim Ng,Sam Lee', 'the grading day list is in age order too (Kim before Sam)');
  ok((await page.textContent('#entryList')).includes('11 yrs'), '...with ages');
  await page.selectOption('#dfBelt', 'White Belt');
  ok((await page.textContent('#entryList')).includes('Kim Ng') && !(await page.textContent('#entryList')).includes('Sam Lee'), 'a grading day can be filtered by belt');
  await page.selectOption('#dfBelt', '');
  await pclick(page, '#sendInv'); await page.waitForSelector('#txPrev');
  const inv = await page.textContent('#txPrev');
  const sam = (await q(`select token from cb_entries where member_key = 'efc:m1'`))[0], kim = (await q(`select token from cb_entries where member_key = 'efc:m2'`))[0];
  ok(inv.includes('Hi Jo') && inv.includes('Yellow Belt') && inv.includes('Thursday 14 November') && inv.includes('at 10:00am') && inv.includes('/b#' + kim.token), 'the invitation preview has the date, time, belt and the family\'s own booking link');
  await page.click('#txGo');
  ok(await until(async () => (await q(`select count(*)::int n from cb_entries where invited_at is not null`))[0].n === 2), 'invited students are marked invited');
  ok(fnCalls.some(c => c.kind === 'invite' && c.items.length === 2 && c.items.some(i => i.body.includes('Hi Pat') && i.body.includes(sam.token))), 'each family gets their own text with their own link');
  await q(`update cb_entries set booked_at = now() where member_key = 'efc:m1'`);
  await page.evaluate(() => loadAll().then(render)); await settle(page);
  ok((await page.textContent('#entryList [data-entry]:has-text("Sam Lee")')).includes('Booked'), 'booked students show Booked (from the family\'s booking link)');
  ok((await page.textContent('#sendNotBooked')).includes('(1)') && (await page.textContent('#sendReminder')).includes('(1)') && (await page.textContent('#sendUnpaid')).includes('(1)'), 'reminders: to book (Kim, invited), grading day (Sam, booked), fee (Sam, unpaid)');
  await pclick(page, '#sendReminder'); await page.waitForSelector('#txPrev');
  ok((await page.textContent('#txPrev')).includes('15 minutes early') && (await page.textContent('#txPrev')).includes('Thursday 14 November'), 'the grading day reminder has its own wording');
  await page.click('#txGo');
  ok(await until(() => fnCalls.some(c => c.kind === 'reminder' && c.items.length === 1 && c.items[0].member_key === 'efc:m1')), 'and goes to booked families');
  await page.waitForSelector('#sendNotBooked', { state: 'attached' }); await pclick(page, '#sendNotBooked'); await page.waitForSelector('#txPrev');
  ok((await page.textContent('#txPrev')).includes('/b#' + kim.token), 'the reminder to book includes their booking link');
  await page.click('#dlg [data-close]');
  // Bookings close: then staff can issue someone a new link
  await q(`update cb_days set book_by = now() - interval '1 hour' where day_id = '${dayId}'`);
  await page.evaluate(() => loadAll().then(render)); await settle(page);
  ok((await page.textContent('#view-day')).includes('Bookings closed'), 'after the closing time, the grading day says bookings are closed');
  await page.click('#entryList [data-entry]:has-text("Kim Ng")'); await page.waitForSelector('#newLink');
  ok((await page.textContent('#dlg')).includes('Bookings have closed for this day'), 'a student who hasn\'t booked can be issued a new link');
  await page.click('#newLink');
  ok(await until(async () => { const k = (await q(`select token, late_ok_until from cb_entries where member_key = 'efc:m2'`))[0]; return k.token !== kim.token && k.late_ok_until; }), 'Issue new link replaces their link (the old one stops working) and lets them book late for 48 hours');
  const kim2 = (await q(`select token from cb_entries where member_key = 'efc:m2'`))[0];
  await page.waitForSelector('#txPrev');
  ok((await page.textContent('#txPrev')).includes('/b#' + kim2.token), '...and offers to text them the new link');
  await page.click('#dlg [data-close]');
  kim.token = kim2.token;
  await q(`update cb_days set book_by = null where day_id = '${dayId}'`);
  await page.evaluate(() => loadAll().then(render)); await settle(page);
  await shots(page, 'cb-day');
  if (SHOTS) { await page.click('#entryList [data-entry]'); await page.waitForSelector('#dlg[open]'); await shots(page, 'cb-entry'); await page.click('#dlg [data-close]'); }
  const gr = await page.textContent('#view-day');
  ok(gr.includes('Getting ready') && /Orange Belt\s*1\s*1/.test(await page.textContent('#view-day table')), 'Getting ready counts the belts and certificates needed');

  console.log('\nPaid, results, certificates');
  await page.click('#entryList [data-entry]:has-text("Sam Lee")'); await page.waitForSelector('#recordPay');
  await page.click('#recordPay'); await page.waitForSelector('#rpForm');
  await page.check('#rpForm input[value="cash"]'); await page.click('#rpGo'); await toastSays(page, 'Payment recorded');
  ok(fnCalls.some(c => c.action === 'record_payment' && c.how === 'cash'), 'staff record a payment taken in person (cash, EFTPOS...) through the cb function');
  ok((await q(`select paid from cb_entries where member_key = 'efc:m1'`))[0].paid === true, 'paid can be ticked');
  ok(await until(async () => (await page.textContent('#dlg').catch(() => '')).includes('Paid (cash)')), '...and it shows how they paid');
  await settle(page); await page.click('#dlg [data-close]');
  await pclick(page, '#resultsBtn'); await page.waitForSelector('.res');
  ok(new URL(page.url()).pathname.endsWith(dayId + '/results'), 'results have their own address too (.../results)');
  ok((await page.$$eval('.rescard:has-text("Sam Lee") .res button', bs => bs.map(b => b.textContent).join())) === 'Pass,Fail', 'results are just Pass or Fail');
  await page.click('.rescard:has-text("Sam Lee") button[data-r="pass"]'); await settle(page);
  await page.click('.rescard:has-text("Kim Ng") button[data-r="retest"]'); await settle(page);
  ok((await q(`select result from cb_entries where member_key = 'efc:m1'`))[0].result === 'pass' && (await q(`select result from cb_entries where member_key = 'efc:m2'`))[0].result === 'retest', 'results are entered on a tablet with big buttons and saved straight away');
  ok((await page.textContent('#resCount')).includes('2 of 2'), 'it counts how many are done');
  // A teacher writes Kim a Black Belt Club invitation (Sam is already in the club)
  ok(!(await page.$('.rescard:has-text("Sam Lee") [data-bbcinv]')), 'no Black Belt Club invite button for someone already in the club');
  await page.click('.rescard:has-text("Kim Ng") [data-bbcinv]');
  ok(await until(async () => (await page.textContent('#bbcCount').catch(() => '')) === '1' && await page.isVisible('#bbcCount'), 1500), 'pressing the button updates the Cards to write number straight away (on the results screen too)');
  await toastSays(page, 'Cards to write');
  const bbcInv = (await q(`select bbc_invited_at, bbc_invited_by from efc_members where member_key = 'efc:m2'`))[0];
  ok(bbcInv.bbc_invited_at && bbcInv.bbc_invited_by === 'tate@ama.test' && await until(async () => (await page.textContent('.rescard:has-text("Kim Ng") [data-bbcinv]').catch(() => '')).includes('asked for')), 'a teacher asks for a Black Belt Club invitation from the results screen');
  // It comes up on the Black Belt Club invitations list for whoever writes them
  await page.click('#backDay'); await page.waitForSelector('#csvPassed', { state: 'attached' });
  ok(await until(async () => (await page.textContent('#bbcCount').catch(() => '')) === '1'), 'the BBC invites tab shows how many are waiting to be written');
  if (SHOTS) { await page.click('.tab[data-view="bbc"]'); await page.waitForSelector('#view-bbc h2'); await shots(page, 'cb-bbc'); }
  await page.click('.tab[data-view="bbc"]'); await page.waitForSelector('#view-bbc h2');
  ok((await page.textContent('#view-bbc')).includes('Kim Ng') && (await page.textContent('#view-bbc')).includes('Asked for by tate@ama.test') && new URL(page.url()).pathname.endsWith('/black-belt-club'), 'the invitation comes up on the Black Belt Club invitations list (its own page)');
  await page.click('#view-bbc [data-written="efc:m2"]'); await toastSays(page, 'written');
  ok(!!(await q(`select bbc_written_at from efc_members where member_key = 'efc:m2'`))[0].bbc_written_at && await until(async () => (await page.textContent('#view-bbc')).includes('No invitations to write') && await page.isHidden('#bbcCount')), 'ticking it off records that it was written');
  // Two weeks later Kim still hasn't joined: a follow-up text to the parent
  await q(`update efc_members set bbc_written_at = now() - interval '15 days' where member_key = 'efc:m2'`);
  await page.evaluate(() => { patchStudent('efc:m2', { bbc_written_at: new Date(Date.now() - 15 * 86400000).toISOString() }); render(); });
  ok(await until(async () => (await page.textContent('#view-bbc')).includes('Follow up') && (await page.textContent('#bbcCount')) === '1'), 'two weeks after the card, someone who hasn\'t joined comes up to follow up');
  await page.click('#bbcFollow'); await page.waitForSelector('#txPrev');
  ok((await page.textContent('#txPrev')).includes("Kim's Black Belt Club invitation") && (await page.textContent('#txPrev')).includes('Hi Jo'), 'with a ready-to-send text to the parent');
  await page.click('#txGo');
  ok(await until(() => fnCalls.some(c => c.kind === 'bbc_followup' && c.items[0].member_key === 'efc:m2')) && await until(async () => !(await page.textContent('#view-bbc')).includes('Follow up')), 'once texted, they leave the follow-up list');
  // Another staff member asks for an invitation on their device: it shows here without reloading
  await page.evaluate(() => applyLive({ table: 'efc_members', eventType: 'UPDATE', new: { member_key: 'efc:m1', full_name: 'Sam Lee', guardian_name: 'Pat Lee', phone: '0412 345 678', bbc_invited_at: new Date().toISOString(), bbc_invited_by: 'coach@ama.test' } }));
  ok(await until(async () => (await page.textContent('#view-bbc')).includes('Sam Lee') && (await page.textContent('#bbcCount')) === '1'), 'an invitation asked for on another device comes up straight away, without reloading');
  await page.evaluate(() => applyLive({ table: 'efc_members', eventType: 'UPDATE', new: { member_key: 'efc:m1', full_name: 'Sam Lee', guardian_name: 'Pat Lee', phone: '0412 345 678', bbc_seen_at: new Date().toISOString() } }));
  ok(await until(async () => (await page.textContent('#view-bbc')).includes('No invitations to write')), '...and goes when it is cancelled');
  await page.click('.tab[data-view="days"]'); await page.click(`#view-days [data-day="${dayId}"]`); await pclick(page, '#resultsBtn'); await page.waitForSelector('.res');
  if (SHOTS) { await page.setViewportSize({ width: 390, height: 844 }); await shot(page, 'cb-results-phone'); await page.setViewportSize({ width: 1100, height: 900 }); }
  await page.click('#backDay'); await page.waitForSelector('#csvPassed', { state: 'attached' });
  const dl = page.waitForEvent('download'); await pclick(page, '#csvPassed'); const file = await dl;
  const csv = readFileSync(await file.path(), 'utf8');
  ok(csv.includes('Full name,Belt going for,Date') && csv.includes('Sam Lee,Orange Belt,14 November 2030') && !csv.includes('Kim Ng'), 'the certificates CSV has full name, belt going for and date, for those who passed');
  await pclick(page, '#sendCongrats'); await page.waitForSelector('#txPrev');
  ok((await page.textContent('#txPrev')).includes('Orange Belt'), 'congratulations texts go to those who passed');
  await page.click('#txGo');
  ok(await until(() => page.isDisabled('#sendCongrats').catch(() => false)), 'once sent, congratulations are not offered again');
  await pclick(page, '#sendRetest'); await page.waitForSelector('#txPrev');
  ok((await page.textContent('#txPrev')).includes('re-test') && (await page.textContent('#txPrev')).includes('Hi Jo'), 'a kind re-test message goes to re-test families');
  await page.click('#txGo');
  ok(await until(() => page.isDisabled('#sendRetest').catch(() => false)), 'and is not offered again once sent');

  console.log('\nGrading photos');
  ok(await page.isDisabled('#sendPhotos'), 'there are no photos to text before any are taken');
  await pclick(page, '#photosBtn'); await page.waitForSelector('.phcard');
  ok(new URL(page.url()).pathname.endsWith(dayId + '/photos'), 'photos have their own address (.../photos)');
  const phNames = await page.$$eval('.phcard .name', ns => ns.map(n => n.textContent).join());
  ok(phNames === 'Sam Lee', 'the photo list has the students who passed (Kim is a re-test)');
  ok(await page.getAttribute('#phFile', 'capture') === 'environment' && (await page.getAttribute('#phFile', 'accept')).includes('image'), 'Take photo opens the camera on a phone or iPad');
  ok((await page.getAttribute('.phcard:has-text("Sam Lee")', 'class')).includes('next'), 'the next student to photograph is highlighted');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const chooser = page.waitForEvent('filechooser'); await page.click('[data-shoot]'); await (await chooser).setFiles({ name: 'IMG_0001.png', mimeType: 'image/png', buffer: png });
  await toastSays(page, "Saved Sam's photo");
  const ph = (await q(`select photo_path, photo_by from cb_entries where member_key = 'efc:m1'`))[0];
  ok(ph.photo_path && ph.photo_path.startsWith(dayId + '/') && ph.photo_by === 'tate@ama.test', 'the photo saves straight away against the student, with who took it');
  ok(uploads.length === 1 && uploads[0].path.startsWith('grading-photos/' + dayId + '/') && uploads[0].jpeg, '...uploaded as a JPEG to the private grading-photos storage');
  ok((await page.textContent('[data-shoot]')).includes('Retake') && (await page.textContent('#phSend')).includes('(1)') && (await page.$('.phcard img.thumb')), 'it shows the photo, offers a retake, and Text photos (1)');
  if (SHOTS) { await page.setViewportSize({ width: 390, height: 844 }); await shot(page, 'cb-photos-phone'); await page.setViewportSize({ width: 1100, height: 900 }); }
  await page.click('#phSend'); await page.waitForSelector('#txPrev');
  const phText = await page.textContent('#txPrev');
  const samCode = (await q(`select photo_code from cb_entries where member_key = 'efc:m1'`))[0].photo_code;
  ok(/^[A-Za-z0-9]{10}$/.test(samCode) && phText.includes('Hi Pat') && phText.includes('Grandmaster') && phText.includes(BASE + '/p#' + samCode), 'the photo text has the family\'s own short photo link');
  ok(phText.length <= 160 && (await page.textContent('#txLen')).includes('fits in one SMS'), '...and fits in one SMS, which the send screen confirms');
  await page.fill('#txTpl', 'x'.repeat(150) + ' {photo}');
  ok(/2 SMS parts/.test(await page.textContent('#txLen')), 'a text too long for one SMS is flagged with how many parts');
  await page.fill('#txTpl', 'Hi {parent}, Ciarán\'s photo: {photo}');
  ok(/70 characters/.test(await page.textContent('#txLen')), '...and characters like é lower the limit to 70, which it explains');
  await page.click('#dlg [data-close]'); await page.click('#phSend'); await page.waitForSelector('#txPrev');
  await page.click('#txGo');
  ok(await until(() => fnCalls.some(c => c.kind === 'photo' && c.items.length === 1 && c.items[0].entry_id && c.items[0].body.includes('/p#' + samCode))), 'Text photos sends each family their link');
  ok(await until(async () => (await page.textContent('.phcard')).includes('texted')), '...and shows who has been texted');
  await page.click('#backDay'); await page.waitForSelector('#photosBtn', { state: 'attached' });
  ok((await page.textContent('#photosBtn')).includes('1 of 1') && await page.isDisabled('#sendPhotos'), 'the day shows photos taken, and texted photos are not offered again');
  await page.click('#entryList [data-entry]:has-text("Sam Lee")'); await page.waitForSelector('#copyPhoto');
  ok((await page.textContent('#dlg')).includes('/p#' + samCode) && (await page.textContent('#dlg')).includes('texted to the family'), 'a student\'s details show their photo link, to resend by hand if needed');
  await page.click('#dlg [data-close]');

  console.log('\nStudents from other schools');
  await page.click('.tab[data-view="days"]'); await page.click('#newDay'); await page.waitForSelector('#dayForm');
  await page.selectOption('#dSchool', 'Concord'); await page.fill('#dDate', '2030-12-05');
  ok(await page.isChecked('#dFrom input[value="Concord"]') && !(await page.isChecked('#dFrom input[value="Marrickville"]')) && !(await page.isChecked('#dFrom input[value="Sydenham"]')), 'a new day takes its own school\'s students to start with (Sydenham only goes with Marrickville)');
  await page.check('#dFrom input[value="Marrickville"]');
  await page.click('#dGo'); await until(async () => (await page.textContent('#view-day').catch(() => '')).includes('Concord'));
  const cDay = (await q(`select day_id, schools from cb_days where location = 'Concord'`))[0];
  ok(cDay.schools.join() === 'Marrickville,Concord' && (await page.textContent('#view-day')).includes('Students from Marrickville, Concord'), 'a Concord grading day can take Marrickville students too');
  await pclick(page, '#addReady'); await toastSays(page, 'Added');
  ok((await q(`select member_key from cb_entries where day_id = '${cDay.day_id}'`)).map(r => r.member_key).join() === 'efc:m3', '"Add everyone marked ready" adds ready Marrickville students (Alex) to the Concord day');
  ok(await until(async () => (await page.textContent('#entryList').catch(() => '')).includes('from Marrickville')), 'the list shows they come from Marrickville');
  ok(!(await q(`select 1 from cb_entries where day_id = '${cDay.day_id}' and member_key = 'efc:m1'`)).length, 'Sam (passed, not yet promoted in EFC) is not added again');
  await pclick(page, '#addOne'); await page.fill('#psQ', 'Jo Bloggs'); await page.waitForTimeout(200);
  ok((await page.textContent('#psList')).includes('Jo Bloggs'), 'Concord\'s own students can be added too');
  await page.check('#psAny'); await page.fill('#psQ', 'Black'); await page.waitForTimeout(200);
  ok((await page.textContent('#psList')).includes('No one matches'), '"Any school" still only offers coloured belts on the day\'s belts');
  await page.click('#dlg [data-close]');
  await q(`delete from cb_entries where day_id = '${cDay.day_id}'`); await q(`delete from cb_days where day_id = '${cDay.day_id}'`);
  await page.evaluate(() => loadAll().then(render));

  console.log('\nNightly EFC update');
  ok((await page.evaluate(() => state.efcAt)) === null, 'before any nightly update, there is no "last updated" time');
  let up = (await q(`select cb_efc_update('Taekwondo', 'Marrickville', '[["m2","White Belt","2030-01-01",44],["new-1","Yellow Belt","2030-02-02",3]]'::jsonb) r`))[0].r;
  ok(up.updated === 1 && up.missing.join() === 'new-1', 'the nightly update changes students already here and lists new ones to add');
  const kimNow = (await q(`select m.attended_since_promoted a, g.attended_since_promoted ga from efc_members m join efc_grades g on g.member_key = m.member_key and g.programme = 'Taekwondo' where m.member_key = 'efc:m2'`))[0];
  ok(kimNow.a === 44 && kimNow.ga === 44, '...for Taekwondo it updates the member (for Black Belt Gradings) and their grade together');
  up = (await q(`select cb_efc_update('Kung Fu', 'Marrickville', '[["m2","Yellow Stripe","2030-03-03",2]]'::jsonb) r`))[0].r;
  ok(up.updated === 1 && (await q(`select belt from efc_grades where member_key = 'efc:m2' and programme = 'Kung Fu'`))[0].belt === 'Yellow Stripe' && (await q(`select belt from efc_members where member_key = 'efc:m2'`))[0].belt === 'White Belt', '...other programs update just that program\'s grade');
  await q(`update efc_members set attended_since_promoted = 26 where member_key = 'efc:m2'`);
  await q(`delete from efc_grades where member_key = 'efc:m2' and programme = 'Kung Fu'`);
  let denied = false; try { await q(`set role authenticated; select cb_efc_update('Taekwondo', 'Marrickville', '[]'::jsonb); reset role;`); } catch (e) { denied = true; await q('reset role').catch(() => {}); }
  ok(denied, 'staff logins cannot run the EFC update themselves');
  await page.evaluate(() => loadAll().then(render)); await settle(page);

  console.log('\nUpdate EFC, dashboard, settings');
  await page.click('.tab[data-view="efc"]');
  ok(/last came from EFC/.test(await page.textContent('#efcAt')) && /nightly/.test(await page.textContent('#efcAt')), 'Update EFC says when belts and classes last came from EFC');
  ok((await page.textContent('#view-efc')).includes('Sam Lee') && !(await page.textContent('#view-efc')).includes('Kim Ng'), 'the Update EFC checklist lists passes to promote in EFC (not re-tests)');
  await page.check('[data-efc]');
  if (SHOTS) { await page.click('.tab[data-view="efc"]'); await page.waitForSelector('#efcAt'); await shots(page, 'cb-efc'); }
  ok(await until(async () => (await q(`select efc_done from cb_entries where member_key = 'efc:m1'`))[0].efc_done === true && (await page.textContent('#view-efc')).includes('Nothing to update in EFC')), 'ticking it off clears it from the list');
  ok((await q(`select belt from efc_members where member_key = 'efc:m1'`))[0].belt === 'Yellow Belt', 'results never change EFC\'s belt here (EFC is the master)');
  // Importing an EFC export: matches by EFC ref, adds new students, leaves other programmes alone
  const efcCsv = 'Member Ref,First Name,Surname,Date of Birth,Grade,Venue,Programme,Attended Since Grading,Medical\r\n' +
    'AU-023-3,Alex,Kim,01/02/2016,Green,AMA Marrickville,Taekwondo,30,asthma\r\n' +
    'AU-023-9,New,Kid,"5/6/2017",yellow belt,AMA Marrickville,Taekwondo,25,\r\n' +
    'AU-023-7,Tiny,Tot,1/1/2022,White,AMA Marrickville,Taekwondo - Mini Dragon,10,\r\n';
  await page.setInputFiles('#impFile', { name: 'efc.csv', mimeType: 'text/csv', buffer: Buffer.from(efcCsv) });
  await page.waitForSelector('#impGo');
  const ip = await page.textContent('#impPrev');
  ok(ip.includes('2 students to import') && ip.includes('1 in programs not graded here left out') && ip.includes('EFC ref ← Member Ref') && ip.includes('Not used: Medical'), 'an EFC file is read and its columns matched (medical notes are not used)');
  await page.click('#impGo'); await toastSays(page, 'imported');
  ok((await page.textContent('#toast')).includes('1 updated, 1 added'), 'importing reports how many were updated and added');
  const alex = (await q(`select attended_since_promoted, date_of_birth, belt from efc_members where member_key = 'efc:m3'`))[0];
  ok(alex.attended_since_promoted === 30 && alex.date_of_birth === '2016-02-01' && alex.belt === 'Green Belt', 'a student already here is updated (classes, date of birth read day first, belt name matched)');
  const kid = (await q(`select full_name, belt, location, programme from efc_members where efc_reference = 'AU-023-9'`))[0];
  ok(kid && kid.full_name === 'New Kid' && kid.belt === 'Yellow Belt' && kid.location === 'Marrickville', 'a new student is added with their belt and school');
  ok(!(await q(`select 1 from efc_members where efc_reference = 'AU-023-7'`)).length && !JSON.stringify(await q(`select * from efc_members`)).includes('asthma'), 'Mini Dragons are left out and medical notes are never stored');
  await page.waitForFunction(() => !document.querySelector('#dlg').open, null, { timeout: 10000 }).catch(async () => console.log('DLG', (await page.textContent('#dlg')).replace(/\s+/g, ' ').slice(0, 300)));
  await settle(page); await noDialog(page); await page.click('#settingsBtn'); await page.waitForSelector('#beltForm');
  await page.fill('tr[data-belt="Yellow Belt"] [name=fee]', '55'); await page.fill('tr[data-belt="White Belt"] [name=classes]', '30');
  await page.click('#saveBelts');
  await until(async () => (await q(`select classes_needed from cb_belts where programme = 'Taekwondo' and belt = 'White Belt'`))[0].classes_needed === 30); await page.waitForSelector('#saveBelts:not([disabled])'); await settle(page);
  ok((await q(`select fee, classes_needed from cb_belts where programme = 'Taekwondo' and belt = 'Yellow Belt'`))[0].fee == 55 && (await q(`select classes_needed from cb_belts where programme = 'Taekwondo' and belt = 'White Belt'`))[0].classes_needed === 30, 'each belt has its own classes needed, weeks between and fee');
  ok((await q(`select enough_classes from cb_students where member_key = 'efc:m2'`))[0].enough_classes === false, 'changing classes needed changes who is eligible (Kim has 26 of 30)');
  ok((await page.$$('#msgForm textarea[data-col]')).length === 9, 'Settings has all nine texts: invitation, reminder to book, day reminder, fee reminder, congratulations, grading photos, fail, not yet, Black Belt Club follow-up');
  await page.fill('#tpl_reminder', 'See you at {school} on {date}!');
  await page.fill('#sHook', 'https://example.com/x'); await page.click('#saveMsgs');
  ok((await toastSays(page, 'script.google.com')).includes('script.google.com'), 'the booking sheet must be a Google Apps Script web app address');
  const bkey = (await q(`select booking_key from cb_settings`))[0].booking_key;
  ok(/^[0-9a-f]{32}$/.test(bkey) && (await page.textContent('#sKey')) === bkey, 'Settings shows the key to paste into the booking sheet script');
  await page.fill('#sHook', 'https://script.google.com/macros/s/AKfycbx-Test_123/exec'); await page.click('#saveMsgs'); await toastSays(page, 'Saved');
  ok((await q(`select booking_webhook from cb_settings`))[0].booking_webhook === 'https://script.google.com/macros/s/AKfycbx-Test_123/exec' && (await q(`select reminder_text from cb_settings`))[0].reminder_text === 'See you at {school} on {date}!', 'the booking sheet address and wording are saved');
  await page.click('.tab[data-view="dash"]');
  const dash = await page.textContent('#view-dash');
  ok(dash.includes('50%') && dash.includes('1 of 2') && dash.includes('$55') && dash.includes('Alex Kim'), 'the dashboard shows the pass rate (a re-test is not a pass), grading fees paid and overdue students');
  await shots(page, 'cb-dash');

  console.log('\nAddresses');
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/dashboard', 'the dashboard is at /grading/coloured-belts/dashboard');
  await page.goBack(); await page.waitForSelector('#view-settings:not([hidden])');
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/settings', 'the back button goes back a screen (to Settings)');
  await page.goto(BASE + '/grading/coloured-belts/grading-days/' + dayId + '/results'); await page.waitForSelector('.res');
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/grading-days/' + dayId + '/results' && (await page.textContent('#view-day')).includes('Results'), 'opening a saved address (via 404.html) goes straight to that screen');
  await page.goto(BASE + '/grading/coloured-belts/update-efc'); await page.waitForSelector('#view-efc:not([hidden])');
  ok((await page.textContent('#view-efc')).includes('Update EFC') && (await page.title()).startsWith('Update EFC'), '...for every screen, with a matching page title');


  console.log('\nBooking sequence (coloured-belts-23.sql)');
  ok((await q(`select count(*)::int n from cb_seq_steps`))[0].n === 15 && (await q(`select seq_on from cb_settings`))[0].seq_on === false, 'coloured-belts-23.sql runs twice; 15 steps, and the sequence starts switched off');
  await page.goto(BASE + '/grading/coloured-belts/settings'); await page.waitForSelector('#seqPanel');
  let sp = await page.textContent('#seqPanel');
  ok(sp.includes('Off') && sp.includes('10 texts, 2 emails and 1 call') && sp.includes('Invitation text') && sp.includes('Day 2') && sp.includes('G−8') && sp.includes('Staff call on My Day') && sp.includes('Sam is preparing for their Orange Belt grading'), 'Settings shows the sequence compactly: off, a count, and the booking steps as a timeline');
  ok((await page.$$('#seqPanel textarea')).length === 0, '...with no editors open (each message is one line with a preview)');
  await page.click('#seqPanel [data-tab="booked"]');
  ok((await page.textContent('#seqPanel .sq-list')).includes('Uses the "Grading day reminder" wording') && (await page.$$('#seqPanel .sq-item')).length === 3, 'tabs show one track at a time (Booked in: 3 steps, one using the existing reminder wording)');
  await page.click('#seqPanel [data-tab="booking"]');
  await page.click('#seqPanel [data-code="nudge_d2"] .sq-row'); await page.waitForSelector('#seqPanel [data-code="nudge_d2"] [data-tpl]');
  ok((await page.inputValue('#seqPanel [data-code="nudge_d2"] [data-tpl]')).startsWith('Hi {parent}, just checking you saw') && (await page.textContent('#seqPanel [data-code="nudge_d2"]')).includes('Day 2 after the invitation at 10:00am'), "tapping a message opens its wording (Mark's) and when it goes");
  await page.click('#seqPanel [data-code="nudge_d2"] [data-test]'); const tt = await toastSays(page, 'mobile');
  ok(/mobile/.test(tt), 'Send test to me asks for your mobile first');
  await page.fill('#seqTP', '0412 999 888'); await page.dispatchEvent('#seqTP', 'change'); await page.click('#seqPanel [data-code="nudge_d2"] [data-test]'); await toastSays(page, 'Logged');
  ok(fnCalls.some(c => c.action === 'seq_test' && c.code === 'nudge_d2' && c.phone === '0412 999 888'), '...then sends the test to you');
  await page.fill('#seqPanel [data-code="nudge_d2"] [data-tpl]', 'Hi {parent}, a gentle nudge to book {first}: {link} AMA {school}'); await page.click('#seqPanel [data-code="nudge_d2"] [data-save]'); await toastSays(page, 'Saved');
  ok((await q(`select template from cb_seq_steps where code = 'nudge_d2'`))[0].template.startsWith('Hi {parent}, a gentle nudge'), 'admins can change the wording');
  await shots(page, 'cb-sequence-settings');
  const before = fnCalls.filter(c => c.action === 'seq_test').length;
  await page.click('#seqAllTests'); await toastSays(page, 'sent to you');
  ok(fnCalls.filter(c => c.action === 'seq_test').length - before === 14, 'Send all to me sends every text and email (14) for Mark to check');
  await page.click('#seqSwitch'); await toastSays(page, 'is on'); await page.waitForSelector('#seqRun');
  const son = (await q(`select seq_on, seq_on_by from cb_settings`))[0];
  ok(son.seq_on === true && son.seq_on_by === 'tate@ama.test' && (await page.textContent('#seqPanel .sq-state')).includes('On'), 'an admin switches it on (after a confirm), and it records who');
  await page.click('#seqRun'); await toastSays(page, 'Done');
  ok((await page.textContent('#toast')).includes('2 sent'), 'Run now runs it straight away');
  await page.goto(BASE + '/grading/coloured-belts/grading-days/' + dayId); await page.waitForSelector('#view-day .day-card');
  ok(!(await page.$('#sendInv')) && await page.$('#seqBtn'), 'with the sequence on, the manual Invite button is replaced by Booking sequence (invitations go automatically)');
  const ents = await q(`select entry_id, full_name from cb_entries where day_id = $1 order by full_name`, [dayId]);
  await q(`insert into cb_seq_log (entry_id, step_code, status, why) values ($1, 'invite_sms', 'sent', null), ($1, 'nudge_d2', 'skipped', 'Booked'), ($1, 'close_g8', 'missed', 'Before they were invited')`, [ents[0].entry_id]);
  await q(`insert into cb_calls (entry_id, reason, callback_on) values ($1, 'not_booked', current_date)`, [ents[ents.length - 1].entry_id]);
  // A coming grading day for the hub checks (the day above has finished)
  const hubDay = (await q(`insert into cb_days (location, grading_date, programme) values ('Concord', current_date + 10, 'Taekwondo') returning day_id`))[0].day_id;
  const hubEnt = (await q(`insert into cb_entries (day_id, member_key, full_name, belt_from, belt_to, invited_at) values ($1, 'efc:m4', 'Jo Bloggs', 'Red Three Belt', 'Cho Dan Bo', now() - interval '3 days') returning entry_id`, [hubDay]))[0].entry_id;
  await q(`insert into cb_calls (entry_id, reason, callback_on) values ($1, 'not_booked', current_date)`, [hubEnt]);
  await pclick(page, '#seqBtn'); await page.waitForSelector('#dlg .seq-grid');
  const grid = await page.textContent('#dlg .seq-grid');
  ok(grid.includes(ents[0].full_name) && grid.includes('Invited') && grid.includes('G−8') && grid.includes('To call'), 'the progress grid shows each student, step ticks, booked, paid and the call');
  ok((await page.getAttribute(`#dlg tr[data-e="${ents[0].entry_id}"] td:nth-of-type(2)`, 'title')).startsWith('Skipped: Booked'), '...each mark says what happened');
  await shots(page, 'cb-sequence-grid');
  await page.click(`#dlg tr[data-e="${ents[0].entry_id}"] [data-seq="pause"]`); await toastSays(page, 'Paused');
  ok((await q(`select seq_paused_until > now() + interval '47 hours' p from cb_entries where entry_id = $1`, [ents[0].entry_id]))[0].p === true, 'Pause stops it for 2 days');
  await page.waitForSelector(`#dlg tr[data-e="${ents[0].entry_id}"] [data-seq="resume"]`);
  await page.click(`#dlg tr[data-e="${ents[1].entry_id}"] [data-seq="skip"]`); await toastSays(page, 'Skipped');
  ok((await q(`select seq_stopped_why from cb_entries where entry_id = $1`, [ents[1].entry_id]))[0].seq_stopped_why === 'Skipped by staff', 'Skip stops it for that student');
  await page.click(`#dlg tr[data-e="${ents[1].entry_id}"] [data-seq="resume"]`); await toastSays(page, 'Resumed');
  ok((await q(`select seq_stopped_at from cb_entries where entry_id = $1`, [ents[1].entry_id]))[0].seq_stopped_at === null, 'Resume starts it again');
  await noDialog(page);

  console.log('\nThe hub: prep session bookings and calls on My Day');
  const skey = (await q(`select skip_key from cb_settings`))[0].skip_key;
  let bad = false; try { await q(`select cb_prep_sync('wrong', '[]'::jsonb)`); } catch (e) { bad = /Wrong key/.test(e.message); }
  ok(bad, 'cb_prep_sync needs the key');
  await q(`select cb_prep_sync($1, $2::jsonb)`, [skey, JSON.stringify([{ efc_id: 'm1', name: 'Sam Lee', time: '9:00am' }])]);
  ok((await q(`select session_time from cb_prep_bookings where member_key = 'efc:m1'`))[0].session_time === '9:00am', 'the hub pushes who booked the prep session, with their session time');
  const due = await q(`select * from cb_calls_due($1)`, [skey]);
  ok(due.length === 1 && due[0].student === 'Jo Bloggs' && due[0].school === 'Concord' && due[0].parent === 'Mo Bloggs' && due[0].mobile === '0412 000 222' && due[0].reason === 'not_booked', 'cb_calls_due lists who to call (finished days left out), with parent, mobile and school, for the hub');
  ok((await q(`select count(*)::int n from cb_calls_due('wrong')`))[0].n === 0, '...and nothing without the key');
  await q(`select cb_call_outcome($1, $2, 'will_book')`, [skey, due[0].entry_id]);
  ok((await q(`select count(*)::int n from cb_calls_due($1)`, [skey]))[0].n === 0 && (await q(`select callback_on - current_date d from cb_calls where entry_id = $1`, [due[0].entry_id]))[0].d === 2, '"Will book": off the list, back in 2 days');
  await q(`update cb_calls set callback_on = current_date where entry_id = $1`, [due[0].entry_id]);
  await q(`select cb_call_outcome($1, $2, 'no_answer')`, [skey, due[0].entry_id]);
  ok((await q(`select kind from cb_outbox where entry_id = $1`, [due[0].entry_id])).map(x => x.kind).join() === 'no_answer', '"No answer" queues the we-tried-calling text');
  await q(`update cb_calls set callback_on = current_date where entry_id = $1`, [due[0].entry_id]);
  await q(`select cb_call_outcome($1, $2, 'no_answer')`, [skey, due[0].entry_id]);
  ok((await q(`select done from cb_calls where entry_id = $1`, [due[0].entry_id]))[0].done === true, '...up to 2 tries, then the call is finished');
  await q(`insert into cb_calls (entry_id, reason, callback_on) values ($1, 'concern', current_date)`, [due[0].entry_id]);
  const paidNot = (await q(`select paid, booked_at from cb_entries where entry_id = $1`, [due[0].entry_id]))[0];
  await q(`select cb_call_outcome($1, $2, 'not_grading')`, [skey, due[0].entry_id]);
  const gone = await q(`select seq_stopped_why from cb_entries where entry_id = $1`, [due[0].entry_id]);
  ok(paidNot.paid || paidNot.booked_at ? gone[0].seq_stopped_why === 'Not grading' : gone.length === 0, '"Not grading" removes them from the grading day (or stops the sequence if already booked)');
  await q(`select cb_seq_switch(false)`).catch(() => {});
  await q(`update cb_settings set seq_on = false`);

  console.log('\nOther programs');
  // Kim also does Kung Fu; Lily and Max are Little Dragons
  await q(`insert into efc_grades (member_key, programme, belt, promoted_on, attended_since_promoted) values ('efc:m2', 'Kung Fu', 'Yellow Sash', current_date - 100, 30)`);
  await q(`insert into efc_members (member_key, kind, full_name, location, programme, efc_reference) values ('efc:m7', 'member', 'Lily Dragon', 'Marrickville', 'Taekwondo - Little Dragon', 'AU-023-7'), ('efc:m8', 'member', 'Max Dragon', 'Marrickville', 'Taekwondo - Little Dragon', 'AU-023-8')`);
  await q(`insert into efc_grades (member_key, programme, belt, promoted_on, attended_since_promoted) values ('efc:m7', 'Taekwondo - Little Dragon', 'Red/Black Belt', current_date - 100, 30), ('efc:m8', 'Taekwondo - Little Dragon', 'Master Belt', current_date - 100, 30)`);
  await page.goto(BASE + '/grading/coloured-belts/ready'); await page.waitForSelector('#progSel');
  ok((await page.$$eval('#progSel option', os => os.map(o => o.textContent))).join() === 'All programs,Taekwondo,Little Dragons,Kung Fu,Kickboxing,BJJ,BJJ Kids,Tricking', 'a program switcher lists every program, and All programs');
  await page.selectOption('#progSel', '*'); await page.waitForSelector('#readyList');
  let allp = await page.textContent('#readyList');
  ok(allp.includes('Kung Fu') && allp.includes('Yellow Sash') && allp.includes('Sam Lee') && (await page.title()).includes('All programs'), 'All programs shows every program\'s students together, each labelled with its program');
  await page.click('#readyList [data-key="efc:m2"][data-prog="Kung Fu"]'); await page.waitForSelector('#apReady');
  ok((await page.textContent('#dlg')).includes('Kung Fu') && (await page.textContent('#dlg')).includes('Yellow Sash'), '...and opening a student shows them in that program');
  await page.click('#dlg [data-close]'); await settle(page);
  await page.click('.tab[data-view="days"]'); await page.waitForSelector('#view-days h2');
  ok(!(await page.$('#newDay')) && (await page.textContent('#view-days')).includes('choose its program'), 'in All programs, grading days from every program are listed; adding one asks for a program');
  await page.click('.tab[data-view="ready"]');
  await page.selectOption('#progSel', 'Kung Fu'); await page.waitForSelector('#readyList');
  let kf = await page.textContent('#readyList');
  ok(kf.includes('Kim Ng') && kf.includes('Yellow Sash to Yellow Stripe') && !kf.includes('Sam Lee'), 'Kung Fu shows its own students and grades (Kim: Yellow Sash to Yellow Stripe)');
  ok((await page.title()).includes('Kung Fu'), '...and the page title says which program');
  await page.click('#readyList [data-key="efc:m2"]'); await page.waitForSelector('#apReady'); await page.click('#apReady'); await toastSays(page, 'Marked ready');
  const apps = await q(`select programme, status from cb_approvals where member_key = 'efc:m2' order by programme`);
  ok(apps.length === 2 && apps.find(a => a.programme === 'Kung Fu').status === 'ready' && apps.find(a => a.programme === 'Taekwondo').status === 'not_yet', 'ready / not yet is kept per program (Kim: ready in Kung Fu, not yet in Taekwondo)');
  await page.click('#dlg [data-close]');
  await settle(page); await noDialog(page); await page.click('#settingsBtn'); await page.waitForSelector('#beltForm');
  ok((await page.textContent('#beltForm')).includes('Each belt: Kung Fu') && (await page.$$('#beltForm tr[data-belt]')).length === 15, 'Settings shows the program\'s own grades (15 for Kung Fu)');
  await shots(page, 'cb-settings');
  await page.selectOption('#progSel', 'Taekwondo - Little Dragon');
  await page.click('.tab[data-view="days"]'); await page.click('#newDay'); await page.waitForSelector('#dayForm');
  await page.fill('#dDate', '2030-12-12'); await page.check('#dMoveUp'); await page.click('#dGo'); await page.waitForSelector('#addOne', { state: 'attached' });
  const ld = (await q(`select day_id, programme, move_up from cb_days where programme = 'Taekwondo - Little Dragon'`))[0];
  ok(ld && ld.move_up, 'a Little Dragons grading day can be for moving up to Taekwondo');
  await pclick(page, '#addOne'); await page.fill('#psQ', 'Dragon'); await page.waitForTimeout(200);
  ok((await page.textContent('#psList')).includes('to Taekwondo Yellow') && (await page.textContent('#psList')).includes('to Taekwondo Orange'), 'moving up: Little Dragon belts go to Taekwondo Yellow, Master Belt to Orange');
  await page.click('#psList [data-key="efc:m7"]');
  ok(await until(async () => (await q(`select belt_to, to_programme from cb_entries where member_key = 'efc:m7'`))[0]?.to_programme === 'Taekwondo'), '...and is saved with the new program');
  await page.waitForSelector('#entryList [data-entry]');
  ok((await page.textContent('#entryList')).includes('to Taekwondo Yellow'), 'the day\'s list shows "to Taekwondo Yellow"');
  await shot(page, 'cb-little-dragons');
  await q(`delete from cb_entries where day_id = '${ld.day_id}'`); await q(`delete from cb_days where day_id = '${ld.day_id}'`);
  await ctx.close();

  console.log('\nOther logins');
  ({ ctx, page } = await open('coach@ama.test', '/grading/coloured-belts/settings'));
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/ready', 'an instructor opening the Settings address gets Who\'s ready instead');
  ok(await page.isHidden('#settingsBtn') && (await page.textContent('#readyList')).includes('Sam Lee'), 'an instructor sees who is ready but not Settings');
  await page.click('.tab[data-view="days"]');
  ok(!(await page.$('#newDay')), '...and cannot add grading days');
  // A teacher checks students in on the day and signs off
  const ciDay = (await q(`select day_id, count(*)::int n from cb_entries group by day_id order by n desc limit 1`))[0];
  const ciEs = await q(`select entry_id, full_name from cb_entries where day_id = '${ciDay.day_id}' order by full_name`);
  await page.goto('about:blank'); await page.goto(BASE + '/grading/coloured-belts/grading-days/' + ciDay.day_id);
  await page.waitForSelector('#checkinBtn', { state: 'attached' }); await pclick(page, '#checkinBtn'); await page.waitForSelector('#ciList');
  ok(new URL(page.url()).pathname.endsWith('/check-in'), 'teachers can open check-in for a grading day (its own address, .../check-in)');
  await page.click(`#ciList [data-entry="${ciEs[0].entry_id}"] button[data-r="in"]`);
  ok(await until(async () => (await q(`select checked_in_at, checked_in_by from cb_entries where entry_id = '${ciEs[0].entry_id}'`))[0].checked_in_by === 'coach@ama.test'), 'tapping Here checks a student in (and records which teacher)');
  await shot(page, 'cb-check-in');
  ok((await page.textContent('#ciCount')).startsWith('1 of ' + ciEs.length + ' here') && !(await page.$('#ciSign')) && !(await page.$('[data-r="no_show"]')), 'the count of who is here updates (just here or not: no sign-off)');
  await page.click(`#ciList [data-entry="${ciEs[0].entry_id}"] button[data-r="in"]`);
  ok(await until(async () => (await q(`select checked_in_at from cb_entries where entry_id = '${ciEs[0].entry_id}'`))[0].checked_in_at === null), 'tapping again undoes it');
  await page.click(`#ciList [data-entry="${ciEs[0].entry_id}"] button[data-r="in"]`); await until(async () => !!(await q(`select checked_in_at from cb_entries where entry_id = '${ciEs[0].entry_id}'`))[0].checked_in_at);
  const [sheet] = await Promise.all([page.context().waitForEvent('page'), page.click('#ciPrint')]);
  await sheet.waitForLoadState(); const st = await sheet.textContent('body');
  ok(st.includes('Line-up') && st.includes(ciEs[0].full_name) && st.includes('youngest first') && st.includes('1 here') && st.includes('Examiner notes'), 'the line-up sheet lists students youngest first, who is here, and boxes for results and notes');
  await sheet.close();
  await q(`update cb_entries set checked_in_at = null, checked_in_by = null where day_id = '${ciDay.day_id}'`);
  await ctx.close();
  ({ ctx, page } = await open('desk@ama.test'));
  ok(await page.isVisible('#noAccess') && (await page.textContent('#noAccess')).includes("can't use gradings"), 'attendance-only staff are told they need a role');
  await ctx.close();

  console.log('\nBooking page and grading hub');
  ({ ctx, page } = await open(null, '/grading/coloured-belts/book/index.html#t=' + sam.token));
  await page.waitForSelector('#info:not([hidden])');
  const bt = await page.textContent('body');
  ok(bt.includes("Sam's grading for Orange Belt") && bt.includes('AMA Marrickville') && await page.isVisible('#book') && await page.isHidden('#pay'), 'the family sees the grading and school; with no fee, they just press Book');
  await page.click('#book'); await page.waitForSelector('#booked:not([hidden])');
  ok((await page.textContent('#booked')).includes('Booked') && fnCalls.some(c => c.action === 'book' && c.token === sam.token), 'pressing Book books it through the cb function');
  await page.goto('about:blank'); await page.goto(BASE + '/grading/coloured-belts/book/index.html#t=' + 'c'.repeat(64));
  await page.waitForSelector('#info:not([hidden])');
  ok((await page.textContent('#pay')).includes('Pay $55 and book') && await page.isHidden('#book') && await page.isVisible('#pay'), 'with a fee, families can only pay by card (no "pay at the desk"); staff record other payments. Families can pay $55 and book, or book and pay at the front desk');
  await Promise.all([page.waitForURL('**/stripe-checkout-test').catch(() => {}), page.click('#pay')]);
  ok(fnCalls.some(c => c.action === 'pay' && c.token === 'c'.repeat(64) && /\/grading\/coloured-belts\/book\/(index\.html)?$/.test(c.back)) && page.url().endsWith('/stripe-checkout-test'), 'Pay goes to Stripe, telling it to come back to this booking page');
  await page.goto('about:blank'); await page.goto(BASE + '/grading/coloured-belts/book/index.html?paid=1#t=' + 'e'.repeat(64));
  await page.waitForSelector('#booked:not([hidden])');
  ok((await page.textContent('#booked')).includes('Paid and booked') && await page.isHidden('#pay') && await page.isHidden('#book') && !page.url().includes('paid=1'), 'back from Stripe, it says paid and booked (and tidies the address)');
  await page.goto('about:blank'); await page.goto(BASE + '/grading/coloured-belts/book/index.html#t=' + '7'.repeat(64));
  await page.waitForSelector('#error:not([hidden])');
  ok((await page.textContent('#error')).includes('Bookings for this grading have closed') && (await page.getAttribute('#error a', 'href')) === 'tel:0295691943' && await page.isHidden('#pay') && await page.isHidden('#book'), 'after closing, the booking page says to call, with a tap-to-call number, and hides Pay and Book');
  await page.goto('about:blank'); await page.goto(BASE + '/grading/coloured-belts/book/index.html');
  await page.waitForSelector('#error:not([hidden])');
  ok((await page.textContent('#error')).includes('missing its code'), 'a link without its code explains what to do');
  await page.goto(BASE + '/p/index.html#' + samCode);
  await page.waitForSelector('#img:not([hidden])');
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/photo/' && page.url().endsWith('#c=' + samCode), 'the short link opens the photo page with the code');
  ok((await page.textContent('#title')) === "Sam's grading photo" && (await page.textContent('#sub')).includes('Orange Belt') && await page.isVisible('#save'), 'the family photo page shows their child\'s photo with a Save button');
  ok(fnCalls.some(c => c.action === 'photo' && c.code === samCode), '...fetched through the cb function with their code');
  await page.goto('about:blank'); await page.goto(BASE + '/grading/coloured-belts/photo/index.html#t=none');
  await page.waitForSelector('#error:not([hidden])');
  ok((await page.textContent('#error')).includes("isn't ready") && await page.isHidden('#save'), 'before the photo is taken, the page says it isn\'t ready yet');
  await page.goto(BASE + '/grading/index.html');
  const hub = await page.$$eval('a.pick', as => as.map(a => a.getAttribute('href')));
  ok(hub[0] === 'coloured-belts/' && hub[1].includes('Black-belt-prep-system') && hub[2].includes('ama-id-cards'), '/grading/ is a hub: coloured belts, black belts (Black Belt Gradings) and ID cards');
  await ctx.close();
} catch (e) { failed++; console.log('  FAIL  stopped: ' + String(e.message || e).split('\n').slice(0, 12).join(' / ')); }

await browser.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

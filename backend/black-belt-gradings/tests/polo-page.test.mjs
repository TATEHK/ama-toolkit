// Browser tests for black belt polo orders: the staff screen in Black Belt Gradings and the family's order page.
// Uses the local stand-in for Supabase (real database rules) with supabase/prep-update-15.sql. The "polo" and "ghl"
// functions are tested on their own; here they are played by the test, with a pretend Stripe payment page.
//   cd tests && CARD_REPO=/path/to/ama-id-cards node polo-page.test.mjs
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

const db = new PGlite();
await db.exec(read(join(here, 'supabase-stub.sql')));
await db.exec(`insert into auth.users (email) values ('owner@ama.test')`);
for (const f of ['setup.sql', 'roles.sql', 'printed.sql']) await db.exec(read(join(CARD, 'supabase', f)));
await db.exec(read(join(here, '../supabase/prep-setup.sql')));
for (let i = 1; i <= 16; i++) await db.exec(read(join(here, `../supabase/prep-update-${String(i).padStart(2, '0')}.sql`)));
await db.exec(`insert into prep_roles (email, role) values ('pay@ama.test', 'payments'), ('grade@ama.test', 'grading'), ('inst@ama.test', 'instructor');
  insert into prep_students (student_id, full_name, certificate_name, belt_rank, contact_phone, contact_email) values
    ('BB0101', 'Kian Lee', 'Kian Thomas Lee', '1st Dan Black Belt', '0412 345 678', 'lee@family.test'),
    ('BB0102', 'Ava Brown', null, '2nd Dan', '0400 111 222', null),
    ('BB0103', 'Noah Smith', null, 'Probationary Black Belt', null, null),
    ('BB0104', 'Mia Tran', null, 'Cho Dan Bo', null, null),
    ('BB0105', 'Old Grader', null, '2nd Dan', null, null);
  insert into prep_grading (student_id, grading_event, target_rank, status, result) values
    ('BB0101', 'Dan grading Nov 2026', '1st Dan Black Belt', 'passed', 'passed'),
    ('BB0102', 'Dan grading Nov 2026', '2nd Dan', 'passed', 'passed'),
    ('BB0103', 'Probationary grading Nov 2026', 'Probationary Black Belt', 'passed', 'passed'),
    ('BB0104', 'Probationary grading Nov 2026', 'Probationary Black Belt', 'unsuccessful', 'unsuccessful');
  insert into prep_grading (student_id, grading_event, target_rank, status, result, grading_date) values ('BB0105', 'Dan grading 2025', '2nd Dan', 'passed', 'passed', '2025-11-20');`);
await db.exec(read(join(here, '../../toolkit/supabase/app-permissions.sql')));   // per-feature permissions (Staff logins), from the roles above

const users = Object.fromEntries(['owner@ama.test', 'pay@ama.test', 'grade@ama.test', 'inst@ama.test'].map((e, i) => [e, { id: `00000000-0000-0000-0000-00000000001${i}`, password: 'pw' }]));
const server = await startServer({ db, appDir: join(here, '../../../site/Black-belt-prep-system'), users, config: '' });
const BASE = `http://localhost:${server.address().port}`;
const q = server.q;
const configJs = `window.PREP_CONFIG = { SUPABASE_URL: '${BASE}', SUPABASE_ANON_KEY: 'test-anon-key' };`;

const browser = await chromium.launch();
let passed = 0, failed = 0;
const ok = (c, name) => { if (c) { passed++; console.log('  pass  ' + name); } else { failed++; console.log('  FAIL  ' + name); } };
const errors = [], texts = [];
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

async function open(email, path = '/') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-AU', timezoneId: 'Australia/Sydney', acceptDownloads: true });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(here, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')) }));
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  // The "ghl" function: texts are recorded
  await ctx.route('**/functions/v1/ghl', async r => {
    const b = JSON.parse(r.request().postData() || '{}');
    if (b.action === 'check') return r.fulfill({ contentType: 'application/json', body: '{"ready":true,"testing":true}' });
    for (const it of b.items) { texts.push(it); await q(`insert into prep_messages (student_id, kind, body, status) values ($1, $2, $3, 'test')`, [it.student_id, it.kind, it.body]); }
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ sent: b.items.length, results: b.items.map(i => ({ student_id: i.student_id, ok: true })), testing: true }) });
  });
  // The "polo" function, played here: info and checkout, with a pretend Stripe page that takes the payment
  await ctx.route('**/functions/v1/polo', async r => {
    const b = JSON.parse(r.request().postData() || '{}');
    const o = (await q(`select o.*, s.full_name from prep_polo_orders o join prep_students s using (student_id) where token = $1`, [b.token]))[0];
    const st = (await q(`select * from prep_polo_settings`))[0];
    if (!o) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false,"error":"This link isn\'t right."}' });
    if (b.action === 'checkout') {
      await q(`update prep_polo_orders set status = 'pending', size = $2, qty = $3, price = $4 where order_id = $1`, [o.order_id, b.size, b.qty, st.price]);
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, url: `${BASE}/pretend-stripe?o=${o.order_id}&back=${encodeURIComponent(`${BASE}/polo/?paid=1#t=${b.token}`)}` }) });
    }
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, first: o.full_name.split(' ')[0], year: o.year, rank: o.rank, size: o.size, qty: o.qty, status: o.status,
      price: Number(st.price), amount: o.amount != null ? Number(o.amount) : null, sizes: st.sizes, open: st.is_open, note: st.note, card: true }) });
  });
  await ctx.route('**/pretend-stripe?**', async r => {
    const u = new URL(r.request().url());
    await q(`update prep_polo_orders set status = 'paid', paid_at = now(), paid_how = 'stripe', amount = price * qty, stripe_session = 'cs_1', stripe_payment = 'pi_1' where order_id = $1`, [u.searchParams.get('o')]);
    r.fulfill({ status: 302, headers: { location: u.searchParams.get('back') } });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE + path);

  if (email) {
    await page.fill('#loginEmail', email); await page.fill('#loginPassword', 'pw'); await page.click('#loginBtn');
    await page.waitForFunction(() => !document.querySelector('#app').hidden || !document.querySelector('#noAccessView').hidden, null, { timeout: 8000 });
    await page.waitForFunction(() => !document.querySelector('#view-dashboard').textContent.includes('Loading'), null, { timeout: 8000 });
  }
  return { ctx, page };
}
const toastSays = async (page, t) => { await page.waitForFunction(x => { const el = document.querySelector('#toast'); return !el.hidden && el.textContent.includes(x); }, t, { timeout: 6000 }).catch(() => {}); return page.textContent('#toast'); };
const polos = async page => { await page.click('.tab[data-view="more"]'); await page.click('[data-goto="polos"]'); await page.waitForSelector('#view-polos:not([hidden]) .stats'); };

try {
  console.log('Links for students who passed a Dan');
  let { ctx, page } = await open('owner@ama.test');
  await polos(page);
  ok((await page.textContent('#view-polos')).includes('Polo shirts'), 'Polo shirts is under More');
  const v = await page.textContent('#view-polos');
  ok(await page.inputValue('#poYear') === String(new Date().getFullYear()), 'it opens on this year\'s polo');
  ok(v.includes('Kian Thomas Lee') && v.includes('Ava Brown') && v.includes('Noah Smith') && !v.includes('Mia Tran') && !v.includes('Old Grader') && /3\s*names on the back/.test(v), 'everyone who passed Probationary Black Belt or a Dan this year is on the back (not those who didn\'t, or graded another year)');
  const dn = page.waitForEvent('download'); await page.click('#poNames'); const nf = readFileSync(await (await dn).path(), 'utf8');
  ok(nf.includes('Name,Rank,Student ID') && nf.includes('Kian Thomas Lee,1st Dan Black Belt') && nf.includes('Noah Smith,Probationary Black Belt'), 'the names for the back download as a list (certificate names)');
  await page.screenshot({ path: join(SHOTS, 'polo-staff-start.png') });
  await page.click('#poMake'); await toastSays(page, 'Polo links ready');
  const orders = await q(`select * from prep_polo_orders order by student_id`);
  ok(orders.length === 3 && orders[0].rank === '1st Dan Black Belt' && orders[2].rank === 'Probationary Black Belt' && orders.every(o => o.status === 'invited' && o.year === new Date().getFullYear() && /^[a-f0-9]{64}$/.test(o.token)), 'each gets a personal link for this year\'s polo');
  await page.waitForSelector('#poMake[disabled]');
  ok((await q(`select count(*)::int n from prep_polo_orders`))[0].n === 3, 'making links again doesn\'t make duplicates');
  await page.click('#poText'); await page.waitForSelector('#ptGo');
  const pp = await page.textContent('#ptPrev');
  ok(orders.some(o => pp.includes('/polo#' + o.token)) && pp.includes(String(new Date().getFullYear())), 'the text has the family\'s own link and the year');
  await page.click('#ptGo'); await toastSays(page, 'logged');
  ok(texts.length === 2 && texts.every(t => t.kind === 'polo') && texts.some(t => t.body.includes(orders[1].token)), 'polo links are texted through GoHighLevel');
  await ctx.close();

  console.log('\nThe family orders and pays');
  ({ ctx, page } = await open(null, '/polo/index.html#t=' + orders[0].token));
  await page.waitForSelector('#form:not([hidden])');
  ok((await page.textContent('#hello')).includes('Kian') && (await page.textContent('#intro')).includes(String(new Date().getFullYear())) && !(await page.$('#name')), 'the family sees it is this year\'s polo, with no name to type');
  await page.click('#go'); await page.waitForSelector('#err:not([hidden])');
  ok((await page.textContent('#err')).includes('size'), 'they must choose a size');
  await page.click('#sizes [data-s="M"]'); await page.selectOption('#qty', '2');
  ok((await page.textContent('#total')).includes('$90') && (await page.textContent('#total')).includes('$45 each'), 'the total is shown');
  await page.screenshot({ path: join(SHOTS, 'polo-family.png'), fullPage: true });
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])', { timeout: 10000 });
  const done = await page.textContent('#done');
  ok(done.includes('Paid') && done.includes('size M') && done.includes('$90'), 'after paying on Stripe they come back to "Paid", with the size');
  const k = (await q(`select * from prep_polo_orders where student_id = 'BB0101'`))[0];
  ok(k.status === 'paid' && k.size === 'M' && k.qty === 2 && Number(k.amount) === 90, 'the order is marked paid with the size and how many');
  await page.screenshot({ path: join(SHOTS, 'polo-family-paid.png'), fullPage: true });
  await page.goto(BASE + '/polo/index.html#t=' + 'f'.repeat(64)); await page.reload(); await page.waitForSelector('#bad:not([hidden])');
  ok(await page.isVisible('#bad'), 'a wrong link says so');
  await ctx.close();

  console.log('\nPayments, sizes and the supplier');
  ({ ctx, page } = await open('pay@ama.test'));
  await polos(page);
  ok(!(await page.$('#poMake')), 'payments staff see orders but don\'t make links');
  await page.click('[data-pof="topay"]'); await page.click('#poList [data-po]:has-text("Ava Brown")'); await page.waitForSelector('#poPaid');
  await page.selectOption('#poSize', 'L'); await page.selectOption('#poHow', 'cash'); await page.click('#poPaid'); await toastSays(page, 'Marked paid');
  const a = (await q(`select * from prep_polo_orders where student_id = 'BB0102'`))[0];
  ok(a.status === 'paid' && a.paid_how === 'cash' && a.paid_by === 'pay@ama.test' && a.size === 'L' && Number(a.amount) === 45, 'payments staff can record a polo paid another way (cash), with the size');
  await ctx.close();

  ({ ctx, page } = await open('grade@ama.test'));
  const bad = await page.evaluate(async id => (await sb.from('prep_polo_orders').update({ status: 'paid', paid_how: 'cash' }).eq('order_id', id)).error?.message || '', (await q(`select order_id from prep_polo_orders where student_id = 'BB0101'`))[0].order_id);
  await q(`update prep_polo_orders set status = 'invited', paid_at = null where student_id = 'BB0101'`);
  const bad2 = await page.evaluate(async id => (await sb.from('prep_polo_orders').update({ status: 'paid' }).eq('order_id', id)).error?.message || '', k.order_id);
  await q(`update prep_polo_orders set status = 'paid', paid_at = now() where student_id = 'BB0101'`);
  ok(/payments staff/.test(bad) && /payments staff/.test(bad2), 'only payments staff (or Stripe) can mark a polo paid');
  await polos(page);
  await page.click('[data-pof="paid"]');
  const pv = await page.textContent('#view-polos');
  ok(/Sizes to order[\s\S]*M\s*2[\s\S]*L\s*1/.test(pv), 'sizes to order are added up (M x2, L x1)');
  const dl = page.waitForEvent('download'); await page.click('#poCsv'); const file = await dl;
  const csv = readFileSync(await file.path(), 'utf8');
  ok(csv.includes('Student,Size,Qty') && csv.includes('Kian Lee,M,2') && csv.includes('Ava Brown,L,1'), 'the supplier list has each student, size and number');
  await page.click('#poOrdered'); await page.click('#askYes'); await toastSays(page, 'Marked ordered');
  ok((await q(`select count(*)::int n from prep_polo_orders where status = 'ordered' and ordered_at is not null`))[0].n === 2, 'paid orders are marked ordered once sent to the supplier');
  await page.click('[data-pof="ordered"]'); await page.click('#poList [data-po]:has-text("Kian Lee")'); await page.waitForSelector('#poDel');
  await page.click('#poDel'); await toastSays(page, 'handed out');
  ok((await q(`select status from prep_polo_orders where student_id = 'BB0101'`))[0].status === 'delivered', 'and handed out');
  await page.screenshot({ path: join(SHOTS, 'polo-staff.png'), fullPage: true });
  await ctx.close();

  console.log('\nSettings and access');
  ({ ctx, page } = await open('owner@ama.test'));
  await polos(page);
  await page.click('#poSet'); await page.waitForSelector('#psForm');
  await page.fill('#psPrice', '50'); await page.fill('#psSizes', 'S, M, L'); await page.uncheck('#psOpen'); await page.click('#psForm [type=submit]'); await toastSays(page, 'saved');
  const st = (await q(`select * from prep_polo_settings`))[0];
  ok(Number(st.price) === 50 && st.sizes.join() === 'S,M,L' && st.is_open === false, 'admins set the price, sizes and whether orders are open');
  await ctx.close();
  ({ ctx, page } = await open('inst@ama.test'));
  await page.click('.tab[data-view="more"]');
  ok(!(await page.$('[data-goto="polos"]')), 'instructors don\'t see polo orders');
  ok((await page.evaluate(async () => (await sb.from('prep_polo_orders').select('*')).data?.length ?? -1)) === 0, '...and can\'t read them');
  await ctx.close();
  ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) { failed++; console.log('  FAIL  stopped: ' + String(e.message || e).split('\n').slice(0, 3).join(' / ')); }

await browser.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Checks the "polo" Supabase function (black belt polo orders paid through Stripe) with a pretend database and a pretend Stripe.
// Run: node tests/polo-function.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(mkdtempSync(join(tmpdir(), 'polo-')), 'polo.mjs');
writeFileSync(tmp, readFileSync(join(here, '../supabase/functions/polo/index.ts'), 'utf8'));
const { handle, signatureOk } = await import(pathToFileURL(tmp).href);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

const T1 = 'a'.repeat(64), T2 = 'b'.repeat(64), T3 = 'c'.repeat(64);
const tables = {
  prep_polo_orders: [
    { order_id: 'o1', student_id: 'S1', year: 2026, rank: '1st Dan Black Belt', token: T1, name_on_back: 'Kian Lee', size: null, qty: 1, price: null, amount: null, status: 'invited', stripe_session: null },
    { order_id: 'o2', student_id: 'S2', rank: '2nd Dan', token: T2, name_on_back: 'Ava Brown', size: 'M', qty: 1, price: 45, amount: 45, status: 'paid', stripe_session: 'cs_old' },
    { order_id: 'o3', student_id: 'S3', rank: '1st Dan Black Belt', token: T3, name_on_back: 'Noah', size: null, qty: 1, status: 'cancelled' }],
  prep_polo_settings: [{ id: 1, price: 45, sizes: ['Kids 10', 'S', 'M', 'L'], is_open: true, note: 'About 4 weeks' }],
  prep_students: [{ student_id: 'S1', full_name: 'Kian Lee', contact_email: 'lee@family.test' }, { student_id: 'S2', full_name: 'Ava Brown', contact_email: null }]
};
const db = {
  from(t) {
    const f = []; let single = false, op = 'select', payload = null;
    const q = {
      select() { return q; }, eq(c, v) { f.push(r => r[c] === v); return q; }, maybeSingle() { single = true; return q; },
      update(p) { op = 'update'; payload = p; return q; },
      then(res) { const d = tables[t].filter(r => f.every(x => x(r)));
        if (op === 'update') { d.forEach(r => Object.assign(r, payload)); return Promise.resolve({ data: null, error: null }).then(res); }
        return Promise.resolve({ data: single ? d[0] || null : d, error: null }).then(res); }
    };
    return q;
  }
};
// A pretend Stripe
const calls = []; let sessionPaid = false;
const http = async (url, opts) => {
  const u = new URL(url); calls.push({ path: u.pathname, method: opts.method, headers: opts.headers, body: opts.body ? new URLSearchParams(opts.body) : null });
  const reply = (b, status = 200) => ({ ok: status < 300, status, json: async () => b });
  if (u.pathname === '/v1/checkout/sessions' && opts.method === 'POST') return reply({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
  if (u.pathname === '/v1/checkout/sessions/cs_test_1') return reply({ id: 'cs_test_1', payment_status: sessionPaid ? 'paid' : 'unpaid', amount_total: 9000, payment_intent: 'pi_1', metadata: { order_id: 'o1' } });
  return reply({ error: { message: 'No such thing' } }, 404);
};
const env = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' };
const call = (body, e = env, headers = {}) => handle(new Request('https://x.test/functions/v1/polo', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), db, e, http).then(async r => ({ status: r.status, ...(await r.json()) }));
const o1 = () => tables.prep_polo_orders[0];

console.log('The family\'s link');
let r = await call({ action: 'info', token: T1 });
ok(r.ok && r.first === 'Kian' && r.year === 2026 && r.price === 45 && r.sizes.join() === 'Kids 10,S,M,L' && r.open && r.status === 'invited', 'a link shows the first name, the year, the price and the sizes');
ok(!JSON.stringify(r).includes('lee@family.test') && !('student_id' in r), '...and nothing private');
ok((await call({ action: 'info', token: 'nope' })).status === 404 && (await call({ action: 'info', token: 'd'.repeat(64) })).status === 404, 'a wrong link is refused');
ok((await call({ action: 'info', token: T3 })).status === 404, 'a cancelled order\'s link no longer works');

console.log('\nChecking out');
r = await call({ action: 'checkout', token: T1, name_on_back: 'Kian Lee', size: 'XXL', qty: 1 });
ok(!r.ok && /size/.test(r.error) && !calls.length, 'a size that isn\'t offered is refused');
r = await call({ action: 'checkout', token: T1, name_on_back: 'Kian', size: 'M', qty: 9 });
ok(!r.ok && /1 to 5/.test(r.error), 'between 1 and 5 shirts');
r = await call({ action: 'checkout', token: T1, name_on_back: 'Kian', size: 'M', qty: 1 }, {});
ok(r.status === 409 && /aren't set up/.test(r.error), 'without the Stripe key it says card payments are not set up');
tables.prep_polo_settings[0].is_open = false;
r = await call({ action: 'checkout', token: T1, name_on_back: 'Kian', size: 'M', qty: 1 });
ok(!r.ok && /closed/.test(r.error), 'when orders are closed, nobody can pay');
tables.prep_polo_settings[0].is_open = true;
r = await call({ action: 'checkout', token: T1, size: 'L', qty: 2 });
ok(r.ok && r.url === 'https://checkout.stripe.com/c/pay/cs_test_1', 'checkout gives the Stripe payment page');
const c = calls.find(x => x.path === '/v1/checkout/sessions' && x.method === 'POST').body;
ok(c.get('line_items[0][price_data][unit_amount]') === '4500' && c.get('line_items[0][quantity]') === '2' && c.get('line_items[0][price_data][currency]') === 'aud', 'Stripe is asked for $45 AUD x 2');
ok(c.get('metadata[order_id]') === 'o1' && c.get('client_reference_id') === 'o1' && c.get('customer_email') === 'lee@family.test', 'the payment carries the order (and the family\'s email for the receipt)');
ok(c.get('success_url').endsWith('?paid=1#t=' + T1) && c.get('cancel_url').endsWith('#t=' + T1), 'Stripe sends them back to their link');
ok(o1().status === 'pending' && o1().size === 'L' && o1().qty === 2 && o1().price === 45 && o1().stripe_session === 'cs_test_1', 'the size and number are saved before paying');
ok(c.get('line_items[0][price_data][product_data][name]') === 'AMA 2026 black belt polo', 'Stripe shows it as the 2026 polo');

console.log('\nPaid');
r = await call({ action: 'info', token: T1 });
ok(r.status === 'pending' && o1().status === 'pending', 'not paid yet: still waiting');
sessionPaid = true;
r = await call({ action: 'info', token: T1 });
ok(r.status === 'paid' && r.amount === 90 && o1().status === 'paid' && o1().paid_how === 'stripe' && o1().stripe_payment === 'pi_1' && o1().amount === 90, 'back from Stripe: the payment is checked with Stripe and the order marked paid');
r = await call({ action: 'checkout', token: T1, name_on_back: 'Kian', size: 'M', qty: 1 });
ok(!r.ok && /already paid/.test(r.error), 'a paid order can\'t be paid again');

console.log('\nStripe webhook');
Object.assign(o1(), { status: 'pending', paid_at: null, amount: null, stripe_payment: null });
const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', amount_total: 9000, payment_intent: 'pi_9', client_reference_id: 'o1', metadata: { order_id: 'o1' } } } });
const sign = (body, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
r = await call(event, env, { 'stripe-signature': sign(event, 'whsec_wrong') });
ok(r.status === 400 && o1().status === 'pending', 'a webhook with a bad signature is refused');
r = await call(event, env, { 'stripe-signature': sign(event, 'whsec_test', Math.floor(Date.now() / 1000) - 3600) });
ok(r.status === 400, 'an old (replayed) webhook is refused');
r = await call(event, env, { 'stripe-signature': sign(event) });
ok(r.received && o1().status === 'paid' && o1().stripe_payment === 'pi_9' && o1().amount === 90, 'Stripe\'s webhook marks the order paid');
const paidAt = o1().paid_at;
r = await call(event, env, { 'stripe-signature': sign(event) });
ok(r.received && o1().paid_at === paidAt, 'the same webhook twice changes nothing');
ok(await signatureOk('x', 't=1,v1=00', 'whsec') === false, 'signatures are checked properly');

console.log('\nOther');
ok((await handle(new Request('https://x.test/', { method: 'GET' }), db, env, http)).status === 405, 'only POST');
ok((await handle(new Request('https://x.test/', { method: 'OPTIONS' }), db, env, http)).status === 200, 'browser pre-check (CORS) is answered');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

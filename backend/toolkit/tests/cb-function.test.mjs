// Tests the "cb" Edge Function (coloured belt booking links and texts) against an in-memory stand-in for Supabase.
// Run: node tests/cb-function.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(mkdtempSync(join(tmpdir(), 'cb-')), 'cb.mjs');
writeFileSync(tmp, readFileSync(join(here, '../supabase/functions/cb/index.ts'), 'utf8'));
const { handle, phoneE164, signatureOk, backTo } = await import(pathToFileURL(tmp).href);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// ---- In-memory tables ----
const TOKEN = 'a'.repeat(64), TOKEN2 = 'b'.repeat(64);
const t = {
  cb_entries: [{ entry_id: 'e1', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN, booked_at: null, booking_error: null, result: null, invited_at: null },
               { entry_id: 'e2', day_id: 'd2', member_key: 'efc:m2', full_name: 'Kim Ng', belt_from: 'White Belt', belt_to: 'Yellow Belt', token: TOKEN2, booked_at: null, booking_error: null, result: null, invited_at: null }],
  cb_days: [{ day_id: 'd1', location: 'Marrickville', grading_date: '2026-11-14', start_time: '10:00:00', efc_session_id: 'sess-1', closed: false },
            { day_id: 'd2', location: 'Sydenham', grading_date: '2026-11-15', start_time: null, efc_session_id: null, closed: true }],
  cb_belts: [{ programme: 'Taekwondo', belt: 'Yellow Belt', fee: 55 }, { programme: 'Taekwondo', belt: 'White Belt', fee: null }, { programme: 'Kung Fu', belt: 'Yellow Belt', fee: 99 }],
  cb_settings: [{ id: 1, booking_webhook: null }],
  efc_members: [{ member_key: 'efc:m1', efc_reference: 'AU-023-1', full_name: 'Sam Lee', guardian_name: 'Pat Lee', phone: '0412 345 678', guardian_phone: null, email: 'pat@example.test', guardian_email: null },
                { member_key: 'efc:m2', efc_reference: 'AU-256-2', full_name: 'Kim Ng', guardian_name: 'Jo Ng', phone: null, guardian_phone: null, email: null, guardian_email: null }],
  prep_roles: [{ email: 'grader@ama.test', role: 'grading' }, { email: 'coach@ama.test', role: 'instructor' }, { email: 'desk@ama.test', role: 'attendance' }],
  cb_messages: [],
  cb_payments: []
};
const db = {
  from(table) {
    let filters = [], op = 'select', payload = null, single = false;
    const q = {
      select() { return q; }, eq(c, v) { filters.push(r => r[c] === v); return q; }, in(c, vs) { filters.push(r => vs.includes(r[c])); return q; }, gte(c, v) { filters.push(r => String(r[c]) >= String(v)); return q; }, maybeSingle() { single = true; return q; },
      update(p) { op = 'update'; payload = p; return q; }, insert(p) { op = 'insert'; payload = p; return q; },
      then(res, rej) {
        return Promise.resolve().then(() => {
          const rows = t[table].filter(r => filters.every(f => f(r)));
          if (op === 'update') { rows.forEach(r => Object.assign(r, payload)); return { data: null, error: null }; }
          if (op === 'insert') { t[table].push({ ...payload }); return { data: null, error: null }; }
          return { data: single ? rows[0] || null : rows, error: null };
        }).then(res, rej);
      }
    };
    return q;
  },
  // The nightly clean-up's database helpers
  async rpc(name, args) {
    if (name === 'cb_cron_ok') return { data: args.p_secret === 'night-secret', error: null };
    if (name === 'cb_old_photos') return { data: oldPhotos.slice(), error: null };
    if (name === 'cb_photos_removed') { let n = 0; for (const e of t.cb_entries) if (args.p_names.includes(e.photo_path)) { e.photo_path = null; e.photo_removed_at = 'now'; n++; } return { data: n, error: null }; }
    return { data: null, error: { message: 'no rpc ' + name } };
  },
  storage: { from(bucket) { return { async remove(names) { removedFiles.push(...names.map(n => bucket + '/' + n)); return { data: [], error: null }; }, async createSignedUrl(path, secs, opts) { signed.push({ bucket, path, secs, opts }); return { data: { signedUrl: `https://store.test/${bucket}/${path}?ttl=${secs}${opts && opts.download ? '&download=' + opts.download : ''}` }, error: null }; } }; } },
  auth: { async getUser(tok) { const email = { 'tok-grader': 'grader@ama.test', 'tok-coach': 'coach@ama.test', 'tok-desk': 'desk@ama.test' }[tok]; return { data: { user: email ? { email } : null } }; } }
};
const signed = [], removedFiles = [], oldPhotos = [];
const hooks = [];
let hookStatus = 200;
// Stripe stand-in: Checkout sessions are created here and can be marked paid
const stripeCalls = [], stripeSessions = {}, sheetRows = [], ghlCalls = [];
let nextSess = 1;
const http = async (url, opts) => {
  if (url.startsWith('https://script.google.com/')) { const b = JSON.parse(opts.body); sheetRows.push(b); return new Response(JSON.stringify(b.key === 'sheet-key' ? { ok: true } : { ok: false, error: 'Wrong key' }), { status: 200 }); }
  if (url.startsWith('https://hooks.zapier.com/')) { hooks.push(JSON.parse(opts.body)); return new Response('{"status":"success"}', { status: hookStatus }); }
  if (url.startsWith('https://services.leadconnectorhq.com/')) {
    ghlCalls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.includes('/contacts/search/duplicate')) return new Response(JSON.stringify({ contact: { id: 'c-1' } }), { status: 200 });
    return new Response(JSON.stringify({ messageId: 'm-' + ghlCalls.length }), { status: 200 });
  }
  if (url.startsWith('https://api.stripe.com/v1/payment_intents/')) { const id = decodeURIComponent(url.split('/').pop().split('?')[0]); return new Response(JSON.stringify({ id, latest_charge: { receipt_url: 'https://pay.stripe.test/receipts/' + id } }), { status: 200 }); }
  if (url.startsWith('https://api.stripe.com/v1/checkout/sessions')) {
    stripeCalls.push({ url, method: opts.method, body: opts.body ? decodeURIComponent(opts.body) : '', auth: opts.headers.Authorization });
    if (opts.method === 'POST') {
      const f = Object.fromEntries(new URLSearchParams(opts.body));
      const id = 'cs_test_' + nextSess++;
      stripeSessions[id] = { id, url: 'https://checkout.stripe.test/' + id, payment_status: 'unpaid', amount_total: Number(f['line_items[0][price_data][unit_amount]']), metadata: { kind: f['metadata[kind]'], entry_id: f['metadata[entry_id]'] }, client_reference_id: f.client_reference_id, payment_intent: 'pi_' + id, _form: f };
      return new Response(JSON.stringify(stripeSessions[id]), { status: 200 });
    }
    const id = decodeURIComponent(url.split('/').pop());
    return new Response(JSON.stringify(stripeSessions[id] || {}), { status: stripeSessions[id] ? 200 : 404 });
  }
  throw new Error('unexpected ' + url);
};
const call = async (body, tok, env = {}) => {
  const res = await handle(new Request('https://x.test/functions/v1/cb', { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) }), db, env, http);
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log('Booking links (no sign-in)');
let r = await call({ action: 'info', token: TOKEN });
ok(r.status === 200 && r.body.first === 'Sam' && r.body.belt_to === 'Orange Belt' && r.body.school === 'Marrickville' && r.body.time === '10:00' && r.body.fee === 55 && !r.body.booked, 'a booking link shows the first name, belt, school, time and fee');
ok(!JSON.stringify(r.body).includes('0412') && !JSON.stringify(r.body).includes('Lee'), '...and nothing private (no surname or phone)');
t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';
r = await call({ action: 'book', token: TOKEN }, null, { STRIPE_SECRET_KEY: 'sk_test_x' });
ok(r.body.ok === false && /pay the grading fee by card/.test(r.body.error) && !t.cb_entries[0].booked_at && !hooks.length, 'with a fee, the link can\'t book without paying by card (no "pay at the desk")');
r = await call({ action: 'book', token: TOKEN });
ok(r.body.ok === false && /call us/.test(r.body.error), '...and without card payments set up, it says to call');
t.cb_settings[0].booking_webhook = null;
t.cb_belts[0].fee = null;   // no fee: the link books straight away (the booking tests below)
r = await call({ action: 'info', token: 'nope' });
ok(r.status === 404 && /isn't valid/.test(r.body.error) && /9569 1943/.test(r.body.error), 'a wrong or replaced link is refused, with the number to call');
r = await call({ action: 'book', token: TOKEN });
ok(r.body.ok === false && /isn't set up/.test(r.body.error) && !hooks.length, 'without a booking Zap saved, it says booking is not set up');
t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';
hookStatus = 500;
r = await call({ action: 'book', token: TOKEN });
ok(r.status === 502 && t.cb_entries[0].booking_error && !t.cb_entries[0].booked_at, 'if Zapier fails, it is not marked booked and the error is kept for staff');
hookStatus = 200;
r = await call({ action: 'book', token: TOKEN });
const h = hooks[hooks.length - 1];
ok(r.body.ok && r.body.booked && t.cb_entries[0].booked_at && !t.cb_entries[0].booking_error, 'pressing Book marks it booked');
ok(h.member_id === 'm1' && h.efc_ref === 'AU-023-1' && h.date === '2026-11-14' && h.session_id === 'sess-1' && h.location_id === 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58' && h.belt_to === 'Orange Belt' && h.programme === 'Taekwondo', 'the Zap gets the EFC member ID, date, session and location to book');
const n = hooks.length;
r = await call({ action: 'book', token: TOKEN });
ok(r.body.booked && hooks.length === n, 'booking twice does not book again');
r = await call({ action: 'book', token: TOKEN2 });
ok(r.body.ok === false && /finished/.test(r.body.error), 'a finished grading cannot be booked');
t.cb_settings[0].booking_webhook = 'https://evil.test/steal';
r = await call({ action: 'info', token: TOKEN2 });
ok(r.body.first === 'Kim', 'a link still opens when the day has no EFC session ID');

console.log('\nTexts (staff)');
r = await call({ action: 'send', kind: 'invite', items: [{ member_key: 'efc:m1', body: 'hi' }] });
ok(r.status === 401, 'staff actions need a sign-in');
r = await call({ action: 'check' }, 'tok-desk');
ok(r.status === 403, 'attendance-only staff cannot use it');
r = await call({ action: 'send', kind: 'invite', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'hi' }] }, 'tok-coach', { GHL_TEST: '1' });
ok(r.status === 403, 'instructors cannot send invitations');
r = await call({ action: 'send', kind: 'not_ready', items: [{ member_key: 'efc:m1', body: 'Keep going' }] }, 'tok-coach');
ok(r.status === 409 && /not set up/.test(r.body.error), 'without GoHighLevel set up, it says so');
r = await call({ action: 'send', kind: 'not_ready', items: [{ member_key: 'efc:m1', body: 'Keep going' }, { member_key: 'efc:m2', body: 'Keep going' }] }, 'tok-coach', { GHL_TEST: '1' });
ok(r.body.sent === 1 && r.body.testing && r.body.results[1].error === 'No mobile number', 'instructors can send "not yet" messages; a student with no mobile is reported');
ok(t.cb_messages.some(m => m.kind === 'not_ready' && m.status === 'test' && m.phone === '+61412345678' && m.sent_by === 'coach@ama.test'), 'each text is logged with who sent it');
r = await call({ action: 'send', kind: 'invite', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'You are invited' }] }, 'tok-grader', { GHL_TEST: '1' });
ok(r.body.sent === 1 && t.cb_entries[0].invited_at, 'an invitation marks the student invited');
r = await call({ action: 'send', kind: 'reminder', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'See you Saturday' }] }, 'tok-grader', { GHL_TEST: '1' });
ok(r.body.sent === 1 && t.cb_messages.some(m => m.kind === 'reminder'), 'grading staff can send the newer texts (reminders, fee, re-test)');
// Cancelled / on hold (coloured-belts-15.sql): never texted, even when already on a day
t.cb_skip = [{ member_key: 'efc:m1', reason: 'Cancelled', until: null, source: 'hub' }];
const skipBefore = t.cb_messages.length;
r = await call({ action: 'send', kind: 'reminder', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'See you Saturday' }] }, 'tok-grader', { GHL_TEST: '1' });
ok(r.body.sent === 0 && r.body.results[0].skipped && /Cancelled/.test(r.body.results[0].error) && t.cb_messages.length === skipBefore, 'a cancelled student on the skip list is not texted');
t.cb_skip = [{ member_key: 'efc:m1', reason: 'On hold', until: '2020-01-01', source: 'hub' }];
r = await call({ action: 'send', kind: 'reminder', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'See you Saturday' }] }, 'tok-grader', { GHL_TEST: '1' });
ok(r.body.sent === 1, '...but once their hold has ended, they are texted again');
t.cb_skip = [];
r = await call({ action: 'send', kind: 'unpaid', items: [{ member_key: 'efc:m1', body: 'Fee' }] }, 'tok-coach', { GHL_TEST: '1' });
ok(r.status === 403, '...instructors cannot send fee reminders');
r = await call({ action: 'send', kind: 'party', items: [] }, 'tok-grader', { GHL_TEST: '1' });
ok(r.status === 400, 'unknown kinds are refused');
ok(phoneE164('0412 345 678') === '+61412345678' && phoneE164('+61 412 345 678') === '+61412345678' && phoneE164('12') === null, 'mobiles are turned into +61 form');


console.log('\nGrading photo links (no sign-in)');
r = await call({ action: 'photo', token: 'nope' });
ok(r.status === 404 && /isn't valid/.test(r.body.error), 'a wrong photo link is refused');
r = await call({ action: 'photo', token: TOKEN });
ok(r.body.ok && r.body.first === 'Sam' && r.body.photo === false && /isn't ready/.test(r.body.error) && !signed.length, 'before the photo is taken, the link says it is not ready yet');
t.cb_entries[0].photo_path = 'd1/e1-1.jpg'; t.cb_entries[0].photo_code = 'Ab3dE9xYz1';
r = await call({ action: 'photo', code: 'Ab3dE9xYz1' });
ok(r.body.photo && r.body.first === 'Sam', 'the short code from a photo text finds the photo');
r = await call({ action: 'photo', code: 'Zz9zZz9zZz' });
ok(r.status === 404, 'a wrong short code is refused');
r = await call({ action: 'photo', code: "x' or 1=1" });
ok(r.status === 404, 'a malformed code is refused');
r = await call({ action: 'photo', token: TOKEN });
ok(r.body.photo && r.body.url.startsWith('https://store.test/grading-photos/d1/e1-1.jpg') && /download=Sam-Lee-AMA-grading\.jpg/.test(r.body.download), 'with a photo, the family gets a short-lived link to view it and one to save it');
ok(signed.every(x => x.bucket === 'grading-photos' && x.secs <= 3600), '...the links come from the private bucket and last an hour at most');
ok(!JSON.stringify(r.body).includes('0412') && r.body.school === 'Marrickville', '...and nothing private comes back');
r = await call({ action: 'send', kind: 'photo', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'Your photo' }] }, 'tok-coach', { GHL_TEST: '1' });
ok(r.status === 403, 'instructors cannot text photos');
r = await call({ action: 'send', kind: 'photo', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'Your photo' }] }, 'tok-grader', { GHL_TEST: '1' });
ok(r.body.sent === 1 && t.cb_messages.some(m => m.kind === 'photo' && m.entry_id === 'e1'), 'grading staff can text photo links, and each is logged');


console.log('\nPhotos removed after 30 days');
const callCron = async (secret) => { const res = await handle(new Request('https://x.test/functions/v1/cb', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-cb-cron': secret } : {}) }, body: JSON.stringify({ action: 'cleanup' }) }), db, {}, http); return { status: res.status, body: await res.json() }; };
r = await callCron(null);
ok(r.status === 403 && !removedFiles.length, 'the clean-up refuses anyone without the nightly secret');
r = await callCron('guess');
ok(r.status === 403, '...or with the wrong one');
oldPhotos.push('d1/e1-1.jpg', 'd1/old-retake.jpg');
r = await callCron('night-secret');
ok(r.body.ok && r.body.removed === 2 && removedFiles.join() === 'grading-photos/d1/e1-1.jpg,grading-photos/d1/old-retake.jpg', 'it deletes photos older than 30 days from storage (including old retakes)');
ok(t.cb_entries[0].photo_path === null && t.cb_entries[0].photo_removed_at && r.body.cleared === 1, '...and marks the student\'s photo as removed');
r = await call({ action: 'photo', code: 'Ab3dE9xYz1' });
ok(r.body.ok && r.body.removed && !r.body.photo && /kept for 30 days/.test(r.body.error), 'the family\'s link then says the photo was removed after 30 days');


console.log('\nPay by card, then book (Stripe)');
t.cb_belts[0].fee = 55;
const TOKEN3 = 'c'.repeat(64), TOKEN4 = 'd'.repeat(64);
t.cb_entries.push({ entry_id: 'e3', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN3, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null },
                  { entry_id: 'e4', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN4, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';
const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET_GRADING: 'whsec_grading' };
r = await call({ action: 'info', token: TOKEN3 });
ok(r.body.card === false && r.body.fee === 55, 'without Stripe set up, the booking page doesn\'t offer card payment');
r = await call({ action: 'pay', token: TOKEN3 });
ok(r.status === 409 && /front desk/.test(r.body.error), '...and paying by card says to pay at the front desk');
r = await call({ action: 'info', token: TOKEN3 }, null, STRIPE_ENV);
ok(r.body.card === true && r.body.paid === false && r.body.booked === false, 'with Stripe set up and a fee, the family can pay by card');
r = await call({ action: 'pay', token: TOKEN3, back: 'https://evil.test/steal' }, null, STRIPE_ENV);
const cs = stripeSessions[Object.keys(stripeSessions).pop()];
ok(cs._form.customer_email === 'pat@example.test' && cs._form['payment_intent_data[receipt_email]'] === 'pat@example.test', 'Stripe is given the family\'s email from EFC, so it emails them a receipt');
ok(r.body.ok && r.body.url === cs.url && cs.amount_total === 5500 && cs._form['line_items[0][price_data][currency]'] === 'aud' && cs.metadata.kind === 'grading' && cs.metadata.entry_id === 'e3', 'Pay sends them to Stripe for the belt\'s fee ($55, AUD), tagged as a grading payment');
ok(cs._form.success_url === 'https://app.train-ama.com/grading/coloured-belts/book/?paid=1#t=' + TOKEN3 && !cs._form.success_url.includes('evil'), '...and Stripe only sends them back to AMA\'s own booking page');
ok(backTo('https://app.australianmartialarts.com.au/grading/coloured-belts/book/') === 'https://app.australianmartialarts.com.au/grading/coloured-belts/book/', '...including on the AMA domain later');
ok(t.cb_payments.length === 1 && t.cb_payments[0].status === 'pending' && t.cb_payments[0].amount === 55 && !t.cb_entries.find(e => e.entry_id === 'e3').paid, 'a pending payment is recorded; they are not paid until Stripe says so');
const before = hooks.length;
const hook = async (obj, secret = 'whsec_grading', type = 'checkout.session.completed') => {
  const raw = JSON.stringify({ type, data: { object: obj } }), ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigHex = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts + '.' + raw)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const res = await handle(new Request('https://x.test/functions/v1/cb', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sigHex}` }, body: raw }), db, STRIPE_ENV, http);
  return { status: res.status, body: await res.json() };
};
r = await hook({ ...cs, payment_status: 'paid' }, 'whsec_wrong');
ok(r.status === 400 && !t.cb_entries.find(e => e.entry_id === 'e3').paid, 'a webhook with the wrong signature is refused');
r = await hook({ ...cs, payment_status: 'paid' });
const e3 = t.cb_entries.find(e => e.entry_id === 'e3');
ok(r.body.received && e3.paid && e3.paid_how === 'card' && t.cb_payments[0].status === 'paid' && t.cb_payments[0].amount === 55, 'when Stripe confirms the payment, they are marked paid by card');
ok(t.cb_payments[0].receipt_url === 'https://pay.stripe.test/receipts/pi_' + cs.id, '...and Stripe\'s receipt is kept');
r = await call({ action: 'info', token: TOKEN3 }, null, STRIPE_ENV);
ok(r.body.receipt === t.cb_payments[0].receipt_url, 'the booking page links to the receipt');
ok(e3.booked_at && hooks.length === before + 1 && hooks[hooks.length - 1].paid === true && hooks[hooks.length - 1].session_id === 'sess-1' && hooks[hooks.length - 1].member_id === 'm1', '...and the Zap is sent the booking (member, session, school, date) straight away');
r = await hook({ ...cs, payment_status: 'paid' });
ok(hooks.length === before + 1 && t.cb_payments.length === 1, 'Stripe sending the same payment twice does not book twice');
r = await call({ action: 'pay', token: TOKEN3 }, null, STRIPE_ENV);
ok(r.body.ok === false && /already paid/.test(r.body.error), 'a paid grading cannot be paid again');
r = await hook({ id: 'cs_polo', payment_status: 'paid', metadata: { order_id: 'o1' } });
ok(r.body.received && t.cb_payments.length === 1, 'polo shirt payments are ignored here');
// Coming back from Stripe before the webhook arrives
r = await call({ action: 'pay', token: TOKEN4 }, null, STRIPE_ENV);
const cs4 = stripeSessions[Object.keys(stripeSessions).pop()];
cs4.payment_status = 'paid'; hookStatus = 500;
r = await call({ action: 'info', token: TOKEN4 }, null, STRIPE_ENV);
const e4 = t.cb_entries.find(e => e.entry_id === 'e4');
ok(r.body.paid && e4.paid_how === 'card', 'coming back from Stripe, the page checks with Stripe and shows it paid (even before the webhook)');
ok(!e4.booked_at && e4.booking_error && r.body.booking_failed, '...and if the Zap fails, it stays paid and the page says the booking needs doing (staff see the error)');
hookStatus = 200;



console.log('\nPayments taken by staff (cash, EFTPOS)');
const TOKEN7 = '7'.repeat(64);
t.cb_entries.push({ entry_id: 'e7', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN7, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
const staffCall = (b, tok) => call(b, tok, {});
r = await staffCall({ action: 'record_payment', entry_id: 'e7', how: 'cash' }, 'tok-coach');
ok(r.status === 403, 'instructors cannot record payments');
r = await staffCall({ action: 'record_payment', entry_id: 'e7', how: 'bitcoin' }, 'tok-grader');
ok(r.status === 400, 'the payment type must be cash, EFTPOS, bank transfer or other');
const hb = hooks.length;
r = await staffCall({ action: 'record_payment', entry_id: 'e7', how: 'eftpos' }, 'tok-grader');
const e7 = t.cb_entries.find(e => e.entry_id === 'e7');
ok(r.body.ok && r.body.booked && e7.paid && e7.paid_how === 'eftpos' && e7.booked_at && hooks.length === hb + 1, 'grading staff record an EFTPOS payment: marked paid and booked into the EFC session');
r = await staffCall({ action: 'record_payment', entry_id: 'e7', how: 'cash' }, 'tok-grader');
ok(r.body.already && hooks.length === hb + 1 && e7.paid_how === 'eftpos', 'recording it twice changes nothing');
t.cb_belts[0].fee = null;

console.log('\nBooking sheet (Google Sheets, then a Zap books from new rows)');
const TOKEN5 = 'f'.repeat(64);
t.cb_entries.push({ entry_id: 'e5', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN5, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
t.cb_settings[0].booking_webhook = 'https://script.google.com/macros/s/AKfycbx-Test_123/exec'; t.cb_settings[0].booking_key = 'wrong';
r = await call({ action: 'book', token: TOKEN5 });
const e5 = t.cb_entries.find(e => e.entry_id === 'e5');
ok(r.status === 502 && !e5.booked_at && /Wrong key/.test(e5.booking_error), 'if the sheet\'s script has a different key, it is not marked booked and staff see why');
t.cb_settings[0].booking_key = 'sheet-key';
r = await call({ action: 'book', token: TOKEN5 });
const row = sheetRows[sheetRows.length - 1];
ok(r.body.booked && e5.booked_at && row.key === 'sheet-key' && row.member_id === 'm1' && row.session_id === 'sess-1' && row.location_id === 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58' && row.date === '2026-11-14' && row.student === 'Sam Lee', 'Book adds a row to the booking sheet with everything the Zap needs (member, session, school, date)');
t.cb_settings[0].booking_webhook = 'https://script.google.com/macros/s/x/exec/../evil'; e5.booked_at = null;
r = await call({ action: 'book', token: TOKEN5 });
ok(r.body.ok === false && /isn't set up/.test(r.body.error), 'only a real Apps Script web app address (or Zapier hook) is used');

console.log('\nBookings close at a set time; a new link lets someone book late');
const TOKEN6 = '6'.repeat(64);
t.cb_days.push({ day_id: 'd6', location: 'Marrickville', grading_date: '2026-11-21', start_time: '10:00:00', efc_session_id: 'sess-6', closed: false, book_by: new Date(Date.now() - 3600e3).toISOString() });
t.cb_entries.push({ entry_id: 'e6', day_id: 'd6', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN6, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null, late_ok_until: null });
t.cb_settings[0].contact_phone = '(02) 9569 1943'; t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';
r = await call({ action: 'info', token: TOKEN6 }, null, STRIPE_ENV);
ok(r.body.booking_closed === true && r.body.phone === '(02) 9569 1943', 'after the closing time the booking page says bookings have closed');
r = await call({ action: 'book', token: TOKEN6 });
const e6 = t.cb_entries.find(e => e.entry_id === 'e6');
ok(r.body.ok === false && /closed.*9569 1943/.test(r.body.error) && !e6.booked_at, '...Book is refused, saying to call');
r = await call({ action: 'pay', token: TOKEN6 }, null, STRIPE_ENV);
ok(r.body.ok === false && /closed/.test(r.body.error), '...and so is paying');
e6.late_ok_until = new Date(Date.now() + 48 * 3600e3).toISOString();
r = await call({ action: 'info', token: TOKEN6 }, null, STRIPE_ENV);
ok(r.body.booking_closed === false && r.body.book_by === e6.late_ok_until, 'with a new (late) link from staff, they can book again until it runs out');
r = await call({ action: 'book', token: TOKEN6 });
ok(r.body.booked && e6.booked_at, '...and booking works');

console.log('\nAutomatic emails through GoHighLevel');
const GHL_ENV = { GHL_TOKEN: 'ghl-x', GHL_LOCATION_ID: 'loc-1' };
const TOKEN8 = '8'.repeat(64);
t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';
t.cb_entries.push({ entry_id: 'e8', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN8, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
r = await call({ action: 'book', token: TOKEN8 }, null, GHL_ENV);
let mail = ghlCalls.filter(c => c.url.endsWith('/conversations/messages') && c.body.type === 'Email');
ok(r.body.booked && mail.length === 1 && /Grading booked: Sam/.test(mail[0].body.subject) && /Hi Pat/.test(mail[0].body.html) && /Orange Belt/.test(mail[0].body.html) && /Saturday 14 November 2026/.test(mail[0].body.html) && /10:00am/.test(mail[0].body.html) && /What to bring/.test(mail[0].body.html) && /Full long-sleeve uniform/.test(mail[0].body.html) && /Drink bottle/.test(mail[0].body.message), 'booking emails the family a confirmation (date, time, school, belt, what to bring) through GoHighLevel, as HTML with a plain-text version');
ok(t.cb_messages.some(m => m.kind === 'email_booked' && m.entry_id === 'e8' && m.email === 'pat@example.test' && m.status === 'sent'), '...and it is logged');
t.cb_belts[0].fee = 55;
r = await call({ action: 'record_payment', entry_id: 'e8', how: 'cash' }, 'tok-grader', GHL_ENV);
mail = ghlCalls.filter(c => c.url.endsWith('/conversations/messages') && c.body.type === 'Email');
ok(mail.length === 2 && /Payment received/.test(mail[1].body.subject) && /\$55\.00/.test(mail[1].body.html), 'recording a payment emails a payment confirmation with the amount');
const before8 = mail.length;
await call({ action: 'record_payment', entry_id: 'e8', how: 'cash' }, 'tok-grader', GHL_ENV);
ok(ghlCalls.filter(c => c.url.endsWith('/conversations/messages') && c.body.type === 'Email').length === before8, 'each email only goes once');
t.cb_belts[0].fee = null;

console.log('\nVisitors from another school (EFC won\'t book them into this school\'s session)');
t.cb_settings[0].booking_webhook = 'https://script.google.com/macros/s/AKfycbx-Test_123/exec';
t.efc_members.push({ member_key: 'efc:m9', efc_reference: 'AU-258-9', full_name: 'Jo Visitor', location: 'Concord', phone: null });
t.cb_entries.push({ entry_id: 'e9', day_id: 'd1', member_key: 'efc:m9', full_name: 'Jo Visitor', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: '9'.repeat(48) + 'a'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
const rowsBefore = sheetRows.length;
r = await call({ action: 'book', token: '9'.repeat(48) + 'a'.repeat(16) });
const e9 = t.cb_entries.find(e => e.entry_id === 'e9');
ok(r.body.booked && e9.booked_at && e9.efc_by_hand === true && sheetRows.length === rowsBefore, 'a Concord member grading at Marrickville is booked here, not sent to the booking sheet, and flagged to book in EFC by hand');
t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';

console.log('\nAn EFC session per school (coloured-belts-19.sql): members book into their own school');
t.prep_grading_fee_rates = [{ target_rank: '1st Dan Black Belt', fee: 0 }];   // fee 0 so the public book path routes without the card step
t.efc_members.push({ member_key: 'efc:mA', efc_reference: 'AU-301-1', full_name: 'Ava Marr', location: 'Marrickville', phone: null },
                    { member_key: 'efc:mB', efc_reference: 'AU-302-2', full_name: 'Ben Conc', location: 'Concord', phone: null },
                    { member_key: 'efc:mC', efc_reference: 'AU-303-3', full_name: 'Cal West', location: 'West', phone: null });
t.cb_days.push({ day_id: 'dml', location: 'Marrickville', grading_date: '2026-12-13', start_time: '10:00:00', efc_session_id: null, efc_sessions: { Marrickville: 'sess-mv', Concord: 'sess-cc' }, closed: false, bb: true, programme: 'Taekwondo' });
t.cb_entries.push({ entry_id: 'eA', day_id: 'dml', member_key: 'efc:mA', full_name: 'Ava Marr', belt_from: 'Cho Dan Bo', belt_to: '1st Dan Black Belt', token: 'A'.repeat(48) + 'a'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null },
                   { entry_id: 'eB', day_id: 'dml', member_key: 'efc:mB', full_name: 'Ben Conc', belt_from: 'Cho Dan Bo', belt_to: '1st Dan Black Belt', token: 'B'.repeat(48) + 'b'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null },
                   { entry_id: 'eC', day_id: 'dml', member_key: 'efc:mC', full_name: 'Cal West', belt_from: 'Cho Dan Bo', belt_to: '1st Dan Black Belt', token: 'C'.repeat(48) + 'c'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
r = await call({ action: 'book', token: 'A'.repeat(48) + 'a'.repeat(16) });
const hA = hooks[hooks.length - 1];
ok(r.body.booked && hA.session_id === 'sess-mv' && hA.location_id === 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58' && hA.location === 'Marrickville', 'a Marrickville candidate books into the Marrickville session');
r = await call({ action: 'book', token: 'B'.repeat(48) + 'b'.repeat(16) });
const hB = hooks[hooks.length - 1];
ok(r.body.booked && hB.session_id === 'sess-cc' && hB.location_id === '7ca1c142-be41-4d02-b5eb-13534b23043b' && hB.location === 'Concord', 'a Concord candidate at the same day books into the Concord session, not the venue\'s');
const hooksBeforeC = hooks.length;
r = await call({ action: 'book', token: 'C'.repeat(48) + 'c'.repeat(16) });
const eC = t.cb_entries.find(e => e.entry_id === 'eC');
ok(r.body.booked && eC.efc_by_hand === true && hooks.length === hooksBeforeC, 'a candidate whose school has no session set is flagged to book by hand');

console.log('\nAn EFC session per belt (coloured-belts-20.sql): coloured belt students book into their belt\'s session');
t.cb_belts.push({ programme: 'Taekwondo', belt: 'White Belt', fee: null }, { programme: 'Taekwondo', belt: 'Yellow Belt', fee: null });
t.efc_members.push({ member_key: 'efc:cb1', efc_reference: 'AU-401-1', full_name: 'Wendy White', location: 'Marrickville', phone: null },
                    { member_key: 'efc:cb2', efc_reference: 'AU-402-2', full_name: 'Yan Yellow', location: 'Marrickville', phone: null });
t.cb_days.push({ day_id: 'dcb', location: 'Marrickville', grading_date: '2026-12-08', start_time: '16:00:00', efc_session_id: 'day-fallback', efc_sessions: {}, efc_belt_sessions: { 'White Belt': 'sess-white', 'Yellow Belt': 'sess-yellow' }, closed: false, bb: false, programme: 'Taekwondo' });
t.cb_entries.push({ entry_id: 'ecb1', day_id: 'dcb', member_key: 'efc:cb1', full_name: 'Wendy White', belt_from: 'White Belt', belt_to: 'Yellow Belt', token: 'W'.repeat(48) + 'w'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null },
                   { entry_id: 'ecb2', day_id: 'dcb', member_key: 'efc:cb2', full_name: 'Yan Yellow', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: 'Y'.repeat(48) + 'y'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
r = await call({ action: 'book', token: 'W'.repeat(48) + 'w'.repeat(16) });
const hW = hooks[hooks.length - 1];
ok(r.body.booked && hW.session_id === 'sess-white' && hW.location_id === 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58', 'a White Belt student books into the White Belt session');
r = await call({ action: 'book', token: 'Y'.repeat(48) + 'y'.repeat(16) });
const hY = hooks[hooks.length - 1];
ok(r.body.booked && hY.session_id === 'sess-yellow', 'a Yellow Belt student on the same day books into the Yellow Belt session');

console.log('\nAn EFC session per belt for a visiting school (coloured-belts-21.sql): a Sydenham student on a shared Marrickville day');
t.efc_members.push({ member_key: 'efc:syd1', efc_reference: 'AU-501-1', full_name: 'Sadie Syd', location: 'Sydenham', phone: null });
t.cb_days.push({ day_id: 'dshare', location: 'Marrickville', grading_date: '2026-12-08', start_time: '18:30:00', efc_session_id: null, efc_sessions: {}, efc_belt_sessions: { 'White Belt': 'mv-white' }, efc_school_belt_sessions: { Sydenham: { 'White Belt': 'syd-white', 'Yellow Belt': 'syd-yellow' } }, schools: ['Marrickville', 'Sydenham'], closed: false, bb: false, programme: 'Taekwondo' });
t.cb_entries.push({ entry_id: 'esyd1', day_id: 'dshare', member_key: 'efc:syd1', full_name: 'Sadie Syd', belt_from: 'White Belt', belt_to: 'Yellow Belt', token: 'S'.repeat(48) + 's'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null },
                   { entry_id: 'emv1', day_id: 'dshare', member_key: 'efc:cb1', full_name: 'Wendy White', belt_from: 'White Belt', belt_to: 'Yellow Belt', token: 'M'.repeat(48) + 'm'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
r = await call({ action: 'book', token: 'S'.repeat(48) + 's'.repeat(16) });
const hSyd = hooks[hooks.length - 1];
ok(r.body.booked && hSyd.session_id === 'syd-white' && hSyd.location_id === '5af07764-95bc-4caf-b889-ba846e409dc5' && hSyd.location === 'Sydenham', 'a Sydenham White Belt student books into the Sydenham White Belt session at the Sydenham venue');
r = await call({ action: 'book', token: 'M'.repeat(48) + 'm'.repeat(16) });
const hMv = hooks[hooks.length - 1];
ok(r.body.booked && hMv.session_id === 'mv-white' && hMv.location === 'Marrickville', 'a Marrickville student on the same shared day still books the venue\'s own White Belt session');
// EFC sent no school for them (as on 8 Nov 2026): they still book their own school's session, not the day's
t.efc_members.push({ member_key: 'efc:syd2', efc_reference: 'AU-256-0042', full_name: 'Sol Syd', location: null, phone: null },
                   { member_key: 'efc:syd3', efc_reference: null, full_name: 'Sia Syd', location: null, phone: null });
t.cb_entries.push({ entry_id: 'esyd2', day_id: 'dshare', member_key: 'efc:syd2', full_name: 'Sol Syd', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: 'cbNoSchoolRef'.repeat(4), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null },
                   { entry_id: 'esyd3', day_id: 'dshare', member_key: 'efc:syd3', full_name: 'Sia Syd', belt_from: 'White Belt', belt_to: 'Yellow Belt', token: 'cbNoSchoolEnt'.repeat(4), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null, school: 'Sydenham' });
r = await call({ action: 'book', token: 'cbNoSchoolRef'.repeat(4) });
ok(r.body.booked && hooks[hooks.length - 1].session_id === 'syd-yellow' && hooks[hooks.length - 1].location === 'Sydenham', 'coloured belt, no school in EFC: their EFC reference (AU-256) books the Sydenham session');
r = await call({ action: 'book', token: 'cbNoSchoolEnt'.repeat(4) });
ok(r.body.booked && hooks[hooks.length - 1].session_id === 'syd-white', 'coloured belt, no school in EFC: the school saved on their entry books the Sydenham session');

console.log('\nBlack belt: an EFC session per rank at each venue (coloured-belts-21.sql), keyed by the rank they grade to');
t.prep_grading_fee_rates = [{ target_rank: '1st Dan Black Belt', fee: 0 }, { target_rank: '2nd Dan', fee: 0 }];
t.efc_members.push({ member_key: 'efc:bbm', efc_reference: 'AU-601-1', full_name: 'Mara BB', location: 'Marrickville', phone: null },
                    { member_key: 'efc:bbs', efc_reference: 'AU-602-2', full_name: 'Sven BB', location: 'Sydenham', phone: null });
t.cb_days.push({ day_id: 'dbbv', location: 'Marrickville', grading_date: '2026-12-05', start_time: null, efc_session_id: null, efc_sessions: {}, efc_belt_sessions: {}, efc_school_belt_sessions: { Marrickville: { '1st Dan Black Belt': 'mv-1dan', '2nd Dan': 'mv-2dan' }, Sydenham: { '1st Dan Black Belt': 'syd-1dan' } }, schools: ['Marrickville', 'Sydenham'], closed: false, bb: true, programme: 'Taekwondo' });
t.cb_entries.push({ entry_id: 'ebbm', day_id: 'dbbv', member_key: 'efc:bbm', full_name: 'Mara BB', belt_from: 'Probationary Black Belt', belt_to: '1st Dan Black Belt', token: 'P'.repeat(48) + 'p'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null },
                   { entry_id: 'ebbm2', day_id: 'dbbv', member_key: 'efc:bbm', full_name: 'Mara BB', belt_from: '1st Dan Level 1', belt_to: '2nd Dan', token: 'Q'.repeat(48) + 'q'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null },
                   { entry_id: 'ebbs', day_id: 'dbbv', member_key: 'efc:bbs', full_name: 'Sven BB', belt_from: 'Probationary Black Belt', belt_to: '1st Dan Black Belt', token: 'R'.repeat(48) + 'r'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
r = await call({ action: 'book', token: 'P'.repeat(48) + 'p'.repeat(16) });
const hbbm = hooks[hooks.length - 1];
ok(r.body.booked && hbbm.session_id === 'mv-1dan' && hbbm.location === 'Marrickville', 'a Marrickville black belt candidate books their venue + rank session (to 1st Dan)');
r = await call({ action: 'book', token: 'Q'.repeat(48) + 'q'.repeat(16) });
const hbbm2 = hooks[hooks.length - 1];
ok(r.body.booked && hbbm2.session_id === 'mv-2dan', 'a different rank on the same black belt day books that rank\'s session (to 2nd Dan)');
r = await call({ action: 'book', token: 'R'.repeat(48) + 'r'.repeat(16) });
const hbbs = hooks[hooks.length - 1];
ok(r.body.booked && hbbs.session_id === 'syd-1dan' && hbbs.location_id === '5af07764-95bc-4caf-b889-ba846e409dc5' && hbbs.location === 'Sydenham', 'a Sydenham black belt candidate books the Sydenham session for their rank');

console.log('\nBlack belt: their own school even when EFC has no school for them (coloured-belts-25.sql)');
const dbbv = t.cb_days.find(x => x.day_id === 'dbbv');
dbbv.efc_school_belt_sessions.Concord = { '1st Dan Black Belt': 'cc-1dan' };
t.efc_members.push({ member_key: 'efc:bbc', efc_reference: 'AU-258-0099', full_name: 'Cara BB', location: null, phone: null },
                    { member_key: 'efc:bbx', efc_reference: null, full_name: 'Xan BB', location: null, phone: null });
t.cb_entries.push({ entry_id: 'ebbc', day_id: 'dbbv', member_key: 'efc:bbc', full_name: 'Cara BB', belt_from: 'Probationary Black Belt', belt_to: '1st Dan Black Belt', token: 'bbSchoolCc'.repeat(6), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null, school: 'Concord' },
                   { entry_id: 'ebbx', day_id: 'dbbv', member_key: 'efc:bbx', full_name: 'Xan BB', belt_from: 'Probationary Black Belt', belt_to: '1st Dan Black Belt', token: 'bbSchoolNo'.repeat(6), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null, school: null });
r = await call({ action: 'info', token: 'bbSchoolCc'.repeat(6) });
ok(r.body.school === 'Concord', 'the booking page shows their own school, not the day\'s');
let nh = hooks.length;
r = await call({ action: 'book', token: 'bbSchoolCc'.repeat(6) });
ok(r.body.booked && hooks.length === nh + 1 && hooks[hooks.length - 1].session_id === 'cc-1dan' && hooks[hooks.length - 1].location === 'Concord', 'a Concord candidate with no school in EFC books the Concord session (from the entry)');
t.cb_entries.find(x => x.entry_id === 'ebbc').school = null; t.cb_entries.find(x => x.entry_id === 'ebbc').booked_at = null;
nh = hooks.length;
r = await call({ action: 'book', token: 'bbSchoolCc'.repeat(6) });
ok(r.body.booked && hooks[hooks.length - 1].location === 'Concord', '... or from their EFC reference (AU-258 is Concord)');
nh = hooks.length;
r = await call({ action: 'book', token: 'bbSchoolNo'.repeat(6) });
ok(r.body.booked && hooks.length === nh && t.cb_entries.find(x => x.entry_id === 'ebbx').efc_by_hand === true, 'no school at all: flagged to book by hand, never sent to the day\'s school');

console.log('\nBlack belt: the time shown depends on the rank (belt_times, coloured-belts-22.sql)');
const dbt = t.cb_days.find(x => x.day_id === 'dbbv');
dbt.start_time = '08:00:00'; dbt.belt_times = { '1st Dan Black Belt': '08:00', '2nd Dan': '15:30' };
r = await call({ action: 'info', token: 'P'.repeat(48) + 'p'.repeat(16) });
ok(r.body.time === '08:00', 'a candidate grading to 1st Dan is shown the 8:00 block');
r = await call({ action: 'info', token: 'Q'.repeat(48) + 'q'.repeat(16) });
ok(r.body.time === '15:30', 'a candidate grading to 2nd Dan on the same day is shown the 3:30 block');

console.log('\nFamilies reply YES to the first grading text (coloured-belts-16.sql)');
{
  const { isYes, fillText } = await import(pathToFileURL(tmp).href);
  ok(['Yes', 'yes please', 'YES!', 'Yep', 'y', 'Yesss', 'Confirmed', 'ok thanks', '\u{1F44D}'].every(isYes) && !['No', 'yes but not this time', 'not yet', 'maybe', 'Who is this?', 'Yesterday was fun'].some(isYes), 'YES replies are recognised (and "no", "not this time", "maybe" are not)');
  ok(fillText('Hi {parent}, {first} {missing}.', { parent: 'Pat', first: 'Sam' }) === 'Hi Pat, Sam.', 'the server fills in the wording the same way the app does');
  t.cb_settings[0].reply_key = 'reply-secret';
  t.cb_settings[0].not_booked_text = 'Hi {parent}, here is {first}\'s official invitation to grade for their {next} at AMA {school} on {date}{time}. Please book their spot here: {link}\nAMA {school}';
  const TOKY = 'y'.repeat(64);
  t.cb_entries.push({ entry_id: 'ey', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'White Belt', belt_to: 'Yellow Belt', token: TOKY, invited_at: '2026-11-06T08:00:00Z', booked_at: null, booking_error: null, result: null, yes_at: null });
  r = await call({ action: 'reply', key: 'wrong', phone: '+61412345678', message: 'Yes' }, null, GHL_ENV);
  ok(r.status === 403, 'a reply without the right key is refused');
  r = await call({ action: 'reply', key: 'reply-secret', phone: '+61412345678', message: 'Not sure yet, will let you know' }, null, GHL_ENV);
  const ey = t.cb_entries.find(e => e.entry_id === 'ey');
  ok(r.body.matched === 1 && r.body.yes === false && !ey.yes_at && /Not sure yet/.test(ey.reply_text), 'any other reply is kept on the student for staff to see, and nothing is sent');
  const sentBefore = ghlCalls.filter(c => c.url.endsWith('/conversations/messages') && c.body.type === 'SMS').length;
  r = await call({ action: 'reply', key: 'reply-secret', phone: '+61412345678', message: 'Yes please!' }, null, GHL_ENV);
  const sms = ghlCalls.filter(c => c.url.endsWith('/conversations/messages') && c.body.type === 'SMS');
  const last = sms[sms.length - 1];
  ok(r.body.yes && ey.yes_at && sms.length === sentBefore + 1 && /Hi Pat, here is Sam's official invitation to grade for their Yellow Belt at AMA Marrickville on Saturday 14 November at 10:00am/.test(last.body.message) && last.body.message.includes('https://app.train-ama.com/b#' + TOKY) && /\nAMA Marrickville$/.test(last.body.message), 'a YES marks them "Said YES" and texts the booking link straight away');
  ok(t.cb_messages.some(m => m.entry_id === 'ey' && m.kind === 'not_booked' && m.sent_by === 'automatic: replied YES' && m.status === 'sent'), '...logged as an automatic text');
  r = await call({ action: 'reply', key: 'reply-secret', phone: '0412 345 678', message: 'yes' }, null, GHL_ENV);
  ok(ghlCalls.filter(c => c.url.endsWith('/conversations/messages') && c.body.type === 'SMS').length === sentBefore + 1, 'saying yes again does not send the link twice');
  r = await call({ action: 'reply', key: 'reply-secret', phone: '+61499999999', message: 'Yes' }, null, GHL_ENV);
  ok(r.body.matched === 0, 'a YES from a number with no invited student does nothing');
  ey.booked_at = 'x'; t.cb_entries = t.cb_entries.filter(e => e.entry_id !== 'ey');
}

console.log('\nInviting sends a family grading email + a note on their GHL contact (update 17)');
{
  const INV_ENV = { GHL_TOKEN: 'tkn', GHL_LOCATION_ID: 'loc1' };
  const TF1 = 'f'.repeat(64), TF2 = 'g'.repeat(64);
  t.efc_members.push(
    { member_key: 'efc:f1', full_name: 'Ilaria Mamone', guardian_name: 'Connie Mamone', phone: '0433 034 739', guardian_phone: '0433 034 739', email: null, guardian_email: 'connie@example.test', date_of_birth: '2015-09-26' },
    { member_key: 'efc:f2', full_name: 'Sara Mamone', guardian_name: 'Connie Mamone', phone: '0433 034 739', guardian_phone: '0433 034 739', email: null, guardian_email: 'connie@example.test', date_of_birth: '2017-02-27' },
    { member_key: 'efc:solo', full_name: 'Tess Alone', guardian_name: 'Robin Alone', phone: '0400 000 111', guardian_phone: null, email: null, guardian_email: 'robin@example.test', date_of_birth: '2016-01-01' });
  t.cb_days.push({ day_id: 'df', location: 'Marrickville', grading_date: '2026-12-08', start_time: '16:00:00', efc_session_id: null, closed: false, programme: 'Taekwondo' });
  t.cb_entries.push(
    { entry_id: 'ef1', day_id: 'df', member_key: 'efc:f1', full_name: 'Ilaria Mamone', belt_from: 'White Belt', belt_to: 'Yellow Belt', token: TF1, booked_at: null, booking_error: null, result: null, invited_at: null },
    { entry_id: 'ef2', day_id: 'df', member_key: 'efc:f2', full_name: 'Sara Mamone', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TF2, booked_at: null, booking_error: null, result: null, invited_at: null },
    { entry_id: 'esolo', day_id: 'df', member_key: 'efc:solo', full_name: 'Tess Alone', belt_from: 'Orange Belt', belt_to: 'Green Belt', token: 'h'.repeat(64), booked_at: null, booking_error: null, result: null, invited_at: null });
  const before = ghlCalls.length;
  r = await call({ action: 'send', kind: 'invite', items: [
    { member_key: 'efc:f1', entry_id: 'ef1', body: 'Check your email' },
    { member_key: 'efc:f2', entry_id: 'ef2', body: 'Check your email' },
    { member_key: 'efc:solo', entry_id: 'esolo', body: 'Check your email' }] }, 'tok-grader', INV_ENV);
  const emails = ghlCalls.slice(before).filter(c => c.url.endsWith('/conversations/messages') && c.body.type === 'Email');
  const fam = emails.find(e => /Ilaria/.test(e.body.html));
  ok(r.body.sent === 3 && emails.length === 2, 'inviting 3 students across 2 families sends exactly 2 emails (one per family)');
  ok(fam && /Ilaria/.test(fam.body.html) && /Sara/.test(fam.body.html) && fam.body.html.includes('/b#' + TF1) && fam.body.html.includes('/b#' + TF2) && /Hi <b>Connie<\/b>/.test(fam.body.html), 'the family email lists both children with their own booking links, addressed to the guardian');
  ok(/Book Ilaria's spot/.test(fam.body.html) && /Grading for their/.test(fam.body.html) && fam.body.subject.includes('AMA Marrickville'), 'each child has a Book button and their grading details');
  const notes = ghlCalls.slice(before).filter(c => /\/contacts\/[^/]+\/notes$/.test(c.url));
  ok(notes.length === 2 && notes.every(n => /Invited to the Dec 2026 grading/.test(n.body.body)), 'a note is left on each family\'s GHL contact');
  ok(t.cb_messages.some(m => m.kind === 'invite' && m.email === 'connie@example.test' && m.sent_by === 'automatic: invitation email' && m.status === 'sent'), '...and the family email is logged');
  ok(t.cb_entries.find(e => e.entry_id === 'ef1').invited_at && t.cb_entries.find(e => e.entry_id === 'esolo').invited_at, 'every invited student is still marked invited');
}

// Black belt (Dan) sessions: the fee comes from the prep grading rates by the rank they're grading to (coloured-belts-18.sql)
{
  t.prep_grading_fee_rates = [{ target_rank: '4th Dan', fee: 495 }, { target_rank: '1st Dan Black Belt', fee: 195 }];
  const BBTOK = 'BBtoken4thDan01';
  t.cb_days.push({ day_id: 'dbb', location: 'Marrickville', grading_date: '2026-12-08', start_time: '10:00:00', efc_session_id: 'sess-bb', closed: false, bb: true, programme: 'Taekwondo' });
  t.cb_entries.push({ entry_id: 'ebb', day_id: 'dbb', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: '3rd Dan Level 3', belt_to: '4th Dan', token: BBTOK, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
  let r = await call({ action: 'info', token: BBTOK }, null, { STRIPE_SECRET_KEY: 'sk_test' });
  ok(r.status === 200 && r.body.belt_to === '4th Dan' && r.body.fee === 495 && r.body.card === true, 'a black belt session takes its fee from the prep grading rates by the grading-to rank ($495 for 4th Dan), payable by card');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

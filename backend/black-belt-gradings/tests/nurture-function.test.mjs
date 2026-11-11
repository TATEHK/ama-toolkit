// Tests the "nurture" Edge Function (grading enrolment sequence) against an in-memory stand-in for Supabase.
// Run: node tests/nurture-function.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(mkdtempSync(join(tmpdir(), 'nur-')), 'nur.mjs');
writeFileSync(tmp, readFileSync(join(here, '../supabase/functions/nurture/index.ts'), 'utf8'));
const mod = await import(pathToFileURL(tmp).href);
const { handle, render, addDays, longDate, emailHtml, isAdult } = mod;

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// ---- in-memory tables ----
let t;
function reset() {
  t = {
    prep_settings: [{ id: 1, prep_session_date: '2026-11-21', prep_session_venue: 'Sydenham', prep_session_cost: '$60', nurture_deadline: '2026-11-21', nurture_hub_key: 'hub123' }],
    prep_nurture_steps: [
      { code: 'enrol_d1_sms', track: 'enrol', channel: 'sms', active: true, send_on: '2026-11-08', send_at: '10:00', anchor: null, offset_days: 0, subject: null, body: 'Hi {first_name}, enrol for {belt} on {grading_date}: {link} - AMA' },
      { code: 'enrol_d3_email', track: 'enrol', channel: 'email', active: true, send_on: '2026-11-10', send_at: '19:00', anchor: null, offset_days: 0, subject: 'Getting ready', body: 'Hi, getting {first_name} ready.{essay_bullet}\nThe AMA team' },
      { code: 'enrol_d12_call', track: 'enrol', channel: 'call', active: true, send_on: '2026-11-19', send_at: '09:00', anchor: null, offset_days: 0, subject: null, body: 'call' },
      { code: 'booked_pay_sms', track: 'booked', channel: 'sms', active: true, send_on: null, send_at: '10:00', anchor: 'on_payment', offset_days: 0, subject: null, body: 'Thanks {first_name}, booked for {belt} on {grading_date}, prep {prep_time}. - AMA' },
      { code: 'booked_pay_email', track: 'booked', channel: 'email', active: true, send_on: null, send_at: '10:00', anchor: 'on_payment', offset_days: 0, subject: 'Booked in', body: 'Hi, {first_name} is booked. {link}' },
      { code: 'booked_grade_sms', track: 'booked', channel: 'sms', active: true, send_on: null, send_at: '06:30', anchor: 'grading_day', offset_days: 0, subject: null, body: 'Today is {first_name}\'s grading! - AMA' }
    ],
    prep_time_groups: [{ time_label: '10:30am to 12:30pm', ranks: ['1st Dan Black Belt'] }, { time_label: '3:30 to 5:30pm', ranks: ['2nd Dan'] }],
    prep_nurture_runs: [{ cycle_id: 'C1', started_at: '2026-11-08T00:00:00Z', paused: false, deadline: '2026-11-21' }],
    prep_overview: [
      { cycle_id: 'C1', student_id: 'S1', full_name: 'Sam Lee', belt_rank: 'Probationary Black Belt', is_grading: true, grading_to: '1st Dan Black Belt', grading_fee_status: 'due' },
      { cycle_id: 'C1', student_id: 'S2', full_name: 'Pat Roy', belt_rank: 'Probationary Black Belt', is_grading: true, grading_to: '1st Dan Black Belt', grading_fee_status: 'paid' },
      { cycle_id: 'C1', student_id: 'S3', full_name: 'Lee Vee', belt_rank: 'Probationary Black Belt', is_grading: true, grading_to: '1st Dan Black Belt', grading_fee_status: 'due' }
    ],
    prep_students: [
      { student_id: 'S1', full_name: 'Sam Lee', belt_rank: 'Probationary Black Belt', efc_ref: 'AU-1', contact_email: 's1@test', contact_phone: '0412000001' },
      { student_id: 'S2', full_name: 'Pat Roy', belt_rank: 'Probationary Black Belt', efc_ref: 'AU-2', contact_email: 's2@test', contact_phone: '0412000002' },
      { student_id: 'S3', full_name: 'Lee Vee', belt_rank: 'Probationary Black Belt', efc_ref: 'AU-3', contact_email: 's3@test', contact_phone: '0412000003' }
    ],
    prep_nurture_state: [{ cycle_id: 'C1', student_id: 'S3', joined_on: '2026-11-20', skipped: false, stopped: false }],   // S3 joined late
    prep_nurture_log: [],
    prep_calls: [],
    prep_essay_questions: [{ target_rank: '1st Dan Black Belt' }],
    prep_essays: [],
    cb_days: [{ day_id: 'D1', grading_date: '2026-12-05', belts: ['1st Dan Black Belt'], bb: true, prep_cycle_id: 'C1' }],
    cb_entries: [
      { member_key: 'efc:M1', belt_to: '1st Dan Black Belt', token: 'tok1', day_id: 'D1' },
      { member_key: 'efc:M2', belt_to: '1st Dan Black Belt', token: 'tok2', day_id: 'D1' },
      { member_key: 'efc:M3', belt_to: '1st Dan Black Belt', token: 'tok3', day_id: 'D1' }
    ],
    // Students link to EFC by reference code (efc_ref); booking entries are keyed by efc_members.member_key (which includes the "efc:" prefix).
    efc_members: [
      { member_key: 'efc:M1', efc_reference: 'AU-1' },
      { member_key: 'efc:M2', efc_reference: 'AU-2' },
      { member_key: 'efc:M3', efc_reference: 'AU-3' }
    ],
    prep_roles: [{ email: 'grader@ama.test', role: 'grading' }]
  };
}

const db = {
  from(table) {
    let flt = [], op = 'select', payload = null, single = false;
    const q = {
      select() { return q; }, eq(c, v) { flt.push(r => r[c] === v); return q; }, in(c, vs) { flt.push(r => vs.includes(r[c])); return q; },
      gte(c, v) { flt.push(r => String(r[c]) >= String(v)); return q; }, not(c, _o, v) { flt.push(r => !(v === null ? r[c] == null : r[c] === v)); return q; },
      maybeSingle() { single = true; return q; }, update(p) { op = 'update'; payload = p; return q; }, insert(p) { op = 'insert'; payload = p; return q; },
      then(res, rej) {
        return Promise.resolve().then(() => {
          const rows = (t[table] || []).filter(r => flt.every(f => f(r)));
          if (op === 'update') { rows.forEach(r => Object.assign(r, payload)); return { data: null, error: null }; }
          if (op === 'insert') { (Array.isArray(payload) ? payload : [payload]).forEach(p => t[table].push({ ...p })); return { data: null, error: null }; }
          return { data: single ? (rows[0] || null) : rows, error: null };
        }).then(res, rej);
      }
    };
    return q;
  },
  auth: { async getUser(tok) { return { data: { user: tok === 'tok-grader' ? { email: 'grader@ama.test' } : null } }; } },
  async rpc(name, args) { if (name === 'prep_nurture_cron_ok') return { data: args.p_secret === 'secret', error: null }; return { data: null, error: { message: 'no rpc ' + name } }; }
};

let ghlCalls = [];
const http = async (url, opts) => {
  ghlCalls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
  if (url.includes('/contacts/search/duplicate')) return new Response(JSON.stringify({ contact: { id: 'c-1' } }), { status: 200 });
  return new Response(JSON.stringify({ messageId: 'm-' + ghlCalls.length }), { status: 200 });
};
const env = { GHL_TOKEN: 'x', GHL_LOCATION_ID: 'loc', NURTURE_CRON: 'secret' };
const run = (when, headers = { 'x-nurture-cron': 'secret' }) => handle(new Request('https://x/', { method: 'POST', headers, body: JSON.stringify({ action: 'run', _now: when }) }), db, env, http);
const sentSms = () => ghlCalls.filter(c => c.body && c.body.type === 'SMS');
const logFor = (sid, code) => t.prep_nurture_log.find(l => l.student_id === sid && l.step_code === code);

// ---- render() unit ----
console.log('render()');
ok(render('Hi {first_name}, {belt} on {grading_date}', { first_name: 'Sam', belt: '1st Dan', grading_date: 'Saturday 5 December' }, false) === 'Hi Sam, 1st Dan on Saturday 5 December', 'fields fill in');
ok(render('Ready.{essay_bullet}\nEnd', { first_name: 'Sam', essay_link: 'https://x/e/#tok' }, true).includes('https://x/e/#tok'), 'essay bullet shows their essay link when they need an essay');
ok(!render('Ready.{essay_bullet}\nEnd', { first_name: 'Sam' }, false).includes('Essay'), 'essay bullet hidden when no essay needed');
// Adults get the messages addressed to them
{ const A = { first_name: 'Kathy', belt: '4th Dan Level 1', grading_date: 'Saturday 28 November', link: 'L', prep_time: '3:30 to 5:30pm', essay_link: 'E', adult: true };
  ok(render("Hi! {first_name} has been marked on track for {belt} and is invited to grade on {grading_date}. Please enrol by Sat 21 Nov using {first_name}'s personal link: {link} - AMA", A, false)
    === "Hi Kathy! You've been marked on track for 4th Dan Level 1 and are invited to grade on Saturday 28 November. Please enrol by Sat 21 Nov using your personal link: L - AMA", 'an adult\'s invitation text speaks to them');
  ok(render('Hi,\n\nThank you. {first_name} is booked in to grade for {belt}. Their session time is on {first_name}\'s personal link: {link}\n\n{essay}Good luck, {first_name}!', A, true)
    === "Hi Kathy,\n\nThank you. You're booked in to grade for 4th Dan Level 1. Your session time is on your personal link: L\n\nYour black belt essay is also due before grading. Submit it here: E\n\nGood luck!", 'an adult\'s email: greeting by name, then "you", essay line too');
  ok(render('{first_name} is invited to grade for {belt}', A, false) === "You're invited to grade for 4th Dan Level 1", 'an adult\'s subject line');
  ok(render('Hi! {first_name} has been marked on track for {belt}', { ...A, first_name: 'Sam', adult: false }, false) === 'Hi! Sam has been marked on track for 4th Dan Level 1', 'a child\'s stays written to the parent');
  ok(isAdult({ dob: '1979-12-11' }) && !isAdult({ dob: '2012-01-01' }) && isAdult({ full_name: 'Kathy Galanis', contact_name: 'Kathy Galanis' }) && !isAdult({ full_name: 'Sam Lee', contact_name: 'Alex Lee' }), 'adult: 18 or over, or their own contact'); }
ok(addDays('2026-12-05', -2) === '2026-12-03', 'addDays works');
ok(longDate('2026-12-05') === 'Saturday 5 December', 'longDate reads nicely');
const eh = emailHtml('Booked in', 'Hi,\n\nEnrol here: https://app.train-ama.com/b#tok\n\n- One\n- Two');
ok(/AUSTRALIAN MARTIAL ARTS ACADEMY/.test(eh) && /MARRICKVILLE &middot; SYDENHAM/.test(eh) && /Booked in/.test(eh), 'emailHtml wraps the message in the AMA branded layout');
ok(eh.includes('<a href="https://app.train-ama.com/b#tok"') && eh.includes('&#8226;</td>'), '...links are clickable and - lines become bullets');

// ---- A: unpaid candidate gets the day's SMS ----
console.log('\nThe scheduled run');
reset();
let r = await (await run('2026-11-07T23:30:00Z')).json();   // Sydney 2026-11-08 10:30
ok(logFor('S1', 'enrol_d1_sms') && logFor('S1', 'enrol_d1_sms').status === 'sent', 'an unpaid candidate is sent Day 1 on its date, after its time');
ok(sentSms().some(c => c.body.message.includes('app.train-ama.com/b#tok1') && c.body.message.includes('Saturday 5 December')), '...the text has their personal link and grading date');
ok(!logFor('S1', 'enrol_d3_email'), 'a later step (Day 3) is not sent early');
ok(t.prep_essays.some(e => e.student_id === 'S1' && e.token && e.token.length >= 10), 'a candidate who needs an essay but has no link gets one made');

// ---- B: idempotent ----
const before = ghlCalls.length;
await run('2026-11-07T23:30:00Z');
ok(ghlCalls.filter(c => c.body && c.body.type === 'SMS').length === sentSms().length && ghlCalls.length >= before, 'running again does not send Day 1 twice');
ok(t.prep_nurture_log.filter(l => l.student_id === 'S1' && l.step_code === 'enrol_d1_sms').length === 1, '...only one log row for that step');

// ---- C: paid candidate — enrol stops, booked-in sends ----
ok(logFor('S2', 'enrol_d1_sms') && logFor('S2', 'enrol_d1_sms').status === 'skipped_paid', 'a paid candidate is not sent the enrolment text (logged skipped_paid)');
ok(logFor('S2', 'booked_pay_sms') && logFor('S2', 'booked_pay_sms').status === 'sent', '...they get the booked-in SMS straight away');
ok(logFor('S2', 'booked_pay_email') && logFor('S2', 'booked_pay_email').status === 'sent', '...and the booked-in email');
ok(sentSms().some(c => c.body.message.includes('prep 10:30am to 12:30pm')), '...the booked SMS shows their prep-session time group');

// ---- D: late joiner skips past steps ----
ok(!logFor('S3', 'enrol_d1_sms'), 'a late joiner (joined after Day 1) is not back-sent Day 1');

// ---- D2: paid candidates still receive the enrolment emails (only the SMS nudge stops) ----
reset();
await run('2026-11-08T08:30:00Z');   // Sydney 2026-11-08 19:30 — enrol email time (19:00) reached
ok(logFor('S2', 'enrol_d1_sms') && logFor('S2', 'enrol_d1_sms').status === 'skipped_paid', 'a paid candidate still skips the enrolment SMS');
ok(logFor('S2', 'enrol_d3_email') && logFor('S2', 'enrol_d3_email').status === 'sent', '...but still receives the enrolment email');

// ---- E: Day 12 makes a call row for the unpaid ----
reset();
await run('2026-11-19T22:30:00Z');   // Sydney 2026-11-20 09:30 — Day 12 has passed its 09:00
ok(t.prep_calls.some(c => c.student_id === 'S1' && c.reason === 'day12'), 'on/after Day 12 an unpaid candidate gets a call-list row');
ok(!t.prep_calls.some(c => c.student_id === 'S2'), '...a paid candidate never goes on the calls list');

// ---- F: cron secret required ----
reset();
const bad = await run('2026-11-07T23:30:00Z', {});
ok(bad.status === 403, 'the run is refused without the cron secret');

// ---- G: a reply pauses the student and raises a concern call; STOP opts out ----
console.log('\nReplies');
reset();
const reply = (b, key = 'hub123') => handle(new Request('https://x/', { method: 'POST', body: JSON.stringify({ action: 'reply', key, phone: '0412000001', message: b }) }), db, env, http);
let rr = await (await reply('I am a bit worried about the test')).json();
ok(rr.matched === 1, 'a reply from a candidate\'s mobile is matched');
let s1state = t.prep_nurture_state.find(s => s.student_id === 'S1');
ok(!!(s1state && s1state.paused_until), 'the reply pauses that student');
ok(t.prep_calls.some(cl => cl.student_id === 'S1' && cl.reason === 'concern'), '...and raises a concern call for an instructor');
reset();
await reply('STOP');
ok(t.prep_nurture_state.find(s => s.student_id === 'S1' && s.stopped), 'STOP opts the student out of the sequence');
const badReply = await reply('hi', 'wrong');
ok(badReply.status === 403, 'a reply with the wrong key is refused');

// ---- H: send_one essay-only (booked + paid) sends just the essay link ----
console.log('\nsend_one essay-only');
reset();
const sendOne = (body, tok = 'tok-grader') => handle(new Request('https://x/', { method: 'POST', headers: { authorization: 'Bearer ' + tok }, body: JSON.stringify({ action: 'send_one', ...body }) }), db, env, http);
let hi = ghlCalls.length;
let eo = await (await sendOne({ cycle: 'C1', student_id: 'S1', essay_only: true })).json();
ok(eo.ok && eo.essay === true, 'essay-only send runs for a candidate who still needs an essay');
let eoMsgs = ghlCalls.slice(hi).filter(c => c.body && (c.body.type === 'SMS' || c.body.type === 'Email'));
ok(eoMsgs.some(c => c.body.type === 'SMS' && /\/e\/#/.test(c.body.message)), '...the SMS carries the essay link');
ok(eoMsgs.length > 0 && eoMsgs.every(c => !/\/b#/.test(c.body.message || '') && !/\/b#/.test(c.body.html || '')), '...and never the booking/enrolment link');

// ---- I: essay-only is a no-op once the essay is in ----
hi = ghlCalls.length;
t.prep_essays.forEach(e => { if (e.student_id === 'S1') e.status = 'submitted'; });   // their essay from test H is now handed in
let eo2 = await (await sendOne({ cycle: 'C1', student_id: 'S1', essay_only: true })).json();
ok(eo2.ok && eo2.essay === false, 'essay-only reports nothing to send when the essay is already in');
ok(ghlCalls.slice(hi).filter(c => c.body && (c.body.type === 'SMS' || c.body.type === 'Email')).length === 0, '...and sends nothing');

// ---- J: send_one resolves the student from a booking member_key ----
hi = ghlCalls.length;
let eo3 = await (await sendOne({ cycle: 'C1', member_key: 'efc:M3', essay_only: true })).json();
ok(eo3.ok && eo3.essay === true, 'essay-only works when called with a booking member_key (resolved via efc_members)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

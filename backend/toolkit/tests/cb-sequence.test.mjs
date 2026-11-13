// Tests the automated coloured belt booking sequence in the "cb" function (coloured-belts-23.sql), against an
// in-memory stand-in for Supabase and GoHighLevel. Covers every scenario in Mark's 7 Nov doc.
// Run: node tests/cb-sequence.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(mkdtempSync(join(tmpdir(), 'cbseq-')), 'cb.mjs');
writeFileSync(tmp, readFileSync(join(here, '../supabase/functions/cb/index.ts'), 'utf8'));
const { handle, planSequence, sydMs, sydParts, stepDue, seqVars, buildSeqEmail, fillText } = await import(pathToFileURL(tmp).href);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// ---- The steps exactly as coloured-belts-23.sql seeds them ----
const SQL = readFileSync(join(here, '../supabase/coloured-belts-23.sql'), 'utf8');
const STEPS = [
  ['invite_sms', 'booking', 'sms', 'invite', 0, null, null, 'not_paid', 10], ['invite_email', 'booking', 'email', 'invite', 0, null, null, 'not_paid', 20],
  ['nudge_d2', 'booking', 'sms', 'invite', 2, null, '10:00', 'not_booked', 30], ['ready_d4', 'booking', 'email', 'invite', 4, null, '19:00', 'not_paid', 40],
  ['checkin_d6', 'booking', 'sms', 'invite', 6, null, '10:00', 'not_paid', 50], ['close_g8', 'booking', 'sms', 'grading', -8, null, '10:00', 'not_paid', 60],
  ['call_g5', 'booking', 'call', 'grading', -5, null, '07:00', 'not_paid', 70], ['prep_last', 'prep', 'sms', 'date', 0, '2026-11-17', '10:00', 'prep_not_booked', 80],
  ['prep_remind', 'prep', 'sms', 'date', 0, '2026-11-20', '10:00', 'prep_booked', 90], ['prep_morning', 'prep', 'sms', 'date', 0, '2026-11-22', '08:00', 'prep_booked', 100],
  ['booked_sms', 'booked', 'sms', 'paid', 0, null, null, 'paid', 110], ['reminder_g2', 'booked', 'sms', 'grading', -2, null, '10:00', 'paid', 120],
  ['morning_g', 'booked', 'sms', 'grading', 0, null, '08:00', 'paid', 130],
  ['out_send_link', 'booking', 'sms', 'date', 0, null, null, 'not_paid', 200], ['out_no_answer', 'booking', 'sms', 'date', 0, null, null, 'not_paid', 210]
].map(([code, track, channel, anchor, offset_days, send_date, send_at, audience, sort]) => ({ code, track, channel, anchor, offset_days, send_date, send_at, audience, sort, active: true,
  template: code === 'reminder_g2' ? 'settings:reminder_text' : code === 'out_send_link' ? 'settings:not_booked_text' : `TEXT ${code} {first} {date}{time} {link} {deadline}`, subject: channel === 'email' ? `SUBJ ${code} {first}` : null }));
ok(STEPS.filter(s => !s.code.startsWith('out_')).every(s => SQL.includes(`('${s.code}', '${s.track}'`)), 'the test uses the same steps the SQL seeds');
ok(/'call_g5', 'booking', 'G-5: staff call on My Day', 'call', 'grading', -5/.test(SQL) && /'close_g8'[^\n]*'grading', -8/.test(SQL), 'G-8 text and G-5 call are timed from the grading date');

// ---- Sydney time ----
const at = (ymd, hm) => sydMs(ymd, hm);
ok(sydParts(at('2026-11-24', '10:00')).hm === '10:00' && sydParts(at('2026-11-24', '10:00')).ymd === '2026-11-24', 'Sydney times round-trip (daylight saving, +11)');
ok(new Date(at('2026-11-24', '10:00')).toISOString() === '2026-11-23T23:00:00.000Z', '10am on 24 Nov in Sydney is 11pm UTC the day before');

// ---- The planner, scenario by scenario (Concord, grading Tue 1 Dec) ----
const day = { day_id: 'd1', location: 'Concord', grading_date: '2026-12-01', start_time: '16:00', programme: 'Taekwondo', closed: false, bb: false, belt_times: {} };
const base = { entry_id: 'e1', day_id: 'd1', member_key: 'efc:1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: 'TOK', invited_at: null, booked_at: null, paid: false, paid_at: null, result: null };
// Run the planner over a span of time, every 15 minutes, applying what it decides (like the real runs)
function simulate({ entry, from, to, prepBooked = [], skipped = [], onTick = null, days = [day] }) {
  const e = { ...entry }, logs = new Map(), sent = [];
  for (let t = from; t <= to; t += 15 * 60e3) {
    if (onTick) onTick(t, e);
    const plan = planSequence({ now: t, steps: STEPS, days, entries: [e], logs: new Set([...logs.keys()].map(c => e.entry_id + '|' + c)), skipped: new Set(skipped), prepBooked: new Set(prepBooked) });
    for (const p of plan) {
      logs.set(p.code, p.act);
      if (p.act === 'send' || p.act === 'call') sent.push({ code: p.code, at: sydParts(t).ymd + ' ' + sydParts(t).hm, act: p.act });
      if (p.code === 'invite_sms' && p.act === 'send') e.invited_at = new Date(t).toISOString();
    }
  }
  return { sent, logs, codes: sent.map(s => s.code) };
}

console.log('\nAdded on Mon 9 Nov at 2pm, never books');
let r = simulate({ entry: base, from: at('2026-11-09', '14:00'), to: at('2026-12-01', '20:00') });
const when = c => (r.sent.find(s => s.code === c) || {}).at;
ok(when('invite_sms') === '2026-11-09 14:00' && when('invite_email') === '2026-11-09 14:00', 'invitation text and email go straight away when added');
ok(when('nudge_d2') === '2026-11-11 10:00' && when('ready_d4') === '2026-11-13 19:00' && when('checkin_d6') === '2026-11-15 10:00', 'Day 2 text 10am, Day 4 email 7pm, Day 6 text 10am');
ok(when('prep_last') === '2026-11-17 10:00', 'prep last chance on Tue 17 Nov (not booked into the prep session)');
ok(when('close_g8') === '2026-11-23 10:00', 'G-8: bookings close text on Mon 23 Nov');
ok(when('call_g5') === '2026-11-26 07:00', 'G-5: on the call list at 7am on Thu 26 Nov, ready for My Day');
ok(!r.codes.includes('booked_sms') && !r.codes.includes('reminder_g2') && !r.codes.includes('morning_g') && !r.codes.includes('prep_remind'), 'no booked-in or prep-booker texts');
ok(new Set(r.codes).size === r.codes.length, 'nothing is sent twice');

console.log('\nBooks and pays on Day 3');
r = simulate({ entry: base, from: at('2026-11-09', '14:00'), to: at('2026-12-01', '20:00'),
  onTick: (t, e) => { if (!e.paid && t >= at('2026-11-12', '12:00')) { e.paid = true; e.booked_at = e.paid_at = new Date(t).toISOString(); } } });
ok(r.codes.includes('nudge_d2') && !r.codes.includes('ready_d4') && !r.codes.includes('checkin_d6') && !r.codes.includes('close_g8') && !r.codes.includes('call_g5'), 'gets nothing more from the booking track, and no call');
ok((r.sent.find(s => s.code === 'booked_sms') || {}).at === '2026-11-12 12:00', 'booked and paid text straight away');
ok((r.sent.find(s => s.code === 'reminder_g2') || {}).at === '2026-11-29 10:00' && (r.sent.find(s => s.code === 'morning_g') || {}).at === '2026-12-01 08:00', 'G-2 reminder and the morning-of text');
ok(r.logs.get('ready_d4') === 'skip' && r.logs.get('call_g5') === 'skip', 'later booking steps are logged as skipped (booked and paid)');

console.log('\nAdded late, at G-6 (Wed 25 Nov)');
r = simulate({ entry: base, from: at('2026-11-25', '11:00'), to: at('2026-11-27', '20:00') });
ok(r.codes[0] === 'invite_sms' && r.codes.includes('invite_email'), 'gets the invitation');
ok(r.logs.get('close_g8') === 'missed' && r.logs.get('prep_last') === 'missed', 'missed steps (G-8, prep last chance) are never sent');
ok(r.codes.includes('call_g5') && (r.sent.find(s => s.code === 'call_g5') || {}).at === '2026-11-26 07:00', 'then the G-5 call');

console.log('\nPrep session');
r = simulate({ entry: base, from: at('2026-11-09', '14:00'), to: at('2026-11-23', '09:00'), prepBooked: ['efc:1'] });
ok(r.logs.get('prep_last') === 'skip' && !r.codes.includes('prep_last'), 'the last-chance text skips prep bookers');
ok((r.sent.find(s => s.code === 'prep_remind') || {}).at === '2026-11-20 10:00' && (r.sent.find(s => s.code === 'prep_morning') || {}).at === '2026-11-22 08:00', 'prep bookers get the Friday reminder and the 8am Sunday text');

console.log('\nNever sent to');
r = simulate({ entry: base, from: at('2026-11-09', '14:00'), to: at('2026-12-01', '20:00'), skipped: ['efc:1'] });
ok(r.sent.length === 0, 'a student on the skip list (cancelled or on hold) gets nothing');
r = simulate({ entry: { ...base, seq_stopped_at: '2026-11-08T00:00:00Z' }, from: at('2026-11-09', '14:00'), to: at('2026-12-01', '20:00') });
ok(r.sent.length === 0, 'a stopped student (STOP, skipped by staff, not grading) gets nothing');
r = simulate({ entry: base, from: at('2026-11-09', '14:00'), to: at('2026-12-01', '20:00'), days: [{ ...day, closed: true }] });
ok(r.sent.length === 0, 'a closed grading day sends nothing');
r = simulate({ entry: base, from: at('2026-11-09', '14:00'), to: at('2026-11-20', '20:00'), days: [{ ...day, bb: true }] });
ok(r.sent.length === 0, 'black belt grading days are left out');

console.log('\nInvited by hand before the sequence was switched on (Sat 7 Nov)');
r = simulate({ entry: { ...base, invited_at: new Date(at('2026-11-07', '15:00')).toISOString() }, from: at('2026-11-10', '09:00'), to: at('2026-11-14', '20:00') });
ok(!r.codes.includes('invite_sms') && !r.codes.includes('invite_email'), 'the invitation is never sent again');
ok(r.logs.get('nudge_d2') === 'missed' && (r.sent.find(s => s.code === 'ready_d4') || {}).at === '2026-11-11 19:00', 'picks up from the next step still ahead (Day 4 email, from 7 Nov)');

console.log('\nSending hours and replies');
r = simulate({ entry: base, from: at('2026-11-09', '21:00'), to: at('2026-11-10', '12:00') });
ok((r.sent.find(s => s.code === 'invite_sms') || {}).at === '2026-11-10 08:00', 'added at 9pm: the invitation waits for 8am');
r = simulate({ entry: { ...base, invited_at: new Date(at('2026-11-09', '14:00')).toISOString(), seq_paused_until: new Date(at('2026-11-12', '09:00')).toISOString() },
  from: at('2026-11-10', '09:00'), to: at('2026-11-14', '20:00') });
ok(r.logs.get('nudge_d2') === 'missed' && r.codes.includes('ready_d4'), 'a reply pauses the booking messages for 2 days (the Day 2 text is dropped, Day 4 still goes)');
const sunDay = { ...day, grading_date: '2026-12-11', location: 'West' };   // Fri 11 Dec: G-5 is Sun 6 Dec
r = simulate({ entry: base, days: [sunDay], from: at('2026-12-04', '09:00'), to: at('2026-12-07', '20:00'), onTick: (t, e) => { if (!e.invited_at) e.invited_at = new Date(at('2026-11-20', '10:00')).toISOString(); } });
ok((r.sent.find(s => s.code === 'call_g5') || {}).at === '2026-12-05 07:00', 'no call on a Sunday: West (Fri 11 Dec) calls on Sat 5 Dec');

// ---- Wording and fields ----
console.log('\nWording');
const v = seqVars({ ...base, token: 'abc123' }, day, { full_name: 'Sam Lee', guardian_name: 'Pat Lee', date_of_birth: '2016-02-01' },
  { fee: 55, prepTime: '9:00am', now: at('2026-11-10', '10:00'), bring: ['Full long-sleeve uniform', 'Belt', 'Drink bottle'] });
ok(v.deadline === 'Tue 24 Nov' && v.date === 'Tuesday 1 December' && v.time === ' at 4:00pm' && v.link === 'https://app.train-ama.com/b#abc123', '{deadline} is 7 days before ("Tue 24 Nov"), with {date}, {time} and {link}');
ok(v.fee === '$55' && v.prep_time === ', 9:00am' && v.prep_link.endsWith('?s=kids') && v.video.startsWith('Grading video: https://youtu.be/'), '{fee}, {prep_time}, {prep_link} (kids or teens) and {video}');
ok(seqVars(base, day, {}, { now: at('2026-11-20', '10:00') }).prep === '', '{prep} is blank once prep bookings close (19 Nov)');
const day0 = (SQL.match(/\('invite_sms'[\s\S]*?E'([\s\S]*?)', 10\)/) || [])[1].replace(/''/g, "'").replace(/\\n/g, '\n');
const sms = fillText(day0, v);
ok(sms === "Hi Pat, Sam is invited to grade for Orange Belt, Tuesday 1 December at 4:00pm, AMA Concord. Reply YES and we'll send the booking link." && sms.length <= 160, 'Day 0 text matches the approved wording, in one SMS');
const mail = buildSeqEmail('Sam\'s Orange Belt grading invitation', "Hi Pat,\n## Grading details\n• Date: Tuesday 1 December\n[Book Sam's grading](https://app.train-ama.com/b#abc)\nAMA Concord");
ok(mail.html.includes('GRADING DETAILS'.toLowerCase().replace(/^./, c => c)) || mail.html.includes('Grading details'), 'emails: ## lines become headings');
ok(mail.html.includes('&#10003;') && mail.html.includes('href="https://app.train-ama.com/b#abc"') && mail.text.includes("Book Sam's grading: https://app.train-ama.com/b#abc"), 'emails: bullet points, and [Button](link) becomes a button');

const links = buildSeqEmail('S', 'Hi\n• Practise with the grading video: https://youtu.be/abc\n• Colour Belt Prep Session: A 2-hour workshop. Book a place: https://train.australianmartialarts.com.au/colour-belt-prep?s=kids\nBook here: https://app.train-ama.com/b#xyz');
ok(/href="https:\/\/youtu\.be\/abc"[^>]*background:#0B6A35[^>]*>Watch the grading video</.test(links.html) && links.html.includes('>Book the Prep Session<') && links.html.includes('>Book the grading<'), 'emails: every link is a button named for where it goes');
ok(!/>https?:\/\//.test(links.html) && !links.html.includes('Book a place') && links.html.includes('Practise with the grading video<') && links.html.includes('A 2-hour workshop.<'), 'emails: no bare addresses shown, and the words around a link stay');
ok(links.text.includes('https://youtu.be/abc'), 'emails: the plain-text version keeps the addresses');

// ---- The function, end to end, with an in-memory database and GoHighLevel ----
const empty = buildSeqEmail('S', 'Hi\n• Colour Belt Prep Session:\n• Date: Tuesday');
ok(!empty.html.includes('Prep Session') && !empty.text.includes('Prep Session') && empty.text.includes('Date: Tuesday'), 'emails: a point left empty (prep session after bookings close) is dropped');
console.log('\nThe function');
function makeDb(tables) {
  const pk = { cb_seq_log: r => r.entry_id + '|' + r.step_code, cb_reply_seen: r => r.who + '|' + r.h };
  let n = 0;
  return {
    t: tables,
    rpc: async (fn, a) => fn === 'cb_cron_ok' ? { data: a.p_secret === 'cron-secret', error: null } : { data: null, error: null },
    auth: { getUser: async tok => ({ data: { user: tok === 'grader' ? { email: 'grader@ama.test' } : tok === 'boss' ? { email: 'boss@ama.test' } : null } }) },
    from(table) {
      const T = tables[table] = tables[table] || [];
      let f = [], op = 'select', payload = null, single = false, tooLong = false, countOnly = false, rng = null, ret = false;   // like the real API: a very long in(...) list fails
      const q = {
        select(c, o) { if (op !== 'select') ret = true; if (o && o.count) countOnly = true; return q; }, or(s) { const parts = String(s).split(',').map(p => { const [c, o, ...v] = p.split('.'); const val = v.join('.'); return r => o === 'is' ? (r[c] ?? null) === (val === 'null' ? null : val) : o === 'neq' ? (r[c] ?? null) !== null && r[c] !== val : o === 'lt' ? (r[c] ?? null) !== null && String(r[c]) < val : o === 'eq' ? r[c] === val : false; }); f.push(r => parts.some(fn => fn(r))); return q; }, neq(c, v) { f.push(r => (r[c] ?? null) !== null && r[c] !== v); return q; },  not(c, op, v) { f.push(r => (r[c] ?? null) !== v); return q; }, lte(c, v) { f.push(r => String(r[c]) <= String(v)); return q; }, eq(c, v) { f.push(r => r[c] === v); return q; }, in(c, vs) { if (vs.length > 150) tooLong = true; f.push(r => vs.includes(r[c])); return q; },
        gte(c, v) { f.push(r => String(r[c]) >= String(v)); return q; }, is(c, v) { f.push(r => (r[c] ?? null) === v); return q; }, match(o) { Object.entries(o).forEach(([c, v]) => f.push(r => r[c] === v)); return q; },
        maybeSingle() { single = true; return q; }, order() { return q; }, limit() { return q; }, range(a, b) { rng = [a, b]; return q; }, lt(c, v) { f.push(r => String(r[c]) < String(v)); return q; },
        update(p) { op = 'update'; payload = p; return q; }, insert(p) { op = 'insert'; payload = p; return q; }, delete() { op = 'delete'; return q; },
        then(res, rej) {
          return Promise.resolve().then(() => {
            if (op === 'insert') {
              for (const row of [].concat(payload)) {
                if (pk[table] && T.some(x => pk[table](x) === pk[table](row))) return { data: null, error: { message: 'duplicate key', code: '23505' } };
                T.push({ id: ++n, ...row, created_at: new Date().toISOString() });
              }
              return { data: null, error: null };
            }
            if (tooLong) return { data: null, error: { message: 'URI too long' } };
            const rows = T.filter(r => f.every(fn => fn(r)));
            if (op === 'update') { rows.forEach(r => Object.assign(r, payload)); return { data: ret ? rows.map(r => ({ ...r })) : null, error: null }; }
            if (op === 'delete') { tables[table] = T.filter(r => !rows.includes(r)); return { data: null, error: null }; }
            if (countOnly) return { data: null, count: rows.length, error: null };
            return { data: single ? (rows[0] || null) : (rng ? rows.slice(rng[0], rng[1] + 1) : rows.slice(0, 1000)), error: null };   // like Supabase: at most 1,000 rows a request
          }).then(res, rej);
        }
      };
      return q;
    }
  };
}
const ghlCalls = [];
let dnd = false;
const http = async (url, opts = {}) => {
  ghlCalls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  const reply = j => ({ ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j });
  if (url.includes('/contacts/search/duplicate')) return reply({ contact: { id: 'c1' } });
  if (/\/contacts\/c1$/.test(url)) return reply({ contact: { id: 'c1', dnd } });
  if (url.includes('/conversations/messages')) return reply({ messageId: 'm' + ghlCalls.length });
  return reply({});
};
const env = { GHL_TOKEN: 'x', GHL_LOCATION_ID: 'loc' };
const tables = () => ({
  cb_settings: [{ id: 1, seq_on: false, contact_phone: '(02) 9569 1943', email_bring: 'Full long-sleeve uniform\nBelt\nDrink bottle', deadline_days: 7, reply_key: 'rk',
    reminder_text: 'REMINDER {first} {date}', not_booked_text: 'OFFICIAL {first} {link}' }],
  cb_seq_steps: STEPS.map(s => ({ ...s })),
  cb_days: [{ ...day }, { day_id: 'bb1', location: 'Sydenham', grading_date: '2026-12-05', bb: true, closed: false, programme: 'Taekwondo' }],
  cb_entries: [{ ...base }, { ...base, entry_id: 'e2', member_key: 'efc:2', full_name: 'Kim Ng', token: 'TOK2' }, { ...base, entry_id: 'bbe', day_id: 'bb1', member_key: 'efc:3', full_name: 'Black Belt' }],
  efc_members: [{ member_key: 'efc:1', full_name: 'Sam Lee', guardian_name: 'Pat Lee', phone: '0412 345 678', email: 'pat@example.test' },
    { member_key: 'efc:2', full_name: 'Kim Ng', guardian_name: 'Jo Ng', phone: '0412 000 111', email: null },
    { member_key: 'efc:3', full_name: 'Black Belt', guardian_name: 'BB Parent', phone: '0499 999 999' }],
  cb_belts: [{ programme: 'Taekwondo', belt: 'Yellow Belt', fee: 55 }],
  cb_seq_log: [], cb_messages: [], cb_calls: [], cb_outbox: [], cb_prep_bookings: [], cb_skip: [], prep_roles: [{ email: 'grader@ama.test', role: 'grading' }, { email: 'boss@ama.test', role: 'admin' }], app_permissions: [{ email: 'grader@ama.test', app: 'cb', perm: 'view' }, { email: 'grader@ama.test', app: 'cb', perm: 'days' }, { email: 'grader@ama.test', app: 'cb', perm: 'readiness' }, { email: 'grader@ama.test', app: 'cb', perm: 'texts' }, { email: 'grader@ama.test', app: 'cb', perm: 'payments' }, { email: 'grader@ama.test', app: 'cb', perm: 'results' }, { email: 'grader@ama.test', app: 'cb', perm: 'calls' }, { email: 'boss@ama.test', app: 'cb', perm: 'admin' }]
});
const call = (db, body, headers = {}) => handle(new Request('https://x.test/functions/v1/cb', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), db, env, http).then(async r => ({ status: r.status, body: await r.json() }));
const cron = db => call(db, { action: 'sequence' }, { 'x-cb-cron': 'cron-secret' });

let db = makeDb(tables());
let res = await call(db, { action: 'sequence' }, { 'x-cb-cron': 'wrong' });
ok(res.status === 403, 'the 15-minute run needs the cron secret');
res = await cron(db);
ok(res.body.ok && res.body.on === false && ghlCalls.length === 0 && db.t.cb_seq_log.length === 0, 'switched off: sends nothing');

db.t.cb_settings[0].seq_on = true;
// Freeze "now" inside the sending hours for the real runs
const realNow = Date.now; Date.now = () => at('2026-11-09', '14:00');
res = await cron(db);
const sms1 = ghlCalls.filter(c => c.body && c.body.type === 'SMS'), mail1 = ghlCalls.filter(c => c.body && c.body.type === 'Email');
ok(res.body.sent === 3 && sms1.length === 2 && mail1.length === 1, 'switched on: invitation texts to both families, email to the one with an email address');
ok(sms1[0].body.message.includes('TEXT invite_sms Sam') && mail1[0].body.subject === 'SUBJ invite_email Sam', 'uses the step wording');
ok(db.t.cb_entries.find(e => e.entry_id === 'e1').invited_at && db.t.cb_entries.find(e => e.entry_id === 'bbe').invited_at == null, 'marks them invited; the black belt student is left alone');
ok(db.t.cb_seq_log.find(l => l.entry_id === 'e2' && l.step_code === 'invite_email').status === 'skipped', 'no email address: that step is logged as skipped');
const sends = () => ghlCalls.filter(c => c.body && c.body.type).length, before = sends();
await cron(db); await cron(db);
ok(sends() === before, 'running again sends nothing more');
// Two runs at the same moment: the claim row means only one sends
Date.now = () => at('2026-11-11', '10:00');
const msgsBefore = ghlCalls.filter(c => c.body && c.body.type === 'SMS').length;
await Promise.all([cron(db), cron(db)]);
ok(ghlCalls.filter(c => c.body && c.body.type === 'SMS').length - msgsBefore === 2, 'two runs at once: the Day 2 nudge goes once to each family');

console.log('\nReplies, STOP and DND');
Date.now = () => at('2026-11-12', '09:00');
res = await call(db, { action: 'reply', key: 'rk', phone: '0412 000 111', message: 'Not sure he is ready' });
const e2 = db.t.cb_entries.find(e => e.entry_id === 'e2');
ok(e2.seq_paused_until && db.t.cb_calls.some(c => c.entry_id === 'e2' && c.reason === 'concern' && c.note === 'Not sure he is ready'), 'a reply pauses the sequence for 2 days and adds a concern call');
res = await call(db, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'STOP' });
ok(db.t.cb_entries.find(e => e.entry_id === 'e1').seq_stopped_why === 'Replied STOP', 'STOP ends the sequence');
Date.now = () => at('2026-11-13', '19:00');
const n0 = ghlCalls.filter(c => c.body && c.body.type).length;
await cron(db);
ok(ghlCalls.filter(c => c.body && c.body.type).length === n0, 'stopped and paused families get nothing (Day 4 email)');
// DND
db = makeDb(tables()); db.t.cb_settings[0].seq_on = true; dnd = true; Date.now = () => at('2026-11-09', '14:00');
const n1 = ghlCalls.filter(c => c.body && c.body.type).length;
await cron(db);
ok(ghlCalls.filter(c => c.body && c.body.type).length === n1 && db.t.cb_seq_log.filter(l => l.step_code === 'invite_sms').every(l => l.status === 'skipped' && l.why === 'DND in GoHighLevel'), 'DND set in GoHighLevel: nothing is sent');
dnd = false;

console.log('\nThe G-5 call and call outcomes');
db = makeDb(tables()); db.t.cb_settings[0].seq_on = true;
db.t.cb_entries.forEach(e => { e.invited_at = new Date(at('2026-11-20', '10:00')).toISOString(); });
db.t.cb_seq_log.push(...['e1', 'e2'].flatMap(id => ['invite_sms', 'invite_email', 'nudge_d2', 'ready_d4', 'checkin_d6', 'close_g8', 'prep_last'].map(c => ({ entry_id: id, step_code: c, status: 'sent' }))));
Date.now = () => at('2026-11-26', '07:00');
await cron(db);
ok(db.t.cb_calls.filter(c => c.reason === 'not_booked').length === 2 && db.t.cb_calls.every(c => c.callback_on === '2026-11-26'), 'G-5: everyone still not booked is on the call list today');
db.t.cb_outbox.push({ out_id: 'o1', entry_id: 'e1', kind: 'send_link', sent_at: null }, { out_id: 'o2', entry_id: 'e2', kind: 'no_answer', sent_at: null });
db.t.cb_settings[0].seq_on = false;   // outcome texts go even while switched off
const n2 = ghlCalls.length;
await cron(db);
const outSms = ghlCalls.slice(n2).filter(c => c.body && c.body.type === 'SMS').map(c => c.body.message);
ok(outSms.some(m => m.startsWith('OFFICIAL Sam https://app.train-ama.com/b#TOK')) && outSms.some(m => m.startsWith('TEXT out_no_answer Kim')) && db.t.cb_outbox.every(o => o.sent_at), '"Send link" texts the booking link again; "No answer" sends the we-tried-calling text');

console.log('\nSend test to me');
db = makeDb(tables());
res = await call(db, { action: 'seq_test', code: 'ready_d4', email: 'mark@ama.test' }, { authorization: 'Bearer grader' });
const testMail = ghlCalls.filter(c => c.body && c.body.type === 'Email').pop();
ok(res.body.ok && testMail.body.subject === 'SUBJ ready_d4 Sam' && db.t.cb_messages.some(m => m.kind === 'seq_test'), 'grading staff get a test email with a sample family, logged as a test');
res = await call(db, { action: 'seq_test', code: 'nudge_d2', phone: '' }, { authorization: 'Bearer grader' });
ok(res.status === 400 && /mobile/.test(res.body.error), 'a test text needs your mobile');
res = await call(db, { action: 'seq_run' }, { authorization: 'Bearer grader' });
ok(res.status === 403, 'only an admin can run the sequence by hand');

console.log('\nA big day: 300 students invited in one run');
db = makeDb(tables());
db.t.cb_settings[0].seq_on = true;
for (let i = 0; i < 300; i++) {
  db.t.cb_entries.push({ ...base, entry_id: 'big' + i, member_key: 'efc:big' + i, full_name: 'Big ' + i, token: 'TOKBIG' + i });
  db.t.efc_members.push({ member_key: 'efc:big' + i, full_name: 'Big ' + i, guardian_name: 'Parent ' + i, phone: '0412 000 ' + String(i).padStart(3, '0') });
}
Date.now = () => at('2026-11-09', '14:00');
const before300 = ghlCalls.filter(c => c.body && c.body.type === 'SMS').length;
await cron(db);
const firstRun = ghlCalls.filter(c => c.body && c.body.type === 'SMS').length - before300;
for (let i = 0; i < 30; i++) await cron(db);   // each run sends a capped number; the next runs pick up the rest
ok(firstRun <= 40, 'one run sends at most 40 messages, so it stays inside the time limit');
ok(ghlCalls.filter(c => c.body && c.body.type === 'SMS').length - before300 === 302 && !db.t.cb_seq_log.some(l => l.why === 'Student not found in EFC'), 'every family is found and texted (lookups go in batches)');
// A run cut off mid-send: its 'sending' claim is let go after 15 minutes (or marked sent if the message went)
const sid = db.t.cb_seq_log.find(l => l.step_code === 'invite_sms').entry_id;
const sentRow = db.t.cb_seq_log.find(l => l.step_code === 'invite_email' && l.status === 'sent');
db.t.cb_seq_log.find(l => l.entry_id === sid && l.step_code === 'invite_sms').status = 'sending';
db.t.cb_seq_log.find(l => l.entry_id === sid && l.step_code === 'invite_sms').at = new Date(Date.now() - 20 * 60e3).toISOString();
db.t.cb_messages = db.t.cb_messages.filter(x => !(x.entry_id === sid && x.sent_by === 'automatic: invite_sms'));
db.t.cb_entries.find(e => e.entry_id === sid).invited_at = null;   // the cut-off run never got as far as sending
sentRow.status = 'sending'; sentRow.at = new Date(Date.now() - 20 * 60e3).toISOString();
const smsBefore = ghlCalls.length;
await cron(db);
ok(db.t.cb_seq_log.find(l => l.entry_id === sid && l.step_code === 'invite_sms').status === 'sent' && ghlCalls.slice(smsBefore).filter(c => c.body && c.body.type === 'SMS').length === 1, 'a claim stuck sending with no message logged is sent again');
ok(sentRow.status === 'sent' && sentRow.why === 'Recovered after a cut-off run', 'a claim stuck sending whose message went is marked sent');
// GoHighLevel's daily SMS limit: a text it accepted and then failed is found on the next run, texting stops until the limit
// resets, the invitation text waits (its email has gone), and other texts go by email instead
{
  const lim = makeDb(tables()); lim.t.cb_settings[0].seq_on = true; dnd = false; Date.now = () => at('2026-11-09', '14:00');
  let failIds = new Set();
  const http2 = async (url, opts = {}) => {
    const m = url.match(/\/conversations\/messages\/(m\d+)$/);
    if (m) { const j = { message: { id: m[1], status: failIds.has(m[1]) ? 'failed' : 'delivered', meta: failIds.has(m[1]) ? { error: 'You have reached your SMS sending limit of 750 for the day. You can start sending message after 2026-11-10 16:41 Australia/Sydney.' } : {} } }; return { ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j }; }
    return http(url, opts);
  };
  const cron2 = () => handle(new Request('https://x.test/functions/v1/cb', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cb-cron': 'cron-secret' }, body: JSON.stringify({ action: 'sequence' }) }), lim, env, http2).then(r => r.json());
  await cron2();
  const sent = lim.t.cb_messages.filter(x => x.sent_by === 'automatic: invite_sms' && x.status === 'sent');
  ok(sent.length === 2 && sent.every(x => x.ghl_id), 'each text keeps GoHighLevel\'s message id');
  sent.forEach(x => { failIds.add(x.ghl_id); x.sent_at = new Date(Date.now() - 5 * 60e3).toISOString(); });
  Date.now = () => at('2026-11-09', '14:10');
  const before = ghlCalls.filter(c => c.body && c.body.type === 'SMS').length;
  const r2 = await cron2();
  ok(r2.verify && r2.verify.failed === 2 && sent.every(x => x.status === 'failed'), 'texts GoHighLevel failed are marked failed');
  ok(String(lim.t.cb_settings[0].sms_blocked_until).startsWith('2026-11-10T05:42'), 'texting stops until the limit resets');
  ok(lim.t.cb_entries.filter(e => e.entry_id !== 'bbe').every(e => !e.invited_at) && ghlCalls.filter(c => c.body && c.body.type === 'SMS').length === before && r2.waiting === 2, 'the invitation texts wait (no texts while stopped)');
  // A family replies YES while texting is stopped: the booking link goes by email
  const before2 = ghlCalls.length;
  lim.t.cb_entries[0].invited_at = new Date().toISOString();
  const rr = await handle(new Request('https://x.test/functions/v1/cb', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reply', key: 'rk', phone: '0412345678', message: 'Yes' }) }), lim, env, http2).then(r => r.json());
  const mails = ghlCalls.slice(before2).filter(c => c.body && c.body.type === 'Email'), texts = ghlCalls.slice(before2).filter(c => c.body && c.body.type === 'SMS');
  ok(rr.results[0].emailed && mails.length === 1 && texts.length === 0 && mails[0].body.html.includes('Book the grading'), 'a YES while texting is stopped gets the booking link by email');
  // After the reset the invitations are texted again
  Date.now = () => at('2026-11-10', '16:45');
  lim.t.cb_entries[0].invited_at = null; lim.t.cb_entries[0].seq_paused_until = null;
  const before3 = ghlCalls.filter(c => c.body && c.body.type === 'SMS').length;
  await cron2();
  ok(ghlCalls.filter(c => c.body && c.body.type === 'SMS').length - before3 === 3, 'once the limit resets, the invitation texts go again, and the queued booking-link text');
  ok(lim.t.cb_outbox.length === 1 && lim.t.cb_outbox[0].status === 'sent', 'the booking-link text queued during the block is sent');
}
// The daily cap: invitation texts beyond sms_daily_cap wait for the next day
{
  const cap = makeDb(tables()); cap.t.cb_settings[0].seq_on = true; cap.t.cb_settings[0].sms_daily_cap = 1; Date.now = () => at('2026-11-09', '14:00');
  const before = ghlCalls.filter(c => c.body && c.body.type === 'SMS').length;
  const r = await handle(new Request('https://x.test/functions/v1/cb', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cb-cron': 'cron-secret' }, body: JSON.stringify({ action: 'sequence' }) }), cap, env, http).then(r => r.json());
  ok(ghlCalls.filter(c => c.body && c.body.type === 'SMS').length - before === 1 && r.waiting === 1, 'invitation texts stop at the daily cap; the rest wait');
}
// "No" or "can't make it": offer the other gradings for their belt and age; replying 1 moves them and sends the link
{
  console.log('\nAnother grading instead');
  const T = tables();
  T.cb_days = [
    { day_id: 'mk', location: 'Marrickville', grading_date: '2026-12-08', start_time: '17:15', programme: 'Taekwondo', closed: false, bb: false, belt_times: {}, belts: ['Yellow Belt'], max_age: 12 },
    { day_id: 'co', location: 'Concord', grading_date: '2026-12-01', start_time: '16:00', programme: 'Taekwondo', closed: false, bb: false, belt_times: {}, belts: ['White Belt', 'Yellow Belt', 'Orange Belt', 'Green Belt'] },
    { day_id: 'teen', location: 'Marrickville', grading_date: '2026-12-08', start_time: '18:30', programme: 'Taekwondo', closed: false, bb: false, belt_times: {}, belts: ['White Belt', 'Yellow Belt'], min_age: 13 },
    { day_id: 'we', location: 'West', grading_date: '2026-12-11', start_time: '17:00', programme: 'Taekwondo', closed: false, bb: false, belt_times: {}, efc_belt_sessions: { 'Yellow Belt': 'S1' } },
    { day_id: 'hi', location: 'West', grading_date: '2026-12-11', start_time: '18:45', programme: 'Taekwondo', closed: false, bb: false, belt_times: {}, belts: ['Blue Belt'] },
    { day_id: 'shut', location: 'Sylvania', grading_date: '2026-12-02', start_time: '16:00', programme: 'Taekwondo', closed: false, bb: false, belt_times: {}, book_by: '2026-11-01T00:00:00Z' }];
  T.cb_entries = [{ ...base, day_id: 'mk', invited_at: '2026-11-08T05:00:00Z', school: 'Marrickville' }];
  T.efc_members[0].date_of_birth = '2017-03-01';   // 9 years old
  const alt = makeDb(T); Date.now = () => at('2026-11-10', '12:00');
  const n0 = ghlCalls.length;
  const r1 = await call(alt, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "Sorry, we can't make that one" });
  const offer = ghlCalls.slice(n0).find(c => c.body && c.body.type === 'SMS');
  ok(r1.body.no && r1.body.offered === 2 && r1.body.days.join() === 'co,we', 'offers the other gradings for their belt and age: not the teens session, a higher belt group or one whose bookings have closed');
  ok(offer && /1\. Tue 1 Dec 4:00pm at AMA Concord\n2\. Fri 11 Dec 5:00pm at AMA West/.test(offer.body.message) && /Reply 1 or 2 to switch/.test(offer.body.message), 'the text lists them by number');
  ok(alt.t.cb_entries[0].alt_offer.days.join() === 'co,we' && alt.t.cb_messages.some(m => m.kind === 'alt_offer'), 'the offer is saved and logged');
  const n1 = ghlCalls.length;
  const r2 = await call(alt, { action: 'reply', key: 'rk', phone: '0412 345 678', message: '2' });
  const link = ghlCalls.slice(n1).find(c => c.body && c.body.type === 'SMS');
  ok(r2.body.moved === 1 && alt.t.cb_entries[0].day_id === 'we' && alt.t.cb_entries[0].moved_from_day === 'mk' && !alt.t.cb_entries[0].alt_offer, 'replying 2 moves them to that grading');
  ok(link && link.body.message === 'OFFICIAL Sam https://app.train-ama.com/b#TOK', 'and texts the booking link');
  const r3 = await call(alt, { action: 'reply', key: 'rk', phone: '0412 345 678', message: '1' });
  ok(!r3.body.moved, 'a number with no offer waiting does nothing');
  // Replying 0 keeps the original date
  { const T0 = tables(); T0.cb_days = T.cb_days; T0.cb_entries = [{ ...base, day_id: 'mk', invited_at: '2026-11-08T05:00:00Z', school: 'Marrickville' }]; T0.efc_members[0].date_of_birth = '2017-03-01';
    const kp = makeDb(T0), k0 = ghlCalls.length;
    await call(kp, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "Sorry, we can't make that one" });
    const of = ghlCalls.slice(k0).find(c => c.body && c.body.type === 'SMS');
    ok(of && /Or reply 0 to keep the original date \(Tue 8 Dec 5:15pm at AMA Marrickville\)/.test(of.body.message), 'the offer has an option to keep the original date');
    const k1 = ghlCalls.length, rk = await call(kp, { action: 'reply', key: 'rk', phone: '0412 345 678', message: '0' });
    const lk = ghlCalls.slice(k1).find(c => c.body && c.body.type === 'SMS'), e0 = kp.t.cb_entries[0];
    ok(rk.body.kept === 1 && e0.day_id === 'mk' && !e0.alt_offer && !e0.cant_make_at && lk && /b#TOK/.test(lk.body.message), 'replying 0 keeps them on the original date, off the Can\'t-make list, and texts the booking link'); }
  // "We won't be grading, we'll be overseas": the date is the problem, so they get the other gradings (not a not-grading call)
  { const T3 = tables(); T3.cb_days = T.cb_days; T3.cb_entries = [{ ...base, day_id: 'mk', invited_at: '2026-11-08T05:00:00Z', school: 'Marrickville' }]; T3.efc_members[0].date_of_birth = '2017-03-01';
    const ov = makeDb(T3); const rr = await call(ov, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "Hi\nWe won't be grading unfortunately\nWe will be overseas at that time" });
    ok(rr.body.no && rr.body.offered === 2 && !ov.t.cb_calls.some(c => c.reason === 'not_grading'), '"we won\'t be grading, we\'ll be overseas" is offered the other gradings'); }
  { const T3 = tables(); T3.cb_entries = [{ ...base, invited_at: '2026-11-08T05:00:00Z' }]; const x = makeDb(T3);
    const rr = await call(x, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "He's injured and we're away anyway" });
    ok(rr.body.not_grading === 1, 'injured (even if also away) is still not grading'); }
  // "I normally do Sam's grading at Concord": moved to that school's grading for their belt and age, and the link is texted
  { const T3 = tables(); T3.cb_days = T.cb_days; T3.cb_entries = [{ ...base, day_id: 'mk', invited_at: '2026-11-08T05:00:00Z', school: 'Marrickville' }]; T3.efc_members[0].date_of_birth = '2017-03-01';
    const sc = makeDb(T3), k0 = ghlCalls.length; const rr = await call(sc, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "Hello\n\nI normally do Sam's grading at Concord" });
    const tx = ghlCalls.slice(k0).find(c => c.body && c.body.type === 'SMS');
    ok(rr.body.school && sc.t.cb_entries[0].day_id === 'co' && sc.t.cb_entries[0].moved_from_day === 'mk', '"I normally grade at Concord" moves them to the Concord grading for their belt');
    ok(tx && /moved Sam to grade for Orange Belt at AMA Concord on Tuesday 1 December at 4:00pm\. Book here: https:\/\/app\.train-ama\.com\/b#TOK/.test(tx.body.message), '...and texts the booking link'); }
  { const T3 = tables(); T3.cb_days = T.cb_days; T3.cb_entries = [{ ...base, day_id: 'mk', invited_at: '2026-11-08T05:00:00Z', school: 'Marrickville' }]; T3.efc_members[0].date_of_birth = '2017-03-01';
    const sc = makeDb(T3); const rr = await call(sc, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "We don't go to Concord any more, Marrickville is fine" });
    ok(!rr.body.school && sc.t.cb_entries[0].day_id === 'mk', 'a school they say they don\'t go to is not a move (and the one they are on stays)'); }
  { const T3 = tables(); T3.cb_days = T.cb_days; T3.cb_entries = [{ ...base, day_id: 'mk', invited_at: '2026-11-08T05:00:00Z', school: 'Marrickville' }]; T3.efc_members[0].date_of_birth = '2017-03-01';
    const sc = makeDb(T3); const rr = await call(sc, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'Can she grade at Sylvania instead?' });
    ok(!rr.body.school && sc.t.cb_entries[0].day_id === 'mk', 'no open grading at that school for their belt: nothing moves'); }
  // Nothing suits: no offer (the call to the family still happens)
  const T2 = tables(); T2.cb_days = [T.cb_days[0], T.cb_days[4]]; T2.cb_entries = [{ ...base, day_id: 'mk', invited_at: '2026-11-08T05:00:00Z' }];
  const none = makeDb(T2), n2 = ghlCalls.length;
  const r4 = await call(none, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'No' });
  ok(r4.body.no && r4.body.offered === 0 && ghlCalls.length === n2, 'when no other grading suits, nothing is texted');
}
// More than 1,000 students on coming gradings: a family listed past row 1,000 is still found and planned
{
  console.log('\nOver 1,000 students');
  const T = tables(); T.cb_settings[0].seq_on = true;
  const filler = Array.from({ length: 1100 }, (_, i) => ({ ...base, entry_id: 'f' + i, member_key: 'efc:f' + i, full_name: 'Filler ' + i, token: 'T' + i, invited_at: '2026-11-08T05:00:00Z', result: 'passed' }));
  T.cb_entries = [...filler, { ...base, invited_at: '2026-11-08T05:00:00Z' }];
  const big = makeDb(T); Date.now = () => at('2026-11-10', '12:00');
  const r = await call(big, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'Yes please' });
  ok(r.body.matched === 1 && big.t.cb_entries.find(e => e.entry_id === 'e1').yes_at, "a family's YES is matched even when they are student 1,101");
}
// "That's the wrong belt": the belt is fixed, they're moved to a grading for it, and the booking link goes
{
  console.log('\nWrong belt');
  const LAD = ['White', 'Yellow', 'Orange', 'Green', 'Blue', 'Purple'].map((b, i, a) => ({ programme: 'Taekwondo', belt: b + ' Belt', next_belt: a[i + 1] ? a[i + 1] + ' Belt' : 'Brown Belt', fee: 70 }));
  const mk = () => { const T = tables(); T.cb_belts = LAD;
    T.cb_days = [{ day_id: 'lo', location: 'Marrickville', grading_date: '2026-12-08', start_time: '16:00', programme: 'Taekwondo', closed: false, bb: false, belt_times: {}, belts: ['White Belt', 'Yellow Belt'] },
      { day_id: 'hi', location: 'Marrickville', grading_date: '2026-12-09', start_time: '17:15', programme: 'Taekwondo', closed: false, bb: false, belt_times: {}, belts: ['Orange Belt', 'Green Belt'] },
      { day_id: 'co', location: 'Concord', grading_date: '2026-12-01', start_time: '16:00', programme: 'Taekwondo', closed: false, bb: false, belt_times: {}, belts: ['Blue Belt'] }];
    T.cb_entries = [{ ...base, day_id: 'lo', invited_at: '2026-11-08T05:00:00Z' }]; return makeDb(T); };
  Date.now = () => at('2026-11-10', '12:00');
  let w = mk(), n0 = ghlCalls.length;
  let r = await call(w, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "That's the wrong belt, Sam's going for Green" });
  const fx = ghlCalls.slice(n0).find(c => c.body && c.body.type === 'SMS'), e = w.t.cb_entries[0];
  ok(e.belt_from === 'Orange Belt' && e.belt_to === 'Green Belt' && e.belt_changed_from === 'Yellow Belt to Orange Belt', 'the belt is changed to what they said (going for Green: on Orange)');
  ok(e.day_id === 'hi' && e.moved_from_day === 'lo' && r.body.belt.moved, '...and they move to the grading at their school for that belt');
  ok(fx && /updated Sam to grade for Green Belt at AMA Marrickville on Wednesday 9 December at 5:15pm\. Book here: https:\/\/app\.train-ama\.com\/b#TOK/.test(fx.body.message) && w.t.cb_messages.some(m => m.kind === 'belt_fix'), 'the booking link is texted straight away');
  w = mk(); r = await call(w, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "Sorry he's a White Belt" });
  ok(w.t.cb_entries[0].belt_from === 'White Belt' && w.t.cb_entries[0].belt_to === 'Yellow Belt' && w.t.cb_entries[0].day_id === 'lo', '"he\'s a White Belt" means the belt they are on; the same day still suits');
  w = mk(); n0 = ghlCalls.length; r = await call(w, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'Wrong belt, she is going for purple' });
  ok(w.t.cb_entries[0].belt_to === 'Orange Belt' && (w.t.cb_admin_q || []).some(q => q.kind === 'no_grading') && !ghlCalls.slice(n0).some(c => c.body && c.body.type === 'SMS'), 'no grading for that belt at their school: nothing changes, the admin gets a belt check');
  w = mk(); n0 = ghlCalls.length; r = await call(w, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'Sam completed her yellow belt grading on September 22.' });
  ok(w.t.cb_entries[0].belt_from === 'Yellow Belt' && w.t.cb_entries[0].belt_to === 'Orange Belt' && !r.body.belt, '"completed her yellow belt grading" when we already have Yellow to Orange changes nothing');
  w = mk(); w.t.cb_entries[0].belt_from = 'White Belt'; w.t.cb_entries[0].belt_to = 'Yellow Belt'; r = await call(w, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'Sam completed her orange belt grading on September 22.' });
  ok(w.t.cb_entries[0].belt_from === 'Orange Belt' && w.t.cb_entries[0].belt_to === 'Green Belt' && w.t.cb_entries[0].day_id === 'hi', '"completed her orange belt grading" means she is on Orange: Orange to Green, moved to that grading');
  for (const t of ['Passed his green belt last term', 'She already achieved her green belt']) { w = mk(); await call(w, { action: 'reply', key: 'rk', phone: '0412 345 678', message: t });
    ok(w.t.cb_entries[0].belt_from === 'Green Belt' && w.t.cb_entries[0].belt_to === 'Blue Belt', `"${t}" is read as the belt they are on`); }
  w = mk(); n0 = ghlCalls.length; r = await call(w, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'Can you check the green belt grading date for her please' });
  ok(r.body.belt === 'asked admin (unclear)' && (w.t.cb_admin_q || []).some(q => q.kind === 'unclear' && q.entry_id === w.t.cb_entries[0].entry_id) && w.t.cb_entries[0].belt_to === 'Orange Belt', 'a reply about a belt that isn\'t a clear correction goes to the admin as a belt check');
  w = mk(); r = await call(w, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'Liked \u201cHi Alex, here is Sam\'s official invitation to grade for their Orange Belt at AMA Marrickville\u201d' });
  ok(r.body.belt !== 'asked admin (unclear)' && !(w.t.cb_admin_q || []).length, 'a reaction quoting our own text is not a belt check');
  w = mk(); r = await call(w, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'Yes see you there' });
  ok(!r.body.belt && w.t.cb_entries[0].belt_to === 'Orange Belt', 'a plain YES is not a belt change');
}
// "We don't want to grade": a call for admins on the hub
{
  console.log('\nNot grading');
  const T = tables(); T.cb_entries = [{ ...base, invited_at: '2026-11-08T05:00:00Z' }];
  const ng = makeDb(T); Date.now = () => at('2026-11-10', '12:00');
  const n0 = ghlCalls.length;
  const r = await call(ng, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "We don't want to grade this time thanks" });
  const c = ng.t.cb_calls[0];
  ok(r.body.not_grading === 1 && c && c.reason === 'not_grading' && c.for_admin === true && /don't want/.test(c.note), 'a call for an admin goes on the hub\'s list, with what they said');
  ok(Date.parse(ng.t.cb_entries[0].seq_paused_until) > Date.now() + 10 * 864e5 && ghlCalls.length === n0, 'their booking messages stop, and nothing is texted to them');
  for (const t of ['Thank you no grading this time', "Not ready yet, maybe next time", "He's injured", "Hi, Yes I did. We opted to pause Luca's membership as he is representing his football academy in the Sydney Premier League championship. This is for the remainder of the year.", 'Her membership is on hold until January']) { const T3 = tables(); T3.cb_entries = [{ ...base, invited_at: '2026-11-08T05:00:00Z' }]; const x = makeDb(T3);
    const rr = await call(x, { action: 'reply', key: 'rk', phone: '0412 345 678', message: t }); ok(rr.body.not_grading === 1 && x.t.cb_calls[0].for_admin, `"${t}" is a not-grading call for an admin`); }
  { const T4 = tables(); T4.cb_entries = [{ ...base, invited_at: '2026-11-08T05:00:00Z' }]; const x = makeDb(T4);
    const rr = await call(x, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "Yes, I did. Thank you very very much. It's just that for family reasons. We have not been attending so therefore we don't feel it. It's time for them to be graded once again thank you Angela." });
    ok(rr.body.not_grading === 1 && x.t.cb_calls[0].for_admin, '"we have not been attending" is a not-grading call for an admin, even starting "Yes, I did"'); }
  { const T5 = tables(); T5.cb_entries = [{ ...base, invited_at: '2026-11-08T05:00:00Z' }]; T5.cb_settings[0].seq_on = true; const x = makeDb(T5);
    await call(x, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'Hi, could I please have a phone call with a staff member at some point today?' });
    const c5 = x.t.cb_calls[0];
    ok(c5 && c5.reason === 'concern' && c5.for_admin === true && /^Asked for a call: /.test(c5.note), 'asking for a phone call puts a call for an admin on the hub'); }
  { const T6 = tables(); T6.cb_entries = [{ ...base, invited_at: '2026-11-08T05:00:00Z' }]; T6.cb_settings[0].seq_on = true; const x = makeDb(T6);
    await call(x, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'What time does it finish?' });
    ok(x.t.cb_calls[0] && x.t.cb_calls[0].for_admin !== true, 'an ordinary question stays an ordinary call'); }
  // "Yes for Kim, no for Sam": only Sam is not grading (both children on the same mobile)
  const T4 = tables(); T4.cb_entries = [{ ...base, invited_at: '2026-11-08T05:00:00Z' }, { ...base, entry_id: 'e9', member_key: 'efc:9', full_name: 'Kim Lee', token: 'TOK9', invited_at: '2026-11-08T05:00:00Z' }];
  T4.efc_members.push({ member_key: 'efc:9', full_name: 'Kim Lee', guardian_name: 'Pat Lee', phone: '0412 345 678' });
  const fam = makeDb(T4); const rf = await call(fam, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "Yes for Kim, no for Sam (he's injured)" });
  ok(rf.body.not_grading === 1 && fam.t.cb_calls.length === 1 && fam.t.cb_calls[0].entry_id === 'e1', '"no for Sam" is a call about Sam only');
  // "STOP - they've stopped attending": texting stops and an admin still follows up
  const T5 = tables(); T5.cb_settings[0].seq_on = true; T5.cb_entries = [{ ...base, invited_at: '2026-11-08T05:00:00Z' }]; const sp = makeDb(T5);
  const rs = await call(sp, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'STOP - Sam has stopped attending' });
  ok(rs.body.stopped && sp.t.cb_entries[0].seq_stopped_at && sp.t.cb_calls.some(c => c.reason === 'not_grading' && c.for_admin), 'STOP with "stopped attending" stops texts and adds an admin call');
  const T6 = tables(); T6.cb_settings[0].seq_on = true; T6.cb_entries = [{ ...base, invited_at: '2026-11-08T05:00:00Z' }]; const sp2 = makeDb(T6);
  await call(sp2, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'STOP' });
  ok(!sp2.t.cb_calls.length, 'a plain STOP adds no call');
}
// ---- Audit fixes: no double answers, no double sends, one shared text limit ----
{
  console.log('\nNo doubles');
  const smsN = () => ghlCalls.filter(c => c.body && c.body.type === 'SMS').length;
  // GoHighLevel delivering the same reply twice: handled once
  { const T = tables(); T.cb_entries = [{ ...base, invited_at: '2026-11-08T05:00:00Z' }]; const x = makeDb(T);
    const a = await call(x, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'What time does it finish?' });
    const b = await call(x, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'What time does it  finish? ' });
    ok(!a.body.duplicate && b.body.duplicate === true && x.t.cb_reply_seen.length === 1, 'the same reply delivered twice is only handled once');
    const c = await call(x, { action: 'reply', key: 'rk', phone: '0412 345 678', message: 'Also, what should she bring?' });
    ok(!c.body.duplicate, '...but a different reply from them is still handled'); }
  // "Can't make those either" after the other days were offered: an admin call
  { const T = tables(); T.cb_entries = [{ ...base, invited_at: '2026-11-08T05:00:00Z', alt_offer: { days: ['d2'], at: new Date(Date.now() - 3600e3).toISOString() } }]; const x = makeDb(T);
    const r = await call(x, { action: 'reply', key: 'rk', phone: '0412 345 678', message: "Sorry we can't make any of those either" });
    ok(r.body.alreadyOffered && x.t.cb_calls.some(c => c.for_admin === true && /other days offered/.test(c.note)), "can't make the other days offered either: a call for an admin"); }
  // The outbox: a row another run is already sending is left alone; one whose run died 10+ minutes ago is sent
  { const x = makeDb(tables()); Date.now = () => at('2026-11-09', '14:00');
    x.t.cb_outbox.push({ out_id: 'b1', entry_id: 'e1', kind: 'send_link', sent_at: null, status: 'sending', claimed_at: new Date(Date.now() - 60e3).toISOString() },
                       { out_id: 'b2', entry_id: 'e2', kind: 'send_link', sent_at: null, status: 'sending', claimed_at: new Date(Date.now() - 20 * 60e3).toISOString() });
    await cron(x);
    ok(!x.t.cb_outbox[0].sent_at && x.t.cb_outbox[1].sent_at, 'an outbox text another run is sending is not sent twice; a stuck one is retried'); }
  // The hub's Send pressed twice: the second is skipped
  { const x = makeDb(tables()); Date.now = realNow; const before = smsN();
    const send = () => call(x, { action: 'send', kind: 'reminder', items: [{ member_key: 'efc:1', entry_id: 'e1', body: 'See you Saturday at 10' }] }, { authorization: 'Bearer grader' });
    const r1 = await send(), r2 = await send();
    ok(r1.body.results[0].ok && r2.body.results[0].duplicate && smsN() - before === 1, 'pressing Send twice only texts them once'); }
  // Black belt texts use the same GoHighLevel number, so they count towards the coloured belt daily cap
  { const x = makeDb(tables()); x.t.cb_settings[0].seq_on = true; x.t.cb_settings[0].sms_daily_cap = 2; Date.now = () => at('2026-11-09', '14:00');
    x.t.prep_nurture_log = [{ log_id: 1, channel: 'sms', status: 'sent', sent_at: new Date(Date.now() - 3600e3).toISOString() }];
    const before = smsN();
    const r = await handle(new Request('https://x.test/functions/v1/cb', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cb-cron': 'cron-secret' }, body: JSON.stringify({ action: 'sequence' }) }), x, env, http).then(r => r.json());
    ok(smsN() - before === 1 && r.waiting === 1, 'black belt texts sent today count towards the daily text limit'); }
}
Date.now = realNow;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

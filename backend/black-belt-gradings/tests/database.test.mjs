// Database tests for the Black Belt Gradings System.
// Builds the card software's database, adds the prep system on top, then checks the
// scenarios from spec section 16 that the database is responsible for.
//
//   cd tests && npm install && CARD_REPO=/path/to/ama-id-cards node database.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CARD = process.env.CARD_REPO || join(here, '../../id-cards');
const read = p => readFileSync(p, 'utf8');

const db = new PGlite();
let passed = 0, failed = 0;
function ok(cond, name) { if (cond) { passed++; console.log('  pass  ' + name); } else { failed++; console.log('  FAIL  ' + name); } }
async function rows(sql, params = []) { return (await db.query(sql, params)).rows; }
async function one(sql, params = []) { return (await rows(sql, params))[0]; }
async function fails(fn, pattern, name) {
  try { await fn(); ok(false, name + ' (no error)'); }
  catch (e) { ok(!pattern || pattern.test(e.message), name + (pattern && !pattern.test(e.message) ? ` (got: ${e.message})` : '')); }
}
// Run as a signed-in user
async function as(email, fn) {
  await db.exec(`set role authenticated`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })]);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false)`); }
}

console.log('Setting up');
await db.exec(read(join(here, 'supabase-stub.sql')));
await db.exec(`insert into auth.users (email) values ('owner@ama.test')`);
await db.exec(read(join(CARD, 'supabase/setup.sql')));
await db.exec(read(join(CARD, 'supabase/roles.sql')));
await db.exec(read(join(CARD, 'supabase/printed.sql')));
const PREP = read(join(here, '../supabase/prep-setup.sql'));
await db.exec(PREP);
await db.exec(PREP); // safe to run twice
ok(true, 'prep-setup.sql runs twice without errors');
for (const f of ['prep-update-01.sql', 'prep-update-02.sql', 'prep-update-03.sql', 'prep-update-04.sql', 'prep-update-05.sql', 'prep-update-06.sql', 'prep-update-07.sql', 'prep-update-08.sql', 'prep-update-09.sql', 'prep-update-10.sql', 'prep-update-11.sql', 'prep-update-12.sql']) {
  const sql = read(join(here, '../supabase', f));
  await db.exec(sql); await db.exec(sql);
  ok(true, `${f} runs twice without errors`);
}
ok((await one(`select default_payment_plan from prep_settings`)).default_payment_plan === 'per_session', 'per session is the normal fee option');
// The general payment tests below use whole-cycle fees; per-session payments are tested in their own section
await db.exec(`update prep_settings set default_payment_plan = 'upfront'`);

const ADMIN = 'owner@ama.test';
ok((await one(`select role from prep_roles where email = $1`, [ADMIN]))?.role === 'admin', 'card software admin becomes prep admin');
await db.exec(`insert into prep_roles (email, role) values
  ('inst@ama.test','instructor'), ('att@ama.test','attendance'), ('pay@ama.test','payments'),
  ('grade@ama.test','grading'), ('cert@ama.test','certificates'), ('card@ama.test','idcards'), ('view@ama.test','viewer')`);

// ---------------------------------------------------------------------------
console.log('\nStudents');
await as(ADMIN, () => db.exec(`
  insert into prep_students (full_name, club, belt_rank, dob) values
    ('Alex Smith','Marrickville','1st Poom','2010-03-01'),
    ('Jordan Lee','Marrickville','1st Dan','2008-07-12'),
    ('Taylor Brown','Newtown','1st Poom','2011-01-20');
  insert into prep_students (full_name, is_test) values ('Test Student', true);
  insert into prep_students (full_name, is_active) values ('Former Student', false);`));
const ids = (await rows(`select student_id, full_name from prep_students order by student_id`));
const S = Object.fromEntries(ids.map(r => [r.full_name.split(' ')[0], r.student_id]));
ok(S.Alex === 'BB0001' && S.Jordan === 'BB0002', 'Student IDs are generated (BB0001, BB0002, ...)');
await as(ADMIN, () => db.exec(`update prep_students set club = 'Newtown' where student_id = 'BB0001'`));
ok((await one(`select club from prep_students where student_id = 'BB0001'`)).club === 'Newtown', 'student details can be edited');
await fails(() => as(ADMIN, () => db.exec(`update prep_students set student_id = 'X1' where student_id = 'BB0001'`)), /cannot be changed/, 'Student ID cannot be changed');
await fails(() => as(ADMIN, () => db.exec(`insert into prep_students (student_id, full_name) values ('BB0001', 'Someone')`)), /duplicate key/, 'duplicate Student ID is rejected');
await as(ADMIN, () => db.exec(`insert into prep_students (full_name) values ('alex  SMITH')`));
ok((await rows(`select * from prep_possible_duplicates`)).some(d => d.student_a === 'BB0001'), 'possible duplicate names are flagged');
await as(ADMIN, () => db.exec(`update prep_students set is_active = false where full_name = 'alex  SMITH'`));
await as('view@ama.test', () => db.exec(`update prep_students set full_name = 'Hacked' where student_id = 'BB0002'`));
ok((await one(`select full_name from prep_students where student_id = 'BB0002'`)).full_name === 'Jordan Lee', 'viewer cannot edit students');

// ---------------------------------------------------------------------------
console.log('\nNew preparation cycle');
const c1 = (await as(ADMIN, () => one(`select prep_start_new_cycle('Term 3 2026', '2026-07-20', '2026-08-10',
  array['2026-07-20','2026-07-27','2026-08-03','2026-08-10']::date[], 120, '2026-07-27') as id`))).id;
const cnt = async (t, where = '', p = []) => Number((await one(`select count(*) n from ${t} ${where}`, p)).n);
ok(await cnt('prep_sessions', 'where cycle_id = $1', [c1]) === 4, 'four sessions created');
ok(await cnt('prep_enrolments', 'where cycle_id = $1', [c1]) === 3, 'active, non-test students enrolled (test and inactive left out)');
ok(await cnt('prep_attendance', `where cycle_id = $1 and status = 'not_recorded'`, [c1]) === 12, 'attendance starts as "not recorded" (12 rows)');
ok(await cnt('prep_readiness', `where cycle_id = $1 and status = 'not_assessed'`, [c1]) === 3, 'readiness starts as "not assessed"');
ok(await cnt('prep_payments', `where cycle_id = $1 and amount_due = 120`, [c1]) === 3, 'fee records created at the cycle fee');
await fails(() => as(ADMIN, () => db.query(`select prep_start_new_cycle('term 3 2026', null, null, null, 120)`)), /already exists/, 'starting the same cycle twice is blocked');
ok(await cnt('prep_cycles') === 1, 'no duplicate cycle was created');
await fails(() => as('inst@ama.test', () => db.query(`select prep_start_new_cycle('X', null, null, null, 1)`)), /Only an admin/, 'only admins can start a cycle');
await as(ADMIN, () => db.query(`select prep_activate_cycle($1)`, [c1]));
ok((await one(`select status from prep_cycles where cycle_id = $1`, [c1])).status === 'active', 'cycle activated');

// ---------------------------------------------------------------------------
console.log('\nAttendance');
const sess = (await rows(`select session_id from prep_sessions where cycle_id = $1 order by session_number`, [c1])).map(r => r.session_id);
await as('att@ama.test', () => db.exec(`update prep_attendance set status = 'present' where session_id = '${sess[0]}' and student_id = 'BB0001'`));
const a1 = await one(`select status, recorded_by, recorded_at from prep_attendance where session_id = $1 and student_id = 'BB0001'`, [sess[0]]);
ok(a1.status === 'present' && a1.recorded_by === 'att@ama.test' && a1.recorded_at, 'individual attendance records who and when');
const n = (await as('att@ama.test', () => one(`select prep_mark_attendance($1, array['BB0002','BB0003'], 'present') n`, [sess[1]]))).n;
ok(n === 2, 'bulk mark present updates the selected students');
ok(await cnt('prep_attendance', `where session_id = $1 and student_id = 'BB0001' and status = 'not_recorded'`, [sess[1]]) === 1, 'bulk marking does not mark anyone else absent');
await as('att@ama.test', () => db.query(`select prep_mark_attendance($1, array['BB0002'], 'absent')`, [sess[1]]));
ok((await one(`select status from prep_attendance where session_id = $1 and student_id = 'BB0002'`, [sess[1]])).status === 'absent', 'attendance can be corrected');
await fails(() => as(ADMIN, () => db.exec(`insert into prep_attendance (student_id, cycle_id, session_id) values ('BB0001', '${c1}', '${sess[0]}')`)), /row-level security/, 'attendance rows cannot be added by hand (created automatically)');
await fails(() => db.exec(`insert into prep_attendance (student_id, cycle_id, session_id) values ('BB0001', '${c1}', '${sess[0]}')`), /duplicate key/, 'even bypassing the app, a second record for the same session is blocked');
await as('view@ama.test', () => db.exec(`update prep_attendance set status = 'absent' where student_id = 'BB0001'`));
ok(await cnt('prep_attendance', `where student_id = 'BB0001' and status = 'absent'`) === 0, 'viewer cannot change attendance');

// Alex: P, -, -, - ; Jordan: -, A, -, - ; Taylor: -, P, -, -
let sum = await one(`select * from prep_attendance_summary where cycle_id = $1 and student_id = 'BB0001'`, [c1]);
ok(sum.attended === 1 && sum.unrecorded === 3 && Number(sum.attendance_pct) === 100, 'percentage uses recorded sessions only (1 of 1 = 100%)');
await as('att@ama.test', () => db.exec(`
  select prep_mark_attendance('${sess[1]}', array['BB0001'], 'absent');
  select prep_mark_attendance('${sess[2]}', array['BB0001'], 'excused');`));
sum = await one(`select * from prep_attendance_summary where cycle_id = $1 and student_id = 'BB0001'`, [c1]);
ok(Number(sum.attendance_pct) === 50 && sum.excused === 1 && sum.unrecorded === 1, 'excused and unrecorded are left out of the percentage (1 of 2 = 50%)');
await as('att@ama.test', () => db.exec(`select prep_mark_attendance(session_id, array['BB0003'], 'present') from prep_sessions where cycle_id = '${c1}'`));
ok((await one(`select attendance_eligible from prep_attendance_summary where student_id = 'BB0003' and cycle_id = $1`, [c1])).attendance_eligible === true, 'four sessions present meets the attendance requirement');

// ---------------------------------------------------------------------------
console.log('\nReadiness');
ok((await one(`select status from prep_readiness where student_id = 'BB0003' and cycle_id = $1`, [c1])).status === 'not_assessed', 'attending all four sessions does not mark a student ready');
await as('inst@ama.test', () => db.exec(`update prep_readiness set status = 'not_ready', reason = 'technique', notes = 'Poomsae timing', next_action = 'Extra class' where student_id = 'BB0001' and cycle_id = '${c1}'`));
const r1 = await one(`select * from prep_readiness where student_id = 'BB0001' and cycle_id = $1`, [c1]);
ok(r1.status === 'not_ready' && r1.reviewed_by === 'inst@ama.test' && r1.reviewed_at, 'instructor flags not ready with reason; reviewer recorded');
await as('inst@ama.test', () => db.exec(`update prep_readiness set status = 'ready', reason = null where student_id = 'BB0001' and cycle_id = '${c1}'`));
ok(await cnt('prep_readiness_history', `where student_id = 'BB0001'`) === 3, 'readiness history keeps every change');
await as('att@ama.test', () => db.exec(`update prep_readiness set status = 'ready' where student_id = 'BB0002'`));
ok((await one(`select status from prep_readiness where student_id = 'BB0002'`)).status === 'not_assessed', 'attendance recorder cannot change readiness');

// ---------------------------------------------------------------------------
console.log('\nPayments');
const pay = async sid => (await one(`select payment_id from prep_payments where student_id = $1 and cycle_id = $2`, [sid, c1])).payment_id;
const P1 = await pay('BB0001'), P2 = await pay('BB0002'), P3 = await pay('BB0003');
await as('pay@ama.test', () => db.exec(`
  insert into prep_payment_transactions (payment_id, type, amount, method, reference) values ('${P1}', 'payment', 120, 'cash', 'R-100');
  insert into prep_payment_transactions (payment_id, type, amount, method, reference) values ('${P2}', 'payment', 50, 'bank_transfer', 'R-101');
  insert into prep_payment_transactions (payment_id, type, amount, method, reference) values ('${P2}', 'payment', 20, 'cash', 'R-102');`));
const ps = async id => one(`select * from prep_payment_summary where payment_id = $1`, [id]);
ok((await ps(P1)).status === 'paid' && Number((await ps(P1)).balance) === 0, 'full payment shows Paid, balance 0');
const p2 = await ps(P2);
ok(Number(p2.amount_paid) === 70 && Number(p2.balance) === 50 && p2.transactions === 2, 'instalments recorded separately and totalled (70 paid, 50 owing)');
ok(['partially_paid','overdue'].includes(p2.status), 'part payment shows Partially paid (or Overdue after the due date)');
await fails(() => as('pay@ama.test', () => db.exec(`insert into prep_payment_transactions (payment_id, type, amount, reference) values ('${P2}', 'payment', 20, ' r-102 ')`)), /duplicate key/, 'same receipt number twice is blocked');
await as('pay@ama.test', () => db.exec(`update prep_payment_transactions set amount = 1 where payment_id = '${P2}'`));
await as(ADMIN, () => db.exec(`delete from prep_payment_transactions where payment_id = '${P2}'`));
ok(Number((await ps(P2)).amount_paid) === 70 && (await ps(P2)).transactions === 2, 'transactions cannot be edited or deleted, even by an admin');
await fails(() => db.exec(`update prep_payment_transactions set amount = 1 where payment_id = '${P2}'`), /cannot be changed/, 'even bypassing the app, transactions are locked');
await fails(() => as('pay@ama.test', () => db.exec(`insert into prep_payment_transactions (payment_id, type, amount) values ('${P2}', 'correction', -20)`)), /check constraint/, 'a correction needs a note');
await as('pay@ama.test', () => db.exec(`insert into prep_payment_transactions (payment_id, type, amount, notes) values ('${P2}', 'correction', -20, 'R-102 entered in error')`));
ok(Number((await ps(P2)).amount_paid) === 50, 'correction adjusts the total without changing earlier transactions');
await fails(() => as('pay@ama.test', () => db.exec(`update prep_payments set status_override = 'waived' where payment_id = '${P3}'`)), /check constraint/, 'a waiver needs a reason');
await as('pay@ama.test', () => db.exec(`update prep_payments set status_override = 'waived', override_reason = 'Committee approved' where payment_id = '${P3}'`));
ok((await ps(P3)).status === 'waived', 'approved fee waiver');
ok((await one(`select status from prep_attendance_summary s join prep_readiness r using (student_id, cycle_id) where student_id = 'BB0003'`)).status === 'not_assessed', 'payment does not change readiness');
for (const who of ['view@ama.test', 'inst@ama.test', 'att@ama.test', 'grade@ama.test']) {
  ok((await as(who, () => rows(`select * from prep_payment_transactions`))).length === 0
     && (await as(who, () => rows(`select * from prep_payment_summary`))).length === 0, `${who.split('@')[0]} cannot see payment information`);
}
const ov = await as('view@ama.test', () => one(`select * from prep_overview where student_id = 'BB0002'`));
ok(ov && ov.payment_status === null && ov.balance === null && ov.readiness === 'not_assessed', 'overview hides payment columns from non-payment users');
ok((await as('pay@ama.test', () => one(`select balance from prep_overview where student_id = 'BB0002'`))).balance !== null, 'payments role sees balances in the overview');
await as(ADMIN, () => db.exec(`update prep_cycles set session_fee = 130 where cycle_id = '${c1}'`));
ok(Number((await ps(P2)).amount_due) === 130, 'changing the cycle fee updates fees still at the old amount');

// ---------------------------------------------------------------------------
console.log('\nSecond cycle keeps history');
const before = await rows(`select attendance_id, status from prep_attendance where cycle_id = $1 order by attendance_id`, [c1]);
const c2 = (await as(ADMIN, () => one(`select prep_start_new_cycle('Term 4 2026', '2026-10-12', '2026-11-02', null, 120) id`))).id;
await fails(() => as(ADMIN, () => db.query(`select prep_activate_cycle($1)`, [c2])), /already active/, 'only one active cycle unless allowed');
await as(ADMIN, () => db.query(`select prep_activate_cycle($1, true)`, [c2]));
ok((await one(`select status from prep_cycles where cycle_id = $1`, [c1])).status === 'completed', 'previous cycle completed on confirmation');
const after = await rows(`select attendance_id, status from prep_attendance where cycle_id = $1 order by attendance_id`, [c1]);
ok(JSON.stringify(before) === JSON.stringify(after), 'previous cycle attendance unchanged');
ok((await one(`select status from prep_readiness where student_id = 'BB0001' and cycle_id = $1`, [c2])).status === 'not_assessed', 'readiness starts fresh in the new cycle');
const newPay = await one(`select * from prep_payment_summary where student_id = 'BB0001' and cycle_id = $1`, [c2]);
ok(newPay.status !== 'paid' && Number(newPay.amount_paid) === 0, 'paid last cycle does not count as paid for the new cycle');
ok((await one(`select status from prep_readiness where student_id = 'BB0001' and cycle_id = $1`, [c1])).status === 'ready', 'previous readiness kept');

// ---------------------------------------------------------------------------
console.log('\nGrading');
await fails(() => as('grade@ama.test', () => db.exec(`insert into prep_grading (student_id, cycle_id, grading_event, target_rank, eligibility_decision)
  values ('BB0002', '${c1}', 'Dan grading Aug 2026', '2nd Dan', 'eligible')`)), /Give a reason/, 'eligible without meeting attendance or readiness needs a reason');
await as('grade@ama.test', () => db.exec(`insert into prep_grading (student_id, cycle_id, grading_event, target_rank, eligibility_decision, decision_reason)
  values ('BB0002', '${c1}', 'Dan grading Aug 2026', '2nd Dan', 'eligible', 'Head instructor approved')`));
const g2 = await one(`select * from prep_grading where student_id = 'BB0002'`);
ok(g2.attendance_eligible === false && g2.readiness_at_review === 'not_assessed' && g2.decided_by === 'grade@ama.test', 'override recorded with the facts at the time');
await as('grade@ama.test', () => db.exec(`insert into prep_grading (student_id, cycle_id, grading_event, target_rank) values ('BB0001', '${c1}', 'Dan grading Aug 2026', '1st Dan')`));
ok((await one(`select eligibility_decision, status from prep_grading where student_id = 'BB0001'`)).eligibility_decision === 'pending', 'attendance and payment never make a student eligible automatically');
await as('grade@ama.test', () => db.exec(`update prep_grading set result = 'passed' where student_id = 'BB0001'`));
ok((await one(`select status from prep_grading where student_id = 'BB0001'`)).status === 'passed', 'grading result recorded');
await fails(() => as('inst@ama.test', () => db.exec(`update prep_grading set result = 'passed' where student_id = 'BB0002'`).then(async () => {
  if ((await one(`select result from prep_grading where student_id = 'BB0002'`)).result) throw new Error('changed');
  throw new Error('blocked');
})), /blocked/, 'instructor cannot record grading results');

// ---------------------------------------------------------------------------
console.log('\nCertificates');
const gid = sid => one(`select grading_id from prep_grading where student_id = $1`, [sid]).then(r => r.grading_id);
await fails(() => as('cert@ama.test', async () => db.exec(`insert into prep_certificates (student_id, grading_id, certificate_name, status)
  values ('BB0002', '${await gid('BB0002')}', 'Jordan Lee', 'issued')`)), /passed grading/, 'certificate cannot be issued without a pass');
await as('cert@ama.test', async () => db.exec(`insert into prep_certificates (student_id, grading_id, certificate_name, awarded_rank, certificate_number, status)
  values ('BB0001', '${await gid('BB0001')}', 'Alexander Smith', '1st Dan', 'AMA-2026-001', 'issued')`));
const ce = await one(`select * from prep_certificates where student_id = 'BB0001'`);
ok(ce.status === 'issued' && ce.issue_date, 'certificate issued for a pass, issue date filled in');
ok((await as('view@ama.test', () => one(`select certificate_status, grading_result from prep_overview where student_id = 'BB0001' and cycle_id = $1`, [c1]))).certificate_status === 'issued', 'certificate status shows in the overview');

// ---------------------------------------------------------------------------
console.log('\nID cards and the card software');
await db.exec(`insert into people (name, dob, dan, photo_path) values ('Jordan Lee', '2008-07-12', '1st Dan', 'photos/j.jpg')`); // already in card software
await fails(() => as('view@ama.test', () => db.query(`select prep_send_to_card_software('BB0001', '1st Dan')`)), /permission/, 'viewer cannot send to the card software');
const pid = (await as('card@ama.test', () => one(`select prep_send_to_card_software('BB0001', '1st Dan') id`))).id;
const person = await one(`select * from people where id = $1`, [pid]);
ok(person.student_id === 'BB0001' && person.dan === '1st Dan', 'passed student added to the card software with their Student ID');
const cardStatus = sid => as('card@ama.test', () => one(`select status from prep_id_card_status where student_id = $1`, [sid])).then(r => r?.status);
ok(await cardStatus('BB0001') === 'details_incomplete', 'no photo yet: Details incomplete');
await db.exec(`update people set photo_path = 'photos/a.jpg' where id = '${pid}'`);
ok(await cardStatus('BB0001') === 'ready_for_printing', 'photo added: Ready for printing');
const job1 = (await one(`insert into print_jobs (people_ids, people_names, card_count, pdf_path) values (array['${pid}']::uuid[], array['Alex Smith'], 1, 'jobs/1.pdf') returning id`)).id;
ok(await cardStatus('BB0001') === 'sent_for_printing', 'in the print queue: Sent for printing');
await db.exec(`update print_jobs set status = 'printed', printed_at = now() where id = '${job1}'`);
ok(await cardStatus('BB0001') === 'printed', 'card software prints it: Printed');
await as('card@ama.test', () => db.exec(`update prep_id_cards set ready_to_collect_at = now() where student_id = 'BB0001'`));
ok(await cardStatus('BB0001') === 'awaiting_collection', 'Awaiting collection');
await as('card@ama.test', () => db.exec(`update prep_id_cards set collected_at = now() where student_id = 'BB0001'`));
ok(await cardStatus('BB0001') === 'collected', 'Collected');
await db.exec(`update people set dan = '2nd Dan' where id = '${pid}'`);
ok(await cardStatus('BB0001') === 'reprint_required', 'card details change after printing: Reprint required');
const job2 = (await one(`insert into print_jobs (people_ids, card_count, pdf_path) values (array['${pid}']::uuid[], 1, 'jobs/2.pdf') returning id`)).id;
await db.exec(`update print_jobs set status = 'printed', printed_at = now() + interval '1 second' where id = '${job2}'`);
await as('card@ama.test', () => db.exec(`insert into prep_print_event_notes (print_job_id, student_id, reprint_reason) values ('${job2}', 'BB0001', 'Dan updated')`));
const hist = await as('card@ama.test', () => rows(`select * from prep_card_print_history() where student_id = 'BB0001' and status = 'printed' order by created_at`));
ok(hist.length === 2 && hist[0].print_number === 1 && hist[1].print_number === 2, 'reprint is a new print event; the original is kept');
ok(await cardStatus('BB0001') === 'printed', 'after the reprint, earlier collection does not count');

const existing = (await one(`select id from people where name = 'Jordan Lee'`)).id;
await as('card@ama.test', () => db.query(`select prep_send_to_card_software('BB0002', '2nd Dan', $1)`, [existing]));
const jl = await one(`select * from people where id = $1`, [existing]);
ok(jl.student_id === 'BB0002' && jl.dan === '1st Dan' && Number((await one(`select count(*) n from people where name = 'Jordan Lee'`)).n) === 1,
   'existing card person linked without duplicating or overwriting their details');
await fails(() => db.exec(`update people set student_id = 'BB0002' where id = '${pid}'`), /duplicate key/, 'two card records cannot share a Student ID');
ok((await as('nobody@ama.test', () => rows(`select * from prep_card_people()`))).length === 0, 'people without a prep role see no card data');

// Card software still works as before
await as(ADMIN, () => db.exec(`insert into people (name) values ('Pasted Member')`));
ok(await cnt('people', `where name = 'Pasted Member' and student_id is null`) === 1, 'card software can still add people without a Student ID');

// ---------------------------------------------------------------------------
console.log('\nAccess and audit');
for (const t of ['prep_students', 'prep_attendance', 'prep_overview', 'prep_cycles']) {
  ok((await as('nobody@ama.test', () => rows(`select * from ${t}`))).length === 0, `no prep role: nothing visible in ${t}`);
}
await fails(() => as('inst@ama.test', () => db.exec(`insert into prep_roles (email, role) values ('inst@ama.test', 'admin')`)), /row-level security/, 'non-admins cannot give themselves roles');
await fails(() => as(ADMIN, () => db.exec(`delete from prep_roles where role = 'admin'`)), /at least one admin/, 'the last admin cannot be removed');
ok(await cnt('prep_audit_log', `where table_name = 'prep_attendance' and changed_by = 'att@ama.test'`) > 0, 'attendance changes are in the audit log');
ok((await as('inst@ama.test', () => rows(`select * from prep_audit_log`))).length === 0, 'only admins can read the audit log');
await fails(() => as(ADMIN, () => db.exec(`delete from prep_enrolments where student_id = 'BB0002' and cycle_id = '${c1}'`)), /foreign key/, 'an enrolment with payments cannot be removed');
await as(ADMIN, () => db.exec(`delete from prep_enrolments where student_id = 'BB0003' and cycle_id = '${c2}'`));
ok(await cnt('prep_attendance', `where student_id = 'BB0003' and cycle_id = $1`, [c2]) === 0, 'a mistaken enrolment with no payments can be removed');

// ---------------------------------------------------------------------------
console.log('\nDan numbers (separate for each rank)');
await as(ADMIN, () => db.exec(`
  insert into prep_students (student_id, full_name, belt_rank) values
    ('D1','Zara Ng','Cho Dan Bo'), ('D2','Ben Ali','1st Dan Level 1'), ('D3','Amy Wu','1st Dan Black Belt'),
    ('D4','Cal Ray','4th Dan Level 4'), ('D5','Dee Fox','Probationary Black Belt'), ('D6','Eve Lim','Cho Dan Bo');`));
const dn = async () => Object.fromEntries((await rows(`select student_id, dan_number, target_rank from prep_dan_numbers`)).map(r => [r.student_id, r]));
const counter = async t => (await one(`select next_number from prep_dan_counters where target_rank = $1`, [t]))?.next_number;
const cA = (await as(ADMIN, () => one(`select prep_start_new_cycle('Dan test A', null, null, null, 0, null, array['D1','D2','D3','D4','D6']) id`))).id;
ok(Object.keys(await dn()).length === 0, 'no numbers handed out before any next number is set');
ok((await as(ADMIN, () => one(`select prep_assign_missing_dan_numbers($1) n`, [cA]))).n === 0, 'assigning with no next numbers set gives out nothing');
await as(ADMIN, () => db.exec(`insert into prep_dan_counters (target_rank, next_number) values ('Probationary Black Belt', 101), ('2nd Dan', 201)`));
ok((await as(ADMIN, () => one(`select prep_assign_missing_dan_numbers($1) n`, [cA]))).n === 3, 'numbers assigned for the ranks that have a next number (3 students)');
let d = await dn();
ok(d.D6.dan_number === 101 && d.D1.dan_number === 102, 'Probationary numbers go up by one in name order (Eve 101, Zara 102)');
ok(d.D2.dan_number === 201 && d.D2.target_rank === '2nd Dan', '2nd Dan has its own sequence (Ben 201)');
ok(!d.D4, 'no number for 5th Dan until its next number is set');
ok(!d.D3, '1st Dan Black Belt (going for a level, not a Dan) gets no number');
ok(await counter('Probationary Black Belt') === 103 && await counter('2nd Dan') === 202, 'each rank\'s next number moves on separately');
await as(ADMIN, () => db.exec(`insert into prep_dan_counters (target_rank, next_number) values ('5th Dan', 501)`));
await as(ADMIN, () => db.query(`select prep_assign_missing_dan_numbers($1)`, [cA]));
ok((await dn()).D4.dan_number === 501, 'setting the 5th Dan next number lets the missing one be filled in');
await as(ADMIN, () => db.exec(`insert into prep_dan_counters (target_rank, next_number) values ('1st Dan Black Belt', 101)`));
const cB = (await as(ADMIN, () => one(`select prep_start_new_cycle('Dan test B', null, null, null, 0, null, array['D2','D5']) id`))).id;
d = await dn();
ok(d.D5.dan_number === 101 && d.D5.target_rank === '1st Dan Black Belt', 'joining a cycle hands out the next number for their rank; 101 can be used once per rank');
ok(d.D2.dan_number === 201, 'a student repeating the same grading keeps their number');
await as(ADMIN, () => db.exec(`update prep_dan_counters set next_number = 101 where target_rank = 'Probationary Black Belt'; update prep_students set belt_rank = 'Cho Dan Bo' where student_id = 'D3'`));
await as(ADMIN, () => db.query(`select prep_assign_missing_dan_numbers($1)`, [cA]));
ok((await dn()).D3.dan_number === 103, 'numbers already used for that rank are skipped, never reused');
await fails(() => as(ADMIN, () => db.exec(`update prep_dan_numbers set dan_number = 101 where student_id = 'D3'`)), /duplicate key/, 'two students cannot share a number for the same rank');
await as('view@ama.test', () => db.exec(`update prep_dan_numbers set dan_number = 9999 where student_id = 'D3'; update prep_dan_counters set next_number = 1`));
ok((await dn()).D3.dan_number === 103 && await counter('2nd Dan') === 202, 'non-admins cannot change Dan numbers or next numbers');
ok((await as('view@ama.test', () => rows(`select * from prep_dan_numbers`))).length === 6, 'everyone with a prep role can see Dan numbers');
await fails(() => as('inst@ama.test', () => db.query(`select prep_assign_missing_dan_numbers($1)`, [cA])), /Only an admin/, 'only admins can run the assignment');

// ---------------------------------------------------------------------------
console.log('\nSign-off (final session)');
await as(ADMIN, () => db.exec(`update prep_settings set sessions_required = 3, excused_counts_as_attended = true`));
const cS = (await as(ADMIN, () => one(`select prep_start_new_cycle('Sign-off test', null, null, null, 0, null, array['D1','D2','D3']) id`))).id;
const ss = (await rows(`select session_id from prep_sessions where cycle_id = $1 order by session_number`, [cS])).map(r => r.session_id);
await as(ADMIN, () => db.exec(`
  select prep_mark_attendance('${ss[0]}', array['D1','D2','D3'], 'present');
  select prep_mark_attendance('${ss[1]}', array['D1','D2','D3'], 'present');
  select prep_mark_attendance('${ss[2]}', array['D1','D2','D3'], 'present');
  select prep_mark_attendance('${ss[3]}', array['D1'], 'present');
  select prep_mark_attendance('${ss[3]}', array['D2'], 'absent');
  select prep_mark_attendance('${ss[3]}', array['D3'], 'excused');`));
const so = Object.fromEntries((await rows(`select * from prep_attendance_summary where cycle_id = $1`, [cS])).map(r => [r.student_id, r]));
ok(so.D1.attendance_eligible === true && so.D1.signoff_present === true, 'present at the sign-off and enough sessions: meets the requirement');
ok(so.D2.attendance_eligible === false && so.D2.attended === 3 && so.D2.signoff_status === 'absent', 'enough sessions but absent from the sign-off: does not meet the requirement');
ok(so.D3.attendance_eligible === false && so.D3.signoff_status === 'excused', 'excused from the sign-off does not count, even when excused counts elsewhere');
await as(ADMIN, () => db.exec(`update prep_settings set sessions_required = 4, excused_counts_as_attended = false;
  update prep_cycles set grading_date = '2026-11-07' where cycle_id = '${cS}'`));
ok((await one(`select grading_date::text g from prep_cycles where cycle_id = $1`, [cS])).g === '2026-11-07', 'cycle has a grading date');

// ---------------------------------------------------------------------------
console.log('\nFees: upfront or per session');
await as(ADMIN, () => db.exec(`insert into prep_students (student_id, full_name) values ('F1','Fee Upfront'), ('F2','Fee Session'), ('F3','Fee Oneoff')`));
const cF = (await as(ADMIN, () => one(`select prep_start_new_cycle('Fee test', null, null, null, null, null, array['F1','F2','F3']) id`))).id;
ok((await one(`select upfront_fee::text u, per_session_fee::text p from prep_cycles where cycle_id = $1`, [cF])).u === '200.00', 'new cycle takes $200 upfront and $60 per session from Settings');
const fee = async id => one(`select * from prep_payment_summary where student_id = $1 and cycle_id = $2`, [id, cF]);
ok(Number((await fee('F1')).amount_due) === 200 && (await fee('F1')).payment_plan === 'upfront', 'students start on the upfront option ($200)');
await as('pay@ama.test', () => db.exec(`update prep_payments set payment_plan = 'per_session' where student_id = 'F2' and cycle_id = '${cF}'`));
let f2 = await fee('F2');
ok(Number(f2.amount_due) === 0 && f2.status === 'not_invoiced', 'per-session student who has attended nothing owes nothing yet');
const sF = (await rows(`select session_id from prep_sessions where cycle_id = $1 order by session_number`, [cF])).map(r => r.session_id);
await as('att@ama.test', () => db.exec(`select prep_mark_attendance('${sF[0]}', array['F1','F2'], 'present'); select prep_mark_attendance('${sF[1]}', array['F2'], 'present');
  select prep_mark_attendance('${sF[2]}', array['F2'], 'absent');`));
f2 = await fee('F2');
ok(Number(f2.amount_due) === 120 && f2.status === 'due', 'per-session student owes $60 for each session marked present (2 x $60)');
ok(Number((await fee('F1')).amount_due) === 200, 'upfront student still owes $200 whatever they attend');
await as('att@ama.test', () => db.exec(`select prep_mark_attendance('${sF[1]}', array['F2'], 'excused')`));
ok(Number((await fee('F2')).amount_due) === 60, 'correcting attendance corrects the fee');
await as(ADMIN, () => db.exec(`update prep_cycles set per_session_fee = 65, upfront_fee = 210 where cycle_id = '${cF}'`));
ok(Number((await fee('F2')).amount_due) === 65 && Number((await fee('F1')).amount_due) === 210, 'changing a cycle\'s fees updates everyone in it');
await fails(() => as('pay@ama.test', () => db.exec(`update prep_payments set fee_override = 100 where student_id = 'F3' and cycle_id = '${cF}'`)), /reason/, 'a one-off fee needs a reason');
await as('pay@ama.test', () => db.exec(`update prep_payments set fee_override = 100, notes = 'Sibling discount' where student_id = 'F3' and cycle_id = '${cF}'`));
await as(ADMIN, () => db.exec(`update prep_cycles set upfront_fee = 220 where cycle_id = '${cF}'`));
ok(Number((await fee('F3')).amount_due) === 100, 'one-off fee stays when the cycle fee changes');
await as('inst@ama.test', () => db.exec(`update prep_payments set payment_plan = 'per_session' where student_id = 'F1'`));
ok((await fee('F1')).payment_plan === 'upfront', 'only the payments role can change a student\'s option');

// ---------------------------------------------------------------------------
console.log('\nPaid at each session');
await db.exec(`update prep_settings set default_payment_plan = 'per_session'`);
await as(ADMIN, () => db.exec(`insert into prep_students (student_id, full_name) values ('S1','Sess One'), ('S2','Sess Two')`));
const cP = (await as(ADMIN, () => one(`select prep_start_new_cycle('Session pay test', null, null, null, null, null, array['S1','S2']) id`))).id;
const sP = (await rows(`select session_id from prep_sessions where cycle_id = $1 order by session_number`, [cP])).map(r => r.session_id);
const psum = async id => one(`select * from prep_payment_summary where student_id = $1 and cycle_id = $2`, [id, cP]);
ok((await psum('S1')).payment_plan === 'per_session', 'new students start on per session');
await as('att@ama.test', () => db.exec(`select prep_mark_attendance('${sP[0]}', array['S1','S2'], 'present')`));
await as('att@ama.test', () => db.query(`select prep_record_session_payment($1, 'S1', true)`, [sP[0]]));
let p1 = await psum('S1');
ok(Number(p1.amount_paid) === 60 && p1.status === 'paid', 'attendance recorder records $60 paid at the session; student is fully paid');
ok((await psum('S2')).status === 'due' && Number((await psum('S2')).balance) === 60, 'present but not paid: $60 owing');
await as('att@ama.test', () => db.query(`select prep_record_session_payment($1, 'S1', true)`, [sP[0]]));
ok(Number((await psum('S1')).amount_paid) === 60, 'tapping paid twice does not charge twice');
const fees = await as('att@ama.test', () => rows(`select * from prep_session_fees($1)`, [cP]));
ok(fees.length === 2 && fees.find(f => f.student_id === 'S1').paid_sessions.length === 1 && !('amount' in fees[0]), 'attendance screen sees who has paid for which session, with no amounts');
ok((await as('att@ama.test', () => rows(`select * from prep_payment_summary`))).length === 0, 'attendance recorder still cannot see balances');
await as('att@ama.test', () => db.query(`select prep_record_session_payment($1, 'S1', false)`, [sP[0]]));
p1 = await psum('S1');
ok(Number(p1.amount_paid) === 0 && Number(p1.transactions) === 2, 'undoing a session payment records a correction (history kept)');
await as('att@ama.test', () => db.query(`select prep_record_session_payment($1, 'S1', true)`, [sP[0]]));
ok(Number((await psum('S1')).amount_paid) === 60, 'can be marked paid again after an undo');
await fails(() => as('view@ama.test', () => db.query(`select prep_record_session_payment($1, 'S2', true)`, [sP[0]])), /permission/, 'viewers cannot record session payments');
ok((await as('view@ama.test', () => rows(`select * from prep_session_fees($1)`, [cP]))).length === 0, 'viewers see no payment information');
const tx = await one(`select method, notes, session_id, recorded_by from prep_payment_transactions where student_id = 'S1' and type = 'payment' order by created_at desc limit 1`);
ok(tx.method === 'cash' && tx.notes === 'Paid at session 1' && tx.session_id === sP[0] && tx.recorded_by === 'att@ama.test', 'session payment recorded as cash, linked to the session, with who took it');

// ---------------------------------------------------------------------------
console.log('\nGrading fees');
await as(ADMIN, () => db.exec(`insert into prep_students (student_id, full_name, belt_rank) values ('G1','Grade Probie','Cho Dan Bo'), ('G2','Grade Level','1st Dan Black Belt'), ('G3','Not Grading','Cho Dan Bo'), ('G4','No Belt', null)`));
const cG = (await as(ADMIN, () => one(`select prep_start_new_cycle('Grading fee test', null, null, null, null, null, array['G1','G2','G3','G4']) id`))).id;
await as(ADMIN, () => db.exec(`update prep_cycles set grading_date = '2026-12-20' where cycle_id = '${cG}';
  insert into prep_grading_fee_rates (target_rank, fee) values ('Probationary Black Belt', 150), ('1st Dan Level 1', 90)`));
const gfee = async id => one(`select * from prep_payment_summary where student_id = $1 and cycle_id = $2 and kind = 'grading'`, [id, cG]);
ok(!(await gfee('G1')), 'nobody is charged a grading fee until they are marked as grading');
await fails(() => as('att@ama.test', () => db.query(`select prep_set_grading($1, 'G1', true)`, [cG])), /permission/, 'only grading and admin roles choose who is grading');
await as('grade@ama.test', () => db.exec(`select prep_set_grading('${cG}', 'G1', true); select prep_set_grading('${cG}', 'G2', true);`));
let gf1 = await gfee('G1'), gf2 = await gfee('G2');
ok(Number(gf1.amount_due) === 150 && gf1.target_rank === 'Probationary Black Belt', 'Cho Dan Bo grading to Probationary is charged the Probationary fee ($150)');
ok(Number(gf2.amount_due) === 90 && gf2.target_rank === '1st Dan Level 1', 'level gradings have their own fee too (1st Dan Black Belt to 1st Dan Level 1, $90)');
ok((await one(`select due_date::text d from prep_payments where student_id = 'G1' and cycle_id = $1 and kind = 'grading'`, [cG])).d === '2026-11-29', 'due date is exactly 21 days before 20 Dec (29 Nov)');
ok(!(await gfee('G3')), 'students not grading are not charged');
const sessFee = await one(`select * from prep_payment_summary where student_id = 'G1' and cycle_id = $1 and kind = 'sessions'`, [cG]);
ok(sessFee && sessFee.payment_plan === 'per_session', 'session fees stay separate from the grading fee');
await as(ADMIN, () => db.exec(`update prep_cycles set grading_date = '2027-01-10' where cycle_id = '${cG}'`));
ok((await one(`select due_date::text d from prep_payments where student_id = 'G1' and cycle_id = $1 and kind = 'grading'`, [cG])).d === '2026-12-20', 'moving the grading date moves the fee due date');
await as(ADMIN, () => db.exec(`update prep_grading_fee_rates set fee = 160 where target_rank = 'Probationary Black Belt'`));
ok(Number((await gfee('G1')).amount_due) === 160, 'changing a grading fee updates students charged it');
await fails(() => as('grade@ama.test', () => db.query(`select prep_set_grading($1, 'G4', true)`, [cG])), /no next belt/, 'a student with no belt cannot be put forward until their belt is set');
await as('pay@ama.test', async () => { const pid = (await one(`select payment_id from prep_payments where student_id = 'G1' and cycle_id = $1 and kind = 'grading'`, [cG])).payment_id;
  await db.query(`insert into prep_payment_transactions (payment_id, type, amount, method) values ($1, 'payment', 160, 'bank_transfer')`, [pid]); });
ok((await gfee('G1')).status === 'paid', 'grading fee paid in full');
await fails(() => as('grade@ama.test', () => db.query(`select prep_set_grading($1, 'G1', false)`, [cG])), /payment recorded/, 'cannot take someone off grading once they have paid (refund first)');
await as('grade@ama.test', () => db.query(`select prep_set_grading($1, 'G2', false)`, [cG]));
ok(!(await gfee('G2')) && (await one(`select is_grading from prep_enrolments where student_id = 'G2' and cycle_id = $1`, [cG])).is_grading === false, 'taking an unpaid student off grading removes their grading fee');
const ovG = await as('view@ama.test', () => one(`select * from prep_overview where student_id = 'G1' and cycle_id = $1`, [cG]));
ok(ovG.is_grading === true && ovG.grading_to === 'Probationary Black Belt' && ovG.grading_fee_status === null, 'overview shows who is grading; fee hidden from non-payment users');
ok((await as(ADMIN, () => rows(`select * from prep_overview where cycle_id = $1`, [cG]))).length === 4, 'overview still has one row per student');
await as('view@ama.test', () => db.exec(`insert into prep_grading_fee_rates (target_rank, fee) values ('5th Dan', 1)`).catch(() => {}));
ok(!(await one(`select * from prep_grading_fee_rates where target_rank = '5th Dan'`)), 'only admins set grading fees');

// ---------------------------------------------------------------------------
console.log('\nDeleting students');
await as(ADMIN, () => db.exec(`insert into prep_students (student_id, full_name, belt_rank) values ('X1','Mistake One','Cho Dan Bo'), ('X2','Mistake Two', null)`));
await as(ADMIN, () => db.exec(`insert into prep_enrolments (cycle_id, student_id) values ('${cG}', 'X1')`));
ok(await cnt('prep_attendance', `where student_id = 'X1'`) === 4 && await cnt('prep_dan_numbers', `where student_id = 'X1'`) === 1, 'mistaken import was added to a cycle and given a Dan number');
await fails(() => as('grade@ama.test', () => db.query(`select * from prep_delete_students(array['X2'])`)), /Only an admin/, 'only admins can delete students');
const del = await as(ADMIN, () => rows(`select * from prep_delete_students(array['X1','X2','G1','D1'])`));
const dres = Object.fromEntries(del.map(r => [r.student_id, r]));
ok(dres.X1.deleted && dres.X2.deleted, 'students with no payments, grading or certificates are deleted');
ok(await cnt('prep_students', `where student_id in ('X1','X2')`) === 0 && await cnt('prep_attendance', `where student_id = 'X1'`) === 0 && await cnt('prep_dan_numbers', `where student_id = 'X1'`) === 0, 'their cycle places, attendance and Dan numbers go with them');
ok(!dres.G1.deleted && dres.G1.reason === 'Has payments recorded', 'a student with payments is kept, with the reason');
ok(await cnt('prep_students', `where student_id = 'G1'`) === 1, 'kept student is untouched');
ok(await cnt('prep_audit_log', `where table_name = 'prep_students' and action = 'delete' and record_key = 'X1'`) === 1, 'deletion is recorded in the audit log');

// ---------------------------------------------------------------------------
console.log('\nUpfront payment from the attendance screen');
await as(ADMIN, () => db.exec(`insert into prep_students (student_id, full_name) values ('U1','Up Front')`));
const cU = (await as(ADMIN, () => one(`select prep_start_new_cycle('Upfront test', null, null, null, null, null, array['U1']) id`))).id;
await as('pay@ama.test', () => db.exec(`update prep_payments set payment_plan = 'upfront' where student_id = 'U1' and cycle_id = '${cU}'`));
const sU = (await rows(`select session_id from prep_sessions where cycle_id = $1 order by session_number`, [cU])).map(r => r.session_id);
let fU = (await as('att@ama.test', () => rows(`select * from prep_session_fees($1)`, [cU])))[0];
ok(fU.payment_plan === 'upfront' && fU.prepaid === false, 'upfront student shows as not yet paid');
await as('att@ama.test', () => db.query(`select prep_record_session_payment($1, 'U1', true)`, [sU[0]]));
fU = (await as('att@ama.test', () => rows(`select * from prep_session_fees($1)`, [cU])))[0];
const sumU = await one(`select * from prep_payment_summary where student_id = 'U1' and cycle_id = $1 and kind = 'sessions'`, [cU]);
ok(fU.prepaid === true && Number(sumU.amount_paid) === 200 && sumU.status === 'paid', 'one tap records the full $200 upfront; all sessions count as paid');
ok(await cnt('prep_attendance', `where student_id = 'U1' and status <> 'not_recorded'`) === 0, 'paying upfront does not record any attendance');
await as('att@ama.test', () => db.query(`select prep_record_session_payment($1, 'U1', true)`, [sU[2]]));
ok(Number((await one(`select amount_paid from prep_payment_summary where student_id = 'U1' and cycle_id = $1 and kind = 'sessions'`, [cU])).amount_paid) === 200, 'tapping again at a later session does not charge twice');
await as('att@ama.test', () => db.query(`select prep_record_session_payment($1, 'U1', false)`, [sU[0]]));
fU = (await as('att@ama.test', () => rows(`select * from prep_session_fees($1)`, [cU])))[0];
ok(fU.prepaid === false && fU.paid_sessions.length === 0, 'undoing the upfront payment clears it from every session');

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
console.log('\nLinking ID cards by name');
await db.exec(`insert into people (name, dan, photo_path) values ('Kara  O''Neil', '1st Dan', 'photos/k.jpg'), ('Sam Twin', '2nd Dan', null), ('Unique Card', '3rd Dan', null)`);
await as(ADMIN, () => db.exec(`insert into prep_students (student_id, full_name, belt_rank) values ('L1','kara oneil','1st Dan Black Belt'), ('L2','Sam Twin','2nd Dan'), ('L3','Sam Twin','2nd Dan'), ('L4','New Person','Cho Dan Bo')`));
const card = async n => (await one(`select student_id from people where name = $1`, [n])).student_id;
ok(await card(`Kara  O'Neil`) === 'L1', 'existing card linked to the student when the student is added (ignores capitals, spaces, punctuation)');
ok(await card('Sam Twin') === null, 'not linked when two students share the name');
await db.exec(`insert into people (name, dan) values ('NEW person', null)`);
ok(await card('NEW person') === 'L4', 'a card added later in the card software links itself to the matching student');
ok(await card('Unique Card') === null, 'cards with no matching student stay unlinked');
await fails(() => as('view@ama.test', () => db.query(`select prep_set_card_link('L2', (select id from people where name = 'Sam Twin'))`)), /permission/, 'only ID card and admin roles can link cards by hand');
const twinId = (await one(`select id from people where name = 'Sam Twin'`)).id;
await as('card@ama.test', () => db.query(`select prep_set_card_link('L2', $1)`, [twinId]));
ok(await card('Sam Twin') === 'L2', 'card linked by hand');
ok((await as('card@ama.test', () => rows(`select * from prep_unlinked_cards()`))).some(r => r.name === 'Unique Card'), 'unlinked cards are listed for linking by hand');
const kid = (await one(`select id from people where student_id = 'L1'`)).id;
const kjob = (await one(`insert into print_jobs (people_ids, card_count, pdf_path) values (array['${kid}']::uuid[], 1, 'jobs/k.pdf') returning id`)).id;
let kc = (await as('view@ama.test', () => rows(`select * from prep_card_people() where student_id = 'L1'`)))[0];
ok(kc.queue_status === 'pending' && !kc.printed_at, 'prep app sees the card waiting in the print queue');
await db.exec(`update print_jobs set status = 'printed', printed_at = now() where id = '${kjob}'`);
kc = (await as('view@ama.test', () => rows(`select * from prep_card_people() where student_id = 'L1'`)))[0];
ok(kc.printed_at && kc.times_printed === 1, 'once printed in the card software, the prep app sees it as printed');

// ---------------------------------------------------------------------------
console.log('\nNo due date for session fees');
await as(ADMIN, () => db.exec(`insert into prep_students (student_id, full_name, belt_rank) values ('Q1','Due Session','Cho Dan Bo')`));
const cQ = (await as(ADMIN, () => one(`select prep_start_new_cycle('Due date test', null, null, null, null, '2020-01-01', array['Q1']) id`))).id;
const sQ = (await rows(`select session_id from prep_sessions where cycle_id = $1 order by session_number`, [cQ])).map(r => r.session_id);
await as('att@ama.test', () => db.exec(`select prep_mark_attendance('${sQ[0]}', array['Q1'], 'present')`));
let qs = await one(`select * from prep_payment_summary where student_id = 'Q1' and cycle_id = $1 and kind = 'sessions'`, [cQ]);
ok(qs.status === 'due' && qs.due_date === null, 'attended but not paid: "Payment due", never overdue, even with an old cycle due date');
await as('pay@ama.test', () => db.exec(`update prep_payments set payment_plan = 'upfront' where student_id = 'Q1' and cycle_id = '${cQ}'`));
ok((await one(`select status from prep_payment_summary where student_id = 'Q1' and cycle_id = $1 and kind = 'sessions'`, [cQ])).status === 'due', 'upfront fees are not overdue either');
await as(ADMIN, () => db.exec(`update prep_cycles set grading_date = '2020-02-01' where cycle_id = '${cQ}'; insert into prep_grading_fee_rates (target_rank, fee) values ('Probationary Black Belt', 150) on conflict (target_rank) do update set fee = 150`));
await as('grade@ama.test', () => db.query(`select prep_set_grading($1, 'Q1', true)`, [cQ]));
ok((await one(`select status from prep_payment_summary where student_id = 'Q1' and cycle_id = $1 and kind = 'grading'`, [cQ])).status === 'overdue', 'grading fees still become overdue after their due date');

console.log('\nBelts up to 9th Dan');
ok((await one(`select prep_dan_target('5th Dan Level 5') t`)).t === '6th Dan' && (await one(`select prep_dan_target('8th Dan') t`)).t === '9th Dan', '5th Dan Level 5 goes for 6th Dan, 8th Dan for 9th Dan');
ok((await one(`select prep_dan_target('5th Dan Level 2') t`)).t === null && (await one(`select prep_dan_target('9th Dan') t`)).t === null, '5th Dan levels below 5 and 9th Dan get no Dan number');
ok((await one(`select prep_next_belt('5th Dan') t`)).t === '5th Dan Level 1' && (await one(`select prep_next_belt('5th Dan Level 5') t`)).t === '6th Dan'
  && (await one(`select prep_next_belt('7th Dan') t`)).t === '8th Dan' && (await one(`select prep_next_belt('9th Dan') t`)).t === null, 'next belt runs 5th Dan, Levels 1 to 5, 6th, 7th, 8th, 9th Dan');
await as(ADMIN, () => db.exec(`insert into prep_dan_counters (target_rank, next_number) values ('6th Dan', 601), ('9th Dan', 901) on conflict (target_rank) do update set next_number = excluded.next_number`));
await as(ADMIN, () => db.exec(`insert into prep_students (student_id, full_name, belt_rank) values ('H1', 'Hana Six', '5th Dan Level 5'), ('H2', 'Hugo Nine', '8th Dan')`));
const cH = (await as(ADMIN, () => one(`select prep_start_new_cycle('High Dan test', null, null, null, 0, null, array['H1','H2']) id`))).id;
const hd = await rows(`select student_id, target_rank, dan_number from prep_dan_numbers where student_id in ('H1','H2') order by student_id`);
ok(hd[0]?.target_rank === '6th Dan' && hd[0].dan_number === 601 && hd[1]?.target_rank === '9th Dan' && hd[1].dan_number === 901, '6th and 9th Dan have their own Dan numbers');
await as(ADMIN, () => db.exec(`insert into prep_grading_fee_rates (target_rank, fee) values ('6th Dan', 300) on conflict (target_rank) do update set fee = excluded.fee`));
await as(ADMIN, () => db.query(`select prep_set_grading($1, 'H1', true)`, [cH]));
ok(Number((await one(`select amount_due from prep_payment_summary where student_id = 'H1' and cycle_id = $1 and kind = 'grading'`, [cH])).amount_due) === 300, 'grading fee for 6th Dan is charged');

console.log('\nDelete anyway');
await fails(() => as('grade@ama.test', () => db.query(`select * from prep_delete_students(array['G1'], true)`)), /Only an admin/, 'only admins can delete anyway');
const gTx = await cnt('prep_payment_transactions', `where student_id = 'G1'`);
await as(ADMIN, () => db.exec(`delete from prep_payment_transactions where student_id = 'G1'`)).catch(() => {});
await db.exec(`delete from prep_payment_transactions where student_id = 'G1'`).catch(() => {});
ok(await cnt('prep_payment_transactions', `where student_id = 'G1'`) === gTx, 'payment transactions still cannot be deleted directly');
ok(gTx > 0, 'G1 has payments recorded');
const fd = await as(ADMIN, () => rows(`select * from prep_delete_students(array['G1'], true)`));
ok(fd[0].deleted && fd[0].reason === null, 'a student with payments is deleted when told to delete anyway');
ok(await cnt('prep_students', `where student_id = 'G1'`) === 0 && await cnt('prep_payment_transactions', `where student_id = 'G1'`) === 0
  && await cnt('prep_payments', `where student_id = 'G1'`) === 0, 'their payments go with them');
ok(await cnt('prep_audit_log', `where table_name = 'prep_payment_transactions' and action = 'delete'`) === gTx, 'every removed payment is kept in the audit log');
await fails(() => db.exec(`delete from prep_payment_transactions where student_id = 'U1'`), /cannot be changed or deleted/, 'transactions are locked again afterwards');
const gr = await one(`select student_id from prep_grading limit 1`);
if (gr) {
  await as(ADMIN, () => db.query(`select * from prep_delete_students(array[$1], true)`, [gr.student_id]));
  ok(await cnt('prep_grading', `where student_id = '${gr.student_id}'`) === 0 && await cnt('prep_certificates', `where student_id = '${gr.student_id}'`) === 0
    && await cnt('prep_students', `where student_id = '${gr.student_id}'`) === 0, 'a student with grading records and certificates is deleted anyway');
}

console.log('\nClasses attended');
{
  const e = await one(`select cycle_id, student_id from prep_enrolments e join prep_cycles c using (cycle_id) order by c.created_at desc limit 1`);
  ok((await one(`select classes_attended from prep_enrolments where cycle_id = $1 and student_id = $2`, [e.cycle_id, e.student_id])).classes_attended === 0, 'everyone starts on 0 classes');
  await as('att@ama.test', () => db.query(`select prep_set_classes($1, $2, 12)`, [e.cycle_id, e.student_id]));
  const r = await one(`select classes_attended, classes_updated_by from prep_enrolments where cycle_id = $1 and student_id = $2`, [e.cycle_id, e.student_id]);
  ok(r.classes_attended === 12 && r.classes_updated_by === 'att@ama.test', 'attendance takers record classes attended (and who did it is kept)');
  await as('inst@ama.test', () => db.query(`select prep_set_classes($1, $2, 13)`, [e.cycle_id, e.student_id]));
  ok((await one(`select classes_attended from prep_enrolments where cycle_id = $1 and student_id = $2`, [e.cycle_id, e.student_id])).classes_attended === 13, 'so do instructors');
  await fails(() => as('view@ama.test', () => db.query(`select prep_set_classes($1, $2, 20)`, [e.cycle_id, e.student_id])), /cannot record classes/, 'viewers cannot');
  await fails(() => as('pay@ama.test', () => db.query(`select prep_set_classes($1, $2, 20)`, [e.cycle_id, e.student_id])), /cannot record classes/, 'nor the payments role');
  await fails(() => as(ADMIN, () => db.query(`select prep_set_classes($1, $2, -1)`, [e.cycle_id, e.student_id])), /between 0 and 999/, 'no negative counts');
  await fails(() => as(ADMIN, () => db.query(`select prep_set_classes($1, 'NOPE1', 3)`, [e.cycle_id])), /not in this cycle/, 'only students in the cycle');
  await as(ADMIN, () => db.query(`update prep_cycles set classes_required = 20 where cycle_id = $1`, [e.cycle_id]));
  ok((await one(`select classes_required from prep_cycles where cycle_id = $1`, [e.cycle_id])).classes_required === 20, 'a cycle can require a number of classes');
  await fails(() => as(ADMIN, () => db.query(`update prep_cycles set classes_required = 0 where cycle_id = $1`, [e.cycle_id])), /classes_required/, 'the requirement is at least 1');
  await as(ADMIN, () => db.exec(`insert into prep_class_requirements (target_rank, classes) values ('2nd Dan', 30)`));
  ok((await one(`select classes from prep_class_requirements where target_rank = '2nd Dan'`)).classes === 30, 'admins set the classes needed for each belt');
  await fails(() => as('inst@ama.test', () => db.exec(`insert into prep_class_requirements (target_rank, classes) values ('3rd Dan', 30)`)), /row-level security|permission/, 'others cannot');
  ok((await as('view@ama.test', () => rows(`select * from prep_class_requirements`))).length === 1, 'everyone can see them');
}

console.log('\nEssays');
{
  // A cycle with someone going for a Dan (Cho Dan Bo -> Probationary) and someone not (1st Poom)
  const cy = (await one(`select cycle_id from prep_cycles order by created_at desc limit 1`)).cycle_id;
  await as(ADMIN, () => db.exec(`insert into prep_students (student_id, full_name, belt_rank) values ('E1', 'Essay Writer', 'Probationary Black Belt'), ('E2', 'Poom Kid', '1st Poom'), ('E3', 'Cho Dan', 'Cho Dan Bo') on conflict do nothing`));
  await as(ADMIN, () => db.query(`insert into prep_enrolments (cycle_id, student_id) values ($1, 'E1'), ($1, 'E2'), ($1, 'E3') on conflict do nothing`, [cy]));
  await as(ADMIN, () => db.exec(`insert into prep_essay_questions (target_rank, question, min_words) values ('1st Dan Black Belt', 'What does black belt mean to you?', 100)`));
  await as(ADMIN, () => db.query(`update prep_cycles set essay_due = current_date + 14 where cycle_id = $1`, [cy]));
  await fails(() => as('view@ama.test', () => db.query(`select * from prep_essay_links($1)`, [cy])), /cannot see essays/, 'viewers cannot get essay links');
  const links = await as('inst@ama.test', () => rows(`select * from prep_essay_links($1)`, [cy]));
  const e1 = links.find(l => l.student_id === 'E1');
  ok(e1 && e1.target_rank === '1st Dan Black Belt' && /^[A-Za-z0-9_-]{12}$/.test(e1.token) && !links.some(l => l.student_id === 'E2' || l.student_id === 'E3'), 'instructors get a personal link for each student going for a Dan (not Probationary Black Belt or Poom)');
  const again = await as('inst@ama.test', () => rows(`select * from prep_essay_links($1, 'E1')`, [cy]));
  ok(again[0].token === e1.token, 'asking again gives the same link');
  ok((await as('view@ama.test', () => rows(`select * from prep_essays`))).length === 0, 'viewers cannot see essays');
  // The student's link (no login)
  await db.exec(`grant usage on schema storage to anon; grant select, insert on storage.objects to anon, authenticated; alter table storage.objects enable row level security`);   // as in Supabase
  const asAnon = async fn => { await db.exec(`set role anon`); try { return await fn(); } finally { await db.exec(`reset role`); } };
  const g = (await asAnon(() => one(`select prep_essay_get($1) g`, [e1.token]))).g;
  ok(g.first_name === 'Essay' && g.question === 'What does black belt mean to you?' && g.min_words === 100 && g.status === 'not_submitted' && !!g.due, 'the link shows their first name, question, minimum words and due date');
  ok((await asAnon(() => one(`select prep_essay_get('nope-not-a-real-token-at-all-0000000') g`))).g === null, 'a wrong link shows nothing');
  await fails(() => asAnon(() => db.query(`select * from prep_essays`)), /permission|denied/, 'the link cannot read other essays');
  await fails(() => asAnon(() => db.query(`select prep_essay_submit($1, '   ')`, [e1.token])), /Type or paste/, 'an empty hand-in is refused');
  const r1 = (await asAnon(() => one(`select prep_essay_submit($1, 'Black belt means never giving up and helping others') r`, [e1.token]))).r;
  ok(r1.word_count === 9 && r1.version === 1, 'the student hands in text (words counted)');
  await asAnon(() => db.query(`insert into storage.objects (bucket_id, name) values ('prep-essays', $1)`, [e1.token + '/a.pdf']));
  ok(true, 'the link can upload a file into its own folder');
  await fails(() => asAnon(() => db.query(`insert into storage.objects (bucket_id, name) values ('prep-essays', 'someoneelse/a.pdf')`)), /row-level security|violates/, 'but not anywhere else');
  await fails(() => asAnon(() => db.query(`select prep_essay_submit($1, null, 'other/x.pdf', 'x.pdf', 'application/pdf')`, [e1.token])), /not from this link/, 'a file from another folder is refused');
  const r2 = (await asAnon(() => one(`select prep_essay_submit($1, 'Second go', $2, 'essay.pdf', 'application/pdf') r`, [e1.token, e1.token + '/a.pdf']))).r;
  ok(r2.version === 2 && (await one(`select count(*)::int n from prep_essay_versions`)).n === 1, 'handing in again keeps the earlier version');
  // Marking
  await fails(() => as('inst@ama.test', () => db.exec(`update prep_essays set body = 'changed' where student_id = 'E1'`)), /Only the marking/, 'staff cannot change what the student wrote');
  await fails(() => as('view@ama.test', () => db.exec(`update prep_essays set status = 'reviewed' where student_id = 'E1'`)).then(async () => { if ((await one(`select status from prep_essays where student_id = 'E1'`)).status !== 'reviewed') throw new Error('permission'); }), /permission/, 'viewers cannot mark');
  await as('inst@ama.test', () => db.exec(`update prep_essays set status = 'needs_changes', feedback = 'Add more about respect' where student_id = 'E1'`));
  const sent = await one(`select status, reviewed_by from prep_essays where student_id = 'E1'`);
  ok(sent.status === 'needs_changes' && sent.reviewed_by === 'inst@ama.test', 'an instructor sends it back with feedback (and who did it is kept)');
  ok((await asAnon(() => one(`select prep_essay_get($1) g`, [e1.token]))).g.feedback === 'Add more about respect', 'the student sees the feedback on their link');
  await asAnon(() => db.query(`select prep_essay_submit($1, 'Third go with respect', null, null, null, true)`, [e1.token]));
  const third = await one(`select status, version, file_name from prep_essays where student_id = 'E1'`);
  ok(third.status === 'submitted' && third.version === 3 && third.file_name === 'essay.pdf', 'they hand in again (keeping the file), and it is waiting to be marked');
  await as(ADMIN, () => db.exec(`update prep_essays set status = 'reviewed', mark = 'Pass', feedback = 'Great work' where student_id = 'E1'`));
  const done = (await asAnon(() => one(`select prep_essay_get($1) g`, [e1.token]))).g;
  ok(done.locked && done.mark === 'Pass', 'once reviewed, the student sees it is marked and it is locked');
  await fails(() => asAnon(() => db.query(`select prep_essay_submit($1, 'too late')`, [e1.token])), /marked/, 'and cannot change it');
  const fresh = await as('inst@ama.test', () => rows(`select * from prep_essay_links($1, 'E1', true)`, [cy]));
  ok(fresh[0].token !== e1.token && (await asAnon(() => one(`select prep_essay_get($1) g`, [e1.token]))).g === null, 'a new link stops the old one working');
}

console.log('\nReadiness reasons');
{
  const rr = await one(`select student_id, cycle_id from prep_readiness limit 1`) || await one(`select student_id, cycle_id from prep_enrolments limit 1`);
  await (async f => f())(() => db.query(`insert into prep_readiness (student_id, cycle_id, status, reason) values ($1, $2, 'not_ready', 'more_time')
    on conflict (student_id, cycle_id) do update set status = 'not_ready', reason = 'more_time'`, [rr.student_id, rr.cycle_id]));   // (checks the allowed reasons)
  ok((await one(`select reason from prep_readiness where student_id = $1 and cycle_id = $2`, [rr.student_id, rr.cycle_id])).reason === 'more_time', 'not ready can be for "needs more time at current belt"');
  ok((await one(`select body from prep_message_templates where kind = 'not_ready'`)).body.includes('would like to see {reason}'), 'the not ready text reads well with the reasons');
}
console.log('\nText messages');
ok((await one(`select count(*)::int n from prep_message_templates`)).n === 4, 'the four texts start with their usual wording');
await as('inst@ama.test', () => db.exec(`update prep_message_templates set body = 'x' where kind = 'congrats'`)).catch(() => {});
ok((await one(`select body from prep_message_templates where kind = 'congrats'`)).body !== 'x', 'only admins change the wording');
await fails(() => as(ADMIN, () => db.exec(`insert into prep_messages (kind, body, status) values ('invite', 'x', 'sent')`)), /permission|denied|row-level/, 'the text log is written only by the GoHighLevel function');
ok((await as('view@ama.test', () => rows(`select * from prep_messages`))).length === 0, 'viewers cannot see texts sent');

const noRls = await rows(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'prep\\_%' and not c.relrowsecurity`);
ok(noRls.length === 0, 'every prep table has row level security on' + (noRls.length ? ': missing ' + noRls.map(r => r.relname) : ''));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

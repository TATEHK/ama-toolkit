// Tests prep-update-24.sql: hub_family_grading, the grading card in the AMA Hub family view.
// Builds stand-in tables with the live columns, then checks each family case.
// Run: node tests/hub-grading.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const db = new PGlite();
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };
const T = {
  cb_days: 'day_id uuid primary key default gen_random_uuid(), location text, grading_date date, bb boolean, prep_cycle_id uuid',
  cb_entries: 'entry_id uuid primary key default gen_random_uuid(), day_id uuid, member_key text, full_name text, belt_from text, belt_to text, invited_at timestamptz, booked_at timestamptz, paid boolean default false, result text, created_at timestamptz default now()',
  cb_students: 'member_key text, programme text, full_name text, belt text, next_belt text, belt_sort integer, classes integer, classes_needed integer, approval text',
  efc_members: 'member_key text primary key, full_name text, phone text, email text, guardian_name text, guardian_phone text, guardian_email text, efc_reference text, belt text, attended_since_promoted integer',
  prep_class_requirements: 'target_rank text, classes integer',
  prep_cycles: 'cycle_id uuid primary key default gen_random_uuid(), name text, status text, grading_date date, classes_required integer',
  prep_enrolments: 'cycle_id uuid, student_id text, is_grading boolean, classes_attended integer',
  prep_essay_questions: 'target_rank text, question text',
  prep_essays: 'essay_id uuid default gen_random_uuid(), cycle_id uuid, student_id text, target_rank text, status text, submitted_at timestamptz, version integer, mark text, late_ok boolean, created_at timestamptz default now()',
  prep_grading: 'grading_id uuid default gen_random_uuid(), student_id text, cycle_id uuid, grading_date date, current_rank text, target_rank text, eligibility_decision text, status text, result text, created_at timestamptz default now()',
  prep_id_card_status: 'student_id text, status text, printed_at timestamptz',
  prep_settings: 'id integer, sessions_required integer',
  prep_students: 'student_id text primary key, full_name text, belt_rank text, contact_email text, contact_phone text, is_active boolean default true, is_test boolean default false, efc_ref text',
  printed: 'student_id text, printed_at timestamptz'
};
for (const [t, c] of Object.entries(T)) await db.exec(`create table ${t} (${c})`);
await db.exec(`create function prep_card_people() returns table (person_id uuid, student_id text, name text, dob date, dan text, issued date,
  has_photo boolean, printed_at timestamptz, queue_status text, times_printed int) language sql as $$
  select null::uuid, student_id, null, null::date, null, null::date, true, printed_at, null, 1 from printed $$`);
await db.exec(`create role anon; create role authenticated; create role service_role;`);
const sql = readFileSync(join(here, '../supabase/prep-update-24.sql'), 'utf8');
await db.exec(sql); await db.exec(sql);
ok(true, 'prep-update-24.sql runs twice');

await db.exec(`
  insert into prep_settings values (1, 24);
  insert into prep_cycles (cycle_id, name, status, grading_date, classes_required) values
    ('00000000-0000-0000-0000-0000000000c1', 'Dec 2026', 'active', current_date + 30, 20),
    ('00000000-0000-0000-0000-0000000000c0', 'Jun 2026', 'closed', current_date - 150, 20);
  insert into prep_class_requirements values ('2nd Dan', 30);
  insert into prep_essay_questions values ('2nd Dan', 'What does black belt mean to you?');
  -- The Smith family: mum Jane (0412 345 678), kids Sam (coloured belt) and Alex (black belt candidate)
  insert into efc_members values
    ('efc:sam', 'Sam Smith', null, null, 'Jane Smith', '0412 345 678', 'Jane@Example.com', 'AU-1', 'Yellow Belt', 9),
    ('efc:alex', 'Alex Smith', null, null, 'Jane Smith', '+61412345678', null, 'AU-2', '1st Dan', 40),
    ('efc:other', 'Pat Other', '0499 000 111', null, null, null, null, 'AU-3', 'White Belt', 2);
  insert into cb_students values ('efc:sam', 'kids', 'Sam Smith', 'Yellow Belt', 'Orange Belt', 3, 18, 24, 'approved'),
                                 ('efc:other', 'kids', 'Pat Other', 'White Belt', 'Yellow Belt', 1, 2, 24, null);
  insert into cb_days (day_id, location, grading_date, bb) values
    ('00000000-0000-0000-0000-0000000000d1', 'Marrickville', current_date + 7, false),
    ('00000000-0000-0000-0000-0000000000d2', 'Marrickville', current_date + 30, true),
    ('00000000-0000-0000-0000-0000000000d0', 'Marrickville', current_date - 90, false);
  insert into cb_entries (day_id, member_key, belt_from, belt_to, invited_at, booked_at, paid) values
    ('00000000-0000-0000-0000-0000000000d0', 'efc:sam', 'White Belt', 'Yellow Belt', now() - interval '100 days', now(), true),
    ('00000000-0000-0000-0000-0000000000d1', 'efc:sam', 'Yellow Belt', 'Orange Belt', now() - interval '2 days', null, false),
    ('00000000-0000-0000-0000-0000000000d2', 'efc:alex', '1st Dan', '2nd Dan', now() - interval '5 days', now(), true);
  insert into prep_students values ('BB0001', 'Alex Smith', '1st Dan', null, null, true, false, 'AU-2'),
                                   ('BB0002', 'Chris Solo', '1st Dan', 'chris@solo.test', '0400 111 222', true, false, null),
                                   ('BB0003', 'Test Kid', '1st Dan', null, '0412345678', true, true, null);
  insert into prep_grading (student_id, cycle_id, current_rank, target_rank, eligibility_decision) values
    ('BB0001', '00000000-0000-0000-0000-0000000000c1', '1st Dan', '2nd Dan', 'eligible'),
    ('BB0001', '00000000-0000-0000-0000-0000000000c0', 'PBB', '1st Dan', 'eligible'),
    ('BB0002', '00000000-0000-0000-0000-0000000000c1', 'Probationary Black Belt', '1st Dan Black Belt', null),
    ('BB0003', '00000000-0000-0000-0000-0000000000c1', '1st Dan', '2nd Dan', null);
  insert into prep_enrolments values ('00000000-0000-0000-0000-0000000000c1', 'BB0001', true, 12),
                                     ('00000000-0000-0000-0000-0000000000c1', 'BB0002', false, 3);
  insert into prep_essays (cycle_id, student_id, target_rank, status, submitted_at, version) values
    ('00000000-0000-0000-0000-0000000000c1', 'BB0001', '2nd Dan', 'submitted', now(), 1);
  insert into printed values ('BB0001', now() - interval '1 day');
`);
const fam = async (names, mobile, email) => (await db.query(`select hub_family_grading($1, $2, $3) j`, [names, mobile, email])).rows[0].j;

let r = await fam([], '0412 345 678', null);
ok(r.length === 2, 'family found by mum\'s mobile, in any format: both kids');
const sam = r.find(x => x.name === 'Sam Smith'), alex = r.find(x => x.name === 'Alex Smith');
ok(sam && sam.track === 'coloured' && sam.target === 'Orange Belt', 'coloured belt kid is going for the next belt');
ok(sam.invite.sent && !sam.invite.booked && !sam.invite.paid, 'coloured belt: invite sent, not booked or paid yet');
ok(sam.classes.done === 18 && sam.classes.needed === 24, 'coloured belt: classes on the belt and classes needed');
ok(!sam.essay.needed && !sam.id_card.needed, 'coloured belt: no essay or ID card needed');
ok(alex && alex.track === 'black' && alex.target === '2nd Dan', 'black belt kid: target from the active cycle, not the old one');
ok(alex.invite.sent && alex.invite.booked && alex.invite.paid, 'black belt: invited, booked and paid');
ok(alex.classes.done === 40 && alex.classes.needed === 30, 'black belt: classes on the belt from EFC (higher than the 12 entered), needed from the rank');
ok(alex.essay.needed && alex.essay.status === 'submitted', 'black belt: essay needed and submitted');
ok(alex.id_card.needed && alex.id_card.printed, 'black belt: ID card printed');

r = await fam([], null, 'jane@example.com ');
ok(r.length === 1 && r[0].name === 'Sam Smith', 'found by email, ignoring case and spaces');

r = await fam(['Chris  solo'], null, null);
ok(r.length === 1 && r[0].track === 'black' && r[0].target === '1st Dan Black Belt', 'black belt student with no EFC record, found by exact name');
ok(!r[0].invite.sent && r[0].classes.done === 3 && r[0].classes.needed === 20, 'not invited; classes needed falls back to the cycle');
ok(!r[0].essay.needed && r[0].essay.status == null, 'no essay question for the rank: essay not needed');
ok(r[0].id_card.needed && !r[0].id_card.printed && r[0].id_card.status === 'not_printed', 'ID card not printed yet');

r = await fam([], '0400111222', null);
ok(r.length === 1 && r[0].name === 'Chris Solo', 'black belt student found by their contact mobile');

r = await fam(['Smith'], null, null);
ok(r.length === 0, 'a surname alone matches nobody');
r = await fam([], '123', 'not-an-email');
ok(r.length === 0, 'too-short mobile and bad email match nobody');
r = await fam([], null, null);
ok(Array.isArray(r) && r.length === 0, 'nothing to search by: empty list');
r = await fam([], '0499000111', null);
ok(r.length === 1 && r[0].target === 'Yellow Belt' && !r[0].invite.sent, 'not invited yet: going for the next belt from EFC');
ok(!(await fam([], '0412345678', null)).some(x => x.name === 'Test Kid'), 'test students never show');

await db.exec(`insert into prep_id_card_status values ('BB0002', 'not_required', null)`);
r = await fam(['Chris Solo'], null, null);
ok(!r[0].id_card.needed, 'ID card marked not required: not needed');

await db.exec(`update prep_grading set eligibility_decision = 'not_eligible' where student_id = 'BB0001' and cycle_id = '00000000-0000-0000-0000-0000000000c1'`);
r = await fam([], '0412345678', null);
ok(!r.some(x => x.name === 'Alex Smith') && r.some(x => x.name === 'Sam Smith'), 'not eligible for black belt: no grading shown for that student');

// Who can run it
await db.exec(`set role authenticated`);
let blocked = false; try { await fam([], '0412345678', null); } catch { blocked = true; }
await db.exec(`reset role; set role anon`);
let blocked2 = false; try { await fam([], '0412345678', null); } catch { blocked2 = true; }
await db.exec(`reset role`);
ok(blocked && blocked2, 'signed-in app users and anonymous visitors cannot run it');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

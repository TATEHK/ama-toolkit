// Database tests for the TV display (supabase/tv-setup.sql), in an embedded Postgres holding the real
// AMA ID Cards and Black Belt Gradings databases. Run: node tests/tv-db.test.mjs
// Uses the test tools from the black-belt-prep-system repository (set PREP_TESTS / CARD_REPO if elsewhere).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PREP_TESTS = process.env.PREP_TESTS || '/home/claude/black-belt-prep-system/tests';
const PREP = join(PREP_TESTS, '..');
const CARD = process.env.CARD_REPO || '/home/claude/theggatonklenner/ama-id-cards';
const { PGlite } = await import(join(PREP_TESTS, 'node_modules/@electric-sql/pglite/dist/index.js'));
const read = p => readFileSync(p, 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };
const { pgcrypto } = await import(join(PREP_TESTS, 'node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js'));
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;`);
async function as(email, fn) {
  await db.exec(email ? 'set role authenticated' : 'set role anon');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(email ? { email } : {})]);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false)`); }
}
const tryAs = async (email, sql, p = []) => { try { const r = await as(email, () => db.query(sql, p)); return { ok: true, rows: r.rows, n: /^\s*select/i.test(sql) ? r.rows.length : r.affectedRows }; } catch (e) { return { ok: false, err: e.message }; } };

console.log('Setting up AMA ID Cards and Black Belt Gradings');
await db.exec(read(join(PREP_TESTS, 'supabase-stub.sql')));
await db.exec(`grant usage on schema public to anon; grant execute on all functions in schema public to anon;`);
await db.exec(`insert into auth.users (email) values ('tate@ama.test'), ('jo@ama.test'), ('station@ama.test'), ('nobody@ama.test')`);
for (const f of ['setup.sql', 'roles.sql', 'printed.sql', 'permissions.sql']) await db.exec(read(join(CARD, 'supabase', f)));
await db.exec(read(join(PREP, 'supabase/prep-setup.sql')));
for (let i = 1; i <= 8; i++) await db.exec(read(join(PREP, `supabase/prep-update-0${i}.sql`)));
// Everyone who exists when the apps are first set up starts as an admin; set up the test people properly
await db.exec(`delete from staff_permissions where email <> 'tate@ama.test';
  insert into staff_permissions values ('station@ama.test', 'printer');
  delete from prep_roles where email <> 'tate@ama.test';
  insert into prep_roles (email, role) values ('jo@ama.test', 'instructor');`);

console.log('\nTV setup');
const SQL = read(join(here, '../supabase/tv-setup.sql'));
await db.exec(SQL); await db.exec(SQL);
ok(true, 'tv-setup.sql runs twice without errors');
const code = (await db.query(`select screen_code from tv_settings where id = 1`)).rows[0].screen_code;
ok(/^[A-Z0-9]{6}$/.test(code), 'a 6-character screen code is made automatically');
ok((await db.query(`select public from storage.buckets where id = 'tv'`)).rows[0].public === true, 'photo and video bucket is set up');

console.log('\nWho can edit');
ok((await tryAs('tate@ama.test', `insert into tv_slides (kind, title, body) values ('text', 'Welcome', 'Class times') returning id`)).ok, 'ID Cards staff can add slides');
ok((await tryAs('jo@ama.test', `insert into tv_slides (kind, title) values ('text', 'From Jo')`)).ok, 'Black Belt Gradings staff can add slides');
ok(!(await tryAs('station@ama.test', `insert into tv_slides (kind, title) values ('text', 'x')`)).ok, 'the print station login cannot');
ok(!(await tryAs('nobody@ama.test', `insert into tv_slides (kind, title) values ('text', 'x')`)).ok, 'a login with no roles cannot');
ok(!(await tryAs(null, `insert into tv_slides (kind, title) values ('text', 'x')`)).ok && (await tryAs(null, `select * from tv_slides`)).ok === false || (await tryAs(null, `select * from tv_slides`)).n === 0, 'the public cannot read or change slides directly');
ok((await tryAs('nobody@ama.test', `select * from tv_settings where id = 1`)).n === 0, 'non-staff cannot see the screen code');

console.log('\nTV permissions');
const tvp = (await db.query(`select email, permission from tv_permissions order by email`)).rows.map(r => r.email + ':' + r.permission).join();
ok(tvp === 'jo@ama.test:edit,tate@ama.test:edit', `first run: everyone who could edit the TV keeps it, the print station doesn't (${tvp})`);
await as('tate@ama.test', () => db.exec(`insert into tv_permissions values ('tvonly@ama.test', 'edit'), ('remote@ama.test', 'remote')`));
ok((await tryAs('tvonly@ama.test', `insert into tv_slides (kind, title) values ('text', 'From TV only')`)).ok, 'someone with only the TV editor ticked can add slides');
ok((await as('tvonly@ama.test', () => db.query(`select can_view_cards() a`))).rows[0].a === false && (await tryAs('tvonly@ama.test', `select * from prep_students`)).n === 0, "...but can't see AMA ID Cards or Black Belt Gradings");
ok((await tryAs('remote@ama.test', `select * from tv_slides`)).n > 0 && (await tryAs('remote@ama.test', `select tv_remote_send('next')`)).ok, 'TV remote only: can see the slides and press the remote buttons');
ok(!(await tryAs('remote@ama.test', `insert into tv_slides (kind, title) values ('text', 'x')`)).ok && (await tryAs('remote@ama.test', `select * from tv_settings where id = 1`)).n === 0
  && (await as('remote@ama.test', () => db.query(`select tv_is_staff() a`))).rows[0].a === false, "...but can't change slides, see the screen code or open the editor");
await as('tate@ama.test', () => db.exec(`insert into tv_permissions values ('party@ama.test', 'party')`));
const pslide = await tryAs('party@ama.test', `insert into tv_slides (kind, title, theme, party) values ('text', 'Happy Birthday Mia!', 'party', true) returning id`);
ok(pslide.ok, 'party mode only: can make a birthday slide');
ok((await tryAs('party@ama.test', `update tv_settings set only_slide = '${pslide.rows[0].id}', only_until = now() + interval '1 hour' where id = 1`)).n === 1, '...and put it on the TV');
ok((await tryAs('party@ama.test', `insert into tv_party_bookings (slide_id, starts_at, ends_at) values ('${pslide.rows[0].id}', now() + interval '1 day', now() + interval '1 day 2 hours')`)).ok, '...and book a party');
ok(!(await tryAs('party@ama.test', `insert into tv_slides (kind, title) values ('text', 'Not a party')`)).ok && !(await tryAs('party@ama.test', `delete from tv_slides where not party`)).n, "...but can't add or delete normal slides");
ok(!(await tryAs('party@ama.test', `update tv_settings set seconds = 5 where id = 1`)).ok && !(await tryAs('party@ama.test', `update tv_settings set screen_code = 'HACKED' where id = 1`)).ok, "...or change the settings or screen code");
ok(!(await tryAs('party@ama.test', `insert into tv_events (starts_on, title) values (current_date, 'x')`)).ok && (await as('party@ama.test', () => db.query(`select tv_is_staff() a, tv_can('remote') b`))).rows[0].a === false, "...or use the rest of the editor");
ok((await tryAs('tvonly@ama.test', `update tv_settings set seconds = seconds where id = 1`)).ok, 'the TV editor can still change settings');
await as('tate@ama.test', () => db.exec(`update tv_settings set only_slide = null, only_until = null where id = 1; delete from tv_party_bookings; delete from tv_slides where title = 'Happy Birthday Mia!'`));
ok(!(await tryAs('jo@ama.test', `insert into tv_permissions values ('x@ama.test', 'edit')`)).ok && !(await tryAs('tvonly@ama.test', `delete from tv_permissions`)).n, 'only admins can change TV permissions');
await as('tate@ama.test', () => db.exec(`delete from tv_permissions where email = 'jo@ama.test'`));
await db.exec(SQL);
ok(!(await tryAs('jo@ama.test', `insert into tv_slides (kind, title) values ('text', 'x')`)).ok, 'unticking takes TV access away, and running the setup again does not give it back');
ok((await tryAs('tate@ama.test', `insert into tv_slides (kind, title) values ('text', 'Admin')`)).ok, 'admins can always use the TV');
await as('tate@ama.test', () => db.exec(`insert into tv_permissions values ('jo@ama.test', 'edit'); delete from tv_slides where title in ('From TV only', 'Admin'); update tv_settings set remote_until = null, remote_cmd = null where id = 1`));
ok((await db.query(`select created_by from tv_slides where title = 'Welcome'`)).rows[0].created_by === 'tate@ama.test', 'records who added a slide');
ok(!(await tryAs('tate@ama.test', `insert into tv_slides (kind, title) values ('photo', 'no file')`)).ok, 'a photo slide needs a file');
ok(!(await tryAs('tate@ama.test', `insert into tv_slides (kind, title) values ('live', 'no kind')`)).ok, 'a live slide needs to say which live info');

console.log('\nWhat the TV gets');
let f = (await as(null, () => db.query(`select tv_feed($1) f`, ['WRONG1']))).rows[0].f;
ok(f.error === 'wrong_code' && !f.slides, 'wrong screen code gets nothing');
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code.toLowerCase()]))).rows[0].f;
ok(!f.error && f.slides.map(s => s.title).join() === 'Welcome,From Jo', 'right code (any case) gets the slides in order');
ok(f.settings.seconds === 10 && f.settings.show_clock === true, 'and the settings');
await as('tate@ama.test', () => db.exec(`update tv_slides set enabled = false where title = 'From Jo';
  insert into tv_slides (kind, title, starts_on) values ('text', 'Future', current_date + 30);
  insert into tv_slides (kind, title, ends_on) values ('text', 'Past', current_date - 1);
  insert into tv_slides (kind, title, starts_on, ends_on) values ('text', 'Now', current_date - 1, current_date + 1);`));
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(f.slides.map(s => s.title).join() === 'Welcome,Now', 'turned-off slides and slides outside their dates are left out; new slides go at the end');

console.log('\nLive AMA info');
await as('tate@ama.test', () => db.exec(`
  insert into prep_students (student_id, full_name, certificate_name, belt_rank) values ('T1', 'Kara Lee', 'Kara Jane Lee', 'Cho Dan Bo'), ('T2', 'Sam Park', null, '1st Dan Level 1'), ('T3', 'Old Pass', null, '2nd Dan Level 2'), ('T4', 'Test Kid', null, 'Cho Dan Bo');
  update prep_students set is_test = true where student_id = 'T4';`));
const cid = (await as('tate@ama.test', () => db.query(`select prep_start_new_cycle('TV cycle', null, null, array[current_date - 14, current_date + 1, current_date + 15, current_date + 29]::date[], 0, null, array['T1','T2','T3','T4']) id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`update prep_cycles set grading_date = current_date + 43 where cycle_id = $1`, [cid]));
await as('tate@ama.test', () => db.query(`select prep_activate_cycle($1, true)`, [cid]));
await db.query(`insert into prep_grading (student_id, cycle_id, grading_event, grading_date, target_rank, result, eligibility_decision, decision_reason, status) values
  ('T1', $1, 'Recent', current_date - 3, 'Probationary Black Belt', 'passed', 'eligible', 'test', 'completed'),
  ('T2', $1, 'Recent', current_date - 3, '2nd Dan', 'passed', 'eligible', 'test', 'completed'),
  ('T3', $1, 'Long ago', current_date - 120, '3rd Dan', 'passed', 'eligible', 'test', 'completed'),
  ('T4', $1, 'Recent', current_date - 3, 'Probationary Black Belt', 'passed', 'eligible', 'test', 'completed')`, [cid]);
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
const today = new Date(f.today + 'T00:00:00Z');
const plus = n => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
ok(f.live.next_grading && f.live.next_grading.date === plus(43) && f.live.next_grading.cycle === 'TV cycle', 'next grading date of the active cycle');
ok(JSON.stringify(f).indexOf('student_id') === -1 && JSON.stringify(f).indexOf('"T1"') === -1, 'the TV never gets Student IDs or anything else about students');

console.log('\nBirthdays today');
// A minimal efc_members (the real one is in the Coloured Belts setup, not loaded here). date_of_birth is text YYYY-MM-DD.
await db.exec(`create table if not exists public.efc_members (member_key text primary key, full_name text, first_name text, last_name text, date_of_birth text, status text);`);
const mmdd = `to_char((now() at time zone 'Australia/Sydney')::date, 'MM-DD')`;
await db.exec(`insert into public.efc_members (member_key, full_name, first_name, last_name, date_of_birth, status) values
  ('m1', 'Sam Lee', 'Sam', 'Lee', '2000-' || ${mmdd}, 'Enrolled'),
  ('m2', 'Jo Park', 'Jo', 'Park', '2015-' || ${mmdd}, 'enrolled'),
  ('m3', 'Mia', 'Mia', null, '2016-' || ${mmdd}, 'Enrolled'),
  ('m4', 'Not Today', 'Not', 'Today', '2010-' || to_char((now() at time zone 'Australia/Sydney')::date + 1, 'MM-DD'), 'Enrolled'),
  ('m5', 'Ex Member', 'Ex', 'Member', '2009-' || ${mmdd}, null),
  ('m6', 'Left Lee', 'Left', 'Lee', '2009-' || ${mmdd}, 'Cancelled');`);
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(Array.isArray(f.live.birthdays) && JSON.stringify(f.live.birthdays) === JSON.stringify(['Jo P.', 'Mia', 'Sam L.']),
  'birthdays today: current members only, first name + last initial, sorted; a single name has no initial');
ok(!JSON.stringify(f.live.birthdays).match(/20\d\d|19\d\d/) && JSON.stringify(f).indexOf('date_of_birth') === -1,
  'no date of birth, year or age reaches the TV');
ok(!JSON.stringify(f.live.birthdays).includes('Not') && !JSON.stringify(f.live.birthdays).includes('Ex') && !JSON.stringify(f.live.birthdays).includes('Left'),
  "no one with a different birthday, and no one who isn't enrolled");
ok((await tryAs('tate@ama.test', `insert into tv_slides (kind, live_kind, theme) values ('live', 'birthdays', 'party')`)).ok, 'a Birthdays today live slide can be added');
await db.exec(`update public.efc_members set status = 'Cancelled'`);
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(Array.isArray(f.live.birthdays) && f.live.birthdays.length === 0, 'with no birthdays today the list is empty (the slide hides itself)');
await db.exec(`drop table public.efc_members; delete from tv_slides where live_kind = 'birthdays';`);

console.log('\nParty mode');
const pid = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, theme, party) values ('text', 'Happy Birthday Kara!', 'party', true) returning id`))).rows[0].id;
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(!f.only && !f.slides.some(s => s.title === 'Happy Birthday Kara!'), 'party slides stay out of the normal slideshow');
await as('tate@ama.test', () => db.query(`update tv_settings set only_slide = $1, only_until = now() + interval '2 hours' where id = 1`, [pid]));
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(f.only === true && f.slides.length === 1 && f.slides[0].title === 'Happy Birthday Kara!' && f.slides[0].theme === 'party', 'party mode: the TV gets only that slide');
ok(f.settings.show_clock === false && f.settings.show_logo === false && Object.keys(f.live).length === 0, 'with no clock, logo or live info over it');
await as('tate@ama.test', () => db.exec(`update tv_settings set only_until = now() - interval '1 minute' where id = 1`));
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(!f.only && f.slides.length > 1, 'when the time is up, the normal slideshow comes back by itself');
ok(!(await tryAs('nobody@ama.test', `update tv_settings set only_slide = null where id = 1`)).n, 'only staff can start or stop party mode');

console.log('\nCountdowns');
ok(!(await tryAs('tate@ama.test', `insert into tv_slides (kind, title, count_to) values ('countdown', 'No date', 'date')`)).ok, 'a countdown to a date needs the date');
await as('tate@ama.test', () => db.exec(`insert into tv_slides (kind, title, count_to, event_on) values ('countdown', 'Comp', 'date', current_date + 21), ('countdown', 'Old comp', 'date', current_date - 1);
  insert into tv_slides (kind, title, count_to) values ('countdown', 'Black belt grading', 'grading');`));
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
const cds = f.slides.filter(x => x.kind === 'countdown');
ok(cds.map(x => x.title).join() === 'Comp,Black belt grading' && cds[0].event_on && cds[1].count_to === 'grading', 'countdowns reach the TV (to a date, or to the next grading); past ones are left out');

console.log('\nBooked parties');
const bk = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, theme, party) values ('text', 'Happy Birthday Mo!', 'party', true) returning id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`insert into tv_party_bookings (slide_id, starts_at, ends_at) values ($1, now() + interval '2 hours', now() + interval '4 hours')`, [bk]));
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(!f.only, 'a booking later today does not change the TV yet');
await db.exec(`update tv_party_bookings set starts_at = now() - interval '1 minute'`);
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(f.only && f.slides[0].title === 'Happy Birthday Mo!' && new Date(f.only_until) > new Date(), 'at the booked time, party mode switches on by itself');
await db.exec(`update tv_party_bookings set ends_at = now() - interval '1 second'`);
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(!f.only, 'and off again at the end');
ok(!(await tryAs('nobody@ama.test', `insert into tv_party_bookings (slide_id, starts_at, ends_at) values ('${bk}', now(), now() + interval '1 hour')`)).ok, 'only staff can book parties');
ok(!(await tryAs('tate@ama.test', `insert into tv_party_bookings (slide_id, starts_at, ends_at) values ('${bk}', now(), now() - interval '1 hour')`)).ok, 'a booking must end after it starts');

console.log('\nTV status and refresh');
const ck = async (c, scr, started) => (await as(null, () => db.query(`select tv_checkin($1, $2, 'Showing: Comp', $3, '{"w":1920}'::jsonb) r`, [c, scr, started]))).rows[0].r;
ok((await ck('WRONG1', 'screen-abc123', new Date().toISOString())).error === 'wrong_code', 'a TV with the wrong code cannot check in');
const started = new Date(Date.now() - 60000).toISOString();
let r = await ck(code, 'screen-abc123', started);
ok(r.reload === false, 'checking in works, and no reload is asked for');
const scr = (await as('tate@ama.test', () => db.query(`select * from tv_screens`))).rows;
ok(scr.length === 1 && scr[0].showing === 'Showing: Comp' && scr[0].details.w === 1920, 'staff can see the TV is online and what it is showing');
ok((await tryAs(null, `select * from tv_screens`)).ok === false || (await tryAs(null, `select * from tv_screens`)).n === 0, 'the public cannot see TV status');
await as('tate@ama.test', () => db.exec(`update tv_settings set reload_at = now() where id = 1`));
ok((await ck(code, 'screen-abc123', started)).reload === true, '"Refresh the TV" asks a TV that loaded earlier to reload');
ok((await ck(code, 'screen-abc123', new Date(Date.now() + 1000).toISOString())).reload === false, 'once it has reloaded, it is not asked again');
// A TV whose clock is an hour fast still gets refreshed
const fast = new Date(Date.now() + 3600e3).toISOString();
await ck(code, 'screen-fast01', fast);
await as('tate@ama.test', () => db.exec(`update tv_settings set reload_at = '2001-01-01' where id = 1`));
ok((await as('tate@ama.test', () => db.query(`select reload_at > now() - interval '1 minute' x from tv_settings where id = 1`))).rows[0].x, 'the refresh time is the server\'s, whatever time the editor sends');
ok((await ck(code, 'screen-fast01', fast)).reload === true, 'a TV with its clock set wrong still refreshes');
ok((await ck(code, 'bad screen!', started)).error === 'bad_screen', 'odd screen names are refused');

ok(!(await tryAs('tate@ama.test', `insert into tv_slides (kind, live_kind) values ('live', 'congrats')`)).ok, 'the Congratulations and Prep sessions slides are gone');
console.log('\nEvents calendar');
const feedEvents = async () => { const f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f; return f.only ? null : f.live.events; };
const D = (await db.query(`select (now() at time zone 'Australia/Sydney')::date::text t, date_trunc('month', (now() at time zone 'Australia/Sydney'))::date::text m0,
  (date_trunc('month', (now() at time zone 'Australia/Sydney')) + interval '1 month')::date::text m1,
  (now() at time zone 'Australia/Sydney')::date >= (date_trunc('month', (now() at time zone 'Australia/Sydney')) + interval '1 month')::date - 10 two`)).rows[0];
ok(!(await tryAs('nobody@ama.test', `insert into tv_events (starts_on, title) values (current_date, 'X')`)).ok, 'only staff can add events');
ok(!(await tryAs('tate@ama.test', `insert into tv_events (starts_on, ends_on, title) values ('2026-05-05', '2026-05-01', 'X')`)).ok, 'an event cannot end before it starts');
await as('tate@ama.test', () => db.query(`insert into tv_events (starts_on, ends_on, title, note) values
  ($1::date, null, 'Today thing', '1:30 pm'), ($1::date - 1, null, 'Yesterday thing', null),
  ($2::date - 3, $1::date, 'Started last month', null), ($3::date + 2, null, 'Next month thing', null),
  ($3::date + interval '1 month' + interval '3 days', null, 'Far off', null)`, [D.t, D.m0, D.m1]));
await as('tate@ama.test', () => db.query(`insert into tv_months (month, theme) values ($1, 'Month of Testing')`, [D.m0]));
let ev = await feedEvents();
const titles = m => (m ? m.events.map(e => e.title) : []);
ok(ev[0].month === D.m0 && ev[0].theme === 'Month of Testing', 'the TV gets this month with its theme');
ok((await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f.live.month.theme === 'Month of Testing', "the month theme slide gets this month's theme");
ok(titles(ev[0]).includes('Today thing') && ev[0].events.find(e => e.title === 'Today thing').note === '1:30 pm', "this month's events are listed, with notes");
ok(!JSON.stringify(ev).includes('Yesterday thing'), 'events that are over are left off');
ok(titles(ev[0]).includes('Started last month'), 'an event that started last month and is still on shows under this month');
ok(!JSON.stringify(ev).includes('Far off'), 'only this month and next month, never the whole year');
ok(D.two ? (ev.length === 2 && titles(ev[1]).includes('Next month thing')) : ev.length === 1, `next month shows only in the last 10 days of the month (${D.two ? 'it is now' : 'not yet'})`);
await as('tate@ama.test', () => db.query(`delete from tv_events where title in ('Today thing', 'Started last month')`));
ev = await feedEvents();
ok(ev.length === 2 && ev[0].events.length === 0 && titles(ev[1]).includes('Next month thing'), 'once this month has nothing left, next month shows');
await as('tate@ama.test', () => db.exec(`delete from tv_events; delete from tv_months`));

console.log('\nQuiet hours and QR codes');
const syd = `(now() at time zone 'Australia/Sydney')`;
const feedNow = async () => (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
await as('tate@ama.test', () => db.exec(`update tv_settings set only_slide = null, only_until = null, quiet_on = true, quiet_style = 'logo',
  quiet_from = (${syd} - interval '1 hour')::time, quiet_to = (${syd} + interval '1 hour')::time where id = 1`));
f = await feedNow();
ok(f.quiet === 'logo' && f.slides.length === 0 && !f.settings.show_clock, 'in quiet hours the TV gets no slides, just the logo');
await as('tate@ama.test', () => db.exec(`update tv_settings set quiet_style = 'black' where id = 1`));
ok((await feedNow()).quiet === 'black', 'or a black screen');
await as('tate@ama.test', () => db.exec(`update tv_settings set quiet_from = (${syd} + interval '1 hour')::time, quiet_to = (${syd} - interval '1 hour')::time where id = 1`));
ok(!(await feedNow()).quiet, 'outside quiet hours the slideshow plays (a 9 pm to 7 am style window that crosses midnight)');
await as('tate@ama.test', () => db.exec(`update tv_settings set quiet_from = (${syd} - interval '1 minute')::time, quiet_to = (${syd} - interval '2 minutes')::time where id = 1`));
ok((await feedNow()).quiet === 'black', 'a window that wraps past midnight covers now');
const qp = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, theme, party) values ('text', 'Party in quiet hours', 'party', true) returning id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`update tv_settings set only_slide = $1, only_until = now() + interval '1 hour' where id = 1`, [qp]));
ok((await feedNow()).only === true, 'a party still shows during quiet hours');
await as('tate@ama.test', () => db.exec(`update tv_settings set party_qr_url = 'https://forms.gle/abc', party_qr_text = 'Scan me' where id = 1`));
ok((await feedNow()).settings.party_qr === 'https://forms.gle/abc' && (await feedNow()).settings.party_qr_text === 'Scan me', 'during a party the feed has the QR code link and text');
ok(!(await tryAs('tate@ama.test', `update tv_settings set party_qr_url = 'not a link' where id = 1`)).ok, 'the party QR code needs a proper link');
await as('tate@ama.test', () => db.exec(`update tv_settings set party_qr_url = null, party_qr_text = null where id = 1`));
await as('tate@ama.test', () => db.exec(`update tv_settings set only_slide = null, only_until = null, quiet_on = false where id = 1`));
ok(!(await feedNow()).quiet, 'quiet hours can be turned off');
ok(!(await tryAs('tate@ama.test', `update tv_settings set quiet_style = 'off' where id = 1`)).ok, 'only black or logo');
const dow = (await db.query(`select extract(dow from ${syd})::int d, to_char(${syd} - interval '1 hour', 'HH24:MI') a, to_char(${syd} + interval '1 hour', 'HH24:MI') b, to_char(${syd} + interval '2 hours', 'HH24:MI') c`)).rows[0];
const setDays = async days => as('tate@ama.test', () => db.query(`update tv_settings set quiet_on = true, quiet_days = $1::jsonb where id = 1`, [JSON.stringify(days)]));
const other = (dow.d + 3) % 7;
// near midnight 'an hour from now' wraps into tomorrow, so use whole-day hours there
const late = dow.b < dow.a || dow.c < dow.b;
await setDays({ [dow.d]: late ? { on: '00:00', off: '23:59' } : { on: dow.a, off: dow.b }, [other]: null });
ok(!(await feedNow()).quiet, "each day has its own hours: during today's hours the slideshow plays");
if (!late) {
  await setDays({ [dow.d]: { on: dow.b, off: dow.c }, [other]: { on: dow.a, off: dow.b } });
  ok((await feedNow()).quiet, "before today's hours start the TV is quiet (another day's hours don't count)");
}
await setDays({ [dow.d]: null });
ok((await feedNow()).quiet, 'a day marked closed is quiet all day');
await as('tate@ama.test', () => db.exec(`update tv_settings set quiet_on = false, quiet_days = null where id = 1`));
ok(!(await tryAs('tate@ama.test', `insert into tv_slides (kind, link, media_path) values ('qr', 'not a link', 'qr/x.png')`)).ok, 'a QR slide needs a proper link');
await as('tate@ama.test', () => db.exec(`insert into tv_slides (kind, title, link, media_path) values ('qr', 'Follow us', 'https://instagram.com/ama', 'qr/x.png')`));
ok((await feedNow()).slides.some(x => x.kind === 'qr' && x.link === 'https://instagram.com/ama'), 'QR slides reach the TV with their link');
await as('tate@ama.test', () => db.exec(`delete from tv_slides where kind = 'qr' or title = 'Party in quiet hours'`));

console.log('\nPhone remote');
const poll = async (after, state = {}) => (await as(null, () => db.query(`select tv_remote_poll($1, 'screen-abc123', $2, $3::jsonb) r`, [code, after, JSON.stringify(state)]))).rows[0].r;
ok(!(await tryAs(null, `select tv_remote_send('next')`)).ok && !(await tryAs('nobody@ama.test', `select tv_remote_send('next')`)).ok, 'only staff with TV access can press the remote buttons');
let p0 = await poll(null);
ok(p0.on === false && !p0.cmd, 'the remote is off until someone opens it');
const verBefore = (await feedNow()).version;
await as('tate@ama.test', () => db.query(`select tv_remote_send('hello')`));
const fr = await feedNow();
ok(fr.remote === true && fr.version === verBefore, 'opening the remote tells the TV to listen closely, without restarting the slideshow');
p0 = await poll(null);
ok(p0.on && !p0.cmd, 'a TV that just started listening does not replay an old press');
const s0 = p0.seq;
const sid = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title) values ('text', 'Remote target') returning id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`select tv_remote_send('show', $1)`, [sid]));
let p1 = await poll(s0, { showing: 'Remote target (2 of 5)', slide: sid, paused: false });
ok(p1.cmd.cmd === 'show' && p1.cmd.slide === sid && p1.seq === s0 + 1, '"Show this slide now" reaches the TV with the slide');
ok(!(await poll(p1.seq)).cmd, 'each press is carried out once');
const scr2 = (await as('tate@ama.test', () => db.query(`select showing, details from tv_screens where screen_id = 'screen-abc123'`))).rows[0];
ok(scr2.showing === 'Remote target (2 of 5)' && scr2.details.slide === sid && scr2.details.paused === false, 'the TV reports what it is showing, for the remote');
await as('tate@ama.test', () => db.query(`select tv_remote_send('pause')`));
await as('tate@ama.test', () => db.exec(`update tv_settings set remote_at = now() - interval '1 minute' where id = 1`));
ok(!(await poll(p1.seq)).cmd, 'a press from more than 30 seconds ago is ignored (e.g. a TV coming back online)');
ok(!(await tryAs('tate@ama.test', `select tv_remote_send('dance')`)).ok, 'only the remote buttons');
await as('tate@ama.test', () => db.query(`select tv_remote_send('done')`));
await as('tate@ama.test', () => db.exec(`update tv_settings set remote_until = now() - interval '1 second' where id = 1`));
ok((await poll(null)).on === false, 'closing the remote lets the TV go back to normal');
await as('tate@ama.test', () => db.query(`delete from tv_slides where id = $1`, [sid]));
const bo = (await as('tate@ama.test', () => db.query(`select tv_remote_send('blackout') r`))).rows[0].r;
let fb = await feedNow();
ok(bo.blackout === true && fb.blackout && fb.quiet === 'black' && fb.slides.length === 0, 'Black out the screen: the TV gets a black screen');
const bp = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, theme, party) values ('text', 'Party under blackout', 'party', true) returning id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`update tv_settings set only_slide = $1, only_until = now() + interval '1 hour' where id = 1`, [bp]));
ok((await feedNow()).blackout === true, 'it stays black even during a party');
ok(!(await tryAs('nobody@ama.test', `select tv_remote_send('wake')`)).ok, 'only people with TV access can black it out or turn it back on');
await as('remote@ama.test', () => db.query(`select tv_remote_send('wake')`));
fb = await feedNow();
ok(!fb.blackout && fb.only === true && fb.remote === true, 'Turn the screen back on (from the remote) brings back what was showing');
await as('tate@ama.test', () => db.exec(`update tv_settings set only_slide = null, only_until = null where id = 1`));
await as('tate@ama.test', () => db.query(`delete from tv_slides where id = $1`, [bp]));

console.log('\nTablets');
const tab = (await db.query(`select screen_code, display from tv_settings where id = 2`)).rows[0];
ok(tab && tab.display === 'tablet' && tab.screen_code !== code, 'the tablets are a second display with their own code');
const feedOf = async c => (await as(null, () => db.query(`select tv_feed($1) f`, [c]))).rows[0].f;
const tsl = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, display) values ('text', 'Tablet notice', 'tablet') returning id`))).rows[0].id;
let ft = await feedOf(tab.screen_code), fv = await feedOf(code);
ok(ft.display === 'tablet' && ft.slides.map(x => x.title).join() === 'Tablet notice', 'the tablet link gets only the tablet slides');
ok(fv.display === 'tv' && !fv.slides.some(x => x.title === 'Tablet notice'), 'and the TV does not get them');
ok(ft.settings.banner === 'Tap to sign in' && !fv.settings.banner, 'the tablets say "Tap to sign in" along the bottom; the TV has no message');
await as('tate@ama.test', () => db.exec(`update tv_settings set banner = '' where id = 2`)); await db.exec(SQL);
ok(!(await feedOf(tab.screen_code)).settings.banner, 'a cleared message stays cleared after running the setup again');
await as('tate@ama.test', () => db.exec(`update tv_settings set banner = 'Tap to sign in' where id = 2`));
const tparty = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, display, party, theme) values ('text', 'Tablet party', 'tablet', true, 'party') returning id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`insert into tv_party_bookings (slide_id, starts_at, ends_at) values ($1, now() - interval '1 minute', now() + interval '1 hour')`, [tparty]));
ok((await feedOf(tab.screen_code)).only === true && !(await feedOf(code)).only, "a booked party on the tablets doesn't touch the TV");
await as('tate@ama.test', () => db.exec(`delete from tv_party_bookings`));
await as('tate@ama.test', () => db.query(`select tv_remote_send('blackout', null, 'tablet')`));
ok((await feedOf(tab.screen_code)).blackout === true && !(await feedOf(code)).blackout, 'blacking out the tablets leaves the TV on');
await as('tate@ama.test', () => db.query(`select tv_remote_send('wake', null, 'tablet')`));
await as(null, () => db.query(`select tv_checkin($1, 'tablet-front1', 'Tablet notice', now(), '{}'::jsonb)`, [tab.screen_code]));
ok((await db.query(`select display from tv_screens where screen_id = 'tablet-front1'`)).rows[0].display === 'tablet', 'tablets check in as tablets');
ok((await tryAs('tate@ama.test', `update tv_screens set name = 'Front desk' where screen_id = 'tablet-front1'`)).n === 1 && !(await tryAs('remote@ama.test', `update tv_screens set name = 'x'`)).n, 'staff can name each tablet');
await as(null, () => db.query(`select tv_checkin($1, 'tablet-front1', 'Next', now(), '{}'::jsonb)`, [tab.screen_code]));
ok((await db.query(`select name from tv_screens where screen_id = 'tablet-front1'`)).rows[0].name === 'Front desk', 'the name stays when the tablet checks in again');
ok(!(await tryAs('tate@ama.test', `update tv_settings set screen_code = '${code}' where id = 2`)).ok, 'two displays cannot share a code');
await as('tate@ama.test', () => db.query(`delete from tv_slides where id in ($1, $2)`, [tsl, tparty]));
await db.exec(`delete from tv_screens where screen_id = 'tablet-front1'; update tv_settings set remote_until = null`);

console.log('\nLocations');
ok((await db.query(`select string_agg(name, ',' order by position) n from tv_locations`)).rows[0].n === 'Marrickville,Sydenham,Concord,Auburn,Sylvania', 'starts with the five AMA locations');
const feedAt = async (scr, loc) => (await as(null, () => db.query(`select tv_feed($1, $2, $3) f`, [code, scr, loc]))).rows[0].f;
const ls1 = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, locations) values ('text', 'Sydenham only', '{sydenham}') returning id`))).rows[0].id;
await as(null, () => db.query(`select tv_checkin($1, 'syd-tv-0001', 'x', now(), '{}'::jsonb, 'sydenham')`, [code]));
await as(null, () => db.query(`select tv_checkin($1, 'mkv-tv-0001', 'x', now(), '{}'::jsonb, null)`, [code]));
ok((await db.query(`select location from tv_screens where screen_id = 'syd-tv-0001'`)).rows[0].location === 'sydenham', 'a device opened with a location link is put at that location');
let fs1 = await feedAt('syd-tv-0001', null), fm1 = await feedAt('mkv-tv-0001', null);
ok(fs1.location === 'sydenham' && fs1.slides.some(x => x.title === 'Sydenham only'), 'a Sydenham slide shows on Sydenham devices');
ok(!fm1.slides.some(x => x.title === 'Sydenham only') && fm1.slides.length > 0, '...not on others (they still get the slides for every location)');
await as('tate@ama.test', () => db.exec(`update tv_screens set location = 'marrickville' where screen_id = 'mkv-tv-0001'`));
await as(null, () => db.query(`select tv_checkin($1, 'mkv-tv-0001', 'x', now(), '{}'::jsonb, 'sydenham')`, [code]));
ok((await db.query(`select location from tv_screens where screen_id = 'mkv-tv-0001'`)).rows[0].location === 'marrickville', "a location set in the editor isn't changed by the link");
const sp = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, party, theme, locations) values ('text', 'Happy Birthday Syd!', true, 'party', '{sydenham}') returning id`))).rows[0].id;
const mp = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, party, theme, locations) values ('text', 'Happy Birthday Mark!', true, 'party', '{marrickville}') returning id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`insert into tv_party_bookings (slide_id, starts_at, ends_at) values ($1, now() - interval '1 minute', now() + interval '1 hour'), ($2, now() - interval '1 minute', now() + interval '1 hour')`, [sp, mp]));
fs1 = await feedAt('syd-tv-0001', null); fm1 = await feedAt('mkv-tv-0001', null);
const fn1 = await feedAt('nowhere-0001', null);
ok(fs1.only && fs1.slides[0].title === 'Happy Birthday Syd!' && fm1.only && fm1.slides[0].title === 'Happy Birthday Mark!', 'two parties at once: each location shows only its own');
ok(!fn1.only, 'a device with no location shows neither');
ok((await feedAt(null, 'sydenham')).slides.some(x => x.title === 'Happy Birthday Syd!'), "a new device uses its link's location before it has checked in");
await as('tate@ama.test', () => db.exec(`delete from tv_party_bookings`));
await as('tate@ama.test', () => db.query(`delete from tv_slides where id in ($1, $2, $3)`, [ls1, sp, mp]));
// A location's own slideshow hours
{
  const today = (await db.query(`select extract(dow from ${syd})::int d`)).rows[0].d;
  const closed = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
  await as('tate@ama.test', () => db.query(`update tv_locations set hours = $1::jsonb where slug = 'sydenham'`, [JSON.stringify(closed)]));
  ok((await feedAt('syd-tv-0001', null)).quiet && !(await feedAt('mkv-tv-0001', null)).quiet, 'a location with its own hours goes quiet outside them; other locations keep the main hours');
  await as('tate@ama.test', () => db.query(`update tv_settings set quiet_on = true, quiet_days = $1::jsonb where id = 1`, [JSON.stringify(closed)]));
  await as('tate@ama.test', () => db.query(`update tv_locations set hours = $1::jsonb where slug = 'sydenham'`, [JSON.stringify({ ...closed, [today]: { on: '00:00', off: '23:59' } })]));
  ok(!(await feedAt('syd-tv-0001', null)).quiet && (await feedAt('mkv-tv-0001', null)).quiet, "a location's own hours are used instead of the main ones");
  await as('tate@ama.test', () => db.exec(`update tv_settings set quiet_on = false, quiet_days = null where id = 1; update tv_locations set hours = null`));
  ok(!(await feedAt('syd-tv-0001', null)).quiet, 'cleared, it goes back to the main hours');
  ok(!(await tryAs('remote@ama.test', `update tv_locations set hours = '{}'::jsonb where slug = 'sydenham'`)).n, 'only the editor changes location hours');
}
await db.exec(`delete from tv_screens where screen_id in ('syd-tv-0001', 'mkv-tv-0001')`);
ok(!(await tryAs('remote@ama.test', `insert into tv_locations (slug, name) values ('x1', 'X')`)).ok && (await tryAs('remote@ama.test', `select * from tv_locations`)).n === 5, 'everyone with TV access sees the locations; only the editor changes them');

console.log('\nScheduled screen-off times');
const nowD = (await db.query(`select extract(dow from ${syd})::int d, to_char(${syd} - interval '2 minutes', 'HH24:MI') a, to_char(${syd} + interval '30 minutes', 'HH24:MI') later`)).rows[0];
const setOffs = async offs => as('tate@ama.test', () => db.query(`update tv_settings set offs = $1::jsonb where id = 1`, [JSON.stringify(offs)]));
await setOffs([{ days: [nowD.d], at: nowD.a, minutes: 10, for: 'all' }]);
let fo = await feedNow();
ok(fo.quiet && fo.off === true && fo.slides.length === 0, 'a scheduled off time turns the screen off');
await setOffs([{ days: [(nowD.d + 1) % 7], at: nowD.a, minutes: 10, for: 'all' }, { days: [nowD.d], at: nowD.later, minutes: 10, for: 'all' }]);
ok(!(await feedNow()).quiet, 'other days and later times leave it on');
await setOffs([{ days: [nowD.d], at: nowD.a, minutes: 1, for: 'all' }]);
ok(!(await feedNow()).quiet, 'it comes back on after the minutes are up');
await as(null, () => db.query(`select tv_checkin($1, 'off-syd-001', 'x', now(), '{}'::jsonb, 'sydenham')`, [code]));
await setOffs([{ days: [nowD.d], at: nowD.a, minutes: 10, for: 'loc:sydenham' }]);
ok((await feedAt('off-syd-001', null)).off === true && !(await feedNow()).quiet, 'it can be for one location only');
await setOffs([{ days: [nowD.d], at: nowD.a, minutes: 10, for: 'dev:off-syd-001' }]);
ok((await feedAt('off-syd-001', null)).off === true && !(await feedAt('other-dev-01', 'sydenham')).quiet, 'or one device');
const op = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, party, theme) values ('text', 'Party in off time', true, 'party') returning id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`insert into tv_party_bookings (slide_id, starts_at, ends_at) values ($1, now() - interval '1 minute', now() + interval '1 hour')`, [op]));
ok((await feedAt('off-syd-001', null)).only === true, 'a party still shows');
await as('tate@ama.test', () => db.exec(`delete from tv_party_bookings`)); await as('tate@ama.test', () => db.query(`delete from tv_slides where id = $1`, [op]));
await setOffs([]); await db.exec(`delete from tv_screens where screen_id = 'off-syd-001'`);

console.log('\nSign-in mode');
await as('tate@ama.test', () => db.exec(`update tv_settings set signin_url = 'https://signin.example.com/ama', signin_idle = 45 where id = 2`));
const fsi = await feedOf(tab.screen_code);
ok(fsi.settings.signin === 'https://signin.example.com/ama' && fsi.settings.signin_idle === 45 && !(await feedNow()).settings.signin, 'the tablets get the sign-in page and how long to wait; the TV has none');
ok(!(await tryAs('tate@ama.test', `update tv_settings set signin_url = 'javascript:alert(1)' where id = 2`)).ok && !(await tryAs('tate@ama.test', `update tv_settings set signin_idle = 2 where id = 2`)).ok, 'only https links, and a sensible wait');
await as('tate@ama.test', () => db.exec(`update tv_settings set signin_url = null, signin_idle = 60 where id = 2`));

ok((await feedNow()).settings.battery_warn === 20, 'screens get the low battery level (20% to start)');
console.log('\nBlack out one device');
await as(null, () => db.query(`select tv_checkin($1, 'dark-dev-01', 'x', now(), '{}'::jsonb)`, [code]));
await as(null, () => db.query(`select tv_checkin($1, 'lit-dev-001', 'x', now(), '{}'::jsonb)`, [code]));
await as('remote@ama.test', () => db.query(`select tv_screen_blackout('dark-dev-01', true)`));
ok((await feedAt('dark-dev-01', null)).blackout === true && !(await feedAt('lit-dev-001', null)).blackout, 'one device can be blacked out on its own');
ok(!(await tryAs('nobody@ama.test', `select tv_screen_blackout('dark-dev-01', false)`)).ok, 'only people with TV access can');
await as('tate@ama.test', () => db.query(`select tv_screen_blackout('dark-dev-01', false)`));
ok(!(await feedAt('dark-dev-01', null)).blackout, 'and turn it back on');
await db.exec(`delete from tv_screens where screen_id in ('dark-dev-01', 'lit-dev-001'); update tv_settings set remote_until = null`);

console.log('\nRefresh reaches both FreeKiosk pages');
{ const ck = (st) => as(null, () => db.query(`select tv_checkin($1, 'fk-tablet-01', 'x', $2::timestamptz, '{}'::jsonb) r`, [code, st])).then(r => r.rows[0].r);
  const mainStart = '2026-10-28T06:40:00Z', saverStart = '2026-10-27T16:01:00Z';
  await ck(saverStart); await ck(mainStart);
  await as('tate@ama.test', () => db.exec(`update tv_settings set reload_at = now() where id = 1`));
  await db.exec(`select pg_sleep(0.01)`);
  // the two pages take turns checking in, as on a FreeKiosk tablet
  const r1 = await ck(mainStart), r2 = await ck(saverStart), r3 = await ck(mainStart);
  ok(r1.reload && r2.reload && r3.reload, 'Refresh reaches both pages of a FreeKiosk tablet, even while they take turns checking in');
  const fresh = await ck(new Date().toISOString());
  ok(!fresh.reload, '...and a page loaded after the refresh does not reload again');
  for (let i = 0; i < 9; i++) await ck(new Date(Date.now() + i * 1000).toISOString());
  ok((await db.query(`select (select count(*) from jsonb_object_keys(loads))::int n from tv_screens where screen_id = 'fk-tablet-01'`)).rows[0].n <= 6, '...and only the newest few page loads are kept');
  await db.exec(`delete from tv_screens where screen_id = 'fk-tablet-01'; update tv_settings set reload_at = null where id = 1`); }

console.log('\nSlide times of day');
const sy = (await db.query(`select to_char(now() at time zone 'Australia/Sydney', 'HH24:MI') t, extract(dow from now() at time zone 'Australia/Sydney')::int d`)).rows[0];
const hm = mins => { const [h, m] = sy.t.split(':').map(Number); const x = ((h * 60 + m + mins) % 1440 + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, show_from, show_to) values ('text', 'On now', $1, $2), ('text', 'Later on', $3, $4), ('text', 'From later', $3, null), ('text', 'Until earlier', null, $5)`,
  [hm(-60), hm(60), hm(60), hm(120), hm(-30)]));
await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, show_days) values ('text', 'Not today', $1), ('text', 'Today only', $2)`, [[0, 1, 2, 3, 4, 5, 6].filter(x => x !== sy.d), [sy.d]]));
let tnames = (await feedNow()).slides.map(x => x.title);
ok(tnames.includes('On now') && !tnames.includes('Later on'), `a slide shows only between its times (now ${sy.t})`);
ok(!tnames.includes('From later') && !tnames.includes('Until earlier'), 'just a start time, or just an end time, works too');
ok(tnames.includes('Today only') && !tnames.includes('Not today'), 'days of the week');
await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, show_from, show_to) values ('text', 'Overnight', $1, $2)`, [hm(-10), hm(-20)]));
ok((await feedNow()).slides.some(x => x.title === 'Overnight'), 'a window that runs past midnight (from after to) works');
await as('tate@ama.test', () => db.exec(`delete from tv_slides where title in ('On now', 'Later on', 'From later', 'Until earlier', 'Not today', 'Today only', 'Overnight')`));

console.log('\nBack to normal on one tablet');
await as(null, () => db.query(`select tv_checkin($1, 'front-tab-01', 'x', now(), '{}'::jsonb)`, [code]));
await as(null, () => db.query(`select tv_checkin($1, 'back-tab-001', 'x', now(), '{}'::jsonb)`, [code]));
const op2 = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, theme, party) values ('text', 'Happy birthday Sam', 'party', true) returning id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`update tv_settings set only_slide = $1, only_until = now() + interval '1 hour' where id = 1`, [op2]));
ok((await feedAt('front-tab-01', null)).only === true && (await feedAt('front-tab-01', null)).override_ok === false, 'party on; no staff code yet, so the tablet offers no override');
ok(!(await tryAs('remote@ama.test', `select tv_staff_code_set('1234')`)).ok, 'only the TV editor can set the staff code');
ok(!(await tryAs('tate@ama.test', `select tv_staff_code_set('12a')`)).ok, 'the staff code must be 4 to 8 digits');
await as('tate@ama.test', () => db.query(`select tv_staff_code_set('2468')`));
ok((await feedAt('front-tab-01', null)).override_ok === true, 'with a code set, the tablet offers it during a party');
ok((await tryAs('tate@ama.test', `select * from tv_staff_code`)).ok === false, 'nobody can read the code back');
ok((await as(null, () => db.query(`select tv_override($1, 'front-tab-01', '1111') r`, [code]))).rows[0].r.error === 'wrong', 'a wrong code is refused');
ok((await feedAt('front-tab-01', null)).only === true, '...and the party stays');
ok((await as(null, () => db.query(`select tv_override($1, 'front-tab-01', '2468') r`, [code]))).rows[0].r.ok === true, 'the right code is accepted');
let fa = await feedAt('front-tab-01', null), fb2 = await feedAt('back-tab-001', null);
ok(!fa.only && fa.override === true && fa.slides.length > 0 && fb2.only === true, 'just that tablet goes back to normal; the other keeps the party');
await as('tate@ama.test', () => db.query(`select tv_remote_send('blackout')`));
ok((await feedAt('front-tab-01', null)).blackout === true, 'a blackout started after the override still shows on it');
await as('tate@ama.test', () => db.query(`select tv_remote_send('wake')`));
await as('tate@ama.test', () => db.query(`update tv_settings set only_slide = null, only_until = null where id = 1`));
await as('tate@ama.test', () => db.query(`update tv_settings set only_slide = $1, only_until = now() + interval '1 hour' where id = 1`, [op2]));
ok((await feedAt('front-tab-01', null)).only === true, 'so does a party started after it');
await as('tate@ama.test', () => db.query(`update tv_settings set only_slide = null, only_until = null where id = 1`));
await as('tate@ama.test', () => db.query(`insert into tv_party_bookings (slide_id, starts_at, ends_at) values ($1, now() - interval '1 minute', now() + interval '1 hour')`, [op2]));
await db.exec(`update tv_screens set override_at = null, override_until = null`);
ok((await feedAt('front-tab-01', null)).only === true, 'a booked party is on');
ok(!(await tryAs('nobody@ama.test', `select tv_screen_normal('front-tab-01', true)`)).ok, 'only staff can use the editor button');
await as('remote@ama.test', () => db.query(`select tv_screen_normal('front-tab-01', true)`));
ok(!(await feedAt('front-tab-01', null)).only && (await feedAt('back-tab-001', null)).only === true, 'the editor button puts back just that tablet, even for a booked party');
await as('tate@ama.test', () => db.query(`select tv_screen_normal('front-tab-01', false)`));
ok((await feedAt('front-tab-01', null)).only === true, 'and can let it show the party again');
await db.exec(`delete from tv_party_bookings`);
await as('tate@ama.test', () => db.query(`select tv_remote_send('blackout')`));
await as(null, () => db.query(`select tv_override($1, 'front-tab-01', '2468')`, [code]));
ok(!(await feedAt('front-tab-01', null)).blackout && (await feedAt('back-tab-001', null)).blackout === true, 'the code also brings one tablet out of a blackout');
await as('tate@ama.test', () => db.query(`select tv_remote_send('wake')`));
for (let i = 0; i < 10; i++) await as(null, () => db.query(`select tv_override($1, 'back-tab-001', '0000')`, [code]));
ok((await as(null, () => db.query(`select tv_override($1, 'back-tab-001', '2468') r`, [code]))).rows[0].r.error === 'locked', '10 wrong tries lock it for a while, even with the right code');
ok((await as(null, () => db.query(`select tv_override('NOPE99', 'back-tab-001', '2468') r`))).rows[0].r.error === 'wrong_code', 'needs the screen code');
await as('tate@ama.test', () => db.query(`select tv_staff_code_set(null)`));
await db.exec(`delete from tv_screens where screen_id in ('front-tab-01', 'back-tab-001'); update tv_settings set remote_until = null`);
await as('tate@ama.test', () => db.query(`delete from tv_slides where id = $1`, [op2]));

console.log('\nSaving egress');
const full1 = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
const same1 = (await as(null, () => db.query(`select tv_feed($1, null, null, $2) f`, [code, full1.hash]))).rows[0].f;
ok(full1.hash && same1.same === true && JSON.stringify(same1).length < 80, `when nothing has changed the screen gets ${JSON.stringify(same1).length} bytes instead of ${JSON.stringify(full1).length}`);
await as('tate@ama.test', () => db.exec(`insert into tv_slides (kind, title) values ('text', 'Egress test')`));
const full2 = (await as(null, () => db.query(`select tv_feed($1, null, null, $2) f`, [code, full1.hash]))).rows[0].f;
ok(!full2.same && full2.slides.some(x => x.title === 'Egress test'), 'a change sends the whole thing again');
ok(!(await tryAs(null, `select tv_feed_full($1)`, [code])).ok, 'the inside part is not open to the public');
await as('tate@ama.test', () => db.exec(`delete from tv_slides where title = 'Egress test'`));

console.log('\nFiles');
const pol = (await db.query(`select policyname, roles::text r from pg_policies where tablename = 'objects' and policyname like 'tv files%'`)).rows;
ok(pol.length === 4 && pol.every(p => p.r.includes('authenticated') && !p.r.includes('anon')), 'only signed-in staff can add, change or remove TV files');

ok((await db.query(`select bool_and(relrowsecurity) r from pg_class where relname in ('tv_slides', 'tv_settings')`)).rows[0].r, 'row level security is on');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

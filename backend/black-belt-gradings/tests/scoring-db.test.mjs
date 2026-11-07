// Tests prep-update-25.sql: examiner scoring and report cards (database rules).
// Run: node tests/scoring-db.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CARD = process.env.CARD_REPO || join(here, '../../id-cards');
const read = p => readFileSync(p, 'utf8');
const db = new PGlite();
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };
const rows = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await rows(s, p))[0];
async function as(email, fn) {
  await db.exec(`set role authenticated`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })]);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false)`); }
}
async function fails(fn, name) { try { await fn(); ok(false, name + ' (no error)'); } catch { ok(true, name); } }

await db.exec(read(join(here, 'supabase-stub.sql')));
await db.exec(`insert into auth.users (email) values ('owner@ama.test')`);
for (const f of ['setup.sql', 'roles.sql', 'printed.sql']) await db.exec(read(join(CARD, 'supabase', f)));
await db.exec(read(join(here, '../supabase/prep-setup.sql')));
// pgcrypto stand-in (Supabase has it; PGlite here does not)
await db.exec(`create or replace function public.gen_random_bytes(n int) returns bytea language sql volatile as $$ select substring(decode(md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text), 'hex') from 1 for n) $$`);
// update 20 needs Supabase-only extensions (pg_cron, Vault)
for (let i = 1; i <= 22; i++) if (i !== 20) await db.exec(read(join(here, `../supabase/prep-update-${String(i).padStart(2, '0')}.sql`)));
const SQL = read(join(here, '../supabase/prep-update-25.sql'));
await db.exec(SQL); await db.exec(SQL);
ok(true, 'prep-update-25.sql runs twice');

const sheets = await rows(`select target_rank, categories, checks from prep_score_sheets`);
ok(sheets.length === 21, 'a score sheet for every grading from Probationary Black Belt to 5th Dan Level 5');
const sheet = t => sheets.find(s => s.target_rank === t);
const keys = t => sheet(t).categories.map(c => c.key);
ok(['Probationary Black Belt', '2nd Dan', '3rd Dan', '4th Dan', '5th Dan'].every(t => keys(t).includes('breaking')), 'breaking is on the PBB, 2nd, 3rd, 4th and 5th Dan sheets');
ok(sheets.filter(s => !['Probationary Black Belt', '2nd Dan', '3rd Dan', '4th Dan', '5th Dan'].includes(s.target_rank)).every(s => !s.categories.some(c => c.key === 'breaking')), '...and on no other sheet');
ok(sheet('Probationary Black Belt').checks.includes('Flexibility: side splits') && sheet('Probationary Black Belt').categories.find(c => c.key === 'patterns').items[0].includes('Taeguk 8'), 'Cho Dan Bo to PBB sheet: Taeguk 8 and side splits');
ok(sheet('2nd Dan').categories.find(c => c.key === 'sparring').items.some(i => /4 opponents/.test(i)), '2nd Dan sparring includes group sparring vs 4');
ok(sheets.every(s => s.categories.every(c => c.items.length > 0)), 'every category lists what is being scored');
ok(!sheets.some(s => JSON.stringify(s.categories).toLowerCase().includes('essay')), 'the essay is not scored here (it is tracked on its own)');

await db.exec(`insert into prep_roles (email, role) values ('ex1@ama.test','instructor'), ('ex2@ama.test','grading'), ('view@ama.test','viewer')`);
const ADMIN = 'owner@ama.test';
await as(ADMIN, () => db.exec(`insert into prep_students (full_name, certificate_name, belt_rank) values ('Alex Smith', 'Alexandra Smith', 'Probationary Black Belt');
  insert into prep_cycles (name, start_date, end_date, status, grading_date) values ('Dec 2026', current_date - 60, current_date + 10, 'active', current_date + 10);`));
const sid = (await one(`select student_id from prep_students`)).student_id, cid = (await one(`select cycle_id from prep_cycles`)).cycle_id;

console.log('\nScoring');
await as('ex1@ama.test', () => db.query(`insert into prep_scores (cycle_id, student_id, examiner, examiner_name, category, score, note) values ($1,$2,'someone-else@ama.test','Jo','patterns',8,'Sharp Koryo'),($1,$2,null,'Jo','sparring',7,null)`, [cid, sid]));
let s = await rows(`select examiner, category, score from prep_scores order by category`);
ok(s.length === 2 && s.every(x => x.examiner === 'ex1@ama.test'), 'an examiner\'s scores are always saved under their own login');
await as('ex2@ama.test', () => db.query(`insert into prep_scores (cycle_id, student_id, examiner_name, category, score) values ($1,$2,'Sam','patterns',9),($1,$2,'Sam','sparring',4)`, [cid, sid]));
await as('ex2@ama.test', () => db.query(`update prep_scores set score = 1 where examiner = 'ex1@ama.test'`));
ok((await one(`select score from prep_scores where examiner = 'ex1@ama.test' and category = 'patterns'`)).score == 8, 'an examiner cannot change another examiner\'s scores');
await as('ex2@ama.test', () => db.query(`update prep_scores set score = 5 where examiner = 'ex2@ama.test' and category = 'sparring'`));
ok((await one(`select score from prep_scores where examiner = 'ex2@ama.test' and category = 'sparring'`)).score == 5, '...but can change their own');
await fails(() => as('ex1@ama.test', () => db.query(`insert into prep_scores (cycle_id, student_id, category, score) values ($1,$2,'breaking',11)`, [cid, sid])), 'scores above 10 are refused');
await fails(() => as('view@ama.test', () => db.query(`insert into prep_scores (cycle_id, student_id, category, score) values ($1,$2,'breaking',5)`, [cid, sid])), 'a viewer cannot score');
ok((await as('view@ama.test', () => rows(`select * from prep_scores`))).length === 4, 'a viewer can see the scores');
const sum = await rows(`select category, average, examiners from prep_score_summary order by category`);
ok(sum.find(x => x.category === 'patterns').average == 8.5 && sum.find(x => x.category === 'sparring').average == 6 && sum[0].examiners == 2, 'summary averages each category across examiners');
await as('ex1@ama.test', () => db.query(`insert into prep_score_notes (cycle_id, student_id, examiner_name, strengths, work_on, checks) values ($1,$2,'Jo','Great spirit','Chamber the side kick', '{"Flexibility: side splits": true}')`, [cid, sid]));
ok((await one(`select examiner from prep_score_notes`)).examiner === 'ex1@ama.test', 'examiner comments are saved under their own login');

console.log('\nReport card');
await fails(() => as('ex1@ama.test', () => db.query(`insert into prep_report_cards (cycle_id, student_id, target_rank, outcome) values ($1,$2,'Probationary Black Belt','pass')`, [cid, sid])), 'an instructor cannot confirm the outcome');
await as('ex2@ama.test', () => db.query(`insert into prep_report_cards (cycle_id, student_id, target_rank, outcome, summary) values ($1,$2,'Probationary Black Belt','pass','Well done')`, [cid, sid]));
const rc = await one(`select token, confirmed_by from prep_report_cards`);
ok(rc.token.length === 16 && rc.confirmed_by === 'ex2@ama.test', 'grading staff confirm the outcome; a private 16-character link is made');
await db.exec(`set role anon`);
let card = (await one(`select prep_report_card($1) j`, [rc.token])).j;
await db.exec(`reset role`);
ok(card === null, 'the family link shows nothing until the report card is released');
await as('ex2@ama.test', () => db.query(`update prep_report_cards set released_at = now(), released_by = 'ex2@ama.test'`));
await db.exec(`set role anon`);
card = (await one(`select prep_report_card($1) j`, [rc.token])).j;
const nope = (await one(`select prep_report_card('notarealtoken123') j`)).j;
let anonRead = true; try { await db.query(`select * from prep_scores`); } catch { anonRead = false; }
await db.exec(`reset role`);
ok(card && card.name === 'Alexandra Smith' && card.target === 'Probationary Black Belt' && card.outcome === 'pass' && card.summary === 'Well done', 'released: the family sees the name on the certificate, the belt and the outcome');
const pat = card.categories.find(c => c.key === 'patterns');
ok(pat.score == 8.5 && pat.notes.includes('Sharp Koryo') && card.categories.length === sheet('Probationary Black Belt').categories.length, '...each category with the average score and examiner notes');
ok(card.checks.find(c => c.label === 'Flexibility: side splits').done === true && card.checks.find(c => /Meditation/.test(c.label)).done === false, '...the checks that were ticked');
ok(card.comments.length === 1 && card.comments[0].by === 'Jo' && card.comments[0].work_on === 'Chamber the side kick' && !JSON.stringify(card).includes('@ama.test'), '...examiner comments by name, never their login emails');
ok(nope === null, 'a made-up link shows nothing');
ok(!anonRead, 'the public cannot read scores directly');
const noRls = await rows(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'prep\\_%' and not c.relrowsecurity`);
ok(noRls.length === 0, 'every prep table has row level security on');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

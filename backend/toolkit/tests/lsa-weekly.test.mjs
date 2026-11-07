// The weekly long service awards helper (tools/lsa-weekly.py), with a made-up EFC that answers "enrolled between X and Y
// weeks ago" from a list of pretend members. Run: node tests/lsa-weekly.test.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '../tools/lsa-weekly.py');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

const dir = mkdtempSync(join(tmpdir(), 'lsa-'));
const LOG = join(dir, 'session.jsonl'), OUT = join(dir, 'out');
const TODAY = '2026-10-27';
const env = { ...process.env, LSA_LOG: LOG, LSA_OUT: OUT, LSA_TODAY: TODAY };
const run = (...a) => execFileSync('python3', [SCRIPT, ...a], { env, encoding: 'utf8' });
writeFileSync(LOG, '');

const MARR = 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58', SYD = '5af07764-95bc-4caf-b889-ba846e409dc5';
const T = new Date(TODAY + 'T00:00:00Z');
const D = s => new Date(s + 'T00:00:00Z');
// Pretend EFC members: enrolled dates and ages
const members = [
  { id: 'a1', ref: 'AU-023-101', first: 'Sam', last: 'Lee', enrolled: '2021-08-10', age: 12, loc: MARR },      // 5 years in Aug 2026: due
  { id: 'a2', ref: 'AU-023-102', first: 'Kim', last: 'Ng ', enrolled: '2017-02-14', age: 30, loc: MARR },     // 10 years in Feb 2027: leeway
  { id: 'a3', ref: 'AU-023-103', first: 'Jo', last: 'Park', enrolled: '2022-05-20', age: 9, loc: MARR },      // 5 years in May 2027: next year
  { id: 'a4', ref: 'AU-023-104', first: 'Old', last: 'Timer', enrolled: '2001-11-03', age: 60, loc: MARR },   // 25 years in Nov 2026
  { id: 'a5', ref: 'AU-023-105', first: 'Not', last: 'Yet', enrolled: '2023-03-01', age: 20, loc: MARR },     // 3.6 years: not in window
  { id: 'b1', ref: 'AU-256-201', first: 'Sydenham', last: 'Kid', enrolled: '2021-12-01', age: 10, loc: SYD },
  { id: 'c804b6eb-test', ref: 'AU-023-9', first: 'EFC', last: 'Test', enrolled: '2021-08-10', age: 30, loc: MARR }   // EFC's own test member
];
// 60 kids at Marrickville enrolled in early 2021 (5 years in early 2026): fills EFC's 50-row page
for (let i = 0; i < 60; i++) members.push({ id: 'k' + i, ref: 'AU-023-3' + String(i).padStart(2, '0'), first: 'Kid', last: String(i), enrolled: '2021-01-1' + (i % 9), age: 7 + (i % 5), loc: MARR });

let calls = 0, n = 0;
function efc(p) {
  calls++;
  const hi = new Date(T - p.enrolledWeeksFrom * 7 * 864e5), lo = new Date(T - p.enrolledWeeksTo * 7 * 864e5);
  return members.filter(m => m.loc === p.location && D(m.enrolled) >= lo && D(m.enrolled) <= hi && (p.ageFrom == null || (m.age >= p.ageFrom && m.age <= p.ageTo)))
    .slice(0, 50).map(m => ({ id: 'z' + m.id, member: { id: m.id, reference: m.ref, firstName: m.first, lastName: m.last, eMail: 'x@y.z', telephoneMobile: '0400', unpaidBalance: 0, medical: null } }));
}
// Run queries the way the scheduled task does: a tool call, then its result, in the session log
function ask(lines, saveBig) {
  for (const l of lines.split('\n').filter(Boolean)) {
    const p = JSON.parse(l), id = 'toolu_' + (++n);
    appendFileSync(LOG, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__Zapier__execute_zapier_read_action', input: { selected_api: 'EfcAquilaCLIAPI', action: 'custom_trigger', params: p } }] } }) + '\n');
    let text = JSON.stringify({ results: efc(p) });
    if (saveBig && text.length > 3000) {   // like Claude saving a large result to a file
      const f = join(dir, 'tool-results', `mcp-Zapier-execute_zapier_read_action-${n}.txt`);
      execFileSync('mkdir', ['-p', join(dir, 'tool-results')]); writeFileSync(f, text);
      text = `Output too large. Full output saved to: ${f}`;
    }
    appendFileSync(LOG, JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } }) + '\n');
  }
}

const first = run('plan');
ok(first.trim().split('\n').length === 40, 'plan: one query per school and milestone (5 schools x 8 milestones)');
const p0 = JSON.parse(first.split('\n')[0]);
ok(p0.status === 'Enrolled' && p0.enrolledWeeksFrom > 0 && p0.enrolledWeeksTo > p0.enrolledWeeksFrom, 'queries ask for enrolled members between two week counts');
ask(first, true);
let rounds = 0, more;
while ((more = run('more')).trim() && rounds < 6) { ask(more, true); rounds++; }
ok(rounds >= 2 && rounds < 6, `follow-up queries finish (${rounds} rounds, ${calls} queries in all)`);
ok(calls < 200, 'only asks for narrower bands where someone was found');
const out = run('collect');
const sql = readFileSync(join(OUT, 'lsa.sql'), 'utf8');
const rows = JSON.parse(sql.match(/\$j\$(.*)\$j\$/)[1]);
const by = Object.fromEntries(rows.map(r => [r.id, r]));
ok(sql.startsWith('select lsa_load($j$['), 'writes one lsa_load statement');
ok(by.a1 && by.a2 && by.a3 && by.a4 && by.b1, 'finds the people reaching 5, 10 and 25 years in the window, at both schools');
ok(!by.a5, 'leaves out someone who is not near a milestone');
ok(!by['c804b6eb-test'], "leaves out EFC's test member");
ok(Object.keys(by).filter(k => k.startsWith('k')).length === 60, 'all 60 kids are found even though EFC only returns 50 at a time (split by age)');
const within = (r, d) => D(r.from) <= D(d) && D(r.to) >= D(d);
ok(rows.every(r => within(r, members.find(m => m.id === r.id).enrolled)), "every person's date range contains their real enrolled date");
ok(rows.every(r => (D(r.to) - D(r.from)) / 864e5 <= 45) || rows.filter(r => (D(r.to) - D(r.from)) / 864e5 > 45).every(r => ['a1', 'a4', 'b1'].includes(r.id)), 'ranges are about a month or less (Apr-Dec is one band)');
ok((D(by.a2.to) - D(by.a2.from)) / 864e5 <= 45, 'someone in the leeway months is pinned to the month');
ok(by.a2.name === 'Kim Ng' && by.a1.loc === 'Marrickville' && by.b1.loc === 'Sydenham', 'name tidied and school from the reference');
ok(!/x@y\.z|0400|unpaid|medical/i.test(sql), 'keeps only names, school and dates (no contacts, balances or medical)');
ok(/Marrickville/.test(out), 'prints a summary per school');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

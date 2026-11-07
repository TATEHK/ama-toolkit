// Checks the "efc" Supabase function (EFC Aquila members from Zapier) with a pretend database.
// Run: node tests/efc-function.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(mkdtempSync(join(tmpdir(), 'efc-')), 'efc.mjs');
writeFileSync(tmp, readFileSync(join(here, '../supabase/functions/efc/index.ts'), 'utf8'));
const { handle, toRow } = await import(pathToFileURL(tmp).href);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

const tables = { efc_hook: [{ id: 1, secret: 's3cret' }], efc_members: [] };
const db = {
  from(t) {
    const f = []; let single = false;
    const q = {
      select() { return q; }, eq(c, v) { f.push(r => r[c] === v); return q; }, maybeSingle() { single = true; return q; },
      async upsert(rows) { for (const r of rows) { const i = tables[t].findIndex(x => x.member_key === r.member_key); if (i >= 0) tables[t][i] = r; else tables[t].push(r); } return { error: null }; },
      then(res) { const d = tables[t].filter(r => f.every(x => x(r))); return Promise.resolve({ data: single ? d[0] || null : d, error: null }).then(res); }
    };
    return q;
  }
};
const post = (body, qs = '?key=s3cret') => handle(new Request('https://x.test/functions/v1/efc' + qs, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }), db).then(async r => ({ status: r.status, ...(await r.json()) }));

console.log('Reading EFC fields');
let r = toRow({ 'First Name': 'Kian', 'Last Name': 'Lee', Mobile: '0412 345 678', 'Email Address': 'KIAN@x.test', Guardian: { 'First Name': 'Mei', 'Last Name': 'Lee', Mobile: '0400 111 222', Email: 'Mei@x.test' }, 'Member ID': 77 });
ok(r.full_name === 'Kian Lee' && r.phone === '0412 345 678' && r.email === 'kian@x.test' && r.member_key === 'efc:77', 'names, mobile, email and member ID are picked up whatever the field names look like');
ok(r.guardian_name === 'Mei Lee' && r.guardian_phone === '0400 111 222' && r.guardian_email === 'mei@x.test', 'parent details are picked up, including nested ones');
r = toRow({ name: 'Ava Brown', phone: '0411 000 000' }, 'lead');
ok(r.kind === 'lead' && r.member_key === 'n:ava brown|0411000000', 'with no member ID it is matched on name and phone');
ok(toRow({ phone: '1' }) === null, 'a record with no name is skipped');

console.log('\nWebhook');
ok((await post({ name: 'X' }, '')).status === 401 && (await post({ name: 'X' }, '?key=nope')).status === 401, 'the secret key is required');
r = await post({ 'First Name': 'Kian', 'Last Name': 'Lee', 'Member ID': 77, Mobile: '0412 345 678' });
ok(r.saved === 1 && tables.efc_members.length === 1, 'a member from Zapier is saved');
r = await post({ 'First Name': 'Kian', 'Last Name': 'Lee', 'Member ID': 77, Mobile: '0499 999 999' });
ok(tables.efc_members.length === 1 && tables.efc_members[0].phone === '0499 999 999', 'sending the same member again updates them');
r = await post({ members: [{ name: 'Ava Brown', mobile: '0411' }, { name: 'Noah Smith' }, { phone: '1', foo: 'bar' }] }, '?key=s3cret&kind=lead');
ok(r.saved === 2 && r.skipped === 1 && r.fields.includes('foo') && tables.efc_members.filter(m => m.kind === 'lead').length === 2, 'a list loads many at once and reports records it could not read');
r = await post('First+Name=Zoe&Last+Name=Tan');
ok(r.saved === 1 && tables.efc_members.some(m => m.full_name === 'Zoe Tan'), 'form-encoded posts work too');

console.log('\nWhat EFC actually sends (Member Query)');
const efc = { id: 'd93acafb79e1044ff2a88d265fb2b6c8', member: { id: '3d65d8b3-58e8', reference: 'AU-023-1', firstName: 'Ana', lastName: 'Test', dob: '2019-04-06',
  contactFirstName: 'Achy ', contactLastName: 'Test', eMail: 'parent@x.test', telephoneMobile: '+61482000000', attended: '2026-09-27', attendanceTotal: 18,
  status: 'Inactive', medical: 'asthma', allergies: 'nuts', overdueBalance: 96, notes: 'private' } };
r = toRow(efc);
ok(r.member_key === 'efc:3d65d8b3-58e8' && r.full_name === 'Ana Test' && r.guardian_name === 'Achy Test' && r.phone === '+61482000000' && r.email === 'parent@x.test', 'EFC member: real member ID, name, parent name, mobile and email');
ok(r.efc_reference === 'AU-023-1' && r.attendance_total === 18 && r.last_attended === '2026-09-27' && r.status === 'Inactive' && r.date_of_birth === '2019-04-06', 'reference, total classes, last attended, status and birthday');
ok(!JSON.stringify(r.raw).match(/asthma|nuts|96|private/), 'medical, allergies, money owed and notes are not kept');
const flat = { id: 'hash', member__id: 'M9', member__firstName: 'Liz', member__lastName: 'Mc', member__contactFirstName: 'Liz', member__contactLastName: 'Mc', member__telephoneMobile: '0400' };
r = toRow(flat);
ok(r.member_key === 'efc:M9' && r.full_name === 'Liz Mc' && r.guardian_name === null, 'Zapier-flattened fields work, and an adult who is their own contact has no separate parent');

const asm = { id: 'hash', member: { id: 'M7', firstName: 'Bo', lastName: 'Kim', contactFirstName: 'Jo', contactLastName: 'Kim', telephoneMobile: '+61400', age: 8 },
  programme: { name: 'Taekwondo' }, grade: { name: 'Cho Dan Bo', rank: 31 }, promoted: '2026-09-23', attended: 12, readyToPromote: false };
r = toRow(asm);
ok(r.member_key === 'efc:M7' && r.belt === 'Cho Dan Bo' && r.programme === 'Taekwondo' && r.promoted_on === '2026-09-23' && r.attended_since_promoted === 12 && r.ready_to_promote === false && r.last_attended === null, 'Assessment Query: belt, programme, last grading and classes since');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

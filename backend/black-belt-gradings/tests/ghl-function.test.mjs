// Checks the "ghl" Supabase function (texts through GoHighLevel) with a pretend database and a pretend GoHighLevel.
// Run: node tests/ghl-function.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(mkdtempSync(join(tmpdir(), 'ghl-')), 'ghl.mjs');
writeFileSync(tmp, readFileSync(join(here, '../supabase/functions/ghl/index.ts'), 'utf8'));
const { handle, phoneE164 } = await import(pathToFileURL(tmp).href);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// A pretend database: just what the function reads and writes
const tables = {
  prep_roles: [{ email: 'boss@ama.test', role: 'admin' }, { email: 'inst@ama.test', role: 'instructor' }, { email: 'view@ama.test', role: 'viewer' }],
  prep_students: [{ student_id: 'S1', full_name: 'Kian Lee', contact_phone: '0412 345 678', contact_email: 'lee@family.test' },
    { student_id: 'S2', full_name: 'Ava Brown', contact_phone: '', contact_email: null },
    { student_id: 'S3', full_name: 'Noah Smith', contact_phone: '+61 400 111 222', contact_email: null }],
  prep_messages: []
};
const db = {
  auth: { async getUser(t) { return { data: { user: t.startsWith('tok-') ? { email: t.slice(4) } : null } }; } },
  from(t) {
    const f = []; let single = false;
    const q = {
      select() { return q; }, eq(c, v) { f.push(r => r[c] === v); return q; }, maybeSingle() { single = true; return q; },
      async insert(row) { tables[t].push(row); return { error: null }; },
      then(res) { const d = tables[t].filter(r => f.every(x => x(r))); return Promise.resolve({ data: single ? d[0] || null : d, error: null }).then(res); }
    };
    return q;
  }
};
// A pretend GoHighLevel
const calls = []; let ghlDown = false;
const http = async (url, opts) => {
  const u = new URL(url); calls.push({ path: u.pathname, search: u.search, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
  const reply = (b, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(b) });
  if (ghlDown) return reply({ message: 'Invalid JWT' }, 401);
  if (u.pathname === '/contacts/search/duplicate') return reply({ contact: u.searchParams.get('number') === '+61412345678' ? { id: 'C-existing' } : null });
  if (u.pathname === '/contacts/') return reply({ contact: { id: 'C-new' } });
  if (u.pathname === '/conversations/messages') return reply({ conversationId: 'V1', messageId: 'M1' });
  return reply({ message: 'not found' }, 404);
};
const env = { GHL_TOKEN: 'pit-secret', GHL_LOCATION_ID: 'LOC1' };
const call = (email, body, e = env) => handle(new Request('https://x.test/functions/v1/ghl', { method: 'POST', headers: { authorization: email ? 'Bearer tok-' + email : '', 'content-type': 'application/json' }, body: JSON.stringify(body) }), db, e, http).then(async r => ({ status: r.status, ...(await r.json()) }));

console.log('Phone numbers');
ok(phoneE164('0412 345 678') === '+61412345678' && phoneE164('+61 400 111 222') === '+61400111222' && phoneE164('412345678') === '+61412345678', 'Australian mobiles become +61 numbers');
ok(phoneE164('') === null && phoneE164('12') === null, 'missing or short numbers are refused');

console.log('\nAccess');
ok((await call(null, { action: 'check' })).status === 401, 'you must be signed in');
ok((await call('stranger@ama.test', { action: 'check' })).status === 403, 'only Black Belt Gradings logins');
ok((await call('inst@ama.test', { action: 'check' })).ready === true, 'check says it is set up');
ok((await call('inst@ama.test', { action: 'check' }, {})).ready === false, '...and says when it is not');
ok((await call('inst@ama.test', { action: 'send', items: [{ student_id: 'S1', kind: 'not_ready', body: 'x' }] }, {})).status === 409, 'sending without the GoHighLevel secrets explains what to add');

console.log('\nSending');
let r = await call('boss@ama.test', { action: 'send', items: [
  { student_id: 'S1', cycle_id: 'CY', kind: 'congrats', body: 'Congratulations Kian!' },
  { student_id: 'S2', cycle_id: 'CY', kind: 'congrats', body: 'Congratulations Ava!' },
  { student_id: 'S3', cycle_id: 'CY', kind: 'congrats', body: 'Congratulations Noah!' }] });
ok(r.sent === 2 && r.results.find(x => x.student_id === 'S2').error === 'No mobile number', 'texts go to families with a mobile; others are reported');
const sends = calls.filter(c => c.path === '/conversations/messages');
ok(sends.length === 2 && sends[0].body.type === 'SMS' && sends[0].body.contactId === 'C-existing' && sends[0].body.message === 'Congratulations Kian!' && sends[0].headers.Authorization === 'Bearer pit-secret' && sends[0].headers.Version, 'an existing contact is found by mobile and texted');
const created = calls.find(c => c.path === '/contacts/');
ok(created && created.body.phone === '+61400111222' && created.body.locationId === 'LOC1' && created.body.firstName === 'Noah' && sends[1].body.contactId === 'C-new', 'a family not in GoHighLevel yet is added as a contact');
ok(tables.prep_messages.filter(m => m.status === 'sent').length === 2 && tables.prep_messages.some(m => m.student_id === 'S2' && m.status === 'failed') && tables.prep_messages.every(m => m.sent_by === 'boss@ama.test'), 'every text is logged, with who sent it');
r = await call('inst@ama.test', { action: 'send', items: [{ student_id: 'S1', kind: 'congrats', body: 'Hi' }, { student_id: 'S1', kind: 'not_ready', body: 'Keep going' }] });
ok(r.results[0].error.includes('cannot send') && r.results[1].ok, 'instructors can send not-ready messages and essay links, but not congratulations or invitations');
ghlDown = true;
r = await call('boss@ama.test', { action: 'send', items: [{ student_id: 'S1', kind: 'invite', body: 'Come grade' }] });
ok(!r.results[0].ok && /Invalid JWT/.test(r.results[0].error) && tables.prep_messages.at(-1).status === 'failed', 'a GoHighLevel error is reported and logged');
ghlDown = false;
const n0 = calls.length;
r = await call('boss@ama.test', { action: 'send', items: [{ student_id: 'S1', kind: 'invite', body: 'Come grade' }] }, { GHL_TEST: '1' });
ok(r.testing && r.sent === 1 && calls.length === n0 && tables.prep_messages.at(-1).status === 'test', 'test mode logs texts without sending them');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

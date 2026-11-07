// Tests the "hub" Edge Function (sign in with the AMA Admin Hub mobile and PIN) against stand-ins for
// Supabase and the hub's Apps Script. Run: node tests/hub-function.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(mkdtempSync(join(tmpdir(), 'hub-')), 'hub.mjs');
writeFileSync(tmp, readFileSync(join(here, '../supabase/functions/hub/index.ts'), 'utf8'));
const { handle, tokenMobile } = await import(pathToFileURL(tmp).href);
const { makeDb } = await import('./mock-db.mjs');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// A pretend hub, signing tokens the same shape as hubToken_ (base64 JSON "." signature)
// Apps Script's base64EncodeWebSafe keeps the = padding
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const staff = { '412345678': { name: 'Mark', role: 'admin', pin: '123456', active: true }, '498765432': { name: 'Jo', role: 'staff', pin: '654321', active: true } };
const hubCalls = [];
const hub = async b => {
  hubCalls.push(b.kind);
  if (b.kind === 'login') {
    const m = String(b.mobile).replace(/\D/g, '').slice(-9), s = staff[m];
    if (!s || s.pin !== b.pin) return { ok: false, error: 'Mobile or PIN not right.' };
    if (!s.active) return { ok: false, error: 'Access is switched off for this mobile. Ask Mark.' };
    return { ok: true, token: b64({ n: s.name, r: s.role, m, e: Date.now() + 3600e3 }) + '.sig', name: s.name, role: s.role };
  }
  if (b.kind === 'whoami') {
    const [body, sig] = String(b.token).split('.');
    if (sig !== 'sig') return { ok: false, error: 'signin' };
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    const s = staff[p.m];
    return s && s.active && p.e > Date.now() ? { ok: true, name: p.n, role: s.role } : { ok: false, error: 'signin' };
  }
  return { ok: false };
};

const db = makeDb();
await db.auth.admin.createUser({ email: 'mark@ama.test', password: 'password1' });
db._t.hub_logins = [{ email: 'mark@ama.test', mobile9: '412345678' }, { email: 'gone@ama.test', mobile9: '400000001' }];
staff['400000001'] = { name: 'Old', role: 'staff', pin: '111111', active: true };
const anon = { auth: { async verifyOtp({ type, token_hash }) {
  const m = /^hash-magiclink-(u\d+)-/.exec(token_hash);
  return type === 'magiclink' && m ? { data: { session: { access_token: 'access-' + m[1], refresh_token: 'refresh-' + m[1] } }, error: null } : { data: null, error: { message: 'bad code' } };
} } };
const findUser = async email => db._users.find(u => u.email === email) || null;
const call = async (body, method = 'POST') => {
  const res = await handle(new Request('https://x.test/functions/v1/hub', { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), { db, anon, hub, findUser });
  return { status: res.status, body: method === 'OPTIONS' ? null : await res.json() };
};

console.log('\nSign in with mobile and PIN');
let r = await call({ mobile: '0412 345 678', pin: '123456' });
ok(r.body.ok && r.body.session.access_token === 'access-u1' && r.body.session.refresh_token === 'refresh-u1', 'right mobile and PIN gives a Supabase session for the linked login');
ok(r.body.name === 'Mark' && r.body.role === 'admin' && r.body.email === 'mark@ama.test', 'reply names the person, hub role and linked login');
ok(hubCalls.join() === 'login', 'signing in is one trip to the hub (no second check of a token it just gave)');
const hubToken = r.body.hub_token;
ok(tokenMobile(hubToken) === '412345678', 'the mobile is read from the hub token');
r = await call({ mobile: '0412345678', pin: '000000' });
ok(!r.body.ok && r.body.error === 'Mobile or PIN not right.' && !r.body.session, "wrong PIN: the hub's message, no session");
r = await call({ mobile: '0412', pin: '1' });
ok(!r.body.ok && /mobile and PIN/.test(r.body.error), 'missing details are refused before asking the hub');
r = await call({ mobile: '0498765432', pin: '654321' });
const jo = 'hub-498765432@staff.amatoolkit.local';
ok(r.body.ok && r.body.created && r.body.email === jo && r.body.session, 'a first hub sign-in makes their AMA Toolkit login automatically and signs them in');
ok(db._users.find(u => u.email === jo).user_metadata.full_name === 'Jo' && db._t.hub_logins.some(x => x.email === jo && x.mobile9 === '498765432'), '...named from the hub and linked to their mobile');
ok(!db._t.prep_roles.some(x => x.email === jo) && !db._t.staff_permissions.some(x => x.email === jo), '...with no permissions until an admin gives them some');
r = await call({ mobile: '0498765432', pin: '654321' });
ok(r.body.ok && !r.body.created && db._users.filter(u => u.email === jo).length === 1, 'signing in again uses the same login (no duplicate)');
r = await call({ mobile: '0400000001', pin: '111111' });
ok(!r.body.ok && /no longer exists/.test(r.body.error), 'a link to a deleted login is explained');

console.log('\nHub tokens');
r = await call({ token: hubToken });
ok(r.body.ok && r.body.session.access_token === 'access-u1', 'a hub token from earlier signs in again');
r = await call({ token: hubToken.replace('.sig', '.forged') });
ok(!r.body.ok && !r.body.session, 'a forged hub token is refused');
const forged = b64({ n: 'Mark', r: 'admin', m: '412345678', e: Date.now() + 3600e3 }) + '.nope';
r = await call({ check: forged });
ok(r.body.ok === false, 'check: a token the hub did not sign is not good');
r = await call({ check: hubToken });
ok(r.body.ok === true, 'check: a good token is good');
staff['412345678'].active = false;
r = await call({ check: hubToken });
ok(r.body.ok === false, 'check: switched off in the hub means no longer good');
r = await call({ token: hubToken });
ok(!r.body.ok && !r.body.session, '...and the token can no longer sign in');
staff['412345678'].active = true;
const wrongSecret = async () => ({ ok: false, error: 'not authorised' });
const ws = await handle(new Request('https://x.test/', { method: 'POST', body: JSON.stringify({ check: hubToken }) }), { db, anon, hub: wrongSecret, findUser });
const wsb = await ws.json();
ok(ws.status === 502 && wsb.ok === false && wsb.error, 'check: a hub problem (wrong secret, hub down) is an error, so nobody is signed out');

console.log('\nOther');
r = await call({}, 'OPTIONS');
ok(r.status === 200, 'browser pre-check (CORS) is answered');
r = await call({}, 'GET');
ok(r.status === 405, 'only POST is accepted');
const broken = async () => { throw new Error('the hub address or secret is not set up yet (HUB_URL, HUB_SECRET)'); };
const res = await handle(new Request('https://x.test/', { method: 'POST', body: JSON.stringify({ mobile: '0412345678', pin: '123456' }) }), { db, anon, hub: broken, findUser });
const jb = await res.json();
ok(res.status === 500 && /HUB_URL/.test(jb.error), 'a missing hub address is explained');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

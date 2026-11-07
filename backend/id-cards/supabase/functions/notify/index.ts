// @ts-nocheck
// AMA ID Cards: sends phone notifications (web push) to staff who turned them on in the app.
//
// Deploy in Supabase: Edge Functions > Deploy a new function > Via Editor, name it "notify",
// paste this whole file, Deploy. Then turn OFF "Enforce JWT verification" for the function.
//
// It is called by:
//   - the database, when a print job needs approval or fails (see supabase/notifications.sql)
//   - the app, to get the public key (?init) and to send a test (?test, signed-in users only)
//   - the app, for admins adding or removing logins (?users)

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SUBJECT = 'https://theggatonklenner.github.io/ama-id-cards/';
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false }
});
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// ---- WEBPUSH START (plain Web Crypto, no libraries) ----
const enc = new TextEncoder();
function b64u(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function ub64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}
async function makeVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64u(pub), privateJwk: jwk };
}
async function vapidHeader(endpoint, publicKey, privateJwk, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${publicKey}`;
}
// Encrypts the message for one phone (RFC 8291, aes128gcm)
async function encryptPayload(sub, payload) {
  const uaPublic = ub64u(sub.keys.p256dh);
  const authSecret = ub64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(enc.encode(payload), new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}
async function sendPush(sub, message, vapid) {
  const body = await encryptPayload(sub, JSON.stringify(message));
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': await vapidHeader(sub.endpoint, vapid.publicKey, vapid.privateJwk, vapid.subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
      'Urgency': 'high'
    },
    body
  });
}
// ---- WEBPUSH END ----

async function getConfig() {
  const { data, error } = await db.from('push_config').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  if (data && data.vapid_public && data.vapid_private_jwk) return data;
  const keys = await makeVapidKeys();
  const { data: saved, error: e2 } = await db.from('push_config')
    .upsert({ id: 1, vapid_public: keys.publicKey, vapid_private_jwk: keys.privateJwk })
    .select('*').single();
  if (e2) throw e2;
  return saved;
}

async function sendTo(subs, message, cfg) {
  const vapid = { publicKey: cfg.vapid_public, privateJwk: cfg.vapid_private_jwk, subject: SUBJECT };
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try {
      const res = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, message, vapid);
      if (res.status === 404 || res.status === 410) {
        await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint); // phone unsubscribed
      } else if (res.ok) sent++;
      else console.warn('Push refused', res.status, await res.text());
    } catch (e) { console.warn('Push failed', e); }
  }));
  return sent;
}

// ---- Admins adding and removing logins ----
// Tick-box permissions (supabase/permissions.sql); older databases still use one role per person.
const PERMS = ['admin', 'edit', 'delete', 'send', 'approve', 'viewer', 'printer'];
const ROLES = ['admin', 'approver', 'photos', 'viewer', 'printer'];
async function usesPermissions() {
  const { error } = await db.from('staff_permissions').select('email').limit(1);
  return !error;
}
async function isAdmin(email) {
  if (await usesPermissions()) {
    const { data } = await db.from('staff_permissions').select('permission').eq('email', email).eq('permission', 'admin').maybeSingle();
    return !!data;
  }
  const { data } = await db.from('staff_roles').select('role').eq('email', email).maybeSingle();
  return !!data && data.role === 'admin';
}
async function callerEmail(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await db.auth.getUser(token);
  return data && data.user && data.user.email ? data.user.email.toLowerCase() : null;
}
async function findUserByEmail(email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find(u => (u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}
async function manageUsers(req) {
  const me = await callerEmail(req);
  if (!me) return json({ error: 'Sign in first.' }, 401);
  if (!(await isAdmin(me))) return json({ error: 'Only admins can manage users.' }, 403);
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);

  if (body.action === 'create') {
    const role = ROLES.includes(body.role) ? body.role : 'viewer';
    const perms = Array.isArray(body.permissions) ? [...new Set(body.permissions.filter(p => PERMS.includes(p)))] : null;
    const password = String(body.password || '');
    const existing = await findUserByEmail(email);
    if (!existing) {
      if (password.length < 8) return json({ error: 'The password needs at least 8 characters.' }, 400);
      const { error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) return json({ error: error.message }, 400);
    } else if (password) {
      const { error } = await db.auth.admin.updateUserById(existing.id, { password });
      if (error) return json({ error: error.message }, 400);
    }
    if (await usesPermissions()) {
      // Set exactly the ticked permissions (add first, then remove, so an admin is never lost half way)
      const want = perms || [];
      if (want.length) {
        const { error } = await db.from('staff_permissions').upsert(want.map(permission => ({ email, permission })), { onConflict: 'email,permission', ignoreDuplicates: true });
        if (error) return json({ error: error.message }, 400);
      }
      const { data: have } = await db.from('staff_permissions').select('permission').eq('email', email);
      const drop = (have || []).map(r => r.permission).filter(p => !want.includes(p));
      if (drop.length) {
        const { error } = await db.from('staff_permissions').delete().eq('email', email).in('permission', drop);
        if (error) return json({ error: /admin/i.test(error.message) ? 'There must always be at least one admin.' : error.message }, 400);
      }
    } else {
      const { error: e2 } = await db.from('staff_roles').upsert({ email, role });
      if (e2) return json({ error: e2.message }, 400);
    }
    return json({ ok: true, existed: !!existing });
  }

  if (body.action === 'remove') {
    if (email === me) return json({ error: "You can't remove yourself." }, 400);
    if (await usesPermissions()) {
      const { error: e0 } = await db.from('staff_permissions').delete().eq('email', email);
      if (e0) return json({ error: /admin/i.test(e0.message) ? 'There must always be at least one admin.' : e0.message }, 400);
    }
    const { error: e1 } = await db.from('staff_roles').delete().eq('email', email);
    if (e1 && !/admin/i.test(e1.message)) return json({ error: e1.message }, 400);
    const user = await findUserByEmail(email);
    if (user) {
      await db.from('push_subscriptions').delete().eq('user_email', email);
      const { error } = await db.auth.admin.deleteUser(user.id);
      if (error) return json({ error: error.message }, 400);
    }
    return json({ ok: true });
  }
  return json({ error: 'Unknown action.' }, 400);
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = new URL(req.url);
    // User management works even if notifications have not been set up
    if (url.searchParams.has('users')) return await manageUsers(req);

    const cfg = await getConfig();
    if (url.searchParams.has('init')) return json({ publicKey: cfg.vapid_public });

    if (url.searchParams.has('test')) {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: u } = await db.auth.getUser(token);
      const email = u && u.user && u.user.email;
      if (!email) return json({ error: 'Sign in first.' }, 401);
      const { data: subs } = await db.from('push_subscriptions').select('*').eq('user_email', email);
      const sent = await sendTo(subs || [], { title: 'AMA ID Cards', body: 'Notifications are working.', tag: 'test', url: './' }, cfg);
      return json({ sent });
    }

    // Called by the database trigger
    if (req.headers.get('x-hook-secret') !== cfg.hook_secret) return json({ error: 'Not allowed' }, 403);
    const { kind, job } = await req.json();
    const n = job.card_count || 1;
    const cards = `${n} card${n === 1 ? '' : 's'}`;
    let message, column;
    if (kind === 'approval') {
      message = { title: 'Cards need approval', body: `${cards} waiting for your approval.`, tag: 'approval', url: './#queue' };
      column = 'wants_approvals';
    } else if (kind === 'failed') {
      message = { title: 'Print failed', body: `${cards} did not print. ${String(job.error || '').slice(0, 120)}`, tag: 'failed', url: './#queue' };
      column = 'wants_failures';
    } else if (kind === 'printed') {
      message = { title: 'Cards printed', body: `${cards} printed and ready to collect.`, tag: 'printed', url: './#queue' };
      column = 'wants_printed';
    } else if (kind === 'offline') {
      const w = job.count || 0;
      message = { title: 'Printer offline', body: `The print station has stopped. ${w} job${w === 1 ? '' : 's'} will print when it's back.`, tag: 'station', url: './#queue' };
      column = 'wants_station';
    } else if (kind === 'online') {
      const w = job.count || 0;
      message = { title: 'Printer back online', body: w ? `${w} job${w === 1 ? ' is' : 's are'} printing now.` : 'Ready to print.', tag: 'station', url: './#queue' };
      column = 'wants_station';
    } else return json({ ignored: true });

    let { data: subs } = await db.from('push_subscriptions').select('*').eq(column, true);
    subs = (subs || []).filter(s => !(kind === 'approval' && s.user_email && s.user_email === job.created_by_email));
    // Printer and approval alerts only go to people who can act on them
    if (kind !== 'printed') {
      let canPrint = null;
      const { data: perms, error: permErr } = await db.from('staff_permissions').select('email, permission').in('permission', ['admin', 'approve']);
      if (!permErr && perms) canPrint = new Set(perms.map(r => r.email));
      else {
        const { data: roles, error: rolesErr } = await db.from('staff_roles').select('email, role');
        if (!rolesErr && roles) canPrint = new Set(roles.filter(r => r.role === 'admin' || r.role === 'approver').map(r => r.email));
      }
      if (canPrint) subs = subs.filter(s => canPrint.has(String(s.user_email || '').toLowerCase()));
    }
    const sent = await sendTo(subs, message, cfg);
    return json({ sent });
  } catch (e) {
    console.error(e);
    return json({ error: String(e && e.message || e) }, 500);
  }
});

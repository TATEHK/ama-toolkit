// @ts-nocheck
// AMA Toolkit: cross-system auto-login ("SSO handoff").
//
// A trusted partner system (e.g. a coworker's booking/CRM system) can sign a short-lived link. When a person
// clicks it, this function verifies the link's signature with a SHARED SECRET, finds the AMA Toolkit login linked
// to that mobile (table hub_logins), and returns an ordinary Supabase session — so the person lands already
// signed in, with exactly the permissions they already have in AMA ID Cards, Black Belt Gradings and the TV.
//
// This mirrors the proven "hub" function: no JWT secret is shared, the partner never gets a Supabase session key,
// and the handoff is a one-time signed token that expires quickly and cannot be replayed.
//
// Deploy: Edge Functions > name it "sso", paste this file, Deploy, turn OFF JWT verification for it.
// Secrets (Edge Functions > Secrets):
//   SSO_SECRET   a long random string shared ONLY with the trusted partner system (used to sign/verify links).
//                Rotate by setting a new value here and on the partner; old links stop working immediately.
//   SSO_ISS      (optional) an allow-list of partner names, comma-separated. If set, the token's "iss" must match.
//
// The partner builds a token like:   <base64url(payloadJSON)>.<base64url(HMAC_SHA256(SSO_SECRET, payloadBytes))>
//   payloadJSON = { "m": "<mobile, last 9 digits>", "exp": <unix seconds>, "jti": "<random nonce>",
//                   "name": "<optional display name>", "iss": "<optional partner name>", "next": "<optional path>" }
// and sends the person to:   https://app.train-ama.com/sso/#token=<token>
//
// Requests to THIS function (POST, JSON):  { token }  ->  { ok, session:{access_token,refresh_token}, name, next, created }

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const last9 = v => String(v || '').replace(/\D/g, '').slice(-9);
const hubEmail = m => `hub-${m}@staff.amatoolkit.local`;
const randomPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');

const b64urlToBytes = s => {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Constant-time compare of two equal-length byte arrays
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return { error: 'This sign-in link is malformed.' };
  const [payloadB64, sigB64] = parts;
  const payloadBytes = b64urlToBytes(payloadB64);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, payloadBytes));
  const given = b64urlToBytes(sigB64);
  if (!timingSafeEqual(expected, given)) return { error: 'This sign-in link is not valid.' };
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(payloadBytes)); } catch { return { error: 'This sign-in link is not valid.' }; }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return { error: 'This sign-in link has expired. Ask for a new one.' };
  if (payload.exp > now + 15 * 60) return { error: 'This sign-in link is not valid.' };   // reject far-future expiry
  if (!payload.jti || String(payload.jti).length < 8) return { error: 'This sign-in link is not valid.' };
  return { payload };
}

// deps: { db (service role client), anon (anon client), findUser(email) }
export async function handle(req, deps, env) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405);
  try {
    const secret = env.SSO_SECRET;
    if (!secret) return json({ ok: false, error: 'SSO is not set up yet (SSO_SECRET missing).' }, 500);
    const body = await req.json().catch(() => ({}));
    const v = await verifyToken(body.token, secret);
    if (v.error) return json({ ok: false, error: v.error });
    const p = v.payload;

    // Optional partner allow-list
    const allow = (env.SSO_ISS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(String(p.iss || ''))) return json({ ok: false, error: 'This sign-in link is not from an allowed partner.' });

    const mobile9 = last9(p.m);
    if (mobile9.length !== 9) return json({ ok: false, error: 'This sign-in link is missing a valid mobile number.' });

    // Replay protection: each token's jti may be used once (table sso_used_jti). Expired rows are harmless.
    const expIso = new Date((p.exp + 60) * 1000).toISOString();
    const { error: je } = await deps.db.from('sso_used_jti').insert({ jti: String(p.jti), expires_at: expIso });
    if (je) {
      if (je.code === '23505') return json({ ok: false, error: 'This sign-in link has already been used. Ask for a new one.' });
      throw je;
    }

    // Find the linked login by mobile; auto-create a hub-only login with NO permissions if none exists.
    let { data: link, error: le } = await deps.db.from('hub_logins').select('email').eq('mobile9', mobile9).maybeSingle();
    if (le) throw le;
    let created = false;
    if (!link) {
      const email = hubEmail(mobile9);
      if (!(await deps.findUser(email))) {
        const { error: ce } = await deps.db.auth.admin.createUser({
          email, password: randomPassword(), email_confirm: true,
          user_metadata: { full_name: p.name || null, hub_only: true, created_via: 'sso', created_iss: p.iss || null }
        });
        if (ce) throw ce;
        created = true;
      }
      const { error: ue } = await deps.db.from('hub_logins').upsert(
        { email, mobile9, updated_at: new Date().toISOString(), updated_by: 'sso:' + (p.iss || 'partner') }, { onConflict: 'email' });
      if (ue) throw ue;
      link = { email };
    }

    const user = await deps.findUser(link.email);
    if (!user) return json({ ok: false, error: `The linked login (${link.email}) no longer exists. Ask an admin to fix it on the Staff logins page.` });

    // One-time magic link for that login, consumed here; nothing is emailed.
    const { data: gl, error: ge } = await deps.db.auth.admin.generateLink({ type: 'magiclink', email: link.email });
    if (ge) throw ge;
    const { data: s, error: ve } = await deps.anon.auth.verifyOtp({ type: 'magiclink', token_hash: gl.properties.hashed_token });
    if (ve || !s || !s.session) throw ve || new Error('No session');

    // next: only a safe same-site path is allowed (no absolute URLs / open redirect)
    let next = String(p.next || '');
    if (!/^\/[A-Za-z0-9_\-./]*$/.test(next)) next = '';
    return json({ ok: true, session: { access_token: s.session.access_token, refresh_token: s.session.refresh_token }, name: p.name || null, next, created });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: 'Sign-in failed: ' + String(e && e.message || e) }, 500);
  }
}

if (typeof Deno !== 'undefined') {
  const { createClient } = await import('npm:@supabase/supabase-js@2.45.4');
  const url = Deno.env.get('SUPABASE_URL');
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), opts);
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY'), opts);
  const findUser = async email => {
    for (let page = 1; page <= 50; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      const u = data.users.find(x => (x.email || '').toLowerCase() === email.toLowerCase());
      if (u) return u;
      if (data.users.length < 200) return null;
    }
    return null;
  };
  const env = { SSO_SECRET: Deno.env.get('SSO_SECRET'), SSO_ISS: Deno.env.get('SSO_ISS') };
  Deno.serve(req => handle(req, { db, anon, findUser }, env));
}

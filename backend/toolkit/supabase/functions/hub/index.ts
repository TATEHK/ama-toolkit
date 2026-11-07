// @ts-nocheck
// AMA Toolkit: sign in with the AMA Admin Hub mobile and PIN.
//
// The hub (Google Apps Script) stays the place where staff mobiles, PINs, lockouts and "Active" live.
// This function asks the hub whether a mobile and PIN (or a hub token) is good, then signs the person in to
// Supabase as the AMA Toolkit login linked to that mobile (table hub_logins, set on the Staff logins page).
// The result is an ordinary Supabase session, so every permission in AMA ID Cards, Black Belt Prep and the TV
// works as before. No JWT secret is copied anywhere.
//
// Deploy: Edge Functions > name it "hub", paste this file, Deploy, and turn OFF JWT verification for it.
// Secrets (Edge Functions > Secrets):
//   HUB_URL     the hub's Apps Script web app address (ends in /exec)
//   HUB_SECRET  the hub's shared secret (HOLD.secret in the Apps Script code)
//
// Requests (POST, JSON):
//   { mobile, pin }  sign in: returns { ok, session: { access_token, refresh_token }, hub_token, name, role }
//   { token }        sign in again with a hub token from earlier (same reply)
//   { check: token } is this hub token still good (unexpired, person still Active)? returns { ok }

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export const last9 = v => String(v || '').replace(/\D/g, '').slice(-9);

// The hub token is "<base64 JSON>.<signature>"; the JSON holds m (mobile, last 9 digits). Only read after the
// hub itself has said the token is good.
export function tokenMobile(token) {
  try {
    const b = String(token).split('.')[0].replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    return last9(JSON.parse(atob(b + '='.repeat((4 - b.length % 4) % 4))).m);
  } catch { return ''; }
}

// First hub sign-in with no AMA Toolkit login yet: one is made automatically (name from the hub, signs in with the hub
// mobile and PIN, no permissions until an admin gives them some on Staff logins). Same stand-in email as Staff logins.
export const hubEmail = m => `hub-${m}@staff.amatoolkit.local`;
const randomPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');

// deps: { db (service role client), anon (publishable/anon client), hub(body) -> hub reply, findUser(email) }
export async function handle(req, deps) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405);
  try {
    const body = await req.json().catch(() => ({}));

    if (body.check) {
      const who = await deps.hub({ kind: 'whoami', token: body.check });
      if (who && who.ok) return json({ ok: true });
      // Only a real "sign in again" from the hub signs people out; anything else (hub down, wrong secret) leaves them in
      if (who && who.error === 'signin') return json({ ok: false });
      return json({ ok: false, error: 'The hub could not be checked: ' + ((who && who.error) || 'no answer') }, 502);
    }

    let token = body.token, name = '', role = '';
    if (!token) {
      if (last9(body.mobile).length !== 9 || String(body.pin || '').replace(/\D/g, '').length < 4) return json({ ok: false, error: 'Enter your mobile and PIN.' });
      const r = await deps.hub({ kind: 'login', mobile: String(body.mobile), pin: String(body.pin) });
      if (!r || !r.ok) return json({ ok: false, error: (r && r.error) || 'Mobile or PIN not right.' });
      token = r.token; name = r.name; role = r.role;
    } else {
      // A token from earlier: confirm with the hub (signature, expiry, still Active). A token the hub has just
      // issued above needs no second trip to the hub (that made sign-in slow).
      const who = await deps.hub({ kind: 'whoami', token });
      if (!who || !who.ok) return json({ ok: false, error: 'Your hub sign-in has run out. Sign in again.' });
      name = who.name || name; role = who.role || role;
    }
    const mobile9 = tokenMobile(token);
    if (mobile9.length !== 9) return json({ ok: false, error: 'Your hub sign-in has run out. Sign in again.' });

    let { data: link, error: le } = await deps.db.from('hub_logins').select('email').eq('mobile9', mobile9).maybeSingle();
    if (le) throw le;
    let created = false;
    if (!link) {
      const email = hubEmail(mobile9);
      if (!(await deps.findUser(email))) {
        const { error: ce } = await deps.db.auth.admin.createUser({ email, password: randomPassword(), email_confirm: true, user_metadata: { full_name: name || null, hub_only: true } });
        if (ce) throw ce;
        created = true;
      }
      const { error: ue } = await deps.db.from('hub_logins').upsert({ email, mobile9, updated_at: new Date().toISOString(), updated_by: 'first hub sign-in' }, { onConflict: 'email' });
      if (ue) throw ue;
      link = { email };
    }
    const user = await deps.findUser(link.email);
    if (!user) return json({ ok: false, error: `The linked login (${link.email}) no longer exists. Ask an admin to fix it on the Staff logins page.`, name });

    // A one-time sign-in code for that login, used straight away here; nothing is emailed
    const { data: gl, error: ge } = await deps.db.auth.admin.generateLink({ type: 'magiclink', email: link.email });
    if (ge) throw ge;
    const { data: v, error: ve } = await deps.anon.auth.verifyOtp({ type: 'magiclink', token_hash: gl.properties.hashed_token });
    if (ve || !v || !v.session) throw ve || new Error('No session');
    return json({ ok: true, session: { access_token: v.session.access_token, refresh_token: v.session.refresh_token },
      hub_token: token, name, role, email: link.email, created });
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
  const HUB_URL = Deno.env.get('HUB_URL'), HUB_SECRET = Deno.env.get('HUB_SECRET');
  // Apps Script answers a POST with a redirect to the result; fetch follows it
  const hub = async b => {
    if (!HUB_URL || !HUB_SECRET) throw new Error('the hub address or secret is not set up yet (HUB_URL, HUB_SECRET)');
    const r = await fetch(HUB_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ...b, secret: HUB_SECRET }), redirect: 'follow' });
    const t = await r.text();
    try { return JSON.parse(t); } catch { throw new Error('the hub did not answer properly'); }
  };
  const findUser = async email => {
    for (let page = 1; page <= 50; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      const u = data.users.find(x => (x.email || '').toLowerCase() === email);
      if (u) return u;
      if (data.users.length < 200) return null;
    }
    return null;
  };
  Deno.serve(req => handle(req, { db, anon, hub, findUser }));
}

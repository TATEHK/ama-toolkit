// @ts-nocheck
// Black Belt Prep: sends texts to families through GoHighLevel (grading invitations, congratulations,
// "not ready yet" messages, essay links, polo order links). Staff choose who and check the wording in the app; this sends them
// one by one, finding (or adding) each family as a GoHighLevel contact by phone number, and logs every text.
//
// Deploy in Supabase: Edge Functions > Deploy a new function > Via Editor, name it "ghl", paste this whole file,
// Deploy, then turn OFF "Verify JWT" for it (it checks the signed-in person itself).
// Secrets (Edge Functions > Secrets):
//   GHL_TOKEN        a GoHighLevel Private Integration token (Settings > Private Integrations), with
//                    contacts read/write and conversations message write access
//   GHL_LOCATION_ID  the GoHighLevel sub-account (location) ID (Settings > Business Profile)
//   GHL_TEST         optional: "1" logs the texts without sending them (for trying it out)
//
// Actions (POST JSON):
//   { action: 'check' }                                   is it set up? (no texts sent)
//   { action: 'send', items: [{ student_id, cycle_id, kind, body }] }

const API = 'https://services.leadconnectorhq.com';
// Who may send each kind: Black Belt Gradings permissions (app_permissions 'bb', set on Staff logins). Admin can send everything.
const KINDS = { invite: ['texts'], congrats: ['texts'], not_ready: ['texts', 'readiness'], essay: ['readiness'], feedback: ['readiness', 'texts'], polo: ['polos', 'texts'] };
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (msg, status = 400) => json({ error: msg }, status);

// Australian numbers to international form: 0412 345 678 -> +61412345678
export function phoneE164(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : null;
  if (s.startsWith('61') && s.length >= 11) return '+' + s;
  if (s.startsWith('0') && s.length === 10) return '+61' + s.slice(1);
  if (s.length === 9 && s.startsWith('4')) return '+61' + s;
  return null;
}

export async function handle(req, db, env = {}, http = fetch) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = token ? await db.auth.getUser(token) : { data: null };
    const me = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
    if (!me) return fail('Sign in first.', 401);
    const { data: roleRows } = await db.from('app_permissions').select('perm').eq('email', me).eq('app', 'bb');
    const roles = (roleRows || []).map(r => r.perm);
    const may = kind => roles.includes('admin') || (KINDS[kind] || []).some(r => roles.includes(r));
    if (!roles.length) return fail('Your login cannot use Black Belt Gradings.', 403);

    const body = await req.json().catch(() => ({}));
    const ready = !!(env.GHL_TOKEN && env.GHL_LOCATION_ID), testing = env.GHL_TEST === '1';
    if (body.action === 'check') return json({ ready: ready || testing, testing });
    if (body.action !== 'send') return fail('Unknown action.');
    if (!ready && !testing) return fail('Texting is not set up yet: add GHL_TOKEN and GHL_LOCATION_ID in Supabase (Edge Functions > Secrets).', 409);
    const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    if (!items.length) return fail('No one to text.');

    const ghl = async (path, opts = {}, version = '2021-07-28') => {
      const r = await http(API + path, { ...opts, headers: { Authorization: 'Bearer ' + env.GHL_TOKEN, Version: version, Accept: 'application/json', 'Content-Type': 'application/json' } });
      const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) { /* not JSON */ }
      if (!r.ok) throw new Error(j.message ? [].concat(j.message).join(', ') : `GoHighLevel said ${r.status}`);
      return j;
    };
    // The family's contact: found by phone (or email); added if new
    const contactFor = async (s, phone) => {
      for (const [k, v] of [['number', phone], ['email', s.contact_email]]) {
        if (!v) continue;
        const r = await ghl(`/contacts/search/duplicate?locationId=${encodeURIComponent(env.GHL_LOCATION_ID)}&${k}=${encodeURIComponent(v)}`, { method: 'GET' });
        if (r.contact && r.contact.id) return r.contact.id;
      }
      const parts = String(s.full_name || '').trim().split(/\s+/);
      const r = await ghl('/contacts/', { method: 'POST', body: JSON.stringify({ locationId: env.GHL_LOCATION_ID, firstName: parts[0] || '', lastName: parts.slice(1).join(' '),
        phone, ...(s.contact_email ? { email: s.contact_email } : {}), tags: ['ama black belt prep'], source: 'Black Belt Prep' }) });
      return (r.contact || {}).id;
    };

    const results = [];
    for (const it of items) {
      const kind = String(it.kind || ''), text = String(it.body || '').trim();
      const out = { student_id: it.student_id, ok: false };
      results.push(out);
      if (!KINDS[kind]) { out.error = 'Unknown kind of message'; continue; }
      if (!may(kind)) { out.error = 'Your login cannot send this kind of message'; continue; }
      if (!text || text.length > 1000) { out.error = 'The message is empty or too long'; continue; }
      const { data: s } = await db.from('prep_students').select('student_id, full_name, contact_phone, contact_email').eq('student_id', it.student_id).maybeSingle();
      if (!s) { out.error = 'Student not found'; continue; }
      const phone = phoneE164(s.contact_phone);
      const log = async (status, extra = {}) => db.from('prep_messages').insert({ student_id: s.student_id, cycle_id: it.cycle_id || null, kind, to_phone: phone || s.contact_phone || null, body: text, status, sent_by: me, ...extra });
      if (!phone) { out.error = 'No mobile number'; await log('failed', { error: out.error }); continue; }
      if (testing && !ready) { out.ok = true; out.test = true; await log('test'); continue; }
      try {
        const cid = await contactFor(s, phone);
        if (!cid) throw new Error('Could not find or add the contact');
        const m = await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId: cid, message: text }) }, '2021-04-15');
        out.ok = true;
        await log('sent', { ghl_contact_id: cid, ghl_message_id: m.messageId || null });
      } catch (e) { out.error = String(e.message || e); await log('failed', { error: out.error.slice(0, 500) }); }
    }
    return json({ sent: results.filter(r => r.ok).length, results, testing: testing && !ready });
  } catch (e) {
    console.error(e);
    return fail(String(e && e.message || e), 500);
  }
}

if (typeof Deno !== 'undefined') {
  const { createClient } = await import('npm:@supabase/supabase-js@2.45.4');
  const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const env = { GHL_TOKEN: Deno.env.get('GHL_TOKEN'), GHL_LOCATION_ID: Deno.env.get('GHL_LOCATION_ID'), GHL_TEST: Deno.env.get('GHL_TEST') };
  Deno.serve(req => handle(req, db, env));
}

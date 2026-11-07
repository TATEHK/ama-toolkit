// @ts-nocheck
// AMA Toolkit: send the "share your memories" SMS for service awards, via GoHighLevel.
// For each ordered person it finds their GHL contact (by name) and texts them their /memories/ link.
//
// Deploy in Supabase, verify_jwt OFF (it checks the caller is a grading/instructor staff member itself).
// Secrets needed (shares the same ones as the other GoHighLevel functions):
//   GHL_TOKEN         a GoHighLevel Private Integration token (scopes: View Contacts, Edit Conversations Messages)
//                     (the old name GHL_API_TOKEN is still accepted as a fallback)
//   GHL_LOCATION_ID   the GHL location id
//
// POST (with the staff member's Supabase access token in Authorization):
//   { round }            text everyone with an un-sent link in that round
//   { token, phone }     test: text one link straight to a phone number (upserts a GHL contact)
//   { token }            text (or re-text) one real person their own link, and mark it sent
//   { note, name }       leave a note on that person's GoHighLevel contact (matched by name)
//
// Returns { sent, skipped: [{ name, why }] } for sends, or { ok } / { ok:false, why } for a note.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const GHL = 'https://services.leadconnectorhq.com';
const MEM_BASE = 'https://app.train-ama.com/memories/#';
const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (msg, status = 400) => json({ error: msg }, status);
function env(n) { const v = Deno.env.get(n); if (!v) throw new Error(`Missing secret ${n}`); return v; }
// The GoHighLevel token, under the name the other functions use (with the old name as a fallback).
function ghlToken() { const v = Deno.env.get('GHL_TOKEN') || Deno.env.get('GHL_API_TOKEN'); if (!v) throw new Error('Missing secret GHL_TOKEN'); return v; }

const smsText = (first, years, link) =>
  `Hi ${first}, congratulations on ${years} years at Australian Martial Arts! To celebrate, we'd love your favourite photos and videos from your time with us - upload them here: ${link}`;

// ---- GoHighLevel ----
async function ghl(path, method, version, body) {
  const res = await fetch(GHL + path, {
    method,
    headers: { Authorization: `Bearer ${ghlToken()}`, Version: version, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GHL ${res.status}: ${data.message || data.error || JSON.stringify(data).slice(0, 180)}`);
  return data;
}
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Find GHL contacts whose full name matches and who have a phone number.
async function contactsByName(name) {
  const d = await ghl(`/contacts/?locationId=${encodeURIComponent(env('GHL_LOCATION_ID'))}&query=${encodeURIComponent(name)}`, 'GET', '2021-07-28');
  return (d.contacts || []).filter(c => norm(`${c.firstName || ''} ${c.lastName || ''}`) === norm(name) && c.phone);
}
async function contactByPhone(phone) {
  const d = await ghl('/contacts/upsert', 'POST', '2021-07-28', { locationId: env('GHL_LOCATION_ID'), phone });
  return (d.contact && d.contact.id) || d.id || (d.contact && d.contact.contactId);
}
async function sendSms(contactId, message) {
  return ghl('/conversations/messages', 'POST', '2021-04-15', { type: 'SMS', contactId, message });
}

// Send one person's link. Returns {ok} or {ok:false, why}. markSent=false for test sends,
// so testing to your own phone doesn't mark a real person's link as already sent.
async function sendOne(row, phoneOverride, markSent = true) {
  const first = String(row.person_name || '').split(' ')[0] || 'there';
  const link = MEM_BASE + row.token;
  let contactId;
  if (phoneOverride) {
    contactId = await contactByPhone(phoneOverride);
    if (!contactId) return { ok: false, why: 'could not create a GHL contact for that number' };
  } else {
    const m = await contactsByName(row.person_name);
    if (!m.length) return { ok: false, why: 'no GHL contact with a phone matched this name' };
    if (m.length > 1) return { ok: false, why: `${m.length} GHL contacts match this name` };
    contactId = m[0].id;
  }
  await sendSms(contactId, smsText(first, row.years, link));
  if (markSent) await db.from('lsa_memory_tokens').update({ sms_sent_at: new Date().toISOString(), sms_status: 'sent' }).eq('token', row.token);
  return { ok: true };
}

export async function handle(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  try {
    // Caller must be a signed-in grading/instructor staff member.
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = jwt ? await db.auth.getUser(jwt) : { data: null };
    const me = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
    if (!me) return fail('Sign in first.', 401);
    const { data: roles } = await db.from('prep_roles').select('role').eq('email', me);
    if (!(roles || []).some(r => ['instructor', 'grading', 'admin'].includes(r.role))) return fail('You need grading or instructor access to send these.', 403);

    const b = await req.json().catch(() => ({}));

    // Test: one link straight to a phone number.
    if (b.token && b.phone) {
      const { data: row } = await db.from('lsa_memory_tokens').select('token, person_name, years').eq('token', String(b.token).trim()).maybeSingle();
      if (!row) return fail('That upload link was not found.', 404);
      const r = await sendOne(row, String(b.phone).trim(), false);
      return r.ok ? json({ sent: 1, skipped: [] }) : json({ sent: 0, skipped: [{ name: row.person_name, why: r.why }] });
    }

    // One real person, from their profile: send (or re-send) their own link and mark it sent.
    if (b.token) {
      const { data: row } = await db.from('lsa_memory_tokens').select('token, person_name, years').eq('token', String(b.token).trim()).maybeSingle();
      if (!row) return fail('That upload link was not found.', 404);
      try { const r = await sendOne(row, null, true); return r.ok ? json({ sent: 1, skipped: [] }) : json({ sent: 0, skipped: [{ name: row.person_name, why: r.why }] }); }
      catch (e) { return json({ sent: 0, skipped: [{ name: row.person_name, why: String(e && e.message || e) }] }); }
    }

    // Leave a note on a person's GoHighLevel contact (member notes live on their GHL profile).
    if (b.note && b.name) {
      const body = String(b.note).trim().slice(0, 5000);
      if (!body) return fail('The note is empty.');
      const m = await contactsByName(String(b.name));
      if (!m.length) return json({ ok: false, why: 'No GoHighLevel contact with a phone matched this name — add the note by hand.' });
      if (m.length > 1) return json({ ok: false, why: `${m.length} GoHighLevel contacts match this name — add the note by hand.` });
      await ghl('/contacts/' + m[0].id + '/notes', 'POST', '2021-07-28', { body });
      return json({ ok: true });
    }

    // Round: everyone with an un-sent link in that round.
    const round = parseInt(b.round, 10);
    if (!round) return fail('Pass { round } or { token, phone }.');
    const { data: rows, error } = await db.from('lsa_memory_tokens').select('token, person_name, years').eq('round', round).is('sms_sent_at', null);
    if (error) throw error;

    let sent = 0; const skipped = [];
    for (const row of rows || []) {
      try {
        const r = await sendOne(row);
        if (r.ok) sent++; else { skipped.push({ name: row.person_name, why: r.why }); await db.from('lsa_memory_tokens').update({ sms_status: 'skipped: ' + r.why }).eq('token', row.token); }
      } catch (e) {
        skipped.push({ name: row.person_name, why: String(e && e.message || e) });
      }
    }
    return json({ sent, skipped });
  } catch (e) {
    console.error(e);
    return fail(String(e && e.message || e), 500);
  }
}

Deno.serve(handle);

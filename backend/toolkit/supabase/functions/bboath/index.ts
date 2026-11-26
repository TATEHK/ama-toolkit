// @ts-nocheck
// AMA Toolkit: the digital Black Belt Oath (bb-oath-1.sql).
//
// Everyone who passes to Probationary Black Belt on a black belt grading day gets an emailed link to a private signing
// page (https://app.train-ama.com/grading/black-belt/oath/#<token>). They type their name after "I,", sign with a finger,
// and the date fills in. The signed oath is saved in public.bb_oath with the signature PNG in the private "bb-oath"
// bucket, keyed to the member (member_key). Mark's hub (AMA OS) reads it through the ama_os_app login.
//
// Deploy: Edge Functions > "bboath", JWT verification OFF (the signing page is opened by people who aren't signed in;
// staff actions check who is signed in; cb's FINISHED reply calls 'send' with the service role key).
// Emails go to the student's own EFC email only.
// Uses the same GoHighLevel secrets as "cb": GHL_TOKEN, GHL_LOCATION_ID, optional GHL_TEST = "1" (log, don't send).
//
// Requests (POST, JSON):
//   { action: 'info', token }                         signing page: who, and whether it's already signed (no sign-in)
//   { action: 'sign', token, name, signature }        signing page: save it. signature = data:image/png;base64,... (no sign-in)
//   { action: 'prepare', day_id }                     staff or cron: make a signing link for each Probationary Black Belt pass
//   { action: 'preview', day_id }                     staff: who would be emailed, and the email itself (sends nothing)
//   { action: 'send', day_id }                        staff or cron: prepare, then email every unsent, unsigned link
//   { action: 'status', day_id }                      staff: passes, sent, signed
//   { action: 'resend', oath_id }                     staff: email one person's link again (not once signed)
// Staff = app_permissions 'cb' admin/results, or 'bb' admin/grading/results. Cron = x-cb-cron header (cb_cron_ok).

const API = 'https://services.leadconnectorhq.com';
const PAGE = 'https://app.train-ama.com/grading/black-belt/oath/#';
const RANK = 'Probationary Black Belt';
const OATH_VERSION = '2026-11';
const LOGO = 'https://www.australianmartialarts.com.au/wp-content/uploads/2019/12/logo1.png';
const MAX_PNG = 400 * 1024;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cb-cron',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (msg, status = 400) => json({ ok: false, error: msg }, status);
const tokenOk = t => /^[A-Za-z0-9_-]{16,64}$/.test(String(t || ''));
const newToken = () => { const b = crypto.getRandomValues(new Uint8Array(18)); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const first = n => String(n || '').trim().split(/\s+/)[0] || '';
const sydToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const longDate = ymd => { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const goodEmail = v => !!v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v));
const ageOf = dob => (typeof dob === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dob)) ? Math.floor((Date.now() - Date.parse(dob.slice(0, 10))) / 31557600000) : null;
export function phoneE164(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : null;
  if (s.startsWith('61') && s.length >= 11) return '+' + s;
  if (s.startsWith('0') && s.length === 10) return '+61' + s.slice(1);
  if (s.length === 9 && s.startsWith('4')) return '+61' + s;
  return null;
}

// Who gets the email: the student's own EFC email only (confirmed by Tate, Nov 2026).
export function recipientsFor(m) {
  return m && goodEmail(m.email) ? [String(m.email).trim().toLowerCase()] : [];
}

// A signature from the page: a PNG data URL, not empty, not huge. Returns the bytes or null.
export function pngBytes(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  let bin; try { bin = atob(m[1]); } catch (_) { return null; }
  if (bin.length < 200 || bin.length > MAX_PNG) return null;
  const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return sig.every((x, i) => b[i] === x) ? b : null;
}

export function cleanName(n) {
  const s = String(n || '').replace(/\s+/g, ' ').trim();
  return s.length >= 2 && s.length <= 80 && /\p{L}/u.test(s) ? s : null;
}

export function buildOathEmail(v) {
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gold = '#FFD200', night = '#0E0E0E', cream = '#F4F2EC', creamLine = '#E3DFD4';
  const subject = `Sign your Black Belt Oath, ${v.first}`;
  const intro = v.self
    ? `Congratulations on passing your grading to Probationary Black Belt. The last step is to sign the AMA Black Belt Oath. It takes a minute on your phone.`
    : `Congratulations to ${v.first} on passing their grading to Probationary Black Belt. The last step is for ${v.first} to sign the AMA Black Belt Oath. It takes a minute on a phone.`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&display=swap');body{margin:0;padding:0;background:#E9E6DE;}@media (max-width:620px){.wrap{width:100%!important;}.pad{padding-left:22px!important;padding-right:22px!important;}}</style></head>
<body style="margin:0;padding:0;background:#E9E6DE;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9E6DE;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:4px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#1c1c1c;">
  <tr><td style="background:${night};padding:26px 40px 22px;" align="center">
    <img src="${LOGO}" width="72" alt="Australian Martial Arts Academy" style="display:block;width:72px;height:auto;border:0;margin:0 auto;">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-weight:600;font-size:15px;letter-spacing:4px;color:#FFFFFF;padding-top:12px;text-transform:uppercase;">Australian Martial Arts Academy</div>
    <div style="font-weight:bold;font-size:10px;letter-spacing:3px;color:${gold};padding-top:6px;">Sydney &middot; Since 1982</div></td></tr>
  <tr><td class="pad" style="background:${night};padding:8px 32px 28px;border-top:1px solid #222;">
    <div style="color:${gold};font-size:12px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;padding-top:16px;">Black Belt Oath</div>
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;color:#ffffff;font-weight:700;font-size:36px;line-height:1.05;text-transform:uppercase;margin-top:8px;">One last step.</div></td></tr>
  <tr><td class="pad" style="padding:30px 32px 6px;">
    <p style="margin:0;font-size:16px;line-height:1.55;color:#333;">Hi ${esc(v.greet)},</p>
    <p style="margin:12px 0 0;font-size:16px;line-height:1.55;color:#333;">${esc(intro)}</p></td></tr>
  <tr><td class="pad" align="center" style="padding:24px 32px 6px;">
    <a href="${esc(v.link)}" style="display:inline-block;background:${night};color:${gold};text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:15px;letter-spacing:1px;padding:14px 30px;border-radius:8px;text-transform:uppercase;">Sign the oath</a></td></tr>
  <tr><td class="pad" style="padding:10px 32px 28px;font-size:12px;line-height:1.5;color:#777;" align="center">Button not working? Copy this into your browser:<br><span style="color:#333;word-break:break-all;">${esc(v.link)}</span></td></tr>
  <tr><td style="background:${night};padding:18px 32px;font-size:12px;color:#aaa;" align="center">Australian Martial Arts Academy &middot; (02) 9569 1943</td></tr>
</table></td></tr></table></body></html>`;
  const text = `Hi ${v.greet},\n\n${intro}\n\nSign here: ${v.link}\n\nAustralian Martial Arts Academy`;
  return { subject, html, text };
}

export async function handle(req, db, env = {}, http = fetch) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  let body = {}; try { body = await req.json(); } catch (_) { return fail('Bad request.'); }
  const bad = 'This link isn\'t valid. Please ask the front desk for a new one.';

  try {
    // ---- Signing page (no sign-in) ----
    if (body.action === 'info' || body.action === 'sign') {
      if (!tokenOk(body.token)) return fail(bad, 404);
      const { data: o } = await db.from('bb_oath').select('oath_id, member_key, efc_reference, full_name, rank, grading_date, name, signature_png, signed_at, signed_date').eq('token', body.token).maybeSingle();
      if (!o) return fail(bad, 404);
      const done = !!o.signed_at;
      const info = { ok: true, first: first(o.full_name), full_name: o.full_name, rank: o.rank, grading_date: o.grading_date, today: sydToday(), signed: done,
        ...(done ? { name: o.name, signed_date: o.signed_date, signature: o.signature_png } : {}) };
      if (body.action === 'info') return json(info);
      if (done) return json({ ...info, ok: false, error: 'This oath has already been signed.' }, 409);
      const name = cleanName(body.name);
      if (!name) return fail('Please write your full name after "I,".');
      const png = pngBytes(body.signature);
      if (!png) return fail('Please sign in the box before you submit.');
      const ref = String(o.efc_reference || o.member_key).replace(/[^A-Za-z0-9-]+/g, '-');
      const path = `${o.grading_date || sydToday()}/${ref}-${o.oath_id.slice(0, 8)}.png`;
      const { error: ue } = await db.storage.from('bb-oath').upload(path, png, { contentType: 'image/png', upsert: true });
      if (ue) throw ue;
      const signed_date = sydToday();
      const { data: upd, error: we } = await db.from('bb_oath').update({ name, signature_path: path, signature_png: body.signature, signed_at: new Date().toISOString(), signed_date,
        oath_version: OATH_VERSION, signed_ua: String(req.headers.get('user-agent') || '').slice(0, 200) }).eq('oath_id', o.oath_id).is('signed_at', null).select('oath_id');
      if (we) throw we;
      if (!upd || !upd.length) return json({ ...info, ok: false, error: 'This oath has already been signed.' }, 409);
      return json({ ok: true, signed: true, first: info.first, rank: o.rank, name, signed_date, signature: body.signature });
    }

    // ---- Staff / cron ----
    let actor = null;
    const cronHdr = req.headers.get('x-cb-cron');
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (env.SERVICE_KEY && bearer && bearer === env.SERVICE_KEY) {
      actor = 'automatic';   // cb's FINISHED reply handler
    } else if (cronHdr) {
      const { data: okCron } = await db.rpc('cb_cron_ok', { p_secret: cronHdr });
      if (okCron !== true) return fail('Not allowed.', 403);
      actor = 'automatic';
    } else {
      const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: who } = jwt ? await db.auth.getUser(jwt) : { data: null };
      const me = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
      if (!me) return fail('Sign in first.', 401);
      // Coloured Belts admin/results, or Black Belt Gradings admin/grading/results (the prep system's Oaths screen)
      const { data: pr } = await db.from('app_permissions').select('app, perm').eq('email', me).in('app', ['cb', 'bb']);
      const ok = (pr || []).some(r => (r.app === 'cb' && ['admin', 'results'].includes(r.perm)) || (r.app === 'bb' && ['admin', 'grading', 'results'].includes(r.perm)));
      if (!ok) return fail('You need grading results access for this.', 403);
      actor = me;
    }
    if (body.action === 'preview' && actor === 'automatic') return fail('Not allowed.', 403);

    let one = null;   // resend: a single oath, looked up by its id; its day is the day
    if (body.action === 'resend') {
      if (!/^[0-9a-f-]{36}$/i.test(String(body.oath_id || ''))) return fail('Which oath?');
      const { data: o1 } = await db.from('bb_oath').select('oath_id, day_id, signed_at').eq('oath_id', body.oath_id).maybeSingle();
      if (!o1) return fail('That oath wasn\'t found.', 404);
      if (o1.signed_at) return fail('They have already signed.');
      if (!o1.day_id) return fail('That oath isn\'t linked to a grading day.');
      one = o1; body.day_id = o1.day_id;
    }
    const dayId = String(body.day_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(dayId)) return fail('Which grading day?');
    const { data: d } = await db.from('cb_days').select('day_id, bb, grading_date, location, prep_cycle_id, closed').eq('day_id', dayId).maybeSingle();
    if (!d) return fail('That grading day wasn\'t found.', 404);
    if (!d.bb) return fail('That isn\'t a black belt grading.');

    const passes = async () => {
      const { data: es, error } = await db.from('cb_entries').select('entry_id, member_key, full_name, belt_to, result').eq('day_id', dayId).eq('belt_to', RANK).eq('result', 'pass');
      if (error) throw error;
      return (es || []).filter(e => e.member_key);
    };
    const prepare = async () => {
      const es = await passes();
      if (!es.length) return 0;
      const keys = es.map(e => e.member_key);
      const { data: ms } = await db.from('efc_members').select('member_key, efc_reference, full_name').in('member_key', keys);
      const byKey = Object.fromEntries((ms || []).map(m => [m.member_key, m]));
      const rows = es.map(e => ({ member_key: e.member_key, efc_reference: (byKey[e.member_key] || {}).efc_reference || null, full_name: e.full_name || (byKey[e.member_key] || {}).full_name || null,
        rank: RANK, entry_id: e.entry_id, day_id: dayId, prep_cycle_id: d.prep_cycle_id, grading_date: d.grading_date, token: newToken() }));
      const { data: ins, error } = await db.from('bb_oath').upsert(rows, { onConflict: 'member_key,day_id', ignoreDuplicates: true }).select('oath_id');
      if (error) throw error;
      return (ins || []).length;
    };
    const pending = async () => {
      let qy = db.from('bb_oath').select('oath_id, member_key, full_name, token, sent_at, signed_at').eq('day_id', dayId).is('signed_at', null);
      qy = one ? qy.eq('oath_id', one.oath_id) : qy.is('sent_at', null);
      const { data: os, error } = await qy;
      if (error) throw error;
      const keys = (os || []).map(o => o.member_key);
      const { data: ms } = keys.length ? await db.from('efc_members').select('member_key, full_name, email, phone, date_of_birth').in('member_key', keys) : { data: [] };
      const byKey = Object.fromEntries((ms || []).map(m => [m.member_key, m]));
      return (os || []).map(o => {
        const m = byKey[o.member_key] || null;
        const age = m ? ageOf(m.date_of_birth) : null, self = age != null && age >= 18;
        const to = recipientsFor(m);
        const mail = buildOathEmail({ first: first(o.full_name), self, greet: first(o.full_name), link: PAGE + o.token });
        return { o, m, to, mail };
      });
    };

    if (body.action === 'status') {
      const es = await passes();
      const { data: os } = await db.from('bb_oath').select('member_key, full_name, sent_at, sent_to, send_error, signed_at, name').eq('day_id', dayId);
      return json({ ok: true, day: { date: d.grading_date, location: d.location, closed: d.closed }, passed: es.length, oaths: os || [] });
    }
    if (body.action === 'prepare') return json({ ok: true, created: await prepare() });
    if (body.action === 'preview') {
      const created = await prepare();
      const list = await pending();
      return json({ ok: true, created, count: list.length, recipients: list.map(x => ({ name: x.o.full_name, to: x.to })), sample: list[0] ? list[0].mail : null });
    }
    if (body.action === 'send' || body.action === 'resend') {
      const created = one ? 0 : await prepare();
      const list = await pending();
      const ghl = async (path, opts = {}, version = '2021-07-28') => {
        const r = await http(API + path, { ...opts, headers: { Authorization: 'Bearer ' + env.GHL_TOKEN, Version: version, Accept: 'application/json', 'Content-Type': 'application/json' } });
        const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (_) { /* not JSON */ }
        if (!r.ok) throw new Error(j.message ? [].concat(j.message).join(', ') : `GoHighLevel said ${r.status}`);
        return j;
      };
      const contactFor = async (name, email, phone) => {
        for (const [k, v] of [['email', email], ['number', phone]]) {
          if (!v) continue;
          const r = await ghl(`/contacts/search/duplicate?locationId=${encodeURIComponent(env.GHL_LOCATION_ID)}&${k}=${encodeURIComponent(v)}`, { method: 'GET' });
          if (r.contact && r.contact.id) return r.contact.id;
        }
        const parts = String(name || '').trim().split(/\s+/);
        const r = await ghl('/contacts/', { method: 'POST', body: JSON.stringify({ locationId: env.GHL_LOCATION_ID, firstName: parts[0] || '', lastName: parts.slice(1).join(' '),
          email, ...(phone ? { phone } : {}), tags: ['ama black belt oath'], source: 'AMA black belt oath' }) });
        return (r.contact || {}).id;
      };
      const results = [];
      for (const x of list) {
        const r = { name: x.o.full_name, to: x.to, status: 'sent' };
        try {
          if (!x.to.length) throw new Error('No email address on their EFC record');
          for (const email of x.to) {
            if (env.GHL_TEST === '1') continue;
            const cid = await contactFor(x.o.full_name, email, phoneE164(x.m.phone));
            if (!cid) throw new Error('Could not find or add the GoHighLevel contact');
            await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'Email', contactId: cid, subject: x.mail.subject, html: x.mail.html, message: x.mail.text }) }, '2021-04-15');
          }
          await db.from('bb_oath').update({ sent_at: new Date().toISOString(), sent_to: x.to.join(', ') + (env.GHL_TEST === '1' ? ' (test mode, not sent)' : ''), send_error: null }).eq('oath_id', x.o.oath_id);
        } catch (er) {
          r.status = 'failed'; r.error = String(er.message || er).slice(0, 300);
          await db.from('bb_oath').update({ send_error: r.error }).eq('oath_id', x.o.oath_id);
        }
        results.push(r);
      }
      return json({ ok: true, created, sent: results.filter(r => r.status === 'sent').length, failed: results.filter(r => r.status === 'failed').length, results, by: actor });
    }
    return fail('Unknown action.');
  } catch (er) {
    console.error(er);
    return fail('Something went wrong. Please try again.', 500);
  }
}

if (typeof Deno !== 'undefined' && Deno.serve && import.meta.main) {
  const { createClient } = await import('npm:@supabase/supabase-js@2.45.4');
  const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const env = { GHL_TOKEN: Deno.env.get('GHL_TOKEN'), GHL_LOCATION_ID: Deno.env.get('GHL_LOCATION_ID'), GHL_TEST: Deno.env.get('GHL_TEST'), SERVICE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') };
  Deno.serve(req => handle(req, db, env));
}

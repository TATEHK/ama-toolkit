// @ts-nocheck
// Black Belt Prep: the grading-enrolment nurture sender (update 19 + 20).
//
// Deploy as an Edge Function named "nurture", with JWT verification OFF (it checks the caller itself).
// Secrets (Edge Functions > Secrets): the same GoHighLevel ones as the "ghl" function — GHL_TOKEN, GHL_LOCATION_ID,
// optional GHL_TEST="1" to log without sending. The scheduled job (prep-update-20.sql) POSTs { action: "run" } here
// every 15 minutes with the x-nurture-cron header, checked against a Vault secret via prep_nurture_cron_ok.
//
// Requests (POST, JSON):
//   { action: "run" }                      the scheduled job (needs the x-nurture-cron header): send everything due
//   { action: "test", step_code, phone?, email? }   staff: send one step to themselves with sample details
//   { action: "check" }                    staff: is GoHighLevel set up?
//
// Nothing sends unless a cycle has a started, un-paused run (prep_nurture_runs). Before every send the student is
// re-checked: paid or waived -> the enrolment track stops; stopped/skipped/paused -> skipped; not grading -> gone.
// Messages are logged in prep_nurture_log, unique per (cycle, student, step), so nothing is ever sent twice.

const API = 'https://services.leadconnectorhq.com';
const SITE = 'https://app.train-ama.com/';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-nurture-cron', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (m, s = 400) => json({ error: m }, s);

// Dates are handled as plain YYYY-MM-DD in Sydney time; messages have their own send_at time of day.
const sydParts = (now, opts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', ...opts }).format(now);
export const sydToday = now => sydParts(now, { year: 'numeric', month: '2-digit', day: '2-digit' });
export const sydTime = now => new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
export const addDays = (ymd, n) => { const d = new Date(String(ymd).slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(n || 0)); return d.toISOString().slice(0, 10); };
export const longDate = ymd => { if (!ymd) return ''; const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).replace(',', ''); };
export const timeReached = (sendAt, nowHHMM) => String(nowHHMM) >= String(sendAt || '00:00').slice(0, 5);
const first = n => String(n || '').trim().split(/\s+/)[0] || '';
export function phoneE164(p) { let s = String(p || '').replace(/[^\d+]/g, ''); if (!s) return null; if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : null; if (s.startsWith('61') && s.length >= 11) return '+' + s; if (s.startsWith('0') && s.length === 10) return '+61' + s.slice(1); if (s.length === 9 && s.startsWith('4')) return '+61' + s; return null; }

// A short url-safe essay token, the same shape as prep_essay_links makes (12 chars).
export const essayToken = () => { const b = crypto.getRandomValues(new Uint8Array(9)); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').slice(0, 12); };

// An adult (18 or over, or their own contact) gets the messages addressed to them, not written to a parent about them.
export function isAdult(s, now = Date.now()) {
  if (!s) return false;
  const dob = String(s.dob || s.date_of_birth || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(dob)) return (now - Date.parse(dob.slice(0, 10))) / 31557600000 >= 18;
  const c = String(s.contact_name || '').trim().toLowerCase().replace(/\s+/g, ' '), f = String(s.full_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return !!c && !!f && c === f;
}
// Rewrite a parent-facing black belt template into second person ("you"), before the fields are filled in.
export function adultBB(t) {
  const F = '{first_name}';
  const rules = [
    [/^Hi,$/m, 'Hi \u0000,'], [/^Hi! /, 'Hi \u0000! '], [/^Thanks! \{first_name\} is booked in/, "Thanks \u0000! You're booked in"],
    [/\{first_name\} has been marked on track for (\{belt\}) and is invited/g, "you've been marked on track for $1 and are invited"],
    [/\{first_name\} is invited to grade/g, "you're invited to grade"], [/\{first_name\} is booked in/g, "you're booked in"],
    [/Enrol \{first_name\} now:/g, 'Enrol now:'], [/Enrol \{first_name\}:/g, 'Enrol:'], [/Getting \{first_name\} ready for/g, 'Getting ready for'],
    [/the best preparation \{first_name\} can get, so please make sure they're there/g, "the best preparation you can get, so please make sure you're there"],
    [/\{first_name\} must attend — it's the best preparation they can get/g, "you must attend — it's the best preparation you can get"],
    [/\{first_name\} must be there/g, 'you must be there'], [/If \{first_name\} isn't enrolled yet/g, "If you're not enrolled yet"],
    [/How is \{first_name\} feeling/g, 'How are you feeling'], [/If you or \{first_name\} have any worries/g, 'If you have any worries'],
    [/What if \{first_name\} doesn't pass\?/g, "What if I don't pass?"], [/and \{first_name\} can grade again/g, 'and you can grade again'],
    [/Worried \{first_name\} isn't quite ready/g, "Worried you're not quite ready"], [/When do we need to enrol\?/g, 'When do I need to enrol?'],
    [/Can parents come\? Yes, parents are welcome to watch\./g, 'Can family come? Yes, family and friends are welcome to watch.'],
    [/Parents are welcome/g, 'Family and friends are welcome'], [/Parents: welcome/g, 'Family and friends: welcome'],
    [/\bTheir session time\b/g, 'Your session time'], [/\bThe session time\b/g, 'Your session time'],
    [/Good luck, \{first_name\}!/g, 'Good luck!'],
    [/\{first_name\}'s/g, 'your'], [/\{first_name\} is\b/g, 'you are'], [/\{first_name\} has\b/g, 'you have'],
  ];
  let out = String(t || '');
  // keep the greeting's {first_name}, rewrite the rest
  out = out.replace(/^(Hi \{first_name\}[,!]|Thanks \{first_name\}!)/, m => m.replace('{first_name}', '\u0000'));
  for (const [re, to] of rules) out = out.replace(re, to);
  out = out.replace(/\{first_name\}/g, 'you').replace(/\u0000/g, F);
  return out.replace(/(^|[.!?]\s+|\n-?\s*)(you|your)\b/g, (m, p, w) => p + w[0].toUpperCase() + w.slice(1));
}

// Fill a template. {essay} / {essay_bullet} appear only when the belt still needs an essay; the rest are plain fields.
// v.adult: the student is an adult, so the wording speaks to them ("you") rather than to a parent about them.
export function render(tpl, v, needsEssay) {
  const where = v.essay_link || (v.adult ? 'your personal link' : 'their personal link');
  const whose = v.adult ? 'your' : `${v.first_name}'s`;
  const essay = needsEssay ? `${v.adult ? 'Your' : whose} black belt essay is also due before grading. Submit it here: ${where}\n\n` : '';
  const bullet = needsEssay ? `\n- Essay: submit ${whose} black belt essay before grading — ${where}` : '';
  let out = (v.adult ? adultBB(tpl) : String(tpl || '')).replace(/\{essay\}/g, essay).replace(/\{essay_bullet\}/g, bullet);
  out = out.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : ''));
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const autolink = s => s.replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}" style="color:#0B6A35;">${u}</a>`);
const LOGO = 'https://www.australianmartialarts.com.au/wp-content/uploads/2019/12/logo1.png';
const HERO = 'https://www.australianmartialarts.com.au/wp-content/uploads/2026/09/Marrickville-Martial-Arts-Students-breaking-a-board-with-instructor.png';
// ---- Links as buttons (shared by every branded email) ----
const URL_RE = /(https?:\/\/[^\s<]+)/g;
const linkKind = u => /\/e\/#/.test(u) ? 'essay' : /\/b#/.test(u) ? 'primary' : 'secondary';
const linkLabel = (u, lead) => /\/e\/#/.test(u) ? 'Write the essay' : /\/b#/.test(u) ? (/enrol/i.test(lead) ? 'Enrol now' : 'View booking & time') : /instagram\.com/.test(u) ? 'Watch the highlights' : 'Open link';
const BTN_STYLE = { primary: ['#0E0E0E', '#FFD200', '#0E0E0E'], essay: ['#0B6A35', '#FFFFFF', '#0B6A35'], secondary: ['#FFFFFF', '#0E0E0E', '#0E0E0E'] };
export function emailButton(href, label, kind = 'primary') {
  const [bg, fg, bd] = BTN_STYLE[kind] || BTN_STYLE.primary;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 24px;"><tr><td align="center" bgcolor="${bg}" style="background:${bg};border:2px solid ${bd};border-radius:6px;mso-padding-alt:14px 28px;">`
    + `<a href="${esc(href)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:17px;font-weight:700;letter-spacing:1px;text-transform:uppercase;line-height:1;color:${fg};text-decoration:none;border-radius:6px;">${esc(label)}</a></td></tr></table>`;
}
const P_STYLE = 'margin:0 0 16px;font-size:16px;line-height:1.65;color:#2B2B2B;font-family:Arial,Helvetica,sans-serif;';
const para = t => t ? `<p style="${P_STYLE}">${esc(t).replace(/\n/g, '<br>')}</p>` : '';
const CTA = /^(enrol|book|pay|watch|view|submit|write|see|open)\b/i;
// One paragraph: plain text, or text followed by a button for its link. "Enrol Sam now: <link>" becomes just the button.
function blockHtml(block) {
  const urls = block.match(URL_RE);
  if (!urls) return para(block);
  const url = urls[urls.length - 1], kind = linkKind(url);
  let text = block.replace(URL_RE, '').replace(/[\s:—–-]+$/, '').trim();
  // The words right before the link ("Enrol Sam now", "Watch last grading's highlights") become the button label when they're a short call to action.
  const m = text.match(/(?:^|[.!?]\s+)([^.!?\n]+)$/), lead = m ? m[1].trim() : '';
  let label = linkLabel(url, text);
  if (kind !== 'essay' && lead && CTA.test(lead) && lead.split(/\s+/).length <= 6) { label = lead; text = text.slice(0, text.length - lead.length).trim(); }
  else if (text && !/[.!?]$/.test(text)) text = text.replace(/\s+(it\s+)?here$/i, ' $1below').replace(/\s+/g, ' ').replace(/\s*$/, '.');
  if (kind === 'essay') {
    text = text.replace(/\s*Submit it (below|here)\.?$/i, '').trim(); label = 'Write the essay';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;"><tr><td bgcolor="#F4F1E8" style="background:#F4F1E8;border-left:4px solid #FFD200;padding:20px 22px 2px;">`
      + `<div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:3px;color:#0B6A35;padding-bottom:8px;">BLACK BELT ESSAY</div>${para(text)}${emailButton(url, label, 'essay')}</td></tr></table>`;
  }
  return para(text) + emailButton(url, label, kind);
}
// A bullet with a link keeps its text and gets a short bold link instead of the raw address.
const bulletLink = l => esc(l).replace(/[\s:—–-]*(https?:\/\/[^\s<]+)/g, (m, u) => {
  const t = /\/e\/#/.test(u) ? 'Write the essay' : /\/b#/.test(u) ? 'View booking & time' : 'Open';
  return ` <a href="${u}" target="_blank" style="color:#0B6A35;font-weight:bold;text-decoration:none;white-space:nowrap;">${t}&nbsp;&rsaquo;</a>`;
});
// A branded AMA email: black header with the logo, the hero image, the message body, and the schools footer.
export function emailHtml(subject, body, adult = false) {
  const blocks = String(body || '').split(/\n{2,}/).map(block => {
    const lines = block.split('\n');
    if (lines.length && lines.every(l => /^\s*-\s+/.test(l))) {
      return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">' + lines.map(l => `<tr><td valign="top" style="color:#0B6A35;font-weight:bold;padding:2px 10px 2px 0;font-family:Arial,Helvetica,sans-serif;">&#8226;</td><td style="font-size:16px;line-height:1.55;color:#2B2B2B;padding:2px 0;font-family:Arial,Helvetica,sans-serif;">${bulletLink(l.replace(/^\s*-\s+/, ''))}</td></tr>`).join('') + '</table>';
    }
    return blockHtml(block);
  }).join('');
  const pre = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(subject)}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&display=swap');body{margin:0;padding:0;background:#E9E6DE;}a{color:#0B6A35;}@media (max-width:620px){.wrap{width:100%!important;}.pad{padding-left:24px!important;padding-right:24px!important;}.hero-title{font-size:34px!important;}}</style></head>
<body style="margin:0;padding:0;background:#E9E6DE;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(pre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#E9E6DE;"><tr><td align="center" style="padding:20px 10px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;">
  <tr><td align="center" style="background:#0E0E0E;padding:26px 40px 22px;">
    <img src="${LOGO}" width="72" alt="Australian Martial Arts Academy" style="display:block;width:72px;height:auto;border:0;">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-weight:600;font-size:15px;letter-spacing:4px;color:#FFFFFF;padding-top:12px;">AUSTRALIAN MARTIAL ARTS ACADEMY</div>
    <div style="font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:10px;letter-spacing:3px;color:#FFD200;padding-top:6px;">SYDNEY &middot; SINCE 1982</div></td></tr>
  <tr><td style="padding:0;"><img src="${HERO}" width="600" alt="A student breaking a board with her instructor at AMA" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
  ${subject ? `<tr><td class="pad" style="background:#0E0E0E;padding:26px 40px 30px;">
    <div style="font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:12px;letter-spacing:3px;color:#FFD200;">AUSTRALIAN MARTIAL ARTS</div>
    <div class="hero-title" style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-weight:700;font-size:38px;line-height:1.05;text-transform:uppercase;color:#FFFFFF;padding-top:10px;">${esc(subject)}</div></td></tr>` : ''}
  <tr><td class="pad" style="padding:34px 40px 8px;">${blocks}</td></tr>
  <tr><td class="pad" style="background:#0E0E0E;padding:30px 40px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:13px;letter-spacing:3px;color:#FFD200;">MARRICKVILLE &middot; SYDENHAM &middot; CONCORD &middot; AUBURN &middot; SYLVANIA</div>
    <div style="height:1px;background:#2A2A2A;margin:16px 0;line-height:1px;font-size:1px;">&nbsp;</div>
    <div style="font-size:11px;line-height:1.6;color:#8A8A8A;"><a href="https://www.australianmartialarts.com.au" style="color:#8A8A8A;">australianmartialarts.com.au</a> &middot; 02 9569 1943<br>You're receiving this about ${adult ? 'your' : "your child's"} black belt grading at Australian Martial Arts Academy.</div></td></tr>
</table></td></tr></table></body></html>`;
}

// 4th Dan & Beyond grading: a bespoke invitation email with its own design and its own grading day.
// The HTML lives in the prep_nurture_steps row 'enrol_invite_4dan' (so it can be edited); here we fill the
// fields and, when the belt needs no essay, drop the essay block delimited by <!--ESSAY--> ... <!--/ESSAY-->.
const FOURTH_DAN_VENUE = 'AMA Sydenham';
export const bb4thPlus = b => /^(4|5|6|7|8|9|10)(st|nd|rd|th)\s+Dan/.test(String(b || ''));
export const stripEssay = (html, keep) => keep ? String(html || '').replace(/<!--\/?ESSAY-->/g, '') : String(html || '').replace(/<!--ESSAY-->[\s\S]*?<!--\/ESSAY-->/g, '');
export function fill4dan(body, v, needsEssay) {
  const map = { first_name: v.first_name, course_date: v.grading_date, venue: FOURTH_DAN_VENUE, link: v.link, essay_link: v.essay_link };
  return stripEssay(body, needsEssay).replace(/\{(\w+)\}/g, (m, k) => (map[k] != null ? map[k] : ''));
}

// The grading helper invitation (prep-update-27). Going for 4th Dan exactly = their sword is presented at the grading they help at.
export const helperDay = slots => { const ds = [...new Set((slots || []).map(x => String(x.grading_date || '').slice(0, 10)).filter(Boolean))]; return ds.length === 1 ? longDate(ds[0]) : ''; };
export const swordLine = target => /^4th Dan$/.test(String(target || '').trim()) ? " You'll be presented your 4th Dan sword in front of everyone at the grading you help at." : '';
export function helperInvite({ first_name, target, slots }) {
  const day = helperDay(slots), nums = slots.length === 1 ? 'Reply 1' : `Reply ${slots.slice(0, -1).map((_, i) => i + 1).join(', ')} or ${slots.length}`;
  return `Hi ${first_name}, we'd love your help at the black belt grading${day ? ' on ' + day : ''} at AMA Sydenham.${swordLine(target)} Which session can you help at?\n${slots.map((x, i) => `${i + 1}. ${x.label}`).join('\n')}\n${nums} to choose. - AMA`;
}

export async function handle(req, db, env = {}, http = fetch) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  const ready = !!(env.GHL_TOKEN && env.GHL_LOCATION_ID), testing = env.GHL_TEST === '1';

  const ghl = async (path, opts = {}, version = '2021-07-28') => {
    const r = await http(API + path, { ...opts, headers: { Authorization: 'Bearer ' + env.GHL_TOKEN, Version: version, Accept: 'application/json', 'Content-Type': 'application/json' } });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error(j.message ? [].concat(j.message).join(', ') : `GoHighLevel said ${r.status}`);
    return j;
  };
  const contactFor = async m => {
    const phone = phoneE164(m.phone);
    for (const [k, v] of [['number', phone], ['email', m.email]]) {
      if (!v) continue;
      const r = await ghl(`/contacts/search/duplicate?locationId=${encodeURIComponent(env.GHL_LOCATION_ID)}&${k}=${encodeURIComponent(v)}`, { method: 'GET' });
      if (r.contact && r.contact.id) return r.contact.id;
    }
    const parts = String(m.full_name || '').trim().split(/\s+/);
    const r = await ghl('/contacts/', { method: 'POST', body: JSON.stringify({ locationId: env.GHL_LOCATION_ID, firstName: parts[0] || '', lastName: parts.slice(1).join(' '), ...(phone ? { phone } : {}), ...(m.email ? { email: m.email } : {}), tags: ['black belt grading'], source: 'Black belt grading enrolment' }) });
    return (r.contact || {}).id;
  };
  const sendSms = async (cid, text) => { const r = await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId: cid, message: text }) }, '2021-04-15'); return r.messageId || r.id || null; };
  const sendEmail = async (cid, subject, text, html) => { const r = await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'Email', contactId: cid, subject, html: html || emailHtml(subject, text), message: text }) }, '2021-04-15'); return r.messageId || r.id || null; };
  // Supabase returns at most 1,000 rows per request: read big tables in pages, or rows past 1,000 are silently missing
  // (that once made the sender think messages hadn't gone, and resend them every run).
  const allRows = async (build, size = 1000) => {
    const out = [];
    for (let from = 0; ; from += size) {
      const { data, error } = await build().range(from, from + size - 1);
      if (error) throw new Error(error.message || String(error));
      out.push(...(data || []));
      if (!data || data.length < size) return out;
    }
  };

  try {
    const raw = await req.text();
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) { /* not JSON */ }

    if (body.action === 'check') return json({ ready: ready || testing, testing });

    // ---- Staff: send one step to themselves, with sample details, to proof it ----
    if (body.action === 'test') {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: who } = token ? await db.auth.getUser(token) : { data: null };
      const me = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
      if (!me) return fail('Sign in first.', 401);
      const { data: roleRows } = await db.from('prep_roles').select('role').eq('email', me);
      const roles = (roleRows || []).map(r => r.role);
      if (!roles.some(r => ['admin', 'grading'].includes(r))) return fail('Your login cannot send test messages.', 403);
      const { data: step } = await db.from('prep_nurture_steps').select('*').eq('code', String(body.step_code || '')).maybeSingle();
      if (!step) return fail('Unknown step.', 404);
      if (step.channel === 'call') return json({ ok: true, skipped: 'This step is the phone call, nothing to send.' });
      const { data: cs } = await db.from('prep_settings').select('prep_session_date').eq('id', 1).maybeSingle();
      const sample = { first_name: 'Sam', name: 'Sam Lee', belt: '1st Dan Black Belt', current_belt: 'Probationary Black Belt', grading_date: longDate('2026-12-05'), link: SITE + 'b#sampletoken', prep_time: '10:30am to 12:30pm', essay_link: SITE + 'e/#sampleessay' };
      const text = render(step.body, sample, true), subject = step.subject ? render(step.subject, sample, true) : '[test]';
      if (!(ready || testing)) return fail('GoHighLevel is not set up yet.', 409);
      const phone = phoneE164(body.phone), email = body.email || null;
      if (step.channel === 'email' && !email) return fail('No email to send the test to.');
      if (step.channel === 'sms' && !phone) return fail('No mobile to send the test to.');
      if (testing && !ready) return json({ ok: true, test: true, subject, text });
      const cid = await contactFor({ full_name: 'AMA test', email, phone });
      if (step.channel === 'email') await sendEmail(cid, subject, text); else await sendSms(cid, text);
      return json({ ok: true, sent: true });
    }

    // ---- Staff: resend the grading invitation (Day 1 SMS + email) to one candidate now ----
    if (body.action === 'send_one') {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: who } = token ? await db.auth.getUser(token) : { data: null };
      const me = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
      if (!me) return fail('Sign in first.', 401);
      const { data: roleRows } = await db.from('prep_roles').select('role').eq('email', me);
      if (!(roleRows || []).some(r => ['admin', 'grading'].includes(r.role))) return fail('Your login cannot send invitations.', 403);
      if (!(ready || testing)) return fail('GoHighLevel is not set up yet.', 409);
      const cycle = String(body.cycle || '');
      let student_id = String(body.student_id || '');
      // If called from a booking entry (member_key), resolve the student via efc_members (reference) -> prep_students.
      if (!student_id && body.member_key) {
        const { data: m } = await db.from('efc_members').select('efc_reference').eq('member_key', String(body.member_key)).maybeSingle();
        if (m && m.efc_reference) { const { data: ps } = await db.from('prep_students').select('student_id').eq('efc_ref', m.efc_reference).maybeSingle(); student_id = (ps && ps.student_id) || ''; }
      }
      if (!cycle) return fail('Missing cycle.');
      if (!student_id) return fail('No linked student profile for this person.', 404);
      const { data: s } = await db.from('prep_students').select('student_id, full_name, belt_rank, efc_ref, contact_email, contact_phone, dob, contact_name').eq('student_id', student_id).maybeSingle();
      if (!s) return fail('Student not found.', 404);
      const { data: ov } = await db.from('prep_overview').select('grading_to').eq('cycle_id', cycle).eq('student_id', student_id).maybeSingle();
      const target = (ov && ov.grading_to) || s.belt_rank || '';
      const { data: cyc } = await db.from('prep_cycles').select('invite_link').eq('cycle_id', cycle).maybeSingle();
      const { data: tgroups } = await db.from('prep_time_groups').select('*');
      const prepTime = (tgroups || []).filter(g => (g.ranks || []).includes(target)).map(g => g.time_label).join(' and ');
      const { data: bdays } = await db.from('cb_days').select('day_id, grading_date').eq('prep_cycle_id', cycle).eq('bb', true);
      // The booking entry's member_key equals efc_members.member_key (which already includes the "efc:" prefix); the student's efc_ref is the EFC reference code, so map via efc_members.
      let efcMemberKey = null;
      let efcDob = null;
      if (s.efc_ref) { const { data: m } = await db.from('efc_members').select('member_key, date_of_birth').eq('efc_reference', s.efc_ref).maybeSingle(); efcMemberKey = m && m.member_key; efcDob = m && m.date_of_birth; }
      let ent = null, gradingYmd = null;
      if (bdays && bdays.length && efcMemberKey) {
        const { data: ers } = await db.from('cb_entries').select('belt_to, token, day_id').in('day_id', bdays.map(d => d.day_id)).eq('member_key', efcMemberKey);
        ent = (ers || []).find(e => e.belt_to === target) || (ers || [])[0] || null;
        const dayBy = Object.fromEntries(bdays.map(d => [d.day_id, d]));
        gradingYmd = ent ? (dayBy[ent.day_id] || {}).grading_date : null;
      }
      const link = ent && ent.token ? (SITE + 'b#' + ent.token) : ((cyc && cyc.invite_link) || '');
      const { data: eqs } = await db.from('prep_essay_questions').select('target_rank');
      const essayRanks = new Set((eqs || []).map(e => e.target_rank));
      const { data: ess } = await db.from('prep_essays').select('target_rank, status, token').eq('cycle_id', cycle).eq('student_id', student_id);
      const essRow = (ess || []).find(e => e.target_rank === target);
      const needsEssay = essayRanks.has(target) && !(essRow && ['submitted', 'reviewed'].includes(essRow.status));
      let essayLink = '';
      if (needsEssay) {
        let tok = essRow && essRow.token;
        if (!tok) { tok = essayToken(); await db.from('prep_essays').insert({ cycle_id: cycle, student_id, target_rank: target, token: tok }); }
        essayLink = SITE + 'e/#' + tok;
      }
      const vars = { first_name: first(s.full_name), name: s.full_name, belt: target, current_belt: s.belt_rank || '', grading_date: longDate(gradingYmd), link, prep_time: prepTime, essay_link: essayLink, adult: isAdult({ ...s, dob: s.dob || efcDob }) };
      // Essay-only resend: for someone already booked and paid, the only thing outstanding is the essay.
      // Send just the essay link (no enrolment/booking link). If their essay is already in, there is nothing to send.
      if (body.essay_only) {
        if (!needsEssay) return json({ ok: true, essay: false, skipped: 'No essay outstanding.' });
        const phone = phoneE164(s.contact_phone), email = s.contact_email;
        const cid = await contactFor({ full_name: s.full_name, email, phone });
        const whose = vars.adult ? 'your' : `${vars.first_name}'s`;
        const smsText = `Hi ${vars.first_name}, ${whose} black belt essay is still to come before grading${target ? ' for ' + target : ''}. Submit it here: ${essayLink} - AMA`;
        const emailBody = `${vars.adult ? 'Your' : vars.first_name + "'s"} black belt essay is still to come before grading${gradingYmd ? ' on ' + longDate(gradingYmd) : ''}.\n\nSubmit it here: ${essayLink}\n\nIf it's already on the way, you can ignore this.\n\nThanks,\nAustralian Martial Arts Academy`;
        const out = { sms: null, email: null, essay: true };
        if (!phone) out.sms = 'no mobile on file';
        else { try { if (!(testing && !ready)) await sendSms(cid, smsText); out.sms = 'sent'; } catch (e) { out.sms = String(e.message || e); } }
        if (!email) out.email = 'no email on file';
        else { try { if (!(testing && !ready)) await sendEmail(cid, vars.adult ? 'Your black belt essay' : `${vars.first_name}'s black belt essay`, emailBody, emailHtml(vars.adult ? 'Your black belt essay' : `${vars.first_name}'s black belt essay`, emailBody, vars.adult)); out.email = 'sent'; } catch (e) { out.email = String(e.message || e); } }
        return json({ ok: true, ...out });
      }
      const { data: steps } = await db.from('prep_nurture_steps').select('*').in('code', ['enrol_d1_sms', 'enrol_d1_email']);
      const bySms = (steps || []).find(x => x.code === 'enrol_d1_sms'), byEmail = (steps || []).find(x => x.code === 'enrol_d1_email');
      const phone = phoneE164(s.contact_phone), email = s.contact_email;
      const out = { sms: null, email: null, link: !!link };
      const cid = await contactFor({ full_name: s.full_name, email, phone });
      const logOne = async (code, channel) => { try { await db.from('prep_nurture_log').insert({ cycle_id: cycle, student_id, step_code: code, channel, status: 'sent' }); } catch (_) { /* already logged */ } };
      if (bySms) {
        if (!phone) out.sms = 'no mobile on file';
        else { try { const t = render(bySms.body, vars, needsEssay); if (!(testing && !ready)) await sendSms(cid, t); out.sms = 'sent'; await logOne('enrol_d1_sms', 'sms'); } catch (e) { out.sms = String(e.message || e); } }
      }
      if (byEmail) {
        if (!email) out.email = 'no email on file';
        else { try { const t = render(byEmail.body, vars, needsEssay); const subj = byEmail.subject ? render(byEmail.subject, vars, needsEssay) : 'Grading invitation'; if (!(testing && !ready)) await sendEmail(cid, subj, t, emailHtml(subj, t, vars.adult)); out.email = 'sent'; await logOne('enrol_d1_email', 'email'); } catch (e) { out.email = String(e.message || e); } }
      }
      return json({ ok: true, ...out });
    }

    // ---- Staff: text one 4th Dan+ student asking them to help at the black belt grading (prep-update-27) ----
    // Lists the sessions that still have room, numbered; their reply ("2") is handled by the cb reply webhook.
    if (body.action === 'helper_send') {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: who } = token ? await db.auth.getUser(token) : { data: null };
      const me = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
      if (!me) return fail('Sign in first.', 401);
      const { data: roleRows } = await db.from('prep_roles').select('role').eq('email', me);
      if (!(roleRows || []).some(r => ['admin', 'grading', 'calls'].includes(r.role))) return fail('Your login cannot send helper texts.', 403);
      if (!(ready || testing)) return fail('GoHighLevel is not set up yet.', 409);
      const cycle = String(body.cycle || ''), student_id = String(body.student_id || '');
      if (!cycle || !student_id) return fail('Missing cycle or student.');
      const { data: s } = await db.from('prep_students').select('student_id, full_name, contact_phone, contact_email').eq('student_id', student_id).maybeSingle();
      if (!s) return fail('Student not found.', 404);
      const { data: ov } = await db.from('prep_overview').select('grading_to').eq('cycle_id', cycle).eq('student_id', student_id).maybeSingle();
      const target = (ov && ov.grading_to) || '';
      if (!bb4thPlus(target)) return fail('Only students going for 4th Dan and above are asked to help.');
      const phone = phoneE164(s.contact_phone);
      if (!phone) return fail('No mobile on file for ' + s.full_name + '.');
      const { data: slots } = await db.from('prep_helper_slots').select('*').eq('cycle_id', cycle).order('sort');
      const { data: hs } = await db.from('prep_helpers').select('student_id, slot_id').eq('cycle_id', cycle);
      const taken = id => (hs || []).filter(h => h.slot_id === id && h.student_id !== student_id).length;
      // Sessions fill evenly: only the ones with the fewest helpers (and room) are offered
      const withRoom = (slots || []).filter(x => taken(x.slot_id) < (x.cap ?? 6));
      if (!withRoom.length) return fail('Every helper session is full.', 409);
      const low = Math.min(...withRoom.map(x => taken(x.slot_id))), open = withRoom.filter(x => taken(x.slot_id) === low);
      const text = helperInvite({ first_name: first(s.full_name), target, slots: open });
      const cid = await contactFor({ full_name: s.full_name, email: s.contact_email, phone });
      if (!(testing && !ready)) await sendSms(cid, text);
      const nowIso = new Date().toISOString();
      const row = { cycle_id: cycle, student_id, offered_at: nowIso, offered_slots: open.map(x => x.slot_id), declined_at: null, updated_at: nowIso };
      const { data: ex } = await db.from('prep_helpers').select('student_id').eq('cycle_id', cycle).eq('student_id', student_id).maybeSingle();
      if (ex) await db.from('prep_helpers').update(row).eq('cycle_id', cycle).eq('student_id', student_id); else await db.from('prep_helpers').insert(row);
      return json({ ok: true, sent: true, text });
    }

    // ---- A family replied (GoHighLevel "customer replied" workflow posts here with the hub key) ----
    // Any reply pauses that student's enrolment messages for 2 days and raises a "concern" call for an instructor.
    // STOP / unsubscribe opts them out of the sequence entirely.
    if (body.action === 'reply') {
      const { data: setg } = await db.from('prep_settings').select('nurture_hub_key').eq('id', 1).maybeSingle();
      if (!setg || !setg.nurture_hub_key || String(body.key || '') !== setg.nurture_hub_key) return fail('Not allowed.', 403);
      const p9 = String(body.phone || '').replace(/\D/g, '').slice(-9);
      const msg = String(body.message || '').trim();
      if (p9.length !== 9) return json({ ok: true, matched: 0 });
      const isStop = /^\s*(stop|unsubscribe|opt\s?out|end)\b/i.test(msg);
      const today = sydToday(new Date());
      const { data: runs } = await db.from('prep_nurture_runs').select('cycle_id').not('started_at', 'is', null);
      const cycles = (runs || []).map(r => r.cycle_id);
      let matched = 0;
      for (const cycle of cycles) {
        const { data: cands } = await db.from('prep_overview').select('student_id, grading_fee_status').eq('cycle_id', cycle).eq('is_grading', true);
        if (!cands || !cands.length) continue;
        const ids = cands.map(c => c.student_id);
        const { data: studs } = await db.from('prep_students').select('student_id, contact_phone').in('student_id', ids);
        const last9 = x => String(x || '').replace(/\D/g, '').slice(-9);
        for (const s of studs || []) {
          if (last9(s.contact_phone) !== p9) continue;
          const paid = ['paid', 'waived'].includes((cands.find(c => c.student_id === s.student_id) || {}).grading_fee_status);
          matched++;
          const patch = isStop ? { stopped: true } : { paused_until: addDays(today, 2) };
          const { data: ex } = await db.from('prep_nurture_state').select('student_id').eq('cycle_id', cycle).eq('student_id', s.student_id).maybeSingle();
          if (ex) await db.from('prep_nurture_state').update({ ...patch, updated_at: new Date().toISOString() }).eq('cycle_id', cycle).eq('student_id', s.student_id);
          else await db.from('prep_nurture_state').insert({ cycle_id: cycle, student_id: s.student_id, joined_on: today, ...patch });
          if (!isStop && !paid) {
            const { data: open } = await db.from('prep_calls').select('call_id').eq('cycle_id', cycle).eq('student_id', s.student_id).eq('reason', 'concern').eq('done', false).maybeSingle();
            if (!open) await db.from('prep_calls').insert({ cycle_id: cycle, student_id: s.student_id, reason: 'concern', note: msg.slice(0, 500), callback_on: today });
          }
        }
      }
      return json({ ok: true, matched, stop: isStop });
    }

    // ---- The scheduled run ----
    if (body.action !== 'run') return fail('Unknown action.');
    const { data: okCron } = await db.rpc('prep_nurture_cron_ok', { p_secret: req.headers.get('x-nurture-cron') || '' });
    if (okCron !== true) return fail('Not allowed.', 403);

    const now = body._now ? new Date(body._now) : new Date();
    const today = sydToday(now), tnow = sydTime(now);
    const { data: cs } = await db.from('prep_settings').select('prep_session_date, prep_session_venue, prep_session_cost, nurture_deadline').eq('id', 1).maybeSingle();
    const { data: steps } = await db.from('prep_nurture_steps').select('*').eq('active', true);
    const enrolSteps = (steps || []).filter(s => s.track === 'enrol' && (s.channel === 'sms' || s.channel === 'email'));
    const bookedSteps = (steps || []).filter(s => s.track === 'booked' && (s.channel === 'sms' || s.channel === 'email'));
    const callStep = (steps || []).find(s => s.track === 'enrol' && s.channel === 'call');
    const { data: tgroups } = await db.from('prep_time_groups').select('*');
    const { data: runs } = await db.from('prep_nurture_runs').select('*').eq('paused', false).not('started_at', 'is', null);
    // The bespoke 4th Dan & Beyond invitation email (active:false, fetched on its own so the generic loop ignores it).
    const { data: inv4 } = await db.from('prep_nurture_steps').select('subject, body').eq('code', 'enrol_invite_4dan').maybeSingle();

    const out = { sent: 0, skipped: 0, failed: 0, calls: 0, held: 0, held_why: [] };
    // Texts share one GoHighLevel number (and its daily limit) with the coloured belt sequence. While the coloured belt
    // side has texting stopped (the limit was hit), or the shared daily cap is used up, SMS steps wait for a later run.
    let smsLeft = Infinity, smsStop = null;
    try {
      const { data: cbs } = await db.from('cb_settings').select('sms_blocked_until, sms_daily_cap').eq('id', 1).maybeSingle();
      if (cbs && cbs.sms_blocked_until && Date.parse(cbs.sms_blocked_until) > now.getTime()) smsStop = 'Texting paused (GoHighLevel daily limit) until ' + cbs.sms_blocked_until;
      if (cbs) {
        const since = new Date(now.getTime() - 864e5).toISOString();
        const { count: cb24 } = await db.from('cb_messages').select('message_id', { count: 'exact', head: true }).not('phone', 'is', null).eq('status', 'sent').gte('sent_at', since);
        const { count: bb24 } = await db.from('prep_nurture_log').select('log_id', { count: 'exact', head: true }).eq('channel', 'sms').eq('status', 'sent').gte('sent_at', since);
        smsLeft = Math.max(0, (cbs.sms_daily_cap ?? 450) - (cb24 || 0) - (bb24 || 0));
      }
    } catch (_) { /* no coloured belt settings: no shared limit to respect */ }
    const hold = (step, student_id, why) => { out.held++; if (out.held_why.length < 50) out.held_why.push(student_id + ' ' + step.code + ': ' + why); };
    const sendStep = async (step, cycle, student_id, vars, phone, email, needsEssay) => {
      // A step that gives them their enrolment/booking link must never go out with a blank one: wait until they have a booking entry
      const fourDanStep = step.channel === 'email' && step.code === 'enrol_d1_email' && bb4thPlus(vars.belt) && inv4 && inv4.body;
      if (!vars.link && (fourDanStep || /\{link\}/.test(String(step.body || '') + String(step.subject || '')))) { hold(step, student_id, 'no booking link yet'); return false; }
      if (step.channel === 'sms') {
        if (smsStop) { hold(step, student_id, smsStop); return false; }
        if (smsLeft <= 0) { hold(step, student_id, 'daily text limit reached'); return false; }
      }
      // 4th Dan+ candidates get the bespoke invitation email in place of the generic Day-1 email (same log key, no double send).
      const fourDan = step.channel === 'email' && step.code === 'enrol_d1_email' && bb4thPlus(vars.belt) && inv4 && inv4.body;
      const html = fourDan ? fill4dan(inv4.body, vars, needsEssay) : null;
      const text = fourDan
        ? `Hi ${vars.first_name}, you're invited to the 4th Dan & Beyond Grading Day on ${vars.grading_date}. Enrol: ${vars.link}${needsEssay && vars.essay_link ? '  Essay: ' + vars.essay_link : ''}`
        : render(step.body, vars, needsEssay);
      const subject = fourDan ? (inv4.subject ? fill4dan(inv4.subject, vars, needsEssay) : '4th Dan & Beyond Grading Day') : (step.subject ? render(step.subject, vars, needsEssay) : null);
      const to = step.channel === 'email' ? email : phoneE164(phone);
      const logRow = (status, extra = {}) => db.from('prep_nurture_log').insert({ cycle_id: cycle, student_id, step_code: step.code, channel: step.channel, status, ...extra });
      const setLog = patch => db.from('prep_nurture_log').update(patch).eq('cycle_id', cycle).eq('student_id', student_id).eq('step_code', step.code);
      if (!to) { await logRow('failed', { error: step.channel === 'email' ? 'no email on file' : 'no mobile on file' }); out.failed++; return; }
      // Claim the step first (one row per cycle, student and step): if the row is already there it has been sent, so never send twice.
      const { error: claimErr } = await logRow('sent', testing && !ready ? { ghl_message_id: 'test' } : {});
      if (claimErr) { out.skipped++; return; }
      if (step.channel === 'sms') smsLeft--;
      if (testing && !ready) { out.sent++; return; }
      try {
        const cid = await contactFor({ full_name: vars.name, email, phone });
        const id = step.channel === 'email' ? await sendEmail(cid, subject, text, html || emailHtml(subject, text, vars.adult)) : await sendSms(cid, text);
        await setLog({ ghl_message_id: id }); out.sent++;
      } catch (e) { await setLog({ status: 'failed', error: String(e.message || e).slice(0, 500) }); out.failed++; }
    };

    // When an enrol step is due. Default: relative to each person's invite date (joined_on + offset_days).
    // A step anchored to 'prep_session' is a fixed date for everyone: the final prep session + offset_days
    // (e.g. the Day 12 call is 2 days before, offset_days = -2).
    const enrolDue = (step, joined) => step.anchor === 'prep_session'
      ? ((cs && cs.prep_session_date) ? addDays(cs.prep_session_date, step.offset_days || 0) : null)
      : ((step.offset_days != null) ? addDays(joined, step.offset_days) : step.send_on);

    for (const run of runs || []) {
      const cycle = run.cycle_id;
      const { data: cands } = await db.from('prep_overview').select('student_id, full_name, belt_rank, is_grading, grading_to, grading_fee_status').eq('cycle_id', cycle).eq('is_grading', true);
      if (!cands || !cands.length) continue;
      const ids = cands.map(c => c.student_id);
      const { data: studs } = await db.from('prep_students').select('student_id, full_name, belt_rank, efc_ref, contact_email, contact_phone, dob, contact_name').in('student_id', ids);
      const studBy = Object.fromEntries((studs || []).map(s => [s.student_id, s]));
      const states = await allRows(() => db.from('prep_nurture_state').select('*').eq('cycle_id', cycle).order('student_id'));
      const stateBy = Object.fromEntries((states || []).map(s => [s.student_id, s]));
      const logs = await allRows(() => db.from('prep_nurture_log').select('student_id, step_code').eq('cycle_id', cycle).order('log_id'));
      const done = new Set((logs || []).map(l => l.student_id + '|' + l.step_code));
      const { data: eqs } = await db.from('prep_essay_questions').select('target_rank');
      const essayRanks = new Set((eqs || []).map(e => e.target_rank));
      const essays = await allRows(() => db.from('prep_essays').select('student_id, target_rank, status, token').eq('cycle_id', cycle).order('essay_id'));
      const essaySt = Object.fromEntries((essays || []).map(e => [e.student_id + '|' + e.target_rank, e.status]));
      const essayTok = Object.fromEntries((essays || []).map(e => [e.student_id + '|' + e.target_rank, e.token]));
      const { data: bdays } = await db.from('cb_days').select('day_id, grading_date, belts').eq('prep_cycle_id', cycle).eq('bb', true);
      const dayBy = Object.fromEntries((bdays || []).map(d => [d.day_id, d]));
      const er = (bdays && bdays.length) ? { data: await allRows(() => db.from('cb_entries').select('entry_id, member_key, belt_to, token, day_id').in('day_id', bdays.map(d => d.day_id)).order('entry_id')) } : { data: [] };
      const entByRefRank = {};
      for (const e of er.data || []) if (e.member_key && String(e.member_key).startsWith('efc:')) entByRefRank[e.member_key + '|' + e.belt_to] = e;
      // Students link to EFC by reference code; booking entries are keyed by efc_members.member_key — map one to the other.
      const refs = (studs || []).map(x => x.efc_ref).filter(Boolean);
      const { data: ems } = refs.length ? await db.from('efc_members').select('member_key, efc_reference, date_of_birth').in('efc_reference', refs) : { data: [] };
      const mkByRef = Object.fromEntries((ems || []).map(m => [m.efc_reference, m.member_key]));
      const dobByRef = Object.fromEntries((ems || []).map(m => [m.efc_reference, m.date_of_birth]));

      for (const c of cands) {
        const s = studBy[c.student_id] || {};
        const target = c.grading_to;
        const paid = ['paid', 'waived'].includes(c.grading_fee_status);
        let st = stateBy[c.student_id];
        if (!st) { await db.from('prep_nurture_state').insert({ cycle_id: cycle, student_id: c.student_id, joined_on: today }); st = { joined_on: today }; }
        if (st.stopped || st.skipped) continue;
        const joined = st.joined_on || today;
        const ent = entByRefRank[(mkByRef[s.efc_ref] || '') + '|' + target] || null;
        const gday = ent ? dayBy[ent.day_id] : null;
        const gradingYmd = st.grading_date_override || (gday && gday.grading_date) || null;
        const link = ent && ent.token ? (SITE + 'b#' + ent.token) : '';
        const prepTime = (tgroups || []).filter(g => (g.ranks || []).includes(target)).map(g => g.time_label).join(' and ');
        const needsEssay = essayRanks.has(target) && !['submitted', 'reviewed'].includes(essaySt[c.student_id + '|' + target] || '');
        // Their own essay link; make one if they need an essay but don't have a link yet.
        let essayLink = '';
        if (needsEssay) {
          let tok = essayTok[c.student_id + '|' + target];
          if (!tok) { tok = essayToken(); await db.from('prep_essays').insert({ cycle_id: cycle, student_id: c.student_id, target_rank: target, token: tok }); essayTok[c.student_id + '|' + target] = tok; }
          essayLink = SITE + 'e/#' + tok;
        }
        const vars = { first_name: first(s.full_name || c.full_name), name: s.full_name || c.full_name, belt: target || '', current_belt: s.belt_rank || c.belt_rank || '', grading_date: longDate(gradingYmd), link, prep_time: prepTime, essay_link: essayLink, adult: isAdult({ ...s, dob: s.dob || dobByRef[s.efc_ref] }) };
        const phone = s.contact_phone, email = s.contact_email;

        if (!paid) {
          const pausedNow = st.paused_until && String(st.paused_until) >= today;
          for (const step of enrolSteps) {
            const key = c.student_id + '|' + step.code;
            if (done.has(key)) continue;
            // Enrol steps run relative to each person's invite date (joined_on): Day N = joined_on + offset_days.
            const due = enrolDue(step, joined);
            if (!due || String(due) > today || String(due) < String(joined)) continue;
            if (!timeReached(step.send_at, tnow)) continue;
            if (pausedNow) continue;
            if (await sendStep(step, cycle, c.student_id, vars, phone, email, needsEssay) !== false) done.add(key);
          }
          const callDue = callStep ? enrolDue(callStep, joined) : null;
          if (callStep && callDue && String(callDue) <= today) {   // the Day 12 call, relative to the person's invite date
            const { data: ex } = await db.from('prep_calls').select('call_id').eq('cycle_id', cycle).eq('student_id', c.student_id).eq('reason', 'day12').maybeSingle();
            if (!ex) { await db.from('prep_calls').insert({ cycle_id: cycle, student_id: c.student_id, reason: 'day12', callback_on: today }); out.calls++; }
          }
        } else {
          for (const step of enrolSteps) {
            const key = c.student_id + '|' + step.code;
            if (done.has(key)) continue;
            const due = enrolDue(step, joined);
            if (!due || String(due) > today || String(due) < String(joined)) continue;
            // Paid people still get the enrolment EMAILS (invitation + info, with their links); only the payment-nudge SMS stops once paid.
            if (step.channel === 'email') {
              if (!timeReached(step.send_at, tnow)) continue;
              if (await sendStep(step, cycle, c.student_id, vars, phone, email, needsEssay) !== false) done.add(key);
            } else {
              await db.from('prep_nurture_log').insert({ cycle_id: cycle, student_id: c.student_id, step_code: step.code, channel: step.channel, status: 'skipped_paid' });
              done.add(key); out.skipped++;
            }
          }
          for (const step of bookedSteps) {
            const key = c.student_id + '|' + step.code;
            if (done.has(key)) continue;
            let dueYmd = null;
            if (step.anchor === 'on_payment') dueYmd = today;
            else if (step.anchor === 'prep_session') dueYmd = (cs && cs.prep_session_date) ? addDays(cs.prep_session_date, step.offset_days) : null;
            else if (step.anchor === 'grading_day') dueYmd = gradingYmd ? addDays(gradingYmd, step.offset_days) : null;
            if (!dueYmd) continue;
            if (step.anchor === 'on_payment') { if (gradingYmd && String(gradingYmd) < today) continue; }
            else { if (String(dueYmd) !== today || !timeReached(step.send_at, tnow)) continue; }
            if (await sendStep(step, cycle, c.student_id, vars, phone, email, needsEssay) !== false) done.add(key);
          }
        }
      }
    }
    return json({ ok: true, ...out });
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

// @ts-nocheck
// AMA Toolkit: coloured belt grading. Family booking links, and texts to families through GoHighLevel.
//
// Deploy: Edge Functions > name it "cb", paste this file, Deploy, and turn OFF JWT verification for it
// (booking links are opened by families who aren't signed in; staff actions check who is signed in).
// Uses the same GoHighLevel secrets as Black Belt Prep's "ghl" function (Edge Functions > Secrets):
//   GHL_TOKEN, GHL_LOCATION_ID, and optional GHL_TEST = "1" to log texts without sending them.
// Booking: Pressing Book (or paying) books the student straight into their EFC grading session via the EFC Aquila
// integration API - POST /locations/{location_id}/calendar/sessions/{session_id}/{date}/bookings with { memberId } and an
// X-API-KEY header, the key being the student's own school's Supabase secret EFC_API_KEY_<SCHOOL>. The session is chosen by
// the member's school and belt (cb_days.efc_belt_sessions / efc_school_belt_sessions / efc_sessions / efc_session_id); a
// student with no EFC id, no mapped session, or a school whose key isn't set is flagged to book by hand instead.
// Emails (automatic, through GoHighLevel with the same secrets): "booked" when a family books, and "paid and booked" when
// they pay by card or staff record a payment (with Stripe's receipt link). Each goes once per student, to their EFC email.
// Card payments (optional): STRIPE_SECRET_KEY (the same one the polo shirts use) and a Stripe webhook to
//   https://<project>.supabase.co/functions/v1/cb  for checkout.session.completed (+ async_payment_succeeded), with its
//   signing secret saved as STRIPE_WEBHOOK_SECRET_GRADING. Paying marks them paid and books the session; set the EFC grading
//   session to $0 so EFC doesn't charge again. Without the webhook, a payment is still picked up when they come back to the page.
//
// Requests (POST, JSON):
//   { action: 'info', token }               a family's booking link: who, what belt, when, where (no sign-in)
//   { action: 'book', token }               book it, only when there is no fee (no sign-in): with a fee, families pay by card
//   { action: 'record_payment', entry_id, how }  staff: a cash/EFTPOS/bank payment taken by staff; marks paid and books it
//   { action: 'pay', token, back? }         pay the fee by card: returns the Stripe payment page (no sign-in); paying books it
//   Stripe's webhook (has a Stripe-Signature header)
//   { action: 'photo', code | token }       a family's grading photo link (short code from /p#<code>): a short-lived address for the photo (no sign-in)
//   { action: 'cleanup' } + x-cb-cron header  the nightly job: delete grading photos older than 30 days (secret in Supabase Vault)
//   { action: 'reply', key, phone, message }  GoHighLevel workflow: a family replied; a YES marks them and texts the booking link
//   { action: 'sequence' } + x-cb-cron header  every 15 minutes: the automated booking sequence (coloured-belts-23.sql).
//        Sends nothing while Settings > Booking sequence is off, except texts a staff call outcome asked for.
//   { action: 'seq_test', code, phone?, email?, entry_id? }  grading staff: send one sequence message to themselves
//   { action: 'seq_run' }                   admins: run the sequence now
//   { action: 'check' }                     staff: is texting set up?
//   { action: 'send', kind, items: [{ entry_id?, member_key, body }] }   staff: text families
//        kind: invite, not_booked, reminder, unpaid, congrats, retest, photo (grading staff); not_ready, bbc_followup (instructors or grading staff)

const API = 'https://services.leadconnectorhq.com';

// Replies: does this text mean yes? ("Yes", "yes please", "Yep!", "Y", "Confirmed", a thumbs up) but not "yes but not this time"
export function isYes(t) {
  const s = String(t || '').trim().toLowerCase();
  if (!s || /\b(no|not|cant|can't|cannot|won't|wont|unable|unsure|maybe)\b/.test(s)) return false;
  return /^(y|ye+s+|yep|yup|yeah|yea|ya|sure|ok|okay|confirm|confirmed|definitely|absolutely|of course|will do)(?![a-z])/u.test(s) || /^\u{1F44D}/u.test(s);
}
// Replies: is this a "no" or "can't make it"? ("No", "Can't make it", "We're away that day", "Is there another day?")
export function isNo(t) {
  const s = String(t || '').trim().toLowerCase().replace(/[‘’]/g, "'");
  if (!s || isYes(s)) return false;
  return /^(no|nope|nah|n)\b/.test(s) || cantMakeIt(s) || /\b(can'?t|cannot|can not|won'?t be able|unable|not able|(another|different|other) (day|time|date|location|school|grading))\b/.test(s);
}
// Replies: the date is the problem, not the grading ("We'll be overseas", "on holiday that week", "can't make that day"): offer other gradings
export function cantMakeIt(t) {
  const s = String(t || '').toLowerCase().replace(/[\u2018\u2019]/g, "'");
  return /\b(away|overseas|holidays?|on vacation|travel+ing|interstate|out of (town|the country|sydney)|not available|unavailable|busy|clash(es|ing)?|can'?t make|cannot make|can not make|won'?t make|not be able to make|(another|different|other) (day|time|date))\b/.test(s);
}
// Replies: they don't want to grade at all ("We don't want to grade this time", "Not grading", "She's stopped", "Not ready",
// "Skip this one", "Next time"). Not "can't make it" or "another day", which are offered other gradings instead.
export function isNotGrading(t) {
  const s = String(t || '').trim().toLowerCase().replace(/[‘’]/g, "'");
  if (!s || /\b(another|different|other)\s+(day|time|date|location|school|grading|session)\b/.test(s)) return false;
  // Left, stopped, injured or paused: not grading even if they also mention being away
  if (/\binjur(ed|y|ies)\b|\bstop(ped)? (attending|coming|training)\b|\b(quit|quitting|withdraw(n|ing)?)\b|\bleft (ama|the club|the academy|martial arts|taekwondo)\b|\bwe'?ve left\b|\b(paus(e|ed|ing)|suspend(ed|ing)?|on hold)\b[^.?!]*\bmembership\b|\bmembership\b[^.?!]*\b(paused|suspended|on hold)\b/.test(s)) return true;
  // "We won't be grading, we'll be overseas": it's the date, so they're offered other gradings instead
  if (cantMakeIt(s)) return false;
  if (/\b(don'?t|do not|doesn'?t|does not|won'?t|wont|will not|not|no longer)\s+(want(ing)?|wanna|going|planning|plan|interested|keen|doing|be doing|ready)\b[^.?!]*\b(grad(e|ing)|test(ing)?|it|this|that)\b/.test(s)) return true;
  if (/\b(not|no)\s+grad(e|ing)\b|\bno for \w+|\binjur(ed|y|ies)\b|\bstop(ped)? (attending|coming|training)\b|\b(not|haven'?t|have not|hasn'?t|has not) (been )?(attending|coming|training)\b|\b(don'?t|do not|doesn'?t) (feel|think)\b[^.?!]*\b(time|ready)\b|\bnot the right time\b|\b(paus(e|ed|ing)|suspend(ed|ing)?|freez(e|ing)|froze|frozen|put on hold|on hold)\b[^.?!]*\b(membership|enrol(l?ment)?|training|classes|lessons)\b|\b(membership|enrol(l?ment)?)\b[^.?!]*\b(paused|suspended|frozen|on hold)\b|\b(won'?t|wont|will not|would not|wouldn'?t|not|no)\s+(be\s+)?grad(e|ing)\b|\bnot (ready|this time|this round)\b|\b(skip|sit out|pass on|miss)\s+(this|the|that)\s+(one|grading|time|round)\b|\bnext (grading|time|round|term|cycle)\b/.test(s)) return true;
  // "She wants to focus and get really good at Blue before trying for Purple", "we'll skip this one", "wait for the next grading"
  if (/\bbefore (trying|going|attempting|moving up|she |he |they )[^.?!]*\b(grad(e|ing)|test(ing)?|belt|purple|green|blue|orange|yellow|red|brown|black|it)\b|\b(skip|sit out|give) (this|the) (one|grading|round)( a miss)?\b|\bwait (until|till|for) (the )?next (one|grading|round|term|time)\b|\bnext (grading|one|round) (instead|then)\b/.test(s)) return true;
  return /\b(quit|quitting|stopped|stopping|leaving|left (the|ama|amaa|the club|the academy|the school|martial arts|taekwondo)\b|we'?ve left|cancel+ing|cancel+ed (her|his|their|the) (membership|enrol)|withdraw(n|ing)?|pulling (him|her|them) out|pulled (him|her|them) out)\b/.test(s);
}
// Replies: they want someone to ring them ("Could I please have a phone call with a staff member today?", "Can someone call me")
export function wantsCall(t) {
  const s = String(t || '').toLowerCase().replace(/[\u2018\u2019]/g, "'");
  return /\b(phone call|call me|call us|call back|callback|ring me|ring us|give (me|us) a (call|ring)|(can|could|would) (someone|somebody|you|a staff member|staff) (please )?(call|ring|phone)|please (call|ring|phone)|(speak|talk|chat) (to|with) (someone|somebody|a staff|staff|a person|an instructor|the instructor|mark|you))\b/.test(s);
}
// Replies: "That's the wrong belt, she's going for Green" / "He's a Blue Belt" / "Should be red two". ladder is the programme's
// belts ({ belt, next_belt }). Returns { belt, as: 'target' | 'current' } for the last belt named, or null if it isn't a belt correction.
export function beltClaim(t, ladder) {
  const s = ' ' + String(t || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\b(red)\s*(2|ii)\b|\b2nd red\b/g, 'red two').replace(/\b(red)\s*(3|iii)\b|\b3rd red\b/g, 'red three').replace(/\s+/g, ' ') + ' ';
  if (!/\b(wrong|mistake|incorrect|actually|should (be|say)|not (a|an|on|the|for)\b|going (for|to)|grading (for|to)|trying (for|to)|up for|go for|currently|already|holding|having|wearing|completed|passed|finished|achieved|earned|graded|is (a|an|on|now)|'s (a|an|on|now)|'re (a|an|on|now)|has (his|her|their|a)|got (his|her|their))\b/.test(s)) return null;
  const names = (ladder || []).map(b => ({ belt: b.belt, key: String(b.belt).toLowerCase().replace(/ belt$/, '') })).sort((a, b) => b.key.length - a.key.length);
  const hits = [];
  for (const n of names) {
    const re = new RegExp('\\b' + n.key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '(?: belt)?\\b', 'g'); let m;
    while ((m = re.exec(s))) if (!hits.some(h => m.index < h.end && m.index + m[0].length > h.start)) hits.push({ belt: n.belt, start: m.index, end: m.index + m[0].length });
  }
  // "orange not yellow": a belt after "not" is the wrong one, so the claim is the last belt that isn't
  const notNeg = h => !/\bnot (the |a |an |)$/.test(s.slice(Math.max(0, h.start - 10), h.start));
  const kept = hits.sort((a, b) => a.start - b.start).filter(notNeg);
  if (!kept.length) return null;
  const last = kept[kept.length - 1], before = s.slice(Math.max(0, last.start - 40), last.start), after = s.slice(last.end, last.end + 12);
  if (/\b(going|grading|trying|test(ing)?|up|go)\s+(for|to)\s+(the |a |an |his |her |their |)$|\bshould (be|say) (the |a |an |)$|\b(it's|it is|its) (the |a |an |)$|\bfor (his|her|their) $/.test(before)) return { belt: last.belt, as: 'target' };
  if (/(\bis|'s|\bare|'re|\bcurrently|\balready|\bnow|\bon|\bhas|\bgot|\bhaving|\bholding|\bwearing|\bcompleted|\bpassed|\bfinished|\bachieved|\bearned|\bdid|\bdone|\bgraded(?: for| to| in)?|\bwas|\bat)\s+(a |an |on |on a |at |his |her |their |my |our |)$/.test(before) || /^\s*already\b/.test(after)) return { belt: last.belt, as: 'current' };
  return { belt: last.belt, as: 'target' };
}
// Does a reply talk about a belt? A belt colour from the programme's ladder named with "belt", or next to "grading"/"graded".
export function mentionsBelt(t, ladder) {
  const s = ' ' + String(t || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ') + ' ';
  const keys = [...new Set((ladder || []).map(b => String(b.belt).toLowerCase().replace(/ belt$/, '')))].map(k => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  if (!keys.length) return false;
  return new RegExp('\\b(' + keys.join('|') + ')( belt|\\s+(grading|grade|graded|tip|stripe))\\b').test(s);
}
// Another grading for this student: a coming day of the same programme, for their belt and age, still open for bookings.
// d.belts (or the belts with an EFC session) says which belts it's for; min_age / max_age split kids' and teens' sessions.
export function fitsDay(d, e, age, from) {
  if (!d || d.bb || d.closed || d.day_id === e.day_id) return false;
  if ((d.programme || 'Taekwondo') !== ((from && from.programme) || 'Taekwondo')) return false;
  if (d.book_by && Date.parse(d.book_by) <= Date.now()) return false;
  const belts = Array.isArray(d.belts) && d.belts.length ? d.belts : (d.efc_belt_sessions && typeof d.efc_belt_sessions === 'object' && Object.keys(d.efc_belt_sessions).length ? Object.keys(d.efc_belt_sessions) : null);
  if (belts && !belts.includes(e.belt_from)) return false;
  if (d.min_age != null || d.max_age != null) {
    if (age == null) return false;
    if (d.min_age != null && age < d.min_age) return false;
    if (d.max_age != null && age > d.max_age) return false;
  }
  return true;
}
export const ALT_DAYS = 3, ALT_VALID_MS = 7 * 864e5;   // offer up to 3 other gradings; a reply of 1, 2 or 3 works for 7 days
const SITE = 'https://app.train-ama.com/';
// A short url-safe essay token, matching the 12-char shape the prep system (nurture) makes.
const essayToken = () => { const b = crypto.getRandomValues(new Uint8Array(9)); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').slice(0, 12); };
const firstWord = x => String(x || '').trim().split(/\s+/)[0] || '';
const longDay = ymd => { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).replace(',', ''); };
const clock = t => { const [h, mi] = String(t).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(mi || 0).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };
// The start time shown for one entry. A grading can run in blocks whose time depends on the belt/rank (belt_times:
// belt -> "HH:MM"; black belt keys by the rank they grade to, otherwise the belt they are on now), falling back to the day's single start_time.
export function entryTime(d, e) { const k = (d && d.bb) ? (e && e.belt_to) : (e && e.belt_from); return (d && d.belt_times && d.belt_times[k]) || (d && d.start_time) || null; }
export function fillText(tpl, v) { return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => v[k] != null ? v[k] : '').replace(/[ \t]+([.,!])/g, '$1').replace(/ {2,}/g, ' ').trim(); }
// An adult grading themselves is their own contact: address them directly instead of as if to a parent.
export function selfOf(m) {
  if (!m) return false;
  const dob = String(m.date_of_birth || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(dob) && (Date.now() - Date.parse(dob.slice(0, 10))) / 31557600000 >= 18) return true;
  const g = String(m.guardian_name || '').trim().toLowerCase().replace(/\s+/g, ' '), f = String(m.full_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return !!g && !!f && g === f;
}
// Rewrite a parent-facing message into second person ("your") for an adult grading themselves.
export function adultize(t) {
  return String(t || '')
    .replace(/Congratulations \{first\}!/g, 'Congratulations!')
    .replace(/\{first\}'s/g, 'your')
    .replace(/\{first\} (is|are|was|passed|worked|needs|has|have|will|did)\b/g, (m, v) => 'you ' + ({ is: 'are', are: 'are', was: 'were', passed: 'passed', worked: 'worked', needs: 'need', has: 'have', have: 'have', will: 'will', did: 'did' }[v]))
    // Questions: "How is {first} feeling" -> "How are you feeling", "Has {first} ..." -> "Have you ...", "Does {first}" -> "Do you"
    .replace(/\b(is|was|has|does) \{first\}/gi, (m, v) => { const w = { is: 'are', was: 'were', has: 'have', does: 'do' }[v.toLowerCase()]; return (v[0] === v[0].toUpperCase() ? w[0].toUpperCase() + w.slice(1) : w) + ' you'; })
    .replace(/\{first\}/g, 'you')
    .replace(/\bis now a\b/g, 'are now a')
    .replace(/\bTheir\b/g, 'Your').replace(/\btheir\b/g, 'your')
    .replace(/\bThey'll\b/g, "You'll").replace(/\bthey'll\b/g, "you'll")
    .replace(/\bThey're\b/g, "You're").replace(/\bthey're\b/g, "you're")
    .replace(/\babout (them|\{first\}) being\b/g, 'about being')
    .replace(/\bThey\b/g, 'You').replace(/\bthey\b/g, 'you').replace(/\bthem\b/g, 'you')
    .replace(/(^|[.!?]\s+)you\b/g, (m, p) => p + 'You');
}
// Fill a family template, switching to second person for an adult grading themselves (their greeting becomes their own name).
export function famFill(tpl, m, v) { return selfOf(m) ? fillText(adultize(tpl), { ...v, parent: firstWord(m.full_name || '') }) : fillText(tpl, v); }
export const EFC_LOCATIONS = {
  Marrickville: 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58', Sydenham: '5af07764-95bc-4caf-b889-ba846e409dc5', West: 'eafda575-a10e-4656-a045-8e20201aad40',
  Concord: '7ca1c142-be41-4d02-b5eb-13534b23043b', Sylvania: 'a5a5ab24-e85d-4e14-ac16-1d9c189ff0dd'
};
// Coloured Belts permissions (app_permissions, app 'cb'; supabase/app-permissions.sql). "admin" covers everything.
const KINDS = { invite: ['texts'], not_booked: ['texts'], reminder: ['texts'], unpaid: ['texts'], congrats: ['texts'], retest: ['texts'], photo: ['results', 'texts'], not_ready: ['readiness'], bbc_followup: ['readiness'] };
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cb-cron, stripe-signature',
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
const first = n => String(n || '').trim().split(/\s+/)[0] || '';
// A student's home school: from EFC, or from the EFC reference (AU-023 Marrickville, 256 Sydenham, 257 West, 258 Concord, 3096 Sylvania)
const REF_SCHOOL = { '023': 'Marrickville', '256': 'Sydenham', '257': 'West', '258': 'Concord', '3096': 'Sylvania' };
export const refSchool = ref => REF_SCHOOL[String(ref || '').split('-')[1]] || null;
// Where a school's students grade, when it isn't their own school. Sydenham students grade at AMA Marrickville, but are
// still booked into EFC under Sydenham (their own school's session and EFC location); this only changes what families are told.
export const GRADING_VENUE = { Sydenham: 'Marrickville' };
// Display-only rename: families and staff see this name; the stored school key stays the same (EFC mapping, references).
export const SCHOOL_LABEL = { West: 'Auburn' };
export const schoolLabel = s => SCHOOL_LABEL[s] || s || '';
export const venueOf = school => { const v = GRADING_VENUE[school] || school || ''; return SCHOOL_LABEL[v] || v; };
// Replies: "I normally do Leon's grading at Sylvania" / "Can she grade at Concord instead?". Returns the school they want to grade
// at (as a grading venue), or null. A school after "not" / "don't attend" / "no longer" is one they don't want.
const SCHOOL_WORDS = [['Marrickville', /\bmarrickville\b/g], ['Sydenham', /\bsydenham\b/g], ['Concord', /\bconcord\b/g], ['Sylvania', /\bsylvania\b/g],
  ['West', /\bauburn\b|\bama west\b|\b(?:at|in|to) west\b/g]];
export function schoolClaim(t, current) {
  const s = ' ' + String(t || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ') + ' ';
  const want = new Set();
  for (const [school, re] of SCHOOL_WORDS) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(s))) {
      const before = s.slice(Math.max(0, m.index - 40), m.index);
      if (/\b(not|don'?t|do not|doesn'?t|no longer|never|stopped|left|moved from|instead of|rather than)\b[^.?!,]*$/.test(before)) continue;
      want.add(venueOf(school));
    }
  }
  const list = [...want].filter(x => x !== venueOf(current || ''));
  return list.length === 1 && want.size === 1 ? list[0] : null;
}
// Where a student grades, as families are told. A black belt grading is held at the day's venue (AMA Sydenham) for every
// school, while each student is still booked into EFC under their own school's session (bookEntry). A coloured belt day is at
// the day's school, with a school's own venue swapped in if it grades elsewhere.
export const whereOf = (e, d) => (d && d.bb) ? (d.location || '') : venueOf((d && d.location) || '');
const tokenOk = t => /^[A-Za-z0-9_-]{8,72}$/.test(String(t || ''));   // short url-safe tokens, and the old 64-hex ones
const STRIPE = 'https://api.stripe.com/v1';
const BOOK_PAGE = 'https://app.train-ama.com/grading/coloured-belts/book/';
// Where Stripe sends families back: the booking page they came from, on AMA's own sites only
export function backTo(u) {
  try { const x = new URL(String(u || '')); if (x.protocol === 'https:' && /(^|\.)(app\.train-ama\.com|theggatonklenner\.github\.io|australianmartialarts\.com\.au)$/.test(x.hostname)) return x.origin + x.pathname; } catch (e) { /* not a URL */ }
  return BOOK_PAGE;
}
// Stripe's form encoding, with nested keys: { a: { b: 1 } } -> a[b]=1
function form(obj, pre = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = pre ? `${pre}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
// Stripe-Signature: t=<time>,v1=<HMAC-SHA256 of "<time>.<body>"> (within 5 minutes)
export async function signatureOk(body, header, secret, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header).split(',').map(p => p.trim()).filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)));
  return sigs.some(s => s.length === want.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ want.charCodeAt(i)), 0) === 0);
}

// The booking and payment emails: a branded layout that works in email apps (tables and inline styles only)
const LOGO = 'https://app.train-ama.com/icons/ama-id-cards.png';
const BRING = 'Full long-sleeve uniform\nBelt\nDrink bottle';
export function buildEmail(kind, v) {
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const paid = kind === 'email_paid';
  const ink = '#1c1c1c', gold = '#FFD200', green = '#0B6A35', night = '#0E0E0E', cream = '#F4F2EC', creamLine = '#E3DFD4';
  const subject = paid ? `Payment received: ${v.kid}'s grading on ${v.when}` : `Grading booked: ${v.kid}, ${v.when}`;
  const eyebrow = paid ? 'Payment received' : 'Booking confirmed';
  const heading = paid ? 'Paid & booked.' : 'You\'re booked in.';
  const intro = paid ? `Thank you, we've received your payment for ${v.kid}'s grading. Here are the details for the day.` : `${v.kid} is booked in to grade. Here are the details for the day.`;
  const rows = [['Student', v.student], ['Grading for', v.belt], ['Date', v.when], ...(v.time ? [['Time', v.time]] : []), ['Where', `AMA ${v.school}`],
    ...(paid ? [['Paid', `${v.amount != null && v.amount !== '' ? '$' + Number(v.amount).toFixed(2) : 'Yes'}${v.how ? ' (' + v.how + ')' : ''}`]] : [])];
  const bring = String(v.bring || BRING).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const tel = String(v.phone || '').replace(/[^\d+]/g, '');
  // When they have more than one grading still to come (a double grading), list them all so the confirmation shows both.
  const up = (v.upcoming || []).filter(Boolean);
  const upHtml = up.length > 1 ? `<tr><td class="pad" style="padding:26px 32px 4px;">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:17px;font-weight:600;text-transform:uppercase;color:#14321f;">Your upcoming gradings</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;font-family:Arial,Helvetica,sans-serif;">${up.map(u => `<tr><td style="padding:8px 0;border-bottom:1px solid ${creamLine};"><span style="font-size:14px;color:#1c1c1c;font-weight:bold;">${esc(u.belt)}</span> <span style="font-size:13px;color:#555;">&mdash; ${esc(u.when)}${u.time ? ' at ' + esc(u.time) : ''}, AMA ${esc(u.where)}</span><br><span style="font-size:13px;color:#666;">${esc(u.status)}${u.link ? `: <a href="${esc(u.link)}" style="color:${green};font-weight:bold;">book &amp; pay</a>` : ''}</span></td></tr>`).join('')}</table></td></tr>` : '';
  const upText = up.length > 1 ? ['', 'Your upcoming gradings:', ...up.map(u => `- ${u.belt}: ${u.when}${u.time ? ' at ' + u.time : ''}, AMA ${u.where} (${u.status}${u.link ? ' — ' + u.link : ''})`)] : [];
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&display=swap');body{margin:0;padding:0;background:#E9E6DE;}a{color:${green};}@media (max-width:620px){.wrap{width:100%!important;}.pad{padding-left:22px!important;padding-right:22px!important;}.hero-title{font-size:34px!important;}}</style></head>
<body style="margin:0;padding:0;background:#E9E6DE;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9E6DE;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:4px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:${ink};">
  <tr><td style="background:${night};padding:26px 40px 22px;" align="center">
    <img src="${LOGO2}" width="72" alt="Australian Martial Arts Academy" style="display:block;width:72px;height:auto;border:0;margin:0 auto;">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-weight:600;font-size:15px;letter-spacing:4px;color:#FFFFFF;padding-top:12px;text-transform:uppercase;">Australian Martial Arts Academy</div>
    <div style="font-weight:bold;font-size:10px;letter-spacing:3px;color:${gold};padding-top:6px;">Sydney &middot; Since 1982</div></td></tr>
  <tr><td style="padding:0;" align="center"><img src="${HERO2}" width="600" alt="AMA grading" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
  <tr><td class="pad" style="background:${night};padding:22px 32px 26px;">
    <div style="color:${gold};font-size:12px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;">${esc(eyebrow)}</div>
    <div class="hero-title" style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;color:#ffffff;font-weight:700;font-size:40px;line-height:1.05;text-transform:uppercase;margin-top:8px;">${esc(heading)}</div></td></tr>
  <tr><td class="pad" style="padding:30px 32px 6px;">
    <p style="margin:0;font-size:16px;line-height:1.55;color:#333;">Hi ${esc(v.parent)},</p>
    <p style="margin:12px 0 0;font-size:16px;line-height:1.55;color:#333;">${esc(intro)}</p></td></tr>
  <tr><td class="pad" style="padding:18px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${cream};border-radius:10px;border:1px solid ${creamLine};"><tr><td style="padding:6px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;">
      ${rows.map(([k, x]) => `<tr><td style="font-size:13px;color:#666;padding:9px 0;width:38%;">${esc(k)}</td><td style="font-size:14px;color:#1c1c1c;font-weight:bold;padding:9px 0;">${esc(x)}</td></tr>`).join('')}
      </table></td></tr></table></td></tr>
  ${v.receipt ? `<tr><td class="pad" align="center" style="padding:18px 32px 0;"><a href="${esc(v.receipt)}" style="display:inline-block;background:${green};color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:14px;padding:11px 24px;border-radius:8px;">View your receipt</a></td></tr>` : ''}
  ${upHtml}
  <tr><td class="pad" style="padding:26px 32px 4px;">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:17px;font-weight:600;text-transform:uppercase;color:#14321f;">What to bring</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;">${bring.map(b => `<tr><td valign="top" style="color:${green};font-weight:bold;padding:3px 10px 3px 0;">&#10003;</td><td style="font-size:14px;color:#333;padding:3px 0;">${esc(b)}</td></tr>`).join('')}</table>
    <p style="margin:16px 0 0;font-size:14px;line-height:1.55;color:#555;">Please arrive 15 minutes early. Good luck, ${esc(v.kid)}! Family and friends are welcome to come and watch.</p></td></tr>
  <tr><td style="background:${night};padding:22px 32px;" align="center">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;color:#ffffff;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Australian Martial Arts Academy</div>
    <div style="color:#9aa39a;font-size:13px;margin-top:8px;line-height:1.5;">Questions? Call us on ${tel ? `<a href="tel:${esc(tel)}" style="color:${gold};text-decoration:none;">${esc(v.phone)}</a>` : esc(v.phone || 'the front desk')}<br>AMA ${esc(v.school)}</div></td></tr>
</table></td></tr></table></body></html>`;
  const text = [`Hi ${v.parent},`, intro, ...rows.map(([k, x]) => `${k}: ${x}`), ...(v.receipt ? [`Your receipt: ${v.receipt}`] : []), ...upText,
    'What to bring:', ...bring.map(b => '- ' + b), 'Please arrive 15 minutes early.', `Questions? Call us on ${v.phone || 'the front desk'}.`, `AMA ${v.school}`].join('\n');
  return { subject, html, text };
}

// Grading video for the belt the student is on now (Taekwondo + Little Dragons; blank for programmes without one). Same as the app (update 15).
const GRADING_VIDEOS = {
  'White Belt': 'https://youtu.be/rEz_0Fru2xQ', 'Yellow Belt': 'https://youtu.be/dWmyzrtqTG8', 'Orange Belt': 'https://youtu.be/-ioyCHMzIYA',
  'Green Belt': 'https://youtu.be/EMJOGc1CFB0', 'Blue Belt': 'https://youtu.be/3p4Mw9OPo0U', 'Purple Belt': 'https://youtu.be/JrKEaXUj698',
  'Brown Belt': 'https://youtu.be/AygN5MoWv_M', 'Red Belt': 'https://youtu.be/qPwhLvx5UOY', 'Red Two Belt': 'https://youtu.be/6Ero56Plb_I',
  'Red Three Belt': 'https://youtu.be/LUKU_llSB-Y'
};
export function videoForBelt(programme, belt) {
  const prog = programme || '';
  if (/little dragon/i.test(prog)) return GRADING_VIDEOS['White Belt'];
  if (prog && prog !== 'Taekwondo') return '';
  const b = String(belt || '').replace(/\s+/g, ' ').trim();
  const key = Object.keys(GRADING_VIDEOS).find(k => k.toLowerCase() === (/belt$/i.test(b) ? b : b + ' Belt').toLowerCase());
  return key ? GRADING_VIDEOS[key] : '';
}
// The optional Colour Belt Prep Session (same details as the app, update 15). Shown until bookings close, then left out.
const PREP = { closes: '2026-11-19', url: 'https://train.australianmartialarts.com.au/colour-belt-prep',
  text: 'A 2-hour workshop with Mr Mark and Master Hakan covering only grading material, on Sunday 22 November at AMA Marrickville. Students from every AMA school are welcome.' };
function prepUrlFor(age) { return PREP.url + (age == null ? '' : age >= 13 ? '?s=teens' : '?s=kids'); }

// The grading helper invitation (Grading Helpers admin > Invite > Send): a text and an AMA house-style email with the
// helper's personal sign-up link. v = { first, parent (set when they're under 18: worded for the parent), link, phone, days:[{ day, date, mon, where, time, belts }], more }
export function buildHelperInvite(v) {
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kid = !!v.parent, who = kid ? v.first : 'you', whose = kid ? `${v.first}'s` : 'your';
  const sms = kid
    ? `Hi ${v.parent}, we'd love ${v.first}'s help at our coloured belt gradings over the next few weeks. They can pick the gradings they can help at here: ${v.link} Thank you! - AMA`
    : `Hi ${v.first}, we'd love your help at our coloured belt gradings over the next few weeks. Pick the gradings you can help at here: ${v.link} Thank you! - AMA`;
  const subject = kid ? `${v.first}'s invitation to help at our coloured belt gradings` : 'Help at our coloured belt gradings';
  const greet = kid ? v.parent : v.first;
  const p1 = kid ? `We'd love ${v.first}'s help at our coloured belt gradings over the next few weeks. Helping out is a great way to give back to the younger students, and seeing a grading from the other side is great experience for ${v.first}'s own.`
    : "We'd love your help at our coloured belt gradings over the next few weeks. Helping out is a great way to give back to the younger students, and seeing a grading from the other side is great experience for your own.";
  const p2 = kid ? `${v.first}'s personal link shows the gradings that still need helpers. They can pick as many as they like.` : 'Your personal link shows the gradings that still need helpers. Pick as many as you like.';
  const days = v.days || [], tel = String(v.phone || '').replace(/[^\d+]/g, '');
  const ink = '#1c1c1c', gold = '#FFD200', green = '#0B6A35', night = '#0E0E0E', cream = '#F4F2EC', creamLine = '#E3DFD4';
  const btn = (label) => `<a href="${esc(v.link)}" style="display:inline-block;background:${green};color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:16px;padding:14px 30px;border-radius:8px;">${esc(label)}</a>`;
  const dayRows = days.map((d, i) => `<tr><td style="padding:11px 0;${i ? `border-top:1px solid ${creamLine};` : ''}width:58px;" valign="top">
      <table role="presentation" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${creamLine};border-radius:8px;width:48px;"><tr><td align="center" style="padding:5px 0;font-family:Arial,Helvetica,sans-serif;line-height:1.1;">
        <div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:${green};text-transform:uppercase;">${esc(d.day)}</div><div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:20px;font-weight:700;color:${ink};">${esc(d.date)}</div><div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:#666;text-transform:uppercase;">${esc(d.mon || '')}</div></td></tr></table></td>
    <td style="padding:11px 0 11px 12px;${i ? `border-top:1px solid ${creamLine};` : ''}font-family:Arial,Helvetica,sans-serif;" valign="middle">
      <div style="font-size:15px;font-weight:bold;color:${ink};">AMA ${esc(d.where)}${d.time ? ' &middot; ' + esc(d.time) : ''}</div>${d.belts ? `<div style="font-size:13px;color:#666;margin-top:2px;">${esc(d.belts)}</div>` : ''}</td></tr>`).join('');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&display=swap');body{margin:0;padding:0;background:#E9E6DE;}a{color:${green};}@media (max-width:620px){.wrap{width:100%!important;}.pad{padding-left:22px!important;padding-right:22px!important;}.hero-title{font-size:34px!important;}}</style></head>
<body style="margin:0;padding:0;background:#E9E6DE;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(p1)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9E6DE;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:4px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:${ink};">
  <tr><td style="background:${night};padding:26px 40px 22px;" align="center">
    <img src="${LOGO2}" width="72" alt="Australian Martial Arts Academy" style="display:block;width:72px;height:auto;border:0;margin:0 auto;">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-weight:600;font-size:15px;letter-spacing:4px;color:#FFFFFF;padding-top:12px;text-transform:uppercase;">Australian Martial Arts Academy</div>
    <div style="font-weight:bold;font-size:10px;letter-spacing:3px;color:${gold};padding-top:6px;">Sydney &middot; Since 1982</div></td></tr>
  <tr><td style="padding:0;" align="center"><img src="${HERO2}" width="600" alt="AMA students and instructor" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
  <tr><td class="pad" style="background:${night};padding:22px 32px 26px;">
    <div style="color:${gold};font-size:12px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;">Grading helpers</div>
    <div class="hero-title" style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;color:#ffffff;font-weight:700;font-size:40px;line-height:1.05;text-transform:uppercase;margin-top:8px;">${kid ? esc(`We'd love ${v.first}'s help.`) : "We'd love your help."}</div></td></tr>
  <tr><td class="pad" style="padding:30px 32px 4px;">
    <p style="margin:0;font-size:16px;line-height:1.55;color:#333;">Hi ${esc(greet)},</p>
    <p style="margin:12px 0 0;font-size:16px;line-height:1.55;color:#333;">${esc(p1)}</p>
    <p style="margin:12px 0 0;font-size:16px;line-height:1.55;color:#333;">${esc(p2)}</p></td></tr>
  <tr><td class="pad" align="center" style="padding:22px 32px 6px;">${btn(kid ? `Pick ${v.first}'s gradings` : 'Pick my gradings')}</td></tr>
  ${days.length ? `<tr><td class="pad" style="padding:22px 32px 0;">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:17px;font-weight:600;text-transform:uppercase;color:#14321f;">Gradings that need helpers</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;background:${cream};border-radius:10px;border:1px solid ${creamLine};"><tr><td style="padding:4px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${dayRows}</table></td></tr></table>
    ${v.more ? `<p style="margin:10px 0 0;font-size:13px;color:#666;">And ${v.more} more on ${whose} list.</p>` : ''}</td></tr>` : ''}
  <tr><td class="pad" style="padding:20px 32px 28px;">
    <p style="margin:0;font-size:16px;line-height:1.55;color:#333;">Thank you,<br><b>Australian Martial Arts Academy</b></p></td></tr>
  <tr><td style="background:${night};padding:22px 32px;" align="center">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;color:#ffffff;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Australian Martial Arts Academy</div>
    <div style="color:#9aa39a;font-size:13px;margin-top:8px;line-height:1.5;">Questions? Call us on ${tel ? `<a href="tel:${esc(tel)}" style="color:${gold};text-decoration:none;">${esc(v.phone)}</a>` : esc(v.phone || 'the front desk')}</div></td></tr>
</table></td></tr></table></body></html>`;
  const text = [`Hi ${greet},`, '', p1, '', p2, '', `Pick ${kid ? v.first + "'s" : 'your'} gradings: ${v.link}`, '',
    ...(days.length ? ['Gradings that need helpers:', ...days.map(d => `- ${d.day} ${d.date} ${d.mon || ''}: AMA ${d.where}${d.time ? ' at ' + d.time : ''}${d.belts ? ' (' + d.belts + ')' : ''}`), ...(v.more ? [`And ${v.more} more.`] : []), ''] : []),
    'Thank you,', 'Australian Martial Arts Academy'].join('\n');
  return { sms, subject, html, text, who };
}

// The family grading invitation email, in AMA's house style (matches Mark's GHL template: black header, Oswald, #FFD200 gold, green buttons).
// v = { parent, school, phone, bring:[], prepOpen, prepUrl, children:[{ first, beltTo, programme, when, where, bookUrl, videoUrl }] }
const LOGO2 = 'https://www.australianmartialarts.com.au/wp-content/uploads/2019/12/logo1.png';
const HERO2 = 'https://www.australianmartialarts.com.au/wp-content/uploads/2026/09/Marrickville-Martial-Arts-Students-breaking-a-board-with-instructor.png';
export function buildGradingInvite(v) {
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kids = v.children || [];
  const only = kids.length === 1 ? kids[0].first : null;
  const subject = only ? `${only}'s grading invitation — AMA ${v.school}` : `Grading invitation for your family — AMA ${v.school}`;
  const card = c => `<tr><td class="pad" style="padding:${kids.indexOf(c) ? 14 : 22}px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2EC;border-radius:10px;border:1px solid #E3DFD4;"><tr><td style="padding:18px 20px;">
      <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:20px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#14321f;">${esc(c.first)}</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#555;margin-top:2px;">Grading for their <b style="color:#1c1c1c;">${esc(c.beltTo)}</b></div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:12px;font-family:Arial,Helvetica,sans-serif;">
        <tr><td style="font-size:13px;color:#666;padding:2px 0;width:70px;">When</td><td style="font-size:14px;color:#1c1c1c;font-weight:bold;padding:2px 0;">${esc(c.when)}</td></tr>
        <tr><td style="font-size:13px;color:#666;padding:2px 0;">Where</td><td style="font-size:14px;color:#1c1c1c;font-weight:bold;padding:2px 0;">AMA ${esc(c.where)}</td></tr></table>
      <a href="${esc(c.bookUrl)}" style="display:inline-block;margin-top:14px;background:#0B6A35;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:14px;padding:11px 22px;border-radius:8px;">Book ${esc(c.first)}'s spot</a>
      ${c.videoUrl ? `<a href="${esc(c.videoUrl)}" style="display:inline-block;margin-top:14px;margin-left:6px;background:#ffffff;color:#0B6A35;border:2px solid #0B6A35;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:14px;padding:9px 18px;border-radius:8px;">Watch the grading video</a>` : ''}
    </td></tr></table></td></tr>`;
  const prepBlock = v.prepOpen ? `<tr><td class="pad" style="padding:26px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#14321f;border-radius:10px;"><tr><td style="padding:20px 22px;">
      <div style="font-family:Arial,Helvetica,sans-serif;color:#FFD200;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;">Optional extra</div>
      <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;color:#ffffff;font-size:20px;font-weight:600;text-transform:uppercase;margin-top:6px;">Colour Belt Prep Session</div>
      <p style="margin:10px 0 0;font-family:Arial,Helvetica,sans-serif;color:#dfe7df;font-size:14px;line-height:1.5;">${esc(PREP.text)}</p>
      <a href="${esc(v.prepUrl || PREP.url)}" style="display:inline-block;margin-top:14px;background:#ffffff;color:#14321f;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:14px;padding:11px 22px;border-radius:8px;">Book a place</a>
    </td></tr></table></td></tr>` : '';
  const bring = (v.bring && v.bring.length ? v.bring : ['Full long-sleeve uniform', 'Belt', 'Drink bottle']);
  const tel = String(v.phone || '').replace(/[^\d+]/g, '');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&display=swap');body{margin:0;padding:0;background:#E9E6DE;}a{color:#0B6A35;}@media (max-width:620px){.wrap{width:100%!important;}.pad{padding-left:22px!important;padding-right:22px!important;}.hero-title{font-size:34px!important;}}</style></head>
<body style="margin:0;padding:0;background:#E9E6DE;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">The December grading cycle is here — your child's grading day and booking link inside.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9E6DE;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:4px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#1c1c1c;">
  <tr><td style="background:#0E0E0E;padding:26px 40px 22px;" align="center">
    <img src="${LOGO2}" width="72" alt="Australian Martial Arts Academy" style="display:block;width:72px;height:auto;border:0;margin:0 auto;">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-weight:600;font-size:15px;letter-spacing:4px;color:#FFFFFF;padding-top:12px;text-transform:uppercase;">Australian Martial Arts Academy</div>
    <div style="font-weight:bold;font-size:10px;letter-spacing:3px;color:#FFD200;padding-top:6px;">Sydney &middot; Since 1982</div></td></tr>
  <tr><td style="padding:0;" align="center"><img src="${HERO2}" width="600" alt="AMA grading" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
  <tr><td class="pad" style="background:#0E0E0E;padding:22px 32px 26px;">
    <div style="color:#FFD200;font-size:12px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;">December 2026 Belt Promotions</div>
    <div class="hero-title" style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;color:#ffffff;font-weight:700;font-size:40px;line-height:1.05;text-transform:uppercase;margin-top:8px;">It's grading time.</div></td></tr>
  <tr><td class="pad" style="padding:30px 32px 6px;">
    <p style="margin:0;font-size:16px;line-height:1.55;color:#333;">Hi <b>${esc(v.parent)}</b>,</p>
    <p style="margin:12px 0 0;font-size:16px;line-height:1.55;color:#333;">Great news — ${only ? `<b>${esc(only)}</b> has` : 'your family has'} been invited to the December grading cycle at AMA. Here ${only ? 'is the grading day' : 'is each student’s grading day'}, with a link to lock in ${only ? 'their' : 'each'} spot.</p></td></tr>
  ${kids.map(card).join('')}
  ${prepBlock}
  <tr><td class="pad" style="padding:26px 32px 4px;">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:17px;font-weight:600;text-transform:uppercase;color:#14321f;">What to bring</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;">${bring.map(b => `<tr><td valign="top" style="color:#0B6A35;font-weight:bold;padding:3px 10px 3px 0;">&#10003;</td><td style="font-size:14px;color:#333;padding:3px 0;">${esc(b)}</td></tr>`).join('')}</table>
    <p style="margin:16px 0 0;font-size:14px;line-height:1.55;color:#555;">Please arrive 15 minutes early. Family and friends are welcome to come and watch.</p></td></tr>
  <tr><td style="background:#0E0E0E;padding:22px 32px;" align="center">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;color:#ffffff;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Australian Martial Arts Academy</div>
    <div style="color:#9aa39a;font-size:13px;margin-top:8px;line-height:1.5;">Questions? Call us on ${tel ? `<a href="tel:${esc(tel)}" style="color:#FFD200;text-decoration:none;">${esc(v.phone)}</a>` : esc(v.phone || 'the front desk')}<br>AMA ${esc(v.school)}</div></td></tr>
</table></td></tr></table></body></html>`;
  const text = [`Hi ${v.parent},`, `${only ? only + ' has' : 'Your family has'} been invited to the December grading cycle at AMA.`, '',
    ...kids.flatMap(c => [`${c.first} — grading for their ${c.beltTo}`, `  When: ${c.when}`, `  Where: AMA ${c.where}`, `  Book: ${c.bookUrl}`, ...(c.videoUrl ? [`  Grading video: ${c.videoUrl}`] : []), '']),
    ...(v.prepOpen ? ['Optional Colour Belt Prep Session: ' + PREP.text + ' ' + (v.prepUrl || PREP.url), ''] : []),
    'What to bring: ' + bring.join(', ') + '.', 'Please arrive 15 minutes early.', `Questions? Call ${v.phone || 'the front desk'}.`, `AMA ${v.school}`].join('\n');
  return { subject, html, text };
}

// ======================= The automated booking sequence (coloured-belts-23.sql) =======================
// Sydney time helpers. sydParts(ms) -> { ymd, hm, dow }; sydMs('2026-11-24', '10:00') -> the UTC time of that Sydney moment.
const SYD = 'Australia/Sydney';
// One formatter, made once: building an Intl.DateTimeFormat per call costs enough CPU that planning ~800 students ran out of time
const SYD_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: SYD, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
export function sydParts(ms) {
  const p = Object.fromEntries(SYD_FMT.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, dow: p.weekday };
}
const SYD_MS = new Map();   // the same few dates and times come up for every student
export function sydMs(ymd, hm = '00:00') {
  const key = String(ymd).slice(0, 10) + ' ' + hm;
  if (SYD_MS.has(key)) return SYD_MS.get(key);
  const v = sydMs0(ymd, hm); if (SYD_MS.size < 5000) SYD_MS.set(key, v); return v;
}
function sydMs0(ymd, hm) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number), [h, mi] = String(hm).split(':').map(Number);
  const want = Date.UTC(y, m - 1, d, h, mi || 0);
  let guess = want - 11 * 3600e3;
  for (let i = 0; i < 3; i++) { const q = sydParts(guess); const [qy, qm, qd] = q.ymd.split('-').map(Number), [qh, qmi] = q.hm.split(':').map(Number); guess += want - Date.UTC(qy, qm - 1, qd, qh, qmi); }
  return guess;
}
const addDaysYmd = (ymd, n) => { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dowOf = ymd => new Date(String(ymd).slice(0, 10) + 'T00:00:00Z').getUTCDay();   // 0 = Sunday
export const SEQ_HOURS = { from: '08:00', to: '19:30' };   // nothing is sent outside these Sydney hours
export const SEQ_STALE_MS = 12 * 3600e3;                     // a step more than 12 hours late is never sent ("missed")
export const SEQ_MAX_SENDS = 40;                              // messages per run (the rest go on the next run)

// When a step is due for one student, as a UTC time (or null if it can't be worked out)
export function stepDue(step, e, d) {
  const at = step.send_at ? String(step.send_at).slice(0, 5) : null;
  if (step.anchor === 'invite') {
    if (!e.invited_at) return null;
    const inv = Date.parse(e.invited_at);
    return at ? sydMs(addDaysYmd(sydParts(inv).ymd, step.offset_days || 0), at) : inv + (step.offset_days || 0) * 864e5;
  }
  if (step.anchor === 'grading') {
    let day = addDaysYmd(d.grading_date, step.offset_days || 0);
    if (step.channel === 'call' && dowOf(day) === 0) day = addDaysYmd(day, -1);   // no calls on a Sunday: the Saturday before
    return sydMs(day, at || '09:00');
  }
  if (step.anchor === 'date') return step.send_date ? sydMs(step.send_date, at || '10:00') : null;
  if (step.anchor === 'paid') return e.paid ? (e.paid_at ? Date.parse(e.paid_at) : null) : null;
  return null;
}

// What to do now, for every student on a coming coloured belt day. Pure: no sending, no database.
// x = { now, steps, days, entries, logs: Set('entry|code'), skipped: Set(member_key), prepBooked: Set(member_key) }
// Returns [{ entry_id, code, act }] where act is 'send' | 'call' | 'skip' | 'missed' | 'invite_by_hand', with a why for skip/missed.
export function planSequence(x) {
  const out = [], now = x.now, nowP = sydParts(now);
  const inHours = nowP.hm >= SEQ_HOURS.from && nowP.hm <= SEQ_HOURS.to;
  const steps = (x.steps || []).filter(s => s.active && !String(s.code).startsWith('out_')).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const dayBy = Object.fromEntries((x.days || []).map(d => [d.day_id, d]));
  for (const e of x.entries || []) {
    const d = dayBy[e.day_id];
    if (!d || d.bb || d.closed || e.result || e.seq_stopped_at) continue;
    if (String(d.grading_date) < nowP.ymd) continue;                 // that grading is over
    if (x.skipped && x.skipped.has(e.member_key)) continue;          // cancelled or on hold: nothing at all
    const has = c => x.logs.has(e.entry_id + '|' + c);
    const paused = e.seq_paused_until && Date.parse(e.seq_paused_until) > now;
    const prepBooked = !!(x.prepBooked && x.prepBooked.has(e.member_key));
    for (const s of steps) {
      if (has(s.code)) continue;
      // The invitation: sent as soon as they're on the day (in sending hours). Invited by hand already: never again.
      if (s.anchor === 'invite' && s.offset_days === 0 && !s.send_at) {
        if (e.invited_at && !has('invite_sms')) { out.push({ entry_id: e.entry_id, code: s.code, act: 'invite_by_hand' }); continue; }
        if (e.invited_at) continue;
        if (e.paid) { out.push({ entry_id: e.entry_id, code: s.code, act: 'skip', why: 'Already paid' }); continue; }
        if (!inHours || paused) continue;
        out.push({ entry_id: e.entry_id, code: s.code, act: 'send' });
        continue;
      }
      if (!e.invited_at) continue;                                   // nothing else before the invitation has gone
      const due = stepDue(s, e, d);
      if (due == null || due > now) continue;
      // A student added late starts at the invitation, then the next step still ahead: never the ones before they started
      if (s.anchor !== 'paid' && s.anchor !== 'invite' && due < Date.parse(e.invited_at)) { out.push({ entry_id: e.entry_id, code: s.code, act: 'missed', why: 'Before they were invited' }); continue; }
      if (now - due > SEQ_STALE_MS) { out.push({ entry_id: e.entry_id, code: s.code, act: 'missed', why: 'Too late to send' }); continue; }
      // Each step is skipped if the family has already done what it asks
      const aud = s.audience;
      if (aud === 'not_paid' && e.paid) { out.push({ entry_id: e.entry_id, code: s.code, act: 'skip', why: 'Booked and paid' }); continue; }
      if (aud === 'not_booked' && (e.booked_at || e.paid)) { out.push({ entry_id: e.entry_id, code: s.code, act: 'skip', why: 'Booked' }); continue; }
      if (aud === 'paid' && !e.paid) { out.push({ entry_id: e.entry_id, code: s.code, act: 'skip', why: 'Not booked and paid' }); continue; }
      if (aud === 'prep_not_booked' && prepBooked) { out.push({ entry_id: e.entry_id, code: s.code, act: 'skip', why: 'Booked into the prep session' }); continue; }
      if (aud === 'prep_booked' && !prepBooked) { out.push({ entry_id: e.entry_id, code: s.code, act: 'skip', why: 'Not booked into the prep session' }); continue; }
      if (s.channel === 'call') { out.push({ entry_id: e.entry_id, code: s.code, act: 'call' }); continue; }
      if (paused && s.track === 'booking') continue;                 // they replied: the booking messages wait 2 days
      if (!inHours) continue;
      out.push({ entry_id: e.entry_id, code: s.code, act: 'send' });
    }
  }
  return out;
}

// The fields every sequence message can use
export function seqVars(e, d, m, o = {}) {
  const et = entryTime(d, e), t = et ? clock(et) : '';
  const age = (m && typeof m.date_of_birth === 'string' && /^\d{4}-\d{2}-\d{2}/.test(m.date_of_birth)) ? Math.floor(((o.now || Date.now()) - Date.parse(m.date_of_birth.slice(0, 10))) / 31557600000) : null;
  const prepUrl = (o.prepUrl || PREP.url) + (age == null ? '' : age >= 13 ? '?s=teens' : '?s=kids');
  const prepOpen = sydParts(o.now || Date.now()).ymd <= (o.prepCloses || PREP.closes);
  const video = videoForBelt(d.programme, e.belt_from);
  const dl = addDaysYmd(d.grading_date, -(o.deadlineDays ?? 7));
  const deadline = new Date(dl + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
  return { parent: firstWord(m && m.guardian_name) || 'there', first: firstWord((m && m.full_name) || e.full_name), next: e.belt_to, school: venueOf(d.location),
    date: longDay(d.grading_date), time: t ? ' at ' + t : '', time_only: t || 'to be confirmed', link: SITE + 'b#' + e.token,
    video: video ? 'Grading video: ' + video : '', video_link: video || 'ask your instructor',
    prep: prepOpen ? (o.channel === 'email' ? PREP.text + ' Book a place: ' + prepUrl : 'Optional extra: our Colour Belt Prep Session is a 2-hour workshop with Mr Mark and Master Hakan covering only grading material, on Sunday 22 November at AMA Marrickville. Students from every AMA school are welcome. Book a place: ' + prepUrl) : '',
    prep_link: prepUrl, prep_time: o.prepTime ? ', ' + o.prepTime : '', deadline,
    fee: o.fee != null ? '$' + Number(o.fee).toFixed(0) : 'shown when you book', bring: (o.bring || ['Full long-sleeve uniform', 'Belt', 'Drink bottle']).join(', ').toLowerCase().replace(/^./, c => c.toUpperCase()),
    phone: o.phone || '(02) 9569 1943' };
}

// The button wording for a web address in a sequence email
export function linkLabel(u) {
  const s = String(u);
  if (/youtu\.?be/i.test(s)) return 'Watch the grading video';
  if (/colour-belt-prep/i.test(s)) return 'Book the Prep Session';
  if (/train-ama\.com\/b#|\/book\//i.test(s)) return 'Book the grading';
  if (/receipt/i.test(s)) return 'View your receipt';
  return 'Open link';
}

// A sequence email: the wording from Settings in AMA's email style. "## Heading", "• point", "[Button](link)", other lines are paragraphs.
export function buildSeqEmail(subject, body) {
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Every web address in the wording becomes a button, named for where it goes; the words around it stay as text.
  const button = (href, label, small) => `<a href="${esc(href)}" style="display:inline-block;background:#0B6A35;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:${small ? '9px 18px' : '11px 22px'};border-radius:8px;">${esc(label)}</a>`;
  const linkify = (s, small) => {
    const urls = [];
    const words = String(s).replace(/(https?:\/\/[^\s<]+[^\s<.,!?)])/g, u => { urls.push(u); return ' '; })
      .replace(/\s*(Book a place|Book here|Book their spot here)?\s*:?\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
    if (!urls.length) return esc(s);
    return (words ? esc(words) : '') + urls.map(u => `<div style="margin-top:10px;">${button(u, linkLabel(u), small)}</div>`).join('');
  };
  const lines = String(body || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const parts = []; let list = [];
  const flush = () => { if (list.length) { parts.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 2px;">${list.map(b => `<tr><td valign="top" style="color:#0B6A35;font-weight:bold;padding:3px 10px 3px 0;">&#10003;</td><td style="font-size:15px;line-height:1.5;color:#333;padding:3px 0 6px;">${linkify(b, true)}</td></tr>`).join('')}</table>`); list = []; } };
  for (const l of lines) {
    const btn = l.match(/^\[(.+?)\]\((https?:\/\/[^)\s]+)\)$/);
    if (/^[•\-*]\s+/.test(l)) { if (!/:\s*$/.test(l)) list.push(l.replace(/^[•\-*]\s+/, '')); continue; }   // a point left empty (e.g. the prep session once bookings close) is dropped
    flush();
    if (/^##\s+/.test(l)) parts.push(`<div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:17px;font-weight:600;text-transform:uppercase;color:#14321f;margin:22px 0 4px;">${esc(l.replace(/^##\s+/, ''))}</div>`);
    else if (btn) parts.push(`<p style="margin:16px 0;">${button(btn[2], btn[1])}</p>`);
    else parts.push(`<div style="margin:12px 0 0;font-size:16px;line-height:1.55;color:#333;">${linkify(l)}</div>`);
  }
  flush();
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&display=swap');body{margin:0;padding:0;background:#E9E6DE;}@media (max-width:620px){.wrap{width:100%!important;}.pad{padding-left:22px!important;padding-right:22px!important;}}</style></head>
<body style="margin:0;padding:0;background:#E9E6DE;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9E6DE;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:4px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#1c1c1c;">
  <tr><td style="background:#0E0E0E;padding:26px 40px 22px;" align="center"><img src="${LOGO2}" width="72" alt="Australian Martial Arts Academy" style="display:block;width:72px;height:auto;border:0;margin:0 auto;">
    <div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-weight:600;font-size:15px;letter-spacing:4px;color:#FFFFFF;padding-top:12px;text-transform:uppercase;">Australian Martial Arts Academy</div></td></tr>
  <tr><td class="pad" style="padding:26px 32px 30px;">${parts.join('\n')}</td></tr>
  <tr><td style="background:#0E0E0E;padding:18px 32px;" align="center"><div style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;color:#ffffff;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Australian Martial Arts Academy</div></td></tr>
</table></td></tr></table></body></html>`;
  const text = lines.filter(l => !(/^[•\-*]\s+/.test(l) && /:\s*$/.test(l))).map(l => l.replace(/^##\s+/, '').replace(/^\[(.+?)\]\((.+)\)$/, '$1: $2')).join('\n');
  return { subject, html, text };
}

async function entryByToken(db, token) {
  if (!tokenOk(token)) return null;
  const { data: e } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, booked_at, booking_error, result, paid, paid_how, late_ok_until, school, discount, discount_kind, discount_reason, discount_note').eq('token', token).maybeSingle();
  if (!e) return null;
  const { data: d } = await db.from('cb_days').select('day_id, location, grading_date, start_time, efc_session_id, efc_sessions, efc_belt_sessions, efc_school_belt_sessions, belt_times, closed, programme, book_by, bb, prep_cycle_id').eq('day_id', e.day_id).maybeSingle();
  return d ? { e, d } : null;
}

// Black belt essay: on a black belt (Dan) grading day, work out whether this student still owes their black belt
// essay and, if so, the link to write it. Mirrors the nurture flow: cb entry -> efc_members.efc_reference ->
// prep_students -> prep_essays. Returns the essay page URL when one is still due, otherwise null.
async function essayUrlFor(db, e, d) {
  try {
    if (!(d && d.bb && d.prep_cycle_id && e && e.member_key && e.belt_to)) return null;
    const { data: m } = await db.from('efc_members').select('efc_reference').eq('member_key', e.member_key).maybeSingle();
    if (!m || !m.efc_reference) return null;
    const { data: ps } = await db.from('prep_students').select('student_id').eq('efc_ref', m.efc_reference).maybeSingle();
    if (!ps || !ps.student_id) return null;
    const target = e.belt_to;
    const { data: eqs } = await db.from('prep_essay_questions').select('target_rank');
    if (!(eqs || []).some(q => q.target_rank === target)) return null;   // this rank needs no essay
    const { data: ess } = await db.from('prep_essays').select('target_rank, status, token').eq('cycle_id', d.prep_cycle_id).eq('student_id', ps.student_id);
    const essRow = (ess || []).find(x => x.target_rank === target);
    if (essRow && ['submitted', 'reviewed'].includes(essRow.status)) return null;   // already in
    let tok = essRow && essRow.token;
    if (!tok) { tok = essayToken(); await db.from('prep_essays').insert({ cycle_id: d.prep_cycle_id, student_id: ps.student_id, target_rank: target, token: tok }); }
    return SITE + 'e/#' + tok;
  } catch (_) { return null; }
}

// ---- Grading helpers (invite-only black belt sign-up) ----
async function helperByToken(db, token) {
  if (!tokenOk(token)) return null;
  let { data, error } = await db.from('cb_helpers').select('helper_id, member_key, full_name, active, little_dragons').eq('token', token).maybeSingle();
  if (error) ({ data } = await db.from('cb_helpers').select('helper_id, member_key, full_name, active').eq('token', token).maybeSingle());   // before cb-helpers-send.sql
  return (data && data.active) ? data : null;
}
// Little Dragons gradings are only shown to the helpers staff pick (cb_helpers.little_dragons)
const isLittleDragons = d => /little dragon/i.test(String((d && d.programme) || ''));
const helperSeesDay = (h, d) => !isLittleDragons(d) || !!(h && h.little_dragons);
async function helperAgeOf(db, member_key) {
  const { data: m } = await db.from('efc_members').select('date_of_birth').eq('member_key', member_key).maybeSingle();
  const dob = m && m.date_of_birth;
  return (typeof dob === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dob)) ? Math.floor((Date.now() - Date.parse(dob.slice(0, 10))) / 31557600000) : null;
}
// A coloured-belt day is visible to a helper of this age: 'kids' and 'all' show to everyone,
// '13+' (teens & adults) is hidden from under-18s. Unknown age is treated as an adult.
const helperCanSee = (aud, age) => aud !== '13+' || age == null || age >= 18;
// Friendly date/time bits for the helper page
const HELP_DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HELP_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const helpDow = s => HELP_DOW[new Date(s + 'T00:00:00').getDay()];
const helpDate = s => { const d = new Date(s + 'T00:00:00'); return d.getDate() + ' ' + HELP_MON[d.getMonth()]; };
const helpTime = t => { if (!t) return null; let [H, M] = String(t).split(':').map(Number); const ap = H >= 12 ? 'pm' : 'am'; H = H % 12 || 12; return H + (M ? ':' + String(M).padStart(2, '0') : '') + ap; };
const helperDayRow = (d, counts, mine) => ({
  id: d.day_id, wd: helpDow(d.grading_date), date: helpDate(d.grading_date), loc: d.location, time: helpTime(d.start_time),
  belts: /little dragon/i.test(String(d.programme || '')) ? 'Little Dragons' : Array.isArray(d.belts) && d.belts.length ? d.belts.join(', ') : (d.programme || ''),
  audience: d.bb ? null : (d.helper_audience || 'all'), cap: d.helper_cap, count: counts[d.day_id] || 0, mine: mine.has(d.day_id)
});

export async function handle(req, db, env = {}, http = fetch) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  const stripe = async (path, opts = {}) => {
    const r = await http(STRIPE + path, { ...opts, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || `Stripe said ${r.status}`);
    return j;
  };
  // GoHighLevel: find or add the family's contact, then send them a text or an email
  const ghl = async (path, opts = {}, version = '2021-07-28') => {
    const r = await http(API + path, { ...opts, headers: { Authorization: 'Bearer ' + env.GHL_TOKEN, Version: version, Accept: 'application/json', 'Content-Type': 'application/json' } });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error(j.message ? [].concat(j.message).join(', ') : `GoHighLevel said ${r.status}`);
    return j;
  };
  const contactFor = async (m, phone) => {
    for (const [k, v] of [['number', phone], ['email', m.email]]) {
      if (!v) continue;
      const r = await ghl(`/contacts/search/duplicate?locationId=${encodeURIComponent(env.GHL_LOCATION_ID)}&${k}=${encodeURIComponent(v)}`, { method: 'GET' });
      if (r.contact && r.contact.id) return r.contact.id;
    }
    const parts = String(m.guardian_name || m.full_name || '').trim().split(/\s+/);
    const r = await ghl('/contacts/', { method: 'POST', body: JSON.stringify({ locationId: env.GHL_LOCATION_ID, firstName: parts[0] || '', lastName: parts.slice(1).join(' '),
      ...(phone ? { phone } : {}), ...(m.email ? { email: m.email } : {}), tags: ['ama coloured belt grading'], source: 'AMA coloured belt grading' }) });
    return (r.contact || {}).id;
  };
  const sendEmailTo = (contactId, m) => ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'Email', contactId, subject: m.subject, html: m.html, message: m.text }) }, '2021-04-15');
  // Leave a note on the family's GoHighLevel contact (member notes live on their GHL profile).
  const addNote = (contactId, body) => ghl('/contacts/' + contactId + '/notes', { method: 'POST', body: JSON.stringify({ body: String(body).slice(0, 5000) }) }, '2021-07-28');
  // Send a text; returns GoHighLevel's message id. GoHighLevel can accept a text and fail it afterwards (its daily SMS limit),
  // so each text's real status is checked on a later run (verifySms) and an email goes instead if it failed.
  const sendSms = async (contactId, message) => { const r = await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId, message }) }, '2021-04-15'); return (r && (r.messageId || r.id)) || null; };
  // GoHighLevel's daily SMS limit: "...You can start sending message after 2026-11-09 16:41 Australia/Sydney."
  const limitUntil = err => { const t = String(err || ''); if (!/sms sending limit|reached its/i.test(t)) return null; const x = t.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/); return new Date(x ? sydMs(x[1], x[2]) + 60e3 : Date.now() + 24 * 3600e3).toISOString(); };
  const smsBlocked = st => !!(st && st.sms_blocked_until && Date.parse(st.sms_blocked_until) > Date.now());
  const goodEmail = m => [m && m.guardian_email, m && m.email].find(v => v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || null;
  // The email backup for a text that can't go (or failed): the same words, as an AMA email with the links as buttons
  const emailBackup = async ({ m, entry_id, subject, text, why }) => {
    const email = goodEmail(m);
    if (!email) return { ok: false, why: 'No email address for the backup' };
    const log = (status, extra = {}) => db.from('cb_messages').insert({ entry_id: entry_id || null, member_key: m.member_key, kind: 'sms_backup', email, body: subject + '\n\n' + text, status, sent_by: 'automatic: email backup (' + why + ')', ...extra });
    try {
      const cid = await contactFor({ ...m, email }, phoneE164(m.phone || m.guardian_phone));
      if (!cid) throw new Error('Could not find or add the contact');
      await sendEmailTo(cid, buildSeqEmail(subject, text)); await log('sent'); return { ok: true };
    } catch (er) { const w = String(er.message || er).slice(0, 500); await log('failed', { error: w }); return { ok: false, why: w }; }
  };
  // Check texts sent in the last 6 hours: mark the ones GoHighLevel failed, stop texting until a daily limit resets, and email instead
  const verifySms = async (st, budgetMs = 40e3) => {
    const t0 = Date.now(), res = { checked: 0, failed: 0, backups: 0 };
    const { data: rows } = await db.from('cb_messages').select('message_id, entry_id, member_key, body, sent_by, ghl_id, sent_at').eq('status', 'sent').not('ghl_id', 'is', null).is('verified_at', null)
      .gte('sent_at', new Date(Date.now() - 6 * 3600e3).toISOString()).lte('sent_at', new Date(Date.now() - 60e3).toISOString()).order('sent_at').limit(60);
    for (const r of rows || []) {
      if (Date.now() - t0 > budgetMs) break;
      let msg; try { msg = await ghl('/conversations/messages/' + encodeURIComponent(r.ghl_id), { method: 'GET' }, '2021-04-15'); } catch (_) { continue; }
      const mm = (msg && (msg.message || msg)) || {}, status = String(mm.status || '');
      res.checked++;
      if (!status || status === 'pending' || status === 'scheduled') continue;
      if (status !== 'failed' && status !== 'undelivered') { await db.from('cb_messages').update({ verified_at: new Date().toISOString() }).eq('message_id', r.message_id); continue; }
      const err = String((mm.meta && mm.meta.error) || mm.error || (mm.meta && JSON.stringify(mm.meta)) || 'Failed in GoHighLevel').slice(0, 500);
      await db.from('cb_messages').update({ status: 'failed', error: err, verified_at: new Date().toISOString() }).eq('message_id', r.message_id);
      res.failed++;
      const until = limitUntil(err);
      if (until && !smsBlocked(st)) { st.sms_blocked_until = until; await db.from('cb_settings').update({ sms_blocked_until: until }).eq('id', 1); }
      // An invitation text that failed is sent again once texting works (its invitation email has already gone); anything else is emailed now
      if (r.entry_id && r.sent_by === 'automatic: invite_sms') {
        await db.from('cb_seq_log').delete().eq('entry_id', r.entry_id).eq('step_code', 'invite_sms');
        await db.from('cb_entries').update({ invited_at: null }).eq('entry_id', r.entry_id);
        continue;
      }
      const { data: m } = await db.from('efc_members').select('member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email').eq('member_key', r.member_key).maybeSingle();
      if (m) { const b = await emailBackup({ m, entry_id: r.entry_id, subject: `${firstWord(m.full_name)}'s grading at AMA`, text: r.body, why: 'text failed' }); if (b.ok) res.backups++; }
    }
    return res;
  };
  // The grading fee: for a black belt (Dan) session it comes from the prep grading rates by the rank they're grading to; otherwise from cb_belts by the belt they're on.
  const feeFor = async (e, d) => {
    if (d && d.bb) { const { data: r } = await db.from('prep_grading_fee_rates').select('fee').eq('target_rank', e.belt_to).maybeSingle(); return r && r.fee != null ? Number(r.fee) : null; }
    const { data: belt } = await db.from('cb_belts').select('fee').eq('programme', (d && d.programme) || 'Taekwondo').eq('belt', e.belt_from).maybeSingle();
    return belt && belt.fee != null ? Number(belt.fee) : null;
  };
  // A staff-set discount on this entry, resolved to dollars off, never more than the fee. 0 when there's none.
  // discount_kind 'percent' means `discount` is a percentage (0-100); otherwise it's a dollar amount.
  const discountOn = (e, fee) => {
    const n = Number(e && e.discount);
    if (!(Number.isFinite(n) && n > 0 && fee != null)) return 0;
    if (e && e.discount_kind === 'percent') return Math.min(fee, Math.round(fee * Math.min(n, 100)) / 100);
    return Math.min(n, fee);
  };
  // Make a one-off Stripe coupon (amount_off or percent_off), so the hosted checkout page shows a "Discount" line.
  // The coupon name is the discount line's label; we show the staff's wording verbatim (e.g. "Staff Gift - 30% off").
  const discountCoupon = async (e, fee) => {
    const name = String(e.discount_reason || '').trim() ? String(e.discount_reason).trim().slice(0, 60) : 'Discount';
    const body = e.discount_kind === 'percent'
      ? { percent_off: Math.min(100, Number(e.discount) || 0), duration: 'once', name }
      : { amount_off: Math.round(Math.min(Number(e.discount) || 0, fee) * 100), currency: 'aud', duration: 'once', name };
    const c = await stripe('/coupons', { method: 'POST', body: form(body) });
    return c.id;
  };
  // All of a student's gradings still to come (this one plus any second grading in the same cycle), oldest first,
  // so a confirmation can list both. Each: belt, date, time, school, status, and a book-and-pay link if not done yet.
  const upcomingFor = async member_key => {
    try {
      const sydToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
      const { data: mine } = await db.from('cb_entries').select('day_id, belt_to, paid, booked_at, token, result').eq('member_key', member_key).is('result', null);
      const dayIds = [...new Set((mine || []).map(x => x.day_id))];
      const { data: dys } = dayIds.length ? await db.from('cb_days').select('day_id, grading_date, start_time, belt_times, location, bb, closed').in('day_id', dayIds) : { data: [] };
      const dmap = {}; (dys || []).forEach(x => { dmap[x.day_id] = x; });
      return (mine || []).map(x => ({ x, dd: dmap[x.day_id] })).filter(o => o.dd && !o.dd.closed && String(o.dd.grading_date) >= sydToday)
        .sort((a, b) => String(a.dd.grading_date).localeCompare(String(b.dd.grading_date)))
        .map(({ x, dd }) => { const tt = entryTime(dd, x); return { belt: x.belt_to, when: longDay(dd.grading_date), time: tt ? clock(tt) : '', where: whereOf(x, dd),
          status: x.paid ? 'Paid' : x.booked_at ? 'Booked' : 'Not booked yet', link: (!x.paid && !x.booked_at && x.token) ? SITE + 'b#' + x.token : '' }; });
    } catch (er) { console.error('upcoming', er); return []; }
  };
  // Automatic confirmation text (once each): 'sms_booked' or 'sms_paid'. Mirrors the email; lists both for a double grading. Never stops a booking/payment if it fails.
  const confirmSms = async (e, d, kind, extra = {}) => {
    try {
      if (!(env.GHL_TOKEN && env.GHL_LOCATION_ID)) return;
      const { data: sent } = await db.from('cb_messages').select('status').eq('entry_id', e.entry_id).eq('kind', kind).eq('status', 'sent').maybeSingle();
      if (sent) return;
      const { data: m } = await db.from('efc_members').select('member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email').eq('member_key', e.member_key).maybeSingle();
      const phone = phoneE164((m && m.phone) || (m && m.guardian_phone));
      if (!phone) return;
      const sbelt = x => String(x || '').replace(/ Belt$/, '');
      const self = selfOf(m), who = self ? 'your' : (first(e.full_name) + "'s");
      const paid = kind === 'sms_paid';
      const et = entryTime(d, e), when = longDay(d.grading_date) + (et ? ' at ' + clock(et) : '');
      const lead = paid ? `Thanks! Payment received for ${who} ${sbelt(e.belt_from)} to ${sbelt(e.belt_to)} grading on ${when}, AMA ${whereOf(e, d)}.`
        : `${self ? "You're" : first(e.full_name) + ' is'} booked in to grade ${sbelt(e.belt_from)} to ${sbelt(e.belt_to)} on ${when}, AMA ${whereOf(e, d)}.`;
      const up = await upcomingFor(e.member_key);
      const extra2 = up.length > 1
        ? ' ' + (self ? 'Your' : 'Their') + ' gradings: ' + up.map(u => `${sbelt(u.belt)} ${u.when}${u.time ? ' ' + u.time : ''} (${u.status === 'Not booked yet' && u.link ? 'book & pay: ' + u.link : u.status})`).join('; ') + '.'
        : '';
      const body = (lead + extra2 + ' See you there - AMA').replace(/ {2,}/g, ' ').trim();
      const log = (status, more = {}) => db.from('cb_messages').insert({ entry_id: e.entry_id, member_key: e.member_key, kind, body, status, sent_by: 'automatic', ...more });
      try {
        const cid = await contactFor({ ...m }, phone);
        if (!cid) throw new Error('Could not find or add the contact');
        await sendSms(cid, body);
        await log('sent');
      } catch (er) { await log('failed', { error: String(er.message || er).slice(0, 500) }); }
    } catch (er) { console.error('confirmSms', er); }
  };
  // Automatic confirmation emails (once each): 'email_booked' or 'email_paid'. Never stops a booking or payment if it fails.
  const confirmEmail = async (e, d, kind, extra = {}) => {
    try {
      if (!(env.GHL_TOKEN && env.GHL_LOCATION_ID)) return;
      const { data: sent } = await db.from('cb_messages').select('status').eq('entry_id', e.entry_id).eq('kind', kind).eq('status', 'sent').maybeSingle();
      if (sent) return;
      const { data: m } = await db.from('efc_members').select('member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email').eq('member_key', e.member_key).maybeSingle();
      const email = m && [m.email, m.guardian_email].find(v => v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));
      if (!email) return;
      const { data: cs } = await db.from('cb_settings').select('contact_phone, email_bring').eq('id', 1).maybeSingle();
      const when = new Date(d.grading_date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const et = entryTime(d, e); const t = et ? String(et).slice(0, 5).split(':').map(Number) : null;
      const HOW = { card: 'card', cash: 'cash', eftpos: 'EFTPOS', transfer: 'bank transfer', other: '' };
      const upcoming = await upcomingFor(e.member_key);   // this one plus any second grading, so the email can list both
      const { subject, html, text } = buildEmail(kind, { parent: first(m.guardian_name) || 'there', kid: first(e.full_name), student: e.full_name, belt: e.belt_to, school: whereOf(e, d),
        when, time: t ? `${((t[0] + 11) % 12) + 1}:${String(t[1]).padStart(2, '0')}${t[0] < 12 ? 'am' : 'pm'}` : '', amount: extra.amount, how: HOW[e.paid_how] || '',
        receipt: extra.receipt || null, phone: (cs && cs.contact_phone) || '(02) 9569 1943', bring: cs && cs.email_bring, upcoming });
      const log = (status, more = {}) => db.from('cb_messages').insert({ entry_id: e.entry_id, member_key: e.member_key, kind, email, body: subject + '\n\n' + text, status, sent_by: 'automatic', ...more });
      try {
        const cid = await contactFor({ ...m, email }, phoneE164(m.phone || m.guardian_phone));
        if (!cid) throw new Error('Could not find or add the contact');
        await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'Email', contactId: cid, subject, html, message: text }) }, '2021-04-15');
        await log('sent');
      } catch (er) { await log('failed', { error: String(er.message || er).slice(0, 500) }); }
    } catch (er) { console.error(er); }
  };
  // Send the booking to the booking sheet (or a Zapier hook); a Zap then books the EFC session
  const bookEntry = async (e, d) => {
    // Books the student directly into their EFC grading session via the EFC Aquila integration API
    // (replaces the old Zapier / Google-Sheet booking webhook). Each school's key is a Supabase secret
    // named EFC_API_KEY_<SCHOOL>, read into env; the member's own school decides the session and location.
    const EFC_BASE = 'https://api.efcaquila.net/version/1';
    const { data: m } = await db.from('efc_members').select('efc_reference, location').eq('member_key', e.member_key).maybeSingle();
    // The student's own school decides the session: the entry's school (coloured-belts-25.sql), then EFC's, then their EFC reference.
    // A black belt student is never sent to the day's school just because EFC has no school for them (booked by hand instead);
    // a coloured belt student with no school at all is at the day's school, the day they were put on.
    const own = e.school || (m && m.location) || refSchool(m && m.efc_reference) || null;
    const mloc = d.bb ? own : (own || d.location);
    const schoolMap = (d.efc_sessions && typeof d.efc_sessions === 'object') ? d.efc_sessions : {};
    const beltMap = (d.efc_belt_sessions && typeof d.efc_belt_sessions === 'object') ? d.efc_belt_sessions : {};
    const sbMap = (d.efc_school_belt_sessions && typeof d.efc_school_belt_sessions === 'object') ? d.efc_school_belt_sessions : {};
    const locId = EFC_LOCATIONS[mloc] || null;
    // Which EFC session this member books into. EFC splits a grading by belt and by venue, so the session depends
    // on both the member's school and their belt/rank. efc_school_belt_sessions maps school -> { belt -> session };
    // for a black belt day the inner key is the rank they grade to (belt_to), otherwise the belt they are on now
    // (belt_from). A student at the day's own school books the day's per-belt session (efc_belt_sessions); a student
    // from another school - and everyone on a black belt day, which runs at several venues - books their own
    // school's per-belt session. Falls back to the single per-school efc_sessions, then the day's single
    // efc_session_id (own school only), else flagged to book by hand.
    const beltKey = d.bb ? e.belt_to : e.belt_from;
    const schoolBelt = (sbMap[mloc] && typeof sbMap[mloc] === 'object') ? (sbMap[mloc][beltKey] || null) : null;
    let sid;
    if (d.bb) sid = schoolBelt || schoolMap[mloc] || null;
    else if (mloc === d.location) sid = beltMap[e.belt_from] || d.efc_session_id || null;
    else sid = schoolBelt || schoolMap[mloc] || null;
    const memberId = e.member_key && e.member_key.startsWith('efc:') ? e.member_key.slice(4) : null;
    const efcKey = env['EFC_API_KEY_' + String(mloc || '').toUpperCase()] || null;
    // Need a session, a location, the member's EFC id and that school's key; otherwise flag to book by hand
    // (e.g. a student with no EFC id, or a school whose key isn't set up yet).
    if (!sid || !locId || !memberId || !efcKey) {
      e.booked_at = new Date().toISOString();
      await db.from('cb_entries').update({ booked_at: e.booked_at, booking_error: null, efc_by_hand: true }).eq('entry_id', e.entry_id);
      return { ok: true, byHand: true };
    }
    const regUrl = `${EFC_BASE}/locations/${locId}/calendar/sessions/${sid}/${d.grading_date}/bookings`;
    // True when the member is already on this session's register (so a conflict/duplicate counts as booked).
    const already = async () => { try { const r = await http(regUrl, { headers: { 'X-API-KEY': efcKey, 'Accept': 'application/json' } }); if (!r.ok) return false; const j = await r.json().catch(() => []); const arr = Array.isArray(j) ? j : (j.records || []); return arr.some(b => b && b.member && b.member.id === memberId); } catch { return false; } };
    let okBook = false, why = '';
    try {
      const r = await http(regUrl, { method: 'POST', headers: { 'X-API-KEY': efcKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId }) });
      if (r.ok) okBook = true;
      else {
        let eb = null; try { eb = await r.json(); } catch {}
        okBook = await already();   // already booked in EFC is still a success
        if (!okBook) why = 'EFC said ' + r.status + (eb && (eb.code || eb.message) ? ' (' + (eb.code || eb.message) + ')' : '');
      }
    }
    catch (err) { why = String(err && err.message || err); }
    if (!okBook) { await db.from('cb_entries').update({ booking_error: why.slice(0, 300) }).eq('entry_id', e.entry_id); return { ok: false, why }; }
    e.booked_at = new Date().toISOString();
    await db.from('cb_entries').update({ booked_at: e.booked_at, booking_error: null, efc_by_hand: false }).eq('entry_id', e.entry_id);
    return { ok: true };
  };
  // A paid Stripe Checkout session for a grading: mark the student paid (once), then book them if they aren't yet
  const markPaid = async s => {
    if (!s || s.payment_status !== 'paid' || !s.metadata || s.metadata.kind !== 'grading') return false;
    const { data: pay } = await db.from('cb_payments').select('payment_id, entry_id, status').eq('stripe_session', s.id).maybeSingle();
    const entryId = (pay && pay.entry_id) || s.metadata.entry_id || s.client_reference_id;
    if (pay && pay.status === 'paid') return true;   // already done
    const now = new Date().toISOString(), payment = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || s.id;
    // Stripe's receipt (from the payment's charge)
    let receipt = null;
    if (payment && String(payment).startsWith('pi_')) { try { const pi = await stripe('/payment_intents/' + encodeURIComponent(payment) + '?expand[]=latest_charge', { method: 'GET' }); receipt = (pi.latest_charge && pi.latest_charge.receipt_url) || null; } catch (er) { console.error(er); } }
    // Stripe's webhook and the family's return page can both arrive at once: only the one that actually flips it to paid
    // carries on (books, emails, alerts), so nobody gets the paid email or the staff alert twice
    if (pay) {
      const { data: won } = await db.from('cb_payments').update({ status: 'paid', paid_at: now, amount: (s.amount_total || 0) / 100, stripe_payment: payment, receipt_url: receipt }).eq('payment_id', pay.payment_id).neq('status', 'paid').select('payment_id');
      if (!(won || []).length) return true;
    } else {
      const { error: insErr } = await db.from('cb_payments').insert({ entry_id: entryId, stripe_session: s.id, status: 'paid', paid_at: now, amount: (s.amount_total || 0) / 100, stripe_payment: payment, receipt_url: receipt });
      if (insErr && (insErr.code === '23505' || /duplicate/i.test(insErr.message || ''))) return true;
    }
    if (!entryId) return true;
    await db.from('cb_entries').update({ paid: true, paid_at: now, paid_how: 'card' }).eq('entry_id', entryId);
    const { data: e } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, booked_at, booking_error, result, paid, paid_how, late_ok_until, school, notify_paid_to, notify_paid_sent_at').eq('entry_id', entryId).maybeSingle();
    if (e) {
      const { data: d } = await db.from('cb_days').select('day_id, location, grading_date, start_time, efc_session_id, efc_sessions, efc_belt_sessions, efc_school_belt_sessions, belt_times, closed, programme, book_by, bb').eq('day_id', e.day_id).maybeSingle();
      if (d && !e.booked_at) await bookEntry(e, d);
      if (d) await confirmEmail(e, d, 'email_paid', { amount: (s.amount_total || 0) / 100, receipt });
      if (d) await confirmSms(e, d, 'sms_paid');
      // Staff alert: text a set number once this entry's fee is paid (one-off payment links), sent only once
      if (e.notify_paid_to && !e.notify_paid_sent_at) {
        try {
          const cid = await contactFor({ guardian_name: 'AMA grading', full_name: 'AMA grading' }, phoneE164(e.notify_paid_to));
          if (cid) { await sendSms(cid, `${e.full_name} has paid the $${((s.amount_total || 0) / 100).toFixed(2)} grading fee (${e.belt_from} to ${e.belt_to}).`); await db.from('cb_entries').update({ notify_paid_sent_at: now }).eq('entry_id', e.entry_id); }
        } catch (er) { console.error('notify_paid', er); }
      }
    }
    return true;
  };

  // ---------- The booking sequence: sending ----------
  const seqTemplate = (step, st) => String(step.template || '').startsWith('settings:') ? (st[String(step.template).slice(9)] || '') : (step.template || '');
  const emailOf = m => [m && m.guardian_email, m && m.email].find(v => v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || null;
  // One message to one family (or a test to a staff member). Returns { status: sent|test|failed|skipped, why }
  const seqSend = async ({ step, e, d, m, st, fee = null, prepTime = null, to = null }) => {
    const ready = !!(env.GHL_TOKEN && env.GHL_LOCATION_ID), testing = env.GHL_TEST === '1';
    const v = seqVars(e, d, m, { channel: step.channel, fee, prepTime, phone: st.contact_phone, deadlineDays: st.deadline_days ?? 7, prepUrl: st.prep_url, prepCloses: st.prep_closes,
      bring: String(st.email_bring || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean) });
    const text = famFill(seqTemplate(step, st), m, v), subject = fillText(step.subject || '', v);
    const phone = to ? phoneE164(to.phone) : phoneE164(m.phone || m.guardian_phone);
    const email = to ? (to.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.email) ? to.email : null) : emailOf(m);
    const log = (status, extra = {}) => db.from('cb_messages').insert({ entry_id: to ? null : e.entry_id, member_key: e.member_key, kind: to ? 'seq_test' : 'seq',
      phone: step.channel === 'sms' ? phone : null, email: step.channel === 'email' ? email : null, body: (subject ? subject + '\n\n' : '') + text,
      status, sent_by: to ? 'test to ' + to.by : 'automatic: ' + step.code, ...extra });
    if (!text) return { status: 'skipped', why: 'No wording for this step' };
    if (step.channel === 'sms' && !phone) { await log('failed', { error: 'No mobile number' }); return { status: 'failed', why: 'No mobile number' }; }
    if (step.channel === 'email' && !email) return { status: 'skipped', why: 'No email address' };
    if (testing && !ready) { await log('test'); return { status: 'test' }; }
    if (!ready) return { status: 'failed', why: 'Texting is not set up (GHL_TOKEN, GHL_LOCATION_ID)' };
    // Texting is stopped (GoHighLevel's daily limit): email the same message instead, or hold it until texting works again
    if (step.channel === 'sms' && !to && smsBlocked(st)) {
      // The booking-link text waits for texting to work again so the family still gets the SMS (the email backup already went when they replied); other steps email instead.
      if (step.code === 'out_send_link') return { status: 'held', why: 'Texting paused until ' + st.sms_blocked_until + ' — will send the SMS when texting works again' };
      const b = await emailBackup({ m, entry_id: e.entry_id, subject: `${v.first}'s grading at AMA`, text, why: 'texting paused' });
      return b.ok ? { status: 'sent', why: 'Emailed instead (texting paused until ' + st.sms_blocked_until + ')' } : { status: 'held', why: b.why };
    }
    try {
      const cid = to ? await contactFor({ guardian_name: to.name || to.by, email }, phone) : await contactFor({ ...m, email }, phone);
      if (!cid) throw new Error('Could not find or add the contact');
      if (!to) {
        // Opted out in GoHighLevel (STOP, or DND set on the contact): never send
        const c = await ghl('/contacts/' + cid, { method: 'GET' }); const ct = (c && c.contact) || {}, k = step.channel === 'sms' ? 'SMS' : 'Email';
        if (ct.dnd === true || (ct.dndSettings && ct.dndSettings[k] && ct.dndSettings[k].status === 'active')) { await log('failed', { error: 'DND in GoHighLevel' }); return { status: 'skipped', why: 'DND in GoHighLevel' }; }
      }
      let gid = null;
      if (step.channel === 'sms') gid = await sendSms(cid, text);
      else { const mail = buildSeqEmail(subject, text); await sendEmailTo(cid, mail); }
      await log('sent', gid ? { ghl_id: gid } : {}); return { status: 'sent' };
    } catch (er) { const why = String(er.message || er).slice(0, 500); await log('failed', { error: why }); return { status: 'failed', why }; }
  };
  // Supabase returns at most 1,000 rows per request: anything that can be longer is read in pages, or rows past 1,000
  // would be silently missing (students not planned, replies not matched, sent messages looking unsent).
  const allRows = async (build, size = 1000) => {
    const out = [];
    for (let from = 0; ; from += size) {
      const { data, error } = await build().range(from, from + size - 1);
      if (error) throw new Error(error.message || String(error));
      out.push(...(data || []));
      if (!data || data.length < size) return out;
    }
  };
  // Long "in (...)" lists go in batches: hundreds of ids in one request is too long an address and the lookup fails.
  // Each batch is itself read in pages (100 students can have well over 1,000 log rows).
  const selectIn = async (table, cols, col, values, size = 100) => {
    const vals = [...new Set(values)], rows = [];
    for (let i = 0; i < vals.length; i += size) {
      try { rows.push(...await allRows(() => db.from(table).select(cols).in(col, vals.slice(i, i + size)))); }
      catch (er) { throw new Error(`${table}: ${er.message || er}`); }
    }
    return rows;
  };
  const membersFor = async keys => {
    if (!keys.length) return {};
    const data = await selectIn('efc_members', 'member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email, date_of_birth', 'member_key', keys);
    return Object.fromEntries(data.map(m => [m.member_key, m]));
  };
  const DAY_COLS = 'day_id, location, grading_date, start_time, belt_times, closed, programme, bb, book_by, private';
  const ENT_COLS = 'entry_id, day_id, member_key, full_name, belt_from, belt_to, token, invited_at, booked_at, paid, paid_at, result, seq_paused_until, seq_stopped_at';
  // Texts a staff call outcome asked for ("Send link", "No answer"): sent on the next run, whether or not the sequence is on
  const runOutbox = async (st, steps, res) => {
    const rows = await allRows(() => db.from('cb_outbox').select('out_id, entry_id, kind, sent_at').is('sent_at', null).order('out_id'));
    for (const o of rows || []) {
      // Claim it first, so two overlapping runs never both send it (a claim older than 10 minutes is a run that died: retried)
      const { data: got } = await db.from('cb_outbox').update({ status: 'sending', error: null, claimed_at: new Date().toISOString() }).eq('out_id', o.out_id).is('sent_at', null)
        .or('status.is.null,status.neq.sending,claimed_at.is.null,claimed_at.lt.' + new Date(Date.now() - 10 * 60e3).toISOString()).select('out_id');
      if (!(got || []).length) continue;
      const step = steps.find(s => s.code === (o.kind === 'send_link' ? 'out_send_link' : 'out_no_answer'));
      const { data: e } = await db.from('cb_entries').select(ENT_COLS).eq('entry_id', o.entry_id).maybeSingle();
      const { data: d } = e ? await db.from('cb_days').select(DAY_COLS).eq('day_id', e.day_id).maybeSingle() : { data: null };
      const m = e ? (await membersFor([e.member_key]))[e.member_key] : null;
      let r = { status: 'skipped', why: 'Student or day not found' };
      if (step && e && d && m && !e.paid) r = await seqSend({ step, e, d, m, st });
      else if (e && e.paid) r = { status: 'skipped', why: 'Booked and paid' };
      if (r.status === 'held') { await db.from('cb_outbox').update({ status: 'held', error: r.why || null }).eq('out_id', o.out_id); continue; }   // tried again on the next run
      await db.from('cb_outbox').update({ sent_at: new Date().toISOString(), status: r.status, error: r.why || null }).eq('out_id', o.out_id);
      res.outbox++;
    }
  };
  const runSequence = async (nowMs = Date.now()) => {
    const { data: st0 } = await db.from('cb_settings').select('*').eq('id', 1).maybeSingle();
    const st = st0 || {};
    const { data: steps0 } = await db.from('cb_seq_steps').select('*');
    const steps = steps0 || [];
    const res = { ok: true, on: !!st.seq_on, sent: 0, test: 0, calls: 0, skipped: 0, missed: 0, failed: 0, outbox: 0 };
    if (env.GHL_TOKEN && env.GHL_LOCATION_ID) { try { res.verify = await verifySms(st); } catch (er) { console.error('verify', er); } }
    await runOutbox(st, steps, res);
    if (!st.seq_on) return res;
    const today = sydParts(nowMs).ymd;
    const { data: days } = await db.from('cb_days').select(DAY_COLS).gte('grading_date', today);
    const coloured = (days || []).filter(d => !d.bb && !d.closed && !d.private);   // private gradings (cb_days.private): no automatic invites or texts
    if (!coloured.length) return res;
    const ents = await allRows(() => db.from('cb_entries').select(ENT_COLS).in('day_id', coloured.map(d => d.day_id)).order('entry_id'));
    const ids = (ents || []).map(e => e.entry_id);
    if (!ids.length) return res;
    // A run that was cut off mid-send leaves its claim 'sending'. After 15 minutes: if the message was logged as sent it was, otherwise let it go again.
    const staleAt = new Date(nowMs - 15 * 60e3).toISOString();
    const stale = await allRows(() => db.from('cb_seq_log').select('entry_id, step_code').eq('status', 'sending').lt('at', staleAt).order('entry_id'));
    for (const l of stale || []) {
      const { data: msg } = await db.from('cb_messages').select('status').eq('entry_id', l.entry_id).eq('sent_by', 'automatic: ' + l.step_code).eq('status', 'sent').limit(1);
      if ((msg || []).length) await db.from('cb_seq_log').update({ status: 'sent', why: 'Recovered after a cut-off run' }).eq('entry_id', l.entry_id).eq('step_code', l.step_code);
      else await db.from('cb_seq_log').delete().eq('entry_id', l.entry_id).eq('step_code', l.step_code).eq('status', 'sending');
    }
    const logs = await selectIn('cb_seq_log', 'entry_id, step_code', 'entry_id', ids);
    let skips = []; try { skips = await allRows(() => db.from('cb_skip').select('member_key, until').order('member_key')); } catch (_) { /* no skip list */ }
    const prep = await allRows(() => db.from('cb_prep_bookings').select('member_key, session_time').order('member_key')).catch(() => []);
    const prepBy = Object.fromEntries((prep || []).map(p => [p.member_key, p.session_time]));
    const plan = planSequence({ now: nowMs, steps, days: coloured, entries: ents || [], logs: new Set((logs || []).map(l => l.entry_id + '|' + l.step_code)),
      skipped: new Set((skips || []).filter(s => !s.until || String(s.until) >= today).map(s => s.member_key)), prepBooked: new Set(Object.keys(prepBy)) });
    const entBy = Object.fromEntries((ents || []).map(e => [e.entry_id, e])), dayBy = Object.fromEntries(coloured.map(d => [d.day_id, d]));
    const memBy = await membersFor(plan.map(p => entBy[p.entry_id].member_key));
    const fees = {};
    // Invitation texts go in smaller lots: at most sms_daily_cap texts a day from here (GoHighLevel stops all of AMA's texts at 750,
    // which the hub needs too), and none while texting is stopped. The rest wait for the next runs.
    const { count: sms24 } = await db.from('cb_messages').select('message_id', { count: 'exact', head: true }).not('phone', 'is', null).eq('status', 'sent').gte('sent_at', new Date(nowMs - 864e5).toISOString());
    // The black belt sequence (nurture) texts through the same GoHighLevel number, so its texts count towards the same daily limit
    let bb24 = 0;
    try { const { count } = await db.from('prep_nurture_log').select('log_id', { count: 'exact', head: true }).eq('channel', 'sms').eq('status', 'sent').gte('sent_at', new Date(nowMs - 864e5).toISOString()); bb24 = count || 0; } catch (_) { /* no black belt tables */ }
    let smsLeft = Math.max(0, (st.sms_daily_cap ?? 450) - (sms24 || 0) - bb24);
    // A run has limited time and memory: send at most SEQ_MAX_SENDS messages, and leave the rest for the next run (every few minutes)
    let sends = 0;
    for (const p of plan) {
      if ((p.act === 'send') && sends >= SEQ_MAX_SENDS) { res.more = true; continue; }
      const e = entBy[p.entry_id], d = dayBy[e.day_id], step = steps.find(s => s.code === p.code);
      if (p.act === 'send' && p.code === 'invite_sms') { if (smsBlocked(st) || smsLeft <= 0) { res.waiting = (res.waiting || 0) + 1; continue; } smsLeft--; }
      // Claim the step first (one row per student per step), so two runs at once never send it twice
      const { error: claimErr } = await db.from('cb_seq_log').insert({ entry_id: e.entry_id, step_code: p.code, status: 'sending' });
      if (claimErr) continue;
      const fin = (status, why) => db.from('cb_seq_log').update({ status, why: why || null, at: new Date().toISOString() }).eq('entry_id', e.entry_id).eq('step_code', p.code);
      if (p.act === 'missed') { await fin('missed', p.why); res.missed++; continue; }
      if (p.act === 'skip') { await fin('skipped', p.why); res.skipped++; continue; }
      if (p.act === 'invite_by_hand') { await fin('skipped', 'Invited by hand before the sequence'); res.skipped++; continue; }
      if (p.act === 'call') {
        const { data: open } = await db.from('cb_calls').select('call_id').eq('entry_id', e.entry_id).eq('done', false);
        if (!(open || []).length) await db.from('cb_calls').insert({ entry_id: e.entry_id, reason: 'not_booked', callback_on: today });
        await fin('sent', 'On My Day'); res.calls++; continue;
      }
      const m = memBy[e.member_key];
      if (!m) { await fin('failed', 'Student not found in EFC'); res.failed++; continue; }
      const fk = d.programme + '|' + e.belt_from;
      if (!(fk in fees)) fees[fk] = await feeFor(e, d);
      sends++;
      const r = await seqSend({ step, e, d, m, st, fee: fees[fk], prepTime: prepBy[e.member_key] || null });
      if (r.status === 'held') { await db.from('cb_seq_log').delete().eq('entry_id', e.entry_id).eq('step_code', p.code); res.held = (res.held || 0) + 1; continue; }   // tried again on a later run
      await fin(r.status, r.why);
      res[r.status] = (res[r.status] || 0) + 1;
      // The invitation starts the clock for everything after it
      if (p.code === 'invite_sms') { const at = new Date(nowMs).toISOString(); await db.from('cb_entries').update({ invited_at: at }).eq('entry_id', e.entry_id); e.invited_at = at; }
    }
    return res;
  };

  // ===================== 4th Dan+ celebration dinner invite (dinner-rsvp-1/2) =====================
  // SMS (GoHighLevel) + email. One SMS per distinct number (shared numbers greet all names on it), one email per
  // address. A test goes to the configured number/email first; the full send fires once dinner_config.send_at is set
  // and reached. Replies are caught by the dinner block at the top of the `reply` action.
  const dinnerGreet = names => names.length <= 1 ? (names[0] || 'there') : names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
  const dinnerSms = g => `Hi ${g}, Grand Master Ridvan would like to personally invite you to a celebration dinner for our 4th Dan and above students, Sat 28th Nov, 6pm at Taste of Turkey. This invitation is for you personally, and dinner is on Grand Master Ridvan. Please reply YES by Mon 23rd Nov to confirm you're coming. – AMA`;
  const dinnerEmailSubject = 'An Invitation from Grand Master Ridvan – 4th Dan & Above Celebration Dinner';
  const dinnerEmail = g => `Dear ${g},\n\nGrand Master Ridvan would like to personally invite you to a celebration dinner in honour of our students who hold, or are grading for, 4th Dan and above.\n\nReaching this level takes years of dedication, discipline and commitment, and Grand Master Ridvan wants to recognise each of you for what you have achieved.\n\nDate: Saturday 28th November\nTime: 6:00pm\nVenue: Taste of Turkey\n\nThis dinner is reserved for our 4th Dan and above students, and your invitation is for you personally. Dinner is Grand Master Ridvan's gift to you, so there is nothing to pay.\n\nPlease RSVP by Monday 23rd November by replying YES to the text message you've also received, to confirm you'll be attending.\n\nWe look forward to celebrating with you.\n\nKind regards,\nMark\nAustralian Martial Arts`;
  const dinnerSendSms = async (phone, greet) => { const p = phoneE164(phone); if (!p) return false; try { const cid = await contactFor({ full_name: greet }, p); if (!cid) return false; await sendSms(cid, dinnerSms(greet)); return true; } catch (_) { return false; } };
  const dinnerSendEmail = async (email, greet) => { if (!(email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) return false; try { const cid = await contactFor({ full_name: greet, email }, null); if (!cid) return false; await sendEmailTo(cid, buildSeqEmail(dinnerEmailSubject, dinnerEmail(greet))); return true; } catch (_) { return false; } };
  const runDinnerSend = async (nowMs = Date.now()) => {
    const { data: cfg } = await db.from('dinner_config').select('*').eq('id', 1).maybeSingle();
    if (!cfg) return { dinner: 'off' };
    if (!(env.GHL_TOKEN && env.GHL_LOCATION_ID)) return { dinner: 'no texting' };
    const nowIso = new Date(nowMs).toISOString(), fw = n => String(n || '').trim().split(/\s+/)[0] || 'there';
    if (!cfg.test_sent_at) {   // test to the configured recipient (Tate) first
      if (cfg.test_phone9) await dinnerSendSms('+61' + cfg.test_phone9, 'Tate');
      if (cfg.test_email) await dinnerSendEmail(cfg.test_email, 'Tate');
      await db.from('dinner_config').update({ test_sent_at: nowIso }).eq('id', 1);
      return { dinner: 'test sent' };
    }
    if (cfg.send_at && Date.parse(cfg.send_at) <= nowMs && !cfg.sent_all_at) {   // full send once armed and reached
      const { data: gs } = await db.from('dinner_rsvp').select('id, name, phone9, email').eq('status', 'invited').is('sent_at', null);
      const guests = gs || [], byPhone = {}, byEmail = {};
      for (const g of guests) { if (g.phone9) (byPhone[g.phone9] = byPhone[g.phone9] || []).push(fw(g.name)); const e = (g.email || '').toLowerCase(); if (e) (byEmail[e] = byEmail[e] || []).push(fw(g.name)); }
      for (const ph of Object.keys(byPhone)) await dinnerSendSms('+61' + ph, dinnerGreet([...new Set(byPhone[ph])]));
      for (const em of Object.keys(byEmail)) await dinnerSendEmail(em, dinnerGreet([...new Set(byEmail[em])]));
      await db.from('dinner_rsvp').update({ sent_at: nowIso }).eq('status', 'invited').is('sent_at', null);
      await db.from('dinner_config').update({ sent_all_at: nowIso }).eq('id', 1);
      return { dinner: 'sent all', numbers: Object.keys(byPhone).length, emails: Object.keys(byEmail).length };
    }
    return { dinner: 'idle' };
  };

  // ===================== Black Belt Club welcome flow (coloured-belts-40) =====================
  // Invited students (efc_members.bbc_invited_at) get a welcome + touch points once their grading closes,
  // and stop the moment they join: by signing up on the landing page, or by showing up in the Black Belt Club
  // programme in EFC (bbc_seen_at within 3 days, the same signal cb_students.black_belt_club uses).
  const BBC_SEEN_MS = 3 * 24 * 60 * 60e3;
  const bbcLink = token => SITE + 'black-belt-club/#t=' + token;
  const bbcFill = (t, name, link) => String(t || '').replace(/\{\{\s*name\s*\}\}/g, name || 'there').replace(/\{\{\s*link\s*\}\}/g, link);
  const bbcInBbc = m => !!(m && m.bbc_seen_at && Date.now() - new Date(m.bbc_seen_at).getTime() < BBC_SEEN_MS);
  const bbcSendStep = async (flow, step, m) => {
    if (!(env.GHL_TOKEN && env.GHL_LOCATION_ID)) return { status: 'failed', why: 'Texting not set up' };
    const name = first(flow.full_name || (m && m.full_name) || ''), link = bbcLink(flow.token);
    const phone = phoneE164(flow.phone || (m && (m.phone || m.guardian_phone)));
    const email = (flow.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(flow.email)) ? flow.email : emailOf(m || {});
    const log = (channel, status, bodyText, extra = {}) => db.from('cb_messages').insert({ member_key: flow.member_key, kind: 'bbc',
      phone: channel === 'sms' ? phone : null, email: channel === 'email' ? email : null, body: bodyText, status, sent_by: 'automatic: bbc step ' + step.step, ...extra });
    let sent = false, why = '';
    if (step.channel === 'sms' || step.channel === 'both') {
      const text = bbcFill(step.sms_body, name, link);
      if (text && phone) {
        try {
          const cid = await contactFor({ ...(m || {}), email }, phone); if (!cid) throw new Error('no contact');
          const c = await ghl('/contacts/' + cid, { method: 'GET' }); const ct = (c && c.contact) || {};
          if (ct.dnd === true || (ct.dndSettings && ct.dndSettings.SMS && ct.dndSettings.SMS.status === 'active')) { await log('sms', 'skipped', text, { error: 'DND in GoHighLevel' }); }
          else { const gid = await sendSms(cid, text); await log('sms', 'sent', text, gid ? { ghl_id: gid } : {}); sent = true; }
        } catch (er) { why = String(er.message || er); await log('sms', 'failed', text, { error: why.slice(0, 400) }); }
      } else if (!phone) why = 'no mobile number';
    }
    if ((step.channel === 'email' || step.channel === 'both') && step.email_subject) {
      const subject = bbcFill(step.email_subject, name, link), bodyText = bbcFill(step.email_body, name, link);
      if (email) {
        try { const cid = await contactFor({ ...(m || {}), email }, phone); if (!cid) throw new Error('no contact');
          await sendEmailTo(cid, buildSeqEmail(subject, bodyText)); await log('email', 'sent', subject + '\n\n' + bodyText); sent = true;
        } catch (er) { why = String(er.message || er); await log('email', 'failed', subject + '\n\n' + bodyText, { error: why.slice(0, 400) }); }
      } else if (!why) why = 'no email address';
    }
    return sent ? { status: 'sent' } : { status: 'failed', why: why || 'nothing sent' };
  };
  const runBbc = async (nowMs = Date.now()) => {
    const res = { flows_created: 0, sent: 0, joined: 0, signed: 0, done: 0, failed: 0 };
    // Master switch: the welcome flow stays dark until Black Belt Club is turned on (cb_settings.bbc_on).
    // The hub feed and the landing page (bbc_feed / bbc_info / bbc_signup) do not go through here, so they work regardless.
    const { data: bcfg } = await db.from('cb_settings').select('bbc_on').eq('id', 1).maybeSingle();
    if (!(bcfg && bcfg.bbc_on)) return { ...res, off: true };
    const nowIso = new Date(nowMs).toISOString();
    // 1) Newly-closed coloured-belt days -> a flow for each invited, not-yet-in-BBC student
    const { data: days } = await db.from('cb_days').select('day_id').eq('closed', true).eq('bb', false).is('bbc_welcomed_at', null);
    for (const d of days || []) {
      const ents = await allRows(() => db.from('cb_entries').select('member_key, full_name').eq('day_id', d.day_id));
      const keys = [...new Set((ents || []).map(e => e.member_key).filter(Boolean))];
      if (keys.length) {
        const mem = await selectIn('efc_members', 'member_key, full_name, phone, guardian_phone, email, guardian_email, bbc_invited_at, bbc_seen_at', 'member_key', keys);
        for (const m of mem) {
          if (!m.bbc_invited_at || bbcInBbc(m)) continue;
          const { error } = await db.from('cb_bbc_flow').insert({ member_key: m.member_key, full_name: m.full_name,
            phone: m.phone || m.guardian_phone || null, email: m.email || m.guardian_email || null,
            day_id: d.day_id, started_at: nowIso, step: 0, status: 'active' });
          if (!error) res.flows_created++;   // a duplicate (already in a flow) is fine
        }
      }
      await db.from('cb_days').update({ bbc_welcomed_at: nowIso }).eq('day_id', d.day_id);
    }
    // 2) Send due touch points for active flows; stop anyone who has joined or signed
    const steps = ((await db.from('cb_bbc_steps').select('*').eq('active', true).order('step')).data) || [];
    if (!steps.length) return res;
    const last = steps[steps.length - 1].step;
    const flows = await allRows(() => db.from('cb_bbc_flow').select('*').eq('status', 'active').order('member_key'));
    const memMap = {};
    if (flows.length) (await selectIn('efc_members', 'member_key, full_name, phone, guardian_phone, email, guardian_email, bbc_seen_at', 'member_key', flows.map(f => f.member_key))).forEach(m => memMap[m.member_key] = m);
    for (const f of flows) {
      const m = memMap[f.member_key];
      if (f.signed_at) { await db.from('cb_bbc_flow').update({ status: 'signed', updated_at: nowIso }).eq('member_key', f.member_key); res.signed++; continue; }
      if (bbcInBbc(m)) { await db.from('cb_bbc_flow').update({ status: 'joined', updated_at: nowIso }).eq('member_key', f.member_key); res.joined++; continue; }
      const ageDays = (nowMs - new Date(f.started_at).getTime()) / 86400e3;
      const due = steps.filter(s => s.step > f.step && s.offset_days <= ageDays).sort((a, b) => a.step - b.step)[0];
      if (!due) continue;
      const r = await bbcSendStep(f, due, m);
      const patch = { step: due.step, updated_at: nowIso };
      if (due.step >= last) { patch.status = 'done'; res.done++; }
      await db.from('cb_bbc_flow').update(patch).eq('member_key', f.member_key);
      res[r.status === 'sent' ? 'sent' : 'failed']++;
    }
    return res;
  };

  try {
    const raw = await req.text();
    // ---- Stripe's webhook: a grading fee was paid ----
    const sig = req.headers.get('stripe-signature');
    if (sig) {
      const secrets = [env.STRIPE_WEBHOOK_SECRET_GRADING, env.STRIPE_WEBHOOK_SECRET].filter(Boolean);
      let good = false; for (const sec of secrets) if (await signatureOk(raw, sig, sec)) { good = true; break; }
      if (!good) return fail('Bad signature.', 400);
      const ev = JSON.parse(raw);
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev.type)) await markPaid(ev.data && ev.data.object);
      return json({ received: true });
    }
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) { /* not JSON */ }

    // ---- Families (no sign-in): the booking link ----
    if (body.action === 'info' || body.action === 'book' || body.action === 'pay') {
      const { data: cs } = await db.from('cb_settings').select('contact_phone, email_bring').eq('id', 1).maybeSingle();
      const phone = (cs && cs.contact_phone) || '(02) 9569 1943';
      const bring = String((cs && cs.email_bring) || BRING).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      let x = await entryByToken(db, body.token);
      if (!x) return json({ ok: false, phone, error: `This link isn't valid any more. Please call us on ${phone}.` }, 404);
      let { e, d } = x;
      // Back from Stripe (or the webhook hasn't come yet): ask Stripe whether it was paid
      if (!e.paid && env.STRIPE_SECRET_KEY) {
        const { data: pend } = await db.from('cb_payments').select('stripe_session').eq('entry_id', e.entry_id).eq('status', 'pending').maybeSingle();
        if (pend && pend.stripe_session) {
          try { if (await markPaid(await stripe('/checkout/sessions/' + encodeURIComponent(pend.stripe_session), { method: 'GET' }))) { x = await entryByToken(db, body.token); e = x.e; d = x.d; } } catch (er) { console.error(er); }
        }
      }
      const baseFee = await feeFor(e, d);
      const disc = discountOn(e, baseFee);
      // What they actually pay: the fee less any staff discount (the discount shows as its own line at checkout).
      const fee = baseFee == null ? null : Math.max(0, baseFee - disc);
      // Bookings close at the day's set time, unless staff issued a new (late) link
      const nowMs = Date.now(), late = e.late_ok_until && Date.parse(e.late_ok_until) > nowMs;
      const shut = !!(d.book_by && Date.parse(d.book_by) <= nowMs && !late);
      let receipt = null;
      if (e.paid && e.paid_how === 'card') { const { data: rp } = await db.from('cb_payments').select('receipt_url').eq('entry_id', e.entry_id).eq('status', 'paid').maybeSingle(); receipt = (rp && rp.receipt_url) || null; }
      const etm = entryTime(d, e);
      const info = { ok: true, first: first(e.full_name), belt_to: e.belt_to, date: d.grading_date, time: etm ? String(etm).slice(0, 5) : null,
        school: whereOf(e, d), fee, fee_full: baseFee, discount: disc, discount_reason: disc > 0 ? (e.discount_reason || null) : null, discount_note: disc > 0 ? (e.discount_note || null) : null,
        booked: !!e.booked_at, paid: !!e.paid, paid_how: e.paid ? (e.paid_how || 'desk') : null, closed: d.closed || !!e.result, bb: !!d.bb,
        card: !!(env.STRIPE_SECRET_KEY && fee > 0), booking_failed: !!(e.paid && !e.booked_at && e.booking_error),
        book_by: late ? e.late_ok_until : (d.book_by || null), booking_closed: shut, phone, receipt, bring };
      // Black belt essay still to submit (shown on the booking page as its own section)
      if (d.bb) { const eu = await essayUrlFor(db, e, d); if (eu) info.essay_url = eu; }
      const shutMsg = `Bookings for this grading have closed. Please call us on ${phone}.`;
      if (body.action === 'info') return json(info);
      if (body.action === 'book') {
        if (e.booked_at) return json({ ...info, booked: true });
        if (info.closed) return json({ ...info, ok: false, error: 'This grading has finished.' });
        if (shut) return json({ ...info, ok: false, error: shutMsg });
        // With a fee, the link only takes card payments (staff record any other payment)
        if (fee > 0) return json({ ...info, ok: false, error: info.card ? 'Please pay the grading fee by card to book.' : `Online payment isn't available for this grading. Please call us on ${phone} to book.` });
        const b = await bookEntry(e, d);
        if (b.notSetUp) return json({ ...info, ok: false, error: 'Online booking isn\'t set up for this grading yet. Please contact the front desk.' });
        if (!b.ok) return json({ ...info, ok: false, error: 'We couldn\'t book it just now. Please try again in a minute, or contact the front desk.' }, 502);
        await confirmEmail(e, d, 'email_booked');
        await confirmSms(e, d, 'sms_booked');
        return json({ ...info, booked: true });
      }
      // Pay by card
      if (e.paid) return json({ ...info, ok: false, error: 'This grading is already paid for.' });
      if (info.closed) return json({ ...info, ok: false, error: 'This grading has finished.' });
      if (shut) return json({ ...info, ok: false, error: shutMsg });
      if (!info.card) return json({ ...info, ok: false, error: 'Card payments aren\'t set up for this grading. Please pay at the front desk.' }, 409);
      const site = backTo(body.back);
      // Stripe emails the receipt to the family (their email from EFC)
      const { data: who } = await db.from('efc_members').select('email, guardian_email').eq('member_key', e.member_key).maybeSingle();
      const email = [who && who.email, who && who.guardian_email].find(v => v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || null;
      const sess = await stripe('/checkout/sessions', { method: 'POST', body: form({
        mode: 'payment', client_reference_id: e.entry_id, metadata: { kind: 'grading', entry_id: e.entry_id, day_id: e.day_id },
        payment_intent_data: { metadata: { kind: 'grading', entry_id: e.entry_id }, description: `AMA ${whereOf(e, d)} grading ${d.grading_date}: ${e.full_name} for ${e.belt_to}`, ...(email ? { receipt_email: email } : {}) },
        ...(email ? { customer_email: email } : {}),
        line_items: { 0: { quantity: 1, price_data: { currency: 'aud', unit_amount: Math.round(baseFee * 100), product_data: { name: `AMA grading: ${e.belt_to}`, description: `${first(e.full_name)}, ${whereOf(e, d)}, ${d.grading_date}` } } } },
        ...(disc > 0 ? { discounts: { 0: { coupon: await discountCoupon(e, baseFee) } } } : {}),
        ...(disc > 0 && String(e.discount_note || '').trim() ? { custom_text: { submit: { message: String(e.discount_note).trim().slice(0, 1000) } } } : {}),
        success_url: `${site}?paid=1#t=${e.token}`, cancel_url: `${site}#t=${e.token}` }) });
      const { data: had } = await db.from('cb_payments').select('payment_id').eq('entry_id', e.entry_id).eq('status', 'pending').maybeSingle();
      if (had) await db.from('cb_payments').update({ stripe_session: sess.id, amount: fee, created_at: new Date().toISOString() }).eq('payment_id', had.payment_id);
      else await db.from('cb_payments').insert({ entry_id: e.entry_id, member_key: e.member_key, full_name: e.full_name, day_id: e.day_id, amount: fee, status: 'pending', stripe_session: sess.id });
      return json({ ok: true, url: sess.url });
    }

    // ---- Families (no sign-in): the grading photo link ----
    if (body.action === 'photo') {
      const byCode = /^[A-Za-z0-9]{8,16}$/.test(String(body.code || ''));
      if (!byCode && !tokenOk(body.token)) return json({ ok: false, error: 'This link isn\'t valid. Ask the front desk for a new one.' }, 404);
      const { data: e } = await db.from('cb_entries').select('entry_id, day_id, full_name, belt_to, photo_path, photo_removed_at').eq(byCode ? 'photo_code' : 'token', byCode ? body.code : body.token).maybeSingle();
      if (!e) return json({ ok: false, error: 'This link isn\'t valid. Ask the front desk for a new one.' }, 404);
      const { data: d } = await db.from('cb_days').select('location, grading_date').eq('day_id', e.day_id).maybeSingle();
      const info = { ok: true, first: first(e.full_name), belt_to: e.belt_to, school: d ? venueOf(d.location) : null, date: d ? d.grading_date : null, photo: false };
      if (!e.photo_path) return json({ ...info, removed: !!e.photo_removed_at, error: e.photo_removed_at ? 'Grading photos are kept for 30 days, and this one has been removed. Please ask the front desk if you need it.' : 'The photo isn\'t ready yet. Please check again soon.' });
      const name = `${String(e.full_name || 'grading').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-AMA-grading.${(String(e.photo_path).match(/\.(jpe?g|png|webp)$/i) || [, 'jpg'])[1].toLowerCase()}`;
      const bucket = db.storage.from('grading-photos');
      const [{ data: v, error: ve }, { data: dl }] = await Promise.all([bucket.createSignedUrl(e.photo_path, 3600), bucket.createSignedUrl(e.photo_path, 3600, { download: name })]);
      if (ve || !v) return json({ ...info, error: 'The photo couldn\'t be loaded just now. Please try again soon.' }, 502);
      return json({ ...info, photo: true, url: v.signedUrl, download: (dl && dl.signedUrl) || v.signedUrl, filename: name });
    }

    // ---- The nightly job: delete grading photos 30 days after they're taken ----
    if (body.action === 'cleanup') {
      const { data: okCron } = await db.rpc('cb_cron_ok', { p_secret: req.headers.get('x-cb-cron') || '' });
      if (okCron !== true) return fail('Not allowed.', 403);
      const { data: names, error: le } = await db.rpc('cb_old_photos', { p_days: 30 });
      if (le) throw le;
      const list = (names || []).map(x => typeof x === 'string' ? x : x.cb_old_photos).filter(Boolean);
      let removed = 0, cleared = 0;
      for (let i = 0; i < list.length; i += 100) {
        const batch = list.slice(i, i + 100);
        const { error: re } = await db.storage.from('grading-photos').remove(batch);
        if (re) throw re;
        removed += batch.length;
        const { data: n } = await db.rpc('cb_photos_removed', { p_names: batch });
        cleared += Number(n) || 0;
      }
      return json({ ok: true, removed, cleared });
    }

    // ---- The booking sequence, every 15 minutes (pg_cron, coloured-belts-23.sql) ----
    if (body.action === 'sequence') {
      const { data: okCron } = await db.rpc('cb_cron_ok', { p_secret: req.headers.get('x-cb-cron') || '' });
      if (okCron !== true) return fail('Not allowed.', 403);
      const seq = await runSequence();
      let dinner = null; try { dinner = await runDinnerSend(); } catch (er) { dinner = { error: String(er.message || er) }; }
      let bbc = null; try { bbc = await runBbc(); } catch (er) { bbc = { error: String(er.message || er) }; }
      return json({ ...seq, dinner, bbc });
    }

    // Admin (cron-authed): book one already-paid entry into EFC. For a student whose payment was recorded
    // out-of-band (e.g. a credit applied directly) so the normal pay-then-book flow never ran, and who is
    // still unbooked. Uses the same bookEntry logic as a card/desk payment (right session, idempotent,
    // falls back to efc_by_hand when something's missing).
    if (body.action === 'book_entry') {
      const { data: okCron } = await db.rpc('cb_cron_ok', { p_secret: req.headers.get('x-cb-cron') || '' });
      if (okCron !== true) return fail('Not allowed.', 403);
      const { data: e } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, booked_at, booking_error, paid, paid_how, school').eq('entry_id', String(body.entry_id || '')).maybeSingle();
      if (!e) return fail('Entry not found.', 404);
      if (!e.paid) return fail('Entry is not paid, so it should not be booked.', 409);
      if (e.booked_at) return json({ ok: true, already: true, booked: true });
      const { data: d } = await db.from('cb_days').select('day_id, location, grading_date, start_time, efc_session_id, efc_sessions, efc_belt_sessions, efc_school_belt_sessions, belt_times, closed, programme, book_by, bb').eq('day_id', e.day_id).maybeSingle();
      if (!d) return fail('Grading day not found.', 404);
      const b = await bookEntry(e, d);
      return json({ ok: !!b.ok, booked: !!(b.ok && e.booked_at), byHand: !!b.byHand, booking_error: b.ok ? null : (b.why || null), full_name: e.full_name });
    }

    // ---- Families (no sign-in): the Black Belt Club welcome landing page (coloured-belts-40) ----
    if (body.action === 'bbc_info' || body.action === 'bbc_signup') {
      const tok = String(body.token || '');
      if (!/^[A-Za-z0-9_-]{10,}$/.test(tok)) return json({ ok: false, error: 'This link isn\'t valid.' }, 404);
      const { data: f } = await db.from('cb_bbc_flow').select('*').eq('token', tok).maybeSingle();
      if (!f) return json({ ok: false, error: 'This link isn\'t valid.' }, 404);
      const { data: m } = await db.from('efc_members').select('full_name, bbc_seen_at').eq('member_key', f.member_key).maybeSingle();
      const enrolled = bbcInBbc(m);
      if (body.action === 'bbc_signup') {
        if (!enrolled && !f.signed_at) await db.from('cb_bbc_flow').update({ signed_at: new Date().toISOString(), uniform_claim: !!body.uniform, sub_consent: true, status: 'signed', updated_at: new Date().toISOString() }).eq('member_key', f.member_key);
        return json({ ok: true });
      }
      const { data: cs } = await db.from('cb_settings').select('bbc_video_url, bbc_weekly, bbc_uniform_full, bbc_uniform_now').eq('id', 1).maybeSingle();
      return json({ ok: true, first_name: first(f.full_name || (m && m.full_name) || ''), video_url: (cs && cs.bbc_video_url) || '',
        weekly: (cs && cs.bbc_weekly) || 20, uniform_full: cs && cs.bbc_uniform_full, uniform_now: cs && cs.bbc_uniform_now, enrolled, signed: !!f.signed_at });
    }

    // ---- Black Belt Club sign-ups feed for Mark's hub (coloured-belts-40). key is cb_settings.hook_key. ----
    // Returns new sign-ups to action on the hub's "my day / main" view. Pass { ack:[member_key,...] } to mark them picked up.
    if (body.action === 'bbc_feed') {
      const { data: st } = await db.from('cb_settings').select('hook_key').eq('id', 1).maybeSingle();
      if (!st || !st.hook_key || String(body.key || '') !== st.hook_key) return fail('Not allowed.', 403);
      if (Array.isArray(body.ack) && body.ack.length) {
        await db.from('cb_bbc_flow').update({ feed_seen_at: new Date().toISOString() }).in('member_key', body.ack.map(String).slice(0, 500));
        return json({ ok: true, acked: body.ack.length });
      }
      const rows = await allRows(() => db.from('cb_bbc_flow').select('member_key, full_name, phone, email, signed_at, uniform_claim, sub_consent, day_id').eq('status', 'signed').is('feed_seen_at', null).order('signed_at'));
      const signups = (rows || []).map(f => ({ member_key: f.member_key, name: f.full_name, phone: f.phone, email: f.email,
        signed_at: f.signed_at, wants_uniform: !!f.uniform_claim, agreed_weekly: !!f.sub_consent, day_id: f.day_id }));
      return json({ ok: true, signups });
    }

    // ---- The hub sends approved Little Dragons nominations (coloured-belts-36.sql) ----
    // { action:'ld_nominate', key, day_id?, nominations:[{ nomination_id?, efc_reference?, member_key?, full_name?, school?, belt, current_belt?, remove? }] }
    // Each nomination becomes (or updates) an entry on the Little Dragons grading day, so the family pipeline runs. key is cb_settings.hook_key.
    if (body.action === 'ld_nominate') {
      const { data: st } = await db.from('cb_settings').select('hook_key').eq('id', 1).maybeSingle();
      if (!st || !st.hook_key || String(body.key || '') !== st.hook_key) return fail('Not allowed.', 403);
      const noms = Array.isArray(body.nominations) ? body.nominations : [];
      if (!noms.length) return fail('No nominations.');
      // The grading day: the one named, else the next upcoming Little Dragons day.
      const today = sydParts(Date.now()).ymd;
      let day = null;
      if (body.day_id) { const { data: d } = await db.from('cb_days').select('day_id').eq('day_id', String(body.day_id)).maybeSingle(); day = d; }
      else { const { data: ds } = await db.from('cb_days').select('day_id').eq('programme', 'Taekwondo - Little Dragon').eq('bb', false).eq('closed', false).gte('grading_date', today).order('grading_date').limit(1); day = (ds || [])[0]; }
      if (!day) return fail('No Little Dragons grading day found.', 404);
      // The Little Dragon belt ladder, to recognise and tidy up the belt each child is going for.
      const { data: ladder0 } = await db.from('cb_belts').select('belt').eq('programme', 'Taekwondo - Little Dragon');
      const norm = s => String(s || '').trim().toLowerCase().replace(/[–—]/g, '-').replace(/\s*belt\s*$/, '').replace(/\s+/g, ' ');
      const canon = {};
      for (const b of (ladder0 || [])) canon[norm(b.belt)] = b.belt;
      const alias = { 'going for master': 'Master Belt', 'going for master belt': 'Master Belt', 'master red': 'Master Belt', 'master black': 'Master Belt', 'master - red': 'Master Belt', 'master - black': 'Master Belt' };
      const beltOf = raw => canon[norm(raw)] || alias[norm(raw)] || null;
      const results = [];
      for (const n of noms.slice(0, 500)) {
        const out = { nomination_id: n.nomination_id || null, ok: false };
        results.push(out);
        try {
          let member_key = String(n.member_key || '').trim();
          let full_name = String(n.full_name || '').trim();
          const school = String(n.school || '').trim();
          if ((!member_key || !full_name) && String(n.efc_reference || '').trim()) {
            const { data: m } = await db.from('efc_members').select('member_key, full_name').eq('efc_reference', String(n.efc_reference).trim()).maybeSingle();
            if (m) { member_key = member_key || m.member_key; full_name = full_name || m.full_name || ''; }
          }
          if (!member_key) { out.error = 'Could not find the child (need member_key or a known efc_reference).'; continue; }
          out.member_key = member_key;
          const { data: ex } = await db.from('cb_entries').select('entry_id, paid, booked_at').eq('day_id', day.day_id).eq('member_key', member_key).maybeSingle();
          // Withdraw a nomination ("Not this time") -- but never silently drop one who's already booked or paid.
          if (n.remove === true || norm(n.belt) === 'not this time') {
            if (!ex) { out.ok = true; out.status = 'not_found'; }
            else if (ex.paid || ex.booked_at) { out.ok = true; out.status = 'kept_already_booked'; out.entry_id = ex.entry_id; }
            else { await db.from('cb_entries').delete().eq('entry_id', ex.entry_id); out.ok = true; out.status = 'removed'; out.entry_id = ex.entry_id; }
            continue;
          }
          const belt_to = beltOf(n.belt);
          if (!belt_to) { out.error = 'Unknown belt "' + String(n.belt || '') + '".'; continue; }
          if (!full_name) { out.error = "Missing the child's name."; continue; }
          const belt_from = String(n.current_belt || '').trim() || 'White Belt';
          const fields = { full_name, belt_from, belt_to, school: school || null, ld_nomination_id: n.nomination_id ? String(n.nomination_id) : null };
          if (ex) {
            await db.from('cb_entries').update(fields).eq('entry_id', ex.entry_id);
            out.ok = true; out.status = 'updated'; out.entry_id = ex.entry_id;
          } else {
            const { data: ins, error: ie } = await db.from('cb_entries').insert({ day_id: day.day_id, member_key, ...fields }).select('entry_id').maybeSingle();
            if (ie) throw ie;
            out.ok = true; out.status = 'created'; out.entry_id = ins && ins.entry_id;
          }
        } catch (e) { out.error = String(e && e.message || e).slice(0, 200); }
      }
      return json({ ok: true, day_id: day.day_id, results });
    }

    // ---- Grading helpers: a select black belt opens their personal link, sees the grading days they can help at,
    // and taps to put their hand up (or pull out). { action: 'helper_info' | 'helper_toggle', token, day_id?, on? } ----
    if (body.action === 'helper_info' || body.action === 'helper_toggle') {
      const h = await helperByToken(db, body.token);
      if (!h) return json({ ok: false, error: "This link isn't valid any more. Please contact the office." }, 404);
      const age = await helperAgeOf(db, h.member_key);
      const today = new Date().toISOString().slice(0, 10);
      if (body.action === 'helper_toggle') {
        const dayId = String(body.day_id || '');
        const { data: d } = await db.from('cb_days').select('day_id, bb, programme, helper_open, helper_cap, helper_audience, closed, grading_date').eq('day_id', dayId).maybeSingle();
        if (!d || !d.helper_open || d.closed || d.grading_date < today) return json({ ok: false, error: "That day isn't open for helpers." }, 400);
        if (!d.bb && (!helperCanSee(d.helper_audience, age) || !helperSeesDay(h, d))) return json({ ok: false, error: "That day isn't available for you." }, 403);
        if (body.on !== false) {
          const { data: mineRow } = await db.from('cb_helper_signups').select('helper_id').eq('day_id', dayId).eq('helper_id', h.helper_id).maybeSingle();
          if (!mineRow) {
            const { count } = await db.from('cb_helper_signups').select('helper_id', { count: 'exact', head: true }).eq('day_id', dayId);
            if ((count || 0) >= (d.helper_cap || 0)) return json({ ok: false, full: true, error: 'That day is full now.' });
            await db.from('cb_helper_signups').insert({ helper_id: h.helper_id, day_id: dayId });
          }
        } else {
          await db.from('cb_helper_signups').delete().eq('helper_id', h.helper_id).eq('day_id', dayId);
        }
      }
      const { data: days } = await db.from('cb_days').select('day_id, grading_date, start_time, location, bb, programme, belts, helper_cap, helper_audience').eq('helper_open', true).eq('closed', false).gte('grading_date', today).order('grading_date');
      const ids = (days || []).map(d => d.day_id), counts = {}, mine = new Set();
      if (ids.length) { const { data: su } = await db.from('cb_helper_signups').select('day_id, helper_id').in('day_id', ids); for (const r of (su || [])) { counts[r.day_id] = (counts[r.day_id] || 0) + 1; if (r.helper_id === h.helper_id) mine.add(r.day_id); } }
      const coloured = (days || []).filter(d => !d.bb && helperCanSee(d.helper_audience, age) && (helperSeesDay(h, d) || mine.has(d.day_id))).map(d => helperDayRow(d, counts, mine));
      const blackbelt = (days || []).filter(d => d.bb).map(d => helperDayRow(d, counts, mine));
      return json({ ok: true, name: first(h.full_name), age, coloured, blackbelt });
    }

    // ---- A family replied to the grading text (GoHighLevel "Customer replied" workflow, coloured-belts-16.sql) ----
    // { action: 'reply', key, phone, message }: if it's a YES, every student from that family who was invited (and hasn't
    // booked) for a coming grading day is marked "Said YES", and is texted the booking link (the "Reminder to book" wording,
    // which is the official invitation). Anything else is just noted. The key is cb_settings.reply_key.
    if (body.action === 'reply') {
      const { data: st } = await db.from('cb_settings').select('*').eq('id', 1).maybeSingle();
      if (!st || !st.reply_key || String(body.key || '') !== st.reply_key) return fail('Not allowed.', 403);
      const msg = String(body.message || '').trim(), p9 = String(body.phone || '').replace(/\D/g, '').slice(-9);
      // Which channel did they reply on? GoHighLevel sends "channel" (or "type") = "Email"/"SMS"; default to SMS when it's absent.
      const chRaw = String(body.channel || body.type || '').toLowerCase(), viaEmail = /mail/.test(chRaw);
      const bodyEmail = String(body.email || '').trim().toLowerCase(), okBodyEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(bodyEmail);
      // The same reply delivered twice (GoHighLevel can fire its workflow more than once): handle it only once, so a family never
      // gets two answers. A repeat of the same words from the same number within 15 minutes is ignored (coloured-belts-34.sql).
      { const who = p9.length === 9 ? p9 : (okBodyEmail ? bodyEmail : '');
        if (who && msg) {
          const h = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg.toLowerCase().replace(/\s+/g, ' '))));
          try {
            await db.from('cb_reply_seen').delete().eq('who', who).lt('seen_at', new Date(Date.now() - 15 * 60e3).toISOString());
            const { error: seenErr } = await db.from('cb_reply_seen').insert({ who, h });
            if (seenErr && (seenErr.code === '23505' || /duplicate/i.test(seenErr.message || ''))) {
              // A short answer like "2" can be a real second reply (e.g. after "that session is full"): only treat it as the
              // same delivery when it's within 90 seconds. Longer messages: within 15 minutes.
              const win = msg.replace(/\s/g, '').length <= 3 ? 90e3 : 15 * 60e3;
              const { data: prev } = await db.from('cb_reply_seen').select('seen_at').eq('who', who).eq('h', h).maybeSingle();
              if (!prev || !prev.seen_at || Date.now() - Date.parse(prev.seen_at) < win) return json({ ok: true, duplicate: true });
              await db.from('cb_reply_seen').update({ seen_at: new Date().toISOString() }).eq('who', who).eq('h', h);
            }
          } catch (_) { /* no dedupe table yet: carry on */ }
        } }
      if (p9.length !== 9 && !okBodyEmail) return json({ ok: true, matched: 0, why: 'no mobile or email' });
      // ---- 4th Dan+ celebration dinner RSVP (dinner-rsvp-1): a guest replies YES/NO to the invite. A clear yes/no is
      //      recorded (and, for a shared number, for everyone on it) and stops here; anything else — e.g. a grading
      //      helper's session pick like "2" — falls through to the normal reply logic below. ----
      if (p9.length === 9) {
        let dguests = [];
        try { const { data } = await db.from('dinner_rsvp').select('id').eq('phone9', p9).eq('status', 'invited'); dguests = data || []; } catch (_) { /* no dinner table */ }
        if (dguests.length) {
          const yesDin = /^\s*(yes|yep|yeah|yup|yes please|count me in|i['’]?m in|we['’]?re in|coming|see you there|attending|will be there|be there|absolutely|definitely|of course|love to|sounds? (?:good|great))\b/i.test(msg) || (/\byes\b/i.test(msg) && !/\bno\b/i.test(msg));
          const noDin = /^\s*(no\b|nope|nah|can['’]?t|cannot|sorry|unfortunately|won['’]?t|not able|unable|afraid not)/i.test(msg) || /\b(can['’]?t make|won['’]?t make|not coming|not able to|can['’]?t attend)\b/i.test(msg);
          if (yesDin !== noDin) {   // exactly one matched: a clear answer
            await db.from('dinner_rsvp').update({ status: yesDin ? 'yes' : 'no', reply_text: msg.slice(0, 300), responded_at: new Date().toISOString(), synced_at: null }).eq('phone9', p9).eq('status', 'invited');
            return json({ ok: true, dinner_rsvp: yesDin ? 'yes' : 'no', guests: dguests.length });
          }
        }
      }
      // ---- A 4th Dan+ student answering the black belt grading helper text (prep-update-27, -28): "2", "1 and 3", "3, 1",
      //      "all" books them into those sessions (never past a session's cap of 6), "no / can't" is noted.
      //      Anything else carries on as a normal reply. ----
      if (p9.length === 9) {
        let hs = [];
        try { const { data } = await db.from('prep_helpers').select('cycle_id, student_id, offered_slots, senior, slot_ids').not('offered_at', 'is', null).is('declined_at', null); hs = (data || []).filter(h => !(h.slot_ids || []).length); } catch (_) { /* no helper tables */ }
        // Read the session numbers out of the reply. A bare list ("2", "1 and 3") is read as-is; a worded pick
        // ("Hi Eleni can do 1, 2 and 3", "available for 1 and 3") is read only when, after the intent phrase, what's
        // left is still basically just the numbers -- so a message that merely mentions a number ("what time is session 3?",
        // "can do 2 of them") is never misread as a session pick.
        const NUM_ONLY = /^\s*(?:(?:options?|numbers?|sessions?|no\.?)\s*|#)?[1-9](?:\s*(?:,|&|\+|\/|and|or|then)?\s*(?:(?:options?|numbers?|sessions?)\s*)?[1-9])*\s*(?:please|pls|thanks?|thank you|cheers)?\s*[.!]*\s*$/i;
        const PICK_LEAD = /(?:can\s+do|can\s+help(?:\s+(?:at|with|out))?|could\s+do|happy\s+to\s+(?:do|help)|keen\s+(?:to\s+do|for)|available\s+(?:for|on)|free\s+(?:for|on)|i['’]?ll\s+(?:do|take)|i\s+can\s+do|put\s+me\s+(?:down|in)\s+for)\s+/i;
        const lead = msg.match(PICK_LEAD), numSrc = lead ? msg.slice(lead.index + lead[0].length) : msg;
        const nums = NUM_ONLY.test(numSrc) ? [...new Set((numSrc.match(/[1-9]/g) || []).map(Number))] : null;
        const allOf = /^\s*(all|all of them|all three|all 3|every one|everything|both)\b/i.test(msg);
        const noWay = /^\s*(no\b|nope|can'?t|cannot|unable|not available|sorry,? (?:i|we) can'?t)/i.test(msg);
        if (hs.length && (nums || allOf || noWay)) {
          const { data: ps } = await db.from('prep_students').select('student_id, full_name, contact_phone, contact_email').in('student_id', hs.map(h => h.student_id));
          const stu = (ps || []).find(x => String(x.contact_phone || '').replace(/\D/g, '').slice(-9) === p9), h = stu && hs.find(x => x.student_id === stu.student_id);
          if (h) {
            const fn = firstWord(stu.full_name) || 'there', phone = phoneE164(stu.contact_phone);
            const { data: slots } = await db.from('prep_helper_slots').select('*').eq('cycle_id', h.cycle_id).order('sort');
            const { data: ov } = await db.from('prep_overview').select('grading_to').eq('cycle_id', h.cycle_id).eq('student_id', h.student_id).maybeSingle();
            const day = (() => { const d = [...new Set((slots || []).map(x => String(x.grading_date || '').slice(0, 10)))]; if (d.length !== 1 || !d[0]) return ''; const [y, mo, dd] = d[0].split('-').map(Number); return new Date(Date.UTC(y, mo - 1, dd)).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).replace(',', ''); })();
            const is4th = /^4th Dan$/.test(String((ov && ov.grading_to) || '').trim());
            // Sessions keep their real numbers in every message (1 = 8:00am, 2 = 12:00pm, 3 = 3:30pm), so a number always means the same session.
            const numOf = id => (slots || []).findIndex(x => x.slot_id === id) + 1;
            const replyHint = (nums2, four) => { const n = [...(nums2 || [])].sort((a, b) => a - b); if (n.length <= 1) return `Reply ${n[0] || 1} to help`; const list = a => a.length <= 2 ? a.join(' and ') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; const eg = n.length >= 3 ? [n[0], n[2]] : n; return four ? `Reply with every number you can do (e.g. ${list(eg)}, or ${list(n)}). The more you can do, the better` : `Reply with the number of each session you can do (e.g. ${list(eg)}, or just ${n[n.length - 1]})`; };
            const reply = async text => {
              if (!(env.GHL_TOKEN && env.GHL_LOCATION_ID)) return env.GHL_TEST === '1';
              try { const cid = await contactFor({ full_name: stu.full_name, email: stu.contact_email }, phone); await sendSms(cid, text); return true; } catch (_) { return false; }
            };
            const nowIso = new Date().toISOString(), offered = (h.offered_slots || []).filter(id => (slots || []).some(x => x.slot_id === id));
            const labels = ids => { const l = (slots || []).filter(x => ids.includes(x.slot_id)).map(x => x.label.replace(/ session$/, '')); return l.length <= 1 ? (l[0] || '') + ' session' : l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1] + ' sessions'; };
            if (noWay && !nums && !allOf) {
              await db.from('prep_helpers').update({ declined_at: nowIso, reply_text: msg.slice(0, 300), updated_at: nowIso }).eq('cycle_id', h.cycle_id).eq('student_id', h.student_id);
              await reply(`No worries, ${fn}, thanks for letting us know. - AMA`);
              return json({ ok: true, helper: 'declined' });
            }
            if (allOf && /^\s*both\b/i.test(msg) && offered.length !== 2) return json({ ok: true, helper: 'unclear' });
            const slotByNum = n => { const sl = (slots || [])[n - 1]; return sl && offered.includes(sl.slot_id) ? sl.slot_id : null; };   // typed number -> that real session, if it was offered
            const want = allOf ? offered : (nums || []).map(slotByNum).filter(Boolean);
            const bad = allOf ? [] : (nums || []).filter(n => !slotByNum(n));
            let res = { ok: [], full: [], uneven: [] };
            if (want.length) { const { data } = await db.rpc('prep_helper_claim', { p_cycle: h.cycle_id, p_student: h.student_id, p_slots: want, p_reply: msg.slice(0, 300), p_by: 'reply', p_balance: want.length === 1 }); res = data || res; }
            const got = res.ok || [], missed = [...(res.full || []), ...(res.uneven || [])];
            if (got.length) {
              let tpl = "Thanks {first_name}! You're helping at the {sessions} on {day} at AMA Sydenham.{full_note}{sword} Please arrive 15-30 minutes before in full uniform. See you there! - AMA";
              try { const { data: hset } = await db.from('prep_helper_settings').select('confirm_text').eq('id', 1).maybeSingle(); if (hset && String(hset.confirm_text || '').trim()) tpl = hset.confirm_text; } catch (_) { /* default wording */ }
              // Going for 4th Dan: settle (once) which of their sessions the sword is presented at, keeping the three sessions ~even.
              let swordSentence = '';
              if (is4th) {
                const { data: meRow } = await db.from('prep_helpers').select('slot_ids, sword_slot').eq('cycle_id', h.cycle_id).eq('student_id', h.student_id).maybeSingle();
                const booked = (meRow && meRow.slot_ids && meRow.slot_ids.length) ? meRow.slot_ids : got;
                let swordSlot = meRow && meRow.sword_slot;
                if (!(swordSlot && booked.includes(swordSlot))) {
                  const { data: allH } = await db.from('prep_helpers').select('sword_slot').eq('cycle_id', h.cycle_id);
                  const cntS = id => (allH || []).filter(r => r.sword_slot === id).length;
                  swordSlot = [...booked].sort((a, b) => (cntS(a) - cntS(b)) || ((slots || []).findIndex(s => s.slot_id === a) - (slots || []).findIndex(s => s.slot_id === b)))[0] || null;
                  if (swordSlot) await db.from('prep_helpers').update({ sword_slot: swordSlot }).eq('cycle_id', h.cycle_id).eq('student_id', h.student_id);
                }
                const lbl = ((slots || []).find(s => s.slot_id === swordSlot) || {}).label || '';
                swordSentence = lbl ? ` You'll be presented your 4th Dan sword at the ${lbl.replace(/ session$/, '')} session.` : " You'll be presented your 4th Dan sword during the day.";
              }
              const fill = { first_name: fn, sessions: labels(got), day, sword: swordSentence, full_note: missed.length ? ` The ${labels(missed)} ${missed.length > 1 ? 'are' : 'is'} already full.` : '' };
              await reply(String(tpl).replace(/\{(\w+)\}/g, (m, k) => (fill[k] != null ? fill[k] : '')).replace(/ on  at /, ' at ').trim());
              return json({ ok: true, helper: 'ok', slots: got, full: missed });
            }
            // Nothing booked: those sessions have just filled (or the numbers weren't choices). Offer what still needs helpers.
            const { data: all } = await db.from('prep_helpers').select('student_id, slot_ids, senior').eq('cycle_id', h.cycle_id);
            const cnt = x => (all || []).filter(r => (r.slot_ids || []).includes(x.slot_id) && r.student_id !== h.student_id && r.senior !== false).length;
            const roomAll = (slots || []).filter(x => cnt(x) < (x.cap ?? 6)), lowN = roomAll.length ? Math.min(...roomAll.map(cnt)) : 0;
            // 4th Dans: re-offer every session with room, dropping one only once it's within 2 of its cap and an emptier
            // session has room (then the emptier ones). Other helpers: any session.
            const open4th = roomAll.filter(x => cnt(x) < (x.cap ?? 6) - 2 || cnt(x) === lowN);
            const room = h.senior === false ? (slots || []) : (open4th.length ? open4th : roomAll);
            if (!room.length) { await reply(`Sorry ${fn}, every helper session is now full. We'll be in touch if a spot opens up. - AMA`); return json({ ok: true, helper: 'all_full' }); }
            await db.from('prep_helpers').update({ offered_slots: room.map(x => x.slot_id), updated_at: nowIso }).eq('cycle_id', h.cycle_id).eq('student_id', h.student_id);
            const roomSorted = [...room].sort((a, b) => numOf(a.slot_id) - numOf(b.slot_id));
            const ask = replyHint(roomSorted.map(x => numOf(x.slot_id)), is4th);
            await reply(`Sorry ${fn}, ${missed.length ? (missed.length > 1 ? 'those sessions now have' : 'that session now has') + ' enough helpers' : (bad.length ? "that isn't one of the choices" : 'that session now has enough helpers')}. These sessions still need helpers:\n${roomSorted.map(x => `${numOf(x.slot_id)}. ${x.label}`).join('\n')}\n${ask}. - AMA`);
            return json({ ok: true, helper: missed.length ? 'full' : 'not_a_choice' });
          }
        }
      }
      const yes = isYes(msg);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
      const { data: days } = await db.from('cb_days').select('day_id, location, grading_date, start_time, belt_times, closed, programme, bb, belts, efc_belt_sessions, min_age, max_age, book_by, makeup, private').gte('grading_date', today);
      const open = (days || []).filter(d => !d.closed); if (!open.length) return json({ ok: true, matched: 0, why: 'no grading days coming up' });
      // Makeup grading days are only ever offered by staff (from the Can't-make list), never picked for a family automatically
      const offerable = open.filter(d => !d.makeup && !d.private);
      const ents = await allRows(() => db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, invited_at, booked_at, result, yes_at, school, alt_offer').in('day_id', open.map(d => d.day_id)).order('entry_id'));
      const waiting = (ents || []).filter(e => e.invited_at && !e.booked_at && !e.result);
      if (!waiting.length) return json({ ok: true, matched: 0 });
      const mems = await selectIn('efc_members', 'member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email, date_of_birth', 'member_key', waiting.map(e => e.member_key));
      const byKey = Object.fromEntries((mems || []).map(m => [m.member_key, m]));
      const last9 = x => String(x || '').replace(/\D/g, '').slice(-9);
      const mine = waiting.filter(e => {
        const m = byKey[e.member_key]; if (!m) return false;
        if (p9.length === 9 && (last9(m.phone) === p9 || last9(m.guardian_phone) === p9)) return true;
        if (okBodyEmail && (String(m.email || '').toLowerCase() === bodyEmail || String(m.guardian_email || '').toLowerCase() === bodyEmail)) return true;
        return false;
      });
      const ready0 = !!(env.GHL_TOKEN && env.GHL_LOCATION_ID), testing0 = env.GHL_TEST === '1';
      // A text (or, while GoHighLevel's daily limit has stopped texting, the same words by email) to this family
      const familyText = async (m, e, text, kind, sentBy, subject) => {
        const phone = phoneE164(m.phone || m.guardian_phone);
        const log = (status, extra = {}) => db.from('cb_messages').insert({ entry_id: e.entry_id, member_key: e.member_key, kind, phone, body: text, status, sent_by: sentBy, ...extra });
        if (testing0 && !ready0) { await log('test'); return { ok: true, test: true }; }
        if (!ready0) return { ok: false, error: 'texting not set up' };
        // They replied by email: answer by email too, the same channel they used
        if (viaEmail) {
          const email = goodEmail(m) || (okBodyEmail ? bodyEmail : null);
          if (email) {
            const elog = (status, extra = {}) => db.from('cb_messages').insert({ entry_id: e.entry_id, member_key: e.member_key, kind, email, body: text, status, sent_by: sentBy + ' (email reply)', ...extra });
            try { const cid = await contactFor({ ...m, email }, phone); await sendEmailTo(cid, buildSeqEmail(subject || `${firstWord(m.full_name || e.full_name)}'s grading`, text)); await elog('sent'); return { ok: true, emailed: true }; }
            catch (er) { const w = String(er.message || er).slice(0, 500); await elog('failed', { error: w }); return { ok: false, error: w }; }
          }
        }
        if (smsBlocked(st)) { const b = await emailBackup({ m, entry_id: e.entry_id, subject, text, why: 'texting paused' }); return { ok: b.ok, emailed: b.ok, error: b.why }; }
        try { const cid = await contactFor({ ...m, email: m.email || m.guardian_email }, phone); const gid = await sendSms(cid, text); await log('sent', gid ? { ghl_id: gid } : {}); return { ok: true }; }
        catch (er) { const w = String(er.message || er).slice(0, 500); await log('failed', { error: w }); return { ok: false, error: w }; }
      };
      const ageNow = m => (m && typeof m.date_of_birth === 'string' && /^\d{4}-\d{2}-\d{2}/.test(m.date_of_birth)) ? Math.floor((Date.now() - Date.parse(m.date_of_birth.slice(0, 10))) / 31557600000) : null;
      const shortDay = ymd => { const [y, mo, dd] = String(ymd).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, mo - 1, dd)).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', ''); };
      const dayLine = (d, e) => `${shortDay(d.grading_date)}${(et => et ? ' ' + clock(et) : '')(entryTime(d, e))} at AMA ${whereOf(e, d)}`;
      const bookText = (m, e, d) => famFill(st.not_booked_text, m, { parent: firstWord(m.guardian_name) || 'there', first: firstWord(m.full_name || e.full_name), next: e.belt_to,
        school: whereOf(e, d), date: longDay(d.grading_date), time: (et => et ? ' at ' + clock(et) : '')(entryTime(d, e)), link: SITE + 'b#' + e.token });

      // ---- When a belt correction can't be auto-fixed, text the admin (cb_settings.alert_phone) and remember the question ----
      const alertAdmin = async (text) => {
        if (!st.alert_phone || !ready0) return { ok: false };
        try { const cid = await contactFor({ guardian_name: 'AMA grading', full_name: 'AMA grading' }, phoneE164(st.alert_phone)); if (cid) { await sendSms(cid, text); return { ok: true }; } } catch (_) { /* ignore */ }
        return { ok: false };
      };
      const askAdmin = async ({ kind, entry, entries, text }) => {
        const { data: top } = await db.from('cb_admin_q').select('ref').is('resolved_at', null).order('ref', { ascending: false }).limit(1);
        const ref = ((top && top[0] && top[0].ref) || 0) + 1;
        await db.from('cb_admin_q').insert({ ref, kind, phone: body.phone || null, entry_id: entry ? entry.entry_id : null, entry_ids: entries ? entries.map(e => e.entry_id) : null, body: msg.slice(0, 300) });
        await alertAdmin(text(ref));
        return ref;
      };

      // ---- The admin replied to a belt-check text: apply it to the right student (ref number maps the reply to its question) ----
      if (st.alert_phone && p9 === last9(st.alert_phone)) {
        const r = String(msg).trim();
        const mref = r.match(/^\s*#?\s*(\d{1,4})\b[\s:.\-]*(.*)$/s);
        let q = null, rest = r;
        if (mref) { const { data } = await db.from('cb_admin_q').select('*').eq('ref', Number(mref[1])).is('resolved_at', null).order('created_at', { ascending: false }).limit(1); if (data && data[0]) { q = data[0]; rest = mref[2].trim(); } }
        if (!q) {
          const { data: openq } = await db.from('cb_admin_q').select('*').is('resolved_at', null).order('created_at');
          if (!openq || !openq.length) { await alertAdmin('No belt checks are waiting.'); return json({ ok: true, admin: true, none: true }); }
          if (openq.length === 1) { q = openq[0]; }
          else { await alertAdmin('Start your reply with the number, e.g. "' + openq[0].ref + ' green to blue". Waiting: ' + openq.map(x => '#' + x.ref).join(', ')); return json({ ok: true, admin: true, need_ref: true }); }
        }
        const resolveQ = how => db.from('cb_admin_q').update({ resolved_at: new Date().toISOString(), resolution: how }).eq('id', q.id);
        if (/^\s*(ignore|skip|leave|none|no)\b/i.test(rest)) { await resolveQ('ignored'); await alertAdmin('OK, left #' + q.ref + ' as it was.'); return json({ ok: true, admin: true, ignored: true }); }
        // ---- The admin replied with a school to move them to (e.g. "6 concord"): move everyone on the check to a grading there, keeping their belt, and text their links ----
        {
          const LOC_WORDS = [['Marrickville', /\bmarrickville\b/], ['Sydenham', /\bsydenham\b/], ['Concord', /\bconcord\b/], ['Sylvania', /\bsylvania\b/], ['West', /\bauburn\b|\bama\s+west\b|\bwest\b/]];
          const lowL = ' ' + rest.toLowerCase() + ' ';
          const locHits = LOC_WORDS.filter(([, re]) => re.test(lowL));
          const wantLoc = locHits.length === 1 ? locHits[0][0] : null;
          if (wantLoc) {
            const ids = q.entry_id ? [q.entry_id] : (q.entry_ids || []);
            const { data: ents } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, yes_at, booked_at, paid').in('entry_id', ids);
            if (!ents || !ents.length) { await resolveQ('gone'); await alertAdmin('#' + q.ref + ': those students are no longer on a grading day.'); return json({ ok: true, admin: true, gone: true }); }
            const nowIso2 = new Date().toISOString(), movedNames = [], noFit = [], sentOk = [];
            for (const e2 of ents) {
              const cur2 = open.find(x => x.day_id === e2.day_id) || (await db.from('cb_days').select('day_id, location, grading_date, start_time, belt_times, closed, programme, bb, belts, efc_belt_sessions, min_age, max_age, book_by').eq('day_id', e2.day_id).maybeSingle()).data;
              const m2 = (await db.from('efc_members').select('member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email, date_of_birth').eq('member_key', e2.member_key).maybeSingle()).data || { member_key: e2.member_key };
              const age2 = ageNow(m2);
              const target = offerable.filter(x => x.location === wantLoc && x.day_id !== e2.day_id && fitsDay(x, { day_id: '', belt_from: e2.belt_from }, age2, cur2))
                .sort((a, b) => String(a.grading_date).localeCompare(String(b.grading_date)) || String(a.start_time || '').localeCompare(String(b.start_time || '')))[0];
              if (!target) { noFit.push(firstWord(e2.full_name)); continue; }
              const { data: clash } = await db.from('cb_entries').select('entry_id').eq('day_id', target.day_id).eq('member_key', e2.member_key).maybeSingle();
              if (clash && clash.entry_id !== e2.entry_id) { noFit.push(firstWord(e2.full_name) + ' (already there)'); continue; }
              await db.from('cb_entries').update({ day_id: target.day_id, moved_from_day: e2.day_id, yes_at: e2.yes_at || nowIso2, seq_paused_until: null, alt_offer: null, cant_make_at: null, cant_make_reason: null }).eq('entry_id', e2.entry_id);
              movedNames.push(firstWord(e2.full_name));
              const fixed2 = { ...e2, day_id: target.day_id };
              const r2 = await familyText(m2, fixed2, bookText(m2, fixed2, target), 'not_booked', 'admin: moved school by text', `${firstWord(m2.full_name || e2.full_name)}'s grading at AMA ${schoolLabel(target.location)}`);
              if (r2 && r2.ok) sentOk.push(firstWord(e2.full_name));
            }
            await resolveQ('moved to ' + schoolLabel(wantLoc));
            const parts = [];
            if (movedNames.length) parts.push('moved ' + movedNames.join(', ') + ' to ' + schoolLabel(wantLoc));
            if (sentOk.length) parts.push('link' + (sentOk.length > 1 ? 's' : '') + ' sent');
            if (noFit.length) parts.push('no ' + schoolLabel(wantLoc) + ' grading for ' + noFit.join(', '));
            await alertAdmin('Done #' + q.ref + ': ' + (parts.join('; ') || 'nothing to move') + '.');
            return json({ ok: true, admin: true, moved: movedNames, location: wantLoc, sent: sentOk.length });
          }
        }
        if (q.kind === 'test') {   // a test belt-check: show how the reply is read, change nothing
          const { data: tb } = await db.from('cb_belts').select('belt, next_belt').eq('programme', 'Taekwondo');
          const lad = tb || [], bw = b => String(b.belt).replace(/\s*belt$/i, '').trim().toLowerCase(), lw = ' ' + rest.toLowerCase() + ' ';
          const hs = lad.map(b => ({ belt: b.belt, at: lw.search(new RegExp('\\b' + bw(b).replace(/\s+/g, '\\s+') + '\\b')) })).filter(h => h.at >= 0).sort((a, b) => a.at - b.at);
          const nx = x => (lad.find(b => b.belt === x) || {}).next_belt || null, pv = x => (lad.find(b => b.next_belt === x) || {}).belt || null;
          let f = null, t = null; const ta = lw.search(/\bto\b/);
          if (ta >= 0 && hs.some(h => h.at < ta) && hs.some(h => h.at > ta)) { f = hs.filter(h => h.at < ta).pop().belt; t = hs.find(h => h.at > ta).belt; }
          else if (hs.length) { const b = hs[hs.length - 1].belt; if (/\b(is|are|already|currently|now|on|has|had|got|having|holding|wearing)\b/.test(lw)) { f = b; t = nx(b); } else { t = b; f = pv(b); } }
          await resolveQ('test');
          await alertAdmin(f && t ? `TEST #${q.ref}: read as "${f} to ${t}". The reply path works - nothing was changed.` : `TEST #${q.ref}: couldn't read a belt from that. Try "${q.ref} green to blue".`);
          return json({ ok: true, admin: true, test: true, from: f, to: t });
        }
        if (q.kind === 'question') {   // a "yes but also asked something" alert: "<ref> call" adds them to the team call list
          const ids = q.entry_id ? [q.entry_id] : (q.entry_ids || []);
          if (/\bcall\b/i.test(rest)) {
            const { data: ents } = await db.from('cb_entries').select('entry_id').in('entry_id', ids);
            for (const en of (ents || [])) {
              const { data: oc } = await db.from('cb_calls').select('call_id').eq('entry_id', en.entry_id).eq('done', false);
              const note = ('Replied yes with a question: ' + (q.body || '')).slice(0, 300);
              if ((oc || []).length) await db.from('cb_calls').update({ reason: 'concern', note, for_admin: false, callback_on: today, updated_at: new Date().toISOString() }).eq('entry_id', en.entry_id).eq('done', false);
              else await db.from('cb_calls').insert({ entry_id: en.entry_id, reason: 'concern', note, for_admin: false, callback_on: today });
            }
            await resolveQ('added to the call list');
            await alertAdmin('Done #' + q.ref + ': added to the call list for the team.');
            return json({ ok: true, admin: true, called: ids.length });
          }
          await alertAdmin('#' + q.ref + ': reply "' + q.ref + ' call" to add them to the call list, or "' + q.ref + ' ignore" to leave it.');
          return json({ ok: true, admin: true, need_action: true });
        }
        let entryId = q.entry_id;
        if (!entryId) {
          const { data: cand } = await db.from('cb_entries').select('entry_id, member_key, full_name').in('entry_id', q.entry_ids || []);
          const low = ' ' + rest.toLowerCase() + ' ';
          const named = (cand || []).filter(e => new RegExp('\\b' + firstWord(e.full_name).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(low));
          if (named.length !== 1) { await alertAdmin('#' + q.ref + ': which child - ' + (cand || []).map(e => firstWord(e.full_name)).join(', ') + '? e.g. "' + q.ref + ' ' + (firstWord((cand || [])[0] && (cand || [])[0].full_name) || 'Name') + ' brown to red"'); return json({ ok: true, admin: true, need_child: true }); }
          entryId = named[0].entry_id; rest = rest.replace(new RegExp('\\b' + firstWord(named[0].full_name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'), '').trim();
        }
        const { data: e } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, yes_at').eq('entry_id', entryId).maybeSingle();
        if (!e) { await resolveQ('gone'); await alertAdmin('#' + q.ref + ': that student is no longer on a grading day.'); return json({ ok: true, admin: true, gone: true }); }
        let d = open.find(x => x.day_id === e.day_id);
        if (!d) { const { data: dd } = await db.from('cb_days').select('day_id, location, grading_date, start_time, belt_times, closed, programme, bb, belts, efc_belt_sessions, min_age, max_age, book_by').eq('day_id', e.day_id).maybeSingle(); d = dd; }
        const { data: belts2 } = await db.from('cb_belts').select('programme, belt, next_belt, sort');
        const ladder = (belts2 || []).filter(b => b.programme === ((d && d.programme) || 'Taekwondo'));
        const beltWord = b => String(b.belt).replace(/\s*belt$/i, '').trim().toLowerCase();
        const low2 = ' ' + rest.toLowerCase() + ' ';
        const hits = ladder.map(b => ({ belt: b.belt, at: low2.search(new RegExp('\\b' + beltWord(b).replace(/\s+/g, '\\s+') + '\\b')) })).filter(h => h.at >= 0).sort((a, b) => a.at - b.at);
        const nextB = x => (ladder.find(b => b.belt === x) || {}).next_belt || null, prevB = x => (ladder.find(b => b.next_belt === x) || {}).belt || null;
        let from = null, to = null; const toAt = low2.search(/\bto\b/);
        if (toAt >= 0 && hits.some(h => h.at < toAt) && hits.some(h => h.at > toAt)) { from = hits.filter(h => h.at < toAt).pop().belt; to = hits.find(h => h.at > toAt).belt; }
        else if (hits.length) { const b = hits[hits.length - 1].belt; if (/\b(is|are|already|currently|now|on|has|had|got|having|holding|wearing)\b/.test(low2)) { from = b; to = nextB(b); } else { to = b; from = prevB(b); } }
        if (!from || !to) { await alertAdmin('#' + q.ref + ': didn\'t catch the belt. Reply like "' + q.ref + ' green to blue" or "' + q.ref + ' grade for blue".'); return json({ ok: true, admin: true, need_belt: true }); }
        const m = (await db.from('efc_members').select('member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email, date_of_birth').eq('member_key', e.member_key).maybeSingle()).data || { member_key: e.member_key };
        const age = ageNow(m), was = `${e.belt_from} to ${e.belt_to}`, nowIso = new Date().toISOString();
        let nd = d;
        if (d && !fitsDay({ ...d, day_id: '-' }, { day_id: '', belt_from: from }, age, d)) {
          const alt = offerable.filter(x => x.location === d.location && x.day_id !== d.day_id && fitsDay(x, { day_id: '', belt_from: from }, age, d))
            .sort((a, b) => String(a.grading_date).localeCompare(String(b.grading_date)) || String(a.start_time || '').localeCompare(String(b.start_time || '')))[0];
          if (alt) { const { data: clash } = await db.from('cb_entries').select('entry_id').eq('day_id', alt.day_id).eq('member_key', e.member_key).maybeSingle(); if (!clash) nd = alt; }
        }
        await db.from('cb_entries').update({ belt_from: from, belt_to: to, belt_changed_from: was, belt_changed_at: nowIso, efc_belt_fix: nowIso, yes_at: e.yes_at || nowIso, seq_paused_until: null, alt_offer: null, ...(nd && nd.day_id !== e.day_id ? { day_id: nd.day_id, moved_from_day: e.day_id } : {}) }).eq('entry_id', e.entry_id);
        await db.from('cb_calls').update({ done: true, outcome: 'belt_fixed', outcome_note: 'Belt set by admin text: ' + from + ' to ' + to, updated_at: nowIso }).eq('entry_id', e.entry_id).eq('done', false).then(() => {}, () => {});
        await resolveQ(from + ' to ' + to);
        let sent = { ok: false };
        if (nd) { const fixed = { ...e, belt_from: from, belt_to: to, day_id: nd.day_id }; sent = await familyText(m, fixed, bookText(m, fixed, nd), 'belt_fix', 'admin: belt set by text', `${firstWord(m.full_name || e.full_name)}'s grading: ${to}`); }
        await alertAdmin('Done #' + q.ref + ': ' + firstWord(e.full_name) + ' set to ' + from + ' to ' + to + (nd && nd.day_id !== e.day_id ? ' (moved to ' + longDay(nd.grading_date) + ')' : '') + (sent.ok ? ', link resent.' : (nd ? ', couldn\'t resend.' : ', no day to book.')));
        return json({ ok: true, admin: true, applied: { entry_id: e.entry_id, from, to, moved: !!(nd && nd.day_id !== e.day_id) }, sent });
      }
      if (!mine.length) return json({ ok: true, matched: 0 });

      // ---- They picked another grading we offered (a reply of 1, 2 or 3): move them to it and send its booking link ----
      // ---- They picked a grading we offered. Shared/one-kid offers take a plain number; a split (per-child)
      //      offer takes the child's name + their number, e.g. "Avery 1, Yash 2". A reply can pick for one kid
      //      or several at once; a kid not named yet stays on offer. ----
      const offered = mine.filter(e => e.alt_offer && Array.isArray(e.alt_offer.days) && e.alt_offer.at && Date.now() - Date.parse(e.alt_offer.at) < ALT_VALID_MS);
      if (offered.length) {
        const low = ' ' + msg.toLowerCase() + ' ', picks = {};
        for (const e of offered) {   // per child: their first name, then a number within a few characters
          const fn = firstWord(e.full_name).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const mm = low.match(new RegExp('\\b' + fn + '\\b[^0-9]{0,8}([0-9])'));
          if (mm) picks[e.entry_id] = Number(mm[1]);
        }
        if (!Object.keys(picks).length) {   // no names: a plain number picks for every shared/one-kid offer
          const lone = msg.match(/^\s*(?:(?:option|number|no\.?|opt|choice|the)\s+|#)?([0-9])(?=[\s.,!?)]|$)/i);
          if (lone) for (const e of offered) if (!(e.alt_offer && e.alt_offer.split)) picks[e.entry_id] = Number(lone[1]);
        }
        if (Object.keys(picks).length) {
          const out = [], nowIso = new Date().toISOString();
          for (const e of offered) {
            const n = picks[e.entry_id]; if (n == null) continue;
            if (n === 0) {   // 0 = keep their original grading date after all: back on it, and the booking link again if they haven't booked
              const od = open.find(x => x.day_id === e.day_id), m = byKey[e.member_key];
              if (!od) { out.push({ entry_id: e.entry_id, error: 'original grading is closed' }); continue; }
              await db.from('cb_entries').update({ alt_offer: null, yes_at: e.yes_at || nowIso, reply_text: msg.slice(0, 300), reply_at: nowIso, seq_paused_until: null, cant_make_at: null, cant_make_reason: null }).eq('entry_id', e.entry_id);
              await db.from('cb_calls').update({ done: true, outcome: 'kept', outcome_note: 'Kept the original grading by text', updated_at: nowIso }).eq('entry_id', e.entry_id).eq('done', false).then(() => {}, () => {});
              const r = (e.booked_at || e.paid) ? { already: true } : await familyText(m, e, bookText(m, e, od), 'not_booked', 'automatic: kept the original grading', `${firstWord(m.full_name || e.full_name)}'s grading booking link`);
              out.push({ entry_id: e.entry_id, kept: od.day_id, ...r });
              continue;
            }
            const nd = open.find(x => x.day_id === e.alt_offer.days[n - 1]), m = byKey[e.member_key];
            if (!nd) { out.push({ entry_id: e.entry_id, error: 'not one of the choices' }); continue; }
            const { data: clash } = await db.from('cb_entries').select('entry_id').eq('day_id', nd.day_id).eq('member_key', e.member_key).maybeSingle();
            if (clash) { out.push({ entry_id: e.entry_id, error: 'already on that day' }); continue; }
            await db.from('cb_entries').update({ day_id: nd.day_id, moved_from_day: e.day_id, alt_offer: null, yes_at: e.yes_at || nowIso, reply_text: msg.slice(0, 300), reply_at: nowIso, seq_paused_until: null, cant_make_at: null, cant_make_reason: null }).eq('entry_id', e.entry_id);
            await db.from('cb_calls').update({ done: true, outcome: 'moved', outcome_note: 'Moved to another grading by text', updated_at: nowIso }).eq('entry_id', e.entry_id).eq('done', false).then(() => {}, () => {});
            const moved = { ...e, day_id: nd.day_id };
            const r = await familyText(m, moved, bookText(m, moved, nd), 'not_booked', 'automatic: moved to another grading', `${firstWord(m.full_name || e.full_name)}'s grading booking link`);
            out.push({ entry_id: e.entry_id, moved_to: nd.day_id, ...r });
          }
          if (out.length) return json({ ok: true, matched: mine.length, moved: out.filter(x => x.moved_to).length, kept: out.filter(x => x.kept).length, results: out });
        }
      }
      const stopping = /^\s*(stop|stopall|unsubscribe|end|quit)\b/i.test(msg);
      // Whose entry a reply is about: the only one waiting, or the child named in it
      const whichKid = () => { if (mine.length === 1) return mine[0]; const low = msg.toLowerCase(); const named = mine.filter(e => new RegExp('\\b' + firstWord(e.full_name).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(low)); return named.length === 1 ? named[0] : null; };
      const callFor = async (e, reason, note, admin = false) => {
        const { data: openCall } = await db.from('cb_calls').select('call_id').eq('entry_id', e.entry_id).eq('done', false);
        if ((openCall || []).length) await db.from('cb_calls').update({ reason, note: note.slice(0, 300), for_admin: admin, callback_on: today, updated_at: new Date().toISOString() }).eq('entry_id', e.entry_id).eq('done', false);
        else await db.from('cb_calls').insert({ entry_id: e.entry_id, reason, note: note.slice(0, 300), for_admin: admin, callback_on: today });
      };

      // ---- "That's the wrong belt" / "She's going for Green": fix the belt, move them to a grading for it, send the booking link ----
      if (!stopping) {
        const { data: belts } = await db.from('cb_belts').select('programme, belt, next_belt, sort');
        const ladderOf = prog => (belts || []).filter(b => b.programme === (prog || 'Taekwondo'));
        const e = whichKid(), d = e && open.find(x => x.day_id === e.day_id);
        const claim = e && d ? beltClaim(msg, ladderOf(d.programme)) : (mine.length > 1 && beltClaim(msg, ladderOf((open.find(x => x.day_id === mine[0].day_id) || {}).programme)));
        if (claim && !e) {   // a belt correction, but which child? Text the admin to decide
          for (const x of mine) { await db.from('cb_entries').update({ reply_text: msg.slice(0, 300), reply_at: new Date().toISOString() }).eq('entry_id', x.entry_id); }
          const m0 = byKey[mine[0].member_key];
          await askAdmin({ kind: 'which_child', entries: mine, text: ref => `Belt check #${ref}: ${firstWord((m0 && m0.guardian_name) || 'A family')} said "${msg.slice(0, 120)}". Which child - ${mine.map(x => firstWord(x.full_name)).join(', ')}? Reply e.g. "${ref} ${firstWord(mine[0].full_name)} brown to red".` });
          return json({ ok: true, matched: mine.length, belt: 'asked admin (which child)' });
        }
        if (claim && e && d) {
          const ladder = ladderOf(d.programme), nowIso = new Date().toISOString(), m = byKey[e.member_key];
          const from = claim.as === 'target' ? ((ladder.find(b => b.next_belt === claim.belt) || {}).belt || null) : claim.belt;
          const to = claim.as === 'target' ? claim.belt : ((ladder.find(b => b.belt === claim.belt) || {}).next_belt || null);
          if (from && to && (from !== e.belt_from || to !== e.belt_to)) {
            const age = ageNow(m);
            const fits = day => fitsDay({ ...day, day_id: '-' }, { day_id: '', belt_from: from }, age, d);
            let nd = fits(d) ? d : offerable.filter(x => x.location === d.location && x.day_id !== d.day_id && fits(x))
              .sort((a, b) => String(a.grading_date).localeCompare(String(b.grading_date)) || String(a.start_time || '').localeCompare(String(b.start_time || '')))[0] || null;
            if (nd && nd.day_id !== d.day_id) { const { data: clash } = await db.from('cb_entries').select('entry_id').eq('day_id', nd.day_id).eq('member_key', e.member_key).maybeSingle(); if (clash) nd = null; }
            const was = `${e.belt_from} to ${e.belt_to}`;
            if (!nd) {   // no grading at their school for that belt (and age): text the admin to decide
              await db.from('cb_entries').update({ reply_text: msg.slice(0, 300), reply_at: nowIso }).eq('entry_id', e.entry_id);
              const gm = byKey[e.member_key];
              await askAdmin({ kind: 'no_grading', entry: e, text: ref => `Belt check #${ref}: ${firstWord((gm && gm.guardian_name) || 'family')} for ${firstWord(e.full_name)} said "${msg.slice(0, 120)}" (we have ${was}); no ${d.location} grading for ${claim.belt}. Reply "${ref} <belt>" to set it anyway, e.g. "${ref} ${String(claim.belt).toLowerCase()}".` });
              return json({ ok: true, matched: mine.length, belt: 'asked admin (no grading)' });
            }
            await db.from('cb_entries').update({ belt_from: from, belt_to: to, belt_changed_from: was, belt_changed_at: nowIso, yes_at: e.yes_at || nowIso, reply_text: msg.slice(0, 300), reply_at: nowIso,
              seq_paused_until: null, alt_offer: null, ...(nd.day_id !== d.day_id ? { day_id: nd.day_id, moved_from_day: d.day_id } : {}) }).eq('entry_id', e.entry_id);
            const fixed = { ...e, belt_from: from, belt_to: to, day_id: nd.day_id };
            const tm = (et => et ? ' at ' + clock(et) : '')(entryTime(nd, fixed));
            const bfSelf = selfOf(m), bfGreet = bfSelf ? firstWord(m.full_name || e.full_name) : (firstWord(m.guardian_name) || 'there'), bfWho = bfSelf ? 'you' : firstWord(m.full_name || e.full_name);
            const text = `Thanks ${bfGreet}, sorry about that! We've updated ${bfWho} to grade for ${to} at AMA ${whereOf(fixed, nd)} on ${longDay(nd.grading_date)}${tm}. Book here: ${SITE}b#${e.token} AMA ${whereOf(fixed, nd)}`;
            const r = await familyText(m, fixed, text, 'belt_fix', 'automatic: belt corrected by reply', `${firstWord(m.full_name || e.full_name)}'s grading: ${to}`);
            await db.from('cb_calls').update({ done: true, outcome: 'belt_fixed', outcome_note: `Belt changed by text from ${was}`, updated_at: nowIso }).eq('entry_id', e.entry_id).eq('done', false).then(() => {}, () => {});
            return json({ ok: true, matched: mine.length, belt: { from, to, was, day: nd.day_id, moved: nd.day_id !== d.day_id }, ...r });
          }
        }
        // A reply that talks about a belt but couldn't be read as a correction ("Grace completed her green belt grading on
        // September 22", "Is this the right belt?"): text the admin a belt check instead of leaving it as an ordinary call
        if (!claim && !yes && !isNotGrading(msg) && !/[\u201c"][^\u201d"]*(train-ama\.com|invited to grade|invitation to grade)/i.test(msg) && mentionsBelt(msg, ladderOf((d || open.find(x => x.day_id === mine[0].day_id) || {}).programme))) {
          const nowIso = new Date().toISOString(), who = e ? [e] : mine, gm = byKey[who[0].member_key];
          for (const x of who) await db.from('cb_entries').update({ reply_text: msg.slice(0, 300), reply_at: nowIso, seq_paused_until: new Date(Date.now() + 2 * 864e5).toISOString() }).eq('entry_id', x.entry_id);
          const have = who.map(x => (who.length > 1 ? firstWord(x.full_name) + ' ' : '') + x.belt_from + ' to ' + x.belt_to).join('; ');
          await askAdmin({ kind: 'unclear', ...(e ? { entry: e } : { entries: mine }), text: ref => `Belt check #${ref}: ${firstWord((gm && gm.guardian_name) || 'A family')}${e ? ' for ' + firstWord(e.full_name) : ''} said "${msg.slice(0, 120)}" (we have ${have}). Reply "${ref} ${e ? '' : firstWord(mine[0].full_name) + ' '}green to blue" to change it, "${ref} concord" to move schools, or "${ref} ignore".` });
          return json({ ok: true, matched: mine.length, belt: 'asked admin (unclear)' });
        }
      }

      // ---- "I normally grade at Sylvania": move them to that school's grading for their belt and age, and text the booking link ----
      if (!stopping && !isNotGrading(msg)) {
        const e = whichKid(), d = e && open.find(x => x.day_id === e.day_id), to = d && schoolClaim(msg, d.location);
        if (e && d && to) {
          const m = byKey[e.member_key], age = ageNow(m);
          const nd = offerable.filter(x => x.location === to && x.day_id !== d.day_id && fitsDay(x, e, age, d))
            .sort((a, b) => String(a.grading_date).localeCompare(String(b.grading_date)) || String(a.start_time || '').localeCompare(String(b.start_time || '')))[0] || null;
          const { data: clash } = nd ? await db.from('cb_entries').select('entry_id').eq('day_id', nd.day_id).eq('member_key', e.member_key).maybeSingle() : { data: null };
          if (nd && !clash) {
            const nowIso = new Date().toISOString();
            await db.from('cb_entries').update({ day_id: nd.day_id, moved_from_day: d.day_id, yes_at: e.yes_at || nowIso, reply_text: msg.slice(0, 300), reply_at: nowIso, seq_paused_until: null, alt_offer: null }).eq('entry_id', e.entry_id);
            await db.from('cb_calls').update({ done: true, outcome: 'moved', outcome_note: 'Moved to ' + to + ' by text', updated_at: nowIso }).eq('entry_id', e.entry_id).eq('done', false).then(() => {}, () => {});
            const moved = { ...e, day_id: nd.day_id }, tm = (et => et ? ' at ' + clock(et) : '')(entryTime(nd, moved));
            const self = selfOf(m), greet = self ? firstWord(m.full_name || e.full_name) : (firstWord(m.guardian_name) || 'there'), who = self ? 'you' : firstWord(m.full_name || e.full_name);
            const text = `Thanks ${greet}! We've moved ${who} to grade for ${e.belt_to} at AMA ${whereOf(moved, nd)} on ${longDay(nd.grading_date)}${tm}. Book here: ${SITE}b#${e.token} AMA ${whereOf(moved, nd)}`;
            const r = await familyText(m, moved, text, 'not_booked', 'automatic: moved school by reply', `${firstWord(m.full_name || e.full_name)}'s grading at AMA ${whereOf(moved, nd)}`);
            return json({ ok: true, matched: mine.length, school: { to, day: nd.day_id }, ...r });
          }
        }
      }

      // ---- "We don't want to grade" / "Not grading this time": a call for admins on the hub, and the booking messages stop ----
      if (!stopping && !yes && isNotGrading(msg)) {
        const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const saidNo = mine.filter(x => new RegExp('\\b(no|not)\\s+(for\\s+)?' + esc(firstWord(x.full_name).toLowerCase()) + '\\b').test(msg.toLowerCase()));
        const e = saidNo.length ? null : whichKid(), list = saidNo.length ? saidNo : e ? [e] : mine, nowIso = new Date().toISOString();
        for (const x of list) {
          await db.from('cb_entries').update({ reply_text: msg.slice(0, 300), reply_at: nowIso, seq_paused_until: new Date(Date.now() + 14 * 864e5).toISOString() }).eq('entry_id', x.entry_id);   // opting out of grading — NOT a "can't make the date", so not on the Can't-make list
          await callFor(x, 'not_grading', msg, true);
        }
        return json({ ok: true, matched: mine.length, not_grading: list.length });
      }

      const no = !yes && isNo(msg);
      // The booking sequence (coloured-belts-23.sql): STOP ends it for good; any other reply pauses it for 2 days, and
      // anything that isn't a YES puts a "concern" call on My Day so an instructor rings them back.
      if (st.seq_on || /^\s*(stop|stopall|unsubscribe|end|quit)\b/i.test(msg)) {
        const nowIso = new Date().toISOString();
        if (/^\s*(stop|stopall|unsubscribe|end|quit)\b/i.test(msg)) {
          for (const e of mine) await db.from('cb_entries').update({ seq_stopped_at: nowIso, seq_stopped_why: 'Replied STOP', reply_text: msg.slice(0, 300), reply_at: nowIso }).eq('entry_id', e.entry_id);
          // "STOP - they've stopped attending": no more texts, and an admin follows it up on the hub
          if (isNotGrading(msg.replace(/^\s*(stop|stopall|unsubscribe|end|quit)\b[\s\-:,.!]*/i, ''))) for (const e of mine) await callFor(e, 'not_grading', msg, true);
          return json({ ok: true, matched: mine.length, stopped: true });
        }
        for (const e of mine) await db.from('cb_entries').update({ seq_paused_until: new Date(Date.now() + 2 * 864e5).toISOString() }).eq('entry_id', e.entry_id);
        if (!yes) for (const e of mine) {
          const { data: open } = await db.from('cb_calls').select('call_id').eq('entry_id', e.entry_id).eq('done', false);
          // "Could I please have a phone call with a staff member?": a call for an admin, at the top of the hub's list
          const ask = wantsCall(msg);
          if (!(open || []).length) await db.from('cb_calls').insert({ entry_id: e.entry_id, reason: 'concern', note: ((ask ? 'Asked for a call: ' : '') + msg).slice(0, 300), callback_on: today, for_admin: ask });
          else if (ask) await db.from('cb_calls').update({ for_admin: true, note: ('Asked for a call: ' + msg).slice(0, 300), callback_on: today, updated_at: new Date().toISOString() }).eq('entry_id', e.entry_id).eq('done', false);
        }
      }
      // ---- "No" or "can't make it": offer the other gradings that suit every student in the family (belt and age) ----
      if (no) {
        const now = new Date().toISOString();
        // Can't make this grading's date (away / "can't make any of those") but still wants to grade: on the Can't-make list and offered other dates
        for (const e of mine) await db.from('cb_entries').update({ reply_text: msg.slice(0, 300), reply_at: now, cant_make_at: now, cant_make_reason: 'cant_make_date' }).eq('entry_id', e.entry_id);
        // Already offered these alternative gradings and still waiting on a pick? A further "no / can't
        // make it" reply is them declining the offer - record it and pause, don't send the same offer again.
        if (mine.some(e => e.alt_offer && Array.isArray(e.alt_offer.days) && e.alt_offer.at && (Date.now() - Date.parse(e.alt_offer.at) < ALT_VALID_MS))) {
          for (const e of mine) await db.from('cb_entries').update({ seq_paused_until: new Date(Date.now() + 14 * 864e5).toISOString(), cant_make_at: now, cant_make_reason: 'declined_offer' }).eq('entry_id', e.entry_id);
          // None of the other days work either: a person needs to sort it out, so it goes to the top of the admin call list
          for (const e of mine) await callFor(e, 'concern', "Can't make the other days offered: " + msg, true);
          return json({ ok: true, matched: mine.length, no: true, offered: 0, alreadyOffered: true });
        }
        // Each child's own options across EVERY location (belt + age), nearest date first, up to ALT_DAYS
        const optsFor = e => offerable.filter(d => fitsDay(d, e, ageNow(byKey[e.member_key]), open.find(x => x.day_id === e.day_id)))
          .sort((a, b) => String(a.grading_date).localeCompare(String(b.grading_date)) || String(a.start_time || '').localeCompare(String(b.start_time || ''))).slice(0, ALT_DAYS);
        const kidOpts = mine.map(e => ({ e, days: optsFor(e) })).filter(k => k.days.length);
        if (!kidOpts.length) return json({ ok: true, matched: mine.length, yes: false, no: true, offered: 0 });
        const m0 = byKey[mine[0].member_key], greet = (selfOf(m0) && kidOpts.length === 1 ? firstWord(m0.full_name || kidOpts[0].e.full_name) : firstWord(m0 && m0.guardian_name)) || 'there';
        const keyOf = k => k.days.map(d => d.day_id).join('|');
        const shared = kidOpts.length > 1 && kidOpts.every(k => keyOf(k) === keyOf(kidOpts[0]));
        const split = !(kidOpts.length === 1 || shared);
        let text;
        if (!split) {   // one kid, or every kid shares the same options: a single numbered list
          const days = kidOpts[0].days, e0 = kidOpts[0].e;
          const who = kidOpts.length === 1 ? (selfOf(m0) ? 'You' : firstWord(e0.full_name)) : [...new Set(kidOpts.map(k => firstWord(k.e.full_name)))].join(' and ');
          const nums = days.length === 1 ? 'Reply 1' : `Reply ${days.slice(0, -1).map((_, i) => i + 1).join(', ')} or ${days.length}`;
          // 0 keeps the date they were invited to (one shared original day only, so it's clear which)
          const origIds = [...new Set(kidOpts.map(k => k.e.day_id))], od = origIds.length === 1 ? open.find(x => x.day_id === origIds[0]) : null;
          const keep = od ? `\nOr reply 0 to keep the original date (${dayLine(od, e0)}).` : '';
          text = `Hi ${greet}, no worries. ${who} can grade on another day instead:\n${days.map((d, i) => `${i + 1}. ${dayLine(d, e0)}`).join('\n')}\n${nums} to switch and we'll send the booking link.${keep} Or call us if none suit. AMA`;
        } else {   // kids suit different days: list each child's own options, reply with name + number
          const blocks = kidOpts.map(k => { const od = open.find(x => x.day_id === k.e.day_id); return `${firstWord(k.e.full_name)} can grade:\n${k.days.map((d, i) => `${i + 1}. ${dayLine(d, k.e)}`).join('\n')}${od ? `\n0. Keep the original date (${dayLine(od, k.e)})` : ''}`; }).join('\n\n');
          const eg = kidOpts[1] ? `e.g. "${firstWord(kidOpts[0].e.full_name)} 1, ${firstWord(kidOpts[1].e.full_name)} 2"` : `e.g. "${firstWord(kidOpts[0].e.full_name)} 1"`;
          text = `Hi ${greet}, no worries - here are the days that suit each of them:\n\n${blocks}\n\nReply with the name and number (${eg}) and we'll send the booking links, or call us if none suit. AMA`;
        }
        const r = await familyText(m0, kidOpts[0].e, text, 'alt_offer', 'automatic: offered another grading' + (split ? ' (per child)' : ''), `Another grading day for your family`);
        if (r.ok) {
          for (const k of kidOpts) await db.from('cb_entries').update({ alt_offer: { days: k.days.map(d => d.day_id), at: now, split } }).eq('entry_id', k.e.entry_id);
          await db.from('cb_calls').update({ note: (msg.slice(0, 220) + ' [Offered other gradings by text]') }).in('entry_id', mine.map(e => e.entry_id)).eq('done', false).then(() => {}, () => {});
        }
        return json({ ok: true, matched: mine.length, yes: false, no: true, offered: r.ok ? kidOpts.length : 0, split });
      }
      if (!yes) { for (const e of mine) await db.from('cb_entries').update({ reply_text: msg.slice(0, 300), reply_at: new Date().toISOString() }).eq('entry_id', e.entry_id); return json({ ok: true, matched: mine.length, yes: false }); }
      const ready = !!(env.GHL_TOKEN && env.GHL_LOCATION_ID), testing = env.GHL_TEST === '1';
      const out = [];
      for (const e of mine) {
        const now = new Date().toISOString(), had = e.yes_at;
        await db.from('cb_entries').update({ yes_at: had || now, reply_text: msg.slice(0, 300), reply_at: now }).eq('entry_id', e.entry_id);
        if (had || e.booked_at || e.paid) { out.push({ entry_id: e.entry_id, already: true }); continue; }   // the link went the first time they said yes, or they've already booked/paid — don't resend it
        let skip = null; try { ({ data: skip } = await db.from('cb_skip').select('reason, until').eq('member_key', e.member_key).maybeSingle()); } catch (_) { /* no skip list */ }
        if (skip && (!skip.until || String(skip.until) >= today)) { out.push({ entry_id: e.entry_id, skipped: true }); continue; }
        const m = byKey[e.member_key], d = open.find(x => x.day_id === e.day_id);
        const text = famFill(st.not_booked_text, m, { parent: firstWord(m.guardian_name) || 'there', first: firstWord(m.full_name || e.full_name), next: e.belt_to,
          school: whereOf(e, d), date: longDay(d.grading_date), time: (et => et ? ' at ' + clock(et) : '')(entryTime(d, e)), link: SITE + 'b#' + e.token });
        const phone = phoneE164(m.phone || m.guardian_phone);
        const log = (status, extra = {}) => db.from('cb_messages').insert({ entry_id: e.entry_id, member_key: e.member_key, kind: 'not_booked', phone, body: text, status, sent_by: 'automatic: replied YES', ...extra });
        if (testing && !ready) { await log('test'); out.push({ entry_id: e.entry_id, ok: true, test: true }); continue; }
        if (!ready) { out.push({ entry_id: e.entry_id, error: 'texting not set up' }); continue; }
        if (viaEmail) {   // they said YES by email: send the booking link back by email, the same channel they used
          const email = goodEmail(m) || (okBodyEmail ? bodyEmail : null);
          if (email) {
            const elog = (status, extra = {}) => db.from('cb_messages').insert({ entry_id: e.entry_id, member_key: e.member_key, kind: 'not_booked', email, body: text, status, sent_by: 'automatic: replied YES (email reply)', ...extra });
            try { const cid = await contactFor({ ...m, email }, phone); await sendEmailTo(cid, buildSeqEmail(`${firstWord(m.full_name || e.full_name)}'s grading booking link`, text)); await elog('sent'); out.push({ entry_id: e.entry_id, ok: true, emailed: true }); }
            catch (er) { const w = String(er.message || er).slice(0, 500); await elog('failed', { error: w }); out.push({ entry_id: e.entry_id, error: w }); }
            continue;
          }
        }
        if (smsBlocked(st)) {   // texting is stopped (GoHighLevel's daily limit): email the booking link now AND queue the text to go by SMS once texting works again
          const b = await emailBackup({ m, entry_id: e.entry_id, subject: `${firstWord(m.full_name || e.full_name)}'s grading booking link`, text, why: 'texting paused' });
          await db.from('cb_outbox').insert({ entry_id: e.entry_id, kind: 'send_link' });
          out.push({ entry_id: e.entry_id, ok: b.ok, emailed: b.ok, queued: true }); continue;
        }
        try {
          const cid = await contactFor({ ...m, email: m.email || m.guardian_email }, phone);
          const gid = await sendSms(cid, text);
          await log('sent', gid ? { ghl_id: gid } : {}); out.push({ entry_id: e.entry_id, ok: true });
        } catch (er) { const msg2 = String(er.message || er).slice(0, 500); await log('failed', { error: msg2 }); out.push({ entry_id: e.entry_id, error: msg2 }); }
      }
      // They said YES but also asked something (a question mark, or asked for a call): text the admin so a
      // person can answer, with the option to reply "<ref> call" and drop them onto the team's call list.
      if (/\?/.test(msg) || wantsCall(msg)) {
        const who = byKey[mine[0].member_key] || {};
        const fam = firstWord(who.guardian_name || who.full_name) || 'A family';
        const kids = [...new Set(mine.map(e => firstWord(e.full_name)))].join(' and ');
        await askAdmin({ kind: 'question', entries: mine, text: ref => `#${ref} ${fam} (${kids}) replied yes but also asked: "${String(msg).slice(0, 160)}". Reply "${ref} call" to put them on the call list, "${ref} concord" to move schools, or "${ref} ignore".` });
      }
      return json({ ok: true, matched: mine.length, yes: true, results: out });
    }

    // ---- Staff ----
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = token ? await db.auth.getUser(token) : { data: null };
    const me = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
    if (!me) return fail('Sign in first.', 401);
    const { data: permRows } = await db.from('app_permissions').select('perm').eq('email', me).eq('app', 'cb');
    const perms = (permRows || []).map(r => r.perm);
    const can = (...want) => perms.includes('admin') || want.some(w => perms.includes(w));
    const may = kind => can(...(KINDS[kind] || []));
    if (!perms.length) return fail('Your login cannot use Coloured Belts. Ask a Staff admin to give you access.', 403);
    // Staff: send a test belt-check alert to the alert phone, so they can check they get it and can reply
    if (body.action === 'alert_test') {
      const { data: s2 } = await db.from('cb_settings').select('alert_phone').eq('id', 1).maybeSingle();
      if (!s2 || !s2.alert_phone) return json({ ok: false, error: 'No alert phone is set.' });
      if (!(env.GHL_TOKEN && env.GHL_LOCATION_ID)) return json({ ok: false, error: 'Texting is not set up.' });
      const { data: top } = await db.from('cb_admin_q').select('ref').is('resolved_at', null).order('ref', { ascending: false }).limit(1);
      const ref = ((top && top[0] && top[0].ref) || 0) + 1;
      await db.from('cb_admin_q').insert({ ref, kind: 'test', body: 'Test sent by ' + me });
      const text = `Belt check #${ref} (TEST): this is how belt questions will reach you. Reply "${ref} ignore" to test the reply, or "${ref} green to blue" to see it read the belt. Nothing real changes.`;
      try {
        const cid = await contactFor({ guardian_name: 'AMA grading', full_name: 'AMA grading' }, phoneE164(s2.alert_phone));
        if (!cid) throw new Error('Could not create the contact for the alert number');
        const gid = await sendSms(cid, text);
        return json({ ok: true, sent: true, ref, to: s2.alert_phone, ghl_id: gid || null });
      } catch (er) { return json({ ok: false, error: String(er.message || er).slice(0, 300), ref }); }
    }
    // A payment taken by staff (cash, EFTPOS, bank transfer): mark paid, then book the EFC session like a card payment would
    if (body.action === 'note') {
      if (!can('readiness', 'days', 'payments', 'texts', 'text_invite', 'text_result', 'text_followup', 'calls', 'set_general', 'set_fees', 'set_wording')) return fail('Your login cannot add notes.', 403);
      const phone = phoneE164(String(body.phone || ''));
      const text = String(body.body || body.note || '').trim();
      if (!phone && !body.email) return fail('Need a phone or email to find the contact.');
      if (!text) return fail('Need the note text.');
      let cid = null;
      try { cid = await contactFor({ guardian_name: body.name || '', full_name: body.name || '', email: body.email || null }, phone); } catch (e) { return fail('GoHighLevel: ' + String(e && e.message || e).slice(0, 200), 502); }
      if (!cid) return fail('Could not find or add the GoHighLevel contact.', 404);
      try { await addNote(cid, text); } catch (e) { return fail('GoHighLevel: ' + String(e && e.message || e).slice(0, 200), 502); }
      return json({ ok: true, contactId: cid });
    }
    if (body.action === 'record_payment') {
      if (!can('payments')) return fail('Your login cannot record payments.', 403);
      const how = String(body.how || '');
      // 'credit' = they already have a credit (e.g. paid last time but missed it): mark paid and book them, but don't send a payment-received text/email.
      if (!['cash', 'eftpos', 'transfer', 'other', 'credit'].includes(how)) return fail('Choose how they paid.');
      const { data: e } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, booked_at, booking_error, result, paid, paid_how, late_ok_until, school, discount, discount_kind, discount_reason').eq('entry_id', String(body.entry_id || '')).maybeSingle();
      if (!e) return fail('Student not found on this grading day.', 404);
      if (e.paid) return json({ ok: true, already: true, booked: !!e.booked_at });
      e.paid = true; e.paid_how = how;
      await db.from('cb_entries').update({ paid: true, paid_at: new Date().toISOString(), paid_how: how }).eq('entry_id', e.entry_id);
      let b = { ok: !!e.booked_at };
      const { data: d } = await db.from('cb_days').select('day_id, location, grading_date, start_time, efc_session_id, efc_sessions, efc_belt_sessions, efc_school_belt_sessions, belt_times, closed, programme, book_by, bb').eq('day_id', e.day_id).maybeSingle();
      if (d && !e.booked_at) b = await bookEntry(e, d);
      if (d && how !== 'credit') { const bf = await feeFor(e, d); await confirmEmail(e, d, 'email_paid', { amount: bf == null ? null : Math.max(0, bf - discountOn(e, bf)) }); }
      if (d && how !== 'credit') await confirmSms(e, d, 'sms_paid');
      return json({ ok: true, booked: !!b.ok, byHand: !!b.byHand, booking_error: b.ok ? null : (b.why || null) });
    }

    // ---- Grading helpers admin (staff) ----
    // List upcoming grading days with their helper settings + who's signed up
    if (body.action === 'helper_admin_days') {
      if (!can('days', 'settings')) return fail('Your login cannot manage grading helpers.', 403);
      const today = new Date().toISOString().slice(0, 10);
      const { data: days } = await db.from('cb_days').select('day_id, grading_date, start_time, location, bb, programme, belts, closed, helper_open, helper_cap, helper_audience').gte('grading_date', today).order('grading_date');
      const ids = (days || []).map(d => d.day_id), byDay = {};
      const detail = {};
      if (ids.length) { const { data: su } = await db.from('cb_helper_signups').select('day_id, helper_id, cb_helpers(full_name)').in('day_id', ids); for (const r of (su || [])) { const nm = (r.cb_helpers && r.cb_helpers.full_name) || ''; (byDay[r.day_id] = byDay[r.day_id] || []).push(nm); (detail[r.day_id] = detail[r.day_id] || []).push({ helper_id: r.helper_id, name: nm }); } }
      return json({ ok: true, days: (days || []).map(d => ({ ...d, helpers: (byDay[d.day_id] || []).filter(Boolean).sort(), helper_list: (detail[d.day_id] || []).filter(x => x.name).sort((a, b) => a.name.localeCompare(b.name)) })) });
    }
    // Staff add (or take off) a helper on a grading day by hand. { day_id, on, helper_id } or { day_id, student_id } or { day_id, name }
    // A black belt from the list keeps their usual helper record; anyone else gets a record by name only (no sign-up link).
    // Staff aren't held to the cap.
    if (body.action === 'helper_admin_assign') {
      if (!can('days', 'settings')) return fail('Your login cannot manage grading helpers.', 403);
      const dayId = String(body.day_id || '');
      const { data: d } = await db.from('cb_days').select('day_id').eq('day_id', dayId).maybeSingle();
      if (!d) return fail('That grading day was not found.', 404);
      if (body.on === false) {
        await db.from('cb_helper_signups').delete().eq('day_id', dayId).eq('helper_id', String(body.helper_id || ''));
        return json({ ok: true });
      }
      let helperId = null, member_key = '', full_name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80), efc_ref = null;
      if (body.student_id) {
        const { data: p } = await db.from('prep_students').select('full_name, efc_ref').eq('student_id', String(body.student_id)).maybeSingle();
        if (p) { full_name = p.full_name; efc_ref = p.efc_ref; if (p.efc_ref) { const { data: m } = await db.from('efc_members').select('member_key').eq('efc_reference', p.efc_ref).maybeSingle(); if (m) member_key = m.member_key; } }
      }
      if (!full_name) return fail('Type their name.');
      if (!member_key) member_key = 'manual:' + full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const { data: h } = await db.from('cb_helpers').select('helper_id').eq('member_key', member_key).maybeSingle();
      if (h) helperId = h.helper_id;
      else {
        const { data: made, error: me1 } = await db.from('cb_helpers').insert({ member_key, efc_ref, full_name, token: essayToken(), active: false }).select('helper_id').single();
        if (me1) return fail(me1.message);
        helperId = made.helper_id;
      }
      const { error: e2 } = await db.from('cb_helper_signups').upsert({ helper_id: helperId, day_id: dayId }, { onConflict: 'helper_id,day_id', ignoreDuplicates: true });
      if (e2) return fail(e2.message);
      return json({ ok: true, helper_id: helperId, name: full_name });
    }

    // Open/close a day for helpers, set the cap and the audience band
    if (body.action === 'helper_admin_day_set') {
      if (!can('days', 'settings')) return fail('Not allowed.', 403);
      const patch = {};
      if (body.open !== undefined) patch.helper_open = !!body.open;
      if (body.cap !== undefined) { const c = parseInt(body.cap, 10); if (Number.isFinite(c) && c >= 0 && c <= 50) patch.helper_cap = c; }
      if (body.audience !== undefined) patch.helper_audience = ['kids', '13+', 'all'].includes(body.audience) ? body.audience : null;
      if (!Object.keys(patch).length) return json({ ok: true });
      await db.from('cb_days').update(patch).eq('day_id', String(body.day_id || ''));
      return json({ ok: true });
    }
    // The black belt roster to invite from, with each one's invite state + personal link
    if (body.action === 'helper_roster') {
      if (!can('days', 'settings')) return fail('Not allowed.', 403);
      const { data: ps } = await db.from('prep_students').select('student_id, full_name, efc_ref, belt_rank').eq('is_active', true).eq('is_test', false).order('full_name');
      const refs = [...new Set((ps || []).map(p => p.efc_ref).filter(Boolean))], memByRef = {};
      if (refs.length) { const { data: mem } = await db.from('efc_members').select('member_key, efc_reference, date_of_birth').in('efc_reference', refs); for (const m of (mem || [])) memByRef[m.efc_reference] = m; }
      let { data: helpers, error: hErr } = await db.from('cb_helpers').select('member_key, token, active, sent_at, little_dragons');
      if (hErr) ({ data: helpers } = await db.from('cb_helpers').select('member_key, token, active'));   // before cb-helpers-send.sql
      const hByKey = {};
      for (const h of (helpers || [])) hByKey[h.member_key] = h;
      const list = (ps || []).map(p => { const m = memByRef[p.efc_ref], key = m && m.member_key, h = key && hByKey[key];
        const age = (m && typeof m.date_of_birth === 'string' && /^\d{4}-\d{2}-\d{2}/.test(m.date_of_birth)) ? Math.floor((Date.now() - Date.parse(m.date_of_birth.slice(0, 10))) / 31557600000) : null;
        return { student_id: p.student_id, full_name: p.full_name, belt_rank: p.belt_rank, efc_ref: p.efc_ref, member_key: key || null, age, invited: !!(h && h.active), link: h && h.active ? SITE + 'grading/helpers/#' + h.token : null, sent_at: (h && h.sent_at) || null, little_dragons: !!(h && h.little_dragons) };
      });
      return json({ ok: true, helpers: list });
    }
    // Invite (or un-invite) a black belt: makes/activates their personal helper link
    if (body.action === 'helper_invite') {
      if (!can('days', 'settings')) return fail('Not allowed.', 403);
      let member_key = String(body.member_key || '').trim(), full_name = '', efc_ref = String(body.efc_ref || '').trim() || null;
      if (!member_key && body.student_id) {
        const { data: p } = await db.from('prep_students').select('full_name, efc_ref').eq('student_id', String(body.student_id)).maybeSingle();
        if (p) { efc_ref = efc_ref || p.efc_ref; full_name = p.full_name; if (p.efc_ref) { const { data: m } = await db.from('efc_members').select('member_key, full_name').eq('efc_reference', p.efc_ref).maybeSingle(); if (m) { member_key = m.member_key; full_name = full_name || m.full_name; } } }
      }
      if (!member_key) return fail("Could not find this black belt's member record.", 404);
      const on = body.on !== false;
      const { data: existing } = await db.from('cb_helpers').select('helper_id, token, active').eq('member_key', member_key).maybeSingle();
      if (!on) { if (existing) await db.from('cb_helpers').update({ active: false }).eq('helper_id', existing.helper_id); return json({ ok: true, active: false }); }
      let tok;
      if (existing) { tok = existing.token; const patch = { active: true }; if (!existing.active) patch.invited_at = new Date().toISOString(); await db.from('cb_helpers').update(patch).eq('helper_id', existing.helper_id); }
      else { tok = essayToken(); await db.from('cb_helpers').insert({ member_key, efc_ref, full_name: full_name || 'Helper', token: tok, active: true, invited_at: new Date().toISOString() }); }
      return json({ ok: true, active: true, link: SITE + 'grading/helpers/#' + tok });
    }

    // Let an invited helper see Little Dragons gradings (hidden from everyone else). { student_id, on }
    if (body.action === 'helper_ld') {
      if (!can('days', 'settings')) return fail('Not allowed.', 403);
      const { data: p } = await db.from('prep_students').select('efc_ref').eq('student_id', String(body.student_id || '')).maybeSingle();
      const { data: m } = p && p.efc_ref ? await db.from('efc_members').select('member_key').eq('efc_reference', p.efc_ref).maybeSingle() : { data: null };
      if (!m) return fail("Could not find this black belt's member record.", 404);
      const { error: e1 } = await db.from('cb_helpers').update({ little_dragons: body.on === true }).eq('member_key', m.member_key);
      if (e1) return fail(e1.message);
      return json({ ok: true, little_dragons: body.on === true });
    }

    // Text and email an invited helper their sign-up link. { student_id, preview: true } returns the exact messages without sending.
    if (body.action === 'helper_send') {
      if (!can('days', 'settings')) return fail('Not allowed.', 403);
      const { data: p } = await db.from('prep_students').select('full_name, efc_ref').eq('student_id', String(body.student_id || '')).maybeSingle();
      const { data: m } = p && p.efc_ref ? await db.from('efc_members').select('member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email, date_of_birth').eq('efc_reference', p.efc_ref).maybeSingle() : { data: null };
      if (!m) return fail("Could not find this black belt's member record.", 404);
      const { data: h } = await db.from('cb_helpers').select('helper_id, token, active').eq('member_key', m.member_key).maybeSingle();
      if (!h || !h.active) return fail('Invite them first (turn them on), then send.', 409);
      const dob = String(m.date_of_birth || ''), age = /^\d{4}-\d{2}-\d{2}/.test(dob) ? Math.floor((Date.now() - Date.parse(dob.slice(0, 10))) / 31557600000) : null;
      const kid = age != null && age < 18 && !!(m.guardian_name || m.guardian_phone || m.guardian_email);
      const okE = v => v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
      const phone = kid ? phoneE164(m.guardian_phone || m.phone) : phoneE164(m.phone || m.guardian_phone);
      const email = kid ? (okE(m.guardian_email) || okE(m.email)) : (okE(m.email) || okE(m.guardian_email));
      const { data: cs } = await db.from('cb_settings').select('contact_phone').eq('id', 1).maybeSingle();
      const msg = buildHelperInvite({ first: first(m.full_name || p.full_name), parent: kid ? (first(m.guardian_name) || 'there') : null, link: SITE + 'grading/helpers/#' + h.token,
        phone: (cs && cs.contact_phone) || '(02) 9569 1943' });   // no list of gradings in the email: their link shows them
      const to = { phone, email, parent: kid };
      if (body.preview) return json({ ok: true, preview: true, to, sms: msg.sms, subject: msg.subject, html: msg.html });
      if (!phone && !email) return fail('There is no mobile or email for them in EFC.', 409);
      if (!(env.GHL_TOKEN && env.GHL_LOCATION_ID)) return fail('Texting is not set up (GHL_TOKEN, GHL_LOCATION_ID).', 409);
      const out = { sms: null, email: null };
      const log = (kind, status, extra = {}) => db.from('cb_messages').insert({ entry_id: null, member_key: m.member_key, kind: 'helper_invite', phone: kind === 'sms' ? phone : null, email: kind === 'email' ? email : null,
        body: kind === 'sms' ? msg.sms : msg.subject + '\n\n' + msg.text, status, sent_by: me || 'staff', ...extra }).then(() => {}, () => {});
      let cid = null;
      try { cid = await contactFor({ guardian_name: kid ? m.guardian_name : m.full_name, full_name: m.full_name, email }, phone); } catch (er) { return fail('Could not find or add them in GoHighLevel: ' + String(er.message || er)); }
      if (!cid) return fail('Could not find or add them in GoHighLevel.');
      if (phone) { try { const gid = await sendSms(cid, msg.sms); out.sms = 'sent'; await log('sms', 'sent', { ghl_id: gid }); } catch (er) { out.sms = String(er.message || er).slice(0, 300); await log('sms', 'failed', { error: out.sms }); } }
      else out.sms = 'no mobile';
      if (email) { try { await sendEmailTo(cid, { subject: msg.subject, html: msg.html, text: msg.text }); out.email = 'sent'; await log('email', 'sent'); } catch (er) { out.email = String(er.message || er).slice(0, 300); await log('email', 'failed', { error: out.email }); } }
      else out.email = 'no email';
      const sentAt = new Date().toISOString();
      if (out.sms === 'sent' || out.email === 'sent') await db.from('cb_helpers').update({ sent_at: sentAt }).eq('helper_id', h.helper_id).then(() => {}, () => {});
      return json({ ok: out.sms === 'sent' || out.email === 'sent', ...out, to, sent_at: sentAt });
    }

    // Staff: set or clear a dollar discount on a student's grading fee. It shows as its own "Discount" line
    // on the Stripe checkout page (and comes off any staff-recorded payment). amount 0 clears it.
    if (body.action === 'set_discount') {
      if (!can('payments', 'set_fees')) return fail('Your login cannot change fees.', 403);
      const { data: e } = await db.from('cb_entries').select('entry_id, day_id, full_name, belt_from, belt_to, paid, discount, discount_kind, discount_reason, discount_note').eq('entry_id', String(body.entry_id || '')).maybeSingle();
      if (!e) return fail('Student not found on this grading day.', 404);
      if (e.paid) return fail('This grading is already paid, so the discount can’t change now.', 409);
      const kind = body.kind === 'percent' ? 'percent' : 'amount';
      let amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0) return fail(kind === 'percent' ? 'Enter a percentage off (0 to clear the discount).' : 'Enter a dollar amount off (0 to clear the discount).');
      amount = Math.round(amount * 100) / 100;
      const { data: d } = await db.from('cb_days').select('day_id, programme, bb').eq('day_id', e.day_id).maybeSingle();
      const baseFee = await feeFor(e, d);
      if (baseFee == null) return fail('This grading has no fee set, so there’s nothing to discount.', 409);
      if (kind === 'percent') { if (amount > 100) return fail('A percentage discount can’t be over 100%.'); }
      else if (amount > baseFee) return fail(`The discount can’t be more than the $${baseFee} fee.`);
      const reason = String(body.reason || '').trim().slice(0, 80) || null;
      const note = String(body.note || '').trim().slice(0, 300) || null;
      await db.from('cb_entries').update({ discount: amount, discount_kind: kind, discount_reason: amount > 0 ? reason : null, discount_note: amount > 0 ? note : null }).eq('entry_id', e.entry_id);
      const off = amount <= 0 ? 0 : kind === 'percent' ? Math.min(baseFee, Math.round(baseFee * Math.min(amount, 100)) / 100) : Math.min(amount, baseFee);
      return json({ ok: true, entry_id: e.entry_id, fee_full: baseFee, discount: amount, discount_kind: kind, discount_reason: amount > 0 ? reason : null, discount_note: amount > 0 ? note : null, off, net: Math.max(0, baseFee - off) });
    }
    // The booking sequence: "Send test to me" for any step (grading staff), with a real student's details or a sample
    if (body.action === 'seq_test') {
      if (!can('settings', 'texts')) return fail('Your login cannot send test messages.', 403);
      const { data: step } = await db.from('cb_seq_steps').select('*').eq('code', String(body.code || '')).maybeSingle();
      if (!step || step.channel === 'call') return fail('Choose a message to test.');
      const toPhone = String(body.phone || '').trim(), toEmail = String(body.email || '').trim();
      if (step.channel === 'sms' && !phoneE164(toPhone)) return fail('Enter your mobile to get the test text.');
      if (step.channel === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) return fail('Enter your email to get the test email.');
      const { data: st } = await db.from('cb_settings').select('*').eq('id', 1).maybeSingle();
      let e = null, d = null, m = null;
      if (body.entry_id) {
        ({ data: e } = await db.from('cb_entries').select(ENT_COLS).eq('entry_id', String(body.entry_id)).maybeSingle());
        if (e) { ({ data: d } = await db.from('cb_days').select(DAY_COLS).eq('day_id', e.day_id).maybeSingle()); m = (await membersFor([e.member_key]))[e.member_key]; }
      }
      if (!e || !d || !m) {   // a sample family
        e = { entry_id: null, member_key: 'sample', full_name: 'Sam Sample', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: 'SAMPLE-LINK' };
        d = { location: 'Concord', grading_date: '2026-12-01', start_time: '16:00', programme: 'Taekwondo', belt_times: {} };
        m = { full_name: 'Sam Sample', guardian_name: 'Alex Sample', date_of_birth: '2016-05-01' };
      }
      const fee = e.member_key === 'sample' ? 55 : await feeFor(e, d);
      const r = await seqSend({ step, e, d, m, st: st || {}, fee, prepTime: '9:00am', to: { phone: toPhone, email: toEmail, by: me, name: 'AMA test' } });
      return json({ ok: r.status === 'sent' || r.status === 'test', ...r });
    }
    // Run the sequence now (admins), instead of waiting for the next 15-minute run
    if (body.action === 'seq_run') {
      if (!can('settings')) return fail('Only staff with Booking sequence and settings can run the sequence by hand.', 403);
      return json(await runSequence());
    }
    const ready = !!(env.GHL_TOKEN && env.GHL_LOCATION_ID), testing = env.GHL_TEST === '1';
    if (body.action === 'check') return json({ ready: ready || testing, testing });
    if (body.action !== 'send') return fail('Unknown action.');
    const kind = String(body.kind || '');
    if (!KINDS[kind]) return fail('Unknown kind of message.');
    if (!may(kind)) return fail('Your login cannot send this kind of message.', 403);
    if (!ready && !testing) return fail('Texting is not set up yet: add GHL_TOKEN and GHL_LOCATION_ID in Supabase (Edge Functions > Secrets).', 409);
    const items = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
    if (!items.length) return fail('No one to text.');

    const results = [];
    for (const it of items) {
      const text = String(it.body || '').trim(), out = { member_key: it.member_key, entry_id: it.entry_id || null, ok: false };
      results.push(out);
      if (!text || text.length > 1000) { out.error = 'The message is empty or too long'; continue; }
      const { data: m } = await db.from('efc_members').select('member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email').eq('member_key', String(it.member_key || '')).maybeSingle();
      if (!m) { out.error = 'Student not found'; continue; }
      // Cancelled or on hold (the hub's daily skip list, coloured-belts-15.sql): never text them, even if already on a grading day
      let skip = null;
      try { ({ data: skip } = await db.from('cb_skip').select('reason, until').eq('member_key', m.member_key).maybeSingle()); } catch (_) { /* table not added yet */ }
      if (skip && (!skip.until || String(skip.until) >= new Date().toISOString().slice(0, 10))) {
        out.error = (skip.reason || 'Cancelled or on hold') + ': not texted'; out.skipped = true; continue;
      }
      const phone = phoneE164(m.phone || m.guardian_phone);
      const log = (status, extra = {}) => db.from('cb_messages').insert({ entry_id: it.entry_id || null, member_key: m.member_key, kind, phone: phone || m.phone || null, body: text, status, sent_by: me, ...extra });
      // A double click (or two staff at once) must not send the same text twice: skip it if it went to them in the last 3 minutes
      { const { data: just } = await db.from('cb_messages').select('message_id').eq('member_key', m.member_key).eq('body', text).eq('status', 'sent').gte('sent_at', new Date(Date.now() - 3 * 60e3).toISOString()).limit(1);
        if ((just || []).length) { out.ok = true; out.duplicate = true; continue; } }
      if (!phone) { out.error = 'No mobile number'; await log('failed', { error: out.error }); continue; }
      if (testing && !ready) { out.ok = true; out.test = true; await log('test'); }
      else {
        try {
          const cid = await contactFor({ ...m, email: m.email || m.guardian_email }, phone);
          if (!cid) throw new Error('Could not find or add the contact');
          await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId: cid, message: text }) }, '2021-04-15');
          out.ok = true; await log('sent');
        } catch (e) { out.error = String(e.message || e); await log('failed', { error: out.error.slice(0, 500) }); continue; }
      }
      if (kind === 'invite' && it.entry_id) await db.from('cb_entries').update({ invited_at: new Date().toISOString() }).eq('entry_id', it.entry_id);
    }

    // On invite: one grading invitation email per family (grouped by guardian), plus a note on each family's GHL contact (update 17).
    if (kind === 'invite') {
      try {
        const ids = results.filter(r => r.ok && r.entry_id).map(r => r.entry_id);
        if (ids.length) {
          const ents = await selectIn('cb_entries', 'entry_id, member_key, full_name, belt_from, belt_to, token, day_id, school', 'entry_id', ids);
          const { data: ds } = await db.from('cb_days').select('day_id, location, grading_date, start_time, belt_times, programme, bb').in('day_id', [...new Set((ents || []).map(e => e.day_id))]);
          const dayBy = Object.fromEntries((ds || []).map(d => [d.day_id, d]));
          const ms = await selectIn('efc_members', 'member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email, date_of_birth', 'member_key', (ents || []).map(e => e.member_key));
          const memBy = Object.fromEntries((ms || []).map(m => [m.member_key, m]));
          const { data: cs } = await db.from('cb_settings').select('contact_phone, email_bring').eq('id', 1).maybeSingle();
          const bring = String((cs && cs.email_bring) || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
          const prepOpen = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }) <= PREP.closes;
          const emailOf = m => [m && m.guardian_email, m && m.email].find(v => v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || null;
          const last9 = x => String(x || '').replace(/\D/g, '').slice(-9);
          const famKey = m => (m && (emailOf(m) || last9(m.guardian_phone) || last9(m.phone))) || ('m:' + (m && m.member_key));
          const ageOf = m => (m && typeof m.date_of_birth === 'string' && /^\d{4}-\d{2}-\d{2}/.test(m.date_of_birth)) ? Math.floor((Date.now() - Date.parse(m.date_of_birth.slice(0, 10))) / 31557600000) : null;
          const families = {};
          for (const e of ents || []) { const m = memBy[e.member_key], d = dayBy[e.day_id]; if (m && d) (families[famKey(m)] = families[famKey(m)] || []).push({ e, m, d }); }
          for (const members of Object.values(families)) {
            const m0 = members[0].m, d0 = members[0].d, to = members.map(x => emailOf(x.m)).find(Boolean);
            const children = members.map(({ e, d }) => ({ first: firstWord(e.full_name), beltTo: e.belt_to, beltFrom: e.belt_from,
              when: longDay(d.grading_date) + (et => et ? ' at ' + clock(et) : '')(entryTime(d, e)), where: whereOf(e, d),
              bookUrl: SITE + 'b#' + e.token, videoUrl: videoForBelt(d.programme, e.belt_from) }));
            const names = children.map(c => c.first).join(' & ');
            const mail = buildGradingInvite({ parent: firstWord(m0.guardian_name) || 'there', school: whereOf(members[0].e, d0), phone: (cs && cs.contact_phone) || '(02) 9569 1943', bring, prepOpen: prepOpen && !members.some(x => x.d.bb), prepUrl: prepUrlFor(ageOf(m0)), children });   // the Colour Belt Prep Session is for coloured belts only
            const note = `Invited to the Dec 2026 grading — SMS sent; invitation email ${to && ready ? 'sent to ' + to : to ? 'queued to ' + to : 'not sent (no email on file)'} (${names}).`;
            try {
              const cid = await contactFor({ ...m0, email: to || emailOf(m0) }, phoneE164(m0.phone || m0.guardian_phone));
              if (cid) {
                if (to && ready) { await sendEmailTo(cid, mail); await db.from('cb_messages').insert({ member_key: m0.member_key, kind: 'invite', email: to, body: mail.subject, status: 'sent', sent_by: 'automatic: invitation email' }); }
                else if (to && testing) await db.from('cb_messages').insert({ member_key: m0.member_key, kind: 'invite', email: to, body: mail.subject, status: 'test', sent_by: 'automatic: invitation email' });
                await addNote(cid, note);
              }
            } catch (er) { console.error('family invite', er && er.message || er); }
          }
        }
      } catch (er) { console.error('invite emails', er && er.message || er); }
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
  const env = { GHL_TOKEN: Deno.env.get('GHL_TOKEN'), GHL_LOCATION_ID: Deno.env.get('GHL_LOCATION_ID'), GHL_TEST: Deno.env.get('GHL_TEST'),
    STRIPE_SECRET_KEY: Deno.env.get('STRIPE_SECRET_KEY'), STRIPE_WEBHOOK_SECRET_GRADING: Deno.env.get('STRIPE_WEBHOOK_SECRET_GRADING'),
    EFC_API_KEY_MARRICKVILLE: Deno.env.get('EFC_API_KEY_MARRICKVILLE'), EFC_API_KEY_SYDENHAM: Deno.env.get('EFC_API_KEY_SYDENHAM'), EFC_API_KEY_CONCORD: Deno.env.get('EFC_API_KEY_CONCORD'), EFC_API_KEY_WEST: Deno.env.get('EFC_API_KEY_WEST'), EFC_API_KEY_SYLVANIA: Deno.env.get('EFC_API_KEY_SYLVANIA') };
  Deno.serve(req => handle(req, db, env));
}

// @ts-nocheck
// On-demand + nightly EFC pull + targeted EFC fixes (server-side, keys from secrets).
// Ops: ping | calendar | setmobile | moveentry | setbelt | cleanstale | rebook | (default) pull+ingest.
// Auth: staff JWT (admin, or the op's listed permission), or header x-cron-key == efc_hook.ingest_key.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const EFC_BASE = 'https://api.efcaquila.net/version/1';
const EFC_LOCATIONS = { Marrickville: 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58', Sydenham: '5af07764-95bc-4caf-b889-ba846e409dc5', West: 'eafda575-a10e-4656-a045-8e20201aad40', Concord: '7ca1c142-be41-4d02-b5eb-13534b23043b', Sylvania: 'a5a5ab24-e85d-4e14-ac16-1d9c189ff0dd' };
const REF_SCHOOL = { '023': 'Marrickville', '256': 'Sydenham', '257': 'West', '258': 'Concord', '3096': 'Sylvania' };
const refSchool = ref => REF_SCHOOL[String(ref || '').split('-')[1]] || null;
const SCHOOLS = [
  { name: 'Marrickville', secret: 'EFC_API_KEY_MARRICKVILLE' },
  { name: 'Sydenham',     secret: 'EFC_API_KEY_SYDENHAM' },
  { name: 'Concord',      secret: 'EFC_API_KEY_CONCORD' },
  { name: 'West',         secret: 'EFC_API_KEY_WEST' },
  { name: 'Sylvania',     secret: 'EFC_API_KEY_SYLVANIA' }
];

const MEMBER_PUT_FIELDS = ['title','firstName','middleName','lastName','gender','dob','contactTitle','contactFirstName','contactLastName','contactDob','contactInformation','address1','address2','town','county','postCode','email','telephoneHome','telephoneMobile','telephoneWork','mediaConsent','alerts','customProperty1','customProperty2','customProperty3','customProperty4','customProperty5','customProperty6','customProperty7','customProperty8','customProperty9','customProperty10','metaData','referrerId','enrolmentReference','enrolmentRank','enrolmentReason','licenceNumber','licenceExpiryDate','uniformSize','beltSize'];

async function efcGet(key, path) {
  const r = await fetch(EFC_BASE + path, { headers: { 'X-API-KEY': key, 'Accept': 'application/json' } });
  const t = await r.text();
  let b = null; try { b = JSON.parse(t); } catch {}
  return { status: r.status, body: b, text: t };
}

async function pullSchool(key, cap = 30000) {
  const id = await efcGet(key, '/identity');
  if (id.status !== 200) return { ok: false, error: 'identity ' + id.status };
  const loc = (id.body.locations || [])[0];
  if (!loc) return { ok: false, error: 'no location on key' };
  const progs = await efcGet(key, `/locations/${loc.id}/programmes`);
  const programmes = Array.isArray(progs.body) ? progs.body : [];
  const records = [];
  const perProgramme = {};
  const SIZE = 200;
  for (const p of programmes) {
    let page = 1;
    while (true) {
      const a = await efcGet(key, `/locations/${loc.id}/programmes/${p.id}/assessments/query?pageSize=${SIZE}&pageNumber=${page}`);
      if (a.status !== 200 || !a.body) break;
      const recs = a.body.records || [];
      for (const r of recs) records.push(r);
      perProgramme[p.name] = (perProgramme[p.name] || 0) + recs.length;
      if (recs.length < SIZE) break;
      page++;
      if (page > 100) break;
      if (records.length >= cap) break;
    }
    if (records.length >= cap) break;
  }
  return { ok: true, locationId: loc.id, locationName: loc.name, programmes: programmes.length, perProgramme, records };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const svc = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const { data: hook } = await svc.from('efc_hook').select('ingest_key').eq('id', 1).maybeSingle();
  const ingestKey = hook && hook.ingest_key;

  let who = null, isCron = false, myPerms = [];
  const cronKey = req.headers.get('x-cron-key') || '';
  if (cronKey && ingestKey && cronKey === ingestKey) {
    who = 'cron'; isCron = true;
  } else {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'Sign in required.' }, 401);
    let email = null;
    try { const { data: u } = await svc.auth.getUser(jwt); email = u && u.user && u.user.email ? u.user.email.toLowerCase() : null; } catch {}
    if (!email) return json({ error: 'Sign in required.' }, 401);
    const { data: perms } = await svc.from('app_permissions').select('perm').eq('app', 'cb').ilike('email', email);
    myPerms = Array.isArray(perms) ? perms.map(p => p.perm) : [];
    who = email;
  }
  const allow = (...p) => isCron || myPerms.includes('admin') || p.some(x => myPerms.includes(x));

  const url = new URL(req.url);
  const op = url.searchParams.get('op') || '';
  const PERM_FOR = { setbelt: ['days', 'belts'], moveentry: ['days'] };
  const need = PERM_FOR[op] || [];
  if (!allow(...need)) return json({ error: need.length ? ('You need the ' + need.join(' or ') + ' permission.') : 'Staff admin permission required.' }, 403);

  const onlySchool = (url.searchParams.get('school') || '').toLowerCase();
  const schools = SCHOOLS.filter(s => !onlySchool || s.name.toLowerCase() === onlySchool);

  if (op === 'ping') {
    const out = [];
    for (const s of schools) {
      const key = Deno.env.get(s.secret);
      if (!key) { out.push({ school: s.name, ok: false, configured: false, note: 'no key yet' }); continue; }
      const id = await efcGet(key, '/identity');
      const loc = id.status === 200 ? (id.body.locations || [])[0] : null;
      out.push({ school: s.name, ok: id.status === 200, configured: true, status: id.status, location: loc ? loc.name : null, roleCount: loc ? (loc.roles || []).length : null });
    }
    return json({ ok: true, op: 'ping', by: who, schools: out });
  }

  if (op === 'calendar') {
    const schoolName = (url.searchParams.get('school') || '').trim();
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || from).trim();
    const locId = EFC_LOCATIONS[schoolName] || '';
    const key = Deno.env.get('EFC_API_KEY_' + String(schoolName || '').toUpperCase());
    if (!locId || !key || !from) return json({ error: 'need school (mapped+key) and from date' }, 400);
    const r = await efcGet(key, `/locations/${locId}/calendar/sessions?dateFrom=${from}&dateTo=${to}`);
    const arr = Array.isArray(r.body) ? r.body : (r.body && r.body.records) || [];
    const sessions = arr.map(s => ({ id: s.id, name: s.name || (s.bookable && s.bookable.name) || null, date: s.date, startTime: s.startTime, bookable: s.bookable && s.bookable.id }));
    return json({ ok: r.status === 200, op: 'calendar', school: schoolName, status: r.status, count: sessions.length, sessions });
  }

  if (op === 'setmobile') {
    const memberId = (url.searchParams.get('member') || '').trim();
    const schoolName = (url.searchParams.get('school') || '').trim();
    const mobile = (url.searchParams.get('mobile') || '').trim();
    const dry = url.searchParams.get('dryRun') === '1';
    const locId = EFC_LOCATIONS[schoolName] || '';
    const key = Deno.env.get('EFC_API_KEY_' + String(schoolName || '').toUpperCase());
    if (!memberId || !locId) return json({ error: 'need member and a known school (name maps to a location)' }, 400);
    if (!key) return json({ error: 'no API key configured for ' + schoolName }, 400);
    if (!mobile) return json({ error: 'need mobile' }, 400);

    const cur = await efcGet(key, `/locations/${locId}/members/${memberId}`);
    if (cur.status !== 200 || !cur.body) return json({ error: 'GET member ' + cur.status }, 502);
    const m = cur.body;

    const body = {};
    for (const f of MEMBER_PUT_FIELDS) if (m[f] !== undefined && m[f] !== null) body[f] = m[f];
    if (Array.isArray(m.groups)) body.groupIds = m.groups.map(g => g.id);
    const before = m.telephoneMobile || null;
    body.telephoneMobile = mobile;

    const info = { member: memberId, name: [m.firstName, m.middleName, m.lastName].filter(Boolean).join(' '), reference: m.reference || null, before, willSet: mobile, groupCount: Array.isArray(m.groups) ? m.groups.length : 0, fieldsSent: Object.keys(body).length, note: 'familyHeadId is not exposed by GET and is omitted from the PUT' };

    if (dry) return json({ ok: true, op: 'setmobile', dryRun: true, by: who, info });

    const put = await fetch(`${EFC_BASE}/locations/${locId}/members/${memberId}`, { method: 'PUT', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const pt = await put.text(); let pb = null; try { pb = JSON.parse(pt); } catch {}
    if (!put.ok) return json({ ok: false, op: 'setmobile', status: put.status, error: pb || pt.slice(0, 400), info }, 502);

    const after = await efcGet(key, `/locations/${locId}/members/${memberId}`);
    const a = after.body || {};
    const check = { telephoneMobile: a.telephoneMobile || null, firstName: a.firstName, lastName: a.lastName, email: a.email || null, telephoneHome: a.telephoneHome || null, groupCount: Array.isArray(a.groups) ? a.groups.length : null, enrolmentRank: a.enrolmentRank || null, beltSize: a.beltSize || null, unchanged: a.telephoneMobile === mobile && a.firstName === m.firstName && a.lastName === m.lastName && (a.email || null) === (m.email || null) && (Array.isArray(a.groups) ? a.groups.length : 0) === (Array.isArray(m.groups) ? m.groups.length : 0) };
    return json({ ok: true, op: 'setmobile', by: who, info, after: check });
  }

  if (op === 'moveentry') {
    const entryId = (url.searchParams.get('entry') || '').trim();
    const toDay = (url.searchParams.get('toDay') || '').trim();
    const dry = url.searchParams.get('dryRun') === '1';
    if (!entryId || !toDay) return json({ error: 'need entry and toDay' }, 400);

    const { data: e } = await svc.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, school, booked_at, paid, result').eq('entry_id', entryId).maybeSingle();
    if (!e) return json({ error: 'entry not found' }, 404);
    const { data: d1 } = await svc.from('cb_days').select('day_id, location, grading_date, bb, efc_session_id, efc_belt_sessions, efc_school_belt_sessions').eq('day_id', e.day_id).maybeSingle();
    const { data: d2 } = await svc.from('cb_days').select('day_id, location, grading_date, bb, efc_session_id, efc_belt_sessions, efc_school_belt_sessions').eq('day_id', toDay).maybeSingle();
    if (!d2) return json({ error: 'target day not found' }, 404);
    const { data: mem } = await svc.from('efc_members').select('efc_reference, location').eq('member_key', e.member_key).maybeSingle();
    const memberId = e.member_key && e.member_key.startsWith('efc:') ? e.member_key.slice(4) : null;

    const coords = (day, school, belt) => {
      if (!day) return null;
      const own = school || (mem && mem.location) || refSchool(mem && mem.efc_reference) || null;
      const mloc = day.bb ? own : (own || day.location);
      const locId = EFC_LOCATIONS[mloc] || null;
      const sbRoot = day.efc_school_belt_sessions && typeof day.efc_school_belt_sessions === 'object' ? day.efc_school_belt_sessions : {};
      const sb = (sbRoot[mloc] && typeof sbRoot[mloc] === 'object') ? (sbRoot[mloc][belt] || null) : null;
      const bm = day.efc_belt_sessions && typeof day.efc_belt_sessions === 'object' ? day.efc_belt_sessions : {};
      let sid;
      if (day.bb) sid = sb || null;
      else if (mloc === day.location) sid = bm[belt] || day.efc_session_id || null;
      else sid = sb || null;
      return { school: mloc, locId, sid, date: day.grading_date };
    };

    const oldC = coords(d1, e.school, e.belt_from);
    const newSchool = e.school || (mem && mem.location) || refSchool(mem && mem.efc_reference) || d2.location;
    const newC = coords(d2, newSchool, e.belt_from);

    const summary = { entry: entryId, name: e.full_name, belt: e.belt_from + ' -> ' + e.belt_to, bookedNow: !!e.booked_at, paid: e.paid, result: e.result, from: { day: e.day_id, loc: d1 && d1.location, date: oldC && oldC.date, school: oldC && oldC.school, session: oldC && oldC.sid }, to: { day: toDay, loc: d2.location, date: newC && newC.date, school: newC && newC.school, session: newC && newC.sid } };
    if (!newC || !newC.sid || !newC.locId) return json({ ok: false, op: 'moveentry', error: 'target day has no EFC session for ' + e.belt_from + ' at ' + newSchool, summary }, 400);
    if (e.result) return json({ ok: false, op: 'moveentry', error: 'entry already has a result; not moving', summary }, 409);
    if (dry) return json({ ok: true, op: 'moveentry', dryRun: true, summary });

    const steps = {};

    const newKey = Deno.env.get('EFC_API_KEY_' + String(newC.school || '').toUpperCase());
    if (!newKey) return json({ ok: false, op: 'moveentry', error: 'no API key for ' + newC.school + '; no changes made', summary }, 400);
    const newReg = `${EFC_BASE}/locations/${newC.locId}/calendar/sessions/${newC.sid}/${newC.date}/bookings`;
    try {
      const r = await fetch(newReg, { method: 'POST', headers: { 'X-API-KEY': newKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId }) });
      if (r.ok) steps.bookNew = 'booked';
      else {
        const c = await fetch(newReg, { headers: { 'X-API-KEY': newKey, 'Accept': 'application/json' } });
        const j = c.ok ? await c.json().catch(() => []) : []; const arr = Array.isArray(j) ? j : (j.records || []);
        if (arr.some(b => b && b.member && b.member.id === memberId)) steps.bookNew = 'already booked';
        else { let eb = null; try { eb = await r.json(); } catch {} steps.bookNew = 'EFC ' + r.status + (eb && (eb.code || eb.message) ? ' (' + (eb.code || eb.message) + ')' : ''); }
      }
    } catch (err) { steps.bookNew = 'error ' + String(err && err.message || err); }
    const bookedNew = steps.bookNew === 'booked' || steps.bookNew === 'already booked';
    if (!bookedNew) return json({ ok: false, op: 'moveentry', error: 'could not book the new session; no changes made', summary, steps }, 502);

    const { error: upErr } = await svc.from('cb_entries').update({ day_id: toDay, school: newSchool, moved_from_day: e.day_id, booking_error: null, efc_by_hand: false, booked_at: e.booked_at || new Date().toISOString() }).eq('entry_id', entryId);
    steps.dbMove = upErr ? ('error ' + upErr.message) : ('moved to ' + toDay + ' as ' + newSchool);

    if (e.booked_at && oldC && oldC.sid && oldC.locId && memberId && !(oldC.locId === newC.locId && oldC.sid === newC.sid && oldC.date === newC.date)) {
      const oldKey = Deno.env.get('EFC_API_KEY_' + String(oldC.school || '').toUpperCase());
      if (!oldKey) steps.cancelOld = 'no key for ' + oldC.school + ' (old booking left in place)';
      else {
        try {
          const reg = await fetch(`${EFC_BASE}/locations/${oldC.locId}/calendar/sessions/${oldC.sid}/${oldC.date}/bookings`, { headers: { 'X-API-KEY': oldKey, 'Accept': 'application/json' } });
          const j = reg.ok ? await reg.json().catch(() => []) : []; const arr = Array.isArray(j) ? j : (j.records || []);
          const bk = arr.find(b => b && b.member && b.member.id === memberId);
          if (bk && bk.id) {
            const del = await fetch(`${EFC_BASE}/locations/${oldC.locId}/calendar/sessions/${oldC.sid}/${oldC.date}/bookings/${bk.id}`, { method: 'DELETE', headers: { 'X-API-KEY': oldKey } });
            steps.cancelOld = del.ok ? 'cancelled' : ('delete ' + del.status + ' (old booking may remain)');
          } else steps.cancelOld = 'no existing booking found on old session';
        } catch (err) { steps.cancelOld = 'error ' + String(err && err.message || err); }
      }
    } else steps.cancelOld = 'skipped';

    return json({ ok: !upErr && bookedNew, op: 'moveentry', summary, steps });
  }

  // --- Set/correct an entry's belt AND re-point its grading day + EFC booking automatically ---
  if (op === 'setbelt') {
    const entryId = (url.searchParams.get('entry') || '').trim();
    const newFrom = (url.searchParams.get('from') || '').trim();
    const newTo = (url.searchParams.get('to') || '').trim();
    const toProg = (url.searchParams.get('toProgramme') || '').trim() || null;
    const toDay = (url.searchParams.get('toDay') || '').trim();
    const dry = url.searchParams.get('dryRun') === '1';
    if (!entryId || !newFrom || !newTo) return json({ error: 'need entry, from, to' }, 400);

    const daySel = 'day_id, location, grading_date, start_time, bb, programme, efc_session_id, efc_belt_sessions, efc_school_belt_sessions';
    const { data: e } = await svc.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, school, booked_at, paid, result').eq('entry_id', entryId).maybeSingle();
    if (!e) return json({ error: 'entry not found' }, 404);
    if (e.result) return json({ error: 'entry already has a result; not changing' }, 409);
    const { data: d1 } = await svc.from('cb_days').select(daySel).eq('day_id', e.day_id).maybeSingle();
    const { data: mem } = await svc.from('efc_members').select('efc_reference, location, date_of_birth').eq('member_key', e.member_key).maybeSingle();
    const memberId = e.member_key && e.member_key.startsWith('efc:') ? e.member_key.slice(4) : null;
    const homeSchool = e.school || (mem && mem.location) || refSchool(mem && mem.efc_reference) || (d1 && d1.location) || null;

    const sessOn = (day, belt) => {
      if (!day) return null;
      const mloc = day.bb ? homeSchool : (homeSchool || day.location);
      const locId = EFC_LOCATIONS[mloc] || null;
      const sbRoot = day.efc_school_belt_sessions && typeof day.efc_school_belt_sessions === 'object' ? day.efc_school_belt_sessions : {};
      const sb = (sbRoot[mloc] && typeof sbRoot[mloc] === 'object') ? (sbRoot[mloc][belt] || null) : null;
      const bm = day.efc_belt_sessions && typeof day.efc_belt_sessions === 'object' ? day.efc_belt_sessions : {};
      let sid;
      if (day.bb) sid = sb || null;
      else if (mloc === day.location) sid = bm[belt] || day.efc_session_id || null;
      else sid = sb || null;
      return sid ? { school: mloc, locId, sid, date: day.grading_date } : null;
    };
    const ageOf = m => (m && typeof m.date_of_birth === 'string' && /^\d{4}-\d{2}-\d{2}/.test(m.date_of_birth)) ? Math.floor((Date.now() - Date.parse(m.date_of_birth.slice(0, 10))) / 31557600000) : null;
    const age = ageOf(mem);

    let d2 = null, why = '';
    if (toDay) {
      ({ data: d2 } = await svc.from('cb_days').select(daySel).eq('day_id', toDay).maybeSingle());
      if (!d2) return json({ error: 'target day not found' }, 404);
      why = 'chosen';
    } else if (sessOn(d1, newFrom)) {
      d2 = d1; why = 'current day already hosts ' + newFrom;
    } else {
      const base = Date.parse(String(d1.grading_date).slice(0, 10));
      const lo = new Date(base - 21 * 86400000).toISOString().slice(0, 10);
      const hi = new Date(base + 21 * 86400000).toISOString().slice(0, 10);
      const { data: days } = await svc.from('cb_days').select(daySel).eq('location', d1.location).eq('bb', d1.bb).gte('grading_date', lo).lte('grading_date', hi);
      const cands = (days || []).filter(dd => sessOn(dd, newFrom));
      if (cands.length === 1) { d2 = cands[0]; why = 'only ' + newFrom + ' day at ' + d1.location; }
      else if (cands.length === 0) { d2 = d1; why = 'no ' + newFrom + ' grading day at ' + d1.location + '; staying put, flagged'; }
      else {
        const candidates = cands.sort((a, b) => (a.grading_date + a.start_time).localeCompare(b.grading_date + b.start_time)).map(c => ({ day_id: c.day_id, location: c.location, date: c.grading_date, start_time: c.start_time }));
        return json({ ok: true, op: 'setbelt', needsDay: true, entry: entryId, name: e.full_name, from: newFrom, to: newTo, age, bookedNow: !!e.booked_at, candidates });
      }
    }

    const move = d2.day_id !== e.day_id;
    const oldSess = e.booked_at ? sessOn(d1, e.belt_from) : null;
    const newSess = e.booked_at ? sessOn(d2, newFrom) : null;
    const summary = { entry: entryId, name: e.full_name, belt: e.belt_from + '/' + e.belt_to + ' -> ' + newFrom + '/' + newTo, age, bookedNow: !!e.booked_at, move, why, from: { day: e.day_id, date: d1 && d1.grading_date, session: oldSess && oldSess.sid }, to: { day: d2.day_id, date: d2.grading_date, session: newSess && newSess.sid } };
    if (dry) return json({ ok: true, op: 'setbelt', dryRun: true, summary });

    const steps = {};
    const needRebook = !!e.booked_at && newSess && (!oldSess || oldSess.locId !== newSess.locId || oldSess.sid !== newSess.sid || oldSess.date !== newSess.date);

    if (needRebook) {
      const newKey = Deno.env.get('EFC_API_KEY_' + String(newSess.school || '').toUpperCase());
      if (!newKey) return json({ ok: false, op: 'setbelt', error: 'no API key for ' + newSess.school + '; no changes made', summary }, 400);
      const reg = `${EFC_BASE}/locations/${newSess.locId}/calendar/sessions/${newSess.sid}/${newSess.date}/bookings`;
      try {
        const r = await fetch(reg, { method: 'POST', headers: { 'X-API-KEY': newKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId }) });
        if (r.ok) steps.bookNew = 'booked';
        else { const c = await fetch(reg, { headers: { 'X-API-KEY': newKey, 'Accept': 'application/json' } }); const j = c.ok ? await c.json().catch(() => []) : []; const arr = Array.isArray(j) ? j : (j.records || []); if (arr.some(b => b && b.member && b.member.id === memberId)) steps.bookNew = 'already booked'; else { let eb = null; try { eb = await r.json(); } catch {} steps.bookNew = 'EFC ' + r.status + (eb && (eb.code || eb.message) ? ' (' + (eb.code || eb.message) + ')' : ''); } }
      } catch (err) { steps.bookNew = 'error ' + String(err && err.message || err); }
      if (!(steps.bookNew === 'booked' || steps.bookNew === 'already booked')) return json({ ok: false, op: 'setbelt', error: 'could not re-book the new session; no changes made', summary, steps }, 502);
    }

    const upd = { belt_from: newFrom, belt_to: newTo, to_programme: toProg, efc_belt_fix: new Date().toISOString(), booking_error: null };
    if (move) { upd.day_id = d2.day_id; upd.moved_from_day = e.day_id; }
    const { error: upErr } = await svc.from('cb_entries').update(upd).eq('entry_id', entryId);
    steps.update = upErr ? ('error ' + upErr.message) : (move ? ('belt set; moved to ' + d2.day_id) : 'belt set');

    if (needRebook && oldSess && oldSess.sid) {
      const oldKey = Deno.env.get('EFC_API_KEY_' + String(oldSess.school || '').toUpperCase());
      if (!oldKey) steps.cancelOld = 'no key for ' + oldSess.school + ' (old booking left in place)';
      else {
        try {
          const reg = await fetch(`${EFC_BASE}/locations/${oldSess.locId}/calendar/sessions/${oldSess.sid}/${oldSess.date}/bookings`, { headers: { 'X-API-KEY': oldKey, 'Accept': 'application/json' } });
          const j = reg.ok ? await reg.json().catch(() => []) : []; const arr = Array.isArray(j) ? j : (j.records || []);
          const bk = arr.find(b => b && b.member && b.member.id === memberId);
          if (bk && bk.id) { const del = await fetch(`${EFC_BASE}/locations/${oldSess.locId}/calendar/sessions/${oldSess.sid}/${oldSess.date}/bookings/${bk.id}`, { method: 'DELETE', headers: { 'X-API-KEY': oldKey } }); steps.cancelOld = del.ok ? 'cancelled' : ('delete ' + del.status + ' (old booking may remain)'); }
          else steps.cancelOld = 'no existing booking found on old session';
        } catch (err) { steps.cancelOld = 'error ' + String(err && err.message || err); }
      }
    } else steps.cancelOld = 'skipped';

    return json({ ok: !upErr, op: 'setbelt', summary, steps });
  }

  // --- Cancel stale GRADING bookings for members: any grading booking whose date isn't keepDay. ---
  // Safe by construction: only touches bookings whose session name contains 'grading', and never the
  // one on keepDay. dryRun=1 lists what it would cancel. members = comma-separated EFC member guids.
  if (op === 'cleanstale') {
    const schoolName = (url.searchParams.get('school') || '').trim();
    const keepDay = (url.searchParams.get('keepDay') || '').trim();
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const members = (url.searchParams.get('members') || '').split(',').map(s => s.trim()).filter(Boolean);
    const dry = url.searchParams.get('dryRun') === '1';
    const locId = EFC_LOCATIONS[schoolName] || '';
    const key = Deno.env.get('EFC_API_KEY_' + String(schoolName || '').toUpperCase());
    if (!locId || !key) return json({ error: 'need school (mapped+key)' }, 400);
    if (!keepDay || !members.length) return json({ error: 'need keepDay and members' }, 400);
    const qs = (from && to) ? `?startDate=${from}&endDate=${to}` : '';
    const out = [];
    for (const mid of members) {
      const r = await efcGet(key, `/locations/${locId}/members/${mid}/bookings${qs}`);
      const arr = Array.isArray(r.body) ? r.body : ((r.body && r.body.records) || []);
      const nameOf = bk => (bk && bk.bookable && bk.bookable.name) || (bk && bk.name) || '';
      const grad = arr.filter(bk => /grading/i.test(nameOf(bk)));
      const stale = grad.filter(bk => String(bk.date).slice(0, 10) !== keepDay);
      const res = { member: mid, status: r.status,
        kept: grad.filter(bk => String(bk.date).slice(0, 10) === keepDay).map(k => ({ date: String(k.date).slice(0, 10), name: nameOf(k) })),
        stale: stale.map(s => ({ bookingId: s.id, session: s.bookable && s.bookable.id, date: String(s.date).slice(0, 10), name: nameOf(s) })) };
      if (!dry) {
        res.cancelled = [];
        for (const s of stale) {
          const sid = s.bookable && s.bookable.id, dt = String(s.date).slice(0, 10), bkid = s.id;
          if (!sid || !dt || !bkid) { res.cancelled.push({ bookingId: bkid, ok: false, why: 'missing ids' }); continue; }
          try { const del = await fetch(`${EFC_BASE}/locations/${locId}/calendar/sessions/${sid}/${dt}/bookings/${bkid}`, { method: 'DELETE', headers: { 'X-API-KEY': key } }); res.cancelled.push({ bookingId: bkid, name: nameOf(s), date: dt, ok: del.ok, status: del.ok ? undefined : del.status }); }
          catch (err) { res.cancelled.push({ bookingId: bkid, ok: false, why: String(err && err.message || err) }); }
        }
      }
      out.push(res);
    }
    return json({ ok: true, op: 'cleanstale', dryRun: dry, keepDay, out });
  }

  // --- Rebook: move paid students onto a grading day's current mapped EFC session ---
  if (op === 'rebook') {
    const dayId = url.searchParams.get('day') || '';
    if (!dayId) return json({ error: 'Pass ?day=<cb_days.day_id>' }, 400);
    const { data: d } = await svc.from('cb_days').select('day_id, location, grading_date, bb, programme, efc_session_id, efc_sessions, efc_belt_sessions, efc_school_belt_sessions').eq('day_id', dayId).maybeSingle();
    if (!d) return json({ error: 'Grading day not found.' }, 404);
    const { data: entries } = await svc.from('cb_entries').select('entry_id, member_key, full_name, belt_from, belt_to, school, booked_at').eq('day_id', dayId).eq('paid', true).is('result', null);
    const schoolMap = (d.efc_sessions && typeof d.efc_sessions === 'object') ? d.efc_sessions : {};
    const beltMap = (d.efc_belt_sessions && typeof d.efc_belt_sessions === 'object') ? d.efc_belt_sessions : {};
    const sbMap = (d.efc_school_belt_sessions && typeof d.efc_school_belt_sessions === 'object') ? d.efc_school_belt_sessions : {};
    const out = [];
    for (const e of (entries || [])) {
      const { data: m } = await svc.from('efc_members').select('efc_reference, location').eq('member_key', e.member_key).maybeSingle();
      const own = e.school || (m && m.location) || refSchool(m && m.efc_reference) || null;
      const mloc = d.bb ? own : (own || d.location);
      const locId = EFC_LOCATIONS[mloc] || null;
      const beltKey = d.bb ? e.belt_to : e.belt_from;
      const schoolBelt = (sbMap[mloc] && typeof sbMap[mloc] === 'object') ? (sbMap[mloc][beltKey] || null) : null;
      let sid;
      if (d.bb) sid = schoolBelt || schoolMap[mloc] || null;
      else if (mloc === d.location) sid = beltMap[e.belt_from] || d.efc_session_id || null;
      else sid = schoolBelt || schoolMap[mloc] || null;
      const memberId = e.member_key && e.member_key.startsWith('efc:') ? e.member_key.slice(4) : null;
      const key = Deno.env.get('EFC_API_KEY_' + String(mloc || '').toUpperCase());
      if (!sid || !locId || !memberId || !key) { out.push({ student: e.full_name, belt: e.belt_from, ok: false, skipped: true, why: 'no session / location / member id / key' }); continue; }
      const reg = `${EFC_BASE}/locations/${locId}/calendar/sessions/${sid}/${d.grading_date}/bookings`;
      let okBook = false, why = '';
      try {
        const r = await fetch(reg, { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId }) });
        if (r.ok) okBook = true;
        else {
          const c = await fetch(reg, { headers: { 'X-API-KEY': key, 'Accept': 'application/json' } });
          if (c.ok) { const j = await c.json().catch(() => []); const arr = Array.isArray(j) ? j : (j.records || []); if (arr.some(b => b && b.member && b.member.id === memberId)) okBook = true; }
          if (!okBook) { let eb = null; try { eb = await r.json(); } catch {} why = 'EFC ' + r.status + (eb && (eb.code || eb.message) ? ' (' + (eb.code || eb.message) + ')' : ''); }
        }
      } catch (err) { why = String(err && err.message || err); }
      if (okBook) { if (!e.booked_at) { try { await svc.from('cb_entries').update({ booked_at: new Date().toISOString(), booking_error: null, efc_by_hand: false }).eq('entry_id', e.entry_id); } catch {} } }
      else { try { await svc.from('cb_entries').update({ booking_error: why.slice(0, 300) }).eq('entry_id', e.entry_id); } catch {} }
      out.push({ student: e.full_name, belt: e.belt_from, school: mloc, session: sid, ok: okBook, why: okBook ? null : why });
    }
    return json({ ok: out.every(x => x.ok), op: 'rebook', day: dayId, date: d.grading_date, count: out.length, results: out });
  }

  if (!ingestKey) return json({ error: 'efc_hook.ingest_key missing; cannot feed ingest.' }, 500);

  const results = [];
  for (const s of schools) {
    const key = Deno.env.get(s.secret);
    if (!key) { results.push({ school: s.name, ok: true, skipped: true, note: 'no key yet' }); continue; }
    const pulled = await pullSchool(key);
    if (!pulled.ok) { results.push({ school: s.name, ok: false, error: pulled.error }); continue; }

    const recs = pulled.records;
    const batchSize = 1500;
    let saved = 0, skipped = 0, ingestErr = null, batches = 0;
    for (let i = 0; i < recs.length; i += batchSize) {
      const batch = recs.slice(i, i + batchSize);
      const r = await fetch(`${SUPABASE_URL}/functions/v1/efc?location=${encodeURIComponent(s.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-efc-key': ingestKey }, body: JSON.stringify(batch) });
      let jb = null; try { jb = await r.json(); } catch {}
      if (jb) { saved += jb.saved || 0; skipped += jb.skipped || 0; if (jb.ingest && jb.ingest.error && !ingestErr) ingestErr = jb.ingest.error; }
      else if (!ingestErr) ingestErr = 'efc batch http ' + r.status;
      batches++;
    }
    results.push({ school: s.name, ok: !ingestErr, location: pulled.locationName, pulled: recs.length, perProgramme: pulled.perProgramme, saved, skipped, batches, ingestError: ingestErr });
  }
  try { await svc.from('efc_hook').update({ last_pull_at: new Date().toISOString(), last_pull_by: who }).eq('id', 1); } catch {}
  return json({ ok: results.every(r => r.ok), ranAt: new Date().toISOString(), by: who, results });
});

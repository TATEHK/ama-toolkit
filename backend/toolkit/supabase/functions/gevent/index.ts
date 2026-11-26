// @ts-nocheck
// AMA Toolkit: grading events (grading-event-1/3.sql), first used for the Beyond 4th Dan grading on Sat 28 Nov 2026.
// The theory test lives here so answers are marked on the server and never sent to phones.
// It is a private test: each candidate works through it at their own pace on their phone within one time limit,
// can change answers until they submit, and only staff see results (no points, no leaderboard).
//
// Deploy: Actions > "Deploy Supabase function" > gevent (JWT verification off: candidates join with the event code, no login;
// staff actions check the signed-in Black Belt Gradings login).
//
// Candidates (no sign-in; code = the event's join code, token = a random id the phone keeps):
//   { action: 'join', code }                               event title + the candidates to pick from
//   { action: 'claim', code, cand_id, token, force? }      sit the test as this candidate on this phone
//   { action: 'state', code, token }                       test status; while open, the questions (no answers) and my saved answers
//   { action: 'answer', code, token, q_ix, answer }        save or change an answer (index, or an array for put-in-order)
//   { action: 'submit', code, token }                      hand the test in (no more changes)
// Staff (Authorization: Bearer <staff session>; app_permissions 'bb'):
//   { action: 'host_state', event_id }                     status, who has joined, progress and (for staff) scores
//   { action: 'host', event_id, cmd, mins? }               cmd: open | start | extend | end | close | reset
//   { action: 'tablet', event_id, cand_id }                a token so a staff tablet can be used by someone without a phone
//   { action: 'quiz_record', event_id }                    write each candidate's theory item from their score (pass mark in the config)
// Setup: { action: 'seed', slug } with x-ge-seed (vault ge_seed_key): load a bundled event config.

import beyond4th from './beyond-4th-dan-2026-11-28.ts';
const BUNDLED = { 'beyond-4th-dan-2026-11-28': { title: 'Beyond 4th Dan Grading', join_code: '4DAN', starts_at: '2026-11-28T08:00:00+11:00', day_id: 'fc39317a-2476-4a9e-988f-f57699714df8', config: beyond4th } };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ge-seed',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (m, s = 400) => json({ ok: false, error: m }, s);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
const tokenOk = t => /^[A-Za-z0-9_-]{20,64}$/.test(String(t || ''));
const newToken = () => { const b = crypto.getRandomValues(new Uint8Array(24)); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

export function isCorrect(q, a) {
  if (q.type === 'order') return Array.isArray(a) && a.length === q.answer.length && a.every((x, i) => Number(x) === q.answer[i]);
  return a !== null && a !== '' && Number.isInteger(Number(a)) && Number(a) === q.answer;
}
const publicQs = quiz => quiz.questions.map((q, ix) => ({ ix, section: (quiz.rounds[q.round] || {}).name || '', type: q.type, text: q.text, options: q.options }));
const testMins = quiz => Number(quiz.minutes || 30);

export async function handle(req, db, env = {}) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  let body = {}; try { body = await req.json(); } catch (_) { return fail('Bad request.'); }
  const now = Date.now();
  try {
    // ---------- setup ----------
    if (body.action === 'seed') {
      const { data: okKey } = await db.rpc('ge_seed_ok', { p_key: req.headers.get('x-ge-seed') || '' });
      if (okKey !== true) return fail('Not allowed.', 403);
      const b = BUNDLED[String(body.slug || '')]; if (!b) return fail('No such event.');
      const { data: ex } = await db.from('ge_events').select('event_id, approved_at').eq('slug', body.slug).maybeSingle();
      if (ex && ex.approved_at) return fail('Results are approved; not changing the event.');
      const row = { slug: body.slug, title: b.title, join_code: b.join_code, starts_at: b.starts_at, day_id: b.day_id, config: b.config, updated_at: new Date().toISOString() };
      const { data, error } = ex ? await db.from('ge_events').update(row).eq('event_id', ex.event_id).select('event_id').single() : await db.from('ge_events').insert(row).select('event_id').single();
      if (error) throw error;
      await db.from('ge_quiz').upsert({ event_id: data.event_id }, { onConflict: 'event_id', ignoreDuplicates: true });
      return json({ ok: true, event_id: data.event_id });
    }

    // ---------- candidates ----------
    if (['join', 'claim', 'state', 'answer', 'submit'].includes(body.action)) {
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{3,12}$/.test(code)) return fail('Check the code and try again.', 404);
      const { data: ev } = await db.from('ge_events').select('event_id, title, config').eq('join_code', code).maybeSingle();
      if (!ev) return fail('Check the code and try again.', 404);
      const quiz = ev.config.quiz, cands = ev.config.candidates || [];
      const { data: qz } = await db.from('ge_quiz').select('*').eq('event_id', ev.event_id).maybeSingle();
      let phase = (qz && qz.phase) || 'closed';
      const ends = qz && qz.q_ends_at ? Date.parse(qz.q_ends_at) : 0;
      if (phase === 'open' && ends && now > ends + 5000) phase = 'ended';   // time is up even if staff haven't pressed End
      if (body.action === 'join') {
        const { data: pl } = await db.from('ge_players').select('cand_id').eq('event_id', ev.event_id);
        const taken = new Set((pl || []).map(p => p.cand_id));
        return json({ ok: true, title: ev.title, phase, players: cands.map(c => ({ id: c.id, name: c.name, group: c.group, taken: taken.has(c.id) })) });
      }
      if (!tokenOk(body.token)) return fail('Join again from the start.', 401);
      const th = await sha(body.token);
      if (body.action === 'claim') {
        const c = cands.find(x => x.id === body.cand_id); if (!c) return fail('Pick your name from the list.');
        const { data: cur } = await db.from('ge_players').select('token_hash, submitted_at').eq('event_id', ev.event_id).eq('cand_id', c.id).maybeSingle();
        if (cur && cur.token_hash !== th && !body.force) return json({ ok: false, taken: true, error: `${c.name} is already signed in on another device.` }, 409);
        await db.from('ge_players').delete().eq('event_id', ev.event_id).eq('token_hash', th).neq('cand_id', c.id);   // a phone is one person
        const { error } = cur ? await db.from('ge_players').update({ token_hash: th, via: body.via === 'tablet' ? 'tablet' : 'phone' }).eq('event_id', ev.event_id).eq('cand_id', c.id)
          : await db.from('ge_players').insert({ event_id: ev.event_id, cand_id: c.id, token_hash: th, via: body.via === 'tablet' ? 'tablet' : 'phone' });
        if (error) throw error;
        return json({ ok: true, name: c.name });
      }
      const { data: me } = await db.from('ge_players').select('cand_id, submitted_at').eq('event_id', ev.event_id).eq('token_hash', th).maybeSingle();
      if (!me) return json({ ok: false, rejoin: true, error: 'Pick your name again.' }, 401);
      const name = (cands.find(c => c.id === me.cand_id) || {}).name;
      if (body.action === 'answer' || body.action === 'submit') {
        if (me.submitted_at) return fail('You have already handed in your test.', 409);
        if (phase !== 'open') return fail(phase === 'ended' ? 'Time is up. Your saved answers count.' : 'The test hasn\'t started yet.', 409);
        if (body.action === 'submit') {
          await db.from('ge_players').update({ submitted_at: new Date().toISOString() }).eq('event_id', ev.event_id).eq('cand_id', me.cand_id);
          return json({ ok: true, submitted: true });
        }
        const ix = Number(body.q_ix), q = quiz.questions[ix];
        if (!q) return fail('Which question?');
        const clear = body.answer === null || (Array.isArray(body.answer) && !body.answer.length);
        if (clear) { await db.from('ge_answers').delete().eq('event_id', ev.event_id).eq('cand_id', me.cand_id).eq('q_ix', ix); return json({ ok: true, saved: null }); }
        const { error } = await db.from('ge_answers').upsert({ event_id: ev.event_id, cand_id: me.cand_id, q_ix: ix, answer: body.answer, correct: isCorrect(q, body.answer), points: 0, streak: 0, answered_at: new Date().toISOString() }, { onConflict: 'event_id,cand_id,q_ix' });
        if (error) throw error;
        return json({ ok: true, saved: ix });
      }
      // state
      const out = { ok: true, title: ev.title, phase, me: { id: me.cand_id, name }, submitted: !!me.submitted_at, total: quiz.questions.length, minutes: testMins(quiz), server_now: now };
      if (phase === 'open' && !me.submitted_at) {
        out.ends_in_ms = Math.max(0, ends - now);
        if (body.with_questions) out.questions = publicQs(quiz);
        const { data: mine } = await db.from('ge_answers').select('q_ix, answer').eq('event_id', ev.event_id).eq('cand_id', me.cand_id);
        out.answers = Object.fromEntries((mine || []).map(a => [a.q_ix, a.answer]));
      }
      return json(out);
    }

    // ---------- staff ----------
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = jwt ? await db.auth.getUser(jwt) : { data: null };
    const email = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
    if (!email) return fail('Sign in first.', 401);
    const { data: pr } = await db.from('app_permissions').select('perm').eq('email', email).eq('app', 'bb');
    const perms = (pr || []).map(r => r.perm), can = (...w) => perms.includes('admin') || w.some(x => perms.includes(x));
    if (!can('grading', 'scoring', 'results')) return fail('You need Black Belt Gradings grading or scoring access.', 403);
    if (!/^[0-9a-f-]{36}$/i.test(String(body.event_id || ''))) return fail('Which event?');
    const { data: ev } = await db.from('ge_events').select('event_id, title, config, approved_at').eq('event_id', body.event_id).maybeSingle();
    if (!ev) return fail('That event wasn\'t found.', 404);
    const quiz = ev.config.quiz, cands = ev.config.candidates || [], QN = quiz.questions.length;
    const getQ = async () => (await db.from('ge_quiz').select('*').eq('event_id', ev.event_id).maybeSingle()).data || { phase: 'closed', q_ix: -1 };

    if (body.action === 'host_state') {
      const [qz, { data: pl }, { data: ans }] = await Promise.all([getQ(), db.from('ge_players').select('cand_id, via, joined_at, submitted_at').eq('event_id', ev.event_id),
        db.from('ge_answers').select('cand_id, correct').eq('event_id', ev.event_id)]);
      const prog = {};
      for (const a of ans || []) { const p = prog[a.cand_id] || (prog[a.cand_id] = { answered: 0, correct: 0 }); p.answered++; if (a.correct) p.correct++; }
      return json({ ok: true, server_now: now, quiz: qz, total: QN, pass_mark: quiz.pass_mark, players: (pl || []).map(p => ({ ...p, ...(prog[p.cand_id] || { answered: 0, correct: 0 }) })) });
    }
    if (body.action === 'tablet') {
      const c = cands.find(x => x.id === body.cand_id); if (!c) return fail('Who is playing?');
      const t = newToken();
      await db.from('ge_players').upsert({ event_id: ev.event_id, cand_id: c.id, token_hash: await sha(t), via: 'tablet', joined_at: new Date().toISOString() }, { onConflict: 'event_id,cand_id' });
      return json({ ok: true, token: t, name: c.name });
    }
    if (body.action === 'quiz_record') {
      if (ev.approved_at) return fail('Results are already approved.');
      const { data: ans } = await db.from('ge_answers').select('cand_id, correct').eq('event_id', ev.event_id);
      const { data: pl } = await db.from('ge_players').select('cand_id').eq('event_id', ev.event_id);
      const sat = new Set([...(pl || []).map(p => p.cand_id), ...(ans || []).map(a => a.cand_id)]);
      const rows = [];
      for (const c of cands) {
        if (!sat.has(c.id)) continue;
        const n = (ans || []).filter(a => a.cand_id === c.id && a.correct).length, item = quiz.theory_items[c.syl];
        if (!item) continue;
        rows.push({ event_id: ev.event_id, cand_id: c.id, item_code: item, result: n >= quiz.pass_mark ? 'pass' : 'fail', comment: `Theory test: ${n}/${QN} correct (pass ${quiz.pass_mark})`, scored_by: email + ' (theory test)', updated_at: new Date().toISOString() });
      }
      if (rows.length) { const { error } = await db.from('ge_marks').upsert(rows, { onConflict: 'event_id,cand_id,item_code' }); if (error) throw error; }
      return json({ ok: true, recorded: rows.length, not_sat: cands.filter(c => !sat.has(c.id)).map(c => c.name) });
    }
    if (body.action === 'host') {
      const qz = await getQ(), cmd = String(body.cmd || '');
      const set = async patch => { const { data, error } = await db.from('ge_quiz').upsert({ event_id: ev.event_id, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'event_id' }).select('*').single(); if (error) throw error; return json({ ok: true, quiz: data }); };
      if (cmd === 'open') return set({ phase: 'lobby' });
      if (cmd === 'close') return set({ phase: 'closed' });
      if (cmd === 'start') { const mins = Number(body.mins) > 0 ? Number(body.mins) : Number(quiz.minutes || 30); return set({ phase: 'open', q_ix: 0, q_started_at: new Date(now).toISOString(), q_ends_at: new Date(now + mins * 60000).toISOString() }); }
      if (cmd === 'extend') { if (!['open', 'ended'].includes(qz.phase)) return fail('The test isn\'t running.'); const base = Math.max(now, Date.parse(qz.q_ends_at) || now); return set({ phase: 'open', q_ends_at: new Date(base + (Number(body.mins) || 5) * 60000).toISOString() }); }
      if (cmd === 'end') return set({ phase: 'ended', q_ends_at: new Date(Math.min(now, Date.parse(qz.q_ends_at) || now)).toISOString() });
      if (cmd === 'reset') {
        if (!can('grading')) return fail('Only grading staff can reset the test.', 403);
        await db.from('ge_answers').delete().eq('event_id', ev.event_id);
        if (body.players) await db.from('ge_players').delete().eq('event_id', ev.event_id);
        else await db.from('ge_players').update({ submitted_at: null }).eq('event_id', ev.event_id);
        return set({ phase: 'lobby', q_ix: -1, q_started_at: null, q_ends_at: null });
      }
      return fail('Unknown command.');
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
  Deno.serve(req => handle(req, db, {}));
}

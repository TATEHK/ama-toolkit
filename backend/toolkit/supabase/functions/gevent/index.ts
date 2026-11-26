// @ts-nocheck
// AMA Toolkit: grading events (grading-event-1.sql), first used for the Beyond 4th Dan grading on Sat 28 Nov 2026.
// The live quiz lives here so timing and points are worked out on the server, and players never see answers early.
//
// Deploy: Actions > "Deploy Supabase function" > gevent (JWT verification off: players join with the event code, no login;
// staff actions check the signed-in Black Belt Gradings login).
//
// Players (no sign-in; code = the event's join code, token = a random id the phone keeps):
//   { action: 'join', code }                               event title + the candidates to pick from
//   { action: 'claim', code, cand_id, token, force? }      play as this candidate on this phone
//   { action: 'state', code, token }                       what to show now (question without the answer, reveal, leaderboard)
//   { action: 'answer', code, token, q_ix, answer }        answer the open question (index, or an array for put-in-order)
// Staff (Authorization: Bearer <staff session>; app_permissions 'bb'):
//   { action: 'host_state', event_id }                     quiz phase, who has joined, answers so far, leaderboard
//   { action: 'host', event_id, cmd }                      cmd: open | start | reveal | leaderboard | next | podium | close | reset
//   { action: 'tablet', event_id, cand_id }                a token so a staff tablet can play for someone without a phone
//   { action: 'quiz_record', event_id }                    write each candidate's theory item from their quiz score (pass 24/30)
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

// Quiz rules (also in the config: speed bonus up to 50%, +100 for each answer on a run of 3+ correct)
export function roundOf(quiz, ix) { const q = quiz.questions[ix]; return q ? quiz.rounds[q.round] : null; }
export function isCorrect(q, a) {
  if (q.type === 'order') return Array.isArray(a) && a.length === q.answer.length && a.every((x, i) => Number(x) === q.answer[i]);
  return Number.isInteger(Number(a)) && Number(a) === q.answer;
}
export function pointsFor(quiz, ix, correct, ms, prevStreak) {
  const r = roundOf(quiz, ix), limit = r.secs * 1000;
  const streak = correct ? prevStreak + 1 : 0;
  if (!correct) return { points: 0, streak };
  const speed = Math.round(r.points * (quiz.speed_bonus ?? 0.5) * Math.max(0, 1 - ms / limit));
  const bonus = streak >= (quiz.streak_at || 3) ? (quiz.streak_bonus ?? 100) : 0;
  return { points: r.points + speed + bonus, streak, speed, bonus };
}
// Leaderboard: total points, then most correct, then who reached it first
export function leaderboard(answers, cands) {
  const by = {};
  for (const a of answers) { const p = by[a.cand_id] || (by[a.cand_id] = { cand_id: a.cand_id, points: 0, correct: 0, last: '' }); p.points += a.points || 0; if (a.correct) p.correct++; if (a.answered_at > p.last) p.last = a.answered_at; }
  const name = Object.fromEntries((cands || []).map(c => [c.id, c.name]));
  return Object.values(by).map(p => ({ ...p, name: name[p.cand_id] || '?' })).sort((a, b) => b.points - a.points || b.correct - a.correct || a.last.localeCompare(b.last));
}
const publicQ = (q, r, ix, total) => ({ ix, total, round: q.round, round_name: r.name, level: r.level, secs: r.secs, points: r.points, type: q.type, text: q.text, options: q.options });

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

    // ---------- players ----------
    if (['join', 'claim', 'state', 'answer'].includes(body.action)) {
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{3,12}$/.test(code)) return fail('Check the code and try again.', 404);
      const { data: ev } = await db.from('ge_events').select('event_id, title, config').eq('join_code', code).maybeSingle();
      if (!ev) return fail('Check the code and try again.', 404);
      const quiz = ev.config.quiz, cands = ev.config.candidates || [];
      const { data: qz } = await db.from('ge_quiz').select('*').eq('event_id', ev.event_id).maybeSingle();
      const phase = (qz && qz.phase) || 'closed';
      if (body.action === 'join') {
        const { data: pl } = await db.from('ge_players').select('cand_id').eq('event_id', ev.event_id);
        const taken = new Set((pl || []).map(p => p.cand_id));
        return json({ ok: true, title: ev.title, phase, players: cands.map(c => ({ id: c.id, name: c.name, group: c.group, taken: taken.has(c.id) })) });
      }
      if (!tokenOk(body.token)) return fail('Join again from the start.', 401);
      const th = await sha(body.token);
      if (body.action === 'claim') {
        const c = cands.find(x => x.id === body.cand_id); if (!c) return fail('Pick your name from the list.');
        const { data: cur } = await db.from('ge_players').select('token_hash').eq('event_id', ev.event_id).eq('cand_id', c.id).maybeSingle();
        if (cur && cur.token_hash !== th && !body.force) return json({ ok: false, taken: true, error: `${c.name} is already playing on another device.` }, 409);
        await db.from('ge_players').delete().eq('event_id', ev.event_id).eq('token_hash', th).neq('cand_id', c.id);   // a phone plays as one person
        const { error } = await db.from('ge_players').upsert({ event_id: ev.event_id, cand_id: c.id, token_hash: th, via: body.via === 'tablet' ? 'tablet' : 'phone', joined_at: new Date().toISOString() }, { onConflict: 'event_id,cand_id' });
        if (error) throw error;
        return json({ ok: true, name: c.name });
      }
      const { data: me } = await db.from('ge_players').select('cand_id').eq('event_id', ev.event_id).eq('token_hash', th).maybeSingle();
      if (!me) return json({ ok: false, rejoin: true, error: 'Pick your name again.' }, 401);
      const ix = qz ? qz.q_ix : -1, q = quiz.questions[ix], r = q ? quiz.rounds[q.round] : null;
      if (body.action === 'answer') {
        if (phase !== 'question' || Number(body.q_ix) !== ix || !q) return fail('Too late for that one.', 409);
        const started = Date.parse(qz.q_started_at), ends = Date.parse(qz.q_ends_at);
        if (now > ends + 1500) return fail('Time is up.', 409);
        const ms = Math.max(0, Math.min(now - started, r.secs * 1000));
        const ok = isCorrect(q, body.answer);
        const { data: prev } = await db.from('ge_answers').select('q_ix, correct, streak').eq('event_id', ev.event_id).eq('cand_id', me.cand_id).eq('q_ix', ix - 1).maybeSingle();
        const p = pointsFor(quiz, ix, ok, ms, prev && prev.correct ? prev.streak : 0);
        const { error } = await db.from('ge_answers').insert({ event_id: ev.event_id, cand_id: me.cand_id, q_ix: ix, answer: body.answer, ms, correct: ok, points: p.points, streak: p.streak });
        if (error) { if (error.code === '23505') return fail('You already answered.', 409); throw error; }
        return json({ ok: true, locked: true });
      }
      // state
      const out = { ok: true, title: ev.title, phase, me: { id: me.cand_id, name: (cands.find(c => c.id === me.cand_id) || {}).name }, server_now: now };
      if (q && ['question', 'reveal'].includes(phase)) {
        out.question = publicQ(q, r, ix, quiz.questions.length);
        out.ends_in_ms = Math.max(0, Date.parse(qz.q_ends_at) - now);
        const { data: mine } = await db.from('ge_answers').select('answer, correct, points, streak').eq('event_id', ev.event_id).eq('cand_id', me.cand_id).eq('q_ix', ix).maybeSingle();
        out.my_answer = mine ? (phase === 'reveal' ? mine : { answer: mine.answer }) : null;
        if (phase === 'reveal') { out.correct_answer = q.answer; out.fact = q.fact || ''; }
      }
      if (['reveal', 'leaderboard', 'podium'].includes(phase)) {
        const { data: all } = await db.from('ge_answers').select('cand_id, points, correct, answered_at').eq('event_id', ev.event_id);
        const lb = leaderboard(all || [], cands), pos = lb.findIndex(p => p.cand_id === me.cand_id);
        out.my_total = pos >= 0 ? { rank: pos + 1, points: lb[pos].points, correct: lb[pos].correct, of: lb.length } : { rank: null, points: 0, correct: 0, of: lb.length };
        if (phase !== 'reveal') out.top = lb.slice(0, phase === 'podium' ? 3 : 5).map(p => ({ name: p.name, points: p.points }));
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
      const [qz, { data: pl }, { data: ans }] = await Promise.all([getQ(), db.from('ge_players').select('cand_id, via, joined_at').eq('event_id', ev.event_id),
        db.from('ge_answers').select('cand_id, q_ix, answer, correct, points, answered_at').eq('event_id', ev.event_id)]);
      const cur = (ans || []).filter(a => a.q_ix === qz.q_ix);
      const q = quiz.questions[qz.q_ix];
      const dist = q && q.type !== 'order' ? q.options.map((_, i) => cur.filter(a => Number(a.answer) === i).length) : null;
      return json({ ok: true, server_now: now, quiz: qz, players: pl || [], answered: cur.length, correct_now: cur.filter(a => a.correct).length, dist,
        answered_ids: cur.map(a => a.cand_id), leaderboard: leaderboard(ans || [], cands) });
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
      const played = new Set([...(pl || []).map(p => p.cand_id), ...(ans || []).map(a => a.cand_id)]);
      const rows = [];
      for (const c of cands) {
        if (!played.has(c.id)) continue;
        const n = (ans || []).filter(a => a.cand_id === c.id && a.correct).length, item = quiz.theory_items[c.syl];
        if (!item) continue;
        rows.push({ event_id: ev.event_id, cand_id: c.id, item_code: item, result: n >= quiz.pass_mark ? 'pass' : 'fail', comment: `Quiz: ${n}/${QN} correct (pass ${quiz.pass_mark})`, scored_by: email + ' (quiz)', updated_at: new Date().toISOString() });
      }
      if (rows.length) { const { error } = await db.from('ge_marks').upsert(rows, { onConflict: 'event_id,cand_id,item_code' }); if (error) throw error; }
      return json({ ok: true, recorded: rows.length, not_played: cands.filter(c => !played.has(c.id)).map(c => c.name) });
    }
    if (body.action === 'host') {
      const qz = await getQ(), cmd = String(body.cmd || '');
      const set = async patch => { const { data, error } = await db.from('ge_quiz').upsert({ event_id: ev.event_id, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'event_id' }).select('*').single(); if (error) throw error; return json({ ok: true, quiz: data }); };
      const startQ = ix => { const r = roundOf(quiz, ix); return set({ phase: 'question', q_ix: ix, q_started_at: new Date(now + 1200).toISOString(), q_ends_at: new Date(now + 1200 + r.secs * 1000).toISOString() }); };
      if (cmd === 'open') return set({ phase: 'lobby', q_ix: qz.q_ix ?? -1 });
      if (cmd === 'close') return set({ phase: 'closed' });
      if (cmd === 'start') return startQ(Math.max(0, qz.q_ix < 0 ? 0 : qz.q_ix));
      if (cmd === 'reveal') { if (qz.phase !== 'question') return fail('No question is open.'); return set({ phase: 'reveal', q_ends_at: new Date(Math.min(now, Date.parse(qz.q_ends_at))).toISOString() }); }
      if (cmd === 'leaderboard') return set({ phase: 'leaderboard' });
      if (cmd === 'podium') return set({ phase: 'podium' });
      if (cmd === 'next') {
        const ix = qz.q_ix, cur = quiz.questions[ix], nxt = quiz.questions[ix + 1];
        if (qz.phase === 'question') return fail('Reveal the answer first.');
        if (ix < 0 || qz.phase === 'lobby') return startQ(0);
        if (!nxt) return set({ phase: qz.phase === 'podium' ? 'podium' : (qz.phase === 'leaderboard' ? 'podium' : 'leaderboard') });
        if (qz.phase === 'reveal' && nxt.round !== cur.round) return set({ phase: 'leaderboard' });   // leaderboard after every round
        return startQ(ix + 1);
      }
      if (cmd === 'back') { if (qz.q_ix <= 0) return set({ phase: 'lobby', q_ix: -1 }); await db.from('ge_answers').delete().eq('event_id', ev.event_id).eq('q_ix', qz.q_ix); return startQ(qz.q_ix); }
      if (cmd === 'reset') {
        if (!can('grading')) return fail('Only grading staff can reset the quiz.', 403);
        await db.from('ge_answers').delete().eq('event_id', ev.event_id);
        if (body.players) await db.from('ge_players').delete().eq('event_id', ev.event_id);
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

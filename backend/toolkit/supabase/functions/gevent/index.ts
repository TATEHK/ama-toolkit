// @ts-nocheck
// AMA Toolkit: grading events (grading-event-1/3.sql), first used for the Beyond 4th Dan grading on Sat 28 Nov 2026.
// The theory test lives here so answers are marked on the server and never sent to phones.
// It is a private test: each candidate works through it at their own pace on their phone within one time limit,
// can change answers until they submit, and only staff see results (no points, no leaderboard).
// The pass mark is every question right: a submission with any wrong sends back just those question numbers (never the
// answers) to redo, until all are right or time runs out.
//
// Deploy: Actions > "Deploy Supabase function" > gevent (JWT verification off: candidates join with the event code, no login;
// staff actions check the signed-in Black Belt Gradings login).
//
// Candidates (no sign-in; code = the event's join code, token = a random id the phone keeps):
//   { action: 'join', code }                               event title + the candidates to pick from
//   { action: 'claim', code, cand_id, token, force? }      sit the test as this candidate on this phone
//   { action: 'state', code, token }                       test status; while open, the questions (no answers) and my saved answers
//   { action: 'answer', code, token, q_ix, answer }        save or change an answer (index, or an array for put-in-order)
//   { action: 'submit', code, token }                      hand the test in: all right = done; otherwise { redo: [q_ix...] } to redo
// Staff (Authorization: Bearer <staff session>; app_permissions 'bb'):
// Staff = Black Belt Gradings logins, or Grading Floor logins with results/days access.
//   { action: 'host_state', event_id }                     status, who has joined, progress and (for staff) scores
//   { action: 'host', event_id, cmd, mins? }               cmd: open | start | extend | end | close | reset
//   { action: 'tablet', event_id, cand_id }                a token so a staff tablet can be used by someone without a phone
//   { action: 'quiz_record', event_id }                    write each candidate's theory item from their score (pass mark in the config)
// Setup: { action: 'seed', slug } with x-ge-seed (vault ge_seed_key): load a bundled event config.

import beyond4th from './beyond-4th-dan-2026-11-28.ts';
const BUNDLED = { 'beyond-4th-dan-2026-11-28': { title: 'Beyond 4th Dan Grading', join_code: '4DAN', starts_at: '2026-11-28T08:00:00+11:00', day_id: 'fc39317a-2476-4a9e-988f-f57699714df8', config: beyond4th,
  floor: { slot: '08:00', runsheet_id: 'a1a1a1a1-0004-4004-8004-0000000b4d28' } } };

// The Grading Floor's run sheet for an event (cb_runsheets format): one section per block, one step per event step
// (the seminar, then each group's assessment), each step naming the floor lines (groups) it's for. Step n here is
// step n of the event (ge_events.live), kept in step by grading-event-5.sql; the floor's event.js scores and times it.
const t12 = t => { const [h, m] = String(t).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };
export function floorDoc(title, slug, c) {
  const items = {}; for (const k in c.syllabi) for (const it of c.syllabi[k].items) items[it.code] = it;
  const its = codes => codes.map(code => ({ h: false, t: `${code} ${items[code].section}${items[code].text ? ': ' + items[code].text : ''}` }));
  const groupIds = c.groups.map(g => g.id);
  const sections = c.blocks.map((b, bi) => {
    const steps = [{ time: t12(b.time), mins: b.mins, groups: b.rollcall ? 'Roll call' : b.public ? 'Public hour: run from the MC screen' : (b.assess.length ? 'Everyone trains' : b.title), belt: '',
      items: [...(b.assess.length ? String(b.train).split(', ') : [b.train]).map(t => ({ h: false, t: t.trim() })), ...(b.notes ? [{ h: true, t: b.notes }] : [])],
      ...(b.assess.length ? { lines: groupIds } : {}), ge: { block: bi, step: 0 } }];
    b.assess.forEach((a, si) => {
      const st = { time: t12(a.time), mins: a.mins, groups: 'Group ' + a.groups.join(' + ') + (a.note ? ' · ' + a.note : ''), lines: a.groups, ge: { block: bi, step: si + 1 } };
      const sy = ['4D', 'L1', 'L3'].filter(k => a.items[k]);
      if (a.quiz) Object.assign(st, { belt: '', items: [{ h: false, t: 'Theory test on their phones. Run it from Theory test at the top of the floor.' }] });
      else if (sy.length === 1 && sy[0] === '4D') Object.assign(st, { belt: '4th Dan', items: its(a.items['4D']) });
      else if (sy.join() === 'L1,L3') Object.assign(st, { belt: '4th Dan Level 1', items: its(a.items.L1), belt2: '4th Dan Level 3', items2: its(a.items.L3) });
      else Object.assign(st, { belt: '', items: sy.flatMap(k => its(a.items[k])) });
      steps.push(st);
    });
    return { name: `${t12(b.time)} · ${b.title}`, steps };
  });
  return { title, note: 'Scoring, Theory test, MC and Results: the buttons at the top of the floor', window: c.hours || '', event_slug: slug,
    groups: c.groups.map((g, i) => ({ n: i + 1, name: g.id, belt: g.note || '', count: c.candidates.filter(x => x.group === g.id).length })), sections };
}

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
      // Grading Floor: the run sheet, assigned to the day's grading slot; each target belt starts at that slot; lines A1/A2/M
      let floor = null;
      if (b.floor && b.day_id) {
        const { error: re } = await db.from('cb_runsheets').upsert({ runsheet_id: b.floor.runsheet_id, title: b.title, programme: 'Taekwondo', doc: floorDoc(b.title, body.slug, b.config), updated_at: new Date().toISOString(), updated_by: 'gevent' }, { onConflict: 'runsheet_id' });
        if (re) throw re;
        const { data: day } = await db.from('cb_days').select('runsheets, belt_times').eq('day_id', b.day_id).single();
        const targets = [...new Set(b.config.candidates.map(x => x.to))];
        const bt = { ...(day.belt_times || {}) }; targets.forEach(t => { bt[t] = b.floor.slot; });
        await db.from('cb_days').update({ runsheets: { ...(day.runsheets || {}), [b.floor.slot]: b.floor.runsheet_id }, belt_times: bt }).eq('day_id', b.day_id);
        await db.from('ge_events').update({ floor_slot: b.floor.slot }).eq('event_id', data.event_id);
        const { data: had } = await db.from('cb_groups').select('group_id').eq('day_id', b.day_id).limit(1);
        let lines = 'kept';
        if (!(had && had.length) || body.floor_lines) {
          await db.from('cb_groups').delete().eq('day_id', b.day_id);
          const rows = b.config.groups.map((g, i) => { const ids = b.config.candidates.filter(x => x.group === g.id).map(x => x.id);
            return { day_id: b.day_id, ord: i, cone: String(i + 1), belt: null, spots: Math.max(ids.length, 1), rows: ids.length > 13 ? 2 : 1, status: 'future', slots: ids, opts: { title: g.id, belts: [], order: 'manual' } }; });
          const { data: all } = await db.from('cb_entries').select('entry_id').eq('day_id', b.day_id);
          const inEvent = new Set(b.config.candidates.map(x => x.id)), rest = (all || []).map(e => e.entry_id).filter(id => !inEvent.has(id));
          if (rest.length) rows.push({ day_id: b.day_id, ord: rows.length, cone: String(rows.length + 1), belt: null, spots: rest.length, rows: 1, status: 'future', slots: rest, opts: { title: 'Not in this grading', belts: [], order: 'manual' } });
          const { error: ge2 } = await db.from('cb_groups').insert(rows); if (ge2) throw ge2;
          lines = rows.length + ' lines';
        }
        floor = { runsheet: b.floor.runsheet_id, slot: b.floor.slot, lines };
      }
      return json({ ok: true, event_id: data.event_id, floor });
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
      const { data: me } = await db.from('ge_players').select('cand_id, submitted_at, rounds, first_score, redo').eq('event_id', ev.event_id).eq('token_hash', th).maybeSingle();
      if (!me) return json({ ok: false, rejoin: true, error: 'Pick your name again.' }, 401);
      const name = (cands.find(c => c.id === me.cand_id) || {}).name;
      if (body.action === 'answer' || body.action === 'submit') {
        if (me.submitted_at) return fail('You have already handed in your test.', 409);
        if (phase !== 'open') return fail(phase === 'ended' ? 'Time is up. Your saved answers count.' : 'The test hasn\'t started yet.', 409);
        if (body.action === 'submit') {
          const { data: mine } = await db.from('ge_answers').select('q_ix, correct').eq('event_id', ev.event_id).eq('cand_id', me.cand_id);
          const right = new Set((mine || []).filter(a => a.correct).map(a => a.q_ix));
          const wrong = quiz.questions.map((_, i) => i).filter(i => !right.has(i));
          const patch = { rounds: (me.rounds || 0) + 1 };
          if (me.first_score == null) patch.first_score = quiz.questions.length - wrong.length;
          if (!wrong.length) { patch.submitted_at = new Date().toISOString(); patch.redo = null; }
          else {
            patch.redo = wrong;
            await db.from('ge_answers').delete().eq('event_id', ev.event_id).eq('cand_id', me.cand_id).in('q_ix', wrong);   // they answer these again
          }
          await db.from('ge_players').update(patch).eq('event_id', ev.event_id).eq('cand_id', me.cand_id);
          return json({ ok: true, submitted: !wrong.length, redo: wrong.length ? wrong : null });
        }
        const ix = Number(body.q_ix), q = quiz.questions[ix];
        if (!q) return fail('Which question?');
        if (Array.isArray(me.redo) && !me.redo.includes(ix)) return fail('That question is already right. Answer the ones to redo.', 409);
        const clear = body.answer === null || (Array.isArray(body.answer) && !body.answer.length);
        if (clear) { await db.from('ge_answers').delete().eq('event_id', ev.event_id).eq('cand_id', me.cand_id).eq('q_ix', ix); return json({ ok: true, saved: null }); }
        const { error } = await db.from('ge_answers').upsert({ event_id: ev.event_id, cand_id: me.cand_id, q_ix: ix, answer: body.answer, correct: isCorrect(q, body.answer), points: 0, streak: 0, answered_at: new Date().toISOString() }, { onConflict: 'event_id,cand_id,q_ix' });
        if (error) throw error;
        return json({ ok: true, saved: ix });
      }
      // state
      const out = { ok: true, title: ev.title, phase, me: { id: me.cand_id, name }, submitted: !!me.submitted_at, redo: Array.isArray(me.redo) ? me.redo : null, total: quiz.questions.length, minutes: testMins(quiz), server_now: now };
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
    // Black Belt Gradings logins, or Grading Floor (Coloured Belts) logins with results/days access (grading-event-6.sql)
    const { data: pr } = await db.from('app_permissions').select('app, perm').eq('email', email).in('app', ['bb', 'cb']);
    const perms = (pr || []).flatMap(r => r.app === 'bb' ? [r.perm] : r.perm === 'admin' ? ['admin'] : ['results', 'days'].includes(r.perm) ? ['grading', 'scoring', 'results'] : []);
    const can = (...w) => perms.includes('admin') || w.some(x => perms.includes(x));
    if (!can('grading', 'scoring', 'results')) return fail('You need grading or results access for this grading.', 403);
    if (!/^[0-9a-f-]{36}$/i.test(String(body.event_id || ''))) return fail('Which event?');
    const { data: ev } = await db.from('ge_events').select('event_id, title, config, approved_at').eq('event_id', body.event_id).maybeSingle();
    if (!ev) return fail('That event wasn\'t found.', 404);
    const quiz = ev.config.quiz, cands = ev.config.candidates || [], QN = quiz.questions.length;
    const getQ = async () => (await db.from('ge_quiz').select('*').eq('event_id', ev.event_id).maybeSingle()).data || { phase: 'closed', q_ix: -1 };

    if (body.action === 'host_state') {
      const [qz, { data: pl }, { data: ans }] = await Promise.all([getQ(), db.from('ge_players').select('cand_id, via, joined_at, submitted_at, rounds, first_score, redo').eq('event_id', ev.event_id),
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
      const { data: pl } = await db.from('ge_players').select('cand_id, rounds, first_score, submitted_at').eq('event_id', ev.event_id);
      const pinfo = Object.fromEntries((pl || []).map(p => [p.cand_id, p]));
      const sat = new Set([...(pl || []).map(p => p.cand_id), ...(ans || []).map(a => a.cand_id)]);
      const rows = [];
      for (const c of cands) {
        if (!sat.has(c.id)) continue;
        const n = (ans || []).filter(a => a.cand_id === c.id && a.correct).length, item = quiz.theory_items[c.syl];
        if (!item) continue;
        const pi = pinfo[c.id] || {}, redos = Math.max(0, (pi.rounds || 0) - 1);
        const how = `${pi.first_score != null ? `first try ${pi.first_score}/${QN}` : 'not submitted'}${redos ? `, ${redos} redo round${redos === 1 ? '' : 's'}` : ''}`;
        const pass = n >= quiz.pass_mark;
        rows.push({ event_id: ev.event_id, cand_id: c.id, item_code: item, result: pass ? 'pass' : 'fail',
          comment: pass ? `Theory test: all ${QN} correct (${how})` : `Theory test: ${n}/${QN} correct when it ended (${how}; pass is ${quiz.pass_mark}/${QN})`, scored_by: email + ' (theory test)', updated_at: new Date().toISOString() });
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
        else await db.from('ge_players').update({ submitted_at: null, rounds: 0, first_score: null, redo: null }).eq('event_id', ev.event_id);
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

// AMA Toolkit: grading events inside the Grading Floor (grading-event-1..6.sql), first used for the Beyond 4th Dan grading
// on Sat 28 Nov 2026. When the open day has an event (ge_events.day_id), its tools live inside the floor's run sheet:
//   an assessment step    "Who's up" becomes pass/fail + note per candidate per item code (flags anything unscored)
//   the theory test step  sign-in QR, the private own-pace test (all right to pass, redo wrong ones), big screen, record results
//   the public hour step  the MC running order with count-up timers, quick scoring and shared showcases
//   Results (run sheet header)  a summary per candidate, the overall result, and an admin's Approve (locks everything)
// The floor's check-in is the roll call, and its live run sheet is the run of day (kept in step with ge_events.live).
// Everything here lives in one closure; the floor calls GE.attach(dayId) when a day loads and GE.mountStep(el, ge) per step.
(function () {
  const $1 = s => document.querySelector(s), $all = s => [...document.querySelectorAll(s)];
  const h = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = (m, ms) => { try { toast(m, ms || 3000); } catch (e) { alert(m); } };
  const db = () => sb;   // the floor's Supabase client
  // el: where the current view draws (a run sheet step's panel, or the full-screen overlay); inline: drawing in the run sheet
  const S = { ev: null, perms: [], marks: {}, outcomes: {}, view: 'score', sel: null, quiz: null, tv: false, open: false, el: null, inline: false, last: null };
  const live_el = () => S.el && document.body.contains(S.el) ? S.el : null;
  const inM = sel => live_el() ? [...S.el.querySelectorAll(sel)] : [];
  const can = (...w) => S.perms.includes('admin') || w.some(x => S.perms.includes(x));
  const C = () => S.ev.config, cands = () => C().candidates || [], cand = id => cands().find(c => c.id === id);
  // partners (config.partners: [[id, id], ...]): who each person works with for pads, self defence and sparring
  const partnerOf = id => { const pr = (C().partners || []).find(p => p.includes(id)); const o = pr && cand(pr.find(x => x !== id)); return o || null; };
  const partnerTag = id => { const o = partnerOf(id); return o ? ` · <span style="color:var(--ink,inherit);font-weight:600">Partner: ${h(o.name.split(' ')[0])}</span>` : ''; };
  const itemOf = code => { for (const k in C().syllabi) { const it = C().syllabi[k].items.find(i => i.code === code); if (it) return it; } return { section: code, text: '' }; };
  const mk = (cid, code) => S.marks[cid + '|' + code] || null;
  const live = () => (S.ev && S.ev.live) || {};
  const hhmm = t => { const [a, m] = String(t).split(':').map(Number); return `${((a + 11) % 12) + 1}:${String(m).padStart(2, '0')}${a < 12 ? 'am' : 'pm'}`; };
  const mmss = s => { const neg = s < 0; s = Math.abs(Math.round(s)); return (neg ? '+' : '') + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const shortName = n => { const p = String(n).split(' '); return p[0] + (p.length > 1 ? ' ' + p[p.length - 1][0] : ''); };
  const inGroups = gs => cands().filter(c => gs.includes(c.group));
  // Roll call = the floor's check-in. Before anyone is checked in, everyone counts as here.
  const anyIn = () => { try { return STUDENTS.some(s => !absentIds.has(s.id)); } catch (e) { return false; } };
  const isHere = id => { try { if (!anyIn()) return true; const f = entry2id[id]; return f == null ? true : !absentIds.has(f); } catch (e) { return true; } };

  /* ---------- data ---------- */
  async function loadLive() {
    if (!S.ev) return;
    const id = S.ev.event_id;
    const [ev, mk2, oc] = await Promise.all([
      db().from('ge_events').select('live, config, approved_at, approved_by').eq('event_id', id).maybeSingle(),
      db().from('ge_marks').select('cand_id, item_code, result, comment, scored_by, updated_at').eq('event_id', id),
      db().from('ge_outcomes').select('cand_id, outcome, note, set_by').eq('event_id', id)]);
    const OFF = window.Off, ck = 'ge_live_' + id;
    let got;
    if (window.amaAuthLost && await window.amaAuthLost(ev)) return;   // sign-in ended: say so instead of quietly showing old data
    if (ev.error || !ev.data || mk2.error || oc.error) {   // no signal: keep what's on screen (or the copy on this device)
      if (OFF && (OFF.netErr(ev) || OFF.netErr(mk2))) OFF.markOffline();
      if (Object.keys(S.marks).length || !OFF) return;
      got = OFF.cache(ck); if (!got) return;
    } else { got = { ev: ev.data, marks: mk2.data || [], outcomes: oc.data || [] }; if (OFF) OFF.cache(ck, got); }
    Object.assign(S.ev, got.ev);
    S.marks = {}; got.marks.forEach(r => S.marks[r.cand_id + '|' + r.item_code] = r);
    S.outcomes = {}; got.outcomes.forEach(r => S.outcomes[r.cand_id] = r);
    // changes made here that haven't reached the server yet stay on screen
    if (OFF) for (const op of OFF.pendingOf('ge_mark')) { const k = op.row.cand_id + '|' + op.row.item_code; if (op.del) delete S.marks[k]; else S.marks[k] = op.row; }
    if (OFF) for (const op of OFF.pendingOf('ge_outcome')) { if (op.del) delete S.outcomes[op.cand_id]; else S.outcomes[op.cand_id] = op.row; }
    if (OFF) for (const op of OFF.pendingOf('ge_live')) S.ev.live = { ...(S.ev.live || {}), ...op.patch };
  }
  // scoring, results and the live step are saved through offline.js: sent now, or kept here and sent when back
  const OQ = {
    ge_mark: op => op.del ? db().from('ge_marks').delete().eq('event_id', op.row.event_id).eq('cand_id', op.row.cand_id).eq('item_code', op.row.item_code)
                          : db().from('ge_marks').upsert(op.row, { onConflict: 'event_id,cand_id,item_code' }),
    ge_outcome: op => op.del ? db().from('ge_outcomes').delete().eq('event_id', op.event_id).eq('cand_id', op.cand_id) : db().from('ge_outcomes').upsert(op.row),
    ge_live: op => db().rpc('ge_live_set', { p_event: op.event_id, p_patch: op.patch }),
  };
  if (window.Off) Object.keys(OQ).forEach(t => Off.register(t, OQ[t]));
  const run1 = op => window.Off ? Off.run(op) : OQ[op.t](op);
  // A save refused because the sign-in has lapsed (expired or signed out): renew it and try once more;
  // if it still can't be saved, the red "Your sign-in has ended" bar comes up so it's one tap to fix
  const authErr = e => !!e && (/permission denied|jwt|not authenticated|401/i.test(String(e.message || e)) || e.code === '42501' || e.code === 'PGRST301');
  const save = async op => {
    let r = await run1(op);
    if (r && authErr(r.error)) {
      try { await db().auth.refreshSession(); } catch (e) {}
      r = await run1(op);
      if (r && authErr(r.error) && window.amaAuthLost) { window.amaAuthLost({ status: 401 }); r = { error: { message: 'Your sign-in has ended. Tap Sign in again at the top, then redo this one.' } }; }
    }
    return r;
  };
  async function setLive(patch) {
    S.ev.live = { ...live(), ...patch }; draw();
    const { error } = await save({ t: 'ge_live', event_id: S.ev.event_id, patch });
    if (error) say('Not saved: ' + error.message, 4000);
  }
  // Calls the test server. If the sign-in on this device has been ended elsewhere (the server says 401), refresh it
  // once and retry; if that can't be done, say so plainly so the fix (sign in again) is one tap away.
  async function call(body, token) {
    const r = await fetch(CFG.SUPABASE_URL + '/functions/v1/gevent', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_KEY, Authorization: 'Bearer ' + (token || '') }, body: JSON.stringify({ event_id: S.ev.event_id, ...body }) });
    return { r, j: await r.json().catch(() => ({})) };
  }
  async function fn(body) {
    const { data: { session } } = await db().auth.getSession();
    let { r, j } = await call(body, session && session.access_token);
    if (r.status === 401) {
      const { data } = await db().auth.refreshSession().catch(() => ({ data: {} }));
      if (data && data.session) ({ r, j } = await call(body, data.session.access_token));
      if (r.status === 401) { S.signedOut = true; throw new Error('Your sign-in has ended. Sign out and back in to use the test.'); }
    }
    S.signedOut = false;
    if (!r.ok || j.ok === false) throw new Error(j.error || 'That didn’t work.');
    return j;
  }
  async function setMark(cid, code, result, comment) {
    if (S.ev.approved_at) return say('Results are approved and locked.');
    if (!can('scoring', 'grading', 'results')) return say('Your login can’t score.');
    const key = cid + '|' + code, cur = S.marks[key] || {};
    const row = { event_id: S.ev.event_id, cand_id: cid, item_code: code, result: result === undefined ? cur.result || null : result, comment: comment === undefined ? cur.comment || null : comment, scored_by: ME, updated_at: new Date().toISOString() };
    if (!row.result && !row.comment) { delete S.marks[key]; draw(); const { error } = await save({ t: 'ge_mark', key: 'm:' + key, del: true, row }); if (error) say('Not saved: ' + error.message, 4000); return; }
    S.marks[key] = row; draw();
    const { error } = await save({ t: 'ge_mark', key: 'm:' + key, row });
    if (error) say('Not saved: ' + error.message, 4000);
  }
  const stepCodes = (st, c) => (st.items && st.items[c.syl]) || [];
  const unscoredIn = st => { const out = []; for (const c of inGroups(st.groups)) { if (!isHere(c.id)) continue; for (const code of stepCodes(st, c)) if (!(mk(c.id, code) || {}).result) out.push({ c, code }); } return out; };
  const allSteps = () => { const out = []; C().blocks.forEach((b, bi) => (b.assess || []).forEach((a, i) => out.push({ b: bi, s: i, block: b, st: a }))); return out; };

  /* ---------- overlay shell ---------- */
  function css() {
    if ($1('#geCss')) return;
    const st = document.createElement('style'); st.id = 'geCss';
    st.textContent = `
#geOv{position:fixed;inset:0;z-index:10000;background:var(--bg);color:var(--ink);display:flex;flex-direction:column;overflow:hidden;
 --bad:var(--danger,#d8362f);--bad-bg:color-mix(in srgb,var(--danger,#d8362f) 16%,var(--panel));--info:#4b8fe0;--okbg:color-mix(in srgb,var(--ok) 18%,var(--panel));--oktx:var(--ok);--display:"Barlow Semi Condensed","Arial Narrow",Arial,sans-serif}
#geOv .ge-top{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
#geOv .ge-top b{font:600 17px var(--display)}
#geOv .ge-tabs{display:flex;gap:4px;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:3px}
#geOv .ge-tabs button{border:0;background:transparent;color:var(--ink-2);font-weight:700;font-size:13.5px;padding:7px 14px;border-radius:999px;cursor:pointer}
#geOv .ge-tabs button.on{background:var(--accent);color:var(--accent-ink)}
#geOv .ge-x{margin-left:auto;background:var(--panel);border:1px solid var(--line);color:var(--ink);border-radius:10px;width:38px;height:38px;font-size:18px;cursor:pointer}
#geOv .ge-main{flex:1;overflow:auto;padding:16px}
#geOv .ge-btn,.ge-inline .ge-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--line-2);background:var(--panel);color:var(--ink);border-radius:10px;padding:8px 13px;font-weight:700;font-size:14px;min-height:38px;cursor:pointer;text-decoration:none}
#geOv .ge-btn.primary,.ge-inline .ge-btn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
#geOv .ge-btn.ok,.ge-inline .ge-btn.ok{background:var(--ok);border-color:var(--ok);color:#fff}
#geOv .ge-btn.ge-ghost,.ge-inline .ge-btn.ge-ghost{background:transparent}
#geOv .ge-btn.sm,.ge-inline .ge-btn.sm{min-height:30px;padding:4px 10px;font-size:12.5px}
#geOv .ge-btn.danger,.ge-inline .ge-btn.danger{border-color:var(--bad);color:var(--bad)}
#geOv .ge-muted,.ge-inline .ge-muted{color:var(--ink-2)}#geOv .ge-tiny,.ge-inline .ge-tiny{font-size:12px;color:var(--ink-3)}#geOv .ge-small,.ge-inline .ge-small{font-size:13px}
#geOv .ge-row,.ge-inline .ge-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}#geOv .ge-grow,.ge-inline .ge-grow{flex:1}
#geOv .ge-card,.ge-inline .ge-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
#geOv h2,.ge-inline h2,#geOv h3,.ge-inline h3{font-family:var(--display);margin:0}
#geOv .ge-tag,.ge-inline .ge-tag{display:inline-block;font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--bg);color:var(--ink-2);white-space:nowrap;border:1px solid var(--line)}
#geOv .ge-tag.ok,.ge-inline .ge-tag.ok{background:var(--okbg);color:var(--oktx);border-color:transparent}#geOv .ge-tag.bad,.ge-inline .ge-tag.bad{background:var(--bad-bg);color:var(--bad);border-color:transparent}
#geOv .ge-tag.warn,.ge-inline .ge-tag.warn{background:color-mix(in srgb,var(--warn) 18%,var(--panel));color:color-mix(in srgb,var(--warn) 70%,var(--ink));border-color:transparent}#geOv .ge-tag.now,.ge-inline .ge-tag.now{background:var(--accent);color:var(--accent-ink);border-color:transparent}
#geOv select,.ge-inline select,#geOv textarea,.ge-inline textarea,#geOv input[type=text],.ge-inline input[type=text]{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line-2);border-radius:10px;padding:8px 10px}
#geOv .srow,.ge-inline .srow{display:grid;grid-template-columns:minmax(170px,240px) 1fr auto;gap:10px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px 10px}
#geOv .srow.absent,.ge-inline .srow.absent{opacity:.5}
#geOv .ge-chips,.ge-inline .ge-chips{display:flex;gap:6px;flex-wrap:wrap}
#geOv .ge-chip,.ge-inline .ge-chip{border:1.5px solid var(--line-2);background:var(--bg);color:var(--ink);border-radius:10px;padding:6px 9px;min-width:64px;text-align:center;font-weight:700;font-size:13px;position:relative;cursor:pointer}
#geOv .ge-chip small,.ge-inline .ge-chip small{display:block;font-size:10px;font-weight:600;color:var(--ink-3)}
#geOv .ge-chip.pass,.ge-inline .ge-chip.pass{background:var(--okbg);border-color:var(--ok);color:var(--oktx)}#geOv .ge-chip.fail,.ge-inline .ge-chip.fail{background:var(--bad-bg);border-color:var(--bad);color:var(--bad)}
#geOv .ge-chip .c,.ge-inline .ge-chip .c{position:absolute;top:-5px;right:-5px;width:12px;height:12px;border-radius:50%;background:var(--info)}
@media (max-width:700px){#geOv .srow,.ge-inline .srow{grid-template-columns:1fr}}
#geOv .timer,.ge-inline .timer{font:700 60px/1 var(--display)}#geOv .timer.over,.ge-inline .timer.over{color:var(--bad)}#geOv .timer.soon,.ge-inline .timer.soon{color:var(--warn)}
#geOv .qz,.ge-inline .qz{display:flex;flex-direction:column;gap:16px;min-height:100%}
#geOv .qz.tv,.ge-inline .qz.tv{position:fixed;inset:0;z-index:2;background:var(--bg);padding:3vh 4vw}
#geOv .qtext,.ge-inline .qtext{font:700 clamp(28px,4.4vw,64px)/1.12 var(--display)}
#geOv .meta,.ge-inline .meta{display:flex;justify-content:center;gap:16px;font:700 clamp(16px,1.8vw,26px) var(--display);color:var(--ink-2)}
#geOv .ring,.ge-inline .ring{font:700 clamp(40px,6vw,96px)/1 var(--display);color:var(--accent)}
#geOv .lobby,.ge-inline .lobby{display:grid;grid-template-columns:auto 1fr;gap:4vw;align-items:center}
#geOv .lobby .qr,.ge-inline .lobby .qr{background:#fff;padding:16px;border-radius:16px;width:min(38vh,360px)}#geOv .lobby .qr svg,.ge-inline .lobby .qr svg{width:100%;height:auto;display:block}
#geOv .joined,.ge-inline .joined{display:flex;flex-wrap:wrap;gap:8px}
#geOv .joined span,.ge-inline .joined span{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-weight:700;color:var(--ink-3)}
#geOv .joined span.in,.ge-inline .joined span.in{background:var(--okbg);border-color:var(--ok);color:var(--oktx)}
#geOv .ctl,.ge-inline .ctl{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#geOv .qz.tv .ctl,.ge-inline .qz.tv .ctl{position:fixed;right:14px;bottom:14px;opacity:.15;transition:opacity .2s}#geOv .qz.tv .ctl:hover,.ge-inline .qz.tv .ctl:hover{opacity:1}
#geOv .mc,.ge-inline .mc{display:grid;grid-template-columns:1fr 360px;gap:16px}@media (max-width:900px){#geOv .mc,.ge-inline .mc{grid-template-columns:1fr}}
#geOv .mc .big h2,.ge-inline .mc .big h2{font-size:40px;line-height:1.05}#geOv .mc .big .sub,.ge-inline .mc .big .sub{font:700 30px var(--display);color:var(--accent);margin-top:6px}
#geOv .alist,.ge-inline .alist{display:flex;flex-direction:column;gap:4px;max-height:70vh;overflow:auto}
#geOv .aitem,.ge-inline .aitem{display:flex;gap:8px;align-items:center;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:10px;padding:7px 9px;font-size:14px;text-align:left;width:100%;cursor:pointer}
#geOv .aitem.now,.ge-inline .aitem.now{border-color:var(--accent)}#geOv .aitem.done,.ge-inline .aitem.done{opacity:.5}
#geOv table,.ge-inline table{border-collapse:collapse;width:100%}#geOv th,.ge-inline th,#geOv td,.ge-inline td{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top;font-size:14px}
#geOv th,.ge-inline th{color:var(--ink-2);font-size:12px;font-weight:600}
#geDlg{z-index:10001;background:var(--panel);color:var(--ink);border:1px solid var(--line-2);border-radius:16px;padding:18px;width:min(560px,94vw)}
#geDlg::backdrop{background:rgba(0,0,0,.6)}
#geDlg .ge-btn{display:inline-flex;align-items:center;border:1px solid var(--line-2);background:var(--bg);color:var(--ink);border-radius:10px;padding:8px 13px;font-weight:700;cursor:pointer}
#geDlg .ge-btn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}#geDlg .ge-btn.danger{border-color:#ef8a73;color:#ef8a73}
#geDlg textarea,#geDlg select{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line-2);border-radius:10px;padding:8px 10px;width:100%}
#geDlg .ge-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}#geDlg .ge-tiny{font-size:12px;color:var(--ink-3)}
.ge-inline{margin-top:14px;padding-top:12px;border-top:1px dashed var(--line);
 --bad:var(--danger,#d8362f);--bad-bg:color-mix(in srgb,var(--danger,#d8362f) 16%,var(--panel));--info:#4b8fe0;--okbg:color-mix(in srgb,var(--ok) 18%,var(--panel));--oktx:var(--ok);--display:"Barlow Semi Condensed","Arial Narrow",Arial,sans-serif}
@media print{#geOv .ge-top,#geOv .noprint,.ge-inline .noprint{display:none!important}#geOv{position:static;background:#fff;color:#000}}`;
    document.head.appendChild(st);
    if (!$1('#geDlg')) { const d = document.createElement('dialog'); d.id = 'geDlg'; document.body.appendChild(d); }
  }
  function openDlg(html) { const d = $1('#geDlg'); d.innerHTML = html; $all('#geDlg [data-x]').forEach(b => b.onclick = closeDlg); if (!d.open) d.showModal(); }
  function closeDlg() { const d = $1('#geDlg'); if (d.open) d.close(); }
  const TABS = [['score', 'Scoring'], ['quiz', 'Theory test'], ['mc', 'MC'], ['results', 'Results']];
  function open(view, sel) {
    if (!S.ev) return;
    css(); S.open = true; S.inline = false; if (view) S.view = view; if (sel) S.sel = sel;
    let el = $1('#geOv'); if (!el) { el = document.createElement('div'); el.id = 'geOv'; document.body.appendChild(el); }
    el.hidden = false;
    el.innerHTML = `<div class="ge-top noprint"><b>${h(S.ev.title)}</b><div class="ge-tabs">${TABS.map(([k, t]) => `<button data-gv="${k}">${t}</button>`).join('')}</div>
      <span class="ge-late" hidden></span><span class="ge-tiny" id="geSync"></span><button class="ge-x" title="Back to the floor">✕</button></div><div class="ge-main" id="geMain"></div>`;
    S.el = $1('#geMain');
    el.querySelector('.ge-x').onclick = close;
    $all('#geOv .ge-tabs [data-gv]').forEach(b => b.onclick = () => { S.view = b.dataset.gv; if (S.view !== 'quiz') S.tv = false; keepUi(); draw(); if (S.view === 'quiz') pollQuiz(); });
    loadLive().then(draw); if (S.view === 'quiz') pollQuiz();
    keepUi(); draw();
  }
  function close() {
    S.open = false; S.tv = false; keepUi(); const el = $1('#geOv'); if (el) { el.hidden = true; el.innerHTML = ''; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    S.el = null; if (S.last && document.body.contains(S.last.el)) mountStep(S.last.el, S.last.ge);   // back to the run sheet step it came from
  }
  // A run sheet step's own tool, drawn inside the step: scoring for an assessment, the test, or the MC screen
  function kindFor(ge) {
    if (!S.ev || !ge) return null; const b = C().blocks[ge.block]; if (!b) return null;
    if (b.public) return { view: 'mc' };
    const a = ge.step > 0 ? b.assess[ge.step - 1] : null;
    if (a && a.quiz) return { view: 'quiz' };
    if (a) return { view: 'score', sel: { b: ge.block, s: ge.step - 1 } };
    return null;
  }
  function mountStep(el, ge) {
    const k = kindFor(ge); if (!k || !el) return false;
    css(); S.last = { el, ge };
    if (S.open) return true;                   // the overlay (Results / big screen) is on top; the step draws again when it closes
    S.el = el; S.inline = true; S.view = k.view; if (k.sel) S.sel = k.sel; S.tv = false;
    if (k.view === 'quiz' && !S.quiz) { try { const c = JSON.parse(localStorage.getItem(QKEY()) || 'null'); if (c) { c.at = Date.now(); S.quiz = c; } } catch (e) {} }
    el.classList.add('ge-inline'); draw(); if (k.view === 'quiz') pollQuiz();
    return true;
  }
  const keepUi = () => { try { localStorage.setItem('ge_floor_ui', JSON.stringify({ day: S.ev && S.ev.day_id, open: S.open, view: S.view, tv: S.tv, sel: S.sel })); } catch (e) {} };
  // the screen redraws every few seconds: keep every scrolled box (running order, lists) and the page where they were
  function scrollKeys(root) { const out = []; if (!root) return out;
    root.querySelectorAll('*').forEach((e, i) => { if (e.scrollTop > 0 || e.scrollLeft > 0) out.push({ k: (e.id ? '#' + e.id : '') + '.' + String(e.className || '').split(' ')[0] + '@' + [...root.querySelectorAll(e.tagName + (e.className ? '.' + String(e.className).trim().split(/\s+/)[0] : ''))].indexOf(e), sel: e.tagName + (e.className ? '.' + String(e.className).trim().split(/\s+/)[0] : ''), e, t: e.scrollTop, l: e.scrollLeft }); });
    return out; }
  function draw() {
    if (!S.ev || !live_el()) return;
    if (S.open) $all('#geOv .ge-tabs [data-gv]').forEach(b => b.classList.toggle('on', b.dataset.gv === S.view));
    const root = S.el, keep = scrollKeys(root), ov = $1('#geOv'), ovTop = ov ? ov.scrollTop : 0, winY = window.scrollY;
    const box = root && root.closest && root.closest('.rsl-detail'), boxTop = box ? box.scrollTop : 0;   // inside the runsheet: its scrolling panel too
    ({ score: vScore, quiz: vQuiz, mc: vMc, results: vResults })[S.view]();
    keep.forEach(x => { const n = Number(x.k.split('@').pop()), el = root && root.querySelectorAll(x.sel)[n]; if (el) { el.scrollTop = x.t; el.scrollLeft = x.l; } });
    if (ov && ov.scrollTop !== ovTop) ov.scrollTop = ovTop;
    if (window.scrollY !== winY) window.scrollTo(0, winY);
    if (box && box.scrollTop !== boxTop) box.scrollTop = boxTop;
  }

  /* ---------- Scoring ---------- */
  function vScore() {
    const list = allSteps();
    if (!S.sel || !list.find(x => x.b === S.sel.b && x.s === S.sel.s)) { const L = live(), cb = C().blocks[L.block ?? 0]; S.sel = cb && L.step > 0 && cb.assess[L.step - 1] ? { b: L.block, s: L.step - 1 } : { b: list[0].b, s: list[0].s }; }
    const cur = list.find(x => x.b === S.sel.b && x.s === S.sel.s) || list[0], st = cur.st;
    const rows = inGroups(st.groups).sort((a, b) => (isHere(b.id) - isHere(a.id)) || 0);
    const legend = Object.entries(st.items).map(([k, codes]) => `<div class="ge-small"><b>${h(C().syllabi[k].name)}</b>: ${codes.map(c => `<b>${c}</b> ${h(itemOf(c).section)}`).join(' · ')}</div>`).join('');
    const un = unscoredIn(st).length, blockUn = (cur.block.assess || []).flatMap(unscoredIn);
    S.el.innerHTML = `${S.inline ? `<div class="ge-row" style="margin:6px 0 8px"><h3 class="ge-grow">Who's up · score each item</h3></div>` : `<div class="ge-row" style="margin-bottom:10px"><h2 class="ge-grow">Scoring</h2>
        <select id="geStep">${list.map(x => `<option value="${x.b}:${x.s}" ${x === cur ? 'selected' : ''}>${hhmm(x.st.time)} · ${h(x.block.title)} · Group ${h(x.st.groups.join(' + '))}</option>`).join('')}</select></div>`}
      ${S.ev.approved_at ? '<div class="ge-card" style="border-color:var(--ok);margin-bottom:10px">Results are approved and locked.</div>' : ''}
      ${st.quiz ? `<div class="ge-card" style="margin-bottom:10px">The theory item is marked from the test: open <b>Theory test</b> and press <b>Record theory results</b> once it has finished, or mark someone by hand below.</div>` : ''}
      <div style="display:flex;flex-direction:column;gap:4px;margin:8px 0 8px">${legend}</div>
      <div class="ge-row" style="gap:6px;flex-wrap:wrap;margin:0 0 12px"><span class="ge-small ge-muted">Pass whole group:</span>${[...new Set(Object.values(st.items).flat())].map(code => `<button class="ge-btn sm ge-ghost" data-gp="${code}" title="Pass ${code} for everyone not scored yet">${code}</button>`).join('')}</div>
      <div class="ge-row ge-small ge-muted" style="margin-bottom:8px"><span class="ge-grow">Tap an item: pass, then fail, then clear. <b>Note</b> adds a comment. Candidates not checked in on the floor are greyed.</span>
        <span style="${un ? 'color:var(--warn)' : ''}" class="${un ? '' : 'ge-tag ok'}">${un ? un + ' to score here' : 'All scored'}</span>
        ${blockUn.length && cur.block.assess.length > 1 ? `<button class="ge-btn sm" id="geBlockUn">${blockUn.length} unscored in this block</button>` : ''}</div>
      <div style="display:flex;flex-direction:column;gap:6px">${rows.map(c => { const codes = stepCodes(st, c), here = isHere(c.id);
        return `<div class="srow ${here ? '' : 'absent'}"><div><b>${h(c.name)}</b><div class="ge-tiny">Group ${h(c.group)} · ${h(c.to)}${c.dan_no ? ' · ' + c.dan_no : ''}${partnerTag(c.id)}${here ? '' : ' · not checked in'}</div></div>
          <div class="ge-chips">${codes.map(code => { const m = mk(c.id, code) || {}; return `<button class="ge-chip ${m.result || ''}" data-m="${c.id}|${code}" title="${h(itemOf(code).text)}">${code}<small>${m.result === 'pass' ? 'Pass' : m.result === 'fail' ? 'Fail' : h(itemOf(code).section)}</small>${m.comment ? '<span class="c"></span>' : ''}</button>`; }).join('')}</div>
          <div class="ge-row" style="gap:6px"><button class="ge-btn sm" data-all="${c.id}">All pass</button><button class="ge-btn sm ge-ghost" data-note="${c.id}">Note</button></div></div>`; }).join('')}</div>`;
    const gs = $1('#geStep'); if (gs) gs.onchange = e => { const [b, s] = e.target.value.split(':').map(Number); S.sel = { b, s }; keepUi(); draw(); };
    inM('[data-m]').forEach(x => x.onclick = () => { const [cid, code] = x.dataset.m.split('|'), m = mk(cid, code) || {}; setMark(cid, code, m.result === 'pass' ? 'fail' : m.result === 'fail' ? null : 'pass'); });
    inM('[data-all]').forEach(x => x.onclick = () => { const c = cand(x.dataset.all); stepCodes(st, c).forEach(code => { if (!(mk(c.id, code) || {}).result) setMark(c.id, code, 'pass'); }); });
    inM('[data-gp]').forEach(x => x.onclick = () => groupPass(st, x.dataset.gp));
    inM('[data-note]').forEach(x => x.onclick = () => noteDlg(cand(x.dataset.note), stepCodes(st, cand(x.dataset.note))));
    const bu = $1('#geBlockUn'); if (bu) bu.onclick = () => openDlg(`<h3>Not scored yet: ${h(cur.block.title)}</h3><div style="max-height:50vh;overflow:auto;margin:10px 0">${blockUn.map(u => `<div class="ge-small">${h(u.c.name)} · <b>${u.code}</b> ${h(itemOf(u.code).section)}</div>`).join('')}</div><button class="ge-btn" data-x>Close</button>`);
  }
  // ---- One person's scoring sheet (tap their photo on the run sheet's floor) ----
  // Each item for this step, opened up into its moves. A move marked Fail is written into the item's comment
  // ("Failed: <move>") and fails the item; Pass on the item passes it; the note box keeps any other comment.
  const FAILED = 'Failed: ';
  const failedMoves = cm => String(cm || '').split('\n').filter(l => l.startsWith(FAILED)).map(l => l.slice(FAILED.length));
  const otherNote = cm => String(cm || '').split('\n').filter(l => l && !l.startsWith(FAILED)).join('\n');
  const joinNote = (fails, note) => [...fails.map(f => FAILED + f), ...(note ? [note] : [])].join('\n') || null;
  function movesFor(code) {
    const fromRs = window.rsMovesFor ? window.rsMovesFor(code) : [];
    if (fromRs.length) return fromRs;
    const t = String(itemOf(code).text || ''); return t ? t.split(/;\s*/).map(x => x.trim()).filter(Boolean) : [];
  }
  // Pass one item for everyone in this step's group(s) who hasn't been scored on it yet (fails and scores already in are left alone)
  async function groupPass(st, code) {
    const who = inGroups(st.groups).filter(x => stepCodes(st, x).includes(code) && !(mk(x.id, code) || {}).result);
    for (const x of who) await setMark(x.id, code, 'pass');
    say(who.length ? `${code} passed for ${who.length} in Group ${st.groups.join(' + ')}` : `Everyone already has a score for ${code}`, 2500);
  }
  function candSheet(cid) {
    if (!S.ev) return false; css();
    const c = cand(cid); if (!c) return false;
    const list = allSteps(), cur = S.sel && list.find(x => x.b === S.sel.b && x.s === S.sel.s);
    if (!cur) return false;
    const st = cur.st, codes = stepCodes(st, c); if (!codes.length) return false;
    const paint = () => {
      openDlg(`<div class="ge-row" style="align-items:flex-start"><div class="ge-grow"><h3 style="margin:0">${h(c.name)}</h3><div class="ge-tiny">Group ${h(c.group)} · ${h(c.to)}${partnerTag(c.id)}${isHere(c.id) ? '' : ' · not checked in'}</div></div>
          <button class="ge-btn primary" data-allp>All pass</button></div>
        <div style="max-height:62vh;overflow:auto;margin:12px 0">${codes.map(code => { const m = mk(c.id, code) || {}, fails = failedMoves(m.comment), mv = movesFor(code);
          return `<details class="cs-item" ${fails.length || m.result === 'fail' ? 'open' : ''} style="border:1px solid var(--line-2);border-radius:12px;padding:8px 10px;margin:0 0 8px">
            <summary style="display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none"><b>${code}</b><span class="ge-grow">${h(itemOf(code).section)}</span>
              <span class="ge-tag ${m.result === 'pass' ? 'ok' : ''}" style="${m.result === 'fail' ? 'color:#ef8a73;border-color:#ef8a73' : ''}">${m.result === 'pass' ? 'Pass' : m.result === 'fail' ? 'Fail' : 'Not scored'}</span></summary>
            <div class="ge-row" style="gap:6px;margin:8px 0"><button class="ge-btn sm" data-ir="${code}|pass">Pass</button><button class="ge-btn sm danger" data-ir="${code}|fail">Fail</button><button class="ge-btn sm" data-ir="${code}|">Clear</button><span class="ge-grow"></span><button class="ge-btn sm ge-ghost" data-gp="${code}">Pass whole group</button></div>
            ${mv.map((t, i) => { const bad = fails.includes(t); return `<div class="ge-row" style="gap:8px;padding:5px 0;border-top:1px solid var(--line)"><span class="ge-grow ge-small" style="${bad ? 'color:#ef8a73;font-weight:700' : ''}">${bad ? '✗ ' : ''}${h(t)}</span><button class="ge-btn sm ${bad ? 'danger' : ''}" data-mv="${code}|${i}">${bad ? 'Failed · undo' : 'Fail this move'}</button></div>`; }).join('')}
            <textarea rows="2" placeholder="Note for ${code} (optional)" data-nt="${code}" style="margin-top:6px">${h(otherNote(m.comment))}</textarea></details>`; }).join('')}</div>
        <div class="ge-row"><button class="ge-btn" data-prof>Open profile</button><span class="ge-grow"></span><button class="ge-btn primary" data-x>Done</button></div>`);
      const d = $1('#geDlg');
      d.querySelector('[data-allp]').onclick = async () => { for (const code of codes) { const m = mk(c.id, code) || {}; if (!failedMoves(m.comment).length) await setMark(c.id, code, 'pass'); } paint(); };
      d.querySelectorAll('[data-ir]').forEach(b => b.onclick = async () => { const [code, r] = b.dataset.ir.split('|'); const m = mk(c.id, code) || {};
        await setMark(c.id, code, r || null, r === 'pass' ? joinNote([], otherNote(m.comment)) : undefined); paint(); });
      d.querySelectorAll('[data-mv]').forEach(b => b.onclick = async () => { const [code, i] = b.dataset.mv.split('|'), t = movesFor(code)[+i], m = mk(c.id, code) || {};
        let fails = failedMoves(m.comment); fails = fails.includes(t) ? fails.filter(x => x !== t) : [...fails, t];
        await setMark(c.id, code, fails.length ? 'fail' : (m.result === 'fail' ? null : m.result || null), joinNote(fails, otherNote(m.comment))); paint(); });
      d.querySelectorAll('[data-gp]').forEach(b => b.onclick = async () => { await groupPass(st, b.dataset.gp); paint(); });
      d.querySelectorAll('[data-nt]').forEach(ta => ta.onchange = () => { const code = ta.dataset.nt, m = mk(c.id, code) || {}; setMark(c.id, code, undefined, joinNote(failedMoves(m.comment), ta.value.trim())); });
      const pr = d.querySelector('[data-prof]'); if (pr) pr.onclick = () => { closeDlg(); if (window.openProfileByEntry) window.openProfileByEntry(c.id); };
    };
    paint(); return true;
  }
  function noteDlg(c, codes) {
    openDlg(`<h3>${h(c.name)}</h3><p class="ge-tiny">Comments are for the panel and Mark. Nothing goes to families until results are approved.</p>
      ${codes.map(code => { const m = mk(c.id, code) || {}; return `<div style="margin:8px 0"><div class="ge-tiny" style="font-weight:700">${code} · ${h(itemOf(code).section)} ${m.result ? `(${m.result})` : ''}</div><textarea rows="2" data-n="${code}">${h(m.comment || '')}</textarea></div>`; }).join('')}
      <div class="ge-row"><button class="ge-btn primary" id="geNSave">Save</button><button class="ge-btn" data-x>Cancel</button></div>`);
    $1('#geNSave').onclick = () => { $all('#geDlg [data-n]').forEach(t => { const code = t.dataset.n, v = t.value.trim() || null, was = (mk(c.id, code) || {}).comment || null; if (v !== was) setMark(c.id, code, undefined, v); }); closeDlg(); };
  }

  /* ---------- Theory test (private, own pace; all right to pass, wrong ones come back to redo) ---------- */
  // The test's state: shown straight away from the last copy on this device, then refreshed every 2 seconds.
  // If the server can't be reached the panel says so (and keeps the sign-in QR up) instead of sitting on "Loading".
  const QKEY = () => 'ge_quiz_' + (S.ev && S.ev.event_id);
  async function pollQuiz() {
    if (S.signedOut && S.quizTry && Date.now() - S.quizTry < 15000) return;   // don't hammer while signed out
    S.quizTry = Date.now();
    try { S.quiz = await fn({ action: 'host_state' }); S.quiz.at = Date.now(); S.quizErr = null; try { localStorage.setItem(QKEY(), JSON.stringify(S.quiz)); } catch (e) {} }
    catch (e) { S.quizErr = e.message || 'Can\u2019t reach the test'; if (!S.quiz) { try { const c = JSON.parse(localStorage.getItem(QKEY()) || 'null'); if (c) { c.at = Date.now(); c.stale = true; S.quiz = c; } } catch (x) {} } }
    if (live_el() && S.view === 'quiz' && !$1('#geDlg').open) vQuiz();
  }
  async function qCmd(cmd, extra = {}) { try { await fn({ action: 'host', cmd, ...extra }); await pollQuiz(); } catch (e) { say(e.message, 4000); } }
  const testLeft = () => { const hs = S.quiz, z = hs && hs.quiz; if (!z || !z.q_ends_at) return 0; const skew = hs.server_now - hs.at; return Math.max(0, Math.ceil((Date.parse(z.q_ends_at) - (Date.now() + skew)) / 1000)); };
  function vQuiz() {
    const Q = C().quiz, hs = S.quiz, z = hs && hs.quiz;
    let ph = z ? z.phase : 'closed'; if (ph === 'open' && testLeft() <= 0) ph = 'ended';
    const pl = Object.fromEntries(((hs && hs.players) || []).map(p => [p.cand_id, p]));
    const nIn = Object.keys(pl).length, nSub = Object.values(pl).filter(p => p.submitted_at).length, total = (hs && hs.total) || Q.questions.length;
    const url = location.origin + '/q/#' + S.ev.join_code;
    let body = '';
    if (!hs) {   // first moment, or the server can't be reached: the sign-in QR is still useful
      let qr = ''; try { const g = qrcode(0, 'M'); g.addData(url); g.make(); qr = g.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch (e) { qr = ''; }
      body = `<div class="lobby"><div class="qr" style="width:min(30vh,240px)">${qr}</div><div><div class="qtext" style="font-size:clamp(22px,3vw,40px)">Theory test sign-in</div><p style="font-size:18px;margin:8px 0">${h(location.host)}/q · code <b style="color:var(--accent);letter-spacing:.1em">${h(S.ev.join_code)}</b></p>
        <p class="ge-small" style="${S.quizErr ? 'color:var(--bad)' : 'color:var(--ink-3)'}">${S.quizErr ? h(S.quizErr) + (S.signedOut ? '' : ' · trying again…') : 'Connecting…'}</p>${S.signedOut ? '<button class="ge-btn" id="geReSign">Sign in again</button>' : ''}</div></div>`;
    }
    else if (ph === 'closed') body = `<div class="ge-card" style="max-width:680px"><h2>Theory test</h2><p class="ge-muted">${total} questions. Each candidate signs in on their own phone and works through the test at their own pace for ${Q.minutes || 30} minutes. Pass is all ${total} right: anyone with a wrong answer is told only which questions to redo (not the answers) and redoes just those. Private: only staff see scores, here.</p><button class="ge-btn primary" data-q="open">Open sign-in</button></div>`;
    else if (ph === 'lobby') {
      let qr = ''; try { const g = qrcode(0, 'M'); g.addData(url); g.make(); qr = g.createSvgTag({ cellSize: 8, margin: 2, scalable: true }); } catch (e) { qr = ''; }
      body = `<div class="lobby"><div class="qr">${qr}</div><div><div class="qtext">Theory test: scan to sign in</div><p style="font-size:clamp(18px,2vw,30px);margin:10px 0">or go to <b>${h(location.host)}/q</b> and enter <b style="color:var(--accent);letter-spacing:.1em">${h(S.ev.join_code)}</b></p>
        <p class="meta" style="justify-content:flex-start">${nIn} of ${cands().length} signed in</p><div class="joined">${cands().map(c => `<span class="${pl[c.id] ? 'in' : ''}">${h(shortName(c.name))}</span>`).join('')}</div></div></div>`;
    } else {
      const big = `<div style="text-align:center;margin-top:${S.tv ? '14vh' : '6px'}"><div class="meta">${ph === 'ended' ? 'Test finished' : 'Theory test in progress'}</div>
        <div class="ring" id="geLeft" style="${ph !== 'ended' && testLeft() < 120 ? 'color:var(--bad);' : ''}font-size:${S.tv ? 'clamp(80px,16vw,240px)' : '80px'}">${ph === 'ended' ? '0:00' : mmss(testLeft())}</div>
        <div class="qtext" style="font-size:clamp(22px,3vw,44px)">${nSub} of ${nIn} finished</div>${ph !== 'ended' && S.tv ? '<p class="ge-muted" style="font-size:clamp(16px,1.8vw,26px)">Work at your own pace. If any answers are wrong when you submit, your phone shows which questions to redo.</p>' : ''}</div>`;
      // status of each candidate, so the table can lead with whoever needs the panel
      const stOf = p => !p ? 'out' : p.submitted_at ? 'done' : ph === 'ended' ? 'timeup' : Array.isArray(p.redo) ? 'redo' : 'ans';
      const ORDER = { timeup: 0, redo: 1, ans: 2, out: 3, done: 4 }, LBL = { timeup: 'Time up', redo: 'Redoing', ans: 'Answering', out: 'Not signed in', done: 'All right' };
      const cnt = {}; cands().forEach(c => { const k = stOf(pl[c.id]); cnt[k] = (cnt[k] || 0) + 1; });
      const rowsC = cands().slice().sort((a, b) => ORDER[stOf(pl[a.id])] - ORDER[stOf(pl[b.id])] || (pl[b.id] ? pl[b.id].answered : 0) - (pl[a.id] ? pl[a.id].answered : 0) || a.name.localeCompare(b.name));
      const tagOf = (k, p) => k === 'done' ? '<span class="ge-tag ok">All right</span>' : k === 'timeup' ? '<span class="ge-tag warn">Time up</span>' : k === 'redo' ? `<span class="ge-tag warn">Redoing ${p.redo.length}</span>` : k === 'ans' ? '<span class="ge-tag now">Answering</span>' : '<span class="ge-tag">Not signed in</span>';
      const barOf = p => { const w = p ? Math.round(p.answered / total * 100) : 0; return `<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;min-width:60px;height:6px;border-radius:9px;background:var(--line);overflow:hidden"><i style="display:block;height:100%;width:${w}%;background:var(--ok)"></i></div><span class="ge-tiny" style="min-width:42px">${p ? p.answered + '/' + total : '—'}</span></div>`; };
      // live: the question each person is on, and which ones they have wrong right now (tap one to see what they picked)
      const upTo = (p, k) => !p || k === 'done' || k === 'out' ? '—' : p.at_q == null ? (p.answered ? `<span class="ge-tiny">about Q${Math.min(p.answered + 1, total)}</span>` : '<span class="ge-tiny">starting</span>') : `<b>Q${p.at_q + 1}</b>${p.seen_at && Date.now() - Date.parse(p.seen_at) > 20000 ? ' <span class="ge-tiny" style="color:var(--warn)">phone idle</span>' : ''}`;
      const wrongOf = (c, p) => !p || !(p.wrong || []).length ? (p && p.answered ? '<span class="ge-tiny">none</span>' : '—') : p.wrong.slice().sort((a, b) => a.ix - b.ix).map(w => `<button class="ge-chip fail" style="padding:3px 7px;min-width:0" data-qw="${c.id}|${w.ix}">Q${w.ix + 1}</button>`).join(' ');
      const summary = `<div class="ge-row" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">${['timeup', 'redo', 'ans', 'out', 'done'].filter(k => cnt[k]).map(k => `<span class="ge-tag${k === 'done' ? ' ok' : k === 'timeup' || k === 'redo' ? ' warn' : k === 'ans' ? ' now' : ''}">${cnt[k]} ${LBL[k].toLowerCase()}</span>`).join('')}</div>`;
      // the questions catching people out (staff only): sent back to redo, or wrong right now
      const qs = ((hs && hs.qstats) || []).map((x, i) => ({ i, n: (x.redo || 0) + (x.wrong || 0), ...x })).filter(x => x.n).sort((a, b) => b.n - a.n).slice(0, 5);
      const missed = qs.length ? `<div class="ge-card" style="margin-top:12px"><div class="ge-row" style="margin-bottom:6px"><h3 class="ge-grow">Questions catching people out</h3><span class="ge-tiny">Only staff see this</span></div>
        ${qs.map(x => { const q = Q.questions[x.i] || {}; return `<div style="display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line)"><b style="min-width:30px">Q${x.i + 1}</b><span class="ge-grow">${h(q.text || '')}${q.section ? ` <span class="ge-tiny">· ${h(q.section)}</span>` : ''}</span><span class="ge-tag warn">${x.n} ${x.redo ? 'redoing' : 'wrong'}</span></div>`; }).join('')}</div>` : '';
      const table = S.tv ? '' : `<div class="ge-card" style="margin-top:16px;overflow:auto"><div class="ge-row" style="margin-bottom:6px"><h3 class="ge-grow">Candidates</h3><span class="ge-tiny">Only staff see this</span></div>${summary}<table><thead><tr><th>Candidate</th><th>Status</th><th>Answered</th><th>Up to</th><th>Wrong now</th><th>First try</th><th>Rounds</th>${ph === 'ended' ? '<th>Right now</th><th>Theory</th>' : ''}</tr></thead><tbody>
        ${rowsC.map(c => { const p = pl[c.id], k = stOf(p); return `<tr><td>${h(c.name)}<div class="ge-tiny">Group ${h(c.group)}</div></td><td>${tagOf(k, p)}${p && p.via === 'tablet' ? ' <span class="ge-tiny">tablet</span>' : ''}</td>
          <td>${barOf(p)}</td><td>${upTo(p, k)}</td><td>${wrongOf(c, p)}</td><td>${p && p.first_score != null ? p.first_score + ' / ' + total : '—'}</td><td>${p && p.rounds ? p.rounds : '—'}</td>${ph === 'ended' ? `<td><b>${p ? p.correct : '—'}</b>${p ? ' / ' + total : ''}</td><td>${p ? (p.correct >= Q.pass_mark ? '<span class="ge-tag ok">Pass</span>' : '<span class="ge-tag bad">Not passed</span>') : ''}</td>` : ''}</tr>`; }).join('')}</tbody></table></div>${missed}`;
      body = big + table;
    }
    const ctl = !hs ? '' : `<div class="ctl noprint">
      ${ph === 'lobby' ? `<button class="ge-btn primary" data-q="start">Start the test (${Q.minutes || 30} min)</button>` : ''}
      ${ph === 'open' ? `<button class="ge-btn" data-q="extend">+5 minutes</button><button class="ge-btn primary" id="geTEnd">End the test</button>` : ''}
      ${ph === 'ended' ? `<button class="ge-btn ok" id="geRec">Record theory results</button><button class="ge-btn" data-q="extend">Reopen +5 min</button>` : ''}
      ${ph !== 'closed' ? `<button class="ge-btn" id="geTv">${S.tv ? 'Exit big screen' : 'Big screen'}</button><button class="ge-btn" id="geTab">Staff tablet</button>` : ''}
      ${ph !== 'closed' && can('grading') ? `<button class="ge-btn ge-ghost danger" id="geReset">Reset</button>` : ''}</div>`;
    S.el.innerHTML = `<div class="qz ${S.tv ? 'tv' : ''}">${hs && S.quizErr ? `<div class="ge-small noprint" style="color:var(--bad)">${h(S.quizErr)} · showing the last update${S.signedOut ? '' : ', trying again…'}</div>${S.signedOut ? '<button class="ge-btn" id="geReSign">Sign in again</button>' : ''}` : ''}${body}${ctl}</div>`;
    const reSign = S.el.querySelector('#geReSign'); if (reSign) reSign.onclick = async () => { try { await db().auth.signOut({ scope: 'local' }); } catch (e) {} location.reload(); };
    inM('[data-q]').forEach(b => b.onclick = () => qCmd(b.dataset.q));
    inM('[data-qw]').forEach(b => b.onclick = () => { const [cid, ix] = b.dataset.qw.split('|'), q = Q.questions[+ix] || {}, c = cand(cid) || {}, p = pl[cid] || {}, w = (p.wrong || []).find(x => x.ix === +ix) || {};
      const opt = v => Array.isArray(v) ? v.map(i => (q.options || [])[i]).join(' → ') : (q.options || [])[v] ?? String(v ?? '');
      openDlg(`<h3>${h(c.name || '')} · Q${+ix + 1}</h3><p style="margin:8px 0">${h(q.text || '')}</p><div class="ge-small" style="color:#ef8a73">They picked: <b>${h(opt(w.answer))}</b></div><div class="ge-small" style="color:var(--ok);margin-top:4px">Right answer: <b>${h(opt(q.answer))}</b></div>${q.fact ? `<div class="ge-tiny" style="margin-top:6px">${h(q.fact)}</div>` : ''}<div class="ge-row" style="margin-top:12px"><span class="ge-grow"></span><button class="ge-btn primary" data-x>Close</button></div>`); });
    const te = $1('#geTEnd'); if (te) te.onclick = () => { const left = nIn - nSub; if (left && !confirm(`${left} candidate${left === 1 ? ' hasn’t' : 's haven’t'} got every answer right yet. End the test now? They won’t pass the theory item unless you reopen it.`)) return; qCmd('end'); };
    const tv = $1('#geTv'); if (tv) tv.onclick = () => {
      if (S.inline) { open('quiz'); S.tv = true; keepUi(); if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); vQuiz(); return; }
      if (S.tv && S.last) { close(); return; }   // leaving the big screen goes back to the run sheet step
      S.tv = !S.tv; keepUi(); if (S.tv && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); else if (!S.tv && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      vQuiz(); };
    const tb = $1('#geTab'); if (tb) tb.onclick = () => {
      openDlg(`<h3>Use this tablet for a candidate</h3><p class="ge-tiny">For someone without a phone. Their test opens in a new tab on this device.</p>
        <select id="geTbWho">${cands().map(c => `<option value="${c.id}">${h(c.name)}${pl[c.id] ? ' (already signed in)' : ''}</option>`).join('')}</select>
        <div class="ge-row" style="margin-top:12px"><button class="ge-btn primary" id="geTbGo">Open their test</button><button class="ge-btn" data-x>Cancel</button></div>`);
      $1('#geTbGo').onclick = async () => { try { const r = await fn({ action: 'tablet', cand_id: $1('#geTbWho').value }); window.open(`/q/#${S.ev.join_code}/${r.token}`, '_blank'); closeDlg(); } catch (e) { say(e.message); } };
    };
    const rc = $1('#geRec'); if (rc) rc.onclick = async () => { try { const r = await fn({ action: 'quiz_record' }); say(`Theory recorded for ${r.recorded}${r.not_sat.length ? '. Didn’t sit: ' + r.not_sat.join(', ') : ''}`, 7000); await loadLive(); } catch (e) { say(e.message, 5000); } };
    const rs = $1('#geReset'); if (rs) rs.onclick = () => {
      openDlg(`<h3>Reset the test?</h3><p class="ge-tiny">Clears every answer and goes back to sign-in. Use it after a test run.</p><label class="ge-row ge-tiny"><input type="checkbox" id="geRsP"> Also sign everyone out</label>
        <div class="ge-row" style="margin-top:12px"><button class="ge-btn danger" id="geRsGo">Reset</button><button class="ge-btn" data-x>Cancel</button></div>`);
      $1('#geRsGo').onclick = () => { const all = $1('#geRsP').checked; closeDlg(); qCmd('reset', { players: all }); };
    };
  }

  /* ---------- MC (public hour) ---------- */
  function vMc() {
    const acts = C().acts, L = live(), ai = Math.min(L.act ?? 0, acts.length - 1), a = acts[ai];
    const who = (a.who || []).map(cand).filter(Boolean);
    const guide = a.kind === 'showcase' ? (a.secs_per_person || 45) * Math.max(1, who.length) : (a.mins || 0) * 60;
    const started = L.act === ai ? L.act_started : null;
    const leftMins = acts.slice(ai).reduce((s, x) => s + (x.kind === 'showcase' ? (x.secs_per_person || 45) * Math.max(1, (x.who || []).length) / 60 : x.mins || 0), 0);
    const n = new Date(), today = n.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const slack = today === C().date ? Math.round((new Date(today + 'T16:00:00+11:00') - n) / 60000 - leftMins) : null;
    const codes = a.items || [];
    S.el.innerHTML = `<div class="mc"><div class="ge-card big">
        <div class="ge-row"><span class="ge-tag now">${ai + 1} of ${acts.length}</span><span class="ge-muted ge-small">${h({ talk: 'MC', patterns: 'Patterns', board: 'Board breaking', showcase: 'Showcase' }[a.kind] || '')}</span><span class="ge-grow"></span>
        ${slack == null ? '' : `<span class="ge-small" style="${slack < 0 ? 'color:var(--bad)' : 'color:var(--ink-2)'}">${slack >= 0 ? slack + ' min spare before 4:00pm' : -slack + ' min over: tighten changeovers'}</span>`}</div>
        <h2 style="margin-top:10px">${h(a.title)}</h2>${a.sub ? `<div class="sub">${h(a.sub)}</div>` : ''}
        ${who.length > 1 ? `<p class="ge-muted" style="font-size:18px">${who.map(c => h(c.name)).join(', ')}</p>` : ''}
        <div class="ge-row" style="align-items:flex-end;margin-top:12px">
          <div><div class="ge-tiny">${started ? 'Running' : 'Not started'} · guide ${mmss(guide)}</div><div class="timer" data-getimer-up="${started || ''}" data-guide="${guide}"></div></div><span class="ge-grow"></span>
          ${started ? '' : '<button class="ge-btn primary" id="geMStart">Start timer</button>'}
          <button class="ge-btn" id="geMBack">Back</button><button class="ge-btn primary" id="geMNext">Next act</button></div>
        ${codes.length && who.length ? `<div style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px"><div class="ge-tiny" style="margin-bottom:6px">Panel: quick score for this act</div>
          ${who.map(c => { const code = codes.find(x => x.split('-')[0] === c.syl); if (!code) return ''; const m = mk(c.id, code) || {};
            return `<div class="ge-row" style="margin:4px 0"><span class="ge-grow">${h(c.name)} <span class="ge-tiny">${code}</span></span><button class="ge-btn sm ${m.result === 'pass' ? 'ok' : ''}" data-ms="${c.id}|${code}|pass">Pass</button><button class="ge-btn sm ${m.result === 'fail' ? 'danger' : ''}" data-ms="${c.id}|${code}|fail">Fail</button><button class="ge-btn sm ge-ghost" data-mn="${c.id}|${code}">Note</button></div>`; }).join('')}</div>` : ''}
      </div>
      <div class="ge-card"><div class="ge-row" style="margin-bottom:8px"><h3 class="ge-grow">Running order</h3>${can('grading') ? '<button class="ge-btn sm" id="geMEdit">Edit showcases</button>' : ''}</div>
        <div class="alist">${acts.map((x, i) => `<button class="aitem ${i === ai ? 'now' : i < ai ? 'done' : ''}" data-a="${i}"><span class="ge-tiny" style="min-width:20px">${i + 1}</span><span class="ge-grow"><b>${h(x.kind === 'board' || x.kind === 'showcase' ? x.sub : x.title)}</b>${x.kind === 'showcase' && (x.who || []).length > 1 ? ' <span class="ge-tag">shared</span>' : ''}<br><span class="ge-tiny">${h(x.kind === 'board' ? 'Board breaking' : x.kind === 'showcase' ? 'Showcase' : x.sub || '')}</span></span></button>`).join('')}</div></div></div>`;
    inM('[data-a]').forEach(x => x.onclick = () => setLive({ act: +x.dataset.a, act_started: null }));
    $1('#geMNext').onclick = () => setLive({ act: Math.min(acts.length - 1, ai + 1), act_started: ai + 1 < acts.length ? new Date().toISOString() : null });
    $1('#geMBack').onclick = () => setLive({ act: Math.max(0, ai - 1), act_started: null });
    const ms = $1('#geMStart'); if (ms) ms.onclick = () => setLive({ act: ai, act_started: new Date().toISOString() });
    inM('[data-ms]').forEach(x => x.onclick = () => { const [c, code, r] = x.dataset.ms.split('|'); setMark(c, code, (mk(c, code) || {}).result === r ? null : r); });
    inM('[data-mn]').forEach(x => x.onclick = () => { const [c, code] = x.dataset.mn.split('|'); noteDlg(cand(c), [code]); });
    const me = $1('#geMEdit'); if (me) me.onclick = editActs;
    tick();
  }
  function editActs() {
    let acts = JSON.parse(JSON.stringify(C().acts));
    const drawE = () => {
      const sc = acts.map((a, i) => ({ a, i })).filter(x => x.a.kind === 'showcase');
      openDlg(`<h3>Showcase order</h3><p class="ge-tiny">Move acts up or down, join an act with the next one for a shared showcase, or split a shared one. Guide time is 45 seconds per person.</p>
        <div style="max-height:60vh;overflow:auto;display:flex;flex-direction:column;gap:6px;margin:10px 0">${sc.map((x, k) => `<div class="ge-row" style="background:var(--bg);border-radius:10px;padding:6px 8px;gap:6px"><span style="flex:1" class="ge-tiny"><b>${k + 1}.</b> ${x.a.who.map(id => h((cand(id) || {}).name)).join(' + ')}</span>
          <button class="ge-btn" data-up="${x.i}" ${k ? '' : 'disabled'}>Up</button><button class="ge-btn" data-dn="${x.i}" ${k < sc.length - 1 ? '' : 'disabled'}>Down</button>
          ${k < sc.length - 1 ? `<button class="ge-btn" data-join="${x.i}">Join next</button>` : ''}${x.a.who.length > 1 ? `<button class="ge-btn" data-split="${x.i}">Split</button>` : ''}</div>`).join('')}</div>
        <div class="ge-row"><button class="ge-btn primary" id="geESave">Save</button><button class="ge-btn" data-x>Cancel</button></div>`);
      const idx = () => acts.map((a, i) => a.kind === 'showcase' ? i : -1).filter(i => i >= 0);
      const swap = (i, d) => { const ix = idx(), p = ix.indexOf(i), j = ix[p + d]; if (j == null) return; [acts[i], acts[j]] = [acts[j], acts[i]]; drawE(); };
      $all('#geDlg [data-up]').forEach(b => b.onclick = () => swap(+b.dataset.up, -1));
      $all('#geDlg [data-dn]').forEach(b => b.onclick = () => swap(+b.dataset.dn, 1));
      $all('#geDlg [data-join]').forEach(b => b.onclick = () => { const i = +b.dataset.join, ix = idx(), j = ix[ix.indexOf(i) + 1]; acts[i].who = [...acts[i].who, ...acts[j].who]; acts[i].sub = acts[i].who.map(id => (cand(id) || {}).name).join(' + '); acts.splice(j, 1); drawE(); });
      $all('#geDlg [data-split]').forEach(b => b.onclick = () => { const i = +b.dataset.split, a = acts[i]; acts.splice(i, 1, ...a.who.map(id => ({ ...a, id: 'sc-' + id.slice(0, 8), who: [id], sub: (cand(id) || {}).name }))); drawE(); });
      $1('#geESave').onclick = async () => { const { error } = await db().rpc('ge_config_set', { p_event: S.ev.event_id, p_key: 'acts', p_value: acts }); if (error) return say(error.message, 4000); S.ev.config.acts = acts; closeDlg(); draw(); say('Running order saved'); };
    };
    drawE();
  }

  /* ---------- Results ---------- */
  const candCodes = c => (C().syllabi[c.syl].items || []).map(i => i.code);
  function summary(c) { const p = [], f = [], u = []; candCodes(c).forEach(code => { const r = (mk(c.id, code) || {}).result; (r === 'pass' ? p : r === 'fail' ? f : u).push(code); }); return { p, f, u, suggest: f.length ? 'review' : u.length ? 'incomplete' : 'pass' }; }
  function vResults() {
    const appr = S.ev.approved_at, rows = cands().map(c => ({ c, s: summary(c), o: S.outcomes[c.id] })), ready = rows.filter(r => r.o).length;
    S.el.innerHTML = `<div class="ge-row" style="margin-bottom:12px"><h2 class="ge-grow">Results</h2><button class="ge-btn sm noprint" id="geCsv">Download CSV</button><button class="ge-btn sm noprint" id="gePrint">Print</button></div>
      <div class="ge-card" style="margin-bottom:12px;${appr ? 'border-color:var(--ok)' : ''}">${appr ? `<b>Approved</b> by ${h(S.ev.approved_by || '')} at ${new Date(appr).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}. Marks and results are locked.${can('admin') ? ' <button class="ge-btn sm ge-ghost noprint" id="geUnAp">Unlock</button>' : ''}`
        : `<b>Held for Mark to approve.</b> Nothing goes to candidates or families until results are approved. ${ready} of ${rows.length} results set.${can('admin') ? ` <button class="ge-btn sm primary noprint" id="geAp">Approve results</button>` : ''}`}</div>
      <div class="ge-card" style="overflow:auto"><table><thead><tr><th>Candidate</th><th>Grading</th><th>Scored</th><th>Failed items</th><th>Suggested</th><th>Result</th></tr></thead><tbody>
      ${rows.map(({ c, s, o }) => `<tr><td><b>${h(c.name)}</b><div class="ge-tiny">Group ${h(c.group)}${c.dan_no ? ' · ' + c.dan_no : ''}${partnerTag(c.id)}${isHere(c.id) ? '' : ' · not checked in'}</div></td><td class="ge-small">${h(c.to)}</td>
        <td class="ge-small">${s.p.length} pass${s.f.length ? `, <span style="color:var(--bad)">${s.f.length} fail</span>` : ''}${s.u.length ? `, <span style="color:var(--warn)">${s.u.length} not scored</span>` : ''}</td>
        <td class="ge-small">${s.f.map(code => { const m = mk(c.id, code) || {}; return `<div><b>${code}</b> ${h(itemOf(code).section)}${m.comment ? ': <span class="ge-muted">' + h(m.comment) + '</span>' : ''}</div>`; }).join('') || '—'}</td>
        <td>${s.suggest === 'pass' ? '<span class="ge-tag ok">Pass</span>' : s.suggest === 'review' ? '<span class="ge-tag bad">Review</span>' : '<span class="ge-tag warn">Not finished</span>'}</td>
        <td>${appr || !can('grading', 'results') ? (o ? `<span class="ge-tag ${o.outcome === 'pass' ? 'ok' : 'bad'}">${h(o.outcome)}</span>${o.note ? '<div class="ge-tiny">' + h(o.note) + '</div>' : ''}` : '—')
          : `<select data-o="${c.id}"><option value="">Set…</option>${['pass', 'retest', 'fail'].map(v => `<option value="${v}" ${o && o.outcome === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select>`}</td></tr>`).join('')}
      </tbody></table></div>
      ${!appr && can('grading', 'results') ? '<div class="ge-row noprint" style="margin-top:10px"><button class="ge-btn sm" id="geFill">Set Pass for everyone suggested Pass</button></div>' : ''}`;
    inM('[data-o]').forEach(s => s.onchange = async () => {
      const id = s.dataset.o, v = s.value;
      const row = { event_id: S.ev.event_id, cand_id: id, outcome: v, set_by: ME, set_at: new Date().toISOString() };
      if (v) S.outcomes[id] = row; else delete S.outcomes[id];
      const r = await save(v ? { t: 'ge_outcome', key: 'o:' + id, cand_id: id, row } : { t: 'ge_outcome', key: 'o:' + id, del: true, event_id: S.ev.event_id, cand_id: id });
      if (r.error) say(r.error.message, 4000); await loadLive(); draw();
    });
    const fp = $1('#geFill'); if (fp) fp.onclick = async () => { const r2 = rows.filter(r => r.s.suggest === 'pass' && !r.o).map(r => ({ event_id: S.ev.event_id, cand_id: r.c.id, outcome: 'pass', set_by: ME, set_at: new Date().toISOString() })); if (!r2.length) return say('Nobody new to set.'); const { error } = await db().from('ge_outcomes').upsert(r2); if (error) say(error.message); await loadLive(); draw(); };
    const ap = $1('#geAp'); if (ap) ap.onclick = async () => { if (ready < rows.length && !confirm(`${rows.length - ready} result(s) aren't set. Approve anyway?`)) return; const { error } = await db().rpc('ge_approve', { p_event: S.ev.event_id, p_on: true }); if (error) return say(error.message, 4000); await loadLive(); draw(); say('Results approved and locked'); };
    const ua = $1('#geUnAp'); if (ua) ua.onclick = async () => { const { error } = await db().rpc('ge_approve', { p_event: S.ev.event_id, p_on: false }); if (error) return say(error.message, 4000); await loadLive(); draw(); };
    $1('#gePrint').onclick = () => print();
    $1('#geCsv').onclick = () => {
      const allCodes = [...new Set(cands().flatMap(candCodes))];
      const lines = [['Name', 'Group', 'Dan no', 'Grading', ...allCodes, 'Result', 'Note'].join(',')].concat(rows.map(({ c, o }) => [c.name, c.group, c.dan_no || '', c.to, ...allCodes.map(code => (mk(c.id, code) || {}).result || ''), o ? o.outcome : '', o && o.note || ''].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')));
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = S.ev.slug + '-results.csv'; a.click();
    };
  }

  window.gePartnerOf = name => { try { if (!S.ev) return null; const n = String(name || '').trim().toLowerCase(), c = cands().find(c => c.name.toLowerCase() === n || c.name.split(' ')[0].toLowerCase() === n); const o = c && partnerOf(c.id); return o ? o.name : null; } catch (e) { return null; } };

  /* ---------- timers (MC count-up, test countdown, and the run sheet step timer) ---------- */
  // Running late: where the day is against the planned block times. Behind = still on a block after the next one was
  // due to start (or this block started late); ahead = moved to a block before its planned time. Today only.
  function lateness() {
    if (!S.ev) return null; const cf = C(), L = live(), bl = (cf && cf.blocks) || [], b = L.block;
    if (b == null || !bl[b] || !bl[b].time || !cf.date) return null;
    const today = new Date(), ymd = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    if (cf.date !== ymd || !L.started || new Date(L.started).toDateString() !== today.toDateString()) return null;   // not running today
    const at = t => new Date(cf.date + 'T' + t + ':00').getTime(), now = Date.now(), T = at(bl[b].time);
    const nx = bl.slice(b + 1).find(x => x.time), Tn = nx ? at(nx.time) : T + (bl[b].mins || 0) * 60000;
    let d = (now - Tn) / 60000;   // minutes past when the next block should have started
    if (!(L.step > 0)) d = Math.max(d, (Date.parse(L.started) - T) / 60000);   // this block started late
    if (now < T) d = -(T - now) / 60000;   // moved on early
    return Math.round(d);
  }
  function tick() {
    { const d = lateness(); $all('.ge-late').forEach(el => { if (d == null) { el.hidden = true; return; } el.hidden = false;
        el.textContent = d >= 3 ? d + ' min behind' : d <= -3 ? (-d) + ' min ahead' : 'On time';
        el.style.cssText = 'font-weight:700;padding:3px 10px;border-radius:999px;font-size:13px;' + (d >= 10 ? 'background:#b42318;color:#fff' : d >= 3 ? 'background:#f2b705;color:#111' : 'background:#1f7a4d;color:#fff'); }); }
    $all('[data-getimer-up]').forEach(el => { const st = Date.parse(el.dataset.getimerUp), g = Number(el.dataset.guide || 0); if (!st) { el.textContent = '0:00'; return; } const gone = (Date.now() - st) / 1000; el.textContent = mmss(gone); el.classList.toggle('soon', g && gone > g * .85 && gone <= g); el.classList.toggle('over', g && gone > g); });
    const tl = $1('#geLeft'); if (tl && S.quiz && S.quiz.quiz && S.quiz.quiz.phase === 'open') { const L = testLeft(); tl.textContent = mmss(L); tl.style.color = L < 120 ? 'var(--bad)' : ''; }
    // the floor's live run sheet: a countdown for the step that's live in the event (started when it was moved to)
    $all('[data-gestep]').forEach(el => { const [b, s, mins] = el.dataset.gestep.split(':').map(Number), L = live();
      if (L.block === b && L.step === s && L.started) { const left = mins * 60 - (Date.now() - Date.parse(L.started)) / 1000; el.textContent = mmss(left) + (left < 0 ? ' over' : ' left'); el.style.color = left < 0 ? '#ef8a73' : left < 60 ? 'var(--warn)' : 'var(--accent)'; }
      else { el.textContent = mins ? mins + ' min' : ''; el.style.color = ''; } });
  }

  /* ---------- attach to the floor ---------- */
  function pills(on) {
    $all('.ge-pill').forEach(b => b.remove());
    if (!on) return;
    const gear = document.getElementById('gearBtn'); if (!gear) return;
    { const late = document.createElement('span'); late.className = 'pill ge-pill ge-late'; late.hidden = true; gear.parentNode.insertBefore(late, gear); }
    TABS.forEach(([k, t]) => { const b = document.createElement('button'); b.className = 'pill ge-pill'; b.textContent = t; b.title = S.ev.title + ': ' + t; b.onclick = () => open(k); gear.parentNode.insertBefore(b, gear); });
  }
  async function attach(dayId) {
    S.ev = null; pills(false);
    if (!dayId) return;
    const OFF = window.Off, ck = 'ge_ev_' + dayId;
    const got = await db().from('ge_events').select('*').eq('day_id', dayId).order('starts_at', { ascending: false }).limit(1);
    let ev = got.data && got.data[0];
    if (got.error && OFF) ev = OFF.cache(ck);            // no signal: the copy on this device
    else if (OFF) OFF.cache(ck, ev || null);
    if (!ev) return;
    S.ev = ev;
    const [bb, cb] = await Promise.all([db().rpc('app_my_perms', { p_app: 'bb' }), db().rpc('app_my_perms', { p_app: 'cb' })]);
    const cbp = cb.data || [];
    S.perms = [...(bb.data || []), ...(cbp.includes('admin') ? ['admin'] : []), ...(cbp.some(p => p === 'results' || p === 'days') ? ['grading', 'scoring', 'results'] : [])];
    await loadLive();
    try { const u = JSON.parse(localStorage.getItem('ge_floor_ui') || '{}'); if (u.day === dayId && u.open && u.view === 'results') open('results'); } catch (e) {}
  }
  setInterval(async () => { if (!S.ev) return; if ($1('#geDlg') && $1('#geDlg').open) return; await loadLive(); if (live_el() && S.view !== 'quiz') draw(); }, 3000);
  setInterval(() => { if (live_el() && S.view === 'quiz' && !($1('#geDlg') && $1('#geDlg').open)) pollQuiz(); }, 2000);
  setInterval(tick, 250);
  window.GE = {
    attach, open, mountStep,
    has: () => !!S.ev,
    isQuiz: ge => { const b = S.ev && ge && C().blocks[ge.block]; return !!(b && (b.quiz || (b.assess || []).some(a => a.quiz))); },   // the theory test block (no floor layout)
    candSheet,   // one person's scoring for the step on screen; false if they have nothing to score here
    hasTool: ge => !!kindFor(ge),
    results: () => open('results'),
    // the floor's run sheet: "Score this step" for an assessment step, and a timer for any event step
    scoreStep: ge => { if (!S.ev || !ge) return; const b = C().blocks[ge.block]; if (b && ge.step > 0 && b.assess[ge.step - 1]) { if (b.assess[ge.step - 1].quiz) open('quiz'); else open('score', { b: ge.block, s: ge.step - 1 }); } else open('score'); },
    stepTimer: (ge, mins) => S.ev && ge ? `<span class="dm" data-gestep="${ge.block}:${ge.step}:${Number(mins) || 0}"></span>` : '',
    stepIsAssess: ge => { if (!S.ev || !ge) return false; const b = C().blocks[ge.block]; return !!(b && ge.step > 0 && b.assess[ge.step - 1]); },
  };
  try { if (typeof DAYID !== 'undefined' && DAYID) attach(DAYID); } catch (e) {}
})();

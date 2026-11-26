// AMA Toolkit: the Grading Floor keeps working with no signal.
//   Off.wrap(sb)   after the floor makes its Supabase client:
//     reads  (cb_floor_load, cb_runsheet_for_slot, ...)  saved on this device; with no signal the last copy is used
//     writes (check-ins, scores, groups, run sheet ticks) applied to that copy straight away; with no signal they wait
//            in order on this device and are sent the moment it's back (also after a refresh or a restart)
//   Off.register(type, exec)   other queued work (event.js: scoring marks and results), exec(op) -> Supabase result
//   Off.run(op)                queue/send one of those; Off.pendingOf(type) lists what's still waiting
// A small badge (top centre) says "Offline" / "N changes waiting" / "Saving…"; nothing is shown when all is saved.
(function () {
  const PFX = 'floor_off_', QK = PFX + 'queue';
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  let queue = get(QK, []), offline = !navigator.onLine, flushing = false, orig = null, retryT = null;
  const execs = {};
  const saveQ = () => { set(QK, queue); badge(); };
  // supabase-js reports a dropped connection as status 0 / "Failed to fetch" rather than throwing
  const netErr = r => !r || r.status === 0 || (r.error && /failed to fetch|networkerror|load failed|network request failed|fetch/i.test(String(r.error.message || '')) && !r.error.code);

  /* ---------- reads: last good copy per call ---------- */
  const READS = { cb_floor_load: ['p_day'], cb_runsheet_for_slot: ['p_day', 'p_slot'], cb_floor_days: [], app_my_perms: ['p_app'], cb_floor_set_code: ['p_day'], cb_runsheets_list: [] };
  const rkey = (fn, a) => PFX + 'r:' + fn + ':' + (READS[fn] || []).map(k => a && a[k]).join('|');

  /* ---------- writes: how each one changes the saved copies (mirrors the SQL) ---------- */
  const floorCopies = () => Object.keys(localStorage).filter(k => k.startsWith(PFX + 'r:cb_floor_load:'));
  const editFloor = (day, f) => { for (const k of (day ? [rkey('cb_floor_load', { p_day: day })] : floorCopies())) { const d = get(k, null); if (d) { f(d); set(k, d); } } };
  const stu = (d, entry) => (d.students || []).find(s => s.entry_id === entry);
  const WRITES = {
    cb_floor_checkin: { key: a => 'ci:' + a.p_entry, fake: a => ({ ok: true, checked_in: !!a.p_on }),
      apply: a => editFloor(null, d => { const s = stu(d, a.p_entry); if (s) { s.checked_in = !!a.p_on; s.checked_in_at = a.p_on ? (s.checked_in_at || new Date().toISOString()) : null; } }) },
    cb_score_save: { apply: a => editFloor(null, d => { const s = stu(d, a.p_entry); if (!s) return; const p = a.p_patch || {}, c = s.score || { scores: {}, pattern: null, ticks: [] };
      s.score = { scores: p.scores !== undefined ? p.scores : c.scores, pattern: 'pattern' in p ? p.pattern : c.pattern, ticks: p.ticks !== undefined ? p.ticks : c.ticks }; }) },
    cb_group_patch: { apply: a => editFloor(a.p_day, d => { const p = a.p_patch || {}; (d.groups || []).forEach(g => { if (p.status === 'current' && g.status === 'current' && g.ord !== a.p_ord) g.status = 'past'; });
      const g = (d.groups || []).find(x => x.ord === a.p_ord); if (g) ['status', 'slots', 'spots', 'rows'].forEach(k => { if (p[k] !== undefined) g[k] = p[k]; }); }) },
    cb_floor_reset: { apply: a => editFloor(a.p_day, d => (d.students || []).forEach(s => { s.score = null; s.checked_in = false; s.checked_in_at = null; })), fake: () => ({ ok: true }) },
    cb_floor_save_groups: { key: a => 'groups:' + a.p_day, drop: a => o => o.fn === 'cb_group_patch' && o.args.p_day === a.p_day,
      apply: a => editFloor(a.p_day, d => { d.groups = clone(a.p_groups || []).map(x => ({ spots: 13, rows: 2, status: 'future', slots: [], opts: {}, ...x })); }) },
    cb_floor_helpers_save: { key: a => 'helpers:' + a.p_day, apply: a => editFloor(a.p_day, d => { d.helpers = clone(a.p_helpers || {}); }) },
    cb_entry_result: { key: a => 'res:' + a.p_entry, fake: a => ({ ok: true, result: a.p_result }),
      apply: a => editFloor(null, d => { const s = stu(d, a.p_entry); if (s) s.result = a.p_result; }) },
    cb_runsheet_live_save: { key: a => 'rs:' + a.p_day + '|' + a.p_slot,
      apply: a => { const k = rkey('cb_runsheet_for_slot', a), d = get(k, null); if (d) { d.live = { ...(d.live || {}), step_ix: a.p_step_ix, move_ix: a.p_move_ix, ticks: clone(a.p_ticks || {}) }; set(k, d); } } },
  };
  // what a read should look like with this device's unsent changes still on top
  function overlay(fn, args, data) {
    if (data == null) return data;
    const k = rkey(fn, args); set(k, data);
    for (const op of queue) if (op.t === 'rpc' && WRITES[op.fn]) WRITES[op.fn].apply(op.args);
    return get(k, data);
  }

  async function read(fn, args) {
    if (!offline) {
      const r = await orig(fn, args);
      if (!netErr(r)) { if (r.error) return r; return { ...r, data: overlay(fn, args, r.data) }; }
      goOffline();
    }
    const data = get(rkey(fn, args), null);
    return data == null ? { data: null, error: { message: 'No signal, and this hasn’t been opened on this device yet.' }, status: 0 } : { data, error: null, status: 200, offline: true };
  }
  function enqueue(op) {
    const w = op.t === 'rpc' && WRITES[op.fn];
    if (w && w.key) { const k = w.key(op.args); queue = queue.filter(o => !(o.t === 'rpc' && WRITES[o.fn] && WRITES[o.fn].key && o.fn === op.fn && WRITES[o.fn].key(o.args) === k)); }
    if (w && w.drop) { const f = w.drop(op.args); queue = queue.filter(o => !f(o)); }
    if (op.key) queue = queue.filter(o => o.key !== op.key);
    queue.push(op); saveQ();
  }
  async function write(fn, args) {
    const w = WRITES[fn]; try { w.apply(args); } catch (e) {}
    if (!offline && !queue.length) {
      const r = await orig(fn, args);
      if (!netErr(r)) return r;
      goOffline();
    }
    enqueue({ t: 'rpc', fn, args, at: Date.now() }); kick();
    return { data: w.fake ? w.fake(args) : null, error: null, status: 200, queued: true };
  }
  // generic queued work from event.js. op: { t: type, key?, ... }
  async function run(op) {
    if (!offline && !queue.length) { const r = await execs[op.t](op); if (!netErr(r)) return r; goOffline(); }
    enqueue({ ...op, at: Date.now() }); kick();
    return { data: null, error: null, status: 200, queued: true };
  }

  async function flush() {
    if (flushing || !queue.length || !orig) return;
    flushing = true; badge();
    try {
      while (queue.length) {
        const op = queue[0];
        let r; try { r = op.t === 'rpc' ? await orig(op.fn, op.args) : execs[op.t] ? await execs[op.t](op) : { data: null, error: null, status: 200 }; } catch (e) { r = { error: e, status: 0 }; }
        if (netErr(r)) { goOffline(); break; }
        if (offline) { offline = false; }
        queue.shift(); saveQ();
        if (r.error) { try { toast('A change made offline couldn’t be saved: ' + (r.error.message || 'error'), 5000); } catch (e) {} }
      }
      if (!queue.length && offline) goOnline(true);
    } finally { flushing = false; badge(); }
  }
  function kick() { clearTimeout(retryT); if (queue.length) retryT = setTimeout(() => { flush().then(() => { if (queue.length) kick(); }); }, offline ? 5000 : 300); }
  function goOffline() { if (offline) return; offline = true; badge(); kick(); }
  function goOnline(confirmed) { const was = offline; offline = false; badge(); if (queue.length) flush(); else if (was && confirmed) { try { toast('Back online. Everything is saved.', 2500); } catch (e) {} } }
  window.addEventListener('online', () => { offline = false; flush(); badge(); });
  window.addEventListener('offline', () => { offline = true; badge(); });
  // while offline, try a real save every few seconds (the online event isn't reliable on every device)
  setInterval(() => { if (queue.length) { if (!flushing) flush(); } else if (offline) offline = false; /* the next read tries the network again */ }, 8000);

  function badge() {
    let b = document.getElementById('offBadge');
    if (!b) { if (!document.body) return; b = document.createElement('div'); b.id = 'offBadge';
      b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:max(10px,env(safe-area-inset-top,0px));white-space:nowrap;z-index:20000;padding:7px 12px;border-radius:999px;font:600 13px/1.2 Barlow,system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.4);pointer-events:none';
      document.body.appendChild(b); }
    const n = queue.length;
    if (!offline && !n) { b.hidden = true; return; }
    b.hidden = false;
    b.style.background = offline ? '#5a2a20' : '#1b2821'; b.style.color = offline ? '#ffd7cc' : '#edf2ee'; b.style.border = '1px solid ' + (offline ? '#ef8a73' : '#31473a');
    b.textContent = offline ? `Offline${n ? ` · ${n} change${n === 1 ? '' : 's'} saved here, will send when back` : ' · showing the last update'}` : `Saving ${n} change${n === 1 ? '' : 's'}…`;
  }

  window.Off = {
    wrap(sb) {
      orig = (fn, args, o) => sb.__rpc(fn, args, o);
      sb.__rpc = sb.rpc.bind(sb);
      sb.rpc = (fn, args, o) => READS[fn] ? read(fn, args) : WRITES[fn] ? write(fn, args) : sb.__rpc(fn, args, o);
      if (queue.length) kick();
      document.addEventListener('DOMContentLoaded', badge); badge();
      return sb;
    },
    register(type, exec) { execs[type] = exec; if (queue.length) kick(); },
    run, netErr,
    pendingOf: type => queue.filter(o => o.t === type),
    isOffline: () => offline,
    markOffline: goOffline,
    cache: (k, v) => v === undefined ? get(PFX + 'c:' + k, null) : set(PFX + 'c:' + k, v),
    // the sign-in saved on this device, for opening with no signal (Supabase can't refresh it offline)
    storedSession() { try { const k = Object.keys(localStorage).find(x => /^sb-.*-auth-token$/.test(x)); const s = k && JSON.parse(localStorage.getItem(k)); return s && s.user ? s : null; } catch (e) { return null; } },
  };

  // install: the floor opens with no signal (sw.js keeps the page and its scripts on this device)
  if ('serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('/grading/floor/sw.js', { scope: '/grading/floor/' }).catch(() => {}); });
})();

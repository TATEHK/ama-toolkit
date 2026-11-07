// AMA Hub: a "Grading" card in the family view (Find a family).
//
// Add to the hub page once, after the hub's own scripts:
//   <script src="https://app.train-ama.com/hub-grading.js" defer></script>
//
// For each student in the family it shows the belt they are going for, whether the grading invite has gone out
// (booked, paid), classes done on the belt against classes needed, and for black belt candidates the essay and
// the ID card. The details come from the Supabase "hub" function, which only answers a good hub sign-in
// (the token in AMA_HUB_USER), so nothing is shown to anyone who is not signed in to the hub.
(function () {
  if (window.__amaHubGrading) return; window.__amaHubGrading = true;
  var API = 'https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/hub';
  var KEY = 'sb_publishable_YsRY6SlgR7U_ohn_xxQD1A_lrowkIGS';
  var MARK = 'data-ama-grading';
  var last = null;   // the family the hub last opened, as the hub handed it over

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function day(d) {
    if (!d) return '';
    var x = new Date(String(d).length <= 10 ? d + 'T00:00:00' : d);
    return isNaN(x) ? '' : x.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // Keep a copy of the family the hub opens (the hub calls AMA_FAMILY_AFTER(family, body) after drawing it).
  // Other add-ons wrap the same hook, so check now and then that ours is still in the chain.
  function hook() {
    var cur = window.AMA_FAMILY_AFTER;
    if (cur && cur.__amaGrading) return;
    var wrapped = function (f) {
      try { if (f && typeof f === 'object') last = { f: f, at: Date.now() }; } catch (e) {}
      if (typeof cur === 'function') return cur.apply(this, arguments);
    };
    wrapped.__amaGrading = true;
    window.AMA_FAMILY_AFTER = wrapped;
  }

  var css = '[' + MARK + '] .g-row{padding:12px 0;border-top:1px solid rgba(255,255,255,.08)}' +
    '[' + MARK + '] .g-row:first-of-type{border-top:0;padding-top:4px}' +
    '[' + MARK + '] .g-top{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px}' +
    '[' + MARK + '] .g-name{font-weight:700}' +
    '[' + MARK + '] .g-belt{opacity:.85}' +
    '[' + MARK + '] .g-belt b{color:#ffd23f}' +
    '[' + MARK + '] .g-when{font-size:12px;opacity:.7}' +
    '[' + MARK + '] .g-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}' +
    '[' + MARK + '] .g-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12.5px;line-height:1.3;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04)}' +
    '[' + MARK + '] .g-chip i{font-style:normal;font-weight:800}' +
    '[' + MARK + '] .g-ok{border-color:rgba(74,222,128,.45);color:#86efac}' +
    '[' + MARK + '] .g-no{border-color:rgba(251,146,60,.5);color:#fdba74}' +
    '[' + MARK + '] .g-dim{opacity:.7}' +
    '[' + MARK + '] .g-bar{display:inline-block;width:54px;height:6px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden}' +
    '[' + MARK + '] .g-bar span{display:block;height:100%;background:#ffd23f}' +
    '[' + MARK + '] .g-bar.full span{background:#4ade80}';
  function addCss() {
    if (document.getElementById('ama-grading-css')) return;
    var st = document.createElement('style'); st.id = 'ama-grading-css'; st.textContent = css; document.head.appendChild(st);
  }

  function chip(state, label, extra) {
    var cls = state === true ? 'g-ok' : state === false ? 'g-no' : 'g-dim';
    var mark = state === true ? '&#10003;' : state === false ? '&#10007;' : '&middot;';
    return '<span class="g-chip ' + cls + '"><i>' + mark + '</i>' + esc(label) + (extra || '') + '</span>';
  }
  var CARD = { printed: 'ID card printed', collected: 'ID card collected', awaiting_collection: 'ID card printed, to collect',
    sent_for_printing: 'ID card sent for printing', ready_for_printing: 'ID card ready to print', details_incomplete: 'ID card details missing',
    reprint_required: 'ID card needs a reprint', required: 'ID card not set up', not_printed: 'ID card not printed' };
  var RESULT = { pass: 'Passed', passed: 'Passed', fail: 'Not yet', retest: 'Retest', distinction: 'Distinction' };

  function row(s) {
    var c = s.classes || {}, inv = s.invite || {}, es = s.essay || {}, id = s.id_card || {};
    var done = +c.done || 0, need = +c.needed || 0;
    var pct = need ? Math.min(100, Math.round(done / need * 100)) : 0;
    var chips = [];
    if (s.result) chips.push(chip(/pass|distinction/i.test(s.result) ? true : null, 'Result: ' + (RESULT[String(s.result).toLowerCase()] || s.result)));
    chips.push(chip(!!inv.sent, inv.sent ? 'Invite sent' + (inv.at ? ' ' + day(inv.at) : '') : 'Not invited yet'));
    if (inv.sent) chips.push(chip(!!inv.booked, inv.booked ? (inv.paid ? 'Booked and paid' : 'Booked, not paid') : 'Not booked yet'));
    var bar = need ? ' <span class="g-bar' + (done >= need ? ' full' : '') + '"><span style="width:' + pct + '%"></span></span>' : '';
    if (s.track === 'coloured' && need) {
      // Coloured belts: say plainly whether they have done enough classes, and how many are left
      chips.push(done >= need
        ? chip(true, 'Enough classes: ' + done + ' of ' + need, bar)
        : chip(false, 'Not enough classes: ' + done + ' of ' + need + ', ' + (need - done) + ' to go', bar));
    } else {
      chips.push(chip(need ? done >= need : null, 'Classes ' + done + (need ? ' of ' + need : ''), bar));
    }
    if (es.needed) chips.push(chip(es.status === 'submitted', es.status === 'submitted' ? 'Essay in' + (es.at ? ' ' + day(es.at) : '') : 'Essay not in yet'));
    if (id.needed) chips.push(chip(!!id.printed, CARD[id.status] || (id.printed ? 'ID card printed' : 'ID card not printed')));
    return '<div class="g-row"><div class="g-top"><span class="g-name">' + esc(s.name) + '</span>' +
      '<span class="g-belt">' + esc(s.belt || '') + (s.target ? ' &rarr; <b>' + esc(s.target) + '</b>' : '') + '</span>' +
      (s.grading_date ? '<span class="g-when">Grading ' + esc(day(s.grading_date)) + '</span>' : '') + '</div>' +
      '<div class="g-chips">' + chips.join('') + '</div></div>';
  }

  // The family's details: from the hub's own family data when we have it, otherwise read off the page
  function familyFrom(studentsCard) {
    // The family header is the first ".fw-m" line outside the cards (place · mobile · email), with the name above it.
    // Only that line is read, so an email or number inside a message further down is never used.
    var panel = studentsCard.closest('.fw-in') || document;
    var title = '', text = '';
    var lines = panel.querySelectorAll('.fw-m');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].closest('.fw-card')) continue;
      text = lines[i].textContent;
      var prev = lines[i].previousElementSibling;
      if (prev) title = prev.textContent.trim();
      break;
    }
    var names = [].map.call(studentsCard.querySelectorAll('b'), function (b) { return b.textContent.trim(); });
    var f = last && Date.now() - last.at < 20000 ? last.f : null;
    if (f && (!title || !f.title || f.title === title)) {
      var st = (f.students || []).map(function (x) { return typeof x === 'string' ? x : x && (x.name || x.full_name || x.student); });
      return { names: names.concat(st, f.names || [], f.title ? [f.title] : []).filter(Boolean), mobile: f.mobile || '', email: f.email || '' };
    }
    var mob = (text.match(/(?:\+?61|0)4[\d\s]{8,11}/) || [''])[0];
    var em = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [''])[0];
    return { names: names.concat(title ? [title] : []), mobile: mob, email: em };
  }

  function draw(studentsCard) {
    if (studentsCard.getAttribute('data-ama-seen')) return;
    studentsCard.setAttribute('data-ama-seen', '1');
    var user = window.AMA_HUB_USER;
    if (!user || !user.token) return;
    addCss();
    var card = document.createElement('div');
    card.className = 'fw-card'; card.setAttribute(MARK, '');
    card.innerHTML = '<div class="fw-lab">Grading</div><div class="fw-m">Checking gradings&hellip;</div>';
    studentsCard.parentNode.insertBefore(card, studentsCard.nextSibling);
    var fam = familyFrom(studentsCard);
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY },
      body: JSON.stringify({ token: user.token, grading: fam }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (j) { j.status = r.status; return j; }); })
      .then(function (j) {
        var body;
        if (j.status === 401) body = '<div class="fw-m">Sign out of the hub and back in to see gradings.</div>';
        else if (!j.ok) body = '<div class="fw-m">Gradings could not be loaded just now.</div>';
        else if (!j.students || !j.students.length) body = '<div class="fw-m">No grading on record for this family.</div>';
        else body = j.students.map(row).join('');
        card.innerHTML = '<div class="fw-lab">Grading</div>' + body;
      })
      .catch(function () { card.innerHTML = '<div class="fw-lab">Grading</div><div class="fw-m">Gradings could not be loaded just now.</div>'; });
  }

  function scan() {
    hook();
    var labs = document.querySelectorAll('.fw-card > .fw-lab');
    for (var i = 0; i < labs.length; i++) {
      if (/^students$/i.test(labs[i].textContent.trim()) && !labs[i].parentElement.hasAttribute(MARK)) draw(labs[i].parentElement);
    }
  }
  hook();
  new MutationObserver(function () { clearTimeout(scan.t); scan.t = setTimeout(scan, 60); })
    .observe(document.documentElement, { childList: true, subtree: true });
  setInterval(hook, 3000);
  scan();
})();

// AMA Toolkit: idle auto-logout — signs a staff login out after a stretch with no activity, so a
// shared office/reception device left open can't be used by whoever walks past. Shared by every AMA
// staff page (copied into ama-id-cards/docs and Black-belt-prep-system/docs; keep the copies the same).
//
//   AmaIdle.watch({ sb, minutes })   minutes defaults to 30; a 60-second "Still there?" warning shows first.
//
// Only runs while signed in. Activity in any tab resets the timer for every tab (shared via localStorage).
// TV party/screen and the public pages don't load this — it's for logins, not the always-on displays.
(function () {
  var ACT = 'ama_idle_at';   // last-activity time, shared across tabs
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function now() { return Date.now(); }

  function watch(o) {
    var sb = o && o.sb; if (!sb || sb.__amaIdle) return; sb.__amaIdle = true;
    var LIMIT = Math.max(1, +(o.minutes) || 30) * 60000;
    var WARN = Math.min(60000, Math.floor(LIMIT / 2));   // how long before sign-out the warning appears
    var signedIn = false, box = null, label = null, goneOut = false;

    function touch() { ls(ACT, String(now())); if (box) hide(); }
    function last() { var v = parseInt(ls(ACT) || '0', 10); return v || now(); }

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(function (ev) {
      window.addEventListener(ev, touch, { passive: true, capture: true });
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });

    function ui() {
      if (box) return;
      box = document.createElement('div');
      box.setAttribute('role', 'alertdialog');
      box.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(6,12,9,.72);font-family:Barlow,"Segoe UI",Arial,sans-serif';
      box.innerHTML =
        '<div style="background:#15201a;color:#edf2ee;border:1px solid #253629;border-radius:16px;max-width:360px;width:100%;padding:26px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5)">' +
        '<div style="font-size:19px;font-weight:700;margin-bottom:8px">Still there?</div>' +
        '<div style="color:#a3b5a9;line-height:1.5;margin-bottom:20px">You\'ll be signed out in <b id="amaIdleN">60</b> seconds to keep this device secure.</div>' +
        '<button id="amaIdleStay" style="min-height:48px;padding:0 24px;border:0;border-radius:12px;background:#f5c518;color:#14130a;font:inherit;font-weight:700;cursor:pointer">Stay signed in</button></div>';
      document.body.appendChild(box);
      label = box.querySelector('#amaIdleN');
      box.querySelector('#amaIdleStay').onclick = touch;
    }
    function hide() { if (box) { box.remove(); box = null; label = null; } }

    function tick() {
      if (goneOut) return;
      if (!signedIn) { hide(); return; }
      var idle = now() - last();
      if (idle >= LIMIT) { goneOut = true; hide(); sb.auth.signOut().then(function () { location.reload(); }, function () { location.reload(); }); return; }
      if (idle >= LIMIT - WARN) { ui(); if (label) label.textContent = String(Math.ceil((LIMIT - idle) / 1000)); }
      else hide();
    }

    sb.auth.getSession().then(function (r) {
      signedIn = !!(r && r.data && r.data.session);
      if (signedIn && !ls(ACT)) touch();
    });
    sb.auth.onAuthStateChange(function (ev, session) {
      signedIn = !!session;
      if (ev === 'SIGNED_IN') { goneOut = false; touch(); }
      if (!signedIn) hide();
    });
    setInterval(tick, 1000);
  }

  window.AmaIdle = { watch: watch };
})();

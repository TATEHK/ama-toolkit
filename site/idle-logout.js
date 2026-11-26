// AMA Toolkit: idle auto-logout — signs a staff login out after a stretch with no activity, so a
// shared office/reception device left open can't be used by whoever walks past. Shared by every AMA
// staff page (copied into ama-id-cards/docs and Black-belt-prep-system/docs; keep the copies the same).
//
//   AmaIdle.watch({ sb, minutes })   minutes defaults to 60; a 60-second "Still there?" warning shows first.
//
// Only runs while signed in. Activity in any tab resets the timer for every tab (shared via localStorage).
// TV party/screen and the public pages don't load this — it's for logins, not the always-on displays.
//
// It also keeps a lightweight record of each signed-in device in app_devices (RLS: a login only ever sees
// its own rows), so the Profile → Signed-in devices page can list them and sign any one of them out. A
// device the user marks "Stay signed in on this device" (trusted) is exempt from the idle auto-logout.
// Signing a device out from elsewhere sets revoked_at; that device notices within ~90s and signs itself out.
(function () {
  var ACT = 'ama_idle_at';          // last-activity time, shared across tabs
  var DEV = 'ama_device_id';        // this browser's stable device id
  var TRUST = 'ama_device_trusted'; // cached "is this device trusted" flag, so idle logic is right before the DB check returns
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function now() { return Date.now(); }

  function deviceId() {
    var id = ls(DEV);
    if (!id) {
      try { id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : null; } catch (e) { id = null; }
      if (!id) id = 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      ls(DEV, id);
    }
    return id;
  }
  function deviceLabel() {
    var ua = (navigator && navigator.userAgent) || '';
    var os = /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
      : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
      : /Windows/.test(ua) ? 'Windows'
      : /Linux/.test(ua) ? 'Linux'
      : 'Device';
    var br = /Edg\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /CriOS|Chrome/.test(ua) ? 'Chrome'
      : /Firefox|FxiOS/.test(ua) ? 'Firefox'
      : /Safari/.test(ua) ? 'Safari'
      : 'Browser';
    return os + ' · ' + br;
  }

  function watch(o) {
    var sb = o && o.sb; if (!sb || sb.__amaIdle) return; sb.__amaIdle = true;
    var LIMIT = Math.max(1, +(o.minutes) || 60) * 60000;
    var WARN = Math.min(60000, Math.floor(LIMIT / 2));   // how long before sign-out the warning appears
    var signedIn = false, box = null, label = null, goneOut = false;
    var trusted = ls(TRUST) === '1';   // start from the cached flag so a trusted device isn't warned before the DB confirms

    function touch() { ls(ACT, String(now())); if (box) hide(); }
    function last() { var v = parseInt(ls(ACT) || '0', 10); return v || now(); }

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(function (ev) {
      window.addEventListener(ev, touch, { passive: true, capture: true });
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { tick(); checkDevice(); } });

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
      if (trusted) { hide(); return; }   // a trusted device stays signed in — no idle logout
      var idle = now() - last();
      if (idle >= LIMIT) { goneOut = true; hide(); sb.auth.signOut({ scope: 'local' }).then(function () { location.reload(); }, function () { location.reload(); }); return; }
      if (idle >= LIMIT - WARN) { ui(); if (label) label.textContent = String(Math.ceil((LIMIT - idle) / 1000)); }
      else hide();
    }

    // --- device registry (best-effort; errors never sign anyone out) ---
    function registerDevice(fresh) {
      sb.auth.getSession().then(function (r) {
        var s = r && r.data && r.data.session; if (!s || !s.user) return;
        var row = {
          device_id: deviceId(),
          user_id: s.user.id,
          label: deviceLabel(),
          user_agent: ((navigator && navigator.userAgent) || '').slice(0, 300),
          last_seen_at: new Date().toISOString()
        };
        if (fresh) row.revoked_at = null;   // a real sign-in re-activates this device; a mere page load must not
        sb.from('app_devices').upsert(row, { onConflict: 'device_id' }).then(function () { checkDevice(); }, function () {});
      }, function () {});
    }
    function signOutRevoked() {
      goneOut = true; hide();
      sb.auth.signOut({ scope: 'local' }).then(function () { location.reload(); }, function () { location.reload(); });
    }
    function checkDevice() {
      if (!signedIn || goneOut) return;
      var id = ls(DEV); if (!id) return;
      sb.from('app_devices').select('trusted,revoked_at').eq('device_id', id).maybeSingle().then(function (res) {
        var d = res && res.data; if (!d) return;
        trusted = !!d.trusted; ls(TRUST, trusted ? '1' : '0');
        if (d.revoked_at) signOutRevoked();
      }, function () {});
    }

    sb.auth.getSession().then(function (r) {
      signedIn = !!(r && r.data && r.data.session);
      if (signedIn) { if (!ls(ACT)) touch(); registerDevice(false); }
    });
    sb.auth.onAuthStateChange(function (ev, session) {
      signedIn = !!session;
      if (ev === 'SIGNED_IN') { goneOut = false; touch(); registerDevice(true); }
      if (!signedIn) { trusted = false; ls(TRUST, '0'); hide(); }
    });
    setInterval(tick, 1000);
    setInterval(checkDevice, 90000);   // notice a remote sign-out / trust change within ~90s
  }

  window.AmaIdle = { watch: watch };
})();

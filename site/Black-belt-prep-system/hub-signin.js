// AMA Toolkit: "Sign in with hub mobile and PIN" (the AMA Admin Hub login), shared by every AMA sign-in page.
// The same file is copied into ama-id-cards/docs and Black-belt-prep-system/docs; keep the copies the same.
//
//   AmaHub.mount({ sb, url, key, form })   adds the hub option under a page's email and password form
//   AmaHub.recheck({ sb, url, key })       on page load: if signed in through the hub, check the hub still
//                                          allows it (12-hour hub session, Active in the hub); if not, sign out
//
// The "hub" Supabase function checks the mobile and PIN with the hub and returns an ordinary Supabase session
// for the AMA Toolkit login linked to that mobile, so each app's permissions work as before.
(function () {
  var KEY = 'ama_hub_token', CHECKED = 'ama_hub_checked', EVERY = 60 * 60 * 1000;   // ask the hub at most once an hour
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { return null; } }
  var store = {
    get: function () { return ls(KEY); },
    set: function (v) { ls(KEY, v || null); ls(CHECKED, v ? String(Date.now()) : null); }
  };
  function call(o, body) {
    return fetch(String(o.url).replace(/\/$/, '') + '/functions/v1/hub', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: o.key }, body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 404) return { ok: false, error: 'Hub sign-in is not set up yet. Use your email and password.' };
      return r.json().catch(function () { return { ok: false, error: 'Hub sign-in did not answer properly. Try again.' }; });
    });
  }
  function watchSignOut(sb) {
    if (sb.__amaHubWatch) return; sb.__amaHubWatch = true;
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT') store.set(null); });
  }

  function mount(o) {
    var form = typeof o.form === 'string' ? document.querySelector(o.form) : o.form;
    if (!form || form.getAttribute('data-hub')) return;
    form.setAttribute('data-hub', '1');
    watchSignOut(o.sb);
    var link = 'background:none;border:0;padding:10px 0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer;opacity:.8';
    var wrap = document.createElement('div');
    wrap.className = 'hub-signin';
    wrap.innerHTML =
      '<button type="button" id="hubShow" style="' + link + '">Sign in with hub mobile and PIN</button>' +
      '<form id="hubForm" style="display:none;flex-direction:column;gap:12px">' +
        '<div class="field"><label for="hubMobile">Mobile</label><input type="tel" id="hubMobile" inputmode="tel" autocomplete="tel" required></div>' +
        '<div class="field"><label for="hubPin">Hub PIN</label><input type="password" id="hubPin" inputmode="numeric" autocomplete="current-password" required></div>' +
        '<p id="hubError" role="alert" style="display:none;margin:0;color:var(--danger,#c0392b)"></p>' +
        '<button type="submit" class="btn primary" id="hubGo">Sign in</button>' +
        '<button type="button" id="hubBack" style="' + link + '">Use email and password instead</button>' +
      '</form>';
    form.parentNode.insertBefore(wrap, form.nextSibling);
    var hubForm = wrap.querySelector('#hubForm'), show = wrap.querySelector('#hubShow'), err = wrap.querySelector('#hubError'), go = wrap.querySelector('#hubGo');
    var formDisplay = form.style.display;
    function mode(hub) {
      form.style.display = hub ? 'none' : formDisplay;
      hubForm.style.display = hub ? 'flex' : 'none';
      show.style.display = hub ? 'none' : '';
      err.style.display = 'none';
      (hub ? wrap.querySelector('#hubMobile') : form.querySelector('input')).focus();
    }
    show.onclick = function () { mode(true); };
    wrap.querySelector('#hubBack').onclick = function () { mode(false); };
    hubForm.onsubmit = function (e) {
      e.preventDefault();
      go.disabled = true; go.textContent = 'Signing in…'; err.style.display = 'none';
      call(o, { mobile: wrap.querySelector('#hubMobile').value, pin: wrap.querySelector('#hubPin').value }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || 'Mobile or PIN not right.');
        return o.sb.auth.setSession(r.session).then(function (s) {
          if (s && s.error) throw s.error;
          store.set(r.hub_token);
          if (o.onSignedIn) o.onSignedIn(r); else location.reload();
        });
      }).catch(function (e2) {
        err.textContent = (e2 && e2.message) || 'Could not sign in. Try again.';
        err.style.display = ''; go.disabled = false; go.textContent = 'Sign in';
      });
    };
  }

  function recheck(o) {
    watchSignOut(o.sb);
    var token = store.get();
    if (!token) return Promise.resolve(true);
    if (Date.now() - Number(ls(CHECKED) || 0) < EVERY) return Promise.resolve(true);   // checked recently
    return o.sb.auth.getSession().then(function (res) {
      if (!res.data.session) { store.set(null); return true; }
      return call(o, { check: token }).then(function (r) {
        if (r && r.ok === false && !r.error) {   // the hub said no (not a network or set-up problem)
          store.set(null);
          return o.sb.auth.signOut().then(function () { location.reload(); return false; });
        }
        if (r && r.ok) ls(CHECKED, String(Date.now()));
        return true;
      });
    }).catch(function () { return true; });
  }

  window.AmaHub = { mount: mount, recheck: recheck };
})();

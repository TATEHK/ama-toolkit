// AMA Toolkit: "Sign in with hub mobile and PIN" (the AMA Admin Hub login), shared by every AMA sign-in page.
// The same file is copied into ama-id-cards/docs and Black-belt-prep-system/docs; keep the copies the same.
//
//   AmaHub.mount({ sb, url, key, form })   adds the hub option under a page's email and password form
//   AmaHub.passkey.register/list/remove(o, ...)   passkeys for the signed-in login (the Profile page)
//   AmaHub.recheck({ sb, url, key })       on page load: if signed in through the hub, check the hub still
//                                          allows it (12-hour hub session, Active in the hub); if not, sign out
//
// The "hub" Supabase function checks the mobile and PIN with the hub and returns an ordinary Supabase session
// for the AMA Toolkit login linked to that mobile, so each app's permissions work as before.
(function () {
  var KEY = 'ama_hub_token', CHECKED = 'ama_hub_checked', EVERY = 60 * 60 * 1000;   // ask the hub at most once an hour
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { return null; } }
  // A device the owner marked "Stay signed in" (set by idle-logout.js from app_devices.trusted, owners only).
  function trustedDevice() { try { return localStorage.getItem('ama_device_trusted') === '1'; } catch (e) { return false; } }
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
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT') { store.set(null); ls(PKS, null); } });
  }

  // ---- Passkeys (Supabase Auth, relying party train-ama.com: one passkey works on app.train-ama.com and ama-os.train-ama.com).
  // The pages use an older supabase-js; the passkey ceremony comes from a current one loaded only when needed, in a
  // client that keeps nothing itself. The session it gets is handed to the page's own client.
  var PKS = 'ama_passkey_session';   // signed in with a passkey: when the hub was last asked about this login
  function hubActive(o) { return Promise.resolve(o.sb.rpc('hub_still_active')).then(function (r) { return !(r && r.data === false); }, function () { return true; }); }
  var PK_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm', pkMod = null;
  function pkSupported() { return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext); }
  function pkClient(o) {
    pkMod = pkMod || import(PK_LIB);
    return pkMod.then(function (m) { return m.createClient(o.url, o.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'ama-pk-tmp' } }); });
  }
  // a client signed in as the page's current login (fresh tokens from the page, so nothing gets rotated)
  function pkAs(o) {
    return o.sb.auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session; if (!s) throw new Error('Sign in first.');
      return pkClient(o).then(function (c) { return c.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token }).then(function (x) { if (x && x.error) throw x.error; return c; }); });
    });
  }
  function pkMsg(e) {
    var m = String((e && (e.code || e.name)) || '') + ' ' + String((e && e.message) || '');
    if (/NotAllowed|abort|cancel/i.test(m)) return '';   // they closed the prompt
    if (/passkey.*(disabled|not enabled)|not_enabled|feature_disabled|404/i.test(m)) return 'Passkeys aren’t switched on yet. Use your mobile and PIN.';
    if (/credential_not_found/i.test(m)) return 'That passkey isn’t set up for AMA any more. Sign in with your mobile and PIN, then add it again on your Profile.';
    if (/InvalidState|already/i.test(m)) return 'This device already has a passkey for your login.';
    if (/failed to fetch|network|load failed/i.test(m)) return 'No connection. Check the Wi-Fi or signal and try again.';
    return (e && e.message) || 'Passkey didn’t work. Try again.';
  }
  var passkey = {
    supported: pkSupported,
    signIn: function (o, opts) {
      return pkClient(o).then(function (c) { return c.auth.signInWithPasskey(opts ? { options: opts } : undefined); }).then(function (r) {
        if (r.error) throw r.error;
        var s = r.data && (r.data.session || r.data); if (!s || !s.access_token) throw new Error('Passkey didn’t work. Try again.');
        return o.sb.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token }).then(function (x) {
          if (x && x.error) throw x.error;
          // a passkey skips the hub's mobile and PIN check, so ask whether the hub still has this person as Active
          return hubActive(o).then(function (ok) {
            if (!ok) return o.sb.auth.signOut({ scope: 'local' }).then(function () { throw new Error('Your hub access isn’t active any more. Ask an admin if that’s a mistake.'); });
            ls('ama_passkey_here', '1'); ls(PKS, String(Date.now())); return x;
          });
        });
      });
    },
    register: function (o, name) {
      return pkAs(o).then(function (c) { return c.auth.registerPasskey().then(function (r) {
        if (r.error) throw r.error; ls('ama_passkey_here', '1');
        var id = r.data && (r.data.id || (r.data.passkey && r.data.passkey.id));
        if (id && name) return c.auth.passkey.update({ passkeyId: id, friendlyName: String(name).slice(0, 120) }).then(function () { return r.data; }, function () { return r.data; });
        return r.data; }); });
    },
    list: function (o) { return pkAs(o).then(function (c) { return c.auth.passkey.list(); }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); },
    remove: function (o, id) { return pkAs(o).then(function (c) { return c.auth.passkey.delete({ passkeyId: id }); }).then(function (r) { if (r && r.error) throw r.error; return true; }); },
    message: pkMsg
  };

  // One look for every AMA sign-in: big, clear fields that follow the page's colours (theme variables), the mobile
  // remembered on this device, PIN show/hide, and the page's own email form restyled to match.
  var CSS = '' +
    '.ama-si,form.ama-si-email{display:flex;flex-direction:column;gap:14px;text-align:left;width:100%;margin:0}' +
    '.ama-si label,form.ama-si-email label{display:block;font-size:13px;font-weight:600;letter-spacing:.01em;color:var(--ink-2,#55655b);margin:0 0 6px;text-transform:none}' +
    '.ama-si input,form.ama-si-email input{display:block;width:100%;box-sizing:border-box;height:54px;padding:0 16px;font:inherit;font-size:18px;font-weight:600;' +
      'color:var(--ink,#14201a);background:var(--bg,#fff);border:1.5px solid var(--line-2,var(--line,#cfd8d2));border-radius:14px;outline:0;box-shadow:none;transition:border-color .15s,box-shadow .15s}' +
    '.ama-si input:focus,form.ama-si-email input:focus{border-color:var(--accent,#f5c518);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent,#f5c518) 25%,transparent);outline:0}' +
    '.ama-si input::placeholder{color:var(--ink-3,#8a978f);font-weight:500}' +
    '.ama-si .ama-si-pin{position:relative}.ama-si .ama-si-pin input{padding-right:64px;letter-spacing:.3em}' +
    '.ama-si .ama-si-eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);height:38px;padding:0 10px;border:0;border-radius:10px;background:transparent;color:var(--ink-3,#7a887f);font:inherit;font-size:13px;font-weight:700;cursor:pointer}' +
    '.ama-si-go,form.ama-si-email button[type=submit]{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:54px;margin-top:4px;border:0;border-radius:14px;' +
      'background:var(--accent,#f5c518);color:var(--accent-ink,#14130a);font:inherit;font-size:17px;font-weight:700;cursor:pointer;box-shadow:0 6px 18px color-mix(in srgb,var(--accent,#f5c518) 28%,transparent);transition:transform .08s,filter .15s}' +
    '.ama-si-go:hover,form.ama-si-email button[type=submit]:hover{filter:brightness(1.05)}.ama-si-go:active,form.ama-si-email button[type=submit]:active{transform:scale(.985)}' +
    '.ama-si-go[disabled],form.ama-si-email button[type=submit][disabled]{opacity:.7;cursor:default}' +
    '.ama-si-spin{width:18px;height:18px;border-radius:50%;border:2.5px solid currentColor;border-right-color:transparent;animation:amaSiSpin .7s linear infinite}' +
    '@keyframes amaSiSpin{to{transform:rotate(360deg)}}' +
    '.ama-si-err{margin:0;padding:11px 14px;border-radius:12px;font-size:14px;font-weight:600;line-height:1.4;color:var(--danger,#c0392b);background:color-mix(in srgb,var(--danger,#c0392b) 12%,transparent)}' +
    '.ama-si-err.shake{animation:amaSiShake .35s}@keyframes amaSiShake{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}' +
    '.ama-si-alt{align-self:center;background:none;border:0;padding:8px 6px;margin:0;font:inherit;font-size:14px;font-weight:600;color:var(--ink-3,#6f7d74);text-decoration:underline;text-underline-offset:3px;cursor:pointer}' +
    '.ama-si-alt:hover{color:var(--ink,#14201a)}' +
    '.ama-si-hint{margin:-4px 0 0;font-size:12.5px;color:var(--ink-3,#7a887f);text-align:center;line-height:1.4}' +
    '.ama-si-pk{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:54px;border-radius:14px;border:1.5px solid var(--line-2,var(--line,#cfd8d2));background:var(--panel,#fff);color:var(--ink,#14201a);font:inherit;font-size:16px;font-weight:700;cursor:pointer;transition:border-color .15s,transform .08s}' +
    '.ama-si-pk:hover{border-color:var(--accent,#f5c518)}.ama-si-pk:active{transform:scale(.985)}.ama-si-pk svg{width:22px;height:22px}' +
    '.ama-si-or{display:flex;align-items:center;gap:12px;margin:14px 0;color:var(--ink-3,#7a887f);font-size:12.5px;font-weight:600;text-transform:uppercase;letter-spacing:.08em}' +
    '.ama-si-or::before,.ama-si-or::after{content:"";flex:1;height:1px;background:var(--line,#dbe2dd)}' +
    '.ama-si-pkerr{margin:10px 0 0}' +
    '.hub-signin{width:100%}';
  function css() { if (document.getElementById('amaSiCss')) return; var st = document.createElement('style'); st.id = 'amaSiCss'; st.textContent = CSS; document.head.appendChild(st); }
  // 0412345678 -> 0412 345 678 as it's typed (+61 numbers left alone apart from spacing)
  function fmtMobile(v) { var d = String(v || '').replace(/[^\d+]/g, ''); if (/^04\d*/.test(d)) return [d.slice(0, 4), d.slice(4, 7), d.slice(7, 10)].filter(Boolean).join(' '); return d; }

  function mount(o) {
    var form = typeof o.form === 'string' ? document.querySelector(o.form) : o.form;
    if (!form || form.getAttribute('data-hub')) return;
    form.setAttribute('data-hub', '1');
    watchSignOut(o.sb); css();
    form.classList.add('ama-si-email');
    var wrap = document.createElement('div');
    wrap.className = 'hub-signin';
    var KEY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3m-3 3 2 2m-5 1 2 2"/></svg>';
    var pkTop = pkSupported() ? '<button type="button" class="ama-si-pk" id="hubPk">' + KEY_SVG + 'Sign in with a passkey</button><p class="ama-si-err ama-si-pkerr" id="hubPkErr" role="alert" style="display:none"></p><div class="ama-si-or">or</div>' : '';
    wrap.innerHTML =
      '<button type="button" id="hubShow" class="ama-si-alt">Use hub mobile and PIN instead</button>' +
      '<form id="hubForm" class="ama-si" style="display:none" novalidate>' +
        '<div><label for="hubMobile">Mobile</label><input type="tel" id="hubMobile" inputmode="tel" autocomplete="tel webauthn" placeholder="0400 000 000" enterkeyhint="next" required></div>' +
        '<div><label for="hubPin">Hub PIN</label><div class="ama-si-pin"><input type="password" id="hubPin" inputmode="numeric" autocomplete="current-password" placeholder="••••" enterkeyhint="go" required>' +
          '<button type="button" class="ama-si-eye" id="hubEye" aria-label="Show PIN">Show</button></div></div>' +
        '<p id="hubError" class="ama-si-err" role="alert" style="display:none"></p>' +
        '<button type="submit" class="ama-si-go" id="hubGo">Sign in</button>' +
        '<p class="ama-si-hint">The same mobile and PIN as the AMA Admin Hub.</p>' +
        '<button type="button" id="hubBack" class="ama-si-alt">Use email and password instead</button>' +
      '</form>';
    form.parentNode.insertBefore(wrap, form.nextSibling);
    if (pkTop) {   // the passkey button sits above whichever form is showing
      var top = document.createElement('div'); top.className = 'hub-signin ama-si-top'; top.innerHTML = pkTop; form.parentNode.insertBefore(top, form);
      var pkb = top.querySelector('#hubPk'), pke = top.querySelector('#hubPkErr');
      pkb.onclick = function () {
        pke.style.display = 'none'; pkb.disabled = true; var was = pkb.innerHTML; pkb.innerHTML = '<span class="ama-si-spin"></span>Waiting for your passkey…';
        passkey.signIn(o).then(function (r) { pkb.innerHTML = 'Signed in'; if (o.onSignedIn) o.onSignedIn(r); else location.reload(); })
          .catch(function (e) { var m = pkMsg(e); pkb.disabled = false; pkb.innerHTML = was; if (m) { pke.textContent = m; pke.style.display = ''; } });
      };
      // Ask for the passkey without a tap: on a device that has one, straight away (once per tab, a cancel stops it);
      // otherwise the passkey is offered in the Mobile box's autofill. Phones that don't allow an unprompted
      // request fall back to the autofill.
      var ac = null;
      function done(r) { if (o.onSignedIn) o.onSignedIn(r); else location.reload(); }
      function autofill() {
        if (!window.PublicKeyCredential || !PublicKeyCredential.isConditionalMediationAvailable) return;
        PublicKeyCredential.isConditionalMediationAvailable().then(function (ok) {
          if (!ok) return; ac = new AbortController();
          passkey.signIn(o, { mediation: 'conditional', signal: ac.signal }).then(done, function () {});
        }, function () {});
      }
      var pkClick = pkb.onclick; pkb.onclick = function () { if (ac) { ac.abort(); ac = null; } pkClick(); };
      o.sb.auth.getSession().then(function (r) {
        if (r && r.data && r.data.session) return;   // already signed in
        var asked = false; try { asked = sessionStorage.getItem('ama_pk_asked') === '1'; } catch (e) {}
        if (ls('ama_passkey_here') === '1' && !asked) {
          try { sessionStorage.setItem('ama_pk_asked', '1'); } catch (e) {}
          var t0 = Date.now(); pkb.disabled = true; var was = pkb.innerHTML; pkb.innerHTML = '<span class="ama-si-spin"></span>Waiting for your passkey…';
          passkey.signIn(o).then(done, function (e) {
            pkb.disabled = false; pkb.innerHTML = was;
            if (Date.now() - t0 < 600) { try { sessionStorage.removeItem('ama_pk_asked'); } catch (x) {} }   // the browser wouldn't ask without a tap
            var m = pkMsg(e); if (m && Date.now() - t0 >= 600) { pke.textContent = m; pke.style.display = ''; }
            autofill();
          });
        } else autofill();
      }, function () {});
    }
    var hubForm = wrap.querySelector('#hubForm'), show = wrap.querySelector('#hubShow'), err = wrap.querySelector('#hubError'), go = wrap.querySelector('#hubGo');
    var mob = wrap.querySelector('#hubMobile'), pin = wrap.querySelector('#hubPin'), eye = wrap.querySelector('#hubEye');
    var formDisplay = form.style.display;
    var saved = ls('ama_hub_mobile'); if (saved) mob.value = fmtMobile(saved);
    mob.addEventListener('input', function () { var end = mob.selectionStart === mob.value.length; var f = fmtMobile(mob.value); if (f !== mob.value) { mob.value = f; if (end) mob.setSelectionRange(f.length, f.length); } });
    mob.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pin.focus(); } });
    eye.onclick = function () { var on = pin.type === 'password'; pin.type = on ? 'text' : 'password'; eye.textContent = on ? 'Hide' : 'Show'; eye.setAttribute('aria-label', on ? 'Hide PIN' : 'Show PIN'); pin.focus(); };
    function say(m) { err.textContent = m; err.style.display = ''; err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake'); }
    function mode(hub) {
      form.style.display = hub ? 'none' : formDisplay;
      hubForm.style.display = hub ? 'flex' : 'none';
      show.style.display = hub ? 'none' : '';
      err.style.display = 'none';
      (hub ? (mob.value ? pin : mob) : form.querySelector('input')).focus();
    }
    show.onclick = function () { mode(true); };
    wrap.querySelector('#hubBack').onclick = function () { mode(false); };
    hubForm.onsubmit = function (e) {
      e.preventDefault();
      var m = mob.value.replace(/\s+/g, ''), p = pin.value.trim();
      if (m.replace(/\D/g, '').length < 9) { say('Enter your mobile number.'); mob.focus(); return; }
      if (p.length < 4) { say('Enter your hub PIN.'); pin.focus(); return; }
      go.disabled = true; go.innerHTML = '<span class="ama-si-spin"></span>Signing in…'; err.style.display = 'none';
      call(o, { mobile: m, pin: p }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || 'That mobile and PIN didn’t match. Check them and try again.');
        return o.sb.auth.setSession(r.session).then(function (s) {
          if (s && s.error) throw s.error;
          store.set(r.hub_token); ls('ama_hub_mobile', m); ls(PKS, null);
          go.innerHTML = 'Signed in';
          if (o.onSignedIn) o.onSignedIn(r); else location.reload();
        });
      }).catch(function (e2) {
        var msg = (e2 && e2.message) || '';
        if (/failed to fetch|network|load failed/i.test(msg)) msg = 'No connection. Check the Wi-Fi or signal and try again.';
        say(msg || 'Couldn’t sign in. Try again.'); pin.value = ''; pin.focus();
        go.disabled = false; go.textContent = 'Sign in';
      });
    };
    // Hub mobile + PIN is the default way in; email and password is the fallback (pass emailDefault:true to flip back).
    // No auto-focus, so phones don't pop the keyboard on load.
    if (o.emailDefault !== true) {
      form.style.display = 'none';
      hubForm.style.display = 'flex';
      show.style.display = 'none';
    }
  }

  function recheck(o) {
    watchSignOut(o.sb);
    var token = store.get();
    if (!token) {
      var pk = Number(ls(PKS) || 0);
      if (!pk || Date.now() - pk < EVERY) return Promise.resolve(true);
      return hubActive(o).then(function (ok) {   // signed in by passkey: hourly, is the hub still allowing this login?
        if (ok) { ls(PKS, String(Date.now())); return true; }
        ls(PKS, null);
        return o.sb.auth.signOut({ scope: 'local' }).then(function () { location.reload(); return false; });
      });
    }
    if (Date.now() - Number(ls(CHECKED) || 0) < EVERY) return Promise.resolve(true);   // checked recently
    return o.sb.auth.getSession().then(function (res) {
      if (!res.data.session) { store.set(null); return true; }
      return call(o, { check: token }).then(function (r) {
        if (r && r.ok === false && !r.error) {   // the hub said no (not a network or set-up problem)
          store.set(null);
          // A trusted device (the owner's own phone) stays signed in on its Supabase session even after the
          // 12-hour hub session ends — "Stay signed in on this device". Others are signed out as before.
          if (trustedDevice()) return true;
          return o.sb.auth.signOut({ scope: 'local' }).then(function () { location.reload(); return false; });
        }
        if (r && r.ok) ls(CHECKED, String(Date.now()));
        return true;
      });
    }).catch(function () { return true; });
  }

  window.AmaHub = { mount: mount, recheck: recheck, passkey: passkey };
})();

// @ts-nocheck
// AMA Toolkit: staff logins for AMA ID Cards, Coloured Belts, Black Belt Gradings, Long Service Awards and the dojang TV, in one place.
// The three grading apps have per-feature permissions (table app_permissions, supabase/app-permissions.sql).
//
// Deploy in Supabase: Edge Functions > Deploy a new function > Via Editor, name it "staff",
// paste this whole file, Deploy. Then turn OFF "Verify JWT with legacy secret" (or "Enforce JWT verification") for the function
// (it checks the signed-in person itself).
//
// Only Staff admins (table staff_admins, supabase/staff-admin.sql) and owners can use it. It can:
//   list      every login, with its AMA ID Cards, Black Belt Gradings and TV permissions
//   create    add a login with permissions, and either a starting password or a set-up link for them to choose
//             their own password (or update an existing login)
//   link      a new set-up link for an existing login (first sign-in, or a forgotten password)
//   password  set a new password for a login
// Set-up links open the welcome page below and work once. Nothing is emailed: you send the link yourself.
// How long they work is Supabase's "Email OTP Expiration" (Authentication > Providers > Email).
//   roles     change a login's permissions in either app
//   remove    delete a login and its permissions in both apps
//   hub       link a login to an AMA Admin Hub mobile (sign in with the hub mobile and PIN), or clear the link
//   details   change a login's name and mobile (the mobile is their hub mobile, for hub sign-in)
//   bulk      add many people at once from { people: [{ name, mobile }] }: hub sign-in only, no permissions
// Owners (supabase/owner.sql, table toolkit_owners) are protected: only the owner can change their own login.
// Every login has a name and a mobile. The email is optional: a login made with only a name and mobile signs in with
// the hub mobile and PIN. Supabase still needs an email for it, so it gets a stand-in one (hub-<mobile>@staff.amatoolkit.local)
// that nobody types; the apps show the name.
// AMA ID Cards needs supabase/permissions.sql (tick-box permissions) from the ama-id-cards repository.
// TV permissions need supabase/tv-setup.sql from this repository (until then they're left out).

export const CARD_PERMS = ['admin', 'edit', 'delete', 'send', 'approve', 'viewer', 'printer'];
export const TV_PERMS = ['edit', 'slides', 'screens', 'party', 'remote'];
// Per-feature permissions for each grading app (table app_permissions, supabase/app-permissions.sql). "admin" = everything in that app.
export const BB_PERMS = ['admin', 'view', 'attendance', 'readiness', 'essays', 'days', 'grading', 'results', 'scoring', 'calls', 'payments',
  'text_invite', 'text_result', 'text_followup', 'certificates', 'idcards', 'polos', 'set_general', 'set_fees', 'set_wording',
  'texts', 'settings'];   // 'texts' and 'settings' kept valid for legacy rows until a save replaces them with the split ticks
export const CB_PERMS = ['admin', 'view', 'days', 'belts', 'readiness', 'results', 'calls', 'payments',
  'text_invite', 'text_result', 'text_followup', 'set_general', 'set_fees', 'set_wording',
  'floor_admin', 'floor_sarah', 'floor_master', 'floor_signin',   // which floor plan screen they get (one at most; none = picked from their ticks)
  'texts', 'settings'];   // 'texts' and 'settings' kept valid for legacy rows until a save replaces them with the split ticks
export const AW_PERMS = ['admin', 'view', 'edit'];
export const WELCOME_URL = 'https://app.train-ama.com/welcome/';
// "AMA ID Cards, Black Belt Gradings and the dojang TV" (shown on the welcome page)
// The welcome page signs them in with this one-time code, then they choose a password
const setupLink = (data, type) => `${WELCOME_URL}#token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=${type}`;
const appNames = (card, bb, tv, cb, aw) => { const l = [card && card.length && 'AMA ID Cards', cb && cb.length && 'Coloured Belts', bb && bb.length && 'Black Belt Gradings', aw && aw.length && 'Long Service Awards', tv && tv.length && 'the dojang TV'].filter(Boolean);
  return l.length <= 1 ? (l[0] || 'the AMA Toolkit') : l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1]; };
const APPS = {
  card: { table: 'staff_permissions', col: 'permission', allowed: CARD_PERMS, name: 'AMA ID Cards' },
  bb: { table: 'app_permissions', col: 'perm', app: 'bb', allowed: BB_PERMS, name: 'Black Belt Gradings' },
  cb: { table: 'app_permissions', col: 'perm', app: 'cb', allowed: CB_PERMS, name: 'Coloured Belts' },
  aw: { table: 'app_permissions', col: 'perm', app: 'awards', allowed: AW_PERMS, name: 'Long Service Awards' },
  tv: { table: 'tv_permissions', col: 'permission', allowed: TV_PERMS, name: 'Dojang TV' }
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (msg, status = 400) => json({ error: msg }, status);
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const last9 = v => String(v || '').replace(/\D/g, '').slice(-9);
const showMobile = m => m ? '0' + m.slice(0, 3) + ' ' + m.slice(3, 6) + ' ' + m.slice(6) : null;
const HUB_DOMAIN = '@staff.amatoolkit.local';
export const hubEmail = m => `hub-${m}${HUB_DOMAIN}`;
const randomPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
const cleanName = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const NEEDS_UPDATE = 'AMA ID Cards needs its tick-box permissions update first: run supabase/permissions.sql (from the ama-id-cards repository) in Supabase > SQL Editor.';

async function allUsers(db) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 200) break;
  }
  return out;
}
const findUser = async (db, email) => (await allUsers(db)).find(u => (u.email || '').toLowerCase() === email) || null;
const clean = (list, allowed) => [...new Set((list || []).filter(r => allowed.includes(r)))];
const cardWantOf = b => b.card_perms === undefined ? undefined : clean(b.card_perms, CARD_PERMS);
// An app's ticks: admin covers everything, so it's kept on its own; any tick also means they can open the app ("view")
// A floor plan screen (floor_*) is a choice, not a feature: at most one, and kept alongside admin
const featWant = (list, allowed) => { if (list === undefined) return undefined; const all = clean(list, allowed);
  const floor = all.filter(x => x.startsWith('floor_')).slice(0, 1), l = all.filter(x => !x.startsWith('floor_'));
  return l.includes('admin') ? ['admin', ...floor] : (l.length || floor.length) && !l.includes('view') ? ['view', ...l, ...floor] : [...l, ...floor]; };
const bbWantOf = b => featWant(b.bb_perms, BB_PERMS), cbWantOf = b => featWant(b.cb_perms, CB_PERMS), awWantOf = b => featWant(b.aw_perms, AW_PERMS);
const GRADING_APPS = [['bb', bbWantOf], ['cb', cbWantOf], ['aw', awWantOf]];
// "TV editor" includes party mode and the remote, so it's kept on its own
const tvWantOf = (b, ready) => b.tv_perms === undefined || !ready ? undefined : (l => l.includes('edit') ? ['edit'] : l)(clean(b.tv_perms, TV_PERMS));

// Make one app's permissions for this email exactly "want" (adds first, so an admin is never lost half way)
async function setPerms(db, app, email, want) {
  const A = APPS[app], scope = q => A.app ? q.eq('app', A.app) : q;
  if (want.length) {
    const { error } = await db.from(A.table).upsert(want.map(v => ({ email, [A.col]: v, ...(A.app ? { app: A.app } : {}) })), { onConflict: A.app ? `email,app,${A.col}` : `email,${A.col}`, ignoreDuplicates: true });
    if (error) throw error;
  }
  const { data: have, error: e2 } = await scope(db.from(A.table).select(A.col).eq('email', email));
  if (e2) throw e2;
  const drop = (have || []).map(r => r[A.col]).filter(v => !want.includes(v));
  if (drop.length) {
    const { error } = await scope(db.from(A.table).delete().eq('email', email)).in(A.col, drop);
    if (error) throw error;
  }
}

// Each app must keep at least one admin
async function lastAdmin(db, app, email, want) {
  if (want.includes('admin')) return null;
  const A = APPS[app];
  let q = db.from(A.table).select('email').eq(A.col, 'admin'); if (A.app) q = q.eq('app', A.app);
  const { data } = await q;
  if (!(data || []).some(r => r.email === email)) return null;   // not an admin there now: nothing to lose
  return (data || []).some(r => r.email !== email) ? null : `${A.name} must keep at least one admin.`;
}

export async function handle(req, db) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = token ? await db.auth.getUser(token) : { data: null };
    const me = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
    if (!me) return fail('Sign in first.', 401);
    const cardReady = !(await db.from('staff_permissions').select('email').limit(1)).error;
    if (!cardReady) return fail(NEEDS_UPDATE, 409);
    // Managing staff logins now needs the dedicated "Staff admin" permission (table staff_admins), or being an owner.
    // Seeded from the people who were admin in both apps, so the cutover changed nobody's access.
    const [{ data: amAdmin }, { data: amOwner }] = await Promise.all([
      db.from('staff_admins').select('email').eq('email', me).maybeSingle(),
      db.from('toolkit_owners').select('email').eq('email', me).maybeSingle()
    ]);
    if (!(amAdmin || amOwner)) return fail('Only Staff admins can manage staff logins. Ask a Staff admin or the owner to add you.', 403);
    // Append-only record of every change (table toolkit_audit). Never fails the action it logs.
    const audit = (a, target, detail = {}) => db.from('toolkit_audit').insert({ actor_email: me, action: a, target_email: target || null, detail }).then(() => {}, () => {});

    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const tvReady = !(await db.from('tv_permissions').select('email').limit(1)).error;
    // Hub mobile links need supabase/hub-login.sql
    const hubRes = await db.from('hub_logins').select('email, mobile9');
    const hubReady = !hubRes.error, hubOf = new Map((hubRes.data || []).map(r => [r.email, r.mobile9]));
    // Owners: nobody else can change their login (supabase/owner.sql)
    const ownRes = await db.from('toolkit_owners').select('email');
    const owners = new Set(ownRes.error ? [] : (ownRes.data || []).map(r => String(r.email).toLowerCase()));
    // Staff admins: the people allowed to manage logins (table staff_admins). Owners are always included.
    const saRes = await db.from('staff_admins').select('email');
    const staffAdmins = new Set(saRes.error ? [] : (saRes.data || []).map(r => String(r.email).toLowerCase()));

    if (action === 'list') {
      const [users, cardRes, appRes, tvRes] = await Promise.all([allUsers(db), db.from('staff_permissions').select('email, permission'), db.from('app_permissions').select('email, app, perm'),
        tvReady ? db.from('tv_permissions').select('email, permission') : Promise.resolve({ data: [] })]);
      if (cardRes.error) throw cardRes.error;
      if (appRes.error) throw appRes.error;
      if (tvRes.error) throw tvRes.error;
      const card = new Map(), tv = new Map(), feat = { bb: new Map(), cb: new Map(), awards: new Map() };
      (cardRes.data || []).forEach(r => card.set(r.email, [...(card.get(r.email) || []), r.permission]));
      (appRes.data || []).forEach(r => { const m = feat[r.app]; if (m) m.set(r.email, [...(m.get(r.email) || []), r.perm]); });
      (tvRes.data || []).forEach(r => tv.set(r.email, [...(tv.get(r.email) || []), r.permission]));
      const order = (list, all) => (list || []).sort((a, b) => all.indexOf(a) - all.indexOf(b));
      // setup_pending: made with a set-up link that hasn't been used yet (the welcome page clears it)
      const meta = u => (u && u.user_metadata) || {};
      const row = (email, u) => ({ email, has_login: !!u, created_at: u ? u.created_at : null, last_sign_in_at: u && u.last_sign_in_at || null,
        name: meta(u).full_name || null, hub_only: email.endsWith(HUB_DOMAIN),
        setup_pending: meta(u).setup_pending === true, setup_at: meta(u).setup_at || null,
        card_perms: order(card.get(email), CARD_PERMS), tv_perms: order(tv.get(email), TV_PERMS),
        bb_perms: order(feat.bb.get(email), BB_PERMS), cb_perms: order(feat.cb.get(email), CB_PERMS), aw_perms: order(feat.awards.get(email), AW_PERMS),
        hub_mobile: showMobile(hubOf.get(email)) });
      const rows = users.filter(u => u.email).map(u => row(u.email.toLowerCase(), u));
      const seen = new Set(rows.map(r => r.email));
      // Permissions given to an email that has no login yet
      new Set([...card.keys(), ...feat.bb.keys(), ...feat.cb.keys(), ...feat.awards.keys(), ...tv.keys()]).forEach(email => { if (!seen.has(email)) rows.push(row(email, null)); });
      rows.sort((a, b) => a.email.localeCompare(b.email));
      rows.forEach(r => { r.owner = owners.has(r.email); r.staff_admin = staffAdmins.has(r.email) || owners.has(r.email); });
      // Recent activity (newest first), for the log on the Staff logins page
      const { data: log } = await db.from('toolkit_audit').select('at, actor_email, action, target_email, detail').order('at', { ascending: false }).limit(100);
      return json({ me, me_owner: owners.has(me), me_staff_admin: true, users: rows, card_perms: CARD_PERMS, bb_perms: BB_PERMS, cb_perms: CB_PERMS, aw_perms: AW_PERMS,
        tv_perms: tvReady ? TV_PERMS : null, hub: hubReady, audit: log || [] });
    }

    // Link (or move) a mobile to a login; '' on a clash means OK. Checked before anything is made.
    const mobileClash = (m, email) => { const other = [...hubOf].find(([e, v]) => v === m && e !== email); return other ? other[0] : null; };
    const whoIs = e => e.endsWith(HUB_DOMAIN) ? 'someone else' : e;
    const linkMobile = async (email, m) => {
      const { error } = await db.from('hub_logins').upsert({ email, mobile9: m, updated_at: new Date().toISOString(), updated_by: me }, { onConflict: 'email' });
      if (error) throw error; hubOf.set(email, m);
    };
    // A login with no email: hub sign-in only, stand-in email, no password anyone knows
    const makeHubOnly = async (name, m, perms) => {
      const email = hubEmail(m);
      const { error } = await db.auth.admin.createUser({ email, password: randomPassword(), email_confirm: true, user_metadata: { full_name: name, hub_only: true } });
      if (error) throw error;
      await setPerms(db, 'card', email, perms.card || []);
      for (const app of ['bb', 'cb', 'aw']) await setPerms(db, app, email, perms[app] || []);
      if (tvReady) await setPerms(db, 'tv', email, perms.tv || []);
      await linkMobile(email, m);
      return email;
    };
    const setName = async (email, name) => {
      const u = await findUser(db, email); if (!u) return;
      const { error } = await db.auth.admin.updateUserById(u.id, { user_metadata: { full_name: name || null } });
      if (error) throw error;
    };

    if (action === 'bulk') {
      if (!hubReady) return fail('Run supabase/hub-login.sql in Supabase > SQL Editor first.', 409);
      const people = Array.isArray(body.people) ? body.people.slice(0, 300) : [];
      const out = { added: [], skipped: [] };
      const seen = new Set();
      for (const p of people) {
        const name = cleanName(p && p.name), m = last9(p && p.mobile);
        if (!name || m.length !== 9) { out.skipped.push({ name: name || '?', why: 'needs a name and a mobile' }); continue; }
        if (seen.has(m)) { out.skipped.push({ name, why: 'that mobile is listed twice' }); continue; }
        seen.add(m);
        const clash = mobileClash(m, null);
        if (clash) { out.skipped.push({ name, why: 'already has a login' }); continue; }
        try { await makeHubOnly(name, m, {}); out.added.push(name); }
        catch (e) { out.skipped.push({ name, why: String(e && e.message || e) }); }
      }
      await audit('bulk', null, { added: out.added.length, skipped: out.skipped.length });
      return json({ ok: true, ...out });
    }

    let email = String(body.email || '').trim().toLowerCase();
    const name = body.name === undefined ? undefined : cleanName(body.name);
    const mobile = body.mobile === undefined ? undefined : last9(body.mobile);
    if (action === 'create' && !email) {
      // Name and mobile only: hub sign-in
      if (!hubReady) return fail('Run supabase/hub-login.sql in Supabase > SQL Editor first.', 409);
      if (!name) return fail('Enter their name.');
      if (!mobile || mobile.length !== 9) return fail('Enter their mobile, or an email.');
      const clash = mobileClash(mobile, null);
      if (clash) return fail(`That mobile already belongs to ${whoIs(clash)}.`);
      const made = await makeHubOnly(name, mobile, { card: cardWantOf(body), bb: bbWantOf(body), cb: cbWantOf(body), aw: awWantOf(body), tv: tvWantOf(body, tvReady) });
      await audit('create', made, { hub_only: true });
      return json({ ok: true, existed: false, email: made, hub_only: true });
    }
    if (!validEmail(email)) return fail('Enter a valid email address.');
    if (owners.has(email) && email !== me) return fail("This is the owner's login. Only they can change it.", 403);
    const password = String(body.password || '');
    const cardWant = cardWantOf(body), tvWant = tvWantOf(body, tvReady);
    const appWant = Object.fromEntries(GRADING_APPS.map(([app, f]) => [app, f(body)]));
    const setGrading = async (empty) => { for (const [app] of GRADING_APPS) if (appWant[app] !== undefined || empty) await setPerms(db, app, email, appWant[app] || []); };

    if (action === 'create') {
      if (mobile && hubReady) { const clash = mobileClash(mobile, email); if (clash) return fail(`That mobile already belongs to ${whoIs(clash)}.`); }
      if (mobile && mobile.length !== 9) return fail('Enter a full mobile number, or leave it blank.');
      const existing = await findUser(db, email);
      const extras = async () => { if (name) await setName(email, name); if (mobile && hubReady) await linkMobile(email, mobile); };
      if (!existing && body.invite === true) {
        // Permissions first (an email can have them before it has a login), then the onboarding email
        await setPerms(db, 'card', email, cardWant || []);
        await setGrading(true);
        if (tvReady) await setPerms(db, 'tv', email, tvWant || []);
        const { data, error } = await db.auth.admin.generateLink({ type: 'invite', email, options: { data: { apps: appNames(cardWant, appWant.bb, tvWant, appWant.cb, appWant.aw), invited_by: me, setup_pending: true, ...(name ? { full_name: name } : {}) } } });
        if (error) return fail(`The permissions are saved, but the login wasn't made: ${error.message}`);
        if (mobile && hubReady) await linkMobile(email, mobile);
        await audit('create', email, { invite: true });
        return json({ ok: true, existed: false, link: setupLink(data, 'invite') });
      }
      if (!existing) {
        if (password.length < 8) return fail('The password needs at least 8 characters.');
        const { error } = await db.auth.admin.createUser({ email, password, email_confirm: true, ...(name ? { user_metadata: { full_name: name } } : {}) });
        if (error) return fail(error.message);
      } else if (password) {
        if (password.length < 8) return fail('The password needs at least 8 characters.');
        const { error } = await db.auth.admin.updateUserById(existing.id, { password });
        if (error) return fail(error.message);
      }
      await setPerms(db, 'card', email, cardWant || []);
      await setGrading(true);
      if (tvReady) await setPerms(db, 'tv', email, tvWant || []);
      await extras();
      await audit('create', email, { existed: !!existing });
      return json({ ok: true, existed: !!existing });
    }

    if (action === 'details') {
      const user = await findUser(db, email);
      if (!user) return fail('There is no login for that email.', 404);
      if (name !== undefined) { if (!name) return fail('Enter their name.'); await setName(email, name); }
      if (mobile !== undefined && hubReady) {
        if (!mobile) {
          if (email.endsWith(HUB_DOMAIN)) return fail('This login signs in with their mobile, so it needs one.');
          const { error } = await db.from('hub_logins').delete().eq('email', email); if (error) throw error;
        } else {
          if (mobile.length !== 9) return fail('Enter a full mobile number.');
          const clash = mobileClash(mobile, email); if (clash) return fail(`That mobile already belongs to ${whoIs(clash)}.`);
          await linkMobile(email, mobile);
        }
      }
      await audit('details', email, { name, mobile });
      return json({ ok: true });
    }

    if ((action === 'link' || action === 'password') && email.endsWith(HUB_DOMAIN))
      return fail('This login signs in with their hub mobile and PIN, so it has no password. Change their PIN in the hub.');

    if (action === 'link') {
      const user = await findUser(db, email);
      if (!user) return fail('That email has no login yet. Use Add login.');
      const { data, error } = await db.auth.admin.generateLink({ type: 'recovery', email });
      if (error) return fail(`Couldn't make a link: ${error.message}`);
      await audit('link', email);
      return json({ ok: true, link: setupLink(data, 'recovery') });
    }

    if (action === 'password') {
      if (password.length < 8) return fail('The password needs at least 8 characters.');
      const user = await findUser(db, email);
      if (!user) return fail('There is no login for that email.', 404);
      const { error } = await db.auth.admin.updateUserById(user.id, { password });
      if (error) return fail(error.message);
      await audit('password', email);
      return json({ ok: true });
    }

    // Force sign-out: revoke the login's sessions so they're signed out on every device.
    if (action === 'signout') {
      const user = await findUser(db, email);
      if (!user) return fail('There is no login for that email.', 404);
      const { data: n, error } = await db.rpc('force_signout', { p_email: email });
      if (error) return fail(error.message);
      await audit('signout', email, { sessions: n || 0 });
      return json({ ok: true, sessions: n || 0 });
    }

    if (action === 'hub') {
      if (!hubReady) return fail('Run supabase/hub-login.sql in Supabase > SQL Editor first.', 409);
      const m = last9(body.mobile);
      if (email.endsWith(HUB_DOMAIN) && !m) return fail('This login signs in with their mobile, so it needs one.');
      if (!m) {
        const { error } = await db.from('hub_logins').delete().eq('email', email);
        if (error) throw error;
        await audit('hub', email, { cleared: true });
        return json({ ok: true, hub_mobile: null });
      }
      if (m.length !== 9) return fail('Enter the mobile number the person uses for the hub.');
      if (!(await findUser(db, email))) return fail('That email has no login yet. Add the login first.');
      const other = [...hubOf].find(([e, v]) => v === m && e !== email);
      if (other) return fail(`That mobile is already linked to ${whoIs(other[0])}.`);
      const { error } = await db.from('hub_logins').upsert({ email, mobile9: m, updated_at: new Date().toISOString(), updated_by: me }, { onConflict: 'email' });
      if (error) throw error;
      await audit('hub', email, { mobile: showMobile(m) });
      return json({ ok: true, hub_mobile: showMobile(m) });
    }

    if (action === 'roles') {
      if (email === me && ((cardWant && !cardWant.includes('admin')) || (appWant.bb && !appWant.bb.includes('admin'))))
        return fail("You can't remove your own admin access.");
      for (const [app, want] of [['card', cardWant], ['bb', appWant.bb], ['cb', appWant.cb], ['aw', appWant.aw]]) {
        if (!want) continue;
        const last = await lastAdmin(db, app, email, want);
        if (last) return fail(last);
      }
      if (cardWant) await setPerms(db, 'card', email, cardWant);
      await setGrading(false);
      if (tvWant) await setPerms(db, 'tv', email, tvWant);
      await audit('roles', email, { card: cardWant, bb: appWant.bb, cb: appWant.cb, awards: appWant.aw, tv: tvWant });
      return json({ ok: true });
    }

    if (action === 'remove') {
      if (email === me) return fail("You can't remove yourself.");
      for (const app of ['card', 'bb', 'cb', 'aw']) { const last = await lastAdmin(db, app, email, []); if (last) return fail(last); }
      for (const app of ['bb', 'cb', 'aw']) await setPerms(db, app, email, []);
      await db.from('prep_roles').delete().eq('email', email);   // older roles, filled in from Black Belt permissions
      await setPerms(db, 'card', email, []);
      if (tvReady) await setPerms(db, 'tv', email, []);
      await db.from('staff_roles').delete().eq('email', email); // old single roles, if still there
      if (hubReady) await db.from('hub_logins').delete().eq('email', email);
      await db.from('staff_admins').delete().eq('email', email); // drop the Staff admin permission too
      const user = await findUser(db, email);
      if (user) {
        await db.from('push_subscriptions').delete().eq('user_email', email); // phone notifications, if set up
        const { error } = await db.auth.admin.deleteUser(user.id);
        if (error) return fail(error.message);
      }
      await audit('remove', email);
      return json({ ok: true });
    }

    // Grant or remove the "Staff admin" permission (who can manage logins). Owners are always Staff admins.
    if (action === 'staff_admin') {
      if (!validEmail(email) && !email.endsWith(HUB_DOMAIN)) return fail('Enter a valid email.');
      if (owners.has(email)) return fail('The owner is always a Staff admin.');
      const on = body.on === true;
      if (email === me && !on) return fail("You can't remove your own Staff admin access.");
      if (on) {
        if (!(await findUser(db, email))) return fail('That person has no login yet. Add the login first.');
        const { error } = await db.from('staff_admins').upsert({ email, added_by: me }, { onConflict: 'email' });
        if (error) throw error;
      } else {
        const { count } = await db.from('staff_admins').select('email', { count: 'exact', head: true });
        if ((count || 0) <= 1) return fail('There must be at least one Staff admin.');
        const { error } = await db.from('staff_admins').delete().eq('email', email);
        if (error) throw error;
      }
      await audit('staff_admin', email, { on });
      return json({ ok: true });
    }

    return fail('Unknown action.');
  } catch (e) {
    console.error(e);
    return fail(String(e && e.message || e), 500);
  }
}

if (typeof Deno !== 'undefined') {
  const { createClient } = await import('npm:@supabase/supabase-js@2.45.4');
  const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  Deno.serve(req => handle(req, db));
}

// The landing page (shows only the apps each login can use) and the welcome page (choose a password from
// the onboarding email), in a headless browser with a pretend Supabase. Run: node tests/landing-page.test.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const UMD = readFileSync(process.env.SUPABASE_UMD || join(here, '../../black-belt-gradings/tests/node_modules/@supabase/supabase-js/dist/umd/supabase.js'), 'utf8');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// Who can do what
const people = {
  'tate@ama.test': { pw: 'password1', card: ['admin'], prep: ['admin'], tv: ['edit', 'party', 'remote'], owner: true },
  'coach@ama.test': { pw: 'password1', card: [], prep: ['instructor'], tv: [] },
  'party@ama.test': { pw: 'password1', card: [], prep: [], tv: ['party'] },
  'nothing@ama.test': { pw: 'password1', card: [], prep: [], tv: [] },
  'new@ama.test': { pw: null, card: [], prep: ['attendance'], tv: [], meta: { apps: 'Black Belt Gradings' } }
};
const tokenFor = e => 'tok-' + e;
const emailOf = req => { const t = (req.headers()['authorization'] || '').replace(/^Bearer\s+/i, ''); return t.startsWith('tok-') ? t.slice(4) : null; };
const mail = [], used = new Set();
const userJson = e => ({ id: 'id-' + e, email: e, aud: 'authenticated', role: 'authenticated', user_metadata: people[e].meta || {} });

const browser = await chromium.launch();
async function context() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: UMD }));
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('https://ptdrcxngaptcgswfbjhg.supabase.co/**', async r => {
    const req = r.request(), url = new URL(req.url()), json = (b, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.pathname === '/auth/v1/token') {
      const { email, password } = JSON.parse(req.postData() || '{}'), p = people[email];
      if (!p || p.pw !== password) return json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400);
      return json({ access_token: tokenFor(email), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: userJson(email) });
    }
    if (url.pathname === '/auth/v1/user') {
      const e = emailOf(req); if (!e) return json({ msg: 'no user' }, 401);
      if (req.method() === 'PUT') { const b = JSON.parse(req.postData()); if (b.password) people[e].pw = b.password; if (b.data) people[e].meta = { ...(people[e].meta || {}), ...b.data }; }
      return json(userJson(e));
    }
    if (url.pathname === '/auth/v1/verify') {
      const { token_hash, type } = JSON.parse(req.postData() || '{}'), m = /^hash-(\w+)-(.+)$/.exec(token_hash || '');
      if (!m || m[1] !== type || used.has(token_hash)) return json({ code: 403, error_code: 'otp_expired', msg: 'Email link is invalid or has expired' }, 403);
      used.add(token_hash);
      return json({ access_token: tokenFor(m[2]), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: userJson(m[2]) });
    }
    if (url.pathname === '/auth/v1/recover') { mail.push({ email: JSON.parse(req.postData()).email, redirect: url.searchParams.get('redirect_to') }); return json({}); }
    if (url.pathname === '/auth/v1/logout') return r.fulfill({ status: 204, body: '' });
    if (url.pathname === '/rest/v1/toolkit_owners') {
      const e = emailOf(req); return json(e && people[e] && people[e].owner ? [{ email: e }] : []);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.split('/').pop(), p = people[emailOf(req)] || { card: [], prep: [], tv: [] };
      if (fn === 'my_permissions') return json(p.card);
      if (fn === 'prep_my_roles') return json(p.prep);
      if (fn === 'tv_can') { const perm = JSON.parse(req.postData() || '{}').p_perm; return json(p.card.includes('admin') || p.tv.includes(perm) || (perm !== 'edit' && p.tv.includes('edit'))); }
    }
    return json({});
  });
  return ctx;
}
const LANDING = pathToFileURL(join(here, '../../../site/index.html')).href;
const shot = async (page, n) => { if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, n + '.png'), fullPage: true }); };
const names = async page => page.$$eval('#apps a.item .name', ns => ns.map(n => n.firstChild.textContent.trim()));   // real apps (not "Coming soon")
async function signIn(page, email) {
  await page.goto(LANDING); await page.waitForSelector('#signIn:not([hidden])');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', email); await page.fill('#siPass', 'password1'); await page.click('#siGo');
  await page.waitForSelector('#apps:not([hidden])');
}

try {
  console.log('Landing page');
  let ctx = await context(), page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(LANDING); await page.waitForSelector('#signIn:not([hidden])');
  await shot(page, 'landing-signin');
  ok(await page.isHidden('#apps') && (await page.$$('#apps .item')).length === 0, 'signed out, it asks you to sign in and shows no apps');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'wrong'); await page.click('#siGo');
  await page.waitForSelector('#siMsg:not([hidden])');
  ok((await page.textContent('#siMsg')).includes('Wrong email or password'), 'a wrong password says so');
  await page.fill('#siPass', 'password1'); await page.click('#siGo'); await page.waitForSelector('#apps:not([hidden])');
  let n = await names(page);
  ok(['Gradings', 'Long service awards', 'TV Display', 'Tablet Display', 'TV Remote', 'Play on this screen', 'Clipboard', 'Staff logins', 'Supabase'].every(x => n.includes(x)), 'an admin sees every app (' + n.join(', ') + ')');
  ok((await page.textContent('#who')) === 'tate@ama.test', 'it shows who is signed in');
  await page.reload(); await page.waitForSelector('#apps:not([hidden])'); await shot(page, 'landing-apps');
  ok((await names(page)).length === n.length, 'it remembers the sign-in');
  await page.click('#signOut'); await page.waitForSelector('#signIn:not([hidden])');
  ok(true, 'Sign out goes back to the sign-in');

  await signIn(page, 'coach@ama.test'); n = await names(page);
  ok(n.join() === 'Gradings,Long service awards', 'an instructor sees Gradings and Long service awards (' + n.join(', ') + ')');
  ok((await page.$$eval('#apps h2', hs => hs.map(h => h.textContent))).join() === 'Gradings,Members' && (await page.$('#apps a[href="grading/"]')) && !(await page.$('#apps a[href*="coloured-belts"]')), 'gradings are one link, to the /grading/ hub (coloured belts, Black Belt Gradings and ID cards are there)');
  await page.click('#signOut'); await page.waitForSelector('#signIn:not([hidden])');
  await signIn(page, 'party@ama.test'); n = await names(page);
  ok(n.includes('TV party mode') && n.includes('Tablet party mode') && !n.includes('TV Remote') && !n.includes('Gradings') && !n.includes('Staff logins'), 'party mode only sees the party pages (' + n.join(', ') + ')');
  await page.click('#signOut'); await page.waitForSelector('#signIn:not([hidden])');
  await signIn(page, 'nothing@ama.test');
  ok((await page.textContent('#apps')).includes("doesn't have access to any apps"), 'a login with no permissions is told to ask an admin');
  await page.click('#signOut'); await page.waitForSelector('#signIn:not([hidden])');

  await page.click('#forgot');
  ok((await page.textContent('#siMsg')).includes('Ask an admin for a new set-up link'), '"Forgot your password?" says to ask an admin for a set-up link');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();

  console.log('\nWelcome page');
  ctx = await context(); page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
  const W = pathToFileURL(join(here, '../../../site/welcome/index.html')).href;
  await page.goto(W + '#token_hash=hash-invite-new@ama.test&type=invite'); await page.waitForTimeout(400); await shot(page, 'welcome');
  await page.waitForSelector('#setPw:not([hidden])', { timeout: 6000 }).catch(() => {});
  ok(await page.isVisible('#setPw') && (await page.textContent('#spFor')).includes('new@ama.test') && (await page.textContent('#spFor')).includes('Black Belt Gradings'), 'the link from the email opens "Choose your password", with their apps');
  ok(!page.url().includes('token_hash'), 'the code is taken out of the address bar');
  await page.fill('#spPass', 'newpass12'); await page.fill('#spPass2', 'newpass13'); await page.click('#spGo');
  ok((await page.textContent('#spMsg')).includes("don't match"), 'the two passwords must match');
  await page.fill('#spPass2', 'newpass12'); await page.click('#spGo'); await page.waitForSelector('#done:not([hidden])');
  ok(people['new@ama.test'].pw === 'newpass12' && people['new@ama.test'].meta.setup_pending === false && !!people['new@ama.test'].meta.setup_at, 'the password is saved, and they are marked as set up');
  ok(await page.getAttribute('#done a', 'href') === '../', '"Open your apps" goes to the landing page');
  await page.goto(LANDING); await page.waitForSelector('#apps:not([hidden])');
  ok((await names(page)).join() === 'Gradings', 'where they are already signed in, and see their apps');
  await page.goto(W + '#token_hash=hash-invite-new@ama.test&type=invite');
  await page.waitForSelector('#problem:not([hidden])');
  ok((await page.textContent('#problem')).includes('run out'), 'a used or old link says it has run out and what to do');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();
} catch (e) { failed++; console.log('  FAIL  stopped: ' + e.message); }
await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

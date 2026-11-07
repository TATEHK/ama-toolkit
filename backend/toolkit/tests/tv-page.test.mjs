// Browser test for the TV display: the editor at phone size and the TV page at TV size, against a local
// stand-in for Supabase holding the real AMA ID Cards, Black Belt Gradings and TV databases.
// Run: node tests/tv-page.test.mjs  (uses the black-belt-prep-system test tools; set PREP_TESTS / CARD_REPO if elsewhere)
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const PREP_TESTS = process.env.PREP_TESTS || join(here, '../../black-belt-gradings/tests');
const PREP = join(PREP_TESTS, '..');
const CARD = process.env.CARD_REPO || join(here, '../../id-cards');
const { PGlite } = await import(join(PREP_TESTS, 'node_modules/@electric-sql/pglite/dist/index.js'));
const { startServer } = await import(pathToFileURL(join(PREP_TESTS, 'fake-supabase.mjs')).href);
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const read = p => readFileSync(p, 'utf8');
const PDFJS = process.env.PDFJS || '/tmp/claude-0/-home-claude/eaa02a79-d300-5a00-9b7a-e09b12f5efb0/scratchpad/pdfjs/node_modules/pdfjs-dist/build';   // pdfjs-dist@3.11.174
const QRDIR = process.env.QR_MODULES || '/tmp/claude-0/-home-claude/eaa02a79-d300-5a00-9b7a-e09b12f5efb0/scratchpad/qr/node_modules';   // qrcode-generator@1.4.4, jsqr, pngjs
const SHOTS = process.env.SHOT_DIR || join(tmpdir(), 'tv-shots'); mkdirSync(SHOTS, { recursive: true });
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// ---- Database ----
const { pgcrypto } = await import(join(PREP_TESTS, 'node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js'));
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;`);
await db.exec(read(join(PREP_TESTS, 'supabase-stub.sql')));
await db.exec(`grant usage on schema public to anon;`);
await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'tate@ama.test'), ('00000000-0000-0000-0000-000000000002', 'jo@ama.test')`);
for (const f of ['setup.sql', 'roles.sql', 'printed.sql', 'permissions.sql']) await db.exec(read(join(CARD, 'supabase', f)));
await db.exec(read(join(PREP, 'supabase/prep-setup.sql')));
for (let i = 1; i <= 8; i++) await db.exec(read(join(PREP, `supabase/prep-update-0${i}.sql`)));
await db.exec(`delete from staff_permissions where email <> 'tate@ama.test'; delete from prep_roles where email <> 'tate@ama.test';`);
await db.exec(read(join(ROOT, 'supabase/tv-setup.sql')));
// What party each screen is showing now: started now (a booking from now) or booked, or the older way (only_slide)
await db.exec(`create view party_now as
  select st.id, coalesce(case when st.only_until > now() then st.only_slide end, b.slide_id) only_slide,
         coalesce(case when st.only_until > now() then st.only_until end, b.ends_at) only_until
    from tv_settings st left join lateral (select bb.slide_id, bb.ends_at from tv_party_bookings bb join tv_slides bs on bs.id = bb.slide_id
      where bs.display = st.display and bb.starts_at <= now() and bb.ends_at > now() order by bb.starts_at desc limit 1) b on true`);
// Black Belt Gradings data for the live slides
await db.exec(`set role authenticated; select set_config('request.jwt.claims', '{"email":"tate@ama.test"}', false);
  insert into prep_students (student_id, full_name, certificate_name, belt_rank) values ('T1', 'Kara Lee', 'Kara Jane Lee', 'Cho Dan Bo'), ('T2', 'Sam Park', null, '1st Dan Level 1');`);
const cid = (await db.query(`select prep_start_new_cycle('Term 4 2026', null, null, array[current_date - 14, current_date + 1, current_date + 15, current_date + 29]::date[], 0, null, array['T1','T2']) id`)).rows[0].id;
await db.query(`update prep_cycles set grading_date = current_date + 43 where cycle_id = $1`, [cid]);
await db.query(`select prep_activate_cycle($1, true)`, [cid]);
await db.exec(`reset role; select set_config('request.jwt.claims', '', false)`);
await db.query(`insert into prep_grading (student_id, cycle_id, grading_event, grading_date, target_rank, result, eligibility_decision, decision_reason, status) values
  ('T1', $1, 'Recent', current_date - 3, 'Probationary Black Belt', 'passed', 'eligible', 'test', 'completed'),
  ('T2', $1, 'Recent', current_date - 3, '2nd Dan', 'passed', 'eligible', 'test', 'completed')`, [cid]);
const CODE = (await db.query(`select screen_code from tv_settings where id = 1`)).rows[0].screen_code;

const users = { 'tate@ama.test': { id: '00000000-0000-0000-0000-000000000001', password: 'pw' }, 'jo@ama.test': { id: '00000000-0000-0000-0000-000000000002', password: 'pw' } };
let BASE;
const server = await startServer({ db, appDir: join(here, '../../../site'), users, config: '' });
BASE = `http://localhost:${server.address().port}`;
const configJs = `window.TOOLKIT_CONFIG = { SUPABASE_URL: '${BASE}', SUPABASE_KEY: 'test' };`;
const files = new Map();   // the "tv" storage bucket
const browser = await chromium.launch();
const errors = [];
async function context(size, offline = false) {
  const ctx = await browser.newContext({ viewport: size, serviceWorkers: 'block', ...(size.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: r.request().url().includes('qrcode-generator') ? read(join(QRDIR, 'qrcode-generator/qrcode.js')) : read(join(PREP_TESTS, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')) }));
  if (process.env.FONTS_DIR) {   // real poster fonts (from @fontsource) instead of none
    await ctx.route('https://fonts.googleapis.com/**', r => {
      const fam = decodeURIComponent((r.request().url().split('family=')[1] || '').split('&')[0]).split(':')[0].replace(/\+/g, ' ');
      const file = { 'Luckiest Guy': 'luckiest-guy/files/luckiest-guy-latin-400-normal.woff2', 'Knewave': 'knewave/files/knewave-latin-400-normal.woff2', 'Montserrat': 'montserrat/files/montserrat-latin-800-normal.woff2' }[fam];
      r.fulfill({ contentType: 'text/css', body: file ? `@font-face{font-family:"${fam}";font-weight:${fam === 'Montserrat' ? 800 : 400};src:url(https://fonts.gstatic.com/${file})}` : '' });
    });
    await ctx.route('https://fonts.gstatic.com/**', r => r.fulfill({ contentType: 'font/woff2', body: readFileSync(join(process.env.FONTS_DIR, r.request().url().split('gstatic.com/')[1])) }));
  } else await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(PDFJS, r.request().url().endsWith('pdf.worker.min.js') ? 'pdf.worker.min.js' : 'pdf.min.js')) }));
  await ctx.route('**/storage/v1/**', async r => {
    const q = r.request(), url = new URL(q.url()), m = url.pathname.match(/\/storage\/v1\/object\/(public\/)?tv\/(.+)$/);
    if (q.method() === 'GET' && m) { const f = files.get(decodeURIComponent(m[2])); return f ? r.fulfill({ status: 200, contentType: f.type, body: f.body }) : r.fulfill({ status: 404, body: '' }); }
    if ((q.method() === 'POST' || q.method() === 'PUT') && m) {
      let type = q.headers()['content-type'] || 'application/octet-stream', body = q.postDataBuffer();
      const bm = type.match(/boundary=(.+)$/);
      if (bm) {   // supabase-js sends files as a form upload: pull out the file part
        const sep = Buffer.from('--' + bm[1]);
        for (let i = body.indexOf(sep); i >= 0;) {
          const j = body.indexOf(sep, i + sep.length); if (j < 0) break;
          const part = body.subarray(i + sep.length, j), h = part.indexOf('\r\n\r\n'), head = part.subarray(0, h).toString();
          const ct = head.match(/Content-Type:\s*([^\r\n]+)/i);
          if (/filename=/.test(head) || (ct && !/text\/plain/.test(ct[1]))) { type = ct ? ct[1].trim() : 'application/octet-stream'; body = part.subarray(h + 4, part.length - 2); break; }
          i = j;
        }
      }
      files.set(decodeURIComponent(m[2]), { type, body });
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ Key: 'tv/' + m[2] }) });
    }
    if (q.method() === 'DELETE') { const b = JSON.parse(q.postData() || '{}'); (b.prefixes || []).forEach(p => files.delete(p)); return r.fulfill({ contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 404, body: '' });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  // The editor has tabs (Slides, Party, Schedule, Setup): before pressing something, open the tab it's on, as a person would
  const reveal = sel => typeof sel !== 'string' ? null : page.evaluate(q => { try { const el = document.querySelector(q), p = el && el.closest('[data-p]'); if (p && window.tvPanel) window.tvPanel(p.dataset.p); } catch (e) { /* not a CSS selector */ } }, sel).catch(() => {});
  for (const fn of ['click', 'fill', 'check', 'uncheck', 'selectOption', 'setInputFiles', 'isVisible', 'waitForSelector', 'focus', 'press', 'type', 'dispatchEvent']) {
    const orig = page[fn].bind(page);
    page[fn] = async (sel, ...rest) => {
      // Wait for it to exist first (it may still be loading), unless only checking or waiting for it to go
      const o = rest[0] && typeof rest[0] === 'object' ? rest[0] : {};
      if (typeof sel === 'string' && fn !== 'isVisible' && !(fn === 'waitForSelector' && o.state && o.state !== 'visible')) await page.locator(sel).first().waitFor({ state: 'attached', timeout: o.timeout || 30000 }).catch(() => {});
      await reveal(sel); return orig(sel, ...rest);
    };
  }
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/i.test(m.text())) errors.push(m.text()); });
  return { ctx, page };
}
const toastSays = async (page, t) => { await page.waitForFunction(x => { const el = document.querySelector('#toast'); return !el.hidden && el.textContent.includes(x); }, t, { timeout: 6000 }).catch(() => {}); return page.textContent('#toast'); };
const slides = async () => (await db.query(`select kind, title, live_kind, enabled, position, media_path, ends_on from tv_slides order by position`)).rows;

try {
  console.log('Editor (phone)');
  let { ctx, page } = await context({ width: 390, height: 844 });
  await page.goto(BASE + '/tv/edit/index.html');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#app:not([hidden])');
  ok((await page.textContent('#code')) === CODE && (await page.textContent('#list')).includes('No slides yet'), 'opens with the screen code and an empty list');
  ok(await page.isVisible('#homeBtn'), 'has the home button back to the toolkit');

  // Info slide
  await page.click('#addBtn'); await page.click('[data-add="text"]'); await page.waitForSelector('#slForm');
  await page.fill('#slTitle', 'No classes on Monday'); await page.fill('#slBody', 'The dojang is closed for the public holiday.\nBack on Tuesday.');
  await page.check('#slForm input[name=theme][value=gold]');
  await page.click('#slSave'); await page.waitForSelector('#list [data-open]');
  ok((await slides())[0].title === 'No classes on Monday', 'info slide added');

  // Photos (two at once)
  await page.setInputFiles('#pickPhotos', [join(here, '../../../site/icons/ama-id-cards.png'), join(here, '../../../site/icons/clipboard.png')]);
  await page.waitForFunction(() => document.querySelectorAll('#list .slide').length === 3, null, { timeout: 15000 });
  const ph = (await slides()).filter(s => s.kind === 'photo');
  ok(ph.length === 2 && ph.every(p => files.has(p.media_path) && files.get(p.media_path).type === 'image/jpeg'), 'two photos added at once, resized to JPEG and uploaded');

  // Live slides
  ok(!(await page.$('[data-add="live:congrats"]')) && !(await page.$('[data-add="live:sessions"]')), 'there is no Congratulations or Prep sessions slide');
  for (const k of ['next_grading', 'month']) { await page.click('#addBtn'); await page.click(`[data-add="live:${k}"]`); await toastSays(page, 'Added'); await page.waitForFunction(n => document.querySelectorAll('#list .slide').length === n, 3 + ['next_grading', 'month'].indexOf(k) + 1); }
  ok((await slides()).filter(s => s.kind === 'live').map(s => s.live_kind).join() === 'next_grading,month', 'live slides added (next grading, month theme)');
  await page.screenshot({ path: join(SHOTS, 'tv-editor.png'), fullPage: true });

  // Reorder: move the month theme up one
  const monthId = (await db.query(`select id from tv_slides where live_kind = 'month'`)).rows[0].id;
  await page.focus(`[data-grip="${monthId}"]`); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(600);
  ok((await slides()).map(s => s.live_kind || s.kind).join() === 'text,photo,photo,month,next_grading', 'slides can be moved up and down');

  // Turn one off, schedule one
  const hideId = (await db.query(`select id from tv_slides where kind = 'photo' order by position desc limit 1`)).rows[0].id;
  await page.uncheck(`[data-on="${hideId}"]`); await toastSays(page, 'Hidden');
  ok((await db.query(`select enabled from tv_slides where id = $1`, [hideId])).rows[0].enabled === false, 'a slide can be hidden from the TV with one tap');
  await page.click('#list [data-open]:has-text("No classes on Monday")'); await page.waitForSelector('#slForm');
  const nextWeek = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  await page.fill('#slUntil', nextWeek); await page.click('#slSave'); await toastSays(page, 'Saved');
  await page.waitForFunction(() => document.querySelector('#list').textContent.includes('Until'), null, { timeout: 5000 }).catch(() => {});
  ok(String((await slides())[0].ends_on).length > 0 && (await page.textContent('#list')).includes('Until'), 'a slide can be set to stop showing after a date');

  // Settings
  await page.fill('#setSecs', '4'); await page.click('#setSave'); await toastSays(page, 'Settings saved');
  ok((await db.query(`select seconds from tv_settings where id = 1`)).rows[0].seconds === 4, 'seconds per slide saved');
  ok((await page.getAttribute('#previewBtn', 'href')) === `../?code=${CODE}&preview=1`, 'Preview opens the TV page with the code');
  // Shuffle button
  ok((await page.getAttribute('#shuffleBtn', 'aria-pressed')) === 'false' && (await page.textContent('#slidesHint')).includes('in order'), 'slides play in order by default');
  await page.click('#shuffleBtn'); await toastSays(page, 'Shuffle on');
  ok((await db.query(`select shuffle from tv_settings where id = 1`)).rows[0].shuffle === true && (await page.getAttribute('#shuffleBtn', 'aria-pressed')) === 'true', 'the Shuffle button turns on random order');
  ok((await page.textContent('#slidesHint')).includes('random order'), 'the hint says the slides play in a random order');
  await page.click('#shuffleBtn'); await toastSays(page, 'Shuffle off');
  ok((await db.query(`select shuffle from tv_settings where id = 1`)).rows[0].shuffle === false, 'pressing it again turns shuffle off');
  await ctx.close();

  console.log('\nTV page (1280 x 720)');
  ({ ctx, page } = await context({ width: 1280, height: 720 }));
  await page.goto(BASE + '/tv/index.html');
  await page.waitForSelector('#codeScreen:not([style*="none"])');
  ok(true, 'asks for the screen code the first time');
  await page.fill('#codeInput', 'WRONG1'); await page.press('#codeInput', 'Enter');
  await page.waitForFunction(() => document.querySelector('#codeErr').textContent.includes('not right'));
  ok(true, 'a wrong code is explained');
  await page.fill('#codeInput', CODE.toLowerCase()); await page.press('#codeInput', 'Enter');
  await page.waitForSelector('.layer.on');
  const st = await page.evaluate(() => window.__tv.state());
  ok(st.count === 3, 'plays the 3 slides that are on (the hidden one, and the month theme with no theme set, are left out)');
  ok(await page.isVisible('#clock') && await page.isVisible('#logo'), 'clock and AMA logo in the corners');
  const seen = {};
  for (let i = 0; i < st.count; i++) {
    await page.waitForTimeout(1200);
    const txt = await page.evaluate(() => { const l = document.querySelectorAll('.layer.on'); return l.length ? l[l.length - 1].textContent : ''; });
    seen[i] = txt;
    await page.screenshot({ path: join(SHOTS, `tv-slide-${i + 1}.png`) });
    await page.evaluate(() => window.__tv.next());
  }
  const all = Object.values(seen).join(' | ');
  ok(all.includes('No classes on Monday') && all.includes('Back on Tuesday'), 'info slide shows the heading and text');
  ok(/weeks to go|days to go/.test(all) && /Next black belt grading/i.test(all), 'next grading slide shows the date and how long to go');
  ok(!all.includes('This is the Month of'), 'the month theme slide waits until a theme is set');
  ok((await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1)), 'fits the screen with no scrolling');

  // Changes reach the TV
  await db.query(`update tv_slides set enabled = true where id = $1`, [hideId]);
  await page.evaluate(() => window.__tv.reload());
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__tv.next());
  await page.waitForFunction(() => window.__tv.state().count === 4, null, { timeout: 5000 }).catch(() => {});
  ok((await page.evaluate(() => window.__tv.state())).count === 4, 'a change in the editor reaches the TV (picked up at the next slide)');

  // Shuffle: every slide once per round, in a new order each round
  await db.query(`update tv_settings set shuffle = true where id = 1`);
  await page.evaluate(() => window.__tv.reload()); await page.waitForTimeout(500);
  await page.evaluate(() => window.__tv.next());
  await page.waitForFunction(() => window.__tv.feed().settings.shuffle === true, null, { timeout: 5000 }).catch(() => {});
  const rounds = [];
  for (let r = 0; r < 6; r++) {
    // finish the current round, then record the next full one
    while ((await page.evaluate(() => window.__tv.state())).index !== (await page.evaluate(() => window.__tv.state())).count - 1) await page.evaluate(() => window.__tv.next());
    const order = [];
    for (let i = 0; i < 4; i++) { await page.evaluate(() => window.__tv.next()); const t = await page.evaluate(() => window.__tv.state()); order.push(t.ids[t.index]); }
    rounds.push(order);
  }
  ok(rounds.every(o => new Set(o).size === 4), 'with shuffle on, each round shows every slide once');
  ok(new Set(rounds.map(o => o.join())).size > 1, 'with shuffle on, the order changes from round to round');
  ok(rounds.every((o, i) => i === 0 || o[0] !== rounds[i - 1][3]), 'never the same slide twice in a row between rounds');
  await db.query(`update tv_settings set shuffle = false where id = 1`);
  await page.evaluate(() => window.__tv.reload()); await page.waitForTimeout(500); await page.evaluate(() => window.__tv.next());

  // Remembered code and no connection
  await ctx.route(`${BASE}/rest/**`, r => r.abort());
  await page.reload(); await page.waitForSelector('.layer.on', { timeout: 8000 });
  ok(await page.isHidden('#codeScreen') && (await page.evaluate(() => window.__tv.state())).count === 4, 'remembers the code, and keeps playing its saved slides with no connection');
  ok(await page.evaluate(() => document.body.className.includes('offline')), 'shows a small dot when offline');
  await ctx.unroute(`${BASE}/rest/**`);

  // New code stops the TV
  await db.query(`update tv_settings set screen_code = 'NEWCODE' where id = 1`);
  await page.evaluate(() => window.__tv.reload());
  await page.waitForSelector('#codeScreen:not([style*="none"])', { timeout: 5000 });
  ok((await page.textContent('#codeErr')).includes('changed'), 'after a new code, the TV asks for it');
  await ctx.close();

  // Party mode
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await db.query(`update tv_settings set screen_code = $1 where id = 1`, [CODE]);
  await page.goto(BASE + '/tv/edit/index.html');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#partyStart');
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  await page.fill('#pName', 'Kara'); await page.fill('#pLine', 'Turning 7 today!');
  ok((await page.textContent('#pPrev')).includes('Happy Birthday Kara!') && (await page.textContent('#pPrev')).includes('Turning 7 today!'), 'party message preview shows "Happy Birthday Kara!"');
  await page.selectOption('#pFor', '60');
  await page.screenshot({ path: join(SHOTS, 'tv-party-editor.png') });
  await page.click('#pGo'); await page.waitForSelector('#partyStop');
  const tvset = (await db.query(`select only_slide, only_until > now() + interval '55 minutes' and only_until < now() + interval '65 minutes' ok from party_now where id = 1`)).rows[0];
  ok(tvset.only_slide && tvset.ok, 'party mode is on for 1 hour');
  ok((await page.textContent('#party')).includes('Party mode is on') && !(await page.textContent('#list')).includes('Happy Birthday'), 'editor shows party mode is on; the party slide is kept out of the slide list');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const cols = await page.$$eval('#party .btn', bs => bs.map(b => { const c = getComputedStyle(b); return [c.color, c.backgroundColor]; }));
    ok(cols.length >= 2 && cols.every(([fg, bg]) => fg !== bg) && cols[1][0] === 'rgb(22, 33, 27)' && cols[1][1] === 'rgb(255, 255, 255)', `party mode buttons are readable in ${scheme} mode`);
  }
  await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: join(SHOTS, 'tv-party-on-dark.png') }); await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: join(SHOTS, 'tv-party-on.png') });
  const tv = await context({ width: 1280, height: 720 });
  await tv.page.goto(BASE + `/tv/index.html?code=${CODE}`); await tv.page.waitForSelector('.layer.on');
  await tv.page.waitForTimeout(1200);
  ok((await tv.page.evaluate(() => window.__tv.state())).count === 1 && (await tv.page.textContent('.layer.on')).includes('Happy Birthday Kara!'), 'the TV shows only the birthday message');
  ok(await tv.page.isHidden('#clock') && (await tv.page.$$('.confetti i')).length > 10, 'full screen with confetti, no clock or logo');
  await tv.page.screenshot({ path: join(SHOTS, 'tv-party.png') });
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');
  await tv.page.evaluate(() => window.__tv.reload()); await tv.page.waitForTimeout(800);
  ok((await tv.page.evaluate(() => window.__tv.state())).count > 1, '"Back to normal" brings the slideshow straight back');
  // Image, and reusing a saved one
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  await page.click('#pForm [data-m="image"]');
  await page.click('#pPick'); await page.setInputFiles('#pickParty', join(here, '../../../site/icons/ama-id-cards.png'));
  await page.waitForSelector('#pForm .preview-img');
  await page.fill('#pCap', 'Happy Birthday Sam!'); await page.click('#pGo'); await page.waitForSelector('#partyStop');
  const img = (await db.query(`select s.kind, s.media_path from party_now t join tv_slides s on s.id = t.only_slide where t.id = 1`)).rows[0];
  ok(img.kind === 'photo' && files.has(img.media_path), 'an uploaded image can be shown on its own');
  await tv.page.evaluate(() => window.__tv.reload()); await tv.page.waitForTimeout(800);
  ok((await tv.page.evaluate(() => window.__tv.state())).count === 1, 'and the TV switches to it');
  ok(!(await tv.page.$('.layer.on .caption')) && !(await tv.page.textContent('#stage')).includes('Happy Birthday Sam!'), 'in party mode the picture shows on its own, with no caption over it');
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  ok((await page.$$('#pForm [data-m="saved"]')).length === 1, 'earlier party slides are saved to reuse');
  await page.click('#pForm [data-m="saved"]'); await page.waitForSelector('#pForm [data-pick]');
  ok((await page.$$('#pForm [data-pick]')).length === 2, 'both earlier party slides are listed');
  await page.selectOption('#pFor', 'day'); await page.click('#pGo'); await page.waitForSelector('#partyStop');
  const endOfDay = await page.evaluate(() => { const d = new Date(); d.setHours(23, 59, 0, 0); return d.toISOString(); });
  ok(Math.abs(new Date((await db.query(`select only_until from party_now where id = 1`)).rows[0].only_until) - new Date(endOfDay)) < 60e3, '"the rest of today" runs until 11:59 pm');
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');

  // A PDF of birthday designs (as exported from Canva): pick a page, or save them all
  let pdfPath = process.env.TEST_PDF;
  if (!pdfPath) {
    const mk = await browser.newPage();
    await mk.setContent(`<style>@page{size:1440px 810px;margin:0}body{margin:0}div{width:1440px;height:810px;display:flex;flex-direction:column;align-items:center;justify-content:center;font:bold 90px Arial;color:#fff;page-break-after:always}</style>
      <div style="background:#4f8ff7">HAPPY BIRTHDAY<span style="font-size:160px">KIAN</span><span style="font-size:30px">From Australian Martial Arts Academy</span></div>
      <div style="background:#2a2a8f">HAPPY BIRTHDAY<span style="font-size:160px">ASTRO</span></div>`);
    pdfPath = join(tmpdir(), 'tv-test-birthdays.pdf');
    await mk.pdf({ path: pdfPath, width: '1440px', height: '810px', printBackground: true }); await mk.close();
  }
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  await page.click('#pForm [data-m="image"]');
  await page.click('#pPick'); await page.setInputFiles('#pickParty', pdfPath);
  await page.waitForSelector('#pForm [data-page]', { timeout: 60000 });
  const pageNames = await page.$$eval('#pForm [data-page] span', ss => ss.map(x => x.textContent));
  console.log('        PDF pages:', pageNames.join(', '));
  ok(pageNames.length >= 2 && (process.env.TEST_PDF || pageNames.join() === 'Kian,Astro'), 'a PDF shows each page to pick from, named after the birthday child');
  await page.screenshot({ path: join(SHOTS, 'tv-party-pdf.png') });
  await page.click('#pForm [data-page="1"]'); await page.waitForSelector('#pForm .preview-img');
  ok((await page.inputValue('#pCap')) === pageNames[1], 'picking a page gets it ready, named');
  await page.click('#pGo'); await page.waitForSelector('#partyStop');
  const pdfSlide = (await db.query(`select s.kind, s.media_path, s.title from party_now t join tv_slides s on s.id = t.only_slide where t.id = 1`)).rows[0];
  ok(pdfSlide.kind === 'photo' && pdfSlide.title === pageNames[1] && files.get(pdfSlide.media_path).type === 'image/jpeg', 'the chosen page goes on the TV as a full-screen image');
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');
  const before = (await db.query(`select count(*)::int n from tv_slides where party`)).rows[0].n;
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  await page.click('#pForm [data-m="image"]'); await page.click('#pPick'); await page.setInputFiles('#pickParty', pdfPath);
  await page.waitForSelector('#pSaveAll', { timeout: 60000 }); await page.click('#pSaveAll');
  await page.waitForSelector('#pForm [data-m="saved"][aria-pressed="true"]', { timeout: 60000 });
  ok((await db.query(`select count(*)::int n from tv_slides where party`)).rows[0].n === before + pageNames.length, '"Save all" keeps every design for next time, under Saved');
  await page.screenshot({ path: join(SHOTS, 'tv-party-saved.png') });
  await page.evaluate(() => document.querySelector('#dlg').close());

  // PDFs in the normal slideshow: one slide per page
  const normalBefore = (await db.query(`select count(*)::int n from tv_slides where not party and kind = 'photo'`)).rows[0].n;
  await page.setInputFiles('#pickPhotos', pdfPath);
  await toastSays(page, 'Added').catch(() => {});
  await page.waitForFunction(() => { const t = document.querySelector('#toast'); return !t.hidden && /^Added/.test(t.textContent); }, null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(500);
  ok((await db.query(`select count(*)::int n from tv_slides where not party and kind = 'photo'`)).rows[0].n === normalBefore + pageNames.length, 'a PDF added under Photos becomes one slide per page');
  await tv.ctx.close(); await ctx.close();

  // Birthday posters: import templates, type a name, show it
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#partyStart');
  let tplFile = process.env.TEMPLATES_JSON;
  if (!tplFile) {
    const img = 'data:image/png;base64,' + readFileSync(join(here, '../../../site/icons/ama-id-cards.png')).toString('base64');
    tplFile = join(tmpdir(), 'tv-test-templates.json');
    (await import('node:fs')).writeFileSync(tplFile, JSON.stringify({ app: 'ama-tv-templates', templates: [
      { title: 'Classic', image: img, settings: { size: 200, box: { cx: 960, base: 560, maxW: 1240 }, font: 'Montserrat', weight: 800, fill: '#ffffff', stroke: '', strokeWidth: 0, spacing: 0.04, uppercase: true } },
      { title: 'Turtles', image: img, settings: { size: 285, box: { cx: 960, base: 550, maxW: 1340 }, font: 'Luckiest Guy', fill: '#ffffff', stroke: '#000000', strokeWidth: 0.1, uppercase: true } }] }));
  }
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  ok(await page.isVisible('#pForm [data-m="poster"]'), 'party mode has a Poster option');
  await page.click('#pForm [data-m="poster"]'); await page.waitForSelector('#pImport');
  await page.click('#pImport'); await page.setInputFiles('#pickImport', tplFile);
  await page.waitForSelector('#pForm [data-tpl]', { timeout: 60000 });
  const nT = (await db.query(`select count(*)::int n from tv_poster_templates`)).rows[0].n;
  ok(nT >= 2 && (await page.$$('#pForm [data-tpl]')).length === nT, `templates imported (${nT}) and shown to pick from`);
  await page.click('#pForm [data-tpl]:nth-child(2)');
  await page.fill('#pPoster', 'Maximilian'); await page.waitForTimeout(800);
  const painted = await page.evaluate(() => { const c = document.querySelector('#pCanvas'), d = c.getContext('2d').getImageData(0, 0, 1920, 1080).data; let n = 0; for (let i = 0; i < d.length; i += 4000) if (d[i] || d[i + 1] || d[i + 2]) n++; return n; });
  ok(painted > 50, 'typing a name draws the poster preview');
  await page.screenshot({ path: join(SHOTS, 'tv-poster-editor.png') });
  const dl = page.waitForEvent('download'); await page.click('#pDownload'); const dlf = await dl;
  ok(dlf.suggestedFilename() === 'birthday-maximilian.png', 'Download saves the poster as a picture');
  await page.selectOption('#pFor', '120'); await page.click('#pGo'); await page.waitForSelector('#partyStop', { timeout: 30000 });
  const ps = (await db.query(`select s.kind, s.title, s.media_path from party_now t join tv_slides s on s.id = t.only_slide where t.id = 1`)).rows[0];
  ok(ps.kind === 'photo' && /^Maximilian \(/.test(ps.title) && files.get(ps.media_path).type === 'image/jpeg' && files.get(ps.media_path).body.length > 10000, 'Show on the TV makes the poster and puts it on in party mode');
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');

  // Add a template: choose a design, drag where the name goes, pick the lettering
  await page.click('#partyStart'); await page.waitForSelector('#pManage'); await page.click('#pManage');
  await page.waitForSelector('#tAdd'); await page.click('#tAdd');
  await page.click('#tPick'); await page.setInputFiles('#pickTpl', join(here, '../../../site/icons/clipboard.png'));
  await page.waitForSelector('#tCanvas');
  const box = await page.$eval('#tCanvas', c => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.4); await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5, { steps: 4 }); await page.mouse.move(box.x + box.w * 0.8, box.y + box.h * 0.6, { steps: 4 }); await page.mouse.up();
  await page.fill('#tTitle', 'Ninja'); await page.selectOption('#tFont', 'Knewave'); await page.fill('#tSample', 'Ayda');
  await page.screenshot({ path: join(SHOTS, 'tv-template-editor.png') });
  await page.click('#tSave'); await page.waitForSelector('#tAdd');
  const nt = (await db.query(`select settings from tv_poster_templates where title = 'Ninja'`)).rows[0];
  ok(nt && nt.settings.font === 'Knewave' && Math.abs(nt.settings.box.cx - 960) < 40 && Math.abs(nt.settings.box.cy - 540) < 40 && nt.settings.box.maxW > 1000, 'a new template saves the dragged name area and lettering');
  await ctx.close();

  // Countdowns, TV status, remote refresh and booked parties
  console.log('\nCountdowns, TV status, refresh and bookings');
  await db.query(`delete from tv_screens`);
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#status:not([hidden])');
  ok((await page.textContent('#status')).includes('No TV has checked in yet'), 'TV status says when no TV has checked in');
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const in21 = ymd(new Date(Date.now() + 21 * 864e5));
  await page.click('#addBtn'); await page.click('[data-add="countdown"]'); await page.waitForSelector('#slEvent');
  await page.fill('#slTitle', 'Comp'); await page.fill('#slEvent', in21);
  ok((await page.textContent('#cdPrev')).includes('Comp · 3 weeks to go'), 'countdown editor shows what the TV will say');
  await page.click('#slSave'); await toastSays(page, 'Added');
  await page.click('#addBtn'); await page.click('[data-add="countdown"]'); await page.waitForSelector('#slEvent');
  await page.check('#slForm input[name=cdTo][value=grading]'); await page.click('#slSave'); await toastSays(page, 'Added');
  await page.waitForTimeout(500);
  const cds = (await db.query(`select title, count_to, event_on::text e from tv_slides where kind = 'countdown' order by position`)).rows;
  ok(cds.length === 2 && cds[0].title === 'Comp' && cds[0].e === in21 && cds[1].count_to === 'grading', 'countdowns saved: one to a date, one to the next grading');
  ok((await page.textContent('#list')).includes('Countdown to the next grading'), 'the list says what each countdown counts to');

  const tvc = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await tvc.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await tvc.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  const tvp = await tvc.newPage();
  tvp.on('pageerror', e => errors.push('tv: ' + e.message));
  await tvp.goto(BASE + `/tv/index.html?code=${CODE}`); await tvp.waitForSelector('.layer.on');
  const words = [];
  for (let i = 0; i < (await tvp.evaluate(() => window.__tv.state().count)); i++) {
    await tvp.waitForTimeout(500);
    words.push(await tvp.evaluate(() => { const l = document.querySelectorAll('.layer.on'); return l[l.length - 1].textContent; }));
    if (/Comp/.test(words[words.length - 1])) await tvp.screenshot({ path: join(SHOTS, 'tv-countdown.png') });
    await tvp.evaluate(() => window.__tv.next());
  }
  const wall = words.join(' | ');
  ok(/Comp\s*3\s*weeks to go/.test(wall), 'the TV shows "Comp 3 weeks to go"');
  ok(/Black belt grading\s*6\s*weeks to go/.test(wall), 'the grading countdown uses the date from Black Belt Gradings');

  await tvp.waitForFunction(() => true); await page.waitForTimeout(2500);
  await page.evaluate(() => pollStatus()); await page.waitForTimeout(400);
  const stText = await page.textContent('#status');
  ok(stText.includes('The TV is online') && /Checked in \d+ s ago/.test(stText) && stText.includes(' of '), 'TV status shows it online, what it is showing and when it last checked in');
  await page.screenshot({ path: join(SHOTS, 'tv-status.png') });

  const started1 = await tvp.evaluate(() => window.__tv.started);
  await page.click('#tvReload'); await toastSays(page, 'Sent');
  await Promise.all([tvp.waitForEvent('load', { timeout: 8000 }), tvp.evaluate(() => window.__tv.checkIn())]).catch(() => {});
  await tvp.waitForSelector('.layer.on');
  ok((await tvp.evaluate(() => window.__tv.started)) !== started1 && /[?&]r=\d+/.test(tvp.url()) && /code=/.test(tvp.url()), 'Refresh the TV makes the TV reload (with a new address, so no saved old copy is used)');
  await tvp.evaluate(() => window.__tv.checkIn()); await tvp.waitForTimeout(800);
  ok((await tvp.evaluate(() => window.__tv.started)) !== started1 && (await db.query(`select count(*)::int n from tv_screens`)).rows[0].n === 1, 'and it only reloads once');

  // Book a party for tomorrow afternoon
  const tmr = ymd(new Date(Date.now() + 864e5));
  await page.click('#partyBook'); await page.waitForSelector('#bDate');
  await page.click('#pForm [data-m="message"]'); await page.waitForSelector('#pName');
  ok(await page.inputValue('#bDate') !== '' && await page.isVisible('#bFrom'), 'Book for later asks for the date and times');
  await page.fill('#bDate', tmr); await page.fill('#bFrom', '14:00'); await page.fill('#bTo', '17:00'); await page.fill('#pName', 'Kian');
  await page.click('#pGo'); await toastSays(page, 'Booked');
  const bk = (await db.query(`select b.*, s.title from tv_party_bookings b join tv_slides s on s.id = b.slide_id where s.display = 'tv' and b.starts_at > now()`)).rows;
  ok(bk.length === 1 && bk[0].title === 'Happy Birthday Kian!' && new Date(bk[0].starts_at).getHours() === 14 && new Date(bk[0].ends_at).getHours() === 17, 'the party is booked with its name and times');
  await page.waitForSelector('#party .booked', { timeout: 5000 }).catch(() => {});
  ok((await page.textContent('#party')).includes('Happy Birthday Kian!') && (await page.textContent('#party')).includes('2:00'), 'the booking shows under Party mode');
  // Edit it: the words and the times
  await page.click('#party [data-editbk]'); await page.waitForSelector('#bkHead');
  ok(await page.inputValue('#bkHead') === 'Happy Birthday Kian!' && await page.inputValue('#bkFrom') === '14:00' && await page.inputValue('#bkTo') === '17:00', 'Edit opens the booking with its words and times');
  await page.fill('#bkHead', 'Happy Birthday Kian!!'); await page.fill('#bkLine', 'Turning 8'); await page.fill('#bkFrom', '13:00'); await page.fill('#bkTo', '15:30');
  await page.click('#bkGo'); await toastSays(page, 'Saved');
  const bke = (await db.query(`select b.*, s.title, s.body from tv_party_bookings b join tv_slides s on s.id = b.slide_id where s.display = 'tv' and b.starts_at > now()`)).rows;
  ok(bke.length === 1 && bke[0].title === 'Happy Birthday Kian!!' && bke[0].body === 'Turning 8' && new Date(bke[0].starts_at).getHours() === 13 && new Date(bke[0].ends_at).getMinutes() === 30, 'editing a booked party changes its words and times');
  await page.click('#party [data-editbk]'); await page.waitForSelector('#bkHead'); await page.fill('#bkFrom', '14:00'); await page.fill('#bkTo', '17:00'); await page.fill('#bkHead', 'Happy Birthday Kian!'); await page.click('#bkGo'); await toastSays(page, 'Saved');
  await page.click('#partyBook'); await page.waitForSelector('#bDate'); await page.click('#pForm [data-m="message"]'); await page.waitForSelector('#pName');
  await page.fill('#bDate', tmr); await page.fill('#bFrom', '16:00'); await page.fill('#bTo', '18:00'); await page.fill('#pName', 'Ava');
  await page.click('#pGo');
  ok((await toastSays(page, 'Another party')).includes('Another party is booked'), 'two parties cannot be booked at the same time');
  await page.click('#pForm [data-close]');

  // The time comes: the TV switches by itself, then back at the end
  await db.query(`update tv_party_bookings set starts_at = now() - interval '1 minute', ends_at = now() + interval '2 hours' where starts_at > now()`);
  await tvp.evaluate(() => window.__tv.reload());
  await tvp.waitForFunction(() => window.__tv.state().count === 1, null, { timeout: 6000 }).catch(() => {});
  ok((await tvp.evaluate(() => window.__tv.state().count)) === 1 && (await tvp.textContent('body')).includes('Kian'), 'at the start time the TV shows only the party');
  await page.evaluate(() => pollStatus()); await page.waitForSelector('#partyStop');
  ok((await page.textContent('#party')).includes('Party mode is on'), 'the editor shows the booked party is on');
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');
  await tvp.evaluate(() => window.__tv.reload());
  await tvp.waitForFunction(() => window.__tv.state().count > 1, null, { timeout: 6000 }).catch(() => {});
  ok((await tvp.evaluate(() => window.__tv.state().count)) > 1, '"Back to normal now" ends the booked party early');
  await tvc.close(); await ctx.close();

  // Events calendar
  console.log('\nEvents calendar');
  const EVENTS = process.env.EVENTS_JSON || join(SHOTS, 'events-test.json');
  if (!process.env.EVENTS_JSON) {
    const t0 = new Date(), mk = (k, d) => { const x = new Date(t0.getFullYear(), t0.getMonth() + k, d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const tday = `${t0.getFullYear()}-${String(t0.getMonth() + 1).padStart(2, '0')}-${String(t0.getDate()).padStart(2, '0')}`;
    (await import('node:fs')).writeFileSync(EVENTS, JSON.stringify({ months: { [tday.slice(0, 7)]: 'Month of Testing', [mk(1, 1).slice(0, 7)]: 'Month of Next' },
      events: [{ start: tday, title: 'Today Session', note: '1:30 pm, Marrickville' }, { start: mk(-1, 15), end: mk(-1, 15), title: 'Old thing' }, { start: mk(1, 3), end: mk(1, 6), title: 'Next Month Grading' }, { start: mk(3, 1), title: 'Far Away' }] }));
  }
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#eventsCard:not([hidden])');
  ok((await page.textContent('#eventsCard')).includes('No upcoming events'), 'the editor has an events calendar');
  await page.click('#evOpen'); await page.waitForSelector('#evImport');
  await page.click('#evImport'); await page.setInputFiles('#pickEvents', EVENTS);
  await toastSays(page, 'Added');
  const nEv = (await db.query(`select count(*)::int n from tv_events`)).rows[0].n, nIn = JSON.parse(read(EVENTS)).events.length;
  ok(nEv === nIn && (await db.query(`select count(*)::int n from tv_months`)).rows[0].n >= 2, `a calendar file imports the events (${nEv}) and month themes`);
  await page.waitForSelector('#evImport'); await page.click('#evImport'); await page.setInputFiles('#pickEvents', EVENTS);
  ok((await toastSays(page, 'already there')).includes('Added 0 events'), 'importing the same file again adds nothing twice');
  await page.waitForSelector('#evForm');
  await page.fill('#evStart', ymd(new Date())); await page.fill('#evTitle', 'Pizza Night'); await page.fill('#evNote', '6 pm');
  await page.click('#evSave'); await toastSays(page, 'Added'); await page.waitForSelector('.evlist li:has-text("Pizza Night")');
  ok(true, 'an event can be added by hand and shows in the month');
  await page.click('.evlist li:has-text("Pizza Night") [data-ev-edit]'); await page.fill('#evTitle', 'Pizza Party'); await page.click('#evSave');
  await page.waitForSelector('.evlist li:has-text("Pizza Party")');
  ok((await db.query(`select count(*)::int n from tv_events where title = 'Pizza Party'`)).rows[0].n === 1, 'and changed');
  await page.screenshot({ path: join(SHOTS, 'tv-events-editor.png') });
  await page.click('.evlist li:has-text("Pizza Party") [data-ev-del]'); await page.waitForFunction(() => !document.querySelector('.evlist') || !document.querySelector('.evlist').textContent.includes('Pizza'));
  ok((await db.query(`select count(*)::int n from tv_events where title like 'Pizza%'`)).rows[0].n === 0, 'and deleted');
  await page.click('#dlg [data-close]');
  await page.click('#addBtn'); await page.click('[data-add="live:events"]'); await toastSays(page, 'Added');
  await page.waitForTimeout(300); await page.click('#addBtn'); await page.click('[data-add="live:month"]'); await toastSays(page, 'Month theme');
  await ctx.close();

  const tvc2 = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await tvc2.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await tvc2.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  const tv2 = await tvc2.newPage(); tv2.on('pageerror', e => errors.push('tv: ' + e.message));
  await tv2.goto(BASE + `/tv/index.html?code=${CODE}&preview=1`); await tv2.waitForSelector('.layer.on');
  let evText = '';
  for (let i = 0; i < (await tv2.evaluate(() => window.__tv.state().count)); i++) {
    await tv2.waitForTimeout(400);
    const txt = await tv2.evaluate(() => { const l = document.querySelectorAll('.layer.on'); return l[l.length - 1].textContent; });
    if (txt.includes("What's on")) { evText = txt; await tv2.waitForTimeout(900); await tv2.screenshot({ path: join(SHOTS, 'tv-events.png') }); break; }
    await tv2.evaluate(() => window.__tv.next());
  }
  const monthName = new Date().toLocaleDateString('en-AU', { month: 'long' }), last10 = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() - new Date().getDate() < 10;
  ok(evText.includes(monthName) && /Today Session|Black Belt Gradings Session/.test(evText), "the TV shows this month's events with the month name");
  if (!process.env.EVENTS_JSON) {
    ok(evText.includes('Month of Testing') && evText.includes('1:30 pm, Marrickville') && evText.includes('Today'), 'with the month theme, notes, and a Today tag');
    ok(!evText.includes('Old thing') && !evText.includes('Far Away'), 'past events and far-off months are left off');
    ok(last10 ? evText.includes('Next Month Grading') && evText.includes('Month of Next') : !evText.includes('Next Month Grading'), `next month shows only near the end of the month (${last10 ? 'it is now' : 'not yet'})`);
  }
  ok(await tv2.evaluate(() => { const c = document.querySelector('.layer.on .card'); return c && c.scrollHeight <= c.clientHeight + 2; }), 'the events slide fits the screen');
  let monText = '';
  for (let i = 0; i < 12 && !monText; i++) {
    await tv2.evaluate(() => window.__tv.next()); await tv2.waitForTimeout(400);
    const txt = await tv2.evaluate(() => { const l = document.querySelectorAll('.layer.on'); return l[l.length - 1].textContent; });
    if (txt.includes('This is the Month of')) { monText = txt; await tv2.waitForTimeout(900); await tv2.screenshot({ path: join(SHOTS, 'tv-month.png') }); }
  }
  ok(monText.includes(monthName) && /This is the Month of\s*(Testing|Health & Nutrition)/.test(monText), 'the month theme slide says "This is the Month of ..."');
  await tvc2.close();
  await db.query(`delete from tv_slides where live_kind in ('events', 'month')`);

  // QR code slides and quiet hours
  console.log('\nQR codes and quiet hours');
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#list [data-open]');
  await page.click('#addBtn'); await page.click('[data-add="qr"]'); await page.waitForSelector('#slLink');
  await page.fill('#slLink', 'not a link'); await page.waitForTimeout(200);
  ok((await page.textContent('#qrNote')).includes("doesn't look like a link"), 'a QR slide spots something that is not a link');
  await page.fill('#slLink', 'instagram.com/amamarrickville'); await page.waitForFunction(() => document.querySelector('#qrNote').textContent.includes('Opens'));
  ok((await page.textContent('#qrNote')).includes('https://instagram.com/amamarrickville'), 'the QR preview shows the full link it opens');
  await page.fill('#slTitle', 'Follow us on Instagram'); await page.fill('#slBody', 'Point your phone camera at the code.');
  await page.click('#slSave'); await toastSays(page, 'Added');
  await page.waitForTimeout(300);
  const qrs = (await db.query(`select link, media_path, title from tv_slides where kind = 'qr'`)).rows[0];
  const { PNG } = await import(join(QRDIR, 'pngjs/lib/png.js')), jsQR = (await import(join(QRDIR, 'jsqr/dist/jsQR.js'))).default;
  const png = PNG.sync.read(files.get(qrs.media_path).body), dec = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  ok(qrs.link === 'https://instagram.com/amamarrickville' && dec && dec.data === qrs.link, `the QR code is made, uploaded, and scans to the link (${png.width} px)`);
  const oldQr = qrs.media_path;
  await page.click(`#list [data-open]:has-text("Follow us on Instagram")`); await page.waitForSelector('#slLink');
  await page.fill('#slLink', 'https://www.amamartialarts.com.au/free-trial?from=tv'); await page.click('#slSave'); await toastSays(page, 'Saved'); await page.waitForTimeout(300);
  const qr2 = (await db.query(`select link, media_path from tv_slides where kind = 'qr'`)).rows[0];
  const png2 = PNG.sync.read(files.get(qr2.media_path).body), dec2 = jsQR(new Uint8ClampedArray(png2.data), png2.width, png2.height);
  ok(dec2 && dec2.data === 'https://www.amamartialarts.com.au/free-trial?from=tv' && !files.has(oldQr), 'changing the link makes a new code and removes the old one');

  // Quiet hours on now
  await page.check('#setQuiet');
  ok(await page.isVisible('#qd1From') && await page.isVisible('#qd0To') && (await page.$$('#qDays tr')).length === 7, 'Settings has slideshow hours for each day of the week');
  await page.fill('#qd1From', '15:30'); await page.fill('#qd1To', '20:45'); await page.click('#qCopy');
  ok(await page.inputValue('#qd4From') === '15:30' && await page.inputValue('#qd5To') === '20:45', 'Copy Monday fills in Tuesday to Friday');
  await page.fill('#qd6From', '08:00'); await page.fill('#qd6To', '13:00');
  const todayDow = new Date().getDay();
  await page.uncheck(`#qd${todayDow}On`);   // off all day today, so the TV is quiet now
  await page.selectOption('#setQStyle', 'logo'); await page.click('#setSave'); await toastSays(page, 'Settings saved');
  const qs = (await db.query(`select quiet_on, quiet_style, quiet_days from tv_settings where id = 1`)).rows[0];
  ok(qs.quiet_on && qs.quiet_style === 'logo' && (todayDow === 6 || qs.quiet_days['6'].on === '08:00') && (todayDow === 2 || qs.quiet_days['2'].off === '20:45') && qs.quiet_days[String(todayDow)] === null, 'each day saves its own hours, and a day can be off all day');
  await page.waitForTimeout(1000);   // the form redraws after saving
  if (todayDow === 3) await page.check('#qd3On');
  await page.fill('#qd3From', '18:00'); await page.fill('#qd3To', '17:00');
  await page.click('#setSave');
  ok((await toastSays(page, 'end time')).includes('Wednesday: the end time must be after the start time'), 'an end time before the start time is caught');
  await page.fill('#qd3To', '21:00'); if (todayDow === 3) await page.uncheck('#qd3On');
  await page.click('#setSave'); await toastSays(page, 'Settings saved');
  await page.waitForTimeout(500); await page.locator('#setForm').screenshot({ path: join(SHOTS, 'tv-hours.png') });

  const tvc3 = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await tvc3.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await tvc3.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await tvc3.route('**/storage/v1/**', r => { const m = new URL(r.request().url()).pathname.match(/\/tv\/(.+)$/), f = m && files.get(decodeURIComponent(m[1])); return f ? r.fulfill({ status: 200, contentType: f.type, body: f.body }) : r.fulfill({ status: 404, body: '' }); });
  const tv3 = await tvc3.newPage(); tv3.on('pageerror', e => errors.push('tv: ' + e.message));
  await tv3.goto(BASE + `/tv/index.html?code=${CODE}&preview=1`); await tv3.waitForSelector('.layer.on');
  await tv3.waitForTimeout(500); await tv3.screenshot({ path: join(SHOTS, 'tv-quiet.png') });
  ok(await tv3.isVisible('.quiet .qlogo') && await tv3.isHidden('#clock') && (await tv3.evaluate(() => window.__tv.state().count)) === 0, 'in quiet hours the TV shows just the dimmed logo');
  const dbIs = async (sql, tries = 30) => { for (let i = 0; i < tries; i++) { if ((await db.query(sql)).rows[0].ok) return true; await page.waitForTimeout(200); } return false; };
  await page.selectOption('#setQStyle', 'black'); await page.click('#setSave'); await dbIs(`select quiet_style = 'black' ok from tv_settings where id = 1`);
  await tv3.evaluate(() => window.__tv.reload()); await tv3.waitForFunction(() => document.querySelector('.quiet') && !document.querySelector('.qlogo'), null, { timeout: 5000 }).catch(() => {});
  ok(await tv3.isVisible('.quiet') && !(await tv3.$('.qlogo')), 'or a black screen');
  await page.uncheck('#setQuiet'); await page.click('#setSave'); await dbIs(`select not quiet_on ok from tv_settings where id = 1`);
  await tv3.evaluate(() => window.__tv.reload()); await tv3.waitForFunction(() => !document.querySelector('.quiet'), null, { timeout: 5000 }).catch(() => {});
  ok(!(await tv3.$('.quiet')) && (await tv3.evaluate(() => window.__tv.state().count)) > 0, 'when quiet hours end, the slideshow comes straight back');
  let qrSeen = false;
  for (let i = 0; i < 12 && !qrSeen; i++) {
    const txt = await tv3.evaluate(() => { const l = document.querySelectorAll('.layer.on'); return l.length ? l[l.length - 1].textContent : ''; });
    if (txt.includes('Follow us on Instagram')) {
      qrSeen = !txt.includes('amamartialarts') && !txt.includes('https://');
      await tv3.waitForTimeout(1200); await tv3.screenshot({ path: join(SHOTS, 'tv-qr.png') });
      const img = await tv3.$eval('.layer.on .qbox img', i => ({ w: i.naturalWidth, shown: i.getBoundingClientRect().width }));
      qrSeen = qrSeen && img.w > 0 && img.shown > 300;
      break;
    }
    await tv3.evaluate(() => window.__tv.next()); await tv3.waitForTimeout(300);
  }
  ok(qrSeen, 'the TV shows the QR slide: heading and a big code, without the link');
  await tvc3.close(); await ctx.close();
  await db.query(`delete from tv_slides where kind = 'qr'`);

  // Videos: hidden until they're actually playing (no big "play" icon first)
  console.log('\nVideos');
  const CLIP = process.env.TEST_CLIP || '/tmp/claude-0/-home-claude/eaa02a79-d300-5a00-9b7a-e09b12f5efb0/scratchpad/clip.webm';
  files.set('videos/test-clip.webm', { type: 'video/webm', body: readFileSync(CLIP) });
  await db.query(`update tv_slides set enabled = false`);
  await db.query(`insert into tv_slides (kind, media_path, title) values ('video', 'videos/test-clip.webm', 'Test clip')`);
  const tvc5 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await tvc5.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await tvc5.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  let releaseClip; const clipGate = new Promise(r => { releaseClip = r; });
  await tvc5.route('**/storage/v1/**', async r => { const m = new URL(r.request().url()).pathname.match(/\/tv\/(.+)$/), f = m && files.get(decodeURIComponent(m[1]));
    if (f && f.type.startsWith('video')) await clipGate;   // hold the video back, like a slow connection
    return f ? r.fulfill({ status: 200, contentType: f.type, body: f.body }) : r.fulfill({ status: 404, body: '' }); });
  const tv5 = await tvc5.newPage(); tv5.on('pageerror', e => errors.push('tv: ' + e.message));
  await tv5.goto(BASE + `/tv/index.html?code=${CODE}&preview=1`);
  await tv5.waitForSelector('video.vid', { state: 'attached' });
  await tv5.waitForTimeout(800);
  ok(await tv5.evaluate(() => getComputedStyle(document.querySelector('video.vid')).opacity === '0' && !document.querySelector('video.vid').controls), 'while a video loads it stays hidden, with no controls or play icon');
  releaseClip();
  await tv5.waitForFunction(() => { const v = document.querySelector('video.vid.on'); return v && !v.paused && v.currentTime > 0; }, null, { timeout: 8000 }).catch(() => {});
  ok(await tv5.evaluate(() => { const v = document.querySelector('video.vid'); return v.className.includes('on') && v.currentTime > 0; }), 'it appears once it is playing');
  await tvc5.close();
  await db.query(`delete from tv_slides where kind = 'video'`); await db.query(`update tv_slides set enabled = true where not party`);

  // Phone remote
  console.log('\nPhone remote');
  const tvc4 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await tvc4.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await tvc4.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  const tv4 = await tvc4.newPage(); tv4.on('pageerror', e => errors.push('tv: ' + e.message));
  await tv4.goto(BASE + `/tv/index.html?code=${CODE}`); await tv4.waitForSelector('.layer.on');
  await db.query(`update tv_settings set seconds = 30 where id = 1`); await tv4.evaluate(() => window.__tv.reload());   // slow, so only the remote moves it
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/remote/index.html');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#app:not([hidden])');
  ok((await page.$$('#list [data-show]')).length >= 3, 'the remote lists the slides to show');
  await tv4.waitForTimeout(500); await tv4.evaluate(() => window.__tv.reload());   // (the TV notices the remote at its next check, up to 20 s)
  await page.waitForFunction(() => document.querySelector('#conn').textContent.includes('listening'), null, { timeout: 10000 }).catch(() => {});
  ok((await page.textContent('#conn')).includes('The TV is listening'), 'once the TV notices, the remote says it is listening');
  const idx = async () => tv4.evaluate(() => window.__tv.state().index);
  const n0 = await tv4.evaluate(() => window.__tv.state().count), i0 = await idx();
  await page.click('#bNext'); await tv4.waitForFunction(i => window.__tv.state().index !== i, i0, { timeout: 5000 }).catch(() => {});
  ok(await idx() === (i0 + 1) % n0, 'Next moves the TV on one slide');
  await page.waitForTimeout(300); await page.click('#bBack'); await tv4.waitForFunction(i => window.__tv.state().index === i, i0, { timeout: 5000 }).catch(() => {});
  ok(await idx() === i0, 'Back goes back one');
  await page.waitForTimeout(300); await page.click('#bPause');
  await tv4.waitForFunction(() => window.__tv.paused(), null, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#pausedChip').hidden, null, { timeout: 5000 }).catch(() => {});
  ok(await tv4.evaluate(() => window.__tv.paused()) && await tv4.isVisible('#pausedTag') && (await page.textContent('#bPause')).includes('Play'), 'Pause stops the slideshow, and both the TV and the remote say Paused');
  const target = (await db.query(`select id from tv_slides where title = 'No classes on Monday'`)).rows[0].id;
  await page.click(`[data-show="${target}"]`);
  await tv4.waitForFunction(id => { const s = window.__tv.state(); return s.ids[s.index] === id; }, target, { timeout: 5000 }).catch(() => {});
  ok(await tv4.evaluate(id => { const s = window.__tv.state(); return s.ids[s.index] === id; }, target) && (await tv4.textContent('.layer.on:last-child')).includes('No classes on Monday'), 'tapping a slide shows it on the TV straight away');
  await page.waitForFunction(id => (document.querySelector(`[data-show="${id}"]`) || {}).className === 'cur', target, { timeout: 5000 }).catch(() => {});
  ok((await page.textContent(`[data-show="${target}"]`)).includes('On the TV now'), 'the remote marks what is on the TV');
  const iHeld = await idx(); await tv4.waitForTimeout(2500);
  ok(await idx() === iHeld && await tv4.evaluate(() => window.__tv.paused()), 'while paused it stays on that slide');
  await page.screenshot({ path: join(SHOTS, 'tv-remote.png') });
  await page.click('#bDark');
  await tv4.waitForFunction(() => !!document.querySelector('.quiet') && !document.querySelector('.qlogo'), null, { timeout: 6000 }).catch(() => {});
  ok(await tv4.isVisible('.quiet') && await tv4.isHidden('#clock'), 'Black out the screen turns the TV black within a few seconds');
  await page.waitForFunction(() => document.querySelector('#bDark').textContent.includes('back on'), null, { timeout: 5000 }).catch(() => {});
  ok((await page.textContent('#bDark')).includes('Turn the screen back on') && await page.isDisabled('#bNext'), 'the remote then offers to turn it back on (and the other buttons wait)');
  await page.screenshot({ path: join(SHOTS, 'tv-remote-dark.png') });
  await page.click('#bDark');
  await tv4.waitForFunction(() => !document.querySelector('.quiet'), null, { timeout: 6000 }).catch(() => {});
  ok(!(await tv4.$('.quiet')) && (await tv4.evaluate(() => window.__tv.state().count)) > 0, 'Turn the screen back on brings the slideshow back');
  await page.waitForTimeout(1500);
  await page.click('#bDone'); await tv4.waitForFunction(() => !window.__tv.paused(), null, { timeout: 5000 }).catch(() => {});
  ok(!(await tv4.evaluate(() => window.__tv.paused())) && await tv4.isHidden('#pausedTag'), 'Done carries on the slideshow');
  await tvc4.close(); await ctx.close();
  await db.query(`update tv_settings set seconds = 4, remote_until = null where id = 1`);

  // Tablets: their own slides, a link with the code in it, upright layout
  console.log('\nTablets');
  const TCODE = (await db.query(`select screen_code from tv_settings where id = 2`)).rows[0].screen_code;
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#list [data-open]');
  await page.click('#dispSeg [data-disp="tablet"]');
  await page.waitForFunction(() => document.querySelector('.brand h1').textContent === 'Tablet Display' && document.querySelector('#list').textContent.includes('No slides yet'), null, { timeout: 5000 }).catch(() => {});
  ok((await page.textContent('#list')).includes('No slides yet') && (await page.textContent('.brand h1')) === 'Tablet Display', 'switching to Tablets shows their own (empty) slide list');
  ok((await page.textContent('#screenLink')) === `https://app.train-ama.com/tv/?code=${TCODE}`, 'Settings shows the tablet link, with its code in it');
  ok(await page.inputValue('#setBanner') === 'Tap to sign in', 'the bottom message is a setting (Tap to sign in for the tablets)');
  await page.click('#qrLink'); await page.waitForSelector('#linkQr');
  await page.waitForTimeout(400);
  const lq = await page.evaluate(() => { const c = document.querySelector('#linkQr'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height); return { w: c.width, h: c.height, data: Array.from(d.data) }; });
  const { PNG: PNG2 } = await import(join(QRDIR, 'pngjs/lib/png.js')), jsQR2 = (await import(join(QRDIR, 'jsqr/dist/jsQR.js'))).default;
  const lqd = jsQR2(new Uint8ClampedArray(lq.data), lq.w, lq.h);
  ok(lqd && lqd.data === `https://app.train-ama.com/tv/?code=${TCODE}`, 'the QR code scans to the tablet link');
  await page.click('#dlg [data-close]');
  await page.click('#addBtn'); await page.click('[data-add="text"]'); await page.waitForSelector('#slForm');
  await page.fill('#slTitle', 'Welcome to AMA'); await page.fill('#slBody', 'Please sign in at the front desk.'); await page.click('#slSave'); await toastSays(page, 'Added');
  await page.waitForTimeout(400);
  await page.click('#addBtn'); await page.click('[data-add="countdown"]'); await page.waitForSelector('#slEvent');
  await page.check('#slForm input[name=cdTo][value=grading]'); await page.click('#slSave'); await toastSays(page, 'Added');
  await page.waitForTimeout(400);
  const tabSlides = (await db.query(`select title, display from tv_slides where display = 'tablet' and not party order by position`)).rows;
  ok(tabSlides.length === 2 && tabSlides[0].title === 'Welcome to AMA', 'slides added on Tablets go to the tablets only');
  ok(!(await page.textContent('#list')).includes('No classes on Monday'), "the TV's slides aren't in the tablet list");
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  if (await page.$('#pForm [data-m="message"]')) await page.click('#pForm [data-m="message"]');
  await page.waitForSelector('#pName'); await page.fill('#pName', 'Leo');
  ok(await page.isChecked('#pBoth') && (await page.textContent('label:has(#pBoth)')).includes('Also on the TV'), 'party mode on the tablets offers "Also on the TV", ticked');
  await page.uncheck('#pBoth'); await page.waitForSelector('#pName'); await page.fill('#pName', 'Leo');
  await page.click('#pGo'); await page.waitForSelector('#partyStop');
  const pr = (await db.query(`select id, only_slide is not null on_ from party_now order by id`)).rows;
  ok(!pr[0].on_ && pr[1].on_, 'party mode on the tablets leaves the TV alone');
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');
  await page.click('#dispSeg [data-disp="tv"]'); await page.waitForFunction(() => document.querySelector('#list').textContent.includes('No classes on Monday'), null, { timeout: 5000 }).catch(() => {});
  ok((await page.textContent('#list')).includes('No classes on Monday') && (await page.textContent('.brand h1')) === 'TV Display', 'switching back shows the TV again');

  // Linked party: one name, the TV poster and its tablet version, on and off together
  const TABLET_TPL = process.env.TABLET_TEMPLATES || '/tmp/claude-0/-home-claude/eaa02a79-d300-5a00-9b7a-e09b12f5efb0/scratchpad/tabpdf/AMA-birthday-poster-tablet-versions.json';
  const jpgSize = b => { for (let i = 2; i < b.length;) { const m = b[i + 1], len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }; i += 2 + len; } return null; };
  if ((await import('node:fs')).existsSync(TABLET_TPL)) {
    await page.click('#partyStart'); await page.waitForSelector('#pForm');
    await page.click('#pForm [data-m="poster"]'); await page.waitForSelector('#pManage'); await page.click('#pManage'); await page.waitForSelector('#tImport');
    await page.click('#tImport'); await page.setInputFiles('#pickImport', TABLET_TPL);
    await page.waitForSelector('#mForm, #tBack:not(:has-text("x"))', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    if (await page.$('#mForm')) await page.click('#mSave');   // the test has fewer templates: skip the rest
    const tt = (await db.query(`select title, tablet_settings from tv_poster_templates where title = 'Turtles'`)).rows[0];
    ok(tt.tablet_settings && tt.tablet_settings.h > tt.tablet_settings.w, 'importing the tablet versions adds an upright design to the matching template');
    await page.waitForFunction(() => document.querySelector('#dlg').textContent.includes('TV and tablet versions'), null, { timeout: 15000 }).catch(() => {});
    ok((await page.textContent('#dlg')).includes('TV and tablet versions'), 'Manage templates shows which have a tablet version');
    // A tablet version saved with just a baseline (no letter size) still gets the name drawn
    const drewName = await page.evaluate(async () => {
      const t = state.templates.find(x => x.title === 'Turtles'), st = { ...t.tablet_settings }; delete st.size;
      const im = await loadImg(MEDIA + t.tablet_image_path), a = document.createElement('canvas'), b = document.createElement('canvas');
      await AMAPoster.render(a, im, st, ''); await AMAPoster.render(b, im, st, 'Kian');
      const da = a.getContext('2d').getImageData(0, 0, a.width, a.height).data, db = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
      let diff = 0; for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 40) diff++;
      return diff;
    });
    ok(drewName > 2000, `a tablet design saved without a letter size still gets the name (${drewName} pixels changed)`);
    await page.click('#tBack'); await page.waitForSelector('#pForm');
    await page.click('#pForm [data-m="poster"]'); await page.waitForSelector('#pForm [data-tpl]');
    await page.click(`#pForm [data-tpl="${(await db.query(`select id from tv_poster_templates where title = 'Turtles'`)).rows[0].id}"]`);
    await page.waitForSelector('#pPoster'); await page.fill('#pPoster', 'Ava'); await page.waitForTimeout(1200);
    ok(await page.isChecked('#pBoth') && await page.isVisible('#pCanvas2'), 'a poster shows on the TV and the tablets together, with both previews');
    await page.screenshot({ path: join(SHOTS, 'party-linked-editor.png') });
    await page.click('#pGo'); await page.waitForSelector('#partyStop', { timeout: 30000 });
    const ls = (await db.query(`select t.id, s.id sid, s.display, s.linked, s.media_path, s.title from party_now t join tv_slides s on s.id = t.only_slide order by t.id`)).rows;
    ok(ls.length === 2 && ls[0].display === 'tv' && ls[1].display === 'tablet' && ls[0].linked === ls[1].sid && ls[1].linked === ls[0].sid && /^Ava/.test(ls[1].title), 'one tap puts it on both screens, linked');
    const dims = jpgSize(files.get(ls[1].media_path).body), dimsTv = jpgSize(files.get(ls[0].media_path).body);
    ok(dims && dims.h > dims.w && dimsTv.w > dimsTv.h, `the tablets get the upright version (${dims && dims.w}x${dims && dims.h}), the TV the wide one`);
    ok((await page.textContent('#party')).includes('The TV and the tablets are showing'), 'the party card says it is on both');
    await page.click('#partyMore'); await page.waitForTimeout(800);
    const mo = (await db.query(`select only_until from party_now order by id`)).rows;
    ok(Math.abs(new Date(mo[0].only_until) - new Date(mo[1].only_until)) < 2000, '1 more hour changes both');
    await page.click('#partyStop'); await toastSays(page, 'Back to normal');
    ok((await db.query(`select count(*)::int n from party_now where only_slide is not null`)).rows[0].n === 0, 'Back to normal ends it on both');
    // Booked, linked
    await page.click('#partyBook'); await page.waitForSelector('#bDate'); await page.click('#pForm [data-m="message"]'); await page.waitForSelector('#pName');
    const tmr2 = new Date(Date.now() + 2 * 864e5), d2 = `${tmr2.getFullYear()}-${String(tmr2.getMonth() + 1).padStart(2, '0')}-${String(tmr2.getDate()).padStart(2, '0')}`;
    await page.fill('#bDate', d2); await page.fill('#bFrom', '10:00'); await page.fill('#bTo', '12:00'); await page.fill('#pName', 'Noah'); await page.click('#pGo'); await toastSays(page, 'Booked');
    const bks = (await db.query(`select s.display from tv_party_bookings b join tv_slides s on s.id = b.slide_id where b.starts_at > now() order by s.display`)).rows.map(r => r.display).join();
    ok(bks === 'tablet,tv', 'booking a party books it on both screens');
    await page.waitForSelector('#party [data-editbk]'); await page.click('#party [data-editbk]'); await page.waitForSelector('#bkTo');
    await page.fill('#bkFrom', '11:00'); await page.fill('#bkTo', '13:00'); await page.fill('#bkHead', 'Happy Birthday Noah and Mia!'); await page.click('#bkGo'); await toastSays(page, 'Saved');
    const bke2 = (await db.query(`select b.starts_at, s.title from tv_party_bookings b join tv_slides s on s.id = b.slide_id where b.starts_at > now()`)).rows;
    ok(bke2.length === 2 && bke2.every(r => new Date(r.starts_at).getHours() === 11 && r.title === 'Happy Birthday Noah and Mia!'), 'editing a linked booking changes it on both screens');
    await page.waitForSelector('#party [data-unbook]'); await page.click('#party [data-unbook]'); await page.click('#cfYes'); await toastSays(page, 'cancelled');
    await page.waitForTimeout(500);
    ok((await db.query(`select count(*)::int n from tv_party_bookings where starts_at > now()`)).rows[0].n === 0, 'cancelling it cancels both');
  } else console.log('        (tablet templates file not found; linked poster tests skipped)');

  // Tablet versions for templates named differently: matched by other names, or picked by hand
  {
    const img = 'data:image/png;base64,' + readFileSync(join(here, '../../../site/icons/clipboard.png')).toString('base64');
    const st = { size: 150, box: { cx: 620, base: 800, maxW: 900 }, font: 'Knewave', fill: '#ffffff', stroke: '#000000', strokeWidth: 0.09, uppercase: true, w: 1240, h: 1754 };
    await db.query(`insert into tv_poster_templates (title, image_path, settings, position) select 'Sonic party', image_path, settings, 50 from tv_poster_templates limit 1`);
    await db.query(`insert into tv_poster_templates (title, image_path, settings, position) select 'Mystery', image_path, settings, 51 from tv_poster_templates limit 1`);
    await page.evaluate(() => load()); await page.waitForTimeout(800);
    const f2 = join(tmpdir(), 'tv-test-tablet-match.json');
    (await import('node:fs')).writeFileSync(f2, JSON.stringify({ app: 'ama-tv-templates', templates: [
      { title: 'Hedgehog', match: ['Sonic'], tablet: { image: img, settings: st } }, { title: 'Unicorn', tablet: { image: img, settings: st } }] }));
    await page.click('#partyStart'); await page.waitForSelector('#pForm');
    await page.click('#pForm [data-m="poster"]'); await page.waitForSelector('#pManage'); await page.click('#pManage'); await page.waitForSelector('#tImport');
    await page.click('#tImport'); await page.setInputFiles('#pickImport', f2);
    await page.waitForSelector('#mForm', { timeout: 15000 }).catch(() => {});
    ok((await db.query(`select tablet_settings is not null t from tv_poster_templates where title = 'Sonic party'`)).rows[0].t, 'a tablet version finds its template by another name (Hedgehog -> "Sonic party")');
    ok(await page.isVisible('#mForm') && (await page.textContent('#mForm')).includes('Unicorn'), "one that doesn't match asks which template it's for");
    const mid = (await db.query(`select id from tv_poster_templates where title = 'Mystery'`)).rows[0].id;
    await page.selectOption('#mForm [data-match="0"]', mid); await page.click('#mSave');
    await page.waitForFunction(() => !document.querySelector('#mForm'), null, { timeout: 10000 }).catch(() => {});
    ok((await db.query(`select tablet_settings is not null t from tv_poster_templates where title = 'Mystery'`)).rows[0].t, '...and gets added to the one picked');
    await page.evaluate(() => document.querySelector('#dlg').close());
    await db.query(`delete from tv_poster_templates where title in ('Sonic party', 'Mystery')`);
  }
  await ctx.close();

  // On a tablet: open the link, no code to type
  const tabc = await browser.newContext({ viewport: { width: 800, height: 1280 }, isMobile: true, hasTouch: true });
  await tabc.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await tabc.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  const tabp = await tabc.newPage(); tabp.on('pageerror', e => errors.push('tablet: ' + e.message));
  await tabp.goto(BASE + `/tv/index.html?code=${TCODE}`); await tabp.waitForSelector('.layer.on');
  ok(await tabp.evaluate(() => document.getElementById('codeScreen').style.display === 'none') && tabp.url().includes(`code=${TCODE}`), 'the tablet link plays straight away (no code to type), and keeps the code in the address');
  const tabTexts = []; let fits = true;
  for (let i = 0; i < (await tabp.evaluate(() => window.__tv.state().count)); i++) {
    await tabp.waitForTimeout(900);
    tabTexts.push(await tabp.evaluate(() => { const l = document.querySelectorAll('.layer.on'); return l[l.length - 1].textContent; }));
    fits = fits && await tabp.evaluate(() => { const c = document.querySelector('.layer.on:last-child .card'); return !c || c.scrollHeight <= c.clientHeight + 2; });
    await tabp.screenshot({ path: join(SHOTS, `tablet-slide-${i + 1}.png`) });
    await tabp.evaluate(() => window.__tv.next());
  }
  const tt = tabTexts.join(' | ');
  ok(tt.includes('Welcome to AMA') && /weeks to go/.test(tt) && !tt.includes('No classes on Monday'), 'the tablet shows its own slides, not the TV ones');
  ok(fits && await tabp.evaluate(() => getComputedStyle(document.querySelector('.clock')).fontSize) !== '0px', 'everything fits the upright screen');
  ok((await tabp.textContent('#hint')).includes('Tap the screen'), 'on a tablet it says to tap for full screen');
  ok(await tabp.isVisible('#banner') && (await tabp.textContent('#banner')) === 'Tap to sign in', 'the tablet shows "Tap to sign in" along the bottom');
  // A second tablet on the same link
  const tabc2 = await browser.newContext({ viewport: { width: 800, height: 1280 }, isMobile: true, hasTouch: true });
  await tabc2.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await tabc2.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  const tabp2 = await tabc2.newPage(); await tabp2.goto(BASE + `/tv/index.html?code=${TCODE}`); await tabp2.waitForSelector('.layer.on');
  ok((await tabp2.evaluate(() => window.__tv.state().count)) === (await tabp.evaluate(() => window.__tv.state().count)), 'a second tablet on the same link plays the same slides');
  await tabp.evaluate(() => window.__tv.checkIn()); await tabp2.evaluate(() => window.__tv.checkIn()); await tabp2.waitForTimeout(800);
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html?display=tablet');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#status:not([hidden])');
  ok((await page.textContent('#status')).includes('2 of 2 tablets online') && (await page.textContent('#status')).includes('Tablet 1') && (await page.textContent('#status')).includes('Tablet 2'), 'the editor lists each tablet');
  await page.click('#status [data-name-tv]'); await page.waitForSelector('#nmIn'); await page.fill('#nmIn', 'Front desk'); await page.click('#nmSave');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Front desk:'), null, { timeout: 5000 }).catch(() => {});
  ok((await page.textContent('#status')).includes('Front desk: Showing'), 'a tablet can be given a name');
  await page.locator('#status').screenshot({ path: join(SHOTS, 'tablets-status.png') });
  await ctx.close(); await tabc2.close();
  await tabc.close();
  await db.query(`delete from tv_slides where display = 'tablet'`);

  // Locations: devices at Sydenham and Marrickville, each with its own party at the same time
  console.log('\nLocations');
  await db.query(`delete from tv_party_bookings`); await db.query(`update tv_settings set only_slide = null, only_until = null`);
  const mkTv = async loc => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await c.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
    await c.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
    const pg = await c.newPage(); pg.on('pageerror', e => errors.push('tv: ' + e.message));
    await pg.goto(BASE + `/tv/index.html?code=${CODE}${loc ? '&loc=' + loc : ''}`); await pg.waitForSelector('.layer.on');
    await pg.evaluate(() => window.__tv.checkIn()); await pg.waitForTimeout(600);
    return { c, pg };
  };
  const syd = await mkTv('sydenham'), mkv = await mkTv(null);
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#locCard:not([hidden])');
  ok((await page.textContent('#locCard')).includes('Marrickville, Sydenham, Concord, Auburn, Sylvania'), 'Settings lists the locations');
  await page.evaluate(() => pollStatus()); await page.waitForTimeout(600);
  const stx = await page.textContent('#status');
  ok(stx.includes('Sydenham') && stx.includes('No location'), 'TV status shows each device\'s location (the one opened with a Sydenham link is at Sydenham)');
  // Give the other TV a location in the editor
  const mkvId = (await db.query(`select screen_id from tv_screens where location is null and display = 'tv' order by last_seen desc limit 1`)).rows[0].screen_id;
  await page.click(`#status [data-name-tv="${mkvId}"]`); await page.waitForSelector('#nmLoc');
  await page.fill('#nmIn', 'Reception'); await page.selectOption('#nmLoc', 'marrickville'); await page.click('#nmSave');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Reception'), null, { timeout: 5000 }).catch(() => {});
  ok((await db.query(`select location from tv_screens where screen_id = $1`, [mkvId])).rows[0].location === 'marrickville', 'a device can be given a location in the editor');
  // Settings link for a location
  await page.selectOption('#linkLoc', 'concord');
  ok((await page.textContent('#screenLink')).endsWith('&loc=concord'), 'Settings makes a link for a device at a location');
  // A Sydenham party and a Marrickville party at once
  const party = async (name, loc) => {
    await page.click('#partyStart'); await page.waitForSelector('#pForm');
    if (await page.$('#pForm [data-m="message"]')) await page.click('#pForm [data-m="message"]');
    await page.waitForSelector('#pWhere'); await page.selectOption('#pWhere', loc); await page.waitForSelector('#pName');
    if (await page.isChecked('#pBoth')) await page.uncheck('#pBoth');
    await page.waitForSelector('#pName'); await page.fill('#pName', name); await page.click('#pGo'); await toastSays(page, 'Party mode on');
    await page.waitForTimeout(600);
  };
  await party('Syd', 'sydenham'); await party('Mark', 'marrickville');
  const act = (await db.query(`select s.title, s.locations from tv_party_bookings b join tv_slides s on s.id = b.slide_id where b.starts_at <= now() and b.ends_at > now() order by s.title`)).rows;
  ok(act.length === 2 && act[0].locations[0] === 'marrickville' && act[1].locations[0] === 'sydenham', 'two locations can each start a party at once');
  ok((await page.$$('#party [data-stop]')).length === 2 && (await page.textContent('#party')).includes('at Sydenham'), 'the party card shows both, with where');
  await page.screenshot({ path: join(SHOTS, 'locations-parties.png') });
  for (const t of [syd, mkv]) { await t.pg.evaluate(() => window.__tv.reload()); }
  await syd.pg.waitForFunction(() => window.__tv.state().count === 1, null, { timeout: 6000 }).catch(() => {});
  await mkv.pg.waitForFunction(() => window.__tv.state().count === 1, null, { timeout: 6000 }).catch(() => {});
  ok((await syd.pg.textContent('#stage')).includes('Happy Birthday Syd!') && (await mkv.pg.textContent('#stage')).includes('Happy Birthday Mark!'), 'each TV shows only the party for its location');
  // Starting another Sydenham party replaces the Sydenham one only
  await party('Sydney', 'sydenham');
  const act2 = (await db.query(`select s.title from tv_party_bookings b join tv_slides s on s.id = b.slide_id where b.starts_at <= now() and b.ends_at > now() order by s.title`)).rows.map(r => r.title).join();
  ok(act2 === 'Happy Birthday Mark!,Happy Birthday Sydney!', 'a new party at Sydenham replaces only the Sydenham one');
  await page.click('#party [data-stop]'); await page.waitForTimeout(500); await page.click('#party [data-stop]'); await page.waitForTimeout(500);
  ok((await db.query(`select count(*)::int n from tv_party_bookings where starts_at <= now() and ends_at > now()`)).rows[0].n === 0, 'each can be ended');
  // A slide just for Sydenham
  await page.click('#addBtn'); await page.click('[data-add="text"]'); await page.waitForSelector('#slLocs');
  await page.fill('#slTitle', 'Sydenham car park closed'); await page.check('#slLocs input[value="sydenham"]'); await page.click('#slSave'); await toastSays(page, 'Added');
  await page.waitForTimeout(500);
  ok((await page.textContent('#list')).includes('Sydenham car park closed') && (await page.$$('#list .tag')).length > 0, 'a slide can be for one location, and the list says where');
  for (const t of [syd, mkv]) { await t.pg.evaluate(() => window.__tv.reload()); await t.pg.waitForTimeout(500); await t.pg.evaluate(() => window.__tv.next()); }
  await syd.pg.waitForTimeout(800);
  const ids = async t => t.pg.evaluate(() => window.__tv.state().ids);
  const sydSlide = (await db.query(`select id from tv_slides where title = 'Sydenham car park closed'`)).rows[0].id;
  ok((await ids(syd)).includes(sydSlide) && !(await ids(mkv)).includes(sydSlide), 'it plays at Sydenham only');
  await page.click('#locEdit'); await page.waitForSelector('#locNew');
  await page.fill('#locNew', 'Parramatta'); await page.click('#locAdd button[type=submit]');
  await page.waitForFunction(() => !!document.querySelector('[data-loc="parramatta"]'), null, { timeout: 5000 }).catch(() => {});
  ok((await db.query(`select name from tv_locations where slug = 'parramatta'`)).rows.length === 1, 'locations can be added (and renamed or removed)');
  // A location's own settings: slideshow hours just for Sydenham
  await page.click('[data-locset="sydenham"]'); await page.waitForSelector('#lsForm');
  ok(await page.isHidden('#lsHours'), 'a location uses the main slideshow hours until it is given its own');
  await page.check('#lsOwn'); await page.waitForSelector('#ld1From');
  const dowNow = new Date().getDay();
  await page.uncheck(`#ld${dowNow}On`); await page.click('#lsGo'); await toastSays(page, 'Saved');
  const lh = (await db.query(`select hours from tv_locations where slug = 'sydenham'`)).rows[0].hours;
  ok(lh && lh[String(dowNow)] === null && Object.keys(lh).length === 7, 'Sydenham can have its own hours for each day');
  await syd.pg.evaluate(() => window.__tv.reload()); await mkv.pg.evaluate(() => window.__tv.reload()); await syd.pg.waitForTimeout(800);
  ok(!!(await syd.pg.evaluate(() => window.__tv.feed().quiet)) && !(await mkv.pg.evaluate(() => window.__tv.feed().quiet)), 'so Sydenham goes quiet outside its hours while other locations carry on');
  ok((await page.textContent('#locCard')).includes('Own slideshow hours'), 'the Locations card lists locations with their own hours');
  await page.click('#locEdit'); await page.click('[data-locset="sydenham"]'); await page.waitForSelector('#lsForm');
  await page.check('#lsForm input[value="main"]'); await page.click('#lsGo'); await page.waitForSelector('#lsForm', { state: 'detached', timeout: 5000 }).catch(() => {}); await page.waitForTimeout(300);
  ok((await db.query(`select hours from tv_locations where slug = 'sydenham'`)).rows[0].hours === null, 'and set back to the main hours');
  await db.query(`delete from tv_slides where title = 'Sydenham car park closed'`); await db.query(`delete from tv_locations where slug = 'parramatta'`);
  await ctx.close(); await syd.c.close(); await mkv.c.close();

  // Scheduled screen-off times
  console.log('\nScheduled screen-off times');
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#offBox:not([hidden])');
  await page.click('#offAdd'); await page.click('#offAdd'); await page.click('#offAdd');
  const ats = await page.$$eval('#offRows [data-at]', xs => xs.map(x => x.value));
  ok(ats.join() === '10:00,10:30,11:00' && (await page.$$('#offRows [data-d="6"][aria-pressed="true"]')).length === 3, '"Add a time" makes Saturday 10:00, 10:30, 11:00 in three taps');
  await page.fill('#offRows [data-off="2"] [data-min]', '15'); await page.click('#offRows [data-off="0"] [data-d="0"]');
  await page.selectOption('#offRows [data-off="1"] [data-for]', 'loc:sydenham');
  await page.locator('#offBox').screenshot({ path: join(SHOTS, 'scheduled-offs.png') });
  await page.click('#setSave'); await toastSays(page, 'Settings saved'); await page.waitForTimeout(400);
  const offs = (await db.query(`select offs from tv_settings where id = 1`)).rows[0].offs;
  ok(offs.length === 3 && offs[2].minutes === 15 && offs[0].days.includes(0) && offs[0].days.includes(6) && offs[1].for === 'loc:sydenham', 'saved with their days, minutes and which screens');
  await page.click('#offRows [data-off="0"] [data-offdel]'); await page.click('#setSave'); await toastSays(page, 'Settings saved'); await page.waitForTimeout(400);
  ok((await db.query(`select jsonb_array_length(offs) n from tv_settings where id = 1`)).rows[0].n === 2, 'a time can be removed');
  const nd = (await db.query(`select extract(dow from (now() at time zone 'Australia/Sydney'))::int d, to_char((now() at time zone 'Australia/Sydney') - interval '1 minute', 'HH24:MI') a`)).rows[0];
  await db.query(`update tv_settings set offs = $1::jsonb where id = 1`, [JSON.stringify([{ days: [nd.d], at: nd.a, minutes: 10, for: 'all' }])]);
  const tvo = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await tvo.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await tvo.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  const tvop = await tvo.newPage(); await tvop.goto(BASE + `/tv/index.html?code=${CODE}`); await tvop.waitForSelector('.layer.on');
  ok(await tvop.isVisible('.quiet') && (await tvop.evaluate(() => window.__tv.state().count)) === 0, 'at a scheduled time the TV turns off');
  await db.query(`update tv_settings set offs = '[]'::jsonb where id = 1`);
  await tvop.evaluate(() => window.__tv.reload()); await tvop.waitForFunction(() => !document.querySelector('.quiet'), null, { timeout: 6000 }).catch(() => {});
  ok(!(await tvop.$('.quiet')), '...and back on after');
  await tvo.close(); await ctx.close();

  // Sign-in mode on the tablets
  console.log('\nSign-in mode');
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html?display=tv');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#setSecs, #setForm', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(800);
  ok(await page.isHidden('#signinBox') && await page.isHidden('#bannerBox'), 'the TV has no sign-in page or bottom message settings (it is a normal browser)');
  ok(await page.isHidden('#pqrBox'), 'the TV has no party QR code setting');
  await page.goto(BASE + '/tv/edit/index.html?display=tablet');
  await page.waitForSelector('#signinBox:not([hidden])');
  // A big QR code along the bottom during parties (e.g. the waiver)
  ok(await page.isVisible('#pqrBox'), 'the tablets have a "QR code during parties" setting');
  await page.fill('#setPqr', 'forms.gle/AmaWaiver123'); await page.fill('#setPqrText', 'Scan to complete the waiver');
  await page.click('#setSave'); await toastSays(page, 'Settings saved');
  const pq = (await db.query(`select party_qr_url, party_qr_text from tv_settings where id = 2`)).rows[0];
  ok(pq.party_qr_url === 'https://forms.gle/AmaWaiver123' && pq.party_qr_text === 'Scan to complete the waiver', 'the link and text are saved (https:// added)');
  await db.query(`update tv_settings set party_qr_url = null where id = 2`);
  await page.waitForFunction(() => document.querySelector('#toast').hidden, null, { timeout: 8000 }).catch(() => {});   // so the next "Settings saved" is a new one
  ok(await page.inputValue('#setSigninOpen') === 'page' && await page.isHidden('#signinTest') && (await page.textContent('#signinHint')).includes('Fully Kiosk'), 'by default a tap goes to the sign-in page (for sites like ESC), with how to set up the kiosk app');
  await page.selectOption('#setSigninOpen', 'frame');
  await page.fill('#setSignin', 'signin.test/ama'); await page.selectOption('#setSigninIdle', '30');
  await page.click('#setSave'); await toastSays(page, 'Settings saved'); await page.waitForTimeout(400);
  const sgn = (await db.query(`select signin_url, signin_idle from tv_settings where id = 2`)).rows[0];
  ok(sgn.signin_url === 'https://signin.test/ama' && sgn.signin_idle === 30, 'the tablets get a sign-in page and how long to wait');
  await ctx.close();
  await db.query(`update tv_settings set signin_idle = 10 where id = 2`);   // quicker for the test
  await db.query(`insert into tv_slides (kind, title, display) values ('text', 'Tablet welcome', 'tablet')`);
  const sic = await browser.newContext({ viewport: { width: 800, height: 1280 }, isMobile: true, hasTouch: true });
  await sic.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await sic.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await sic.route('https://signin.test/**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="font:40px sans-serif"><h1>ESC sign in</h1><input id="q" placeholder="Your name"></body>' }));
  const sp2 = await sic.newPage(); sp2.on('pageerror', e => errors.push('tablet: ' + e.message));
  const TC = (await db.query(`select screen_code from tv_settings where id = 2`)).rows[0].screen_code;
  await sp2.goto(BASE + `/tv/index.html?code=${TC}`); await sp2.waitForSelector('.layer.on');
  await sp2.waitForSelector('#signin', { state: 'visible', timeout: 5000 }).catch(() => {});
  const fr = sp2.frames().find(f => f.url().startsWith('https://signin.test'));
  ok(await sp2.isVisible('#signin') && fr && (await fr.textContent('h1')) === 'ESC sign in', 'the tablet opens on the sign-in page');
  await sp2.screenshot({ path: join(SHOTS, 'signin-page.png') });
  await sp2.waitForSelector('#signin', { state: 'hidden', timeout: 14000 }).catch(() => {});
  ok(await sp2.isHidden('#signin') && (await sp2.textContent('.layer.on:last-child')).includes('Tablet welcome'), 'with no taps for the set time, it shows the slides');
  await sp2.click('.layer.on', { force: true }); await sp2.waitForTimeout(400);
  ok(await sp2.isVisible('#signin'), 'a tap brings the sign-in page back');
  const tpid = (await db.query(`insert into tv_slides (kind, title, theme, party, display) values ('text', 'Happy Birthday Zoe!', 'party', true, 'tablet') returning id`)).rows[0].id;
  await db.query(`insert into tv_party_bookings (slide_id, starts_at, ends_at) values ($1, now() - interval '1 minute', now() + interval '1 hour')`, [tpid]);
  await sp2.evaluate(() => window.__tv.reload()); await sp2.waitForTimeout(1000);
  ok(await sp2.isHidden('#signin') && (await sp2.textContent('#stage')).includes('Happy Birthday Zoe!'), 'when a party starts, the tablet goes to the party');
  await sp2.click('.layer.on', { force: true }); await sp2.waitForTimeout(400);
  ok(await sp2.isHidden('#signin'), 'and taps do nothing during the party');
  await db.query(`delete from tv_party_bookings`); await sp2.evaluate(() => window.__tv.reload()); await sp2.waitForTimeout(1000);
  await sp2.click('.layer.on', { force: true }); await sp2.waitForTimeout(400);
  ok(await sp2.isVisible('#signin'), 'after the party, a tap opens the sign-in page again');
  // Going to the page instead (sites that can't be shown inside, like ESC)
  await db.query(`update tv_settings set signin_open = 'page' where id = 2`);
  const sp3 = await sic.newPage(); await sp3.goto(BASE + `/tv/index.html?code=${TC}`); await sp3.waitForSelector('.layer.on'); await sp3.waitForTimeout(500);
  ok(await sp3.isHidden('#signin') && sp3.url().startsWith(BASE), 'it starts on the slides');
  await Promise.all([sp3.waitForURL(/signin\.test/, { timeout: 5000 }).catch(() => {}), sp3.click('.layer.on', { force: true })]);
  ok(sp3.url().startsWith('https://signin.test/ama'), 'a tap goes to the sign-in page itself');
  await db.query(`insert into tv_party_bookings (slide_id, starts_at, ends_at) values ($1, now() - interval '1 minute', now() + interval '1 hour')`, [tpid]);
  await sp3.goto(BASE + `/tv/index.html?code=${TC}`); await sp3.waitForSelector('.layer.on'); await sp3.waitForTimeout(800);
  await sp3.click('.layer.on', { force: true }); await sp3.waitForTimeout(800);
  ok(sp3.url().startsWith(BASE) && (await sp3.textContent('#stage')).includes('Happy Birthday Zoe!'), 'during a party a tap does nothing');
  ok(!(await sp3.$('.pqr')), 'no QR code strip when no link is set');
  await db.query(`update tv_settings set party_qr_url = 'https://forms.gle/AmaWaiver123', party_qr_text = 'Scan to complete the waiver' where id = 2`);
  await sp3.goto(BASE + `/tv/index.html?code=${TC}`); await sp3.waitForSelector('.layer.on .pqr'); await sp3.waitForTimeout(600);
  const qrPng = await sp3.$eval('.layer.on .pqrc', c => c.toDataURL('image/png'));
  { const { PNG } = await import(join(QRDIR, 'pngjs/lib/png.js')), jsQR = (await import(join(QRDIR, 'jsqr/dist/jsQR.js'))).default;
    const im = PNG.sync.read(Buffer.from(qrPng.split(',')[1], 'base64')), dec = jsQR(new Uint8ClampedArray(im.data), im.width, im.height);
    const box = await sp3.$eval('.layer.on .pqrc', c => c.getBoundingClientRect().width / window.innerWidth);
    ok(dec && dec.data === 'https://forms.gle/AmaWaiver123' && (await sp3.textContent('.layer.on .pqrt')).includes('Scan to complete the waiver') && (await sp3.textContent('#stage')).includes('Happy Birthday Zoe!'),
      'during a party the tablet shows the poster with a big QR code along the bottom, and it scans');
    ok(box > 0.35, `the QR code is big (${Math.round(box * 100)}% of the screen width)`); }
  await sp3.screenshot({ path: join(SHOTS, 'tablet-party-qr.png') });
  await db.query(`update tv_settings set party_qr_url = null where id = 2`);
  await db.query(`delete from tv_party_bookings`);
  // FreeKiosk: sign-in page as its main page, our slides as its screensaver; a party goes onto the main screen
  await db.query(`update tv_settings set signin_open = 'kiosk', kiosk_port = 8080 where id = 2`);
  const api = [];
  let kioskStatus = '{"status":"ok"}', kioskFollows = false;   // what FreeKiosk's /api/status says (its current page, when we set one)
  await sic.route('http://127.0.0.1:8080/**', async r => { const path = new URL(r.request().url()).pathname; api.push({ path, body: r.request().postData() || '' });
    if (kioskFollows && path === '/api/url') kioskStatus = JSON.stringify({ webview: { url: JSON.parse(r.request().postData()).url } });
    return r.fulfill({ status: 200, contentType: 'application/json', body: path === '/api/status' ? kioskStatus : '{"status":"ok"}' }); });
  await sp2.close(); await sp3.close();   // one tablet page from here on (each page talks to FreeKiosk)
  const ss = await sic.newPage(); await ss.goto(BASE + `/tv/index.html?code=${TC}`); await ss.waitForSelector('.layer.on'); await ss.waitForTimeout(600);
  await ss.click('.layer.on', { force: true }); await ss.waitForTimeout(600);
  ok(ss.url().startsWith(BASE) && api.length === 0 && await ss.isHidden('#signin'), 'as FreeKiosk\'s screensaver, a tap is left to FreeKiosk and nothing is sent');
  await db.query(`insert into tv_party_bookings (slide_id, starts_at, ends_at) values ($1, now() - interval '1 minute', now() + interval '1 hour')`, [tpid]);
  await ss.evaluate(() => window.__tv.reload()); await ss.waitForTimeout(1500);
  const urlCall = api.find(x => x.path === '/api/url');
  ok(urlCall && /kiosk=main/.test(JSON.parse(urlCall.body).url) && api.some(x => x.path === '/api/wake'), 'when a party starts, it asks FreeKiosk to put it on the main screen (and close the screensaver)');
  await ss.evaluate(() => window.__tv.reload()); await ss.waitForTimeout(800);
  ok(api.filter(x => x.path === '/api/url').length === 1, 'only once per party');
  ok(/[?&]p=\d+/.test(JSON.parse(urlCall.body).url), 'with a new address each time, so FreeKiosk always loads it fresh');
  // FreeKiosk still showing another page 10 seconds later (not the party's main page): it sends it again
  kioskStatus = JSON.stringify({ webview: { url: 'http://' + new URL(BASE).host + '/tv/index.html?code=X' } });
  await ss.waitForTimeout(11000); await ss.evaluate(() => window.__tv.reload()); await ss.waitForTimeout(1500);
  ok(api.filter(x => x.path === '/api/url').length >= 2 && api.some(x => x.path === '/api/status'), 'if FreeKiosk is still on an old page after 10 seconds, it sends the party again');
  const lastUrl = JSON.parse(api.filter(x => x.path === '/api/url').pop().body).url;
  kioskStatus = JSON.stringify({ webview: { url: lastUrl } }); kioskFollows = true;   // FreeKiosk now does what it's told
  await ss.waitForTimeout(11000); const sentNow = api.filter(x => x.path === '/api/url').length;
  await ss.waitForTimeout(11000); await ss.evaluate(() => window.__tv.reload()); await ss.waitForTimeout(800);
  ok(api.filter(x => x.path === '/api/url').length === sentNow, 'once FreeKiosk shows it, nothing more is sent');
  kioskStatus = '{"status":"ok"}'; kioskFollows = false;
  const mainUrl = JSON.parse(urlCall.body).url.replace(/^https?:\/\/[^/]+/, BASE);
  const mp = await sic.newPage(); await mp.goto(mainUrl); await mp.waitForSelector('.layer.on'); await mp.waitForTimeout(600);
  await mp.click('.layer.on', { force: true }); await mp.waitForTimeout(600);
  ok(mp.url().includes('kiosk=main') && (await mp.textContent('#stage')).includes('Happy Birthday Zoe!'), 'the main screen shows the party and taps do nothing');
  ok(await mp.evaluate(() => /user-scalable=no/.test(document.querySelector('meta[name=viewport]').content) && getComputedStyle(document.body).touchAction === 'none'), 'and it can\'t be zoomed in');
  // FreeKiosk's screensaver comes on again after a minute with no taps (a fresh copy of this page): it mustn't send the party again
  // (that reloaded the main screen every minute)
  { const before = api.filter(x => x.path === '/api/url').length;
    kioskStatus = JSON.stringify({ webview: { url: mainUrl } });
    const ss2 = await sic.newPage(); await ss2.goto(BASE + `/tv/index.html?code=${TC}`); await ss2.waitForSelector('.layer.on'); await ss2.waitForTimeout(1500);
    await ss2.evaluate(() => window.__tv.reload()); await ss2.waitForTimeout(1000);
    ok(api.filter(x => x.path === '/api/url').length === before, 'the screensaver coming back during a party does not reload the main screen');
    await ss2.close(); kioskStatus = '{"status":"ok"}'; }
  await db.query(`delete from tv_party_bookings`);
  await ss.evaluate(() => window.__tv.reload()); await ss.waitForTimeout(800);
  ok(api.some(x => x.path === '/api/url' && /signin\.test/.test(x.body)), 'when the party ends, the screensaver also tells FreeKiosk to put the sign-in page back (in case the party page is paused)');
  if (!mp.url().startsWith('https://signin.test/ama')) await Promise.all([mp.waitForURL(/signin\.test/, { timeout: 8000 }).catch(() => {}), mp.evaluate(() => window.__tv.reload()).catch(() => {})]);
  ok(mp.url().startsWith('https://signin.test/ama'), 'when the party ends, the main screen goes back to the sign-in page');
  await sic.close();
  await db.query(`update tv_settings set signin_url = null, signin_idle = 60, signin_open = 'page' where id = 2`); await db.query(`delete from tv_slides where display = 'tablet'`);

  // Saving egress: only changes are sent, and photos are kept on the screen
  console.log('\nSaving egress');
  {
    const ec = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ec.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
    await ec.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
    const hits = {}; let feedBytes = [];
    await ec.route('**/storage/v1/**', r => { const m = new URL(r.request().url()).pathname.match(/\/tv\/(.+)$/), k = m && decodeURIComponent(m[1]), f = k && files.get(k);
      hits[k] = (hits[k] || 0) + 1; return f ? r.fulfill({ status: 200, contentType: f.type, headers: { 'access-control-allow-origin': '*' }, body: f.body }) : r.fulfill({ status: 404, body: '' }); });
    const ep = await ec.newPage();
    ep.on('response', async res => { if (res.url().includes('/rpc/tv_feed')) { try { feedBytes.push((await res.body()).length); } catch (e) { /* ignore */ } } });
    await ep.goto(BASE + `/tv/index.html?code=${CODE}`); await ep.waitForSelector('.layer.on');
    await ep.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 8000 }).catch(() => {});
    await ep.reload(); await ep.waitForSelector('.layer.on');
    const n = await ep.evaluate(() => window.__tv.state().count);
    for (let i = 0; i < n + 1; i++) { await ep.waitForTimeout(400); await ep.evaluate(() => window.__tv.next()); }
    await ep.evaluate(() => window.__tv.reload()); await ep.waitForTimeout(800);
    const photos = Object.keys(hits).filter(k => k && k.startsWith('photos/'));
    ok(photos.every(k => hits[k] === 1), `each photo is downloaded once, even after the page reloads (${photos.map(k => hits[k]).join(',')})`);
    ok(feedBytes.length >= 2 && feedBytes[feedBytes.length - 1] < 100 && feedBytes[0] > 300, `checks with nothing new are tiny (${feedBytes.join(', ')} bytes)`);
    await ec.close();
  }

  // Low battery (tablets only)
  console.log('\nLow battery');
  {
    const TCB = (await db.query(`select screen_code from tv_settings where id = 2`)).rows[0].screen_code;
    const mk = async (c) => { const x = await browser.newContext({ viewport: { width: 800, height: 1280 } });
      await x.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
      await x.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
      const p = await x.newPage(); await p.goto(BASE + `/tv/index.html?code=${c}`); await p.waitForSelector('.layer.on'); return { x, p }; };
    const tvb = await mk(CODE);
    await tvb.p.evaluate(() => window.__tv.battery(10, false)); await tvb.p.waitForTimeout(300);
    ok(await tvb.p.isHidden('#lowbat'), 'the TV never shows the battery bar');
    await tvb.x.close();
    const tb = await mk(TCB);
    await tb.p.evaluate(() => window.__tv.battery(15, false)); await tb.p.waitForTimeout(300);
    ok(await tb.p.isVisible('#lowbat') && (await tb.p.textContent('#lowbat')).includes('15%'), 'on a tablet below 20% (not charging) a red bar asks for it to be plugged in');
    await tb.p.screenshot({ path: join(SHOTS, 'low-battery.png') });
    await tb.p.evaluate(() => window.__tv.battery(15, true)); await tb.p.waitForTimeout(300);
    ok(await tb.p.isHidden('#lowbat'), 'it hides while charging');
    await tb.p.evaluate(() => window.__tv.battery(64, false)); await tb.p.waitForTimeout(300);
    ok(await tb.p.isHidden('#lowbat'), 'and above the level');
    await tb.p.evaluate(() => window.__tv.battery(12, false)); await tb.p.evaluate(() => window.__tv.checkIn()); await tb.p.waitForTimeout(800);
    ({ ctx, page } = await context({ width: 390, height: 844 }));
    await page.goto(BASE + '/tv/edit/index.html');
    await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
    await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
    await page.waitForSelector('#setForm');
    ok(await page.isHidden('#batBox'), 'the TV screen has no battery setting');
    await page.click('#dispSeg [data-disp="tablet"]'); await page.waitForSelector('#batBox:not([hidden])');
    await page.evaluate(() => pollStatus()); await page.waitForTimeout(600);
    ok((await page.textContent('#status')).includes('Battery 12%'), 'the editor shows each tablet\'s battery');
    await page.fill('#setBatWarn', '30'); await page.click('#setSave'); await toastSays(page, 'Settings saved'); await page.waitForTimeout(300);
    ok((await db.query(`select battery_warn from tv_settings where id = 2`)).rows[0].battery_warn === 30, 'the level can be changed in the tablet Settings');
    await db.query(`update tv_settings set battery_warn = 20 where id = 2`);
    await page.click('#dispSeg [data-disp="tv"]'); await page.waitForTimeout(500);
    await ctx.close(); await tb.x.close();
  }

  // Black out one device
  console.log('\nBlack out one device');
  {
    const mk = async () => { const x = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      await x.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
      await x.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
      const p = await x.newPage(); await p.goto(BASE + `/tv/index.html?code=${CODE}`); await p.waitForSelector('.layer.on');
      await p.evaluate(() => window.__tv.checkIn()); await p.waitForTimeout(500); return { x, p }; };
    const a1 = await mk(), a2 = await mk();
    const id1 = await a1.p.evaluate(() => localStorage.getItem('tvScreen'));
    ({ ctx, page } = await context({ width: 390, height: 844 }));
    await page.goto(BASE + '/tv/edit/index.html');
    await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
    await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
    await page.waitForSelector(`#status [data-dark-tv="${id1}"]`);
    await page.click(`#status [data-dark-tv="${id1}"]`); await toastSays(page, 'goes black');
    await page.waitForFunction(id => (document.querySelector(`#status [data-dark-tv="${id}"]`) || {}).textContent === 'Back on', id1, { timeout: 5000 }).catch(() => {});
    await page.locator('#status').screenshot({ path: join(SHOTS, 'device-blackout.png') });
    for (const t of [a1, a2]) { await t.p.evaluate(() => window.__tv.reload()); await t.p.waitForTimeout(800); }
    ok(await a1.p.isVisible('.quiet') && !(await a2.p.$('.quiet')), 'one device goes black, the other keeps playing');
    ok((await page.textContent('#status')).includes('Blacked out'), 'the status card shows which device is blacked out');
    await page.click(`#status [data-dark-tv="${id1}"]`); await toastSays(page, 'comes back on');
    await a1.p.evaluate(() => window.__tv.reload()); await a1.p.waitForFunction(() => !document.querySelector('.quiet'), null, { timeout: 5000 }).catch(() => {});
    ok(!(await a1.p.$('.quiet')), 'and comes back on');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'the device buttons fit on a phone');
    await ctx.close(); await a1.x.close(); await a2.x.close();
  }

  // Slide times of day, and back to normal on just one device
  console.log('\nSlide times and back to normal on one device');
  {
    ({ ctx, page } = await context({ width: 390, height: 844 }));
    await page.goto(BASE + '/tv/edit/index.html');
    await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
    await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
    await page.waitForSelector('#list [data-open]');
    const ts = (await db.query(`select id from tv_slides where display = 'tv' and not party and kind = 'text' and enabled order by position limit 1`)).rows[0].id;
    await page.click(`[data-open="${ts}"]`); await page.waitForSelector('#slTFrom');
    await page.fill('#slTFrom', '17:00'); await page.fill('#slTTo', '19:00');
    await page.click('#slDays [data-d="6"]'); await page.click('#slDays [data-d="0"]');
    await page.screenshot({ path: join(SHOTS, 'slide-times.png') });
    await page.click('#slSave'); await toastSays(page, 'Saved'); await page.waitForTimeout(500);
    const st = (await db.query(`select show_from::text f, show_to::text t, show_days d from tv_slides where id = $1`, [ts])).rows[0];
    ok(st.f === '17:00:00' && st.t === '19:00:00' && st.d.join() === '1,2,3,4,5', 'a slide can be set to come on at 5pm to 7pm, Mon to Fri');
    ok((await page.textContent(`#list [data-open="${ts}"]`)).includes('5pm to 7pm, Mon to Fri'), 'the list shows its times');
    await db.query(`update tv_slides set show_from = null, show_to = null, show_days = null where id = $1`, [ts]);

    // Staff code
    await page.reload(); await page.waitForSelector('#pinBox:not([hidden])');
    ok((await page.textContent('#pinHint')).includes('No code is set'), 'the staff code starts off');
    await page.fill('#setPin', '12'); await page.click('#pinSave');
    ok((await toastSays(page, '4 to 8 digits')).includes('4 to 8 digits'), 'a short code is refused');
    await page.fill('#setPin', '2468'); await page.click('#pinSave'); await toastSays(page, 'Staff code saved');
    ok((await page.textContent('#pinHint')).includes('A code is set'), 'the staff code is saved (and never shown again)');

    // Two screens, a party on
    const mk = async () => { const x = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      await x.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
      await x.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
      const p = await x.newPage(); await p.goto(BASE + `/tv/index.html?code=${CODE}`); await p.waitForSelector('.layer.on');
      await p.evaluate(() => window.__tv.checkIn()); await p.waitForTimeout(500); return { x, p }; };
    const b1 = await mk(), b2 = await mk();
    const id2 = await b2.p.evaluate(() => localStorage.getItem('tvScreen'));
    const ps = (await db.query(`insert into tv_slides (kind, title, theme, party, display) values ('text', 'Happy Birthday Noor!', 'party', true, 'tv') returning id`)).rows[0].id;
    await db.query(`update tv_settings set only_slide = $1, only_until = now() + interval '1 hour' where id = 1`, [ps]);
    for (const t of [b1, b2]) { await t.p.evaluate(() => window.__tv.reload()); await t.p.waitForFunction(() => (window.__tv.feed() || {}).only, null, { timeout: 5000 }).catch(() => {}); }
    ok((await b1.p.textContent('#stage')).includes('Noor') && (await b2.p.textContent('#stage')).includes('Noor'), 'both screens show the party');
    await b1.p.mouse.click(640, 360); await b1.p.waitForTimeout(300);
    ok(await b1.p.isHidden('#ovr'), 'a normal tap does nothing');
    await b1.p.mouse.move(12, 12); await b1.p.mouse.down(); await b1.p.waitForTimeout(3300); await b1.p.mouse.up();
    ok(await b1.p.isVisible('#ovr'), 'holding the top-left corner for 3 seconds asks for the staff code');
    await b1.p.click('#ovrCancel');
    // On a tablet: a long press in the corner doesn't select text or open a menu, and still opens the staff code
    const tp = await b1.p.evaluate(() => { const el = document.querySelector('#stage'); const t = new Touch({ identifier: 1, target: el, clientX: 15, clientY: 15 });
      const ev = new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true }); el.dispatchEvent(ev);
      const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); el.dispatchEvent(cm);
      return { start: ev.defaultPrevented, menu: cm.defaultPrevented, select: getComputedStyle(document.body).userSelect }; });
    await b1.p.waitForTimeout(3300);
    ok(tp.start && tp.menu && tp.select === 'none' && await b1.p.isVisible('#ovr'), 'a long press on a tablet opens the staff code without selecting text');
    for (const k of ['1', '1', '1', '1', 'OK']) await b1.p.click(`#ovrKeys [data-k="${k}"]`);
    await b1.p.waitForFunction(() => /not right/.test(document.querySelector('#ovrErr').textContent), null, { timeout: 5000 }).catch(() => {});
    ok((await b1.p.textContent('#ovrErr')).includes('not right'), 'a wrong code is refused');
    await b1.p.screenshot({ path: join(SHOTS, 'staff-code.png') });
    for (const k of ['2', '4', '6', '8', 'OK']) await b1.p.click(`#ovrKeys [data-k="${k}"]`);
    const onText = p => p.evaluate(() => (document.querySelector('.layer.on') || {}).textContent || '');
    await b1.p.waitForFunction(() => !/Noor/.test((document.querySelector('.layer.on') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    await b2.p.evaluate(() => window.__tv.reload()); await b2.p.waitForTimeout(800);
    ok(await b1.p.isHidden('#ovr') && !(await onText(b1.p)).includes('Noor') && (await onText(b2.p)).includes('Noor'), 'the right code puts just that screen back to normal; the other keeps the party');
    for (const t of [b1, b2]) { await t.p.evaluate(() => window.__tv.checkIn()); } await page.waitForTimeout(800);

    // The editor's button for one device
    await page.reload(); await page.waitForSelector(`#status [data-normal-tv="${id2}"]`, { timeout: 8000 }).catch(() => {});
    ok(await page.isVisible(`#status [data-normal-tv="${id2}"][data-on="1"]`) && (await page.textContent('#status')).includes('back to normal here'), 'the status card shows which screen is back to normal, with a button for the other');
    await page.locator('#status').screenshot({ path: join(SHOTS, 'device-normal.png') });
    await page.click(`#status [data-normal-tv="${id2}"]`); await toastSays(page, 'goes back to normal');
    await b2.p.evaluate(() => window.__tv.reload()); await b2.p.waitForFunction(() => !/Noor/.test((document.querySelector('.layer.on') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    ok(!(await onText(b2.p)).includes('Noor'), 'the editor button puts that screen back to normal');
    await db.query(`update tv_settings set only_slide = null, only_until = null where id = 1`);
    await db.query(`delete from tv_slides where id = $1`, [ps]);
    await db.query(`update tv_screens set override_at = null, override_until = null`);
    await db.query(`update tv_staff_code set code_hash = null`);
    await ctx.close(); await b1.x.close(); await b2.x.close();
  }

  // Delete removes the file
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#list [data-open]');
  const photo = (await slides()).find(s => s.kind === 'photo');
  const pid = (await db.query(`select id from tv_slides where media_path = $1`, [photo.media_path])).rows[0].id;
  await page.click(`[data-open="${pid}"]`); await page.waitForSelector('#slDel'); await page.click('#slDel'); await page.click('#cfYes');
  await toastSays(page, 'Deleted'); await page.waitForTimeout(400);
  ok(!(await slides()).some(s => s.media_path === photo.media_path) && !files.has(photo.media_path), 'deleting a photo slide removes the photo too');
  await page.click('#signOut'); await page.waitForSelector('#signIn:not([hidden])');
  await page.click('.hub-signin #hubBack', { timeout: 4000 }).catch(() => {});
  await page.fill('#siEmail', 'jo@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#problem:not([hidden])');
  ok((await page.textContent('#problem')).includes("doesn't have TV access"), 'someone without TV access cannot edit the TV');
  await db.query(`insert into tv_permissions values ('jo@ama.test', 'remote')`);
  await page.click('#retry'); await page.waitForSelector('#problem a[href="../remote/"]', { timeout: 5000 }).catch(() => {});
  ok((await page.textContent('#problem')).includes('can use the TV remote, but not the editor'), 'someone with the remote only is sent to the remote');
  await page.goto(BASE + '/tv/remote/index.html'); await page.waitForSelector('#app:not([hidden]), #problem:not([hidden])');
  ok(await page.isVisible('#app') && (await page.$$('#list [data-show]')).length > 0, '...and the remote works for them');
  await db.query(`insert into tv_permissions values ('jo@ama.test', 'party')`);
  await page.goto(BASE + '/tv/edit/index.html'); await page.waitForSelector('#app:not([hidden]), #problem:not([hidden])');
  ok(await page.isVisible('#partyStart') && await page.isHidden('#list') && await page.isHidden('#setForm') && await page.isHidden('#addBtn') && (await page.textContent('#partyOnly')).includes('party mode'),
    'party mode only: the editor shows just Party mode');
  ok(await page.isVisible('#partyOnly a[href="../remote/"]'), '...with a link to the remote if they have that too');
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  ok(!(await page.$('#pManage')) && !(await page.$('#pImport')), "...and can't manage poster templates");
  if (await page.$('#pForm [data-m="message"]')) await page.click('#pForm [data-m="message"]');
  await page.waitForSelector('#pName'); await page.fill('#pName', 'Mia'); await page.click('#pGo');
  await page.waitForSelector('#partyStop', { timeout: 8000 }).catch(() => {});
  const jp = (await db.query(`select s.title from party_now t join tv_slides s on s.id = t.only_slide where t.id = 1`)).rows[0];
  ok(jp && jp.title === 'Happy Birthday Mia!', '...and can put a birthday message on the TV');
  await page.screenshot({ path: join(SHOTS, 'tv-party-only.png') });
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');
  ok(!(await db.query(`select only_slide from party_now where id = 1`)).rows[0].only_slide, '...and stop it');
  // Slides vs screens: a login can manage slide content, the device/settings, or both.
  await db.query(`delete from tv_permissions where email = 'jo@ama.test'`);
  await db.query(`insert into tv_permissions values ('jo@ama.test', 'slides')`);
  await page.goto(BASE + '/tv/edit/index.html'); await page.waitForSelector('#app:not([hidden]), #problem:not([hidden])');
  ok(await page.isVisible('#app') && await page.isVisible('#addBtn') && await page.isHidden('#setForm') && await page.isHidden('#remoteBtn'),
    'slides only: the editor shows the slide list but not Settings or the remote');
  await db.query(`delete from tv_permissions where email = 'jo@ama.test'`);
  await db.query(`insert into tv_permissions values ('jo@ama.test', 'screens')`);
  await page.goto(BASE + '/tv/edit/index.html'); await page.waitForSelector('#app:not([hidden]), #problem:not([hidden])');
  ok(await page.isVisible('#app') && await page.isVisible('#setForm') && await page.isHidden('#addBtn') && await page.isHidden('#list') && await page.isVisible('#remoteBtn'),
    'screens only: the editor shows Settings and the remote but not slide editing');
  await page.goto(BASE + '/tv/remote/index.html'); await page.waitForSelector('#app:not([hidden]), #problem:not([hidden])');
  ok(await page.isVisible('#app'), '...and screens access carries the remote');
  await db.query(`delete from tv_permissions where email = 'jo@ama.test'`);
  await db.query(`insert into tv_permissions values ('jo@ama.test', 'remote')`);
  await page.goto(BASE + '/tv/remote/index.html');
  await db.query(`delete from tv_permissions where email = 'jo@ama.test'`);
  await page.reload(); await page.waitForSelector('#problem:not([hidden])');
  ok((await page.textContent('#problem')).includes("doesn't have the TV remote"), 'without TV access, the remote says so');
  await ctx.close();

  ok(errors.length === 0, 'no errors in the browser console' + (errors.length ? ': ' + errors.slice(0, 3).join(' / ') : ''));
} catch (e) {
  ok(false, 'stopped: ' + e.message.split('\n').slice(0, 3).join(' / ')); console.log(errors.slice(0, 5).join('\n'));
}
await browser.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

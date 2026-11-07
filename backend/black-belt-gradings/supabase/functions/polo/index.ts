// @ts-nocheck
// Black Belt Prep: the year's black belt polo (the back has everyone who passed Probationary Black Belt or a Dan that
// year). A family opens their personal link (polo/#t=<secret>), picks the size and how many, and pays by card through Stripe Checkout. Stripe tells this function when the
// payment goes through and the order is marked paid with its size. Nobody signs in; the secret finds the order.
//
// Deploy in Supabase: Edge Functions > Deploy a new function > Via Editor, name it "polo", paste this whole file,
// Deploy, then turn OFF "Verify JWT" for it (families and Stripe call it without a Supabase login).
// Secrets (Edge Functions > Secrets):
//   STRIPE_SECRET_KEY      Stripe > Developers > API keys > Secret key (sk_live_... or sk_test_... to try it out)
//   STRIPE_WEBHOOK_SECRET  Stripe > Developers > Webhooks > your endpoint > Signing secret (whsec_...)
//   POLO_SITE              optional: the family page address, if not https://theggatonklenner.github.io/Black-belt-prep-system/polo/
// Stripe webhook endpoint: https://<project>.supabase.co/functions/v1/polo, event checkout.session.completed
// (and checkout.session.async_payment_succeeded). Without the webhook, a payment is still picked up when the
// family comes back to the page; the webhook catches anyone who closes the page straight after paying.
//
// Requests (POST JSON):
//   { action: 'info', token }                                  the order on a family's link
//   { action: 'checkout', token, size, qty }                   save the choice and get the Stripe payment page
//   Stripe's webhook (has a Stripe-Signature header)

const STRIPE = 'https://api.stripe.com/v1';
const SITE = 'https://theggatonklenner.github.io/Black-belt-prep-system/polo/';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (msg, status = 400) => json({ ok: false, error: msg }, status);
const tokenOk = t => /^[a-f0-9]{48,72}$/.test(String(t || ''));
const OPEN = ['invited', 'pending'];

// Stripe's form encoding, with nested keys: { a: { b: 1 } } -> a[b]=1
function form(obj, pre = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = pre ? `${pre}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
// Stripe-Signature: t=<time>,v1=<HMAC-SHA256 of "<time>.<body>"> (within 5 minutes)
export async function signatureOk(body, header, secret, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header).split(',').map(p => p.trim()).filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)));
  return sigs.some(s => s.length === want.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ want.charCodeAt(i)), 0) === 0);
}

export async function handle(req, db, env = {}, http = fetch) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  const stripe = async (path, opts = {}) => {
    const r = await http(STRIPE + path, { ...opts, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || `Stripe said ${r.status}`);
    return j;
  };
  // A paid Stripe Checkout session: mark its order paid (once)
  const markPaid = async s => {
    if (!s || s.payment_status !== 'paid') return false;
    const id = (s.metadata && s.metadata.order_id) || s.client_reference_id;
    if (!id) return false;
    const { data: o } = await db.from('prep_polo_orders').select('order_id, status').eq('order_id', id).maybeSingle();
    if (!o) return false;
    if (!OPEN.includes(o.status)) return true;   // already marked
    const { error } = await db.from('prep_polo_orders').update({ status: 'paid', paid_at: new Date().toISOString(), paid_how: 'stripe', amount: (s.amount_total || 0) / 100,
      stripe_session: s.id, stripe_payment: typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || s.id }).eq('order_id', id);
    if (error) throw error;
    return true;
  };

  try {
    const raw = await req.text();
    // ---- Stripe's webhook ----
    const sig = req.headers.get('stripe-signature');
    if (sig) {
      if (!await signatureOk(raw, sig, env.STRIPE_WEBHOOK_SECRET)) return fail('Bad signature.', 400);
      const ev = JSON.parse(raw);
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev.type)) await markPaid(ev.data && ev.data.object);
      return json({ received: true });
    }

    // ---- Families ----
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) { /* not JSON */ }
    if (!tokenOk(body.token)) return fail('This link isn\'t right. Ask your instructor for a new one.', 404);
    const { data: o } = await db.from('prep_polo_orders').select('order_id, student_id, year, rank, size, qty, price, amount, status, stripe_session, stripe_payment, paid_at, paid_how').eq('token', body.token).maybeSingle();
    if (!o || o.status === 'cancelled') return fail('This link isn\'t right. Ask your instructor for a new one.', 404);
    const { data: st } = await db.from('prep_polo_settings').select('price, sizes, is_open, note').eq('id', 1).maybeSingle();
    const { data: s } = await db.from('prep_students').select('full_name, contact_email').eq('student_id', o.student_id).maybeSingle();
    const price = st ? Number(st.price) : null;
    const info = () => ({ ok: true, first: String((s && s.full_name) || '').trim().split(/\s+/)[0] || '', year: o.year, rank: o.rank, size: o.size, qty: o.qty,
      status: o.status, price: OPEN.includes(o.status) ? price : Number(o.price ?? price), amount: o.amount != null ? Number(o.amount) : null,
      sizes: (st && st.sizes) || [], open: !!(st && st.is_open), note: (st && st.note) || null, card: !!env.STRIPE_SECRET_KEY, paid_how: o.paid_how || null, receipt: o.receipt || null });

    if (body.action === 'info') {
      // Back from Stripe (or the webhook hasn't come yet): ask Stripe whether it was paid
      if (o.status === 'pending' && o.stripe_session && env.STRIPE_SECRET_KEY) {
        try { const sess = await stripe('/checkout/sessions/' + encodeURIComponent(o.stripe_session), { method: 'GET' });
          if (await markPaid(sess)) { o.status = 'paid'; o.paid_how = 'stripe'; o.amount = (sess.amount_total || 0) / 100; o.stripe_payment = typeof sess.payment_intent === 'string' ? sess.payment_intent : (sess.payment_intent && sess.payment_intent.id) || null; } } catch (e) { console.error(e); }
      }
      // Paid by card: Stripe's receipt (from the payment's charge)
      if (!OPEN.includes(o.status) && env.STRIPE_SECRET_KEY && String(o.stripe_payment || '').startsWith('pi_')) {
        try { const pi = await stripe('/payment_intents/' + encodeURIComponent(o.stripe_payment) + '?expand[]=latest_charge', { method: 'GET' }); o.receipt = (pi.latest_charge && pi.latest_charge.receipt_url) || null; } catch (e) { console.error(e); }
      }
      return json(info());
    }

    if (body.action !== 'checkout') return fail('Unknown action.');
    if (!OPEN.includes(o.status)) return json({ ...info(), ok: false, error: 'This polo is already paid for.' });
    if (!st || !st.is_open) return json({ ...info(), ok: false, error: 'Polo orders are closed at the moment. Please ask at the front desk.' });
    const size = String(body.size || ''), qty = Number(body.qty || 1);
    if (!(st.sizes || []).includes(size)) return fail('Choose a size.');
    if (!Number.isInteger(qty) || qty < 1 || qty > 5) return fail('Choose how many (1 to 5).');
    if (!(price > 0)) return fail('The polo price isn\'t set yet. Please ask at the front desk.');
    if (!env.STRIPE_SECRET_KEY) return fail('Card payments aren\'t set up yet. Please ask at the front desk.', 409);

    const { error: ue } = await db.from('prep_polo_orders').update({ size, qty, price, status: 'pending' }).eq('order_id', o.order_id);
    if (ue) throw ue;
    const site = env.POLO_SITE || SITE;
    const email = s && s.contact_email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.contact_email) ? s.contact_email : null;
    const sess = await stripe('/checkout/sessions', { method: 'POST', body: form({
      mode: 'payment', client_reference_id: o.order_id, metadata: { order_id: o.order_id, student_id: o.student_id, year: o.year, size },
      payment_intent_data: { metadata: { order_id: o.order_id, student_id: o.student_id }, description: `AMA ${o.year} black belt polo x${qty} (${size})`, ...(email ? { receipt_email: email } : {}) },
      line_items: { 0: { quantity: qty, price_data: { currency: 'aud', unit_amount: Math.round(price * 100), product_data: { name: `AMA ${o.year} black belt polo`, description: `Size ${size}` } } } },
      ...(email ? { customer_email: email } : {}),
      success_url: `${site}?paid=1#t=${body.token}`, cancel_url: `${site}#t=${body.token}` }) });
    await db.from('prep_polo_orders').update({ stripe_session: sess.id }).eq('order_id', o.order_id);
    return json({ ok: true, url: sess.url });
  } catch (e) {
    console.error(e);
    return fail('Something went wrong: ' + String(e && e.message || e), 500);
  }
}

if (typeof Deno !== 'undefined') {
  const { createClient } = await import('npm:@supabase/supabase-js@2.45.4');
  const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const env = { STRIPE_SECRET_KEY: Deno.env.get('STRIPE_SECRET_KEY'), STRIPE_WEBHOOK_SECRET: Deno.env.get('STRIPE_WEBHOOK_SECRET'), POLO_SITE: Deno.env.get('POLO_SITE') };
  Deno.serve(req => handle(req, db, env));
}

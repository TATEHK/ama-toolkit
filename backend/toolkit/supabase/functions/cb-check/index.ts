// @ts-nocheck
// AMA Toolkit: check what GoHighLevel actually did with texts the "cb" function logged as sent.
// GoHighLevel accepts a text and can fail it afterwards (e.g. the daily SMS limit), so cb_messages can say "sent" for a text
// that never went. { since, offset?, limit? } + x-cb-cron header: for each text logged since then, finds the family's
// conversation in GoHighLevel and saves the real status of the matching outbound SMS to cb_ghl_check.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
const API = 'https://services.leadconnectorhq.com';
Deno.serve(async req => {
  const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const { data: ok } = await db.rpc('cb_cron_ok', { p_secret: req.headers.get('x-cb-cron') || '' });
  if (ok !== true) return new Response('Not allowed', { status: 403 });
  const TOKEN = Deno.env.get('GHL_TOKEN'), LOC = Deno.env.get('GHL_LOCATION_ID');
  const ghl = async (path, version = '2021-07-28') => {
    const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + TOKEN, Version: version, Accept: 'application/json' } });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message ? [].concat(j.message).join(', ') : 'GHL ' + r.status); return j;
  };
  const { data: rows } = await db.from('cb_messages').select('message_id, phone, body, sent_at, sent_by').eq('status', 'sent').not('phone', 'is', null)
    .gte('sent_at', body.since).order('sent_at').range(body.offset || 0, (body.offset || 0) + (body.limit || 40) - 1);
  let done = 0;
  for (const m of rows || []) {
    let status = null, err = null;
    try {
      const c = await ghl(`/contacts/search/duplicate?locationId=${encodeURIComponent(LOC)}&number=${encodeURIComponent(m.phone)}`);
      const cid = c.contact && c.contact.id; if (!cid) throw new Error('no contact');
      const cs = await ghl(`/conversations/search?locationId=${encodeURIComponent(LOC)}&contactId=${cid}`, '2021-04-15');
      const conv = (cs.conversations || [])[0]; if (!conv) throw new Error('no conversation');
      const ms = await ghl(`/conversations/${conv.id}/messages?limit=20`, '2021-04-15');
      const list = (ms.messages && ms.messages.messages) || ms.messages || [];
      const start = String(m.body || '').slice(0, 40);
      const hit = list.filter(x => x.direction === 'outbound' && String(x.body || '').slice(0, 40) === start)
        .sort((a, b) => Math.abs(Date.parse(a.dateAdded) - Date.parse(m.sent_at)) - Math.abs(Date.parse(b.dateAdded) - Date.parse(m.sent_at)))[0];
      if (!hit) throw new Error('message not found');
      status = hit.status || 'unknown'; err = hit.meta && hit.meta.error ? JSON.stringify(hit.meta.error).slice(0, 300) : (hit.error ? String(hit.error).slice(0, 300) : null);
    } catch (e) { err = String(e.message || e).slice(0, 300); }
    await db.from('cb_ghl_check').upsert({ message_id: m.message_id, ghl_status: status, ghl_error: err, checked_at: new Date().toISOString() });
    done++;
  }
  return new Response(JSON.stringify({ ok: true, done }), { headers: { 'Content-Type': 'application/json' } });
});

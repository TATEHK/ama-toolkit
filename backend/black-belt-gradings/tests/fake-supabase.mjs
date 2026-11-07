// A small local stand-in for Supabase, for browser tests only.
// It answers the sign-in and REST requests the app makes, and runs them against a real
// Postgres (PGlite) holding the card software's tables plus prep-setup.sql, as the signed-in
// user, so the real security rules and calculations are exercised.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = s => JSON.parse(Buffer.from(s, 'base64url').toString());
const ident = s => { if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw Object.assign(new Error('bad identifier ' + s), { status: 400 }); return `"${s}"`; };
const pgArray = a => '{' + a.map(v => v == null ? 'NULL' : '"' + String(v).replace(/(["\\])/g, '\\$1') + '"').join(',') + '}';

export function startServer({ db, port = 0, appDir, users, config, maxRows = 0 }) {   // maxRows: like Supabase's 1,000-row cap per request (0: no cap)
  let queue = Promise.resolve();
  const serial = fn => (queue = queue.then(fn, fn));

  const token = email => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: users[email].id, email, role: 'authenticated', aud: 'authenticated', exp })}.x`;
  };
  const sessionFor = email => ({
    access_token: token(email), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'refresh-' + Buffer.from(email).toString('base64url'),
    user: { id: users[email].id, aud: 'authenticated', role: 'authenticated', email, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() }
  });
  const claimsOf = req => {
    const h = req.headers.authorization || '';
    const t = h.replace(/^Bearer /, '');
    try { const p = unb64(t.split('.')[1]); return p.email ? p : null; } catch { return null; }
  };

  async function asUser(claims, fn) {
    return db.transaction(async tx => {
      await tx.exec(`set local role ${claims ? 'authenticated' : 'anon'}`);
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims || {})]);
      return fn(tx);
    });
  }

  function filters(params, table, startIdx) {
    const where = [], vals = [];
    let order = '', lim = null, off = null;
    for (const [k, v] of params) {
      if (k === 'select' || k === 'columns' || k === 'on_conflict') continue;
      if (k === 'order') {
        order = ' order by ' + v.split(',').map(p => { const [c, dir, nulls] = p.split('.'); return `t.${ident(c)} ${dir === 'desc' ? 'desc' : 'asc'}${nulls === 'nullsfirst' ? ' nulls first' : nulls === 'nullslast' ? ' nulls last' : ''}`; }).join(', ');
        continue;
      }
      if (k === 'limit') { lim = parseInt(v, 10); continue; }
      if (k === 'offset') { off = parseInt(v, 10); continue; }
      const m = v.match(/^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.*)$/s);
      if (!m) throw Object.assign(new Error('unsupported filter ' + k + '=' + v), { status: 400 });
      const [, not, op, raw] = m, col = `t.${ident(k)}`;
      let expr;
      if (op === 'is') expr = `${col} is ${raw === 'null' ? 'null' : raw === 'true' ? 'true' : 'false'}`;
      else if (op === 'in') {
        const items = raw.replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, ''));
        vals.push(pgArray(items)); expr = `${col} = any($${startIdx + vals.length})`;
      } else {
        vals.push(raw);
        const sym = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' }[op];
        expr = `${col} ${sym} $${startIdx + vals.length}`;
      }
      where.push(not ? `not (${expr})` : expr);
    }
    if (maxRows && (lim == null || lim > maxRows)) lim = maxRows;
    const limit = (lim != null ? ` limit ${lim}` : '') + (off != null ? ` offset ${off}` : '');
    return { where: where.length ? ' where ' + where.join(' and ') : '', vals, order, limit };
  }

  async function rest(req, url, body, claims) {
    const parts = url.pathname.replace(/^\/rest\/v1\//, '').split('/');
    const prefer = req.headers.prefer || '';
    const wantRows = /return=representation/.test(prefer);
    if (parts[0] === 'rpc') {
      const fn = parts[1];
      return asUser(claims, async tx => {
        const meta = (await tx.query(`select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types,
            p.proretset as retset, format_type(p.prorettype, null) as rettype
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn])).rows[0];
        if (!meta) throw Object.assign(new Error(`Could not find the function public.${fn} in the schema cache`), { status: 404, code: 'PGRST202' });
        const args = [], vals = [];
        for (const [k, v] of Object.entries(body || {})) {
          const i = (meta.names || []).indexOf(k);
          if (i < 0) throw Object.assign(new Error(`unknown argument ${k}`), { status: 400 });
          vals.push(Array.isArray(v) && !/^jsonb?$/.test(meta.types[i]) ? pgArray(v) : v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
          args.push(`${ident(k)} => $${vals.length}::${meta.types[i]}`);
        }
        const call = `public.${ident(fn)}(${args.join(', ')})`;
        if (meta.retset) return { status: 200, json: (await tx.query(`select coalesce(json_agg(x), '[]'::json) as j from ${call} x`, vals)).rows[0].j };
        const r = (await tx.query(`select to_json(${call}) as j`, vals)).rows[0].j;
        return { status: 200, json: meta.rettype === 'void' ? null : r };
      });
    }
    const table = `public.${ident(parts[0])}`;
    const params = [...url.searchParams.entries()];
    const sel = url.searchParams.get('select') || '*';
    const cols = sel === '*' ? 't.*' : sel.split(',').map(c => `t.${ident(c.trim())}`).join(', ');
    return asUser(claims, async tx => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const f = filters(params, table, 0);
        const q = `select coalesce(json_agg(x), '[]'::json) as j from (select ${cols} from ${table} t${f.where}${f.order}${f.limit}) x`;
        return { status: 200, json: (await tx.query(q, f.vals)).rows[0].j };
      }
      if (req.method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];
        const out = [];
        // Upsert (Prefer: resolution=merge-duplicates): on the on_conflict columns, or the primary key
        let conflict = '';
        if (/resolution=(merge|ignore)-duplicates/.test(prefer)) {
          let cols = url.searchParams.get('on_conflict');
          if (!cols) cols = (await tx.query(`select string_agg(a.attname, ',' order by a.attnum) c from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = $1::regclass and i.indisprimary`, [table])).rows[0].c;
          conflict = cols ? { cols: cols.split(',').map(c => ident(c.trim())), ignore: /ignore-duplicates/.test(prefer) } : '';
        }
        for (const r of rows) {
          const keys = Object.keys(r);
          const onc = conflict ? ` on conflict (${conflict.cols.join(', ')}) do ${conflict.ignore || !keys.length ? 'nothing' : 'update set ' + keys.map(k => `${ident(k)} = excluded.${ident(k)}`).join(', ')}` : '';
          const q = keys.length
            ? `insert into ${table} as t (${keys.map(ident).join(', ')}) select ${keys.map(k => 'r.' + ident(k)).join(', ')} from json_populate_record(null::${table}, $1::json) r${onc} returning to_json(t) as j`
            : `insert into ${table} as t default values returning to_json(t) as j`;
          const got = (await tx.query(q, keys.length ? [JSON.stringify(r)] : [])).rows[0];
          if (got) out.push(got.j);
        }
        return wantRows ? { status: 201, json: out } : { status: 201, json: null };
      }
      if (req.method === 'PATCH') {
        const keys = Object.keys(body || {});
        const f = filters(params, table, 1);
        const q = `update ${table} as t set ${keys.map(k => `${ident(k)} = r.${ident(k)}`).join(', ')} from json_populate_record(null::${table}, $1::json) r${f.where} returning to_json(t) as j`;
        const res = (await tx.query(q, [JSON.stringify(body), ...f.vals])).rows.map(x => x.j);
        return wantRows ? { status: 200, json: res } : { status: 204, json: null };
      }
      if (req.method === 'DELETE') {
        const f = filters(params, table, 0);
        const res = (await tx.query(`delete from ${table} as t${f.where} returning to_json(t) as j`, f.vals)).rows.map(x => x.j);
        return wantRows ? { status: 200, json: res } : { status: 204, json: null };
      }
      throw Object.assign(new Error('method not supported'), { status: 405 });
    });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    const send = (status, json, headers = {}) => {
      res.writeHead(status, { ...cors, ...(json === null ? {} : { 'content-type': 'application/json' }), ...headers });
      res.end(json === null ? '' : JSON.stringify(json));
    };
    if (req.method === 'OPTIONS') return send(204, null);
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => serial(async () => {
      const body = raw ? JSON.parse(raw) : null;
      try {
        if (url.pathname === '/auth/v1/token') {
          const g = url.searchParams.get('grant_type');
          let email;
          if (g === 'password') {
            email = (body.email || '').toLowerCase();
            if (!users[email] || users[email].password !== body.password) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 400 });
          } else email = Buffer.from(String(body.refresh_token).replace('refresh-', ''), 'base64url').toString();
          return send(200, sessionFor(email));
        }
        if (url.pathname === '/auth/v1/user') { const c = claimsOf(req); return c ? send(200, sessionFor(c.email).user) : send(401, { msg: 'no user' }); }
        if (url.pathname === '/auth/v1/logout') return send(204, null);
        if (url.pathname.startsWith('/rest/v1/')) {
          const r = await rest(req, url, body, claimsOf(req));
          return send(r.status, r.json);
        }
        if (url.pathname === '/config.js') { res.writeHead(200, { ...cors, 'content-type': 'text/javascript' }); return res.end(config); }
        // Static app files
        let file = join(appDir, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');   // a folder: its index.html
        if (!file.startsWith(appDir) || !existsSync(file)) { res.writeHead(404, cors); return res.end(); }
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
        res.writeHead(200, { ...cors, 'content-type': types[extname(file)] || 'application/octet-stream' });
        res.end(readFileSync(file));
      } catch (e) {
        const status = e.status || (e.code === '42501' ? 403 : e.code === '23505' || e.code === '23503' ? 409 : 400);
        send(status, { message: e.message, code: e.code || null, details: e.detail || null, hint: e.hint || null });
      }
    }));
  });
  // Direct database access for test checks, queued behind in-flight requests
  server.q = (sql, params = []) => serial(() => db.query(sql, params)).then(r => r.rows);
  return new Promise(r => server.listen(port, () => r(server)));
}

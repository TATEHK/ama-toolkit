// In-memory stand-in for the parts of Supabase the staff function uses.
export function makeDb() {
  const t = { staff_roles: [], staff_permissions: [], prep_roles: [], app_permissions: [], push_subscriptions: [], tv_permissions: [], hub_logins: [], toolkit_owners: [], staff_admins: [], toolkit_audit: [] };
  const opts = { permissionsMissing: false, tvMissing: false };
  const users = []; let nextId = 1;
  const tokens = new Map();
  function query(table) {
    let rows = () => t[table] || [], filters = [], op = 'select', payload = null, single = false, head = false;
    const q = {
      select(_c, o) { if (o && o.head) head = true; return q; },
      eq(c, v) { filters.push(r => r[c] === v); return q; },
      in(c, vs) { filters.push(r => vs.includes(r[c])); return q; },
      maybeSingle() { single = true; return q; },
      limit() { return q; },
      order() { return q; },
      insert(p) { op = 'insert'; payload = { rows: Array.isArray(p) ? p : [p] }; return q; },
      upsert(p, opts = {}) { op = 'upsert'; payload = { rows: Array.isArray(p) ? p : [p], opts }; return q; },
      delete() { op = 'delete'; return q; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); }
    };
    function run() {
      if (table === 'hub_logins' && opts.hubMissing) return { data: null, error: { message: 'relation "public.hub_logins" does not exist' } };
      if (table === 'tv_permissions' && opts.tvMissing) return { data: null, error: { message: 'relation "public.tv_permissions" does not exist' } };
      if (table === 'staff_permissions' && opts.permissionsMissing) return { data: null, error: { message: 'relation "public.staff_permissions" does not exist' } };
      const match = r => filters.every(f => f(r));
      if (op === 'select') { const d = rows().filter(match); if (head) return { count: d.length, data: null, error: null }; return { data: single ? d[0] || null : d, error: null }; }
      if (op === 'insert') { for (const r of payload.rows) t[table].push({ ...r }); return { data: null, error: null }; }
      if (op === 'upsert') {
        for (const r of payload.rows) {
          if (table === 'staff_roles') { const i = t.staff_roles.findIndex(x => x.email === r.email); i >= 0 ? (t.staff_roles[i] = { ...r }) : t.staff_roles.push({ ...r }); }
          if (table === 'prep_roles') { if (!t.prep_roles.some(x => x.email === r.email && x.role === r.role)) t.prep_roles.push({ ...r }); }
          if (table === 'app_permissions') { if (!t.app_permissions.some(x => x.email === r.email && x.app === r.app && x.perm === r.perm)) t.app_permissions.push({ ...r }); }
          if (table === 'tv_permissions') { if (!t.tv_permissions.some(x => x.email === r.email && x.permission === r.permission)) t.tv_permissions.push({ ...r }); }
          if (table === 'hub_logins') {
            if (t.hub_logins.some(x => x.mobile9 === r.mobile9 && x.email !== r.email)) return { data: null, error: { message: 'duplicate key value violates unique constraint "hub_logins_mobile9_key"' } };
            const i = t.hub_logins.findIndex(x => x.email === r.email); i >= 0 ? (t.hub_logins[i] = { ...r }) : t.hub_logins.push({ ...r });
          }
          if (table === 'staff_permissions') { if (!t.staff_permissions.some(x => x.email === r.email && x.permission === r.permission)) t.staff_permissions.push({ ...r }); }
          if (table === 'staff_admins') { const i = t.staff_admins.findIndex(x => x.email === r.email); i >= 0 ? (t.staff_admins[i] = { ...r }) : t.staff_admins.push({ ...r }); }
        }
        return { data: null, error: null };
      }
      if (op === 'delete') {
        const gone = t[table].filter(match);
        const adminCol = { prep_roles: 'role', staff_permissions: 'permission' }[table];
        if (adminCol && gone.some(r => r[adminCol] === 'admin') && !t[table].some(r => r[adminCol] === 'admin' && !gone.includes(r)))
          return { data: null, error: { message: 'There must always be at least one admin.' } };
        t[table] = t[table].filter(r => !match(r));
        return { data: null, error: null };
      }
    }
    return q;
  }
  const mail = [];
  const db = {
    from: query,
    rpc: async (name, args = {}) => {
      if (name === 'force_signout') { const u = users.find(x => (x.email || '').toLowerCase() === String(args.p_email || '').toLowerCase()); return { data: u ? 1 : 0, error: null }; }
      return { data: null, error: null };
    },
    auth: {
      async getUser(token) { const u = users.find(x => x.id === tokens.get(token)); return { data: { user: u || null } }; },
      admin: {
        async listUsers({ page, perPage }) { return { data: { users: users.slice((page - 1) * perPage, page * perPage) }, error: null }; },
        async createUser({ email, password, user_metadata }) {
          if (users.some(u => u.email === email)) return { error: { message: 'A user with this email address has already been registered' } };
          const u = { id: 'u' + nextId++, email, password, created_at: new Date().toISOString(), user_metadata: { ...(user_metadata || {}) } }; users.push(u);
          return { data: { user: u }, error: null };
        },
        async generateLink({ type, email, options = {} }) {
          if (opts.linkFails) return { data: null, error: { message: 'Link service unavailable' } };
          let u = users.find(x => x.email === email);
          if (type === 'invite') {
            if (u) return { data: null, error: { message: 'A user with this email address has already been registered' } };
            u = { id: 'u' + nextId++, email, password: null, created_at: new Date().toISOString(), user_metadata: options.data || {} }; users.push(u);
          } else if (!u) return { data: null, error: { message: 'User not found' } };
          const hashed_token = 'hash-' + type + '-' + u.id + '-' + nextId++;
          mail.push({ kind: type, email, data: options.data, hashed_token });
          return { data: { user: u, properties: { hashed_token, action_link: 'https://x.test/verify' } }, error: null };
        },
        async updateUserById(id, { password, user_metadata }) { const u = users.find(x => x.id === id); if (!u) return { error: { message: 'User not found' } };
          if (password !== undefined) u.password = password; if (user_metadata) u.user_metadata = { ...(u.user_metadata || {}), ...user_metadata }; return { data: { user: u }, error: null }; },
        async deleteUser(id) { const i = users.findIndex(x => x.id === id); users.splice(i, 1); return { error: null }; }
      }
    },
    _t: t, _users: users, _opts: opts, _mail: mail,
    _login(email) { const u = users.find(x => x.email === email); const tok = 'tok-' + u.id; tokens.set(tok, u.id); return tok; }
  };
  return db;
}


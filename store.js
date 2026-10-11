'use strict';
// Storage layer. server.js only talks to the small interface below, so the
// backend can be swapped without touching any route code:
//   findUserByEmail, findUserById, createUser, updateUser, deleteUser, getState, putState
//
//  - supabaseStore: production. Talks to Supabase PostgreSQL over its REST API
//    using the SERVER-ONLY service-role key. The browser never sees this key.
//  - fileStore: local development only. Writes JSON files and is NOT suitable for
//    hosting platforms whose disk is wiped on restart.
const fs = require('fs'), path = require('path');

class DuplicateError extends Error { constructor() { super('duplicate'); this.code = 'DUPLICATE'; } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const needId = id => { if (!UUID.test(String(id))) throw new Error('Invalid id'); return id; };
const withDefaults = u => u && ({ prefs: { notify: false }, plans: [], sessionVersion: 0, resetHash: null, resetExp: 0, resetAttempts: 0, googleId: null, ...u });

function fileStore(dir) {
  const usersFile = path.join(dir, 'auth-users.json'), stateFile = path.join(dir, 'local-state.json');
  // A corrupt file throws instead of silently returning [] so a later write can never wipe real accounts.
  const read = (f, d) => { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return v == null ? d : v; } catch (e) { if (e.code === 'ENOENT') return d; throw e; } };
  const write = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(t, f); };
  const users = () => { const v = read(usersFile, []); return Array.isArray(v) ? v : []; };
  return {
    kind: 'file',
    async findUserByEmail(email) { return withDefaults(users().find(u => u.email === email) || null); },
    async findUserById(id) { return withDefaults(users().find(u => u.id === id) || null); },
    async findUserByGoogleId(googleId) { return withDefaults(users().find(u => u.googleId === googleId) || null); },
    async createUser(user) { const a = users(); if (a.some(u => u.email === user.email)) throw new DuplicateError(); a.push(user); write(usersFile, a); return withDefaults(user); },
    async updateUser(id, patch) { const a = users(), i = a.findIndex(u => u.id === id); if (i < 0) return null; a[i] = { ...a[i], ...patch }; write(usersFile, a); return withDefaults(a[i]); },
    async deleteUser(id) { write(usersFile, users().filter(u => u.id !== id)); const s = read(stateFile, {}); delete s[id]; write(stateFile, s); },
    async getState(id) { return read(stateFile, {})[id] || null; },
    async putState(id, state) { const s = read(stateFile, {}), updatedAt = new Date().toISOString(); s[id] = { state, updatedAt }; write(stateFile, s); return updatedAt; }
  };
}


// Accepts the Project URL exactly as Supabase shows it. Tolerates quotes, trailing slashes and an accidental "/rest/v1".
// Rejects dashboard links and the placeholder from .env.example with a clear message instead of a confusing 404 later.
function normalizeSupabaseUrl(raw) {
  const u = String(raw || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '').replace(/\/rest\/v1$/i, '').replace(/\/+$/, '');
  let p; try { p = new URL(u); } catch (e) { throw new Error('SUPABASE_URL is not a valid web address. Use the Project URL from Supabase, for example https://abcdefghijkl.supabase.co'); }
  if (/your-project-ref/i.test(u)) throw new Error('SUPABASE_URL is still the placeholder from .env.example. Paste your real Project URL (Supabase -> Project Settings -> API).');
  if (p.pathname !== '/') throw new Error('SUPABASE_URL must be only the project address, like https://abcdefghijkl.supabase.co (no /dashboard/... or other path).');
  return p.origin;
}
// Plain-English next step for each kind of Supabase failure.
function supabaseHint(e, table) {
  if (e.status === 0) return 'The server cannot reach Supabase. Check the spelling of SUPABASE_URL and your internet connection.';
  if (e.status === 404 && e.pg === 'PGRST205') return 'Table public.' + table + ' is not visible to the API. Run supabase/migrations/001_init.sql and then 002_service_role_grants.sql in the SQL Editor of the SAME Supabase project that SUPABASE_URL points to.';
  if (e.status === 404) return 'Supabase did not recognise this address (no database error came back). Check SUPABASE_URL for typos, and that the project is not paused or deleted.';
  if (e.status === 401 || e.pg === 'PGRST301' || e.pg === 'PGRST302') return 'Supabase rejected the key. Use the secret / service_role key of THIS project, copied completely, as SUPABASE_SERVICE_ROLE_KEY.';
  if (e.status === 403 || e.pg === '42501') return 'The service role has no permission on public.' + table + '. Run supabase/migrations/002_service_role_grants.sql in the SQL Editor.';
  return 'Unexpected Supabase response. Check the project status in the Supabase dashboard.';
}

function supabaseStore(url, key) {
  const base = normalizeSupabaseUrl(url) + '/rest/v1';
  // Legacy service_role keys are JWTs ("eyJ...") and are sent as both apikey and Bearer.
  // Newer "sb_secret_..." keys go in the apikey header only.
  const auth = { apikey: key }; if (key.startsWith('eyJ')) auth.Authorization = 'Bearer ' + key;
  async function rq(method, p, body, prefer) {
    let r;
    try { r = await fetch(base + p, { method, signal: AbortSignal.timeout(15000), headers: { ...auth, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (err) { const e = new Error('Could not reach Supabase (' + ((err.cause && (err.cause.code || err.cause.message)) || err.name) + ')'); e.status = 0; throw e; }
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON body */ }
    if (!r.ok) {
      // Keep only PostgREST's short error code and message (for example PGRST205 "Could not find the table...").
      // The body is never copied wholesale, and nothing here is ever sent to the browser.
      const pg = data && typeof data === 'object' ? data : {};
      const e = new Error('Supabase request failed with status ' + r.status + (pg.code ? ' [' + pg.code + '] ' + String(pg.message || '').slice(0, 160) : ' (no database error details came back)'));
      e.status = r.status; e.pg = pg.code; throw e;
    }
    return data;
  }
  const fromRow = r => r && withDefaults({ id: r.id, name: r.name, email: r.email, salt: r.password_salt, hash: r.password_hash, role: r.role, createdAt: Date.parse(r.created_at), prefs: r.prefs || undefined, plans: r.plans || undefined, sessionVersion: r.session_version, resetHash: r.reset_hash, resetExp: r.reset_expires_at ? Date.parse(r.reset_expires_at) : 0, resetAttempts: r.reset_attempts, googleId: r.google_id || null });
  const COLS = { id: 'id', name: 'name', email: 'email', salt: 'password_salt', hash: 'password_hash', role: 'role', prefs: 'prefs', plans: 'plans', sessionVersion: 'session_version', resetHash: 'reset_hash', resetAttempts: 'reset_attempts', googleId: 'google_id' };
  const toRow = p => { const o = {}; for (const k of Object.keys(p)) { if (COLS[k]) o[COLS[k]] = p[k]; else if (k === 'createdAt') o.created_at = new Date(p[k]).toISOString(); else if (k === 'resetExp') o.reset_expires_at = p[k] ? new Date(p[k]).toISOString() : null; } return o; };
  const one = async (p) => { const a = await rq('GET', p); return Array.isArray(a) && a[0] ? fromRow(a[0]) : null; };
  return {
    kind: 'supabase',
    // Startup self-check: tries both tables and returns a list of problems, each with a plain-English hint. Never throws.
    async check() {
      const problems = [];
      for (const [table, col] of [['app_users', 'id'], ['student_state', 'user_id']]) {
        try { await rq('GET', '/' + table + '?select=' + col + '&limit=1'); }
        catch (e) { problems.push({ table, message: e.message, hint: supabaseHint(e, table) }); }
      }
      return problems;
    },
    findUserByEmail: email => one('/app_users?select=*&limit=1&email=eq.' + encodeURIComponent(email)),
    findUserById: id => one('/app_users?select=*&limit=1&id=eq.' + needId(id)),
    findUserByGoogleId: googleId => one('/app_users?select=*&limit=1&google_id=eq.' + encodeURIComponent(googleId)),
    async createUser(user) {
      try { const a = await rq('POST', '/app_users', toRow(user), 'return=representation'); return fromRow(a[0]); }
      catch (e) { if (e.status === 409) throw new DuplicateError(); throw e; }
    },
    async updateUser(id, patch) { const a = await rq('PATCH', '/app_users?id=eq.' + needId(id), toRow(patch), 'return=representation'); return Array.isArray(a) && a[0] ? fromRow(a[0]) : null; },
    async deleteUser(id) { await rq('DELETE', '/app_users?id=eq.' + needId(id)); }, // student_state rows are removed by ON DELETE CASCADE
    async getState(id) { const a = await rq('GET', '/student_state?select=state,updated_at&limit=1&user_id=eq.' + needId(id)); return Array.isArray(a) && a[0] ? { state: a[0].state, updatedAt: a[0].updated_at } : null; },
    async putState(id, state) {
      const updatedAt = new Date().toISOString();
      await rq('POST', '/student_state?on_conflict=user_id', { user_id: needId(id), state, updated_at: updatedAt }, 'resolution=merge-duplicates,return=minimal');
      return updatedAt;
    }
  };
}

module.exports = { fileStore, supabaseStore, normalizeSupabaseUrl, DuplicateError, UUID };

'use strict';
// Reads the .env file next to server.js and copies its settings into process.env.
//  * Real environment variables (set by your host) always win over the file.
//  * Understands Windows quirks: UTF-8 BOM, UTF-16 (what PowerShell's "echo x > .env" creates), CRLF line ends,
//    "export NAME=value", quotes, and trailing "# comments".
//  * Values that are still the placeholder text from .env.example are IGNORED (so a copied-but-unedited file
//    can never be used as a real secret or key).
//  * It reports what happened using setting NAMES only. It never returns or prints values.
const fs = require('fs'), path = require('path');

const KNOWN = ['GROQ_API_KEY', 'GROQ_MODEL', 'GROQ_API_URL', 'CHAT_DAILY_LIMIT', 'SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY', 'MAIL_FROM', 'PORT', 'NODE_ENV', 'TRUST_PROXY', 'ALLOW_FILE_STORE', 'DATA_DIR', 'SIGNUP_IP_MAX', 'LOGIN_IP_MAX', 'SKIP_DOTENV',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL'];
const PLACEHOLDER = /^(your[_-]|replace[_-]?with|change[_-]?me|<.*>$)|[_-]here$|your-project-ref/i;

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}
function parse(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line[0] === '#') continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (!m) continue;
    let v = m[2].trim();
    const q = v.match(/^(["'])(.*?)\1(?:\s+#.*)?$/);
    out[m[1]] = q ? q[2] : v.replace(/\s+#.*$/, '').trim();
  }
  return out;
}
function loadEnv(dir, opts = {}) {
  const file = path.join(dir, '.env');
  const info = { path: file, found: false, skipped: !!opts.skip, loaded: [], empty: [], placeholders: [], unknown: [], lookalikes: [] };
  if (opts.skip) return info;
  let text;
  try { text = decode(fs.readFileSync(file)); info.found = true; }
  catch (e) {
    try { info.lookalikes = fs.readdirSync(dir).filter(f => f !== '.env' && f !== '.env.example' && /^(\.?env(\..+)?|_env(\..+)?)$/i.test(f) && !/example$/i.test(f)); } catch (e2) { /* ignore */ }
    return info;
  }
  for (const [k, v] of Object.entries(parse(text))) {
    if (!KNOWN.includes(k)) info.unknown.push(k);
    if (!v) { info.empty.push(k); continue; }
    if (PLACEHOLDER.test(v)) { info.placeholders.push(k); continue; }
    if (process.env[k] === undefined) { process.env[k] = v; info.loaded.push(k); }
  }
  return info;
}
module.exports = { loadEnv, parse, decode, KNOWN, PLACEHOLDER };

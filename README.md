# EngineerPath AI (v2.2)

Same website and design as before. What changed is **how accounts, sessions and student progress are stored and protected**, and how the server is configured.

## What is what
| File | Job |
|---|---|
| `index.html` | The whole frontend (HTML + CSS + JavaScript, no framework) |
| `server.js` | Node server (no npm packages): login, sessions, rate limits, progress API, Groq AI proxy |
| `store.js` | Storage layer: Supabase (production) or local JSON files (development only) |
| `loadenv.js` | Reads `.env` (handles Windows quirks) and ignores example placeholders |
| `supabase/migrations/001_init.sql`, `002_service_role_grants.sql` | Create the tables, security rules and permissions |
| `scripts/check-supabase.js` | Checks your real Supabase connection |
| `scripts/migrate-users.js` | Copies old `auth-users.json` accounts into Supabase |
| `tests/` | Automated tests |
| `.env.example` | Template for your settings. Copy to `.env` |

## 1. First-time setup (Windows PowerShell or macOS/Linux)
Open a terminal **inside the project folder** (the one that contains `server.js`).
```bash
copy .env.example .env        # Windows.   macOS/Linux: cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"    # prints a long random text: use it as SESSION_SECRET
```
Edit `.env` with a normal editor (VS Code, Notepad) and set at least `SESSION_SECRET` and `GROQ_API_KEY`. Save as **UTF-8**.
Make sure Windows did not name the file `.env.txt` (File Explorer hides extensions by default). The server now also reads UTF-16 files, which is what PowerShell's `echo ... > .env` creates, but a normal editor is safer.
```bash
npm start                     # same as: node server.js   (works from any folder, e.g. node .\engineerpath-ai\server.js)
```
Open http://localhost:3000. There is nothing to `npm install` (no dependencies); `npm ci` also works.

### What the first terminal lines mean
| Terminal line | Meaning / what to do |
|---|---|
| `.env found at ... settings read: A, B` | Good. These setting **names** were read (values are never printed). |
| `No .env file at <path>` | The file is missing or misnamed. The next line lists look-alikes such as `.env.txt`. |
| `Still the example placeholder, so IGNORED: X` | You copied the example but did not replace value `X`. |
| `Names in .env this app does not use (check spelling)` | A typo such as `SUPABSE_URL`. |
| `SESSION_SECRET is not set / too short ... temporary one` | Fine for a quick local try, but everyone is logged out on every restart. Set a 32+ character secret. |
| `storage: file` | Local development files are used. `storage: supabase` means Supabase is configured. |
| `Supabase check OK` / `Supabase problem ... FIX:` | Result of a real test of both tables, with the exact fix. |
| `AI chat is OFF: GROQ_API_KEY is not set` | The app works; chat gives offline guidance until you add the key. |

## 2. Set up Supabase (needed for hosting)
1. Create a project at supabase.com.
2. Dashboard -> **SQL Editor** -> paste `supabase/migrations/001_init.sql` -> **Run**. Then do the same with `002_service_role_grants.sql` (safe to repeat).
3. Dashboard -> **Project Settings -> API**: put the **Project URL** in `.env` as `SUPABASE_URL` (just `https://xxxx.supabase.co`) and the **secret / service_role** key as `SUPABASE_SERVICE_ROLE_KEY`. Never put this key in `index.html`, GitHub or screenshots. Set both, or neither: one without the other stops the server on purpose.
4. Check the real connection:
   ```bash
   npm run check:supabase              # read-only
   npm run check:supabase -- --write   # also creates, reads and removes ONE temporary test account
   ```
5. Copy your old accounts (passwords keep working):
   ```bash
   npm run migrate:users -- --dry-run
   npm run migrate:users
   ```
6. `npm start`; the terminal should say `storage: supabase` and `Supabase check OK`. Keep `auth-users.json` as an offline backup (it has real emails and password hashes).

## 3. AI (Groq)
Needs `GROQ_API_KEY` (server only). The default model is `openai/gpt-oss-120b`. **Groq shut down `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` on 16 Aug 2026**; if `GROQ_MODEL` still names a retired model the server says so and uses the default instead. Model names change over time: check console.groq.com/docs/models.

## 4. Deploy
Set on the host: `NODE_ENV=production`, `TRUST_PROXY=1`, `SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY` (optional: `RESEND_API_KEY` + `MAIL_FROM` for reset emails). Start command `npm start`. In production the server refuses to start without a strong `SESSION_SECRET` and Supabase, sends only `Secure` cookies, and redirects HTTP to HTTPS (the `/api/health` path is exempt for platform health checks).

## 5. API endpoints
| Method and path | Needs login | Purpose |
|---|---|---|
| `GET /` | no | The website |
| `GET /api/health` | no | Health check |
| `GET /api/chat/status` | no | Is the AI key configured? |
| `POST /api/auth/signup`, `/login` | no | Create account / log in (sets the session cookie) |
| `POST /api/auth/forgot`, `/reset` | no | Password reset by 6-digit emailed code |
| `GET /api/auth/me` | no | Current user or `null` |
| `POST /api/auth/logout` | no | Ends the session on the server and clears the cookie |
| `POST /api/auth/profile`, `/password` | yes | Update name/preferences/plans; change password |
| `DELETE /api/auth/account` | yes | Delete account and its progress |
| `GET`/`PUT /api/state` | yes | Load / save the student's roadmap and progress |
| `POST /api/chat` | yes | Ask the AI assistant |

## 6. Tests
```bash
npm test                               # 45 backend tests, no internet, no real keys needed
pip install playwright && playwright install chromium
python3 tests/e2e_browser.py           # 24 real-browser checks
```
Tests run the server in temporary folders with `SKIP_DOTENV=1`, so they **never read your real `.env`** and never touch your real Supabase or Groq. Supabase and Groq are replaced by local stand-ins, so only `npm run check:supabase` proves your real project works.

## 7. Security summary
- Signed, HttpOnly, SameSite=Lax session cookie, re-checked against the database on every request; 7-day expiry; `Secure` in production.
- Logout and password change both invalidate the old cookie on the server. **Logout signs you out of all devices** (simple and safe; per-device sign-out would need another table).
- All private endpoints require login; student data is read and written only for the user in the cookie.
- Rate limits: signup, login (IP and email), reset, password change, state saves, and AI (per minute, per day and per IP).
- Identical login error for wrong password and unknown email. Reset codes are stored hashed, expire in 15 minutes, 5 attempts.
- Origin check + JSON-only requests (CSRF), no CORS headers (same-origin only), CSP, no framing, nosniff, HSTS over HTTPS.
- Secrets only in server environment; never logged, never sent to the browser. Placeholders from `.env.example` are never accepted as real values.
- Supabase tables have Row Level Security on with no public policies; only the server's secret key can read/write.

## 8. Known limitations
- Progress is one JSON record per student (`student_state`), as the app already kept it. Separate tables for skills/assessments/roadmap progress are a later stage.
- Rate limits are in memory (reset on restart, per server instance).
- The page needs `'unsafe-inline'` scripts in its CSP because it uses inline event handlers.
- Reset emails need a Resend account; without it students cannot reset passwords in production.
- Two-device edits: newest save wins (no merging).

# VINAYVERSE AI backend

A small, secure Node.js server that sits between the VINAYVERSE fitness app
and a genuine AI provider. The app never talks to the AI provider directly,
and your provider API key lives **only** on this server — never in the app,
the HTML file, or your phone.

It powers two app features:
- **AI Coach** — `POST /api/coach`
- **Food Scanner** — `POST /analyze-food` (photo in, food estimates out)

---

## Setup on Windows (beginner-friendly)

You only need **Windows 10 or 11**. No coding required — just follow the steps.

### Step 1 — Install Node.js

1. Go to **https://nodejs.org** and download the **LTS** version (the big green button).
2. Run the installer, clicking **Next** through everything (the defaults are fine).
3. To confirm it worked: press `Win + R`, type `powershell`, press Enter, then type:
   ```powershell
   node --version
   ```
   You should see something like `v20.x.x`. If so, you're good.

### Step 2 — Extract this ZIP

1. Right-click the ZIP file → **Extract All…** → **Extract**.
2. Open the extracted `vinayverse-ai-backend` folder. You should see files like
   `server.js`, `package.json`, `.env.example`, and folders `lib/` and `test/`.

### Step 3 — Open a terminal in that folder

1. Inside the `vinayverse-ai-backend` folder, click the address bar at the top
   of File Explorer, type `powershell`, and press Enter.
   (A blue PowerShell window opens, already in the right folder.)

### Step 4 — Install dependencies (one time)

In the PowerShell window, type:

```powershell
npm install
```

Wait until it finishes (it downloads a few small libraries — about a minute).

### Step 5 — Create your `.env` file

Still in PowerShell:

```powershell
copy .env.example .env
notepad .env
```

Notepad opens. Find the line `AI_API_KEY=` and paste your AI provider key
after the `=` sign, so it looks like:

```
AI_API_KEY=sk-...your real key here...
```

Save (`Ctrl + S`) and close Notepad. **Never share this `.env` file with
anyone and never upload it to GitHub** — it holds your secret key.

> Don't have a key yet? Sign up at platform.openai.com → **API keys** →
> **Create new secret key**. API usage is pay-per-use (pennies per request).

### Step 6 — Start the server

```powershell
npm start
```

You should see something like `listening on http://localhost:3001`.
**Leave this window open** — closing it stops the server.

### Step 7 — Check it works

Open a **second** PowerShell window (`Win + R` → `powershell`) and run:

```powershell
curl http://localhost:3001/health
```

You should get back something like:
`{"ok":true,"version":"1.0.0","providerConfigured":true}`.

### Step 8 — Run the tests (optional but recommended)

```powershell
npm test
```

All 23 tests should pass. (They use a simulated AI provider, so no key or
internet needed — this just proves the server logic is sound.)

---

## Endpoints

| Method | Path            | Request | Response |
|--------|-----------------|---------|----------|
| GET    | `/health`       | — | `{ ok: true, version, providerConfigured: boolean }` |
| POST   | `/api/coach`    | JSON `{ question: string, profile?: object, todayData?: object }` | `{ answer: string }` |
| POST   | `/analyze-food` | multipart form, single file field `photo` (JPEG/PNG/WEBP, ≤ `MAX_UPLOAD_MB`) | JSON array of `{ name, grams, kcal, protein?, carbs?, fat?, meal? }` |

The app calls these as `${BASE_URL}/api/coach` and `${BASE_URL}/analyze-food`,
so the **base URL** you paste into the app is e.g. `https://your-app.onrender.com`
(no trailing path).

In `AI_MOCK=1` mode every response is canned test data tagged `"mock": true`
— for tests only, never for real use.

## Deploying so your phone can reach it

Your phone can't reach `localhost` on your PC, so for real use deploy this
folder to a free host. Full click-by-click guide: **`DEPLOY.md`**
(GitHub upload → Render free web service → paste your key as an environment
variable → copy your `https://....onrender.com` URL into the app).

## Security model

- `AI_API_KEY` is read only from server env vars. It is never logged, never
  returned to clients, and never embedded in the app/HTML/APK.
- CORS allowlist via `CORS_ORIGIN` (permissive-by-default only for local dev,
  with a loud startup warning).
- JSON bodies capped at 100kb; uploads filtered to JPEG/PNG/WEBP and capped
  at `MAX_UPLOAD_MB` (default 12); uploads are held in memory, never written
  to disk.
- Per-IP rate limiting (default 30 req/min on API routes).
- 50s upstream AI timeout, 60s server request timeout.
- Provider failures are mapped to generic `502`/`503`/`504` messages — the
  provider's status/body is never forwarded to clients.
- Logs contain counts and sizes only (question length, image bytes, item
  counts) — never prompts, images, profiles, or keys.

# Deploying the VINAYVERSE AI backend

## 1. Run locally

```bash
cd vinayverse-ai-backend
npm install
cp .env.example .env
# Edit .env: set AI_API_KEY to your provider key (and AI_BASE_URL if not OpenAI)
npm start
# → listening on http://localhost:3001
```

Smoke test (no key needed — mock mode):

```bash
AI_MOCK=1 PORT=3001 npm start &
curl -s http://localhost:3001/health
# {"ok":true,"version":"1.0.0","providerConfigured":true}
curl -s -X POST http://localhost:3001/api/coach \
  -H 'Content-Type: application/json' \
  -d '{"question":"How much protein do I need?"}'
# {"answer":"This is a MOCK coach reply ...","mock":true}
curl -s -X POST http://localhost:3001/analyze-food \
  -F "photo=@/path/to/meal.jpg"
# [{"name":"Mock rice (test data)",...,"mock":true}, ...]
```

`npm test` runs the full suite against the mock provider (no key required).

## 2. What to paste into the VINAYVERSE app

In the app, open **AI Coach → Connect your own AI backend** (and the same
setting feeds the Food Scanner). Paste the **base URL only**, e.g.:

```
https://vinayverse-ai.onrender.com
```

The app appends `/api/coach` and `/analyze-food` itself. Then press **Test**
in the app to verify reachability.

> ⚠️ Never paste your `AI_API_KEY` into the app. The key lives only in the
> server's environment variables (see below).

## 3. Free hosting options

### Option A — Render (easiest free start)

**A1. Put the code on GitHub (no git needed — upload in the browser):**
1. Go to **github.com** and sign up / log in (free).
2. Click **+** (top right) → **New repository**. Name it `vinayverse-ai-backend`,
   leave it Public, and click **Create repository**.
3. On the new repo page, click **Add file → Upload files**.
4. Open the `vinayverse-ai-backend` folder on your computer, select **all** files
   and folders inside it (`server.js`, `package.json`, `lib/`, `test/`,
   `.env.example`, `README.md`, `DEPLOY.md` — everything **except** any `.env`
   file if you created one), and drag them into the GitHub upload area.
   > ⚠️ Double-check: if you see a `.env` file in the list, remove it before
   > committing — that file would contain your secret key.
5. Click **Commit changes**. Your code is now on GitHub.

**A2. Deploy on Render:**
1. Go to **dashboard.render.com** and sign up / log in (free — you can sign in
   with GitHub).
2. Click **New + → Web Service** → **Build and deploy from a Git repository** →
   **Connect** your GitHub account if asked → select the `vinayverse-ai-backend`
   repo → **Connect**.
3. Settings:
   - **Name:** `vinayverse-ai` (your URL becomes `https://vinayverse-ai.onrender.com`)
   - **Region:** pick the closest to you (e.g. Singapore)
   - **Branch:** `main`, **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
4. Before creating, open the **Environment Variables** section → **Add Environment
   Variable**:
   - Key: `AI_API_KEY` — Value: paste your AI provider key.
   - (Optional) `AI_MODEL` = `gpt-4o-mini`, `AI_VISION_MODEL` = `gpt-4o-mini`.
   - Leave `CORS_ORIGIN` **unset** for now so the app works from anywhere
     (including the single-file HTML opened as a file). You can restrict it later.
5. Click **Create Web Service** and wait 2–5 minutes for the first deploy.
6. When it says **Live**, copy the URL at the top of the page
   (`https://vinayverse-ai.onrender.com`) — that's what you paste into the app
   (AI Coach → Connect your own AI backend → Save → Test).

Honest notes: the free tier **sleeps after ~15 min idle** — the first request
after sleep takes **~30–60s** (cold start). The app's mountain-climbing loader
is designed for exactly this: it shows after ~1.5s and waits patiently. If the
first request times out at 60s, just retry once the service is warm. Free tier
also gives ~750 instance-hours/month (enough for one always-"on" service that
sleeps when idle).

### Option B — Fly.io (generous free allowances)
1. Install `flyctl`, then `fly launch` in this folder (choose Node detector,
   or add a tiny Dockerfile — `fly launch` will offer one).
2. `fly secrets set AI_API_KEY=... AI_MODEL=gpt-4o-mini` (secrets, not env).
3. `fly deploy`. URL: `https://<app-name>.fly.dev`.
4. Set `CORS_ORIGIN` via `fly secrets set CORS_ORIGIN=...`.

Honest notes: Fly's free allowance covers small apps (shared CPU, 256MB is
plenty here); machines auto-stop when idle → same cold-start behavior as
Render. Requires a credit card on file for the free tier.

### Option C — Railway ($5 of free credit, then pay-as-you-go)
1. https://railway.app → **New Project → Deploy from GitHub**.
2. Add variables in the service's **Variables** tab (`AI_API_KEY`, etc.).
3. Railway assigns a public domain like `https://<x>.up.railway.app`.

Honest notes: no always-free tier anymore — new accounts get a small trial
credit (~$5), then usage billing. Good if you outgrow Render's sleeps.

## 4. Production checklist

- [ ] `AI_API_KEY` set as a **secret/env var** on the host (never in code).
- [ ] `CORS_ORIGIN` restricted to your app's origin(s). If you open the
      single-file HTML directly from `file://`, browsers send `Origin: null` —
      add the literal `null` to `CORS_ORIGIN` for that setup.
- [ ] `AI_MOCK` is **unset** (mock mode is for tests only).
- [ ] `AI_VISION_MODEL` supports image input (e.g. `gpt-4o-mini` does).
- [ ] Test `/health`, then the app's **Test** button, then a real coach
      question and one food photo.

## 5. Expected costs

| Part | Cost |
|------|------|
| Hosting (Render free) | **$0** (sleeps when idle; 30–60s cold starts) |
| Hosting (Render paid, no sleep) | **~$7/month** |
| Hosting (Fly.io small) | **~$0–5/month** within free allowances |
| Hosting (Railway) | **~$5/month** after trial credit |
| AI usage (your own provider key) | **Pay-per-use, pennies per request.** Example on `gpt-4o-mini`: a coach answer (~1–2k tokens) costs a fraction of a cent; a food-photo analysis (~1–3k tokens incl. image) costs roughly a tenth of a cent. A heavy user costs on the order of **$0.10–1/month**. Prices vary by provider/model — check your provider's pricing page. |

You bring your own provider key, so AI spend is billed by your provider
directly, not by the host.

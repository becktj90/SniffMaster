# SniffMaster Pro — Web Dashboard

A hosted PWA that displays real-time air quality data from your SniffMaster Pro device. Access it from any browser — phone, tablet, or work laptop — over public HTTPS.

## Architecture

```
ESP32 (sketch_apr3a.ino)
  │  HTTPS POST every 10 min
  ▼
Vercel Serverless  ──►  Upstash Redis (free tier)
  POST /api/update           │
                             │
Browser / iPhone PWA         │
  GET /api/latest  ◄─────────┘
  GET /api/history
  GET /api/sniff
  GET /api/sniff-history
  GET /api/health
```

**Frontend**: Static PWA (HTML/CSS/JS) — mobile-first dark theme, installable on iPhone home screen.

**API relay**: Serverless functions on Vercel for snapshots, sulfur-priority events, history, SSE, health checks, office metrics, and weather briefing.

**Storage**: Upstash Redis (free tier — 10k commands/day). Stores latest snapshot + 48h ring buffer.

**ESP32**: New `sendToWebDashboard()` function posts a JSON snapshot via HTTPS.

## What the dashboard shows

- Air Quality score gauge (0–100) with color coding
- IAQ, VOC, CO2 at a glance
- All 20 odor detection scores as bar charts
- Local weather forecast briefing with deterministic fallback
- Temperature, humidity, pressure, gas resistance
- Outdoor AQI
- IAQ history chart (up to 48 hours)
- **Work Area Environment Monitor** — real-time threshold alerts + a daily 24h personnel report (stat tiles with change-vs-norm deltas, sparklines, and an LC-36 weather + natural-lighting outlook), with an owner-adjustable **Industrial / Office** environment mode that tailors wording and which sensor readings are highlighted (industrial focuses on crew heat/humidity/air-quality safety plus gas-resistance smoke checks; office frames the same data around occupant comfort and ventilation)

## Deploy (one-time setup)

### 1. Create Upstash Redis database

1. Sign up at https://upstash.com (free)
2. Create a Redis database (any region)
3. Copy the **REST URL** and **REST Token** from the database details page

### 2. Deploy to Vercel

```bash
cd sniffmaster_web
npm install

# Install Vercel CLI if needed
npm i -g vercel

# Deploy (follow prompts to link to your Vercel account)
vercel

# Set environment variables
vercel env add SNIFFMASTER_API_KEY     # generate: openssl rand -hex 16
vercel env add UPSTASH_REDIS_REST_URL  # from step 1
vercel env add UPSTASH_REDIS_REST_TOKEN # from step 1
vercel env add OPENAI_API_KEY          # optional, enables model-generated weather insight

# Deploy to production
vercel --prod
```

Your dashboard is now live at `https://your-app.vercel.app`.

### 3. Configure the ESP32

1. Copy `web_dashboard_config.h.example` to `web_dashboard_config.h`:
   ```bash
   cp web_dashboard_config.h.example web_dashboard_config.h
   ```

2. Edit `web_dashboard_config.h`:
   ```cpp
   #define WEB_DASHBOARD_URL  "https://your-app.vercel.app"
   #define WEB_DASHBOARD_KEY  "same-key-you-set-in-vercel"
   ```

3. In `sketch_apr3a.ino`, uncomment the feature flag (near line 40):
   ```cpp
   #define USE_WEB_DASHBOARD
   ```

4. Upload the sketch to your ESP32.

The device will POST a JSON snapshot every 10 minutes plus event-driven pushes. The web dashboard polls `/api/latest` every 10 seconds.

## Add to iPhone home screen

1. Open your dashboard URL in Safari
2. Tap the Share button (box with arrow)
3. Scroll down and tap **Add to Home Screen**
4. Tap **Add**

The app launches full-screen with a dark status bar — no Safari chrome.

## API reference

### POST /api/update

Receives sensor data from the ESP32. Requires `key` field matching `SNIFFMASTER_API_KEY`.

```json
{
  "key": "your-secret",
  "voc": 0.5, "iaq": 25, "iaqAcc": 3, "co2": 420,
  "tempF": 72.5, "humidity": 45.2, "pressHpa": 1013.25,
  "gasR": 180000, "dVoc": 0.1, "airScore": 85, "tier": 1,
  "fartCount": 3,
  "odors": [0,0,0,...],
  "primary": "Clean Air", "primaryConf": 0,
  "hazard": "Fresh", "sassy": "...", "quip": "...", "radar": "...",
  "uptime": 3600, "outdoorAqi": 42, "city": "Kent"
}
```

### GET /api/latest

Returns the most recent snapshot (or 204 if none).

### GET /api/history?count=48

Returns up to `count` recent snapshots (newest first, max 288).

### GET /api/sniff

Returns the most recent sulfur/VSC priority event.

### GET /api/sniff-history?count=12

Returns recent sulfur/VSC priority events (newest first).

### GET /api/health

Returns Redis configuration + reachability status so you can verify the hosted relay is actually talking to Upstash.

### GET /api/office-stats

Returns the latest Office Vitality heuristics, including CFI and transmission-risk fields.

### GET /api/weather-briefing

Returns a 3-day local forecast bundle plus a concise local insight. Uses Open-Meteo forecast data and, if `OPENAI_API_KEY` is configured, an OpenAI-generated weather brief. Otherwise it falls back to deterministic local forecast logic.

### GET /api/daily-summary

Three modes:
- **Unauthenticated**: returns the most recently stored 24h summary (or 204) — used by the dashboard's Restoration Safety Monitor panel.
- **Authorized** (`Authorization: Bearer $CRON_SECRET`, sent automatically by Vercel Cron): computes the 24h min/avg/max baseline, texts the morning report via AWS SNS, stores it, and returns the JSON. An atomic Redis lock guarantees at most one send per 6-hour window. The report is tailored (wording, which sensors are highlighted) by the current `environmentType` — see `/api/settings` below.
- **`?manual=true`** (no `CRON_SECRET` needed — the "Send test report now" button on the dashboard): forces a real, fresh send the same way `?force=true` does, but since anyone with the dashboard URL can trigger it and each send costs real money via ClickSend, it's rate-limited server-side to once every 5 minutes (independent of the 6-hour cron resend guard) rather than gated behind a secret.

Report wording isn't static: it factors in how many consecutive days a problem has persisted (or that it just cleared) via `computeProblemStreak()`, and the OpenAI-written narrative is given the same day-over-day % comparisons the report page shows, so two different underlying situations don't read the same.

The text message itself is a short summary (the personal-voice report + today's Cape launches, if any) plus a link to `/report` — the detailed 24h stats-vs-baseline breakdown and the LC-36 weather/lightning outlook live on that page instead of as a raw text dump in the SMS.

### GET/POST /api/settings

Adjustable alarm limits and the environment mode.

- **GET**: returns the effective settings (including current `environmentType`, `humidityHigh`, `tempHighC`, `co2High`, `iaqPoor`, `gasDropPct`, `alertCooldownMin`, and the allowed ranges/enum). No auth required — the dashboard reads this to mirror the backend's thresholds and copy.
- **POST**: no auth required — this is a personal single-tenant dashboard, so anyone with the URL can retune alarms from the "Adjust alarm limits" panel. Accepts a partial patch of `{ humidityHigh, tempHighC, co2High, iaqPoor, gasDropPct, alertCooldownMin, environmentType }`. `environmentType` must be `"industrial"` (default) or `"office"` (`"construction"` is accepted as a legacy alias and normalized to `"industrial"`). Changing it immediately affects: real-time alert wording on the dashboard, which sensor reading is highlighted, and the next morning report's tone and stats. Every numeric field is clamped to a safe range server-side (see `THRESHOLD_LIMITS`/`ALERT_COOLDOWN_LIMITS` in `lib/thresholds.js`) so a bad or malicious value can never fully disable monitoring.

Real-time alerts fire both on the daily 6 AM ET schedule **and** immediately whenever a reading breaches a threshold. Each breach sends **one message**: a short personal-voice summary of what tripped, plus a link to `/report` for the detailed 24h-stats-vs-baseline breakdown and the LC-36 weather/lightning outlook — the message itself stays a simple summary rather than a raw stats dump. Sent as an MMS with the visual report-card image when ClickSend is configured (falls back to plain SMS otherwise).

### GET /report

A small, self-contained mobile-first page (no dependency on the main dashboard SPA) that the daily report and alert messages link to. Fetches `/api/report-card?format=json` (whichever is newer: the morning report or the most recent alert's own snapshot) and renders a verdict banner, stat tiles with deltas vs the recent-days baseline, the LC-36 weather outlook, and today's Cape launches.

## SMS alerts (Amazon SNS) — setup

The relay can text you a **daily 6 AM ET work-area report** and **immediate alerts** when conditions breach the personnel-safety limits (humidity, temp, CO2 — all owner-adjustable — plus sudden gas-resistance drop and IAQ ≥ 150). With the env vars unset, texting is silently skipped and everything else keeps working.

US SMS pricing is ~$0.00645/message (any free-tier allowance depends on your account; AWS has been phasing the SMS free tier out). Either way, one report + occasional alerts costs pennies per month.

### Step 1: Create AWS IAM User

1. Go to **https://console.aws.amazon.com/iam/**
2. Click **Users** → **Create user**
3. Enter username (e.g., "sniffmaster-sns")
4. Click **Next**
5. Under **Attach policies directly**, search for and select **AmazonSNSFullAccess** (or, better, an inline policy allowing only `sns:Publish`)
6. Click **Create user**
7. Click on the user you just created
8. Go to **Security credentials** tab
9. Click **Create access key**
10. Select **Application running outside AWS**
11. Click **Create access key**
12. **SAVE these immediately:**
    - Access Key ID (starts with `AKIA...`)
    - Secret Access Key (you'll only see it once)

### Step 2: Exit the SNS SMS sandbox (or verify your number)

New AWS accounts start in the **SMS sandbox**: SNS will silently refuse to text any number you haven't verified.

1. Go to **SNS console → Text messaging (SMS) → Sandbox destination phone numbers**
2. Click **Add phone number**, enter your cell, confirm the verification code it texts you

That's enough for personal alerts. (For unverified recipients you'd request production access from that same page.) Also note the default **$1/month SMS spend limit** — roughly 150 texts — which is plenty here; raise it via Service Quotas if you ever need more.

### Step 3: Set Environment Variables in Vercel

Go to **Vercel Dashboard** → your SniffMaster project → **Settings** → **Environment Variables** (Production):

> ⚠ The AWS variable names are prefixed with `SNS_` **on purpose**. Vercel functions run on AWS Lambda, which reserves the standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` names — Vercel won't let you set them, and at runtime they contain Lambda's own credentials, which cannot send SMS.

| Variable | Value | Example |
|----------|-------|----------|
| `SNS_AWS_ACCESS_KEY_ID` | Your IAM Access Key ID | `AKIAIOSFODNN7EXAMPLE` |
| `SNS_AWS_SECRET_ACCESS_KEY` | Your IAM Secret Access Key | `wJalrXUtnFEMI/K7MDENG/bPxRfiCY...` |
| `SNS_AWS_REGION` | AWS region (optional, default us-east-1) | `us-east-1` |
| `ALERT_SMS_TO` | Recipient (E.164; optional — defaults to the owner's number baked into `lib/notify.js`) | `+15104324862` |
| `CRON_SECRET` | Random secret for cron auth | `openssl rand -hex 16` |

**Generate CRON_SECRET in your terminal:**
```bash
openssl rand -hex 16
# Output: 3a7f2c8b1e4d9a5f6c2b8e1a3f7d4c9b
```

Optional: `OPENAI_API_KEY` gives the daily report a naturally written, personal tone (same key that powers the weather briefing); without it a built-in template is used — either way the text reads like a friendly site report, includes the 24h numbers, and lists any Cape Canaveral launches scheduled that day. ClickSend (`CLICKSEND_USERNAME`/`CLICKSEND_API_KEY`) can be set as an automatic fallback provider.

### Step 4: Redeploy

In Vercel, click **Deployments** → **Redeploy** on the latest deployment, or:

```bash
git push  # triggers automatic redeploy
```

Wait ~2 minutes for the deployment to finish.

> **Deploying from GitHub?** In the Vercel project settings, **Build & Development Settings → Root Directory must be `web`** — the app lives in this subdirectory, and building from the repo root makes every URL 404.

### Step 5: Test the Morning Report

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
  https://YOUR-APP.vercel.app/api/daily-summary
```

You should see JSON returned + a text on your phone!

### Step 6: Test a Live Alert

Post a humidity breach (> 55%):

```bash
curl -X POST https://YOUR-APP.vercel.app/api/update \
  -H "Content-Type: application/json" \
  -d '{
    "key":"YOUR_SNIFFMASTER_API_KEY",
    "temperature":22,
    "humidity":61,
    "pressure":1012,
    "gas_resistance":150000,
    "iaq":40
  }'
```

Humidity 61% > 55% → you'll get an alert text immediately!

**Cron note**: the schedule in `vercel.json` is `0 10 * * *` (10:00 UTC = 6:00 AM EDT during daylight saving). Vercel Hobby supports daily crons but fires them "within the hour"; Pro is exact. During EST (winter) 10:00 UTC is 5:00 AM ET — bump to `0 11 * * *` if that matters.

## Alternative deploy targets

The frontend is static files and the API is standard serverless functions. You can adapt to:

- **Netlify**: Move `api/` to `netlify/functions/`, update imports, add `netlify.toml`
- **Cloudflare Pages + Workers**: Convert functions to Workers format, use Cloudflare KV instead of Upstash
- **Railway / Fly.io**: Wrap in an Express server

## Cost

Everything used is free tier:
- **Vercel**: Free for hobby (100 GB bandwidth, 100k function invocations/month)
- **Upstash Redis**: Free tier (10k commands/day — device posts 144/day, dashboard polls ~5k/day when open)
- **AWS SNS**: ~$0.00645 per US SMS (~$0.25/month for one daily report + occasional alerts)
- **ESP32**: One HTTPS POST every 10 minutes (~1–3 seconds, no impact on sensor loop)

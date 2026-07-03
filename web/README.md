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
- Fart counter
- Outdoor AQI
- IAQ history chart (up to 48 hours)

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

Two modes:
- **Unauthenticated**: returns the most recently stored 24h summary (or 204) — used by the dashboard's Restoration Safety Monitor panel.
- **Authorized** (`Authorization: Bearer $CRON_SECRET`, sent automatically by Vercel Cron): computes the 24h min/avg/max baseline, texts the morning report via Twilio, stores it, and returns the JSON. An atomic Redis lock guarantees at most one send per 6-hour window.

## SMS alerts (Twilio) — setup

The relay can text you a **daily 6 AM ET room report** and **immediate alerts** when conditions breach restoration-safe limits (humidity > 55%, temp > 40°C, sudden gas-resistance drop, IAQ ≥ 150). With the env vars unset, texting is silently skipped and everything else keeps working.

1. **Create a Twilio account** at <https://www.twilio.com/try-twilio>. A free trial works for texting *your own verified number* (trial texts carry a "Sent from your Twilio trial account" prefix).
2. **Get a phone number**: Console → Phone Numbers → Buy a Number (with SMS capability). Trial accounts get one free. For a paid US local (10-digit) number, Twilio requires A2P 10DLC registration before SMS delivers reliably — a **toll-free number with (free) toll-free verification** is usually the fastest path for personal alerts.
3. **Trial only**: verify your personal cell under Phone Numbers → Verified Caller IDs, or texts to it will be rejected.
4. **Copy credentials** from the Console home page: Account SID (`AC…`) and Auth Token.
5. **Set env vars** in Vercel → Project → Settings → Environment Variables (Production):
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (your Twilio number, `+1…`), `ALERT_SMS_TO` (your cell, `+1…`; comma-separate for multiple), and `CRON_SECRET` (`openssl rand -hex 16`).
6. **Redeploy** so the functions pick up the new env, then **test the morning report by hand**:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-APP.vercel.app/api/daily-summary
   ```
   You should get the JSON back and the text on your phone. (Re-runs within 6h return `skipped` — that's the resend guard working.)
7. **Test a live alert** by posting a breaching snapshot as the device would:
   ```bash
   curl -X POST https://YOUR-APP.vercel.app/api/update \
     -H "Content-Type: application/json" \
     -d '{"key":"YOUR_SNIFFMASTER_API_KEY","temperature":22,"humidity":61,"pressure":1012,"gas_resistance":150000,"iaq":40}'
   ```
   Humidity 61% > 55% fires one alert text; identical re-posts stay silent (30-min per-condition cooldown; a fresh text fires when a *new* condition breaches).

**Cron note**: the schedule in `vercel.json` is `0 10 * * *` (10:00 UTC = 6:00 AM EDT). Vercel Hobby supports daily crons but fires them "within the hour"; Pro is exact. During EST (winter) 10:00 UTC is 5:00 AM ET — bump to `0 11 * * *` if that matters.

## Alternative deploy targets

The frontend is static files and the API is standard serverless functions. You can adapt to:

- **Netlify**: Move `api/` to `netlify/functions/`, update imports, add `netlify.toml`
- **Cloudflare Pages + Workers**: Convert functions to Workers format, use Cloudflare KV instead of Upstash
- **Railway / Fly.io**: Wrap in an Express server

## Cost

Everything used is free tier:
- **Vercel**: Free for hobby (100 GB bandwidth, 100k function invocations/month)
- **Upstash Redis**: Free tier (10k commands/day — device posts 144/day, dashboard polls ~5k/day when open)
- **ESP32**: One HTTPS POST every 10 minutes (~1–3 seconds, no impact on sensor loop)

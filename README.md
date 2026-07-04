# SniffMaster Pro

Monorepo for the SniffMaster Pro embedded firmware, hosted web dashboard, and supporting docs/tools.

## Layout

- `firmware/` — ESP32 PlatformIO project migrated from the Arduino sketch
- `web/` — Vercel-hosted dashboard and API relay
- `docs/` — architecture notes and stabilization roadmap
- `tools/` — future data/ML utilities
- `ntfy_sms_forwarder.py` — standalone background script that forwards ntfy.sh push notifications to a phone as SMS via an Email-to-SMS gateway (independent of the web dashboard's own SNS/Twilio/ntfy alert pipeline)

## Quick start

### Firmware

1. Install VS Code + PlatformIO extension.
2. Open `firmware/` as a PlatformIO project.
3. Review `platformio.ini` and select the correct board env:
   - `xiao_esp32s3`
   - `xiao_esp32c3`
4. Put private config headers next to `src/main.cpp` if your sketch depends on local secrets or omitted model files.
5. Build and flash.

### Web

1. `cd web`
2. `npm install`
3. Copy `.env.example` to `.env.local`
4. `npm run dev`

### ntfy SMS forwarder

`ntfy_sms_forwarder.py` (repo root) listens on a ntfy.sh topic over SSE and
forwards each notification as an SMS by emailing an Email-to-SMS gateway
address (e.g. `15104324862@txt.att.net` for AT&T) via SMTP. It reconnects
automatically with exponential backoff and never hardcodes secrets — all
config comes from a root-level `.env`.

**Setup:**

1. `pip install -r requirements.txt`
2. A root `.env` already exists (copied from `.env.example`) with
   `NTFY_BASE_URL`, `NTFY_TOPIC`, and `SMS_GATEWAY_ADDRESS` pre-filled.
   Fill in the remaining SMTP secrets in `.env`:
   - `SMTP_SERVER` / `SMTP_PORT` — your SMTP provider (defaults to Gmail's `smtp.gmail.com:587`)
   - `SMTP_USERNAME` / `SMTP_PASSWORD` — SMTP login (for Gmail, use an [App Password](https://myaccount.google.com/apppasswords), not your normal password)
   - `SENDER_EMAIL` — the "From" address for the outgoing email (usually the same as `SMTP_USERNAME`)
3. Run it in the foreground to verify it connects: `python3 ntfy_sms_forwarder.py`

**Running it in the background** (matches the usage notes in the script's own docstring):

```bash
# Unix/Mac — logs to ntfy_forwarder.log, keeps running after you close the shell
nohup python3 ntfy_sms_forwarder.py > ntfy_forwarder.log 2>&1 &

# Or with screen, so you can reattach later:
screen -S ntfy-forwarder
python3 ntfy_sms_forwarder.py
# Detach with Ctrl-A then D; reattach later with: screen -r ntfy-forwarder

# Windows — no console window
pythonw ntfy_sms_forwarder.py
```

The script also writes its own rotating-free log to `ntfy_forwarder.log` in
the working directory regardless of how it's launched, so `tail -f
ntfy_forwarder.log` works for checking on it later.

## Recommended git branches

- `main` — stable builds only
- `dev` — integration branch
- `feature/firmware-stability`
- `feature/ml`
- `feature/ble`
- `feature/web-ui`

## Immediate priorities

1. Prove firmware stability with ML disabled.
2. Gate BLE scans and Wi-Fi/cloud tasks on intervals.
3. Split the hot loop into timed tasks.
4. Reduce OLED redraw frequency.

(Web service-worker shell caching was fixed in `web/public/sw.js` v45 —
the install step had been failing on a stale pre-cache entry.)

## Vercel build/version indicator

The web dashboard footer shows a build indicator (e.g. `v1.1.0
(a1b2c3d@main)`) so you can tell which deployment is actually live:

- On Vercel, `web/api/version.js` reads the platform's built-in
  `VERCEL_GIT_COMMIT_SHA` / `VERCEL_GIT_COMMIT_REF` / `VERCEL_ENV` system
  environment variables at request time — no dashboard configuration
  needed, Vercel sets these automatically for every deployment.
- Locally (`node web/server.js`), those variables aren't set, so it falls
  back to the `version` field in `web/package.json` and labels the build
  `(local)`.
- The frontend (`web/public/app.js`) fetches `/api/version` on load and
  renders the label in the page footer (`#app-version`); hover over it to
  see the full commit SHA, branch, and environment.
- Bump `web/package.json`'s `version` field on notable releases so the
  local/fallback label stays meaningful.

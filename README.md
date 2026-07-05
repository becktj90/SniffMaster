# SniffMaster Pro

Monorepo for the SniffMaster Pro embedded firmware, hosted web dashboard, and supporting docs/tools.

## Layout

- `firmware/` — ESP32 PlatformIO project migrated from the Arduino sketch
- `web/` — Vercel-hosted dashboard and API relay
- `docs/` — architecture notes and stabilization roadmap
- `tools/` — future data/ML utilities
- `ntfy_sms_forwarder.py` — standalone background script that forwards ntfy.sh push notifications to a phone as SMS via the Brevo API (independent of the web dashboard's own SNS/Brevo/ntfy alert pipeline)
- `systemd/` — optional systemd user unit to keep the ntfy forwarder running across reboots/crashes
- `scripts/ntfy_watchdog.sh` — cron-friendly alternative to systemd for keeping the ntfy forwarder alive

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
forwards each notification as an SMS via the [Brevo](https://www.brevo.com/)
transactional SMS API, which sends over the real SMS network (not an email
gateway). It reconnects automatically with exponential backoff and never
hardcodes secrets — all config comes from a root-level `.env`.

**Setup:**

1. `pip install -r requirements.txt`
2. A root `.env` already exists (copied from `.env.example`) with
   `NTFY_BASE_URL`, `NTFY_TOPIC`, and `ALERT_SMS_TO` pre-filled. Fill in the
   Brevo credentials in `.env` (from your
   [Brevo dashboard](https://app.brevo.com) → Settings → SMTP & API → API Keys):
   - `BREVO_API_KEY` — transactional API key
   - `BREVO_SMS_SENDER` — sender name/number shown to the recipient (max 15
     chars: up to 11 if alphanumeric, up to 15 if a real numeric phone
     number). Some countries require this sender to be pre-approved in the
     Brevo dashboard (Transactional → SMS → Senders) before sends succeed.
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

**Keeping it running automatically (survives reboots and crashes):**

`nohup`/`screen` above are fine for a manual foreground session, but neither
comes back on its own after a reboot or if the script dies (uncaught
exception, OOM kill, etc). Use one of these instead for unattended,
long-term operation:

*Option A — systemd user service (Linux, preferred if available)*

```bash
mkdir -p ~/.config/systemd/user
cp systemd/ntfy-sms-forwarder.service ~/.config/systemd/user/
# edit the copied unit if your checkout isn't at ~/sniffmaster-pro
systemctl --user daemon-reload
systemctl --user enable --now ntfy-sms-forwarder.service
# let user services start without an active login session:
loginctl enable-linger "$USER"
```

`Restart=always` in the unit restarts the process a few seconds after any
crash, and `enable`d units start automatically on every boot. Check status
and logs with:

```bash
systemctl --user status ntfy-sms-forwarder.service
journalctl --user -u ntfy-sms-forwarder.service -f
```

*Option B — cron (no systemd, e.g. some minimal Linux setups)*

`scripts/ntfy_watchdog.sh` starts the forwarder if it isn't already running
and tracks its PID. Wire it up with cron so it fires once at boot and then
rechecks every 5 minutes in case the process crashed in between:

```bash
crontab -e
```

```cron
@reboot /full/path/to/sniffmaster-pro/scripts/ntfy_watchdog.sh
*/5 * * * * /full/path/to/sniffmaster-pro/scripts/ntfy_watchdog.sh
```

*macOS equivalent:* use `launchd` (a `~/Library/LaunchAgents/*.plist` with
`RunAtLoad` + `KeepAlive` set to `true`) instead of systemd/cron — the same
`ExecStart` command (`python3 ntfy_sms_forwarder.py`) applies.

None of these are a full process manager (e.g. pm2/supervisord) — that's
intentionally out of scope here — they're just enough supervision to make
sure the forwarder comes back after a reboot or crash without someone
noticing missed alerts first.

**History: AT&T email-to-SMS gateway → Twilio → Brevo.**

Live end-to-end testing (with real Gmail App Password credentials) confirmed
that the original email-to-SMS approach was unusable: Gmail's SMTP server
accepted every message (`✓ SMS sent successfully` in the logs), but no text
ever arrived on the destination phone (510-432-4862, confirmed AT&T), across
three separate attempts against both `txt.att.net` and `mms.att.net`. There
was no bounce-back or error in any case — AT&T's gateway (or an intermediate
spam filter) silently dropped the mail. This matches a widely-reported,
ongoing problem: AT&T has significantly tightened spam filtering on its
email-to-SMS gateways and frequently blocks mail from unfamiliar/bulk senders
(including standard Gmail SMTP) with zero feedback. **SMTP acceptance was
never proof of SMS delivery for AT&T numbers.**

The forwarder then moved to Twilio's SMS API, which sends over the real SMS
network rather than an email gateway — but hit its own carrier-side wall: a
live test showed Twilio's API accepting the message while the carrier marked
it `undelivered` with error 30034, because U.S. carriers require long-code
numbers to complete **A2P 10DLC registration** (a spam/abuse prevention
program) before delivering application-to-person texts. That's a one-time
business-verification step done in the Twilio Console — not something this
script can complete on your behalf.

**The forwarder now sends via [Brevo](https://www.brevo.com/)'s
transactional SMS API instead** (`BREVO_API_KEY` / `BREVO_SMS_SENDER` /
`ALERT_SMS_TO` in `.env` — see Setup above). Like Twilio, Brevo returns a
real HTTP error on failure — not a silent SMTP "success" — so send failures
are observable in `ntfy_forwarder.log`. One difference to know about: Brevo's
API does not expose a per-message delivery-status lookup the way Twilio's
`GET /Messages/{sid}` does, so `send_sms_via_brevo()` logs acceptance
(the `reference`, segment count, and remaining credits) and stops there. If
a text never arrives, check **Transactional → SMS → Logs** in the Brevo
dashboard for the actual carrier status — some countries also require the
sender name/number to be pre-approved there (Transactional → SMS → Senders)
before sends succeed at all.

**Quick way to verify a send:**

```bash
python3 -c "
import ntfy_sms_forwarder as f
f.validate_config()
print('Send succeeded:', bool(f.send_sms_via_brevo('Test: Brevo forwarder verification')))
"
```

The Brevo reference is printed in the log line right above (e.g.
`✓ Brevo accepted the message (reference: ..., smsCount: 1,
remainingCredits: 42)`). Check the Brevo dashboard's Transactional → SMS →
Logs to confirm the carrier actually delivered it.

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

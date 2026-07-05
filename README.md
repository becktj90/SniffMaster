# SniffMaster Pro

Monorepo for the SniffMaster Pro embedded firmware, hosted web dashboard, and supporting docs/tools.

## Layout

- `firmware/` — ESP32 PlatformIO project migrated from the Arduino sketch
- `web/` — Vercel-hosted dashboard and API relay
- `docs/` — architecture notes and stabilization roadmap
- `tools/` — future data/ML utilities
- `ntfy_sms_forwarder.py` — standalone background script that forwards ntfy.sh push notifications to a phone as SMS via the Twilio API (independent of the web dashboard's own SNS/Twilio/ntfy alert pipeline)
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
forwards each notification as an SMS via the [Twilio](https://www.twilio.com/)
API, which sends over the real SMS network (not an email gateway). It
reconnects automatically with exponential backoff and never hardcodes
secrets — all config comes from a root-level `.env`.

**Setup:**

1. `pip install -r requirements.txt`
2. A root `.env` already exists (copied from `.env.example`) with
   `NTFY_BASE_URL`, `NTFY_TOPIC`, and `ALERT_SMS_TO` pre-filled. Fill in the
   Twilio credentials in `.env` (from the
   [Twilio Console](https://console.twilio.com)):
   - `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` — API credentials
   - `TWILIO_MESSAGING_SERVICE_SID` — preferred sender: a Messaging Service
     whose sender pool holds your registered Twilio number
   - `TWILIO_FROM` — or, instead of a Messaging Service, a bare Twilio
     phone number in E.164 format (e.g. `+15555550100`)
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

**Switched off AT&T's email-to-SMS gateway in favor of Twilio — one manual
registration step still required before texts are actually delivered.**

Live end-to-end testing (with real Gmail App Password credentials) confirmed
that the previous email-to-SMS approach was unusable: Gmail's SMTP server
accepted every message (`✓ SMS sent successfully` in the logs), but no text
ever arrived on the destination phone (510-432-4862, confirmed AT&T), across
three separate attempts against both `txt.att.net` and `mms.att.net`. There
was no bounce-back or error in any case — AT&T's gateway (or an intermediate
spam filter) silently dropped the mail. This matches a widely-reported,
ongoing problem: AT&T has significantly tightened spam filtering on its
email-to-SMS gateways and frequently blocks mail from unfamiliar/bulk senders
(including standard Gmail SMTP) with zero feedback. **SMTP acceptance was
never proof of SMS delivery for AT&T numbers.**

The forwarder sends real SMS via a pluggable `SMS_PROVIDER` (see Setup above):
**ClickSend by default**, or [Twilio](https://www.twilio.com/) if you set
`SMS_PROVIDER=twilio`. Both send over the real SMS network rather than an
email gateway and return a message ID on success plus a real HTTP error on
failure — so send failures are now actually observable in
`ntfy_forwarder.log` instead of failing silently like the old gateway did.

**Why ClickSend is the default.** Twilio requires U.S. long-code numbers to
complete **A2P 10DLC registration** (a carrier spam/abuse prevention program)
before it will actually deliver application-to-person texts — a live test
showed Twilio's API accepting the message while the carrier silently marked
it `undelivered` with error code
[30034](https://www.twilio.com/docs/api/errors/30034). Worse, on a Twilio
Trial account this registration is stuck behind an auto-generated **"Mock
Brand"** in Trust Hub, which never actually delivers — the account has to be
upgraded to paid, then a *real* brand registered, before 10DLC clears at all.
ClickSend does not require this per-sender brand registration step for
low-volume personal alerts, so texts send immediately with just an API
username/key (`CLICKSEND_USERNAME` / `CLICKSEND_API_KEY` in `.env`).

**If you still want to use Twilio** (`SMS_PROVIDER=twilio`), you'll need to
complete A2P 10DLC registration first:

1. Upgrade the Twilio account from Trial to a paid account (required — Trial
   accounts only get a non-functional Mock Brand).
2. Go to [Messaging → Regulatory Compliance → A2P 10DLC](https://console.twilio.com/us1/develop/sms/regulatory-compliance/a2p-10dlc) in the Twilio Console.
3. Register a real brand (your business/individual info).
4. Register a campaign for this use case (e.g. "low-volume alerts/notifications").
5. Attach the campaign to `+17543379692` (or whichever number `TWILIO_FROM` points to).

Approval is often near-instant for low-volume/verified brands, but can take
up to a couple of days for full vetting. Once approved, re-run the forwarder
(or the quick test below) — no code changes are needed on this end.

**Quick way to verify delivery:**

```bash
python3 -c "
import ntfy_sms_forwarder as f
f.validate_config()
print('Send succeeded:', f.send_sms('Test: SMS delivery verification'))
"
```

This uses whichever provider `SMS_PROVIDER` selects. The message ID is
printed in the log line right above (e.g.
`✓ SMS sent successfully (ClickSend message_id: ...)` or
`... (Twilio SID: SM...)`), and `send_sms` prints `True`/`False` for whether
the provider *accepted* the send. If using Twilio, check the message status
directly with Twilio's API to confirm the carrier actually delivered it
(replace `<SID>` with the SID from the log):

```bash
curl -s -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Messages/<SID>.json" \
  | python3 -m json.tool
```

A `status` of `delivered` (not `undelivered`/`failed`) confirms the phone
actually received it.

**Automatic re-checking (no manual curl needed):** since approval timing
after registering in the Twilio Console varies (near-instant to a couple of
days), `scripts/check_twilio_delivery.py` automates the whole check above —
it sends the test message, polls Twilio for that message's delivery status,
and keeps retrying on an interval until a send comes back `delivered`, then
reports clear success and exits. It logs every attempt (status, Twilio error
code/message) to `twilio_delivery_check.log` so nothing is silent.

Since every retry is a real, billed Twilio send, it defaults to a cost
ceiling instead of retrying forever on a fixed cadence: the wait interval
starts at 30 minutes and doubles after each failed attempt (up to 4 hours
between attempts), and it gives up after 16 attempts if nothing is
delivered by then — enough attempts, at that backoff schedule, to span
roughly the "couple of days" approval window without hammering Twilio.

```bash
# Keep re-checking with growing backoff (default) until delivered or the
# default attempt cap (16) is reached:
python3 scripts/check_twilio_delivery.py

# Run it in the background so you don't have to babysit it:
nohup python3 scripts/check_twilio_delivery.py > twilio_delivery_check.log 2>&1 &

# Custom starting interval (seconds) between attempts:
python3 scripts/check_twilio_delivery.py --interval 900

# Give up after N attempts instead of the default cap (0 = unlimited):
python3 scripts/check_twilio_delivery.py --max-attempts 20

# Disable backoff and retry on a fixed interval:
python3 scripts/check_twilio_delivery.py --backoff-multiplier 1

# Single check-and-exit (useful for cron instead of a long-running loop):
python3 scripts/check_twilio_delivery.py --once
```

Exit code `0` means delivery was confirmed; `1` means it gave up after
`--max-attempts` without confirming; `2` means `.env` is misconfigured.

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

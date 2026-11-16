# Handoff — SniffMaster email alerts + perf work (Nov 15, 2026)

## Email alerts (Brevo) — setup done, redeploy BLOCKED

- Brevo "Sniff API" key **reactivated Nov 15** — status Active, expires July 5, 2027.
  No new key was created.
- Brevo sender: `Beckify <trevorjohnbeck@gmail.com>` — Verified. That email is the
  alert sender.
- Vercel (project `sniffmaster-web`, prod domain `sniff.beckify.com`):
  - `BREVO_API_KEY` already existed (Production + Preview, added Jul 4) holding the
    reactivated key's value — left unchanged.
  - `ALERT_EMAIL_FROM` did not exist — **created as a Production secret**
    (`trevorjohnbeck@gmail.com`). Takes effect only after a new deployment.
- **Redeploy is blocked on Vercel identity verification.** Clicking Redeploy on the
  current production deployment (main, "Merge pull request #76 from
  becktj90/remove-text-alerts") opens a "Verify Your Identity" dialog that offers
  only: 6-digit authenticator code, passkey, or recovery code. No emailed-code
  option. Trevor's Microsoft Authenticator has **no Vercel entry** (only OpenAI +
  Microsoft Entra ID); several authenticator codes tried Nov 15 were not accepted
  and the passkey attempt did not complete. The dialog is still open on the code
  screen. Until verification succeeds, `/api/alerts` cannot show `email: true`
  (currently `email: false, sms: false, push: true`).
- Next step: Trevor verifies in the dialog (authenticator code from wherever his
  Vercel 2FA lives, a passkey, or a Vercel recovery code) — or redeploys from his
  own Vercel app/dashboard. Then confirm `/api/alerts` shows `email: true`.

## Text/SMS signup — REMOVED (PR #76, live)

PR #76 merged Nov 15 (`f3c373f`). `channelStatus()` reports `sms: false`
permanently; UI Text option gone. Owner SMS path in `web/lib/notify.js`
(ClickSend) deliberately untouched. ClickSend is out of credit.

## Perf fixes — PR #77 merged, NOT yet live

PR #77 merged Nov 15 (`130d05e`, branch `perf/home-payload-cache`), tests
101/101 green. Production still reports version `f3c373f` as of ~11:38 AM Nov 15
— the deploy had not picked it up yet. Changes: `buildHomePayload` Redis cache
(60s TTL), alert-eval gating on near-threshold snapshots, `/api/oled` s-maxage
30→60, sensors 24h reads compact `home_fine` series, firmware drops the
`fetchHomeStats()` poll (home-stats scalars now ride in the OLED feed).

## Firmware — needs re-flash + compile check

- The ESP32 must be **re-flashed** for the `fetchHomeStats()` removal to take
  effect. Old firmware keeps calling `/api/home-stats`, which still works
  (server is backwards compatible).
- The C++ change (`firmware/src/main.cpp`) was **not compile-verified** in the
  VM (no PlatformIO installed, no CI for firmware). Run `pio run` before
  flashing.

## Alert channels (live, Nov 15)

- Email: Brevo, 300/day free tier — setup above, pending redeploy.
- App push: ntfy.sh — verified working live Nov 15 (server-side publish 200).
  This VM's egress blocks ntfy.sh, so topics can't be polled from here.
- SMS: no free route. Options researched: textbee (needs spare Android),
  AWS SNS sandbox (already wired in `notify.js`, ~$0.30/mo at this volume,
  needs live test), Textbelt demo (1/day). Owner decision pending.

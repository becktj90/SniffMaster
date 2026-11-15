# SniffMaster Pro — Hosting, Alerts & UI: Feasibility + Recommendations

_Assessed 2026-11-14 against **GitHub `origin/main` @ aa2b82a** (becktj90/SniffMaster).
This is the handoff memo, checked in after PRs #58–#66. origin/main was at 7ed808d when the memo was written; this copy is added with origin/main at c8de25e. Line numbers were taken against aa2b82a, so re-check them before editing code.
Pricing was checked against current public pages; re-verify before you depend on a hard limit._

## TL;DR

| Area | Already on main | Recommendation |
|---|---|---|
| **Hosting (now)** | Vercel Hobby + Upstash Redis, functions consolidated via `api/extras.js` | **Keep it, but cut polling** (see "Fix first"). One always-open tab costs ~4× the Upstash free tier's daily average. |
| **Hosting (target)** | — | **Cloudflare Workers + one Durable Object** (free plan): SQLite history, hibernating WebSocket push to browsers, DO alarm for stale-device checks. Keep the `/api/*` contract so firmware only changes its base URL. |
| **Alerts** | ntfy (owner + guest topics) sent in parallel with SMS (AWS SNS → ClickSend fallback); daily-summary Vercel cron | **Keep ntfy as the trusted channel.** SMS is optional and flaky (SNS sandbox drops, carrier filtering). Add **device-offline alerts**: a once-a-day Vercel Hobby cron can't do it, so use Healthchecks.io or a DO alarm. Phase 2: PWA Web Push. |
| **UI** | Vanilla PWA (`public/app.js` ~5 K lines, `home.js`, `guest.html`, `report.html`); SW is already network-first for navigations | Keep it static. Pause all polling when `document.hidden`. If you're rewriting, use Vite + Preact/Svelte + uPlot. |

## Current load math (still true on origin/main)

Sources: `web/api/extras.js:908-960` (sniff-stream), `web/public/app.js:80,5030-5032`, `firmware/src/main.cpp:790,793`, `web/lib/store.js` (no pipeline).

**Upstash free = 500 K commands / month (~16.6 K/day).** The "10 k/day" in DEPLOYMENT.md is the pre-2025 limit.

| Source | Rate | Redis cmds/day |
|---|---|---|
| Device `POST /api/update` | 60 s × ≥3 cmds | ≥4,320 |
| Device command poll | 20 s × 1 | 4,320 |
| One open tab: SSE sniff-stream | `getLatestSniff()` every **1.5 s** | **~57,600** |
| One open tab: `fetchLatest` / history / sniff-history | 10 s / 80 s / 40 s | ~11,800 |
| **Per always-open tab** | | **~69 K/day** |

**Vercel Hobby = 1 M invocations/mo and 4 h active CPU. It is non-commercial, has no overages, and gets paused when you exceed a limit.** The device makes ~173 K invocations/mo and each always-open tab ~450 K/mo, so **two wall tabs exceed Hobby.** The public guest page adds viewers on top of that.

## Fix first (cheap, keeps the current stack)

1. **sniff-stream (`api/extras.js` ~L908)**: stop polling Redis every 1.5 s. Either drop SSE and carry the sniff `seq` in `/api/latest`, or poll every ≥10 s. This is the biggest win, ~83 % of per-tab cost.
2. **`public/app.js` / `home.js` / guest page**: pause every `setInterval` and close the EventSource while `document.hidden`. Back off to 30–60 s when `receivedAt` is unchanged. Cache `/api/guest` at the edge (`Cache-Control: s-maxage=30`) so public viewers don't each hit Redis.
3. **Firmware + `api/update.js`**: return any pending command in the `/api/update` response, and drop or stretch the 20 s `COMMAND_POLL_MS` to ≥60 s.
4. **`lib/store.js`**: batch set + lpush + ltrim with `redis.pipeline()` (1 HTTP round-trip).
5. **DEPLOYMENT.md**: fix the quota numbers.

After these changes: device ≈ 4–5 K/day plus ≤8.6 K/day per visible tab, which fits the free tier.

## Hosting options assessed

| Option | Free-tier fit | Real-time | Migration effort | Verdict |
|---|---|---|---|---|
| **Vercel + Upstash (current)** | OK only after the fixes | Polling | 0 | ✅ Keep short-term |
| **Cloudflare Workers + Durable Object (SQLite)** | 100 K req/day, 5 GB DO storage, idle hibernating WS isn't billed | **WebSocket push** | Medium: port handlers; `@resvg/resvg-js` (report-card PNG) needs the WASM build; AWS SNS SDK → plain `fetch` | ⭐ Best target |
| Supabase | Good | Push | Medium | ⚠️ Free projects pause after ~7 days of inactivity |
| Firebase | Good | Push | Medium; heavy on ESP32 | OK, more lock-in |
| MQTT broker (HiveMQ/EMQX free) | Good | Push to the device too | High: new firmware transport | Only if you need a sub-second downlink |
| Adafruit IO (firmware already posts every 30 s) | 30 pts/min | Polling/MQTT | — | Too limited to be the main backend; consider dropping it to save device TLS time |
| Self-hosted VPS | Paid or sleeps | Any | High | Not worth it |

## Alerts assessment

| Channel | Status | Verdict |
|---|---|---|
| **ntfy.sh** (owner + guest topics) | ✅ on main | ⭐ Primary. Keep the topics long and random. Consider an ntfy access token if a topic ever leaks. |
| SMS via AWS SNS → ClickSend | ✅ on main | Optional. SNS sandbox and toll-free/A2P rules make delivery unreliable. Paid per message. |
| **Device-offline alert** | ❌ missing | **Add.** Healthchecks.io (free; the device or `/api/update` pings it, and it alerts via ntfy/email when pings stop), or a CF DO alarm after migration. |
| PWA Web Push (VAPID) | ❌ | Phase 2: free, iOS 16.4+ home-screen installs only, needs subscription storage. |
| Pushover / Telegram / Discord | — | Fine alternatives. No need while ntfy works. |

Alert hygiene: rate-limit event alerts (e.g., ≤1 per 10 min unless the tier escalates), and keep all alert/LLM secrets server-side.

## UI assessment

- Keep a static PWA (it works on Vercel or Cloudflare unchanged). The SW navigation handling is already network-first. ✅
- Biggest UI cost is polling, not rendering: add visibility-based pausing on all three pages.
- If rewriting: Vite + Preact or Svelte, uPlot for time series, static output. Avoid Next.js.

## Security / privacy (public repo)

1. **The same `WEB_DASHBOARD_KEY` the device uses now is in public GitHub history** (commits 3e78c90, 35fb251, confirmed by the firmware session). `git rm` doesn't help: **rotate `SNIFFMASTER_API_KEY` in Vercel and reflash.** Rewriting history is optional once the key is rotated.
2. **A personal phone number is committed** in `web/.env.example` (`ALERT_SMS_TO`) and reportedly as the default in `web/lib/notify.js`. Replace it with a placeholder and require the env var.
3. Firmware still calls `api.openai.com` directly (`main.cpp` ~L3308, ~L5237), which puts an OpenAI key on the device. Route through `/api/weather-briefing` and remove it.
4. Local repo: ~1,090 `firmware/.venv` files are staged, and its history is unrelated to GitHub. Don't push from it.

## Per-agent handoff

- **Dashboard rebuild** (`feature/dashboard-rebuild` worktree): fixes 1–2 and edge caching on `/api/guest`. Web Push subscribe UI is phase 2.
- **Firmware**: fix 3 (command via the POST response), remove direct OpenAI calls, optionally a Healthchecks ping. Reflash with the rotated key.
- **Backend (`web/api`, `web/lib`)**: fixes 3–5, the device-offline alert, and removing the phone number. Phase 3: Cloudflare Worker + DO prototype behind the same `/api/*` contract.

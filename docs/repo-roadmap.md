# Repository Roadmap

## Suggested tags
- `v0.4-arduino-sketch-baseline`
- `v0.5-platformio-migration`
- `v0.6-loop-stability`
- `v0.7-web-cache-fix`

## Suggested issues
1. Split current `main.cpp` into modules.
2. Remove duplicate UI listeners in web app.
3. ~~Make service worker network-first for HTML shell.~~ Done — `web/public/sw.js` v45 serves navigations network-first with cached-shell fallback.
4. Add firmware serial health metrics.
5. Add BLE-off and ML-off test modes.
6. ~~Slim `/api/history` payloads.~~ Done — `/api/history?fields=dash` projects each entry to the 17 fields the dashboard reads; the dashboard now requests it (~5x less JSON per 80s poll).

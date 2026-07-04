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
6. Slim `/api/history` payloads: the dashboard pulls up to 1008 full snapshots (~all fields incl. 20-element odor arrays and text quips) every ~80s; a `fields=` projection could cut that transfer ~5x.

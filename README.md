# SniffMaster Pro

Monorepo for the SniffMaster Pro embedded firmware, hosted web dashboard, and supporting docs/tools.

## Layout

- `firmware/` — ESP32 PlatformIO project migrated from the Arduino sketch
- `web/` — Vercel-hosted dashboard and API relay
- `docs/` — architecture notes and stabilization roadmap
- `tools/` — future data/ML utilities

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
5. Fix service-worker shell caching in the web app.

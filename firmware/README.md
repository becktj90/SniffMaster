# Firmware

SniffMaster Pro sketch as a PlatformIO project (`default_envs = xiao_esp32c3`).

## How it runs

- `loop()` owns the sensor, button, buzzer, and OLED. It never touches the network.
- A FreeRTOS `net` task (lower priority) does Wi-Fi, the dashboard post (`/api/update`, every 60 s or on events), command polling, `/api/home-stats`, `/api/environment`, and the OpenAI summary. Slow HTTPS can't freeze the screen. A gas scan sets `scanBusy` and the net task skips TLS until BSEC is restarted.
- Shared state crosses tasks only through short copies under a mutex.
- Serial prints `[LOOP] max=…ms` every 10 s. On a healthy device it stays well under 100 ms.

## Display

Metric cards advance every 5 s; a button tap jumps to the next one, and a hold forces a dashboard sync.
Cards: Home Score (from the dashboard), IAQ, VOC, CO₂ estimate, temperature, humidity, pressure, smells, allergens & mold (from the dashboard), outdoor, "SniffMaster Says" (OpenAI), network.
Each sensor card shows the value, a range bar, and a 32-minute history bar graph.

An OLED health check re-initialises the panel (with I²C bus recovery) if it stops ACKing.

## Sound

The buzzer is used only for hazardous air: smoke/gas score ≥ 40, IAQ ≥ 250, or CO₂ estimate ≥ 2500 ppm, with hysteresis. It repeats every minute while the hazard lasts; a tap mutes it.

## Secrets

Copy `include/secrets.h.example` → `include/secrets.h` (Wi-Fi, `OPENAI_API_KEY`, `OPENAI_MODEL`) and `include/web_dashboard_config.h.example` → `include/web_dashboard_config.h`. Both are gitignored. With no OpenAI key, the summary card shows the dashboard's headline instead.

## Optional Home-mode sensors

`include/home_sensors.h` is a stub for PM, true CO₂, HCHO, and Sensirion VOC/NOx indexes. Build with `-DSM_HOME_SENSORS=1` and fill in `pollHomeSensors()` for the sensor you own. Default builds don't compile it.

## Sensor and outdoor-environment plan

BME688 work and the Google pollen / air-quality / weather integration follow `docs/firmware-bme688-google-env-plan.md`.

Phases 1–4 are implemented:

- Phase 1: bme680 IAQ config, LP only, valid-gas-only resistance, versioned BSEC state restore with a boot-loop guard, and the `co2eq` / `bsecCfg` / `bsecBundle` / `gasValid` / `gasPctValid` / `runIn` / `stab` / `tempRawC` / `humRaw` payload keys. Raw temperature and humidity stay off unless `SM_BSEC_RAW_EXTRAS=1`.
- Phase 2: portal action `gas_scan` runs the Bosch sequential heater profile (`bme68x-seq-3-v1.1.40407`, three steps from the v1.1.40407 example). The loop task borrows the sensor, logs `GASSCAN` lines, posts `gasScan` once, and restarts BSEC from the saved state.
- Phase 3: the device posts to `/api/environment`. The server calls Google (or Open-Meteo when Google is unset or fails) and never returns the API key. Pollen stays on the monthly cap in `web/lib/pollen.js`.
- Phase 4: on-device dew point, 90-minute pressure trend, ventilation (`open` / `brief` / `shut`), and `roomScore` from static IAQ. `airScore` stays on dynamic IAQ. Pollen changes ventilation only.

Phase 5 (a BME AI-Studio classifier) is not implemented. It waits on a labeled set of `GASSCAN` lines.

## Next refactor targets

1. Extract display code into `lib/display/`
2. Extract sensor/BSEC path into `lib/sensor/`
3. Extract cloud/web relay into `lib/cloud/`

# Firmware plan: BME688 full use and Google outdoor context

This document is the prompt for firmware work. Implement one phase at a time, in order. Do not start the next phase in the same change. Paste the phase block at the bottom into the agent and point it at this file.

The device is a Seeed XIAO ESP32-C3 by default (`firmware/platformio.ini`, `default_envs = xiao_esp32c3`), with a BME688 on Grove I2C address `0x76`, an SSD1306 OLED, and the hosted dashboard in `web/`. Almost all sensor and network behavior lives in `firmware/src/main.cpp`.

## What "full potential" means here

The BME688 is a heated metal-oxide gas sensor plus temperature, humidity, and pressure. Its gas channel is a fingerprint across heater steps, not a pollen counter and not an NDIR CO2 meter. Bosch BSEC2 turns the standard one-step profile into IAQ, static IAQ, breath-VOC equivalent, and a VOC-derived CO2 equivalent. A separate 10-step heater scan is what makes selective odor work possible. Those two modes share one sensor and one BSEC instance. They are not both free at once.

Google Maps Platform supplies the outdoor context the BME688 cannot measure: pollen, particulate and combustion pollutants, and weather. The Google API key stays on the server. The ESP32 only receives a small JSON summary.

In scope:

- Every BSEC output the loaded IAQ config actually produces, with invalid gas samples rejected.
- The BME688 IAQ config, on every board, instead of the BME680 blob that only the C3 loads today.
- Calibration state restored on the C3, which is the default board and currently skips restore.
- Dew point and a multi-hour pressure tendency computed on the device from the BME688.
- An on-demand 10-step gas scan for labeling and a future model. The scan is not the always-on loop.
- Outdoor pollen, US EPA AQI, pollutant concentrations, and weather, located with Wi-Fi geolocation when a scan is available.

Out of scope:

- Treating gas resistance as pollen, PM2.5, or true CO2.
- Loading a BME AI-Studio config into the default firmware. That config replaces Bosch IAQ.
- Retraining SmellNet or changing `scoreOdors()` input width.
- Google map tiles, Places, Routes, or the Solar API.
- Moving the LC-36 daily SMS forecast in `web/lib/forecast.js` off Open-Meteo.
- Putting `GOOGLE_MAPS_API_KEY` in `firmware/include/secrets.h`.

## Current behavior the next agent must not rediscover

BSEC setup is in `setup()` and `subscribeBsecOutputs()`:

- `envSensor.begin(BME68X_I2C_ADDR_LOW, Wire, safeBmeDelayUs)` then, on the C3 only, `envSensor.setConfig(bsecIaqLpConfig)` from `config/bme680/bme680_iaq_33v_3s_4d/bsec_iaq.txt`. S3 and C2 never load that blob, so they often fall through to ULP.
- Subscribed outputs: breath VOC, IAQ, static IAQ, CO2 equivalent, heat-compensated temperature and humidity, raw pressure, raw gas, compensated gas, gas percentage, stabilization, run-in. The fallback list drops compensated gas and gas percentage.
- Sample rate is `BSEC_SAMPLE_RATE_LP` (3 s). If that subscribe fails, the code retries the safe list at ULP (about 300 s). ULP misses every transient this product exists to catch. After the 3 s config loads on all boards, delete the ULP fallback.
- `onSensorData()` copies virtual sensors and ignores `bme68xData.status`. Samples with `gas_valid` or `heat_stable` clear still update `latestGasR`.
- `loadBsecState()` sets `skipBsecRestore = true` on the ESP32-C3. The default board throws away the blob that lets IAQ accuracy survive a reboot. The 4-day config (`4d` in the filename) cannot reach accuracy 3 if every boot is a cold start.
- SmellNet (`firmware/include/smellnet_inference.h`) is a 10-input MLP: VOC, IAQ, CO2eq, temp F, humidity, hPa, log gas resistance, dVOC, and two ratios. It never sees a heater-step vector. `emitLabelData()` logs those scalars only.
- Sulfur confidence is `ss_scores[OD_SULFUR]`, not a BSEC VSC channel. The comment above `bsecIaqLpConfig` already says a gas-scan config is future work.
- Outdoor weather is `fetchWeather()` against `http://wttr.in/`. Outdoor pollutants are `fetchOutdoorAQI()` against OpenWeatherMap `air_pollution` (AQI 1–5) or Open-Meteo `us_aqi` (0–500). `computeAirScore()` special-cases both scales. The dashboard `aqiColor()` in `web/public/app.js` is the EPA scale (50 / 100 / 150 / 200). An OWM value of 1–5 is painted as "good".
- Location is IP geolocation from `http://ip-api.com/json/` in `fetchLocation()`. There is no GPS chip. Comments that say "GPS" mean this IP fix. A sensor in a truck and the site forecast are different places: `web/lib/forecast.js` pins the daily report to LC-36 (`28.4707, -80.5405`) on purpose.
- `sendToWebDashboard()` posts one JSON document (`StaticJsonDocument<6144>`) to `/api/update`. Existing keys must keep their names and units. Add keys; do not rename `co2`, `iaq`, `gasR`, `outdoorAqi`, or `odors`.
- `pollPortalCommand()` parses `/api/command` into `StaticJsonDocument<384>` and treats HTTP 204 as "no command". Do not stuff the outdoor payload into that response. The command route is in `web/api/extras.js` (`ALLOWED_ACTIONS` is `refresh`, `breath_check`, `presence_probe`).
- `loop()` must stay responsive. TLS is already skipped when RSSI is worse than about -80 dBm, BLE is quieted first, and cloud work is interval-gated. New network work uses that pattern. No `delay()` inside the sensor path except the existing scan command, which is allowed to block because it is manual.

`co2` in every payload is BSEC CO2 equivalent, estimated from VOCs. Do not scale it against outdoor CO, and do not describe a new field as occupancy-grade CO2. Personnel thresholds in `web/lib/thresholds.js` already treat the number as CO2 ppm. Leave those thresholds alone. Add `co2eq` as a duplicate of the same number so new copy can be honest, and keep sending `co2`.

## Hard rules for every phase

- Default build remains `USE_ML_SCORING` and `USE_WEB_DASHBOARD`. Do not require `secrets.h` to contain a Google key.
- Match the surrounding C++ style. This file is one sketch with sections, not a new framework.
- Do not split `main.cpp` into libraries in these phases. The module split in `firmware/README.md` is separate work.
- Keep the loop order: button, `envSensor.run()`, melody, then interval-gated Wi-Fi and cloud.
- A gas percentage of 0 is not a measurement when the LP-safe bundle is active. Send `gasPctValid: false` and leave the raw numbers out of that post.
- Outdoor numbers older than their TTL do not affect `computeAirScore()` or ventilation advice.
- Pollen never adds points to the room score. It only changes ventilation advice.
- If a Google call fails, the server may fill weather and AQI from the existing Open-Meteo helpers and set `source` accordingly. Pollen stays invalid. The device does not call wttr.in, OpenWeatherMap, or Google itself after Phase 3.

## Phase 1 — Make the IAQ path tell the truth

Firmware only, plus one dashboard guard so a missing gas percentage is not drawn as 0%.

### Config

Inspect the installed bsec2 package under `.pio/libdeps/<env>/bsec2/src/config/` after the first build, or the library cache PlatformIO downloaded for `boschsensortec/bsec2 @ ^1.8.2610`.

- If `bme688/bme688_iaq_33v_3s_4d/bsec_iaq.txt` exists, load that on C3, S3, and C2.
- If it does not, keep `bme680/bme680_iaq_33v_3s_4d/bsec_iaq.txt`, and load it on all three boards, not only the C3.
- Do not download a config from a gist. The blob has to be the one shipped with this library version.
- Define a string id, `bsecCfgId`, exactly `bme688_iaq_33v_3s_4d` or `bme680_iaq_33v_3s_4d`.

Stop falling through to `BSEC_SAMPLE_RATE_ULP`. If the full LP list fails, subscribe the existing LP-safe list at LP. If that also fails, log the BSEC status and retry on the existing first-packet retry path. Record the active bundle as `full` or `safe`.

Subscribe two extra outputs when the status code says the config allows them:

- `BSEC_OUTPUT_RAW_TEMPERATURE`
- `BSEC_OUTPUT_RAW_HUMIDITY`

If adding them causes `BSEC_W_SU_SAMPLERATEMISMATCH`, drop only those two and keep the rest. Do not subscribe `BSEC_OUTPUT_GAS_ESTIMATE_1` through `_4` on this config. Those outputs belong to an AI-Studio blob and will fail the subscribe.

### Valid gas samples

In `onSensorData()`, update `latestGasR` only when the raw sample says the heater was stable and the gas measurement is valid. Confirm the mask names in the installed `bme68x_defs.h` (`BME68X_GASM_VALID_MSK` and `BME68X_HEAT_STAB_MSK` are the usual names). Hold the previous resistance when a sample is invalid. Still accept temperature, humidity, pressure, and the BSEC virtual sensors from that callback. Store `gasValid` for the payload.

Publish raw temperature °C and raw humidity only as diagnostics (`tempRawC`, `humRaw`). Display and scoring keep the heat-compensated values (`latestTemp`, `latestHumidity`).

### Calibration restore on the C3

Replace the C3 early-return in `loadBsecState()` with a versioned record:

- magic `0x42534332` (`BSC2`)
- version `1`
- `bsecCfgId` of the blob that produced the state
- the existing `BSEC_MAX_STATE_BLOB_SIZE` bytes

Restore only when magic, version, and config id match, then `envSensor.setState()`. A blob saved under the old raw key, or under the other config id, is a cold start: erase it. Order stays `begin()`, `setConfig()`, `setState()`, `updateSubscription()`, `attachCallback()`.

If the existing first-packet retry fires after a restore, erase the record and continue the retry without state. That is the safety valve the C3 skip was standing in for. Save with the same envelope on the existing 10-minute timer, and still save immediately when accuracy first reaches 3. Do not save when accuracy is still 0.

Home baseline persistence is unchanged.

### Payload and score

Add these keys to the dashboard post when the values exist:

| Key | Meaning |
| --- | --- |
| `co2eq` | Same number as `co2` |
| `bsecCfg` | Config id string |
| `bsecBundle` | `full` or `safe` |
| `gasValid` | Last raw gas sample accepted |
| `gasPctValid` | True only for the full bundle |
| `runIn` | `latestRunInStatus` as 0 or 1 |
| `stab` | `latestStabStatus` as 0 or 1 |
| `tempRawC` | Raw temperature, one decimal |
| `humRaw` | Raw humidity, one decimal |

When `gasPctValid` is false, omit `gasPct` and `compGas`. In `web/public/app.js`, render the gas-percentage readout as `n/a` when `gasPctValid` is false instead of coloring 0% as bad. Do not change `computeAirScore()` in this phase.

On boot, if `begin()` fails at `0x76`, try `BME68X_I2C_ADDR_HIGH` (`0x77`) once before the reboot path.

### Done when

- Serial log on boot shows the config id, `full` or `safe`, and `LP`. It never logs `ULP` for a successful subscribe.
- A sample with gas-valid clear does not move `gasR`.
- After a reboot with accuracy already 2 or 3, the log says the state loaded, and accuracy does not sit at 0 for the whole run-in. If the blob is corrupt, the log says cold start and samples still arrive.
- Dashboard JSON still contains `iaq`, `co2`, `gasR`, and `odors`.
- `pio run -e xiao_esp32c3` succeeds. Build the other envs if the toolchain is present.

## Phase 2 — On-demand 10-step gas scan

This phase records the fingerprint the IAQ profile throws away. It does not classify it.

### Heater profile

Create `firmware/include/heater_profile.h`. Copy the temperature and duration tables from the sequential-mode example in the installed Bosch BME68x library (`examples/sequential_mode` or the equivalent `.c` example under the BME68x package). Do not type a profile from memory.

The header exports:

- `HEATER_PROFILE_ID`: a short literal that includes the step count and the library version you copied from, for example `bme68x-seq-10-v1.1.40407`
- `HEATER_STEP_COUNT` (10 unless that example has a different length)
- the temperature array in °C and the duration array in milliseconds, matching the example's units
- a one-line comment naming the source file

A scan recorded under a different profile is useless for a later model. The id is part of every log line and every upload.

### When it runs

Add portal action `gas_scan`.

- `web/api/extras.js`: add it to `ALLOWED_ACTIONS`.
- `executePortalCommand()`: call `runGasScan()`.
- Do not run a scan from `loop()` on a timer.
- Refuse and log if a scan is already running, or if `ss_iaqAcc` is 0 and no state has ever been saved. A scan restarts BSEC, and a device that has never had a good blob should not be interrupted during run-in.

### How it runs

BSEC owns the sensor during `envSensor.run()`. A scan has to borrow it and give it back:

1. `getState()` into the Phase 1 envelope and save it.
2. Set `scanBusy`. While it is set, `loop()` still services the button and the buzzer, and it skips `envSensor.run()`, Wi-Fi TLS, and the dashboard post.
3. Talk to the BME688 with the BME68x library on the same `Wire` and the same address BSEC just used. Program the copied heater profile in sequential / forced scan mode, one cycle.
4. For each step, keep the resistance only when gas-valid and heat-stable are set. Store ohms as `uint32`. A missing step is `0` and a parallel `valid` bit is false. Do not interpolate.
5. `begin()` + `setConfig()` + `setState()` + `updateSubscription()` + `attachCallback()` again, then clear `scanBusy`.
6. If re-begin fails, use the existing init-failure reboot path. Do not continue with a dead sensor.

Expect a gap of one scan length (the sum of the step durations, typically well under 30 s) plus re-init. Accuracy after restore should come back at the saved level, not at 0. If a bench run shows accuracy stuck at 0 after a successful `setState()`, stop and report that; do not paper over it with a fake accuracy.

### Output

Serial, one line per step:

```text
GASSCAN,<profile id>,<step>,<heater C>,<duration ms>,<ohms or 0>,<valid 0 or 1>
```

On the single dashboard post after the scan, add `gasScanProfile` and `gasScan`, an array of ohms in step order. Clear both after that post so the regular 6 KB document does not carry them forever. If `serializeJson` would exceed the payload buffer, drop `launches`, `radar`, and `sassy` for that one post only.

Extend `emitLabelData()` with the same 10 ohms and the profile id when a scan result is sitting in memory, so a future training capture has the vector next to the scalar line. Do not change the SmellNet call.

OLED: one status screen during the scan, `Gas scan 3/10`, then return to the previous page. No new auto-cycle page.

### Done when

- A `gas_scan` command prints one line per heater step and the device returns to IAQ updates without a power cycle.
- The following regular post contains `gasScan` once, then stops containing it.
- SmellNet's function signature is unchanged.
- A second scan issued while the first is running is ignored.

## Phase 3 — Google pollen, air quality, and weather

The device stops calling wttr.in and OpenWeatherMap. The server calls Google and returns a fixed-shape summary.

### Server

Add `web/lib/googleEnv.js` and a device-authenticated route:

- `GET /api/environment` and `POST /api/environment`
- Wire it like the other extras: `web/server.js`, `web/vercel.json`, and a branch in `web/api/extras.js`
- Auth: the same device check `/api/command` uses (`X-SniffMaster-Key`)
- Secret: `GOOGLE_MAPS_API_KEY` in the Vercel environment only

Enable that key for the Air Quality API, the Pollen API, the Weather API, and the Geolocation API. Do not embed it in firmware, source, logs, or the JSON response.

POST body, all optional:

```json
{
  "lat": 28.4889,
  "lon": -80.5778,
  "wifi": [
    { "mac": "aa:bb:cc:dd:ee:ff", "rssi": -48, "channel": 6 }
  ]
}
```

Accept at most 8 Wi-Fi entries. Ignore SSIDs if a client sends them. Do not store the scan.

Location order:

1. If `wifi` has at least 2 access points, `POST https://www.googleapis.com/geolocation/v1/geolocate?key=API_KEY` with `considerIp: false` and those access points (`macAddress`, `signalStrength`, `channel`). Use the returned `lat`, `lng`, and `accuracy`.
2. Else if `lat` and `lon` are finite and not both near 0, use them and set accuracy to null.
3. Else use the Cape Canaveral default already in `web/api/extras.js` (`DEFAULT_LAT` / `DEFAULT_LON`) and `source: "default"`.

Cache the Google result in Redis for 30 minutes under a key that includes a geohash of 6 characters (about a kilometer) plus the location source. `web/lib/forecast.js` already shows the Redis get/set pattern. A cache hit must not include another device's Wi-Fi list.

Google calls for a cache miss, in parallel:

| API | Request | What to keep |
| --- | --- | --- |
| Pollen | `GET https://pollen.googleapis.com/v1/forecast:lookup` with `location.latitude`, `location.longitude`, `days=1`, `plantsDescription=false`, `languageCode=en` | Today only. From `dailyInfo[0].pollenTypeInfo`, the `indexInfo.value` and category for `TREE`, `GRASS`, and `WEED`. Values are the Universal Pollen Index, integers 0–5. From `plantInfo`, the in-season plant with the highest index: its `displayName` trimmed to 16 characters and its index. |
| Air Quality | `POST https://airquality.googleapis.com/v1/currentConditions:lookup` with `universalAqi: true`, `extraComputations: ["POLLUTANT_CONCENTRATION", "LOCAL_AQI", "DOMINANT_POLLUTANT_CONCENTRATION"]`, and `customLocalAqis: [{ "regionCode": "us", "aqi": "usa_epa" }]` | `indexes` entry whose code is `usa_epa`: numeric AQI and category. Also the `uaqi` index value. Pollutants `pm25`, `pm10`, `o3`, `no2`, `so2`, `co`. Dominant pollutant code. |
| Weather | `GET https://weather.googleapis.com/v1/currentConditions:lookup` with `location.latitude`, `location.longitude`, `unitsSystem=IMPERIAL`, `languageCode=en` | Condition text, temperature, feels-like, dew point, heat index, humidity, wind speed and direction, gust, precipitation probability, thunderstorm probability, UV index, cloud cover, pressure, visibility. Read each quantity's unit field and convert. |

Confirm each method against the official reference while implementing. The three methods above are the contract. Hourly forecast endpoints are optional and must not be required for the device payload. Do not request pollen plant descriptions or photos. Do not call heatmap tile endpoints from firmware or from this route.

Normalize on the server before responding:

- Temperatures in Fahrenheit, integer.
- Wind and gust in mph, integer.
- Pressure in hPa, one decimal. Google imperial pressure may arrive in inches of mercury; convert (1 inHg = 33.8639 hPa).
- Pollutant concentrations in µg/m³, one decimal. Convert ppb with `µg/m³ = ppb * molecular_weight / 24.45` at 25 °C (CO 28.01, NO2 46.01, O3 48.00, SO2 64.07). PM values are already µg/m³.
- US AQI as an integer 0–500. Never return the OpenWeatherMap 1–5 index in `usAqi`.
- Pollen indexes as integers 0–5, or omit the pollen object if the call failed.

If Google weather or air quality returns an error, fill those sections from Open-Meteo (the URLs already used in `web/api/extras.js`) and set `source` to `open-meteo`. Leave pollen out. If everything fails, respond 200 with `{ "ok": false }` so the device keeps its previous sample until TTL.

Response shape, target under 900 bytes, hard cap 1100:

```json
{
  "ok": true,
  "source": "google",
  "ttlSec": 1800,
  "loc": { "lat": 28.4889, "lon": -80.5778, "accM": 40, "source": "wifi", "label": "Cape Canaveral" },
  "wx": {
    "cond": "Partly cloudy",
    "tempF": 74,
    "feelsF": 76,
    "dewF": 68,
    "heatF": 78,
    "rh": 80,
    "windMph": 12,
    "gustMph": 18,
    "windDir": "NE",
    "precipPct": 20,
    "thunderPct": 5,
    "uv": 6,
    "cloudPct": 40,
    "pressHpa": 1016.2,
    "visMi": 10
  },
  "aq": {
    "usAqi": 42,
    "cat": "Good",
    "uaqi": 80,
    "dom": "pm25",
    "pm25": 8.2,
    "pm10": 14.0,
    "o3": 30.0,
    "no2": 6.0,
    "so2": 1.0,
    "co": 220.0
  },
  "pollen": {
    "tree": 3,
    "grass": 1,
    "weed": 0,
    "top": "Oak",
    "topIdx": 4
  }
}
```

`label` is optional. Reverse-geocode only when the location source is `wifi`, and cache it with the same Redis entry. Skip it on failure.

`cond` must fit 21 characters. `cat` is the EPA category string Google returns (`Good`, `Moderate`, `Unhealthy for Sensitive Groups`, and so on), trimmed so the OLED line still fits; the device may show only the first 8 characters of the category.

There is no NH3 field. Google's air-quality pollutant list does not include ammonia. Delete the ammonia branch from the device-side cause guess rather than sending 0.

### Firmware

Replace `fetchWeather()` and `fetchOutdoorAQI()` with one function, `fetchGoogleEnv()`, called from the existing weather queue on `WEATHER_REFRESH_MS` (10 minutes). Delete the wttr.in and OpenWeatherMap HTTP calls. Keep `fetchWeatherFacts()` (Death Valley and moon) as it is.

Before the request, if Wi-Fi is connected and a scan is not already running, start an async scan (`WiFi.scanNetworks(true)`), collect up to 8 BSSIDs with RSSI and channel, and POST them. Do not scan more often than every 15 minutes. If the scan fails or returns fewer than 2 APs, POST the last lat/lon from `fetchLocation()` instead. Keep `fetchLocation()` as the coarse fallback. Never block `loop()` on `WiFi.scanComplete()` for more than one pass: start the scan, and read it on a later iteration.

Parse with `StaticJsonDocument<1536>`. Reject a body larger than 1100 bytes. Map into the existing structs so the rest of the sketch keeps compiling:

- `weather.tempF`, `feelsLikeF`, `humidity`, `condition`, `windDir`, `windSpeed` (write `windSpeed` as `"12 mph"`).
- `outdoorAqi.aqi` becomes US AQI 0–500. `outdoorAqi.level` is `aq.cat`. Concentrations are the µg/m³ values. `outdoorAqi.nh3` stays 0 and is not displayed.
- New small struct for pollen indexes, top plant, dew point F, heat index F, UV, precip percent, Google pressure hPa, location accuracy, `source`, and `fetchedAt`.

`computeAirScore()` outdoor points use only the EPA scale:

| US AQI | Points |
| --- | --- |
| 0–50 | 0 |
| 51–100 | 2 |
| 101–150 | 4 |
| 151–200 | 7 |
| 201–500 | 10 |

Missing or stale AQI adds 0. Delete the 1–5 lookup table.

Rewrite the cause/advice text in the old `fetchOutdoorAQI()` path to use µg/m³ thresholds that match the units you actually store, and drop the ammonia case. Keep the advisory short enough for the existing 200-byte buffer.

Dashboard post: keep `outdoorAqi`, `outdoorLevel`, `outdoorPm25`, `outdoorPm10`, `outdoorCo`, `outdoorNo2`, `outdoorO3`, `outdoorSo2`. Add `outdoorUaqi`, `pollenTree`, `pollenGrass`, `pollenWeed`, `pollenTop`, `envSource`. Omit pollen keys when pollen is invalid. Update `lat`, `lon`, and `city` when the response location source is `wifi`.

Do not change `web/lib/forecast.js`. The daily LC-36 report stays on its fixed coordinates.

### OLED weather page

`renderWeatherPage()` is six text rows on a 128×64 panel, 21 characters each. Replace the moon row. Keep moon phase on the web payload via the existing facts fetch.

| Row | Example |
| --- | --- |
| Header | `-- Weather --` |
| 1 | `74F feel 76` |
| 2 | `Partly cloudy` |
| 3 | `NE 12  AQI 42` |
| 4 | `PM2.5 8 Good` |
| 5 | `Pol T3 G1 W0 Oak` |

When pollen is invalid, row 5 is `Pollen --`. When the sample is stale, row 2 is `Env data stale`.

### Done when

- The device binary contains no `wttr.in` and no `openweathermap.org` URL.
- A mocked `/api/environment` body with `usAqi: 160` and pollen tree `5` shows `AQI 160` and `T5` on the OLED, and `computeAirScore()` adds 7 outdoor points, not the old "greater than 5 means EPA fallback" accident.
- `usAqi: 3` must not be treated as "Fair" on the 1–5 scale. The server never sends that scale.
- With `GOOGLE_MAPS_API_KEY` unset, the route still returns Open-Meteo weather and AQI, `source: "open-meteo"`, and no pollen object.
- The Google key does not appear in firmware, in the response, or in a log line.

## Phase 4 — Fuse the indoor sensor with the outdoor context

Still no new classifier. This phase uses measurements the BME688 is actually good at, and stops the device from recommending open windows into pollen or dirty outdoor air.

### Dew point, on device

From heat-compensated Celsius temperature `T` and relative humidity `RH` (Magnus):

```text
a = 17.625
b = 243.04
gamma = ln(RH / 100) + (a * T) / (b + T)
dewC = (b * gamma) / (a - gamma)
```

Send `dewF`. This is the indoor dew point. Google's `wx.dewF` is the outdoor dew point. Do not overwrite one with the other.

### Pressure tendency, on device

Append heat-compensated or raw pressure in hPa to a 12-slot ring, one sample per 15 minutes. Label the tendency only after at least 6 samples (90 minutes):

- `falling` if newest minus oldest is less than or equal to -1.6 hPa
- `rising` if the delta is greater than or equal to +1.6 hPa
- `steady` otherwise

Send `pressTrend` as that string. If both the BME688 pressure and `wx.pressHpa` are valid and they differ by more than 8 hPa, send `pressDisagree: true`. Do not "correct" the sensor to the forecast. A disagreement means the location fix is wrong or the sensor reading is stuck, and the log line should say which pressures were compared.

Show the tendency in the weather header as `rising`, `steady`, or `falling` when it exists. Drop it if the header would exceed the width; the payload still has it.

### Ventilation advice

Compute one enum after each sensor sample and after each environment refresh. First match wins. Stale means the environment sample is older than `ttlSec`, or `ok` was false.

| Order | Condition | `vent` |
| --- | --- | --- |
| 1 | Outdoor sample stale or missing, and static IAQ > 150 or CO2eq > 1200 | `brief` |
| 2 | Outdoor sample stale or missing | `open` |
| 3 | US AQI ≥ 100, or PM2.5 ≥ 35 µg/m³, or any pollen index ≥ 4 | `shut` |
| 4 | Indoor RH ≥ 65% and outdoor dew point F ≥ indoor temp F − 2 | `shut` |
| 5 | Static IAQ > 150, or CO2eq > 1200, or smoothed VOC > 3, and US AQI ≤ 50 and every pollen index ≤ 2 | `open` |
| 6 | Static IAQ > 150, or CO2eq > 1200, or smoothed VOC > 3 | `brief` |
| 7 | Otherwise | `open` |

Pollen indexes count as 0 when the pollen object was omitted. Send `vent` as `open`, `brief`, or `shut`.

OLED environment page (`renderEnvPage`): one extra short token if it fits, `Vent shut` / `Vent open` / `Vent brief`. Do not remove the existing indoor readings to make room. If the page is full, skip the token; the dashboard field is the source of truth.

`checkAirAlerts()` may raise the existing advisory path when `vent` transitions to `shut` because US AQI or pollen crossed the threshold. Use the current alert cooldown. Do not add a new melody.

Leave `airScore` on dynamic IAQ. Add `roomScore`, same function with `latestStaticIAQ` in place of dynamic IAQ, so a short odor event does not define the background room number. Alerts keep using the dynamic score.

### Done when

- A fixture with indoor IAQ 40, indoor RH 45, US AQI 40, and tree pollen 5 produces `vent: "shut"` and does not add pollen into `airScore`.
- A fixture with static IAQ 180, US AQI 30, and all pollen indexes ≤ 2 produces `vent: "open"`.
- `dewF` changes when humidity changes and stays independent of `wx.dewF`.
- `pressTrend` stays empty until 90 minutes of samples exist. A unit test or a host-side extraction of the ring function is enough; do not block on a 90-minute hardware soak.
- Existing alert thresholds and SmellNet outputs are unchanged.

## Phase 5 — Do not do this until labeled scans exist

This phase is a decision, not a default implementation. An agent asked to implement Phases 1–4 must stop before it.

Bosch documents that a BME AI-Studio `.config` replaces the standard IAQ algorithm inside the same BSEC instance. Loading one beside the current config will drop IAQ, static IAQ, breath VOC, and CO2 equivalent, which the dashboard, the air score, and the alerts all require. Two BSEC instances on one BME688 are not a supported layout.

When a labeled set of `GASSCAN` lines exists:

- Prefer retraining the SmellNet MLP with the current 10 scalars plus the scan vector (log resistance per step, and each step divided by step 0). That keeps BSEC IAQ. It is a new model file and a new `scoreOdors()` signature, behind a compile flag, with the old model as the fallback when a scan is absent.
- Ship an AI-Studio config only as a separate PlatformIO env, `xiao_esp32c3_scan`, which does not pretend to emit Bosch IAQ. Read `BSEC_OUTPUT_GAS_ESTIMATE_1` through `_4` only in that env, and only after `updateSubscription` succeeds.

Until that dataset exists, sulfur stays a SmellNet-derived class. Do not invent a VSC formula from a single gas resistance.

## Copy-paste prompts

### Phase 1

```text
Implement Phase 1 of docs/firmware-bme688-google-env-plan.md in the SniffMaster repo. Do not implement later phases.

Work in firmware/src/main.cpp and the gas-percentage display in web/public/app.js. Load the BME688 3-second IAQ config from the installed bsec2 library when that file exists, otherwise the BME680 3-second config, on every board. Stay on the LP sample rate. Restore BSEC state on the ESP32-C3 only when the config id matches. Reject raw gas samples that are not heat-stable and gas-valid. Keep every existing dashboard JSON key. Do not add a Google client, a heater-scan mode, or a SmellNet change.
```

### Phase 2

```text
Implement Phase 2 of docs/firmware-bme688-google-env-plan.md. Phase 1 is already done. Do not implement Phases 3–5.

Add an on-demand gas_scan portal command that runs the Bosch sequential heater profile copied from the installed BME68x example, logs each step, posts gasScan once, and restarts BSEC from the saved state. Do not change scoreOdors or run the scan on a timer.
```

### Phase 3

```text
Implement Phase 3 of docs/firmware-bme688-google-env-plan.md. Phases 1 and 2 are already done. Do not implement Phases 4 or 5.

Add web/lib/googleEnv.js and GET/POST /api/environment. The server calls Google Pollen, Air Quality, and Weather, plus Geolocation when the device posts Wi-Fi BSSIDs. The Google key is server-only. The device replaces wttr.in and OpenWeatherMap with that endpoint. outdoorAqi becomes US EPA AQI. Pollen is displayed and uploaded, and it does not enter the air score. Leave the LC-36 Open-Meteo forecast alone.
```

### Phase 4

```text
Implement Phase 4 of docs/firmware-bme688-google-env-plan.md. Phases 1–3 are already done. Do not implement Phase 5.

Add on-device dew point and pressure tendency from the BME688, the ventilation enum in the plan, and roomScore from static IAQ. Keep airScore on dynamic IAQ. Pollen and outdoor AQI can force vent to shut; they still do not add a separate pollen term to the score.
```

## Suggested bench checks

Use the XIAO ESP32-C3 and the real BME688 for Phases 1 and 2. For Phase 3, a local `web/server.js` with a stubbed `fetch` is enough to prove the device parser; a live Google key is only needed to prove the server mapping.

| Check | Pass |
| --- | --- |
| Boot log | Config id, bundle, `LP`, and either `state loaded` or `cold start` |
| Hold the sensor in clean air, then reboot | Accuracy does not reset to a long run-in when a matching blob exists |
| Breathe across the sensor once | `gasR` moves, and a following stable sample is kept |
| `gas_scan` | 10 serial lines, IAQ resumes, one post with `gasScan` |
| Mock AQI 42, tree pollen 1 | OLED row shows `AQI 42` and `T1`, outdoor score points 0 |
| Mock AQI 160, tree pollen 5, quiet indoor air | `vent` is `shut`, `airScore` outdoor part is 7 |
| RSSI worse than -82 dBm | No new TLS attempt, sensor loop still updates |

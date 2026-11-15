/***********************************************************
  SniffMaster Pro v5.0 — BSEC2 + SmellNet + Web Portal
  Hardware:
    - Seeed XIAO ESP32-C3 on Expansion Board
    - BME688 on Grove I2C (addr 0x76)
    - Built-in SSD1306 128x64 OLED (addr 0x3C)
    - Passive buzzer on D3 (hazard alarm ONLY)
    - USER button on D0 (D1 and the BOOT button also work)

  Button:
    tap   = next page (or dismiss an alert / mute a hazard alarm)
    hold  = push a fresh snapshot to the web portal

  The wall deck (four retro cards) auto-cycles every 10 s. Tap walks the
  detail cards too; after a minute with no tap the deck returns.

  Architecture:
    loop()   — sensor, button, buzzer, OLED, on-demand gas scan. Never touches the network.
    netTask  — Wi-Fi, portal posts/commands, /api/environment.
               Runs at lower priority so slow HTTPS can't freeze the UI.
    Shared state crosses tasks only via short copies under gLock.
***********************************************************/

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_idf_version.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <math.h>
#include "bsec2.h"
#include "bme68xLibrary.h"
#include "secrets.h"               // WIFI_CREDS, OPENAI_API_KEY, OPENAI_MODEL
#include "web_dashboard_config.h"  // WEB_DASHBOARD_URL, WEB_DASHBOARD_KEY
#include "heater_profile.h"        // Bosch sequential profile, copied not invented
#include "env_fusion.h"            // dew point, pressure trend, ventilation
#define USE_ML_SCORING
#include "smellnet_model_data.h"
#include "smellnet_inference.h"
#include "home_sensors.h"           // optional SM_HOME_SENSORS add-ons

// ══════════════════════════════════════════════════════════════
// Hardware
// ══════════════════════════════════════════════════════════════

// XIAO ESP32-C2 default Wire pins differ from the C3; set GPIO6/GPIO7 explicitly.
#if defined(CONFIG_IDF_TARGET_ESP32C2) || defined(ARDUINO_XIAO_ESP32C2)
  #define I2C_BEGIN() Wire.begin(6, 7)
#else
  #define I2C_BEGIN() Wire.begin()
#endif

// The expansion-board user button is D1 (GPIO3), active low. D0 is the
// Grove A0 pin, not that button. The BOOT button on the XIAO module is
// GPIO9. Each pin is tracked on its own: one stuck-low pin must not hold
// the others in the "already pressed" state.
#define BTN_PIN        D1
#define BTN_LONG_MS    700
#define BTN_DEBOUNCE_MS 25
#define BUZZER_PIN     D3

#define SCREEN_WIDTH   128
#define SCREEN_HEIGHT  64
#define OLED_ADDR      0x3C

// 100 kHz during frame transfers (library default is 400 kHz): the OLED shares
// the bus with the Grove-cabled BME688, and the extra capacitance corrupted
// pixels at 400 kHz. A full frame takes ~95 ms, which the loop budget absorbs.
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1, 100000UL, 100000UL);

#define PAGE_CYCLE_MS       5000UL    // metric cards auto-advance
#define UI_TASK_WDT_TIMEOUT_MS 8000UL  // reset if the UI task stops making progress

#ifndef ARRAY_LEN
#define ARRAY_LEN(a) (sizeof(a) / sizeof(a[0]))
#endif

enum UiLoopStage : uint8_t {
  UI_STAGE_BOOT,
  UI_STAGE_BUTTON,
  UI_STAGE_GAS_SCAN,
  UI_STAGE_HOME_SENSORS,
  UI_STAGE_SENSOR,
  UI_STAGE_PROCESS_SAMPLE,
  UI_STAGE_ALARM,
  UI_STAGE_DISPLAY,
  UI_STAGE_OLED_HEALTH,
  UI_STAGE_IDLE,
};

// This survives a task-watchdog restart and tells us which UI operation was
// in flight. The network task is deliberately not watched here: it must never
// be able to take the button, display, or sensor loop down with it.
RTC_DATA_ATTR static uint8_t lastUiLoopStage = UI_STAGE_BOOT;
static bool uiTaskWdtActive = false;

static const char* uiLoopStageName(uint8_t stage) {
  switch (stage) {
    case UI_STAGE_BUTTON:         return "button";
    case UI_STAGE_GAS_SCAN:       return "gas scan";
    case UI_STAGE_HOME_SENSORS:   return "home sensors";
    case UI_STAGE_SENSOR:         return "sensor";
    case UI_STAGE_PROCESS_SAMPLE: return "sample processing";
    case UI_STAGE_ALARM:          return "alarm";
    case UI_STAGE_DISPLAY:        return "display";
    case UI_STAGE_OLED_HEALTH:    return "OLED health";
    case UI_STAGE_IDLE:           return "idle";
    default:                      return "startup";
  }
}

static void resetUiTaskWatchdog() {
  if (uiTaskWdtActive) esp_task_wdt_reset();
}

static void startUiTaskWatchdog() {
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t config = {};
  config.timeout_ms = UI_TASK_WDT_TIMEOUT_MS;
  config.idle_core_mask = 0;
  config.trigger_panic = true;
  const esp_err_t initResult = esp_task_wdt_init(&config);
#else
  const esp_err_t initResult = esp_task_wdt_init(UI_TASK_WDT_TIMEOUT_MS / 1000UL, true);
#endif

  if (initResult != ESP_OK && initResult != ESP_ERR_INVALID_STATE) {
    Serial.printf("[WDT] UI watchdog init failed: %d\n", (int)initResult);
    return;
  }
  const esp_err_t addResult = esp_task_wdt_add(nullptr);
  if (addResult != ESP_OK) {
    Serial.printf("[WDT] UI watchdog add failed: %d\n", (int)addResult);
    return;
  }
  uiTaskWdtActive = true;
  if (esp_reset_reason() == ESP_RST_TASK_WDT)
    Serial.printf("[WDT] Recovered stalled UI at %s\n", uiLoopStageName(lastUiLoopStage));
  lastUiLoopStage = UI_STAGE_IDLE;
  Serial.printf("[WDT] UI recovery armed (%lus)\n", UI_TASK_WDT_TIMEOUT_MS / 1000UL);
}

// ══════════════════════════════════════════════════════════════
// BSEC2 configuration
// ══════════════════════════════════════════════════════════════

Bsec2 envSensor;

static bsecSensor sensorList[] = {
  BSEC_OUTPUT_BREATH_VOC_EQUIVALENT,
  BSEC_OUTPUT_IAQ,
  BSEC_OUTPUT_STATIC_IAQ,
  BSEC_OUTPUT_CO2_EQUIVALENT,
  BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_TEMPERATURE,
  BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_HUMIDITY,
  BSEC_OUTPUT_RAW_PRESSURE,
  BSEC_OUTPUT_RAW_GAS,
  BSEC_OUTPUT_COMPENSATED_GAS,
  BSEC_OUTPUT_GAS_PERCENTAGE,
  BSEC_OUTPUT_STABILIZATION_STATUS,
  BSEC_OUTPUT_RUN_IN_STATUS,
};

static bsecSensor sensorListLpSafe[] = {
  BSEC_OUTPUT_BREATH_VOC_EQUIVALENT,
  BSEC_OUTPUT_IAQ,
  BSEC_OUTPUT_STATIC_IAQ,
  BSEC_OUTPUT_CO2_EQUIVALENT,
  BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_TEMPERATURE,
  BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_HUMIDITY,
  BSEC_OUTPUT_RAW_PRESSURE,
  BSEC_OUTPUT_RAW_GAS,
  BSEC_OUTPUT_STABILIZATION_STATUS,
  BSEC_OUTPUT_RUN_IN_STATUS,
};

// Optional raw T/RH diagnostics. Off by default: while they were subscribed the
// bench C3 stayed in BSEC run-in (accuracy 0) for 50+ min, whereas the original
// output set historically reached accuracy 1 at ~33 min. Not yet proven to be
// the cause. Build with -DSM_BSEC_RAW_EXTRAS=1 to experiment.
#ifndef SM_BSEC_RAW_EXTRAS
#define SM_BSEC_RAW_EXTRAS 0
#endif
#if SM_BSEC_RAW_EXTRAS
static bsecSensor sensorListRawExtras[] = {
  BSEC_OUTPUT_RAW_TEMPERATURE,
  BSEC_OUTPUT_RAW_HUMIDITY,
};
#endif

// bsec2 1.8.x ships no bme688 *IAQ* blob (only AI-Studio selectivity configs,
// which replace Bosch IAQ), so the bme680 IAQ blob is loaded on every board.
static const uint8_t bsecIaqLpConfig[] = {
  #include <config/bme680/bme680_iaq_33v_3s_4d/bsec_iaq.txt>
};
static const char* const bsecCfgId = "bme680_iaq_33v_3s_4d";

#define BSEC_NVS_NS       "sniffmstr"
#define BSEC_NVS_KEY      "bsec"      // legacy raw blob — erased on sight
#define BSEC_STATE_KEY    "bsecst"    // versioned envelope (BSC2)
#define BSEC_GUARD_KEY    "rstguard"  // set while a restore is unproven
#define BSEC_STATE_MAGIC  0x42534332UL  // "BSC2"
#define BSEC_STATE_VER    1
#define BSEC_HOME_KEY     "homebase"
#define BSEC_SAVE_MS      (10UL * 60UL * 1000UL)
#define HOME_BASE_MAGIC   0x48424C31UL   // "HBL1"
#define HOME_BASE_VER     1
#define CAL_READY_SAMPLES 3

// ══════════════════════════════════════════════════════════════
// Odor model
// ══════════════════════════════════════════════════════════════

#define ODOR_COUNT          20
#define BASE_ODOR_COUNT     12
#define ODOR_MIN_CONF       20
#define ODOR_STRONG_CONF    65
#define ODOR_RUNTIME_ACC_MIN 2
#define HOME_BASELINE_MIN_SAMPLES 25
#define HOME_BASELINE_ALPHA 0.08f
#define HOME_BASELINE_CALM_DVOC 0.15f
#define HOME_EVENT_MIN_VOC_RISE 0.35f
#define HOME_EVENT_MIN_GAS_DROP 0.12f

enum OdorIndex : uint8_t {
  OD_FART = 0, OD_MUSTY, OD_CIGARETTE, OD_ALCOHOL, OD_WEED, OD_CLEANING,
  OD_GASOLINE, OD_SMOKE, OD_COOKING, OD_COFFEE, OD_GARBAGE, OD_SWEAT,
  OD_PERFUME, OD_LAUNDRY, OD_SULFUR, OD_SOLVENT, OD_PET, OD_SOUR,
  OD_BURNT, OD_CITRUS
};

// <=7 chars, for the OLED bar labels
static const char* const odorShort[ODOR_COUNT] = {
  "Fart", "Musty", "Cig", "Alcohol", "Weed", "Clean", "Gas", "Smoke",
  "Cooking", "Coffee", "Garbage", "Sweat", "Perfume", "Laundry", "Sulfur",
  "Solvent", "Pet", "Sour", "Burnt", "Citrus"
};

static const char* const odorNames[ODOR_COUNT] = {
  "Fart",       "Musty",      "Cigarette", "Alcohol",
  "Weed",       "Cleaning",   "Gasoline",  "Smoke",
  "Cooking",    "Coffee",     "Garbage",   "Sweat/BO",
  "Perfume",    "Laundry",    "Sulfur",    "Solvent",
  "Pet/Litter", "Sour Food",  "Burnt/Oil", "Citrus"
};

// Concern level per odor (0=pleasant .. 3=urgent)
static const uint8_t ODOR_CONCERN[ODOR_COUNT] = {
  3,1,2,1,2,0,3,3,0,0,2,1,0,0,3,2,2,2,2,0
};

struct HomeOdorBaseline {
  bool     ready;
  uint16_t calmSamples;
  float    voc, iaq, co2, gasR, hum, pressHpa;
};

struct PersistedHomeBaseline {
  uint32_t magic;
  uint16_t version;
  uint16_t calmSamples;
  uint8_t  ready;
  uint8_t  reserved[3];
  float    voc, iaq, co2, gasR, hum, pressHpa;
};

struct PersistedBsecState {
  uint32_t magic;
  uint16_t version;
  uint16_t blobLen;
  char     cfgId[24];
  uint8_t  blob[BSEC_MAX_STATE_BLOB_SIZE];
};

struct CalibrationRuntimeState {
  bool    bsecStateLoaded;
  bool    homeBaseDirty;
  bool    bsecReady;
  uint8_t stableSamples;
  uint8_t lastIaqAcc;
};

// ══════════════════════════════════════════════════════════════
// Alert thresholds
//   Hazard  = buzzer + full-screen alert (repeats until cleared/muted)
//   Advisory = silent on-screen notice
// ══════════════════════════════════════════════════════════════

#define HAZ_SMOKE_GAS_ON    40     // smoke/gasoline odor score
#define HAZ_SMOKE_GAS_OFF   30
#define HAZ_IAQ_ON          250.0f
#define HAZ_IAQ_OFF         220.0f
#define HAZ_CO2_ON          2500.0f
#define HAZ_CO2_OFF         2200.0f
#define HAZ_REPEAT_MS       60000UL     // re-sound every minute while hazardous
#define HAZ_SCREEN_MS       10000UL
#define ADVISORY_COOLDOWN_MS (5UL * 60UL * 1000UL)
#define ADVISORY_SCREEN_MS  5000UL
#define FART_COOLDOWN_MS    30000UL

// ══════════════════════════════════════════════════════════════
// Main-task state (only touched from loop())
// ══════════════════════════════════════════════════════════════

// Filled by BSEC callback (runs inside envSensor.run() in the loop task)
static bool    newDataReady      = false;
static float   latestVocRaw = 0, latestIAQ = 0, latestStaticIAQ = 0, latestCO2 = 0;
static float   latestTemp = 0, latestHumidity = 0, latestPressure = 0, latestGasR = 0;
static float   latestCompGas = 0, latestGasPct = 0;
static float   latestStabStatus = 0, latestRunInStatus = 0;
static uint8_t latestIAQAccuracy = 0;
static float   latestRawTempC = NAN, latestRawHum = NAN;
static bool    latestGasValid = false;   // last raw gas sample heat-stable + valid

// Processed snapshot used by the OLED
static float   ss_voc = 0, ss_iaq = 0, ss_co2 = 0;
static float   ss_tempF = 72.0f, ss_hum = 50.0f, ss_pressure = 101325.0f;
static float   ss_gasR = 50000.0f, ss_dvoc = 0;
static float   ss_stabStatus = 0, ss_runInStatus = 0;
static uint8_t ss_iaqAcc = 0;
static uint8_t ss_scores[ODOR_COUNT] = {0};
static uint8_t ss_tier = 0;
static int     ss_airScore = 0;
static int     ss_roomScore = 0;
static float   ss_dewF = NAN;
static char    ss_vent[8] = "open";
static char    ss_prevVent[8] = "";
static char    ss_pressTrend[8] = "";
static bool    ss_pressDisagree = false;
static EnvPressureTrend gPressTrend;
static unsigned long lastPressSampleMs = 0;
static bool    ss_valid = false;
static float   ss_prevVoc = 0;
static uint8_t ss_prevTier = 0xFF;
static int     ss_prevAirScore = 0;
static uint8_t ss_prevFartConf = 0, ss_peakFartConf = 0, ss_prevSulfurConf = 0;

static HomeOdorBaseline        homeBase = { false, 0, 0.5f, 25.0f, 420.0f, 180000.0f, 45.0f, 1013.0f };
static CalibrationRuntimeState calState = { false, false, false, 0, 0xFF };
static uint8_t homeLastPrimaryOdor = ODOR_COUNT;
static uint8_t homePrimaryHoldCount = 0;

// VOC smoothing (3 samples × 3 s keeps transient spikes visible)
#define SMOOTH_WINDOW 3
static float   vocBuffer[SMOOTH_WINDOW] = {0};
static uint8_t vocBufIdx = 0;
static bool    vocBufFilled = false;

// 5-minute trend (one point every 30 s)
#define TREND_SAMPLES     10
#define TREND_INTERVAL_MS 30000UL
struct TrendPoint { float iaq; float voc; };
static TrendPoint    trendRing[TREND_SAMPLES];
static uint8_t       trendHead = 0, trendFilled = 0;
static unsigned long lastTrendMs = 0;

// Fart tracker (silent)
static int           fartCount = 0;
static float         biggestFartVoc = 0;
static int           fartResetDay = -1;
static unsigned long lastFartMs = 0;

// Display
static uint8_t       displayPage = 0;
static unsigned long lastDeckTapMs = 0;   // last tap; detail pages return to the deck
static bool          forceRedraw = true;
static unsigned long lastPageAdvanceMs = 0;
static unsigned long lastBootRenderMs = 0;

// On-screen alert overlay
static bool          overlayActive = false;
static bool          overlayDirty = false;
static bool          overlayIsHazard = false;
static unsigned long overlayUntilMs = 0;
static char          overlayTitle[22] = "";
static char          overlayMsg[96] = "";

// Hazard alarm
static bool          hazardActive = false;
static bool          hazardMuted = false;
static unsigned long lastHazardAlarmMs = 0;
static unsigned long lastAdvisoryMs = 0;
static bool          advisoryEverShown = false;

// Buzzer pattern (non-blocking): beeps of ALARM_ON_MS separated by ALARM_OFF_MS
#define ALARM_FREQ_HZ   2700
#define ALARM_ON_MS     180
#define ALARM_OFF_MS    120
#define ALARM_BEEPS     6
static uint8_t       alarmStepsLeft = 0;   // counts on+off phases
static unsigned long alarmPhaseEndMs = 0;

// BSEC housekeeping
static Preferences   bsecPrefs;
static unsigned long lastBsecSaveMs = 0;
static bool          bsecAcc3Saved = false;
static bool          bsecEverSaved = false;   // a good blob exists in NVS (this boot or earlier)
static unsigned long bsecInitMillis = 0;
static unsigned long lastBsecWaitLogMs = 0;
static bool          bsecFirstPacketRetryDone = false;
static bool          bsecFullBundle = false;    // false = LP-safe list (no compGas/gasPct)
static bool          bsecRawExtras = false;     // raw temp/humidity subscribed
static uint8_t       bmeI2cAddr = BME68X_I2C_ADDR_LOW;
static int           lastBsecStatusLog = 9999, lastBmeStatusLog = 9999;

// ══════════════════════════════════════════════════════════════
// Cross-task shared state (guarded by gLock)
// ══════════════════════════════════════════════════════════════

static SemaphoreHandle_t gLock = nullptr;
struct LockGuard {
  LockGuard()  { xSemaphoreTake(gLock, portMAX_DELAY); }
  ~LockGuard() { xSemaphoreGive(gLock); }
};

// main → net: latest telemetry for the portal
struct Telemetry {
  bool    valid;
  float   voc, iaq, staticIaq, co2, tempF, hum, pressHpa, gasR, compGas, gasPct, dVoc;
  uint8_t iaqAcc;
  bool    calReady;
  char    calText[28];
  int     airScore;
  uint8_t tier;
  uint8_t odors[ODOR_COUNT];
  uint8_t primaryIdx, primaryConf;
  float   cfiScore;
  uint8_t cfiPercent, vtrLevel;
  int     fartCount;
  bool    fullBundle, gasValid, runIn, stab, bsecRestored;
  float   rawTempC, rawHum;       // NAN when not subscribed
  float   dewF;                   // indoor Magnus dew point, Fahrenheit
  int     roomScore;              // air score with static IAQ
  char    vent[8];                // open | brief | shut
  char    pressTrend[8];          // "" until 90 minutes, then rising|steady|falling
  bool    pressDisagree;
  bool    gasScanPost;
  uint32_t gasScanGen;
  char    gasScanProfile[28];
  uint32_t gasScanOhms[HEATER_STEP_COUNT];
  uint8_t gasScanCount;
#if SM_HOME_SENSORS
  HomeAirReading home;
#endif
  const char* iaqTrend;   // string literals only
  const char* vocTrend;
  char    hazard[12];
};
static Telemetry gTelem = {};

struct SniffEvent {
  int     iaq;
  float   conf;
  char    label[24];
  int     airScore;
  float   voc, dVoc;
  uint8_t primaryIdx, primaryConf;
  int     fartCount;
};
static SniffEvent gSniff = {};
static bool       gSniffPending = false;
static uint32_t   gSniffGen = 0;        // bumped per queued event; guards clear-after-send
static bool       gPushRequested = false;
static volatile bool gScanBusy = false;          // loop owns the BME688; net skips TLS
static volatile bool gGasScanRequest = false;    // net asks, loop runs the scan

// net → main: connection info + outdoor data
struct WeatherData {
  bool  valid;
  int   tempF, feelsLikeF, humidity;
  char  condition[24];
  char  windDir[4];
  char  windSpeed[12];
};
struct OutdoorAQI {
  bool  valid;
  int   aqi;          // US EPA 0-500
  float co, no2, o3, so2, pm25, pm10;   // µg/m³
  char  level[16];
  char  advisory[200];
  unsigned long fetchedMs;
  unsigned long ttlMs;          // server ttlSec; 0 → OUTDOOR_TTL_MS
  bool  pollenValid;
  int   pollenTree, pollenGrass, pollenWeed;
  char  pollenTop[17];
  float outdoorDewF;            // forecast dew point °F; NAN if absent
  float googlePress;            // forecast hPa
  bool  googlePressValid;
  bool  uaqiValid;
  int   uaqi;
  int   heatF, uv, precipPct;
  char  source[12];             // google | open-meteo
};
// Server-computed Home mode metrics (GET /api/home-stats)
struct HomeStats {
  bool  valid;
  unsigned long fetchedMs;
  int   score;            // Home Air Score 0-100
  char  grade[12];
  int   comp[4];          // VOC, ventilation, biological, comfort (-1 = missing)
  float dewPointF;
  int   moldPct, mitePct, dryPct, petIdx;
  char  moldCat[10], miteCat[10], dryCat[10], petLevel[10];
  char  headline[80];
};
// Pre-formatted wall-display feed (GET /api/oled): the server does the
// thinking and the wording, so this is just a few short ASCII strings.
struct WallStatus {
  bool  valid;
  unsigned long fetchedMs;
  int   sc, sl, aq, ot;     // home score, minutes smelly, outdoor AQI, outdoor F (-1/-999 = none)
  float uv;                 // NAN = none
  char  sm[10];             // FRESH | SLIGHT | SMELLY | DANGER | LEARNING
  char  tr[12];             // trend word
  char  ca[24];             // likely cause
  char  cc[8];              // cause confidence
  char  ac[2][24];          // best action, two 21-col lines
  char  al[10];             // allergen level: CLEAR LOW MODERATE HIGH SEVERE N/A
  char  an[14];             // top allergen driver, e.g. CAT DANDER
  char  pl[10];             // outdoor pollen level
  char  pn[14];             // top pollen type
  char  wn[24];             // window advice, one 21-col line
};
struct NetStatus {
  bool          connected;
  char          ssid[33];
  char          ip[16];
  int           rssi;
  int           channel;
  unsigned long lastPostMs;   // 0 = never
  char          city[32];
  WeatherData   weather;
  OutdoorAQI    aqi;
  HomeStats     home;
  WallStatus    wall;
  char          snark[140];   // OpenAI one-liner, ASCII, wrapped on screen
};
static NetStatus gNet = {};

static void requestPortalPush() { LockGuard g; gPushRequested = true; }

static NetStatus copyNetStatus() { LockGuard g; return gNet; }

#define OUTDOOR_TTL_MS (30UL * 60UL * 1000UL)
static unsigned long outdoorTtlMs(const OutdoorAQI& a) {
  return a.ttlMs ? a.ttlMs : OUTDOOR_TTL_MS;
}
static bool outdoorFresh(const OutdoorAQI& a) {
  return a.valid && (millis() - a.fetchedMs) <= outdoorTtlMs(a);
}
// Outdoor AQI for scoring/alerts; stale (> TTL) counts as missing
static int sharedOutdoorAqi() {
  LockGuard g;
  if (!outdoorFresh(gNet.aqi)) return 0;
  return gNet.aqi.aqi;
}

struct OutdoorSnap {
  bool  fresh;
  int   usAqi;
  float pm25;
  int   tree, grass, weed;
  float dewF;
  float pressHpa;
  bool  pressValid;
};
static OutdoorSnap copyOutdoorSnap() {
  LockGuard g;
  OutdoorSnap s = {};
  s.dewF = NAN;
  s.fresh = outdoorFresh(gNet.aqi);
  if (!s.fresh) return s;
  s.usAqi = gNet.aqi.aqi;
  s.pm25 = gNet.aqi.pm25;
  if (gNet.aqi.pollenValid) {
    s.tree = gNet.aqi.pollenTree;
    s.grass = gNet.aqi.pollenGrass;
    s.weed = gNet.aqi.pollenWeed;
  }
  s.dewF = gNet.aqi.outdoorDewF;
  s.pressHpa = gNet.aqi.googlePress;
  s.pressValid = gNet.aqi.googlePressValid;
  return s;
}

// ══════════════════════════════════════════════════════════════
// Utility functions
// ══════════════════════════════════════════════════════════════

static float pressToHpa(float raw) { return (raw > 10000.0f) ? raw / 100.0f : raw; }

static const char* iaqQuality(float iaq) {
  if (iaq <=  50) return "Good";
  if (iaq <= 100) return "OK";
  if (iaq <= 150) return "Moderate";
  if (iaq <= 200) return "Poor";
  if (iaq <= 300) return "Bad";
  return "Hazardous";
}

static const char* tierDesc(uint8_t tier) {
  switch (tier) {
    case 0: return "Clean";
    case 1: return "Normal";
    case 2: return "Funky";
    case 3: return "Stinky";
    case 4: return "Ripe";
    default: return "HAZMAT!";
  }
}

// BSEC2 breath-VOC tiers (ppm)
static uint8_t smellTier(float voc) {
  if (voc <  0.8f) return 0;
  if (voc <  3.0f) return 1;
  if (voc <  8.0f) return 2;
  if (voc < 25.0f) return 3;
  if (voc < 60.0f) return 4;
  return 5;
}

// Composite Room Quality Score (0 = pristine, 100 = hazardous)
static int computeAirScore(float iaq, float voc, float co2, float hum,
                           const uint8_t scores[], int outdoorAqi) {
  float iaqPts = constrain(iaq * 0.06f, 0.0f, 30.0f);
  float vocPts = constrain(voc * 2.0f, 0.0f, 15.0f);
  float co2Pts = constrain((co2 - 400.0f) * 0.0071f, 0.0f, 15.0f);

  float humPts = 0.0f;
  if (hum < 30.0f)      humPts = (30.0f - hum) * 0.5f;
  else if (hum > 60.0f) humPts = (hum - 60.0f) * 0.375f;
  humPts = constrain(humPts, 0.0f, 15.0f);

  uint8_t peak = 0;
  for (int i = 0; i < ODOR_COUNT; i++) if (scores[i] > peak) peak = scores[i];
  float odorPts = constrain(peak * 0.15f, 0.0f, 15.0f);

  // Outdoor US EPA AQI (0-500) only; 0 = missing/stale. Pollen is not a term.
  float outdoorPts = (float)envOutdoorPoints(outdoorAqi);

  int total = (int)(iaqPts + vocPts + co2Pts + humPts + odorPts + outdoorPts + 0.5f);
  return constrain(total, 0, 100);
}

static float computeCfiScore(float co2, float iaq) {
  float score = 1.0f;
  if (co2 > 800.0f) score -= ((co2 - 800.0f) / 100.0f) * 0.05f;
  if (iaq > 100.0f) score -= 0.10f;
  return constrain(score, 0.0f, 1.0f);
}

static const char* cfiBandForScore(float score) {
  const int pct = (int)lroundf(constrain(score, 0.0f, 1.0f) * 100.0f);
  if (pct >= 80) return "Peak";
  if (pct >= 60) return "Reduced";
  return "Drained";
}

static uint8_t computeVtrLevel(float hum, float co2, float iaq) {
  if (hum < 30.0f && co2 > 1200.0f) return 2;
  if (hum >= 40.0f && hum <= 60.0f && co2 < 800.0f && iaq <= 100.0f) return 0;
  return 1;
}

static const char* vtrLabelForLevel(uint8_t level) {
  switch (level) {
    case 0:  return "Safe";
    case 2:  return "High Bio-Risk";
    default: return "Elevated";
  }
}

static const char* vtrAdviceForLevel(uint8_t level) {
  switch (level) {
    case 0:  return "Ventilation and humidity are in a favorable range.";
    case 2:  return "Dry, rebreathed air pattern detected. Air cleaning, filtration, or masking is recommended.";
    default: return "Stagnant or dry air detected. Increase ventilation.";
  }
}

// Local replacement for the old GPT "hazard" label sent to the portal
static const char* hazardLabel(int airScore, bool hazard) {
  if (hazard)        return "Danger";
  if (airScore < 10) return "Pristine";
  if (airScore < 20) return "Fresh";
  if (airScore < 35) return "Fair";
  if (airScore < 50) return "Stale";
  if (airScore < 65) return "Caution";
  return "Warning";
}

static float pushAndSmooth(float v) {
  vocBuffer[vocBufIdx] = v;
  vocBufIdx = (vocBufIdx + 1) % SMOOTH_WINDOW;
  if (!vocBufIdx) vocBufFilled = true;
  uint8_t n = vocBufFilled ? SMOOTH_WINDOW : vocBufIdx;
  if (!n) return v;
  float s = 0;
  for (uint8_t i = 0; i < n; i++) s += vocBuffer[i];
  return s / n;
}

static void topTwo(const uint8_t scores[ODOR_COUNT], uint8_t &i1, uint8_t &i2) {
  i1 = 0;
  for (uint8_t i = 1; i < ODOR_COUNT; i++) if (scores[i] > scores[i1]) i1 = i;
  i2 = (i1 == 0) ? 1 : 0;
  for (uint8_t i = 0; i < ODOR_COUNT; i++)
    if (i != i1 && scores[i] > scores[i2]) i2 = i;
}

static uint8_t maxOdorScore(const uint8_t scores[ODOR_COUNT]) {
  uint8_t mx = 0;
  for (uint8_t i = 0; i < ODOR_COUNT; i++) if (scores[i] > mx) mx = scores[i];
  return mx;
}

static void pushTrend(float iaq, float voc) {
  if (trendFilled && millis() - lastTrendMs < TREND_INTERVAL_MS) return;
  lastTrendMs = millis();
  trendRing[trendHead] = { iaq, voc };
  trendHead = (trendHead + 1) % TREND_SAMPLES;
  if (trendFilled < TREND_SAMPLES) trendFilled++;
}

static const char* trendOf(bool useIaq, float threshold) {
  if (trendFilled < 2) return "stable";
  uint8_t oldest = (trendHead - trendFilled + TREND_SAMPLES) % TREND_SAMPLES;
  uint8_t newest = (trendHead - 1 + TREND_SAMPLES) % TREND_SAMPLES;
  float delta = useIaq ? trendRing[newest].iaq - trendRing[oldest].iaq
                       : trendRing[newest].voc - trendRing[oldest].voc;
  return (delta > threshold) ? "rising" : (delta < -threshold) ? "falling" : "stable";
}
static const char* getIaqTrend() { return trendOf(true, 12.0f); }
static const char* getVocTrend() { return trendOf(false, 4.0f); }

// Non-blocking local time (getLocalTime() defaults to a 5 s wait when unsynced)
static bool localTimeNow(struct tm* t) { return getLocalTime(t, 0); }

// ══════════════════════════════════════════════════════════════
// Calibration + home baseline
// ══════════════════════════════════════════════════════════════

static void resetHomeBaseline() {
  homeBase = { false, 0, 0.5f, 25.0f, 420.0f, 180000.0f, 45.0f, 1013.0f };
  homeLastPrimaryOdor = ODOR_COUNT;
  homePrimaryHoldCount = 0;
  calState.homeBaseDirty = false;
}

static bool homeBaseLooksValid(const HomeOdorBaseline &b) {
  return isfinite(b.voc) && isfinite(b.iaq) && isfinite(b.co2) &&
         isfinite(b.gasR) && isfinite(b.hum) && isfinite(b.pressHpa) &&
         b.voc >= 0.2f && b.voc <= 15.0f &&
         b.iaq >= 0.0f && b.iaq <= 500.0f &&
         b.co2 >= 350.0f && b.co2 <= 5000.0f &&
         b.gasR >= 1000.0f && b.gasR <= 2000000.0f &&
         b.hum >= 0.0f && b.hum <= 100.0f &&
         b.pressHpa >= 850.0f && b.pressHpa <= 1085.0f &&
         (!b.ready || b.calmSamples >= HOME_BASELINE_MIN_SAMPLES);
}

static bool bsecPhysicallySettled(float stab, float runIn) { return stab >= 1.0f || runIn >= 1.0f; }

static void updateCalibrationRuntimeState(uint8_t iaqAcc, float stab, float runIn) {
  const bool readySample = (iaqAcc >= ODOR_RUNTIME_ACC_MIN) &&
                           (bsecPhysicallySettled(stab, runIn) || calState.bsecStateLoaded);
  if (readySample) { if (calState.stableSamples < 255) calState.stableSamples++; }
  else calState.stableSamples = 0;

  const bool wasReady = calState.bsecReady;
  calState.bsecReady = calState.stableSamples >= CAL_READY_SAMPLES;

  if (calState.lastIaqAcc != iaqAcc) {
    Serial.printf("[CAL] IAQ accuracy %u -> %u (stab=%.0f runin=%.0f base=%s)\n",
                  calState.lastIaqAcc == 0xFF ? 0 : calState.lastIaqAcc, iaqAcc,
                  stab, runIn, homeBase.ready ? "ready" : "learning");
    calState.lastIaqAcc = iaqAcc;
  }
  if (!wasReady && calState.bsecReady) Serial.println(F("[CAL] Runtime ready"));
}

static bool bsecCalibrationReady(uint8_t iaqAcc) {
  return iaqAcc >= ODOR_RUNTIME_ACC_MIN && calState.bsecReady;
}

static bool fullCalibrationReady(uint8_t iaqAcc) {
  return bsecCalibrationReady(iaqAcc) && homeBase.ready;
}

static const char* calibrationStatusText(uint8_t iaqAcc, float stab, float runIn) {
  if (fullCalibrationReady(iaqAcc)) return "Ready";
  if (bsecCalibrationReady(iaqAcc)) return "Learning room baseline";
  if (iaqAcc >= ODOR_RUNTIME_ACC_MIN &&
      (bsecPhysicallySettled(stab, runIn) || calState.bsecStateLoaded))
    return "Finalizing sensor";
  if (calState.bsecStateLoaded) return "Restoring calibration";
  if (runIn >= 1.0f) return "Finishing run-in";
  if (iaqAcc >= 1) return "Calibrating sensor";
  return "Warming sensor";
}

static const char* calibrationBadgeText(uint8_t iaqAcc, float stab, float runIn) {
  if (fullCalibrationReady(iaqAcc)) return nullptr;
  if (bsecCalibrationReady(iaqAcc)) return "BASE";
  if (calState.bsecStateLoaded) return "REST";
  if (iaqAcc == 0 && !bsecPhysicallySettled(stab, runIn)) return "WARM";
  return "~CAL";
}

static void updateHomeBaseline(float voc, float iaq, float co2, float gasR,
                               float hum, float pressHpa, uint8_t iaqAcc,
                               float dVocAbs, const uint8_t scores[ODOR_COUNT]) {
  if (!bsecCalibrationReady(iaqAcc)) return;
  const bool calm = dVocAbs < HOME_BASELINE_CALM_DVOC && voc < 3.0f && iaq < 120.0f &&
                    maxOdorScore(scores) < ODOR_MIN_CONF && gasR > 10000.0f;
  if (!calm) return;

  if (homeBase.calmSamples == 0 && !homeBase.ready) {
    homeBase.voc = max(voc, 0.3f); homeBase.iaq = iaq; homeBase.co2 = max(co2, 400.0f);
    homeBase.gasR = gasR; homeBase.hum = hum; homeBase.pressHpa = pressHpa;
  } else {
    const float a = homeBase.ready ? 0.03f : HOME_BASELINE_ALPHA;
    homeBase.voc      += (voc - homeBase.voc) * a;
    homeBase.iaq      += (iaq - homeBase.iaq) * a;
    homeBase.co2      += (co2 - homeBase.co2) * a;
    homeBase.gasR     += (gasR - homeBase.gasR) * a;
    homeBase.hum      += (hum - homeBase.hum) * a;
    homeBase.pressHpa += (pressHpa - homeBase.pressHpa) * a;
  }

  const bool wasReady = homeBase.ready;
  if (homeBase.calmSamples < 65535) homeBase.calmSamples++;
  if (homeBase.calmSamples >= HOME_BASELINE_MIN_SAMPLES) homeBase.ready = true;
  if (!wasReady && homeBase.ready) {
    calState.homeBaseDirty = true;
    Serial.printf("[CAL] Home baseline ready (%u calm samples)\n", homeBase.calmSamples);
  }
}

// ══════════════════════════════════════════════════════════════
// Odor scoring pipeline
// ══════════════════════════════════════════════════════════════

static inline uint8_t clampScore(int v) { return (uint8_t)constrain(v, 0, 100); }

// Cross-correlate ML scores with sensor physics to resolve ambiguities
static void correctOdorScores(uint8_t s[ODOR_COUNT], float voc, float iaq,
                              float co2, float gasR, float dVoc, float hum) {
  const float iaqVocR = iaq / fmaxf(voc, 1.0f);
  const float gasRk   = gasR / 1000.0f;

  // Biological decay depresses gasR far more than cooking volatiles
  if (gasRk < 150.0f && iaqVocR > 1.2f && iaq > 40.0f) {
    s[OD_FART] = clampScore(s[OD_FART] + 15);  s[OD_GARBAGE] = clampScore(s[OD_GARBAGE] + 15);
    s[OD_COOKING] = (uint8_t)(s[OD_COOKING] * 0.6f); s[OD_COFFEE] = (uint8_t)(s[OD_COFFEE] * 0.7f);
  }
  if (gasRk < 80.0f && iaqVocR > 1.5f && iaq > 80.0f) {
    s[OD_FART] = clampScore(s[OD_FART] + 15);  s[OD_GARBAGE] = clampScore(s[OD_GARBAGE] + 15);
    s[OD_COOKING] = (uint8_t)(s[OD_COOKING] * 0.3f); s[OD_COFFEE] = (uint8_t)(s[OD_COFFEE] * 0.3f);
    s[OD_SWEAT] = clampScore(s[OD_SWEAT] + 10);
  }

  // Cooking requires CO2 correlation
  if (co2 < 500.0f && s[OD_COOKING] > 15) s[OD_COOKING] = (uint8_t)(s[OD_COOKING] * 0.5f);
  if (co2 > 600.0f && voc > 2.0f && voc < 12.0f && gasRk > 60.0f)
    s[OD_COOKING] = clampScore(s[OD_COOKING] + 10);

  // Fart = sudden spike; garbage = sustained
  if (dVoc < 0.3f && voc > 3.0f && iaq > 50.0f && s[OD_FART] > s[OD_GARBAGE]) {
    int shift = min((int)(s[OD_FART] * 0.3f), 20);
    s[OD_FART] = clampScore(s[OD_FART] - shift);
    s[OD_GARBAGE] = clampScore(s[OD_GARBAGE] + shift);
  }
  if (dVoc > 2.0f && voc > 2.0f) {
    s[OD_FART] = clampScore(s[OD_FART] + 15);
    s[OD_GARBAGE] = clampScore(s[OD_GARBAGE] - 10);
  }

  // Solvents: high VOC relative to IAQ with moderate gasR
  if (voc > 5.0f && iaqVocR < 0.8f && gasRk > 50.0f) {
    s[OD_CLEANING] = clampScore(s[OD_CLEANING] + 10); s[OD_ALCOHOL] = clampScore(s[OD_ALCOHOL] + 10);
    s[OD_FART] = clampScore(s[OD_FART] - 10);         s[OD_GARBAGE] = clampScore(s[OD_GARBAGE] - 10);
  }

  // Smoke/cigarette need very high readings
  if (iaq < 150.0f && voc < 10.0f) s[OD_SMOKE] = (uint8_t)(s[OD_SMOKE] * 0.3f);
  if (iaq < 100.0f) s[OD_CIGARETTE] = (uint8_t)(s[OD_CIGARETTE] * 0.5f);
  if (iaq > 100.0f) s[OD_COFFEE] = (uint8_t)(s[OD_COFFEE] * 0.5f);

  // Musty correlates with humidity
  if (hum < 45.0f) s[OD_MUSTY] = (uint8_t)(s[OD_MUSTY] * 0.5f);
  if (hum > 60.0f && iaq > 40.0f) s[OD_MUSTY] = clampScore(s[OD_MUSTY] + 10);

  // Genuinely clean air → zero everything
  if (iaq < 20.0f && voc < 0.5f && gasRk > 250.0f)
    for (int i = 0; i < ODOR_COUNT; i++) s[i] = 0;
}

// Suppress false positives using the learned quiet-room baseline
static void applyHomeMlTuning(uint8_t s[ODOR_COUNT], float voc, float iaq,
                              float co2, float gasR, float dVocRise,
                              float hum, uint8_t iaqAcc) {
  if (!bsecCalibrationReady(iaqAcc)) {
    for (uint8_t i = 0; i < ODOR_COUNT; i++)
      s[i] = (s[i] >= ODOR_STRONG_CONF) ? (uint8_t)(s[i] * 0.75f) : (uint8_t)(s[i] * 0.35f);
    return;
  }

  const float baseVoc  = homeBase.ready ? homeBase.voc  : 0.5f;
  const float baseIaq  = homeBase.ready ? homeBase.iaq  : 25.0f;
  const float baseCo2  = homeBase.ready ? homeBase.co2  : 420.0f;
  const float baseGasR = homeBase.ready ? homeBase.gasR : 180000.0f;

  const float vocRise = fmaxf(0.0f, voc - baseVoc);
  const float iaqRise = fmaxf(0.0f, iaq - baseIaq);
  const float co2Rise = fmaxf(0.0f, co2 - baseCo2);
  const float gasDrop = (baseGasR > 1000.0f) ? fmaxf(0.0f, (baseGasR - gasR) / baseGasR) : 0.0f;

  const bool nearBaseline = vocRise < HOME_EVENT_MIN_VOC_RISE && iaqRise < 15.0f &&
                            dVocRise < 0.20f && gasDrop < 0.08f;
  const bool meaningfulEvent = vocRise >= HOME_EVENT_MIN_VOC_RISE || iaqRise >= 20.0f ||
                               dVocRise >= 0.4f || gasDrop >= HOME_EVENT_MIN_GAS_DROP;

  if (nearBaseline) {
    for (uint8_t i = 0; i < ODOR_COUNT; i++)
      s[i] = (s[i] >= ODOR_STRONG_CONF) ? (uint8_t)(s[i] * 0.4f) : 0;
    return;
  }
  if (!meaningfulEvent) {
    for (uint8_t i = 0; i < ODOR_COUNT; i++)
      if (s[i] < ODOR_STRONG_CONF) s[i] = (uint8_t)(s[i] * 0.4f);
  }

  if (homeBase.ready && vocRise < 0.6f && gasDrop < 0.10f) {
    s[OD_FART] = (uint8_t)(s[OD_FART] * 0.5f);         s[OD_CIGARETTE] = (uint8_t)(s[OD_CIGARETTE] * 0.5f);
    s[OD_GASOLINE] = (uint8_t)(s[OD_GASOLINE] * 0.35f); s[OD_SMOKE] = (uint8_t)(s[OD_SMOKE] * 0.35f);
    s[OD_GARBAGE] = (uint8_t)(s[OD_GARBAGE] * 0.5f);
  }
  if (homeBase.ready && co2Rise > 150.0f && vocRise > 0.4f && vocRise < 8.0f && gasDrop < 0.35f) {
    s[OD_COOKING] = clampScore(s[OD_COOKING] + 8);
    s[OD_SWEAT]   = clampScore(s[OD_SWEAT] + 6);
    if (voc < 4.0f) s[OD_COFFEE] = clampScore(s[OD_COFFEE] + 4);
  }
  if (homeBase.ready && gasDrop > 0.18f && vocRise > 0.8f) {
    s[OD_FART] = clampScore(s[OD_FART] + 6);         s[OD_ALCOHOL] = clampScore(s[OD_ALCOHOL] + 6);
    s[OD_CLEANING] = clampScore(s[OD_CLEANING] + 6); s[OD_GARBAGE] = clampScore(s[OD_GARBAGE] + 6);
  }
  if (hum < 40.0f) s[OD_MUSTY] = (uint8_t)(s[OD_MUSTY] * 0.6f);

  for (uint8_t i = 0; i < ODOR_COUNT; i++) if (s[i] < 5) s[i] = 0;
}

// Derive the 8 expanded odor families from the 12 base ML classes
static void deriveExpandedOdors(uint8_t s[ODOR_COUNT], float voc, float iaq,
                                float co2, float gasR, float dVocRise,
                                float hum, uint8_t iaqAcc) {
  for (uint8_t i = BASE_ODOR_COUNT; i < ODOR_COUNT; i++) s[i] = 0;

  const float gasRk = gasR / 1000.0f;
  const float iaqVocR = iaq / fmaxf(voc, 1.0f);
  const float vocIaqR = voc / fmaxf(iaq, 1.0f);

  int perfume = (int)(s[OD_ALCOHOL] * 0.45f + s[OD_CLEANING] * 0.30f + s[OD_WEED] * 0.20f);
  if (voc > 1.0f && voc < 9.0f && gasRk > 70.0f && co2 < 900.0f) perfume += 12;
  if (iaq < 160.0f && dVocRise < 2.5f) perfume += 8;
  if (s[OD_SMOKE] > 20 || s[OD_GASOLINE] > 20) perfume -= 20;
  s[OD_PERFUME] = clampScore(perfume);

  int laundry = (int)(s[OD_CLEANING] * 0.60f + s[OD_PERFUME] * 0.35f);
  if (gasRk > 100.0f && voc < 7.0f && iaqVocR > 1.0f) laundry += 12;
  if (hum < 70.0f && co2 < 900.0f) laundry += 6;
  if (s[OD_SMOKE] > 15 || s[OD_GASOLINE] > 15) laundry -= 15;
  s[OD_LAUNDRY] = clampScore(laundry);

  int sulfur = (int)(s[OD_FART] * 0.55f + s[OD_GARBAGE] * 0.45f);
  if (iaqVocR > 1.3f && gasRk < 120.0f) sulfur += 18;
  if (co2 < 800.0f && voc > 1.5f) sulfur += 8;
  if (s[OD_CLEANING] > 25) sulfur -= 10;
  s[OD_SULFUR] = clampScore(sulfur);

  int solvent = (int)(s[OD_GASOLINE] * 0.45f + s[OD_ALCOHOL] * 0.30f + s[OD_CLEANING] * 0.30f);
  if (voc > 4.0f && iaqVocR < 1.0f) solvent += 15;
  if (vocIaqR > 0.04f && gasRk > 30.0f) solvent += 8;
  if (s[OD_GARBAGE] > 20 || s[OD_FART] > 20) solvent -= 12;
  s[OD_SOLVENT] = clampScore(solvent);

  int pet = (int)(s[OD_GARBAGE] * 0.40f + s[OD_SWEAT] * 0.35f + s[OD_FART] * 0.20f);
  if (co2 > 500.0f && co2 < 1400.0f && dVocRise < 1.5f) pet += 10;
  if (gasRk < 180.0f && iaqVocR > 1.0f) pet += 10;
  if (s[OD_CLEANING] > 25) pet -= 8;
  s[OD_PET] = clampScore(pet);

  int sour = (int)(s[OD_GARBAGE] * 0.35f + s[OD_ALCOHOL] * 0.35f + s[OD_MUSTY] * 0.20f);
  if (voc > 1.5f && voc < 8.0f && dVocRise < 1.2f) sour += 12;
  if (co2 < 900.0f && gasRk < 170.0f) sour += 8;
  if (s[OD_SMOKE] > 20) sour -= 12;
  s[OD_SOUR] = clampScore(sour);

  int burnt = (int)(s[OD_COOKING] * 0.45f + s[OD_SMOKE] * 0.40f);
  if (voc > 3.0f && dVocRise > 0.3f) burnt += 10;
  if (gasRk < 110.0f || iaq > 120.0f) burnt += 8;
  if (s[OD_COFFEE] > 20) burnt -= 8;
  s[OD_BURNT] = clampScore(burnt);

  int citrus = (int)(s[OD_PERFUME] * 0.35f + s[OD_CLEANING] * 0.25f + s[OD_COFFEE] * 0.15f);
  if (voc > 0.8f && voc < 5.0f && gasRk > 100.0f && iaq < 120.0f) citrus += 14;
  if (co2 < 800.0f && hum < 65.0f) citrus += 6;
  if (s[OD_SMOKE] > 15 || s[OD_GARBAGE] > 20) citrus -= 12;
  s[OD_CITRUS] = clampScore(citrus);

  if (!bsecCalibrationReady(iaqAcc)) {
    for (uint8_t i = BASE_ODOR_COUNT; i < ODOR_COUNT; i++)
      s[i] = (s[i] >= ODOR_STRONG_CONF) ? (uint8_t)(s[i] * 0.7f) : (uint8_t)(s[i] * 0.4f);
  }
}

// Require moderate scores to persist 2+ samples before reporting
static void stabilizePrimaryOdor(uint8_t s[ODOR_COUNT], uint8_t iaqAcc) {
  uint8_t i1, i2;
  topTwo(s, i1, i2);
  const uint8_t top = s[i1], next = s[i2];

  if (top < ODOR_MIN_CONF) { homeLastPrimaryOdor = ODOR_COUNT; homePrimaryHoldCount = 0; return; }

  const bool immediate = top >= ODOR_STRONG_CONF;
  const bool clearWinner = top >= (uint8_t)(next + 8);

  if (!bsecCalibrationReady(iaqAcc) || !clearWinner) {
    if (!immediate) s[i1] = ODOR_MIN_CONF - 1;
    if (!clearWinner) { homeLastPrimaryOdor = ODOR_COUNT; homePrimaryHoldCount = 0; }
    return;
  }

  if (i1 == homeLastPrimaryOdor) { if (homePrimaryHoldCount < 255) homePrimaryHoldCount++; }
  else { homeLastPrimaryOdor = i1; homePrimaryHoldCount = 1; }

  if (!immediate && homePrimaryHoldCount < 2) s[i1] = ODOR_MIN_CONF - 1;
}

// ══════════════════════════════════════════════════════════════
// Buzzer — hazard alarm only
// ══════════════════════════════════════════════════════════════

static void alarmStart() {
  alarmStepsLeft = ALARM_BEEPS * 2;
  alarmPhaseEndMs = 0;   // start immediately on next tick
}

static void alarmStop() {
  alarmStepsLeft = 0;
  noTone(BUZZER_PIN);
  digitalWrite(BUZZER_PIN, LOW);
}

static void alarmTick(unsigned long now) {
  if (!alarmStepsLeft) return;
  if (alarmPhaseEndMs && (long)(now - alarmPhaseEndMs) < 0) return;
  const bool beepPhase = (alarmStepsLeft % 2) == 0;
  if (beepPhase) { tone(BUZZER_PIN, ALARM_FREQ_HZ); alarmPhaseEndMs = now + ALARM_ON_MS; }
  else           { noTone(BUZZER_PIN);             alarmPhaseEndMs = now + ALARM_OFF_MS; }
  alarmStepsLeft--;
  if (!alarmStepsLeft) noTone(BUZZER_PIN);
}

// ══════════════════════════════════════════════════════════════
// Drawing helpers + overlay
// ══════════════════════════════════════════════════════════════

static void drawHeader(const char* left, const char* right = nullptr) {
  // Plain text + underline. A solid white bar ghosts/streaks on SSD1306 panels.
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  if (hazardActive && !right) right = "HAZ";
  // Truncate the title so it never runs into the right-hand badge
  const int maxLeft = (SCREEN_WIDTH - 4 - (right ? (int)strlen(right) * 6 + 6 : 0)) / 6;
  char title[22];
  strlcpy(title, left, min((int)sizeof(title), maxLeft + 1));
  display.setCursor(2, 1);
  display.print(title);
  if (right) {
    display.setCursor(SCREEN_WIDTH - (int)(strlen(right) * 6) - 2, 1);
    display.print(right);
  }
  display.drawFastHLine(0, 9, SCREEN_WIDTH, SSD1306_WHITE);
}

static void drawBar(int x, int y, int w, int h, uint8_t pct) {
  int fill = map(constrain((int)pct, 0, 100), 0, 100, 0, w - 2);
  display.drawRect(x, y, w, h, SSD1306_WHITE);
  if (fill > 0) display.fillRect(x + 1, y + 1, fill, h - 2, SSD1306_WHITE);
}

// Print \n-separated lines starting at startY (9 px spacing)
static void drawLines(const char* text, int startY) {
  int y = startY;
  const char* p = text;
  while (*p && y < SCREEN_HEIGHT) {
    const char* nl = strchr(p, '\n');
    int len = nl ? (int)(nl - p) : (int)strlen(p);
    char line[22];
    len = min(len, 21);
    memcpy(line, p, len);
    line[len] = '\0';
    display.setCursor(0, y);
    display.print(line);
    y += 9;
    if (!nl) break;
    p = nl + 1;
  }
}

static void printRight(int y, const char* s) {
  display.setCursor(SCREEN_WIDTH - (int)strlen(s) * 6, y);
  display.print(s);
}

static void showOverlay(const char* title, const char* msg, unsigned long durationMs, bool hazard) {
  strlcpy(overlayTitle, title, sizeof(overlayTitle));
  strlcpy(overlayMsg, msg, sizeof(overlayMsg));
  overlayActive = true;
  overlayDirty = true;
  overlayIsHazard = hazard;
  overlayUntilMs = millis() + durationMs;
}

static void dismissOverlay() {
  overlayActive = false;
  forceRedraw = true;
}

static void renderOverlay() {
  display.clearDisplay();
  display.fillRect(0, 0, SCREEN_WIDTH, 13, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  int tw = strlen(overlayTitle) * 6;
  display.setCursor(max(0, (SCREEN_WIDTH - tw) / 2), 3);
  display.print(overlayTitle);
  display.setTextColor(SSD1306_WHITE);
  drawLines(overlayMsg, 17);
  if (overlayIsHazard) {
    display.setCursor(0, 56);
    display.print(hazardMuted ? F("Muted") : F("Tap to mute alarm"));
  }
  display.display();
}

// ══════════════════════════════════════════════════════════════
// OLED pages
// ══════════════════════════════════════════════════════════════

static void renderBootStatusPage() {
  const NetStatus net = copyNetStatus();
  display.clearDisplay();
  drawHeader("-- Starting Up --",
             calibrationBadgeText(latestIAQAccuracy, latestStabStatus, latestRunInStatus));
  display.setCursor(0, 12);
  display.print(calibrationStatusText(latestIAQAccuracy, latestStabStatus, latestRunInStatus));

  display.setCursor(0, 21);
  if (homeBase.ready)                     display.print(F("Room baseline loaded"));
  else if (latestIAQAccuracy > 0 || latestRunInStatus > 0.0f) display.print(F("Building baseline"));
  else                                    display.print(F("Waiting for sensor"));

  display.setCursor(0, 30);
  display.print(F("WiFi: "));
  display.print(net.connected ? net.ssid : "connecting");

  display.setCursor(0, 39);
  display.print(F("Portal: "));
  display.print(!net.connected ? "offline" : net.lastPostMs ? "linked" : "pending");

  display.setCursor(0, 52);
  display.print(F("Up "));
  display.print(millis() / 1000UL);
  display.print(F("s"));
  display.display();
}

// ══════════════════════════════════════════════════════════════
// Metric cards — one metric per screen, cycling every 5 s
//   header (name + status) · big value · range bar · history bars
// ══════════════════════════════════════════════════════════════

// ── History (one point per minute, 32 points ≈ last half hour) ──
#define HIST_LEN       32
#define HIST_PERIOD_MS 60000UL
enum HistId : uint8_t { H_IAQ, H_VOC, H_CO2, H_TEMP, H_HUM, H_PRESS, H_SCORE, H_COUNT };
static float         histBuf[H_COUNT][HIST_LEN];
static uint8_t       histHead = 0, histFilled = 0;
static unsigned long lastHistMs = 0;

static void histPush(unsigned long now) {
  if (histFilled && now - lastHistMs < HIST_PERIOD_MS) return;
  lastHistMs = now;
  const float v[H_COUNT] = { ss_iaq, ss_voc, ss_co2, ss_tempF, ss_hum,
                             pressToHpa(ss_pressure), (float)(100 - ss_airScore) };
  for (uint8_t i = 0; i < H_COUNT; i++) histBuf[i][histHead] = v[i];
  histHead = (histHead + 1) % HIST_LEN;
  if (histFilled < HIST_LEN) histFilled++;
}

// Bottom strip: vertical bars, oldest → newest, auto-scaled with a minimum span
// so a flat signal looks flat instead of noisy.
static void drawHistory(HistId id, float minSpan, int y = 41, int h = 23) {
  if (histFilled < 2) {
    display.setCursor(0, y + 8);
    display.print(F("history filling..."));
    return;
  }
  float lo = 1e9f, hi = -1e9f;
  for (uint8_t i = 0; i < histFilled; i++) {
    float v = histBuf[id][(histHead - histFilled + i + HIST_LEN) % HIST_LEN];
    lo = min(lo, v); hi = max(hi, v);
  }
  if (hi - lo < minSpan) { float mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const int barW = SCREEN_WIDTH / HIST_LEN;   // 4 px
  const int x0 = SCREEN_WIDTH - histFilled * barW;
  for (uint8_t i = 0; i < histFilled; i++) {
    float v = histBuf[id][(histHead - histFilled + i + HIST_LEN) % HIST_LEN];
    int bh = 1 + (int)((v - lo) / (hi - lo) * (h - 1));
    display.fillRect(x0 + i * barW, y + h - bh, barW - 1, bh, SSD1306_WHITE);
  }
}

// Range bar with a value marker; `pct` 0-100 along the scale
static void drawRangeBar(int y, uint8_t pct, const char* lo, const char* hi) {
  const int x = (int)strlen(lo) * 6 + 3;
  const int w = SCREEN_WIDTH - (int)strlen(hi) * 6 - 3 - x;
  display.setCursor(0, y - 1);  display.print(lo);
  display.setCursor(SCREEN_WIDTH - (int)strlen(hi) * 6, y - 1); display.print(hi);
  display.drawRect(x, y, w, 6, SSD1306_WHITE);
  int fill = (int)(constrain((int)pct, 0, 100) * (w - 2) / 100);
  if (fill > 0) display.fillRect(x + 1, y + 1, fill, 4, SSD1306_WHITE);
}

// Labelled mini bar row: "Mold   ████░░░  12%"
static void drawMiniBar(int y, const char* label, int pct, const char* right) {
  display.setCursor(0, y);
  display.print(label);
  const int x = 44;                                            // labels are <= 7 chars
  const int w = SCREEN_WIDTH - (int)strlen(right) * 6 - 3 - x;
  display.drawRect(x, y, w, 7, SSD1306_WHITE);
  if (pct > 0) display.fillRect(x + 1, y + 1, constrain(pct, 0, 100) * (w - 2) / 100, 5, SSD1306_WHITE);
  printRight(y, right);
}

// Big value + unit, plus a right-aligned status word
static void drawBigValue(const char* value, const char* unit, const char* status) {
  display.setTextSize(2);
  display.setCursor(0, 13);
  display.print(value);
  int vx = strlen(value) * 12 + 2;
  display.setTextSize(1);
  display.setCursor(vx, 20);
  display.print(unit);
  printRight(13, status);
}

static uint8_t pctOf(float v, float lo, float hi) {
  return (uint8_t)constrain((int)((v - lo) * 100.0f / (hi - lo)), 0, 100);
}

static bool homeFresh(const NetStatus& n) {
  return n.home.valid && millis() - n.home.fetchedMs < 10UL * 60UL * 1000UL;
}

// ── Cards ─────────────────────────────────────────────────────
static void cardHomeScore(const NetStatus& n) {
  drawHeader("Home Score");
  char buf[24];
  if (!homeFresh(n)) {
    display.setCursor(0, 24);
    display.print(n.connected ? F("Waiting for dashboard") : F("Dashboard offline"));
    snprintf(buf, sizeof(buf), "Device score: %d", 100 - ss_airScore);
    display.setCursor(0, 40); display.print(buf);
    return;
  }
  snprintf(buf, sizeof(buf), "%d", n.home.score);
  drawBigValue(buf, "/100", n.home.grade);
  // Component mini-bars (missing sensors shown as "--")
  static const char* const LABELS[] = { "VOC", "Vent", "Bio", "Comfy" };
  for (int i = 0; i < 4; i++) {
    int s = n.home.comp[i];
    char r[6];
    if (s < 0) strlcpy(r, "--", sizeof(r)); else snprintf(r, sizeof(r), "%d", s);
    drawMiniBar(31 + i * 8, LABELS[i], max(s, 0), r);
  }
}

static void cardIaq() {
  drawHeader("Indoor Air", calibrationBadgeText(ss_iaqAcc, ss_stabStatus, ss_runInStatus));
  char buf[12];
  snprintf(buf, sizeof(buf), "%.0f", ss_iaq);
  drawBigValue(buf, "", iaqQuality(ss_iaq));
  drawRangeBar(32, pctOf(ss_iaq, 0, 300), "0", "300");
  drawHistory(H_IAQ, 20);
}

static void cardVoc() {
  drawHeader("VOC (breath eq)");
  char buf[12];
  snprintf(buf, sizeof(buf), ss_voc < 10 ? "%.2f" : "%.1f", ss_voc);
  drawBigValue(buf, "ppm", (ss_voc < 0.5f) ? "clean" : (ss_voc < 2.0f) ? "normal" :
                           (ss_voc < 5.0f) ? "elevated" : (ss_voc < 15.0f) ? "HIGH" : "DANGER");
  drawRangeBar(32, pctOf(ss_voc, 0, 10), "0", "10");
  drawHistory(H_VOC, 0.5f);
}

static void cardCo2() {
  drawHeader("CO2 (estimate)");
  char buf[12];
  snprintf(buf, sizeof(buf), "%.0f", ss_co2);
  drawBigValue(buf, "ppm", (ss_co2 < 800) ? "fresh" : (ss_co2 < 1200) ? "stuffy" :
                           (ss_co2 < 2000) ? "VENT" : "DANGER");
  drawRangeBar(32, pctOf(ss_co2, 400, 2500), "400", "2.5k");
  drawHistory(H_CO2, 100);
}

static void cardTemp(const NetStatus& n) {
  drawHeader("Temperature");
  char buf[12], st[14];
  snprintf(buf, sizeof(buf), "%.1f", ss_tempF);
  if (homeFresh(n) && isfinite(n.home.dewPointF)) snprintf(st, sizeof(st), "dew %.0fF", n.home.dewPointF);
  else strlcpy(st, (ss_tempF < 65) ? "chilly" : (ss_tempF > 80) ? "warm" : "comfy", sizeof(st));
  drawBigValue(buf, "F", st);
  drawRangeBar(32, pctOf(ss_tempF, 55, 90), "55", "90");
  drawHistory(H_TEMP, 2);
}

static void cardHumidity() {
  const char* badge = !strcmp(ss_vent, "shut") ? "Vent shut" :
                      !strcmp(ss_vent, "brief") ? "Vent brief" : "Vent open";
  drawHeader("Humidity", badge);
  char buf[12];
  snprintf(buf, sizeof(buf), "%.0f", ss_hum);
  drawBigValue(buf, "%RH", (ss_hum < 30) ? "dry" : (ss_hum <= 60) ? "ideal" : (ss_hum <= 70) ? "damp" : "MOLDY");
  drawRangeBar(32, (uint8_t)constrain((int)ss_hum, 0, 100), "0", "100");
  drawHistory(H_HUM, 5);
}

static void cardPressure() {
  drawHeader("Pressure", ss_pressTrend[0] ? ss_pressTrend : nullptr);
  char buf[12], st[12];
  const float hpa = pressToHpa(ss_pressure);
  snprintf(buf, sizeof(buf), "%.0f", hpa);
  // 30-minute tendency from history
  if (histFilled >= 2) {
    float d = histBuf[H_PRESS][(histHead - 1 + HIST_LEN) % HIST_LEN] -
              histBuf[H_PRESS][(histHead - histFilled + HIST_LEN) % HIST_LEN];
    snprintf(st, sizeof(st), "%s%.1f", d >= 0 ? "+" : "", d);
  } else {
    strlcpy(st, "steady", sizeof(st));
  }
  drawBigValue(buf, "hPa", st);
  drawRangeBar(32, pctOf(hpa, 980, 1040), "980", "1040");
  drawHistory(H_PRESS, 2);
}

// 0=ALL CLEAR .. 4=EVACUATE
static uint8_t verdictLevel(const uint8_t scores[ODOR_COUNT], int airScore) {
  uint8_t i1, i2;
  topTwo(scores, i1, i2);
  uint8_t conf = scores[i1];
  if (conf < ODOR_MIN_CONF) return (airScore < 15) ? 0 : (airScore < 35) ? 1 : 2;
  uint8_t concern = ODOR_CONCERN[i1];
  int cs = (int)concern * 20 + conf / 4 + airScore / 5;
  if (concern == 3 && conf >= 50) cs += 30;
  return (cs < 15) ? 0 : (cs < 30) ? 1 : (cs < 55) ? 2 : (cs < 75) ? 3 : 4;
}
static const char* const VERDICT_LABEL[] = { "ALL CLEAR", "SUBTLE", "NOTICEABLE", "AIR IT OUT", "EVACUATE" };

static void cardOdors() {
  drawHeader("Smells", VERDICT_LABEL[verdictLevel(ss_scores, ss_airScore)]);
  if (!bsecCalibrationReady(ss_iaqAcc)) {
    display.setCursor(0, 16);
    display.print(calibrationStatusText(ss_iaqAcc, ss_stabStatus, ss_runInStatus));
    display.setCursor(0, 28);
    display.print(F("Odor model warming up"));
  } else {
    // Top 4 odor scores as bars
    uint8_t idx[ODOR_COUNT];
    for (uint8_t i = 0; i < ODOR_COUNT; i++) idx[i] = i;
    for (uint8_t i = 0; i < 4; i++)
      for (uint8_t j = i + 1; j < ODOR_COUNT; j++)
        if (ss_scores[idx[j]] > ss_scores[idx[i]]) { uint8_t t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    for (uint8_t r = 0; r < 4; r++) {
      char label[8], pct[6];
      strlcpy(label, odorShort[idx[r]], sizeof(label));
      snprintf(pct, sizeof(pct), "%u%%", ss_scores[idx[r]]);
      drawMiniBar(12 + r * 10, label, ss_scores[idx[r]], pct);
    }
  }
  uint8_t dominant, runnerUp;
  topTwo(ss_scores, dominant, runnerUp);
  char buf[24];
  // Keep this exactly in step with the `primary` value sent to the dashboard.
  // The card already shows calibration state above the footer.
  if (ss_scores[dominant] < ODOR_MIN_CONF) {
    strlcpy(buf, "Dominant: clean air", sizeof(buf));
  } else {
    snprintf(buf, sizeof(buf), "Dominant: %s", odorShort[dominant]);
  }
  display.setCursor(0, 55);
  display.print(buf);
}

static void shortCat(const char* in, char* out, size_t len) {
  if (!strcasecmp(in, "Moderate"))       strlcpy(out, "Mod", len);
  else if (!strcasecmp(in, "Very High")) strlcpy(out, "VHigh", len);
  else if (!strcasecmp(in, "Very Low"))  strlcpy(out, "VLow", len);
  else { strlcpy(out, in, len); if (strlen(out) > 5) out[5] = '\0'; }
}

static void cardAllergens(const NetStatus& n) {
  drawHeader("Allergens & Mold");
  if (!homeFresh(n)) {
    display.setCursor(0, 24);
    display.print(F("Waiting for dashboard"));
    return;
  }
  char r[8];
  shortCat(n.home.moldCat, r, sizeof(r));   drawMiniBar(13, "Mold",  n.home.moldPct, r);
  shortCat(n.home.miteCat, r, sizeof(r));   drawMiniBar(23, "Mites", n.home.mitePct, r);
  shortCat(n.home.dryCat, r, sizeof(r));    drawMiniBar(33, "Dry",   n.home.dryPct, r);
  shortCat(n.home.petLevel, r, sizeof(r));  drawMiniBar(43, "Pet",   n.home.petIdx, r);
  display.setCursor(0, 55);
  display.print(F("estimates"));
}

static void cardOutdoor(const NetStatus& n) {
  char city[13];
  strlcpy(city, n.city, sizeof(city));
  const bool trend = ss_pressTrend[0] != '\0';
  drawHeader("Outdoor", trend ? ss_pressTrend : (city[0] ? city : nullptr));
  if (!n.aqi.valid) {
    display.setCursor(0, 24);
    display.print(n.connected ? F("Fetching outdoor air") : F("WiFi offline"));
    return;
  }
  const bool fresh = outdoorFresh(n.aqi);
  char buf[24];
  if (n.weather.valid)
    snprintf(buf, sizeof(buf), "%dF feel %d", n.weather.tempF, n.weather.feelsLikeF);
  else
    strlcpy(buf, "--", sizeof(buf));
  display.setCursor(0, 12);
  display.print(buf);

  display.setCursor(0, 21);
  if (!fresh || !n.weather.valid) display.print(F("Env data stale"));
  else display.print(n.weather.condition);

  int wind = 0;
  if (n.weather.valid) sscanf(n.weather.windSpeed, "%d", &wind);
  snprintf(buf, sizeof(buf), "%.3s %d  AQI %d",
           n.weather.windDir[0] ? n.weather.windDir : "--", wind, n.aqi.aqi);
  display.setCursor(0, 30);
  display.print(buf);

  char cat[9];
  strlcpy(cat, n.aqi.level, sizeof(cat));
  if (isfinite(n.aqi.pm25)) snprintf(buf, sizeof(buf), "PM2.5 %.0f %.8s", n.aqi.pm25, cat);
  else snprintf(buf, sizeof(buf), "PM2.5 -- %.8s", cat);
  display.setCursor(0, 39);
  display.print(buf);

  if (fresh && n.aqi.pollenValid) {
    snprintf(buf, sizeof(buf), "Pol T%d G%d W%d %.6s",
             n.aqi.pollenTree, n.aqi.pollenGrass, n.aqi.pollenWeed, n.aqi.pollenTop);
    if (strlen(buf) > 21) buf[21] = '\0';
  } else {
    strlcpy(buf, "Pollen --", sizeof(buf));
  }
  display.setCursor(0, 48);
  display.print(buf);
}

// Word-wrap plain ASCII text into 21-column lines starting at y (9 px pitch).
// If the text needs more than maxLines, the last line ends with "...".
static void drawWrapped(const char* text, int y, int maxLines) {
  char line[24];
  int len = strlen(text), pos = 0, lines = 0;
  while (pos < len && lines < maxLines) {
    while (text[pos] == ' ') pos++;
    int end = min(pos + 21, len);
    if (end < len) {
      int brk = end;
      while (brk > pos && text[brk] != ' ') brk--;
      if (brk > pos) end = brk;
    }
    int n = end - pos;
    memcpy(line, text + pos, n);
    line[n] = '\0';
    pos = end;
    lines++;
    if (lines == maxLines && pos < len) {   // overflow: trim and add an ellipsis
      if (n > 18) n = 18;
      while (n > 0 && line[n - 1] == ' ') n--;
      strcpy(line + n, "...");
    }
    display.setCursor(0, y + (lines - 1) * 9);
    display.print(line);
  }
}

static void cardSnark(const NetStatus& n) {
  drawHeader("SniffMaster Says");
  if (n.snark[0]) {
    drawWrapped(n.snark, 11, 6);
  } else if (homeFresh(n) && n.home.headline[0]) {
    drawWrapped(n.home.headline, 11, 6);
  } else {
    display.setCursor(0, 24);
    display.print(n.connected ? F("Thinking of an insult") : F("WiFi offline"));
  }
}

static void cardNetwork(const NetStatus& n) {
  drawHeader("Network");
  char buf[24];
  if (n.connected) {
    strlcpy(buf, n.ssid, 22);
    display.setCursor(0, 13); display.print(buf);
    int sigQ = constrain(map(n.rssi, -90, -30, 0, 100), 0, 100);
    snprintf(buf, sizeof(buf), "%ddBm", n.rssi);
    drawMiniBar(23, "Signal", sigQ, buf);
    if (n.lastPostMs) {
      unsigned long ago = (millis() - n.lastPostMs) / 1000UL;
      snprintf(buf, sizeof(buf), "Synced %lu%s ago", ago < 60 ? ago : ago / 60, ago < 60 ? "s" : "m");
    } else {
      strlcpy(buf, "Sync pending", sizeof(buf));
    }
    display.setCursor(0, 34); display.print(buf);
  } else {
    display.setCursor(0, 16); display.print(F("WiFi reconnecting..."));
  }
  const unsigned long upMin = millis() / 60000UL;
  snprintf(buf, sizeof(buf), "Up %luh%02lum Heap %uK", upMin / 60, upMin % 60,
           (unsigned)(ESP.getFreeHeap() / 1024));
  display.setCursor(0, 46); display.print(buf);
}


// ── Retro wall deck ────────────────────────────────────────────
// Four glanceable cards for a wall. Outline ticks and a dotted rule only:
// a solid white header ghosts on this SSD1306. A blinking lamp and one
// blinking tick are the animation, redrawn twice a second (updateDisplay).
// The inverse "CRT scan line" was removed because it punched holes in text.
static bool wallFresh(const NetStatus& n) {
  return n.wall.valid && millis() - n.wall.fetchedMs < 5UL * 60UL * 1000UL;
}
static inline bool wallBlink() { return (millis() / 500UL) & 1UL; }

static void retroCorners() {
  const int x1 = SCREEN_WIDTH - 1, y0 = 12, y1 = SCREEN_HEIGHT - 1;
  display.drawFastHLine(0, y0, 4, SSD1306_WHITE);  display.drawFastVLine(0, y0, 4, SSD1306_WHITE);
  display.drawFastHLine(x1 - 3, y0, 4, SSD1306_WHITE); display.drawFastVLine(x1, y0, 4, SSD1306_WHITE);
  display.drawFastHLine(0, y1, 4, SSD1306_WHITE);  display.drawFastVLine(0, y1 - 3, 4, SSD1306_WHITE);
  display.drawFastHLine(x1 - 3, y1, 4, SSD1306_WHITE); display.drawFastVLine(x1, y1 - 3, 4, SSD1306_WHITE);
}

static const char* aqiWord(int a) {
  return a <= 50 ? "GOOD" : a <= 100 ? "MODERATE" : a <= 150 ? "SENSITIVE" :
         a <= 200 ? "UNHEALTHY" : a <= 300 ? "VERY UNHEALTHY" : "HAZARDOUS";
}

static void pollenLine(char* out, size_t n, const WallStatus& w) {
  if (w.pn[0]) snprintf(out, n, "%.9s: %.8s", w.pn, w.pl);
  else         snprintf(out, n, "POLLEN: %.8s", w.pl);
}

static void wallChrome(const char* tag, bool alert, bool live) {
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.print(F("SNIFF//"));
  display.print(tag);
  if (!live) {
    printRight(0, "N/C");
  } else if (wallBlink()) {
    display.fillRect(123, 1, 4, 4, SSD1306_WHITE);
  } else {
    display.drawRect(123, 1, 4, 4, SSD1306_WHITE);
  }
  if (alert && wallBlink()) display.drawFastHLine(0, 8, SCREEN_WIDTH, SSD1306_WHITE);
  else for (int x = 0; x < SCREEN_WIDTH; x += 2) display.drawPixel(x, 8, SSD1306_WHITE);
  retroCorners();
}

// One blinking tick marks the current value. The rest stay hollow so the
// panel is not a slab of white (that ghosts on this OLED).
static void tickGauge(int y, int lit, int n = 20) {
  lit = constrain(lit, 0, n);
  for (int i = 0; i < n; i++) {
    const int x = 4 + i * 6;
    const bool on = i < lit || (i == lit && wallBlink());
    if (on) display.fillRect(x, y, 3, 5, SSD1306_WHITE);
    else    display.drawRect(x, y, 3, 5, SSD1306_WHITE);
  }
}

static void drawSpark(HistId id, int x, int y, int w, int h, float minSpan) {
  if (histFilled < 2) {
    const int mid = y + h / 2;
    for (int i = 0; i < w; i += 3) display.drawPixel(x + i, mid, SSD1306_WHITE);
    display.fillRect(x + (int)((millis() / 80UL) % (unsigned)w), mid - 1, 2, 3, SSD1306_WHITE);
    return;
  }
  float lo = 1e9f, hi = -1e9f;
  for (uint8_t i = 0; i < histFilled; i++) {
    float v = histBuf[id][(histHead - histFilled + i + HIST_LEN) % HIST_LEN];
    lo = min(lo, v); hi = max(hi, v);
  }
  if (hi - lo < minSpan) { float mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  int px = 0, py = 0;
  for (uint8_t i = 0; i < histFilled; i++) {
    float v = histBuf[id][(histHead - histFilled + i + HIST_LEN) % HIST_LEN];
    int cx = x + (histFilled == 1 ? 0 : i * (w - 1) / (histFilled - 1));
    int cy = y + h - 1 - (int)((v - lo) / (hi - lo) * (h - 1));
    if (i) display.drawLine(px, py, cx, cy, SSD1306_WHITE);
    px = cx; py = cy;
  }
}

static int deckScore(const NetStatus& n) {
  if (homeFresh(n)) return constrain(n.home.score, 0, 100);
  return constrain(100 - ss_airScore, 0, 100);
}

// Short lines for a clean room. ASCII, <= 20 columns. Rotates every 8 s.
static const char* const FINE_LINES[] = {
  "AIR: BORING. GOOD.",
  "NOSE REPORTS CLEAR",
  "CATS UNBOTHERED",
  "FILTERS CAN NAP",
  "ROOM SMELLS LIKE ROOM",
  "SCIENCE SAYS: FINE",
  "ODOR LEVEL: NONE",
  "BREATHE EASY, HUMAN",
};
static const char* fineLine() {
  return FINE_LINES[(millis() / 8000UL) % ARRAY_LEN(FINE_LINES)];
}

static void deckFooter(const NetStatus& n, bool bad) {
  char b[22];
  const char* msg = fineLine();
  if (bad) {
    if (n.wall.ac[0][0]) msg = n.wall.ac[0];
    else if (n.wall.ca[0]) msg = n.wall.ca;
    else msg = "OPEN A WINDOW";
  } else if (n.snark[0]) {
    msg = n.snark;
  }
  snprintf(b, sizeof(b), "> %.18s", msg);
  display.setCursor(0, 55);
  display.print(b);
}

static void cardWallBridge(const NetStatus& n) {
  const bool bad = wallFresh(n) && (!strcmp(n.wall.sm, "SMELLY") || !strcmp(n.wall.sm, "DANGER"));
  wallChrome("BRIDGE", bad || hazardActive, n.connected);
  char b[16];
  snprintf(b, sizeof(b), "%d", deckScore(n));
  display.setTextSize(2);
  display.setCursor(2, 12);
  display.print(b);
  display.setTextSize(1);
  const char* mood = wallFresh(n) && n.wall.sm[0] ? n.wall.sm : iaqQuality(ss_iaq);
  display.setCursor(44, 16);
  display.print(mood);
  tickGauge(32, deckScore(n) / 5);
  snprintf(b, sizeof(b), "%dF", (int)(ss_tempF + 0.5f));
  display.setCursor(2, 42); display.print(b);
  snprintf(b, sizeof(b), "%d%%", (int)(ss_hum + 0.5f));
  display.setCursor(40, 42); display.print(b);
  snprintf(b, sizeof(b), "IAQ %.0f", ss_iaq);
  printRight(42, b);
  deckFooter(n, bad);
}

static void traceRow(const char* name, const char* value, HistId id, float span, int y) {
  display.setCursor(0, y);
  display.print(name);
  drawSpark(id, 32, y, 62, 8, span);
  printRight(y, value);
}

static void cardWallTrace(const NetStatus& n) {
  const bool bad = ss_iaq >= 150 || ss_co2 >= 1500;
  wallChrome("TRACE", bad, n.connected);
  char b[12];
  snprintf(b, sizeof(b), "%.0f", ss_iaq);          traceRow("IAQ", b, H_IAQ, 20, 12);
  snprintf(b, sizeof(b), ss_voc < 10 ? "%.1f" : "%.0f", ss_voc);
  traceRow("VOC", b, H_VOC, 0.4f, 26);
  snprintf(b, sizeof(b), "%.0f", ss_co2);          traceRow("CO2", b, H_CO2, 80, 40);
  display.setCursor(0, 55);
  if (!bsecCalibrationReady(ss_iaqAcc)) display.print(F("> SENSOR WARMING"));
  else if (bad)                         display.print(F("> TRACE IS HIGH"));
  else                                  display.print(F("> TRACE IS STEADY"));
}

static void cardWallOdor(const NetStatus& n) {
  wallChrome("ODOR", hazardActive, n.connected);
  if (!bsecCalibrationReady(ss_iaqAcc)) {
    display.setTextSize(2);
    display.setCursor(2, 14); display.print(F("WARM"));
    display.setTextSize(1);
    display.setCursor(2, 36); display.print(F("> NOSE IS LEARNING"));
    display.setCursor(2, 46); display.print(F("> ODORS IN A BIT"));
    return;
  }
  uint8_t idx[ODOR_COUNT];
  for (uint8_t i = 0; i < ODOR_COUNT; i++) idx[i] = i;
  for (uint8_t i = 0; i < 3; i++)
    for (uint8_t j = i + 1; j < ODOR_COUNT; j++)
      if (ss_scores[idx[j]] > ss_scores[idx[i]]) { uint8_t t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  display.setTextSize(2);
  display.setCursor(2, 11);
  display.print(odorShort[idx[0]]);
  display.setTextSize(1);
  char b[8];
  snprintf(b, sizeof(b), "%u%%", ss_scores[idx[0]]);
  printRight(14, b);
  tickGauge(30, ss_scores[idx[0]] / 5);
  for (uint8_t r = 1; r < 3; r++) {
    snprintf(b, sizeof(b), "%u%%", ss_scores[idx[r]]);
    display.setCursor(r == 1 ? 2 : 66, 42);
    display.print(odorShort[idx[r]]);
    display.print(' ');
    display.print(b);
  }
  const bool bad = wallFresh(n) && (!strcmp(n.wall.sm, "SMELLY") || !strcmp(n.wall.sm, "DANGER"));
  deckFooter(n, bad);
}

static void cardWallSky(const NetStatus& n) {
  const WallStatus& w = n.wall;
  const bool bad = wallFresh(n) && w.aq > 100;
  wallChrome("SKY", bad, n.connected);
  char b[20];
  if (!wallFresh(n) || w.aq < 0) {
    snprintf(b, sizeof(b), "%d", (int)(ss_tempF + 0.5f));
    display.setTextSize(2);
    display.setCursor(2, 12); display.print(b);
    display.setTextSize(1);
    display.setCursor(2 + (int)strlen(b) * 12 + 2, 18); display.print(F("F LOCAL"));
    snprintf(b, sizeof(b), "RH %d%%", (int)(ss_hum + 0.5f));
    display.setCursor(2, 34); display.print(b);
    snprintf(b, sizeof(b), "%.0f hPa", pressToHpa(ss_pressure));
    printRight(34, b);
    display.setCursor(0, 55);
    display.print(n.connected ? F("> SKY NET LINKING") : F("> SKY NET OFFLINE"));
    return;
  }
  snprintf(b, sizeof(b), "%d", w.aq);
  display.setTextSize(2);
  display.setCursor(2, 12); display.print(b);
  display.setTextSize(1);
  display.setCursor(2 + (int)strlen(b) * 12 + 3, 14); display.print(F("AQI"));
  display.setCursor(2 + (int)strlen(b) * 12 + 3, 23); display.print(aqiWord(w.aq));
  if (w.ot > -900) { snprintf(b, sizeof(b), "%dF", w.ot); printRight(14, b); }
  if (isnan(w.uv)) strlcpy(b, "UV --", sizeof(b)); else snprintf(b, sizeof(b), "UV %.1f", w.uv);
  display.setCursor(2, 36); display.print(b);
  pollenLine(b, sizeof(b), w);
  display.setCursor(2, 46); display.print(b);
  display.setCursor(0, 55);
  if (w.wn[0]) { snprintf(b, sizeof(b), "> %.18s", w.wn); display.print(b); }
  else         display.print(F("> WINDOWS: NO NOTE"));
}

enum CardId : uint8_t {
  C_WALL_BRIDGE, C_WALL_TRACE, C_WALL_ODOR, C_WALL_SKY,
  C_HOME, C_IAQ, C_VOC, C_CO2, C_TEMP, C_HUM, C_PRESS, C_ODORS,
  C_ALLERGEN, C_OUTDOOR, C_SNARK, C_NETWORK, C_COUNT
};
#define NUM_PAGES C_COUNT
static bool isWallPage(uint8_t page) { return page <= C_WALL_SKY; }

static void renderCurrentPage() {
  const NetStatus n = copyNetStatus();
  display.clearDisplay();
  display.setTextSize(1);
  switch (displayPage) {
    case C_WALL_BRIDGE: cardWallBridge(n); break;
    case C_WALL_TRACE:  cardWallTrace(n);  break;
    case C_WALL_ODOR:   cardWallOdor(n);   break;
    case C_WALL_SKY:    cardWallSky(n);    break;
    case C_HOME:     cardHomeScore(n); break;
    case C_IAQ:      cardIaq();        break;
    case C_VOC:      cardVoc();        break;
    case C_CO2:      cardCo2();        break;
    case C_TEMP:     cardTemp(n);      break;
    case C_HUM:      cardHumidity();   break;
    case C_PRESS:    cardPressure();   break;
    case C_ODORS:    cardOdors();      break;
    case C_ALLERGEN: cardAllergens(n); break;
    case C_OUTDOOR:  cardOutdoor(n);   break;
    case C_SNARK:    cardSnark(n);     break;
    default:         cardNetwork(n);   break;
  }
  display.display();
}

static void drawSplash() {
  display.clearDisplay();
  display.drawCircle(64, 16, 12, SSD1306_WHITE);
  display.drawCircle(64, 16, 4, SSD1306_WHITE);
  display.drawLine(64, 16, 74, 8, SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(28, 34); display.print(F("SNIFFMASTER"));
  display.setCursor(16, 46); display.print(F("WALL DECK ARMED"));
  display.setCursor(4, 56);  display.print(F("Tap page  Hold sync"));
  display.display();
}

// ══════════════════════════════════════════════════════════════
// Alerts
// ══════════════════════════════════════════════════════════════

static void checkAirAlerts(float iaq, float voc, float co2, float hum,
                           const uint8_t scores[], uint8_t iaqAcc, int outdoorAqi,
                           bool ventShutEdge, bool windowsShut) {
  if (!bsecCalibrationReady(iaqAcc)) return;   // warm-up transients false-trigger
  const unsigned long now = millis();

  // Hazard detection with hysteresis so the alarm doesn't flap
  const uint8_t smokeGas = max(scores[OD_SMOKE], scores[OD_GASOLINE]);
  const bool smokeHaz = smokeGas >= (hazardActive ? HAZ_SMOKE_GAS_OFF : HAZ_SMOKE_GAS_ON);
  const bool iaqHaz   = iaq      >= (hazardActive ? HAZ_IAQ_OFF       : HAZ_IAQ_ON);
  const bool co2Haz   = co2      >= (hazardActive ? HAZ_CO2_OFF       : HAZ_CO2_ON);

  if (smokeHaz || iaqHaz || co2Haz) {
    if (!hazardActive) {
      hazardActive = true;
      hazardMuted = false;
      lastHazardAlarmMs = 0;
      Serial.printf("[ALERT] HAZARD on (smoke/gas=%u iaq=%.0f co2=%.0f)\n", smokeGas, iaq, co2);
      requestPortalPush();
    }
    if (!hazardMuted && (lastHazardAlarmMs == 0 || now - lastHazardAlarmMs >= HAZ_REPEAT_MS)) {
      lastHazardAlarmMs = now;
      if (smokeHaz)    showOverlay("!! DANGER !!", "Smoke or gas detected\nCheck source NOW.\nVentilate / get out.", HAZ_SCREEN_MS, true);
      else if (iaqHaz) showOverlay("!! BAD AIR !!", "Air quality unhealthy\nOpen windows now.\nConsider leaving.", HAZ_SCREEN_MS, true);
      else             showOverlay("!! HIGH CO2 !!", "CO2 dangerously high\nVentilate now.", HAZ_SCREEN_MS, true);
      alarmStart();
    }
    return;
  }

  if (hazardActive) {
    hazardActive = false;
    hazardMuted = false;
    alarmStop();
    if (overlayActive && overlayIsHazard) dismissOverlay();
    Serial.println(F("[ALERT] Hazard cleared"));
    requestPortalPush();
    forceRedraw = true;
  }

  // Silent advisories
  if (advisoryEverShown && now - lastAdvisoryMs < ADVISORY_COOLDOWN_MS) return;
  const char* title = nullptr;
  const char* msg = nullptr;
  if (ventShutEdge)        { title = "WINDOWS SHUT"; msg = "Outdoor air or pollen\nis high. Keep windows\nclosed."; }
  else if (co2 > 1500)     { title = "HIGH CO2";     msg = windowsShut ? "CO2 elevated.\nKeep windows closed." : "CO2 elevated.\nOpen a window."; }
  else if (iaq > 150)      { title = "STALE AIR";    msg = windowsShut ? "Indoor air is stale.\nKeep windows closed." : "Air quality declining\nConsider opening\na window."; }
  else if (voc > 5.0f)     { title = "ELEVATED VOC"; msg = windowsShut ? "Volatile compounds\nrising. Filter the air." : "Volatile compounds\nrising. Ventilate."; }
  else if (hum > 75)       { title = "HIGH HUMIDITY"; msg = windowsShut ? "Humidity is high.\nDehumidify the room." : "Humidity is high.\nDehumidify or vent."; }
  else if (outdoorAqi > 150) {
    title = "OUTDOOR AQI"; msg = "Outdoor air unhealthy\nKeep windows closed.";
  }
  if (!title) return;

  lastAdvisoryMs = now;
  advisoryEverShown = true;
  Serial.printf("[ALERT] Advisory: %s\n", title);
  showOverlay(title, msg, ADVISORY_SCREEN_MS, false);
}

// ══════════════════════════════════════════════════════════════
// BSEC persistence + setup helpers
// ══════════════════════════════════════════════════════════════

static void loadBsecState() {
  resetHomeBaseline();
  calState = { false, false, false, 0, 0xFF };

  if (!bsecPrefs.begin(BSEC_NVS_NS, /*readOnly=*/false)) {
    Serial.println(F("[BSEC] Preferences open failed — cold start"));
    return;
  }

  // Legacy unversioned blob: unknown config provenance → discard.
  if (bsecPrefs.isKey(BSEC_NVS_KEY)) {
    bsecPrefs.remove(BSEC_NVS_KEY);
    Serial.println(F("[BSEC] Erased legacy state blob"));
  }

  // Boot-loop guard: the guard is set before setState() and cleared once the
  // first sensor packet arrives. If it is still set, the last restore never
  // produced data (crash or hang) — drop the state and cold start.
  if (bsecPrefs.getBool(BSEC_GUARD_KEY, false)) {
    bsecPrefs.remove(BSEC_STATE_KEY);
    bsecPrefs.remove(BSEC_GUARD_KEY);
    Serial.println(F("[BSEC] Previous restore never produced data — cold start"));
  } else if (bsecPrefs.isKey(BSEC_STATE_KEY) &&
             bsecPrefs.getBytesLength(BSEC_STATE_KEY) == sizeof(PersistedBsecState)) {
    static PersistedBsecState st;   // ~230 B; static keeps it off the loop stack
    bsecPrefs.getBytes(BSEC_STATE_KEY, &st, sizeof(st));
    if (st.magic == BSEC_STATE_MAGIC && st.version == BSEC_STATE_VER &&
        st.blobLen == BSEC_MAX_STATE_BLOB_SIZE && strncmp(st.cfgId, bsecCfgId, sizeof(st.cfgId)) == 0) {
      bsecPrefs.putBool(BSEC_GUARD_KEY, true);
      calState.bsecStateLoaded = envSensor.setState(st.blob);
      if (calState.bsecStateLoaded) {
        bsecEverSaved = true;
        Serial.printf("[BSEC] Saved state loaded (%s) — warm resume\n", bsecCfgId);
      } else {
        bsecPrefs.remove(BSEC_STATE_KEY);
        bsecPrefs.remove(BSEC_GUARD_KEY);
        Serial.println(F("[BSEC] setState rejected blob — cold start"));
      }
    } else {
      bsecPrefs.remove(BSEC_STATE_KEY);
      Serial.println(F("[BSEC] Saved state mismatched (magic/version/config) — cold start"));
    }
  } else {
    Serial.println(F("[BSEC] No saved state — cold start"));
  }

  if (bsecPrefs.isKey(BSEC_HOME_KEY) &&
      bsecPrefs.getBytesLength(BSEC_HOME_KEY) == sizeof(PersistedHomeBaseline)) {
    PersistedHomeBaseline st = {};
    bsecPrefs.getBytes(BSEC_HOME_KEY, &st, sizeof(st));
    if (st.magic == HOME_BASE_MAGIC && st.version == HOME_BASE_VER) {
      HomeOdorBaseline restored = { st.ready != 0, st.calmSamples, st.voc, st.iaq,
                                    st.co2, st.gasR, st.hum, st.pressHpa };
      if (homeBaseLooksValid(restored)) {
        homeBase = restored;
        Serial.printf("[CAL] Restored home baseline (%u calm samples)\n", homeBase.calmSamples);
      } else {
        Serial.println(F("[CAL] Saved home baseline invalid — relearning"));
      }
    }
  } else {
    Serial.println(F("[CAL] No saved home baseline — relearning room"));
  }
  bsecPrefs.end();
}

static void saveBsecState() {
  if (latestIAQAccuracy == 0) return;   // never persist an uncalibrated state
  static PersistedBsecState st;
  memset(&st, 0, sizeof(st));
  st.magic = BSEC_STATE_MAGIC;
  st.version = BSEC_STATE_VER;
  st.blobLen = BSEC_MAX_STATE_BLOB_SIZE;
  strlcpy(st.cfgId, bsecCfgId, sizeof(st.cfgId));
  if (!envSensor.getState(st.blob)) {
    Serial.println(F("[BSEC] getState failed — state not saved"));
    return;
  }
  if (!bsecPrefs.begin(BSEC_NVS_NS, /*readOnly=*/false)) {
    Serial.println(F("[BSEC] Preferences open failed — state not saved"));
    return;
  }
  bsecPrefs.putBytes(BSEC_STATE_KEY, &st, sizeof(st));
  if (homeBase.ready && homeBaseLooksValid(homeBase)) {
    PersistedHomeBaseline st = {
      HOME_BASE_MAGIC, HOME_BASE_VER, homeBase.calmSamples, 1, {0, 0, 0},
      homeBase.voc, homeBase.iaq, homeBase.co2, homeBase.gasR, homeBase.hum, homeBase.pressHpa
    };
    bsecPrefs.putBytes(BSEC_HOME_KEY, &st, sizeof(st));
    calState.homeBaseDirty = false;
  }
  bsecPrefs.end();
  lastBsecSaveMs = millis();
  bsecEverSaved = true;
  Serial.printf("[BSEC] State saved (%s, acc=%u)\n", bsecCfgId, latestIAQAccuracy);
}

static void eraseBsecState(const char* why) {
  if (!bsecPrefs.begin(BSEC_NVS_NS, false)) return;
  bsecPrefs.remove(BSEC_STATE_KEY);
  bsecPrefs.remove(BSEC_GUARD_KEY);
  bsecPrefs.end();
  calState.bsecStateLoaded = false;
  bsecEverSaved = false;
  Serial.printf("[BSEC] Saved state erased (%s)\n", why);
}

static void clearRestoreGuard() {
  if (!bsecPrefs.begin(BSEC_NVS_NS, false)) return;
  if (bsecPrefs.isKey(BSEC_GUARD_KEY)) bsecPrefs.remove(BSEC_GUARD_KEY);
  bsecPrefs.end();
}

// LP (3 s) only — ULP (300 s) misses every transient this device exists for.
static bool subscribeBsecOutputs(const char* context) {
  bsecFullBundle = bsecRawExtras = false;

#if SM_BSEC_RAW_EXTRAS
  // Full list + raw temp/humidity diagnostics
  bsecSensor withExtras[ARRAY_LEN(sensorList) + ARRAY_LEN(sensorListRawExtras)];
  memcpy(withExtras, sensorList, sizeof(sensorList));
  memcpy(withExtras + ARRAY_LEN(sensorList), sensorListRawExtras, sizeof(sensorListRawExtras));
  if (envSensor.updateSubscription(withExtras, ARRAY_LEN(withExtras), BSEC_SAMPLE_RATE_LP)) {
    bsecFullBundle = bsecRawExtras = true;
  } else
#endif
  if (envSensor.updateSubscription(sensorList, ARRAY_LEN(sensorList), BSEC_SAMPLE_RATE_LP)) {
    bsecFullBundle = true;
  } else if (envSensor.updateSubscription(sensorListLpSafe, ARRAY_LEN(sensorListLpSafe), BSEC_SAMPLE_RATE_LP)) {
    latestCompGas = latestGasPct = 0;
  } else {
    Serial.printf("[BSEC] %s: subscription failed status=%d sensor=%d (will retry)\n",
                  context, (int)envSensor.status, (int)envSensor.sensor.status);
    return false;
  }
  Serial.printf("[BSEC] %s: cfg=%s bundle=%s raw=%s rate=LP\n", context, bsecCfgId,
                bsecFullBundle ? "full" : "safe", bsecRawExtras ? "yes" : "no");
  return true;
}

// Bosch delay callback: sleep for most of the wait, busy-wait only the tail
static void safeBmeDelayUs(uint32_t periodUs, void* intfPtr) {
  (void)intfPtr;
  const uint32_t lagUs = 5000UL;
  const uint32_t start = micros();
  if (periodUs > lagUs) {
    delay((periodUs - lagUs) / 1000UL);
    while ((uint32_t)(micros() - start) < (periodUs - lagUs)) delay(1);
  }
  while ((uint32_t)(micros() - start) < periodUs) { }
}

static void onSensorData(const bme68xData data, const bsecOutputs outputs, const Bsec2 bsec) {
  (void)bsec;
  // Only trust gas resistance from a heat-stable, valid measurement; hold the
  // previous value otherwise. T/RH/P and BSEC virtual sensors are still used.
  latestGasValid = (data.status & BME68X_GASM_VALID_MSK) && (data.status & BME68X_HEAT_STAB_MSK);
  for (uint8_t i = 0; i < outputs.nOutputs; i++) {
    const bsecData &o = outputs.output[i];
    switch (o.sensor_id) {
      case BSEC_OUTPUT_BREATH_VOC_EQUIVALENT:               latestVocRaw = o.signal; break;
      case BSEC_OUTPUT_IAQ: latestIAQ = o.signal; latestIAQAccuracy = o.accuracy;  break;
      case BSEC_OUTPUT_STATIC_IAQ:                          latestStaticIAQ = o.signal; break;
      case BSEC_OUTPUT_CO2_EQUIVALENT:                      latestCO2 = o.signal; break;
      case BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_TEMPERATURE: latestTemp = o.signal; break;
      case BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_HUMIDITY:    latestHumidity = o.signal; break;
      case BSEC_OUTPUT_RAW_PRESSURE:                        latestPressure = o.signal; break;
      case BSEC_OUTPUT_RAW_GAS:          if (latestGasValid) latestGasR = o.signal; break;
      case BSEC_OUTPUT_RAW_TEMPERATURE:                     latestRawTempC = o.signal; break;
      case BSEC_OUTPUT_RAW_HUMIDITY:                        latestRawHum = o.signal; break;
      case BSEC_OUTPUT_COMPENSATED_GAS:                     latestCompGas = o.signal; break;
      case BSEC_OUTPUT_GAS_PERCENTAGE:                      latestGasPct = o.signal; break;
      case BSEC_OUTPUT_STABILIZATION_STATUS:                latestStabStatus = o.signal; break;
      case BSEC_OUTPUT_RUN_IN_STATUS:                       latestRunInStatus = o.signal; break;
    }
  }
  // Wait for the first valid gas reading before publishing a snapshot.
  if (latestGasR > 0) newDataReady = true;
}

// ══════════════════════════════════════════════════════════════
// Sample processing (loop task)
// ══════════════════════════════════════════════════════════════

static void processSample(unsigned long now) {
  newDataReady = false;
  const bool hadValid = ss_valid;

  const float iaq = latestIAQ, co2 = latestCO2, hum = latestHumidity;
  const float pressure = latestPressure, gasR = latestGasR;
  const uint8_t iaqAcc = latestIAQAccuracy;
  const float tempF = latestTemp * 9.0f / 5.0f + 32.0f;
  const float hpa = pressToHpa(pressure);

  const float voc = pushAndSmooth(latestVocRaw);
  const float vocDelta = voc - ss_prevVoc;
  const float dVoc = vocDelta > 0.0f ? vocDelta : 0.0f;   // rising only
  ss_prevVoc = voc;
  const uint8_t tier = smellTier(voc);
  pushTrend(iaq, voc);
  updateCalibrationRuntimeState(iaqAcc, latestStabStatus, latestRunInStatus);
  const bool calReady = bsecCalibrationReady(iaqAcc);

  if (calReady && ss_prevTier != 0xFF && tier != ss_prevTier) requestPortalPush();
  ss_prevTier = tier;

  uint8_t scores[ODOR_COUNT] = {0};
  scoreOdors(voc, iaq, co2, tempF, hum, hpa, gasR, dVoc, scores);   // fills 0..11
  correctOdorScores(scores, voc, iaq, co2, gasR, dVoc, hum);
  updateHomeBaseline(voc, iaq, co2, gasR, hum, hpa, iaqAcc, fabsf(vocDelta), scores);
  applyHomeMlTuning(scores, voc, iaq, co2, gasR, dVoc, hum, iaqAcc);
  deriveExpandedOdors(scores, voc, iaq, co2, gasR, dVoc, hum, iaqAcc);
  stabilizePrimaryOdor(scores, iaqAcc);

  const OutdoorSnap outdoor = copyOutdoorSnap();
  const int outdoorAqi = outdoor.fresh ? outdoor.usAqi : 0;
  const int airScore = computeAirScore(iaq, voc, co2, hum, scores, outdoorAqi);
  const int roomScore = computeAirScore(latestStaticIAQ, voc, co2, hum, scores, outdoorAqi);
  const float dewF = envDewPointF(latestTemp, hum);
  if (!lastPressSampleMs || now - lastPressSampleMs >= 15UL * 60UL * 1000UL) {
    gPressTrend.push(hpa);
    lastPressSampleMs = now;
  }
  strlcpy(ss_pressTrend, gPressTrend.label(), sizeof(ss_pressTrend));

  EnvVentInput vin = {};
  vin.outdoorFresh = outdoor.fresh;
  vin.staticIaq = latestStaticIAQ;
  vin.co2eq = co2;
  vin.voc = voc;
  vin.indoorRh = hum;
  vin.indoorTempF = tempF;
  vin.outdoorDewF = outdoor.dewF;
  vin.usAqi = outdoor.usAqi;
  vin.pm25 = outdoor.pm25;
  vin.pollenTree = outdoor.tree;
  vin.pollenGrass = outdoor.grass;
  vin.pollenWeed = outdoor.weed;
  const EnvVentDecision vent = envVentilation(vin);
  const bool ventShutEdge = vent.reason == VENT_OUTDOOR &&
                            strcmp(ss_prevVent, "shut") != 0;

  bool disagree = false;
  if (outdoor.fresh && outdoor.pressValid && fabsf(hpa - outdoor.pressHpa) > 8.0f) {
    disagree = true;
    if (!ss_pressDisagree)
      Serial.printf("[PRESS] BME %.1f hPa vs forecast %.1f hPa\n", hpa, outdoor.pressHpa);
  }
  ss_pressDisagree = disagree;

  ss_voc = voc; ss_iaq = iaq; ss_co2 = co2; ss_tempF = tempF; ss_hum = hum;
  ss_pressure = pressure; ss_gasR = gasR; ss_dvoc = vocDelta;
  ss_stabStatus = latestStabStatus; ss_runInStatus = latestRunInStatus;
  ss_iaqAcc = iaqAcc; ss_tier = tier; ss_airScore = airScore; ss_roomScore = roomScore;
  ss_dewF = dewF;
  strlcpy(ss_vent, vent.vent, sizeof(ss_vent));
  memcpy(ss_scores, scores, sizeof(ss_scores));
  ss_valid = true;
  if (!hadValid) {
    forceRedraw = true;
    lastPageAdvanceMs = now;
    if (calState.bsecStateLoaded) clearRestoreGuard();   // restore proven good
  }

  uint8_t i1, i2;
  topTwo(scores, i1, i2);

  // ── Fart detection (silent) ────────────────────────────────
  {
    const bool fartIsPrimary = (i1 == OD_FART);
    const bool bioEvidence = scores[OD_SULFUR] >= 15 || scores[OD_GARBAGE] >= 20 ||
                             (gasR / 1000.0f < 120.0f && iaq > 60.0f);
    const bool rearmed = ss_prevFartConf < 20 ||
                         (ss_peakFartConf > 0 && ss_prevFartConf <= ss_peakFartConf - 15);
    if (scores[OD_FART] >= 40 && rearmed && calReady && (fartIsPrimary || bioEvidence) &&
        dVoc > 0.3f && (lastFartMs == 0 || now - lastFartMs >= FART_COOLDOWN_MS)) {
      fartCount++;
      lastFartMs = now;
      ss_peakFartConf = 0;
      if (voc > biggestFartVoc) biggestFartVoc = voc;
      Serial.printf("[FART] #%d VOC=%.2f dVOC=%.2f score=%d\n", fartCount, voc, dVoc, scores[OD_FART]);
      requestPortalPush();
    }
    ss_prevFartConf = scores[OD_FART];
    if (scores[OD_FART] > ss_peakFartConf) ss_peakFartConf = scores[OD_FART];
  }

  // ── Priority sulfur event for the portal ───────────────────
  {
    const uint8_t sulfur = scores[OD_SULFUR];
    const bool high = sulfur >= 70;
    if (calReady && high && (ss_prevSulfurConf < 70 || sulfur >= ss_prevSulfurConf + 12)) {
      LockGuard g;
      gSniff.iaq = (int)iaq;
      gSniff.conf = sulfur;
      strlcpy(gSniff.label, scores[i1] >= ODOR_MIN_CONF ? odorNames[i1] : "High Sulfur", sizeof(gSniff.label));
      gSniff.airScore = airScore;
      gSniff.voc = voc;
      gSniff.dVoc = vocDelta;
      gSniff.primaryIdx = scores[i1] >= ODOR_MIN_CONF ? i1 : ODOR_COUNT;
      gSniff.primaryConf = scores[i1];
      gSniff.fartCount = fartCount;
      gSniffPending = true;
      gSniffGen++;
    }
    ss_prevSulfurConf = sulfur;
  }

  if (calReady && abs(airScore - ss_prevAirScore) > 12) requestPortalPush();
  ss_prevAirScore = airScore;

  histPush(now);
  const bool advisoryCooling = advisoryEverShown && now - lastAdvisoryMs < ADVISORY_COOLDOWN_MS;
  checkAirAlerts(iaq, voc, co2, hum, scores, iaqAcc, outdoorAqi, ventShutEdge,
                 strcmp(vent.vent, "shut") == 0);
  if (calReady && !hazardActive && !advisoryCooling) strlcpy(ss_prevVent, vent.vent, sizeof(ss_prevVent));

  // ── Telemetry snapshot for the network task ────────────────
  {
    const float cfi = computeCfiScore(co2, iaq);
    LockGuard g;
    Telemetry &t = gTelem;
    t.valid = true;
    t.voc = voc; t.iaq = iaq; t.staticIaq = latestStaticIAQ; t.co2 = co2;
    t.tempF = tempF; t.hum = hum; t.pressHpa = hpa; t.gasR = gasR;
    t.compGas = latestCompGas; t.gasPct = latestGasPct; t.dVoc = vocDelta;
    t.iaqAcc = iaqAcc; t.calReady = calReady;
    strlcpy(t.calText, calibrationStatusText(iaqAcc, latestStabStatus, latestRunInStatus), sizeof(t.calText));
    t.airScore = airScore; t.roomScore = roomScore; t.tier = tier;
    t.dewF = dewF;
    strlcpy(t.vent, vent.vent, sizeof(t.vent));
    strlcpy(t.pressTrend, ss_pressTrend, sizeof(t.pressTrend));
    t.pressDisagree = disagree;
    memcpy(t.odors, scores, sizeof(t.odors));
    t.primaryIdx = scores[i1] >= ODOR_MIN_CONF ? i1 : ODOR_COUNT;
    t.primaryConf = scores[i1];
    t.cfiScore = cfi; t.cfiPercent = (uint8_t)lroundf(cfi * 100.0f);
    t.vtrLevel = computeVtrLevel(hum, co2, iaq);
    t.fartCount = fartCount;
    t.fullBundle = bsecFullBundle;
    t.bsecRestored = calState.bsecStateLoaded;
    t.gasValid = latestGasValid;
    t.runIn = latestRunInStatus >= 1.0f;
    t.stab = latestStabStatus >= 1.0f;
    t.rawTempC = bsecRawExtras ? latestRawTempC : NAN;
    t.rawHum = bsecRawExtras ? latestRawHum : NAN;
    t.iaqTrend = getIaqTrend(); t.vocTrend = getVocTrend();
    strlcpy(t.hazard, hazardLabel(airScore, hazardActive), sizeof(t.hazard));
  }

  // ── BSEC state persistence ────────────────────────────────
  if (calReady) {
    if (iaqAcc == 3 && !bsecAcc3Saved) { saveBsecState(); bsecAcc3Saved = true; }
    else if (homeBase.ready && calState.homeBaseDirty) saveBsecState();
    else if (now - lastBsecSaveMs >= BSEC_SAVE_MS) saveBsecState();
  }

  // ── Midnight reset of the fart counter ─────────────────────
  struct tm tNow;
  if (localTimeNow(&tNow) && tNow.tm_mday != fartResetDay) {
    if (fartResetDay != -1) { fartCount = 0; biggestFartVoc = 0; lastFartMs = 0; }
    fartResetDay = tNow.tm_mday;
  }

  Serial.printf("[SNS] acc=%u IAQ=%.0f VOC=%.2f CO2=%.0f T=%.1fF RH=%.0f gasR=%.0fk score=%d top=%s:%u heap=%u\n",
                iaqAcc, iaq, voc, co2, tempF, hum, gasR / 1000.0f, airScore,
                scores[i1] >= ODOR_MIN_CONF ? odorNames[i1] : "clean", scores[i1],
                (unsigned)ESP.getFreeHeap());

  forceRedraw = true;   // refresh the current page with new data
}

// ══════════════════════════════════════════════════════════════
// Button (loop task)
// ══════════════════════════════════════════════════════════════

struct BtnTrack {
  uint8_t gpio;
  bool    armed;       // has been seen released since boot
  bool    stable;      // debounced "down"
  bool    lastRaw;
  unsigned long changeMs;
  unsigned long downMs;
  bool    longFired;
};
static BtnTrack btnTrack[] = {
  { D1, false, false, false, 0, 0, false },
  { D0, false, false, false, 0, 0, false },
  { 9,  false, false, false, 0, 0, false },
};
// Set from a falling-edge interrupt. display() blocks for ~160 ms while the
// OLED frame is sent, which is long enough to miss a whole tap if we only
// poll in loop().
static volatile bool btnFell[3] = {};
static void IRAM_ATTR btnIsr0() { btnFell[0] = true; }
static void IRAM_ATTR btnIsr1() { btnFell[1] = true; }
static void IRAM_ATTR btnIsr2() { btnFell[2] = true; }
static void (*const btnIsr[3])() = { btnIsr0, btnIsr1, btnIsr2 };

static void onShortPress() {
  if (alarmStepsLeft) alarmStop();
  if (hazardActive && !hazardMuted) {
    hazardMuted = true;
    Serial.println(F("[ALERT] Hazard alarm muted"));
    if (overlayActive) dismissOverlay();
    return;
  }
  if (overlayActive) {
    if (overlayIsHazard) { hazardMuted = true; Serial.println(F("[ALERT] Hazard alarm muted")); }
    dismissOverlay();
    return;
  }
  displayPage = (displayPage + 1) % NUM_PAGES;
  lastPageAdvanceMs = millis();
  lastDeckTapMs = lastPageAdvanceMs;
  forceRedraw = true;
}

static void onLongPress() {
  if (alarmStepsLeft || hazardActive) {
    alarmStop();
    hazardMuted = true;
    dismissOverlay();
    return;
  }
  Serial.println(F("[BTN] Hold → portal sync"));
  requestPortalPush();
  showOverlay("Portal Sync", "Fresh snapshot\nqueued for upload.", 1500, false);
}

static void armButtonPins() {
  for (uint8_t i = 0; i < 3; i++) {
    BtnTrack& b = btnTrack[i];
    pinMode(b.gpio, INPUT_PULLUP);
    gpio_pullup_en((gpio_num_t)b.gpio);
    gpio_pulldown_dis((gpio_num_t)b.gpio);
    attachInterrupt(digitalPinToInterrupt(b.gpio), btnIsr[i], FALLING);
  }
}

static void handleButton(unsigned long now) {
  static unsigned long lastPullMs = 0;
  // Wi-Fi bring-up can clear the pull-ups on these pins. Put them back
  // without detaching the edge interrupt (gpio pull only, no pinMode).
  if (lastPullMs && now - lastPullMs >= 2000UL) {
    for (BtnTrack& b : btnTrack) gpio_pullup_en((gpio_num_t)b.gpio);
    lastPullMs = now;
  } else if (!lastPullMs) {
    lastPullMs = now;
  }

  for (uint8_t i = 0; i < 3; i++) {
    BtnTrack& b = btnTrack[i];
    const bool fell = btnFell[i];
    if (fell) btnFell[i] = false;
    const bool low = digitalRead(b.gpio) == LOW || fell;
    if (!b.armed) {
      if (digitalRead(b.gpio) == HIGH) b.armed = true;
      continue;
    }
    if (low != b.lastRaw) { b.lastRaw = low; b.changeMs = now; }
    if (!fell && now - b.changeMs < BTN_DEBOUNCE_MS) continue;

    if (low && !b.stable) {
      b.stable = true;
      b.downMs = now;
      b.longFired = false;
      // Tap completed entirely during an OLED transfer: the pin is already up.
      if (fell && digitalRead(b.gpio) == HIGH) {
        b.stable = false;
        b.lastRaw = false;
        Serial.printf("[BTN] tap gpio=%u\n", b.gpio);
        onShortPress();
      }
    } else if (low && b.stable) {
      if (!b.longFired && now - b.downMs >= BTN_LONG_MS) {
        b.longFired = true;
        Serial.printf("[BTN] hold gpio=%u\n", b.gpio);
        onLongPress();
      }
    } else if (!low && b.stable) {
      b.stable = false;
      if (!b.longFired) {
        Serial.printf("[BTN] tap gpio=%u\n", b.gpio);
        onShortPress();
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════
// Network task — everything here may block; the UI never waits on it
// ══════════════════════════════════════════════════════════════

namespace net {

static const unsigned long WIFI_RETRY_MS          = 30000UL;
static const unsigned long WIFI_CONNECT_TIMEOUT_MS = 12000UL;
static const unsigned long WIFI_ROTATE_AFTER_MS   = 120000UL;
static const unsigned long WEB_POST_INTERVAL_MS   = 60000UL;
static const unsigned long WEB_RETRY_MS           = 30000UL;
static const unsigned long WEB_EVENT_COOLDOWN_MS  = 15000UL;
static const unsigned long SNIFF_RETRY_MS         = 10000UL;
static const unsigned long SNIFF_COOLDOWN_MS      = 45000UL;
static const unsigned long WEATHER_REFRESH_MS     = 10UL * 60UL * 1000UL;
static const unsigned long OPTIONAL_RETRY_MS      = 60000UL;
static const unsigned long RELAY_STALE_MS         = 5UL * 60UL * 1000UL;
static const unsigned long RELAY_RECOVER_BACKOFF  = 5UL * 60UL * 1000UL;

// Wi-Fi state machine
static bool          wasConnected = false;
static bool          timeConfigured = false;
static bool          attemptActive = false;
static unsigned long attemptStartMs = 0;
static unsigned long lastRetryMs = 0;
static unsigned long offlineSinceMs = 0;
static int           preferredIdx = 0;
static int           rotateIdx = 0;

// Portal state (task-local)
static unsigned long lastPostOkMs = 0;
static unsigned long lastPostAttemptMs = 0;
static unsigned long lastCommandSeq = 0;
static unsigned long lastSniffOkMs = 0;
static unsigned long lastSniffAttemptMs = 0;
static unsigned long lastRecoveryMs = 0;
static bool          pushPending = true;

// Location / outdoor data (task-local)
static bool          locationOk = false;
static float         lat = 0, lon = 0;
static int32_t       utcOffsetSec = 0;
static unsigned long lastLocationTryMs = 0;
static unsigned long envOkMs = 0, envTryMs = 0;
static unsigned long homeOkMs = 0, homeTryMs = 0;
static unsigned long wallOkMs = 0, wallTryMs = 0;
static unsigned long snarkOkMs = 0, snarkTryMs = 0;
static int           snarkScore = -1000;    // device air score at last snark
static const unsigned long HOME_STATS_MS   = 2UL * 60UL * 1000UL;
static const unsigned long WALL_STATS_MS   = 60UL * 1000UL;   // server edge-caches 30 s
static const unsigned long SNARK_REFRESH_MS = 20UL * 60UL * 1000UL;
static const unsigned long SNARK_RETRY_MS   = 5UL * 60UL * 1000UL;

static String dashboardUrl(const char* path) {
  String u = WEB_DASHBOARD_URL;
  if (u.indexOf("://") < 0) u = "https://" + u;
  while (u.endsWith("/")) u.remove(u.length() - 1);
  return u + path;
}

// One HTTP(S) exchange with bounded timeouts. Returns status code (<=0 on error).
static int request(const String& url, const char* body, String* response,
                   bool keyHeader = false, uint16_t timeoutMs = 8000) {
  const bool https = url.startsWith("https://");
  WiFiClientSecure tls;
  WiFiClient plain;
  if (https) {
    tls.setInsecure();
    tls.setHandshakeTimeout(10);           // seconds
    tls.setTimeout(timeoutMs / 1000 + 1);  // seconds
  }
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(timeoutMs);
  http.setTimeout(timeoutMs);
  bool ok = https ? http.begin(tls, url) : http.begin(plain, url);
  if (!ok) {
    Serial.printf("[NET] begin failed: %s\n", url.c_str());
    return -1;
  }
  if (keyHeader) http.addHeader("X-SniffMaster-Key", WEB_DASHBOARD_KEY);
  int code;
  if (body) {
    http.addHeader("Content-Type", "application/json");
    code = http.POST((uint8_t*)body, strlen(body));
  } else {
    code = http.GET();
  }
  if (response) {
    // 204/304 carry no body; reading one makes mbedTLS log -76 on the closed socket
    *response = (code > 0 && code != 204 && code != 304) ? http.getString() : String();
  }
  http.end();
  return code;
}

static int wifiIndexForSsid(const String& ssid) {
  for (int i = 0; i < WIFI_NUM_NETWORKS; i++) if (ssid == WIFI_CREDS[i][0]) return i;
  return -1;
}

static void startAttempt(int idx) {
  if (idx < 0 || idx >= WIFI_NUM_NETWORKS) return;
  Serial.printf("[WiFi] Connecting to %s\n", WIFI_CREDS[idx][0]);
  WiFi.disconnect();
  WiFi.begin(WIFI_CREDS[idx][0], WIFI_CREDS[idx][1]);
  attemptActive = true;
  attemptStartMs = millis();
}

static void publishStatus(bool connected) {
  char ssid[33] = "", ip[16] = "";
  int rssi = 0, ch = 0;
  if (connected) {
    strlcpy(ssid, WiFi.SSID().c_str(), sizeof(ssid));
    strlcpy(ip, WiFi.localIP().toString().c_str(), sizeof(ip));
    rssi = WiFi.RSSI();
    ch = WiFi.channel();
  }
  LockGuard g;
  gNet.connected = connected;
  memcpy(gNet.ssid, ssid, sizeof(ssid));
  memcpy(gNet.ip, ip, sizeof(ip));
  gNet.rssi = rssi;
  gNet.channel = ch;
  gNet.lastPostMs = lastPostOkMs;
}

static bool maintainWiFi() {
  const unsigned long now = millis();
  const bool connected = WiFi.status() == WL_CONNECTED;

  if (connected) {
    if (!wasConnected) {
      wasConnected = true;
      attemptActive = false;
      offlineSinceMs = 0;
      WiFi.setSleep(false);
      int idx = wifiIndexForSsid(WiFi.SSID());
      if (idx >= 0) preferredIdx = rotateIdx = idx;
      Serial.printf("[WiFi] Connected: %s IP=%s RSSI=%d\n",
                    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
      if (!timeConfigured) {
        configTime(utcOffsetSec, 0, "pool.ntp.org", "time.nist.gov");
        timeConfigured = true;
      }
      pushPending = true;
    }
    return true;
  }

  if (wasConnected) {
    wasConnected = false;
    offlineSinceMs = now;
    Serial.println(F("[WiFi] Link lost"));
  }
  if (!offlineSinceMs) offlineSinceMs = now;
  if (WIFI_NUM_NETWORKS <= 0) return false;

  if (attemptActive) {
    if (now - attemptStartMs < WIFI_CONNECT_TIMEOUT_MS) return false;
    attemptActive = false;
    Serial.printf("[WiFi] Attempt timed out (status=%d)\n", (int)WiFi.status());
  }
  if (lastRetryMs && now - lastRetryMs < WIFI_RETRY_MS) return false;
  lastRetryMs = now;

  int idx = preferredIdx;
  if (now - offlineSinceMs >= WIFI_ROTATE_AFTER_MS || !lastPostOkMs) {
    idx = rotateIdx;
    rotateIdx = (rotateIdx + 1) % WIFI_NUM_NETWORKS;
  }
  startAttempt(idx);
  return false;
}

static bool fetchLocation() {
  String body;
  int code = request("http://ip-api.com/json/?fields=lat,lon,city,offset", nullptr, &body, false, 6000);
  if (code != 200) return false;
  JsonDocument doc;
  if (deserializeJson(doc, body)) return false;
  lat = doc["lat"] | 0.0f;
  lon = doc["lon"] | 0.0f;
  utcOffsetSec = doc["offset"] | 0;
  {
    LockGuard g;
    strlcpy(gNet.city, doc["city"] | "", sizeof(gNet.city));
  }
  configTime(utcOffsetSec, 0, "pool.ntp.org", "time.nist.gov");
  timeConfigured = true;
  locationOk = true;
  Serial.printf("[NET] Location %.4f,%.4f UTC%+d\n", lat, lon, (int)(utcOffsetSec / 3600));
  return true;
}

static const char* epaCategory(int aqi) {
  return aqi <= 50 ? "Good" : aqi <= 100 ? "Moderate" : aqi <= 150 ? "Sensitive" :
         aqi <= 200 ? "Unhealthy" : aqi <= 300 ? "Very Bad" : "Hazardous";
}

// Cause/advice from µg/m³ concentrations (Open-Meteo units)
static void buildAqiAdvisory(OutdoorAQI& a) {
  const bool highPM = a.pm25 > 35.0f, veryHighPM = a.pm25 > 55.0f, highCO = a.co > 4000.0f;
  const bool highNO2 = a.no2 > 100.0f, highSO2 = a.so2 > 75.0f, highO3 = a.o3 > 140.0f;
  const bool highPM10 = a.pm10 > 150.0f;
  const char* cause; const char* advice;
  if (veryHighPM && highCO && !highNO2) { cause = "Wildfire/burn nearby"; advice = "Close windows, run air purifier"; }
  else if (highPM && highNO2)           { cause = "Traffic/combustion";   advice = "Keep windows closed"; }
  else if (highSO2)                     { cause = "Industrial emissions"; advice = "Stay indoors"; }
  else if (highO3)                      { cause = "High ozone (heat/UV)"; advice = "Limit afternoon outdoor activity"; }
  else if (highPM || highPM10)          { cause = "Dust/particulate";     advice = "Sensitive groups limit outdoor time"; }
  else if (a.aqi > 100)                 { cause = "Multiple pollutants";  advice = "Keep windows closed"; }
  else if (a.aqi <= 50)                 { cause = "All clear";            advice = "Great day for open windows"; }
  else                                  { cause = "Mild pollution";       advice = "Sensitive groups be cautious"; }
  char pm25[8], pm10[8], co[8], no2[8], o3[8], so2[8];
  auto conc = [](char* out, size_t n, float v) {
    if (isfinite(v)) snprintf(out, n, "%.0f", v);
    else strlcpy(out, "--", n);
  };
  conc(pm25, sizeof(pm25), a.pm25); conc(pm10, sizeof(pm10), a.pm10);
  conc(co, sizeof(co), a.co);       conc(no2, sizeof(no2), a.no2);
  conc(o3, sizeof(o3), a.o3);       conc(so2, sizeof(so2), a.so2);
  snprintf(a.advisory, sizeof(a.advisory),
           "AQI: %d  %s\nPM2.5: %s  PM10: %s\nCO: %s  NO2: %s  O3: %s  SO2: %s\n%s\n%s",
           a.aqi, a.level, pm25, pm10, co, no2, o3, so2, cause, advice);
}

// Async BSSID scan for the server-side geolocation call. At most every 15 min.
// A pass that only starts the scan returns false so the next retry can read it.
static const unsigned long ENV_WIFI_SCAN_MS = 15UL * 60UL * 1000UL;
static unsigned long lastEnvScanMs = 0;
struct EnvAp { char mac[18]; int8_t rssi; uint8_t channel; };
static EnvAp envAps[8];
static uint8_t envApCount = 0;

static void harvestEnvScan(int found) {
  envApCount = 0;
  const int n = found > 8 ? 8 : found;
  for (int i = 0; i < n; i++) {
    const uint8_t* b = WiFi.BSSID(i);
    if (!b) continue;
    snprintf(envAps[envApCount].mac, sizeof(envAps[envApCount].mac),
             "%02x:%02x:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3], b[4], b[5]);
    envAps[envApCount].rssi = (int8_t)WiFi.RSSI(i);
    envAps[envApCount].channel = (uint8_t)WiFi.channel(i);
    envApCount++;
  }
  WiFi.scanDelete();
}

static bool envScanReady() {
  const int st = WiFi.scanComplete();
  if (st == WIFI_SCAN_RUNNING) return false;
  if (st >= 0) {
    harvestEnvScan(st);
    lastEnvScanMs = millis();
    return true;
  }
  if (st == WIFI_SCAN_FAILED) WiFi.scanDelete();
  const unsigned long now = millis();
  if (!lastEnvScanMs || now - lastEnvScanMs >= ENV_WIFI_SCAN_MS) {
    WiFi.scanNetworks(true);
    lastEnvScanMs = now;
    return false;
  }
  return true;
}

// One server call replaces the old weather and outdoor-AQI fetches.
// Google is called only by the server. This function never sees the API key.
static bool fetchGoogleEnv() {
  if (!envScanReady()) return false;

  JsonDocument req;
  if (locationOk) {
    req["lat"] = roundf(lat * 10000.0f) / 10000.0f;
    req["lon"] = roundf(lon * 10000.0f) / 10000.0f;
  }
  if (envApCount >= 2) {
    JsonArray wifi = req["wifi"].to<JsonArray>();
    for (uint8_t i = 0; i < envApCount; i++) {
      JsonObject ap = wifi.add<JsonObject>();
      ap["mac"] = envAps[i].mac;
      ap["rssi"] = envAps[i].rssi;
      ap["channel"] = envAps[i].channel;
    }
  }
  String payload;
  serializeJson(req, payload);
  String body;
  const int code = request(dashboardUrl("/api/environment"), payload.c_str(), &body, true, 12000);
  if (code != 200) {
    Serial.printf("[NET] environment HTTP %d\n", code);
    return false;
  }
  if (body.length() > 1100) {
    Serial.printf("[NET] environment body %u bytes rejected\n", (unsigned)body.length());
    return false;
  }
  JsonDocument doc;
  if (deserializeJson(doc, body)) return false;
  if (!(doc["ok"] | false)) return false;
  JsonObject wx = doc["wx"];
  JsonObject aq = doc["aq"];
  if (wx.isNull() || aq.isNull() || aq["usAqi"].isNull()) return false;

  WeatherData w = {};
  w.tempF = wx["tempF"] | 0;
  w.feelsLikeF = wx["feelsF"] | w.tempF;
  w.humidity = wx["rh"] | 0;
  strlcpy(w.condition, wx["cond"] | "", sizeof(w.condition));
  strlcpy(w.windDir, wx["windDir"] | "", sizeof(w.windDir));
  snprintf(w.windSpeed, sizeof(w.windSpeed), "%d mph", (int)(wx["windMph"] | 0));
  w.valid = true;

  OutdoorAQI a = {};
  a.outdoorDewF = NAN;
  a.uv = -1;
  a.precipPct = -1;
  a.aqi = aq["usAqi"] | 0;
  a.pm25 = a.pm10 = a.co = a.no2 = a.o3 = a.so2 = NAN;
  if (!aq["pm25"].isNull()) a.pm25 = aq["pm25"] | 0.0f;
  if (!aq["pm10"].isNull()) a.pm10 = aq["pm10"] | 0.0f;
  if (!aq["co"].isNull()) a.co = aq["co"] | 0.0f;
  if (!aq["no2"].isNull()) a.no2 = aq["no2"] | 0.0f;
  if (!aq["o3"].isNull()) a.o3 = aq["o3"] | 0.0f;
  if (!aq["so2"].isNull()) a.so2 = aq["so2"] | 0.0f;
  strlcpy(a.level, aq["cat"] | epaCategory(a.aqi), sizeof(a.level));
  if (!aq["uaqi"].isNull()) { a.uaqiValid = true; a.uaqi = aq["uaqi"] | 0; }
  buildAqiAdvisory(a);
  a.valid = true;
  a.fetchedMs = millis();
  a.ttlMs = (unsigned long)(doc["ttlSec"] | 1800) * 1000UL;
  strlcpy(a.source, doc["source"] | "", sizeof(a.source));
  if (!wx["dewF"].isNull()) a.outdoorDewF = wx["dewF"] | 0.0f;
  if (!wx["pressHpa"].isNull()) { a.googlePress = wx["pressHpa"] | 0.0f; a.googlePressValid = true; }
  a.heatF = wx["heatF"] | 0;
  if (!wx["uv"].isNull()) a.uv = wx["uv"] | 0;
  if (!wx["precipPct"].isNull()) a.precipPct = wx["precipPct"] | 0;
  JsonObject pol = doc["pollen"];
  if (!pol.isNull()) {
    a.pollenValid = true;
    a.pollenTree = pol["tree"] | 0;
    a.pollenGrass = pol["grass"] | 0;
    a.pollenWeed = pol["weed"] | 0;
    strlcpy(a.pollenTop, pol["top"] | "", sizeof(a.pollenTop));
  }

  const char* locSource = doc["loc"]["source"] | "";
  const bool wifiFix = strcmp(locSource, "wifi") == 0;
  if (wifiFix) {
    lat = doc["loc"]["lat"] | lat;
    lon = doc["loc"]["lon"] | lon;
    locationOk = true;
  }
  Serial.printf("[NET] Env %s AQI=%d PM2.5=%.1f pollen=%s\n",
                a.source, a.aqi, a.pm25, a.pollenValid ? "yes" : "no");
  LockGuard g;
  gNet.weather = w;
  gNet.aqi = a;
  if (wifiFix) {
    const char* label = doc["loc"]["label"] | "";
    if (label[0]) strlcpy(gNet.city, label, sizeof(gNet.city));
  }
  return true;
}

// ── Dashboard → device: server-computed Home metrics ─────────
static bool fetchHomeStats() {
  String body;
  int code = request(dashboardUrl("/api/home-stats"), nullptr, &body, false, 10000);
  if (code != 200) { Serial.printf("[WEB] home-stats failed: %d\n", code); return false; }

  // Filter keeps only what the OLED shows (the full response is ~7 KB)
  JsonDocument filter;
  filter["score"]["value"] = true;
  filter["score"]["grade"] = true;
  filter["score"]["components"][0]["key"] = true;
  filter["score"]["components"][0]["score"] = true;
  filter["climate"]["dewPointC"] = true;
  filter["biological"]["mold"]["pct"] = true;
  filter["biological"]["mold"]["category"] = true;
  filter["biological"]["dustMite"]["pct"] = true;
  filter["biological"]["dustMite"]["category"] = true;
  filter["biological"]["dryAir"]["pct"] = true;
  filter["biological"]["dryAir"]["category"] = true;
  filter["petAllergen"]["index"] = true;
  filter["petAllergen"]["level"] = true;
  filter["visitor"]["headline"] = true;
  JsonDocument doc;
  if (deserializeJson(doc, body, DeserializationOption::Filter(filter))) return false;
  if (doc["score"]["value"].isNull()) return false;

  HomeStats h = {};
  h.valid = true;
  h.fetchedMs = millis();
  h.score = doc["score"]["value"] | 0;
  strlcpy(h.grade, doc["score"]["grade"] | "", sizeof(h.grade));
  static const char* const KEYS[4] = { "voc", "ventilation", "biological", "comfort" };
  for (int i = 0; i < 4; i++) {
    h.comp[i] = -1;
    for (JsonObject c : doc["score"]["components"].as<JsonArray>())
      if (strcmp(c["key"] | "", KEYS[i]) == 0 && !c["score"].isNull()) h.comp[i] = c["score"].as<int>();
  }
  JsonVariant dp = doc["climate"]["dewPointC"];
  h.dewPointF = dp.isNull() ? NAN : dp.as<float>() * 9.0f / 5.0f + 32.0f;
  JsonObject bio = doc["biological"];
  h.moldPct = bio["mold"]["pct"] | 0;      strlcpy(h.moldCat, bio["mold"]["category"] | "--", sizeof(h.moldCat));
  h.mitePct = bio["dustMite"]["pct"] | 0;  strlcpy(h.miteCat, bio["dustMite"]["category"] | "--", sizeof(h.miteCat));
  h.dryPct  = bio["dryAir"]["pct"] | 0;    strlcpy(h.dryCat, bio["dryAir"]["category"] | "--", sizeof(h.dryCat));
  h.petIdx  = doc["petAllergen"]["index"] | 0;
  strlcpy(h.petLevel, doc["petAllergen"]["level"] | "--", sizeof(h.petLevel));
  strlcpy(h.headline, doc["visitor"]["headline"] | "", sizeof(h.headline));

  Serial.printf("[WEB] home-stats: score=%d %s\n", h.score, h.grade);
  LockGuard g;
  gNet.home = h;
  return true;
}


// ── Dashboard → device: pre-formatted wall display feed ──────
static bool fetchWallStatus() {
  String body;
  int code = request(dashboardUrl("/api/oled"), nullptr, &body, false, 10000);
  if (code != 200) { Serial.printf("[WEB] oled feed failed: %d\n", code); return false; }
  JsonDocument doc;
  if (deserializeJson(doc, body)) return false;
  if (doc["v"].isNull()) return false;

  WallStatus w = {};
  w.valid = true;
  w.fetchedMs = millis();
  w.sc = doc["sc"] | -1;
  w.sl = doc["sl"] | 0;
  w.aq = doc["aq"] | -1;
  w.ot = doc["ot"] | -999;
  w.uv = doc["uv"].isNull() ? NAN : doc["uv"].as<float>();
  strlcpy(w.sm, doc["sm"] | "LEARNING", sizeof(w.sm));
  strlcpy(w.tr, doc["tr"] | "", sizeof(w.tr));
  strlcpy(w.ca, doc["ca"] | "", sizeof(w.ca));
  strlcpy(w.cc, doc["cc"] | "", sizeof(w.cc));
  strlcpy(w.al, doc["al"] | "N/A", sizeof(w.al));
  strlcpy(w.an, doc["an"] | "", sizeof(w.an));
  strlcpy(w.pl, doc["pl"] | "N/A", sizeof(w.pl));
  strlcpy(w.pn, doc["pn"] | "", sizeof(w.pn));
  strlcpy(w.wn, doc["wn"] | "", sizeof(w.wn));
  for (int i = 0; i < 2; i++) strlcpy(w.ac[i], doc["ac"][i] | "", sizeof(w.ac[i]));
  Serial.printf("[WEB] oled: smell=%s cause=%s allergen=%s pollen=%s\n", w.sm, w.ca, w.al, w.pl);
  LockGuard g;
  gNet.wall = w;
  return true;
}

// Keep only characters the OLED font can draw; map common UTF-8 punctuation.
static void asciiFold(const char* in, char* out, size_t outLen) {
  size_t o = 0;
  for (const uint8_t* p = (const uint8_t*)in; *p && o + 1 < outLen; ) {
    if (*p < 0x80) {
      char c = (char)*p++;
      if (c == '\n' || c == '\r' || c == '\t') c = ' ';
      if (c == '"' ) continue;
      if (c >= 32) out[o++] = c;
      continue;
    }
    // 3-byte sequences: E2 80 98/99 (‘’) 9C/9D (“”) 93/94 (–—) A6 (…)
    if (p[0] == 0xE2 && p[1] == 0x80 && p[2]) {
      const uint8_t k = p[2];
      if (k == 0x98 || k == 0x99) out[o++] = '\'';
      else if (k == 0x93 || k == 0x94) out[o++] = '-';
      else if (k == 0xA6 && o + 3 < outLen) { out[o++] = '.'; out[o++] = '.'; out[o++] = '.'; }
      p += 3;
      continue;
    }
    // Skip any other multi-byte character (emoji etc.)
    p++;
    while ((*p & 0xC0) == 0x80) p++;
  }
  out[o] = '\0';
}

// ── OpenAI snark: one short roast of the house that fits the OLED ──
static bool fetchSnark(const Telemetry& t) {
  if (!OPENAI_API_KEY[0] || strncmp(OPENAI_API_KEY, "YOUR", 4) == 0) return false;
  NetStatus ns;
  { LockGuard g; ns = gNet; }

  char facts[400];
  struct tm tm;
  char clock[12] = "unknown";
  if (localTimeNow(&tm)) strftime(clock, sizeof(clock), "%I:%M %p", &tm);
  int n = snprintf(facts, sizeof(facts),
                   "Time %s. Device air score %d/100 (higher is worse). IAQ %.0f%s. VOC %.2f ppm. "
                   "CO2 est %.0f ppm. %.0fF, %.0f%%RH. Top smell: %s %u%%. Farts today: %d.",
                   clock, t.airScore, t.iaq, t.calReady ? "" : " (sensor still calibrating)",
                   t.voc, t.co2, t.tempF, t.hum,
                   t.primaryIdx < ODOR_COUNT ? odorNames[t.primaryIdx] : "nothing", t.primaryConf,
                   t.fartCount);
  if (ns.home.valid && n > 0 && n < (int)sizeof(facts))
    n += snprintf(facts + n, sizeof(facts) - n, " Home score %d %s. Mold %s, dust mites %s.",
                  ns.home.score, ns.home.grade, ns.home.moldCat, ns.home.miteCat);
  if (ns.aqi.valid && n > 0 && n < (int)sizeof(facts))
    snprintf(facts + n, sizeof(facts) - n, " Outdoor AQI %d %s.", ns.aqi.aqi, ns.aqi.level);

  JsonDocument req;
  req["model"] = OPENAI_MODEL;
  req["max_completion_tokens"] = 600;   // headroom for reasoning models
  JsonArray msgs = req["messages"].to<JsonArray>();
  JsonObject sys = msgs.add<JsonObject>();
  sys["role"] = "system";
  sys["content"] =
      "You are SniffMaster, a snarky home air-quality sensor with a tiny screen. "
      "Write ONE sarcastic but accurate summary of this house's air, max 100 characters, "
      "plain ASCII, no emoji, no hashtags, no quotes. Use only the data given. "
      "If something is actually unhealthy, say so plainly first.";
  JsonObject usr = msgs.add<JsonObject>();
  usr["role"] = "user";
  usr["content"] = facts;
  String payload;
  serializeJson(req, payload);

  // Inline request: needs an Authorization header the generic helper doesn't add
  WiFiClientSecure tls;
  tls.setInsecure();
  tls.setHandshakeTimeout(10);
  tls.setTimeout(25);
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(10000);
  http.setTimeout(25000);
  if (!http.begin(tls, "https://api.openai.com/v1/chat/completions")) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + OPENAI_API_KEY);
  int code = http.POST(payload);
  String body = (code > 0) ? http.getString() : String();
  http.end();

  JsonDocument filter;
  filter["choices"][0]["message"]["content"] = true;
  filter["error"]["message"] = true;
  JsonDocument doc;
  if (deserializeJson(doc, body, DeserializationOption::Filter(filter))) {
    Serial.printf("[GPT] HTTP %d, unparseable reply\n", code);
    return false;
  }
  if (code != 200) {
    Serial.printf("[GPT] HTTP %d: %.120s\n", code, (const char*)(doc["error"]["message"] | ""));
    return false;
  }
  const char* text = doc["choices"][0]["message"]["content"] | "";
  char clean[140];
  asciiFold(text, clean, sizeof(clean));
  if (!clean[0]) { Serial.println(F("[GPT] Empty reply")); return false; }
  Serial.printf("[GPT] %s\n", clean);
  LockGuard g;
  strlcpy(gNet.snark, clean, sizeof(gNet.snark));
  return true;
}

static bool sendSniffEvent(const SniffEvent& e) {
  JsonDocument doc;
  doc["key"] = WEB_DASHBOARD_KEY;
  doc["iaq"] = e.iaq;
  doc["vsc_conf"] = roundf(e.conf * 10.0f) / 10.0f;
  doc["label"] = e.label;
  doc["airScore"] = e.airScore;
  doc["voc"] = roundf(e.voc * 100.0f) / 100.0f;
  doc["dVoc"] = roundf(e.dVoc * 100.0f) / 100.0f;
  doc["primary"] = e.primaryIdx < ODOR_COUNT ? odorNames[e.primaryIdx] : "Clean Air";
  doc["primaryConf"] = e.primaryConf;
  doc["fartCount"] = e.fartCount;
  String payload;
  serializeJson(doc, payload);
  int code = request(dashboardUrl("/api/sniff"), payload.c_str(), nullptr);
  Serial.printf("[WEB] Sniff event -> %d\n", code);
  return code == 200;
}

// Owner commands ride back on POST /api/update. The old 20s GET /api/command
// poll is gone; a queued action arrives on the next successful snapshot.
static void applyRemoteCommand(JsonVariantConst cmd) {
  if (!cmd.is<JsonObjectConst>()) return;
  unsigned long seq = cmd["seq"] | 0UL;
  const char* action = cmd["action"] | "";
  if (!seq || seq <= lastCommandSeq || !action[0]) return;
  lastCommandSeq = seq;

  if (strcmp(action, "refresh") == 0) {
    Serial.println(F("[WEB] Remote command: refresh"));
    pushPending = true;
    lastPostAttemptMs = 0;
  } else if (strcmp(action, "gas_scan") == 0) {
    if (gScanBusy || gGasScanRequest) {
      Serial.println(F("[GAS] scan busy — command dropped"));
    } else {
      gGasScanRequest = true;
      Serial.println(F("[WEB] Remote command: gas_scan"));
    }
  } else {
    Serial.printf("[WEB] Remote command '%s' not supported in this build\n", action);
  }
}

static void applyUpdateResponse(const String& body) {
  if (!body.length()) return;
  JsonDocument doc;
  if (deserializeJson(doc, body)) return;
  applyRemoteCommand(doc["command"]);
}

static bool sendSnapshot(const Telemetry& t, String* responseOut) {
  NetStatus ns;
  { LockGuard g; ns = gNet; }

  JsonDocument doc;
  doc["key"]        = WEB_DASHBOARD_KEY;
  doc["voc"]        = roundf(t.voc * 100) / 100.0f;
  doc["iaq"]        = (int)t.iaq;
  doc["iaqAcc"]     = t.iaqAcc;
  doc["highAccuracyIaq"] = t.calReady;
  doc["staticIaq"]  = lroundf(t.staticIaq);
  doc["co2"]        = lroundf(t.co2);
  doc["co2eq"]      = lroundf(t.co2);   // same BSEC estimate, honest name
  doc["bsecCfg"]    = bsecCfgId;
  doc["bsecBundle"] = t.fullBundle ? "full" : "safe";
  doc["gasValid"]   = t.gasValid;
  doc["bsecRestored"] = t.bsecRestored;   // calibration resumed from NVS this boot
  doc["runIn"]      = t.runIn ? 1 : 0;
  doc["stab"]       = t.stab ? 1 : 0;
  if (isfinite(t.rawTempC)) doc["tempRawC"] = roundf(t.rawTempC * 10) / 10.0f;
  if (isfinite(t.rawHum))   doc["humRaw"]   = roundf(t.rawHum * 10) / 10.0f;
  doc["tempF"]      = roundf(t.tempF * 10) / 10.0f;
  doc["humidity"]   = roundf(t.hum * 10) / 10.0f;
  doc["pressHpa"]   = roundf(t.pressHpa * 10) / 10.0f;
  doc["gasR"]       = lroundf(t.gasR);
  // LP-safe bundle has no compensated gas / gas %: 0 would be a fake reading
  doc["gasPctValid"] = t.fullBundle;
  if (t.fullBundle) {
    doc["compGas"]  = lroundf(t.compGas);
    doc["gasPct"]   = roundf(t.gasPct * 10) / 10.0f;
  }
  doc["dVoc"]       = roundf(t.dVoc * 100) / 100.0f;
  doc["vscConf"]    = t.odors[OD_SULFUR];
  doc["cfiScore"]   = roundf(t.cfiScore * 1000.0f) / 1000.0f;
  doc["cfiPercent"] = t.cfiPercent;
  doc["cfiBand"]    = cfiBandForScore(t.cfiScore);
  doc["vtrLevel"]   = t.vtrLevel;
  doc["vtrLabel"]   = vtrLabelForLevel(t.vtrLevel);
  doc["vtrAdvice"]  = vtrAdviceForLevel(t.vtrLevel);
  doc["airScore"]   = t.airScore;
  doc["roomScore"]  = t.roomScore;
  if (isfinite(t.dewF)) doc["dewF"] = roundf(t.dewF * 10.0f) / 10.0f;
  if (t.vent[0]) doc["vent"] = t.vent;
  if (t.pressTrend[0]) doc["pressTrend"] = t.pressTrend;
  if (t.pressDisagree) doc["pressDisagree"] = true;
  if (t.gasScanPost && t.gasScanCount) {
    doc["gasScanProfile"] = t.gasScanProfile;
    JsonArray scan = doc["gasScan"].to<JsonArray>();
    for (uint8_t i = 0; i < t.gasScanCount && i < HEATER_STEP_COUNT; i++) scan.add(t.gasScanOhms[i]);
  }
  doc["tier"]       = t.tier;
  doc["fartCount"]  = t.fartCount;
  doc["iaqTrend"]   = t.iaqTrend;
  doc["vocTrend"]   = t.vocTrend;
  doc["calibration"] = t.calText;
  doc["hazard"]     = t.hazard;
  doc["primary"]    = t.primaryIdx < ODOR_COUNT ? odorNames[t.primaryIdx] : "Clean Air";
  doc["primaryConf"] = t.primaryConf;
  JsonArray odors = doc["odors"].to<JsonArray>();
  for (int i = 0; i < ODOR_COUNT; i++) odors.add(t.odors[i]);

  doc["wifiSsid"] = ns.ssid;
  doc["wifiIp"]   = ns.ip;
  doc["wifiRssi"] = ns.rssi;
  doc["uptime"]   = (unsigned long)(millis() / 1000UL);
  doc["commandAfter"] = lastCommandSeq;
  if (locationOk) {
    doc["lat"] = roundf(lat * 10000.0f) / 10000.0f;
    doc["lon"] = roundf(lon * 10000.0f) / 10000.0f;
    doc["utcOffsetSec"] = utcOffsetSec;
  }
  if (ns.city[0]) doc["city"] = ns.city;
  if (ns.weather.valid) {
    doc["weatherCondition"] = ns.weather.condition;
    doc["feelsLikeF"] = ns.weather.feelsLikeF;
    doc["windDir"]    = ns.weather.windDir;
    doc["windSpeed"]  = ns.weather.windSpeed;
  }
#if SM_HOME_SENSORS
  if (t.home.valid) {   // only real readings; NAN fields are skipped
    auto put = [&](const char* k, float v, float scale) {
      if (isfinite(v)) doc[k] = roundf(v * scale) / scale;
    };
    put("pm1", t.home.pm1, 10);   put("pm25", t.home.pm25, 10);
    put("pm4", t.home.pm4, 10);   put("pm10", t.home.pm10, 10);
    put("co2True", t.home.co2True, 1);  put("hcho", t.home.hcho, 1);
    put("vocIndex", t.home.vocIndex, 1); put("noxIndex", t.home.noxIndex, 1);
  }
#endif
  if (ns.aqi.valid) {
    doc["outdoorAqi"]   = ns.aqi.aqi;
    doc["outdoorLevel"] = ns.aqi.level;
    doc["aqiAdvisory"]  = ns.aqi.advisory;
    if (isfinite(ns.aqi.pm25)) doc["outdoorPm25"] = roundf(ns.aqi.pm25 * 10) / 10.0f;
    if (isfinite(ns.aqi.pm10)) doc["outdoorPm10"] = roundf(ns.aqi.pm10 * 10) / 10.0f;
    if (isfinite(ns.aqi.co))   doc["outdoorCo"]   = lroundf(ns.aqi.co);
    if (isfinite(ns.aqi.no2))  doc["outdoorNo2"]  = roundf(ns.aqi.no2 * 10) / 10.0f;
    if (isfinite(ns.aqi.o3))   doc["outdoorO3"]   = roundf(ns.aqi.o3 * 10) / 10.0f;
    if (isfinite(ns.aqi.so2))  doc["outdoorSo2"]  = roundf(ns.aqi.so2 * 10) / 10.0f;
    if (ns.aqi.uaqiValid) doc["outdoorUaqi"] = ns.aqi.uaqi;
    if (ns.aqi.pollenValid) {
      doc["pollenTree"] = ns.aqi.pollenTree;
      doc["pollenGrass"] = ns.aqi.pollenGrass;
      doc["pollenWeed"] = ns.aqi.pollenWeed;
      if (ns.aqi.pollenTop[0]) doc["pollenTop"] = ns.aqi.pollenTop;
    }
    if (ns.aqi.source[0]) doc["envSource"] = ns.aqi.source;
  }

  String payload;
  serializeJson(doc, payload);
  String resp;
  int code = request(dashboardUrl("/api/update"), payload.c_str(), &resp);
  if (code == 200) {
    if (t.gasScanPost) {
      LockGuard g;
      if (gTelem.gasScanGen == t.gasScanGen) gTelem.gasScanPost = false;
    }
    if (responseOut) *responseOut = resp;
    Serial.println(F("[WEB] Dashboard updated"));
    return true;
  }
  Serial.printf("[WEB] POST failed: %d %s\n", code, resp.substring(0, 120).c_str());
  return false;
}

// Force a radio reset if the relay has been unreachable for a long time.
static void relayWatchdog(unsigned long now) {
  const bool stale = lastPostOkMs ? (now - lastPostOkMs >= RELAY_STALE_MS)
                                  : (now >= RELAY_STALE_MS && lastPostAttemptMs != 0);
  if (!stale) return;
  if (lastRecoveryMs && now - lastRecoveryMs < RELAY_RECOVER_BACKOFF) return;
  lastRecoveryMs = now;
  Serial.println(F("[WEB] Relay stale — resetting WiFi"));
  WiFi.disconnect();
  wasConnected = false;
  attemptActive = false;
  lastRetryMs = 0;
}

static void task(void*) {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  for (;;) {
    const unsigned long now = millis();
    const bool connected = maintainWiFi();
    publishStatus(connected);

    if (connected && !gScanBusy) {
      // Pull requests from the main task
      Telemetry t;
      SniffEvent sniff;
      bool sniffPending, pushReq;
      uint32_t sniffGen;
      {
        LockGuard g;
        t = gTelem;
        sniff = gSniff;
        sniffPending = gSniffPending;
        sniffGen = gSniffGen;
        pushReq = gPushRequested;
        gPushRequested = false;
      }
      if (pushReq) pushPending = true;

      // One network operation per pass, most important first
      const bool postDue = t.valid &&
          (!lastPostAttemptMs ||
           now - lastPostAttemptMs >= (pushPending ? WEB_EVENT_COOLDOWN_MS : WEB_RETRY_MS)) &&
          (pushPending || !lastPostOkMs || now - lastPostOkMs >= WEB_POST_INTERVAL_MS);

      if (sniffPending && (!lastSniffOkMs || now - lastSniffOkMs >= SNIFF_COOLDOWN_MS) &&
          (!lastSniffAttemptMs || now - lastSniffAttemptMs >= SNIFF_RETRY_MS)) {
        lastSniffAttemptMs = now;
        if (sendSniffEvent(sniff)) {
          lastSniffOkMs = millis();
          // Only clear if no newer event was queued while this one uploaded
          LockGuard g;
          if (gSniffGen == sniffGen) gSniffPending = false;
        }
      } else if (postDue) {
        lastPostAttemptMs = now;
        String updateResp;
        if (sendSnapshot(t, &updateResp)) {
          lastPostOkMs = millis();
          pushPending = false;
          // A refresh command sets pushPending again after this clear.
          applyUpdateResponse(updateResp);
        }
      } else if (!locationOk && (!lastLocationTryMs || now - lastLocationTryMs >= OPTIONAL_RETRY_MS)) {
        lastLocationTryMs = now;
        fetchLocation();
      } else if ((!envOkMs || now - envOkMs >= WEATHER_REFRESH_MS) &&
                 (!envTryMs || now - envTryMs >= OPTIONAL_RETRY_MS)) {
        envTryMs = now;
        if (fetchGoogleEnv()) envOkMs = millis();
      } else if (lastPostOkMs && (!homeOkMs || now - homeOkMs >= HOME_STATS_MS) &&
                 (!homeTryMs || now - homeTryMs >= OPTIONAL_RETRY_MS)) {
        homeTryMs = now;
        if (fetchHomeStats()) homeOkMs = millis();
      } else if (lastPostOkMs && (!wallOkMs || now - wallOkMs >= WALL_STATS_MS) &&
                 (!wallTryMs || now - wallTryMs >= OPTIONAL_RETRY_MS)) {
        wallTryMs = now;
        if (fetchWallStatus()) wallOkMs = millis();
      } else if (t.valid && (!snarkTryMs || now - snarkTryMs >= SNARK_RETRY_MS) &&
                 (!snarkOkMs || now - snarkOkMs >= SNARK_REFRESH_MS ||
                  abs(t.airScore - snarkScore) >= 15)) {
        // Refresh every 20 min, or sooner when the air changes a lot
        snarkTryMs = now;
        if (fetchSnark(t)) { snarkOkMs = millis(); snarkScore = t.airScore; }
      }

      relayWatchdog(millis());
      publishStatus(WiFi.status() == WL_CONNECTED);
    }

    vTaskDelay(pdMS_TO_TICKS(250));
  }
}

}  // namespace net

// ══════════════════════════════════════════════════════════════
// On-demand heater scan (loop task — it owns I2C)
// ══════════════════════════════════════════════════════════════

static void rebootSensorFail() {
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println(F("BME688 INIT FAIL"));
  display.println(F("Check sensor wiring"));
  display.println();
  display.println(F("Rebooting in 10s..."));
  display.display();
  delay(10000);
  ESP.restart();
}

static bool restoreBsecBlob() {
  if (!bsecPrefs.begin(BSEC_NVS_NS, true)) return false;
  bool ok = false;
  if (bsecPrefs.getBytesLength(BSEC_STATE_KEY) == sizeof(PersistedBsecState)) {
    static PersistedBsecState st;
    bsecPrefs.getBytes(BSEC_STATE_KEY, &st, sizeof(st));
    if (st.magic == BSEC_STATE_MAGIC && st.version == BSEC_STATE_VER &&
        st.blobLen == BSEC_MAX_STATE_BLOB_SIZE && strncmp(st.cfgId, bsecCfgId, sizeof(st.cfgId)) == 0) {
      ok = envSensor.setState(st.blob);
    }
  }
  bsecPrefs.end();
  calState.bsecStateLoaded = ok;
  if (ok) bsecEverSaved = true;
  return ok;
}

static bool restartBsec(const char* why) {
  Serial.printf("[BSEC] Restarting after %s\n", why);
  if (!envSensor.begin(bmeI2cAddr, Wire, safeBmeDelayUs)) return false;
  if (!envSensor.setConfig(bsecIaqLpConfig))
    Serial.printf("[BSEC] Config reload failed: %d\n", (int)envSensor.status);
  if (!restoreBsecBlob()) Serial.println(F("[BSEC] No blob restored after scan"));
  if (!subscribeBsecOutputs("scan")) return false;
  envSensor.attachCallback(onSensorData);
  bsecInitMillis = millis();
  return true;
}

static void emitLabelData(const uint32_t* ohms, uint8_t count) {
  Serial.printf("SMELLNET_DATA,%.2f,%.0f,%.0f,%.1f,%.1f,%.1f,%.0f,%.2f,%s",
                ss_voc, ss_iaq, ss_co2, ss_tempF, ss_hum, pressToHpa(ss_pressure),
                ss_gasR, ss_dvoc, HEATER_PROFILE_ID);
  for (uint8_t i = 0; i < count; i++) Serial.printf(",%lu", (unsigned long)ohms[i]);
  Serial.println();
}

static void showGasScan(uint8_t step, uint8_t total) {
  display.clearDisplay();
  drawHeader("Gas scan");
  char buf[12];
  snprintf(buf, sizeof(buf), "%u/%u", step, total);
  display.setTextSize(2);
  display.setCursor(0, 28);
  display.print(buf);
  display.setTextSize(1);
  display.display();
}

static void runGasScan() {
  if (gScanBusy) {
    Serial.println(F("[GAS] scan already running — dropped"));
    return;
  }
  if (latestIAQAccuracy == 0 && !bsecEverSaved) {
    Serial.println(F("[GAS] refused: accuracy 0 and no saved BSEC state"));
    return;
  }
  if (latestIAQAccuracy > 0) {
    const bool hadBlob = bsecEverSaved;
    saveBsecState();
    if (!bsecEverSaved && !hadBlob) {
      Serial.println(F("[GAS] refused: could not save BSEC state"));
      return;
    }
  }
  gScanBusy = true;
  showGasScan(0, HEATER_STEP_COUNT);

  Bme68x bme;
  bme.begin(bmeI2cAddr, Wire);
  uint16_t temp[HEATER_STEP_COUNT];
  uint16_t dur[HEATER_STEP_COUNT];
  for (uint8_t i = 0; i < HEATER_STEP_COUNT; i++) {
    temp[i] = HEATER_TEMP_C[i];
    dur[i] = HEATER_DUR_MS[i];
  }
  bool programmed = bme.checkStatus() != BME68X_ERROR;
  if (programmed) {
    bme.setTPH();
    bme.setSeqSleep(BME68X_ODR_250_MS);
    bme.setHeaterProf(temp, dur, HEATER_STEP_COUNT);
    bme.setOpMode(BME68X_SEQUENTIAL_MODE);
    programmed = bme.checkStatus() != BME68X_ERROR;
  }

  uint32_t ohms[HEATER_STEP_COUNT] = {};
  uint8_t valid[HEATER_STEP_COUNT] = {};
  uint8_t seen[HEATER_STEP_COUNT] = {};
  uint8_t nSeen = 0;
  const unsigned long deadline = millis() + 15000UL;
  while (programmed && nSeen < HEATER_STEP_COUNT && (long)(deadline - millis()) > 0) {
    lastUiLoopStage = UI_STAGE_GAS_SCAN;
    resetUiTaskWatchdog();
    handleButton(millis());
    alarmTick(millis());
    if (!bme.fetchData()) { delay(20); continue; }
    bme68xData data;
    uint8_t left;
    do {
      left = bme.getData(data);
      if (data.gas_index >= HEATER_STEP_COUNT) continue;
      const uint8_t step = data.gas_index;
      if (!seen[step]) { seen[step] = 1; nSeen++; showGasScan(nSeen, HEATER_STEP_COUNT); }
      const bool ok = (data.status & BME68X_GASM_VALID_MSK) && (data.status & BME68X_HEAT_STAB_MSK);
      if (ok) {
        ohms[step] = (uint32_t)lroundf(data.gas_resistance);
        valid[step] = 1;
      }
    } while (left);
  }
  if (programmed) bme.setOpMode(BME68X_SLEEP_MODE);

  for (uint8_t i = 0; i < HEATER_STEP_COUNT; i++) {
    Serial.printf("GASSCAN,%s,%u,%u,%u,%lu,%u\n",
                  HEATER_PROFILE_ID, i, HEATER_TEMP_C[i], HEATER_DUR_MS[i],
                  (unsigned long)(valid[i] ? ohms[i] : 0), valid[i]);
  }
  {
    LockGuard g;
    strlcpy(gTelem.gasScanProfile, HEATER_PROFILE_ID, sizeof(gTelem.gasScanProfile));
    memcpy(gTelem.gasScanOhms, ohms, sizeof(ohms));
    gTelem.gasScanCount = HEATER_STEP_COUNT;
    gTelem.gasScanGen++;
    gTelem.gasScanPost = true;
  }
  emitLabelData(ohms, HEATER_STEP_COUNT);

  if (!restartBsec("gas scan")) rebootSensorFail();
  gScanBusy = false;
  forceRedraw = true;
}

// ══════════════════════════════════════════════════════════════
// setup() / loop()
// ══════════════════════════════════════════════════════════════

void setup() {
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  armButtonPins();

  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT && ARDUINO_USB_MODE
  Serial.setTxTimeoutMs(0);   // never stall the UI when no USB host is reading
#endif

  I2C_BEGIN();
  Wire.setClock(100000);
  Wire.setTimeOut(200);       // ms — a glitched bus must not hang the loop

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("OLED init failed — continuing without display"));
  }
  display.setTextColor(SSD1306_WHITE);
  display.setTextWrap(false);
  drawSplash();

  gLock = xSemaphoreCreateMutex();

  // UI loop outranks the network task so slow HTTPS can never starve it.
  vTaskPrioritySet(nullptr, 2);
  xTaskCreate(net::task, "net", 16384, nullptr, 1, nullptr);

  if (!envSensor.begin(BME68X_I2C_ADDR_LOW, Wire, safeBmeDelayUs)) {
    Serial.println(F("[BSEC] init failed at 0x76 — trying 0x77"));
    delay(200);
    bmeI2cAddr = BME68X_I2C_ADDR_HIGH;
    if (!envSensor.begin(BME68X_I2C_ADDR_HIGH, Wire, safeBmeDelayUs)) rebootSensorFail();
  }

  Serial.printf("[BSEC] BME688 at 0x%02X\n", bmeI2cAddr);
  if (envSensor.setConfig(bsecIaqLpConfig))
    Serial.printf("[BSEC] Loaded config %s\n", bsecCfgId);
  else
    Serial.printf("[BSEC] Config %s load failed: status=%d\n", bsecCfgId, (int)envSensor.status);

  // Restore saved state BEFORE subscribing so BSEC starts from it
  loadBsecState();
  if (calState.bsecStateLoaded) bsecAcc3Saved = true;
  subscribeBsecOutputs("setup");
  envSensor.attachCallback(onSensorData);
  bsecInitMillis = millis();

  smellnet_init();
  startUiTaskWatchdog();
  Serial.println(F("SniffMaster Pro v5.0 ready"));
}

// Retry the BSEC subscription once if no data ever arrives
// BSEC health counters, reported (and reset) with the [LOOP] line
static uint16_t bsecRunFail = 0, bsecTimingViol = 0;
static int      bsecLastFailStatus = 0;

static void bsecWatchdog(unsigned long now, bool ran) {
  if (!ran) {
    bsecRunFail++;
    bsecLastFailStatus = (int)envSensor.status;
    if ((int)envSensor.status == (int)BSEC_W_SC_CALL_TIMING_VIOLATION) bsecTimingViol++;
    int bs = (int)envSensor.status, ms = (int)envSensor.sensor.status;
    if (bs != lastBsecStatusLog || ms != lastBmeStatusLog) {
      Serial.printf("[BSEC] run() issue: status=%d sensor=%d\n", bs, ms);
      lastBsecStatusLog = bs;
      lastBmeStatusLog = ms;
    }
  }
  if (ss_valid || !bsecInitMillis) return;
  if (now - bsecInitMillis < 15000UL) return;
  if (!lastBsecWaitLogMs || now - lastBsecWaitLogMs >= 15000UL) {
    lastBsecWaitLogMs = now;
    Serial.printf("[BSEC] Waiting for first packet... status=%d sensor=%d\n",
                  (int)envSensor.status, (int)envSensor.sensor.status);
  }
  if (now - bsecInitMillis >= 25000UL) {
    if (calState.bsecStateLoaded) {
      // Safety valve: a restored state that yields no data is discarded and
      // BSEC is restarted cold.
      eraseBsecState("no data after restore");
      envSensor.begin(bmeI2cAddr, Wire, safeBmeDelayUs);
      envSensor.setConfig(bsecIaqLpConfig);
    }
    Serial.println(F("[BSEC] No data yet — retrying subscription"));
    subscribeBsecOutputs("retry");
    envSensor.attachCallback(onSensorData);
    bsecInitMillis = now;
    bsecFirstPacketRetryDone = true;
  }
}

static void updateDisplay(unsigned long now) {
  if (!ss_valid) {
    if (forceRedraw || !lastBootRenderMs || now - lastBootRenderMs >= 1000UL) {
      renderBootStatusPage();
      lastBootRenderMs = now;
      forceRedraw = false;
    }
    return;
  }

  if (overlayActive) {
    if ((long)(now - overlayUntilMs) >= 0) {
      dismissOverlay();
    } else {
      if (overlayDirty) { renderOverlay(); overlayDirty = false; }
      return;
    }
  }

  // Wall deck cycles on its own. Detail cards keep cycling only while
  // someone is tapping; a quiet minute returns to the bridge card.
  const bool wallPage = isWallPage(displayPage);
  if (!wallPage && lastDeckTapMs && now - lastDeckTapMs >= 60000UL) {
    displayPage = C_WALL_BRIDGE;
    lastPageAdvanceMs = now;
    forceRedraw = true;
  } else if (wallPage && now - lastPageAdvanceMs >= 10000UL) {
    displayPage = (displayPage + 1) % 4;   // C_WALL_BRIDGE .. C_WALL_SKY are 0..3
    lastPageAdvanceMs = now;
    forceRedraw = true;
  } else if (!wallPage && now - lastPageAdvanceMs >= PAGE_CYCLE_MS) {
    displayPage++;
    if (displayPage >= NUM_PAGES) displayPage = C_HOME;
    lastPageAdvanceMs = now;
    forceRedraw = true;
  }
  static unsigned long lastWallAnimMs = 0;
  if (wallPage && now - lastWallAnimMs >= 500UL) {
    lastWallAnimMs = now;
    forceRedraw = true;
  }
  if (forceRedraw) {
    renderCurrentPage();
    forceRedraw = false;
  }
}

// ── OLED health check ────────────────────────────────────────
// If the SSD1306 stops ACKing (loose Grove cable, ESD, brown-out) the
// screen looks frozen while the firmware keeps running. Probe it every
// 15 s; on failure free a stuck bus (9 SCL pulses) and re-init the panel.
#define OLED_HEALTH_MS 15000UL
static unsigned long lastOledCheckMs = 0;
static uint16_t      oledRecoveries = 0;

static void i2cBusRecover() {
  Wire.end();
#if defined(CONFIG_IDF_TARGET_ESP32C2) || defined(ARDUINO_XIAO_ESP32C2)
  const int sda = 6, scl = 7;
#else
  const int sda = SDA, scl = SCL;
#endif
  pinMode(sda, INPUT_PULLUP);
  pinMode(scl, OUTPUT_OPEN_DRAIN);
  for (int i = 0; i < 9 && digitalRead(sda) == LOW; i++) {
    digitalWrite(scl, LOW);  delayMicroseconds(5);
    digitalWrite(scl, HIGH); delayMicroseconds(5);
  }
  I2C_BEGIN();
  Wire.setClock(100000);
  Wire.setTimeOut(200);
}

static void oledHealthCheck(unsigned long now) {
  if (now - lastOledCheckMs < OLED_HEALTH_MS) return;
  lastOledCheckMs = now;
  Wire.beginTransmission(OLED_ADDR);
  const uint8_t err = Wire.endTransmission();
  if (err == 0) return;
  Serial.printf("[OLED] No ACK (err=%u) — recovering bus + re-init\n", err);
  i2cBusRecover();
  if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR, /*reset=*/false, /*periphBegin=*/false)) {
    oledRecoveries++;
    display.setTextColor(SSD1306_WHITE);
    display.setTextWrap(false);
    forceRedraw = true;
    overlayDirty = true;
    Serial.printf("[OLED] Re-init OK (%u recoveries)\n", oledRecoveries);
  } else {
    Serial.println(F("[OLED] Re-init failed — will retry"));
  }
}

// ── Loop timing telemetry (evidence for freeze diagnosis) ───
static unsigned long loopMaxMs = 0, lastLoopLogMs = 0;

#if SM_HOME_SENSORS
#define HOME_SENSOR_POLL_MS 5000UL
static unsigned long lastHomePollMs = 0;
static void serviceHomeSensors(unsigned long now) {
  if (now - lastHomePollMs < HOME_SENSOR_POLL_MS) return;
  lastHomePollMs = now;
  HomeAirReading r = emptyHomeAirReading();
  if (!pollHomeSensors(r)) return;
  r.valid = true;
  LockGuard g;
  gTelem.home = r;
}
#endif

void loop() {
  const unsigned long now = millis();
  lastUiLoopStage = UI_STAGE_BUTTON;
  handleButton(now);
  if (gGasScanRequest && !gScanBusy) {
    gGasScanRequest = false;
    lastUiLoopStage = UI_STAGE_GAS_SCAN;
    runGasScan();
  }
  if (gScanBusy) {
    lastUiLoopStage = UI_STAGE_ALARM;
    alarmTick(millis());
    lastUiLoopStage = UI_STAGE_IDLE;
    resetUiTaskWatchdog();
    delay(5);
    return;
  }
#if SM_HOME_SENSORS
  lastUiLoopStage = UI_STAGE_HOME_SENSORS;
  serviceHomeSensors(now);
#endif
  lastUiLoopStage = UI_STAGE_SENSOR;
  const bool ran = envSensor.run();
  bsecWatchdog(now, ran);
  if (newDataReady) {
    lastUiLoopStage = UI_STAGE_PROCESS_SAMPLE;
    processSample(now);
  }
  lastUiLoopStage = UI_STAGE_ALARM;
  alarmTick(millis());
  lastUiLoopStage = UI_STAGE_DISPLAY;
  updateDisplay(millis());
  lastUiLoopStage = UI_STAGE_BUTTON;
  handleButton(millis());   // catch a tap that landed during the OLED transfer
  lastUiLoopStage = UI_STAGE_OLED_HEALTH;
  oledHealthCheck(millis());

  const unsigned long took = millis() - now;
  if (took > loopMaxMs) loopMaxMs = took;
  if (now - lastLoopLogMs >= 10000UL) {
    Serial.printf("[LOOP] max=%lums heap=%u page=%u d0=%d d1=%d boot=%d\n",
                  loopMaxMs, (unsigned)ESP.getFreeHeap(), displayPage,
                  digitalRead(D0), digitalRead(D1), digitalRead(9));
    bsecRunFail = bsecTimingViol = 0;
    loopMaxMs = 0;
    lastLoopLogMs = now;
  }
  lastUiLoopStage = UI_STAGE_IDLE;
  resetUiTaskWatchdog();
  delay(5);   // let the network + idle tasks run
}

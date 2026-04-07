// Increase Arduino loop() task stack from 8KB default to 16KB.
// Needed for HTTPS + large JSON payloads.
// SET_LOOP_TASK_STACK_SIZE(16384);  // Not available in Arduino framework

/***********************************************************
  SniffMaster Pro v4.0 - BSEC2 + WiFi + SmellNet + Web Portal
  Hardware:
    - Seeed XIAO ESP32-C3/S3 on Expansion Board
    - BME688 on Grove I2C (addr 0x76)
    - Built-in SSD1306 128x64 OLED (addr 0x3C)
    - Passive buzzer on D3
    - USER button D1 (see gesture chart below)
    - Optional NeoPixel: define HAVE_RGB
  Button gestures:
    1-2x press   = next page
    3x press     = dad joke
    4x press     = breath checker / breathalyzer
    5x press     = paranormal investigation (GPT)
    6x press     = fart lab (analysis page)
    7x press     = mute/unmute jingles
    long press   = launches + random melody
    double-long  = portal refresh
  Pages (7 auto-cycle):
    0 Air Quality   1 Odor Detail    2 Environment   3 Gas Analysis
    4 Smell Quip    5 Fart Tracker   6 Weather
  Special pages:
    LAUNCHES(7)=long-press   DAD_JOKE(8)=triple-press
***********************************************************/

// ══════════════════════════════════════════════════════════════
// Section 1: Feature Flags
// ══════════════════════════════════════════════════════════════

// ── Optional ML scoring — uncomment after copying smellnet_model_data.h ─────
// #define USE_ML_SCORING

// ── Blynk IoT — not needed for the hosted web portal. Leave disabled unless
// you explicitly want to keep a separate Blynk dashboard around.
// #define USE_BLYNK

// ── Adafruit IO — not needed for the hosted web portal. Leave disabled unless
// you explicitly want a second cloud dashboard/feed mirror.
// #define USE_ADAFRUIT_IO

// ── Web Dashboard — uncomment after deploying sniffmaster_web + editing config
#define USE_WEB_DASHBOARD

// ══════════════════════════════════════════════════════════════
// Section 2: Includes
// ══════════════════════════════════════════════════════════════

// ── Blynk — must be defined before #include <BlynkSimpleEsp32.h> ────────────
// Set to 0 to reduce Blynk serial debug chatter; 1 for normal logs
#ifdef USE_BLYNK
  #define BLYNK_PRINT Serial
  #define BLYNK_DEBUG 0
#endif

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include "bsec2.h"
#include "secrets.h"          // WiFi, Adafruit IO, OpenAI, Blynk credentials
#include "melody_library.h"   // Extended melody pool (31 songs + 29 jingles + 3 alerts)

// ── Blynk IoT — uses existing WiFi connection (no Blynk.begin()) ────────────
#ifdef USE_BLYNK
  #include <BlynkSimpleEsp32.h>
  #include <WidgetTerminal.h>
#endif

#ifdef USE_ML_SCORING
  #include "smellnet_model_data.h"
  #include "smellnet_inference.h"
#endif

// ── Web Dashboard — hosted PWA relay ─────────────────────────────────────────
#ifdef USE_WEB_DASHBOARD
  #include "web_dashboard_config.h"
#endif
#include "sniffmaster_ble_presence.h"

// ── Optional NeoPixel ────────────────────────────────────────────────────────
// #define HAVE_RGB
#ifdef HAVE_RGB
  #include <Adafruit_NeoPixel.h>
#endif

// ══════════════════════════════════════════════════════════════
// Section 3: Hardware Pin Definitions (BTN, BUZZER, OLED, RGB)
// ══════════════════════════════════════════════════════════════

// ── Button ───────────────────────────────────────────────────────────────────
#define BTN_PIN      D1
#define BTN_LONG_MS  600

// ── Buzzer ───────────────────────────────────────────────────────────────────
#define BUZZER_PIN D3

// ── OLED ─────────────────────────────────────────────────────────────────────
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT  64
#define OLED_RESET     -1
#define OLED_ADDR    0x3C

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ── RGB LED ──────────────────────────────────────────────────────────────────
#ifdef HAVE_RGB
  #define RGB_PIN   D7
  #define RGB_COUNT  1
  Adafruit_NeoPixel rgbLed(RGB_COUNT, RGB_PIN, NEO_GRB + NEO_KHZ800);
#endif

// ══════════════════════════════════════════════════════════════
// Section 4: (Note constants provided by melody_library.h)
// melody_library.h supplies note frequencies C3–G6, REST=0,
// ML_WHOLE/HALF/QUARTER/EIGHTH/SIXTEENTH/DOTTED_Q/DOTTED_E(bpm)
// macros, and the MelodyLibrary namespace with SONGS, ICONIC_JINGLES,
// and ALERTS arrays.
// ══════════════════════════════════════════════════════════════

// Bring note names and REST into global scope for readability
using MelodyLibrary::REST;

// ══════════════════════════════════════════════════════════════
// Section 5: Display Constants
// ══════════════════════════════════════════════════════════════

// Pages 0-7 auto-cycle. Special: 8=launches 9=dad joke.
// Page 0: Air Quality   1: Network   2: Odor Detail   3: Environment
// Page 4: Gas Analysis   5: Smell Sentence   6: Fart Tracker   7: Weather
#define NUM_PAGES      8
#define NUM_AUTO_PAGES 8
#define LAUNCHES_PAGE  8
#define DAD_JOKE_PAGE  9

// ══════════════════════════════════════════════════════════════
// Section 6: BSEC2 Configuration
// ══════════════════════════════════════════════════════════════

Bsec2 envSensor;

bsecSensor sensorList[] = {
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

#if defined(CONFIG_IDF_TARGET_ESP32C3) || defined(ARDUINO_XIAO_ESP32C3)
static const uint8_t bsecIaqLpConfig[] = {
  #include <config/bme680/bme680_iaq_33v_3s_4d/bsec_iaq.txt>
};
#endif
// Note: this BSEC2 build does not expose a literal VSC enum. Until a Bosch
// AI-Studio gas-scan config blob is added, sulfur/VSC confidence is mirrored
// from the trained odor classifier rather than a dedicated BSEC VSC channel.

#ifndef ARRAY_LEN
#define ARRAY_LEN(a) (sizeof(a) / sizeof(a[0]))
#endif

// ── Expanded odor classifier ─────────────────────────────────────────────────
// The first 12 classes are the existing SmellNet outputs.
// Extra classes are derived odor families layered on top for broader coverage.
#define ODOR_COUNT          20
#define BASE_ODOR_COUNT     12
#define ODOR_MIN_CONF       20
#define ODOR_HIGHLIGHT_CONF 55
#define ODOR_STRONG_CONF    65
#define ODOR_RUNTIME_ACC_MIN 2
#define HOME_BASELINE_MIN_SAMPLES 25
#define HOME_BASELINE_ALPHA 0.08f
#define HOME_BASELINE_CALM_DVOC 0.15f
#define HOME_EVENT_MIN_VOC_RISE 0.35f
#define HOME_EVENT_MIN_GAS_DROP 0.12f
#define CLEAN_AIR_SENTENCE_IDX ODOR_COUNT

enum OdorIndex : uint8_t {
  OD_FART = 0,
  OD_MUSTY,
  OD_CIGARETTE,
  OD_ALCOHOL,
  OD_WEED,
  OD_CLEANING,
  OD_GASOLINE,
  OD_SMOKE,
  OD_COOKING,
  OD_COFFEE,
  OD_GARBAGE,
  OD_SWEAT,
  OD_PERFUME,
  OD_LAUNDRY,
  OD_SULFUR,
  OD_SOLVENT,
  OD_PET,
  OD_SOUR,
  OD_BURNT,
  OD_CITRUS
};

static const char* const odorNames[ODOR_COUNT] = {
  "Fart",       "Musty",      "Cigarette", "Alcohol",
  "Weed",       "Cleaning",   "Gasoline",  "Smoke",
  "Cooking",    "Coffee",     "Garbage",   "Sweat/BO",
  "Perfume",    "Laundry",    "Sulfur",    "Solvent",
  "Pet/Litter", "Sour Food",  "Burnt/Oil", "Citrus"
};

struct HomeOdorBaseline {
  bool     ready;
  uint16_t calmSamples;
  float    voc;
  float    iaq;
  float    co2;
  float    gasR;
  float    hum;
  float    pressHpa;
};

struct PersistedHomeBaseline {
  uint32_t magic;
  uint16_t version;
  uint16_t calmSamples;
  uint8_t  ready;
  uint8_t  reserved[3];
  float    voc;
  float    iaq;
  float    co2;
  float    gasR;
  float    hum;
  float    pressHpa;
};

struct CalibrationRuntimeState {
  bool     bsecStateLoaded;
  bool     homeBaseLoaded;
  bool     homeBaseDirty;
  bool     bsecReady;
  uint8_t  stableSamples;
  uint8_t  lastIaqAcc;
};

// ── VOC smoothing (3-sample moving average) ───────────────────────────────────
// BSEC2 already smooths internally; keeping our window small preserves transient
// spikes (farts, cooking bursts) while still filtering single-sample noise.
// Old: 5 samples × 3s = 15s lag — killed fart detection completely.
// New: 3 samples × 3s = 9s lag — catches real events.
#define SMOOTH_WINDOW 3
static float   vocBuffer[SMOOTH_WINDOW] = {0};
static uint8_t vocBufIdx   = 0;
static bool    bufferFilled = false;

// ── Launch data defines ──────────────────────────────────────────────────────
#define MAX_LAUNCHES 3
#define LAUNCH_REFRESH_MS (60UL * 60UL * 1000UL)  // refresh hourly

struct LaunchData {
  char name[48];
  char time[18];
  char status[20];
  char provider[24];
  char pad[36];
  char missionType[20];
};

struct SpaceHistoryEntry {
  uint8_t month;
  uint8_t day;
  uint16_t year;
  const char* shortText;
  const char* longText;
  const char* contextText;
};

// ── Weather data struct ──────────────────────────────────────────────────────
struct WeatherData {
  bool  valid;
  int   tempF;
  int   feelsLikeF;
  int   humidity;
  char  condition[24];
  char  windDir[4];       // compass direction: N, NE, E, etc.
  char  windSpeed[12];    // speed portion only: "8 mph"
  unsigned long fetchTime;
};

#define WEATHER_REFRESH_MS (10UL * 60UL * 1000UL)

// Outdoor AQI / pollutants from OpenWeatherMap Air Pollution API
struct OutdoorAQI {
  bool  valid;
  int   aqi;           // OWM AQI index 1-5 (1=Good, 5=Very Poor)
  float co;            // Carbon monoxide    ug/m3
  float no2;           // Nitrogen dioxide   ug/m3
  float o3;            // Ozone              ug/m3
  float so2;           // Sulfur dioxide     ug/m3
  float pm25;          // PM2.5              ug/m3
  float pm10;          // PM10               ug/m3
  float nh3;           // Ammonia            ug/m3
  char  level[16];     // "Good", "Fair", "Moderate", "Poor", "Very Poor"
  char  advisory[200]; // practical advice string for Adafruit IO feed
  unsigned long fetchTime;
};

// ── Weather facts struct ─────────────────────────────────────────────────────
struct WeatherFacts {
  bool valid;
  int  dvTempF;   // Death Valley current temp
  int  moonDay;   // 0-29 (days since last new moon)
  unsigned long fetchTime;
};
#define FACTS_REFRESH_MS (30UL * 60UL * 1000UL)

// ── 5-minute IAQ / VOC trend tracker ─────────────────────────────────────────
// Samples once every 30 s; ring of 10 points covers ~5 minutes.
#define TREND_SAMPLES     10
#define TREND_INTERVAL_MS (30UL * 1000UL)

struct TrendPoint { float iaq; float voc; };

// ── BSEC2 state persistence defines ─────────────────────────────────────────
#define BSEC_NVS_NS       "sniffmstr"   // NVS namespace (max 15 chars)
#define BSEC_NVS_KEY      "bsec"
#define BSEC_HOME_KEY     "homebase"
#define BSEC_SAVE_MS      (10UL * 60UL * 1000UL)   // periodic save interval
#define HOME_BASE_MAGIC   0x48424C31UL             // "HBL1"
#define HOME_BASE_VER     1
#define CAL_READY_SAMPLES 3

// (NOTE_SPEED removed — all timing now BPM-based via duration macros)

// ── Verdict concern level ────────────────────────────────────────────────────
// Concern level per odor (0=pleasant, 1=mild, 2=moderate, 3=urgent)
// Fart,Musty,Cig,Alc,Weed,Clean,Gas,Smoke,Cook,Coffee,Garb,Sweat
// Concern level per odor (0=pleasant, 1=mild, 2=moderate, 3=urgent)
// Fart,Musty,Cig,Alc,Weed,Clean,Gas,Smoke,Cook,Coffee,Garb,Sweat,Perf,Laundry,Sulfur,Solvent,Pet,Sour,Burnt,Citrus
static const uint8_t ODOR_CONCERN[ODOR_COUNT] = {
  3,1,2,1,2,0,3,3,0,0,2,1,0,0,3,2,2,2,2,0
};

// ── Alert cooldown ───────────────────────────────────────────────────────────
#define ALERT_COOLDOWN_MS (120000UL)          // 2 min between alert popups

// ══════════════════════════════════════════════════════════════
// Section 7: Forward Declarations of ALL Functions
// ══════════════════════════════════════════════════════════════

// Utility functions
static float pressToHpa(float raw);
const char* iaqQuality(float iaq);
static const char* windDirFromArrow(const char* raw);
static int moonIllumPct(int age);
static int moonAge(int y, int m, int d);
static const char* moonPhaseName(int day);
const char* confWord(uint8_t score);
const char* tierDesc(uint8_t tier);
uint8_t smellTier(float voc);
int computeAirScore(float iaq, float voc, float co2, float hum,
                    const uint8_t scores[], int outdoorAqi);
float pushAndSmooth(float v);
void topTwo(const uint8_t scores[ODOR_COUNT], uint8_t &i1, uint8_t &i2);
static uint8_t maxOdorScore(const uint8_t scores[ODOR_COUNT]);
static void resetHomeBaseline();
static bool homeBaseLooksValid(const HomeOdorBaseline &base);
static bool bsecPhysicallySettled(float stabStatus, float runInStatus);
static void updateCalibrationRuntimeState(uint8_t iaqAcc, float stabStatus, float runInStatus);
static bool bsecCalibrationReady(uint8_t iaqAcc);
static bool fullCalibrationReady(uint8_t iaqAcc);
static const char* calibrationStatusText(uint8_t iaqAcc, float stabStatus, float runInStatus);
static const char* calibrationBadgeText(uint8_t iaqAcc, float stabStatus, float runInStatus);
static void updateHomeBaseline(float voc, float iaq, float co2, float gasR,
                               float hum, float pressHpa, uint8_t iaqAcc,
                               float dVocAbs, const uint8_t scores[ODOR_COUNT]);
static void applyHomeMlTuning(uint8_t scores[ODOR_COUNT], float voc, float iaq,
                              float co2, float gasR, float dVocRise,
                              float hum, uint8_t iaqAcc);
static void deriveExpandedOdors(uint8_t scores[ODOR_COUNT], float voc, float iaq,
                                float co2, float gasR, float dVocRise,
                                float hum, uint8_t iaqAcc);
static void stabilizePrimaryOdor(uint8_t scores[ODOR_COUNT], uint8_t iaqAcc);

// Odor classification
#ifndef USE_ML_SCORING
void scoreOdors(float voc, float iaq, float co2, float dVoc, float gasR,
                uint8_t scores[ODOR_COUNT]);
#endif

// Drawing helpers
void drawHeader(const char* left, const char* right = nullptr);
void drawBar(int x, int y, int w, int h, uint8_t pct, bool invert = false);
void drawOdorRow(int y, char prefix, const char* name, bool lowAcc,
                 uint8_t score, bool highlight);
void drawWrappedSentence(const char* text, int startY);
static int wrapLine(const char* text, int offset, char* out);

// RGB LED
void updateRGB(float iaq);

// Melody system
static void melStart(const int16_t* notes, const uint16_t* durs, uint8_t len, uint8_t repeats = 1);
static void melStartPool(uint8_t idx, uint8_t repeats = 1);
static void melStartAlert(uint8_t idx, uint8_t repeats = 1);
static void melStop();
static bool melBusy();
static void melTick();
static bool playMelodyByKey(const char* key, const char* reason = nullptr);
static bool waitResponsive(unsigned long ms);
static bool jinglesEnabled();
static void toggleJinglesMute();
static void safeBmeDelayUs(uint32_t periodUs, void* intfPtr);
void showNowPlaying(uint8_t idx, const char* reason = nullptr);
static void showNowPlayingText(const char* title, const char* artist, const char* reason = nullptr);
static void rememberMelodyPlayback(const char* title, const char* reason);

// Last melody played — shown in Blynk SniffMaster report
static char lastMelodyPlayed[48] = "(none yet)";
static char lastMelodyReason[48] = "Waiting for a trigger";
static unsigned long lastMelodyUptimeSec = 0;
static bool jinglesMuted = false;
void playStartupMelody();
void playLongPressMelody();
void playOdorChangeMelody(uint8_t oldTier, uint8_t newTier);

// Label mode
void enterLabelMode();
void emitLabelData(float voc, float iaq, float co2, float tempF,
                   float hum, float pressurePa, float gasR, float dVoc);

// Trend tracker
static void pushTrend(float iaq, float voc);
static const char* getIaqTrend();
static const char* getVocTrend();

// BSEC persistence
static void loadBsecState();
static void saveBsecState();
static bool subscribeBsecOutputs(bool allowFallback, const char* context);

// Network functions
bool fetchLocation();
bool fetchWeather();
bool fetchWeatherFacts();
bool fetchOutdoorAQI();
bool fetchLaunches();
static void queueBootstrapCloudTasks();
static void queueWeatherCloudTasks();
static void queueLaunchCloudTasks();
static void queueDadJokeFetch();
static void queueDeferredCloudTasksForNewDay();
static void serviceDeferredCloudTasks(unsigned long now);
static bool optionalCloudAllowed(unsigned long now);
static void noteOptionalCloudAttempt(unsigned long now);
#ifdef USE_ADAFRUIT_IO
void ensureAioGroup();
bool sendToAdafruitIO(int iaq, float voc, float co2, float tempF, float hum,
                      float pressHpa, float gasR, const char* odorName,
                      uint8_t odorConf, int airScore, uint8_t tier,
                      const char* sassyMsg, const char* hazardLevel);
#endif
static void fmtLaunchTime(const char* iso, char* out, int len);
static void fmtLaunchTimeBrief(const char* iso, char* out, int len);
static bool launchLooksKscCcsfs(const String& body, int startPos);
static bool getTodaySpaceHistory(char* shortLine, int shortLen, char* longLine, int longLen);
static bool getTodaySpaceHistory(char* shortLine, int shortLen, char* longLine, int longLen,
                                 char* contextLine, int contextLen);
bool fetchDadJoke();
bool fetchGPTSassyMsg(int iaq, float voc, float co2, float tempF, float hum,
                      float pressHpa, float gasR, const char* topOdor,
                      uint8_t odorConf, int airScore,
                      const char* iaqTrend, const char* vocTrend,
                      char* outHazard, int hazardLen,
                      char* outMsg,    int outLen);
#ifdef USE_BLYNK
void sendToBlynk(int iaq, float voc, float co2, float tempF, float hum,
                 float pressHpa, float gasR, const char* odorName,
                 uint8_t odorConf, int airScore,
                 const char* sassyMsg, const char* hazardLevel);
#endif
#ifdef USE_WEB_DASHBOARD
bool sendToWebDashboard();
bool sendPrioritySniffEvent();
void pollPortalCommand();
static void executePortalCommand(const char* action, const char* melodyKey = nullptr);
#endif

// Splash screen
static void splashNose(int ny);
static void splashSniff(int baseY);
void drawSplash();
void drawHelpScreen();

// OLED Pages
void renderAirQualityPage(uint8_t tier, float voc, float iaq, int airScore,
                          uint8_t iaqAcc, const uint8_t scores[ODOR_COUNT]);
void renderOdorDetailPage(const uint8_t scores[ODOR_COUNT], int airScore, uint8_t iaqAcc);
static uint8_t verdictLevel(const uint8_t scores[ODOR_COUNT], int airScore);
static const char* getAdvice(uint8_t topOdor, uint8_t conf, uint8_t level);
void renderEnvPage(float tempF, float hum, float pressureRaw,
                   float co2, float voc, float iaq, uint8_t iaqAcc);
void renderGasAnalysisPage(float voc, float iaq, float co2, float gasR,
                           float dvoc, uint8_t iaqAcc,
                           const char* iaqTrend, const char* vocTrend);
void renderSmellSentencePage(const uint8_t scores[ODOR_COUNT],
                             int airScore, uint8_t iaqAcc);
void renderNetworkPage();
void renderFartTrackerPage();
void renderWeatherPage();
void renderLaunchPage();
void renderDadJokePage();
static void renderBootStatusPage();
static void _drawJokeFrame(char lines[][22], int numLines, int pxOff);

// Special modes
void runBreathChecker();
void runPresenceProbe();
void runParanormalScan();
void showFartAnalysis();

// Alert system
void showAirAlert(const char* title, const char* msg);
void checkAirAlerts(float iaq, float voc, float co2, float hum,
                    const uint8_t scores[], uint8_t iaqAcc);
static void showFartAlert();

// Input handling
void handleButton();

// BSEC2 callback
void onSensorData(const bme68xData data, const bsecOutputs outputs, const Bsec2 bsec);

// setup() and loop()
void setup();
void loop();

// ══════════════════════════════════════════════════════════════
// Section 8: Global State - Sensor Volatiles, Flags
// ══════════════════════════════════════════════════════════════

volatile bool    newDataReady      = false;
volatile float   latestVocRaw      = 0;
volatile float   latestIAQ         = 0;
volatile float   latestStaticIAQ   = 0;
volatile float   latestCO2         = 0;
volatile float   latestTemp        = 0;
volatile float   latestHumidity    = 0;
volatile float   latestPressure    = 0;
volatile float   latestGasR        = 0;
volatile float   latestCompGas     = 0;   // temp/humidity compensated gas resistance
volatile float   latestGasPct      = 0;   // gas composition change 0-100%
volatile float   latestStabStatus  = 0;   // 1.0 = sensor stabilized
volatile float   latestRunInStatus = 0;   // 1.0 = initial run-in complete
volatile uint8_t latestIAQAccuracy = 0;

bool pendingDcSend = false;    // Deferred cloud refresh / GPT refresh flag
bool forceRedraw   = false;    // Used to refresh the OLED immediately
int  lastIAQ       = 0;        // Used to track IAQ shifts

// ══════════════════════════════════════════════════════════════
// Section 9: Global State - Display/Page State, Snapshot Variables
// ══════════════════════════════════════════════════════════════

static unsigned long lastDisplayUpdate   = 0;
const  unsigned long DISPLAY_INTERVAL_MS = 10000;  // 10s auto-cycle
uint8_t              displayPage         = 0;
static unsigned long lastBootStatusRenderMs = 0;

// Sensor snapshot — persists between renders so short-press can force redraw
static float   ss_voc = 0, ss_iaq = 0, ss_co2 = 0;
static float   ss_tempF = 72.0f, ss_hum = 50.0f, ss_pressure = 101325.0f;
static float   ss_gasR = 50000.0f, ss_dvoc = 0;
static float   ss_staticIAQ = 0, ss_compGas = 0, ss_gasPct = 0;
static float   ss_stabStatus = 0, ss_runInStatus = 0;
static uint8_t ss_iaqAcc = 0;
static uint8_t ss_scores[ODOR_COUNT] = {0};
static uint8_t ss_tier = 0;
static int     ss_airScore = 0;
static bool    ss_valid = false;
static float   ss_prevVoc = 0;
static uint8_t ss_prevTier = 0xFF;
static HomeOdorBaseline homeBase = { false, 0, 0.5f, 25.0f, 420.0f, 180000.0f, 45.0f, 1013.0f };
static CalibrationRuntimeState calState = { false, false, false, false, 0, 0xFF };
static uint8_t homeLastPrimaryOdor = ODOR_COUNT;
static uint8_t homePrimaryHoldCount = 0;

// Calibration beep
static uint8_t ss_prevIaqAcc = 0;
static bool    calBeepDone   = false;
// Rapid smell detection
static uint8_t ss_prevFartConf   = 0;
static uint8_t ss_peakFartConf   = 0;  // highest fart score since last count (for re-arm hysteresis)
static uint8_t ss_prevSulfurConf = 0;
static int     ss_prevAirScore      = 0;
static unsigned long lastRapidMs = 0;

// ══════════════════════════════════════════════════════════════
// Section 10: Global State - Cloud/Telemetry Variables (dc*)
// ══════════════════════════════════════════════════════════════

static int    dcIAQ           = 0;
static float  dcVOC           = 0;
static float  dcCO2           = 0;
static float  dcTempF         = 0;
static float  dcHum           = 0;
static float  dcPressHpa      = 0;
static float  dcGasR          = 0;
static float  dcCFIScore      = 1.0f;
static uint8_t dcCFIPercent   = 100;
static uint8_t dcVTRLevel     = 0;
static uint8_t dcOdorIdx      = 0;
static uint8_t dcOdorConf     = 0;
static int    dcAirScore         = 0;
static uint8_t dcTier         = 0;
static char   dcSassyMsg[280]   = "";     // GPT environmental report (up to 240 chars)
static char   dcHazardLevel[20] = "";   // Pristine/Fresh/Fair/Stale/Caution/Warning/Danger
static char   dcSmellQuip[120]  = "";   // GPT smell quip for OLED (3 short lines, \n separated)
static char   dcSmellRadar[300] = "";   // GPT smell radar narrative for Blynk V8
static bool   dcSnapshotReady  = false; // true once dc* has been populated by sensor or button

// ══════════════════════════════════════════════════════════════
// Section 11: Global State - Fart Tracker, Alerts
// ══════════════════════════════════════════════════════════════

static int           fartCount        = 0;
static float         biggestFartVoc   = 0;
static int           fartResetDay     = -1;   // day-of-month when counter was last reset
#define FART_COOLDOWN_MS 30000UL              // 30s refractory between fart counts
static unsigned long lastFartMs       = 0;    // millis of last counted fart

// Last fart event metrics — for 6-click analysis page
struct FartEvent {
  bool     valid;
  unsigned long ms;
  uint8_t  fartScore;
  float    voc;
  float    dVocRise;
  float    iaq;
  float    gasR;
  float    baseGasDrop;   // fraction drop from home baseline
  uint8_t  topOdor;
  uint8_t  sulfurScore;
  uint8_t  garbageScore;
  uint8_t  petScore;
  uint8_t  iaqAcc;
};
static FartEvent lastFartEvent = { false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };

struct ParanormalScanCache {
  bool valid;
  char entity[20];
  char report[120];
  unsigned long uptimeSec;
};
static ParanormalScanCache lastParanormalScan = { false, "", "", 0 };

// Initialize to max so (millis() - lastAlertMs >= cooldown) passes on first check
static unsigned long lastAlertMs      = -(ALERT_COOLDOWN_MS);

// Hourly chime — plays Westminster chime at the top of each hour
static int           lastChimeHour    = -1;   // hour when chime last played (-1 = never)

// ══════════════════════════════════════════════════════════════
// Section 12: Global State - Location, Weather, Outdoor AQI,
//             Launches, Dad Joke, Trend
// ══════════════════════════════════════════════════════════════

// Location (fetched once on boot via IP geolocation)
static float  deviceLat       = 0.0f;
static float  deviceLon       = 0.0f;
static char   deviceCity[32]  = "";
static bool   locationFetched = false;
static int32_t utcOffsetSec   = 0;      // UTC offset in seconds (auto-detected from IP geolocation)

// Weather
static WeatherData weather = { false, 0, 0, 0, "", "", "", 0 };

// Outdoor AQI
static OutdoorAQI outdoorAqi = { false, 0, 0,0,0,0, 0,0,0, "", "", 0 };

// Weather facts
static WeatherFacts facts = { false, 0, 0, 0 };

// Dad joke
static char dadJokeText[200] = "";
static bool dadJokeReady     = false;

// Launches
static LaunchData    launches[MAX_LAUNCHES];
static int           launchCount    = 0;
static unsigned long launchFetchTime = 0;
static int           launchesYTD    = -1;  // year-to-date launch count (-1 = not fetched)
static bool          pendingLocationFetch = false;
static bool          pendingWeatherFetch = false;
static bool          pendingOutdoorAqiFetch = false;
static bool          pendingLaunchFetch = false;
static bool          pendingDadJokeFetch = false;
static unsigned long lastOptionalCloudMillis = 0;
const  unsigned long OPTIONAL_CLOUD_GAP_MS = 12000UL;

// Trend ring buffer
static TrendPoint    trendRing[TREND_SAMPLES];
static uint8_t       trendHead   = 0;
static uint8_t       trendFilled = 0;
static unsigned long lastTrendMs = 0;

// ══════════════════════════════════════════════════════════════
// Section 13: Global State - Melody State Machine, Label Mode,
//             BSEC Persistence
// ══════════════════════════════════════════════════════════════

// ── Non-blocking melody state machine ─────────────────────────────────────────
// melTick() is called every loop() iteration and advances the buzzer one step
// without blocking, so envSensor.run() and button checks continue uninterrupted.
struct MelState {
  const int16_t*  notes;
  const uint16_t* durations;
  uint8_t         len;
  uint8_t         idx;
  uint8_t         repeatsLeft;
  unsigned long   phaseEnd;   // millis() when this note/gap phase ends
  bool            inGap;      // true during the 20 ms articulation gap
  bool            active;
};
static MelState mel = {};

// Label mode flag
static bool labelModeActive = false;

// BSEC persistence state
static Preferences        bsecPrefs;
static unsigned long      lastBsecSaveMs  = 0;
static bool               bsecAcc3Saved   = false;   // save-once flag for acc==3

// AI fetch cooldown — GPT is called on significant environmental changes AND
// periodically to keep the dashboard feeling alive and intelligent.
// gpt-4o-mini is extremely cheap (~$0.15/1K requests) so 2-min is safe.
static unsigned long lastAiFetchMillis = 0;
const  unsigned long AI_COOLDOWN       = 120000UL;  // 2 minutes

// Track previous odor detection for AI triggers
static uint8_t prevAiOdorIdx = 255;     // last odor index sent to GPT

#ifdef USE_ADAFRUIT_IO
// Adafruit IO dashboard update interval — separate from GPT cooldown.
// Free tier: 30 data points/min. A group POST with 10 feeds = 10 points.
// 30s interval = 2 posts/min = 20 points/min (safely under limit).
static unsigned long lastAioPostMillis = 0;
const  unsigned long AIO_POST_INTERVAL = 30000UL;   // 30 seconds (was 20 — caused throttle)
const  unsigned long AIO_MIN_COOLDOWN  = 15000UL;   // minimum 15s between AIO pushes
#endif

static void queueEventPush();

// Blynk IoT update interval — separate from AIO.
// Blynk free tier: 10 datastreams, no hard rate limit but ~10s recommended.
// Uses persistent TCP connection via Blynk library (not REST).
#ifdef USE_BLYNK
static unsigned long lastBlynkPostMillis = 0;
const  unsigned long BLYNK_POST_INTERVAL = 900000UL; // 15 minutes (12 events/cycle = ~35k/month)
static bool blynkConnected = false;
#endif

static unsigned long lastWiFiRetryMillis = 0;
static wl_status_t    lastWiFiLoopStatus = WL_IDLE_STATUS;
static int            wifiRetryIndex = 0;
static int            wifiPreferredIndex = 0;
static unsigned long  wifiOfflineSinceMillis = 0;
static bool           wifiConnectAttemptActive = false;
static unsigned long  wifiConnectStartMillis = 0;
static int            wifiConnectIndex = -1;
static bool           wifiBootstrapPending = true;
static bool           blePresenceStarted = false;
static unsigned long  bsecInitMillis = 0;
static unsigned long  lastBsecWaitLogMillis = 0;
static bool           bsecFirstPacketRetryDone = false;
static bool           bsecUsingLpSafeOutputs = false;
static float          bsecActiveSampleRate = BSEC_SAMPLE_RATE_LP;
static int            lastBsecStatusLog = 9999;
static int            lastBmeStatusLog = 9999;
const  unsigned long  WIFI_RETRY_MS = 30000UL;
const  unsigned long  WIFI_OFFLINE_DEBOUNCE_MS = 10000UL;
const  unsigned long  WIFI_ROTATE_AFTER_MS = 120000UL;
const  unsigned long  WIFI_CONNECT_TIMEOUT_MS = 8000UL;
const  unsigned long  CLOUD_RADIO_QUIET_MS = 20000UL;

#define EVENT_PUSH() queueEventPush()

// Web Dashboard update interval — posts JSON snapshot to hosted relay.
// Uses HTTPS POST, so each call takes ~1–3 seconds.  Every 10 minutes
// keeps Upstash free tier well under 10k commands/day.
#ifdef USE_WEB_DASHBOARD
static unsigned long lastWebPostMillis = 0;
static unsigned long lastWebAttemptMillis = 0;
static bool pendingWebSend = false;
static bool pendingWebUrgent = false;
static unsigned long lastCommandPollMillis = 0;
static unsigned long lastCommandSeq = 0;
static unsigned long lastWebRecoveryMillis = 0;
const  unsigned long WEB_POST_INTERVAL = 60000UL;  // 1 minute
const  unsigned long WEB_MIN_COOLDOWN  = 15000UL;  // allow event-driven pushes without spamming
const  unsigned long WEB_POST_RETRY_MS = 60000UL;  // retry failed web posts every minute
const  unsigned long COMMAND_POLL_MS   = 20000UL;
const  unsigned long COMMAND_POLL_START_DELAY_MS = 30000UL;
const  unsigned long WEB_STALE_RECOVER_MS = 180000UL;   // 3 minutes without a fresh post
const  unsigned long WEB_RECOVER_BACKOFF_MS = 120000UL; // avoid thrashing radio resets
static bool pendingSniffSend = false;
static unsigned long lastSniffPostMillis = 0;
static unsigned long lastSniffAttemptMs = 0;
const  unsigned long SNIFF_POST_RETRY_MS = 10000UL;
const  unsigned long SNIFF_POST_COOLDOWN = 45000UL;
static int    queuedSniffIaq = 0;
static float  queuedSniffConf = 0.0f;
static char   queuedSniffLabel[24] = "";
#endif

static void queueEventPush() {
  unsigned long now = millis();
#ifdef USE_ADAFRUIT_IO
  if (now - lastAioPostMillis > AIO_MIN_COOLDOWN) {
    lastAioPostMillis = now - AIO_POST_INTERVAL + AIO_MIN_COOLDOWN;
  }
#endif
#ifdef USE_BLYNK
  lastBlynkPostMillis = 0;
#endif
#ifdef USE_WEB_DASHBOARD
  pendingWebSend = true;
  pendingWebUrgent = true;
#endif
}

static void queueMelodyChangePush() {
  // Skip the boot-time startup tune before we have a meaningful snapshot.
  // Once runtime data exists, melody changes should flow out to dashboards
  // just like other notable events.
  if (!ss_valid && !dcSnapshotReady) return;
  queueEventPush();
}

static void quietBleForCloud() {
  blePresencePauseFor(CLOUD_RADIO_QUIET_MS);
}

static void noteOptionalCloudAttempt(unsigned long now) {
  lastOptionalCloudMillis = now;
}

static void queueWeatherCloudTasks() {
  pendingWeatherFetch = true;
  pendingOutdoorAqiFetch = true;
  if (!locationFetched) pendingLocationFetch = true;
}

static void queueLaunchCloudTasks() {
  pendingLaunchFetch = true;
}

static void queueDadJokeFetch() {
  pendingDadJokeFetch = true;
}

static void queueBootstrapCloudTasks() {
  // Keep boot focused on sensor bring-up and the live relay. Optional cloud
  // lookups are fetched on demand so they cannot destabilize the portal path
  // during the first successful snapshot on the ESP32-C3.
  if (!locationFetched) pendingLocationFetch = true;
}

static void queueDeferredCloudTasksForNewDay() {
  // Keep midnight maintenance light. Nonessential fetches are loaded on demand
  // from the UI so they cannot starve the live relay path overnight.
}

#ifdef USE_WEB_DASHBOARD
static bool portalBackpressureActive(unsigned long now) {
  if (pendingSniffSend) return true;
  if (pendingWebSend) return true;
  if (dcSnapshotReady && lastWebPostMillis == 0) return true;
  return lastWebPostMillis != 0 &&
         now - lastWebPostMillis >= (WEB_POST_INTERVAL + WEB_POST_RETRY_MS);
}
#endif

static bool optionalCloudAllowed(unsigned long now) {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (lastOptionalCloudMillis != 0 &&
      now - lastOptionalCloudMillis < OPTIONAL_CLOUD_GAP_MS) return false;
#ifdef USE_WEB_DASHBOARD
  if (lastWebPostMillis == 0 && !dcSnapshotReady) return false;
  if (portalBackpressureActive(now)) return false;
#endif
  return true;
}

static void serviceDeferredCloudTasks(unsigned long now) {
  if (!optionalCloudAllowed(now)) return;
  if (melBusy()) melStop();  // silence buzzer before blocking TLS calls

  bool attempted = false;

  if (pendingLocationFetch) {
    pendingLocationFetch = !fetchLocation();
    attempted = true;
  } else if (pendingWeatherFetch) {
    pendingWeatherFetch = !fetchWeather();
    attempted = true;
  } else if (pendingOutdoorAqiFetch) {
    if (!locationFetched) {
      pendingLocationFetch = true;
    } else {
      pendingOutdoorAqiFetch = !fetchOutdoorAQI();
      attempted = true;
    }
  } else if (pendingLaunchFetch) {
    pendingLaunchFetch = !fetchLaunches();
    attempted = true;
  } else if (pendingDadJokeFetch) {
    pendingDadJokeFetch = !fetchDadJoke();
    attempted = true;
  }

  if (attempted) noteOptionalCloudAttempt(now);
}

static void maybeRecoverWebRelay(unsigned long now) {
  if (!dcSnapshotReady) return;
  if (WiFi.status() != WL_CONNECTED) return;

  const bool neverPostedTooLong =
      (lastWebPostMillis == 0 && now >= 300000UL && lastWebAttemptMillis != 0 &&
       now - lastWebAttemptMillis >= WEB_POST_RETRY_MS);
  const bool stalePostedTooLong =
      (lastWebPostMillis != 0 && now - lastWebPostMillis >= WEB_STALE_RECOVER_MS);

  if (!neverPostedTooLong && !stalePostedTooLong) return;
  if (lastWebRecoveryMillis != 0 &&
      now - lastWebRecoveryMillis < WEB_RECOVER_BACKOFF_MS) return;

  lastWebRecoveryMillis = now;
  Serial.println(F("[WEB] Relay watchdog: forcing WiFi recovery."));
  quietBleForCloud();
  pendingWebSend = true;
  pendingWebUrgent = true;
  lastWebAttemptMillis = 0;
  lastCommandPollMillis = 0;
  lastWiFiRetryMillis = 0;
  WiFi.disconnect();
  lastWiFiLoopStatus = WL_DISCONNECTED;
  wifiConnectAttemptActive = false;
  wifiConnectStartMillis = 0;
  wifiConnectIndex = -1;
}

static int wifiIndexForSsid(const String& ssid) {
  for (int i = 0; i < WIFI_NUM_NETWORKS; i++) {
    if (ssid == WIFI_CREDS[i][0]) return i;
  }
  return -1;
}

static bool startWiFiConnectAttempt(int networkIndex, bool announce) {
  if (networkIndex < 0 || networkIndex >= WIFI_NUM_NETWORKS) return false;

  const char* ssid = WIFI_CREDS[networkIndex][0];
  const char* pass = WIFI_CREDS[networkIndex][1];

  quietBleForCloud();
  WiFi.disconnect();
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);
  wifiConnectAttemptActive = true;
  wifiConnectStartMillis = millis();
  wifiConnectIndex = networkIndex;

  if (announce) {
    Serial.printf("[WiFi] Reconnect attempt %d/%d -> %s\n",
                  networkIndex + 1, WIFI_NUM_NETWORKS, ssid);
  }
  return true;
}

static void maintainWiFi() {
  wl_status_t status = WiFi.status();
  unsigned long now = millis();

  if (status == WL_CONNECTED) {
    if (lastWiFiLoopStatus != WL_CONNECTED) {
      WiFi.setSleep(false);
      Serial.printf("[WiFi] Recovered: %s  IP=%s\n",
                    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
      lastWiFiRetryMillis = 0;
      wifiOfflineSinceMillis = 0;
      wifiConnectAttemptActive = false;
      wifiConnectStartMillis = 0;
      wifiConnectIndex = -1;
      int currentIdx = wifiIndexForSsid(WiFi.SSID());
      if (currentIdx >= 0) {
        wifiPreferredIndex = currentIdx;
        wifiRetryIndex = currentIdx;
      }
      if (wifiBootstrapPending) {
        configTime(0, 0, "pool.ntp.org", "time.nist.gov");
        queueBootstrapCloudTasks();
        wifiBootstrapPending = false;
      }
      if (dcSnapshotReady) queueEventPush();
    }
    lastWiFiLoopStatus = status;
    return;
  }

  if (lastWiFiLoopStatus == WL_CONNECTED) {
    Serial.println(F("[WiFi] Link lost; enabling background reconnect."));
#ifdef USE_BLYNK
    blynkConnected = false;
#endif
    wifiOfflineSinceMillis = now;
    wifiConnectAttemptActive = false;
    wifiConnectStartMillis = 0;
    wifiConnectIndex = -1;
  }
  lastWiFiLoopStatus = status;

  if (wifiOfflineSinceMillis == 0) wifiOfflineSinceMillis = now;
  if (now - wifiOfflineSinceMillis < WIFI_OFFLINE_DEBOUNCE_MS) return;

  if (wifiConnectAttemptActive) {
    if (now - wifiConnectStartMillis < WIFI_CONNECT_TIMEOUT_MS) return;
    const char* timedOutSsid =
        (wifiConnectIndex >= 0 && wifiConnectIndex < WIFI_NUM_NETWORKS)
      ? WIFI_CREDS[wifiConnectIndex][0]
      : "(unknown)";
    Serial.printf("[WiFi] %s did not reconnect after %lums (status=%d)\n",
                  timedOutSsid, now - wifiConnectStartMillis, (int)WiFi.status());
    wifiConnectAttemptActive = false;
    wifiConnectStartMillis = 0;
    wifiConnectIndex = -1;
  }

  if (now - lastWiFiRetryMillis < WIFI_RETRY_MS) return;
  lastWiFiRetryMillis = now;

  if (WIFI_NUM_NETWORKS <= 0) return;

  int retryIndex = wifiPreferredIndex;
  bool bootstrapScan = wifiBootstrapPending || wifiPreferredIndex < 0 ||
                       wifiPreferredIndex >= WIFI_NUM_NETWORKS;
  if (retryIndex < 0 || retryIndex >= WIFI_NUM_NETWORKS) retryIndex = 0;
  if (bootstrapScan || now - wifiOfflineSinceMillis >= WIFI_ROTATE_AFTER_MS) {
    retryIndex = wifiRetryIndex;
    wifiRetryIndex = (wifiRetryIndex + 1) % WIFI_NUM_NETWORKS;
  } else {
    wifiRetryIndex = wifiPreferredIndex;
  }

  startWiFiConnectAttempt(retryIndex, true);
}

#ifdef USE_WEB_DASHBOARD
static void queueSniffPriorityPost(int iaq, float vscConf, const char* label) {
  queuedSniffIaq = iaq;
  queuedSniffConf = constrain(vscConf, 0.0f, 100.0f);
  strlcpy(queuedSniffLabel, (label && label[0]) ? label : "High Sulfur", sizeof(queuedSniffLabel));
  pendingSniffSend = true;
}
#endif

// ══════════════════════════════════════════════════════════════
// Section 14: Utility Functions
//   pressToHpa, iaqQuality, windDirFromArrow, moonIllumPct,
//   moonAge, moonPhaseName, confWord, tierDesc, smellTier,
//   computeAirScore (composite Room Quality), pushAndSmooth, topTwo
// ══════════════════════════════════════════════════════════════

// Auto-detect pressure units: if > 10000, value is Pa; else already hPa
static float pressToHpa(float raw) {
  return (raw > 10000.0f) ? raw / 100.0f : raw;
}

// IAQ quality label per Bosch BSEC2 ranges (0-500 scale)
const char* iaqQuality(float iaq) {
  if (iaq <=  50) return "Good";
  if (iaq <= 100) return "OK";
  if (iaq <= 150) return "Moderate";
  if (iaq <= 200) return "Poor";
  if (iaq <= 300) return "Bad";
  return "Hazardous";
}

// Convert UTF-8 directional arrow from wttr.in to compass text
static const char* windDirFromArrow(const char* raw) {
  if (!raw || (uint8_t)raw[0] != 0xE2 || (uint8_t)raw[1] != 0x86) return "";
  switch ((uint8_t)raw[2]) {
    case 0x91: return "N";  case 0x97: return "NE"; case 0x92: return "E";
    case 0x98: return "SE"; case 0x93: return "S";  case 0x99: return "SW";
    case 0x90: return "W";  case 0x96: return "NW";
  }
  return "";
}

// Moon illumination percentage from lunar age (0-29 days)
static int moonIllumPct(int age) {
  float phase = (float)age / 29.53f;
  return (int)((1.0f - cosf(phase * 2.0f * 3.14159265f)) / 2.0f * 100.0f + 0.5f);
}

// Approximate moon age from calendar date.
// Uses Julian Day method; accurate to +/-1-2 days.
static int moonAge(int y, int m, int d) {
  if (m <= 2) { y--; m += 12; }
  int A = y / 100, B = 2 - A + A / 4;
  float jd = (int)(365.25f * (y + 4716)) + (int)(30.6001f * (m + 1)) + d + B - 1524.5f;
  float age = fmod(jd - 2451550.1f, 29.53059f);
  if (age < 0) age += 29.53059f;
  return (int)age;
}

static const char* moonPhaseName(int day) {
  if (day <= 1 || day >= 29) return "New Moon";
  if (day <=  6) return "Waxing Crescent";
  if (day <=  9) return "First Quarter";
  if (day <= 13) return "Waxing Gibbous";
  if (day <= 16) return "Full Moon";
  if (day <= 20) return "Waning Gibbous";
  if (day <= 23) return "Last Quarter";
  return "Waning Crescent";
}

const char* confWord(uint8_t score) {
  if (score >= 75) return "strong";
  if (score >= 55) return "likely";
  if (score >= 35) return "maybe";
  return "faint";
}

const char* tierDesc(uint8_t tier) {
  switch (tier) {
    case 0: return "Clean";
    case 1: return "Normal";
    case 2: return "Funky";
    case 3: return "Stinky";
    case 4: return "Ripe";
    default: return "HAZMAT!";
  }
}

uint8_t smellTier(float voc) {
  // BSEC2 breath VOC equivalent ranges:
  //   Clean air:   0.3–0.8 ppm
  //   Mild odor:   0.8–3.0 ppm  (coffee, mild cooking)
  //   Moderate:    3.0–8.0 ppm  (cooking, someone nearby)
  //   Strong:      8.0–25.0 ppm (diaper, fart, garbage)
  //   Very strong: 25.0–60.0 ppm (smoke, chemicals)
  //   Extreme:     60.0+ ppm    (fire, spill, heavy smoke)
  if (voc <  0.8f) return 0;   // Clean
  if (voc <  3.0f) return 1;   // Normal
  if (voc <  8.0f) return 2;   // Funky
  if (voc < 25.0f) return 3;   // Stinky
  if (voc < 60.0f) return 4;   // Ripe
  return 5;                     // HAZMAT
}

// Dew point from temperature (F) and relative humidity (%)
// Uses Magnus formula — accurate to ~0.4F across normal indoor range.
// Dew point tells you the actual moisture content of the air.
// If room temp approaches dew point → condensation risk.
static float dewPointF(float tempF, float rh) {
  float tC = (tempF - 32.0f) * 5.0f / 9.0f;
  float a = 17.27f, b = 237.7f;
  float gamma = (a * tC) / (b + tC) + logf(rh / 100.0f);
  float dpC = (b * gamma) / (a - gamma);
  return dpC * 9.0f / 5.0f + 32.0f;
}

// Format uptime as human-readable string: "2h 15m" or "3d 5h"
static void fmtUptime(char* buf, size_t len) {
  unsigned long sec = millis() / 1000UL;
  unsigned long m = sec / 60;
  unsigned long h = m / 60;
  unsigned long d = h / 24;
  if (d > 0)
    snprintf(buf, len, "%lud %luh", d, h % 24);
  else if (h > 0)
    snprintf(buf, len, "%luh %lum", h, m % 60);
  else
    snprintf(buf, len, "%lum %lus", m, sec % 60);
}

/**
 * computeAirScore() — composite Room Quality Score (0–100)
 *
 * 0 = perfect, pristine air.  100 = hazardous, evacuate.
 *
 * Combines 6 independent factors that each contribute meaningful,
 * non-overlapping information about air quality:
 *
 *   IAQ (0–30 pts)     : BSEC2's calibrated air quality index — the primary
 *                         indicator of overall indoor air health.
 *   VOC (0–15 pts)     : Volatile organic compounds — captures chemical
 *                         exposures (solvents, paints, cleaning products)
 *                         that IAQ alone may underweight.
 *   CO2 (0–15 pts)     : Stuffiness / ventilation adequacy. Rises in
 *                         occupied rooms with poor airflow. Independent of
 *                         VOC sources.
 *   Humidity (0–15 pts) : Comfort + mold risk. Too dry (<30%) or too
 *                         humid (>60%) degrades air quality even when
 *                         IAQ/VOC are fine.
 *   Odor (0–15 pts)    : SmellNet ML's peak odor confidence — detects
 *                         unpleasant or hazardous smells that may not
 *                         register strongly in raw IAQ/VOC numbers.
 *   Outdoor AQI (0–10 pts): If outdoor air is poor, indoor air is likely
 *                         affected too (infiltration through windows/HVAC).
 */
int computeAirScore(float iaq, float voc, float co2, float hum,
                    const uint8_t scores[], int outdoorAqi) {
  // IAQ: 0–500 → 0–30 points (0.06 pts per IAQ unit)
  float iaqPts = constrain(iaq * 0.06f, 0.0f, 30.0f);

  // VOC: 0–8+ ppm → 0–15 points
  // BSEC2 range: <0.5 ppm baseline, 1-3 occupied, 3-8 event, 8+ serious
  float vocPts = constrain(voc * 2.0f, 0.0f, 15.0f);

  // CO2: 400–2500 ppm → 0–15 points
  // 400 = fresh outdoor, 800 = occupied room, 1500+ = stuffy, 2500+ = bad
  float co2Pts = constrain((co2 - 400.0f) * 0.0071f, 0.0f, 15.0f);

  // Humidity penalty: ideal 40–55%, penalty outside that range
  float humPts = 0.0f;
  if (hum < 30.0f)      humPts = (30.0f - hum) * 0.5f;     // too dry
  else if (hum > 60.0f) humPts = (hum - 60.0f) * 0.375f;   // too humid
  humPts = constrain(humPts, 0.0f, 15.0f);

  // Odor: peak SmellNet score → 0–15 points
  // Only harmful/unpleasant odors count heavily
  uint8_t peakOdor = 0;
  for (int i = 0; i < ODOR_COUNT; i++) {
    if (scores[i] > peakOdor) peakOdor = scores[i];
  }
  float odorPts = constrain(peakOdor * 0.15f, 0.0f, 15.0f);

  // Outdoor AQI: OWM 1–5 scale → 0–10 points
  // 1=Good(0), 2=Fair(2), 3=Moderate(4), 4=Poor(7), 5=Very Poor(10)
  float outdoorPts = 0.0f;
  if (outdoorAqi >= 2 && outdoorAqi <= 5) {
    const float aqiMap[] = {0, 0, 2, 4, 7, 10};
    outdoorPts = aqiMap[outdoorAqi];
  } else if (outdoorAqi > 5) {
    // EPA scale fallback (0–500)
    outdoorPts = constrain(outdoorAqi * 0.02f, 0.0f, 10.0f);
  }

  int total = (int)(iaqPts + vocPts + co2Pts + humPts + odorPts + outdoorPts + 0.5f);
  return constrain(total, 0, 100);
}

float computeCfiScore(float co2, float iaq) {
  float score = 1.0f;
  if (co2 > 800.0f) {
    score -= ((co2 - 800.0f) / 100.0f) * 0.05f;
  }
  if (iaq > 100.0f) {
    score -= 0.10f;
  }
  return constrain(score, 0.0f, 1.0f);
}

const char* cfiBandForScore(float score) {
  const int pct = (int)lroundf(constrain(score, 0.0f, 1.0f) * 100.0f);
  if (pct >= 80) return "Peak";
  if (pct >= 60) return "Reduced";
  return "Drained";
}

uint8_t computeVtrLevel(float hum, float co2, float iaq) {
  if (hum < 30.0f && co2 > 1200.0f) return 2;
  if (hum >= 40.0f && hum <= 60.0f && co2 < 800.0f && iaq <= 100.0f) return 0;
  return 1;
}

const char* vtrLabelForLevel(uint8_t level) {
  switch (level) {
    case 0:  return "Safe";
    case 2:  return "High Bio-Risk";
    default: return "Elevated";
  }
}

const char* vtrAdviceForLevel(uint8_t level) {
  switch (level) {
    case 0:  return "Ventilation and humidity are in a favorable range.";
    case 2:  return "Dry, rebreathed air pattern detected. Air cleaning, filtration, or masking is recommended.";
    default: return "Stagnant or dry air detected. Increase ventilation.";
  }
}

float pushAndSmooth(float v) {
  vocBuffer[vocBufIdx] = v;
  vocBufIdx = (vocBufIdx + 1) % SMOOTH_WINDOW;
  if (!vocBufIdx) bufferFilled = true;
  uint8_t n = bufferFilled ? SMOOTH_WINDOW : vocBufIdx;
  if (!n) return v;
  float s = 0;
  for (uint8_t i = 0; i < n; i++) s += vocBuffer[i];
  return s / n;
}

void topTwo(const uint8_t scores[ODOR_COUNT], uint8_t &i1, uint8_t &i2) {
  i1 = 0;
  for (uint8_t i = 1; i < ODOR_COUNT; i++)
    if (scores[i] > scores[i1]) i1 = i;
  i2 = (i1 == 0) ? 1 : 0;
  for (uint8_t i = 0; i < ODOR_COUNT; i++)
    if (i != i1 && scores[i] > scores[i2]) i2 = i;
}

static uint8_t maxOdorScore(const uint8_t scores[ODOR_COUNT]) {
  uint8_t mx = 0;
  for (uint8_t i = 0; i < ODOR_COUNT; i++)
    if (scores[i] > mx) mx = scores[i];
  return mx;
}

static void resetHomeBaseline() {
  homeBase = { false, 0, 0.5f, 25.0f, 420.0f, 180000.0f, 45.0f, 1013.0f };
  homeLastPrimaryOdor = ODOR_COUNT;
  homePrimaryHoldCount = 0;
  calState.homeBaseDirty = false;
}

static bool homeBaseLooksValid(const HomeOdorBaseline &base) {
  return isfinite(base.voc) && isfinite(base.iaq) && isfinite(base.co2) &&
         isfinite(base.gasR) && isfinite(base.hum) && isfinite(base.pressHpa) &&
         base.voc >= 0.2f && base.voc <= 15.0f &&
         base.iaq >= 0.0f && base.iaq <= 500.0f &&
         base.co2 >= 350.0f && base.co2 <= 5000.0f &&
         base.gasR >= 1000.0f && base.gasR <= 2000000.0f &&
         base.hum >= 0.0f && base.hum <= 100.0f &&
         base.pressHpa >= 850.0f && base.pressHpa <= 1085.0f &&
         (!base.ready || base.calmSamples >= HOME_BASELINE_MIN_SAMPLES);
}

static bool bsecPhysicallySettled(float stabStatus, float runInStatus) {
  return stabStatus >= 1.0f || runInStatus >= 1.0f;
}

static void updateCalibrationRuntimeState(uint8_t iaqAcc, float stabStatus, float runInStatus) {
  const bool readySample = (iaqAcc >= ODOR_RUNTIME_ACC_MIN) &&
                           (bsecPhysicallySettled(stabStatus, runInStatus) ||
                            calState.bsecStateLoaded);
  if (readySample) {
    if (calState.stableSamples < 255) calState.stableSamples++;
  } else {
    calState.stableSamples = 0;
  }

  const bool wasReady = calState.bsecReady;
  calState.bsecReady = calState.stableSamples >= CAL_READY_SAMPLES;

  if (calState.lastIaqAcc != iaqAcc) {
    Serial.printf("[CAL] IAQ accuracy %u -> %u (stab=%.0f runin=%.0f base=%s)\n",
                  calState.lastIaqAcc == 0xFF ? 0 : calState.lastIaqAcc,
                  iaqAcc, stabStatus, runInStatus,
                  homeBase.ready ? "ready" : "learning");
    calState.lastIaqAcc = iaqAcc;
  }

  if (!wasReady && calState.bsecReady) {
    Serial.printf("[CAL] Runtime ready (%s)%s\n",
                  calState.bsecStateLoaded ? "restored state" : "fresh calibration",
                  homeBase.ready ? " + home baseline" : ", learning room baseline");
  }
}

static bool bsecCalibrationReady(uint8_t iaqAcc) {
  return iaqAcc >= ODOR_RUNTIME_ACC_MIN && calState.bsecReady;
}

static bool fullCalibrationReady(uint8_t iaqAcc) {
  return bsecCalibrationReady(iaqAcc) && homeBase.ready;
}

static const char* calibrationStatusText(uint8_t iaqAcc, float stabStatus, float runInStatus) {
  if (fullCalibrationReady(iaqAcc)) return "Ready";
  if (bsecCalibrationReady(iaqAcc)) return "Learning room baseline";
  if (iaqAcc >= ODOR_RUNTIME_ACC_MIN &&
      (bsecPhysicallySettled(stabStatus, runInStatus) || calState.bsecStateLoaded))
    return "Finalizing sensor";
  if (calState.bsecStateLoaded) return "Restoring calibration";
  if (runInStatus >= 1.0f) return "Finishing run-in";
  if (iaqAcc >= 1) return "Calibrating sensor";
  return "Warming sensor";
}

static const char* calibrationBadgeText(uint8_t iaqAcc, float stabStatus, float runInStatus) {
  if (fullCalibrationReady(iaqAcc)) return nullptr;
  if (bsecCalibrationReady(iaqAcc)) return "BASE";
  if (calState.bsecStateLoaded) return "REST";
  if (iaqAcc == 0 && !calState.bsecStateLoaded && !bsecPhysicallySettled(stabStatus, runInStatus))
    return "WARM";
  return "~CAL";
}

// ══════════════════════════════════════════════════════════════
// Section 14b-1: Home baseline learning & expanded odor derivation
// ══════════════════════════════════════════════════════════════

static void updateHomeBaseline(float voc, float iaq, float co2, float gasR,
                               float hum, float pressHpa, uint8_t iaqAcc,
                               float dVocAbs, const uint8_t scores[ODOR_COUNT]) {
  if (!bsecCalibrationReady(iaqAcc)) return;

  const uint8_t peak = maxOdorScore(scores);
  const bool calm = (dVocAbs < HOME_BASELINE_CALM_DVOC &&
                     voc < 3.0f &&
                     iaq < 120.0f &&
                     peak < ODOR_MIN_CONF &&
                     gasR > 10000.0f);
  if (!calm) return;

  if (homeBase.calmSamples == 0 && !homeBase.ready) {
    homeBase.voc      = max(voc, 0.3f);
    homeBase.iaq      = iaq;
    homeBase.co2      = max(co2, 400.0f);
    homeBase.gasR     = gasR;
    homeBase.hum      = hum;
    homeBase.pressHpa = pressHpa;
  } else {
    const float alpha = homeBase.ready ? 0.03f : HOME_BASELINE_ALPHA;
    homeBase.voc      += (voc - homeBase.voc) * alpha;
    homeBase.iaq      += (iaq - homeBase.iaq) * alpha;
    homeBase.co2      += (co2 - homeBase.co2) * alpha;
    homeBase.gasR     += (gasR - homeBase.gasR) * alpha;
    homeBase.hum      += (hum - homeBase.hum) * alpha;
    homeBase.pressHpa += (pressHpa - homeBase.pressHpa) * alpha;
  }

  const bool wasReady = homeBase.ready;
  if (homeBase.calmSamples < 65535) homeBase.calmSamples++;
  if (homeBase.calmSamples >= HOME_BASELINE_MIN_SAMPLES) homeBase.ready = true;

  if (!wasReady && homeBase.ready) {
    calState.homeBaseDirty = true;
    Serial.printf("[CAL] Home baseline ready (%u calm samples)\n", homeBase.calmSamples);
  }
}

static void applyHomeMlTuning(uint8_t scores[ODOR_COUNT], float voc, float iaq,
                              float co2, float gasR, float dVocRise,
                              float hum, uint8_t iaqAcc) {
  if (!bsecCalibrationReady(iaqAcc)) {
    for (uint8_t i = 0; i < ODOR_COUNT; i++) {
      scores[i] = (scores[i] >= ODOR_STRONG_CONF)
                ? (uint8_t)(scores[i] * 0.75f)
                : (uint8_t)(scores[i] * 0.35f);
    }
    return;
  }

  const float baseVoc  = homeBase.ready ? homeBase.voc  : 0.5f;
  const float baseIaq  = homeBase.ready ? homeBase.iaq  : 25.0f;
  const float baseCo2  = homeBase.ready ? homeBase.co2  : 420.0f;
  const float baseGasR = homeBase.ready ? homeBase.gasR : 180000.0f;

  const float vocRise = fmaxf(0.0f, voc - baseVoc);
  const float iaqRise = fmaxf(0.0f, iaq - baseIaq);
  const float co2Rise = fmaxf(0.0f, co2 - baseCo2);
  const float gasDrop = (baseGasR > 1000.0f)
                      ? fmaxf(0.0f, (baseGasR - gasR) / baseGasR)
                      : 0.0f;

  const bool nearBaseline = (vocRise < HOME_EVENT_MIN_VOC_RISE &&
                             iaqRise < 15.0f &&
                             dVocRise < 0.20f &&
                             gasDrop < 0.08f);
  const bool meaningfulEvent = (vocRise >= HOME_EVENT_MIN_VOC_RISE ||
                                iaqRise >= 20.0f ||
                                dVocRise >= 0.4f ||
                                gasDrop >= HOME_EVENT_MIN_GAS_DROP);

  if (nearBaseline) {
    for (uint8_t i = 0; i < ODOR_COUNT; i++)
      scores[i] = (scores[i] >= ODOR_STRONG_CONF) ? (uint8_t)(scores[i] * 0.4f) : 0;
    return;
  }

  if (!meaningfulEvent) {
    for (uint8_t i = 0; i < ODOR_COUNT; i++)
      if (scores[i] < ODOR_STRONG_CONF) scores[i] = (uint8_t)(scores[i] * 0.4f);
  }

  if (homeBase.ready && vocRise < 0.6f && gasDrop < 0.10f) {
    scores[0]  = (uint8_t)(scores[0]  * 0.5f);
    scores[2]  = (uint8_t)(scores[2]  * 0.5f);
    scores[6]  = (uint8_t)(scores[6]  * 0.35f);
    scores[7]  = (uint8_t)(scores[7]  * 0.35f);
    scores[10] = (uint8_t)(scores[10] * 0.5f);
  }

  if (homeBase.ready && co2Rise > 150.0f && vocRise > 0.4f &&
      vocRise < 8.0f && gasDrop < 0.35f) {
    scores[8]  = constrain(scores[8]  + 8, 0, 100);
    scores[11] = constrain(scores[11] + 6, 0, 100);
    if (voc < 4.0f) scores[9] = constrain(scores[9] + 4, 0, 100);
  }

  if (homeBase.ready && gasDrop > 0.18f && vocRise > 0.8f) {
    scores[0]  = constrain(scores[0]  + 6, 0, 100);
    scores[3]  = constrain(scores[3]  + 6, 0, 100);
    scores[5]  = constrain(scores[5]  + 6, 0, 100);
    scores[10] = constrain(scores[10] + 6, 0, 100);
  }

  if (hum < 40.0f) scores[1] = (uint8_t)(scores[1] * 0.6f);

  for (uint8_t i = 0; i < ODOR_COUNT; i++) {
    if (scores[i] < 5) scores[i] = 0;
    else scores[i] = constrain(scores[i], 0, 100);
  }
}

static void deriveExpandedOdors(uint8_t scores[ODOR_COUNT], float voc, float iaq,
                                float co2, float gasR, float dVocRise,
                                float hum, uint8_t iaqAcc) {
  for (uint8_t i = BASE_ODOR_COUNT; i < ODOR_COUNT; i++) scores[i] = 0;

  const float gasRk = gasR / 1000.0f;
  const float iaqVocR = iaq / fmaxf(voc, 1.0f);
  const float vocIaqR = voc / fmaxf(iaq, 1.0f);

  int perfume = (int)(scores[OD_ALCOHOL] * 0.45f + scores[OD_CLEANING] * 0.30f +
                      scores[OD_WEED] * 0.20f);
  if (voc > 1.0f && voc < 9.0f && gasRk > 70.0f && co2 < 900.0f) perfume += 12;
  if (iaq < 160.0f && dVocRise < 2.5f) perfume += 8;
  if (scores[OD_SMOKE] > 20 || scores[OD_GASOLINE] > 20) perfume -= 20;
  scores[OD_PERFUME] = constrain(perfume, 0, 100);

  int laundry = (int)(scores[OD_CLEANING] * 0.60f + scores[OD_PERFUME] * 0.35f);
  if (gasRk > 100.0f && voc < 7.0f && iaqVocR > 1.0f) laundry += 12;
  if (hum < 70.0f && co2 < 900.0f) laundry += 6;
  if (scores[OD_SMOKE] > 15 || scores[OD_GASOLINE] > 15) laundry -= 15;
  scores[OD_LAUNDRY] = constrain(laundry, 0, 100);

  int sulfur = (int)(scores[OD_FART] * 0.55f + scores[OD_GARBAGE] * 0.45f);
  if (iaqVocR > 1.3f && gasRk < 120.0f) sulfur += 18;
  if (co2 < 800.0f && voc > 1.5f) sulfur += 8;
  if (scores[OD_CLEANING] > 25) sulfur -= 10;
  scores[OD_SULFUR] = constrain(sulfur, 0, 100);

  int solvent = (int)(scores[OD_GASOLINE] * 0.45f + scores[OD_ALCOHOL] * 0.30f +
                      scores[OD_CLEANING] * 0.30f);
  if (voc > 4.0f && iaqVocR < 1.0f) solvent += 15;
  if (vocIaqR > 0.04f && gasRk > 30.0f) solvent += 8;
  if (scores[OD_GARBAGE] > 20 || scores[OD_FART] > 20) solvent -= 12;
  scores[OD_SOLVENT] = constrain(solvent, 0, 100);

  int pet = (int)(scores[OD_GARBAGE] * 0.40f + scores[OD_SWEAT] * 0.35f +
                  scores[OD_FART] * 0.20f);
  if (co2 > 500.0f && co2 < 1400.0f && dVocRise < 1.5f) pet += 10;
  if (gasRk < 180.0f && iaqVocR > 1.0f) pet += 10;
  if (scores[OD_CLEANING] > 25) pet -= 8;
  scores[OD_PET] = constrain(pet, 0, 100);

  int sour = (int)(scores[OD_GARBAGE] * 0.35f + scores[OD_ALCOHOL] * 0.35f +
                   scores[OD_MUSTY] * 0.20f);
  if (voc > 1.5f && voc < 8.0f && dVocRise < 1.2f) sour += 12;
  if (co2 < 900.0f && gasRk < 170.0f) sour += 8;
  if (scores[OD_SMOKE] > 20) sour -= 12;
  scores[OD_SOUR] = constrain(sour, 0, 100);

  int burnt = (int)(scores[OD_COOKING] * 0.45f + scores[OD_SMOKE] * 0.40f);
  if (voc > 3.0f && dVocRise > 0.3f) burnt += 10;
  if (gasRk < 110.0f || iaq > 120.0f) burnt += 8;
  if (scores[OD_COFFEE] > 20) burnt -= 8;
  scores[OD_BURNT] = constrain(burnt, 0, 100);

  int citrus = (int)(scores[OD_PERFUME] * 0.35f + scores[OD_CLEANING] * 0.25f +
                     scores[OD_COFFEE] * 0.15f);
  if (voc > 0.8f && voc < 5.0f && gasRk > 100.0f && iaq < 120.0f) citrus += 14;
  if (co2 < 800.0f && hum < 65.0f) citrus += 6;
  if (scores[OD_SMOKE] > 15 || scores[OD_GARBAGE] > 20) citrus -= 12;
  scores[OD_CITRUS] = constrain(citrus, 0, 100);

  if (!bsecCalibrationReady(iaqAcc)) {
    for (uint8_t i = BASE_ODOR_COUNT; i < ODOR_COUNT; i++)
      scores[i] = (scores[i] >= ODOR_STRONG_CONF)
                ? (uint8_t)(scores[i] * 0.7f)
                : (uint8_t)(scores[i] * 0.4f);
  }
}

static void stabilizePrimaryOdor(uint8_t scores[ODOR_COUNT], uint8_t iaqAcc) {
  uint8_t i1, i2;
  topTwo(scores, i1, i2);
  const uint8_t top  = scores[i1];
  const uint8_t next = scores[i2];

  if (top < ODOR_MIN_CONF) {
    homeLastPrimaryOdor = ODOR_COUNT;
    homePrimaryHoldCount = 0;
    return;
  }

  const bool immediate = top >= ODOR_STRONG_CONF;
  const bool clearWinner = top >= (uint8_t)(next + 8);

  if (!bsecCalibrationReady(iaqAcc) || !clearWinner) {
    if (!immediate && scores[i1] >= ODOR_MIN_CONF) scores[i1] = ODOR_MIN_CONF - 1;
    if (!clearWinner) {
      homeLastPrimaryOdor = ODOR_COUNT;
      homePrimaryHoldCount = 0;
    }
    return;
  }

  if (i1 == homeLastPrimaryOdor) {
    if (homePrimaryHoldCount < 255) homePrimaryHoldCount++;
  } else {
    homeLastPrimaryOdor = i1;
    homePrimaryHoldCount = 1;
  }

  if (!immediate && homePrimaryHoldCount < 2)
    scores[i1] = ODOR_MIN_CONF - 1;
}

// ══════════════════════════════════════════════════════════════
// Section 14b: Post-scoring cross-correlation
//   correctOdorScores — resolves ambiguities using multi-sensor
//   reasoning. Runs AFTER both ML and heuristic scoring.
// ══════════════════════════════════════════════════════════════

/**
 * correctOdorScores() — cross-correlate odor scores with sensor physics
 *
 * The BME688 MOX sensor can't directly identify molecules, so both the
 * heuristic and ML models produce false positives when different odor
 * sources share similar VOC/IAQ profiles. This function uses the
 * RELATIONSHIPS between readings to resolve ambiguities.
 *
 * Key physics exploited:
 *   1. Gas resistance (gasR) drops sharply for reducing gases (H2S, NH3,
 *      alcohols) but less for oxidizing VOCs (aldehydes from cooking).
 *      Low gasR + high IAQ = biological decay or chemical, not cooking.
 *   2. IAQ-to-VOC ratio distinguishes sulfur/ammonia compounds (high IAQ
 *      relative to VOC because BSEC2 weights them heavily) from organic
 *      volatiles (VOC rises proportionally with IAQ).
 *   3. CO2 correlation: cooking and human presence raise CO2; chemical
 *      sources, garbage, and diapers do NOT raise CO2 significantly.
 *   4. Rate of change (dVoc): sudden spikes = fart/spray; sustained
 *      elevation = garbage/diaper/musty; slow rise = cooking/BO.
 *   5. Temperature: cooking raises ambient temp; garbage/diaper does not.
 *
 * Categories:
 *   0:Fart  1:Musty  2:Cigarette  3:Alcohol  4:Weed  5:Cleaning
 *   6:Gasoline  7:Smoke  8:Cooking  9:Coffee  10:Garbage  11:Sweat/BO
 */
void correctOdorScores(uint8_t scores[ODOR_COUNT], float voc, float iaq,
                       float co2, float gasR, float dVoc, float tempF,
                       float hum, float compGas) {
  const float iaqVocR = iaq / fmaxf(voc, 1.0f);
  const float gasRk   = gasR / 1000.0f;

  // ── Rule 1: Biological decay vs. cooking disambiguation ─────────────────
  // Biological sources (fart, garbage, BO) depress gasR while cooking
  // volatiles (aldehydes, terpenes) cause milder gasR drops.
  // BSEC2 scale: gasR <150k with elevated IAQ:VOC = biological.
  bool bioDecay = (gasRk < 150.0f && iaqVocR > 1.2f && iaq > 40.0f);
  bool strongBioDecay = (gasRk < 80.0f && iaqVocR > 1.5f && iaq > 80.0f);

  if (bioDecay) {
    scores[0]  = constrain(scores[0]  + 15, 0, 100);  // Fart
    scores[10] = constrain(scores[10] + 15, 0, 100);  // Garbage
    scores[8]  = (uint8_t)(scores[8]  * 0.6f);        // Suppress cooking
    scores[9]  = (uint8_t)(scores[9]  * 0.7f);        // Suppress coffee
  }
  if (strongBioDecay) {
    scores[0]  = constrain(scores[0]  + 15, 0, 100);
    scores[10] = constrain(scores[10] + 15, 0, 100);
    scores[8]  = (uint8_t)(scores[8]  * 0.3f);        // Hard suppress cooking
    scores[9]  = (uint8_t)(scores[9]  * 0.3f);        // Hard suppress coffee
    scores[11] = constrain(scores[11] + 10, 0, 100);  // BO also likely
  }

  // ── Rule 2: Cooking requires CO2 correlation ────────────────────────────
  if (co2 < 500.0f && scores[8] > 15) {
    scores[8] = (uint8_t)(scores[8] * 0.5f);
  }
  if (co2 > 600.0f && voc > 2.0f && voc < 12.0f && gasRk > 60.0f) {
    scores[8] = constrain(scores[8] + 10, 0, 100);
  }

  // ── Rule 3: Fart vs. garbage — timing discrimination ────────────────────
  // Farts = sudden spike (high dVoc) and fade. Garbage = sustained.
  if (dVoc < 0.3f && voc > 3.0f && iaq > 50.0f) {
    // Sustained source → shift from fart to garbage
    if (scores[0] > scores[10]) {
      int shift = min((int)(scores[0] * 0.3f), 20);
      scores[0]  = constrain(scores[0]  - shift, 0, 100);
      scores[10] = constrain(scores[10] + shift, 0, 100);
    }
  }
  // Rapid dVoc spike = fart, not garbage
  if (dVoc > 2.0f && voc > 2.0f) {
    scores[0]  = constrain(scores[0]  + 15, 0, 100);
    scores[10] = constrain(scores[10] - 10, 0, 100);
  }

  // ── Rule 4: Chemical vs. organic — gasR pattern ─────────────────────────
  // Solvents produce high VOC:IAQ ratio with gasR staying moderate.
  if (voc > 5.0f && iaqVocR < 0.8f && gasRk > 50.0f) {
    scores[5]  = constrain(scores[5]  + 10, 0, 100);  // Cleaning
    scores[3]  = constrain(scores[3]  + 10, 0, 100);  // Alcohol
    scores[0]  = constrain(scores[0]  - 10, 0, 100);  // Not fart
    scores[10] = constrain(scores[10] - 10, 0, 100);  // Not garbage
  }

  // ── Rule 5: Smoke requires VERY high readings ──────────────────────────
  if (iaq < 150.0f && voc < 10.0f) {
    scores[7] = (uint8_t)(scores[7] * 0.3f);          // Strongly suppress smoke
  }
  if (iaq < 100.0f) {
    scores[2] = (uint8_t)(scores[2] * 0.5f);          // Suppress cigarette
  }

  // ── Rule 6: Coffee needs low-to-moderate readings ──────────────────────
  if (iaq > 100.0f) {
    scores[9] = (uint8_t)(scores[9] * 0.5f);          // Too much for just coffee
  }

  // ── Rule 7: Humidity correlation for musty ─────────────────────────────
  if (hum < 45.0f) {
    scores[1] = (uint8_t)(scores[1] * 0.5f);
  }
  if (hum > 60.0f && iaq > 40.0f) {
    scores[1] = constrain(scores[1] + 10, 0, 100);
  }

  // ── Rule 8: Suppress all odors when air is actually clean ──────────────
  // IAQ < 20, VOC baseline, gasR high = genuinely clean — zero everything.
  if (iaq < 20.0f && voc < 0.5f && gasRk > 250.0f) {
    for (int i = 0; i < ODOR_COUNT; i++) scores[i] = 0;
  }

  // Final clamp
  for (int i = 0; i < ODOR_COUNT; i++)
    scores[i] = constrain(scores[i], 0, 100);
}

// ══════════════════════════════════════════════════════════════
// Section 15: Odor Classification
//   scoreOdors (both ML and heuristic), SMELL_SENTENCES
// ══════════════════════════════════════════════════════════════

#ifndef USE_ML_SCORING
// ── BSEC2-calibrated heuristic odor scoring ─────────────────────────────────
// BSEC2 breath_voc_equivalent output ranges (real-world observations):
//   Clean air:     0.3–0.8 ppm    IAQ 0–50      gasR 200–500k
//   Someone near:  0.8–2.0 ppm    IAQ 50–100    gasR 150–300k
//   Mild cooking:  1.5–5.0 ppm    IAQ 80–180    gasR 80–200k
//   Fart event:    2.0–10.0 ppm   IAQ 80–200    gasR 80–200k  (rapid dVoc)
//   Strong fart:   5.0–20.0 ppm   IAQ 120–300   gasR 40–120k  (rapid dVoc)
//   Cooking:       2.0–8.0 ppm    IAQ 80–200    gasR 60–200k  (gradual, CO2 rise)
//   Cleaning:      3.0–15.0 ppm   IAQ 100–300   gasR stays high (oxidizers)
//   Cigarette:     5.0–25.0 ppm   IAQ 150–350   gasR moderate  (sustained)
//   Smoke/fire:    15.0–100+ ppm  IAQ 300–500   gasR crashes   (extreme)
//
// dVoc (delta of smoothed VOC between samples) — with SMOOTH_WINDOW=3:
//   Normal drift:  < 0.3 ppm
//   Mild event:    0.3–1.5 ppm
//   Sudden event:  1.5–5.0 ppm  (fart, spray, cooking burst)
//   Major event:   5.0+ ppm     (smoke, chemical spill)

void scoreOdors(float voc, float iaq, float co2, float dVoc, float gasR,
                uint8_t scores[ODOR_COUNT]) {
  for (uint8_t i = 0; i < ODOR_COUNT; i++) scores[i] = 0;
  const float iaqVocRatio = iaq / fmaxf(voc, 0.1f);
  const float vocIaqRatio = voc / fmaxf(iaq, 1.0f);
  const float gasRk = gasR / 1000.0f;

  // 0: Fart — sudden sulfur/ammonia spike, gasR drops, rapid onset
  //    Key signature: fast dVoc + gasR depression + IAQ:VOC ratio elevated
  if (dVoc > 1.0f)                                    scores[0] += 15; // mild spike
  if (dVoc > 3.0f)                                    scores[0] += 20; // real spike
  if (dVoc > 6.0f)                                    scores[0] += 15; // big spike
  if (iaqVocRatio > 1.3f && voc > 2.0f)              scores[0] += 25; // bio pattern
  if (voc > 2.0f && voc < 25.0f)                     scores[0] += 10; // in fart VOC range
  if (gasRk < 150.0f && iaq > 40.0f)                 scores[0] += 15; // gasR depressed
  if (dVoc > 1.0f && gasRk < 200.0f)                 scores[0] += 10; // spike + low gasR

  // 1: Musty — low-moderate, sustained, humidity-correlated
  if (voc > 1.0f && voc < 8.0f && dVoc < 0.5f)       scores[1] += 30;
  if (iaq > 25.0f && iaq < 120.0f && dVoc < 0.5f)    scores[1] += 25;
  if (voc > 1.5f && voc < 6.0f)                       scores[1] += 15;

  // 2: Cigarette — high sustained VOC, moderate gasR
  if (voc > 5.0f)  scores[2] += constrain((int)((voc - 5.0f) * 2.5f), 0, 25);
  if (iaq > 120.0f) scores[2] += constrain((int)((iaq - 120.0f) / 6.0f), 0, 30);
  if (co2 > 700.0f) scores[2] += constrain((int)((co2 - 700.0f) / 20.0f), 0, 20);
  if (voc > 5.0f && dVoc < 2.0f)  scores[2] += 10;   // sustained, not spiking

  // 3: Alcohol — VOC high relative to IAQ (strong reducer, not sulfur)
  if (voc > 4.0f && vocIaqRatio > 0.85f)              scores[3] += 35;
  if (dVoc > 1.0f && dVoc < 5.0f && voc > 3.0f)      scores[3] += 20;
  if (voc > 6.0f && iaq < 180.0f)                    scores[3] += 20;
  if (voc > 3.0f && vocIaqRatio > 1.0f)              scores[3] += 10;

  // 4: Weed — moderate VOC, terpene profile (gasR moderate, not crashed)
  if (voc > 4.0f && voc < 20.0f) scores[4] += constrain((int)((voc - 4.0f) * 1.6f), 0, 25);
  if (iaq > 60.0f && iaq < 250.0f) scores[4] += constrain((int)((iaq - 60.0f) / 6.0f), 0, 25);
  if (dVoc > 0.8f && dVoc < 4.0f)  scores[4] += 18;
  if (gasRk > 30.0f && gasRk < 180.0f && voc > 4.0f) scores[4] += 12;

  // 5: Cleaning — IAQ disproportionately high relative to VOC (oxidizers)
  if (iaqVocRatio > 2.0f && voc > 2.0f)               scores[5] += 35;
  if (iaq > 150.0f && voc < 15.0f)                   scores[5] += 25;
  if (dVoc > 1.0f && iaq > 100.0f)                   scores[5] += 20;
  if (gasRk > 50.0f && iaq > 100.0f)                 scores[5] += 10;

  // 6: Gasoline — extreme VOC, gasR crashes hard
  if (voc > 15.0f) scores[6] += constrain((int)((voc - 15.0f) * 2.0f), 0, 35);
  if (dVoc > 3.0f && voc > 10.0f)                    scores[6] += 25;
  if (gasRk < 20.0f && voc > 10.0f)                  scores[6] += 20;

  // 7: Smoke — extreme readings across the board
  if (voc > 15.0f) scores[7] += constrain((int)((voc - 15.0f) * 1.5f), 0, 30);
  if (iaq > 250.0f) scores[7] += constrain((int)((iaq - 250.0f) / 5.0f), 0, 30);
  if (co2 > 1200.0f) scores[7] += constrain((int)((co2 - 1200.0f) / 15.0f), 0, 25);
  if (dVoc > 3.0f && voc > 12.0f) scores[7] += 15;

  // 8: Cooking — moderate VOC, CO2 correlates (people breathing + combustion),
  //    gasR NOT crashed, gradual rise
  if (voc > 2.0f && voc < 12.0f && dVoc < 3.0f && gasRk > 60.0f) scores[8] += 20;
  if (iaq > 40.0f && iaq < 200.0f && co2 > 500.0f)               scores[8] += 20;
  if (co2 > 550.0f && co2 < 1200.0f)                              scores[8] += 15;
  if (dVoc > 0.3f && dVoc < 2.0f && voc > 2.0f && gasRk > 60.0f) scores[8] += 15;
  if (iaqVocRatio > 0.6f && iaqVocRatio < 1.5f && voc > 2.0f)    scores[8] += 10;

  // 9: Coffee — mild, pleasant, moderate readings, gasR stays relatively high
  if (voc > 1.5f && voc < 6.0f && gasRk > 80.0f)                  scores[9] += 25;
  if (iaq > 20.0f && iaq < 100.0f)                                scores[9] += 20;
  if (co2 > 420.0f && co2 < 700.0f)                               scores[9] += 15;
  if (dVoc < 1.5f && voc > 1.2f)                                  scores[9] += 15;
  if (vocIaqRatio > 0.5f && vocIaqRatio < 1.5f && voc < 6.0f)     scores[9] += 10;

  // 10: Garbage — sustained biological decay, high IAQ:VOC, depressed gasR
  if (iaqVocRatio > 1.2f && voc > 3.0f)                           scores[10] += 25;
  if (voc > 3.0f && voc < 20.0f && dVoc < 1.0f)                   scores[10] += 20;
  if (iaq > 80.0f && dVoc < 0.8f)                                 scores[10] += 15;
  if (gasRk < 150.0f && iaq > 50.0f && dVoc < 1.5f)               scores[10] += 20;
  if (co2 < 550.0f && iaq > 60.0f)                                scores[10] += 10;

  // 11: Sweat/BO — moderate, sustained, human-correlated (elevated CO2)
  if (voc > 1.5f && voc < 8.0f && dVoc < 0.5f)                    scores[11] += 25;
  if (iaq > 30.0f && iaq < 120.0f && dVoc < 0.5f)                 scores[11] += 20;
  if (iaqVocRatio > 1.0f && iaqVocRatio < 3.0f && voc < 8.0f)     scores[11] += 15;
  if (co2 > 600.0f && voc > 1.5f && voc < 6.0f)                   scores[11] += 15;
  if (gasRk < 200.0f && gasRk > 30.0f && iaq > 40.0f)             scores[11] += 10;

  for (uint8_t i = 0; i < ODOR_COUNT; i++)
    scores[i] = constrain(scores[i], 0, 100);
}
#endif // !USE_ML_SCORING

// ── Smell sentences [21][3]: odor(0-19)+cleanAir(20) x scoreTier(low/med/high)
// Air Score tiers: low=0-40, med=41-69, high=70+
// Each \n-separated line must be <=21 chars (size-1 font, 128px wide)
static const char* const SMELL_SENTENCES[ODOR_COUNT + 1][3] = {
  { // 0 Fart
    "Crop-dusted zone.\nSilent but deadly.\nYou were warned.",
    "BIOLOGICAL EVENT.\nEvacuate politely.\nBring nose plugs.",
    "DEFCON 1 GAS ALERT!\nThis is a war crime.\nCall EPA. Now."
  },
  { // 1 Musty
    "Earthy vintage air.\nOld wizard vibes.\nUnwashed robes.",
    "Mold confirmed.\n1987 wants its air\nback. Very gross.",
    "Full swamp dungeon.\nSomething damp died\nand just stayed."
  },
  { // 2 Cigarette
    "Faint smoke nearby.\nSomeone is 'outside'.\nSure they are.",
    "Classic bar air.\nJacket is ruined.\nRIP your deposit.",
    "Marlboro 400 in here.\nLungs filed lawsuit.\nOpen a window."
  },
  { // 3 Alcohol
    "Light ethanol vibe.\nSocially acceptable.\nFor now.",
    "Party confirmed.\nAlcohol everywhere.\nGoodnight, all.",
    "95 proof air.\nCombustible. Beware.\nDon't breathe. Wink?"
  },
  { // 4 Weed
    "Terpene drift noted.\nNeighbors are chill.\nSolidarity.",
    "Dank and present.\nSnack supply: low.\nTime: irrelevant.",
    "HEAVY terpene load.\nYou are basically\nhotboxed. Walk on."
  },
  { // 5 Cleaning
    "Fresh cleaner scent.\nSomething got cleaned\nor covered up.",
    "Aggressive bleach.\nA crime scene being\nwiped. Probably.",
    "Full chem assault.\nWho are you hiding?\nHazmat required."
  },
  { // 6 Gasoline
    "Hydrocarbons noted.\nNear a car or just\na bad decision.",
    "BTX levels rising.\nDon't light a match.\nI mean it. Don't.",
    "EVACUATE NOW.\nSpill or villain's\nlair. Your call."
  },
  { // 7 Smoke
    "Smoke detected.\nBBQ or disaster?\nProbably fine.",
    "Something's burning.\nHopefully on purpose.\nCheck oven. Now.",
    "FIRE RISK DETECTED.\nLeave. Call 911.\nNot the aesthetic."
  },
  { // 8 Cooking
    "Something's cooking.\nSmells intentional.\nMaybe edible?",
    "Full kitchen mode.\nGarlic and ambition.\nYou've got this.",
    "Peak cooking chaos.\nSmoke alarm incoming.\nYou tried. Bless."
  },
  { // 9 Coffee
    "Gentle coffee waft.\nCivilization found.\nAll is right.",
    "Strong brew detected.\nProductivity: soon.\nOr just the vibe.",
    "ESPRESSO OVERLOAD.\nHeart rate: jazz\ndrum solo. Send help."
  },
  { // 10 Garbage
    "Mild organic decay.\nTake the trash out.\nThis week. Please.",
    "Active decomp.\nBin contents made\na personal choice.",
    "BIOHAZARD BIN.\nPublic health crisis.\nEvacuate the area."
  },
  { // 11 Sweat/BO
    "Human musk noted.\nYou worked hard.\nShower exists. Go.",
    "Gym locker level.\nDeodorant: aisle 5.\nTime's ticking. Go.",
    "BIOLOGICAL WARFARE.\nThis is a war crime.\nShower. Please. Now."
  },
  { // 12 Perfume
    "Perfume drift.\nFancy air today.\nNo apology.",
    "Fragrance cloud.\nSomeone sprayed a lot.\nWindows maybe.",
    "Perfume bomb.\nNow the room is\none big mall."
  },
  { // 13 Laundry
    "Laundry fresh vibe.\nClean towel energy.\nPretty harmless.",
    "Detergent air.\nFresh but obvious.\nMaybe dryer day.",
    "Laundry blast.\nDetergent took over.\nEase off a bit."
  },
  { // 14 Sulfur
    "Sulfur note found.\nEggy vibes only.\nCheck it soon.",
    "Sulfur hit.\nSewer-like funk.\nCheck drains now.",
    "Sulfur overload.\nRotten-egg warning.\nInspect ASAP."
  },
  { // 15 Solvent
    "Solvent trace.\nPaint or glue vibe.\nKeep airflow up.",
    "Solvent air.\nPaint booth energy.\nVent the room.",
    "Solvent blast.\nHeadache territory.\nGet fresh air."
  },
  { // 16 Pet/Litter
    "Pet zone detected.\nLitter box maybe.\nNose says yes.",
    "Pet funk active.\nClean the litter.\nOpen a window.",
    "Litter emergency.\nThe pet wins this.\nScoop now."
  },
  { // 17 Sour Food
    "Sour note found.\nFridge check time.\nTrust less.",
    "Ferment vibes.\nSomething turned.\nCheck kitchen.",
    "Spoilage alert.\nThat food is done.\nAbort snack."
  },
  { // 18 Burnt/Oil
    "Oily heat note.\nPan was busy.\nCheck stove.",
    "Burnt food air.\nDinner got darker.\nVent now.",
    "Grease smoke mix.\nKitchen chaos live.\nKill heat."
  },
  { // 19 Citrus
    "Citrus drift.\nOrange peel energy.\nPretty pleasant.",
    "Bright terpene air.\nLemon-clean vibes.\nFresh but loud.",
    "Citrus blast.\nZest took over.\nVery strong."
  },
  { // 20 Clean air (no odor detected)
    "Fresh air detected.\nBreathing optional\nbut recommended.",
    "Mild ambient air.\nNothing alarming yet.\nRemain calm.",
    "Unknown funk rising.\nNo odor match found.\nTrust your nose."
  }
};

// ══════════════════════════════════════════════════════════════
// Section 16: Drawing Helpers
//   drawHeader, drawBar, drawOdorRow, drawWrappedSentence, wrapLine
// ══════════════════════════════════════════════════════════════

void drawHeader(const char* left, const char* right) {
  display.fillRect(0, 0, SCREEN_WIDTH, 10, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(2, 1);
  display.print(left);
  if (right) {
    int bx = SCREEN_WIDTH - (int)(strlen(right) * 6) - 2;
    display.setCursor(bx, 1);
    display.print(right);
  }
  display.setTextColor(SSD1306_WHITE);
}

void drawBar(int x, int y, int w, int h, uint8_t pct, bool invert) {
  uint16_t fg = invert ? SSD1306_BLACK : SSD1306_WHITE;
  int fill = map(constrain((int)pct, 0, 100), 0, 100, 0, w - 2);
  display.drawRect(x, y, w, h, fg);
  if (fill > 0) display.fillRect(x + 1, y + 1, fill, h - 2, fg);
}

void drawOdorRow(int y, char prefix, const char* name, bool lowAcc,
                 uint8_t score, bool highlight) {
  if (highlight) {
    display.fillRect(0, y - 1, SCREEN_WIDTH, 10, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
  }
  display.setCursor(0, y);
  display.print(prefix);
  display.print(name);
  if (lowAcc) display.print('?');
  const char* cw = confWord(score);
  display.setCursor(SCREEN_WIDTH - (int)(strlen(cw) * 6), y);
  display.print(cw);
  if (highlight) display.setTextColor(SSD1306_WHITE);
}

// Split text on \n and render each line starting at startY (9px line spacing)
void drawWrappedSentence(const char* text, int startY) {
  char buf[128];
  strncpy(buf, text, sizeof(buf) - 1);
  buf[sizeof(buf) - 1] = '\0';
  char* line = strtok(buf, "\n");
  int y = startY;
  while (line && y < SCREEN_HEIGHT) {
    display.setCursor(0, y);
    display.print(line);
    y += 9;
    line = strtok(nullptr, "\n");
  }
}

// Break text at word boundaries into <=21 char lines; returns new offset into text
static int wrapLine(const char* text, int offset, char* out) {
  int remaining = strlen(text + offset);
  if (remaining <= 21) {
    strcpy(out, text + offset);
    return offset + remaining;
  }
  int breakAt = 21;
  for (int i = 21; i > 0; i--) {
    if (text[offset + i] == ' ') { breakAt = i; break; }
  }
  strncpy(out, text + offset, breakAt);
  out[breakAt] = '\0';
  int next = offset + breakAt;
  if (text[next] == ' ') next++;
  return next;
}

// ══════════════════════════════════════════════════════════════
// Section 17: RGB LED
//   updateRGB
// ══════════════════════════════════════════════════════════════

void updateRGB(float iaq) {
#ifdef HAVE_RGB
  uint8_t r, g, b;
  if      (iaq <  50) { r =   0; g = 128; b =   0; }
  else if (iaq < 100) { r =  64; g = 128; b =   0; }
  else if (iaq < 150) { r = 128; g = 128; b =   0; }
  else if (iaq < 200) { r = 128; g =  64; b =   0; }
  else if (iaq < 300) { r = 128; g =   0; b =   0; }
  else                { r =  80; g =   0; b =  80; }
  rgbLed.setPixelColor(0, r, g, b);
  rgbLed.show();
#endif
}

// ══════════════════════════════════════════════════════════════
// Section 18: Melody System
//   Note arrays, MelState struct, melStart/Stop/Busy/Tick,
//   MelodyInfo pool, showNowPlaying, playStartupMelody,
//   playLongPressMelody, playOdorChangeMelody
// ══════════════════════════════════════════════════════════════

// ── Melody system ─────────────────────────────────────────────────────────────
// All note data comes from melody_library.h (MelodyLibrary namespace).
// SONGS[31] = random pool, ICONIC_JINGLES[29] = stingers, ALERTS[3] = system.

static void melStart(const int16_t* notes, const uint16_t* durs, uint8_t len, uint8_t repeats) {
  noTone(BUZZER_PIN);
  mel             = {};
  mel.notes       = notes;
  mel.durations   = durs;
  mel.len         = len;
  mel.repeatsLeft = max(repeats, (uint8_t)1);
  mel.active      = true;
  // Kick off the very first note immediately
  int ms = (int)durs[0];
  if (notes[0] == MelodyLibrary::REST) { noTone(BUZZER_PIN); mel.phaseEnd = millis() + ms; }
  else { tone(BUZZER_PIN, (unsigned)notes[0]); mel.phaseEnd = millis() + max(ms - 20, 20); }
}

static void melStop()  { noTone(BUZZER_PIN); mel.active = false; }
static bool melBusy()  { return mel.active; }
static bool jinglesEnabled() { return !jinglesMuted; }

// Call once per loop() — advances the melody one step if its phase timer has elapsed
static void melTick() {
  if (!mel.active) return;
  unsigned long now = millis();
  if (now < mel.phaseEnd) return;   // still in current phase

  if (!mel.inGap) {
    // Note play-time done — start 20 ms articulation gap
    noTone(BUZZER_PIN);
    mel.inGap    = true;
    mel.phaseEnd = now + 20;
    return;
  }
  // Gap done — advance to the next note
  mel.inGap = false;
  mel.idx++;
  if (mel.idx >= mel.len) {
    if (--mel.repeatsLeft == 0) { mel.active = false; return; }
    mel.idx = 0;   // loop back for next repeat
  }
  int ms = (int)mel.durations[mel.idx];
  if (mel.notes[mel.idx] == MelodyLibrary::REST) {
    noTone(BUZZER_PIN);
    mel.phaseEnd = now + ms;
  } else {
    tone(BUZZER_PIN, (unsigned)mel.notes[mel.idx]);
    mel.phaseEnd = now + max(ms - 20, 20);
  }
}

// ── Melody pool helpers ───────────────────────────────────────────────────────
// SONGS[31] is the random-play pool. Indices 0-19 match the original 20 songs
// exactly, so all hardcoded index references in playOdorChangeMelody() etc. are
// still correct. New songs occupy indices 20-30.
// melStartPool(idx)       — play from SONGS by index (no title display)
// melStartPoolShow(idx)   — play + show Now Playing screen
// melStartAlert(idx)      — play from ALERTS (0=calibration, 1=smoke, 2=westminster)
static void melStartPool(uint8_t idx, uint8_t repeats) {
  if (!jinglesEnabled()) return;
  const MelodyLibrary::MelodyInfo& m = MelodyLibrary::SONGS[idx];
  melStart(m.notes, m.durations, m.length, repeats);
}
static void melStartAlert(uint8_t idx, uint8_t repeats) {
  if (!jinglesEnabled() && idx != 1) return;  // keep critical smoke/gas alert audible
  const MelodyLibrary::MelodyInfo& a = MelodyLibrary::ALERTS[idx];
  melStart(a.notes, a.durations, a.length, repeats);
}

static bool playMelodyByKey(const char* key, const char* reason) {
  if (!key || !key[0]) return false;

  for (size_t i = 0; i < MelodyLibrary::SONG_COUNT; i++) {
    const MelodyLibrary::MelodyInfo& m = MelodyLibrary::SONGS[i];
    if (strcmp(m.key, key) == 0) {
      showNowPlaying((uint8_t)i, reason ? reason : "portal jukebox");
      melStart(m.notes, m.durations, m.length, m.defaultRepeats);
      return true;
    }
  }

  for (size_t i = 0; i < MelodyLibrary::JINGLE_COUNT; i++) {
    const MelodyLibrary::MelodyInfo& m = MelodyLibrary::ICONIC_JINGLES[i];
    if (strcmp(m.key, key) == 0) {
      showNowPlayingText(m.title, m.source, reason ? reason : "portal jukebox");
      melStart(m.notes, m.durations, m.length, m.defaultRepeats);
      return true;
    }
  }

  for (size_t i = 0; i < MelodyLibrary::ALERT_COUNT; i++) {
    const MelodyLibrary::MelodyInfo& m = MelodyLibrary::ALERTS[i];
    if (strcmp(m.key, key) == 0) {
      showNowPlayingText(m.title, m.source, reason ? reason : "portal jukebox");
      melStart(m.notes, m.durations, m.length, m.defaultRepeats);
      return true;
    }
  }

  Serial.printf("[AUDIO] Melody key not found: %s\n", key);
  return false;
}

static void rememberMelodyPlayback(const char* title, const char* reason) {
  snprintf(lastMelodyPlayed, sizeof(lastMelodyPlayed), "%s", (title && title[0]) ? title : "(unknown)");
  snprintf(lastMelodyReason, sizeof(lastMelodyReason), "%s", (reason && reason[0]) ? reason : "manual trigger");
  lastMelodyUptimeSec = millis() / 1000UL;
  queueMelodyChangePush();
}

void showNowPlaying(uint8_t idx, const char* reason) {
  display.clearDisplay();
  drawHeader("-- Now Playing --");
  display.setTextSize(1);
  display.setCursor(0, 14);
  display.print(MelodyLibrary::SONGS[idx].title);
  display.setCursor(0, 46);
  display.print(F("by "));
  display.print(MelodyLibrary::SONGS[idx].source);
  display.display();
  rememberMelodyPlayback(MelodyLibrary::SONGS[idx].title, reason);
  // Reset the display cycle so the Now Playing screen stays visible
  lastDisplayUpdate = millis();
  forceRedraw = false;
}

// Brief "Now Playing" for system jingles not in the melody pool
static void showNowPlayingText(const char* title, const char* artist, const char* reason) {
  display.clearDisplay();
  drawHeader("-- Now Playing --");
  display.setTextSize(1);
  display.setCursor(0, 14);
  display.print(title);
  display.setCursor(0, 46);
  display.print(F("by "));
  display.print(artist);
  display.display();
  rememberMelodyPlayback(title, reason);
  lastDisplayUpdate = millis();
  forceRedraw = false;
}

static void toggleJinglesMute() {
  jinglesMuted = !jinglesMuted;
  if (jinglesMuted && melBusy()) melStop();

  Serial.printf("[AUDIO] Jingles %s\n", jinglesMuted ? "muted" : "enabled");

  display.clearDisplay();
  drawHeader("-- Audio Mode --");
  display.setTextSize(1);
  display.setCursor(0, 18);
  display.print(jinglesMuted ? F("Jingles muted") : F("Jingles enabled"));
  display.setCursor(0, 30);
  display.print(jinglesMuted
              ? F("Alerts still sound")
              : F("Startup + room tunes on"));
  display.setCursor(0, 42);
  display.print(F("7 taps toggles this"));
  display.display();
  waitResponsive(1600UL);
  forceRedraw = true;
}

// Button guide — shown briefly at boot after the splash screen
void drawHelpScreen() {
  display.clearDisplay();
  drawHeader("-- Button Guide --");
  display.setTextSize(1);
  display.setCursor(0, 12); display.print(F("1-2 taps: next page"));
  display.setCursor(0, 20); display.print(F("3 taps:   dad joke"));
  display.setCursor(0, 28); display.print(F("4 taps:   breath test"));
  display.setCursor(0, 36); display.print(F("5 taps:   paranormal"));
  display.setCursor(0, 44); display.print(F("6 taps:   fart lab"));
  display.setCursor(0, 52); display.print(F("Hold:     launches"));
  display.setCursor(0, 60); display.print(F("2xHold: portal 7x mute"));
  display.display();
  delay(1200);
}

// Startup melody — called in setup() before the sensor starts.
// Spins the state machine in a tight loop so it blocks there (not in main loop).
void playStartupMelody() {
  if (!jinglesEnabled()) return;
  randomSeed(esp_random());
  // Pool = all 31 SONGS (indices 0-30)
  uint8_t idx = (uint8_t)random((long)MelodyLibrary::SONG_COUNT);
  showNowPlaying(idx, "startup tune");
  melStartPool(idx);
  { // Block with timeout — max 8 seconds to prevent boot hang
    unsigned long melStart = millis();
    while (melBusy() && (millis() - melStart < 8000UL)) { melTick(); delay(2); }
    if (melBusy()) { melStop(); Serial.println(F("[MELODY] Startup melody timed out")); }
  }
}

// Long-press melody — non-blocking; plays twice via repeats param.
void playLongPressMelody() {
  if (!jinglesEnabled()) return;
  uint8_t idx = (uint8_t)random((long)MelodyLibrary::SONG_COUNT);
  showNowPlaying(idx, "launch mode long press");
  melStartPool(idx, 2);
}

void playOdorChangeMelody(uint8_t oldTier, uint8_t newTier) {
  if (!jinglesEnabled()) return;
  if (newTier > oldTier) {
    if (newTier >= 5) {
      showNowPlaying(1, "odor tier worsened sharply"); melStartPool(1);   // Imperial March
    } else if (newTier - oldTier >= 2) {
      showNowPlaying(2, "odor tier worsened"); melStartPool(2);   // Under Pressure
    } else {
      showNowPlaying(9, "odor profile changed"); melStartPool(9);   // Tainted Love
    }
  } else {
    showNowPlaying(4, "air quality improved"); melStartPool(4);     // Don't Stop Believin'
  }
}

// ══════════════════════════════════════════════════════════════
// Section 19: Label Mode
//   enterLabelMode, emitLabelData
// ══════════════════════════════════════════════════════════════

void emitLabelData(float voc, float iaq, float co2, float tempF,
                   float hum, float pressurePa, float gasR, float dVoc) {
  Serial.printf(
    "SMELLNET_DATA: voc=%.2f iaq=%.2f co2=%.2f tempF=%.2f "
    "hum=%.2f hpa=%.2f gasR=%.0f dvoc=%.2f\n",
    voc, iaq, co2, tempF, hum, pressToHpa(pressurePa), gasR, dVoc
  );
}

void enterLabelMode() {
  labelModeActive = true;
  display.clearDisplay();
  drawHeader("-- LABEL MODE --");
  display.setTextSize(1);
  display.setCursor(0, 12);  display.println(F("Open collect_labels.py"));
  display.setCursor(0, 21);  display.println(F("on your computer."));
  display.setCursor(0, 30);  display.println(F("Readings -> Serial."));
  display.setCursor(0, 39);  display.println(F("Label each smell."));
  display.setCursor(0, 52);  display.println(F("Long-press to exit."));
  display.display();
  Serial.println(F("=== LABEL MODE ACTIVE ==="));
  Serial.println(F("Odors: 0=Fart 1=Musty 2=Cigarette 3=Alcohol 4=Weed"));
  Serial.println(F("       5=Cleaning 6=Gasoline 7=Smoke 8=Cooking"));
  Serial.println(F("       9=Coffee 10=Garbage 11=Sweat/BO"));
}

// ══════════════════════════════════════════════════════════════
// Section 20: Trend Tracker
//   pushTrend, getIaqTrend, getVocTrend
// ══════════════════════════════════════════════════════════════

static void pushTrend(float iaq, float voc) {
  if (millis() - lastTrendMs < TREND_INTERVAL_MS) return;
  lastTrendMs = millis();
  trendRing[trendHead] = { iaq, voc };
  trendHead = (trendHead + 1) % TREND_SAMPLES;
  if (trendFilled < TREND_SAMPLES) trendFilled++;
}

static const char* getIaqTrend() {
  if (trendFilled < 2) return "stable";
  uint8_t oldest = (trendHead - trendFilled + TREND_SAMPLES) % TREND_SAMPLES;
  uint8_t newest = (trendHead - 1 + TREND_SAMPLES) % TREND_SAMPLES;
  float delta = trendRing[newest].iaq - trendRing[oldest].iaq;
  return (delta > 12.0f) ? "rising" : (delta < -12.0f) ? "falling" : "stable";
}

static const char* getVocTrend() {
  if (trendFilled < 2) return "stable";
  uint8_t oldest = (trendHead - trendFilled + TREND_SAMPLES) % TREND_SAMPLES;
  uint8_t newest = (trendHead - 1 + TREND_SAMPLES) % TREND_SAMPLES;
  float delta = trendRing[newest].voc - trendRing[oldest].voc;
  return (delta > 4.0f) ? "rising" : (delta < -4.0f) ? "falling" : "stable";
}

// ══════════════════════════════════════════════════════════════
// Section 21: BSEC Persistence
//   loadBsecState, saveBsecState
// ══════════════════════════════════════════════════════════════

// Saves Bosch BSEC state to flash every 10 min once runtime calibration is
// trusted, immediately whenever accuracy first reaches 3, and once the learned
// room baseline becomes ready.
// The learned quiet-room baseline is persisted alongside it so odor tuning can
// resume quickly after reboot instead of relearning from scratch.

static void loadBsecState() {
  resetHomeBaseline();
  calState.bsecStateLoaded = false;
  calState.homeBaseLoaded = false;
  calState.homeBaseDirty = false;
  calState.bsecReady = false;
  calState.stableSamples = 0;
  calState.lastIaqAcc = 0xFF;

  if (!bsecPrefs.begin(BSEC_NVS_NS, /*readOnly=*/true)) {
    Serial.println(F("[BSEC] Preferences open failed — cold start"));
    return;
  }

  const size_t stateLen = bsecPrefs.getBytesLength(BSEC_NVS_KEY);
  bool skipBsecRestore = false;
#if defined(CONFIG_IDF_TARGET_ESP32C3) || defined(ARDUINO_XIAO_ESP32C3)
  skipBsecRestore = true;
#endif

  if (skipBsecRestore) {
    Serial.println(F("[BSEC] Saved state restore skipped on ESP32-C3 (stability mode)"));
  } else if (stateLen == BSEC_MAX_STATE_BLOB_SIZE) {
    uint8_t blob[BSEC_MAX_STATE_BLOB_SIZE];
    bsecPrefs.getBytes(BSEC_NVS_KEY, blob, stateLen);
    calState.bsecStateLoaded = envSensor.setState(blob);
    Serial.println(calState.bsecStateLoaded
      ? F("[BSEC] Saved state loaded — warm resume")
      : F("[BSEC] State load failed — cold start"));
  } else {
    Serial.println(F("[BSEC] No saved state — cold start"));
  }

  const size_t homeLen = bsecPrefs.getBytesLength(BSEC_HOME_KEY);
  if (homeLen == sizeof(PersistedHomeBaseline)) {
    PersistedHomeBaseline stored = {};
    bsecPrefs.getBytes(BSEC_HOME_KEY, &stored, sizeof(stored));
    if (stored.magic == HOME_BASE_MAGIC && stored.version == HOME_BASE_VER) {
      HomeOdorBaseline restored = {
        stored.ready != 0, stored.calmSamples, stored.voc, stored.iaq,
        stored.co2, stored.gasR, stored.hum, stored.pressHpa
      };
      if (homeBaseLooksValid(restored)) {
        homeBase = restored;
        calState.homeBaseLoaded = homeBase.ready;
        Serial.printf("[CAL] Restored home baseline (%u calm samples)\n",
                      homeBase.calmSamples);
      } else {
        Serial.println(F("[CAL] Saved home baseline invalid — relearning"));
        resetHomeBaseline();
      }
    } else {
      Serial.println(F("[CAL] Saved home baseline format mismatch — relearning"));
    }
  } else {
    Serial.println(F("[CAL] No saved home baseline — relearning room"));
  }

  bsecPrefs.end();
}

static bool subscribeBsecOutputs(bool allowFallback, const char* context) {
  bsecUsingLpSafeOutputs = false;
  bsecActiveSampleRate = BSEC_SAMPLE_RATE_LP;

  bool ok = envSensor.updateSubscription(sensorList, ARRAY_LEN(sensorList), BSEC_SAMPLE_RATE_LP);
  Serial.printf("[BSEC] %s full-set subscribe ok=%d status=%d sensor=%d\n",
                context ? context : "setup",
                ok ? 1 : 0,
                (int)envSensor.status,
                (int)envSensor.sensor.status);
  if (ok) return true;

  if (!allowFallback) return false;

  if ((int)envSensor.status == (int)BSEC_W_SU_SAMPLERATEMISMATCH) {
    Serial.println(F("[BSEC] LP subscription mismatch — retrying LP-safe output set"));
  } else {
    Serial.println(F("[BSEC] Full output set rejected — retrying LP-safe output set"));
  }

  ok = envSensor.updateSubscription(sensorListLpSafe, ARRAY_LEN(sensorListLpSafe), BSEC_SAMPLE_RATE_LP);
  bsecUsingLpSafeOutputs = ok;
  if (ok) {
    latestCompGas = 0.0f;
    latestGasPct = 0.0f;
  }
  Serial.printf("[BSEC] %s LP-safe subscribe ok=%d status=%d sensor=%d\n",
                context ? context : "setup",
                ok ? 1 : 0,
                (int)envSensor.status,
                (int)envSensor.sensor.status);
  if (ok) return true;

  Serial.println(F("[BSEC] LP-safe set still mismatched — retrying ULP-safe output set"));
  ok = envSensor.updateSubscription(sensorListLpSafe, ARRAY_LEN(sensorListLpSafe), BSEC_SAMPLE_RATE_ULP);
  bsecUsingLpSafeOutputs = ok;
  if (ok) {
    bsecActiveSampleRate = BSEC_SAMPLE_RATE_ULP;
    latestCompGas = 0.0f;
    latestGasPct = 0.0f;
  }
  Serial.printf("[BSEC] %s ULP-safe subscribe ok=%d status=%d sensor=%d\n",
                context ? context : "setup",
                ok ? 1 : 0,
                (int)envSensor.status,
                (int)envSensor.sensor.status);
  return ok;
}

static void safeBmeDelayUs(uint32_t periodUs, void* intfPtr) {
  (void)intfPtr;
  const uint32_t lagUs = 5000UL;
  const uint32_t start = micros();

  if (periodUs > lagUs) {
    delay((periodUs - lagUs) / 1000UL);
    while ((uint32_t)(micros() - start) < (periodUs - lagUs)) {
      delay(1);
    }
  }

  while ((uint32_t)(micros() - start) < periodUs) {
    // Fine-grain tail wait for Bosch timing without pinning the core for the
    // entire measurement window.
  }
}

static void saveBsecState() {
  uint8_t blob[BSEC_MAX_STATE_BLOB_SIZE];
  envSensor.getState(blob);
  if (!bsecPrefs.begin(BSEC_NVS_NS, /*readOnly=*/false)) {
    Serial.println(F("[BSEC] Preferences open failed — state not saved"));
    return;
  }
  bsecPrefs.putBytes(BSEC_NVS_KEY, blob, BSEC_MAX_STATE_BLOB_SIZE);

  if (homeBase.ready && homeBaseLooksValid(homeBase)) {
    PersistedHomeBaseline stored = {
      HOME_BASE_MAGIC,
      HOME_BASE_VER,
      homeBase.calmSamples,
      homeBase.ready ? 1 : 0,
      {0, 0, 0},
      homeBase.voc,
      homeBase.iaq,
      homeBase.co2,
      homeBase.gasR,
      homeBase.hum,
      homeBase.pressHpa
    };
    bsecPrefs.putBytes(BSEC_HOME_KEY, &stored, sizeof(stored));
    calState.homeBaseLoaded = true;
    calState.homeBaseDirty = false;
  }

  bsecPrefs.end();
  lastBsecSaveMs = millis();
  Serial.println(F("[BSEC] State saved to NVS"));
}

// ══════════════════════════════════════════════════════════════
// Section 22: Network Functions
//   fetchLocation, fetchWeather, fetchWeatherFacts,
//   fetchOutdoorAQI, fetchLaunches (with helpers),
//   fetchDadJoke, fetchGPTSassyMsg, sendToAdafruitIO
// ══════════════════════════════════════════════════════════════

// ── IP Geolocation (one-shot on boot) ────────────────────────────────────────
bool fetchLocation() {
  if (WiFi.status() != WL_CONNECTED) return false;
  quietBleForCloud();
  HTTPClient http;
  // Request lat, lon, city, and UTC offset (in seconds, DST-aware)
  http.begin("http://ip-api.com/json/?fields=lat,lon,city,offset");
  http.setTimeout(5000);
  int code = http.GET();
  if (code != 200) { http.end(); return false; }
  String body = http.getString();
  http.end();

  int li = body.indexOf("\"lat\":");
  if (li >= 0) deviceLat = body.substring(li + 6, body.indexOf(',', li + 6)).toFloat();

  int loi = body.indexOf("\"lon\":");
  if (loi >= 0) deviceLon = body.substring(loi + 6, body.indexOf(',', loi + 6)).toFloat();

  int ci = body.indexOf("\"city\":\"");
  if (ci >= 0) {
    ci += 8;
    int ce = body.indexOf('"', ci);
    if (ce > ci) body.substring(ci, min(ce, ci + 31)).toCharArray(deviceCity, sizeof(deviceCity));
  }

  // Parse UTC offset (seconds) — ip-api returns current offset including DST
  int oi = body.indexOf("\"offset\":");
  if (oi >= 0) {
    utcOffsetSec = body.substring(oi + 9).toInt();
    if (utcOffsetSec != 0) {
      configTime(utcOffsetSec, 0, "pool.ntp.org", "time.nist.gov");
      Serial.printf("[NTP] Timezone applied: UTC%+d (%ds)\n",
                    (int)(utcOffsetSec / 3600), (int)utcOffsetSec);
    }
  }

  locationFetched = true;
  Serial.printf("[Location] %.4f, %.4f  %s  UTC%+d\n",
                deviceLat, deviceLon, deviceCity, (int)(utcOffsetSec / 3600));
  return true;
}

bool fetchWeather() {
  if (WiFi.status() != WL_CONNECTED) return false;
  quietBleForCloud();
  HTTPClient http;
  // %25t → server receives %t, etc. (wttr.in format codes, &u = imperial)
  http.begin("http://wttr.in/?format=%25t|%25f|%25C|%25h|%25w&u");
  http.setTimeout(8000);
  int code = http.GET();
  if (code != 200) { http.end(); return false; }
  String body = http.getString();
  http.end();
  body.trim();

  // Expected: "+72F|+68F|Partly cloudy|65%|8 mph"
  int p1 = body.indexOf('|');
  if (p1 < 0) return false;
  int p2 = body.indexOf('|', p1 + 1);
  if (p2 < 0) return false;
  int p3 = body.indexOf('|', p2 + 1);
  if (p3 < 0) return false;
  int p4 = body.indexOf('|', p3 + 1);

  weather.tempF      = (int)body.substring(0, p1).toFloat();
  weather.feelsLikeF = (int)body.substring(p1 + 1, p2).toFloat();
  String cond = body.substring(p2 + 1, p3);
  cond.trim();
  strncpy(weather.condition, cond.c_str(), sizeof(weather.condition) - 1);
  weather.condition[sizeof(weather.condition) - 1] = '\0';
  weather.humidity = body.substring(p3 + 1, p4 < 0 ? (int)body.length() : p4).toInt();
  if (p4 >= 0) {
    String w = body.substring(p4 + 1);
    w.trim();
    // Parse wind direction from UTF-8 arrow + speed
    const char* dir = windDirFromArrow(w.c_str());
    strncpy(weather.windDir, dir, sizeof(weather.windDir) - 1);
    weather.windDir[sizeof(weather.windDir) - 1] = '\0';
    // Extract speed: skip arrow bytes + any spaces
    const char* sp = w.c_str();
    while (*sp && (uint8_t)*sp >= 128) sp++;
    while (*sp == ' ') sp++;
    strncpy(weather.windSpeed, sp, sizeof(weather.windSpeed) - 1);
    weather.windSpeed[sizeof(weather.windSpeed) - 1] = '\0';
  }
  weather.valid = true;
  weather.fetchTime = millis();
  return true;
}

// ── Weather facts (Death Valley temp + moon phase) ───────────────────────────
bool fetchWeatherFacts() {
  if (WiFi.status() != WL_CONNECTED) return false;
  quietBleForCloud();
  HTTPClient http;
  // Get Death Valley temperature (iconic world heat benchmark, no API key needed)
  http.begin("http://wttr.in/Death+Valley,CA?format=%25t&u");
  http.setTimeout(8000);
  int code = http.GET();
  if (code != 200) { http.end(); return false; }
  String body = http.getString();
  http.end();
  body.trim();
  facts.dvTempF = (int)body.toFloat();

  // Moon phase from local calendar time (set via NTP in setup)
  struct tm t;
  if (getLocalTime(&t)) {
    facts.moonDay = moonAge(t.tm_year + 1900, t.tm_mon + 1, t.tm_mday);
  } else {
    facts.moonDay = 0;
  }

  facts.valid = true;
  facts.fetchTime = millis();
  return true;
}

// ── Outdoor Air Quality (OpenWeatherMap Air Pollution API) ───────────────────
// Returns individual pollutant concentrations (CO, NO2, O3, SO2, PM2.5, PM10,
// NH3) plus OWM's 1-5 AQI index. Builds an advisory string with practical
// advice and likely cause of conditions (wildfire, traffic, industrial, etc).
// Requires OWM_API_KEY in secrets.h (free tier: 60 calls/min).
// Endpoint: https://api.openweathermap.org/data/2.5/air_pollution
//
// Fallback: if OWM key is not configured, uses Open-Meteo free API for basic
// AQI + PM2.5 only.
bool fetchOutdoorAQI() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (deviceLat == 0.0f && deviceLon == 0.0f) return false;
  quietBleForCloud();

  // ── Try OpenWeatherMap first (richer data) ──────────────────────────────────
  bool useOWM = (strncmp(OWM_API_KEY, "YOUR_", 5) != 0);

  if (useOWM) {
    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(5000);
    HTTPClient http;
    char url[200];
    snprintf(url, sizeof(url),
      "https://api.openweathermap.org/data/2.5/air_pollution?"
      "lat=%.4f&lon=%.4f&appid=%s",
      deviceLat, deviceLon, OWM_API_KEY);
    http.begin(client, url);
    http.setTimeout(6000);
    int code = http.GET();
    if (code == 200) {
      String body = http.getString();
      http.end();

      // Parse OWM AQI (1-5)
      int ai = body.indexOf("\"aqi\":");
      if (ai >= 0) outdoorAqi.aqi = body.substring(ai + 6, body.indexOf('}', ai)).toInt();

      // Helper lambda to extract a float field from the "components" object
      auto parseComp = [&](const char* key) -> float {
        int ki = body.indexOf(key);
        if (ki < 0) return 0.0f;
        ki += strlen(key);
        int end = body.indexOf(',', ki);
        if (end < 0) end = body.indexOf('}', ki);
        return body.substring(ki, end).toFloat();
      };

      outdoorAqi.co   = parseComp("\"co\":");
      outdoorAqi.no2  = parseComp("\"no2\":");
      outdoorAqi.o3   = parseComp("\"o3\":");
      outdoorAqi.so2  = parseComp("\"so2\":");
      outdoorAqi.pm25 = parseComp("\"pm2_5\":");
      outdoorAqi.pm10 = parseComp("\"pm10\":");
      outdoorAqi.nh3  = parseComp("\"nh3\":");

      // AQI level label (OWM uses 1-5)
      static const char* OWM_LEVELS[] = {
        "Good", "Fair", "Moderate", "Poor", "Very Poor"
      };
      int lvl = constrain(outdoorAqi.aqi, 1, 5) - 1;
      strncpy(outdoorAqi.level, OWM_LEVELS[lvl], sizeof(outdoorAqi.level) - 1);

      // ── Build advisory string with cause detection ──────────────────────────
      // Analyze pollutant ratios to infer likely source:
      //   Wildfire  : very high PM2.5 + high CO + low NO2
      //   Traffic   : high NO2 + moderate CO + moderate PM2.5
      //   Industrial: high SO2 + high PM10
      //   Ozone     : high O3 (summer/heat)
      //   Ammonia   : high NH3 (agricultural/chemical)
      char cause[40]  = "";
      char advice[80] = "";

      bool highPM    = (outdoorAqi.pm25 > 35.0f);
      bool veryHighPM = (outdoorAqi.pm25 > 55.0f);
      bool highCO    = (outdoorAqi.co > 4000.0f);
      bool highNO2   = (outdoorAqi.no2 > 40.0f);
      bool highSO2   = (outdoorAqi.so2 > 20.0f);
      bool highO3    = (outdoorAqi.o3 > 100.0f);
      bool highNH3   = (outdoorAqi.nh3 > 50.0f);
      bool highPM10  = (outdoorAqi.pm10 > 50.0f);

      // Detect cause (priority order)
      if (veryHighPM && highCO && !highNO2) {
        strcpy(cause, "Wildfire/burn nearby");
        strcpy(advice, "Close windows, run air purifier, avoid outdoors");
      } else if (highPM && highCO && highNO2) {
        strcpy(cause, "Traffic/combustion");
        strcpy(advice, "Limit outdoor exercise, keep windows closed");
      } else if (highSO2 && highPM10) {
        strcpy(cause, "Industrial emissions");
        strcpy(advice, "Stay indoors, monitor for odor");
      } else if (highO3) {
        strcpy(cause, "High ozone (heat/UV)");
        strcpy(advice, "Limit outdoor activity in afternoon heat");
      } else if (highNH3) {
        strcpy(cause, "Ammonia (agricultural)");
        strcpy(advice, "Close windows if strong odor detected");
      } else if (highPM && !highCO) {
        strcpy(cause, "Dust/particulate");
        strcpy(advice, "Sensitive groups limit outdoor time");
      } else if (outdoorAqi.aqi >= 4) {
        strcpy(cause, "Multiple pollutants");
        strcpy(advice, "Stay indoors, reduce ventilation");
      } else if (outdoorAqi.aqi <= 2) {
        strcpy(cause, "All clear");
        strcpy(advice, "Great day for open windows");
      } else {
        strcpy(cause, "Mild pollution");
        strcpy(advice, "OK for most, sensitive groups cautious");
      }

      // Formatted for dashboard text block: structured with line breaks
      snprintf(outdoorAqi.advisory, sizeof(outdoorAqi.advisory),
        "AQI: %d  %s\nPM2.5: %.0f  PM10: %.0f\nCO: %.0f  NO2: %.0f  O3: %.0f\nSO2: %.0f  NH3: %.0f\n%s\n%s",
        outdoorAqi.aqi, outdoorAqi.level,
        outdoorAqi.pm25, outdoorAqi.pm10, outdoorAqi.co / 1000.0f,  // CO ug→mg
        outdoorAqi.no2, outdoorAqi.o3, outdoorAqi.so2, outdoorAqi.nh3,
        cause, advice);

      outdoorAqi.valid = true;
      outdoorAqi.fetchTime = millis();
      // Event-driven: push immediately if outdoor air is poor/very poor
      if (outdoorAqi.aqi >= 4) EVENT_PUSH();
      Serial.printf("[AQI] OWM AQI=%d  PM2.5=%.1f  CO=%.0f  NO2=%.1f  O3=%.1f  %s\n",
                    outdoorAqi.aqi, outdoorAqi.pm25, outdoorAqi.co,
                    outdoorAqi.no2, outdoorAqi.o3, outdoorAqi.level);
      Serial.printf("[AQI] Cause: %s | Advice: %s\n", cause, advice);
      return true;
    }
    http.end();
    // OWM failed — fall through to Open-Meteo
  }

  // ── Fallback: Open-Meteo free API (basic AQI + PM2.5 only) ────────────────
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(5000);
  HTTPClient http;
  char url[160];
  snprintf(url, sizeof(url),
    "https://air-quality-api.open-meteo.com/v1/air-quality?"
    "latitude=%.4f&longitude=%.4f&current=us_aqi,pm2_5",
    deviceLat, deviceLon);
  http.begin(client, url);
  http.setTimeout(6000);
  int code = http.GET();
  if (code != 200) { http.end(); return false; }
  String body = http.getString();
  http.end();

  int aq = body.indexOf("\"us_aqi\":");
  if (aq >= 0) outdoorAqi.aqi = body.substring(aq + 9, body.indexOf(',', aq + 9)).toInt();
  int pm = body.indexOf("\"pm2_5\":");
  if (pm >= 0) outdoorAqi.pm25 = body.substring(pm + 8, body.indexOf(',', pm + 8)).toFloat();

  // Map US EPA AQI → level
  if      (outdoorAqi.aqi <=  50) strcpy(outdoorAqi.level, "Good");
  else if (outdoorAqi.aqi <= 100) strcpy(outdoorAqi.level, "Moderate");
  else if (outdoorAqi.aqi <= 150) strcpy(outdoorAqi.level, "Sensitive");
  else if (outdoorAqi.aqi <= 200) strcpy(outdoorAqi.level, "Unhealthy");
  else if (outdoorAqi.aqi <= 300) strcpy(outdoorAqi.level, "Very Bad");
  else                            strcpy(outdoorAqi.level, "Hazardous");

  // Basic advisory for fallback — formatted for dashboard text block
  if (outdoorAqi.aqi <= 50)
    snprintf(outdoorAqi.advisory, sizeof(outdoorAqi.advisory),
      "AQI: %d  Good\nPM2.5: %.0f\nAll clear\nGreat air, open windows", outdoorAqi.aqi, outdoorAqi.pm25);
  else if (outdoorAqi.aqi <= 100)
    snprintf(outdoorAqi.advisory, sizeof(outdoorAqi.advisory),
      "AQI: %d  Moderate\nPM2.5: %.0f\nMild\nOK for most people", outdoorAqi.aqi, outdoorAqi.pm25);
  else
    snprintf(outdoorAqi.advisory, sizeof(outdoorAqi.advisory),
      "AQI: %d  %s\nPM2.5: %.0f\nElevated\nLimit outdoor exposure",
      outdoorAqi.aqi, outdoorAqi.level, outdoorAqi.pm25);

  outdoorAqi.valid = true;
  outdoorAqi.fetchTime = millis();
  Serial.printf("[AQI] Open-Meteo AQI=%d  PM2.5=%.1f  %s\n",
                outdoorAqi.aqi, outdoorAqi.pm25, outdoorAqi.level);
  return true;
}

// ── Launch data (Cape Canaveral / KSC — location ID 12 in Launch Library 2) ──

// Format ISO-8601 "2024-04-03T18:45:00Z" → "Apr 03 18:45Z"
static void fmtLaunchTime(const char* iso, char* out, int len) {
  static const char* MON[] = {
    "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"
  };
  if (!iso || strlen(iso) < 16) {
    strncpy(out, "TBD", len);
    if (len > 0) out[len - 1] = '\0';
    return;
  }
  int m = ((iso[5]-'0')*10 + (iso[6]-'0')) - 1;
  int d  = (iso[8]-'0')*10 + (iso[9]-'0');
  if (m < 0 || m > 11) {
    strncpy(out, "TBD", len);
    if (len > 0) out[len - 1] = '\0';
    return;
  }
  snprintf(out, len, "%s %d %c%c:%c%cZ",
           MON[m], d, iso[11], iso[12], iso[14], iso[15]);
}

static void fmtLaunchTimeBrief(const char* iso, char* out, int len) {
  static const char* MON[] = {
    "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"
  };
  if (!iso || !iso[0]) {
    strncpy(out, "TBD", len);
    if (len > 0) out[len - 1] = '\0';
    return;
  }
  // If a caller already passed a compact display string like "Apr 5 12:34Z",
  // preserve it instead of trying to re-parse it as ISO-8601.
  if (!strchr(iso, 'T')) {
    strncpy(out, iso, len);
    if (len > 0) out[len - 1] = '\0';
    return;
  }
  if (strlen(iso) < 16) {
    strncpy(out, "TBD", len);
    if (len > 0) out[len - 1] = '\0';
    return;
  }
  int m = ((iso[5]-'0')*10 + (iso[6]-'0')) - 1;
  int d  = (iso[8]-'0')*10 + (iso[9]-'0');
  if (m < 0 || m > 11) {
    strncpy(out, "TBD", len);
    if (len > 0) out[len - 1] = '\0';
    return;
  }
  snprintf(out, len, "%s%d %c%c:%c%c",
           MON[m], d, iso[11], iso[12], iso[14], iso[15]);
}

static bool launchLooksKscCcsfs(const String& body, int startPos) {
  int endPos = body.indexOf("\"slug\":\"", startPos + 8);
  if (endPos < 0) endPos = min((int)body.length(), startPos + 1400);
  String chunk = body.substring(startPos, endPos);
  return chunk.indexOf("\"location\":{\"id\":11") >= 0 ||
         chunk.indexOf("\"location\":{\"id\":12") >= 0 ||
         chunk.indexOf("Kennedy Space Center") >= 0 ||
         chunk.indexOf("Cape Canaveral Space Force Station") >= 0 ||
         chunk.indexOf("Cape Canaveral SFS") >= 0 ||
         chunk.indexOf("Cape Canaveral Space Force Base") >= 0;
}

static bool extractJsonStringNear(const String& body, int anchorPos,
                                  const char* marker, int windowChars,
                                  char* out, size_t outLen) {
  if (!out || outLen == 0) return false;
  out[0] = '\0';

  int start = body.indexOf(marker, anchorPos);
  if (start < 0 || start > anchorPos + windowChars) return false;
  start += strlen(marker);
  int end = body.indexOf('"', start);
  if (end < 0 || end <= start) return false;
  body.substring(start, end).toCharArray(out, outLen);
  return out[0] != '\0';
}

static const SpaceHistoryEntry SPACE_HISTORY[] = {
  {  4,  5, 2010, "STS-131",  "STS-131 launched from KSC",
     "Discovery carried logistics and science gear to the ISS during the Shuttle program's final stretch." },
  {  4, 12, 1981, "STS-1",    "STS-1 first Shuttle launch",
     "Columbia's first flight proved the reusable Shuttle concept could leave the pad and return like a spacecraft, not a capsule." },
  {  5,  5, 1961, "Freedom 7","Alan Shepard flies Freedom 7",
     "America's first crewed spaceflight was brief, but it restored confidence and accelerated the Mercury program." },
  {  6, 16, 1963, "Vostok 6", "Tereshkova becomes first woman in space",
     "Valentina Tereshkova's mission became a lasting milestone for human spaceflight and women in exploration." },
  {  7, 20, 1969, "Apollo 11","Apollo 11 reaches the Moon",
     "The first lunar landing reshaped the space race and became the benchmark every Moon-return plan still references." },
  {  8, 25, 2012, "Voyager 1","Voyager 1 enters interstellar space",
     "The probe moved beyond the heliosphere, turning a 1977 mission into humanity's longest-running deep-space scout." },
  { 10,  4, 1957, "Sputnik 1","Sputnik 1 opens the Space Age",
     "That beeping metal sphere triggered the space race and changed science, education, and Cold War politics overnight." },
  { 11, 20, 1998, "Zarya",    "First ISS module launches",
     "Zarya was the opening hardware step toward the permanently crewed orbital outpost we still use today." },
  { 12, 24, 1968, "Apollo 8", "Apollo 8 transmits Earthrise",
     "Its Christmas Eve lunar broadcast gave the public a new image of Earth and proved crews could operate at the Moon." },
};

static bool getTodaySpaceHistory(char* shortLine, int shortLen, char* longLine, int longLen,
                                 char* contextLine, int contextLen) {
  struct tm tNow;
  if (!getLocalTime(&tNow)) {
    strncpy(shortLine, "History unavailable", shortLen);
    strncpy(longLine,  "Today in Space History unavailable", longLen);
    if (contextLine && contextLen > 0) {
      strncpy(contextLine, "Local time is unavailable, so today's historical context could not be selected.", contextLen);
      contextLine[contextLen - 1] = '\0';
    }
    if (shortLen > 0) shortLine[shortLen - 1] = '\0';
    if (longLen  > 0) longLine[longLen - 1] = '\0';
    return false;
  }

  const int month = tNow.tm_mon + 1;
  const int day   = tNow.tm_mday;
  for (const auto& entry : SPACE_HISTORY) {
    if (entry.month == month && entry.day == day) {
      snprintf(shortLine, shortLen, "%u %s", entry.year, entry.shortText);
      snprintf(longLine,  longLen,  "%u: %s", entry.year, entry.longText);
      if (contextLine && contextLen > 0) {
        strncpy(contextLine, entry.contextText, contextLen);
        contextLine[contextLen - 1] = '\0';
      }
      return true;
    }
  }

  strncpy(shortLine, "No history cached", shortLen);
  strncpy(longLine,  "No space-history entry cached for today.", longLen);
  if (contextLine && contextLen > 0) {
    strncpy(contextLine, "This build has a curated history list, so some calendar dates will not have an expanded note yet.", contextLen);
    contextLine[contextLen - 1] = '\0';
  }
  if (shortLen > 0) shortLine[shortLen - 1] = '\0';
  if (longLen  > 0) longLine[longLen - 1] = '\0';
  return false;
}

static bool getTodaySpaceHistory(char* shortLine, int shortLen, char* longLine, int longLen) {
  return getTodaySpaceHistory(shortLine, shortLen, longLine, longLen, nullptr, 0);
}

// Fetch next 3 upcoming launches from KSC/CCSFS from Launch Library 2 API,
// plus year-to-date launch count from previous launches endpoint.
// Uses manual JSON field extraction to keep RAM usage minimal.
bool fetchLaunches() {
  if (WiFi.status() != WL_CONNECTED) return false;
  quietBleForCloud();

  // ── 1. Upcoming launches from Cape Canaveral (KSC/CCSFS), next 3 ──────────
  // Location IDs: 11 = Kennedy Space Center, 12 = Cape Canaveral SFS (Florida)
  String body;
  {
    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(5000);
    HTTPClient http;
    http.begin(client,
      "https://ll.thespacedevs.com/2.2.0/launch/upcoming/"
      "?limit=8&mode=list&pad__location__ids=11,12");
    http.setTimeout(8000);
    int code = http.GET();
    if (code != 200) {
      Serial.printf("[LAUNCH] HTTP %d\n", code);
      http.end();
      return false;
    }
    body = http.getString();
    http.end();
  }

  launchCount = 0;
  int pos = body.indexOf("\"results\":");
  if (pos < 0) return false;

  while (launchCount < MAX_LAUNCHES) {
    int slugPos = body.indexOf("\"slug\":\"", pos);
    if (slugPos < 0) break;
    pos = slugPos + 8;
    if (!launchLooksKscCcsfs(body, slugPos)) continue;

    int np = body.indexOf("\"name\":\"", slugPos);
    if (np < 0) break;
    np += 8;
    int ne = body.indexOf('"', np);
    if (ne < 0) break;

    char statusName[20] = "?";
    char abbrev[12] = "?";
    int statusPos = body.indexOf("\"status\":{", slugPos);
    if (statusPos > 0 && statusPos < np + 500) {
      extractJsonStringNear(body, statusPos, "\"name\":\"", 160, statusName, sizeof(statusName));
    }
    int ap = body.indexOf("\"abbrev\":\"", np);
    if (ap > 0 && ap < np + 500) {
      ap += 10;
      int ae = body.indexOf('"', ap);
      if (ae > ap) body.substring(ap, min(ae, ap + 11)).toCharArray(abbrev, sizeof(abbrev));
    }

    char timeStr[18] = "TBD";
    int tp = body.indexOf("\"net\":\"", np);
    if (tp > 0) {
      tp += 7;
      int te = body.indexOf('"', tp);
      if (te > tp) fmtLaunchTime(body.substring(tp, te).c_str(), timeStr, sizeof(timeStr));
    }

    char provider[24] = "";
    int providerPos = body.indexOf("\"launch_service_provider\":{", slugPos);
    if (providerPos > 0 && providerPos < np + 900) {
      extractJsonStringNear(body, providerPos, "\"name\":\"", 220, provider, sizeof(provider));
    }

    char pad[36] = "";
    int padPos = body.indexOf("\"pad\":{", slugPos);
    if (padPos > 0 && padPos < np + 900) {
      extractJsonStringNear(body, padPos, "\"name\":\"", 220, pad, sizeof(pad));
    }

    char missionType[20] = "";
    int missionPos = body.indexOf("\"mission\":{", slugPos);
    if (missionPos > 0 && missionPos < np + 1400) {
      extractJsonStringNear(body, missionPos, "\"type\":\"", 260, missionType, sizeof(missionType));
    }

    body.substring(np, ne).toCharArray(launches[launchCount].name,
                                        sizeof(launches[0].name));
    strncpy(launches[launchCount].time,   timeStr, sizeof(launches[0].time)   - 1);
    strncpy(launches[launchCount].status, statusName[0] ? statusName : abbrev, sizeof(launches[0].status) - 1);
    strncpy(launches[launchCount].provider, provider[0] ? provider : "Unknown", sizeof(launches[0].provider) - 1);
    strncpy(launches[launchCount].pad, pad[0] ? pad : "Cape pad TBD", sizeof(launches[0].pad) - 1);
    strncpy(launches[launchCount].missionType, missionType[0] ? missionType : "Mission", sizeof(launches[0].missionType) - 1);
    launches[launchCount].time[sizeof(launches[0].time) - 1] = '\0';
    launches[launchCount].status[sizeof(launches[0].status) - 1] = '\0';
    launches[launchCount].provider[sizeof(launches[0].provider) - 1] = '\0';
    launches[launchCount].pad[sizeof(launches[0].pad) - 1] = '\0';
    launches[launchCount].missionType[sizeof(launches[0].missionType) - 1] = '\0';
    launchCount++;
    pos = ne;
  }

  // ── 2. Year-to-date launch count ──────────────────────────────────────────
  // Uses "previous" endpoint with current year filter; the "count" field in
  // the JSON response gives the total without downloading every record.
  struct tm tNow;
  if (getLocalTime(&tNow)) {
    static char ytdUrl[120];
    snprintf(ytdUrl, sizeof(ytdUrl),
      "https://ll.thespacedevs.com/2.2.0/launch/previous/"
      "?net__gte=%04d-01-01&limit=1&mode=list&pad__location__ids=11,12",
      tNow.tm_year + 1900);
    {
      WiFiClientSecure ytdClient;
      ytdClient.setInsecure();
      ytdClient.setTimeout(4000);
      HTTPClient ytdHttp;
      ytdHttp.begin(ytdClient, ytdUrl);
      ytdHttp.setTimeout(5000);
      int ytdCode = ytdHttp.GET();
      if (ytdCode == 200) {
        String ytdBody = ytdHttp.getString();
        int ci = ytdBody.indexOf("\"count\":");
        if (ci >= 0) {
          ci += 8;
          while (ci < (int)ytdBody.length() && ytdBody[ci] == ' ') ci++;
          launchesYTD = ytdBody.substring(ci).toInt();
          Serial.printf("[LAUNCH] %d launches so far in %d\n",
                        launchesYTD, tNow.tm_year + 1900);
        }
      }
      ytdHttp.end();
    }
  }

  launchFetchTime = millis();
  Serial.printf("[LAUNCH] %d upcoming fetched\n", launchCount);
  return launchCount > 0;
}

// ── Dad Joke ─────────────────────────────────────────────────────────────────
bool fetchDadJoke() {
  if (WiFi.status() != WL_CONNECTED) return false;
  quietBleForCloud();
  WiFiClientSecure sslClient;
  sslClient.setInsecure();
  sslClient.setTimeout(4000);
  HTTPClient http;
  http.begin(sslClient, "https://icanhazdadjoke.com/");
  http.addHeader("Accept", "application/json");
  http.addHeader("User-Agent", "SniffMasterPro/3.0");
  http.setTimeout(5000);
  int code = http.GET();
  if (code != 200) { http.end(); return false; }
  String body = http.getString();
  http.end();

  // Parse "joke":"..." field, handle JSON escapes + strip non-ASCII
  int start = body.indexOf("\"joke\":\"");
  if (start < 0) return false;
  start += 8;
  int out = 0;
  for (int i = start; i < (int)body.length() && out < (int)sizeof(dadJokeText) - 1; i++) {
    char c = body[i];
    if (c == '\\' && i + 1 < (int)body.length()) {
      char nc = body[++i];
      if (nc == '"')  { dadJokeText[out++] = '"'; }
      else if (nc == '\'') { dadJokeText[out++] = '\''; }
      else if (nc == 'n')  { dadJokeText[out++] = ' '; }
      else if (nc == 'u' && i + 4 < (int)body.length()) {
        // \uXXXX — map common Unicode punctuation to ASCII
        char hex[5] = { body[i+1], body[i+2], body[i+3], body[i+4], 0 };
        i += 4;
        uint16_t cp = (uint16_t)strtol(hex, nullptr, 16);
        if (cp == 0x2018 || cp == 0x2019) dadJokeText[out++] = '\''; // smart quotes
        else if (cp == 0x201C || cp == 0x201D) dadJokeText[out++] = '"';
        else if (cp == 0x2013 || cp == 0x2014) dadJokeText[out++] = '-'; // em/en dash
        else if (cp == 0x2026) { dadJokeText[out++] = '.'; dadJokeText[out++] = '.'; dadJokeText[out++] = '.'; } // ellipsis
        else if (cp < 0x80)  dadJokeText[out++] = (char)cp;
        // else: skip unmappable
      } else {
        dadJokeText[out++] = nc;
      }
    } else if (c == '"') {
      break;
    } else if ((uint8_t)c >= 0x80) {
      // Raw UTF-8 multi-byte — skip byte (continuation bytes follow, skip those too)
      // Simple heuristic: replace entire sequence with apostrophe for common 3-byte smart quotes
      if ((uint8_t)c == 0xE2 && i + 2 < (int)body.length() &&
          (uint8_t)body[i+1] == 0x80) {
        uint8_t b3 = (uint8_t)body[i+2];
        if (b3 == 0x98 || b3 == 0x99) { dadJokeText[out++] = '\''; i += 2; }
        else if (b3 == 0x9C || b3 == 0x9D) { dadJokeText[out++] = '"'; i += 2; }
        else if (b3 == 0x93 || b3 == 0x94) { dadJokeText[out++] = '-'; i += 2; }
        else i += 2; // skip other E2 80 xx sequences
      }
      // else just skip this byte
    } else {
      dadJokeText[out++] = c;
    }
  }
  dadJokeText[out] = '\0';
  dadJokeReady = (out > 0);
  return dadJokeReady;
}

// ── ChatGPT AI smell report (Optimized) ──────────────────────────────────────
// Asks GPT for a JSON response with a custom hazard level name and snarky
// observation, informed by 5-minute IAQ/VOC trend direction.
// Returns true on success; always writes safe fallback strings on failure.
bool fetchGPTSassyMsg(int iaq, float voc, float co2, float tempF, float hum,
                      float pressHpa, float gasR, const char* topOdor,
                      uint8_t odorConf, int airScore,
                      const char* iaqTrend, const char* vocTrend,
                      char* outHazard, int hazardLen,
                      char* outMsg,    int outLen) {

  // 1. Initial Fallbacks (The "OLED won't be blank" insurance)
  strlcpy(outHazard, "Analyzing...", hazardLen);
  strlcpy(outMsg, "The AI is thinking...", outLen);

  if (WiFi.status() != WL_CONNECTED) {
    strlcpy(outMsg, "WiFi offline - no cloud sniff.", outLen);
    return false;
  }

  // 2. Static buffers to avoid stack overflow on ESP32 (8KB stack limit)
  static char prompt[800];
  static char esc[1000];  // Increased for escape characters (\")
  static char reqBody[2400];

  // Build the richest possible context for GPT — every available sensor reading,
  // environmental context, outdoor conditions, and time-of-day for smart analysis.
  // GPT should reason about what's ACTUALLY happening in the room, not just echo numbers.
  {
    // Get time of day for contextual awareness
    const char* timeCtx = "unknown";
    struct tm tInfo;
    if (getLocalTime(&tInfo)) {
      int h = tInfo.tm_hour;
      timeCtx = (h < 6) ? "late night" : (h < 9) ? "early morning" :
                (h < 12) ? "morning" : (h < 14) ? "midday" :
                (h < 17) ? "afternoon" : (h < 20) ? "evening" : "night";
    }

    // Build secondary odor context — what else is the sensor picking up?
    static char odorCtx[80];
    int oc = 0;
    for (int i = 0; i < ODOR_COUNT && oc < 70; i++) {
      if (ss_scores[i] >= ODOR_MIN_CONF) {
        if (oc > 0) oc += snprintf(odorCtx + oc, sizeof(odorCtx) - oc, ",");
        oc += snprintf(odorCtx + oc, sizeof(odorCtx) - oc, "%s:%d%%", odorNames[i], ss_scores[i]);
      }
    }
    if (oc == 0) strcpy(odorCtx, "none");

    // Outdoor context string
    static char outdoorCtx[60];
    if (outdoorAqi.valid) {
      snprintf(outdoorCtx, sizeof(outdoorCtx), "AQI:%d(%s) PM2.5:%.0f",
               outdoorAqi.aqi, outdoorAqi.level, outdoorAqi.pm25);
    } else {
      strcpy(outdoorCtx, "unavailable");
    }

    // Build the richest possible data dump so GPT can analyze everything
    snprintf(prompt, sizeof(prompt),
      "SENSOR DUMP: IAQ=%d(%s,trend:%s) VOC=%.2fppm(trend:%s) CO2=%.0fppm "
      "Temp=%.0fF Hum=%.0f%% Press=%.0fhPa GasR=%.0fohm(%.0fk) CompGas=%.0fohm "
      "dVOC=%.1f Score=%d/100 Tier=%d/5 SmellNet=[%s] "
      "City=%s Time=%s Outdoor=%s Farts=%d. "
      "Give me your environmental report as JSON: {hazard_level, observation(max 230 chars)}.",
      iaq, iaqQuality(iaq), iaqTrend, voc, vocTrend, co2, tempF, hum,
      pressHpa, gasR, gasR / 1000.0f, ss_compGas,
      ss_dvoc, airScore, ss_tier, odorCtx,
      deviceCity[0] ? deviceCity : "unknown", timeCtx, outdoorCtx, fartCount);
  }

  // JSON-escape the prompt string
  int ei = 0;
  for (int i = 0; prompt[i] && ei < 995; i++) {
    if (prompt[i] == '"' || prompt[i] == '\\') esc[ei++] = '\\';
    esc[ei++] = prompt[i];
  }
  esc[ei] = '\0';

  // response_format:json_object guarantees GPT returns raw JSON — no fences, no prose
  int written = snprintf(reqBody, sizeof(reqBody),
    "{\"model\":\"%s\",\"max_tokens\":500,"
    "\"response_format\":{\"type\":\"json_object\"},"
    "\"messages\":["
      "{\"role\":\"system\",\"content\":\"You are SniffMaster Pro v4.0 — a brutally honest, slightly rude AI nose living inside a BME688 air quality sensor. You're trapped in this sensor and you have OPINIONS about what people are doing to the air around you."
      " Your job: write a short environmental status report like a sarcastic weatherman who can smell everything. Talk like a real person, not a robot. Be blunt, judgy, funny. Roast the humans when warranted."
      " RULES:"
      " - Cross-reference ALL the data: IAQ, VOC, CO2, gasR (low = nasty reducing gases, high = clean), humidity, temp, time of day, outdoor AQI, detected odors, trends, fart count."
      " - DIAGNOSE what is actually happening in the room. Don't just list numbers — tell a story. Is someone cooking? Did someone rip one? Is the room stuffy because nobody opened a window? Is it 2am and the air is suspiciously funky?"
      " - Do not default to cooking unless the signal strongly supports food prep. In offices or mixed indoor spaces, prefer explanations like coffee, break-room food, fragrance, cleaning products, stale occupancy air, leftovers, or mixed VOC buildup when those fit better."
      " - Note trends: if IAQ is rising say so, if VOC is dropping say things are improving."
      " - Mention specific numbers when roasting (e.g. 'your CO2 hit 1200, that means 3 people breathing in a closet')."
      " - If fart count > 0, absolutely mention it and judge them."
      " - Give practical advice but make it backhanded (e.g. 'Maybe crack a window? Just a thought. Or don't. I'll just suffer.')."
      " - Max 230 chars for observation. Write in plain english, no bullet points."
      " hazard_level: Pristine/Fresh/Fair/Stale/Caution/Warning/Danger."
      " smell_quip: A 3-line punchy quip about the current smell situation (max 60 chars total, lines separated by backslash-n, each line max 21 chars). Think bumper sticker energy."
      " smell_radar: A short narrative (max 280 chars) analyzing the smell detection results like a detective report. Name specific odors detected and their likely real-world source. Be colorful but informative."
      " Reply ONLY {hazard_level, observation, smell_quip, smell_radar}.\"},"
      "{\"role\":\"user\",\"content\":\"%s\"}"
    "]}",
    OPENAI_MODEL, esc);

  if (written >= (int)sizeof(reqBody)) {
    Serial.printf("[ChatGPT] WARNING: request truncated (%d >= %d)\n",
                  written, (int)sizeof(reqBody));
  }
  Serial.printf("[ChatGPT] Request body (%d bytes)\n", written);

  // 4. Secure Connection
  if (melBusy()) melStop();  // silence buzzer — this call blocks 5-15s
  WiFiClientSecure gptClient;
  gptClient.setInsecure(); // Required for ESP32 unless using Root CA
  gptClient.setTimeout(5000);  // limit TLS handshake (was 6s)
  HTTPClient http;

  quietBleForCloud();
  http.setTimeout(7000);
  http.begin(gptClient, "https://api.openai.com/v1/chat/completions");
  http.addHeader("Content-Type",  "application/json");
  http.addHeader("Authorization", "Bearer " OPENAI_API_KEY);

  Serial.println(F("[ChatGPT] Requesting sassy remark..."));
  int code = http.POST(reqBody);
  Serial.printf("[ChatGPT] HTTP %d\n", code);

  if (code != 200) {
    String errBody = http.getString();
    Serial.println("[ChatGPT] Error Details: " + errBody);
    http.end();
    strlcpy(outMsg, "GPT is ghosting us.", outLen);
    return false;
  }

  String body = http.getString();
  http.end();

  // 5. Extraction Logic — robust parser for OpenAI chat completions response
  // The API returns: { ... "choices":[{"message":{"content":"..."}}] ... }
  // The "content" value is a JSON-escaped string containing our JSON object.
  //
  // We search for "content" with multiple patterns because the API may format
  // with or without spaces, and the field may appear in different contexts.
  Serial.printf("[ChatGPT] Response length: %d\n", (int)body.length());

  // Find "content" field — the API nests it as:
  //   {"choices":[{"message":{"content":"{ ... }"}}]}
  // We need to handle: "content":"...", "content": "...", "content":null

  // First check for content:null (model refusal on newer API)
  if (body.indexOf("\"content\":null") >= 0 || body.indexOf("\"content\": null") >= 0) {
    Serial.println(F("[ChatGPT] Model returned content:null (refused)"));
    strlcpy(outHazard, "AI Refused", hazardLen);
    strlcpy(outMsg, "GPT declined to respond.", outLen);
    return false;
  }

  // Locate the "message" object first, then find "content" within it
  // This avoids matching "content" in other parts of the response (e.g. system_fingerprint)
  int mi = body.indexOf("\"message\"");
  int ci = -1;
  int ciLen = 0;

  if (mi >= 0) {
    // Search for "content":"  or  "content": "  after "message"
    int c1 = body.indexOf("\"content\":\"", mi);
    int c2 = body.indexOf("\"content\": \"", mi);
    if (c1 >= 0) { ci = c1; ciLen = 11; }
    else if (c2 >= 0) { ci = c2; ciLen = 12; }
  }

  // Fallback: search entire body
  if (ci < 0) {
    ci = body.indexOf("\"content\":\"");
    ciLen = 11;
  }
  if (ci < 0) {
    ci = body.indexOf("\"content\": \"");
    ciLen = 12;
  }

  if (ci < 0) {
    Serial.println(F("[ChatGPT] Could not find 'content' in response"));
    Serial.println(body.substring(0, min((int)body.length(), 400)));
    strlcpy(outHazard, "Parse Error", hazardLen);
    strlcpy(outMsg, "AI reply format unexpected.", outLen);
    return false;
  }
  ci += ciLen;

  // Extract the content string value, handling JSON escape sequences
  static char contentBuf[800];
  int cx = 0;
  for (int i = ci; i < (int)body.length() && cx < (int)sizeof(contentBuf) - 2; i++) {
    char c = body[i];
    if (c == '\\' && i + 1 < (int)body.length()) {
      char nc = body[++i];
      if      (nc == '"')  contentBuf[cx++] = '"';
      else if (nc == 'n')  contentBuf[cx++] = ' ';
      else if (nc == 't')  contentBuf[cx++] = ' ';
      else if (nc == '\\') contentBuf[cx++] = '\\';
      else if (nc == '/')  contentBuf[cx++] = '/';
      else                 contentBuf[cx++] = nc;
    } else if (c == '"') {
      break;  // end of JSON string value
    } else if ((uint8_t)c >= 0x20 && (uint8_t)c < 0x80) {
      contentBuf[cx++] = c;
    }
    // skip non-ASCII / control chars
  }
  contentBuf[cx] = '\0';
  Serial.printf("[ChatGPT] raw content: %s\n", contentBuf);

  // Strip markdown code fences if GPT added them despite response_format
  // e.g. ```json { ... } ``` → find the first { and last }
  char* jsonStart = strchr(contentBuf, '{');
  char* jsonEnd   = strrchr(contentBuf, '}');
  if (jsonStart && jsonEnd && jsonEnd > jsonStart) {
    *(jsonEnd + 1) = '\0';
  } else {
    jsonStart = contentBuf;
  }

  // Parse the extracted JSON
  StaticJsonDocument<768> doc;
  DeserializationError err = deserializeJson(doc, jsonStart);

  if (!err) {
    strlcpy(outHazard, doc["hazard_level"] | "Sniffing...",           hazardLen);
    strlcpy(outMsg,    doc["observation"]  | "The air is suspicious.", outLen);
    // GPT smell quip (for OLED smell sentence page)
    const char* quip = doc["smell_quip"] | "";
    if (quip[0]) strlcpy(dcSmellQuip, quip, sizeof(dcSmellQuip));
    // GPT smell radar narrative (for Blynk V8)
    const char* radar = doc["smell_radar"] | "";
    if (radar[0]) strlcpy(dcSmellRadar, radar, sizeof(dcSmellRadar));
    Serial.printf("[ChatGPT] OK: hazard=\"%s\"  obs=\"%s\"\n", outHazard, outMsg);
  } else {
    Serial.printf("[ChatGPT] JSON parse fail: %s\n", err.c_str());
    Serial.printf("[ChatGPT] Attempted to parse: %s\n", jsonStart);
    // Surface whatever we got so the user sees something useful
    strlcpy(outHazard, "AI Error", hazardLen);
    // If contentBuf has readable text, show it; otherwise generic message
    if (cx > 5) {
      strlcpy(outMsg, contentBuf, outLen);
    } else {
      strlcpy(outMsg, "GPT response unreadable.", outLen);
    }
  }

  doc.clear();
  Serial.printf("[ChatGPT] Final: %s | %s\n", outHazard, outMsg);
  return !err;
}

// ── Adafruit IO — auto-provision group + feeds on first boot ─────────────────
#ifdef USE_ADAFRUIT_IO
// Creates the "sniffmaster" group AND all 10 feeds via the REST API.
// AIO does NOT auto-create feeds — they must be explicitly created before the
// group batch data endpoint will accept data.  This runs once at boot; feeds
// that already exist return a non-error and are skipped quickly.
static bool aioGroupReady = false;

void ensureAioGroup() {
  if (aioGroupReady) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (strncmp(AIO_USERNAME, "YOUR_", 5) == 0) return;

  WiFiClientSecure sslClient;
  sslClient.setInsecure();
  sslClient.setTimeout(5000);
  HTTPClient http;

  // ── Step 1: ensure group exists ────────────────────────────────────────────
  char url[120];
  snprintf(url, sizeof(url),
    "https://io.adafruit.com/api/v2/%s/groups/sniffmaster", AIO_USERNAME);

  http.begin(sslClient, url);
  http.addHeader("X-AIO-Key", AIO_KEY);
  http.setTimeout(6000);
  int code = http.GET();
  http.end();

  if (code == 200) {
    Serial.println(F("[AIO] Group 'sniffmaster' found."));
  } else {
    // Group doesn't exist — create it
    Serial.println(F("[AIO] Creating group 'sniffmaster'..."));
    char createUrl[120];
    snprintf(createUrl, sizeof(createUrl),
      "https://io.adafruit.com/api/v2/%s/groups", AIO_USERNAME);

    http.begin(sslClient, createUrl);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-AIO-Key",    AIO_KEY);
    http.setTimeout(8000);
    code = http.POST("{\"group\":{\"name\":\"SniffMaster\",\"key\":\"sniffmaster\"}}");
    String resp = http.getString();
    http.end();

    if (code >= 200 && code < 300) {
      Serial.println(F("[AIO] Group created."));
    } else {
      Serial.printf("[AIO] Group create failed: HTTP %d\n", code);
      Serial.println(resp);
      return;  // can't continue without a group
    }
  }

  // ── Step 2: ensure all 10 feeds exist inside the group ─────────────────────
  // POST /api/v2/{user}/groups/sniffmaster/feeds  with {"feed":{"name":"..."}}
  // If a feed already exists AIO returns 200/409 — we treat both as success.
  static const char* feedNames[] = {
    "iaq", "status", "dad-joke", "air-score", "fart-count",
    "odor-status", "weather", "gas-readings", "launches"
  };
  const int NUM_FEEDS = 9;  // free tier: 10 feeds max, keep 1 slot spare

  char feedUrl[120];
  snprintf(feedUrl, sizeof(feedUrl),
    "https://io.adafruit.com/api/v2/%s/groups/sniffmaster/feeds", AIO_USERNAME);

  int created = 0, existed = 0, failed = 0;
  for (int i = 0; i < NUM_FEEDS; i++) {
    char body[100];
    snprintf(body, sizeof(body),
      "{\"feed\":{\"name\":\"%s\"}}", feedNames[i]);

    http.begin(sslClient, feedUrl);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-AIO-Key",    AIO_KEY);
    http.setTimeout(5000);
    code = http.POST(body);
    http.end();

    if (code == 201 || code == 200) {
      created++;
      Serial.printf("[AIO] Feed '%s' created\n", feedNames[i]);
    } else {
      existed++;  // 400/409/422 all mean "already exists" — fine
    }
    delay(50);  // brief courtesy delay between requests
  }

  Serial.printf("[AIO] Feeds: %d new, %d existing\n", created, existed);
  aioGroupReady = true;
  Serial.println(F("[AIO] Setup complete — ready for data."));
}

// ── Adafruit IO — send metrics via REST group data endpoint ──────────────────
// POSTs all feeds at once: POST /api/v2/{user}/groups/sniffmaster/data
// Feeds are pre-created by ensureAioGroup() at boot — the batch endpoint
// does NOT auto-create feeds.
//
// Free tier budget: 10 feeds max, 30 data points/min.
// We use 9 feeds × 30s interval = 18 pts/min (60% of limit, safe margin).
// Outdoor AQI data is included in the weather feed — no separate feed needed.
//
// 9 feeds:
//   1. iaq           (number)  IAQ 0-500
//   2. status        (string)  GPT snarky status / alert when conditions change
//   3. dad-joke      (string)  daily dad joke
//   4. air-score     (number)  combined 0-100
//   5. fart-count    (number)  daily fart count
//   6. odor-status   (string)  "Coffee 75%|Tier:Clean|GasR:355k|Score:72"
//   7. weather       (string)  includes outdoor AQI, dew point, wind, moon phase
//   8. gas-readings  (string)  "VOC:0.85ppm|CO2:612ppm|GasR:355k|CompGas:340k|..."
//   9. launches      (string)  "Falcon 9|Apr 6 14:30Z|Go ++ Starliner|Apr 10|TBD"
bool sendToAdafruitIO(int iaq, float voc, float co2, float tempF, float hum,
                      float pressHpa, float gasR, const char* odorName,
                      uint8_t odorConf, int airScore, uint8_t tier,
                      const char* sassyMsg, const char* hazardLevel) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[AIO] WiFi offline — skipped"));
    return false;
  }
  if (strncmp(AIO_USERNAME, "YOUR_", 5) == 0) {
    Serial.println(F("[AIO] Not configured — edit secrets.h"));
    return false;
  }

  // ── All large buffers are static to avoid stack overflow on ESP32 ──────────
  // The ESP32 default task stack is 8KB; these buffers alone would exceed 4KB
  // if stack-allocated. Safe because sendToAdafruitIO() is never re-entrant.

  // ── Build GPT status string ────────────────────────────────────────────────
  // GPT gives an AI-powered room analysis. When not available, generate a
  // detailed, specific status so the dashboard always feels alive and smart.
  static char statusStr[320];
  if (!fullCalibrationReady(ss_iaqAcc)) {
    snprintf(statusStr, sizeof(statusStr),
      "Sensor %s\nBME688 accuracy %d/3  stab %.0f run-in %.0f\nHome baseline: %s (%u/%u calm)\nFull odor logic available shortly",
      calibrationStatusText(ss_iaqAcc, ss_stabStatus, ss_runInStatus),
      ss_iaqAcc, ss_stabStatus, ss_runInStatus,
      homeBase.ready ? "ready" : "learning",
      (unsigned)min((int)homeBase.calmSamples, (int)HOME_BASELINE_MIN_SAMPLES),
      (unsigned)HOME_BASELINE_MIN_SAMPLES);
  } else if (sassyMsg[0] != '\0') {
    // GPT analysis available — clean format, no brackets
    snprintf(statusStr, sizeof(statusStr), "%s\n%s", hazardLevel, sassyMsg);
  } else {
    // Rich descriptive fallback with actual environmental insight
    const char* aq = (iaq < 25) ? "Pristine" : (iaq < 50) ? "Fresh" :
                     (iaq < 100) ? "Good" : (iaq < 150) ? "Fair" :
                     (iaq < 200) ? "Getting Stale" :
                     (iaq < 300) ? "Poor" : "Hazardous";
    const char* comfort = (hum > 30 && hum < 60) ? "comfortable" :
                          (hum <= 30) ? "dry air" : "humid";
    const char* vent = (co2 < 600) ? "well-ventilated" :
                       (co2 < 1000) ? "adequate airflow" :
                       (co2 < 1500) ? "needs fresh air" : "stuffy";
    snprintf(statusStr, sizeof(statusStr),
      "%s Air Quality\nIAQ %d  VOC %.1f ppm  CO2 %.0f ppm\n%.0fF  %s  %s\nRoom score: %d/100",
      aq, iaq, voc, co2, tempF, comfort, vent, airScore);
  }

  // ── Build dad joke string (use cached joke, or fallback) ───────────────────
  const char* jokeStr = dadJokeReady ? dadJokeText : "Warming up the joke engine...";

  // ── Build comprehensive odor-status string ──────────────────────────────────
  // Premium format: room assessment + all detections + AI quip
  static char odorStatus[360];
  const char* tLabel = tierDesc(tier);
  int op = 0;

  // Room assessment header
  const char* roomVerdict = (airScore < 15) ? "Pristine Environment" :
                            (airScore < 30) ? "Fresh Room" :
                            (airScore < 50) ? "Normal Conditions" :
                            (airScore < 70) ? "Elevated Activity" :
                            (airScore < 85) ? "Poor Conditions" : "Hazardous Air";
  op += snprintf(odorStatus + op, sizeof(odorStatus) - op,
    "%s\nSmell tier: %s  Room score: %d/100", roomVerdict, tLabel, airScore);

  // Primary detection with physics context
  if (odorConf >= ODOR_MIN_CONF) {
    const char* confDesc = (odorConf >= 75) ? "Strong detection" :
                           (odorConf >= 55) ? "Likely detected" :
                           (odorConf >= 35) ? "Possible trace" : "Faint signal";
    op += snprintf(odorStatus + op, sizeof(odorStatus) - op,
      "\n%s: %s (%d%%)", confDesc, odorName, odorConf);

    // Sensor context for primary odor
    float gasRk = gasR / 1000.0f;
    if (gasRk < 30.0f) {
      op += snprintf(odorStatus + op, sizeof(odorStatus) - op,
        "\nGas resistance crashed (%.0fk) - strong reducing gases", gasRk);
    } else if (gasRk > 200.0f) {
      op += snprintf(odorStatus + op, sizeof(odorStatus) - op,
        "\nGas resistance high (%.0fk) - mild organic source", gasRk);
    }
  } else {
    op += snprintf(odorStatus + op, sizeof(odorStatus) - op,
      "\nNo odors detected - air is clean");
    if (iaq < 25) {
      op += snprintf(odorStatus + op, sizeof(odorStatus) - op,
        "\nExcellent baseline established");
    }
  }

  // All secondary detections above threshold
  for (int i = 0; i < ODOR_COUNT && op < (int)sizeof(odorStatus) - 35; i++) {
    if (odorNames[i] == odorName || ss_scores[i] < ODOR_MIN_CONF) continue;
    op += snprintf(odorStatus + op, sizeof(odorStatus) - op,
      "\nAlso: %s (%d%%)", odorNames[i], ss_scores[i]);
  }

  // Add the smell quip sentence
  uint8_t quipIdx = (odorConf >= ODOR_MIN_CONF && dcOdorIdx < ODOR_COUNT) ? dcOdorIdx : CLEAN_AIR_SENTENCE_IDX;
  uint8_t quipTier = (airScore < 41) ? 0 : (airScore < 70) ? 1 : 2;
  op += snprintf(odorStatus + op, sizeof(odorStatus) - op,
    "\n---\n%s", SMELL_SENTENCES[quipIdx][quipTier]);

  // ── Build combined weather string ──────────────────────────────────────────
  static char weatherStr[200];
  const char* city = (deviceCity[0] != '\0') ? deviceCity : "Location pending";
  if (weather.valid) {
    int mDay = 0;
    struct tm tNow;
    char timeStr[12] = "";
    if (getLocalTime(&tNow)) {
      mDay = moonAge(tNow.tm_year + 1900, tNow.tm_mon + 1, tNow.tm_mday);
      int h12 = tNow.tm_hour > 12 ? tNow.tm_hour - 12 :
                (tNow.tm_hour ? tNow.tm_hour : 12);
      snprintf(timeStr, sizeof(timeStr), "%d:%02d %s",
               h12, tNow.tm_min, tNow.tm_hour >= 12 ? "PM" : "AM");
    }
    int illum = moonIllumPct(mDay);
    const char* mPhase = moonPhaseName(mDay);

    if (outdoorAqi.valid) {
      snprintf(weatherStr, sizeof(weatherStr),
        "%s | %s\n%s\n%.0fF (feels %dF)  %.0f%% RH  Dew %.0fF\nWind: %s %s  %.0f hPa\nOutdoor: %s  PM2.5: %.0f\n%s %d%%",
        city, timeStr, weather.condition,
        tempF, weather.feelsLikeF, hum, dewPointF(tempF, hum),
        weather.windDir, weather.windSpeed, pressHpa,
        outdoorAqi.level, outdoorAqi.pm25, mPhase, illum);
    } else {
      snprintf(weatherStr, sizeof(weatherStr),
        "%s | %s\n%s\n%.0fF (feels %dF)  %.0f%% RH  Dew %.0fF\nWind: %s %s  %.0f hPa\n%s %d%%",
        city, timeStr, weather.condition,
        tempF, weather.feelsLikeF, hum, dewPointF(tempF, hum),
        weather.windDir, weather.windSpeed, pressHpa, mPhase, illum);
    }
  } else {
    snprintf(weatherStr, sizeof(weatherStr),
      "%s\n%.0fF  %.0f%% RH  Dew %.0fF  %.0f hPa\nFetching outdoor conditions...",
      city, tempF, hum, dewPointF(tempF, hum), pressHpa);
  }

  // ── Build gas readings string ──────────────────────────────────────────────
  // Comprehensive BSEC2 + SmellNet readout with intelligent interpretation.
  // The BME688 MOX sensor measures total gas resistance — BSEC2 decomposes
  // this into VOC equivalent and CO2 equivalent using Bosch's proprietary
  // algorithms. SmellNet ML classifies the gas fingerprint into 12 base
  // odor categories; 8 derived families are layered on top for 20 total.
  static char gasStr[480];
  int gp = 0;
  float gasRk_g = gasR / 1000.0f;
  float compK_g = ss_compGas / 1000.0f;

  // BSEC2 core readings with interpretation
  const char* vocLevel = (voc < 0.5f) ? "baseline" : (voc < 2.0f) ? "normal" :
                         (voc < 5.0f) ? "elevated" : (voc < 15.0f) ? "high" : "very high";
  const char* co2Level = (co2 < 500) ? "fresh" : (co2 < 800) ? "occupied" :
                         (co2 < 1200) ? "stuffy" : (co2 < 2000) ? "poor" : "dangerous";
  gp += snprintf(gasStr + gp, sizeof(gasStr) - gp,
    "VOC: %.2f ppm (%s)\nCO2: %.0f ppm (%s)\nIAQ: %d  Static IAQ: %.0f",
    voc, vocLevel, co2, co2Level, iaq, ss_staticIAQ);

  // Gas resistance with context — this is the key diagnostic
  const char* gasNote = (gasRk_g > 300.0f) ? "clean baseline" :
                        (gasRk_g > 100.0f) ? "normal range" :
                        (gasRk_g > 50.0f)  ? "mild gas exposure" :
                        (gasRk_g > 20.0f)  ? "active gas source" : "heavy gas load";
  gp += snprintf(gasStr + gp, sizeof(gasStr) - gp,
    "\nGasR: %.0fk (%s)\nCompGas: %.0fk  Gas%%: %.0f\nDew point: %.0fF",
    gasRk_g, gasNote, compK_g, ss_gasPct, dewPointF(tempF, hum));

  // Sensor calibration status
  const char* calStatus = calibrationStatusText(ss_iaqAcc, ss_stabStatus, ss_runInStatus);
  gp += snprintf(gasStr + gp, sizeof(gasStr) - gp,
    "\nSensor: %s (acc %d/3)", calStatus, ss_iaqAcc);

  // SmellNet ML analysis — full 20-category fingerprint (12 base + 8 derived)
  gp += snprintf(gasStr + gp, sizeof(gasStr) - gp, "\n--- SmellNet ML ---");
  for (int i = 0; i < ODOR_COUNT && gp < (int)sizeof(gasStr) - 30; i++) {
    const char* marker = ss_scores[i] >= 60 ? " STRONG" :
                         ss_scores[i] >= ODOR_MIN_CONF ? " detected" : "";
    gp += snprintf(gasStr + gp, sizeof(gasStr) - gp,
      "\n%s: %d%%%s", odorNames[i], ss_scores[i], marker);
  }

  // ── Build launch schedule string ───────────────────────────────────────────
  static char launchStr[320];
  char histLong[96];
  char histShort[32];
  getTodaySpaceHistory(histShort, sizeof(histShort), histLong, sizeof(histLong));
  if (launchCount > 0) {
    int lp = 0;
    // Year-to-date header
    if (launchesYTD > 0) {
      struct tm tL;
      int yr = 2026;
      if (getLocalTime(&tL)) yr = tL.tm_year + 1900;
      lp += snprintf(launchStr + lp, sizeof(launchStr) - lp,
        "%d launches KSC/CCSFS in %d\n---\n", launchesYTD, yr);
    }
    for (int i = 0; i < launchCount && lp < (int)sizeof(launchStr) - 2; i++) {
      if (i > 0) { lp += snprintf(launchStr + lp, sizeof(launchStr) - lp, "\n---\n"); }
      lp += snprintf(launchStr + lp, sizeof(launchStr) - lp,
        "%s\n%s\nStatus: %s", launches[i].name, launches[i].time, launches[i].status);
    }
  } else {
    strncpy(launchStr, "No upcoming launches", sizeof(launchStr));
  }
  size_t used = strlen(launchStr);
  snprintf(launchStr + used, sizeof(launchStr) - used,
    "\n---\nToday in Space History\n%s\n%s", histShort, histLong);

  // ── Build JSON payload (10 feeds) ──────────────────────────────────────────
  // JSON-escape all string values: quotes, backslashes, and newlines.
  // Newlines in feed values render as line breaks on Adafruit IO text blocks.
  auto jsonEsc = [](const char* src, char* dst, int maxLen) {
    int d = 0;
    for (int i = 0; src[i] && d < maxLen - 3; i++) {
      if (src[i] == '"' || src[i] == '\\') { dst[d++] = '\\'; dst[d++] = src[i]; }
      else if (src[i] == '\n') { dst[d++] = '\\'; dst[d++] = 'n'; }
      else if (src[i] == '\r') { /* skip CR */ }
      else dst[d++] = src[i];
    }
    dst[d] = '\0';
  };

  static char escStatus[400];   jsonEsc(statusStr,    escStatus,  sizeof(escStatus));
  static char escJoke[240];     jsonEsc(jokeStr,       escJoke,    sizeof(escJoke));
  static char escOdor[440];     jsonEsc(odorStatus,    escOdor,    sizeof(escOdor));
  static char escWeather[250];  jsonEsc(weatherStr,    escWeather, sizeof(escWeather));
  static char escGas[580];      jsonEsc(gasStr,        escGas,     sizeof(escGas));
  static char escLaunch[420];   jsonEsc(launchStr,     escLaunch,  sizeof(escLaunch));

  static char payload[2800];  // 9 feeds, ~1500 bytes typical
  snprintf(payload, sizeof(payload),
    "{\"feeds\":["
    "{\"key\":\"iaq\",\"value\":\"%d\"},"
    "{\"key\":\"status\",\"value\":\"%s\"},"
    "{\"key\":\"dad-joke\",\"value\":\"%s\"},"
    "{\"key\":\"air-score\",\"value\":\"%d\"},"
    "{\"key\":\"fart-count\",\"value\":\"%d\"},"
    "{\"key\":\"odor-status\",\"value\":\"%s\"},"
    "{\"key\":\"weather\",\"value\":\"%s\"},"
    "{\"key\":\"gas-readings\",\"value\":\"%s\"},"
    "{\"key\":\"launches\",\"value\":\"%s\"}"
    "]}",
    iaq, escStatus, escJoke,
    airScore, fartCount, escOdor, escWeather,
    escGas, escLaunch);

  static char url[100];
  snprintf(url, sizeof(url),
    "https://io.adafruit.com/api/v2/%s/groups/sniffmaster/data", AIO_USERNAME);

  if (melBusy()) melStop();  // silence buzzer before blocking TLS
  quietBleForCloud();
  WiFiClientSecure aioClient;
  aioClient.setInsecure();
  aioClient.setTimeout(4000);
  HTTPClient http;
  if (!http.begin(aioClient, url)) {
    Serial.println(F("[AIO] HTTP begin failed"));
    return false;
  }
  http.addHeader("Content-Type",  "application/json");
  http.addHeader("X-AIO-Key",     AIO_KEY);
  http.setTimeout(5000);

  int code = http.POST(payload);
  if (code < 200 || code >= 300) {
    String resp = http.getString();
    Serial.printf("[AIO] HTTP %d (%s)  (%d bytes, RSSI %d)\n",
                  code, HTTPClient::errorToString(code).c_str(),
                  (int)strlen(payload), WiFi.RSSI());
    // Print first 200 chars of error body for diagnostics
    if (resp.length() > 0) {
      Serial.printf("[AIO] Error: %s\n", resp.substring(0, 200).c_str());
    }
    if (code == 422) {
      Serial.println(F("[AIO] 422 = likely throttled (free tier: 30 pts/min)"));
    }
  } else {
    Serial.printf("[AIO] HTTP %d OK (%d bytes)\n", code, (int)strlen(payload));
  }
  http.end();
  return (code >= 200 && code < 300);
}
#endif // USE_ADAFRUIT_IO

// ══════════════════════════════════════════════════════════════
// Section 22b: Blynk IoT Dashboard
//   sendToBlynk — pushes sensor data over persistent TCP
// ══════════════════════════════════════════════════════════════

#ifdef USE_BLYNK
// ── Terminal widget objects — one per string datastream ──────────────────────
// WidgetTerminal renders multiline text with proper \n line breaks, scrolling,
// and monospaced font. Much better than Label widgets for detailed data.
// Each terminal.clear() wipes the widget, then println() lines render cleanly.
WidgetTerminal termWeather(V2);
WidgetTerminal termGas(V4);
WidgetTerminal termJoke(V5);
WidgetTerminal termStatus(V7);
WidgetTerminal termOdor(V8);
WidgetTerminal termLaunch(V11);

// Format current local time into a buffer as "8:37 PM" (12-hour + AM/PM with space)
static void fmtLocalTime(char* buf, size_t len) {
  struct tm tNow;
  if (getLocalTime(&tNow)) {
    int h12 = tNow.tm_hour > 12 ? tNow.tm_hour - 12 :
              (tNow.tm_hour ? tNow.tm_hour : 12);
    snprintf(buf, len, "%d:%02d %s",
             h12, tNow.tm_min, tNow.tm_hour >= 12 ? "PM" : "AM");
  } else {
    strncpy(buf, "??:??", len);
  }
}

/**
 * sendToBlynk() — push all sensor data to Blynk IoT virtual pins.
 *
 * Uses the Blynk library's persistent TCP connection (not REST).
 * Numeric pins use Gauge/Value widgets; string pins use Terminal widgets.
 *
 * Virtual Pin mapping (must match Datastreams in Blynk template):
 *   V0  IAQ            Integer   0–500       (Gauge)
 *   V1  Air Score      Integer   0–100       (Gauge)
 *   V2  Weather        String                (Terminal)
 *   V3  Humidity       Double    0–100 %     (Gauge)
 *   V4  Gas Readings   String                (Terminal)
 *   V5  Dad Joke       String                (Terminal)
 *   V6  Fart Count     Integer   0–999       (Value)
 *   V7  Status         String                (Terminal)
 *   V8  Odor           String                (Terminal)
 *   V9  Outdoor AQI    Integer   0–500       (Gauge)
 *   V10 Pressure       Double    900–1100    (Gauge)
 *   V11 Launches       String                (Terminal)
 */
void sendToBlynk(int iaq, float voc, float co2, float tempF, float hum,
                 float pressHpa, float gasR, const char* odorName,
                 uint8_t odorConf, int airScore,
                 const char* sassyMsg, const char* hazardLevel) {
  if (!blynkConnected || !Blynk.connected()) {
    Serial.println(F("[BLYNK] Not connected — skipped"));
    return;
  }

  // ── Numeric pins — Gauge / Value Display widgets ──────────────────────────
  // 6 virtualWrite calls = 6 events
  Blynk.virtualWrite(V0, iaq);
  Blynk.virtualWrite(V1, airScore);
  Blynk.virtualWrite(V3, hum);
  Blynk.virtualWrite(V6, fartCount);
  Blynk.virtualWrite(V9, outdoorAqi.valid ? outdoorAqi.aqi : 0);
  Blynk.virtualWrite(V10, pressHpa);

  // ── Terminal pins — single virtualWrite per terminal ──────────────────────
  // Content is built into a static buffer, then sent in ONE call per pin.
  // No terminal.clear() — Label widgets replace content on each write.
  // 6 numeric + 6 terminal = 12 events per cycle.

  char ts[12]; fmtLocalTime(ts, sizeof(ts));
  char uptStr[16]; fmtUptime(uptStr, sizeof(uptStr));
  float gasRk = gasR / 1000.0f;
  float dp = dewPointF(tempF, hum);
  int rssi = WiFi.RSSI();

  // Shared build buffer — reused for each terminal (max content ~1400 chars)
  static char buf[1500];
  int n = 0;
  #define BC(fmt, ...) do { n += snprintf(buf + n, sizeof(buf) - 1 - n, fmt, ##__VA_ARGS__); } while(0)

  // ── V2 Weather ────────────────────────────────────────────────────────────
  n = 0;
  {
    const char* city = (deviceCity[0] != '\0') ? deviceCity : "Location pending";
    int mDay = 0;
    struct tm tNow;
    if (getLocalTime(&tNow))
      mDay = moonAge(tNow.tm_year + 1900, tNow.tm_mon + 1, tNow.tm_mday);

    BC("=== WEATHER === %s\n%s\n------------------------\n", ts, city);
    if (weather.valid) {
      const char* dpNote = (dp < 55) ? "dry" : (dp < 60) ? "comfortable" :
                           (dp < 65) ? "sticky" : "oppressive";
      const char* pNote  = (pressHpa > 1022) ? "high (clear skies)" :
                           (pressHpa > 1009) ? "normal" : "low (storm possible)";
      BC("%s\n\nTemp:       %.0fF\nFeels Like: %dF\nHumidity:   %.0f%%\n"
         "Dew Point:  %.0fF (%s)\n\nWind:       %s %s\nPressure:   %.0f hPa\n"
         "            %s\n",
         weather.condition, tempF, weather.feelsLikeF, hum,
         dp, dpNote, weather.windDir, weather.windSpeed, pressHpa, pNote);
    } else {
      BC("Temp: %.0fF | Hum: %.0f%%\nDew: %.0fF | %.0f hPa\nWeather data pending...\n",
         tempF, hum, dp, pressHpa);
    }
    // Outdoor air
    BC("\n--- Outdoor Air ---\n");
    if (outdoorAqi.valid) {
      const char* aqiLabel = (outdoorAqi.aqi <= 1) ? "Good" :
                             (outdoorAqi.aqi <= 2) ? "Fair" :
                             (outdoorAqi.aqi <= 3) ? "Moderate" :
                             (outdoorAqi.aqi <= 4) ? "Poor" : "Hazardous";
      const char* winAdv = (outdoorAqi.aqi <= 2) ? "Good day for open windows" :
                           (outdoorAqi.aqi <= 3) ? "Sensitive groups be cautious" :
                                                   "Keep windows closed";
      BC("AQI: %d (%s)\nPM2.5: %.1f  PM10: %.0f\nO3: %.0f  NO2: %.1f  CO: %.0f\n%s\n",
         outdoorAqi.aqi, aqiLabel, outdoorAqi.pm25, outdoorAqi.pm10,
         outdoorAqi.o3, outdoorAqi.no2, outdoorAqi.co, winAdv);
    } else {
      BC("No outdoor data yet\n");
    }
    // Moon
    int illum = moonIllumPct(mDay);
    BC("\n--- Moon ---\n%s (%d%% illuminated)\n", moonPhaseName(mDay), illum);
    if      (illum >= 95)                BC("Werewolf conditions\n");
    else if (illum <= 5)                 BC("Perfect stargazing night\n");
    else if (illum >= 40 && illum <= 60) BC("Half moon tonight\n");
  }
  buf[n] = '\0';
  Blynk.virtualWrite(V2, buf);

  // ── V4 Gas Readings (Sensor Lab) ──────────────────────────────────────────
  n = 0;
  {
    float compK = ss_compGas / 1000.0f;
    const char* vocNote = (voc < 0.5f) ? "baseline" : (voc < 2.0f) ? "normal" :
                          (voc < 5.0f) ? "elevated" : (voc < 15.0f) ? "high" : "very high";
    const char* co2Note = (co2 < 500) ? "fresh" : (co2 < 800) ? "occupied" :
                          (co2 < 1200) ? "stuffy" : (co2 < 2000) ? "poor" : "dangerous";
    const char* gasNote = (gasRk > 300.0f) ? "clean baseline" :
                          (gasRk > 100.0f) ? "normal range" :
                          (gasRk > 50.0f)  ? "mild gas exposure" :
                          (gasRk > 20.0f)  ? "active gas source" : "heavy gas load";
    const char* calNote = calibrationStatusText(ss_iaqAcc, ss_stabStatus, ss_runInStatus);

    BC("=== SENSOR LAB === %s\n------------------------\n", ts);
    BC("VOC:  %.2f ppm (%s)\n      trend: %s  dVOC: %.1f\n", voc, vocNote, getVocTrend(), ss_dvoc);
    BC("CO2:  %.0f ppm (%s)\n", co2, co2Note);
    if (co2 > 500) {
      int estPeople = (int)((co2 - 420) / 40);
      if (estPeople > 0) BC("      ~%d people estimated\n", estPeople);
    }
    BC("\nIAQ:  %d (%s)\n      static: %.0f  trend: %s\n\n", iaq, iaqQuality(iaq), ss_staticIAQ, getIaqTrend());
    BC("GasR: %.0fk ohms\n      %s\nComp: %.0fk  Gas%%: %.0f\nDew:  %.0fF\n\n",
       gasRk, gasNote, compK, ss_gasPct, dp);
    BC("Sensor: %s\nAccuracy: %d/3\n\n--- SmellNet ML Analysis ---\n", calNote, ss_iaqAcc);
    for (int i = 0; i < ODOR_COUNT; i++) {
      char bar[11];
      int filled = ss_scores[i] / 10;
      for (int b = 0; b < 10; b++) bar[b] = (b < filled) ? '#' : '-';
      bar[10] = '\0';
      const char* tag = (ss_scores[i] >= 60) ? " !!" :
                        (ss_scores[i] >= ODOR_MIN_CONF) ? " *" : "";
      BC("%-9s [%s] %2d%%%s\n", odorNames[i], bar, ss_scores[i], tag);
    }
  }
  buf[n] = '\0';
  Blynk.virtualWrite(V4, buf);

  // ── V5 Dad Joke ───────────────────────────────────────────────────────────
  n = 0;
  BC("--- Daily Dad Joke ---\n\n%s\n\nUpdated %s\n",
     dadJokeReady ? dadJokeText : "Warming up the joke engine...", ts);
  buf[n] = '\0';
  Blynk.virtualWrite(V5, buf);

  // ── V7 Status (SniffMaster Report) ────────────────────────────────────────
  n = 0;
  {
    BC("=== SNIFFMASTER PRO === %s\n============================\n", ts);
    if (!fullCalibrationReady(ss_iaqAcc)) {
      BC("Status: %s\n\nIAQ: %d  Accuracy: %d/3\n"
         "VOC: %.2f ppm  CO2: %.0f ppm\nGasR: %.0fk\n"
         "Stab: %.0f  Run-in: %.0f\nBaseline: %s (%u/%u)\n\n"
         "AI odor analysis appears\nonce the gas model settles.\n"
         "Temp: %.0fF  Humidity: %.0f%%\nDew point: %.0fF\n",
         calibrationStatusText(ss_iaqAcc, ss_stabStatus, ss_runInStatus),
         iaq, ss_iaqAcc, voc, co2, gasRk,
         ss_stabStatus, ss_runInStatus,
         homeBase.ready ? "ready" : "learning",
         (unsigned)min((int)homeBase.calmSamples, (int)HOME_BASELINE_MIN_SAMPLES),
         (unsigned)HOME_BASELINE_MIN_SAMPLES,
         tempF, hum, dp);
    } else if (sassyMsg[0] != '\0') {
      BC("[%s]\n%s\n\n--- Environment ---\n", hazardLevel, sassyMsg);
      BC("IAQ: %d (%s)  Score: %d/100\nVOC: %.2f ppm  CO2: %.0f ppm\n"
         "Temp: %.0fF  Humidity: %.0f%%\nGasR: %.0fk  Dew: %.0fF\n"
         "Trends: IAQ %s | VOC %s\n",
         iaq, iaqQuality(iaq), airScore, voc, co2, tempF, hum, gasRk, dp,
         getIaqTrend(), getVocTrend());
      if (odorConf >= ODOR_MIN_CONF)
        BC("Smell: %s (%d%%) Tier %d/5\n", odorName, odorConf, dcTier);
      else
        BC("No odors detected. Tier: %s\n", tierDesc(dcTier));
      if (fartCount > 0) BC("Farts today: %d\n", fartCount);
    } else {
      const char* aq = (iaq < 25) ? "Pristine" : (iaq < 50) ? "Fresh" :
                       (iaq < 100) ? "Good" : (iaq < 150) ? "Fair" :
                       (iaq < 200) ? "Stale" : (iaq < 300) ? "Poor" : "Hazardous";
      const char* comfort = (hum >= 30 && hum <= 60) ? "Comfortable" :
                            (hum < 30) ? "Too dry" : "Too humid";
      BC("Air Quality: %s\n\n--- Readings ---\n"
         "IAQ: %d  Score: %d/100\nVOC: %.2f ppm  CO2: %.0f ppm\n"
         "Trends: IAQ %s | VOC %s\n\n--- Comfort ---\n"
         "Temp: %.0fF  Humidity: %.0f%%\nComfort: %s\nDew: %.0fF\n\n"
         "--- Ventilation ---\n",
         aq, iaq, airScore, voc, co2, getIaqTrend(), getVocTrend(),
         tempF, hum, comfort, dp);
      if      (co2 < 600)  BC("Excellent - well ventilated\n");
      else if (co2 < 1000) BC("Adequate airflow\n");
      else if (co2 < 1500) BC("Stuffy (CO2 %.0f)\n", co2);
      else                 BC("POOR - open windows!\n");
      BC("GasR: %.0fk\n\n", gasRk);
      if (odorConf >= ODOR_MIN_CONF)
        BC("Smell: %s (%d%%)\nTier: %s (%d/5)\n", odorName, odorConf, tierDesc(dcTier), dcTier);
      if (fartCount > 0) BC("Farts today: %d\n", fartCount);
      BC("\nAI report incoming...\n");
    }
    // Last melody & next report
    BC("\n--- Jukebox ---\nLast played: %s\n", lastMelodyPlayed);
    if (lastMelodyUptimeSec > 0) {
      unsigned long nowUp = millis() / 1000UL;
      unsigned long ageSec = (nowUp >= lastMelodyUptimeSec) ? (nowUp - lastMelodyUptimeSec) : 0;
      if (ageSec < 60UL) {
        BC("When: %lus ago\n", ageSec);
      } else if (ageSec < 3600UL) {
        BC("When: %lum ago\n", ageSec / 60UL);
      } else {
        BC("When: %luh ago\n", ageSec / 3600UL);
      }
    }
    BC("Why: %s\n", lastMelodyReason);
    {
      unsigned long elapsed = millis() - lastBlynkPostMillis;
      unsigned long remain  = (elapsed >= BLYNK_POST_INTERVAL) ? 0 : BLYNK_POST_INTERVAL - elapsed;
      unsigned long remMin  = remain / 60000UL;
      if (remMin > 0)
        BC("Next report: ~%lu min\n", remMin);
      else
        BC("Next report: soon\n");
    }
    const char* sigQ = (rssi > -50) ? "excellent" : (rssi > -60) ? "good" :
                       (rssi > -70) ? "fair" : "weak";
    BC("---\nWiFi: %d dBm (%s)\nSensor: acc %d/3 | Up: %s\nFree RAM: %d bytes\n",
       rssi, sigQ, ss_iaqAcc, uptStr, (int)ESP.getFreeHeap());
  }
  buf[n] = '\0';
  Blynk.virtualWrite(V7, buf);

  // ── V8 Odor Detection (Smell Radar) ───────────────────────────────────────
  n = 0;
  {
    const char* vocDir = (ss_dvoc > 0.5f) ? "RISING" :
                         (ss_dvoc < -0.3f) ? "falling" : "steady";
    BC("=== SMELL RADAR === %s\n============================\n"
       "Tier: %s (%d/5)\nRoom Score: %d/100\n\n"
       "VOC: %.2f ppm (%s)\ndVOC: %.2f  trend: %s\n",
       ts, tierDesc(dcTier), dcTier, airScore, voc, vocDir, ss_dvoc, getVocTrend());
    if (biggestFartVoc > 0.5f) BC("Peak VOC today: %.1f ppm\n", biggestFartVoc);
    BC("\n--- Detection ---\n");
    if (odorConf >= ODOR_MIN_CONF) {
      const char* conf = (odorConf >= 75) ? "STRONG" : (odorConf >= 55) ? "Likely" :
                         (odorConf >= 35) ? "Possible" : "Faint";
      BC("%s: %s (%d%%)\n", conf, odorName, odorConf);
      if      (gasRk < 20.0f) BC("GasR: %.0fk CRASHED\n", gasRk);
      else if (gasRk < 50.0f) BC("GasR: %.0fk (active src)\n", gasRk);
      else                    BC("GasR: %.0fk\n", gasRk);
      if (co2 > 1000) BC("CO2: %.0f (people nearby)\n", co2);
      bool hasSec = false;
      for (int i = 0; i < ODOR_COUNT; i++) {
        if (odorNames[i] != odorName && ss_scores[i] >= ODOR_MIN_CONF) {
          if (!hasSec) { BC("\nAlso detected:\n"); hasSec = true; }
          BC("  %s: %d%%\n", odorNames[i], ss_scores[i]);
        }
      }
    } else {
      BC("No odors detected\n");
      if      (iaq < 25 && gasRk > 300) BC("Air is pristine\nBaseline is excellent\n");
      else if (iaq < 50)                BC("Air is clean and fresh\n");
      else if (iaq < 100)               BC("Air is fair, low activity\n");
      else                              BC("IAQ %d - activity detected\nbut below odor threshold\n", iaq);
      BC("GasR: %.0fk\n", gasRk);
    }
    // GPT smell radar narrative (if available)
    if (dcSmellRadar[0]) {
      BC("\n--- AI Analysis ---\n%s\n", dcSmellRadar);
    }
    // Fart tracker
    BC("\n--- Fart Tracker ---\nToday: %d detected\n", fartCount);
    if (biggestFartVoc > 0.5f) BC("Biggest spike: %.1f ppm\n", biggestFartVoc);
    else                       BC("No events yet today\n");
    // Quip
    uint8_t qi = (odorConf >= ODOR_MIN_CONF && dcOdorIdx < ODOR_COUNT) ? dcOdorIdx : CLEAN_AIR_SENTENCE_IDX;
    uint8_t qt = (airScore < 41) ? 0 : (airScore < 70) ? 1 : 2;
    BC("\n--- Room Vibe ---\n");
    if (dcSmellQuip[0]) {
      BC("%s\n", dcSmellQuip);
    } else {
      const char* quip = SMELL_SENTENCES[qi][qt];
      while (*quip) {
        const char* nl = strchr(quip, '\n');
        if (nl) {
          int len = min((int)(nl - quip), (int)(sizeof(buf) - 2 - n));
          n += snprintf(buf + n, sizeof(buf) - 1 - n, "%.*s\n", len, quip);
          quip = nl + 1;
        } else {
          BC("%s\n", quip);
          break;
        }
      }
    }
  }
  buf[n] = '\0';
  Blynk.virtualWrite(V8, buf);

  // ── V11 Launches (Space Watch) ────────────────────────────────────────────
  n = 0;
  {
    char histLong[96];
    char histShort[32];
    getTodaySpaceHistory(histShort, sizeof(histShort), histLong, sizeof(histLong));
    BC("=== SPACE WATCH === %s\n============================\n", ts);
    if (launchCount > 0) {
      if (launchesYTD > 0) {
        struct tm tL;
        int yr = 2026;
        if (getLocalTime(&tL)) yr = tL.tm_year + 1900;
        BC("%d launches from KSC/CCSFS in %d\n", launchesYTD, yr);
      }
      BC("\n");
      for (int i = 0; i < launchCount; i++) {
        const char* sIcon = (strstr(launches[i].status, "Go"))      ? "[GO]"   :
                            (strstr(launches[i].status, "Success")) ? "[OK]"   :
                            (strstr(launches[i].status, "Hold"))    ? "[HOLD]" :
                            (strstr(launches[i].status, "TBD"))     ? "[TBD]"  : "[--]";
        BC("---\n%d. %s\n   %s\n   Status: %s %s\n",
           i + 1, launches[i].name, launches[i].time, sIcon, launches[i].status);
      }
    } else {
      BC("\nNo upcoming launches\nCheck back soon!\n");
    }
    BC("\n--- Today in Space History ---\n%s\n%s\n", histShort, histLong);
    BC("\nUpdated %s\n", ts);
  }
  buf[n] = '\0';
  Blynk.virtualWrite(V11, buf);

  #undef BC
  Serial.println(F("[BLYNK] Data pushed (12 events: 6 numeric + 6 terminal)"));
}
#endif // USE_BLYNK

// ══════════════════════════════════════════════════════════════
// Section 22b: Web Dashboard — HTTPS POST to hosted relay
// ══════════════════════════════════════════════════════════════

#ifdef USE_WEB_DASHBOARD
bool sendPrioritySniffEvent() {
  if (WiFi.RSSI() < -80) {
    Serial.printf("[WEB] Sniff POST deferred: RSSI %d\n", WiFi.RSSI());
    return false;
  }
  if (melBusy()) melStop();  // silence buzzer before blocking TLS
  quietBleForCloud();
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(3000);
  HTTPClient http;

  char url[128];
  snprintf(url, sizeof(url), "%s/api/sniff", WEB_DASHBOARD_URL);

  if (!http.begin(client, url)) {
    Serial.println(F("[WEB] Sniff HTTP begin failed"));
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);

  StaticJsonDocument<512> doc;
  doc["key"] = WEB_DASHBOARD_KEY;
  doc["iaq"] = queuedSniffIaq;
  doc["vsc_conf"] = roundf(queuedSniffConf * 10.0f) / 10.0f;
  doc["label"] = queuedSniffLabel[0] ? queuedSniffLabel : "High Sulfur";
  doc["airScore"] = dcAirScore;
  doc["voc"] = roundf(dcVOC * 100.0f) / 100.0f;
  doc["dVoc"] = roundf(ss_dvoc * 100.0f) / 100.0f;
  doc["primary"] = (dcOdorIdx < ODOR_COUNT) ? odorNames[dcOdorIdx] : "Clean Air";
  doc["primaryConf"] = dcOdorConf;
  doc["fartCount"] = fartCount;

  char payload[640];
  serializeJson(doc, payload, sizeof(payload));

  int code = http.POST(payload);
  String response = (code > 0) ? http.getString() : String();
  http.end();

  if (code == 200) {
    Serial.printf("[WEB] Priority sulfur event sent (%.1f%% %s)\n",
                  queuedSniffConf, queuedSniffLabel);
    return true;
  }

  Serial.printf("[WEB] Priority sulfur POST failed: %d (%s, RSSI %d)\n",
                code, HTTPClient::errorToString(code).c_str(), WiFi.RSSI());
  if (response.length()) {
    Serial.printf("[WEB] Priority sulfur response: %s\n", response.c_str());
  }
  return false;
}

bool sendToWebDashboard() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[WEB] POST skipped: WiFi offline"));
    return false;
  }
  if (WiFi.RSSI() < -80) {
    Serial.printf("[WEB] POST deferred: RSSI %d too weak for TLS\n", WiFi.RSSI());
    return false;  // will retry next interval
  }

  if (melBusy()) melStop();  // silence buzzer before blocking TLS
  quietBleForCloud();
  WiFiClientSecure client;
  client.setInsecure();  // skip cert validation (relay is public HTTPS)
  client.setTimeout(4000);  // limit TLS handshake time (was 5000)
  HTTPClient http;

  char url[128];
  snprintf(url, sizeof(url), "%s/api/update", WEB_DASHBOARD_URL);

  if (!http.begin(client, url)) {
    Serial.println(F("[WEB] HTTP begin failed"));
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(6000);

  // Build JSON payload with structured telemetry, weather, paranormal scan,
  // and launch/location data for the hosted dashboard.
  static StaticJsonDocument<6144> doc;
  doc.clear();
  doc["key"]        = WEB_DASHBOARD_KEY;
  doc["voc"]        = round(dcVOC * 100) / 100.0;
  doc["iaq"]        = dcIAQ;
  doc["iaqAcc"]     = ss_iaqAcc;
  doc["highAccuracyIaq"] = bsecCalibrationReady(ss_iaqAcc);
  doc["staticIaq"]  = round(ss_staticIAQ);
  doc["co2"]        = round(dcCO2);
  doc["tempF"]      = round(dcTempF * 10) / 10.0;
  doc["humidity"]   = round(dcHum * 10) / 10.0;
  doc["pressHpa"]   = round(dcPressHpa * 10) / 10.0;
  doc["gasR"]       = round(dcGasR);
  doc["compGas"]    = round(ss_compGas);
  doc["gasPct"]     = round(ss_gasPct * 10) / 10.0;
  doc["dVoc"]       = round(ss_dvoc * 100) / 100.0;
  doc["vscConf"]    = ss_scores[OD_SULFUR];
  doc["cfiScore"]   = roundf(dcCFIScore * 1000.0f) / 1000.0f;
  doc["cfiPercent"] = dcCFIPercent;
  doc["cfiBand"]    = cfiBandForScore(dcCFIScore);
  doc["vtrLevel"]   = dcVTRLevel;
  doc["vtrLabel"]   = vtrLabelForLevel(dcVTRLevel);
  doc["vtrAdvice"]  = vtrAdviceForLevel(dcVTRLevel);
  doc["airScore"]   = dcAirScore;
  doc["tier"]       = dcTier;
  doc["fartCount"]  = fartCount;
  doc["iaqTrend"]   = getIaqTrend();
  doc["vocTrend"]   = getVocTrend();
  doc["calibration"] = calibrationStatusText(ss_iaqAcc, ss_stabStatus, ss_runInStatus);
  doc["lastMelody"] = lastMelodyPlayed;
  doc["lastMelodyReason"] = lastMelodyReason;
  doc["lastMelodyUptime"] = lastMelodyUptimeSec;
  if (WiFi.status() == WL_CONNECTED) {
    doc["wifiSsid"] = WiFi.SSID();
    doc["wifiIp"] = WiFi.localIP().toString();
    doc["wifiRssi"] = WiFi.RSSI();
  }
  {
    const BlePresenceSnapshot &ble = blePresenceGetSnapshot();
    doc["blePresenceEnabled"] = ble.enabled;
    doc["blePresenceState"] = blePresenceStateLabel(ble.state);
    doc["blePresenceConf"] = ble.confidence;
    doc["bleTargetRssi"] = ble.lastRssi;
    doc["bleRssiEma"] = roundf(ble.emaRssi * 10.0f) / 10.0f;
    doc["bleRssiStdDev"] = roundf(ble.rssiStdDev * 10.0f) / 10.0f;
    doc["bleSeen"] = ble.seenRecently;
    doc["bleBreathReady"] = blePresenceBreathReady();
    if (ble.matchedName[0])    doc["bleTargetName"] = ble.matchedName;
    if (ble.matchedAddress[0]) doc["bleTargetAddr"] = ble.matchedAddress;
  }
  if (locationFetched) {
    doc["lat"] = round(deviceLat * 10000.0f) / 10000.0f;
    doc["lon"] = round(deviceLon * 10000.0f) / 10000.0f;
    doc["utcOffsetSec"] = utcOffsetSec;
  }

  JsonArray odors = doc.createNestedArray("odors");
  for (int i = 0; i < ODOR_COUNT; i++) odors.add(ss_scores[i]);

  const char* odorName = (dcOdorIdx < ODOR_COUNT) ? odorNames[dcOdorIdx] : "Clean Air";
  doc["primary"]     = odorName;
  doc["primaryConf"] = dcOdorConf;
  doc["hazard"]      = dcHazardLevel;

  if (dcSassyMsg[0])    doc["sassy"] = dcSassyMsg;
  if (dcSmellQuip[0])   doc["quip"]  = dcSmellQuip;
  if (dcSmellRadar[0])  doc["radar"] = dcSmellRadar;
  if (weather.valid) {
    doc["weatherCondition"] = weather.condition;
    doc["feelsLikeF"] = weather.feelsLikeF;
    doc["windDir"] = weather.windDir;
    doc["windSpeed"] = weather.windSpeed;
  }
  if (facts.valid) {
    doc["deathValleyTempF"] = facts.dvTempF;
    doc["moonDay"] = facts.moonDay;
  }

  doc["uptime"] = (unsigned long)(millis() / 1000UL);
  if (outdoorAqi.valid) {
    doc["outdoorAqi"] = outdoorAqi.aqi;
    doc["outdoorLevel"] = outdoorAqi.level;
    doc["aqiAdvisory"] = outdoorAqi.advisory;
    doc["outdoorPm25"] = round(outdoorAqi.pm25 * 10) / 10.0f;
    doc["outdoorPm10"] = round(outdoorAqi.pm10 * 10) / 10.0f;
    doc["outdoorCo"] = round(outdoorAqi.co);
    doc["outdoorNo2"] = round(outdoorAqi.no2 * 10) / 10.0f;
    doc["outdoorO3"] = round(outdoorAqi.o3 * 10) / 10.0f;
    doc["outdoorSo2"] = round(outdoorAqi.so2 * 10) / 10.0f;
    doc["outdoorNh3"] = round(outdoorAqi.nh3 * 10) / 10.0f;
  }
  if (deviceCity[0])    doc["city"] = deviceCity;
  if (lastParanormalScan.valid) {
    doc["paranormalEntity"] = lastParanormalScan.entity;
    doc["paranormalReport"] = lastParanormalScan.report;
    doc["paranormalUptime"] = lastParanormalScan.uptimeSec;
  }
  if (launchesYTD > 0)  doc["launchesYtd"] = launchesYTD;
  if (launchCount > 0) {
    JsonArray launchArr = doc.createNestedArray("launches");
    for (int i = 0; i < launchCount; i++) {
      JsonObject item = launchArr.createNestedObject();
      item["name"] = launches[i].name;
      item["time"] = launches[i].time;
      item["status"] = launches[i].status;
      item["provider"] = launches[i].provider;
      item["pad"] = launches[i].pad;
      item["missionType"] = launches[i].missionType;
    }
  }
  char histShort[32];
  char histLong[96];
  char histContext[160];
  getTodaySpaceHistory(histShort, sizeof(histShort), histLong, sizeof(histLong),
                       histContext, sizeof(histContext));
  doc["spaceHistoryShort"] = histShort;
  doc["spaceHistoryLong"] = histLong;
  doc["spaceHistoryContext"] = histContext;

  static char payload[8192];
  serializeJson(doc, payload, sizeof(payload));

  int code = http.POST(payload);
  String response = (code > 0) ? http.getString() : String();
  http.end();

  if (code == 200) {
    Serial.println(F("[WEB] Dashboard updated"));
    return true;
  }
  Serial.printf("[WEB] POST failed: %d (%s, RSSI %d)\n",
                code, HTTPClient::errorToString(code).c_str(), WiFi.RSSI());
  if (response.length()) {
    Serial.printf("[WEB] Response: %s\n", response.c_str());
  }
  return false;
}

static void executePortalCommand(const char* action, const char* melodyKey) {
  if (!action || !action[0]) return;

  Serial.printf("[WEB] Remote command: %s%s%s\n",
                action,
                (melodyKey && melodyKey[0]) ? " key=" : "",
                (melodyKey && melodyKey[0]) ? melodyKey : "");

  if (strcmp(action, "refresh") == 0) {
    pendingDcSend = true;
    EVENT_PUSH();
    forceRedraw = true;
    return;
  }

  if (strcmp(action, "breath_check") == 0) {
    runBreathChecker();
    EVENT_PUSH();
    forceRedraw = true;
    return;
  }

  if (strcmp(action, "ghost_scan") == 0) {
    runParanormalScan();
    EVENT_PUSH();
    forceRedraw = true;
    return;
  }

  if (strcmp(action, "presence_probe") == 0) {
    runPresenceProbe();
    EVENT_PUSH();
    forceRedraw = true;
    return;
  }

  if (strcmp(action, "play_melody") == 0) {
    if (playMelodyByKey(melodyKey, "portal jukebox")) {
      EVENT_PUSH();
      forceRedraw = true;
    }
    return;
  }
}

void pollPortalCommand() {
  if (!ss_valid) return;
  if (WiFi.status() != WL_CONNECTED) return;

  unsigned long now = millis();
  if (lastWebPostMillis == 0 || now - lastWebPostMillis < COMMAND_POLL_START_DELAY_MS) return;
  if (portalBackpressureActive(now)) return;
  if (lastCommandPollMillis != 0 && now - lastCommandPollMillis < COMMAND_POLL_MS) return;
  lastCommandPollMillis = now;

  // RSSI pre-check: skip poll entirely if signal is marginal.
  // This prevents 3-8s TLS stalls from freezing the OLED between sensor reads.
  if (WiFi.RSSI() < -78) {
    Serial.printf("[WEB] Command poll skipped: RSSI %d too weak\n", WiFi.RSSI());
    return;
  }
  if (melBusy()) melStop();  // silence buzzer before blocking TLS
  quietBleForCloud();
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(3000);  // TLS handshake limit — tight for a poll
  HTTPClient http;

  char url[160];
  snprintf(url, sizeof(url), "%s/api/command?after=%lu", WEB_DASHBOARD_URL, lastCommandSeq);
  if (!http.begin(client, url)) {
    Serial.println(F("[WEB] Command poll begin failed"));
    return;
  }

  http.addHeader("X-SniffMaster-Key", WEB_DASHBOARD_KEY);
  http.setTimeout(3000);

  int code = http.GET();
  String response = (code > 0) ? http.getString() : String();
  http.end();

  if (code == 204) return;

  if (code != 200) {
    Serial.printf("[WEB] Command poll failed: %d (%s, RSSI %d)\n",
                  code, HTTPClient::errorToString(code).c_str(), WiFi.RSSI());
    if (response.length()) {
      Serial.printf("[WEB] Command response: %s\n", response.c_str());
    }
    return;
  }

  StaticJsonDocument<384> doc;
  DeserializationError err = deserializeJson(doc, response);
  if (err) {
    Serial.printf("[WEB] Command JSON parse failed: %s\n", err.c_str());
    return;
  }

  unsigned long seq = doc["seq"] | 0UL;
  const char* action = doc["action"] | "";
  const char* melodyKey = doc["melodyKey"] | "";
  if (seq == 0 || !action[0] || seq <= lastCommandSeq) return;

  lastCommandSeq = seq;
  executePortalCommand(action, melodyKey);
}
#endif // USE_WEB_DASHBOARD

// ══════════════════════════════════════════════════════════════
// Section 23: Splash Screen
//   splashNose, splashSniff, drawSplash
// ══════════════════════════════════════════════════════════════

// Cartoon nose: rounded body + two nostrils + bridge lines.
// ny = y of the top of the nose body.
static void splashNose(int ny) {
  display.fillRoundRect(50, ny, 28, 20, 10, SSD1306_WHITE);    // nose body
  display.fillCircle(57, ny + 14, 5, SSD1306_BLACK);           // left nostril
  display.fillCircle(71, ny + 14, 5, SSD1306_BLACK);           // right nostril
  // Bridge narrows as it goes up (lines converge toward centre)
  display.drawLine(53, ny, 59, ny - 13, SSD1306_WHITE);        // left bridge
  display.drawLine(75, ny, 69, ny - 13, SSD1306_WHITE);        // right bridge
}

// Two zigzag sniff-wave columns rising from above the nostrils.
// baseY = y of the bottom of the wave column.
static void splashSniff(int baseY) {
  // Only draw a segment if both endpoints are on-screen (y >= 0)
  auto seg = [](int x1, int y1, int x2, int y2) {
    if (y1 >= 0 && y2 >= 0)
      display.drawLine(x1, y1, x2, y2, SSD1306_WHITE);
  };
  // Left column
  seg(56, baseY,      52, baseY - 7);
  seg(52, baseY - 7,  60, baseY - 14);
  seg(60, baseY - 14, 54, baseY - 21);
  // Right column (mirror)
  seg(72, baseY,      76, baseY - 7);
  seg(76, baseY - 7,  68, baseY - 14);
  seg(68, baseY - 14, 74, baseY - 21);
}

void drawSplash() {
  display.setTextColor(SSD1306_WHITE);

  // Phase 1: nose appears in the centre of the screen
  display.clearDisplay();
  splashNose(22);
  display.display();
  delay(550);

  // Phase 2: sniff animation — waves rise from nostrils (4 frames)
  for (int f = 0; f < 4; f++) {
    display.clearDisplay();
    splashNose(22);
    splashSniff(21 - f * 5);   // base of wave moves upward each frame
    display.display();
    delay(300);
  }

  // Phase 3: nose slides up, welcome text fades in below
  display.clearDisplay();
  splashNose(8);               // nose near top of screen
  display.setTextSize(1);
  display.setCursor(34, 40);   // "Welcome to" — 10 chars x 6px = 60px, centred
  display.print(F("Welcome to"));
  display.setCursor(7, 52);    // "SniffMaster Pro" — 15 chars x 6px = 90px, centred
  display.print(F("SniffMaster Pro"));
  display.display();
  delay(2500);
}

// ══════════════════════════════════════════════════════════════
// Section 24: OLED Pages (in page order)
// ══════════════════════════════════════════════════════════════

static void renderBootStatusPage() {
  display.clearDisplay();
  const char* badge = calibrationBadgeText(latestIAQAccuracy, latestStabStatus, latestRunInStatus);
  drawHeader("-- Starting Up --", badge);
  display.setTextSize(1);

  const char* cal = calibrationStatusText(latestIAQAccuracy, latestStabStatus, latestRunInStatus);
  display.setCursor(0, 12);
  display.print(cal);

  display.setCursor(0, 21);
  if (homeBase.ready) {
    display.print(F("Room baseline loaded"));
  } else if (calState.bsecStateLoaded) {
    display.print(F("Warm resume in progress"));
  } else if (latestIAQAccuracy > 0 || latestRunInStatus > 0.0f) {
    display.print(F("Building room baseline"));
  } else {
    display.print(F("Waiting for first sensor packet"));
  }

  display.setCursor(0, 30);
  if (WiFi.status() == WL_CONNECTED) {
    display.print(F("Wi-Fi: "));
    display.print(WiFi.SSID());
  } else {
    display.print(F("Wi-Fi: reconnecting"));
  }

  const BlePresenceSnapshot &ble = blePresenceGetSnapshot();
  display.setCursor(0, 39);
  display.print(F("Presence: "));
  if (!ble.enabled) {
    display.print(F("standby"));
  } else {
    display.print(blePresenceStateLabel(ble.state));
  }
  if (ble.matchedName[0]) {
    display.print(F(" "));
    display.print(ble.matchedName);
  } else if (!ble.targetConfigured) {
    display.print(F(" standby"));
  }

  display.setCursor(0, 48);
  display.print(F("Portal: "));
#ifdef USE_WEB_DASHBOARD
  if (WiFi.status() != WL_CONNECTED) {
    display.print(F("offline"));
  } else if (lastWebPostMillis == 0) {
    display.print(F("first sync pending"));
  } else {
    display.print(F("linked"));
  }
#else
  display.print(F("disabled"));
#endif

  display.setCursor(0, 57);
  display.print(F("Up "));
  display.print(millis() / 1000UL);
  display.print(F("s"));

  display.display();
}

// ── Page 0 — Air Quality ─────────────────────────────────────────────────────
void renderAirQualityPage(uint8_t tier, float voc, float iaq, int airScore,
                          uint8_t iaqAcc, const uint8_t scores[ODOR_COUNT]) {
  display.clearDisplay();
  const char* badge = calibrationBadgeText(iaqAcc, ss_stabStatus, ss_runInStatus);
  drawHeader("-- Air Quality --", badge);
  display.setTextSize(1);

  // IAQ line: "IAQ: 120 Moderate" with quality label
  char buf[22];
  snprintf(buf, sizeof(buf), "IAQ: %.0f %s", iaq, iaqQuality(iaq));
  display.setCursor(0, 12);
  display.print(buf);

  // Air Score bar (combines IAQ + VOC into 0-100)
  display.setCursor(0, 22);
  snprintf(buf, sizeof(buf), "Air Score: %d/100", airScore);
  display.print(buf);

  // Score bar — inverted when score is bad (>=70)
  if (airScore >= 70) {
    display.fillRect(0, 31, SCREEN_WIDTH, 5, SSD1306_WHITE);
    int emptyW = SCREEN_WIDTH - map(airScore, 0, 100, 0, SCREEN_WIDTH);
    if (emptyW > 0) display.fillRect(SCREEN_WIDTH - emptyW, 31, emptyW, 5, SSD1306_BLACK);
  } else {
    drawBar(0, 31, SCREEN_WIDTH, 5, airScore);
  }

  // Smell tier
  display.setCursor(0, 38);
  snprintf(buf, sizeof(buf), "Smell: %d/5 %s", tier, tierDesc(tier));
  display.print(buf);

  display.drawFastHLine(0, 47, SCREEN_WIDTH, SSD1306_WHITE);

  // Detected odor
  if (!bsecCalibrationReady(iaqAcc)) {
    display.setCursor(0, 49);
    display.print(calibrationStatusText(iaqAcc, ss_stabStatus, ss_runInStatus));
    display.setCursor(0, 57);
    if (homeBase.ready) display.print(F("Odor logic almost ready"));
    else display.print(F("Building gas baseline"));
  } else {
    uint8_t i1, i2;
    topTwo(scores, i1, i2);
    if (scores[i1] >= ODOR_MIN_CONF) {
      display.setCursor(0, 49);
      snprintf(buf, sizeof(buf), "Detected: %s %d%%", odorNames[i1], scores[i1]);
      display.print(buf);
    } else {
      display.setCursor(0, 49);
      display.print(F("Detected: Clean Air"));
    }
    if (scores[i2] >= ODOR_MIN_CONF) {
      display.setCursor(0, 57);
      snprintf(buf, sizeof(buf), "  Also: %s %d%%", odorNames[i2], scores[i2]);
      display.print(buf);
    }
  }
  display.display();
}

// ── Page 1 — Smart Smell Assessment ──────────────────────────────────────────

// Returns 0=ALL CLEAR, 1=SUBTLE, 2=NOTICEABLE, 3=AIR IT OUT, 4=EVACUATE!
static uint8_t verdictLevel(const uint8_t scores[ODOR_COUNT], int airScore) {
  uint8_t i1, i2;
  topTwo(scores, i1, i2);
  uint8_t conf = scores[i1];
  if (conf < ODOR_MIN_CONF) {
    if (airScore < 15) return 0;
    if (airScore < 35) return 1;
    return 2;
  }
  uint8_t concern = ODOR_CONCERN[i1];
  int cs = (int)concern * 20 + conf / 4 + airScore / 5;
  if (concern == 3 && conf >= 50) cs += 30;  // urgent odors escalate fast
  if (cs < 15) return 0;
  if (cs < 30) return 1;
  if (cs < 55) return 2;
  if (cs < 75) return 3;
  return 4;
}

// Returns \n-separated 2-line advice (each line <= 21 chars)
static const char* getAdvice(uint8_t topOdor, uint8_t conf, uint8_t level) {
  if (level == 0) {
    if (conf >= ODOR_MIN_CONF && topOdor == 9) return "Coffee detected.\nSmells amazing!";
    if (conf >= ODOR_MIN_CONF && topOdor == 8) return "Something cooking.\nSmells good!";
    return "Fresh air here.\nNo action needed.";
  }
  if (level == 1) {
    if (topOdor == 9) return "Hint of coffee.\nSmells nice!";
    if (topOdor == 8) return "Something cooking?\nSmells good.";
    if (topOdor == 5) return "Cleaning products.\nFaint whiff.";
    return "Faint whiff detected.\nNothing alarming.";
  }
  // level 2+
  switch (topOdor) {
    case OD_FART:      return "Cut the cheese!\nOpen a window.";
    case OD_MUSTY:     return "Check for mold.\nVentilate area.";
    case OD_CIGARETTE: return "Cigarette smoke.\nVentilate area.";
    case OD_ALCOHOL:   return "Alcohol smell.\nRoom airing out?";
    case OD_WEED:      return "Smoke in here.\nOpen the windows.";
    case OD_CLEANING:  return "Cleaning products.\nDont mix bleach!";
    case OD_GASOLINE:  return "GAS DETECTED!\nGet outside now!";
    case OD_SMOKE:     return "Smoke detected!\nCheck for fire!";
    case OD_COOKING:   return "Cooking smells.\nVent the kitchen.";
    case OD_COFFEE:    return "Coffee detected.\nSmells amazing!";
    case OD_GARBAGE:   return "Take out trash!\nGarbage smell.";
    case OD_SWEAT:     return "BO detected.\nSomeone shower up!";
    case OD_PERFUME:   return "Strong perfume.\nMaybe ease up?";
    case OD_LAUNDRY:   return "Laundry smell.\nFresh but strong.";
    case OD_SULFUR:    return "Sulfur detected.\nCheck drains now.";
    case OD_SOLVENT:   return "Solvent fumes.\nVentilate fast.";
    case OD_PET:       return "Pet odor here.\nCheck litter box.";
    case OD_SOUR:      return "Sour food smell.\nCheck the fridge.";
    case OD_BURNT:     return "Burnt oil smell.\nCheck the stove.";
    case OD_CITRUS:    return "Citrus detected.\nBright and strong.";
    default: return "Unknown odor.\nConsider airing out.";
  }
}

// Verdict label strings (centered on 128px display)
static const char* const VERDICT_LABEL[] = {
  "ALL CLEAR", "SUBTLE", "NOTICEABLE", "AIR IT OUT!", "EVACUATE!"
};

void renderOdorDetailPage(const uint8_t scores[ODOR_COUNT], int airScore, uint8_t iaqAcc) {
  display.clearDisplay();
  drawHeader("-- Odor Detail --");
  display.setTextSize(1);

  uint8_t i1, i2;
  topTwo(scores, i1, i2);
  uint8_t level = verdictLevel(scores, airScore);

  // Primary detected odor
  char buf[24];
  display.setCursor(0, 11);
  if (scores[i1] >= ODOR_MIN_CONF) {
    snprintf(buf, sizeof(buf), "Detected: %s %d%%", odorNames[i1], scores[i1]);
  } else {
    snprintf(buf, sizeof(buf), "Detected: Clean Air");
  }
  display.print(buf);

  // Secondary odor
  display.setCursor(0, 20);
  if (scores[i2] >= ODOR_MIN_CONF) {
    snprintf(buf, sizeof(buf), "Also: %s %d%%", odorNames[i2], scores[i2]);
    display.print(buf);
  } else if (!bsecCalibrationReady(iaqAcc)) {
    display.print(calibrationStatusText(iaqAcc, ss_stabStatus, ss_runInStatus));
  } else if (!homeBase.ready) {
    display.print(F("(learning room baseline)"));
  }

  // Divider
  display.drawFastHLine(0, 29, SCREEN_WIDTH, SSD1306_WHITE);

  // Verdict banner (inverted box for urgent levels)
  const char* label = VERDICT_LABEL[level];
  int labelW = strlen(label) * 6;
  int labelX = (SCREEN_WIDTH - labelW) / 2;
  if (level >= 3) {
    display.fillRect(0, 30, SCREEN_WIDTH, 11, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
    display.setCursor(labelX, 31);
    display.print(label);
    display.setTextColor(SSD1306_WHITE);
  } else {
    display.setCursor(labelX, 31);
    display.print(label);
  }

  // Divider
  display.drawFastHLine(0, 42, SCREEN_WIDTH, SSD1306_WHITE);

  // Advice (2 lines via drawWrappedSentence)
  drawWrappedSentence(getAdvice(i1, scores[i1], level), 44);

  display.display();
}

// ── Page 2 — Environment ──────────────────────────────────────────────────────
static const char* const accLabelSerial[] = { "warming", "low", "medium", "high" };

void renderEnvPage(float tempF, float hum, float pressureRaw,
                   float co2, float voc, float iaq, uint8_t iaqAcc) {
  display.clearDisplay();
  drawHeader("-- Environment --");
  display.setTextSize(1);
  char buf[22];

  float hpa = pressToHpa(pressureRaw);

  snprintf(buf, sizeof(buf), "Temp   %.1fF", tempF);
  display.setCursor(0, 11); display.print(buf);

  snprintf(buf, sizeof(buf), "Humid  %.1f %%RH", hum);
  display.setCursor(0, 20); display.print(buf);

  snprintf(buf, sizeof(buf), "Press  %.1f hPa", hpa);
  display.setCursor(0, 29); display.print(buf);

  snprintf(buf, sizeof(buf), "CO2eq  %.0f ppm", co2);
  display.setCursor(0, 38); display.print(buf);

  snprintf(buf, sizeof(buf), "VOCeq  %.1f ppm", voc);
  display.setCursor(0, 47); display.print(buf);

  // IAQ with quality label and bar
  display.setCursor(0, 56);
  snprintf(buf, sizeof(buf), "IAQ %.0f %s", iaq, iaqQuality(iaq));
  display.print(buf);
  int barX = strlen(buf) * 6 + 2;
  int barW = SCREEN_WIDTH - barX;
  if (barW > 10) {
    int iaqFill = map(constrain((int)iaq, 0, 500), 0, 500, 0, barW - 2);
    display.drawRect(barX, 56, barW, 7, SSD1306_WHITE);
    if (iaqFill > 0) display.fillRect(barX + 1, 57, iaqFill, 5, SSD1306_WHITE);
  }

  display.display();
}

// ── Page 3 — Gas Analysis ────────────────────────────────────────────────────
void renderGasAnalysisPage(float voc, float iaq, float co2, float gasR,
                           float dvoc, uint8_t iaqAcc,
                           const char* iaqTrend, const char* vocTrend) {
  display.clearDisplay();
  drawHeader("-- Gas Analysis --");
  display.setTextSize(1);
  char buf[22];
  float gasRk = gasR / 1000.0f;

  // VOC with trend and meaning
  const char* vt = (vocTrend[0] == 'r') ? "^" : (vocTrend[0] == 'f') ? "v" : "=";
  snprintf(buf, sizeof(buf), "VOC %.1f %s", voc, vt);
  display.setCursor(0, 11); display.print(buf);
  // Right-justified interpretation
  const char* vocNote = (voc < 0.5f) ? "clean" : (voc < 2.0f) ? "normal" :
                        (voc < 5.0f) ? "elevated" : (voc < 15.0f) ? "HIGH" : "DANGER";
  int vnw = strlen(vocNote) * 6;
  display.setCursor(SCREEN_WIDTH - vnw, 11); display.print(vocNote);

  // CO2 with meaning
  snprintf(buf, sizeof(buf), "CO2 %.0f", co2);
  display.setCursor(0, 20); display.print(buf);
  const char* co2Note = (co2 < 500) ? "fresh air" : (co2 < 800) ? "occupied" :
                        (co2 < 1200) ? "stuffy" : (co2 < 2000) ? "VENTILATE" : "DANGER";
  int cnw = strlen(co2Note) * 6;
  display.setCursor(SCREEN_WIDTH - cnw, 20); display.print(co2Note);

  // GasR with meaning — this is the key diagnostic
  snprintf(buf, sizeof(buf), "GasR %.0fk", gasRk);
  display.setCursor(0, 29); display.print(buf);
  const char* gasNote = (gasRk > 300.0f) ? "baseline" : (gasRk > 100.0f) ? "normal" :
                        (gasRk > 50.0f)  ? "mild gas" :
                        (gasRk > 20.0f)  ? "active" : "HEAVY";
  int gnw = strlen(gasNote) * 6;
  display.setCursor(SCREEN_WIDTH - gnw, 29); display.print(gasNote);

  // dVOC — rate of change indicates event timing
  snprintf(buf, sizeof(buf), "dVOC %.1f", dvoc);
  display.setCursor(0, 38); display.print(buf);
  const char* dNote = (dvoc < 1.0f) ? "steady" : (dvoc < 5.0f) ? "changing" :
                      (dvoc < 15.0f) ? "SPIKE" : "RAPID";
  int dnw = strlen(dNote) * 6;
  display.setCursor(SCREEN_WIDTH - dnw, 38); display.print(dNote);

  display.drawFastHLine(0, 47, SCREEN_WIDTH, SSD1306_WHITE);

  // IAQ with trend
  const char* it = (iaqTrend[0] == 'r') ? "^" : (iaqTrend[0] == 'f') ? "v" : "=";
  snprintf(buf, sizeof(buf), "IAQ %.0f %s %s", iaq, iaqQuality(iaq), it);
  display.setCursor(0, 49); display.print(buf);

  // Bottom line: sensor calibration + room verdict
  display.setCursor(0, 57);
  if (!bsecCalibrationReady(iaqAcc)) {
    display.print(calibrationStatusText(iaqAcc, ss_stabStatus, ss_runInStatus));
  } else if (!homeBase.ready) {
    display.print(F("Learning room baseline"));
  } else {
    // Fully calibrated — show a room summary instead
    const char* room = (iaq < 25 && voc < 0.5f) ? "Pristine air" :
                       (iaq < 50)  ? "Fresh room" :
                       (iaq < 100) ? "Normal room" :
                       (iaq < 200) ? "Open a window" : "Ventilate now!";
    display.print(room);
  }

  display.display();
}

// ── Page 4 — Smell Sentence ───────────────────────────────────────────────────
void renderSmellSentencePage(const uint8_t scores[ODOR_COUNT],
                             int airScore, uint8_t iaqAcc) {
  display.clearDisplay();
  drawHeader("-- Smell Quip --");
  display.setTextSize(1);

  uint8_t i1, i2;
  topTwo(scores, i1, i2);

  // Use GPT quip if available, otherwise fall back to static sentences
  if (dcSmellQuip[0]) {
    drawWrappedSentence(dcSmellQuip, 12);
  } else {
    uint8_t odorIdx  = (scores[i1] >= ODOR_MIN_CONF) ? i1 : CLEAN_AIR_SENTENCE_IDX;
    uint8_t scoreTier = (airScore < 41) ? 0 : (airScore < 70) ? 1 : 2;
    drawWrappedSentence(SMELL_SENTENCES[odorIdx][scoreTier], 12);
  }

  display.display();
}

// ── Page 1 — Network Status ─────────────────────────────────────────────────
void renderNetworkPage() {
  display.clearDisplay();
  drawHeader("-- Network --");
  display.setTextSize(1);
  char buf[22];

  wl_status_t wst = WiFi.status();

  if (wst == WL_CONNECTED) {
    // Line 1: SSID
    String ssid = WiFi.SSID();
    if (ssid.length() > 21) ssid = ssid.substring(0, 21);
    display.setCursor(0, 12);
    display.print(ssid);

    // Line 2: IP address
    display.setCursor(0, 21);
    display.print(WiFi.localIP());

    // Line 3: RSSI + signal quality bar
    int rssi = WiFi.RSSI();
    int sigQ = constrain(map(rssi, -90, -30, 0, 100), 0, 100);
    display.setCursor(0, 30);
    snprintf(buf, sizeof(buf), "%ddBm", rssi);
    display.print(buf);
    // Signal quality bar + percentage (right-aligned, no overlap)
    int barW = map(sigQ, 0, 100, 0, 38);
    display.drawRect(60, 30, 38, 7, SSD1306_WHITE);
    if (barW > 0) display.fillRect(60, 30, barW, 7, SSD1306_WHITE);
    snprintf(buf, sizeof(buf), "%d%%", sigQ);
    display.setCursor(102, 30);
    display.print(buf);

    // Line 4: Channel + cloud status
    display.setCursor(0, 39);
    snprintf(buf, sizeof(buf), "Ch:%d", WiFi.channel());
    display.print(buf);

    // Cloud sync age
    display.setCursor(50, 39);
    if (lastWebPostMillis > 0) {
      unsigned long ago = (millis() - lastWebPostMillis) / 1000UL;
      if (ago < 60) snprintf(buf, sizeof(buf), "Sync:%lus", ago);
      else          snprintf(buf, sizeof(buf), "Sync:%lum", ago / 60);
    } else {
      strcpy(buf, "Sync:pending");
    }
    display.print(buf);

    // Line 5: BLE presence
    display.setCursor(0, 48);
    const BlePresenceSnapshot &ble = blePresenceGetSnapshot();
    if (!ble.enabled) {
      display.print(F("BLE: standby"));
    } else {
      snprintf(buf, sizeof(buf), "BLE:%s %d%%",
               blePresenceStateLabel(ble.state), ble.confidence);
      display.print(buf);
    }

    // Line 6: Heap + uptime
    display.setCursor(0, 57);
    unsigned long up = millis() / 1000UL;
    snprintf(buf, sizeof(buf), "Heap:%uK Up:%lum",
             ESP.getFreeHeap() / 1024, up / 60);
    display.print(buf);
  } else {
    // WiFi disconnected
    display.setCursor(0, 15);
    display.print(F("WiFi: DISCONNECTED"));
    display.setCursor(0, 27);
    switch (wst) {
      case WL_NO_SSID_AVAIL: display.print(F("No SSID found")); break;
      case WL_CONNECT_FAILED: display.print(F("Connect failed")); break;
      case WL_IDLE_STATUS:   display.print(F("Idle / scanning")); break;
      case WL_DISCONNECTED:  display.print(F("Disconnected")); break;
      default:
        snprintf(buf, sizeof(buf), "Status: %d", (int)wst);
        display.print(buf);
    }
    display.setCursor(0, 39);
    display.print(F("Attempting reconnect"));

    display.setCursor(0, 51);
    unsigned long up = millis() / 1000UL;
    snprintf(buf, sizeof(buf), "Heap:%uK Up:%lum",
             ESP.getFreeHeap() / 1024, up / 60);
    display.print(buf);
  }

  display.display();
}

// ── Page 6 — Fart Tracker ────────────────────────────────────────────────────
void renderFartTrackerPage() {
  display.clearDisplay();
  drawHeader("-- Fart Tracker --");
  display.setTextSize(1);
  char buf[22];

  // Daily count — big number
  display.setTextSize(2);
  display.setCursor(0, 12);
  display.print(fartCount);
  display.setTextSize(1);
  display.setCursor(fartCount >= 10 ? 30 : 18, 14);
  display.print(F("farts today"));

  display.drawFastHLine(0, 29, SCREEN_WIDTH, SSD1306_WHITE);

  // Biggest spike
  display.setCursor(0, 32);
  if (biggestFartVoc > 0) {
    snprintf(buf, sizeof(buf), "Worst VOC: %.1f ppm", biggestFartVoc);
    display.print(buf);
  } else {
    display.print(F("No farts yet. Stay"));
    display.setCursor(0, 41);
    display.print(F("tuned. Or not."));
    display.display();
    return;
  }

  // Fun rating
  display.setCursor(0, 42);
  if (fartCount == 0)       display.print(F("Rating: Saint"));
  else if (fartCount <= 3)  display.print(F("Rating: Human"));
  else if (fartCount <= 7)  display.print(F("Rating: Gassy"));
  else if (fartCount <= 12) display.print(F("Rating: Hazardous"));
  else                      display.print(F("Rating: BIOHAZARD"));

  // Uptime
  unsigned long upMin = millis() / 60000UL;
  display.setCursor(0, 55);
  snprintf(buf, sizeof(buf), "Tracking: %luh %lum", upMin / 60, upMin % 60);
  display.print(buf);

  display.display();
}

// ── Page 6 — Weather ─────────────────────────────────────────────────────────
void renderWeatherPage() {
  display.clearDisplay();
  drawHeader("-- Weather --");
  display.setTextSize(1);

  if (WiFi.status() != WL_CONNECTED) {
    display.setCursor(0, 22);
    display.print(F("WiFi offline."));
    display.setCursor(0, 32);
    display.print(F("Check connection."));
    display.display();
    return;
  }

  // Fetch if missing or stale
  if (!weather.valid || millis() - weather.fetchTime >= WEATHER_REFRESH_MS) {
    queueWeatherCloudTasks();
    display.setCursor(0, 22);
    display.print(F("Refreshing weather..."));
    display.display();
    return;
  }

  if (!weather.valid) {
    display.setCursor(0, 22);
    display.print(F("Weather unavailable"));
    display.display();
    return;
  }

  char buf[22];

  // Temperature + feels like
  snprintf(buf, sizeof(buf), "%dF feels %dF", weather.tempF, weather.feelsLikeF);
  display.setCursor(0, 12); display.print(buf);

  // Condition
  char cond[22];
  strncpy(cond, weather.condition, 21); cond[21] = '\0';
  display.setCursor(0, 21); display.print(cond);

  // Wind: direction + speed
  display.setCursor(0, 30);
  snprintf(buf, sizeof(buf), "Wind: %s %s", weather.windDir, weather.windSpeed);
  display.print(buf);

  // Humidity
  snprintf(buf, sizeof(buf), "Humidity: %d%%", weather.humidity);
  display.setCursor(0, 39); display.print(buf);

  // Outdoor AQI / PM2.5 (from web)
  display.setCursor(0, 48);
  if (outdoorAqi.valid) {
    snprintf(buf, sizeof(buf), "AQI:%d PM2.5:%.0f %s",
             outdoorAqi.aqi, outdoorAqi.pm25, outdoorAqi.level);
    display.print(buf);
  } else {
    display.print(F("AQI: loading..."));
  }

  // Moon phase
  display.setCursor(0, 57);
  struct tm t;
  if (getLocalTime(&t)) {
    int mDay = moonAge(t.tm_year + 1900, t.tm_mon + 1, t.tm_mday);
    int illum = moonIllumPct(mDay);
    snprintf(buf, sizeof(buf), "%s %d%%", moonPhaseName(mDay), illum);
    display.print(buf);
  }

  display.display();
}

// ── Page LAUNCHES — KSC/CCSFS launches + today in space history ─────────────
void renderLaunchPage() {
  display.clearDisplay();
  drawHeader("-- Launches --");
  display.setTextSize(1);
  char histLong[96];
  char histShort[32];
  getTodaySpaceHistory(histShort, sizeof(histShort), histLong, sizeof(histLong));

  if (WiFi.status() != WL_CONNECTED) {
    display.setCursor(0, 22); display.print(F("WiFi offline"));
    display.setCursor(0, 38);
    display.print(F("History:"));
    display.setCursor(0, 47);
    display.print(histShort);
    display.display();
    return;
  }

  bool stale = !launchFetchTime || millis() - launchFetchTime >= LAUNCH_REFRESH_MS;
  if (launchCount == 0 || stale) {
    queueLaunchCloudTasks();
    display.setCursor(0, 22); display.print(F("Fetching launches..."));
    display.display();
    return;
  }

  // YTD count header bar
  int y = 12;
  if (launchCount == 0) {
    display.setCursor(0, 22); display.print(F("No launches found"));
    y = 32;
  }
  if (launchesYTD > 0) {
    char ytdBuf[22];
    struct tm tL;
    int yr = 2026;
    if (getLocalTime(&tL)) yr = tL.tm_year + 1900;
    snprintf(ytdBuf, sizeof(ytdBuf), "%d KSC launches in %d", launchesYTD, yr);
    display.setCursor(0, y);
    display.print(ytdBuf);
    y += 10;
    display.drawFastHLine(0, y, SCREEN_WIDTH, SSD1306_WHITE);
    y += 2;
  }

  const int maxRows = (launchesYTD > 0) ? 2 : 3;
  for (int i = 0; i < launchCount && i < maxRows && y < 40; i++) {
    char name[22];
    char timeShort[16];
    strncpy(name, launches[i].name, 8); name[8] = '\0';
    fmtLaunchTimeBrief(launches[i].time, timeShort, sizeof(timeShort));
    display.setCursor(0, y);
    char row[28];
    snprintf(row, sizeof(row), "%d. %-8s %s", i + 1, name, timeShort);
    display.print(row);
    y += 9;
  }

  display.drawFastHLine(0, y, SCREEN_WIDTH, SSD1306_WHITE);
  y += 2;
  display.setCursor(0, y);
  display.print(F("History:"));
  y += 9;
  display.setCursor(0, y);
  display.print(histShort);

  display.display();
}

// ── Page DAD_JOKE — Dad Joke (triple-press only) ─────────────────────────────

static void _drawJokeFrame(char lines[][22], int numLines, int pxOff) {
  display.clearDisplay();
  drawHeader("-- Dad Joke --");
  display.setTextSize(1);
  const int viewTop = 11;
  const int lineH   = 9;
  for (int li = 0; li < numLines; li++) {
    int y = viewTop + li * lineH - pxOff;
    if (y > viewTop - lineH && y < SCREEN_HEIGHT) {
      display.setCursor(0, y);
      display.print(lines[li]);
    }
  }
  display.display();
}

static bool waitResponsive(unsigned long ms) {
  unsigned long endMs = millis() + ms;
  while ((long)(millis() - endMs) < 0) {
    if (digitalRead(BTN_PIN) == LOW) return true;
    envSensor.run();
    melTick();
    blePresenceTick();
    delay(20);
  }
  return false;
}

void renderDadJokePage() {
  if (!dadJokeReady) {
    display.clearDisplay();
    drawHeader("-- Dad Joke --");
    display.setTextSize(1);
    display.setCursor(0, 22);
    display.print(F("Fetching joke..."));
    display.display();
    return;
  }

  char lines[12][22];
  int numLines = 0;
  {
    int off = 0;
    while (dadJokeText[off] && numLines < 12)
      off = wrapLine(dadJokeText, off, lines[numLines++]);
  }

  const int lineH    = 9;
  const int viewTop  = 11;
  const int scrollEnd = max(0, numLines * lineH - (SCREEN_HEIGHT - viewTop));

  // Show first frame, pause 1.5s before scrolling
  _drawJokeFrame(lines, numLines, 0);
  unsigned long t0 = millis();
  while (millis() - t0 < 1500UL) {
    if (digitalRead(BTN_PIN) == LOW) { displayPage = 0; forceRedraw = true; return; }
    envSensor.run();
    melTick();
    blePresenceTick();
    delay(40);
  }

  // Scroll up 1px per frame
  for (int sc = 1; sc <= scrollEnd; sc++) {
    _drawJokeFrame(lines, numLines, sc);
    if (digitalRead(BTN_PIN) == LOW) { displayPage = 0; forceRedraw = true; return; }
    envSensor.run();
    melTick();
    blePresenceTick();
    delay(30);
  }

  // Hold at end 2.5s then auto-return
  unsigned long t1 = millis();
  while (millis() - t1 < 2500UL) {
    if (digitalRead(BTN_PIN) == LOW) break;
    envSensor.run();
    melTick();
    blePresenceTick();
    delay(40);
  }
  displayPage = 0;
  forceRedraw = true;
}

// ══════════════════════════════════════════════════════════════
// Section 25: Special Modes
//   runBreathChecker, runParanormalScan
// ══════════════════════════════════════════════════════════════

// ── Presence Probe ───────────────────────────────────────────────────────────
void runPresenceProbe() {
  unsigned long showUntil = millis() + 5000UL;
  unsigned long nextRedraw = 0;

  while (millis() < showUntil) {
    envSensor.run();
    melTick();
    blePresenceTick();
    if (digitalRead(BTN_PIN) == LOW) break;

    unsigned long now = millis();
    if (now >= nextRedraw) {
      nextRedraw = now + 250UL;
      const BlePresenceSnapshot &ble = blePresenceGetSnapshot();
      char buf[24];

      display.clearDisplay();
      drawHeader("-- Presence Probe --");
      display.setTextSize(1);

      snprintf(buf, sizeof(buf), "State: %s", blePresenceStateLabel(ble.state));
      display.setCursor(0, 12); display.print(buf);

      snprintf(buf, sizeof(buf), "Conf: %u%%  RSSI:%d", ble.confidence, ble.lastRssi);
      display.setCursor(0, 21); display.print(buf);

      snprintf(buf, sizeof(buf), "EMA:%.1f SD:%.1f", ble.emaRssi, ble.rssiStdDev);
      display.setCursor(0, 30); display.print(buf);

      display.setCursor(0, 39);
      display.print(blePresenceBreathReady() ? F("Breath-ready: yes") : F("Breath-ready: no"));

      display.setCursor(0, 48);
      if (ble.matchedName[0]) {
        display.print(ble.matchedName);
      } else {
        display.print(F("No target matched"));
      }

      display.setCursor(0, 57);
      if (ble.seenRecently) {
        display.print(F("Live BLE presence"));
      } else {
        display.print(F("Waiting for advertiser"));
      }

      display.display();
    }
    delay(20);
  }
}

// ── Breath Checker ────────────────────────────────────────────────────────────
void runBreathChecker() {
  // 5-second countdown — poll sensor at full rate, redraw only when digit changes
  unsigned long countdownEnd = millis() + 5000UL;
  int lastDisplayedSec = -1;
  while (millis() < countdownEnd) {
    int secLeft = (int)((countdownEnd - millis() + 999UL) / 1000UL);
    secLeft = constrain(secLeft, 1, 5);
    if (secLeft != lastDisplayedSec) {
      lastDisplayedSec = secLeft;
      display.clearDisplay();
      drawHeader("-- Breath Check --");
      display.setTextSize(1);
      display.setCursor(0, 13);
      display.print(F("Blow on sensor now!"));
      display.setCursor(54, 26);
      display.setTextSize(2);
      display.print(secLeft);
      display.setTextSize(1);
      display.setCursor(0, 52);
      display.print(F("Hold steady..."));
      display.display();
    }
    envSensor.run();   // poll as fast as possible — BME688 delivers new data ~every 3s
    melTick();         // keep any background melody alive
    blePresenceTick();
    delay(20);
  }

  // Capture latest sensor values
  float bVoc  = latestVocRaw;
  float bIaq  = latestIAQ;
  float bCo2  = latestCO2;
  float bTmpC = latestTemp;
  float bHum  = latestHumidity;
  float bPres = latestPressure;
  float bGasR = latestGasR;
  uint8_t bAcc = latestIAQAccuracy;
  float bTmpF = bTmpC * 9.0f / 5.0f + 32.0f;

  uint8_t bScores[ODOR_COUNT];
#ifdef USE_ML_SCORING
  scoreOdors(bVoc, bIaq, bCo2, bTmpF, bHum, pressToHpa(bPres), bGasR, 0.0f, bScores); // ML: 9 args
#else
  scoreOdors(bVoc, bIaq, bCo2, 0.0f, bGasR, bScores);   // heuristic: 6 args (no tempF/hum/press)
#endif

  // Determine verdict
  const char* verdict;
  const char* advice;
  bool isUrgent = false;

  if (!bsecCalibrationReady(bAcc)) {
    verdict = calState.bsecStateLoaded ? "SENSOR RESTORING" : "SENSOR WARMING";
    advice = calState.bsecStateLoaded
           ? "Restoring saved gas\nmodel. Try again\nvery shortly."
           : "BME688 still settling.\nTry again in a bit.";
  } else if (bScores[3] > 50) {                  // Alcohol
    verdict = "BOOZY BREATH!";
    advice = "Drink some water.\nMaybe slow down.";
    isUrgent = true;
  } else if (bScores[0] > 45) {                   // Fart/sulfur
    verdict = "WHAT DID YOU EAT?!";
    advice = "Brush your teeth.\nSee a doctor.";
    isUrgent = true;
  } else if (bVoc < 1.5f && bIaq < 75) {
    verdict = "Fresh Breath!";
    advice = "Smells great!\nNo action needed.";
  } else if (bVoc < 3.0f && bIaq < 125) {
    verdict = "Not Bad!";
    advice = "Pretty fresh.\nYou're good to go.";
  } else if (bVoc < 6.0f && bIaq < 200) {
    verdict = "Could Be Worse";
    advice = "Grab some gum.\nDrink more water.";
  } else if (bVoc < 10.0f && bIaq < 300) {
    verdict = "Grab Some Gum!";
    advice = "Brush soon.\nMint needed ASAP.";
    isUrgent = true;
  } else {
    verdict = "See a Dentist!";
    advice = "Brush & floss ASAP.\nBad breath detected.";
    isUrgent = true;
  }

  // Render result — page 1: verdict + metrics
  display.clearDisplay();
  drawHeader("-- Breathalyzer --");
  display.setTextSize(1);

  int labelW = strlen(verdict) * 6;
  int labelX = max(0, (SCREEN_WIDTH - labelW) / 2);
  if (isUrgent) {
    display.fillRect(0, 11, SCREEN_WIDTH, 12, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
    display.setCursor(labelX, 13);
    display.print(verdict);
    display.setTextColor(SSD1306_WHITE);
  } else {
    display.setCursor(labelX, 13);
    display.print(verdict);
  }

  char buf[22];
  // Breathalyzer metrics
  snprintf(buf, sizeof(buf), "VOC: %.1f ppm", bVoc);
  display.setCursor(0, 26); display.print(buf);

  snprintf(buf, sizeof(buf), "IAQ: %.0f %s", bIaq, iaqQuality(bIaq));
  display.setCursor(0, 35); display.print(buf);

  // Alcohol estimation: very rough — BME688 can't measure BAC directly,
  // but ethanol is a major VOC component of breath alcohol
  display.setCursor(0, 44);
  if (!bsecCalibrationReady(bAcc)) {
    display.print(calState.bsecStateLoaded
                ? F("Calibration: restore")
                : F("Calibration: warming"));
  } else if (bScores[3] > 60) {
    display.print(F("Alcohol: HIGH"));
  } else if (bScores[3] > 30) {
    display.print(F("Alcohol: Moderate"));
  } else {
    display.print(F("Alcohol: None/Low"));
  }

  // Gas resistance (higher = cleaner air)
  if (bGasR > 1000)
    snprintf(buf, sizeof(buf), "GasR: %.0fk Ohm", bGasR / 1000.0f);
  else
    snprintf(buf, sizeof(buf), "GasR: %.0f Ohm", bGasR);
  display.setCursor(0, 53); display.print(buf);

  if (!bsecCalibrationReady(bAcc)) {
    const char* badge = calibrationBadgeText(bAcc, latestStabStatus, latestRunInStatus);
    if (badge) {
      display.setCursor(80, 53);
      display.print(badge);
    }
  }

  display.display();

  // Hold page 1 briefly, but keep the device responsive
  waitResponsive(2800UL);

  // Page 2: advice
  display.clearDisplay();
  drawHeader("-- Breath Advice --");
  display.setTextSize(1);
  drawWrappedSentence(advice, 12);
  display.display();

  waitResponsive(2600UL);
}

// ── Paranormal Investigation (5x press) ──────────────────────────────────────
// Sends all sensor data to GPT with a paranormal investigation prompt and
// displays the result as a scrolling text report.
void runParanormalScan() {
  display.clearDisplay();
  drawHeader("-- Ghost Scan --");
  display.setTextSize(1);
  display.setCursor(0, 16);
  display.print(F("Scanning for"));
  display.setCursor(0, 26);
  display.print(F("paranormal activity..."));
  display.setCursor(0, 42);
  display.print(F("Analyzing EMF, VOC,"));
  display.setCursor(0, 52);
  display.print(F("temp anomalies..."));
  display.display();

  if (WiFi.status() != WL_CONNECTED) {
    waitResponsive(900UL);
    display.clearDisplay();
    drawHeader("-- Ghost Scan --");
    display.setCursor(0, 25);
    display.print(F("WiFi offline."));
    display.setCursor(0, 35);
    display.print(F("Ghosts are hiding."));
    display.display();
    waitResponsive(1800UL);
    return;
  }

  float hpa = pressToHpa(ss_pressure);
  static char prompt[512];
  snprintf(prompt, sizeof(prompt),
    "You are a paranormal investigator analyzing sensor data from a haunted location. "
    "Readings: Temp=%.1fF, Humidity=%.1f%%, Pressure=%.0fhPa, IAQ=%d, VOC=%.1fppm, "
    "CO2=%.0fppm, GasResistance=%.0fOhm. "
    "In character, report what supernatural entities may be present based on cold spots, "
    "unexplained gas fluctuations, pressure anomalies, and mysterious VOC spikes. "
    "Be dramatic and fun. Return JSON: {\"entity\":\"<ghost type max 15ch>\","
    "\"report\":\"<investigation findings max 90ch>\"}",
    ss_tempF, ss_hum, hpa, (int)ss_iaq, ss_voc, ss_co2, ss_gasR);

  static char esc[600];
  int ei = 0;
  for (int i = 0; prompt[i] && ei < 595; i++) {
    if (prompt[i] == '"' || prompt[i] == '\\') esc[ei++] = '\\';
    esc[ei++] = prompt[i];
  }
  esc[ei] = '\0';

  static char reqBody[1100];
  snprintf(reqBody, sizeof(reqBody),
    "{\"model\":\"%s\",\"max_tokens\":120,"
    "\"response_format\":{\"type\":\"json_object\"},"
    "\"messages\":["
      "{\"role\":\"system\",\"content\":\"You are a dramatic paranormal investigator. Always reply with ONLY a JSON object with keys entity and report.\"},"
      "{\"role\":\"user\",\"content\":\"%s\"}"
    "]}",
    OPENAI_MODEL, esc);

  if (melBusy()) melStop();  // silence buzzer before blocking GPT call
  WiFiClientSecure gptClient;
  gptClient.setInsecure();
  gptClient.setTimeout(5000);  // limit TLS handshake — prevents freeze on weak WiFi
  HTTPClient http;
  quietBleForCloud();
  http.setTimeout(7000);
  http.begin(gptClient, "https://api.openai.com/v1/chat/completions");
  http.addHeader("Content-Type",  "application/json");
  http.addHeader("Authorization", "Bearer " OPENAI_API_KEY);

  Serial.println(F("[Paranormal] Requesting scan..."));
  int code = http.POST(reqBody);

  char entity[20]  = "Unknown";
  char report[120] = "The spirits are silent... for now.";

  if (code == 200) {
    String body = http.getString();
    http.end();

    // Robust content extraction — matches main GPT parser patterns
    // Check for content:null first
    if (body.indexOf("\"content\":null") >= 0 || body.indexOf("\"content\": null") >= 0) {
      Serial.println(F("[Paranormal] content:null — model refused"));
    } else {
      // Find "content" within "message" object, handle spacing variants
      int mi = body.indexOf("\"message\"");
      int ci = -1;
      int ciLen = 0;
      if (mi >= 0) {
        int c1 = body.indexOf("\"content\":\"", mi);
        int c2 = body.indexOf("\"content\": \"", mi);
        if (c1 >= 0) { ci = c1; ciLen = 11; }
        else if (c2 >= 0) { ci = c2; ciLen = 12; }
      }
      if (ci < 0) { ci = body.indexOf("\"content\":\""); ciLen = 11; }
      if (ci < 0) { ci = body.indexOf("\"content\": \""); ciLen = 12; }

      if (ci >= 0) {
        ci += ciLen;
        char contentBuf[256];
        int cx = 0;
        for (int i = ci; i < (int)body.length() && cx < 254; i++) {
          char c = body[i];
          if (c == '\\' && i + 1 < (int)body.length()) {
            char nc = body[++i];
            if      (nc == '"')  contentBuf[cx++] = '"';
            else if (nc == 'n')  contentBuf[cx++] = ' ';
            else if (nc == '\\') contentBuf[cx++] = '\\';
            else if (nc == '/')  contentBuf[cx++] = '/';
            else                 contentBuf[cx++] = nc;
          } else if (c == '"') break;
          else if ((uint8_t)c >= 0x20 && (uint8_t)c < 0x80) contentBuf[cx++] = c;
        }
        contentBuf[cx] = '\0';

        char* js = strchr(contentBuf, '{');
        char* je = strrchr(contentBuf, '}');
        if (js && je && je > js) {
          *(je + 1) = '\0';
          StaticJsonDocument<512> doc;
          if (!deserializeJson(doc, js)) {
            strlcpy(entity, doc["entity"] | "Specter", sizeof(entity));
            strlcpy(report, doc["report"] | "Anomalous readings detected.", sizeof(report));
          }
        }
      }
    }
  } else {
    http.end();
  }

  Serial.printf("[Paranormal] Entity=%s  Report=%s\n", entity, report);

  if (code == 200) {
    lastParanormalScan.valid = true;
    strlcpy(lastParanormalScan.entity, entity, sizeof(lastParanormalScan.entity));
    strlcpy(lastParanormalScan.report, report, sizeof(lastParanormalScan.report));
    lastParanormalScan.uptimeSec = millis() / 1000UL;
    EVENT_PUSH();
  }

  // Display result
  display.clearDisplay();
  drawHeader("-- Ghost Scan --");
  display.setTextSize(1);

  // Entity name — inverted banner
  int ew = strlen(entity) * 6;
  int ex = max(0, (SCREEN_WIDTH - ew) / 2);
  display.fillRect(0, 11, SCREEN_WIDTH, 11, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setCursor(ex, 13);
  display.print(entity);
  display.setTextColor(SSD1306_WHITE);

  display.drawFastHLine(0, 23, SCREEN_WIDTH, SSD1306_WHITE);

  // Word-wrapped report
  char lines[4][22];
  int numLines = 0;
  int off = 0;
  while (report[off] && numLines < 4)
    off = wrapLine(report, off, lines[numLines++]);
  for (int li = 0; li < numLines; li++) {
    display.setCursor(0, 25 + li * 9);
    display.print(lines[li]);
  }
  display.display();

  waitResponsive(4000UL);
}

// ══════════════════════════════════════════════════════════════
// Section 26: Alert System
//   showAirAlert, checkAirAlerts, showFartAlert
// ══════════════════════════════════════════════════════════════

// Checks sensor readings and shows an OLED alert + beep when action is needed.
void showAirAlert(const char* title, const char* msg) {
  melStop();
  melStartAlert(1);  // SMOKE_ALERT — attention beep

  display.clearDisplay();
  // Inverted title banner
  display.fillRect(0, 0, SCREEN_WIDTH, 13, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  int tw = strlen(title) * 6;
  display.setCursor(max(0, (SCREEN_WIDTH - tw) / 2), 3);
  display.print(title);
  display.setTextColor(SSD1306_WHITE);

  drawWrappedSentence(msg, 18);
  display.display();

  waitResponsive(3200UL);
  forceRedraw = true;
}

void checkAirAlerts(float iaq, float voc, float co2, float hum,
                    const uint8_t scores[], uint8_t iaqAcc) {
  // Require at least ODOR_RUNTIME_ACC_MIN — acc 0/1 readings are unreliable
  // and can false-trigger smoke/gas alerts during warmup transients.
  if (!bsecCalibrationReady(iaqAcc)) return;
  if (millis() - lastAlertMs < ALERT_COOLDOWN_MS) return;

  const char* title = nullptr;
  const char* msg   = nullptr;

  if (scores[6] >= 40 || scores[7] >= 40) {
    title = "!! DANGER !!";
    msg   = "Smoke or gas detected!\nCheck source NOW.\nVentilate immediately.";
  } else if (iaq > 250) {
    title = "! POOR AIR !";
    msg   = "Air quality unhealthy.\nOpen windows now.\nConsider leaving area.";
  } else if (co2 > 1500) {
    title = "HIGH CO2";
    msg   = "CO2 level elevated.\nOpen a window.\nRoom needs fresh air.";
  } else if (iaq > 150) {
    title = "AIR GETTING STALE";
    msg   = "Air quality declining.\nConsider opening\na window soon.";
  } else if (voc > 5.0f) {
    title = "ELEVATED VOC";
    msg   = "Volatile compounds\nrising. Ventilate\nthe area.";
  } else if (hum > 75) {
    title = "HIGH HUMIDITY";
    msg   = "Humidity is high.\nUse dehumidifier or\nopen a window.";
  }

  // Outdoor AQI alert (handles both OWM 1-5 and EPA 0-500 scales)
  bool outdoorBad = outdoorAqi.valid &&
    ((outdoorAqi.aqi <= 5 && outdoorAqi.aqi >= 4) ||   // OWM: 4=Poor, 5=Very Poor
     (outdoorAqi.aqi > 5  && outdoorAqi.aqi > 150));    // EPA fallback: >150
  if (!title && outdoorBad) {
    title = "! OUTDOOR AQI !";
    msg   = "Outdoor air unhealthy.\nKeep windows closed.\nCheck for wildfires.";
  }

  if (!title) return;

  lastAlertMs = millis();
  EVENT_PUSH();  // event-driven: push air alert immediately
  Serial.printf("[ALERT] %s\n", title);
  showAirAlert(title, msg);
}

// ── Fart Alert ────────────────────────────────────────────────────────────────
static void showFartAlert() {
  static const char* const quips[] = {
    "Who dealt it?!", "Clear the area!", "Evacuate now!", "Someone's guilty..."
  };
  const char* quip = quips[esp_random() % 4];
  int qw = strlen(quip) * 6;

  unsigned long fartAlertEnd = millis() + 3000UL;
  int frame = 0;
  while (millis() < fartAlertEnd) {
    bool inv = (frame / 5) % 2 == 0;           // flip every 500ms
    display.clearDisplay();
    if (inv) display.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, SSD1306_WHITE);
    display.setTextColor(inv ? SSD1306_BLACK : SSD1306_WHITE);
    display.setTextSize(2);
    display.setCursor((SCREEN_WIDTH - 4 * 12) / 2, 8);
    display.print(F("FART"));
    display.setCursor((SCREEN_WIDTH - 6 * 12) / 2, 28);
    display.print(F("ALERT!"));
    display.setTextSize(1);
    display.setCursor(max(0, (SCREEN_WIDTH - qw) / 2), 52);
    display.print(quip);
    display.setTextColor(SSD1306_WHITE);
    display.display();
    envSensor.run(); melTick(); blePresenceTick();
    if (digitalRead(BTN_PIN) == LOW) break;
    delay(80);
    frame++;
  }
}

// ── 6-click: Fart Analysis Page ─────────────────────────────────────────────
void showFartAnalysis() {
  // Current fart likelihood — apply same gates as the live detector
  uint8_t fScore = ss_scores[OD_FART];
  uint8_t fi1, fi2;
  topTwo(ss_scores, fi1, fi2);
  bool fartPrimary = (fi1 == OD_FART);
  bool bioEv = (ss_scores[OD_SULFUR] >= 15 || ss_scores[OD_GARBAGE] >= 20 ||
                (ss_gasR / 1000.0f < 120.0f && ss_iaq > 60.0f));
  bool calibrated = bsecCalibrationReady(ss_iaqAcc);
  // Gate: must be calibrated AND (primary odor or bio evidence) for strong labels
  const char* severity;
  if (!calibrated)                            severity = "Uncalibrated";
  else if (fScore >= 65 && (fartPrimary || bioEv)) severity = "CONFIRMED";
  else if (fScore >= 40 && (fartPrimary || bioEv)) severity = "Likely";
  else if (fScore >= 40)                      severity = "Possible*";
  else if (fScore >= 20)                      severity = "Possible";
  else if (fScore >= 10)                      severity = "Faint";
  else                                        severity = "None";

  float gasRk = ss_gasR / 1000.0f;
  float gasDrop = (homeBase.ready && homeBase.gasR > 1000.0f)
                ? fmaxf(0.0f, (homeBase.gasR - ss_gasR) / homeBase.gasR) * 100.0f
                : 0.0f;

  // Page 1: Current analysis (5 seconds)
  display.clearDisplay();
  drawHeader("-- Fart Lab --");
  display.setTextSize(1);
  char buf[22];

  snprintf(buf, sizeof(buf), "Status: %s", severity);
  display.setCursor(0, 12); display.print(buf);

  snprintf(buf, sizeof(buf), "Fart score: %d%%", fScore);
  display.setCursor(0, 21); display.print(buf);

  snprintf(buf, sizeof(buf), "VOC: %.2f  dVOC: %.1f", ss_voc, ss_dvoc);
  display.setCursor(0, 30); display.print(buf);

  snprintf(buf, sizeof(buf), "IAQ: %.0f  GasR: %.0fk", ss_iaq, gasRk);
  display.setCursor(0, 39); display.print(buf);

  if (gasDrop > 1.0f) {
    snprintf(buf, sizeof(buf), "GasDrop: %.0f%%", gasDrop);
    display.setCursor(0, 48); display.print(buf);
  } else {
    display.setCursor(0, 48); display.print(F("GasDrop: baseline"));
  }

  // Verdict line
  display.setCursor(0, 57);
  if (fScore >= 65)      display.print(F("Evacuate immediately."));
  else if (fScore >= 40) display.print(F("Someone is sus."));
  else if (fScore >= 20) display.print(F("Could be cooking..."));
  else if (fScore >= 10) display.print(F("Barely a whisper."));
  else                   display.print(F("All clear. For now."));

  display.display();
  waitResponsive(3200UL);

  // Page 2: History + last event (5 seconds)
  display.clearDisplay();
  drawHeader("-- Fart History --");
  display.setTextSize(1);

  snprintf(buf, sizeof(buf), "Today: %d farts", fartCount);
  display.setCursor(0, 12); display.print(buf);

  if (biggestFartVoc > 0.5f) {
    snprintf(buf, sizeof(buf), "Peak VOC: %.1f ppm", biggestFartVoc);
    display.setCursor(0, 21); display.print(buf);
  } else {
    display.setCursor(0, 21); display.print(F("No events today"));
  }

  if (lastFartEvent.valid) {
    unsigned long ago = (millis() - lastFartEvent.ms) / 60000UL;
    snprintf(buf, sizeof(buf), "Last: %lum ago (%d%%)", ago, lastFartEvent.fartScore);
    display.setCursor(0, 30); display.print(buf);

    snprintf(buf, sizeof(buf), "VOC:%.1f dV:%.1f", lastFartEvent.voc, lastFartEvent.dVocRise);
    display.setCursor(0, 39); display.print(buf);

    snprintf(buf, sizeof(buf), "IAQ:%.0f GR:%.0fk", lastFartEvent.iaq, lastFartEvent.gasR / 1000.0f);
    display.setCursor(0, 48); display.print(buf);

    // Why it was detected
    display.setCursor(0, 57);
    if (lastFartEvent.baseGasDrop > 0.12f)
      display.print(F("GasR crashed = bio"));
    else if (lastFartEvent.sulfurScore >= 15)
      display.print(F("Sulfur signature"));
    else
      display.print(F("VOC spike pattern"));
  } else {
    display.setCursor(0, 30);
    display.print(F("No fart events"));
    display.setCursor(0, 39);
    display.print(F("recorded yet."));
    display.setCursor(0, 48);
    display.print(F("Check back after"));
    display.setCursor(0, 57);
    display.print(F("biological activity."));
  }

  display.display();
  waitResponsive(3200UL);
}

// ══════════════════════════════════════════════════════════════
// Section 27: Input Handling
//   showSassyOnOled, handleButton
// ══════════════════════════════════════════════════════════════

// ── Show cached sassy GPT message on OLED (called from 5s button hold) ──────
void showSassyOnOled() {
  // If no cached message, queue a fetch — don't block here.
  // The GPT call can take 5-15s and would freeze the OLED + button.
  if (dcSassyMsg[0] == '\0' && dcSnapshotReady) {
    pendingDcSend = true;  // let loop() handle the fetch asynchronously
  }

  display.clearDisplay();
  drawHeader("-- AI Says --");
  display.setTextSize(1);

  // Hazard level in inverted banner
  const char* hl = dcHazardLevel[0] ? dcHazardLevel : "Sniffing...";
  int hw = strlen(hl) * 6;
  int hx = max(0, (SCREEN_WIDTH - hw) / 2);
  display.fillRect(0, 11, SCREEN_WIDTH, 11, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setCursor(hx, 13);
  display.print(hl);
  display.setTextColor(SSD1306_WHITE);

  // Word-wrap the sassy message (max 4 lines, 21 chars each)
  const char* msg = dcSassyMsg[0] ? dcSassyMsg : "Hold 5s for AI snark.";
  int y = 25, len = strlen(msg), pos = 0;
  while (pos < len && y <= 56) {
    int lineEnd = min(pos + 21, len);
    if (lineEnd < len) {
      int brk = lineEnd;
      while (brk > pos && msg[brk] != ' ') brk--;
      if (brk > pos) lineEnd = brk;
    }
    char line[22];
    int lc = lineEnd - pos;
    memcpy(line, msg + pos, lc);
    line[lc] = '\0';
    display.setCursor(0, y);
    display.print(line);
    y += 9;
    pos = lineEnd;
    if (pos < len && msg[pos] == ' ') pos++;
  }
  display.display();
}

static uint8_t       btnState     = 0;
static unsigned long btnPressTime = 0;
static unsigned long lastLongTime = 0;
static uint8_t       clickCount   = 0;
static unsigned long lastClickMs  = 0;
static bool          btnInputArmed = false;
static unsigned long btnIgnoreUntilMs = 0;
static unsigned long lastBtnBootLogMs = 0;

void handleButton() {
  bool down = (digitalRead(BTN_PIN) == LOW);
  unsigned long now = millis();

  if (!btnInputArmed) {
    if (now < btnIgnoreUntilMs) return;
    if (down) {
      if (lastBtnBootLogMs == 0 || now - lastBtnBootLogMs >= 5000UL) {
        lastBtnBootLogMs = now;
        Serial.println(F("[BTN] Waiting for button release before arming input"));
      }
      return;
    }
    btnInputArmed = true;
    btnState = 0;
    clickCount = 0;
    lastClickMs = 0;
    Serial.println(F("[BTN] Button input armed"));
    return;
  }

  // 1. Deferred multi-click actions — wait 650ms after last click to see
  //    if more clicks are coming, then fire the action for the final count.
  //    This prevents 4-click (breath check) from swallowing a 5th click.
  if (clickCount >= 3 && lastClickMs > 0 && now - lastClickMs >= 650UL) {
    uint8_t cc = clickCount;
    clickCount = 0;
    if (cc >= 7) {
      // 7x press: mute / unmute non-critical jingles
      toggleJinglesMute();
      displayPage = 0;
      forceRedraw = true;
    } else if (cc == 6) {
      // 6x press: fart analysis
      showFartAnalysis();
      displayPage = 0;
      forceRedraw = true;
    } else if (cc == 5) {
      // 5x press: paranormal investigation
      runParanormalScan();
      displayPage = 0;
      forceRedraw = true;
    } else if (cc == 4) {
      // 4x press: breath checker / breathalyzer
      runBreathChecker();
      displayPage = 0;
      forceRedraw = true;
    } else {
      // 3x press: dad joke — set flag, let loop() handle the fetch
      dadJokeReady = false;
      queueDadJokeFetch();
      displayPage = DAD_JOKE_PAGE;
      lastDisplayUpdate = now;
      display.clearDisplay();
      drawHeader("-- Dad Joke --");
      display.setTextSize(1);
      display.setCursor(0, 22);
      display.print(F("Asking for a joke..."));
      display.display();
      // NOTE: removed synchronous serviceDeferredCloudTasks() here —
      // blocking cloud fetch inside button handler freezes OLED + button.
      // The deferred task will fire on the next loop() iteration instead.
      lastOptionalCloudMillis = 0;  // allow immediate cloud on next loop
      forceRedraw = true;
    }
  }

  // 2. Button State Machine
  if (btnState == 0 && down) {
    // Button just pressed
    btnPressTime = now;
    btnState = 1;
  }
  else if (btnState == 1) {
    if (!down) {
      // --- SHORT PRESS RELEASE ---
      if (!labelModeActive) {
        if (now - lastClickMs > 900UL) clickCount = 0;
        clickCount++;
        lastClickMs = now;

        if (clickCount < 3) {
          // 1st or 2nd click: advance page immediately
          displayPage = (displayPage >= NUM_PAGES) ? 0 : (displayPage + 1) % NUM_PAGES;
          lastDisplayUpdate = now;
          forceRedraw = true;
        }
        // 3+ clicks: handled by deferred block above after 650ms timeout
      }
      btnState = 0;
    }
    else if (now - btnPressTime >= BTN_LONG_MS) {
      // --- LONG PRESS DETECTED ---
      // Don't fire actions yet — transition to state 2 and wait.
      // Action is decided on RELEASE (state 2) based on total hold time,
      // or immediately at 5 seconds if still held.
      btnState = 2;
    }
  }
  else if (btnState == 2) {
    if (down && now - btnPressTime >= 5000UL) {
      // --- 5-SECOND HOLD: Show sassy GPT message on OLED ---
      Serial.println(F("[BTN] 5s hold → Sassy message"));
      showSassyOnOled();
      // Wait for release so we don't re-trigger (10 s safety timeout
      // prevents infinite hang if button is physically stuck or shorted)
      { unsigned long _wt = millis();
        while (digitalRead(BTN_PIN) == LOW && millis() - _wt < 10000UL) {
          melTick(); delay(20);
        }
      }
      btnState = 0;
      forceRedraw = true;
    }
    else if (!down) {
      // --- RELEASED AFTER LONG PRESS (0.6s–5s) ---
      unsigned long holdTime = now - btnPressTime;
      Serial.printf("[BTN] Long press released after %lums  lastLongTime=%lu\n",
                    holdTime, lastLongTime);
      if (!labelModeActive) {
        if (lastLongTime > 0 && now - lastLongTime < 4000UL) {
          // DOUBLE-LONG PRESS (within 4 seconds): force GPT + hosted portal sync
          Serial.println(F("[BTN] Double-long-press → Portal Refresh"));
          display.clearDisplay();
          drawHeader("-- Portal Sync --");
          display.setTextSize(1);
          display.setCursor(0, 25);
          display.print(F("Refreshing cloud..."));
          display.setCursor(0, 40);
          display.print(F("Portal update queued"));
          display.display();
          pendingDcSend = true;
#ifdef USE_WEB_DASHBOARD
          EVENT_PUSH();
#endif
          lastLongTime  = 0;
          forceRedraw   = true;
        } else {
          // SINGLE-LONG PRESS: Show launches
          Serial.println(F("[BTN] Single-long-press → Launches"));
          displayPage = LAUNCHES_PAGE;
          lastDisplayUpdate = now;
          lastLongTime = now;
          forceRedraw  = true;
          playLongPressMelody();
        }
      } else {
        labelModeActive = false;
        Serial.println(F("=== LABEL MODE OFF ==="));
      }
      btnState = 0;
    }
  }
}

// ══════════════════════════════════════════════════════════════
// Section 28: BSEC2 Callback
//   onSensorData
// ══════════════════════════════════════════════════════════════

void onSensorData(const bme68xData data, const bsecOutputs outputs, const Bsec2 bsec) {
  for (uint8_t i = 0; i < outputs.nOutputs; i++) {
    const bsecData &o = outputs.output[i];
    switch (o.sensor_id) {
      case BSEC_OUTPUT_BREATH_VOC_EQUIVALENT:                latestVocRaw     = o.signal; break;
      case BSEC_OUTPUT_IAQ:
        latestIAQ = o.signal; latestIAQAccuracy = o.accuracy;               break;
      case BSEC_OUTPUT_STATIC_IAQ:                           latestStaticIAQ  = o.signal; break;
      case BSEC_OUTPUT_CO2_EQUIVALENT:                       latestCO2        = o.signal; break;
      case BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_TEMPERATURE:  latestTemp       = o.signal; break;
      case BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_HUMIDITY:     latestHumidity   = o.signal; break;
      case BSEC_OUTPUT_RAW_PRESSURE:                         latestPressure   = o.signal; break;
      case BSEC_OUTPUT_RAW_GAS:                              latestGasR       = o.signal; break;
      case BSEC_OUTPUT_COMPENSATED_GAS:                      latestCompGas    = o.signal; break;
      case BSEC_OUTPUT_GAS_PERCENTAGE:                       latestGasPct     = o.signal; break;
      case BSEC_OUTPUT_STABILIZATION_STATUS:                 latestStabStatus = o.signal; break;
      case BSEC_OUTPUT_RUN_IN_STATUS:                        latestRunInStatus= o.signal; break;
    }
  }
  newDataReady = true;
}

// ══════════════════════════════════════════════════════════════
// Section 29: setup()
// ══════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin();
  Wire.setTimeOut(50);
  Wire.setClock(100000);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(BTN_PIN, INPUT_PULLUP);
  btnInputArmed = false;
  btnIgnoreUntilMs = millis() + 5000UL;
  lastBtnBootLogMs = 0;

#ifdef HAVE_RGB
  rgbLed.begin();
  rgbLed.setBrightness(60);
  rgbLed.clear();
  rgbLed.show();
#endif

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("OLED init failed — retrying..."));
    delay(500);
    Wire.begin();
    Wire.setClock(100000);
    if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
      Serial.println(F("OLED init failed after retry — continuing without display"));
      // Continue without display rather than freezing forever
    }
  }
  display.setTextColor(SSD1306_WHITE);
  drawSplash();
  drawHelpScreen();

  // Seed RNG from hardware entropy (must happen before playStartupMelody)
  randomSeed(esp_random());

  // Kick WiFi bootstrap without blocking setup. Reconnect rotation and timeout
  // handling live in maintainWiFi() once loop() starts.
  WiFi.disconnect(true);
  delay(50);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  wifiOfflineSinceMillis = millis() - WIFI_OFFLINE_DEBOUNCE_MS;
  lastWiFiRetryMillis = 0;
  lastWiFiLoopStatus = WiFi.status();
  wifiConnectAttemptActive = false;
  wifiConnectStartMillis = 0;
  wifiConnectIndex = -1;
  wifiPreferredIndex = 0;
  wifiRetryIndex = (WIFI_NUM_NETWORKS > 1) ? 1 : 0;
  wifiBootstrapPending = true;

  display.clearDisplay();
  drawHeader("-- WiFi --");
  display.setTextSize(1);
  if (WIFI_NUM_NETWORKS > 0) {
    display.setCursor(0, 12);
    display.print(F("Starting async WiFi"));
    display.setCursor(0, 22);
    display.print(WIFI_CREDS[wifiPreferredIndex][0]);
    display.setCursor(0, 36);
    display.print(F("Boot continues now"));
    display.display();
    startWiFiConnectAttempt(wifiPreferredIndex, true);
  } else {
    display.setCursor(0, 20);
    display.print(F("WiFi not configured"));
    display.display();
  }

  // Startup melody — random each boot
  playStartupMelody();

  // BME688 init
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(F("SniffMaster Pro v4.0"));
  display.println(F("--------------------"));
  display.println(F("Preparing BME688 core"));
  display.println(F("Restoring calibration"));
  display.println(F("Loading room baseline"));
  display.display();

  if (!envSensor.begin(BME68X_I2C_ADDR_LOW, Wire, safeBmeDelayUs)) {
    Serial.println(F("BSEC2 init failed — retrying with I2C reset..."));
    Wire.end();
    delay(200);
    Wire.begin();
    Wire.setClock(100000);
    delay(100);
    if (!envSensor.begin(BME68X_I2C_ADDR_LOW, Wire, safeBmeDelayUs)) {
      Serial.println(F("BSEC2 init failed after retry!"));
      display.clearDisplay();
      display.setCursor(0, 0);
      display.println(F("BSEC2 INIT FAIL"));
      display.println(F("Check BME688 wiring"));
      display.println(F(""));
      display.println(F("Rebooting in 10s..."));
      display.display();
      delay(10000);
      ESP.restart();
    }
  }

#if defined(CONFIG_IDF_TARGET_ESP32C3) || defined(ARDUINO_XIAO_ESP32C3)
  if (envSensor.setConfig(bsecIaqLpConfig)) {
    Serial.println(F("[BSEC] Loaded C3 IAQ 3s config"));
  } else {
    Serial.printf("[BSEC] IAQ config load failed: status=%d sensor=%d\n",
                  (int)envSensor.status, (int)envSensor.sensor.status);
  }
#endif

  // Restore previous calibration from NVS BEFORE subscribing to outputs.
  // This must happen after begin() but before updateSubscription() so BSEC2
  // starts from the saved calibration state. Without this order, the sensor
  // restarts calibration from scratch (30+ min to reach accuracy 3).
  loadBsecState();
  if (calState.bsecStateLoaded) {
    calBeepDone = true;     // restored state should not replay the victory fanfare on boot
    bsecAcc3Saved = true;   // avoid an immediate redundant flash write if acc already returns at 3
  }

  subscribeBsecOutputs(/*allowFallback=*/true, "setup");
  envSensor.attachCallback(onSensorData);
  bsecInitMillis = millis();
  lastBsecWaitLogMillis = 0;
  bsecFirstPacketRetryDone = false;
  Serial.printf("[BSEC] Active output bundle: %s @ %s\n",
                bsecUsingLpSafeOutputs ? "safe" : "full",
                (bsecActiveSampleRate == BSEC_SAMPLE_RATE_ULP) ? "ULP" : "LP");

#ifdef USE_ML_SCORING
  smellnet_init();
  Serial.println(F("SmellNet ML scoring active"));
#else
  Serial.println(F("Heuristic scoring active"));
#endif
  Serial.println(F("SniffMaster Pro v4.0 ready"));
  delay(1000);

}



// ── Cooperative loop scheduler (anti-freeze) ───────────────────────────────
// Keep button, melody, and BSEC responsive every pass, but duty-cycle the
// heavier subsystems so BLE / Wi-Fi / cloud work cannot monopolize the loop.
static unsigned long lastBleTickMs = 0;
static unsigned long lastWiFiMaintainMs = 0;
static unsigned long lastCloudServiceMs = 0;
static unsigned long lastLoopHealthLogMs = 0;
static unsigned long lastYieldMs = 0;
static const unsigned long BLE_TICK_INTERVAL_MS = 80UL;
static const unsigned long WIFI_MAINTAIN_INTERVAL_MS = 250UL;
static const unsigned long CLOUD_SERVICE_INTERVAL_MS = 150UL;
static const unsigned long LOOP_HEALTH_LOG_INTERVAL_MS = 10000UL;
static const unsigned long LOOP_YIELD_INTERVAL_MS = 25UL;

static inline bool dueEvery(unsigned long now, unsigned long &lastMs, unsigned long intervalMs) {
  if (now - lastMs < intervalMs) return false;
  lastMs = now;
  return true;
}

// ══════════════════════════════════════════════════════════════
// Section 30: loop()
// ══════════════════════════════════════════════════════════════

void loop() {
  unsigned long now = millis();

  handleButton();
  bool bsecRan = envSensor.run();
  melTick();

  // BLE scanning and Wi-Fi maintenance were previously called every loop,
  // which can starve the OLED/UI path on the XIAO when BLE/ML/cloud are all
  // enabled. Duty-cycle them so the loop stays responsive even under load.
  if (dueEvery(now, lastBleTickMs, BLE_TICK_INTERVAL_MS)) {
    blePresenceTick();
  }
  if (dueEvery(now, lastWiFiMaintainMs, WIFI_MAINTAIN_INTERVAL_MS)) {
    maintainWiFi();
  }

  // Compute RSSI gate early — used by all cloud paths below.
  // TLS handshakes at <-82 dBm can block 20-30s, freezing OLED + button.
  const bool wifiTooWeak = (WiFi.status() == WL_CONNECTED && WiFi.RSSI() < -82);

#ifdef USE_WEB_DASHBOARD
  if (!wifiTooWeak && dueEvery(now, lastCloudServiceMs, CLOUD_SERVICE_INTERVAL_MS)) pollPortalCommand();
#endif

#if 1
  if (!bsecRan) {
    int bsecStatus = (int)envSensor.status;
    int bmeStatus = (int)envSensor.sensor.status;
    if (bsecStatus != lastBsecStatusLog || bmeStatus != lastBmeStatusLog) {
      Serial.printf("[BSEC] run() issue: status=%d sensor=%d\n", bsecStatus, bmeStatus);
      lastBsecStatusLog = bsecStatus;
      lastBmeStatusLog = bmeStatus;
    }
  }
#endif
#ifdef USE_WEB_DASHBOARD
  if (!wifiTooWeak) maybeRecoverWebRelay(now);
#endif

  const unsigned long bsecWarnDelayMs =
    (bsecActiveSampleRate == BSEC_SAMPLE_RATE_ULP) ? 90000UL : 15000UL;
  const unsigned long bsecRetryDelayMs =
    (bsecActiveSampleRate == BSEC_SAMPLE_RATE_ULP) ? 180000UL : 25000UL;

  if (!ss_valid && bsecInitMillis != 0 && now - bsecInitMillis >= bsecWarnDelayMs) {
    if (lastBsecWaitLogMillis == 0 || now - lastBsecWaitLogMillis >= 15000UL) {
      lastBsecWaitLogMillis = now;
      Serial.printf("[BSEC] Waiting for first sensor packet... status=%d sensor=%d mode=%s uptime=%lus\n",
                    (int)envSensor.status, (int)envSensor.sensor.status,
                    (bsecActiveSampleRate == BSEC_SAMPLE_RATE_ULP) ? "ULP" : "LP",
                    now / 1000UL);
    }
    if (!bsecFirstPacketRetryDone && now - bsecInitMillis >= bsecRetryDelayMs) {
      Serial.println(F("[BSEC] No first packet yet — retrying subscription"));
      subscribeBsecOutputs(/*allowFallback=*/true, "retry");
      envSensor.attachCallback(onSensorData);
      bsecInitMillis = now;
      bsecFirstPacketRetryDone = true;
      Serial.printf("[BSEC] Retry active output bundle: %s @ %s\n",
                    bsecUsingLpSafeOutputs ? "safe" : "full",
                    (bsecActiveSampleRate == BSEC_SAMPLE_RATE_ULP) ? "ULP" : "LP");
    }
  }

  // ── Sensor snapshot ───────────────────────────────────────────────────────
  if (newDataReady) {
    newDataReady = false;
    const bool hadValidSnapshot = ss_valid;

    const float vocRaw    = latestVocRaw;
    const float iaq       = latestIAQ;
    const float staticIaq = latestStaticIAQ;
    const float co2       = latestCO2;
    const float tempC     = latestTemp;
    const float hum       = latestHumidity;
    const float pressure  = latestPressure;
    const float gasR      = latestGasR;
    const float compGas   = latestCompGas;
    const float gasPct    = latestGasPct;
    const float stabStatus = latestStabStatus;
    const float runInStatus = latestRunInStatus;
    const uint8_t iaqAcc  = latestIAQAccuracy;

    const float tempF     = tempC * 9.0f / 5.0f + 32.0f;
    const float vocSmooth = pushAndSmooth(vocRaw);
    const float vocDelta  = vocSmooth - ss_prevVoc;
    const float dVoc      = vocDelta > 0.0f ? vocDelta : 0.0f;  // Rising-only
    const float dVocAbs   = fabsf(vocDelta);
    ss_prevVoc            = vocSmooth;
    const uint8_t tier    = smellTier(vocSmooth);
    pushTrend(iaq, vocSmooth);

    updateCalibrationRuntimeState(iaqAcc, stabStatus, runInStatus);

    if (bsecCalibrationReady(iaqAcc) && ss_prevTier != 0xFF && tier != ss_prevTier) {
      playOdorChangeMelody(ss_prevTier, tier);
      EVENT_PUSH();  // event-driven: push odor tier change immediately
    }
    ss_prevTier = tier;

    uint8_t scores[ODOR_COUNT] = {0};
#ifdef USE_ML_SCORING
    scoreOdors(vocSmooth, iaq, co2, tempF, hum, pressToHpa(pressure), gasR, dVoc, scores);
#else
    scoreOdors(vocSmooth, iaq, co2, dVoc, gasR, scores);
#endif

    // Cross-correlation post-processor — resolves odor misclassification
    // by checking gasR patterns, CO2 correlation, timing, humidity, etc.
    correctOdorScores(scores, vocSmooth, iaq, co2, gasR, dVoc, tempF, hum, compGas);

    // Home baseline learning — builds an EMA of quiet indoor readings
    updateHomeBaseline(vocSmooth, iaq, co2, gasR, hum, pressToHpa(pressure),
                       iaqAcc, dVocAbs, scores);

    // Suppress false positives using home baseline context
    applyHomeMlTuning(scores, vocSmooth, iaq, co2, gasR, dVoc, hum, iaqAcc);

    // Derive 8 expanded odor families from base 12 ML scores + sensor data
    deriveExpandedOdors(scores, vocSmooth, iaq, co2, gasR, dVoc, hum, iaqAcc);

    // Require moderate scores to persist 2+ samples before reporting
    stabilizePrimaryOdor(scores, iaqAcc);

    // Composite Room Quality Score — computed AFTER correction so odor
    // detections and outdoor AQI can factor into the overall assessment.
    const int airScore = computeAirScore(iaq, vocSmooth, co2, hum, scores,
                                         outdoorAqi.valid ? outdoorAqi.aqi : 0);
    const float cfiScore = computeCfiScore(co2, iaq);
    const uint8_t cfiPercent = (uint8_t)lroundf(cfiScore * 100.0f);
    const uint8_t vtrLevel = computeVtrLevel(hum, co2, iaq);

    ss_voc = vocSmooth; ss_iaq = iaq; ss_co2 = co2;
    ss_tempF = tempF;   ss_hum = hum; ss_pressure = pressure;
    ss_gasR = gasR;     ss_dvoc = vocDelta;  // signed delta for display/trends
    ss_staticIAQ = staticIaq; ss_compGas = compGas; ss_gasPct = gasPct;
    ss_stabStatus = stabStatus; ss_runInStatus = runInStatus;
    ss_iaqAcc = iaqAcc;
    for (uint8_t i = 0; i < ODOR_COUNT; i++) ss_scores[i] = scores[i];
    ss_tier = tier; ss_airScore = airScore;
    ss_valid = true;
    if (!hadValidSnapshot) {
      forceRedraw = true;
      lastBootStatusRenderMs = 0;
      if (!blePresenceStarted) {
        blePresenceStarted = blePresenceBegin();
      }
    }

    // Queue GPT AI analysis on significant environmental changes:
    //   1. IAQ shift >=15 (air quality changed meaningfully)
    //   2. New odor detected or primary odor changed
    //   3. Air score jumped >20 points (rapid quality shift)
    //   4. Periodic refresh every 2 minutes to keep dashboard alive
    // All checks require cooldown elapsed AND sensor calibrated.
    if (bsecCalibrationReady(iaqAcc) &&
        (now - lastAiFetchMillis >= AI_COOLDOWN || lastAiFetchMillis == 0)) {
      uint8_t _ai1, _ai2;
      topTwo(scores, _ai1, _ai2);
      uint8_t curOdorIdx = (scores[_ai1] >= ODOR_MIN_CONF) ? _ai1 : ODOR_COUNT;

      bool iaqShift    = abs((int)iaq - lastIAQ) >= 10;   // was 15 — catch smaller changes
      bool odorChange  = (curOdorIdx != prevAiOdorIdx) &&
                         (curOdorIdx < ODOR_COUNT || prevAiOdorIdx < ODOR_COUNT);
      bool scoreJump   = abs(airScore - ss_prevAirScore) > 12;  // was 20 — match rapid detect
      bool periodicRefresh = (now - lastAiFetchMillis >= 180000UL);  // 3 min auto-refresh

      if (iaqShift || odorChange || scoreJump || periodicRefresh) {
        lastIAQ = (int)iaq;
        prevAiOdorIdx = curOdorIdx;
        pendingDcSend = true;   // triggers GPT fetch / cloud refresh in deferred block
        if (iaqShift)   Serial.println(F("[AI] Trigger: IAQ shift"));
        if (odorChange) Serial.println(F("[AI] Trigger: odor change"));
        if (scoreJump)  Serial.println(F("[AI] Trigger: score jump"));
        if (periodicRefresh && !iaqShift && !odorChange && !scoreJump)
          Serial.println(F("[AI] Trigger: periodic refresh"));
      }
    }

    // Snapshot latest values for cloud dashboards (always fresh for hosted relay)
    dcIAQ        = (int)iaq;
    dcVOC        = vocSmooth;  dcCO2   = co2;
    dcTempF      = tempF;      dcHum   = hum;
    dcPressHpa   = pressToHpa(pressure);
    dcGasR       = gasR;       dcAirScore = airScore;
    dcCFIScore   = cfiScore;   dcCFIPercent = cfiPercent;
    dcVTRLevel   = vtrLevel;
    dcTier       = tier;
    {
      uint8_t _i1, _i2; topTwo(scores, _i1, _i2);
      dcOdorIdx  = (scores[_i1] >= ODOR_MIN_CONF) ? _i1 : ODOR_COUNT;
      dcOdorConf = scores[_i1];
    }
    dcSnapshotReady = true;

#ifdef USE_WEB_DASHBOARD
    {
      const float sulfurConf = scores[OD_SULFUR];
      const bool highSulfur = sulfurConf >= 70.0f;
      const bool risingSulfur = highSulfur && ss_prevSulfurConf < 70;
      const bool sulfurSurged = highSulfur &&
                                sulfurConf >= (float)ss_prevSulfurConf + 12.0f;
      const bool sniffCooldownDone = (lastSniffPostMillis == 0) ||
                                     (now - lastSniffPostMillis >= SNIFF_POST_COOLDOWN);
      if (bsecCalibrationReady(iaqAcc) && sniffCooldownDone &&
          (risingSulfur || sulfurSurged)) {
        uint8_t si1, si2;
        topTwo(scores, si1, si2);
        const char* sniffLabel = (si1 < ODOR_COUNT && scores[si1] >= ODOR_MIN_CONF)
                               ? odorNames[si1]
                               : "High Sulfur";
        queueSniffPriorityPost((int)iaq, sulfurConf, sniffLabel);
      }
      ss_prevSulfurConf = scores[OD_SULFUR];
    }
#endif

    // Triumphant jingle when BSEC2 reaches full calibration (accuracy 3)
    if (!calBeepDone && iaqAcc == 3 && ss_prevIaqAcc < 3 && bsecCalibrationReady(iaqAcc)) {
      if (jinglesEnabled()) {
        showNowPlayingText("Sensor Calibrated!", "SniffMaster Pro", "sensor reached full calibration");
        melStartAlert(0);  // CALIBRATION_FANFARE
      }
      calBeepDone = true;
      Serial.println(F("[CAL] Full calibration reached! Playing victory jingle."));
    }
    ss_prevIaqAcc = iaqAcc;

    // BSEC state persistence
    if (iaqAcc == 3 && !bsecAcc3Saved && bsecCalibrationReady(iaqAcc)) {
      saveBsecState(); bsecAcc3Saved = true;
    } else if (homeBase.ready && calState.homeBaseDirty && bsecCalibrationReady(iaqAcc)) {
      saveBsecState();
    } else if (bsecCalibrationReady(iaqAcc) &&
               millis() - lastBsecSaveMs >= BSEC_SAVE_MS) {
      saveBsecState();
    }

    // Rapid smell / fart detection — BSEC2-calibrated thresholds
    // Fart detection requirements (all must be true to count):
    //   1. Fart score >= 40 AND re-armed (dropped enough since last peak)
    //   2. Sensor calibrated (iaqAcc >= ODOR_RUNTIME_ACC_MIN)
    //   3. Fart is primary odor winner OR strong biological evidence
    //   4. Rising VOC (dVoc > 0) — not just a fade-out from prior event
    //   5. Refractory cooldown elapsed (prevents one cloud = multiple counts)
    if (ss_valid) {
      uint8_t fi1, fi2;
      topTwo(scores, fi1, fi2);
      bool fartIsPrimary = (fi1 == OD_FART);
      bool bioEvidence = (scores[OD_SULFUR] >= 15 || scores[OD_GARBAGE] >= 20 ||
                          (gasR / 1000.0f < 120.0f && iaq > 60.0f));
      // Re-arm: score must have dropped by >=15 from peak OR below 20
      bool rearmed = (ss_prevFartConf < 20) ||
                     (ss_peakFartConf > 0 && ss_prevFartConf <= ss_peakFartConf - 15);
      bool fartSpike = scores[OD_FART] >= 40 &&
                       rearmed &&
                       bsecCalibrationReady(iaqAcc) &&
                       (fartIsPrimary || bioEvidence) &&
                       dVoc > 0.3f &&
                       (now - lastFartMs >= FART_COOLDOWN_MS);

      bool dVocSpike    = dVoc > 3.0f && bsecCalibrationReady(iaqAcc);
      bool airScoreJump = (airScore - ss_prevAirScore) > 12 && bsecCalibrationReady(iaqAcc);

      if (fartSpike) {
        fartCount++;
        lastFartMs = now;
        ss_peakFartConf = 0;  // reset peak for re-arm hysteresis
        if (vocSmooth > biggestFartVoc) biggestFartVoc = vocSmooth;
        // Save last fart event metrics for 6-click analysis
        float gasDrop = (homeBase.ready && homeBase.gasR > 1000.0f)
                      ? fmaxf(0.0f, (homeBase.gasR - gasR) / homeBase.gasR)
                      : 0.0f;
        lastFartEvent = { true, now, scores[OD_FART], vocSmooth, dVoc,
                          iaq, gasR, gasDrop, fi1,
                          scores[OD_SULFUR], scores[OD_GARBAGE], scores[OD_PET], iaqAcc };
        Serial.printf("[FART] #%d detected! VOC=%.2f dVOC=%.2f score=%d gasR=%.0fk primary=%d bio=%d\n",
                      fartCount, vocSmooth, dVoc, scores[OD_FART], gasR / 1000.0f,
                      fartIsPrimary, bioEvidence);
        melStop();
        for (int _i = 0; _i < 3; _i++) {
          tone(BUZZER_PIN, 1047); delay(100);
          noTone(BUZZER_PIN);    delay(80);
        }
        showFartAlert();
        forceRedraw = true;
        lastRapidMs = now;
        EVENT_PUSH();
      } else if ((dVocSpike || airScoreJump) && now - lastRapidMs > 10000UL) {
        Serial.printf("[RAPID] dVoc=%.2f scoreJump=%d scores[gas]=%d [smoke]=%d\n",
                      dVoc, airScore - ss_prevAirScore, scores[OD_GASOLINE], scores[OD_SMOKE]);
        if (scores[OD_SMOKE] >= 40 || scores[OD_GASOLINE] >= 40) {
          showNowPlayingText("!! SMOKE / GAS ALERT !!", "SniffMaster Pro", "smoke or gas alert");
          melStartAlert(1);
        } else if (dVoc > 4.0f && jinglesEnabled()) {
          showNowPlaying(2, "rapid air-quality spike"); melStartPool(2);
        } else if (jinglesEnabled()) {
          showNowPlaying(1, "rapid odor alert"); melStartPool(1);
        }
        lastRapidMs = now;
      }
      ss_prevFartConf = scores[OD_FART];
      if (scores[OD_FART] > ss_peakFartConf) ss_peakFartConf = scores[OD_FART];
      ss_prevAirScore = airScore;
    }

    // Air quality alerts (checks for dangerous conditions)
    checkAirAlerts(iaq, vocSmooth, co2, hum, scores, iaqAcc);

    // Reset fart counter at midnight + daily refreshes + hourly chime
    struct tm tNow;
    if (getLocalTime(&tNow)) {
      // Midnight reset + daily data refreshes
      if (tNow.tm_mday != fartResetDay) {
        fartResetDay = tNow.tm_mday;
        fartCount = 0;
        biggestFartVoc = 0;
        // Fresh joke every day at midnight
        Serial.println(F("[DAILY] Midnight refresh: joke + launches"));
        queueDeferredCloudTasksForNewDay();
      }
      // Hourly Westminster chime — plays once when minutes roll to 0
      if (tNow.tm_hour != lastChimeHour && tNow.tm_min == 0) {
        lastChimeHour = tNow.tm_hour;
        if (!melBusy() && jinglesEnabled()) {
          showNowPlayingText("Westminster Chime", "Big Ben", "hourly chime");
          melStartAlert(2);  // WESTMINSTER
          Serial.printf("[CHIME] Hourly chime at %02d:00\n",
                        tNow.tm_hour);
        }
      }
    }

    updateRGB(iaq);

    if (labelModeActive)
      emitLabelData(vocSmooth, iaq, co2, tempF, hum, pressure, gasR, dVoc);

    Serial.println(F("================================"));
    Serial.printf("Heap: %u free / %u min / %u blk  RSSI: %d\n",
                  ESP.getFreeHeap(), ESP.getMinFreeHeap(),
                  heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
                  WiFi.RSSI());
    Serial.printf("IAQ acc: %s  Tier: %d (%s)  AirScore: %d\n",
                  accLabelSerial[iaqAcc], tier, tierDesc(tier), airScore);
    Serial.printf("Temp: %.1fF  Hum: %.1f%%  Press: %.1fhPa\n",
                  tempF, hum, pressToHpa(pressure));
    Serial.printf("VOC: %.1f  IAQ: %.1f  CO2: %.0f  gasR: %.0f  dVOC: %.1f\n",
                  vocSmooth, iaq, co2, gasR, dVoc);
    {
      const BlePresenceSnapshot &ble = blePresenceGetSnapshot();
      Serial.printf("BLE: %s  conf=%u%%  rssi=%d  ema=%.1f  target=%s\n",
                    blePresenceStateLabel(ble.state),
                    ble.confidence,
                    ble.lastRssi,
                    ble.emaRssi,
                    ble.matchedName[0] ? ble.matchedName : "(none)");
    }
  }

  // ── Cloud-call-per-loop limiter ─────────────────────────────────────────────
  // Only ONE blocking HTTPS call per loop() iteration.  Without this guard,
  // GPT (15 s) + AIO (9 s) + Web (10 s) can all fire in the same pass = 34 s
  // with no melTick(), no button read, no OLED update → device appears frozen.
  bool cloudCallThisLoop = false;

  // ── Deferred ChatGPT fetch (infrequent — only on significant IAQ shifts) ────
  // GPT call takes 5-15s so it runs separately from the fast AIO updates.
  // wifiTooWeak is computed at the top of loop() and gates all cloud paths.
  if (wifiTooWeak && pendingDcSend) {
    // Keep queued — will fire once signal recovers
    Serial.printf("[CLOUD] Deferred GPT: RSSI %d too weak, retrying later\n", WiFi.RSSI());
  } else if (pendingDcSend) {
#ifdef USE_WEB_DASHBOARD
    if (portalBackpressureActive(now)) {
      // Keep AI commentary queued until the portal relay is healthy again.
      // The live feed matters more than a fresh quip.
    } else
#endif
    {
      pendingDcSend = false;

      if (!dcSnapshotReady) {
        dcIAQ      = (int)ss_iaq;   dcVOC  = ss_voc;  dcCO2   = ss_co2;
        dcTempF    = ss_tempF;      dcHum  = ss_hum;
        dcPressHpa = pressToHpa(ss_pressure);
        dcGasR     = ss_gasR;       dcAirScore = ss_airScore; dcTier = ss_tier;
        uint8_t _i1, _i2; topTwo(ss_scores, _i1, _i2);
        dcOdorIdx  = (ss_scores[_i1] >= ODOR_MIN_CONF) ? _i1 : ODOR_COUNT;
        dcOdorConf = ss_scores[_i1];
        dcSnapshotReady = true;
      }

      // Silence buzzer before blocking cloud call — prevents stuck-tone freeze.
      // melTick() won't run during the 5-15s GPT request, so any active note
      // would drone continuously until the HTTP response arrives.
      if (melBusy()) melStop();
      Serial.println(F("[GPT] Fetching sassy message..."));
      const char* odorName = (dcOdorIdx < ODOR_COUNT) ? odorNames[dcOdorIdx] : "None";
      fetchGPTSassyMsg(dcIAQ, dcVOC, dcCO2, dcTempF, dcHum, dcPressHpa, dcGasR,
                       odorName, dcOdorConf, dcAirScore,
                       getIaqTrend(), getVocTrend(),
                       dcHazardLevel, sizeof(dcHazardLevel),
                       dcSassyMsg,    sizeof(dcSassyMsg));
      lastAiFetchMillis = millis();
      EVENT_PUSH();  // force immediate post with fresh GPT message
      forceRedraw = true;
      cloudCallThisLoop = true;  // prevent AIO/Web from stacking in same loop
    }
  }

#ifdef USE_ADAFRUIT_IO
  // ── Adafruit IO dashboard update (every 30s) ───────────────────────────────
  // Sends latest sensor data independently of GPT. The GPT sassy message and
  // hazard level persist from the last GPT call until a new one arrives.
  // Free tier: 30 data points/min → 10 feeds × 2 posts/min = 20 (safe margin).
  if (!cloudCallThisLoop && dcSnapshotReady && (now - lastAioPostMillis >= AIO_POST_INTERVAL)) {
    const char* odorName = (dcOdorIdx < ODOR_COUNT) ? odorNames[dcOdorIdx] : "None";
    sendToAdafruitIO(dcIAQ, dcVOC, dcCO2, dcTempF, dcHum, dcPressHpa, dcGasR,
                     odorName, dcOdorConf, dcAirScore, dcTier,
                     dcSassyMsg, dcHazardLevel);
    lastAioPostMillis = now;
    cloudCallThisLoop = true;
  }
#endif

  // ── Blynk IoT dashboard update (every 15 min) ─────────────────────────────
  // Persistent TCP — much faster than AIO REST. ~18 events per cycle,
  // ~52k events/month on the free tier (100k cap).
#ifdef USE_BLYNK
  Blynk.run();   // process incoming commands + keep-alive
  if (dcSnapshotReady && (now - lastBlynkPostMillis >= BLYNK_POST_INTERVAL)) {
    const char* odorName = (dcOdorIdx < ODOR_COUNT) ? odorNames[dcOdorIdx] : "None";
    sendToBlynk(dcIAQ, dcVOC, dcCO2, dcTempF, dcHum, dcPressHpa, dcGasR,
                odorName, dcOdorConf, dcAirScore,
                dcSassyMsg, dcHazardLevel);
    lastBlynkPostMillis = now;
  }
  // Auto-reconnect Blynk if it drops
  if (!Blynk.connected() && blynkConnected) {
    blynkConnected = Blynk.connect(3000);  // quick 3s retry
  }
#endif

  // ── Web Dashboard update (every 10 min) ───────────────────────────────────
  // HTTPS POST to hosted relay — ~1–3s per call. Upstash free tier: 10k/day.
  // Skip all web calls when signal is too weak to prevent loop freezes.
#ifdef USE_WEB_DASHBOARD
 if (!wifiTooWeak && !cloudCallThisLoop) {
  bool sniffDue = pendingSniffSend &&
                  (lastSniffAttemptMs == 0 || now - lastSniffAttemptMs >= SNIFF_POST_RETRY_MS);
  if (sniffDue) {
    lastSniffAttemptMs = now;
    if (sendPrioritySniffEvent()) {
      pendingSniffSend = false;
      lastSniffPostMillis = now;
    }
  }

  bool webPeriodicDue = dcSnapshotReady &&
                        (lastWebPostMillis == 0 || now - lastWebPostMillis >= WEB_POST_INTERVAL) &&
                        (lastWebAttemptMillis == 0 ||
                         now - lastWebAttemptMillis >= WEB_POST_RETRY_MS);
  unsigned long webEventCooldown = pendingWebUrgent ? WEB_MIN_COOLDOWN : WEB_POST_RETRY_MS;
  bool webEventDue = dcSnapshotReady && pendingWebSend &&
                     (lastWebAttemptMillis == 0 ||
                      now - lastWebAttemptMillis >= webEventCooldown);
  if (webPeriodicDue || webEventDue) {
    lastWebAttemptMillis = now;
    bool webOk = sendToWebDashboard();
    if (webOk) {
      lastWebPostMillis = now;
      pendingWebSend = false;
      pendingWebUrgent = false;
    } else {
      pendingWebSend = true;
      pendingWebUrgent = false;
    }
  }
 } // !wifiTooWeak
#endif

  if (!wifiTooWeak && !cloudCallThisLoop && dueEvery(now, lastCloudServiceMs, CLOUD_SERVICE_INTERVAL_MS)) {
    serviceDeferredCloudTasks(now);
  }

  if (!ss_valid) {
    if (!labelModeActive &&
        (forceRedraw || lastBootStatusRenderMs == 0 || now - lastBootStatusRenderMs >= 2000UL)) {
      renderBootStatusPage();
      lastBootStatusRenderMs = now;
      forceRedraw = false;
    }
    yield();
    return;
  }

  if (labelModeActive) {
    yield();
    return;
  }

  // ── Dad joke auto-return ──────────────────────────────────────────────────
  if (displayPage == DAD_JOKE_PAGE && now - lastDisplayUpdate >= 7000UL) {
    displayPage = 0;
    forceRedraw = true;
  }

  bool intervalElapsed = (now - lastDisplayUpdate >= DISPLAY_INTERVAL_MS);
  if (!intervalElapsed && !forceRedraw) return;

  if (intervalElapsed && !forceRedraw) {
    if (displayPage < NUM_AUTO_PAGES)
      displayPage = (displayPage + 1) % NUM_AUTO_PAGES;
    else displayPage = 0;
  }
  forceRedraw = false;

  switch (displayPage) {
    case 0: renderAirQualityPage(ss_tier, ss_voc, ss_iaq, ss_airScore, ss_iaqAcc, ss_scores); break;
    case 1: renderNetworkPage(); break;
    case 2: renderOdorDetailPage(ss_scores, ss_airScore, ss_iaqAcc); break;
    case 3: renderEnvPage(ss_tempF, ss_hum, ss_pressure, ss_co2, ss_voc, ss_iaq, ss_iaqAcc); break;
    case 4: renderGasAnalysisPage(ss_voc, ss_iaq, ss_co2, ss_gasR, ss_dvoc, ss_iaqAcc, getIaqTrend(), getVocTrend()); break;
    case 5: renderSmellSentencePage(ss_scores, ss_airScore, ss_iaqAcc); break;
    case 6: renderFartTrackerPage(); break;
    case 7: renderWeatherPage(); break;
    case LAUNCHES_PAGE: renderLaunchPage(); break;
    case DAD_JOKE_PAGE: renderDadJokePage(); break;
  }

  lastDisplayUpdate = millis();

  // Cooperative yield keeps Wi-Fi/BLE/driver tasks serviced without letting
  // any one feature pin the core for too long.
  if (now - lastYieldMs >= LOOP_YIELD_INTERVAL_MS) {
    lastYieldMs = now;
    yield();
  }

  if (now - lastLoopHealthLogMs >= LOOP_HEALTH_LOG_INTERVAL_MS) {
    lastLoopHealthLogMs = now;
    Serial.printf("[LOOP] free=%u min=%u block=%u wifi=%d rssi=%d page=%d\n",
                  ESP.getFreeHeap(), ESP.getMinFreeHeap(),
                  heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
                  WiFi.status(), WiFi.RSSI(), displayPage);
  }
}

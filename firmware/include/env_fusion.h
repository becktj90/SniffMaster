#pragma once
// Pure indoor/outdoor fusion used by the firmware and the host test.
// No Arduino types: the ESP32 sketch and `g++ firmware/test/env_fusion_test.cpp`
// both include this header.

#include <cmath>
#include <cstdint>

// isfinite is a macro on some Arduino cores and breaks std::isfinite.
inline bool envFinite(float v) {
  return v == v && v < INFINITY && v > -INFINITY;
}

// Magnus dew point from heat-compensated Celsius and relative humidity.
// Returns Fahrenheit. NAN when humidity is outside (0, 100].
inline float envDewPointF(float tempC, float rhPercent) {
  if (!(rhPercent > 0.0f && rhPercent <= 100.0f) || !envFinite(tempC)) return NAN;
  const float a = 17.625f;
  const float b = 243.04f;
  const float gamma = logf(rhPercent / 100.0f) + (a * tempC) / (b + tempC);
  const float dewC = (b * gamma) / (a - gamma);
  return dewC * 9.0f / 5.0f + 32.0f;
}

// US EPA AQI → the 0–10 outdoor term inside the room score.
// 0 means missing or stale. Pollen is intentionally not an input.
inline int envOutdoorPoints(int usAqi) {
  if (usAqi <= 0) return 0;
  if (usAqi <= 50) return 0;
  if (usAqi <= 100) return 2;
  if (usAqi <= 150) return 4;
  if (usAqi <= 200) return 7;
  return 10;
}

enum EnvVentReason : int {
  VENT_NONE = 0,
  VENT_STALE_BAD = 1,
  VENT_STALE_OK = 2,
  VENT_OUTDOOR = 3,
  VENT_MOISTURE = 4,
  VENT_PURGE = 5,
  VENT_INDOOR = 6,
  VENT_FINE = 7,
};

struct EnvVentInput {
  bool  outdoorFresh;
  float staticIaq;
  float co2eq;
  float voc;
  float indoorRh;
  float indoorTempF;
  float outdoorDewF;   // NAN when the forecast has no dew point
  int   usAqi;
  float pm25;
  int   pollenTree;
  int   pollenGrass;
  int   pollenWeed;
};

struct EnvVentDecision {
  const char* vent;    // "open", "brief", or "shut"
  int         reason;
};

inline int envPollenIndex(int v) { return v < 0 ? 0 : v; }

inline bool envIndoorStale(const EnvVentInput& in) {
  return in.staticIaq > 150.0f || in.co2eq > 1200.0f;
}

inline bool envIndoorLoad(const EnvVentInput& in) {
  return envIndoorStale(in) || in.voc > 3.0f;
}

// First matching rule in the firmware plan wins.
inline EnvVentDecision envVentilation(const EnvVentInput& in) {
  if (!in.outdoorFresh) {
    if (envIndoorStale(in)) return { "brief", VENT_STALE_BAD };
    return { "open", VENT_STALE_OK };
  }
  const int tree = envPollenIndex(in.pollenTree);
  const int grass = envPollenIndex(in.pollenGrass);
  const int weed = envPollenIndex(in.pollenWeed);
  if (in.usAqi >= 100 || in.pm25 >= 35.0f || tree >= 4 || grass >= 4 || weed >= 4)
    return { "shut", VENT_OUTDOOR };
  if (in.indoorRh >= 65.0f && envFinite(in.outdoorDewF) &&
      in.outdoorDewF >= in.indoorTempF - 2.0f)
    return { "shut", VENT_MOISTURE };
  const bool outdoorClean = in.usAqi <= 50 && tree <= 2 && grass <= 2 && weed <= 2;
  if (envIndoorLoad(in) && outdoorClean) return { "open", VENT_PURGE };
  if (envIndoorLoad(in)) return { "brief", VENT_INDOOR };
  return { "open", VENT_FINE };
}

// 12-slot pressure ring. Label stays empty until 6 samples (90 min at 15 min).
struct EnvPressureTrend {
  float   samples[12];
  uint8_t head;
  uint8_t count;

  EnvPressureTrend() : samples(), head(0), count(0) {
    for (int i = 0; i < 12; i++) samples[i] = 0.0f;
  }

  void push(float hpa) {
    samples[head] = hpa;
    head = (uint8_t)((head + 1) % 12);
    if (count < 12) count++;
  }

  const char* label() const {
    if (count < 6) return "";
    const int oldest = (head + 12 - count) % 12;
    const int newest = (head + 12 - 1) % 12;
    const float delta = samples[newest] - samples[oldest];
    if (delta <= -1.6f) return "falling";
    if (delta >= 1.6f) return "rising";
    return "steady";
  }
};

// Host-side checks for dew point, pressure tendency, EPA points, and ventilation.
// Build: g++ -std=c++17 -I firmware/include firmware/test/env_fusion_test.cpp -o /tmp/env_fusion_test && /tmp/env_fusion_test
#include "env_fusion.h"

#include <cmath>
#include <cstdio>
#include <cstring>

static int fails = 0;

static void expect(bool ok, const char* msg) {
  if (ok) return;
  std::printf("FAIL %s\n", msg);
  fails++;
}

int main() {
  const float dry = envDewPointF(22.0f, 40.0f);
  const float damp = envDewPointF(22.0f, 80.0f);
  expect(std::isfinite(dry) && std::isfinite(damp) && damp > dry + 5.0f,
         "dew point rises with humidity and is independent of any outdoor value");
  expect(!std::isfinite(envDewPointF(22.0f, 0.0f)), "zero humidity is not a dew point");

  EnvPressureTrend trend;
  for (int i = 0; i < 5; i++) trend.push(1013.0f);
  expect(std::strcmp(trend.label(), "") == 0, "pressure trend stays empty before 90 minutes");
  trend.push(1013.0f);
  expect(std::strcmp(trend.label(), "steady") == 0, "flat pressure is steady");
  EnvPressureTrend falling;
  for (int i = 0; i < 6; i++) falling.push(1016.0f - i * 0.4f);
  expect(std::strcmp(falling.label(), "falling") == 0, "a 2 hPa drop is falling");
  EnvPressureTrend rising;
  for (int i = 0; i < 6; i++) rising.push(1008.0f + i * 0.4f);
  expect(std::strcmp(rising.label(), "rising") == 0, "a 2 hPa rise is rising");

  expect(envOutdoorPoints(0) == 0, "missing AQI adds no points");
  expect(envOutdoorPoints(40) == 0, "AQI 40 adds no points");
  expect(envOutdoorPoints(51) == 2, "AQI 51 is the moderate band");
  expect(envOutdoorPoints(160) == 7, "AQI 160 adds 7, not a 1-5 scale lookup");
  expect(envOutdoorPoints(3) == 0, "EPA 3 is good air, not OpenWeatherMap Fair");

  EnvVentInput pollenShut = {};
  pollenShut.outdoorFresh = true;
  pollenShut.staticIaq = 40;
  pollenShut.co2eq = 500;
  pollenShut.voc = 0.4f;
  pollenShut.indoorRh = 45;
  pollenShut.indoorTempF = 72;
  pollenShut.outdoorDewF = 50;
  pollenShut.usAqi = 40;
  pollenShut.pm25 = 8;
  pollenShut.pollenTree = 5;
  const EnvVentDecision shut = envVentilation(pollenShut);
  expect(std::strcmp(shut.vent, "shut") == 0 && shut.reason == VENT_OUTDOOR,
         "high tree pollen shuts windows");
  expect(envOutdoorPoints(pollenShut.usAqi) == 0, "pollen does not add room-score points");

  EnvVentInput purge = {};
  purge.outdoorFresh = true;
  purge.staticIaq = 180;
  purge.co2eq = 600;
  purge.voc = 0.5f;
  purge.indoorRh = 45;
  purge.indoorTempF = 72;
  purge.outdoorDewF = 50;
  purge.usAqi = 30;
  purge.pm25 = 6;
  const EnvVentDecision opened = envVentilation(purge);
  expect(std::strcmp(opened.vent, "open") == 0 && opened.reason == VENT_PURGE,
         "stale indoor air with clean outdoors opens");

  EnvVentInput stale = {};
  stale.outdoorFresh = false;
  stale.staticIaq = 40;
  stale.co2eq = 500;
  const EnvVentDecision staleOpen = envVentilation(stale);
  expect(std::strcmp(staleOpen.vent, "open") == 0, "stale outdoor context does not invent a shut");

  if (fails) {
    std::printf("%d failed\n", fails);
    return 1;
  }
  std::printf("env_fusion ok\n");
  return 0;
}

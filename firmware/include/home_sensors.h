#pragma once
/*  home_sensors.h — optional add-on sensors for the web "Home" mode.

    Disabled by default. Build with -DSM_HOME_SENSORS=1 to compile the hook.
    The web dashboard (/api/update) accepts these OPTIONAL keys and ignores
    them when absent:
      pm1, pm25, pm4, pm10   µg/m³            (e.g. Sensirion SEN5x)
      co2True                ppm, real NDIR    (e.g. Sensirion SCD41)
      hcho                   ppb               (e.g. Sensirion SFA30)
      vocIndex, noxIndex     Sensirion 1–500

    This file is a stub: pollHomeSensors() reports no reading, so nothing is
    sent. Fill it in for the sensor you actually own. Leave a field NAN when
    that sensor isn't fitted — only finite values are posted.                 */

#include <math.h>

#ifndef SM_HOME_SENSORS
#define SM_HOME_SENSORS 0
#endif

struct HomeAirReading {
  bool  valid;
  float pm1, pm25, pm4, pm10;
  float co2True;
  float hcho;
  float vocIndex, noxIndex;
};

static inline HomeAirReading emptyHomeAirReading() {
  return { false, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN };
}

#if SM_HOME_SENSORS
// Called from loop() (I2C owner) every HOME_SENSOR_POLL_MS. Return true and
// fill `out` when a fresh measurement is available.
static bool pollHomeSensors(HomeAirReading& out) {
  (void)out;
  return false;   // no driver yet
}
#endif

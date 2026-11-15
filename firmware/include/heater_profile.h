#pragma once
// Copied from Bosch-BME68x-Library v1.1.40407
// examples/sequential_mode/sequential_mode.ino (setHeaterProf length 3).
// The example declares 10-element arrays but only programs these three steps.

#define HEATER_PROFILE_ID "bme68x-seq-3-v1.1.40407"
#define HEATER_STEP_COUNT 3

static const uint16_t HEATER_TEMP_C[HEATER_STEP_COUNT] = { 100, 200, 320 };
static const uint16_t HEATER_DUR_MS[HEATER_STEP_COUNT] = { 150, 150, 150 };

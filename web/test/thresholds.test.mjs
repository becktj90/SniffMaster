import test from "node:test";
import assert from "node:assert/strict";
import {
  THRESHOLDS,
  GAS_BASE_REFRESH_MS,
  nearAlertThreshold,
  evaluateBreaches,
  normalizeReading,
} from "../lib/thresholds.js";

// A comfortable all-clear snapshot: every reading far from every limit.
const CLEAR = {
  tempC: 22, humidity: 45, pressHpa: 1013, gasR: 180000, iaq: 40, co2: 600,
  pm25: 5, pm10: 8, hcho: 10, receivedAt: Date.now(),
};
const BASE_STATE = { activeKeys: [], sentAt: {}, gasBase: 180000, gasBaseAt: Date.now() };

test("gate stays closed on an all-clear snapshot far from every limit", () => {
  assert.equal(nearAlertThreshold(CLEAR, THRESHOLDS, "industrial", BASE_STATE), false);
  assert.equal(nearAlertThreshold(CLEAR, THRESHOLDS, "home", BASE_STATE), false);
});

test("gate opens within a margin of a limit, and on a breach itself", () => {
  assert.equal(nearAlertThreshold({ ...CLEAR, humidity: 56 }, THRESHOLDS, "industrial", BASE_STATE), true); // 60 - 5
  assert.equal(nearAlertThreshold({ ...CLEAR, humidity: 54 }, THRESHOLDS, "industrial", BASE_STATE), false);
  assert.equal(nearAlertThreshold({ ...CLEAR, tempC: 38.5 }, THRESHOLDS, "industrial", BASE_STATE), true); // 40 - 2
  assert.equal(nearAlertThreshold({ ...CLEAR, iaq: 130 }, THRESHOLDS, "industrial", BASE_STATE), true); // 150 - 20
  assert.equal(nearAlertThreshold({ ...CLEAR, co2: 900 }, THRESHOLDS, "industrial", BASE_STATE), true); // 1000 - 100
  assert.equal(nearAlertThreshold({ ...CLEAR, co2: 899 }, THRESHOLDS, "industrial", BASE_STATE), false);
  assert.equal(nearAlertThreshold({ ...CLEAR, humidity: 80 }, THRESHOLDS, "industrial", BASE_STATE), true);
});

test("gate opens whenever a breach is already active, even if the air cleared", () => {
  const active = { activeKeys: ["humidity"], sentAt: {}, gasBase: 180000, gasBaseAt: Date.now() };
  assert.equal(nearAlertThreshold(CLEAR, THRESHOLDS, "industrial", active), true);
});

test("home-only limits gate only in home mode", () => {
  assert.equal(nearAlertThreshold({ ...CLEAR, pm25: 31 }, THRESHOLDS, "home", BASE_STATE), true); // 35 - 5
  assert.equal(nearAlertThreshold({ ...CLEAR, pm25: 31 }, THRESHOLDS, "industrial", BASE_STATE), false);
  assert.equal(nearAlertThreshold({ ...CLEAR, hcho: 72 }, THRESHOLDS, "home", BASE_STATE), true); // 81 - 10
  assert.equal(nearAlertThreshold({ ...CLEAR, hcho: 72 }, THRESHOLDS, "industrial", BASE_STATE), false);
  assert.equal(nearAlertThreshold({ ...CLEAR, humidity: 28 }, THRESHOLDS, "home", BASE_STATE), true); // dry floor 25 + 5
  assert.equal(nearAlertThreshold({ ...CLEAR, humidity: 28 }, THRESHOLDS, "industrial", BASE_STATE), false);
});

test("gas gate uses the stored baseline with a wider ratio than the trip", () => {
  // Trip is gasR <= 60% of baseline; gate opens at <= 75%.
  assert.equal(nearAlertThreshold({ ...CLEAR, gasR: 135000 }, THRESHOLDS, "industrial", BASE_STATE), true); // 75%
  assert.equal(nearAlertThreshold({ ...CLEAR, gasR: 135001 }, THRESHOLDS, "industrial", BASE_STATE), false);
  // No stored baseline yet: evaluate once to learn it.
  assert.equal(nearAlertThreshold(CLEAR, THRESHOLDS, "industrial", { activeKeys: [], sentAt: {} }), true);
  // Stale baseline (>6h): evaluate once to re-learn it.
  const stale = { activeKeys: [], sentAt: {}, gasBase: 180000, gasBaseAt: Date.now() - GAS_BASE_REFRESH_MS - 1000 };
  assert.equal(nearAlertThreshold(CLEAR, THRESHOLDS, "industrial", stale), true);
  // A baseline below the noise floor cannot trip the gas test at all.
  const lowBase = { activeKeys: [], sentAt: {}, gasBase: 500, gasBaseAt: Date.now() };
  assert.equal(nearAlertThreshold({ ...CLEAR, gasR: 100 }, THRESHOLDS, "industrial", lowBase), false);
});

test("gate and evaluateBreaches agree: a closed gate means no breach and no state change", () => {
  const cases = [
    CLEAR,
    { ...CLEAR, humidity: 50, co2: 800, iaq: 100 },
    { ...CLEAR, tempC: 30, gasR: 150000 },
    { ...CLEAR, humidity: 35, pm25: 20, hcho: 50 },
  ];
  for (const snap of cases) {
    for (const env of ["industrial", "office", "home"]) {
      const reading = normalizeReading(snap);
      const open = nearAlertThreshold(reading, THRESHOLDS, env, BASE_STATE);
      const breaches = evaluateBreaches(reading, BASE_STATE.gasBase, THRESHOLDS, env);
      if (!open) assert.deepEqual(breaches, [], `${env} ${JSON.stringify(snap)}`);
    }
  }
});

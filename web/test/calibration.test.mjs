import test from "node:test";
import assert from "node:assert/strict";
import { calState } from "../public/calibration.js";

test("calibration pill labels follow the Sensors page thresholds", () => {
  assert.deepEqual(calState(3), { label: "Calibrated", tone: "good", known: true });
  assert.deepEqual(calState(2), { label: "Calibrated", tone: "fair", known: true });
  assert.deepEqual(calState(1), { label: "Calibrating", tone: "poor", known: true });
  assert.deepEqual(calState(0), { label: "Calibrating", tone: "poor", known: true });
  assert.deepEqual(calState("2"), { label: "Calibrated", tone: "fair", known: true });
});

test("unknown accuracy is a neutral state, never a wrong one", () => {
  assert.deepEqual(calState(null), { label: "Checking…", tone: "na", known: false });
  assert.deepEqual(calState(undefined), { label: "Checking…", tone: "na", known: false });
  assert.deepEqual(calState(""), { label: "Checking…", tone: "na", known: false });
  assert.deepEqual(calState("nope"), { label: "Checking…", tone: "na", known: false });
});

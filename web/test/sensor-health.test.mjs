// Sensor Health page: calibration stages, feed freshness, Wi-Fi quality,
// reading validity, and the wiring (pill target, route, Sensors link).
// Pure logic is unit-tested from the modules; markup wiring is checked
// with static source assertions — no DOM in this VM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { calStage } from "../public/calibration.js";
import { feedState, wifiState, readingChecks, fmtUptime, FEED_LIVE_MS } from "../public/sensor-health.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const appText = readFileSync(path.join(root, "../public/app.js"), "utf8");
const htmlText = readFileSync(path.join(root, "../public/index.html"), "utf8");
const cssText = readFileSync(path.join(root, "../public/style.css"), "utf8");

test("calibration stages map iaqAcc 0–3 to plain-language progress", () => {
  assert.deepEqual(
    (({ acc, known, index, label, tone }) => ({ acc, known, index, label, tone }))(calStage(0)),
    { acc: 0, known: true, index: 0, label: "Stabilizing", tone: "poor" });
  assert.deepEqual(
    (({ acc, known, index, label, tone }) => ({ acc, known, index, label, tone }))(calStage(1)),
    { acc: 1, known: true, index: 1, label: "Low", tone: "poor" });
  assert.deepEqual(
    (({ acc, known, index, label, tone }) => ({ acc, known, index, label, tone }))(calStage(2)),
    { acc: 2, known: true, index: 2, label: "Medium", tone: "fair" });
  assert.deepEqual(
    (({ acc, known, index, label, tone }) => ({ acc, known, index, label, tone }))(calStage(3)),
    { acc: 3, known: true, index: 3, label: "High", tone: "good" });
  assert.match(calStage(1).needs, /varied air/i, "low stage says what it needs");
  assert.match(calStage(3).needs, /nothing/i, "high stage needs nothing");
});

test("unknown accuracy is a neutral stage, never a wrong one", () => {
  for (const v of [null, undefined, "", "nope"]) {
    const s = calStage(v);
    assert.equal(s.known, false, "known false for " + JSON.stringify(v));
    assert.equal(s.label, "Checking…");
    assert.equal(s.tone, "na");
    assert.equal(s.index, -1);
  }
});

test("feed freshness uses the same 15-minute live rule as the header", () => {
  assert.equal(FEED_LIVE_MS, 15 * 60 * 1000);
  const now = 1_800_000_000_000;
  assert.equal(feedState(now - 60_000, now).state, "live");
  assert.equal(feedState(now - 14 * 60_000, now).state, "live");
  assert.equal(feedState(now - 15 * 60_000, now).state, "stale");
  assert.equal(feedState(now - 3_600_000, now).state, "stale");
  assert.equal(feedState(null, now).state, "none");
  assert.equal(feedState(now - 60_000, now).ageMs, 60_000);
});

test("Wi-Fi quality bands follow dBm", () => {
  assert.deepEqual(wifiState(-40), { label: "Strong", tone: "good", dbm: -40 });
  assert.deepEqual(wifiState(-60), { label: "Good", tone: "good", dbm: -60 });
  assert.deepEqual(wifiState(-70), { label: "Fair", tone: "fair", dbm: -70 });
  assert.deepEqual(wifiState(-82), { label: "Weak", tone: "poor", dbm: -82 });
  assert.deepEqual(wifiState(null), { label: "Unknown", tone: "na", dbm: null });
  assert.deepEqual(wifiState(""), { label: "Unknown", tone: "na", dbm: null });
});

test("reading checks flag missing values and the publishing state", () => {
  const full = { iaq: 71, co2: 595, tempF: 75, humidity: 58.2, pressHpa: 1020.9, gasR: 707916 };
  const c = readingChecks(full);
  assert.equal(c.publishing, true);
  assert.equal(c.rows.length, 6);
  assert.ok(c.rows.every((r) => r.ok));
  assert.equal(c.rows.find((r) => r.key === "co2").text, "595 ppm");

  const partial = { iaq: 0, co2: 0, tempF: 75, humidity: null, pressHpa: 1020.9, gasR: 0 };
  const p = readingChecks(partial);
  assert.equal(p.publishing, false);
  assert.equal(p.rows.find((r) => r.key === "humidity").ok, false);
  assert.equal(p.rows.find((r) => r.key === "humidity").text, "—");
  assert.equal(p.rows.find((r) => r.key === "gasR").ok, false);

  const none = readingChecks(null);
  assert.equal(none.publishing, false);
  assert.ok(none.rows.every((r) => !r.ok));
});

test("uptime formats in plain words", () => {
  assert.equal(fmtUptime(128), "2 min");
  assert.equal(fmtUptime(3600), "1.0 h");
  assert.equal(fmtUptime(21435), "6.0 h");
  assert.equal(fmtUptime(3 * 86400), "3.0 d");
  assert.equal(fmtUptime(null), "—");
  assert.equal(fmtUptime(-5), "—");
});

test("header calibration pill opens the Sensor Health page", () => {
  assert.match(htmlText, /id="cal-pill" href="#\/sensor-health"/, "pill href is #/sensor-health");
  assert.match(htmlText, /sensor-health\.js/, "sensor-health module is loaded");
  assert.doesNotMatch(htmlText, /id="cal-pill" href="#\/sensors"/, "pill no longer points at #/sensors");
});

test("Sensor Health route exists and polls the lightweight snapshot", () => {
  assert.match(appText, /"sensor-health":\s*\{\s*render:\s*pageSensorHealth,\s*poll:\s*\["latest"\]/, "route registered with latest poll");
  assert.match(appText, /function pageSensorHealth\(\)/, "page function exists");
  assert.match(appText, /sniff-health-ready/, "module-ready listener present");
  assert.match(appText, /currentRoute === "sensor-health"/, "30s interval re-renders the page");
});

test("Sensors calibration card links to the new page", () => {
  assert.match(appText, /href="#\/sensor-health">Sensor Health page<\/a>/, "Sensors card links to Sensor Health");
  assert.match(appText, /function calibrationNote\(L\)/, "shared calibration note lives at top level");
});

test("calibration stepper styles exist", () => {
  assert.match(cssText, /\.cal-steps\s*\{/, ".cal-steps grid exists");
  assert.match(cssText, /\.cal-steps \.step\.now\.good i/, "current calibrated step reads good");
  assert.match(cssText, /\.cal-steps \.step\.done i/, "passed steps read done");
});

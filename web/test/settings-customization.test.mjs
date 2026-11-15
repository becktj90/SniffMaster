// Settings customization: health profile (environment + sensitivity
// presets + alert limits) and per-trigger severity. Pure logic is unit-
// tested from the modules; markup wiring is checked with static source
// assertions — no DOM in this VM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  SENSITIVITY_PRESETS,
  SENSITIVITY_FIELDS,
  presetFor,
  ENVIRONMENTS,
} from "../public/sensitivity.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const appText = readFileSync(path.join(root, "../public/app.js"), "utf8");
const htmlText = readFileSync(path.join(root, "../public/index.html"), "utf8");
const cssText = readFileSync(path.join(root, "../public/style.css"), "utf8");
const extrasText = readFileSync(path.join(root, "../api/extras.js"), "utf8");

test("sensitivity presets are all within the server's safe limits", () => {
  // THRESHOLD_LIMITS in web/lib/thresholds.js — keep in sync if they move.
  const limits = {
    humidityHigh: [40, 90],
    tempHighC: [25, 70],
    co2High: [600, 2000],
    iaqPoor: [50, 300],
    pm25High: [9, 150],
    gasDropPct: [20, 70],
  };
  for (const [name, preset] of Object.entries(SENSITIVITY_PRESETS)) {
    for (const [key, [min, max]] of Object.entries(limits)) {
      assert.ok(
        Number.isFinite(preset.values[key]) && preset.values[key] >= min && preset.values[key] <= max,
        `${name}.${key} = ${preset.values[key]} outside [${min}, ${max}]`
      );
    }
  }
  // Sensitive trips sooner than standard on every limit that matters.
  const std = SENSITIVITY_PRESETS.standard.values;
  const sen = SENSITIVITY_PRESETS.sensitive.values;
  const very = SENSITIVITY_PRESETS.verySensitive.values;
  for (const k of ["humidityHigh", "tempHighC", "co2High", "iaqPoor", "pm25High", "gasDropPct"]) {
    assert.ok(sen[k] < std[k], `sensitive ${k} should be tighter than standard`);
    assert.ok(very[k] <= sen[k], `verySensitive ${k} should be at least as tight as sensitive`);
  }
});

test("presetFor matches each preset and reports hand-tuned mixes as custom", () => {
  assert.equal(presetFor(SENSITIVITY_PRESETS.standard.values), "standard");
  assert.equal(presetFor(SENSITIVITY_PRESETS.sensitive.values), "sensitive");
  assert.equal(presetFor(SENSITIVITY_PRESETS.verySensitive.values), "verySensitive");
  assert.equal(presetFor({ ...SENSITIVITY_PRESETS.standard.values, co2High: 900 }), "custom");
  assert.equal(presetFor({}), "custom");
});

test("sensitivity fields cover all six adjustable limits", () => {
  assert.deepEqual(
    SENSITIVITY_FIELDS.map((f) => f.key),
    ["humidityHigh", "tempHighC", "co2High", "iaqPoor", "pm25High", "gasDropPct"]
  );
  for (const f of SENSITIVITY_FIELDS) {
    assert.ok(f.label && f.unit && Number.isFinite(f.min) && Number.isFinite(f.max) && f.min < f.max, f.key);
  }
});

test("environment list matches the server's environment types", () => {
  assert.deepEqual(
    ENVIRONMENTS.map((e) => e.key),
    ["home", "office", "industrial"]
  );
  for (const e of ENVIRONMENTS) assert.ok(e.label && e.blurb, e.key);
});

test("settings page fetches server settings and renders the profile card", () => {
  assert.match(appText, /getJSON\("\/api\/settings"\)/);
  assert.match(appText, /Health profile/);
  assert.match(appText, /data-env=/);
  assert.match(appText, /data-sensitivity=/);
  assert.match(appText, /data-setting=/);
  assert.match(appText, /settings-save-note/);
  assert.match(appText, /fetch\("\/api\/settings", \{ method: "POST"/);
  // Alert rules stay read-only in Settings: the settings render shows
  // pills and links over, and wires no rule toggle of its own (the
  // data-rule toggles live on the Alerts page, where the subscription is).
  const settingsStart = appText.indexOf("async function pageSettings()");
  const settingsEnd = appText.indexOf("// ── Sensor Health ─");
  const settingsText = appText.slice(settingsStart, settingsEnd);
  assert.doesNotMatch(settingsText, /data-rule=/);
  assert.match(settingsText, /Manage alerts/);
});

test("severity rows render for picked triggers and persist per device", () => {
  assert.match(appText, /data-sev-trig=/);
  assert.match(appText, /data-sev="/);
  assert.match(appText, /sm-trigger-severity/);
  assert.match(appText, /How strongly each one affects you/);
});

test("home URL carries the severity alongside the triggers", () => {
  assert.match(appText, /&severity=/);
  assert.match(appText, /sev\[k\] !== "moderate"/);
});

test("trigger list grew to the new allergy options", () => {
  for (const key of ["treePollen", "grassPollen", "weedPollen", "dust", "voc", "dryAir"]) {
    assert.match(appText, new RegExp(`"${key}"`), `TRIGGERS missing ${key}`);
  }
  assert.match(appText, /Tree pollen/);
  assert.match(appText, /Fragrances & chemicals/);
  assert.match(appText, /Dry air/);
});

test("server threads severity through the home payload and cache key", () => {
  assert.match(extrasText, /buildHomePayload\(req\.query\?\.triggers, req\.query\?\.severity\)/);
  assert.match(extrasText, /canonicalSeverities\(severitiesInput\)/);
  assert.match(extrasText, /allergyOutlook\(withPollen, triggers, smell, severitiesInput\)/);
});

test("sensitivity module is loaded and styled", () => {
  assert.match(htmlText, /<script type="module" src="\/sensitivity\.js"><\/script>/);
  assert.match(cssText, /\.sev-row/);
  assert.match(cssText, /\.thresh-grid/);
  assert.match(cssText, /\.thresh input/);
});

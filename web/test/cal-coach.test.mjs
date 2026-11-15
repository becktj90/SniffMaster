// Calibration coaching on the Sensor Health page: one next action per
// stage, the stuck-vs-learning distinction, and the wiring (module load,
// page render, ready listener). Pure logic is unit-tested from the module;
// markup wiring is checked with static source assertions — no DOM in this VM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  coachAdvice,
  recordStage,
  daysAtStage,
  isSettled,
  isPublishing,
  PROGRESS_NOTES,
  FEED_LIVE_MS,
  STUCK_DAYS,
  MAX_HISTORY,
} from "../public/cal-coach.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const appText = readFileSync(path.join(root, "../public/app.js"), "utf8");
const htmlText = readFileSync(path.join(root, "../public/index.html"), "utf8");
const cssText = readFileSync(path.join(root, "../public/style.css"), "utf8");

const NOW = 1_800_000_000_000;

// A healthy, live, publishing snapshot; tests override one field at a time.
function live(over = {}) {
  return Object.assign(
    {
      iaqAcc: 1,
      receivedAt: NOW - 60_000,
      uptime: 86400,
      stab: 1,
      runIn: 1,
      gasR: 700000,
      iaq: 71,
      co2: 595,
      gasValid: true,
      bsecRestored: true,
      calibration: "Calibrating sensor",
    },
    over
  );
}

test("unknown accuracy is neutral, never a wrong action", () => {
  for (const L of [null, undefined, {}, { iaqAcc: null }, { iaqAcc: "nope" }]) {
    const c = coachAdvice(L, NOW, []);
    assert.equal(c.known, false, "known false for " + JSON.stringify(L));
    assert.equal(c.headline, "Checking…");
  }
});

test("a stale feed comes before any calibration advice", () => {
  const c = coachAdvice(live({ iaqAcc: 3, receivedAt: NOW - 3_600_000 }), NOW, []);
  assert.equal(c.headline, "Fix the feed first");
  assert.equal(c.tone, "poor");
  assert.match(c.action, /power and Wi-Fi/i);
  assert.match(c.why, /fresh readings/i);
});

test("stage 0 warming up: leave it alone", () => {
  const c = coachAdvice(live({ iaqAcc: 0, stab: 0, runIn: 0, uptime: 300 }), NOW, []);
  assert.equal(c.headline, "Warming up — just wait");
  assert.match(c.action, /leave it running where it is/i);
  assert.match(c.why, /power-on/i);
});

test("stage 0 for over an hour without settling is flagged unusual", () => {
  const c = coachAdvice(live({ iaqAcc: 0, stab: 0, runIn: 0, uptime: 7200 }), NOW, []);
  assert.match(c.headline, /unusual/i);
  assert.equal(c.tone, "poor");
  assert.match(c.action, /power-cycle/i);
});

test("stage 1 without flowing gas readings points at system health", () => {
  const c = coachAdvice(live({ gasR: 0, co2: 0 }), NOW, []);
  assert.equal(c.headline, "Readings aren't flowing yet");
  assert.match(c.action, /System health/i);
});

test("stage 1 still in run-in: don't move it", () => {
  const c = coachAdvice(live({ stab: 0, runIn: 0 }), NOW, []);
  assert.equal(c.headline, "Finishing run-in — leave it be");
  assert.match(c.action, /leave it where it is/i);
  assert.match(c.why, /run-in/i);
});

test("stage 1 settled in still air: the move-it case", () => {
  const c = coachAdvice(live({}), NOW, []);
  assert.equal(c.headline, "Give it different air");
  assert.equal(c.tone, "fair");
  assert.match(c.action, /move the sensor to a busier spot/i);
  assert.match(c.action, /for a day/i);
  assert.match(c.why, /air changes/i);
  assert.equal(c.stuck, "");
});

test("stage 1 for 4+ days is flagged stuck, under 4 days is not", () => {
  const old = [{ acc: 1, at: NOW - 5 * 86400000 }];
  const stuck = coachAdvice(live({}), NOW, old);
  assert.match(stuck.stuck, /longer than the usual learning window/i);
  assert.equal(stuck.daysAtStage, 5);

  const recent = [{ acc: 1, at: NOW - 2 * 86400000 }];
  const learning = coachAdvice(live({}), NOW, recent);
  assert.equal(learning.stuck, "");
  assert.equal(learning.daysAtStage, 2);
  assert.equal(STUCK_DAYS, 4, "stuck threshold matches the 4-day config window");
});

test("stage 2 is calibrated and stage 3 is fully done", () => {
  const two = coachAdvice(live({ iaqAcc: 2 }), NOW, []);
  assert.equal(two.headline, "Calibrated — nothing needed");
  assert.match(two.action, /nothing needed/i);
  assert.match(two.why, /trustworthy baseline/i);

  const three = coachAdvice(live({ iaqAcc: 3 }), NOW, []);
  assert.equal(three.headline, "Fully calibrated — all set");
  assert.equal(three.tone, "good");
  assert.match(three.action, /all set/i);
});

test("a boot without restored calibration is flagged, not hidden", () => {
  const c = coachAdvice(live({ bsecRestored: false }), NOW, []);
  assert.equal(c.freshBoot, true);
  const restored = coachAdvice(live({ bsecRestored: true }), NOW, []);
  assert.equal(restored.freshBoot, false);
});

test("stage history only grows on change and is capped", () => {
  let h = recordStage([], 0, NOW);
  assert.deepEqual(h, [{ acc: 0, at: NOW }]);
  h = recordStage(h, 0, NOW + 30_000);
  assert.equal(h.length, 1, "same stage adds nothing");
  h = recordStage(h, 1, NOW + 60_000);
  assert.equal(h.length, 2, "a stage change appends");
  assert.deepEqual(h[1], { acc: 1, at: NOW + 60_000 });

  let big = [];
  for (let i = 0; i < 45; i++) big = recordStage(big, i % 4, NOW + i * 1000);
  assert.equal(big.length, MAX_HISTORY, "history is capped");
  assert.equal(big[big.length - 1].acc, 0, "newest entry kept");

  assert.equal(daysAtStage([], NOW), null, "no history, no days");
  assert.equal(daysAtStage([{ acc: 1, at: NOW - 3 * 86400000 }], NOW), 3);
});

test("settled and publishing match the firmware's definitions", () => {
  assert.equal(isSettled({ stab: 0, runIn: 1 }), true);
  assert.equal(isSettled({ stab: 1, runIn: 0 }), true);
  assert.equal(isSettled({ stab: 0, runIn: 0 }), false);
  assert.equal(isPublishing({ gasR: 700000, iaq: 71, co2: 595 }), true);
  assert.equal(isPublishing({ gasR: 0, iaq: 71, co2: 595 }), false);
  assert.equal(FEED_LIVE_MS, 15 * 60 * 1000, "same 15-minute live rule as the header");
});

test("progress notes are grounded, not invented timelines", () => {
  assert.equal(PROGRESS_NOTES.length, 4);
  assert.match(PROGRESS_NOTES.join(" "), /4 days/i, "names the 4-day learning window");
  assert.match(PROGRESS_NOTES.join(" "), /reboot/i, "covers reboots resuming");
  assert.match(PROGRESS_NOTES.join(" "), /clean-air baseline/i, "covers calm-air learning");
  assert.doesNotMatch(PROGRESS_NOTES.join(" "), /exactly \d+ hours|guaranteed/i, "no invented guarantees");
});

test("coaching is wired into the Sensor Health page", () => {
  assert.match(htmlText, /cal-coach\.js/, "coaching module is loaded");
  assert.match(appText, /window\.SniffCoach/, "page uses the coaching module");
  assert.match(appText, /coachAdvice\(L, Date\.now\(\), calHistory\)/, "advice is computed from the live snapshot");
  assert.match(appText, /sm-cal-history/, "stage history is kept on this device");
  assert.match(appText, /What the sensor still needs/, "coaching card heading exists");
  assert.match(appText, /What counts as progress/, "progress explainer exists");
  assert.match(appText, /sniff-coach-ready/, "module-ready listener present");
  assert.match(cssText, /\.coach-points\s*\{/, "coaching list styles exist");
});

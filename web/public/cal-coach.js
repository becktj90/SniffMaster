// Calibration coaching for the Sensor Health page.
//
// Pure functions that turn the live snapshot into one useful next action:
// what the sensor still needs, why, and whether its learning looks stuck.
// The dashboard script (app.js, a classic script) uses the `window.SniffCoach`
// global below; the exports keep the logic testable from node.
//
// Grounding — everything below comes from the firmware / repo, not guesses:
//   * BSEC runs the 4-day configuration (`bme680_iaq_33v_3s_4d`): full
//     accuracy (3) takes up to about 4 days of powered operation with
//     varied air, and cannot be reached if every boot is a cold start
//     (firmware/src/main.cpp, docs/firmware-bme688-google-env-plan.md).
//   * "Accuracy 2 needs the air to change. An hour in a still room often
//     stays at 1." — accuracyLimitedBySteadyAir(), main.cpp. A running
//     sensor in still air is not a broken sensor.
//   * The sensor is physically settled when stabilization or run-in
//     completes (stab >= 1 or runIn >= 1) — bsecPhysicallySettled().
//   * The home baseline is learned from calm, still air (25 calm samples)
//     — updateHomeBaseline().
//   * Calibration state is saved to flash and restored on boot
//     (bsecRestored); a boot that restores it resumes learning instead of
//     starting over — though accuracy dips briefly while the sensor warms
//     back up.
//   * The dashboard only sees stage changes while this page is open, so the
//     "days at this stage" figure is a lower bound observed on this device,
//     not continuous monitoring. No claim is made about time nobody watched.

// Same 15-minute "live" rule as the header status (app.js setStatus) and
// sensor-health.js.
export var FEED_LIVE_MS = 15 * 60 * 1000;

// Full accuracy takes up to about 4 days (the 4-day BSEC configuration), so
// sitting at Low for at least this long is longer than the usual window.
export var STUCK_DAYS = 4;

// Stage history is capped so localStorage stays tiny.
export var MAX_HISTORY = 40;

function isNum(v) {
  return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
}

function flagOn(v) {
  return v === 1 || v === true;
}

/**
 * Is the snapshot's calibration stage settled (stabilization or run-in done)?
 * Mirrors bsecPhysicallySettled() in firmware/src/main.cpp.
 * @param {object} L latest snapshot
 * @returns {boolean}
 */
export function isSettled(L) {
  var s = L || {};
  return flagOn(s.stab) || flagOn(s.runIn);
}

/**
 * Is the device publishing complete readings (the same check the Sensors
 * page and sensor-health.js use)?
 * @param {object} L latest snapshot
 * @returns {boolean}
 */
export function isPublishing(L) {
  var s = L || {};
  return isNum(s.gasR) && Number(s.gasR) > 0 && isNum(s.iaq) && isNum(s.co2) && Number(s.co2) > 0;
}

/**
 * Record a stage observation. Appends only when the stage changed (or the
 * history is empty), so a page that re-renders every 30 s does not flood
 * the log. Capped at MAX_HISTORY entries.
 * @param {Array<{acc: number, at: number}>|null|undefined} history
 * @param {number} acc calibration stage index 0–3
 * @param {number} nowMs Date.now()
 * @returns {Array<{acc: number, at: number}>}
 */
export function recordStage(history, acc, nowMs) {
  var h = Array.isArray(history) ? history.slice() : [];
  var a = Math.max(0, Math.min(3, Math.floor(Number(acc) || 0)));
  var last = h[h.length - 1];
  if (!last || last.acc !== a) {
    h.push({ acc: a, at: nowMs });
  }
  if (h.length > MAX_HISTORY) h = h.slice(h.length - MAX_HISTORY);
  return h;
}

/**
 * Days observed at the current (last) stage — a lower bound, since the
 * dashboard only watches while this page is open. Null when there is no
 * usable history yet.
 * @param {Array<{acc: number, at: number}>|null|undefined} history
 * @param {number} nowMs Date.now()
 * @returns {number|null}
 */
export function daysAtStage(history, nowMs) {
  if (!Array.isArray(history) || history.length === 0) return null;
  var last = history[history.length - 1];
  if (!last || !isNum(last.at)) return null;
  return Math.max(0, (nowMs - Number(last.at)) / 86400000);
}

/**
 * The single most useful next action for the sensor's learning, from the
 * live snapshot and the observed stage history.
 * @param {object|null|undefined} L latest snapshot
 * @param {number} nowMs Date.now()
 * @param {Array<{acc: number, at: number}>|null|undefined} history
 * @returns {{known: boolean, tone: string, headline: string, action: string, why: string, stuck: string, daysAtStage: number|null, freshBoot: boolean, stage: number}}
 */
export function coachAdvice(L, nowMs, history) {
  var none = { known: false, tone: "na", headline: "Checking…", action: "", why: "", stuck: "", daysAtStage: null, freshBoot: false, stage: -1 };
  if (!L || !isNum(L.iaqAcc)) return none;
  var acc = Math.max(0, Math.min(3, Math.floor(Number(L.iaqAcc))));
  var days = daysAtStage(history, nowMs);
  var freshBoot = L.bsecRestored === false;
  var base = { known: true, tone: "na", headline: "", action: "", why: "", stuck: "", daysAtStage: days, freshBoot: freshBoot, stage: acc };

  // The feed comes before everything: with no fresh readings we cannot see
  // how calibration is going at all (the sensor itself may be learning
  // fine — the dashboard just has nothing new to show for it).
  if (isNum(L.receivedAt) && nowMs - Number(L.receivedAt) >= FEED_LIVE_MS) {
    return Object.assign(base, {
      tone: "poor",
      headline: "Fix the feed first",
      action: "No new readings have arrived for a while, so we can't tell how calibration is going. Check the device's power and Wi-Fi, and the router — a reboot of the device usually brings the feed back.",
      why: "Calibration progress is only visible while fresh readings arrive.",
    });
  }

  if (acc === 0) {
    var uptime = isNum(L.uptime) ? Number(L.uptime) : null;
    if (uptime !== null && uptime >= 3600 && !isSettled(L)) {
      return Object.assign(base, {
        tone: "poor",
        headline: "Still warming after an hour — that's unusual",
        action: "Power-cycle the device and watch for it to move to Calibrating. If it keeps sitting at Stabilizing, the sensor may not be starting up properly.",
        why: "After power-on the sensor usually settles within minutes — an hour at Stabilizing is unusual.",
      });
    }
    return Object.assign(base, {
      tone: "poor",
      headline: "Warming up — just wait",
      action: "Leave it running where it is. It's stabilizing after power-on; readings will settle in a few minutes, and moving it now only restarts the wait.",
      why: "After power-on the heater and the BSEC model need a few minutes before the numbers mean anything.",
    });
  }

  if (acc === 1) {
    if (!isPublishing(L)) {
      return Object.assign(base, {
        tone: "poor",
        headline: "Readings aren't flowing yet",
        action: "Check the System health section below — gas readings aren't coming through yet. Calibration can't climb until the sensor is publishing complete readings.",
        why: "Accuracy is built from the gas channel. Until that flows, there is nothing for BSEC to learn from.",
      });
    }
    if (!isSettled(L)) {
      return Object.assign(base, {
        tone: "poor",
        headline: "Finishing run-in — leave it be",
        action: "Keep it powered and leave it where it is. It's still settling in after power-on — moving it now restarts the learning.",
        why: "Accuracy can't climb until the sensor settles. Run-in finishes on its own; it just needs powered time.",
      });
    }
    // Settled, publishing, still at Low: the steady-air case. The
    // firmware's own words: "Accuracy 2 needs the air to change. An hour
    // in a still room often stays at 1."
    var out = Object.assign(base, {
      tone: "fair",
      headline: "Give it different air",
      action: "Move the sensor to a busier spot for a day — near the kitchen, a lived-in room, or by a window you open — then move it back. Cooking, people coming and going, and fresh air all count.",
      why: "Accuracy only climbs when the air changes. An hour in a still room teaches it nothing new — the sensor is running fine, the air is just too steady.",
    });
    if (days !== null && days >= STUCK_DAYS) {
      out.stuck = "It's been at Low for " + Math.floor(days) + "+ days — longer than the usual learning window. Try the move above; if it still doesn't climb after a few days in varied air, check placement and power — a sensor that keeps losing power restarts its learning.";
    }
    return out;
  }

  if (acc === 2) {
    return Object.assign(base, {
      tone: "fair",
      headline: "Calibrated — nothing needed",
      action: "Nothing needed — the readings are usable now. Accuracy can still climb to High with more varied air over time; that's a bonus, not a requirement.",
      why: "Medium means the sensor has a trustworthy baseline for this room.",
    });
  }

  return Object.assign(base, {
    tone: "good",
    headline: "Fully calibrated — all set",
    action: "Nothing — you're all set.",
    why: "The sensor knows this room's air and is giving its best-accuracy readings.",
  });
}

// What counts as progress — static explainer, shown under the advice.
// Every line is grounded in the firmware notes above; no invented timelines.
export var PROGRESS_NOTES = [
  "Stages move over days, not minutes. Full accuracy takes up to about 4 days of powered operation with varied air — that's the 4-day BSEC configuration this sensor runs.",
  "A reboot doesn't start over from zero: calibration is saved and restored, so learning resumes — accuracy just dips briefly while the sensor warms back up.",
  "Quiet time counts too. The sensor learns its clean-air baseline during calm, still air, like overnight — that's part of the learning, not wasted time.",
  "Judge it by the stage, not the minute-to-minute IAQ. A stage moving up over days is progress; the IAQ number itself wobbles all day.",
];

if (typeof window !== "undefined") {
  window.SniffCoach = {
    coachAdvice: coachAdvice,
    recordStage: recordStage,
    daysAtStage: daysAtStage,
    isSettled: isSettled,
    isPublishing: isPublishing,
    PROGRESS_NOTES: PROGRESS_NOTES,
    FEED_LIVE_MS: FEED_LIVE_MS,
    STUCK_DAYS: STUCK_DAYS,
    MAX_HISTORY: MAX_HISTORY,
  };
  window.dispatchEvent(new Event("sniff-coach-ready"));
}

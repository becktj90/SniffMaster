// Calibration state for the header pill.
//
// Same thresholds as the Sensors page ("Sensor health & calibration" card)
// and the server (`web/lib/insights.js` treats iaqAcc >= 2 as calibrated):
//   iaqAcc >= 3  → Calibrated, high accuracy (good)
//   iaqAcc == 2  → Calibrated, medium accuracy (fair)
//   iaqAcc 0–1   → still Calibrating (poor)
//   unknown     → neutral "Checking…" — never a wrong state while the first
//                 reading is still loading.
//
// The dashboard script (app.js, a classic script) uses the `window.SniffCal`
// global below; the export keeps the mapping testable from node.

/**
 * Map a BSEC IAQ accuracy (0–3) to the header pill's label and tone.
 * @param {number|string|null|undefined} iaqAcc
 * @returns {{label: string, tone: string, known: boolean}}
 */
export function calState(iaqAcc) {
  if (iaqAcc === null || iaqAcc === undefined || iaqAcc === "") {
    return { label: "Checking…", tone: "na", known: false };
  }
  var acc = Number(iaqAcc);
  if (!isFinite(acc)) {
    return { label: "Checking…", tone: "na", known: false };
  }
  if (acc >= 3) return { label: "Calibrated", tone: "good", known: true };
  if (acc >= 2) return { label: "Calibrated", tone: "fair", known: true };
  return { label: "Calibrating", tone: "poor", known: true };
}

if (typeof window !== "undefined") {
  window.SniffCal = { calState: calState, calStage: calStage };
}

// Detailed calibration stage for the Sensor Health page. Same thresholds
// as calState above; adds the plain-language "how far along" story — what
// the sensor is doing at this stage and what it still needs. The "needs
// varied air" wording matches the Sensors page note: accuracy rises when
// the air changes, not from uptime alone.
var CAL_STAGES = [
  {
    label: "Stabilizing",
    tone: "poor",
    detail: "Warming up after power-on. The sensor is stabilizing and its readings aren't settled yet.",
    needs: "A few minutes to warm up — nothing to do but wait.",
  },
  {
    label: "Low",
    tone: "poor",
    detail: "Still learning the room. The sensor has a rough picture of the air but not a trustworthy baseline yet.",
    needs: "Varied air — opening a window, cooking, people coming and going. Accuracy rises when the air changes, not from uptime alone.",
  },
  {
    label: "Medium",
    tone: "fair",
    detail: "Calibrated. Good enough for everyday readings — the IAQ, CO₂ and VOC numbers are usable now.",
    needs: "Nothing required. Accuracy can still climb to High with more varied air over time.",
  },
  {
    label: "High",
    tone: "good",
    detail: "Fully calibrated. The sensor knows this room's air and is giving its best-accuracy readings.",
    needs: "Nothing — you're all set.",
  },
];

/**
 * Map a BSEC IAQ accuracy (0–3) to its calibration stage (0–3 of 3).
 * @param {number|string|null|undefined} iaqAcc
 * @returns {{acc: number|null, known: boolean, index: number, label: string, tone: string, detail: string, needs: string}}
 */
export function calStage(iaqAcc) {
  if (iaqAcc === null || iaqAcc === undefined || iaqAcc === "") {
    return { acc: null, known: false, index: -1, label: "Checking…", tone: "na", detail: "Waiting for the first reading to see where calibration stands.", needs: "" };
  }
  var acc = Number(iaqAcc);
  if (!isFinite(acc)) {
    return { acc: null, known: false, index: -1, label: "Checking…", tone: "na", detail: "Waiting for the first reading to see where calibration stands.", needs: "" };
  }
  var idx = Math.max(0, Math.min(3, Math.floor(acc)));
  var stage = CAL_STAGES[idx];
  return { acc: idx, known: true, index: idx, label: stage.label, tone: stage.tone, detail: stage.detail, needs: stage.needs };
}

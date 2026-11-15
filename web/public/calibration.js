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
  window.SniffCal = { calState: calState };
}

// Health profile: alert sensitivity presets + environment type.
//
// The server already stores owner-adjustable alert limits in Redis and
// merges them via getEffectiveThresholds() (web/lib/thresholds.js); the
// Settings page writes them through POST /api/settings. This module holds
// only the client-side preset definitions — which limit values a named
// sensitivity means — and the matcher that tells whether the live limits
// are one of the presets or a custom mix. Every preset value sits inside
// the server's THRESHOLD_LIMITS, and the server clamps anyway, so a preset
// can never silence monitoring.
//
// The dashboard script (app.js, a classic script) uses the
// `window.SniffSensitivity` global below; the exports keep the mapping
// testable from node.

/**
 * Named sensitivities → the six adjustable alert limits they set.
 * Standard is the built-in default. Sensitive and Very sensitive trip
 * alerts sooner: lower CO₂ / IAQ / PM2.5 limits, tighter humidity, and a
 * smaller gas-resistance drop counts as an event. tempHighC is a
 * heat-stress limit, so it comes down too for heat-sensitive people.
 */
export var SENSITIVITY_PRESETS = {
  standard: {
    label: "Standard",
    blurb: "The built-in limits — alerts only when conditions are clearly off.",
    values: { humidityHigh: 60, tempHighC: 40, co2High: 1000, iaqPoor: 150, pm25High: 35, gasDropPct: 40 },
  },
  sensitive: {
    label: "Sensitive",
    blurb: "Alerts sooner — for asthma, allergies or anyone who feels bad air early.",
    values: { humidityHigh: 55, tempHighC: 35, co2High: 800, iaqPoor: 100, pm25High: 25, gasDropPct: 30 },
  },
  verySensitive: {
    label: "Very sensitive",
    blurb: "Alerts at the first sign of trouble — for severe asthma or chemical sensitivity.",
    values: { humidityHigh: 50, tempHighC: 32, co2High: 700, iaqPoor: 75, pm25High: 15, gasDropPct: 25 },
  },
};

/** The adjustable limits, in the order the Settings page shows them. */
export var SENSITIVITY_FIELDS = [
  { key: "humidityHigh", label: "Humidity", unit: "% RH", min: 40, max: 90, step: 1 },
  { key: "tempHighC", label: "Temperature", unit: "°C", min: 25, max: 70, step: 1 },
  { key: "co2High", label: "CO₂", unit: "ppm", min: 600, max: 2000, step: 50 },
  { key: "iaqPoor", label: "IAQ (poor)", unit: "index", min: 50, max: 300, step: 5 },
  { key: "pm25High", label: "PM2.5", unit: "µg/m³", min: 9, max: 150, step: 1 },
  { key: "gasDropPct", label: "Gas drop", unit: "% drop", min: 20, max: 70, step: 5 },
];

/**
 * Which preset (if any) the live limit values match. Anything else is
 * "custom" — e.g. one limit hand-tuned away from its preset.
 * @param {object} values — effective limits, e.g. from GET /api/settings
 * @returns {"standard"|"sensitive"|"verySensitive"|"custom"}
 */
export function presetFor(values) {
  var v = values || {};
  var keys = Object.keys(SENSITIVITY_PRESETS);
  for (var i = 0; i < keys.length; i++) {
    var preset = SENSITIVITY_PRESETS[keys[i]].values;
    var match = Object.keys(preset).every(function (k) { return Number(v[k]) === preset[k]; });
    if (match) return keys[i];
  }
  return "custom";
}

/** Environment types, matching the server's ENVIRONMENT_TYPES. */
export var ENVIRONMENTS = [
  { key: "home", label: "Home", blurb: "A residence — particulate, mold and dust-mite humidity, dry air, VOCs and ventilation." },
  { key: "office", label: "Office", blurb: "A normally-occupied workspace — CO₂ and ventilation, and comfort for the people in it." },
  { key: "industrial", label: "Industrial", blurb: "An active work area with equipment and crews — condensation, heat and fumes." },
];

if (typeof window !== "undefined") {
  window.SniffSensitivity = {
    SENSITIVITY_PRESETS: SENSITIVITY_PRESETS,
    SENSITIVITY_FIELDS: SENSITIVITY_FIELDS,
    presetFor: presetFor,
    ENVIRONMENTS: ENVIRONMENTS,
  };
}

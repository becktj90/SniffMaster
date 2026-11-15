// Map layers for the Outside page — pure helpers + layer definitions.
//
// The "Around the house" map is a Leaflet map rebuilt on every Outside
// re-render (the route polls home + weather), so the user's layer choice
// is persisted in localStorage ("sm-map-layers") and restored on each
// rebuild — otherwise a poll tick would reset the map to the defaults.
//
// Every layer is backed by real data already on the page:
//   - Streets (OpenStreetMap) and Satellite (Esri World Imagery, free,
//     no key) base maps.
//   - "Air quality": the Google air-quality heatmap served by our own
//     /api/air-tile endpoint (only when home.googleAir.heatmap exists).
//   - "Pollen near home": a circle around the sensor colored by the worst
//     pollen level right now. Pollen is a regional point value, not a tile
//     field, so it is drawn as one honest circle at home — not fake tiles.
//   - "Your sensor": the existing pin (circle marker + popup).
//
// The dashboard script (app.js, a classic script) uses the
// `window.SniffMapLayers` global below; the exports keep the selection,
// availability, and pollen logic testable from node. Colors are passed in
// (dark flag) so this module stays pure — app.js knows the active theme.

export const BASE_LAYER_DEFS = [
  {
    key: "streets",
    label: "Streets",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 18,
    attribution: "© OpenStreetMap contributors",
  },
  {
    key: "satellite",
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 18,
    attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
];

export const AIR_OVERLAY_DEF = {
  key: "air",
  label: "Air quality",
  url: "/api/air-tile?z={z}&x={x}&y={y}",
  opacity: 0.62,
  minZoom: 6,
  maxZoom: 12,
  attribution: "Air colors: Google",
};

// Pollen is a regional reading, so the circle covers the neighborhood
// around the sensor rather than pretending to be a precise boundary.
export const POLLEN_RADIUS_M = 1000;
export const POLLEN_OVERLAY_LABEL = "Pollen near home";
export const SENSOR_OVERLAY_LABEL = "Your sensor";

// Tone colors from style.css (dark theme first, light second) so the
// pollen circle matches the pills and tones elsewhere on the dashboard.
export const TONE_COLORS = {
  dark: { good: "#3ccf74", fair: "#fab219", poor: "#ec835a", bad: "#f06262", na: "#8a94a6" },
  light: { good: "#0f8a3c", fair: "#a66b00", poor: "#c4501f", bad: "#c62f2f", na: "#6b7686" },
};

export const OVERLAY_KEYS = ["air", "pollen", "sensor"];

export function defaultMapLayers() {
  // Same view as before this change: streets + air heat when available +
  // sensor pin. Pollen is new and starts off — the user turns it on.
  return { base: "streets", overlays: { air: true, pollen: false, sensor: true } };
}

function isBool(v) {
  return v === true || v === false;
}

export function normalizeMapLayers(saved) {
  const d = defaultMapLayers();
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return d;
  const base = BASE_LAYER_DEFS.some(function (def) { return def.key === saved.base; }) ? saved.base : d.base;
  const overlays = {};
  for (const key of OVERLAY_KEYS) {
    overlays[key] = saved.overlays && isBool(saved.overlays[key]) ? saved.overlays[key] : d.overlays[key];
  }
  return { base, overlays };
}

// Which overlays can be offered for this home snapshot. The sensor pin is
// always available once the map exists (it only needs the location).
export function availableOverlays(home) {
  return {
    air: Boolean(home && home.googleAir && home.googleAir.heatmap),
    pollen: Boolean(home && home.pollen && home.pollen.ok),
    sensor: true,
  };
}

// Worst pollen item, mirroring the server's worstOf/pollenScore
// (web/lib/homeInsights.js): a numeric value wins when present, otherwise
// the category rank (Very low 1 … Very high 5) decides.
const CATEGORY_SCORE = { "Very low": 1, Low: 2, Moderate: 3, High: 4, "Very high": 5 };

function pollenScore(item) {
  if (!item || typeof item !== "object") return 0;
  const v = Number(item.value);
  if (Number.isFinite(v)) return v;
  if (item.category) return CATEGORY_SCORE[item.category] || 0;
  return 0;
}

export function pollenWorst(pollen) {
  if (!pollen || pollen.ok !== true) return null;
  const items = [].concat(pollen.types || [], pollen.plants || []);
  let worst = null;
  for (const item of items) {
    const score = pollenScore(item);
    if (!worst || score > worst.score) {
      worst = { name: item.name, category: item.category || null, value: item.value, score };
    }
  }
  return worst;
}

// Same word rules as the dashboard's levelTone (app.js): Low reads good,
// Moderate fair, High poor, anything worse bad.
export function pollenTone(category) {
  const l = String(category || "").toLowerCase();
  if (!l) return "na";
  if (/very low/.test(l) || /^(low|none|fresh|good|excellent|safe)/.test(l)) return "good";
  if (/^(moderate|fair|elevated|medium)/.test(l)) return "fair";
  if (/^(high)/.test(l)) return "poor";
  return "bad";
}

export function toneColor(tone, dark) {
  const palette = dark ? TONE_COLORS.dark : TONE_COLORS.light;
  return palette[tone] || palette.na;
}

// Leaflet circle options for the pollen overlay, or null when there is no
// usable pollen reading. The fill is deliberately light so the base map
// and the air heatmap still show through.
export function pollenCircleStyle(pollen, dark) {
  const worst = pollenWorst(pollen);
  if (!worst) return null;
  const color = toneColor(pollenTone(worst.category), dark);
  return { color, fillColor: color, fillOpacity: 0.15, weight: 2, radius: POLLEN_RADIUS_M };
}

if (typeof window !== "undefined") {
  window.SniffMapLayers = {
    BASE_LAYER_DEFS,
    AIR_OVERLAY_DEF,
    POLLEN_RADIUS_M,
    POLLEN_OVERLAY_LABEL,
    SENSOR_OVERLAY_LABEL,
    OVERLAY_KEYS,
    defaultMapLayers,
    normalizeMapLayers,
    availableOverlays,
    pollenWorst,
    pollenTone,
    toneColor,
    pollenCircleStyle,
  };
  window.dispatchEvent(new Event("sniff-map-layers-ready"));
}

// Outside map layers: base maps, overlay availability, pollen circle,
// and the persisted selection. Pure logic is unit-tested from the module;
// wiring is checked with static source assertions — no DOM in this VM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  BASE_LAYER_DEFS,
  AIR_OVERLAY_DEF,
  POLLEN_RADIUS_M,
  defaultMapLayers,
  normalizeMapLayers,
  availableOverlays,
  pollenWorst,
  pollenTone,
  toneColor,
  pollenCircleStyle,
} from "../public/map-layers.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const appText = readFileSync(path.join(root, "../public/app.js"), "utf8");
const htmlText = readFileSync(path.join(root, "../public/index.html"), "utf8");

test("defaults keep the old view: streets + air + sensor, pollen off", () => {
  assert.deepEqual(defaultMapLayers(), {
    base: "streets",
    overlays: { air: true, pollen: false, sensor: true },
  });
});

test("normalizeMapLayers repairs bad saved selections", () => {
  assert.deepEqual(normalizeMapLayers(null), defaultMapLayers());
  assert.deepEqual(normalizeMapLayers("streets"), defaultMapLayers());
  assert.deepEqual(
    normalizeMapLayers({ base: "satellite", overlays: { air: false, pollen: true, sensor: false } }),
    { base: "satellite", overlays: { air: false, pollen: true, sensor: false } }
  );
  // Unknown base falls back to streets; partial overlays fill from defaults.
  assert.deepEqual(
    normalizeMapLayers({ base: "topo", overlays: { pollen: true } }),
    { base: "streets", overlays: { air: true, pollen: true, sensor: true } }
  );
  // Non-boolean overlay values are not trusted.
  assert.deepEqual(
    normalizeMapLayers({ base: "streets", overlays: { air: "yes", pollen: 1, sensor: null } }),
    defaultMapLayers()
  );
});

test("base maps are Streets (OSM) and Satellite (Esri, free, no key)", () => {
  assert.deepEqual(
    BASE_LAYER_DEFS.map((d) => d.key),
    ["streets", "satellite"]
  );
  const streets = BASE_LAYER_DEFS[0];
  assert.equal(streets.url, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.match(streets.attribution, /OpenStreetMap/);
  const satellite = BASE_LAYER_DEFS[1];
  assert.equal(
    satellite.url,
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
  );
  assert.match(satellite.attribution, /Esri/);
  assert.match(satellite.attribution, /Maxar/);
});

test("air overlay def matches the existing /api/air-tile layer", () => {
  assert.equal(AIR_OVERLAY_DEF.url, "/api/air-tile?z={z}&x={x}&y={y}");
  assert.equal(AIR_OVERLAY_DEF.opacity, 0.62);
  assert.equal(AIR_OVERLAY_DEF.minZoom, 6);
  assert.equal(AIR_OVERLAY_DEF.maxZoom, 12);
  assert.match(AIR_OVERLAY_DEF.attribution, /Google/);
});

test("availableOverlays only offers layers the data backs", () => {
  assert.deepEqual(availableOverlays(null), { air: false, pollen: false, sensor: true });
  assert.deepEqual(availableOverlays({}), { air: false, pollen: false, sensor: true });
  assert.deepEqual(
    availableOverlays({ googleAir: { heatmap: true }, pollen: { ok: true } }),
    { air: true, pollen: true, sensor: true }
  );
  // Heatmap flag off, or pollen not ok, means no overlay — not a fake one.
  assert.deepEqual(
    availableOverlays({ googleAir: { heatmap: false }, pollen: { ok: false } }),
    { air: false, pollen: false, sensor: true }
  );
});

const pollenSample = {
  ok: true,
  types: [
    { name: "Grass", category: "Moderate", value: 3, code: "GRASS" },
    { name: "Tree", category: "Low", value: 2, code: "TREE" },
  ],
  plants: [{ name: "Ragweed", category: "High", code: "RAGWEED" }],
};

test("pollenWorst picks the highest score, value first then category", () => {
  assert.equal(pollenWorst(null), null);
  assert.equal(pollenWorst({ ok: false, types: [] }), null);
  assert.equal(pollenWorst({ ok: true, types: [], plants: [] }), null);
  // Ragweed has no value but category High (rank 4) beats Grass value 3.
  assert.equal(pollenWorst(pollenSample).name, "Ragweed");
  assert.equal(pollenWorst(pollenSample).category, "High");
  // A numeric value beats any category rank.
  assert.equal(
    pollenWorst({ ok: true, types: [{ name: "Birch", category: "Low", value: 5 }] }).name,
    "Birch"
  );
});

test("pollenTone follows the dashboard's level words", () => {
  assert.equal(pollenTone("Low"), "good");
  assert.equal(pollenTone("Very low"), "good");
  assert.equal(pollenTone("Moderate"), "fair");
  assert.equal(pollenTone("High"), "poor");
  assert.equal(pollenTone("Very high"), "bad");
  assert.equal(pollenTone(""), "na");
  assert.equal(pollenTone(null), "na");
});

test("toneColor matches the style.css palette in both themes", () => {
  assert.equal(toneColor("good", true), "#3ccf74");
  assert.equal(toneColor("fair", true), "#fab219");
  assert.equal(toneColor("poor", true), "#ec835a");
  assert.equal(toneColor("bad", true), "#f06262");
  assert.equal(toneColor("good", false), "#0f8a3c");
  assert.equal(toneColor("bad", false), "#c62f2f");
  assert.equal(toneColor("mystery", true), "#8a94a6");
});

test("pollenCircleStyle colors the circle by the worst pollen level", () => {
  assert.equal(pollenCircleStyle(null, true), null);
  assert.equal(pollenCircleStyle({ ok: false }, true), null);
  const style = pollenCircleStyle(pollenSample, true);
  // Ragweed High → poor → dark-theme #ec835a, light fill, 1 km radius.
  assert.equal(style.color, "#ec835a");
  assert.equal(style.fillColor, "#ec835a");
  assert.equal(style.fillOpacity, 0.15);
  assert.equal(style.radius, POLLEN_RADIUS_M);
  assert.equal(POLLEN_RADIUS_M, 1000);
  assert.equal(pollenCircleStyle(pollenSample, false).color, "#c4501f");
});

test("wiring: drawMap builds a layers control and persists the choice", () => {
  assert.match(appText, /L\.control\.layers\(baseMaps, overlays\)/);
  assert.match(appText, /store\("sm-map-layers"/);
  assert.match(appText, /normalizeMapLayers\(store\("sm-map-layers"\)\)/);
  assert.match(appText, /baselayerchange/);
  assert.match(appText, /overlayadd/);
  assert.match(appText, /overlayremove/);
  assert.match(appText, /sniff-map-layers-ready/);
  assert.match(appText, /POLLEN_OVERLAY_LABEL/);
  assert.match(htmlText, /<script type="module" src="\/map-layers\.js"><\/script>/);
});

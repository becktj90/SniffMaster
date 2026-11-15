// Chart viewing: zoom math, event detection (gaps + breaches), CSV export,
// and the per-chart view store. The DOM helpers (download, svgToPng) are
// covered by wiring assertions in app.js/style.css checks below.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  medianInterval,
  findGaps,
  sliceWindow,
  timeAtPixel,
  pixelAtTime,
  pinchWindow,
  detectBreaches,
  buildEvents,
  toCsv,
  csvFilename,
  pngFilename,
  createViewStore,
} from "../public/charts.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const jsText = readFileSync(path.join(root, "../public/app.js"), "utf8");
const cssText = readFileSync(path.join(root, "../public/style.css"), "utf8");
const htmlText = readFileSync(path.join(root, "../public/index.html"), "utf8");

// 1-minute cadence, 3 hours, with the Nov 15 outage baked in: no points
// from 13:21 to 14:22 ET (62 missing minutes), readings resume 14:23 — so
// the timestamp jump is 63 minutes.
function outageSeries() {
  const t = [];
  const start = Date.UTC(2026, 10, 15, 12, 0, 0);
  for (let m = 0; m < 180; m++) {
    if (m >= 81 && m < 143) continue; // 13:21–14:23 missing
    t.push(start + m * 60000);
  }
  return t;
}

test("medianInterval ignores the outage jump", () => {
  assert.equal(medianInterval(outageSeries()), 60000);
  assert.equal(medianInterval([]), null);
  assert.equal(medianInterval([1000]), null);
});

test("findGaps catches the 62-minute outage and nothing else", () => {
  const gaps = findGaps(outageSeries());
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].kind, "gap");
  assert.equal(gaps[0].mins, 63); // last point 13:20, first back 14:23
  assert.match(gaps[0].label, /Feed gap · 63 min/);
  // Steady 1-minute data has no gaps.
  const steady = Array.from({ length: 60 }, (_, i) => 1000 + i * 60000);
  assert.deepEqual(findGaps(steady), []);
  // A single 3-minute late post is not an outage (below the 4x bar).
  const late = [...steady.slice(0, 30), steady[29] + 180000, ...steady.slice(30).map((x) => x + 120000)];
  assert.deepEqual(findGaps(late), []);
});

test("findGaps works on the 10-minute compact series too", () => {
  const t = Array.from({ length: 100 }, (_, i) => 1000 + i * 600000);
  t.splice(50, 6); // 60 minutes missing
  const gaps = findGaps(t);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].mins, 70); // jump spans the missing buckets
});

test("sliceWindow keeps series aligned with timestamps", () => {
  const t = [1000, 2000, 3000, 4000, 5000];
  const series = [
    { name: "A", values: [1, 2, 3, 4, 5], color: "#000" },
    { name: "B", values: [null, 20, null, 40, 50], color: "#111", dash: true },
  ];
  const out = sliceWindow(t, series, [2000, 4000]);
  assert.deepEqual(out.t, [2000, 3000, 4000]);
  assert.deepEqual(out.series[0].values, [2, 3, 4]);
  assert.deepEqual(out.series[1].values, [20, null, 40]);
  assert.equal(out.series[1].dash, true);
  // No window: a copy, not the same arrays.
  const full = sliceWindow(t, series, null);
  assert.deepEqual(full.t, t);
  assert.notEqual(full.t, t);
  // Empty window: no points.
  assert.deepEqual(sliceWindow(t, series, [9000, 9999]).t, []);
});

test("timeAtPixel / pixelAtTime round-trip like lineChart's x()", () => {
  const W = 600, padL = 40, padR = 10, t0 = 1000, t1 = 61000;
  assert.equal(timeAtPixel(40, W, padL, padR, t0, t1), 1000);
  assert.equal(timeAtPixel(590, W, padL, padR, t0, t1), 61000);
  assert.equal(timeAtPixel(315, W, padL, padR, t0, t1), 31000);
  assert.equal(pixelAtTime(31000, W, padL, padR, t0, t1), 315);
  // Out-of-range pixels clamp to the window ends.
  assert.equal(timeAtPixel(0, W, padL, padR, t0, t1), 1000);
  assert.equal(timeAtPixel(9999, W, padL, padR, t0, t1), 61000);
});

test("pinchWindow narrows around the anchor and clamps to the full range", () => {
  const full = [0, 100000];
  assert.deepEqual(pinchWindow([0, 100000], full, 50000, 2), [25000, 75000]);
  assert.deepEqual(pinchWindow([25000, 75000], full, 50000, 0.5), [0, 100000]);
  // Pinching out past the full range clamps instead of overshooting.
  assert.deepEqual(pinchWindow([40000, 60000], full, 50000, 0.2), [0, 100000]);
  assert.deepEqual(pinchWindow([40000, 60000], full, 50000, 0.25), [10000, 90000]);
  // Anchored off-center: the window follows the anchor.
  assert.deepEqual(pinchWindow([0, 100000], full, 25000, 2), [0, 50000]);
  assert.deepEqual(pinchWindow([0, 100000], full, 25000, 1), [0, 100000]);
});

test("detectBreaches fires once per entry into a bad zone", () => {
  const t = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => 1000 + i * 60000);
  const bad = [{ lo: 1200, hi: 5000, label: "Stuffy, above 1,200" }];
  // 700, 900, 1300, 1400, 1100, 1250, 900, 800 → enters at 2 and at 5.
  const values = [700, 900, 1300, 1400, 1100, 1250, 900, 800];
  const ev = detectBreaches(t, values, bad);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].t, t[2]);
  assert.equal(ev[0].label, "Stuffy, above 1,200");
  assert.equal(ev[0].value, 1300);
  assert.equal(ev[1].t, t[5]);
  // Never entering: no events. Always in: a single event at the start.
  assert.deepEqual(detectBreaches(t, [700, 800, 900, 1000, 1100, 900, 800, 700], bad), []);
  assert.equal(detectBreaches(t, [1300, 1400, 1500, 1300, 1400, 1300, 1400, 1500], bad).length, 1);
  // Nulls break the line, not the logic: a null inside a bad stretch does
  // not re-trigger, a null after it does not hide the entry.
  const withNulls = [1300, null, 1400, 1100, null, 1250, 900, 800];
  assert.equal(detectBreaches(t, withNulls, bad).length, 2);
});

test("buildEvents merges gaps and breaches, earliest first", () => {
  const t = outageSeries();
  const co2 = t.map((ts, i) => (i > 100 && i < 110 ? 1400 : 700));
  const zones = [
    { lo: 0, hi: 800, tone: "good", label: "Fresh, under 800" },
    { lo: 1200, hi: 5000, tone: "bad", label: "Stuffy, above 1,200" },
  ];
  const ev = buildEvents(t, co2, zones);
  assert.ok(ev.some((e) => e.kind === "gap"), "gap present");
  assert.ok(ev.some((e) => e.kind === "breach"), "breach present");
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].t >= ev[i - 1].t, "sorted");
  // No bad zones: gaps only.
  assert.deepEqual(buildEvents(t, co2, [{ lo: 0, hi: 800, tone: "good", label: "x" }]).map((e) => e.kind), ["gap"]);
});

test("toCsv exports the visible window with ISO timestamps and blanks for gaps", () => {
  const t = [Date.UTC(2026, 10, 15, 12, 0, 0), Date.UTC(2026, 10, 15, 12, 1, 0)];
  const series = [
    { name: "CO2", values: [700, null] },
    { name: "IAQ", values: [55, 60] },
  ];
  const csv = toCsv(t, series);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "timestamp,CO2,IAQ");
  assert.equal(lines[1], "2026-11-15T12:00:00.000Z,700,55");
  assert.equal(lines[2], "2026-11-15T12:01:00.000Z,,60");
  assert.equal(csvFilename("co2", "6h"), "sniffmaster-co2-6h.csv");
  assert.equal(pngFilename("iaq", "24h"), "sniffmaster-iaq-24h.png");
});

test("view store keeps zoom per chart and defaults events on", () => {
  const s = createViewStore();
  assert.equal(s.getZoom("iaq"), null);
  assert.equal(s.isZoomed("iaq"), false);
  assert.equal(s.eventsOn("iaq"), true);
  s.setZoom("iaq", [1000, 2000]);
  s.setZoom("co2", [3000, 4000]);
  assert.deepEqual(s.getZoom("iaq"), [1000, 2000]);
  assert.equal(s.isZoomed("co2"), true);
  s.setEventsOn("iaq", false);
  assert.equal(s.eventsOn("iaq"), false);
  assert.equal(s.eventsOn("co2"), true);
  s.clearZoom("iaq");
  assert.equal(s.getZoom("iaq"), null);
  assert.deepEqual(s.getZoom("co2"), [3000, 4000]);
  s.clearAllZoom();
  assert.equal(s.getZoom("co2"), null);
  // Clearing the zoom does not touch the events toggle.
  assert.equal(s.eventsOn("iaq"), false);
});

test("wiring: charts module is loaded and lineChart takes zoom/events/tools", () => {
  assert.ok(htmlText.includes('/charts.js'), "charts.js script tag in index.html");
  assert.ok(jsText.includes("sniff-charts-ready"), "charts-ready re-render listener");
  assert.ok(jsText.includes("opts.events"), "lineChart reads opts.events");
  assert.ok(jsText.includes("opts.onZoom"), "lineChart calls opts.onZoom for drag/pinch/reset");
  assert.ok(jsText.includes("opts.full"), "lineChart clamps pinch zoom to opts.full");
  assert.ok(jsText.includes("sliceWindow(d.series.t"), "callers slice the zoom window before drawing");
  assert.ok(jsText.includes("chart-tools"), "toolbar markup present");
  assert.ok(jsText.includes("data-act=\"csv\""), "CSV export button");
  assert.ok(jsText.includes("data-act=\"png\""), "PNG export button");
  assert.ok(jsText.includes("svgToPng"), "PNG export calls svgToPng");
  assert.ok(jsText.includes("buildEvents"), "callers build events from channel zones");
  assert.ok(jsText.includes("clearAllZoom"), "range change clears zoom state");
});

test("wiring: data-vs-interpretation classes exist and sparklines use series colors", () => {
  assert.ok(cssText.includes(".interp"), ".interp rule in style.css");
  assert.ok(cssText.includes(".chart-tools"), ".chart-tools rule in style.css");
  assert.ok(cssText.includes(".event-label"), ".event-label rule in style.css");
  assert.ok(cssText.includes(".event-gap"), ".event-gap rule in style.css");
  assert.ok(cssText.includes(".zoom-select"), ".zoom-select rule in style.css");
  // Overview sparklines are measurement traces: series colors, not states.
  assert.ok(jsText.includes('spark(s.tempC, css("--series-2"))'), "comfort spark is series-2");
  assert.ok(jsText.includes('spark(s.co2, css("--series-1"))'), "CO2 spark is series-1");
  assert.ok(!jsText.includes("tempTone"), "no state-colored temp spark left");
  assert.ok(!jsText.includes("co2Tone"), "no state-colored CO2 spark left");
  // Plain-English captions carry .interp.
  assert.ok(jsText.includes('class="line interp"'), "overview captions marked interp");
});

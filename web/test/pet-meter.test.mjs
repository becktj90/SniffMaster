import test from "node:test";
import assert from "node:assert/strict";
import {
  PET_ODOR_INDEX,
  petIndexFromSnapshot,
  petSeriesIndexes,
  petTrend,
  trendLine,
  petSparklineHtml,
  catsRoamingLabel,
  petTriggerReading,
} from "../public/pet-meter.js";
import { petAllergenIndex, OD_PET_INDEX } from "../lib/homeAir.js";

// The client mirror must stay in lockstep with the server formula:
// same weights, same lookup tables, same renormalization over the
// parts actually present. If either side drifts, this is the tripwire.
test("PET_ODOR_INDEX matches homeAir.OD_PET_INDEX", () => {
  assert.equal(PET_ODOR_INDEX, 16);
  assert.equal(PET_ODOR_INDEX, OD_PET_INDEX);
});

const MIRROR_CASES = [
  { odor: 10, co2: 600 }, // low odor, fresh air
  { odor: 80, co2: 1500 }, // strong odor, stale air
  { odor: 45, co2: 900, pm25: 8, pm10: 20 }, // coarse dust present
  { odor: 45, co2: 900, pm25: 20, pm10: 8 }, // pm10 < pm25 clamps coarse to 0
  { odor: null, co2: 1200 }, // odor missing: stale-air part alone
  { odor: 30, co2: null }, // co2 missing: odor part alone
  { odor: null, co2: null }, // nothing at all
  { odor: 150, co2: 3000 }, // out-of-range clamps
  { odor: 0, co2: 600 },
  { odor: 100, co2: 2200, pm25: 0, pm10: 30 },
];

test("petIndexFromSnapshot matches the server petAllergenIndex exactly", () => {
  for (const c of MIRROR_CASES) {
    const odors = Array(20).fill(0);
    if (c.odor !== null && c.odor !== undefined) odors[16] = c.odor;
    else odors[16] = null;
    const snap = { odors };
    const server = petAllergenIndex(snap, {
      co2: c.co2 ?? undefined,
      particulate: { pm25: c.pm25, pm10: c.pm10 },
    });
    const mirror = petIndexFromSnapshot(c.odor, c.co2, c.pm25, c.pm10);
    assert.equal(mirror, server.index, JSON.stringify(c));
  }
});

test("petSeriesIndexes only scores buckets with a pet-odor reading", () => {
  const t = [1000, 2000, 3000, 4000];
  const odors = [
    (() => { const a = Array(20).fill(0); a[16] = 40; return a; })(),
    null, // no odor rows in this bucket (e.g. feed gap)
    (() => { const a = Array(20).fill(0); a[16] = 60; return a; })(),
    (() => { const a = Array(20).fill(0); a[16] = null; return a; })(),
  ];
  const co2 = [700, 800, 900, 1000];
  const out = petSeriesIndexes(t, odors, co2);
  assert.equal(out.length, 4);
  assert.equal(out[0].index, petIndexFromSnapshot(40, 700));
  assert.equal(out[1].index, null);
  assert.equal(out[2].index, petIndexFromSnapshot(60, 900));
  assert.equal(out[3].index, null);
  // No odors at all (24h/7d ranges) → every bucket null, never invented.
  assert.deepEqual(
    petSeriesIndexes(t, null, co2).map((p) => p.index),
    [null, null, null, null],
  );
});

const pts = (indexes, t0 = 1000) =>
  indexes.map((index, i) => ({ t: t0 + i * 60000, index }));

test("petTrend compares second half to first half, ±5 is steady", () => {
  const rising = petTrend(pts([20, 22, 21, 40, 42, 41]));
  assert.equal(rising.direction, "rising");
  assert.equal(rising.delta, 20);
  assert.equal(rising.spanHours, 0.1); // 5 minutes across 6 points

  const falling = petTrend(pts([80, 78, 81, 50, 52, 49]));
  assert.equal(falling.direction, "falling");
  assert.equal(falling.delta, -29); // (50+52+49)/3 − (80+78+81)/3 = −29.33 → −29

  const steady = petTrend(pts([30, 31, 29, 32, 31, 30]));
  assert.equal(steady.direction, "steady");
  assert.ok(Math.abs(steady.delta) < 5);

  // Too few valid points, or gaps leaving too little — never a guess.
  assert.equal(petTrend(pts([20, 22])).direction, "unknown");
  assert.equal(petTrend(pts([20, null, null, 40])).direction, "unknown");
  assert.equal(petTrend([]).direction, "unknown");
});

test("trendLine words match the direction, empty when unknown", () => {
  assert.equal(trendLine({ direction: "rising", delta: 12, spanHours: 6 }), "▲ Rising · +12 points over the last 6 hours");
  assert.equal(trendLine({ direction: "falling", delta: -8, spanHours: 6 }), "▼ Falling · -8 points over the last 6 hours");
  assert.equal(trendLine({ direction: "steady", delta: 2, spanHours: 6 }), "• Steady · within 2 points over the last 6 hours");
  assert.equal(trendLine({ direction: "rising", delta: 12, spanHours: 0.9 }), "▲ Rising · +12 points over the last hour");
  assert.equal(trendLine({ direction: "unknown", delta: null, spanHours: null }), "");
  assert.equal(trendLine(null), "");
});

test("petSparklineHtml breaks the line at null buckets", () => {
  const html = petSparklineHtml(pts([10, 20, 30, null, null, 50, 60, 70]), "#3b82f6");
  assert.match(html, /<svg class="spark"/);
  // Two runs → two line paths (plus two area fills): the gap is a gap.
  const lines = html.match(/fill="none" stroke/g) || [];
  assert.equal(lines.length, 2);
  // The two runs start at different x positions — no bridge across the nulls.
  const starts = [...html.matchAll(/<path d="M([0-9.]+) /g)].map((m) => Number(m[1]));
  assert.ok(starts[0] === 0, "first run starts at x=0, got " + starts[0]);
  assert.ok(starts.some((x) => x > 50), "second run starts past the gap: " + starts);

  assert.equal(petSparklineHtml(pts([10]), "#3b82f6"), "");
  assert.equal(petSparklineHtml(pts([null, null, null]), "#3b82f6"), "");
  assert.equal(petSparklineHtml([], "#3b82f6"), "");
});

test("petSparklineHtml downsamples long series to at most 48 points", () => {
  const long = Array.from({ length: 240 }, (_, i) => ({ t: 1000 + i * 60000, index: i % 100 }));
  const html = petSparklineHtml(long, "#3b82f6");
  // Count plotted points on the line path only (area fills repeat them).
  const line = html.match(/<path d="([^"]+)" fill="none"/);
  assert.ok(line, "line path present");
  const cmds = line[1].match(/[ML][0-9.]+ [0-9.]+/g) || [];
  assert.ok(cmds.length <= 49, "got " + cmds.length + " plotted points");
  assert.ok(cmds.length >= 40, "still shows the shape, got " + cmds.length);
});

test("catsRoamingLabel names the roaming count", () => {
  assert.equal(catsRoamingLabel(2), "2 cats roaming");
  assert.equal(catsRoamingLabel(5), "5 cats roaming");
  assert.equal(catsRoamingLabel(1), "1 cat roaming");
  assert.equal(catsRoamingLabel(null), "");
});

test("petTriggerReading picks Cats/Dogs in the server's own words", () => {
  const items = [
    { label: "Cats", level: "High", severity: "severe", reason: "Dander is up.", action: "Ventilate." },
    { label: "Pollen", level: "Low", severity: "moderate", reason: "Pollen is low.", action: "" },
    { label: "Dogs", level: "Moderate", severity: "moderate", reason: "Some dog allergen.", action: "" },
  ];
  const out = petTriggerReading(items);
  assert.equal(out.length, 2);
  assert.equal(out[0].label, "Cats");
  assert.equal(out[0].severity, "severe");
  assert.equal(out[0].text, "Dander is up. Ventilate.");
  assert.equal(out[1].label, "Dogs");

  assert.equal(petTriggerReading([{ label: "Pollen", level: "Low" }]), null);
  assert.equal(petTriggerReading([]), null);
  assert.equal(petTriggerReading(null), null);
});

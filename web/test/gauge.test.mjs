import test from "node:test";
import assert from "node:assert/strict";
import { colorAtScore, gaugePoint, gaugeNote, lowestComponent, scoreRingHtml } from "../public/gauge.js";

const COLORS = { good: "#3ccf74", fair: "#fab219", poor: "#ec835a", bad: "#f06262" };

test("gaugePoint maps scores around the 270° arc (SVG space, gap at bottom after rotation)", () => {
  assert.deepEqual(gaugePoint(0, 84), { x: 184, y: 100 });
  assert.deepEqual(gaugePoint(50, 84), { x: 40.6, y: 159.4 });
  assert.deepEqual(gaugePoint(100, 84), { x: 100, y: 16 });
  assert.deepEqual(gaugePoint(40, 84), { x: 74, y: 179.9 });
  assert.deepEqual(gaugePoint(80, 84), { x: 32, y: 50.6 });
  // Out of range clamps to the ends; non-numeric reads as the bottom.
  assert.deepEqual(gaugePoint(140, 84), { x: 100, y: 16 });
  assert.deepEqual(gaugePoint(-5, 84), { x: 184, y: 100 });
  assert.deepEqual(gaugePoint(null, 84), { x: 184, y: 100 });
});

test("colorAtScore runs red to green across the band boundaries", () => {
  assert.equal(colorAtScore(0, COLORS), "#f06262");
  assert.equal(colorAtScore(40, COLORS), "#ec835a");
  assert.equal(colorAtScore(60, COLORS), "#fab219");
  assert.equal(colorAtScore(80, COLORS), "#3ccf74");
  assert.equal(colorAtScore(100, COLORS), "#3ccf74");
  // Midpoints blend between the anchors.
  assert.equal(colorAtScore(20, COLORS), "#ee735e");
  assert.equal(colorAtScore(50, COLORS), "#f39b3a");
  assert.equal(colorAtScore(70, COLORS), "#9bc147");
  assert.equal(colorAtScore(null, COLORS), "#f06262");
});

test("gaugeNote speaks plainly per tone", () => {
  assert.match(gaugeNote("good"), /good shape/);
  assert.match(gaugeNote("fair"), /mostly fine/);
  assert.match(gaugeNote("poor"), /noticeably off/);
  assert.match(gaugeNote("bad"), /needs attention/);
  assert.match(gaugeNote("na"), /No reading yet/);
  assert.match(gaugeNote("whatever"), /No reading yet/);
});

test("lowestComponent picks the worst scorer and skips non-numeric scores", () => {
  const comps = [
    { label: "Particulate", score: 90 },
    { label: "Gases", score: 54 },
    { label: "Humidity", score: "n/a" },
    { label: "Smell", score: 71 },
  ];
  assert.equal(lowestComponent(comps).label, "Gases");
  assert.equal(lowestComponent([]), null);
  assert.equal(lowestComponent(null), null);
  assert.equal(lowestComponent([{ label: "X", score: "n/a" }]), null);
});

test("scoreRingHtml draws the full scale faintly and fills up to the value", () => {
  const html = scoreRingHtml(81, "Good", COLORS);
  const count = (re) => (html.match(re) || []).length;
  // 30 segments total: 24 filled (floor(0.81 * 30)), 6 ghost.
  assert.equal(count(/class="seg"/g), 24);
  assert.equal(count(/class="seg ghost"/g), 6);
  // Ticks at the 40 / 60 / 80 band boundaries.
  assert.equal(count(/class="tick"/g), 3);
  // A dot marks the exact value, at the ring position for 81.
  const p = gaugePoint(81, 84);
  assert.match(html, /class="dot"/);
  assert.ok(html.includes('cx="' + p.x + '"'), "dot x should be " + p.x);
  assert.ok(html.includes('cy="' + p.y + '"'), "dot y should be " + p.y);
  // The scale spans red to green: the first segment is the reddish end of
  // the scale and the last is solid green (no segment midpoint is exactly
  // score 0, so the raw bad hex never appears verbatim).
  assert.ok(html.includes('stroke="' + colorAtScore(50 / 30, COLORS) + '"'));
  assert.ok(html.includes('stroke="' + colorAtScore(295 / 3, COLORS) + '"'));
  // Number and grade in the middle.
  assert.match(html, />81</);
  assert.match(html, /Good/);
});

test("scoreRingHtml with no data shows the scale but no dot or fill", () => {
  const html = scoreRingHtml(null, null, COLORS);
  const count = (re) => (html.match(re) || []).length;
  assert.equal(count(/class="seg"/g), 0);
  assert.equal(count(/class="seg ghost"/g), 30);
  assert.doesNotMatch(html, /class="dot"/);
  assert.match(html, /No data/);
});

test("scoreRingHtml at the ends fills everything or nothing", () => {
  const full = scoreRingHtml(100, "Excellent", COLORS);
  assert.equal((full.match(/class="seg"/g) || []).length, 30);
  assert.equal((full.match(/class="seg ghost"/g) || []).length, 0);
  const empty = scoreRingHtml(0, "Poor", COLORS);
  assert.equal((empty.match(/class="seg"/g) || []).length, 0);
  assert.equal((empty.match(/class="seg ghost"/g) || []).length, 30);
  assert.match(empty, /class="dot"/);
});

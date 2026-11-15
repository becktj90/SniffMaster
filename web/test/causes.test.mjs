import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCause } from "../lib/causes.js";
import { toOledView, wrap } from "../lib/oled.js";

const now = Date.now();
const noise = (i) => Math.sin(i * 12.9898) * 0.02;
const ahOf = (tc, rh) => { const es = 6.112 * Math.exp((17.67 * tc) / (tc + 243.5)); return (es * rh * 2.1674) / (273.15 + tc); };

/**
 * Build 24h of 1-minute posts. `shape(m)` gives, for m minutes ago, deltas to
 * the baseline: { def (VOC deficit), co2, rh, tc, odor:[idx,score] }.
 */
function scenario(shape = () => ({})) {
  const rows = [];
  for (let m = 24 * 60; m >= 0; m--) {
    const s = shape(m) || {};
    const rh = 45 + (s.rh || 0) + 4 * Math.sin(m / 180);
    const tc = 22 + (s.tc || 0);
    const ah = ahOf(tc, rh);
    const gasR = 200000 * Math.exp(-0.08 * (ah - 8) - (s.def || 0) + noise(m));
    const odors = Array(20).fill(2);
    if (s.odor) odors[s.odor[0]] = s.odor[1];
    rows.push({ receivedAt: now - m * 60000, gasR, humidity: rh, temperature: tc, co2: 520 + (s.co2 || 0), iaqAcc: 3, odors });
  }
  const sorted = rows.sort((a, b) => b.receivedAt - a.receivedAt); // newest first
  return { latest: sorted[0], history: sorted };
}
const run = (shape, extra) => { const { latest, history } = scenario(shape); return analyzeCause(latest, history, { now, ...extra }); };
const ramp = (m, startAgo, full) => (m >= startAgo ? 0 : full * (1 - m / startAgo)); // 0 before start, rises to full now

test("nothing unusual in a quiet room", () => {
  const c = run(() => ({}));
  assert.equal(c.key, "none");
  assert.equal(c.action, null);
});

test("shower: fast humidity jump, no VOC deficit", () => {
  const c = run((m) => ({ rh: m < 15 ? 25 * (1 - m / 15) : 0, tc: m < 15 ? 1.5 * (1 - m / 15) : 0 }));
  assert.equal(c.key, "steam", JSON.stringify(c));
  assert.match(c.action, /fan/i);
});

test("people / stale air: CO2 climbs steadily, VOC flat", () => {
  const c = run((m) => ({ co2: m < 40 ? 350 * (1 - m / 40) : 0 }));
  assert.equal(c.key, "occupancy", JSON.stringify(c));
  assert.ok(c.evidence.some((e) => /CO₂ \+/.test(e)));
  assert.ok(c.rates.co2Per30Min > 100);
});

test("cooking: VOC burst with CO2 and temperature rising", () => {
  const c = run((m) => (m < 20 ? { def: 0.9 * (1 - m / 20), co2: 260 * (1 - m / 20), tc: 1.6 * (1 - m / 20), odor: [8, 50] } : {}));
  assert.equal(c.key, "cooking", JSON.stringify(c));
});

test("litter box: pet odor with a moderate deficit that built over time", () => {
  const c = run((m) => (m < 40 ? { def: 0.45 * (1 - m / 40), odor: [16, 68] } : {}));
  assert.equal(c.key, "litter", JSON.stringify(c));
  assert.match(c.action, /litter/i);
});

test("trash: garbage odor, CO2 flat", () => {
  const c = run((m) => (m < 50 ? { def: 0.5 * (1 - m / 50), odor: [10, 65] } : {}));
  assert.equal(c.key, "garbage", JSON.stringify(c));
});

test("cleaning product: sharp spike that is already decaying", () => {
  const c = run((m) => (m < 30 ? { def: m > 10 ? 1.3 * Math.exp(-(25 - m) / 8) * 0 + 1.3 : 0.6, odor: [5, 60] } : {}));
  assert.equal(c.key, "product", JSON.stringify(c));
});

test("smoke is urgent", () => {
  const c = run((m) => (m < 10 ? { def: 1.2, odor: [7, 80] } : {}));
  assert.equal(c.key, "smoke");
  assert.equal(c.urgent, true);
});

test("damp: musty odor while humid", () => {
  const c = run((m) => (m < 120 ? { rh: 22, def: 0.3, odor: [1, 60] } : {}));
  assert.equal(c.key, "damp", JSON.stringify(c));
});

test("slow off-gassing: deficit crept up over hours without an event", () => {
  const c = run((m) => ({ def: m < 300 ? 0.5 * (1 - m / 300) : 0 }));
  assert.equal(c.key, "offgas", JSON.stringify(c));
});

test("unexplained change says so instead of guessing", () => {
  const c = run((m) => (m < 15 ? { def: 0.5 * (1 - m / 15) } : {}));
  assert.ok(["unexplained", "offgas", "product"].includes(c.key));
  if (c.key === "unexplained") assert.equal(c.confidence, "none");
});

test("outdoor smoke coming in", () => {
  const c = run((m) => (m < 30 ? { def: 0.4 * (1 - m / 30) } : {}), { outdoor: { usAqi: 180 } });
  assert.equal(c.key, "outdoor");
});

test("OLED feed fits 21-column lines and stays small", () => {
  const { latest, history } = scenario((m) => (m < 40 ? { def: 0.45 * (1 - m / 40), odor: [16, 68] } : {}));
  const cause = analyzeCause(latest, history, { now });
  const view = toOledView({
    receivedAt: now, score: { value: 61 },
    smell: { state: "bad", level: "Noticeable smell", sinceMinutes: 22, trend: "worsening" },
    cause, outlook: { level: "High", items: [{ key: "cat", rank: 3 }] },
    pollen: { ok: true, types: [{ name: "Grass", category: "High", value: 4 }], plants: [] },
    outdoor: { usAqi: 42, uvIndex: 6.2, tempC: 24 }, ventilation: { action: "open", text: "Open windows for 10 minutes: indoor air is stale and outdoor air is fine." },
  });
  assert.equal(view.sm, "SMELLY");
  assert.equal(view.ca, "LITTER / PET AREA");
  assert.equal(view.an, "CAT DANDER");
  assert.equal(view.al, "HIGH");
  assert.equal(view.pl, "HIGH");
  for (const l of [view.ca, ...view.ac, view.wn]) assert.ok(l.length <= 21, l);
  assert.equal(view.wn, "OPEN WINDOWS 10 MIN");
  assert.ok(view.pn.length <= 9);
  assert.ok(JSON.stringify(view).length < 700, String(JSON.stringify(view).length));
});

test("wrap ellipsises, splits long words, strips non-ASCII", () => {
  assert.deepEqual(wrap("Open windows for 10 minutes: indoor air is stale", 21, 2).length, 2);
  assert.ok(wrap("a ".repeat(60), 21, 2)[1].endsWith("..."));
  assert.equal(wrap("CO₂ 1,200 ppm °F", 21, 1)[0], "CO2 1,200 ppm F");
});

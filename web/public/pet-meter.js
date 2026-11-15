// Pet meter helpers for the dashboard — pure functions + markup.
//
// The dander index the server reports (web/lib/homeAir.js
// petAllergenIndex) is a weighted mix of three signals. The client
// recomputes it per history bucket from the same formula so the Pets
// page can show a real trend and sparkline without a new endpoint.
// The mirror below must stay in lockstep with homeAir.js —
// pet-meter.test.mjs imports both and asserts identical indexes over
// a fixture matrix, and pins PET_ODOR_INDEX to homeAir.OD_PET_INDEX
// the same way.
//
// The dashboard script (app.js, a classic script) uses the
// `window.SniffPetMeter` global below; the exports keep the math and
// markup testable from node.

/** Pet / litter odor class in the 20-class smell model (homeAir.OD_PET_INDEX). */
export const PET_ODOR_INDEX = 16;

// Weights and lookup tables — copied from homeAir.petAllergenIndex;
// the equality test is the tripwire if either side ever drifts.
const W_ODOR = 0.45;
const W_COARSE = 0.4;
const W_STALE = 0.15;
const COARSE_TABLE = [[0, 0], [5, 20], [15, 60], [30, 100]];
const STALE_TABLE = [[600, 0], [1000, 40], [1500, 80], [2200, 100]];

function num(v) {
  // NB: Number(null) is 0, so plain Number() calls must never guard a
  // possibly-missing value — num() is the only safe conversion here.
  if (v === null || v === undefined || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** Piecewise-linear lookup. `table` is [[x0,y0],[x1,y1],...] sorted by x. */
function interp(x, table) {
  if (!Number.isFinite(x)) return NaN;
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

/**
 * Mirror of homeAir.petAllergenIndex's scoring, for one snapshot worth
 * of inputs. `odor` is the pet/litter smell-model score (0–100);
 * `co2` in ppm; `pm25`/`pm10` in µg/m³ when a particulate sensor is
 * fitted (today: absent, so that part drops out exactly as on the
 * server). Missing inputs are NaN. Returns the 0–100 index, or null
 * when no signal is present at all.
 */
export function petIndexFromSnapshot(odor, co2, pm25, pm10) {
  const petOdor = num(odor);
  const coarse =
    Number.isFinite(num(pm25)) && Number.isFinite(num(pm10))
      ? Math.max(0, num(pm10) - num(pm25))
      : NaN;
  const co2v = num(co2);

  const parts = [];
  if (Number.isFinite(petOdor)) {
    parts.push({ weight: W_ODOR, score: clamp(petOdor, 0, 100) });
  }
  if (Number.isFinite(coarse)) {
    parts.push({ weight: W_COARSE, score: interp(coarse, COARSE_TABLE) });
  }
  if (Number.isFinite(co2v)) {
    parts.push({ weight: W_STALE, score: interp(co2v, STALE_TABLE) });
  }
  if (!parts.length) return null;
  const wSum = parts.reduce((a, p) => a + p.weight, 0);
  return Math.round(parts.reduce((a, p) => a + p.score * p.weight, 0) / wSum);
}

/**
 * Per-bucket dander index for a sensors payload: `t` (ms timestamps),
 * `odors` (per-bucket 20-class max arrays, or null for 24h/7d ranges),
 * `co2`/`pm25`/`pm10` (per-bucket mean series). A bucket only yields
 * an index when its pet-odor score exists — the dominant part — so the
 * trend stays apples-to-apples with the live server index; other
 * buckets are null (a gap in the sparkline, never a fabricated point).
 */
export function petSeriesIndexes(t, odors, co2, pm25, pm10) {
  const n = Array.isArray(t) ? t.length : 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = Array.isArray(odors) ? odors[i] : null;
    const odor = Array.isArray(o) ? num(o[PET_ODOR_INDEX]) : NaN;
    if (!Number.isFinite(odor)) {
      out.push({ t: t[i], index: null });
      continue;
    }
    out.push({
      t: t[i],
      index: petIndexFromSnapshot(
        odor,
        Array.isArray(co2) ? co2[i] : NaN,
        Array.isArray(pm25) ? pm25[i] : NaN,
        Array.isArray(pm10) ? pm10[i] : NaN,
      ),
    });
  }
  return out;
}

/**
 * Direction of the dander index across a point list: mean of the
 * second half vs mean of the first half of the valid points. A swing
 * under 5 points reads as steady. Needs at least 4 valid points (2
 * per half) or the direction is "unknown" — never a guess from one
 * or two readings.
 */
export function petTrend(points) {
  const valid = (points || []).filter(
    (p) => p && Number.isFinite(num(p.t)) && Number.isFinite(num(p.index)),
  );
  const empty = { direction: "unknown", delta: null, fromT: null, toT: null, spanHours: null };
  if (valid.length < 4) return empty;
  const half = Math.floor(valid.length / 2);
  const first = valid.slice(0, half);
  const second = valid.slice(half);
  if (first.length < 2 || second.length < 2) return empty;
  const mean = (a) => a.reduce((s, p) => s + Number(p.index), 0) / a.length;
  const delta = Math.round(mean(second) - mean(first));
  const direction = delta >= 5 ? "rising" : delta <= -5 ? "falling" : "steady";
  const spanHours = Math.round(((valid[valid.length - 1].t - valid[0].t) / 3600000) * 10) / 10;
  return { direction, delta, fromT: valid[0].t, toT: valid[valid.length - 1].t, spanHours };
}

function spanLabel(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return "";
  if (hours < 1.5) return "over the last hour";
  return "over the last " + Math.round(hours) + " hours";
}

/** Plain-language trend line, e.g. "▲ Rising · +12 points over the last 6 hours". */
export function trendLine(trend) {
  if (!trend || trend.direction === "unknown" || trend.delta === null) return "";
  const span = spanLabel(trend.spanHours);
  if (trend.direction === "rising") return "▲ Rising · +" + trend.delta + " points" + (span ? " " + span : "");
  if (trend.direction === "falling") return "▼ Falling · " + trend.delta + " points" + (span ? " " + span : "");
  return "• Steady · within " + Math.abs(trend.delta) + " points" + (span ? " " + span : "");
}

function downsample(pts, max) {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  const out = pts.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Small time-based sparkline for the dander index, in the same visual
 * language as the Overview sparklines (series color, soft area fill).
 * Unlike app.js spark(), the line BREAKS at null buckets — a feed gap
 * is a gap, never a straight line across the outage. Downsampled to
 * at most 48 plotted points. Returns "" when fewer than 2 points can
 * be drawn.
 */
export function petSparklineHtml(points, color) {
  const pts = downsample(
    (points || []).map((p) => ({ t: num(p.t), index: num(p.index) })),
    48,
  );
  const valid = pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.index));
  if (valid.length < 2) return "";
  const minT = Math.min(...valid.map((p) => p.t));
  const maxT = Math.max(...valid.map((p) => p.t));
  const spanT = maxT - minT || 1;
  const mn = Math.min(...valid.map((p) => p.index));
  const mx = Math.max(...valid.map((p) => p.index));
  const rg = mx - mn || 1;
  const X = (t) => (((t - minT) / spanT) * 100).toFixed(2);
  const Y = (v) => (30 - ((v - mn) / rg) * 26 - 2).toFixed(2);

  const runs = [];
  let cur = [];
  pts.forEach((p) => {
    if (Number.isFinite(p.index)) cur.push(p);
    else {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    }
  });
  if (cur.length >= 2) runs.push(cur);
  if (!runs.length) return "";

  const paths = runs
    .map((run) => {
      const d = run.map((p, i) => (i ? "L" : "M") + X(p.t) + " " + Y(p.index)).join("");
      const area = d + "L" + X(run[run.length - 1].t) + " 30L" + X(run[0].t) + " 30Z";
      return (
        '<path d="' + area + '" fill="' + color + '" fill-opacity="0.14"/>' +
        '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round"/>'
      );
    })
    .join("");
  return (
    '<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">' +
    paths +
    "</svg>"
  );
}

/** "2 cats roaming" — the count the roaming band renders for this index. */
export function catsRoamingLabel(count) {
  // NB: Number(null) is 0, so null/undefined/"" must be excluded first.
  if (count === null || count === undefined || count === "") return "";
  const n = Number(count);
  if (!Number.isFinite(n)) return "";
  const r = Math.round(n);
  return r === 1 ? "1 cat roaming" : r + " cats roaming";
}

/**
 * What the current level means for the pet triggers: the Cats / Dogs
 * outlook items, in the server's own words (reason + action).
 * Returns null when neither trigger has an outlook entry.
 */
export function petTriggerReading(items) {
  const picks = (items || []).filter(
    (i) => i && (i.label === "Cats" || i.label === "Dogs"),
  );
  if (!picks.length) return null;
  return picks.map((i) => ({
    label: i.label,
    level: i.level,
    severity: i.severity,
    text: [i.reason, i.action].filter(Boolean).join(" "),
  }));
}

if (typeof window !== "undefined") {
  window.SniffPetMeter = {
    PET_ODOR_INDEX,
    petIndexFromSnapshot,
    petSeriesIndexes,
    petTrend,
    trendLine,
    petSparklineHtml,
    catsRoamingLabel,
    petTriggerReading,
  };
}

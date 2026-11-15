// Gradient home-health gauge for the Overview page — pure helpers + markup.
//
// The ring is a 270° arc (SVG circle, dash start at 3 o'clock, CSS-rotated
// 135° so the gap sits at the bottom). A linear SVG gradient cannot follow
// a curve, so the gradient is built from 30 short arc segments, each
// colored by its position on the green → amber → red scale: the whole
// scale shows faintly underneath (ghost segments) and the filled portion
// up to the current value shows at full strength, with a dot marking the
// exact value and ticks at the 40 / 60 / 80 band boundaries.
//
// The dashboard script (app.js, a classic script) uses the
// `window.SniffGauge` global below; the exports keep the geometry and
// markup testable from node. Colors are passed in so this module stays
// pure — app.js reads them from the CSS vars (which follow the active
// light/dark theme).

const R = 84; // ring radius, matches the SVG in scoreRingHtml
const CX = 100;
const CY = 100;
const SEGMENTS = 30; // 9° each — fine enough that the scale reads as smooth
const TICKS = [40, 60, 80]; // band boundaries (toneFor: 80 good, 60 fair, 40 poor)

// Band anchors for the 0–100 score. The last two share a color so the top
// of the scale stays solid green instead of blending on toward something else.
const BANDS = [
  { at: 0, tone: "bad" },
  { at: 40, tone: "poor" },
  { at: 60, tone: "fair" },
  { at: 80, tone: "good" },
  { at: 100, tone: "good" },
];

function clampScore(v) {
  // NB: Number(null) is 0, so null/undefined/"" must be excluded first.
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return a;
  const ch = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return "#" + ch.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Color on the green → amber → red scale for a score 0–100.
 * `colors` maps tone names to hex ({ good, fair, poor, bad }).
 * Non-numeric scores read as the bottom of the scale.
 * `opts.flip` reverses the scale (0 reads green, 100 reads red) for
 * meters where a high number is bad — the Pet dander index.
 */
export function colorAtScore(score, colors, opts) {
  const s = clampScore(score);
  let v = s === null ? 0 : s;
  if (opts && opts.flip) v = 100 - v;
  for (let i = 0; i < BANDS.length - 1; i++) {
    const a = BANDS[i];
    const b = BANDS[i + 1];
    if (v >= a.at && v <= b.at) {
      const t = b.at === a.at ? 0 : (v - a.at) / (b.at - a.at);
      return lerpColor(colors[a.tone], colors[b.tone], t);
    }
  }
  return colors[BANDS[BANDS.length - 1].tone];
}

/**
 * Point on the ring for a score, in SVG user space. The arc is drawn from
 * 3 o'clock clockwise over 270°, so score 0 sits at (184, 100) and score
 * 100 at (100, 16) — the CSS rotation then puts the gap at the bottom.
 */
export function gaugePoint(score, r) {
  const s = clampScore(score);
  const v = s === null ? 0 : s;
  const rad = (v / 100) * 270 * (Math.PI / 180);
  const round1 = (n) => Number(n.toFixed(1));
  return { x: round1(CX + r * Math.cos(rad)), y: round1(CY + r * Math.sin(rad)) };
}

/**
 * Plain-language answer to "what does this number mean", keyed by the
 * tone toneFor() in app.js returns (good / fair / poor / bad / na).
 */
export function gaugeNote(tone) {
  switch (tone) {
    case "good":
      return "Air is in good shape — nothing needs attention right now.";
    case "fair":
      return "Air is mostly fine — one or two things below are pulling the score down.";
    case "poor":
      return "Air is noticeably off — the lowest items below are what's driving it.";
    case "bad":
      return "Air needs attention — start with the lowest item below.";
    default:
      return "No reading yet — the score appears once the sensor reports.";
  }
}

/**
 * The component dragging the score down most (lowest numeric score),
 * or null when there is nothing scored. Callers only need its label
 * and score — no advice is invented here.
 */
export function lowestComponent(comps) {
  let worst = null;
  (comps || []).forEach(function (c) {
    if (!c || !Number.isFinite(Number(c.score))) return;
    if (!worst || Number(c.score) < Number(worst.score)) worst = c;
  });
  return worst;
}

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>\"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/**
 * Full ring markup for a score 0–100 and grade word (e.g. 81, "Good").
 * `colors` maps tone names to hex ({ good, fair, poor, bad }).
 * No-data scores still render the ghost scale so the range reads.
 * `opts.ticks` overrides the tick marks (default 40/60/80);
 * `opts.flip` reverses the color scale (see colorAtScore).
 */
export function scoreRingHtml(score, grade, colors, opts) {
  const s = clampScore(score);
  const pct = s === null ? 0 : s / 100;
  const C = 2 * Math.PI * R;
  const arc = C * 0.75;
  const segLen = arc / SEGMENTS;
  const dash = (segLen + 0.8).toFixed(1);
  const gap = (C - segLen - 0.8).toFixed(1);
  const filled = Math.floor(pct * SEGMENTS);

  let segs = "";
  for (let i = 0; i < SEGMENTS; i++) {
    const col = colorAtScore(((i + 0.5) / SEGMENTS) * 100, colors, opts);
    const off = (-(i * segLen)).toFixed(1);
    const base =
      '<circle class="seg' + (i < filled ? "" : " ghost") + '" cx="100" cy="100" r="' + R +
      '" fill="none" stroke="' + col + '" stroke-width="12" stroke-dasharray="' + dash + " " + gap +
      '" stroke-dashoffset="' + off + '"/>';
    segs += base;
  }

  const ticks = ((opts && Array.isArray(opts.ticks)) ? opts.ticks : TICKS).map(function (t) {
    const p1 = gaugePoint(t, R - 10);
    const p2 = gaugePoint(t, R + 10);
    return '<line class="tick" x1="' + p1.x + '" y1="' + p1.y + '" x2="' + p2.x + '" y2="' + p2.y + '"/>';
  }).join("");

  let dot = "";
  if (s !== null) {
    const p = gaugePoint(s, R);
    dot =
      '<circle class="dot" cx="' + p.x + '" cy="' + p.y + '" r="7" fill="' + colorAtScore(s, colors, opts) +
      '" style="stroke:var(--card)" stroke-width="2.5"/>';
  }

  const num = s === null ? "—" : String(Math.round(s));
  return (
    '<div class="ring"><svg viewBox="0 0 200 200" aria-hidden="true">' +
    '<circle class="track" cx="100" cy="100" r="' + R + '" fill="none" stroke-width="12" stroke-dasharray="' + arc.toFixed(1) + " " + C.toFixed(1) + '"/>' +
    segs + ticks + dot +
    "</svg>" +
    '<div class="ring-label"><span class="num">' + num + '</span><span class="grade">' + esc(grade || "No data") + "</span></div></div>"
  );
}

if (typeof window !== "undefined") {
  window.SniffGauge = { colorAtScore, gaugePoint, gaugeNote, lowestComponent, scoreRingHtml };
  window.dispatchEvent(new CustomEvent("sniff-gauge-ready"));
}

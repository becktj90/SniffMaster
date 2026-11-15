// Chart viewing helpers for SniffMaster: zoom, export, and event labels.
//
// The charts themselves are hand-rolled SVG in app.js (lineChart); this
// module holds the pure logic so it stays testable from node:
//
//   - Zoom: drag-to-select and pinch both produce a [startMs, endMs] time
//     window. The window is sliced out of the series before drawing, so a
//     zoomed chart is just a chart of fewer points. Zoom state lives in the
//     module-level store below and is keyed per chart (channel key, "pet",
//     "smell") — the dashboard re-renders the whole page on every poll tick,
//     so state kept in the DOM would be wiped; state kept here survives.
//     Changing the global history range (sm-range) clears all zoom.
//   - Events: only things already in the data. Feed gaps (the timestamps
//     jump — e.g. the Nov 15 outage, ~1:21–2:23 PM ET after a router
//     restart) and threshold breaches (a value entering one of the
//     channel's "bad" zones). Nothing is invented.
//   - Export: CSV of the currently visible window (timestamps included),
//     and a PNG snapshot of the chart as it looks right now, event labels
//     included.
//
// The dashboard script (app.js, a classic script) uses the
// `window.SniffCharts` global below; the exports keep the math testable.

export function isNum(v) {
  return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
}

// Median of the positive gaps between consecutive timestamps, in ms.
// Null when there are fewer than two distinct timestamps.
export function medianInterval(t) {
  const diffs = [];
  for (let i = 1; i < t.length; i++) {
    const d = t[i] - t[i - 1];
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

// Feed gaps: consecutive timestamps further apart than the sampling
// rhythm allows. The bar is 4x the median interval, with a 2-minute floor
// so a single late post never counts as an outage. A missing bucket shows
// up as a jump in `t` (bucketMean averages the rows it has), so this works
// on the 1-minute and the 10-minute compact series alike.
export function findGaps(t, opts = {}) {
  const med = medianInterval(t);
  const minGap = Math.max(120000, med ? 4 * med : 120000);
  const out = [];
  for (let i = 1; i < t.length; i++) {
    const dt = t[i] - t[i - 1];
    if (dt > minGap) {
      const mins = dt / 60000;
      const label =
        mins < 90
          ? `Feed gap · ${Math.round(mins)} min`
          : `Feed gap · ${(mins / 60).toFixed(1)} h`;
      out.push({ t: t[i - 1], t0: t[i - 1], t1: t[i], kind: "gap", label, mins });
    }
  }
  return out;
}

// Slice timestamps + every series' values down to a [w0, w1] window
// (inclusive). `series` is an array of { values } objects; the returned
// objects keep their other fields (name, color, dash).
export function sliceWindow(t, series, win) {
  if (!win) return { t: t.slice(), series: series.map((s) => ({ ...s, values: (s.values || []).slice() })) };
  const [w0, w1] = win;
  const idx = [];
  for (let i = 0; i < t.length; i++) if (t[i] >= w0 && t[i] <= w1) idx.push(i);
  return {
    t: idx.map((i) => t[i]),
    series: series.map((s) => ({ ...s, values: idx.map((i) => (s.values || [])[i] ?? null) })),
  };
}

// Pixel <-> time mapping, mirroring lineChart's x(): padL/padR are the
// chart's left/right padding, W the svg width in viewBox units.
export function timeAtPixel(px, W, padL, padR, t0, t1) {
  const frac = (px - padL) / (W - padL - padR);
  return t0 + Math.max(0, Math.min(1, frac)) * (t1 - t0);
}

export function pixelAtTime(ts, W, padL, padR, t0, t1) {
  if (t1 === t0) return padL;
  return padL + ((ts - t0) / (t1 - t0)) * (W - padL - padR);
}

// Pinch zoom: scale > 1 (fingers apart) narrows the window around the
// anchor time; scale < 1 widens it. The result is clamped to the full
// range the chart was drawn from.
export function pinchWindow(win, full, anchorMs, scale) {
  if (!scale || scale <= 0) return win;
  const half = (win[1] - win[0]) / 2 / scale;
  let w0 = anchorMs - half;
  let w1 = anchorMs + half;
  const fullSpan = full[1] - full[0];
  if (w1 - w0 >= fullSpan) return [full[0], full[1]];
  if (w0 < full[0]) { w1 += full[0] - w0; w0 = full[0]; }
  if (w1 > full[1]) { w0 -= w1 - full[1]; w1 = full[1]; }
  return [Math.max(full[0], w0), Math.min(full[1], w1)];
}

// Breaches: the first point where a value enters one of the channel's
// "bad" ranges (from the channel's zones). One event per entry — staying
// in the bad range does not spam markers.
export function detectBreaches(t, values, badRanges) {
  const out = [];
  let inside = null;
  for (let j = 0; j < t.length; j++) {
    const v = values[j];
    // A missing bucket is "no reading", not "back to good air": it
    // preserves the previous state instead of ending a bad stretch.
    if (!isNum(v)) continue;
    let hit = null;
    for (const r of badRanges || []) {
      if (Number(v) >= r.lo && Number(v) < r.hi) { hit = r; break; }
    }
    if (hit && !inside) out.push({ t: t[j], kind: "breach", label: hit.label, value: Number(v) });
    inside = hit;
  }
  return out;
}

// Split a merged event list into feed gaps and breaches. The two kinds
// are rendered by different rules: a gap is data integrity, so its band
// and label stay visible even when the Events toggle is off; a breach is
// an event, so the toggle hides it.
export function partitionEvents(events) {
  const gaps = [];
  const breaches = [];
  for (const e of events || []) (e.kind === "gap" ? gaps : breaches).push(e);
  return { gaps, breaches };
}

// Which events belong in a visible [t0, t1] window. A breach is a point:
// it counts when it falls inside. A gap is an interval: it counts when
// it overlaps the window at all, even when it started before the window
// opened (e.g. a zoom or range change that lands mid-outage) — otherwise
// the label vanishes exactly when the range changes, the v0 Charts Lab
// bug.
export function eventsInWindow(events, t0, t1) {
  return (events || []).filter((e) => {
    if (e.kind === "gap") {
      const g0 = e.t0 ?? e.t;
      const g1 = e.t1 ?? e.t;
      return g1 >= t0 && g0 <= t1;
    }
    return e.t >= t0 && e.t <= t1;
  });
}

// Notable smell events in a visible window, from the real heatmap data:
// one event per run of consecutive columns where a class scores at or
// above the "strong" bar (65, the same cutoff the smell bars use).
// The event time is the peak column of its run, so a pill's time always
// matches the heatmap cell it names — the times come from the same
// arrays the cells are drawn from. Returns earliest first.
export function smellEvents(t, odors, names, opts = {}) {
  const strong = opts.strong ?? 65;
  const out = [];
  const cols = Math.min(t.length, odors.length);
  for (let oi = 0; oi < (names || []).length; oi++) {
    let run = null;
    for (let c = 0; c < cols; c++) {
      const v = odors[c] ? odors[c][oi] : 0;
      if (v >= strong) {
        if (!run) run = { start: c, peak: c, score: v };
        else if (v > run.score) { run.peak = c; run.score = v; }
      } else if (run) {
        out.push({ classIndex: oi, name: names[oi], t: t[run.peak], score: run.score, start: t[run.start], end: t[c - 1] });
        run = null;
      }
    }
    if (run) out.push({ classIndex: oi, name: names[oi], t: t[run.peak], score: run.score, start: t[run.start], end: t[cols - 1] });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// All events for a chart, earliest first: feed gaps from the timestamps
// plus breaches from the values against the channel's "bad" zones.
export function buildEvents(t, values, zones) {
  const badRanges = (zones || [])
    .filter((z) => z.tone === "bad")
    .map((z) => ({ lo: z.lo, hi: z.hi, label: z.label }));
  const events = [...findGaps(t), ...detectBreaches(t, values, badRanges)];
  events.sort((a, b) => a.t - b.t);
  return events;
}

// CSV of the visible window: one timestamp column (ISO) plus one column
// per series. Missing values are empty cells, never fabricated.
export function toCsv(t, series) {
  const head = ["timestamp", ...series.map((s) => s.name || "value")].join(",");
  const rows = t.map((ts, j) =>
    [new Date(ts).toISOString(), ...series.map((s) => (isNum((s.values || [])[j]) ? String((s.values || [])[j]) : ""))].join(",")
  );
  return [head, ...rows].join("\n") + "\n";
}

export function csvFilename(key, range) {
  return `sniffmaster-${key}-${range || "chart"}.csv`;
}

export function pngFilename(key, range) {
  return `sniffmaster-${key}-${range || "chart"}.png`;
}

// Per-chart viewing state. One store for the whole session: the dashboard
// re-renders on every poll tick, so this must not live in the DOM.
// eventsOn defaults to true for every chart.
export function createViewStore() {
  const zoom = {};
  const eventsOn = {};
  return {
    getZoom(key) { return zoom[key] || null; },
    setZoom(key, win) { if (win) zoom[key] = win; else delete zoom[key]; },
    clearZoom(key) { delete zoom[key]; },
    clearAllZoom() { for (const k of Object.keys(zoom)) delete zoom[k]; },
    isZoomed(key) { return Boolean(zoom[key]); },
    eventsOn(key) { return eventsOn[key] !== false; },
    setEventsOn(key, on) { eventsOn[key] = Boolean(on); },
  };
}

export const viewStore = createViewStore();

// --- DOM helpers (used by app.js; not unit-tested, covered by wiring) ---

export function downloadText(filename, text, mime = "text/csv") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Snapshot an SVG chart as a PNG. The chart's classes live in the page's
// stylesheet, which a rasterized SVG cannot see, so the few rules the
// chart needs are inlined into a <style> block in the clone (colors read
// from the live computed styles, so dark/light themes both work).
export function svgToPng(svgEl, scale = 2) {
  return new Promise((resolve, reject) => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    const clone = svgEl.cloneNode(true);
    const w = Number(svgEl.getAttribute("width")) || svgEl.viewBox.baseVal.width || 600;
    const h = Number(svgEl.getAttribute("height")) || svgEl.viewBox.baseVal.height || 190;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent =
      `.axis-text{fill:${v("--ink-3")};font-size:10.5px;font-family:${v("--sans")}}` +
      `.grid-line{stroke:${v("--viz-grid")};stroke-width:1}` +
      `.crosshair{stroke:${v("--ink-3")};stroke-width:1;stroke-dasharray:3 3}` +
      `.event-label{fill:${v("--ink-2")};font-size:10.5px;font-family:${v("--sans")}}` +
      `.gap-label{fill:${v("--fair")};font-size:10.5px;font-weight:600;font-family:${v("--sans")}}` +
      `.event-line{stroke:${v("--bad")};stroke-width:1.5;stroke-dasharray:4 3}` +
      `.event-gap{fill:${v("--fair-bg")};stroke:${v("--fair")};stroke-width:1;stroke-dasharray:4 3}` +
      `.heat .axis-text{fill:${v("--ink-2")};font-size:11px}`;
    clone.insertBefore(style, clone.firstChild);
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", "0"); bg.setAttribute("y", "0");
    bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%");
    bg.setAttribute("fill", v("--card"));
    clone.insertBefore(bg, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encode failed"))), "image/png");
      } catch (err) { reject(err); }
    };
    img.onerror = () => reject(new Error("SVG rasterize failed"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  });
}

export function downloadPng(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if (typeof window !== "undefined") {
  window.SniffCharts = {
    medianInterval,
    findGaps,
    partitionEvents,
    eventsInWindow,
    smellEvents,
    sliceWindow,
    timeAtPixel,
    pixelAtTime,
    pinchWindow,
    detectBreaches,
    buildEvents,
    toCsv,
    csvFilename,
    pngFilename,
    store: viewStore,
    downloadText,
    svgToPng,
    downloadPng,
  };
  window.dispatchEvent(new Event("sniff-charts-ready"));
}

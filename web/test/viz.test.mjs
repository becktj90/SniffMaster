// Pro color system: the series palette must stay disjoint in hue from the
// state palette, so a chart line never reads as a good/fair/poor/bad state.
// Also pins the gradient-bar wiring (the --bar custom property) and the
// zone/heatmap/spark fill treatments, which are pure markup.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const cssText = readFileSync(path.join(root, "../public/style.css"), "utf8");
const jsText = readFileSync(path.join(root, "../public/app.js"), "utf8");

function tokens(block, names) {
  const out = {};
  names.forEach(function (n) {
    const m = new RegExp("--" + n + ":\\s*(#[0-9a-f]{6})", "i").exec(block);
    assert.ok(m, "--" + n + " token present");
    out[n] = m[1];
  });
  return out;
}

function hue(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  if (mx === r) return ((g - b) / d + (g < b ? 6 : 0)) * 60;
  if (mx === g) return ((b - r) / d + 2) * 60;
  return ((r - g) / d + 4) * 60;
}

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

// Dark :root is everything before the light-theme media query; the light
// tokens live after it (in both the media query and [data-theme="light"]).
const lightAt = cssText.indexOf("@media (prefers-color-scheme: light)");
const darkCss = cssText.slice(0, lightAt);
const lightCss = cssText.slice(lightAt);
const names = ["series-1", "series-2", "series-3", "good", "fair", "poor", "bad"];
const dark = tokens(darkCss, names);
const light = tokens(lightCss, names);

for (const [label, t] of [["dark", dark], ["light", light]]) {
  test(label + " theme: series hues stay clear of every state hue", () => {
    for (const s of ["series-1", "series-2", "series-3"]) {
      for (const st of ["good", "fair", "poor", "bad"]) {
        const d = hueDist(hue(t[s]), hue(t[st]));
        assert.ok(d > 35, s + " (" + t[s] + ") is " + d.toFixed(0) + "° from " + st + " (" + t[st] + ")");
      }
    }
  });

  test(label + " theme: the three series hues are distinct from each other", () => {
    const hs = ["series-1", "series-2", "series-3"].map((s) => hue(t[s]));
    for (let i = 0; i < hs.length; i++) {
      for (let j = i + 1; j < hs.length; j++) {
        assert.ok(hueDist(hs[i], hs[j]) > 20, "series hues " + hs[i].toFixed(0) + "° and " + hs[j].toFixed(0) + "° too close");
      }
    }
  });
}

test("chart gridlines use the soft --viz-grid token, not the card border", () => {
  assert.ok(/--viz-grid:/.test(darkCss), "dark --viz-grid token");
  assert.ok(/--viz-grid:/.test(lightCss), "light --viz-grid token");
  assert.match(cssText, /\.chart \.grid-line \{[^}]*stroke: var\(--viz-grid\)/);
});

test("bars fill as gradients driven by the --bar custom property", () => {
  assert.match(cssText, /\.comp \.bar i \{[^}]*linear-gradient\(90deg, var\(--bar/);
  assert.match(cssText, /\.hbar \.track i \{[^}]*linear-gradient\(90deg, var\(--bar/);
  // Both state-colored bar sites set --bar instead of a flat background.
  const barUses = (jsText.match(/--bar:/g) || []).length;
  assert.ok(barUses >= 2, "expected --bar: on component + smell bars, found " + barUses);
});

test("line-chart zones fade via gradients and sparklines carry an area fill", () => {
  assert.ok(jsText.includes("url(#' + id + \"z\""), "zone rects reference a per-zone gradient");
  assert.ok(jsText.includes('stop-opacity="0.14"'), "zone gradient has a soft top stop");
  assert.ok(jsText.includes('fill-opacity="0.14"'), "sparkline area fill present");
  assert.ok(jsText.includes('fill-opacity="0.22"'), "now-dot halo present");
});

test("smell heatmap colors cells by strength band, not one flat blue", () => {
  assert.ok(jsText.includes("cellFill(v)"), "heatmap fill is banded by score");
  assert.ok(jsText.includes("cellOp(v)"), "heatmap opacity steps with strength");
  assert.ok(!jsText.includes('var base = css("--series-1")'), "flat blue heatmap base is gone");
});

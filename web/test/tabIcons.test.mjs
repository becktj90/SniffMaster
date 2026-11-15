// Bottom tab-bar icons: six routes, each with a filled icon plus one
// accent detail, all colors from theme tokens. Static source
// assertions — no DOM in this VM, and no SVG renderer here either.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const htmlText = readFileSync(path.join(root, "../public/index.html"), "utf8");
const cssText = readFileSync(path.join(root, "../public/style.css"), "utf8");

const nav = htmlText.match(/<nav class="tabs"[^>]*>([\s\S]*?)<\/nav>/);
assert.ok(nav, "tabs nav exists");
const navHtml = nav[1];

const ROUTES = [
  ["home", "Overview"],
  ["sensors", "Sensors"],
  ["smell", "Smell"],
  ["pets", "Pets"],
  ["outside", "Outside"],
  ["alerts", "Alerts"],
];

test("nav keeps all six routes with labels and 24px icons", () => {
  for (const [route, label] of ROUTES) {
    const link = navHtml.match(
      new RegExp(`<a href="#[^"]*" data-route="${route}">([\\s\\S]*?)</a>`)
    );
    assert.ok(link, `tab link for ${route} exists`);
    assert.ok(
      link[1].includes(`<span>${label}</span>`),
      `${route} keeps its ${label} label`
    );
    assert.ok(
      link[1].includes('<svg viewBox="0 0 24 24"'),
      `${route} icon keeps the 24x24 viewBox`
    );
  }
});

test("each icon has a filled shape and one accent detail", () => {
  for (const [route] of ROUTES) {
    const link = navHtml.match(
      new RegExp(`<a href="#[^"]*" data-route="${route}">([\\s\\S]*?)</a>`)
    );
    const svg = link[1];
    assert.ok(
      /class="(fill|area|acc|sun)"/.test(svg),
      `${route} icon has a filled shape`
    );
    assert.ok(
      /class="(acc|accs|sun)"/.test(svg),
      `${route} icon has an accent detail`
    );
  }
});

test("tab icons use theme tokens, no hard-coded colors", () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(navHtml), "no hex colors in the tab SVGs");
  for (const cls of [".fill", ".acc", ".accs", ".sun", ".area"]) {
    assert.ok(
      cssText.includes(`.tabs svg ${cls}`),
      `style.css defines .tabs svg ${cls}`
    );
  }
  assert.ok(
    cssText.includes('.tabs a[aria-current="page"] svg'),
    "active tab icon picks up the accent"
  );
});

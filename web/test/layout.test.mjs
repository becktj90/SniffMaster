// Layout density: one spacing scale, tighter cards/charts, and the
// mixed-height rows that used to stretch short cards tall with empty
// space inside. Pure markup/CSS checks — no DOM in this VM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const cssText = readFileSync(path.join(root, "../public/style.css"), "utf8");
const jsText = readFileSync(path.join(root, "../public/app.js"), "utf8");

function pxValue(text, re, label) {
  const m = re.exec(text);
  assert.ok(m, label + " present");
  return Number(m[1]);
}

test("spacing scale: one set of tokens, tighter than the old 16/18px", () => {
  const gap = pxValue(cssText, /--gap:\s*(\d+)px/, "--gap");
  const pad = pxValue(cssText, /--pad:\s*(\d+)px/, "--pad");
  const pageX = pxValue(cssText, /--page-x:\s*(\d+)px/, "--page-x");
  assert.ok(gap <= 14, "--gap is " + gap + "px (was 16)");
  assert.ok(pad <= 16, "--pad is " + pad + "px (was 18)");
  assert.ok(pageX === 20, "--page-x is 20px");
});

test("grid gap and card padding come from the tokens", () => {
  assert.match(cssText, /\.grid\s*\{[^}]*gap:\s*var\(--gap\)/, ".grid uses var(--gap)");
  assert.match(cssText, /\.card\s*\{[^}]*padding:\s*var\(--pad\)/, ".card uses var(--pad)");
  assert.match(cssText, /main\s*\{[^}]*max-width:\s*1240px/, "main is 1240px wide");
  assert.match(cssText, /\.foot\s*\{[^}]*max-width:\s*1240px/, "footer matches main width");
});

test("section-spacing utilities exist and use the token", () => {
  assert.match(cssText, /\.grid\.top\s*\{[^}]*align-items:\s*start/, ".grid.top hugs content");
  assert.match(cssText, /\.mt\s*\{[^}]*margin-top:\s*var\(--gap\)/, ".mt uses var(--gap)");
  assert.match(cssText, /\.mb\s*\{[^}]*margin-bottom:\s*var\(--gap\)/, ".mb uses var(--gap)");
});

test("no inline 16px section margins left in app.js", () => {
  assert.ok(!/margin-(top|bottom):16px/.test(jsText), "all section spacing goes through .mt/.mb");
  assert.ok((jsText.match(/"mt"| mt"/g) || []).length >= 10, ".mt is actually used across pages");
});

test("mixed-height rows hug their content instead of stretching", () => {
  for (const row of [
    'grid g-side top', // Alerts: long form vs short How-it-works
    'grid g-2 top mt', // Sensors cal vs add-on, Outside Google vs Pollen,
    // Smell timeline vs events, Pets chart vs outlook, Settings Alerts vs About
  ]) {
    assert.ok(jsText.includes(row), row + " used");
  }
  const mixed = (jsText.match(/grid g-2 top mt/g) || []).length;
  assert.ok(mixed >= 5, "at least 5 mixed-height g-2 rows use .top (found " + mixed + ")");
});

test("sensors channel cards go 3-across on wide desktops", () => {
  assert.ok(jsText.includes('grid g-2 wide3'), "channel grid carries wide3");
  assert.match(
    cssText,
    /@media\s*\(min-width:\s*1280px\)\s*\{[^}]*\.g-2\.wide3\s*\{[^}]*grid-template-columns:\s*repeat\(3/,
    "wide3 is 3 columns at 1280px+"
  );
});

test("pets meter sits in the narrow hero column, chart shares a row with outlook", () => {
  assert.ok(jsText.includes('grid g-hero"><div class="card"><div class="card-head"><h3>Pet dander index</h3>'), "meter is the hero column");
  assert.ok(
    jsText.includes('grid g-2 top mt"><div class="card"><div class="card-head"><h3>Pet / litter smell over time</h3>'),
    "pet chart and outlook share one row"
  );
});

test("settings alerts and about share one row instead of two full-width cards", () => {
  assert.ok(
    jsText.includes('grid g-2 top mt"><div class="card"><div class="card-head"><h3>Alerts</h3>'),
    "Alerts + About are side by side"
  );
  assert.ok(!jsText.includes('<div class="card" style="margin-top:16px"><div class="card-head"><h3>Alerts</h3>'), "no lone full-width Alerts card");
});

test("smell timeline and sulfur events share one row", () => {
  assert.ok(
    jsText.includes('grid g-2 top mt"><div class="card"><div class="card-head"><h3>Smell timeline</h3>'),
    "timeline + events are side by side"
  );
});

test("charts are shorter but still readable", () => {
  assert.match(cssText, /\.chart\s*\{[^}]*height:\s*170px/, ".chart is 170px (was 190)");
  assert.match(cssText, /\.chart\.tall\s*\{[^}]*height:\s*220px/, ".chart.tall is 220px (was 240)");
});

test("wide desktop: content steps out past the 1240px cap", () => {
  assert.match(
    cssText,
    /@media\s*\(min-width:\s*1440px\)\s*\{[\s\S]*?main\s*\{[^}]*max-width:\s*1400px/,
    "main is 1400px at 1440px+"
  );
  assert.match(
    cssText,
    /@media\s*\(min-width:\s*1440px\)\s*\{[\s\S]*?\.foot\s*\{[^}]*max-width:\s*1400px/,
    "footer steps out with main at 1440px+"
  );
  assert.match(
    cssText,
    /@media\s*\(min-width:\s*1720px\)\s*\{[\s\S]*?main\s*\{[^}]*max-width:\s*1560px/,
    "main is 1560px at 1720px+"
  );
  // The base cap is unchanged, so smaller screens are unaffected.
  assert.match(cssText, /main\s*\{[^}]*max-width:\s*1240px/, "base main is still 1240px");
});

test("overview uses wide-desktop space: hero, tips, and the bottom row", () => {
  assert.ok(jsText.includes('grid g-hero overview-hero'), "overview hero carries overview-hero");
  assert.ok(jsText.includes('grid g-2 top mt overview-bottom'), "outside + risks + sample share one row");
  assert.ok(
    jsText.includes("outside + risks + sampleCard + \"</div>\""),
    "sample card is inside the bottom row, not a lone full-width card"
  );
  assert.match(
    cssText,
    /@media\s*\(min-width:\s*1440px\)\s*\{[\s\S]*?\.g-hero\.overview-hero\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*380px\)/,
    "hero score column is 380px at 1440px+"
  );
  assert.match(
    cssText,
    /@media\s*\(min-width:\s*1440px\)\s*\{[\s\S]*?\.brief \.tips\s*\{[^}]*grid-template-columns:\s*repeat\(3/,
    "brief tips go 3-across at 1440px+"
  );
  assert.match(
    cssText,
    /@media\s*\(min-width:\s*1440px\)\s*\{[\s\S]*?\.overview-bottom\s*\{[^}]*grid-template-columns:\s*repeat\(3/,
    "bottom row is 3 columns at 1440px+"
  );
  assert.match(
    cssText,
    /\.overview-bottom > \.card:last-child\s*\{[^}]*grid-column:\s*1 \/ -1/,
    "sample spans both columns below the wide breakpoint"
  );
});

test("mobile and tablet breakpoints are untouched", () => {
  for (const bp of [1020, 760, 600, 480]) {
    assert.match(cssText, new RegExp("@media\\s*\\(max-width:\\s*" + bp + "px\\)"), bp + "px breakpoint still present");
  }
  assert.match(
    cssText,
    /@media\s*\(max-width:\s*760px\)\s*\{[^}]*\.g-hero[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    "hero still collapses to one column on mobile"
  );
});

test("cats-band clearance is untouched: body padding still clears the band", () => {
  // Desktop: band is 64px tall, body padding-bottom must clear it.
  const band = pxValue(cssText, /\.cats-band\s*\{[^}]*height:\s*(\d+)px/, "cats band height");
  const desktopPad = pxValue(
    cssText,
    /@media\s*\(min-width:\s*861px\)\s*\{[^}]*padding-bottom:\s*(\d+)px/,
    "desktop body padding-bottom"
  );
  assert.ok(desktopPad > band, "desktop body padding " + desktopPad + "px clears the " + band + "px cats band");
  assert.match(cssText, /padding-bottom:\s*calc\(114px \+ env\(safe-area-inset-bottom\)\)/, "mobile body padding still clears band + tab bar");
});

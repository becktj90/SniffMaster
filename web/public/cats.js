// Roaming black cats for the dashboard — a small revival of the old dashboard
// animation (two black cats strolling when the air was OK, more appearing as
// pet dander rose). Inline SVG cats with faces that blink, pink inner ears
// and nose, swaying tails and an occasional ear twitch; no images, no libs.
//
// The cats live in a dedicated band in the sticky bottom dock at the end of
// the document (see index.html) — above the mobile tab bar, below the page
// content, so no number, gauge, chart, card or text is ever covered.
// `pointer-events: none` keeps every tap reaching the page.
//
// The dashboard script (app.js, a classic script) uses the `window.SniffCats`
// global below; the exports keep the mapping and markup testable from node.

/**
 * How many cats roam for a given pet dander index (0-100).
 * Scale: 2 cats while the air is OK, one more at each band as dander climbs.
 * Unknown / non-numeric index reads as "OK" and shows the baseline pair.
 */
export function catCountForPetIndex(idx) {
  const v = Number(idx);
  if (!Number.isFinite(v)) return 2;
  if (v <= 25) return 2;
  if (v <= 50) return 3;
  if (v <= 75) return 4;
  return 5;
}

const clampCount = (n) => Math.max(2, Math.min(5, Math.floor(Number(n)) || 2));

const INK = "#14181f"; // near-black, lifted a touch so the cats read on dark too
const PINK = "#f4a7b9";
const EYE = "#ffd166";

/**
 * One cute black cat, side profile facing right. Blinking eyes, pink inner
 * ears and nose, whiskers, little paws and a tail that sways — the cute bits
 * are animated in style.css (.cat-eyes, .cat-ear-r, .cat-tail, .cat-svg).
 */
function catSvg() {
  return (
    `<svg viewBox="0 0 72 48" aria-hidden="true">` +
    `<path class="cat-tail" d="M13 33 C 5 30, 3 20, 9 11" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>` +
    `<ellipse cx="35" cy="33" rx="21" ry="11" fill="${INK}"/>` +
    `<ellipse cx="26" cy="36" rx="9" ry="7" fill="${INK}"/>` +
    `<ellipse cx="24" cy="44" rx="5" ry="2.6" fill="${INK}"/>` +
    `<ellipse cx="44" cy="44" rx="5" ry="2.6" fill="${INK}"/>` +
    `<ellipse cx="56" cy="44" rx="4.5" ry="2.6" fill="${INK}"/>` +
    `<circle cx="56" cy="21" r="11.5" fill="${INK}"/>` +
    `<polygon points="47,15 48,3 55,11" fill="${INK}"/>` +
    `<polygon points="49,12 49.5,6 53,10.5" fill="${PINK}"/>` +
    `<g class="cat-ear-r"><polygon points="57,11 63,2 65,14" fill="${INK}"/><polygon points="59,10.5 61.5,6 63.5,12" fill="${PINK}"/></g>` +
    `<g class="cat-eyes"><circle cx="52" cy="19" r="2.4" fill="${EYE}"/><circle cx="52.4" cy="19" r="1.1" fill="#1a1a1a"/>` +
    `<circle cx="60.5" cy="19" r="2.4" fill="${EYE}"/><circle cx="60.9" cy="19" r="1.1" fill="#1a1a1a"/></g>` +
    `<polygon points="59,26 63,26 61,28.8" fill="${PINK}"/>` +
    `<line x1="63" y1="24" x2="70" y2="22" stroke="rgba(255,255,255,.4)" stroke-width=".7"/>` +
    `<line x1="63" y1="27" x2="70" y2="28.5" stroke="rgba(255,255,255,.4)" stroke-width=".7"/>` +
    `</svg>`
  );
}

/**
 * The cat spans for one bandful. Each cat gets its own pace (--dur), start
 * offset (--delay, negative so cats are already mid-stroll on load), height
 * inside the band (--lane), size (--w), blink phase (--blink) and pause spot
 * (--pause-a/b/c: where it stops for a look around mid-crossing). Odd cats
 * stroll the other way so the band doesn't feel mechanical.
 */
export function catsInnerHtml(count) {
  const n = clampCount(count);
  let cats = "";
  for (let i = 0; i < n; i++) {
    const rev = i % 2 === 1;
    const dur = 30 + ((i * 11) % 17); // 30–46s per crossing: a gentle stroll
    const delay = -((i * 9) % 26); // start mid-journey, never all off-screen
    const lane = (i % 3) * 7; // 0/7/14px up from the band floor
    const pause = "abc"[i % 3];
    const size = 56 + ((i * 5) % 14); // 56–69px wide: cats vary a little
    const blink = ((i * 1.3) % 3).toFixed(1); // desync the blinks
    const spot = Math.round(((i + 0.5) / n) * 100); // resting spot, reduced motion
    cats +=
      `<span class="roam-cat${rev ? " roam-cat--rev" : ""} roam-cat--pause-${pause}" ` +
      `style="--dur:${dur}s;--delay:${delay}s;--lane:${lane}px;--w:${size}px;--blink:${blink}s;--spot:${spot}" aria-hidden="true">` +
      catSvg() +
      `</span>`;
  }
  return cats;
}

/** HTML for the whole roaming band: lives in the bottom dock, no data. */
export function catsBandHtml(count) {
  return `<div class="cats-band" id="cats-band" aria-hidden="true">${catsInnerHtml(count)}</div>`;
}

let currentCount = null;

/** Create the band once (baseline pair) and pin it to the page. */
export function mountCats(count) {
  if (typeof document === "undefined") return null;
  let band = document.getElementById("cats-band");
  if (!band) {
    const tmp = document.createElement("div");
    tmp.innerHTML = catsBandHtml(count === undefined ? 2 : count);
    band = tmp.firstChild;
    // Into the bottom dock, above the tab nav — so band and tab bar move
    // together as one sticky unit. Falls back to body if the dock is absent.
    const dock = document.getElementById("bottom-dock");
    if (dock) dock.prepend(band);
    else document.body.appendChild(band);
    currentCount = clampCount(count === undefined ? 2 : count);
  }
  return band;
}

/**
 * Sync the roaming count to the live pet dander index. Only rebuilds when
 * the count actually changes, so a passing cat is never yanked mid-stroll
 * by a routine data refresh.
 */
export function setCatCount(count) {
  const n = clampCount(count);
  const band = mountCats(n);
  if (!band) return;
  if (currentCount === n) return;
  band.innerHTML = catsInnerHtml(n);
  currentCount = n;
}

if (typeof window !== "undefined") {
  window.SniffCats = { catCountForPetIndex, catsBandHtml, catsInnerHtml, mountCats, setCatCount };
  mountCats(2);
}

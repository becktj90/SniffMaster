// Walking black cats for the Pets page — a small revival of the old dashboard
// animation (two black cats strolling when the air was OK, more appearing as
// pet dander rose). Pure CSS silhouettes + a few DOM elements, no images.
//
// The dashboard script (app.js, a classic script) uses the `window.SniffCats`
// global below; the exports keep the mapping testable from node.

/**
 * How many cats stroll the Pets page for a given pet dander index (0-100).
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

/**
 * HTML for the cats strip: a caption line plus a thin strip the cats stroll
 * across. Each cat gets its own pace (--dur), start offset (--delay, negative
 * so cats are already mid-strip on load), lane (--lane) and resting spot
 * (--spot, used when the user prefers reduced motion). Odd cats stroll the
 * other way so the strip doesn't feel mechanical.
 */
export function catsStripHtml(count) {
  const n = clampCount(count);
  let cats = "";
  for (let i = 0; i < n; i++) {
    const rev = i % 2 === 1;
    const dur = 28 + ((i * 7) % 13); // 28–36s per crossing: a gentle stroll
    const delay = -((i * 8) % 24); // start mid-journey, never all off-screen
    const lane = (i % 3) * 5; // 0/5/10px up from the strip floor
    const spot = Math.round(((i + 0.5) / n) * 100); // resting spot, reduced motion
    cats +=
      `<span class="cat${rev ? " cat--rev" : ""}" style="--dur:${dur}s;--delay:${delay}s;--lane:${lane}px;--spot:${spot}" aria-hidden="true">` +
      `<span class="cat-body"><span class="cat-tail"></span><span class="cat-head"></span></span></span>`;
  }
  return (
    `<div class="cats"><p class="muted small cats-caption">${n} black cats on patrol — more appear as pet dander rises.</p>` +
    `<div class="cats-strip" aria-hidden="true">${cats}</div></div>`
  );
}

if (typeof window !== "undefined") {
  window.SniffCats = { catCountForPetIndex, catsStripHtml };
}

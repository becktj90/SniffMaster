/**
 * oled.js — a tiny, pre-formatted status feed for the wall-mounted 128x64 OLED.
 *
 * The device has about 21 characters per line at the smallest font and little
 * RAM for JSON, so the server does the thinking and the wording: every string
 * is already uppercase, ASCII-only and wrapped to fit. Short keys keep the
 * payload under ~700 bytes.
 */

const W = 21;
const ascii = (t) => String(t ?? "").replace(/[₂]/g, "2").replace(/[°]/g, "").replace(/[–—]/g, "-").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();

/** Wrap to `width` chars and at most `lines` lines, ellipsising overflow. */
export function wrap(text, width = W, lines = 2) {
  const words = ascii(text).split(" ").filter(Boolean);
  const out = [];
  let cur = "";
  for (const w0 of words) {
    let w = w0;
    while (w.length > width) { // hard-split very long words
      if (cur) { out.push(cur); cur = ""; }
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= width) cur += " " + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = kept[lines - 1].slice(0, width - 3).trimEnd() + "...";
    return kept;
  }
  return out;
}

const LV = { None: "CLEAR", Low: "LOW", Moderate: "MODERATE", High: "HIGH", "Very high": "SEVERE" };
const lvl = (l) => LV[l] || "N/A";

// What the wall display says about each cause, as short as it can be.
const SHORT_ACTION = {
  smoke: "CHECK STOVE NOW. OPEN WINDOWS.",
  steam: "RUN BATH FAN. IT WILL CLEAR.",
  cooking: "RANGE HOOD ON. OPEN WINDOW.",
  occupancy: "OPEN A WINDOW 10 MIN.",
  litter: "SCOOP THE LITTER BOX.",
  garbage: "TAKE OUT TRASH. CHECK FRIDGE.",
  product: "VENTILATE UNTIL IT FADES.",
  damp: "RUN DEHUMIDIFIER. CHECK LEAKS.",
  offgas: "VENTILATE. FIND NEW SOURCE.",
  outdoor: "CLOSE WINDOWS. RUN HEPA.",
  unexplained: "OPEN WINDOW, WATCH TREND.",
};

const SHORT_VENT = {
  "keep-closed": "KEEP WINDOWS CLOSED",
  open: "OPEN WINDOWS 10 MIN",
  fan: "USE EXHAUST FAN",
  filter: "HEPA ON, WINDOWS SHUT",
};

const SHORT_CAUSE = {
  smoke: "SMOKE / BURNING", steam: "SHOWER / STEAM", cooking: "COOKING", occupancy: "PEOPLE / STALE AIR",
  litter: "LITTER / PET AREA", garbage: "TRASH / FOOD", product: "CLEANER / FRAGRANCE",
  damp: "DAMP / MOLD", offgas: "SLOW OFF-GASSING", outdoor: "OUTDOOR AIR", unexplained: "UNEXPLAINED CHANGE",
};

/**
 * @param {object} p  buildHomePayload() result (with smell, outlook, cause, pollen, outdoor)
 */
export function toOledView(p) {
  const sm = p.smell || {};
  const cause = p.cause || {};
  const ol = p.outlook || {};
  const pol = p.pollen || {};
  const od = p.outdoor || {};

  const smellState = sm.state === "bad"
    ? (sm.safety ? "DANGER" : "SMELLY")
    : sm.state === "unclassified"
      ? "GAS SHIFT"
      : sm.state === "ok"
        ? (sm.level === "Slight odor" ? "SLIGHT" : "FRESH")
        : "LEARNING";
  const hasCause = cause.key && cause.key !== "none";
  const causeLine = hasCause ? (SHORT_CAUSE[cause.key] || ascii(cause.label).toUpperCase()) : "";
  const actionText = hasCause ? (SHORT_ACTION[cause.key] || ascii(cause.action).toUpperCase()) : ascii(sm.action).toUpperCase();

  // Top allergen driver, e.g. "CAT DANDER".
  const top = [...(ol.items || [])].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))[0];
  const NAMES = { cat: "CAT DANDER", dog: "DOG DANDER", pollen: "POLLEN", dustMite: "DUST MITES", mold: "MOLD", smoke: "SMOKE" };
  const polItems = pol.ok ? [...(pol.types || []), ...(pol.plants || [])] : [];
  const polTop = polItems.reduce((m, x) => ((x.value ?? 0) > (m?.value ?? -1) ? x : m), null);

  // Home health score breakdown + biologicals, formerly a separate
  // /api/home-stats poll the device made every 2 min — the wall feed already
  // builds this payload every 60 s, so it rides along here instead.
  const comp = {};
  for (const c of p.score?.components || []) comp[c.key] = c.score;
  const cp = (k) => (Number.isFinite(comp[k]) ? comp[k] : -1);
  const bio = p.biological || {};
  const pct = (x) => (Number.isFinite(Number(x?.pct)) ? Math.round(Number(x.pct)) : 0);
  const cat = (x) => (typeof x?.category === "string" && x.category ? x.category : "--");

  return {
    v: 1,
    t: p.receivedAt || 0,
    sc: p.score?.value ?? null,                 // home health score 0-100, higher is healthier
    sm: smellState,                              // FRESH | SLIGHT | SMELLY | DANGER | LEARNING | GAS SHIFT
    sl: sm.state === "bad" ? sm.sinceMinutes ?? 0 : 0, // minutes it has smelled
    tr: sm.trend ? String(sm.trend).toUpperCase() : "",
    ca: wrap(causeLine, W, 1)[0] || "",         // cause label
    cc: hasCause ? String(cause.confidence || "").toUpperCase() : "",
    ac: wrap(actionText, W, 2),                  // up to two 21-char lines
    al: lvl(ol.level),                           // allergen level overall
    an: top && top.rank >= 2 ? NAMES[top.key] || "" : "",
    pl: pol.ok ? (polTop ? lvl(polTop.category) : "CLEAR") : "N/A", // outdoor pollen
    pn: polTop ? ascii(polTop.name).toUpperCase().slice(0, 9) : "",
    aq: Number.isFinite(od.usAqi) ? Math.round(od.usAqi) : null,    // outdoor US AQI
    uv: Number.isFinite(od.uvIndex) ? Math.round(od.uvIndex * 10) / 10 : null,
    ot: Number.isFinite(od.tempC) ? Math.round(od.tempC * 9 / 5 + 32) : null, // outdoor F
    wn: SHORT_VENT[p.ventilation?.action] || "",     // window advice, one line
    gr: typeof p.score?.grade === "string" ? p.score.grade : "", // score grade
    cp: [cp("voc"), cp("ventilation"), cp("biological"), cp("comfort")], // component scores, -1 = missing
    dp: Number.isFinite(p.climate?.dewPointC) ? Math.round((p.climate.dewPointC * 9 / 5 + 32) * 10) / 10 : null, // dew point F
    mo: pct(bio.mold), mc: cat(bio.mold),        // mold % + category
    mi: pct(bio.dustMite), ic: cat(bio.dustMite), // dust mites % + category
    dr: pct(bio.dryAir), dc: cat(bio.dryAir),    // dry air % + category
    pi: Number.isFinite(Number(p.petAllergen?.index)) ? Math.round(Number(p.petAllergen.index)) : 0, // pet allergen index
    pe: typeof p.petAllergen?.level === "string" ? p.petAllergen.level : "--", // pet allergen level
    hl: typeof p.visitor?.headline === "string" ? p.visitor.headline : "", // visitor headline
  };
}

/* home.js — "Home" tab: whole-home air quality, particulate, allergen and
 * comfort dashboard, plus a visitor-friendly summary. Data: GET /api/home-stats
 * (see lib/homeAir.js). Loaded before app.js; app.js calls SniffHome.onView().
 * Every metric is tagged sensor / estimated / outdoor-api / missing so an
 * estimate is never presented as a measurement. */
(function () {
  "use strict";
  var POLL_MS = 120000;
  var timer = null;
  var inflight = false;
  var active = false;

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(v, d, unit) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    return Number(v).toFixed(d == null ? 0 : d) + (unit || "");
  }
  function tone(score) { // 0-100 higher = better
    if (score == null) return "na";
    return score >= 75 ? "good" : score >= 50 ? "fair" : score >= 30 ? "poor" : "bad";
  }
  function riskTone(pct) { // 0-100 higher = worse
    if (pct == null || !isFinite(pct)) return "na";
    return pct < 25 ? "good" : pct < 50 ? "fair" : pct < 75 ? "poor" : "bad";
  }
  function levelTone(level) {
    return { "Low": "good", "Moderate": "fair", "High": "poor", "Very high": "bad", "Severe": "bad", "None": "good", "Mild": "fair" }[level] || "na";
  }
  var SRC = {
    sensor: ["Measured", "sensor"],
    estimated: ["Estimated", "estimated"],
    "outdoor-api": ["Outdoor feed", "outdoor"],
    missing: ["No sensor", "missing"],
  };
  function badge(src) {
    var s = SRC[src] || SRC.missing;
    return '<span class="hm-badge hm-src-' + s[1] + '">' + s[0] + "</span>";
  }

  function spark(vals, color) {
    var pts = (vals || []).map(function (v, i) { return [i, v]; }).filter(function (p) { return p[1] !== null && isFinite(p[1]); });
    if (pts.length < 2) return '<div class="hm-spark-empty">No data</div>';
    var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (y1 === y0) { y1 += 1; y0 -= 1; }
    var path = pts.map(function (p, i) {
      var x = ((p[0] - x0) / (x1 - x0 || 1)) * 200;
      var y = 38 - ((p[1] - y0) / (y1 - y0)) * 34;
      return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }).join(" ");
    return '<svg viewBox="0 0 200 42" preserveAspectRatio="none" class="hm-spark" role="img"><path d="' + path +
      '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>' +
      '<div class="hm-spark-range">' + fmt(Math.min.apply(null, ys), 1) + " – " + fmt(Math.max.apply(null, ys), 1) + "</div>";
  }

  function tile(label, value, sub, t, extra) {
    return '<div class="hm-tile hm-t-' + (t || "na") + '"><div class="hm-tile-label">' + esc(label) +
      '</div><div class="hm-tile-value">' + value + '</div>' +
      (sub ? '<div class="hm-tile-sub">' + sub + "</div>" : "") + (extra || "") + "</div>";
  }

  function meter(label, pct, category, detail) {
    var p = pct == null || !isFinite(pct) ? 0 : Math.max(0, Math.min(100, pct));
    return '<div class="hm-meter"><div class="hm-meter-top"><span>' + esc(label) + '</span><b class="hm-c-' + levelTone(category) + '">' +
      esc(category || "—") + (pct != null && isFinite(pct) ? " · " + Math.round(pct) + "%" : "") + '</b></div>' +
      '<div class="hm-bar"><i class="hm-fill hm-f-' + riskTone(pct) + '" style="width:' + p + '%"></i></div>' +
      (detail ? '<div class="hm-meter-detail">' + esc(detail) + "</div>" : "") + "</div>";
  }

  function fFromC(c) {
    return c == null || !isFinite(Number(c)) ? null : Number(c) * 9 / 5 + 32;
  }
  function whoNote(pt) {
    var bits = [];
    var ratio = pt.whoRatio || {};
    if (ratio.pm25 != null && isFinite(ratio.pm25)) bits.push("PM2.5 " + Math.round(ratio.pm25 * 100) + "%");
    if (ratio.pm10 != null && isFinite(ratio.pm10)) bits.push("PM10 " + Math.round(ratio.pm10 * 100) + "%");
    return bits.length ? "WHO 24-h guideline: " + bits.join(" · ") + " of the limit." : "";
  }
  function exposureDetail(base, risk) {
    if (!risk || risk.windowComplete !== false) return base;
    var recorded = isFinite(risk.coverageHours) ? Math.round(risk.coverageHours) : 0;
    return base + " · " + recorded + "h of " + risk.windowHours + "h recorded, so a long damp spell can still be understated";
  }

  function render(d) {
    var root = $("home-root");
    if (!root) return;
    if (!d) {
      root.innerHTML = '<div class="hm-empty">Waiting for the first reading from your SniffMaster…</div>';
      return;
    }
    var v = d.visitor || {}, sc = d.score || {}, pt = d.particulate || {}, g = d.gases || {}, cl = d.climate || {};
    var bio = d.biological || {}, pet = d.petAllergen || {}, od = d.outdoor || {}, io = d.indoorOutdoor || {};
    var pol = d.pollen || {}, ser = d.series || {};
    var h = [];

    // ── Visitor card ────────────────────────────────────────────────────
    h.push('<section class="hm-card hm-visitor" id="hm-visitor"><div class="hm-visitor-main">' +
      '<div class="hm-ring hm-t-' + tone(v.airScore) + '"><b>' + fmt(v.airScore) + '</b><span>air score</span></div>' +
      '<div class="hm-visitor-copy"><div class="hm-kicker">Welcome — air in this home right now</div>' +
      '<h3>' + esc(v.headline || "") + '</h3>' +
      (v.petAllergen ? '<div class="hm-pet hm-t-' + levelTone(v.petAllergen.level) + '">Pet allergen exposure (estimate): <b>' + esc(v.petAllergen.level) +
        '</b> <small>' + esc(v.petAllergen.confidence) + ' confidence</small></div>' : "") +
      ((v.notes || []).length ? "<ul>" + v.notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul>" : "") +
      '<div class="hm-disclaimer">' + esc(v.disclaimer || "") + "</div></div></div></section>");

    // ── Score + drivers ────────────────────────────────────────────────
    h.push('<section class="hm-card" id="hm-score"><div class="hm-card-head"><span>Home Air Score</span><span class="hm-pill hm-t-' + tone(sc.value) + '">' +
      esc(sc.grade || "No data") + "</span></div>");
    h.push('<div class="hm-score-row"><div class="hm-bigscore hm-t-' + tone(sc.value) + '">' + fmt(sc.value) + '<small>/100</small></div><div class="hm-drivers">' +
      ((sc.drivers || []).length
        ? "<b>Pulling the score down</b>" + sc.drivers.map(function (x) { return "<div>" + esc(x.label) + " — " + esc(x.detail) + " <i>(" + x.score + ")</i></div>"; }).join("")
        : "<b>Nothing is dragging the score down.</b>") + "</div></div>");
    h.push('<div class="hm-comps">' + (sc.components || []).map(function (c) {
      return '<div class="hm-comp"><span>' + esc(c.label) + " " + badge(c.source) + '</span><div class="hm-bar"><i class="hm-fill hm-f-' + (c.score == null ? "na" : tone(c.score)) +
        '" style="width:' + (c.score == null ? 0 : c.score) + '%"></i></div><em>' + (c.score == null ? "n/a" : c.score) + "</em></div>";
    }).join("") + "</div></section>");

    // ── Particulate ────────────────────────────────────────────────────
    h.push('<section class="hm-card" id="hm-particulate"><div class="hm-card-head"><span>Particulate</span>' + badge(pt.measured ? "sensor" : "missing") + "</div>");
    if (pt.measured) {
      h.push('<div class="hm-grid">' +
        tile("PM1.0", fmt(pt.pm1, 1), "µg/m³", "na") +
        tile("PM2.5", fmt(pt.pm25, 1), "µg/m³ · AQI " + fmt(pt.aqiPm25), riskTone((pt.aqiPm25 || 0) / 3)) +
        tile("PM4", fmt(pt.pm4, 1), "µg/m³", "na") +
        tile("PM10", fmt(pt.pm10, 1), "µg/m³ · AQI " + fmt(pt.aqiPm10), riskTone((pt.aqiPm10 || 0) / 3)) + "</div>" +
        '<div class="hm-note">Indoor air is <b>' + esc(pt.category || "—") + "</b>. " + esc(whoNote(pt)) + "</div>");
    } else {
      h.push('<div class="hm-note">No indoor particulate sensor is connected. The stock BME688 cannot see dust, smoke or pollen particles. Add a PM sensor (e.g. Sensirion SEN5x or PMS5003) and PM1/2.5/4/10 appear here automatically. Outdoor PM is shown below.</div>');
    }
    h.push("</section>");

    // ── Allergens & biological ─────────────────────────────────────────
    h.push('<section class="hm-card" id="hm-allergens"><div class="hm-card-head"><span>Allergens &amp; Biologicals</span>' + badge("estimated") + "</div>");
    h.push(meter("Pet dander (cats / dogs)", pet.index, pet.level, pet.index == null ? "No pet-related signals yet." : "Confidence: " + pet.confidence + " — " + (pet.basis || []).map(function (b) { return b.label; }).join(", ")));
    h.push(meter("Mold growth risk", (bio.mold || {}).pct, (bio.mold || {}).category, exposureDetail("Hours ≥60% RH: " + fmt((bio.mold || {}).hoursRh60, 1) + " · ≥70%: " + fmt((bio.mold || {}).hoursRh70, 1), bio.mold)));
    h.push(meter("Dust-mite habitat", (bio.dustMite || {}).pct, (bio.dustMite || {}).category, exposureDetail("Hours ≥65% RH: " + fmt((bio.dustMite || {}).hoursRh65, 1), bio.dustMite)));
    h.push(meter("Dry-air irritation", (bio.dryAir || {}).pct, (bio.dryAir || {}).category, "Below ~30% RH dries eyes, throat and skin."));
    h.push('<div class="hm-note">' + esc(pet.note || "") + "</div>");
    h.push('<div class="hm-subhead">Outdoor pollen ' + (pol.ok ? badge("outdoor-api") : badge("missing")) + "</div>");
    if (pol.ok) {
      var items = (pol.types || []).map(function (t) { return { n: t.name, c: t.category, v: t.value !== null && t.value !== undefined ? t.value + "/5" : "" }; })
        .concat((pol.plants || []).map(function (p) { return { n: p.name, c: p.category, v: p.value !== undefined && p.value !== null ? (p.grains !== undefined && p.grains !== null ? fmt(p.grains) + " gr/m³" : p.value + "/5") : (p.grains != null ? fmt(p.grains) + " gr/m³" : "") }; }));
      h.push('<div class="hm-chips">' + items.map(function (i) { return '<span class="hm-chip hm-t-' + levelTone(i.c) + '">' + esc(i.n) + ": " + esc(i.c || "") + " " + esc(i.v) + "</span>"; }).join("") + "</div>" +
        '<div class="hm-note">' + esc(pol.source || "") + "</div>");
    } else {
      h.push('<div class="hm-note">' + esc(pol.reason || "Pollen feed unavailable.") + "</div>");
    }
    h.push("</section>");

    // ── Gases + climate ────────────────────────────────────────────────
    h.push('<section class="hm-card" id="hm-gases"><div class="hm-card-head"><span>Gases, VOC &amp; Climate</span></div><div class="hm-grid">' +
      tile("IAQ", fmt(g.iaq), badge(g.iaqSource), tone(g.iaq == null ? null : 100 - g.iaq / 3)) +
      tile("CO₂", fmt(g.co2, 0, " ppm"), badge(g.co2Source) + " " + esc(g.co2Category || ""), tone(g.co2 == null ? null : 110 - g.co2 / 20)) +
      tile("Formaldehyde", g.hcho == null ? "—" : fmt(g.hcho, 0, " ppb"), g.hcho == null ? badge("missing") : esc(g.hchoCategory || ""), "na") +
      tile("bVOC", fmt(g.bvoc, 2, " ppm"), badge(g.bvoc == null ? "missing" : "estimated"), "na") +
      tile("Temperature", fmt(cl.tempF, 1, "°F"), esc(cl.comfort || ""), "na") +
      tile("Humidity", fmt(cl.humidity, 0, "%"), "Dew point " + fmt(fFromC(cl.dewPointC), 1, "°F"), "na") +
      tile("Abs. humidity", fmt(cl.absHumidity, 1, " g/m³"), "", "na") +
      tile("Pressure", fmt(cl.pressHpa, 0, " hPa"), "", "na") + "</div></section>");

    // ── Indoor vs outdoor ──────────────────────────────────────────────
    h.push('<section class="hm-card" id="hm-compare"><div class="hm-card-head"><span>Indoor vs Outdoor</span><span class="hm-pill">' + esc(od.source || "") + "</span></div>" +
      '<table class="hm-table"><tr><th></th><th>Indoor</th><th>Outdoor</th></tr>' +
      "<tr><td>PM2.5 µg/m³</td><td>" + fmt(pt.pm25, 1) + "</td><td>" + fmt(od.pm25, 1) + "</td></tr>" +
      "<tr><td>PM10 µg/m³</td><td>" + fmt(pt.pm10, 1) + "</td><td>" + fmt(od.pm10, 1) + "</td></tr>" +
      "<tr><td>Temperature °F</td><td>" + fmt(cl.tempF, 1) + "</td><td>" + fmt(fFromC(od.tempC), 1) + "</td></tr>" +
      "<tr><td>Humidity %</td><td>" + fmt(cl.humidity, 0) + "</td><td>" + fmt(od.humidity, 0) + "</td></tr>" +
      "<tr><td>Abs. humidity g/m³</td><td>" + fmt(cl.absHumidity, 1) + "</td><td>" + fmt(od.absHumidity, 1) + "</td></tr>" +
      "<tr><td>US AQI (outdoor)</td><td>—</td><td>" + fmt(od.usAqi) + "</td></tr>" +
      "<tr><td>Ozone / NO₂ / SO₂ µg/m³</td><td>—</td><td>" + fmt(od.o3) + " / " + fmt(od.no2) + " / " + fmt(od.so2) + "</td></tr>" +
      "<tr><td>UV index</td><td>—</td><td>" + fmt(od.uvIndex, 1) + "</td></tr></table>" +
      (io.pm25Ratio != null ? '<div class="hm-note">Indoor/outdoor PM2.5 ratio: <b>' + fmt(io.pm25Ratio, 2) + "</b> (&gt;1 means the source is inside).</div>" : "") +
      (io.absHumidityDelta != null ? '<div class="hm-note">' + (io.absHumidityDelta > 1.5 ? "Outdoor air is drier — ventilating would dry the house." : io.absHumidityDelta < -1.5 ? "Outdoor air is more humid — keep windows shut to avoid adding moisture." : "Indoor and outdoor moisture are similar.") + "</div>" : "") +
      "</section>");

    // ── Trends ─────────────────────────────────────────────────────────
    var spanH = ser.t && ser.t.length > 1 ? (ser.t[ser.t.length - 1] - ser.t[0]) / 3600000 : 0;
    var trendLabel = spanH >= 20 ? "Last 24 hours" : (spanH > 0 ? "Last " + Math.max(1, Math.round(spanH)) + " hours recorded" : "Last 24 hours");
    h.push('<section class="hm-card" id="hm-trends"><div class="hm-card-head"><span>' + trendLabel + '</span></div><div class="hm-sparks">' +
      [["Humidity %", ser.humidity, "#00f2ff"], ["CO₂ ppm", ser.co2, "#f1c40f"], ["IAQ", ser.iaq, "#ff9958"], ["PM2.5 µg/m³", ser.pm25, "#b8ff3f"], ["Temp °F", (ser.tempC || []).map(function (v) { return v == null || !isFinite(v) ? null : v * 9 / 5 + 32; }), "#78c9ff"]]
        .map(function (s) { return '<div class="hm-spark-box"><div class="hm-spark-title">' + s[0] + "</div>" + spark(s[1], s[2]) + "</div>"; }).join("") + "</div></section>");

    // ── Coverage ───────────────────────────────────────────────────────
    h.push('<section class="hm-card" id="hm-coverage"><div class="hm-card-head"><span>What is measured vs estimated</span></div><table class="hm-table">' +
      (d.coverage || []).map(function (c) { return "<tr><td>" + esc(c.metric) + "</td><td>" + badge(c.source) + "</td><td class=\"hm-dim\">" + esc(c.detail) + "</td></tr>"; }).join("") + "</table></section>");

    root.innerHTML = h.join("");
    var stamp = $("home-updated");
    if (stamp) stamp.textContent = d.receivedAt ? "Reading from " + new Date(d.receivedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + (d.city ? " · " + d.city : "") : "";
  }

  function load() {
    if (inflight) return;
    inflight = true;
    fetch("/api/home-stats", { cache: "no-store" })
      .then(function (r) { return r.status === 204 ? null : r.ok ? r.json() : Promise.reject(new Error("home-stats " + r.status)); })
      .then(function (d) {
        render(d);
        var root = $("home-root");
        if (root && d) root.dataset.loaded = "1";
      })
      .catch(function (e) {
        console.error("home-stats failed:", e);
        var root = $("home-root");
        var stamp = $("home-updated");
        if (root && root.dataset.loaded !== "1") {
          root.innerHTML = '<div class="hm-empty">Couldn\'t load home data. Retrying…</div>';
        } else if (stamp) {
          stamp.textContent = "Update failed — showing the last reading";
        }
      })
      .then(function () { inflight = false; });
  }

  window.SniffHome = {
    onView: function (view) {
      var on = view === "household";
      if (on && !active) { active = true; load(); timer = setInterval(load, POLL_MS); }
      else if (!on && active) { active = false; clearInterval(timer); timer = null; }
    },
  };
})();

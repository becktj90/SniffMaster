/* SniffMaster dashboard — vanilla JS, no build step.
 *
 * Routes (hash): #/ overview · #/sensors · #/smell · #/pets · #/outside · #/alerts · #/settings
 * Data: /api/home-stats (score, smell, pets, mold, outdoor, pollen),
 *       /api/insights (friendly briefing), /api/sensors?range= (BME688 series),
 *       /api/weather-briefing (forecast), /api/sniff-history, /api/alerts.
 *
 * Quota care (Upstash free tier + Vercel Hobby): every poll pauses while the
 * tab is hidden, polls only what the current page shows, and backs off when
 * the device's receivedAt hasn't moved.
 */
(function () {
  "use strict";

  // Gradient gauge module (public/gauge.js): pure ring math + markup.
  // Loaded async; the Overview re-renders when it arrives (see the
  // sniff-gauge-ready listener below). Until then scoreRing falls back
  // to the flat single-color ring.
  (function () {
    var g = document.createElement("script");
    g.type = "module"; g.src = "/gauge.js";
    document.head.appendChild(g);
  })();

  // ── tiny helpers ────────────────────────────────────────────────────
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var view = $("#view");
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function isNum(v) { return v !== null && v !== undefined && v !== "" && isFinite(Number(v)); }
  function fmt(v, d) { return isNum(v) ? Number(v).toFixed(d == null ? 0 : d) : "—"; }
  function cToF(c) { return isNum(c) ? (c * 9) / 5 + 32 : null; }
  function ago(ts) {
    if (!ts) return "never";
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function clock(ts, withDay) {
    var d = new Date(ts);
    var o = { hour: "numeric", minute: "2-digit" };
    if (withDay) o.weekday = "short";
    return d.toLocaleTimeString([], o);
  }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function toneFor(score) { return !isNum(score) ? "na" : score >= 80 ? "good" : score >= 60 ? "fair" : score >= 40 ? "poor" : "bad"; }
  function levelTone(level) {
    var l = String(level || "").toLowerCase();
    if (!l || l === "--") return "na";
    if (/very low/.test(l) || /^(low|none|fresh|good|excellent|safe)/.test(l)) return "good";
    if (/^(moderate|fair|elevated|medium)/.test(l)) return "fair";
    if (/^(high)/.test(l)) return "poor";
    return "bad";
  }
  function pill(text, tone) { return '<span class="tone ' + (tone || "na") + '">' + esc(text) + "</span>"; }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }

  async function getJSON(url) {
    var r = await fetch(url, { cache: "no-store" });
    if (r.status === 204) return null;
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }

  // ── data cache with visibility-aware polling ───────────────────────
  var cache = {};
  var sources = {
    home: { url: function () { var t = store("sm-triggers") || []; return "/api/home-stats?triggers=" + encodeURIComponent(t.join(",")); }, every: 120000 },
    insights: { url: function () { return "/api/insights"; }, every: 600000 },
    weather: { url: function () { return "/api/weather-briefing"; }, every: 1800000 },
    sniffs: { url: function () { return "/api/sniff-history?count=12"; }, every: 300000 },
    alerts: { url: function () { return "/api/alerts"; }, every: 0 },
    // Lightweight latest snapshot — feeds the header calibration pill only.
    // (The full /api/sensors series would be far too heavy for the header.)
    latest: { url: function () { return "/api/latest"; }, every: 120000 },
  };
  var sensorRange = store("sm-range") || "6h";
  sources.sensors = { url: function () { return "/api/sensors?range=" + sensorRange; }, every: 120000 };

  var timers = {};
  var unchanged = 0;
  async function load(name, force) {
    var src = sources[name];
    var c = cache[name];
    if (!force && c && src.every && Date.now() - c.at < src.every * 0.9) return c.data;
    try {
      var data = await getJSON(src.url());
      if (name === "home") {
        var prev = cache.home && cache.home.data && cache.home.data.receivedAt;
        unchanged = data && prev === data.receivedAt ? unchanged + 1 : 0;
        setStatus(data);
        // Roaming cats: sync the count to the live pet dander index. No
        // extra network call — this reuses the home data already loaded.
        if (data && window.SniffCats && window.SniffCats.setCatCount) {
          window.SniffCats.setCatCount(data.petAllergen && data.petAllergen.index);
        }
      }
      if (name === "latest") setCalPill(data);
      cache[name] = { data: data, at: Date.now() };
      return data;
    } catch (err) {
      if (name === "home") setStatus(null, err);
      if (c) return c.data;
      throw err;
    }
  }
  function schedule(names) {
    Object.keys(timers).forEach(function (k) { clearTimeout(timers[k]); });
    timers = {};
    names.forEach(function (n) {
      var src = sources[n];
      if (!src.every) return;
      var tick = function () {
        if (document.hidden) return; // resumed by visibilitychange
        var backoff = n === "home" || n === "sensors" ? Math.min(4, 1 + unchanged * 0.5) : 1;
        timers[n] = setTimeout(function () {
          load(n, true).then(function () { if (currentRoute) rerender(); }).catch(function () {}).then(tick);
        }, src.every * backoff);
      };
      tick();
    });
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && currentRoute) { unchanged = 0; render(currentRoute, true); }
  });

  function setStatus(home, err) {
    var el = $("#status"), txt = $("#status-text");
    el.classList.remove("live", "stale", "down");
    if (err) { el.classList.add("down"); txt.textContent = "Offline"; return; }
    if (!home) { txt.textContent = "No data yet"; return; }
    var age = Date.now() - (home.receivedAt || 0);
    el.classList.add(age < 15 * 60000 ? "live" : "stale");
    txt.textContent = (age < 15 * 60000 ? "Live · " : "Last seen ") + ago(home.receivedAt);
    // Keep the header calibration pill on the same refresh cycle as the
    // status. load() caches the snapshot for ~2 min, so the 30s interval
    // calls below are cheap.
    load("latest").then(function (d) { setCalPill(d); }).catch(function () {});
  }

  // Header calibration pill — same thresholds as the Sensors page, via
  // window.SniffCal (calibration.js). Shows a neutral "Checking…" until the
  // first snapshot arrives, never a wrong state.
  function setCalPill(data) {
    var el = $("#cal-pill-tone");
    if (!el) return;
    var st = window.SniffCal
      ? window.SniffCal.calState(data && data.iaqAcc)
      : { label: "Checking…", tone: "na" };
    el.textContent = st.label;
    el.className = "tone " + st.tone;
  }

  // ── charts (SVG, single y-axis, crosshair + tooltip) ───────────────
  var tooltip = $("#tooltip");
  var chartId = 0;
  function niceRange(min, max) {
    if (min === max) { min -= 1; max += 1; }
    var pad = (max - min) * 0.12;
    return [min >= 0 ? Math.max(0, min - pad) : min - pad, max + pad];
  }
  function lineChart(el, opts) {
    var t = opts.t || [];
    var series = opts.series.filter(function (s) { return (s.values || []).some(isNum); });
    if (!t.length || !series.length) { el.innerHTML = '<div class="chart-empty">' + esc(opts.empty || "No readings in this window yet") + "</div>"; return; }
    var W = el.clientWidth || 600, H = el.clientHeight || 190;
    var padL = 40, padR = 10, padT = 10, padB = 22;
    var all = [];
    series.forEach(function (s) { s.values.forEach(function (v) { if (isNum(v)) all.push(Number(v)); }); });
    var r = opts.yRange || niceRange(Math.min.apply(null, all), Math.max.apply(null, all));
    var t0 = t[0], t1 = t[t.length - 1] === t0 ? t0 + 1 : t[t.length - 1];
    var x = function (ts) { return padL + ((ts - t0) / (t1 - t0)) * (W - padL - padR); };
    var y = function (v) { return padT + (1 - (v - r[0]) / (r[1] - r[0])) * (H - padT - padB); };
    var id = "g" + (++chartId);
    var toneStroke = { good: css("--good"), fair: css("--fair"), poor: css("--poor"), bad: css("--bad") };
    var html = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(opts.label || "chart") + '">';
    (opts.zones || []).forEach(function (z, zi) {
      var topV = Math.min(r[1], z.hi), botV = Math.max(r[0], z.lo);
      if (topV <= botV) return;
      var top = y(topV), bot = y(botV);
      // Zone bands fade top-to-bottom (denser at the top edge) via the
      // gradient defined in the <defs> below — a flat tint competes with
      // the line; a fade reads as background.
      html += '<rect x="' + padL + '" y="' + top.toFixed(1) + '" width="' + (W - padL - padR) + '" height="' + Math.max(0, bot - top).toFixed(1) + '" fill="url(#' + id + "z" + zi + ')"/>';
    });
    (opts.marks || []).forEach(function (m) {
      if (m.y < r[0] || m.y > r[1]) return;
      var yy = y(m.y).toFixed(1);
      html += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy + '" y2="' + yy + '" stroke="' + (toneStroke[m.tone] || css("--ink-3")) + '" stroke-width="2" stroke-dasharray="6 4"/>';
    });
    html += '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + series[0].color + '" stop-opacity=".22"/><stop offset="1" stop-color="' + series[0].color + '" stop-opacity="0"/></linearGradient>';
    (opts.zones || []).forEach(function (z, zi) {
      var zc = toneStroke[z.tone] || "transparent";
      html += '<linearGradient id="' + id + "z" + zi + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + zc + '" stop-opacity="0.14"/><stop offset="1" stop-color="' + zc + '" stop-opacity="0.03"/></linearGradient>';
    });
    html += "</defs>";
    for (var i = 0; i <= 3; i++) {
      var gv = r[0] + ((r[1] - r[0]) * i) / 3;
      var gy = y(gv);
      html += '<line class="grid-line" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy + '" y2="' + gy + '"/>';
      var yLabel = opts.tick ? opts.tick(gv) : fmt(gv, Math.abs(r[1] - r[0]) < 6 ? 1 : 0);
      if (i === 3 && opts.unit && !opts.tick) yLabel += " " + opts.unit.trim(); // unit lives on the top tick, HMI-style
      html += '<text class="axis-text" x="' + (padL - 6) + '" y="' + (gy + 3.5) + '" text-anchor="end">' + esc(yLabel) + "</text>";
    }
    var span = t1 - t0, n = W < 420 ? 3 : 5;
    for (var k = 0; k <= n; k++) {
      var ts = t0 + (span * k) / n;
      html += '<text class="axis-text" x="' + x(ts) + '" y="' + (H - 5) + '" text-anchor="' + (k === 0 ? "start" : k === n ? "end" : "middle") + '">' + esc(clock(ts, span > 2 * 86400000)) + "</text>";
    }
    series.forEach(function (s, si) {
      var d = "", area = "", started = false, firstX = 0, lastX = 0;
      s.values.forEach(function (v, j) {
        if (!isNum(v)) { started = false; return; }
        var px = x(t[j]).toFixed(1), py = y(Number(v)).toFixed(1);
        d += (started ? "L" : "M") + px + " " + py;
        if (!area) firstX = px;
        area += (area ? "L" : "M") + px + " " + py;
        lastX = px; started = true;
      });
      if (si === 0 && area) html += '<path d="' + area + "L" + lastX + " " + (H - padB) + "L" + firstX + " " + (H - padB) + 'Z" fill="url(#' + id + ')"/>';
      html += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"' + (s.dash ? ' stroke-dasharray="4 4"' : "") + "/>";
    });
    // "Now" dot on the latest reading, so the current value is visible at a glance — with a soft halo so it reads at small sizes.
    var s0 = series[0], lastJ = -1;
    for (var j = s0.values.length - 1; j >= 0; j--) { if (isNum(s0.values[j])) { lastJ = j; break; } }
    if (lastJ >= 0) html += '<circle cx="' + x(t[lastJ]).toFixed(1) + '" cy="' + y(Number(s0.values[lastJ])).toFixed(1) + '" r="7.5" fill="' + s0.color + '" fill-opacity="0.22"/>' + '<circle class="now-dot" cx="' + x(t[lastJ]).toFixed(1) + '" cy="' + y(Number(s0.values[lastJ])).toFixed(1) + '" r="4" fill="' + s0.color + '" stroke="' + css("--card") + '" stroke-width="2"/>';
    html += '<line class="crosshair" y1="' + padT + '" y2="' + (H - padB) + '" visibility="hidden"/>';
    series.forEach(function (s) { html += '<circle class="dot" r="4.5" fill="' + s.color + '" visibility="hidden"/>'; });
    html += "</svg>";
    el.innerHTML = html;
    var svg = el.querySelector("svg"), cross = svg.querySelector(".crosshair"), dots = svg.querySelectorAll(".dot");
    function move(ev) {
      var rect = svg.getBoundingClientRect();
      var px = ((ev.clientX - rect.left) / rect.width) * W;
      var ts = t0 + ((px - padL) / (W - padL - padR)) * (t1 - t0);
      var best = 0;
      for (var j = 1; j < t.length; j++) if (Math.abs(t[j] - ts) < Math.abs(t[best] - ts)) best = j;
      var cx = x(t[best]);
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
      var rows = "";
      series.forEach(function (s, si) {
        var v = s.values[best];
        if (isNum(v)) { dots[si].setAttribute("cx", cx); dots[si].setAttribute("cy", y(Number(v))); dots[si].setAttribute("visibility", "visible"); }
        else dots[si].setAttribute("visibility", "hidden");
        rows += '<div class="row"><i style="background:' + s.color + '"></i>' + (series.length > 1 ? esc(s.name) + ": " : "") + '<b class="num">' + esc(isNum(v) ? (opts.fmt ? opts.fmt(v) : fmt(v, 1)) : "—") + "</b>" + esc(opts.unit || "") + "</div>";
      });
      tooltip.innerHTML = '<div class="t">' + esc(new Date(t[best]).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })) + "</div>" + rows;
      tooltip.hidden = false;
      var tx = Math.min(window.innerWidth - tooltip.offsetWidth - 8, ev.clientX + 14);
      tooltip.style.left = Math.max(8, tx) + "px";
      tooltip.style.top = Math.max(8, ev.clientY - tooltip.offsetHeight - 12) + "px";
    }
    function leave() { tooltip.hidden = true; cross.setAttribute("visibility", "hidden"); dots.forEach(function (d) { d.setAttribute("visibility", "hidden"); }); }
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", leave);
  }
  function spark(values, color) {
    var v = (values || []).filter(isNum).map(Number);
    if (v.length < 2) return "";
    var mn = Math.min.apply(null, v), mx = Math.max.apply(null, v), rg = mx - mn || 1;
    var d = v.map(function (p, i) { return (i ? "L" : "M") + ((i / (v.length - 1)) * 100).toFixed(2) + " " + (30 - ((p - mn) / rg) * 26 - 2).toFixed(2); }).join("");
    // Soft area fill under the line — the spark reads as a shape, not a thread.
    var area = d + "L100 30L0 30Z";
    return '<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="' + area + '" fill="' + color + '" fill-opacity="0.14"/><path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round"/></svg>';
  }
  function stats(values) {
    var v = (values || []).filter(isNum).map(Number);
    if (!v.length) return null;
    return { min: Math.min.apply(null, v), max: Math.max.apply(null, v), avg: v.reduce(function (a, b) { return a + b; }, 0) / v.length };
  }

  // ── shared bits ─────────────────────────────────────────────────────
  function head(title, sub, right) {
    return '<div class="page-head"><div><h1>' + esc(title) + "</h1>" + (sub ? "<p>" + sub + "</p>" : "") + "</div>" + (right || "") + "</div>";
  }
  function skeleton() {
    return '<div class="grid g-hero"><div class="card"><div class="skeleton" style="height:240px"></div></div><div class="card"><div class="skeleton" style="height:28px;width:60%"></div><div class="skeleton" style="height:60px;margin-top:14px"></div><div class="skeleton" style="height:120px;margin-top:14px"></div></div></div>';
  }
  function noData(err) {
    return '<div class="card"><h2>' + (err ? "Can't reach the sensor right now" : "Waiting for the first reading") + '</h2><p class="muted">' + (err ? "The dashboard will retry on its own." : "As soon as the SniffMaster posts its first reading, it shows up here.") + "</p></div>";
  }
  function scoreRing(score, grade) {
    if (window.SniffGauge) {
      return window.SniffGauge.scoreRingHtml(score, grade, {
        good: css("--good"), fair: css("--fair"), poor: css("--poor"), bad: css("--bad")
      });
    }
    // Fallback until /gauge.js loads: the old flat single-color ring.
    var tone = toneFor(score), color = css("--" + (tone === "na" ? "ink-3" : tone));
    var R = 84, C = 2 * Math.PI * R, arc = C * 0.75, pct = isNum(score) ? Math.max(0, Math.min(100, score)) / 100 : 0;
    return '<div class="ring"><svg viewBox="0 0 200 200" aria-hidden="true"><circle class="track" cx="100" cy="100" r="' + R + '" fill="none" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + arc + " " + C + '"/>' +
      '<circle class="arc" cx="100" cy="100" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + arc * pct + " " + C + '"/></svg>' +
      '<div class="ring-label"><span class="num">' + fmt(score) + '</span><span class="grade">' + esc(grade || "No data") + "</span></div></div>";
  }

  // ── Overview ───────────────────────────────────────────────────────
  async function pageHome() {
    var home = await load("home");
    if (!home) return noData();
    var ins = await load("insights").catch(function () { return null; });
    var wx = await load("weather").catch(function () { return null; });
    var s = home.series || {};
    var comps = (home.score && home.score.components) || [];
    // Worst first: the list reads as "what to look at", not data order.
    var scored = comps.filter(function (c) { return isNum(c.score); });
    var sorted = scored.slice().sort(function (a, b) { return a.score - b.score; });
    var compHtml = sorted.map(function (c) {
      return '<div class="comp"><span>' + esc(c.label) + '</span><span class="num">' + fmt(c.score) + '</span><span class="bar"><i style="width:' + c.score + "%;--bar:" + css("--" + toneFor(c.score)) + '"></i></span></div>';
    }).join("");
    // Plain-language takeaway + what's driving the score, from the same
    // data the bars show — nothing invented. Appears once /gauge.js
    // loads (see the sniff-gauge-ready listener); the ring renders first.
    var gauge = window.SniffGauge;
    var noteHtml = "";
    var driverHtml = "";
    if (gauge) {
      noteHtml = '<p class="gauge-note">' + esc(gauge.gaugeNote(toneFor(home.score && home.score.value))) + "</p>";
      var low = gauge.lowestComponent(scored);
      if (low) {
        driverHtml = Number(low.score) < 80
          ? '<p class="driver">Biggest drag right now: <b>' + esc(low.label) + "</b> · " + fmt(low.score) + "/100</p>"
          : '<p class="driver">No single drag — every part is scoring well.</p>';
      }
    }

    var brief = ins
      ? '<p class="kicker"><span class="ai-tag">' + (ins.source === "claude" ? "Insight from Claude" : "Today's read") + "</span></p><h2>" + esc(ins.headline) + '</h2><p class="summary">' + esc(ins.summary) + '</p><div class="tips">' +
        (ins.tips || []).map(function (t) { return '<div class="tip ' + esc(t.tone) + '"><b>' + esc(t.title) + "</b><p>" + esc(t.text) + "</p></div>"; }).join("") + "</div>"
      : '<p class="kicker">Today\'s read</p><h2>' + esc((home.visitor && home.visitor.headline) || "Air data is in.") + "</h2>";

    var smell = home.smell || {};
    var cl = home.climate || {};
    var g = home.gases || {};
    var device = home.device || {};
    var pet = home.petAllergen || {};
    var out = home.outdoor || {};
    var cur = wx && wx.current;
    var vent = home.ventilation || {};
    // Sparkline color means state, not series identity: green while the reading
    // is in its good band, amber when it drifts, red/orange when it is bad.
    var tempTone = !isNum(cl.tempF) ? "--ink-3" : cl.tempF >= 68 && cl.tempF <= 76 ? "--good" : cl.tempF >= 60 && cl.tempF <= 84 ? "--fair" : "--poor";
    var co2Tone = !isNum(g.co2) ? "--ink-3" : g.co2 <= 800 ? "--good" : g.co2 <= 1200 ? "--fair" : "--bad";

    var tiles = [
      '<a class="card stat" href="#/smell"><p class="kicker">Smell</p><div class="value value-md">' + esc(smell.level || "—") + '</div><div class="line">' + esc(smell.headline || "") + "</div>" + (smell.sinceMinutes ? '<div class="line muted small">For ' + smell.sinceMinutes + " min · " + esc(smell.trend || "") + "</div>" : "") + "</a>",
      '<a class="card stat" href="#/sensors"><p class="kicker">Comfort</p><div class="value num">' + fmt(cl.tempF, 1) + "<small>°F</small> " + fmt(cl.humidity) + '<small>% RH</small></div><div class="line">' + esc(cl.comfort || "") + " · dew point " + fmt(cToF(cl.dewPointC)) + "°F</div>" + spark(s.tempC, css(tempTone)) + "</a>",
      '<a class="card stat" href="#/sensors"><p class="kicker">' + (g.co2Source === "sensor" ? "CO₂ sensor" : g.co2Source === "estimated" ? "CO₂ estimate" : "CO₂") + '</p><div class="value num">' + fmt(g.co2) + '<small>ppm CO₂</small></div><div class="line">' + esc(vent.text || g.co2Category || "") + (g.co2Source === "estimated" ? " · same BSEC estimate as the OLED" : "") + "</div>" + spark(s.co2, css(co2Tone)) + "</a>",
      '<a class="card stat" href="#/pets"><p class="kicker">Pet meter</p><div class="value num">' + fmt(pet.index) + '<small>/ 100</small></div><div class="line">' + pill(pet.level || "Unknown", levelTone(pet.level)) + ' <span class="muted small">' + esc(pet.confidence ? pet.confidence + " confidence" : "") + "</span></div></a>",
    ];

    var outside = '<a class="card" href="#/outside"><div class="card-head"><h3>Outside' + (home.city ? " in " + esc(home.city) : "") + "</h3>" + pill("AQI " + fmt(out.usAqi), levelTone(wx && wx.outdoorLevel || (out.usAqi <= 50 ? "good" : out.usAqi <= 100 ? "moderate" : "high"))) + "</div>" +
      (cur ? '<p style="margin:0 0 12px" class="muted">' + esc(cur.condition) + ", " + fmt(cur.tempF) + "°F (feels " + fmt(cur.feelsLikeF) + "°F) · wind " + esc(cur.windSpeed || "calm") + " " + esc(cur.windDir || "") + "</p>" : "") +
      (wx && wx.forecast && wx.forecast.length ? '<div class="forecast">' + wx.forecast.map(function (d) { return "<div><b>" + esc(d.label.split(",")[0]) + '</b><span class="hi">' + fmt(d.highF) + "°</span> <span class=\"muted\">" + fmt(d.lowF) + "°</span><br><span class=\"small\">" + esc(d.condition) + (d.precipChance ? " · " + fmt(d.precipChance) + "%" : "") + "</span></div>"; }).join("") + "</div>" : "") +
      "</a>";

    var bio = home.biological || {};
    var sampleCard = airSampleCard(home.airSample);
    var risks = '<div class="card"><div class="card-head"><h3>Allergen & moisture risk</h3><span class="sub">estimates</span></div><dl class="kv">' +
      "<dt>Pet dander</dt><dd>" + pill(pet.level || "—", levelTone(pet.level)) + "</dd>" +
      "<dt>Mold</dt><dd>" + pill((bio.mold && bio.mold.category) || "—", levelTone(bio.mold && bio.mold.category)) + "</dd>" +
      "<dt>Dust mites</dt><dd>" + pill((bio.dustMite && bio.dustMite.category) || "—", levelTone(bio.dustMite && bio.dustMite.category)) + "</dd>" +
      "<dt>Dry air</dt><dd>" + pill((bio.dryAir && bio.dryAir.category) || "—", levelTone(bio.dryAir && bio.dryAir.category)) + "</dd>" +
      "<dt>Outdoor pollen</dt><dd>" + (home.pollen && home.pollen.ok ? pill(topPollen(home.pollen), levelTone(topPollen(home.pollen).split(" ").pop())) : '<span class="muted small">not available here</span>') + "</dd></dl></div>";

    var deviceRows = "";
    if (isNum(device.airScore) || device.primary) {
      deviceRows = '<div class="device-readout">' +
        (isNum(device.airScore) ? '<span>Device air load</span><b class="num">' + fmt(device.airScore) + '/100</b>' : "") +
        (isNum(device.oledDeviceScore) ? '<span>OLED device score</span><b class="num">' + fmt(device.oledDeviceScore) + '/100</b>' : "") +
        (device.primary ? '<span>Dominant odor</span><b>' + esc(device.primary) + (isNum(device.primaryConf) ? " · " + fmt(device.primaryConf) + "%" : "") + "</b>" : "") +
        '<small>Lower is cleaner. The OLED prints the other number, 100 minus this one, only when it cannot reach the dashboard. Dominant odor uses the same 20% cutoff as the OLED footer.</small></div>';
    }

    return '<div class="grid g-hero">' +
      '<div class="card score-card"><p class="kicker">Home health score</p>' + scoreRing(home.score && home.score.value, home.score && home.score.grade) +
      noteHtml + driverHtml +
      '<div class="where">Higher is healthier · this is the OLED Home Score · updated ' + esc(ago(home.receivedAt)) + "</div>" + deviceRows + (compHtml ? '<div class="components">' + compHtml + "</div>" : "") + "</div>" +
      '<div class="card brief">' + brief + "</div></div>" +
      '<div class="grid g-4 mt">' + tiles.join("") + "</div>" +
      '<div class="grid g-2 mt">' + outside + risks + "</div>" + sampleCard;
  }
  function airSampleCard(sample) {
    sample = sample || {};
    var phrase = { no_shift: "No meaningful VOC shift", mild: "Mild VOC response", strong: "Strong VOC response" };
    var stateLabel = { idle: "Idle", baseline: "Baseline", measure: "Measuring", result: "Result", rejected: "Not ready", cancelled: "Cancelled" };
    var live = sample.state === "baseline" || sample.state === "measure";
    var tone = sample.result === "strong" ? "poor" : sample.result === "mild" ? "fair" : sample.result === "no_shift" ? "good" : live ? "fair" : "na";
    var headline = live
      ? (sample.state === "baseline" ? "Collecting a 10 second baseline." : "Measuring the VOC change.")
      : (phrase[sample.result] || "Hold the right-hand button to sample the air in front of the sensor.");
    var prog = isNum(sample.progress) ? Math.max(0, Math.min(100, Math.round(Number(sample.progress)))) : 0;
    var whenSec = Number(sample.completedAt);
    var when = isNum(sample.completedAt) && whenSec > 1000000000 ? clock(whenSec > 1000000000000 ? whenSec : whenSec * 1000) : "";
    var delta = isNum(sample.deltaVoc) ? '<p class="muted" style="margin:0 0 8px">VOC change ' + fmt(sample.deltaVoc, 2) + " ppm" + (isNum(sample.baselineVoc) ? " from a " + fmt(sample.baselineVoc, 2) + " ppm baseline" : "") + "</p>" : "";
    var bar = live ? '<div class="hbar"><span>' + esc(stateLabel[sample.state] || "Progress") + '</span><div class="track"><i style="width:' + prog + '%"></i></div><span class="v">' + prog + "%</span></div>" : "";
    return '<div class="card mt"><div class="card-head"><h3>Air sample</h3>' + pill(live ? (stateLabel[sample.state] || "Running") : sample.result ? (phrase[sample.result] || "Complete") : "Ready", tone) + "</div>" +
      '<p style="margin:0 0 8px;font-weight:600">' + esc(headline) + "</p>" + delta + bar +
      (when && !live ? '<p class="muted small" style="margin:8px 0 0">Latest result ' + esc(when) + "</p>" : "") +
      '<p class="note">VOC response only. Not a health or alcohol test.</p></div>';
  }
  function topPollen(p) {
    var items = [].concat(p.types || [], p.plants || []).filter(function (x) { return isNum(x.value); }).sort(function (a, b) { return b.value - a.value; });
    return items.length ? items[0].name + " " + (items[0].category || "") : "Low";
  }

  // ── Sensors ────────────────────────────────────────────────────────
  var CHANNELS = [
    { key: "iaq", title: "Indoor air quality (IAQ)", unit: "", d: 0, color: "--series-1", extra: { key: "staticIaq", name: "Static IAQ" }, note: "Lower is cleaner. The colored bands are the usual indoor ranges.", floor: 0, y: [0, 200],
      zones: [{ lo: 0, hi: 100, tone: "good", label: "Good, under 100" }, { lo: 100, hi: 150, tone: "fair", label: "Watch, 100 to 150" }, { lo: 150, hi: 500, tone: "bad", label: "High, above 150" }],
      marks: [{ y: 100, tone: "fair" }, { y: 150, tone: "bad" }] },
    { key: "co2", title: "CO₂ equivalent", unit: " ppm", d: 0, color: "--series-1", note: "Estimated from gases. Under 800 feels fresh. Above 1,200 most people notice stuffiness.", floor: 0, y: [400, 1600],
      zones: [{ lo: 0, hi: 800, tone: "good", label: "Fresh, under 800" }, { lo: 800, hi: 1200, tone: "fair", label: "Getting stuffy, 800 to 1,200" }, { lo: 1200, hi: 5000, tone: "bad", label: "Stuffy, above 1,200" }],
      marks: [{ y: 800, tone: "fair" }, { y: 1200, tone: "bad" }] },
    { key: "voc", title: "Breath VOC equivalent", unit: " ppm", d: 2, color: "--series-1", note: "Vapors from people, cooking, cleaners, and furniture. Lower is calmer.", floor: 0, y: [0, 4],
      zones: [{ lo: 0, hi: 1, tone: "good", label: "Low, under 1" }, { lo: 1, hi: 2.5, tone: "fair", label: "Noticeable, 1 to 2.5" }, { lo: 2.5, hi: 20, tone: "bad", label: "High, above 2.5" }],
      marks: [{ y: 1, tone: "fair" }, { y: 2.5, tone: "bad" }] },
    { key: "gasR", title: "Gas resistance", unit: " kΩ", d: 0, color: "--series-3", scale: 0.001, note: "There is no fixed good or bad line. A falling line means more gases in the air." },
    { key: "tempF", title: "Temperature", unit: " °F", d: 1, color: "--series-2", note: "Most homes feel comfortable between 68 and 76°F.", y: [60, 84],
      zones: [{ lo: 68, hi: 76, tone: "good", label: "Comfortable, 68 to 76°F" }, { lo: 60, hi: 68, tone: "fair", label: "Cool, 60 to 68°F" }, { lo: 76, hi: 84, tone: "fair", label: "Warm, 76 to 84°F" }, { lo: 32, hi: 60, tone: "bad", label: "Cold, under 60°F" }, { lo: 84, hi: 110, tone: "bad", label: "Hot, above 84°F" }],
      marks: [{ y: 68, tone: "good" }, { y: 76, tone: "good" }] },
    { key: "humidity", title: "Relative humidity", unit: " %", d: 1, color: "--series-3", note: "40–60% is comfortable. Long stretches above 60% favor mold and dust mites.", floor: 0, y: [25, 75],
      zones: [{ lo: 40, hi: 60, tone: "good", label: "Comfortable, 40 to 60%" }, { lo: 30, hi: 40, tone: "fair", label: "A bit dry, 30 to 40%" }, { lo: 60, hi: 70, tone: "fair", label: "A bit damp, 60 to 70%" }, { lo: 0, hi: 30, tone: "bad", label: "Too dry, under 30%" }, { lo: 70, hi: 100, tone: "bad", label: "Too damp, above 70%" }],
      marks: [{ y: 40, tone: "good" }, { y: 60, tone: "fair" }] },
    { key: "pressHpa", title: "Barometric pressure", unit: " hPa", d: 1, color: "--series-1", note: "No good or bad line. A falling line often means weather is on the way." },
    { key: "gasPct", title: "Gas percentage", unit: " %", d: 0, color: "--series-3", note: "Where this reading sits in the sensor's own history. It is not a health limit.", floor: 0, y: [0, 100] },
  ];
  function zoneFor(c, v) {
    if (!c.zones || !isNum(v)) return null;
    for (var i = 0; i < c.zones.length; i++) if (v >= c.zones[i].lo && v < c.zones[i].hi) return c.zones[i];
    return null;
  }
  function guideRange(values, c) {
    var nums = (values || []).filter(isNum).map(Number);
    if (!nums.length) return c.y || [0, 1];
    var lo = Math.min.apply(null, nums);
    var hi = Math.max.apply(null, nums);
    var marks = (c.marks || []).map(function (m) { return m.y; }).sort(function (a, b) { return a - b; });
    var below = null, above = null;
    marks.forEach(function (y) {
      if (y <= lo + (hi - lo) * 0.02) below = y;
      if (above === null && y >= hi) above = y;
    });
    if (below !== null) lo = Math.min(lo, below);
    if (above !== null) hi = Math.max(hi, above);
    var span = Math.max(hi - lo, 1);
    var pad = Math.max(span * 0.12, c.key === "voc" ? 0.12 : 1);
    var y0 = lo - (below === null ? pad : pad * 0.35);
    var y1 = hi + (above === null ? pad * 0.45 : span * 0.22);
    if (c.floor !== undefined) y0 = Math.max(c.floor, y0);
    return [y0, y1];
  }
  async function pageSensors() {
    var d = await load("sensors");
    if (!d) return noData();
    var L = d.latest || {};
    var S = d.series || {};
    var seg = '<div class="seg" role="group" aria-label="Time range">' + ["1h", "6h", "24h", "7d"].map(function (r) { return '<button type="button" data-range="' + r + '" aria-pressed="' + (r === sensorRange) + '">' + r + "</button>"; }).join("") + "</div>";
    var cards = CHANNELS.map(function (c) {
      if (c.key === "gasPct" && L.gasPctValid === false) {
        return '<div class="card"><div class="metric-head"><div><h3>' + esc(c.title) + '</h3><p class="muted small" style="margin:4px 0 0;max-width:46ch">' + esc(c.note) + '</p></div><div class="now"><span class="num">n/a</span><br><small>not measured</small></div></div><p class="muted small">This BSEC bundle does not produce gas percentage. A zero here would be a fake reading.</p></div>';
      }
      var vals = (S[c.key] || []).map(function (v) { return isNum(v) && c.scale ? v * c.scale : v; });
      var st = stats(vals);
      var nowV = isNum(L[c.key]) ? L[c.key] * (c.scale || 1) : null;
      if (!st && !isNum(nowV)) return "";
      var zone = zoneFor(c, nowV);
      var unitSuffix = c.unit.trim() ? " " + c.unit.trim() : "";
      var legend = (c.zones || []).map(function (z) { return '<span><i class="swatch ' + z.tone + '"></i>' + esc(z.label) + "</span>"; }).join("");
      return '<div class="card"><div class="metric-head"><div><h3>' + esc(c.title) + '</h3><p class="muted small" style="margin:4px 0 0;max-width:46ch">' + esc(c.note) + "</p>" +
        (zone ? '<p class="level-now">' + pill(zone.label.split(",")[0], zone.tone) + "</p>" : "") + '</div><div class="now"><span class="num">' + fmt(nowV, c.d) + "</span><br><small>" + esc(c.unit.trim() || "index") + " now</small></div></div>" +
        (legend ? '<div class="legend bands">' + legend + "</div>" : "") +
        (c.extra && S[c.extra.key] ? '<div class="legend"><span><i style="background:' + css(c.color) + '"></i>' + esc(c.title.split(" (")[0]) + '</span><span><i style="background:' + css("--series-2") + '"></i>' + esc(c.extra.name) + "</span></div>" : "") +
        '<div class="chart" data-ch="' + c.key + '"></div>' +
        (st ? '<div class="mma"><span>Low <b>' + fmt(st.min, c.d) + unitSuffix + "</b></span><span>Avg <b>" + fmt(st.avg, c.d) + unitSuffix + "</b></span><span>High <b>" + fmt(st.max, c.d) + unitSuffix + "</b></span></div>" : "") + "</div>";
    }).join("");

    var accText = ["Stabilizing", "Low", "Medium", "High"][Number(L.iaqAcc)] || "—";
    var cal = '<div class="card"><div class="card-head"><h3>Sensor health & calibration</h3>' + pill("Accuracy " + accText, Number(L.iaqAcc) >= 3 ? "good" : Number(L.iaqAcc) >= 2 ? "fair" : "poor") + '</div><dl class="kv">' +
      "<dt>BSEC status</dt><dd>" + esc(L.calibration || "—") + "</dd>" +
      "<dt>Stabilized / run-in</dt><dd>" + (L.stab ? "yes" : "no") + " / " + (L.runIn ? "done" : "running") + "</dd>" +
      "<dt>Calibration restored from flash</dt><dd>" + (L.bsecRestored ? "yes" : "no") + "</dd>" +
      "<dt>Configuration</dt><dd>" + esc(L.bsecCfg || "—") + " (" + esc(L.bsecBundle || "?") + ")</dd>" +
      "<dt>Compensated gas</dt><dd>" + (L.gasPctValid ? fmt(L.compGas) + " Ω" : "—") + "</dd>" +
      "<dt>VOC change (dVOC)</dt><dd>" + fmt(L.dVoc, 2) + " ppm</dd>" +
      "<dt>Raw temp / humidity</dt><dd>" + (isNum(L.tempRawC) ? fmt(cToF(L.tempRawC), 1) + " °F" : "—") + " / " + (isNum(L.humRaw) ? fmt(L.humRaw, 1) + " %" : "—") + "</dd>" +
      "<dt>IAQ trend / VOC trend</dt><dd>" + esc(L.iaqTrend || "—") + " / " + esc(L.vocTrend || "—") + "</dd>" +
      "<dt>Room score</dt><dd>" + (isNum(L.roomScore) ? fmt(L.roomScore, 0) : "—") + "</dd>" +
      "<dt>Ventilation</dt><dd>" + esc(L.vent || "—") + "</dd>" +
      "<dt>Dew point</dt><dd>" + (isNum(L.dewF) ? fmt(L.dewF, 1) + " °F" : "—") + "</dd>" +
      "<dt>Pressure trend</dt><dd>" + esc(L.pressTrend || "—") + (L.pressDisagree ? " (disagrees with forecast)" : "") + "</dd>" +
      "<dt>Wi-Fi signal</dt><dd>" + fmt(L.wifiRssi) + " dBm</dd>" +
      "<dt>Uptime</dt><dd>" + (isNum(L.uptime) ? fmt(L.uptime / 3600, 1) + " h" : "—") + "</dd>" +
      "<dt>Last reading</dt><dd>" + esc(L.receivedAt ? clock(L.receivedAt) + " (" + ago(L.receivedAt) + ")" : "—") + "</dd></dl>" +
      (sensorNote(L)) + "</div>";

    var addon = ["pm25", "pm10"].some(function (k) { return isNum(L[k]); }) ? "" :
      '<div class="card"><h3>Want particulate readings?</h3><p class="muted" style="margin:6px 0 0">The BME688 senses gases, not dust. Adding a Sensirion SEN5x (PM1–PM10) makes the pet dander meter far more precise, and the firmware already has a hook for it in <code>home_sensors.h</code>.</p></div>';

    function sensorNote(L) {
      var acc = Number(L.iaqAcc);
      var settled = L.stab === 1 || L.stab === true || L.runIn === 1 || L.runIn === true;
      var publishing = isNum(L.gasR) && Number(L.gasR) > 0 && isNum(L.iaq) && isNum(L.co2) && Number(L.co2) > 0;
      var posted = /room air has not varied/i.test(L.calibration || "");
      if ((acc >= 1 && acc < 2 && settled && publishing) || posted)
        return '<p class="note">The sensor is running, and BSEC accuracy is still low because the room air has not varied. Accuracy rises when the air changes, not from uptime alone.</p>';
      if (acc < 2)
        return '<p class="note">The sensor is still warming up. This is a cold start, not a sensor that has already been publishing in still air.</p>';
      return "";
    }
    window.__sensorData = d;
    return head("Sensors", "Every channel from the BME688 and BSEC2, at full precision.", seg) +
      (sensorRange === "7d" ? '<div class="callout mb">The 7-day view uses the compact 10-minute history, which keeps temperature, humidity, CO₂ and IAQ.</div>' : "") +
      '<div class="grid g-2 wide3">' + cards + "</div>" + '<div class="grid g-2 top mt">' + cal + addon + "</div>";
  }
  function drawSensorCharts() {
    var d = window.__sensorData;
    if (!d) return;
    CHANNELS.forEach(function (c) {
      var el = view.querySelector('[data-ch="' + c.key + '"]');
      if (!el) return;
      var vals = (d.series[c.key] || []).map(function (v) { return isNum(v) && c.scale ? v * c.scale : v; });
      var series = [{ name: c.title, values: vals, color: css(c.color) }];
      if (c.extra && d.series[c.extra.key]) series.push({ name: c.extra.name, values: d.series[c.extra.key], color: css("--series-2"), dash: true });
      var allVals = vals.slice();
      series.slice(1).forEach(function (s) { (s.values || []).forEach(function (v) { allVals.push(v); }); });
      lineChart(el, { t: d.series.t, series: series, unit: c.unit, label: c.title, zones: c.zones, marks: c.marks, yRange: c.y || c.zones ? guideRange(allVals, c) : undefined, fmt: function (v) { return fmt(v, c.d); } });
    });
  }

  // ── Smell ──────────────────────────────────────────────────────────
  var ODORS = ["Flatulence", "Musty", "Cigarette smoke", "Alcohol", "Cannabis", "Cleaning products", "Gasoline", "Smoke", "Cooking", "Coffee", "Garbage", "Body odor", "Perfume", "Laundry", "Sulfur", "Solvent", "Pet / litter", "Sour food", "Burnt / oil", "Citrus"];
  async function pageSmell() {
    var home = await load("home");
    if (!home) return noData();
    var sens = await load("sensors").catch(function () { return null; });
    var sniffs = await load("sniffs").catch(function () { return []; });
    window.__sensorData = sens;
    var sm = home.smell || {};
    var device = home.device || {};
    var sense = home.airSense || {};
    var cause = home.cause || sense.cause || {};
    var latest = (sens && sens.latest) || {};
    var odors = Array.isArray(latest.odors) ? latest.odors : [];
    var rankedAtlas = (sense.odors && sense.odors.length) ? sense.odors : odors.map(function (v, i) { return { index: i, score: Number(v) || 0, name: ODORS[i], active: (Number(v) || 0) >= 8 }; }).sort(function (a, b) { return b.score - a.score; });
    var bars = rankedAtlas.map(function (o) {
      var v = o.score || 0;
      // Bar color means strength in the shared state language: mild is fine,
      // noticeable is worth watching, strong is the one to act on.
      var barTone = v >= 65 ? "--poor" : v >= 40 ? "--fair" : "--good";
      return '<div class="hbar' + (v < 20 ? " dim" : "") + '"><span>' + esc(o.name || ODORS[o.index]) + '</span><span class="track"><i style="width:' + Math.min(100, v) + "%;--bar:" + css(barTone) + '"></i></span><span class="v">' + fmt(v) + "</span></div>";
    }).join("");
    var tone = sm.smellsBad ? (sm.safety ? "bad" : "poor") : sm.tone === "fair" ? "fair" : "good";
    var nose = sense.sensoryLoad || {};
    var debt = sense.freshnessDebt || {};
    var character = sense.character || {};
    var smellPill = sm.state === "unclassified"
      ? pill(sm.level || "Unclassified gas change", "fair")
      : (sm.smellsBad ? pill(sm.level || "Smelly", tone) : pill(sm.tone === "fair" ? "Slightly off" : "Fresh", tone));
    var deviceOdor = device.primary
      ? '<p class="note"><b>OLED dominant odor. </b>' + esc(device.primary) + (isNum(device.primaryConf) ? " · " + fmt(device.primaryConf) + "%" : "") + ". The smells card footer uses this same call.</p>"
      : "";
    var main = '<div class="card"><p class="kicker">Right now</p><h2 style="font-size:22px;margin:0 0 6px">' + esc(sm.headline || "No reading yet") + "</h2>" +
      '<div class="chips" style="margin:6px 0 10px">' + smellPill + (sm.confidence ? pill(sm.confidence + " confidence", "na") : "") + (sm.trend ? pill(sm.trend, sm.trend === "worsening" ? "poor" : "na") : "") +
      (nose.band ? pill("Nose: " + nose.band, nose.value >= 65 ? "poor" : nose.value >= 40 ? "fair" : "good") : "") +
      (character.headline ? pill(character.headline, "na") : "") + "</div>" +
      (sm.action ? '<div class="callout ' + (sm.safety ? "bad" : "fair") + '">' + esc(sm.action) + "</div>" : "") +
      deviceOdor +
      (cause.label ? '<p class="note"><b>Likely situation. </b>' + esc(cause.label) + (cause.action ? " — " + esc(cause.action) : "") + "</p>" : "") +
      '<p class="note">' + esc(sm.detail || "") + "</p></div>";

    var story = (sense.breathStory || []).map(function (line) { return "<li>" + esc(line) + "</li>"; }).join("");
    var storyCard = '<div class="card"><div class="card-head"><h3>Everything known about this air</h3><span class="sub">derived from every signal</span></div>' +
      (story ? '<ol class="breath-story">' + story + "</ol>" : '<p class="muted">Waiting for enough readings to build the story.</p>') +
      '<p class="note">' + esc(sense.honesty || "Smell families are associations from indoor-air science, not a lab chemical ID.") + "</p></div>";

    var metrics = '<div class="grid g-3" style="margin-top:0">' +
      '<div class="card stat"><p class="kicker">Sensory load</p><div class="value num">' + fmt(nose.value) + '<small>/100</small></div><div class="line">' + esc(nose.text || "How much a nose would notice.") + "</div></div>" +
      '<div class="card stat"><p class="kicker">Freshness debt</p><div class="value num">' + fmt(debt.pct) + '<small>%</small></div><div class="line">' + esc(debt.text || "Distance below this room's clean baseline.") + "</div></div>" +
      '<div class="card stat"><p class="kicker">Bouquet</p><div class="value value-md">' + esc((sense.odorComplexity && sense.odorComplexity.label) || "—") + '</div><div class="line">' + esc((sense.odorComplexity && sense.odorComplexity.text) || "") + "</div></div></div>";

    var bouquetCards = (sense.bouquets || []).map(function (b) {
      return '<div class="tip ' + (b.strength === "strong" ? "bad" : b.strength === "likely" ? "fair" : "good") + '"><b>' + esc(b.label) + " · " + esc(b.strength) + " · " + fmt(b.score) + '</b><p>' + esc(b.why) + (b.regions && b.regions.length ? " Common in: " + esc(b.regions.join(", ")) + "." : "") + "</p></div>";
    }).join("");
    var bouquetCard = '<div class="card"><div class="card-head"><h3>Worldwide smell bouquets</h3><span class="sub">multi-class matches</span></div>' +
      (bouquetCards ? '<div class="tips">' + bouquetCards + "</div>" : '<p class="muted">No multi-class bouquet is strong enough yet.</p>') +
      '<p class="note">Bouquets combine several smell classes plus humidity or outdoor AQI. They describe atmospheres people recognize worldwide — incense, spice kitchens, monsoon damp, garage petrol — without claiming a lab ID.</p></div>';

    var familyRows = (sense.families || []).map(function (f) {
      return "<dt>" + esc(f.family) + "</dt><dd>" + fmt(f.score) + '<div class="small muted">' + esc((f.senses || []).slice(0, 4).join(", ")) +
        (f.compounds && f.compounds.length ? " · often linked with " + esc(f.compounds.slice(0, 3).join(", ")) : "") + "</div></dd>";
    }).join("");
    var familyCard = '<div class="card"><div class="card-head"><h3>Chemical families</h3><span class="sub">associations</span></div>' +
      (familyRows ? '<dl class="kv">' + familyRows + "</dl>" : '<p class="muted">No family is clearly active.</p>') +
      '<p class="note">Compound names are common associations for that smell family in published indoor-air work — not a measurement of those molecules.</p></div>';

    var atlasCards = (sense.activeOdors || rankedAtlas.filter(function (o) { return o.score >= 20; }).slice(0, 8)).map(function (o) {
      return '<article class="odor-card"><div class="card-head"><h3>' + esc(o.name) + "</h3>" + pill(String(o.score), o.score >= 65 ? "poor" : o.score >= 40 ? "fair" : "good") + "</div>" +
        '<p class="muted small" style="margin:0 0 8px">' + esc(o.family || "") + (o.senses && o.senses.length ? " · " + esc(o.senses.join(", ")) : "") + "</p>" +
        (o.sources && o.sources.length ? '<p class="note" style="margin:0 0 6px"><b>Common sources. </b>' + esc(o.sources.join(", ")) + "</p>" : "") +
        (o.compounds && o.compounds.length ? '<p class="note" style="margin:0 0 6px"><b>Often linked with. </b>' + esc(o.compounds.join(", ")) + "</p>" : "") +
        (o.regions && o.regions.length ? '<p class="note" style="margin:0 0 6px"><b>Where it shows up. </b>' + esc(o.regions.join(", ")) + "</p>" : "") +
        (o.also ? '<p class="note" style="margin:0 0 6px">' + esc(o.also) + "</p>" : "") +
        (o.tip ? '<p class="note" style="margin:0"><b>What to do. </b>' + esc(o.tip) + "</p>" : "") +
        "</article>";
    }).join("");
    var atlasCard = '<div class="card"><div class="card-head"><h3>Active smells, explained</h3><span class="sub">' + fmt(sense.atlasSize || 20) + " class atlas</span></div>" +
      (atlasCards ? '<div class="odor-grid">' + atlasCards + "</div>" : '<p class="muted">Nothing is clearly above background yet.</p>') + "</div>";

    var extraBits = [];
    if (sense.staticGap) extraBits.push('<div class="tip fair"><b>Live vs background IAQ</b><p>' + esc(sense.staticGap.reading) + "</p></div>");
    if (sense.pressure) extraBits.push('<div class="tip good"><b>Pressure</b><p>' + esc(sense.pressure.text) + "</p></div>");
    if (sense.windowLeak) extraBits.push('<div class="tip ' + (sense.windowLeak.level === "likely" ? "bad" : "fair") + '"><b>Outdoor air</b><p>' + esc(sense.windowLeak.text) + "</p></div>");
    if (sense.comfort) extraBits.push('<div class="tip good"><b>Comfort</b><p>' + esc(sense.comfort.text) + "</p></div>");
    if (home.ventilation && home.ventilation.text) extraBits.push('<div class="tip fair"><b>Windows</b><p>' + esc(home.ventilation.text) + "</p></div>");
    var derivedCard = extraBits.length ? '<div class="card"><div class="card-head"><h3>More derived signals</h3><span class="sub">multi-variable</span></div><div class="tips">' + extraBits.join("") + "</div></div>" : "";

    var how = '<div class="card"><h3>How smell detection works</h3><p class="muted" style="margin:6px 0 0">The BME688 heats a metal-oxide plate and measures its resistance; smelly gases lower it. SniffMaster learns this room\'s own clean-air level, corrects for humidity, and only calls a smell when the drop holds for several minutes. A small neural network on the device scores 20 smell classes. The atlas and bouquets add worldwide context and multi-signal stories on top — still associations, not a lab assay.</p></div>';
    var events = (sniffs || []).length
      ? '<ul class="events">' + sniffs.map(function (e) { return "<li><span>" + esc(e.label || e.primary || "Sulfur event") + '</span><span class="muted num">' + esc(e.receivedAt ? clock(e.receivedAt, true) : "") + "</span></li>"; }).join("") + "</ul>"
      : '<p class="muted" style="margin:0">No strong sulfur events recorded recently.</p>';
    return head("Smell", "Every smell class the sensor knows, what that air usually means worldwide, and what we can derive from the whole room.") +
      '<div class="grid g-2">' + '<div class="stack" style="margin:0">' + main + storyCard + how + "</div>" +
      '<div class="card"><div class="card-head"><h3>Smell model scores</h3><span class="sub">0–100 per class · live</span></div>' + '<div class="legend bands"><span><i class="swatch good"></i>Mild 20–39</span><span><i class="swatch fair"></i>Noticeable 40–64</span><span><i class="swatch poor"></i>Strong 65+</span></div>' + (bars || '<p class="muted">No classifier output yet.</p>') + '<p class="note">Scores under 20 are background noise. The model holds back until the sensor is calibrated.</p></div></div>' +
      '<div class="mt">' + metrics + "</div>" +
      '<div class="grid g-2 mt">' + bouquetCard + familyCard + "</div>" +
      '<div class="mt">' + atlasCard + "</div>" +
      (derivedCard ? '<div class="mt">' + derivedCard + "</div>" : "") +
      '<div class="grid g-2 top mt"><div class="card"><div class="card-head"><h3>Smell timeline</h3><span class="sub">strongest class per interval, last ' + esc(sensorRange === "7d" ? "24h" : sensorRange) + '</span></div><div id="heat"></div><p class="note">Darker means a stronger smell (score 8–100). A row appears once a class rises above background.</p></div>' +
      '<div class="card"><h3 style="margin-bottom:8px">Recent sulfur events</h3>' + events + "</div></div>";
  }
  function drawHeat() {
    var el = $("#heat");
    var d = window.__sensorData;
    if (!el || !d || !Array.isArray(d.odors) || !d.odors.length) { if (el) el.innerHTML = '<div class="chart-empty" style="height:80px">Not enough history yet</div>'; return; }
    var rows = ODORS.map(function (_, i) { return d.odors.some(function (col) { return col && col[i] >= 20; }) ? i : -1; }).filter(function (i) { return i >= 0; });
    if (!rows.length) { el.innerHTML = '<div class="chart-empty" style="height:80px">Quiet the whole window. Nothing above background.</div>'; return; }
    var cols = d.odors.length, W = el.clientWidth || 800, labelW = 120, rowH = 18, H = rows.length * rowH + 20, cw = (W - labelW) / cols;
    // Cell color means strength in the same state language as the smell
    // bars (mild / noticeable / strong): warmer and more opaque as the
    // score rises, instead of one flat blue ramp.
    var cellFill = function (v) { return v >= 65 ? css("--poor") : v >= 40 ? css("--fair") : css("--good"); };
    var cellOp = function (v) { return v >= 65 ? 0.95 : v >= 40 ? 0.7 : 0.45; };
    var svg = '<svg class="heat" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Smell class strength over time">';
    rows.forEach(function (oi, r) {
      svg += '<text class="axis-text" x="0" y="' + (r * rowH + 13) + '" fill="currentColor" style="fill:var(--ink-2);font-size:11px">' + esc(ODORS[oi]) + "</text>";
      d.odors.forEach(function (col, c) {
        var v = col ? col[oi] : 0;
        if (!v || v < 8) return;
        svg += '<rect x="' + (labelW + c * cw).toFixed(1) + '" y="' + (r * rowH + 2) + '" width="' + Math.max(1, cw - 0.5).toFixed(1) + '" height="' + (rowH - 4) + '" rx="2" fill="' + cellFill(v) + '" fill-opacity="' + cellOp(v) + '"><title>' + esc(ODORS[oi]) + " " + v + " · " + clock(d.series.t[c]) + "</title></rect>";
      });
    });
    var t = d.series.t;
    svg += '<text class="axis-text" x="' + labelW + '" y="' + (H - 3) + '">' + esc(clock(t[0])) + '</text><text class="axis-text" x="' + W + '" y="' + (H - 3) + '" text-anchor="end">' + esc(clock(t[t.length - 1])) + "</text></svg>";
    el.innerHTML = svg;
  }

  // ── Pets ───────────────────────────────────────────────────────────
  var TRIGGERS = [["cat", "Cats"], ["dog", "Dogs"], ["pollen", "Pollen"], ["dustMite", "Dust mites"], ["mold", "Mold"], ["smoke", "Smoke"]];
  async function pagePets() {
    var home = await load("home");
    if (!home) return noData();
    var sens = await load("sensors").catch(function () { return null; });
    var pet = home.petAllergen || {};
    var idx = isNum(pet.index) ? Number(pet.index) : null;
    var ang = -90 + (Math.max(0, Math.min(100, idx || 0)) / 100) * 180;
    var bands = [["--good", 0, 25], ["--fair", 25, 50], ["--poor", 50, 75], ["--bad", 75, 100]];
    var arc = function (a0, a1) {
      var p = function (v) { var a = Math.PI * (1 - v / 100); return [150 + 120 * Math.cos(a), 150 - 120 * Math.sin(a)]; };
      var s = p(a0), e = p(a1);
      return "M" + s[0].toFixed(1) + " " + s[1].toFixed(1) + "A120 120 0 0 1 " + e[0].toFixed(1) + " " + e[1].toFixed(1);
    };
    var meter = '<div class="meter"><svg viewBox="0 0 300 170" aria-hidden="true">' +
      bands.map(function (b) { return '<path d="' + arc(b[1] + 0.8, b[2] - 0.8) + '" stroke="' + css(b[0]) + '" stroke-width="20" fill="none" stroke-linecap="butt" opacity="' + (idx !== null && idx >= b[1] && idx < b[2] + (b[2] === 100 ? 1 : 0) ? 1 : 0.22) + '"/>'; }).join("") +
      [[0, "0"], [50, "50"], [100, "100"]].map(function (tv) {
        var a = Math.PI * (1 - tv[0] / 100);
        var px = 150 + 138 * Math.cos(a), py = 150 - 138 * Math.sin(a);
        return '<text x="' + px.toFixed(0) + '" y="' + (py + (tv[0] === 50 ? 2 : 4)).toFixed(0) + '" text-anchor="middle" font-size="11" fill="' + css("--ink-3") + '">' + tv[1] + "</text>";
      }).join("") +
      '<g class="needle" style="transform:rotate(' + ang + 'deg)"><line x1="150" y1="150" x2="150" y2="44" stroke="' + css("--ink") + '" stroke-width="3" stroke-linecap="round"/></g><circle cx="150" cy="150" r="8" fill="' + css("--ink") + '"/></svg>' +
      '<div class="meter-value"><span class="num">' + fmt(idx) + '</span><div style="margin-top:6px">' + pill(pet.level || "Unknown", levelTone(pet.level)) + " " + pill((pet.confidence || "no") + " confidence", "na") + "</div></div></div>";
    var basis = (pet.basis || []).map(function (b) {
      return '<div class="hbar"><span>' + esc(b.label) + '</span><span class="track"><i style="width:' + b.score + '%"></i></span><span class="v">' + fmt(b.score) + '</span></div><p class="muted small" style="margin:-4px 0 6px">' + esc(b.detail) + "</p>";
    }).join("");
    var trig = store("sm-triggers") || [];
    var chips = '<div class="chips" id="trig">' + TRIGGERS.map(function (t) { return '<button type="button" class="chip" data-trig="' + t[0] + '" aria-pressed="' + (trig.indexOf(t[0]) >= 0) + '">' + t[1] + "</button>"; }).join("") + "</div>";
    var ol = home.outlook || {};
    var outlook = (ol.items || []).map(function (i) {
      return '<div class="tip ' + (levelTone(i.level) === "good" ? "good" : levelTone(i.level) === "fair" ? "fair" : "bad") + '"><b>' + esc(i.label) + " · " + esc(i.level) + "</b><p>" + esc(i.reason || "") + (i.action ? " " + esc(i.action) : "") + "</p></div>";
    }).join("");
    var bio = home.biological || {};
    var cov = function (r) { return r && r.windowComplete === false ? '<p class="note">Based on ' + fmt(r.coverageHours, 1) + " of " + r.windowHours + " hours so far.</p>" : ""; };
    var pollen = home.pollen && home.pollen.ok ? [].concat(home.pollen.types || [], home.pollen.plants || []) : [];
    window.__sensorData = sens;
    return head("Pet meter", "A precise read on pet dander and the other things that set off allergies, and how much to trust it.") +
      '<div class="grid g-hero"><div class="card"><div class="card-head"><h3>Pet dander index</h3><span class="sub">0–100 estimate</span></div>' + meter + '<p class="note">' + esc(pet.note || "") + "</p></div>" +
      '<div class="card"><h3 style="margin-bottom:12px">What goes into it</h3><div class="hbars">' + (basis || '<p class="muted">No pet-related signals yet.</p>') + "</div>" +
      '<p class="note">With a particulate sensor fitted, coarse dust in the 2.5–10 µm range (where dander lives) joins the index and confidence goes up to medium.</p></div></div>' +
      '<div class="grid g-2 top mt"><div class="card"><div class="card-head"><h3>Pet / litter smell over time</h3><span class="sub">smell-model class score</span></div><div class="chart" id="petchart"></div></div>' +
      '<div class="card"><h3>Your personal outlook</h3><p class="muted" style="margin:4px 0 12px">Pick what you react to. It stays on this device.</p>' + chips +
      '<p style="margin:14px 0 10px;font-weight:600">' + esc(ol.headline || "") + "</p>" + (outlook ? '<div class="tips">' + outlook + "</div>" : "") + "</div></div>" +
      '<div class="grid g-3 mt">' +
      '<div class="card stat"><p class="kicker">Mold risk</p><div class="value num">' + fmt(bio.mold && bio.mold.pct) + '<small>%</small></div><div class="line">' + pill((bio.mold && bio.mold.category) || "—", levelTone(bio.mold && bio.mold.category)) + " " + fmt(bio.mold && bio.mold.hoursRh70, 1) + " h above 70% RH in 3 days</div>" + cov(bio.mold) + "</div>" +
      '<div class="card stat"><p class="kicker">Dust-mite risk</p><div class="value num">' + fmt(bio.dustMite && bio.dustMite.pct) + '<small>%</small></div><div class="line">' + pill((bio.dustMite && bio.dustMite.category) || "—", levelTone(bio.dustMite && bio.dustMite.category)) + " " + fmt(bio.dustMite && bio.dustMite.hoursRh65, 1) + " h above 65% RH this week</div>" + cov(bio.dustMite) + "</div>" +
      '<div class="card"><p class="kicker">Outdoor pollen</p>' + (pollen.length ? '<div class="hbars">' + pollen.map(function (p) { return '<div class="hbar"><span>' + esc(p.name) + '</span><span class="track"><i style="width:' + Math.min(100, (Number(p.value) || 0) * 20) + '%"></i></span><span class="v">' + esc(p.category || "") + "</span></div>"; }).join("") + "</div>" : '<p class="muted" style="margin:0">' + esc((home.pollen && home.pollen.reason) || "No pollen data for this location.") + "</p>") + "</div></div>";
  }
  function drawPetChart() {
    var el = $("#petchart");
    var d = window.__sensorData;
    if (!el) return;
    if (!d || !Array.isArray(d.odors)) { el.innerHTML = '<div class="chart-empty">Not enough history yet</div>'; return; }
    lineChart(el, { t: d.series.t, series: [{ name: "Pet / litter", values: d.odors.map(function (c) { return c ? c[16] : null; }), color: css("--series-1") }], yRange: [0, 100], label: "Pet smell score", fmt: function (v) { return fmt(v); } });
  }

  // ── Outside ────────────────────────────────────────────────────────
  async function pageOutside() {
    var home = await load("home");
    if (!home) return noData();
    var wx = await load("weather").catch(function () { return null; });
    var o = home.outdoor || {};
    var cl = home.climate || {};
    var cur = wx && wx.current;
    var poll = [["PM2.5", o.pm25, "µg/m³", 9, 35], ["PM10", o.pm10, "µg/m³", 54, 154], ["Ozone", o.o3, "µg/m³", 100, 160], ["NO₂", o.no2, "µg/m³", 40, 100], ["SO₂", o.so2, "µg/m³", 40, 125], ["CO", o.co, "µg/m³", 4000, 10000], ["Dust", o.dust, "µg/m³", 50, 150], ["UV index", o.uvIndex, "", 3, 6]];
    var pollRows = poll.map(function (p) {
      var t = !isNum(p[1]) ? "na" : p[1] <= p[3] ? "good" : p[1] <= p[4] ? "fair" : "bad";
      return "<dt>" + esc(p[0]) + "</dt><dd>" + fmt(p[1], p[1] < 10 ? 1 : 0) + " " + esc(p[2]) + " " + pill(t === "good" ? "OK" : t === "fair" ? "Elevated" : t === "bad" ? "High" : "—", t) + "</dd>";
    }).join("");
    var cmp = [["Temperature", cl.tempF, cToF(o.tempC), "°F", 1], ["Humidity", cl.humidity, o.humidity, "%", 0], ["Moisture in the air", cl.absHumidity, o.absHumidity, "g/m³", 1], ["Dew point", cToF(cl.dewPointC), cToF(o.dewPointC), "°F", 0]];
    var cmpRows = cmp.map(function (c) { return "<tr><td>" + esc(c[0]) + '</td><td class="num">' + fmt(c[1], c[4]) + " " + c[3] + '</td><td class="num">' + fmt(c[2], c[4]) + " " + c[3] + "</td></tr>"; }).join("");
    var advice = home.ventilation && home.ventilation.text;
    var g = home.googleAir || {};
    var pollName = { pm25: "Fine dust", pm10: "Dust", o3: "Ozone", no2: "Nitrogen dioxide", so2: "Sulfur dioxide", co: "Carbon monoxide", nh3: "Ammonia" };
    var plain = function (code) { return pollName[code] || (code ? String(code).replace(/_/g, " ") : "—"); };
    var us = (g.indexes || []).filter(function (i) { return i.code === "usa_epa"; })[0];
    var uaqi = (g.indexes || []).filter(function (i) { return i.code === "uaqi"; })[0];
    var primary = us || uaqi || (g.indexes || [])[0];
    var gPoll = (g.pollutants || []).map(function (p) {
      return '<div class="poll"><div><b>' + esc(p.name) + "</b>" + (p.effects ? "<p>" + esc(p.effects) + "</p>" : "") + '</div><span class="num">' + fmt(p.value, p.value < 10 ? 1 : 0) + " " + esc(p.unit) + "</span></div>";
    }).join("");
    var hours = (g.hourly || []).map(function (h) {
      var when = h.t ? new Date(h.t).toLocaleTimeString([], { hour: "numeric" }) : "";
      return "<div><b>" + esc(when) + "</b><span class=\"hi\">" + fmt(h.aqi) + "</span><br><span class=\"small muted\">" + esc((h.category || "").replace(/ air quality/i, "")) + "</span></div>";
    }).join("");
    var health = g.health || {};
    var pol = home.pollen || {};
    var pollenItems = [].concat(pol.types || [], pol.plants || []);
    var pollenChips = pollenItems.map(function (p) {
      return '<span class="tone ' + levelTone(p.category) + '">' + esc(p.name) + (p.category ? " · " + esc(p.category) : "") + (isNum(p.value) ? " " + fmt(p.value) : "") + "</span>";
    }).join(" ");
    var mapCard = '<div class="card map-card"><div class="card-head"><h3>Around the house</h3><span class="sub">' + (g.heatmap ? "Streets plus Google air colors" : "Local map") + "</span></div>" +
      (home.location ? '<div id="local-map" class="local-map" role="region" aria-label="Map of the area around the sensor"></div>' : '<p class="muted">The map shows up once the sensor reports its location.</p>') +
      '<p class="note">The pin is your sensor. ' + (g.heatmap ? "Green on the map is cleaner outdoor air and red is dirtier, from Google. " : "") + "Street map © OpenStreetMap.</p></div>";
    var googleCard = g.ok ? '<div class="card"><h3 style="margin-bottom:8px">Outdoor air, from Google</h3>' +
      '<div class="grid g-3">' +
      (us ? '<div class="stat"><p class="kicker">US AQI</p><div class="value num">' + fmt(us.aqi) + "</div><div class=\"line\">" + esc(us.category || "") + "</div></div>" : "") +
      (uaqi ? '<div class="stat"><p class="kicker">Universal index</p><div class="value num">' + fmt(uaqi.aqi) + "</div><div class=\"line\">" + esc(uaqi.category || "") + "</div></div>" : "") +
      (!us && !uaqi && primary ? '<div class="stat"><p class="kicker">' + esc(primary.name || "Air index") + '</p><div class="value num">' + fmt(primary.aqi) + "</div><div class=\"line\">" + esc(primary.category || "") + "</div></div>" : "") +
      '<div class="stat"><p class="kicker">Main pollutant</p><div class="line" style="font-size:16px;color:var(--ink)">' + esc(plain(primary && primary.dominant)) + "</div></div></div>" +
      (health.olderAdults ? '<p class="callout" style="margin-top:12px"><b>For older adults. </b>' + esc(health.olderAdults) + "</p>" : "") +
      (health.everyone ? '<p class="note"><b>For everyone. </b>' + esc(health.everyone) + "</p>" : "") +
      (health.children || health.lungs || health.heart ? '<details class="more"><summary>Advice for children, lungs, and heart</summary><div class="more-body">' +
        [health.children && "<p><b>Children. </b>" + esc(health.children) + "</p>", health.lungs && "<p><b>Lungs. </b>" + esc(health.lungs) + "</p>", health.heart && "<p><b>Heart. </b>" + esc(health.heart) + "</p>", health.active && "<p><b>Exercise. </b>" + esc(health.active) + "</p>", health.pregnancy && "<p><b>Pregnancy. </b>" + esc(health.pregnancy) + "</p>"].filter(Boolean).join("") +
        "</div></details>" : "") +
      (gPoll ? '<div class="polls">' + gPoll + "</div>" : "") +
      (hours ? '<h3 style="margin:14px 0 8px">Later today</h3><div class="forecast hours">' + hours + "</div>" : "") +
      "</div>" : (g.reason ? '<div class="card"><h3>Google outdoor air</h3><p class="muted">' + esc(g.reason) + ". Open-Meteo numbers are still shown below.</p></div>" : "");
    var pollenCard = '<div class="card"><h3 style="margin-bottom:8px">Pollen</h3>' +
      (pol.ok ? '<div class="chips">' + pollenChips + "</div>" + ((pol.tips || []).map(function (t) { return '<p class="note">' + esc(t) + "</p>"; }).join("")) + '<p class="note">' + esc(pol.source || "") + (pol.date ? " · " + esc(pol.date) : "") + "</p>" : '<p class="muted">' + esc(pol.reason || "No pollen reading yet.") + "</p>") + "</div>";
    var solar = home.solar || {};
    var solarCard = solar.ok ? '<div class="card"><div class="card-head"><h3>Roof solar potential</h3><span class="sub">one-time context</span></div><div class="grid g-3"><div class="stat"><p class="kicker">Panels</p><div class="value num">' + fmt(solar.maxPanels) + '</div></div><div class="stat"><p class="kicker">Roof area</p><div class="value num">' + fmt(solar.maxAreaM2) + '<small>m²</small></div></div><div class="stat"><p class="kicker">Sun hours</p><div class="value num">' + fmt(solar.maxSunHoursYear) + '</div></div></div>' + (isNum(solar.estimatedYearlyKwh) ? '<p class="note">Google estimate: up to ' + fmt(solar.estimatedYearlyKwh) + ' kWh/year before local design, shade, tariffs, and rules. Not a quote.</p>' : '') + '</div>' : '<div class="card"><h3>Roof solar potential</h3><p class="muted">' + esc(solar.reason || "No solar insight yet.") + "</p></div>";
    return head("Outside" + (home.city ? " · " + home.city : ""), "A map of the neighborhood, plus outdoor air, pollen, and weather.") +
      mapCard +
      '<div class="grid g-2 top mt">' + googleCard + pollenCard + "</div>" +
      '<div class="mt">' + solarCard + "</div>" +
      '<div class="grid g-3 mt">' +
      '<div class="card stat"><p class="kicker">Now</p><div class="value num">' + fmt(cur && cur.tempF) + '<small>°F</small></div><div class="line">' + esc(cur ? cur.condition + " · feels " + fmt(cur.feelsLikeF) + "°F" : "—") + '</div><div class="line muted small">' + esc(cur ? "Wind " + (cur.windSpeed || "calm") + " " + (cur.windDir || "") + " · " + fmt(cur.pressHpa) + " hPa" : "") + "</div></div>" +
      '<div class="card stat"><p class="kicker">Outdoor AQI</p><div class="value num">' + fmt(o.usAqi) + '</div><div class="line">' + pill((wx && wx.outdoorLevel) || "—", levelTone(wx && wx.outdoorLevel)) + "</div></div>" +
      '<div class="card stat"><p class="kicker">Windows</p><div class="line" style="font-size:15px;color:var(--ink);margin-top:0">' + esc(advice || "No advice yet.") + "</div></div></div>" +
      (wx && wx.forecast && wx.forecast.length ? '<div class="card mt"><h3 style="margin-bottom:10px">Next three days</h3><div class="forecast">' + wx.forecast.map(function (d) { return "<div><b>" + esc(d.label) + '</b><span class="hi">' + fmt(d.highF) + '°</span> <span class="muted">' + fmt(d.lowF) + "°</span><br>" + esc(d.condition) + '<br><span class="small muted">Rain ' + fmt(d.precipChance) + "% · wind " + fmt(d.windMph) + " mph</span></div>"; }).join("") + "</div>" + (wx.briefing ? '<p class="note">' + esc(wx.briefing) + "</p>" : "") + "</div>" : "") +
      '<div class="grid g-2 mt"><div class="card"><h3 style="margin-bottom:10px">Outdoor pollutants</h3><dl class="kv">' + pollRows + "</dl></div>" +
      '<div class="card"><h3 style="margin-bottom:10px">Inside vs outside</h3><table style="width:100%;border-collapse:collapse;font-size:13.5px"><thead><tr class="muted small"><th style="text-align:left;font-weight:600;padding-bottom:6px">Reading</th><th style="text-align:left;font-weight:600">Inside</th><th style="text-align:left;font-weight:600">Outside</th></tr></thead><tbody>' + cmpRows + "</tbody></table>" +
      '<p class="note">When the outside air holds less moisture than inside, opening up dries the home out. When it holds more, keep the windows shut on humid days.</p></div></div>';
  }
  var localMap = null;
  function drawMap() {
    var home = cache.home && cache.home.data;
    var el = document.getElementById("local-map");
    if (!el || !home || !home.location) return;
    if (!window.L) { el.innerHTML = '<p class="muted" style="padding:16px">The map could not load. The air numbers below are still here.</p>'; return; }
    if (localMap) { try { localMap.remove(); } catch (e) { /* container already gone */ } localMap = null; }
    var lat = home.location.lat, lon = home.location.lon;
    var map = L.map(el, { scrollWheelZoom: false }).setView([lat, lon], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
    if (home.googleAir && home.googleAir.heatmap) {
      L.tileLayer("/api/air-tile?z={z}&x={x}&y={y}", {
        opacity: 0.62, minZoom: 6, maxZoom: 12, attribution: "Air colors: Google",
      }).addTo(map);
    }
    var g = home.googleAir || {};
    var us = (g.indexes || []).filter(function (i) { return i.code === "usa_epa"; })[0];
    var pol = home.pollen && home.pollen.ok ? topPollen(home.pollen) : "";
    var popup = "<b>Your sensor</b><br>" + (us ? "Outdoor AQI " + esc(String(us.aqi)) + " · " + esc(us.category || "") + "<br>" : "") + (pol ? "Pollen: " + esc(pol) : "");
    L.circleMarker([lat, lon], { radius: 11, color: "#ffffff", weight: 3, fillColor: "#2a6fdb", fillOpacity: 1 })
      .addTo(map).bindPopup(popup);
    localMap = map;
    setTimeout(function () { map.invalidateSize(); }, 60);
  }

  // ── Alerts ─────────────────────────────────────────────────────────
  var alertState = { step: "form", channel: "email", id: null, masked: "", address: "", push: null, error: "", ok: "" };
  async function pageAlerts() {
    var info = await load("alerts").catch(function () { return null; });
    if (!info) return head("Alerts") + '<div class="card"><p class="muted">Alerts are unavailable right now.</p></div>';
    var ch = info.channels || {};
    if (!ch[alertState.channel]) alertState.channel = ch.push ? "push" : ch.email ? "email" : "push";
    var none = !ch.email && !ch.push;
    var saved = store("sm-alert-rules") || {};
    var presetOn = ["pet", "mold", "pollen", "smell", "humidityHi"];
    var ruleList = Object.keys(info.rules).map(function (k) { return [k, info.rules[k]]; }).sort(function (a, b) {
      return (a[1].easy || 99) - (b[1].easy || 99);
    });
    var choice = function (k, r) {
      var on = saved[k] !== undefined ? saved[k] !== false : presetOn.indexOf(k) >= 0;
      return '<label class="choice' + (on ? "" : " off") + '"><span><b>' + esc(r.label) + "</b><span>" + esc(r.hint || "") + "</span></span>" +
        '<input type="checkbox" role="switch" data-rule="' + k + '"' + (on ? " checked" : "") + "></label>";
    };
    var easy = ruleList.filter(function (x) { return x[1].easy; }).map(function (x) { return choice(x[0], x[1]); }).join("");
    var more = ruleList.filter(function (x) { return !x[1].easy; }).map(function (x) { return choice(x[0], x[1]); }).join("");
    var numbers = ruleList.filter(function (x) { return x[1].dir !== "flag"; }).map(function (x) {
      var k = x[0], r = x[1];
      var val = isNum(saved[k]) ? saved[k] : r.def;
      return '<label class="rule"><span>' + esc(r.label) + "</span>" +
        '<span class="lim">' + (r.dir === "above" ? "above" : "below") + ' <input type="number" data-lim="' + k + '" value="' + val + '" min="' + r.min + '" max="' + r.max + '" step="' + (r.max <= 20 ? 0.5 : 1) + '">' + esc(r.unit.trim()) + "</span></label>";
    }).join("");
    var rules = '<div class="choices">' + easy + "</div>" +
      (more ? '<details class="more"><summary>More alerts</summary><div class="choices">' + more + "</div></details>" : "") +
      '<details class="more"><summary>Change the exact numbers</summary><p class="muted small">Leave these alone if you just want a message when something is higher than usual.</p><div class="rules">' + numbers + "</div></details>";
    var msg = (alertState.error ? '<div class="msg err" role="alert">' + esc(alertState.error) + "</div>" : "") + (alertState.ok ? '<div class="msg ok" role="status">' + esc(alertState.ok) + "</div>" : "");
    var notes = [];
    if (!ch.email) notes.push("Email isn't set up on this dashboard.");
    var channelBtn = function (id, label, title) {
      var enabled = !!ch[id];
      return '<button type="button" data-ch="' + id + '" aria-pressed="' + (alertState.channel === id) + '"' +
        (enabled ? "" : " disabled") + (title && !enabled ? ' title="' + esc(title) + '"' : "") + ">" + label + "</button>";
    };
    var body;
    if (alertState.step === "code") {
      var push = alertState.push;
      var lead = push
        ? '<p style="margin:0">We sent a 6-digit code as a phone notification. Open it, then type the code here.</p>' +
          '<a class="btn block" href="' + esc(push.web) + '" target="_blank" rel="noopener noreferrer">Open the notification</a>' +
          '<p class="muted small" style="margin:0"><a href="' + esc(push.app) + '">Add it in the ntfy app</a> so later alerts reach this phone after you close this page.</p>'
        : '<p style="margin:0">We sent a 6-digit code to <b>' + esc(alertState.masked) + "</b>. Enter it to turn alerts on.</p>";
      body = '<form class="form" id="codeform">' + lead + msg +
        '<div class="field"><label for="code">Code</label><input id="code" class="code-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required' + (alertState.error ? ' aria-invalid="true"' : "") + "></div>" +
        '<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" type="submit">Confirm</button><button class="btn ghost" type="button" id="restart">' + (push ? "Start over" : "Use a different address") + "</button></div></form>";
    } else if (alertState.step === "done") {
      var keep = alertState.push
        ? '<p class="muted" style="margin:0">Leave that notification subscribed. Every alert has a link to stop.</p><a class="btn" href="' + esc(alertState.push.web) + '" target="_blank" rel="noopener noreferrer">Open the notification</a>'
        : '<p class="muted" style="margin:0">Every alert includes a one-tap unsubscribe link.</p>';
      body = '<div class="form">' + msg + keep + '<div><button class="btn ghost" type="button" id="restart">Sign up another address</button></div></div>';
    } else {
      var addr = esc(alertState.address || "");
      var bad = alertState.error ? ' aria-invalid="true"' : "";
      var addressField = alertState.channel === "push"
        ? '<p class="muted" style="margin:0">A notification on this phone. You\'ll open it to read a code, and later alerts arrive the same way.</p>'
        : '<div class="field"><label for="addr">Email address</label>' +
          '<input id="addr" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="' + addr + '"' + bad + " required>" +
          "</div>";
      body = '<form class="form" id="subform">' + msg +
        '<div class="seg" role="group" aria-label="How should we reach you?">' +
        channelBtn("email", "Email", "Email isn't set up") +
        channelBtn("push", "App", "") + "</div>" +
        (notes.length ? '<p class="note" style="margin:0">' + esc(notes.join(" ")) + "</p>" : "") +
        addressField +
        '<fieldset class="field"><legend>Tell me when…</legend>' + rules + "</fieldset>" +
        '<p class="muted small" style="margin:0">You\'ll get one message when a reading crosses your limit, a reminder at most every 3 hours if it stays there, and nothing more until it clears.</p>' +
        '<div><button class="btn block" type="submit"' + (none ? " disabled" : "") + ">Send my code</button></div></form>";
    }
    return head("Alerts", "Pick what you want to hear about. An email or phone notification arrives when it happens, and each message has a link to stop.") +
      '<div class="grid g-side top"><div class="card">' + body + "</div>" +
      '<div class="card"><h3>How it works</h3><ol class="muted" style="padding-left:18px;margin:10px 0 0;display:grid;gap:8px"><li>Pick email or a phone notification, and the readings you care about.</li><li>Confirm with the code we send, so nobody can sign you up by mistake.</li><li>SniffMaster checks every couple of minutes and only messages you when something changes.</li></ol>' +
      '<p class="note">' + info.subscriberCount + " " + (info.subscriberCount === 1 ? "person is" : "people are") + " signed up." + (none ? " Alerts aren't configured on this dashboard yet." : "") + "</p></div></div>";
  }
  function bindAlerts() {
    view.querySelectorAll("[data-ch]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.disabled) return;
        var addr = $("#addr");
        if (addr) alertState.address = addr.value;
        alertState.channel = b.dataset.ch;
        alertState.error = "";
        rerender();
      });
    });
    view.querySelectorAll("[data-rule]").forEach(function (cb) {
      cb.addEventListener("change", function () { cb.closest(".choice") && cb.closest(".choice").classList.toggle("off", !cb.checked); });
    });
    var addrInput = $("#addr");
    if (addrInput && alertState.error) addrInput.focus();
    var restart = $("#restart");
    if (restart) restart.addEventListener("click", function () { alertState = { step: "form", channel: alertState.channel, address: "", push: null, error: "", ok: "" }; rerender(); });
    var sub = $("#subform");
    if (sub) sub.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var rules = {}, saved = {};
      view.querySelectorAll("[data-rule]").forEach(function (cb) {
        var k = cb.dataset.rule, lim = view.querySelector('[data-lim="' + k + '"]');
        saved[k] = cb.checked ? (lim ? Number(lim.value) : true) : false;
        if (cb.checked) rules[k] = lim ? Number(lim.value) : true;
      });
      store("sm-alert-rules", saved);
      var typed = $("#addr") ? $("#addr").value : alertState.address;
      if (!Object.keys(rules).length) { alertState.error = "Pick at least one thing to be alerted about."; alertState.ok = ""; alertState.address = typed || ""; return rerender(); }
      var btn = sub.querySelector('button[type="submit"]'); btn.disabled = true; btn.textContent = "Sending…";
      var r = await post({ action: "subscribe", channel: alertState.channel, address: alertState.channel === "push" ? "" : typed, rules: rules });
      if (r.error) {
        alertState.error = r.error; alertState.ok = ""; alertState.address = typed || "";
        // Re-ask which channels work: if text just failed for credit the server
        // now says so, and the page moves to the App option instead of letting
        // the next tap fail the same way.
        cache.alerts = null;
      }
      else { alertState = { step: "code", channel: alertState.channel, id: r.id, masked: r.masked, address: typed || "", push: r.push || null, error: "", ok: "" }; }
      rerender();
    });
    var cf = $("#codeform");
    if (cf) {
      $("#code").focus();
      cf.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        var btn = cf.querySelector('button[type="submit"]'); btn.disabled = true;
        var r = await post({ action: "verify", id: alertState.id, code: $("#code").value });
        if (r.error) { alertState.error = r.error; } else { alertState = { step: "done", channel: alertState.channel, push: alertState.push, ok: "You're signed up. Alerts will go to " + r.masked + "." }; cache.alerts = null; }
        rerender();
      });
    }
  }
  async function post(body) {
    try {
      var res = await fetch("/api/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      var j = await res.json().catch(function () { return {}; });
      return res.ok ? j : { error: j.error || "Something went wrong." };
    } catch (e) { return { error: "Couldn't reach the server. Check your connection." }; }
  }

  // ── Settings ───────────────────────────────────────────────────────
  // One place for the per-device preferences that used to live only on
  // their own pages. Everything reads/writes the same localStorage keys
  // (sm-range, sm-triggers, sm-alert-rules), so a change here shows up on
  // the Sensors, Pets, and Alerts pages too. Alert rules themselves are
  // managed on the Alerts page — the subscription lives server-side, so a
  // toggle here would be a lie; this page shows what is saved and links
  // over to change it.
  async function pageSettings() {
    var ver = null;
    try { ver = await getJSON("/api/version"); } catch (e) { ver = null; }
    var info = await load("alerts").catch(function () { return null; });
    var trig = store("sm-triggers") || [];
    var saved = store("sm-alert-rules") || {};
    var seg = '<div class="seg" role="group" aria-label="Time range">' + ["1h", "6h", "24h", "7d"].map(function (r) { return '<button type="button" data-range="' + r + '" aria-pressed="' + (r === sensorRange) + '">' + r + "</button>"; }).join("") + "</div>";
    var chips = '<div class="chips" id="trig">' + TRIGGERS.map(function (t) { return '<button type="button" class="chip" data-trig="' + t[0] + '" aria-pressed="' + (trig.indexOf(t[0]) >= 0) + '">' + t[1] + "</button>"; }).join("") + "</div>";
    var presetOn = ["pet", "mold", "pollen", "smell", "humidityHi"];
    var rulesHtml;
    if (!info || !info.rules) {
      rulesHtml = '<p class="muted" style="margin:0">Couldn\'t load the alert rules right now.</p>';
    } else {
      var ruleList = Object.keys(info.rules).map(function (k) { return [k, info.rules[k]]; }).sort(function (a, b) {
        return (a[1].easy || 99) - (b[1].easy || 99);
      });
      rulesHtml = '<dl class="kv">' + ruleList.map(function (x) {
        var k = x[0], r = x[1];
        var on = saved[k] !== undefined ? saved[k] !== false : presetOn.indexOf(k) >= 0;
        return "<dt>" + esc(r.label) + "</dt><dd>" + pill(on ? "On" : "Off", on ? "good" : "na") + "</dd>";
      }).join("") + "</dl>";
    }
    return head("Settings", "Preferences stored on this device — they stay here and apply everywhere on the dashboard.") +
      '<div class="grid g-2">' +
      '<div class="card"><h3 style="margin-bottom:8px">Sensor history</h3><p class="muted" style="margin:0 0 12px">Which window the Sensors charts show.</p>' + seg +
      '<p class="note">The 7-day view uses the compact 10-minute history, which keeps temperature, humidity, CO₂ and IAQ.</p></div>' +
      '<div class="card"><h3 style="margin-bottom:8px">Your allergy triggers</h3><p class="muted" style="margin:0 0 12px">Pick what you react to. It stays on this device.</p>' + chips + "</div></div>" +
      '<div class="grid g-2 top mt"><div class="card"><div class="card-head"><h3>Alerts</h3><span class="sub">what you signed up for</span></div>' + rulesHtml +
      '<p style="margin:12px 0 0"><a class="btn" href="#/alerts">Manage alerts</a></p></div>' +
      '<div class="card"><h3 style="margin-bottom:8px">About this dashboard</h3><dl class="kv">' +
      "<dt>Version</dt><dd>" + esc(ver ? ver.label : "Unavailable right now") + "</dd>" +
      (ver && ver.environment ? "<dt>Environment</dt><dd>" + esc(ver.environment) + "</dd>" : "") +
      "</dl></div></div>";
  }
  function bindSettings() {
    bindPets(); // allergy trigger chips share the Pets page behavior
  }

  // ── router ─────────────────────────────────────────────────────────
  var ROUTES = {
    home: { render: pageHome, poll: ["home", "insights", "weather"], title: "Overview" },
    sensors: { render: pageSensors, poll: ["sensors"], title: "Sensors", after: drawSensorCharts },
    smell: { render: pageSmell, poll: ["home", "sensors"], title: "Smell", after: drawHeat },
    pets: { render: pagePets, poll: ["home", "sensors"], title: "Pet meter", after: drawPetChart, bind: bindPets },
    outside: { render: pageOutside, poll: ["home", "weather"], title: "Outside", after: drawMap },
    alerts: { render: pageAlerts, poll: [], title: "Alerts", bind: bindAlerts },
    settings: { render: pageSettings, poll: [], title: "Settings", bind: bindSettings },
  };
  var currentRoute = null;
  function routeName() { var h = location.hash.replace(/^#\/?/, "").split("?")[0]; return ROUTES[h] ? h : "home"; }
  function bindPets() {
    view.querySelectorAll("[data-trig]").forEach(function (b) {
      b.addEventListener("click", function () {
        var list = store("sm-triggers") || [];
        var k = b.dataset.trig, i = list.indexOf(k);
        if (i >= 0) list.splice(i, 1); else list.push(k);
        store("sm-triggers", list);
        load("home", true).then(rerender);
      });
    });
  }
  function bindRange() {
    view.querySelectorAll("[data-range]").forEach(function (b) {
      b.addEventListener("click", function () {
        sensorRange = b.dataset.range; store("sm-range", sensorRange);
        cache.sensors = null; rerender();
      });
    });
  }
  var rendering = 0;
  async function render(name, force) {
    var r = ROUTES[name];
    var token = ++rendering;
    if (currentRoute !== name) { view.innerHTML = skeleton(); window.scrollTo(0, 0); }
    currentRoute = name;
    document.title = (name === "home" ? "" : r.title + " · ") + "SniffMaster";
    document.querySelectorAll(".tabs a").forEach(function (a) { a.toggleAttribute("aria-current", a.dataset.route === name); if (a.dataset.route === name) a.setAttribute("aria-current", "page"); });
    var gb = document.querySelector(".icon-btn");
    if (gb) gb.classList.toggle("active", name === "settings");
    if (force) r.poll.forEach(function (n) { if (cache[n]) cache[n].at = 0; });
    var html;
    try { html = await r.render(); } catch (err) { console.error(err); html = noData(err); }
    if (token !== rendering) return;
    view.innerHTML = html;
    if (r.after) r.after();
    if (r.bind) r.bind();
    bindRange();
    schedule(r.poll);
  }
  function rerender() { if (currentRoute) render(currentRoute); }
  window.addEventListener("hashchange", function () { render(routeName()); view.focus({ preventScroll: true }); });
  // The gauge module loads async; re-render once it arrives so the
  // Overview swaps the flat fallback ring for the gradient one (and the
  // plain-language note + driver line appear with it).
  window.addEventListener("sniff-gauge-ready", function () { if (currentRoute) rerender(); });
  var resizeT;
  window.addEventListener("resize", function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { var r = ROUTES[currentRoute]; if (r && r.after) r.after(); }, 150);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerender);
  setInterval(function () { if (!document.hidden && cache.home) setStatus(cache.home.data); }, 30000);
  render(routeName());

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
})();

/* SniffMaster dashboard — vanilla JS, no build step.
 *
 * Routes (hash): #/ overview · #/sensors · #/smell · #/pets · #/outside · #/alerts
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
    if (/^(low|none|fresh|good|excellent|safe)/.test(l)) return "good";
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
      }
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
    var html = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(opts.label || "chart") + '">';
    html += '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + series[0].color + '" stop-opacity=".22"/><stop offset="1" stop-color="' + series[0].color + '" stop-opacity="0"/></linearGradient></defs>';
    for (var i = 0; i <= 3; i++) {
      var gv = r[0] + ((r[1] - r[0]) * i) / 3;
      var gy = y(gv);
      html += '<line class="grid-line" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy + '" y2="' + gy + '"/>';
      html += '<text class="axis-text" x="' + (padL - 6) + '" y="' + (gy + 3.5) + '" text-anchor="end">' + esc(opts.tick ? opts.tick(gv) : fmt(gv, Math.abs(r[1] - r[0]) < 6 ? 1 : 0)) + "</text>";
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
    return '<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round"/></svg>';
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
    var compHtml = comps.filter(function (c) { return isNum(c.score); }).map(function (c) {
      return '<div class="comp"><span>' + esc(c.label) + '</span><span class="num">' + fmt(c.score) + '</span><span class="bar"><i style="width:' + c.score + "%;background:" + css("--" + toneFor(c.score)) + '"></i></span></div>';
    }).join("");

    var brief = ins
      ? '<p class="kicker"><span class="ai-tag">' + (ins.source === "claude" ? "Insight from Claude" : "Today's read") + "</span></p><h2>" + esc(ins.headline) + '</h2><p class="summary">' + esc(ins.summary) + '</p><div class="tips">' +
        (ins.tips || []).map(function (t) { return '<div class="tip ' + esc(t.tone) + '"><b>' + esc(t.title) + "</b><p>" + esc(t.text) + "</p></div>"; }).join("") + "</div>"
      : '<p class="kicker">Today\'s read</p><h2>' + esc((home.visitor && home.visitor.headline) || "Air data is in.") + "</h2>";

    var smell = home.smell || {};
    var cl = home.climate || {};
    var g = home.gases || {};
    var pet = home.petAllergen || {};
    var out = home.outdoor || {};
    var cur = wx && wx.current;
    var vent = home.ventilation || {};

    var tiles = [
      '<a class="card stat" href="#/smell"><p class="kicker">Smell</p><div class="value" style="font-size:22px;font-family:var(--sans);font-weight:700">' + esc(smell.level || "—") + '</div><div class="line">' + esc(smell.headline || "") + "</div>" + (smell.sinceMinutes ? '<div class="line muted small">For ' + smell.sinceMinutes + " min · " + esc(smell.trend || "") + "</div>" : "") + "</a>",
      '<a class="card stat" href="#/sensors"><p class="kicker">Comfort</p><div class="value num">' + fmt(cl.tempF, 1) + "<small>°F</small> " + fmt(cl.humidity) + '<small>% RH</small></div><div class="line">' + esc(cl.comfort || "") + " · dew point " + fmt(cToF(cl.dewPointC)) + "°F</div>" + spark(s.tempC, css("--series-2")) + "</a>",
      '<a class="card stat" href="#/sensors"><p class="kicker">Fresh air</p><div class="value num">' + fmt(g.co2) + '<small>ppm CO₂</small></div><div class="line">' + esc(vent.text || g.co2Category || "") + "</div>" + spark(s.co2, css("--series-1")) + "</a>",
      '<a class="card stat" href="#/pets"><p class="kicker">Pet meter</p><div class="value num">' + fmt(pet.index) + '<small>/ 100</small></div><div class="line">' + pill(pet.level || "Unknown", levelTone(pet.level)) + ' <span class="muted small">' + esc(pet.confidence ? pet.confidence + " confidence" : "") + "</span></div></a>",
    ];

    var outside = '<a class="card" href="#/outside"><div class="card-head"><h3>Outside' + (home.city ? " in " + esc(home.city) : "") + "</h3>" + pill("AQI " + fmt(out.usAqi), levelTone(wx && wx.outdoorLevel || (out.usAqi <= 50 ? "good" : out.usAqi <= 100 ? "moderate" : "high"))) + "</div>" +
      (cur ? '<p style="margin:0 0 12px" class="muted">' + esc(cur.condition) + ", " + fmt(cur.tempF) + "°F (feels " + fmt(cur.feelsLikeF) + "°F) · wind " + esc(cur.windSpeed || "calm") + " " + esc(cur.windDir || "") + "</p>" : "") +
      (wx && wx.forecast && wx.forecast.length ? '<div class="forecast">' + wx.forecast.map(function (d) { return "<div><b>" + esc(d.label.split(",")[0]) + '</b><span class="hi">' + fmt(d.highF) + "°</span> <span class=\"muted\">" + fmt(d.lowF) + "°</span><br><span class=\"small\">" + esc(d.condition) + (d.precipChance ? " · " + fmt(d.precipChance) + "%" : "") + "</span></div>"; }).join("") + "</div>" : "") +
      "</a>";

    var bio = home.biological || {};
    var risks = '<div class="card"><div class="card-head"><h3>Allergen & moisture risk</h3><span class="sub">estimates</span></div><dl class="kv">' +
      "<dt>Pet dander</dt><dd>" + pill(pet.level || "—", levelTone(pet.level)) + "</dd>" +
      "<dt>Mold</dt><dd>" + pill((bio.mold && bio.mold.category) || "—", levelTone(bio.mold && bio.mold.category)) + "</dd>" +
      "<dt>Dust mites</dt><dd>" + pill((bio.dustMite && bio.dustMite.category) || "—", levelTone(bio.dustMite && bio.dustMite.category)) + "</dd>" +
      "<dt>Dry air</dt><dd>" + pill((bio.dryAir && bio.dryAir.category) || "—", levelTone(bio.dryAir && bio.dryAir.category)) + "</dd>" +
      "<dt>Outdoor pollen</dt><dd>" + (home.pollen && home.pollen.ok ? pill(topPollen(home.pollen), levelTone(topPollen(home.pollen).split(" ").pop())) : '<span class="muted small">not available here</span>') + "</dd></dl></div>";

    return '<div class="grid g-hero">' +
      '<div class="card score-card"><p class="kicker">Home air score</p>' + scoreRing(home.score && home.score.value, home.score && home.score.grade) +
      '<div class="where">Updated ' + esc(ago(home.receivedAt)) + "</div>" + (compHtml ? '<div class="components">' + compHtml + "</div>" : "") + "</div>" +
      '<div class="card brief">' + brief + "</div></div>" +
      '<div class="grid g-4" style="margin-top:16px">' + tiles.join("") + "</div>" +
      '<div class="grid g-2" style="margin-top:16px">' + outside + risks + "</div>";
  }
  function topPollen(p) {
    var items = [].concat(p.types || [], p.plants || []).filter(function (x) { return isNum(x.value); }).sort(function (a, b) { return b.value - a.value; });
    return items.length ? items[0].name + " " + (items[0].category || "") : "Low";
  }

  // ── Sensors ────────────────────────────────────────────────────────
  var CHANNELS = [
    { key: "iaq", title: "Indoor air quality (IAQ)", unit: "", d: 0, color: "--series-1", extra: { key: "staticIaq", name: "Static IAQ" }, note: "0–50 excellent, 51–100 good, 101–150 lightly polluted, 151–200 moderately polluted, 200+ heavily polluted." },
    { key: "co2", title: "CO₂ equivalent", unit: " ppm", d: 0, color: "--series-1", note: "Estimated from VOCs by BSEC. Under 800 ppm feels fresh; above 1,200 ppm most people notice stuffiness." },
    { key: "voc", title: "Breath VOC equivalent", unit: " ppm", d: 2, color: "--series-1", note: "Volatile organic compounds from people, cooking, cleaners and furniture." },
    { key: "gasR", title: "Gas resistance", unit: " kΩ", d: 0, color: "--series-3", scale: 0.001, note: "The raw MOX reading. Lower resistance means more reducing gases (VOCs, smoke, sulfur) in the air." },
    { key: "tempF", title: "Temperature", unit: " °F", d: 1, color: "--series-2", note: "Heat-compensated by BSEC so the sensor's own warmth is removed." },
    { key: "humidity", title: "Relative humidity", unit: " %", d: 1, color: "--series-3", note: "40–60% is the comfortable band. Above 60% for long stretches favors mold and dust mites." },
    { key: "pressHpa", title: "Barometric pressure", unit: " hPa", d: 1, color: "--series-1", note: "Falling pressure often means weather is on the way." },
    { key: "gasPct", title: "Gas percentage", unit: " %", d: 0, color: "--series-3", note: "Where the current gas reading sits within this sensor's own learned history (BSEC)." },
  ];
  async function pageSensors() {
    var d = await load("sensors");
    if (!d) return noData();
    var L = d.latest || {};
    var S = d.series || {};
    var seg = '<div class="seg" role="group" aria-label="Time range">' + ["1h", "6h", "24h", "7d"].map(function (r) { return '<button type="button" data-range="' + r + '" aria-pressed="' + (r === sensorRange) + '">' + r + "</button>"; }).join("") + "</div>";
    var cards = CHANNELS.map(function (c) {
      var vals = (S[c.key] || []).map(function (v) { return isNum(v) && c.scale ? v * c.scale : v; });
      var st = stats(vals);
      var nowV = isNum(L[c.key]) ? L[c.key] * (c.scale || 1) : null;
      if (!st && !isNum(nowV)) return "";
      return '<div class="card"><div class="metric-head"><div><h3>' + esc(c.title) + '</h3><p class="muted small" style="margin:4px 0 0;max-width:46ch">' + esc(c.note) + '</p></div><div class="now"><span class="num">' + fmt(nowV, c.d) + "</span><br><small>" + esc(c.unit.trim() || "index") + " now</small></div></div>" +
        (c.extra && S[c.extra.key] ? '<div class="legend"><span><i style="background:' + css(c.color) + '"></i>' + esc(c.title.split(" (")[0]) + '</span><span><i style="background:' + css("--series-2") + '"></i>' + esc(c.extra.name) + "</span></div>" : "") +
        '<div class="chart" data-ch="' + c.key + '"></div>' +
        (st ? '<div class="mma"><span>Low <b>' + fmt(st.min, c.d) + "</b></span><span>Avg <b>" + fmt(st.avg, c.d) + "</b></span><span>High <b>" + fmt(st.max, c.d) + "</b></span></div>" : "") + "</div>";
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
      "<dt>Wi-Fi signal</dt><dd>" + fmt(L.wifiRssi) + " dBm</dd>" +
      "<dt>Uptime</dt><dd>" + (isNum(L.uptime) ? fmt(L.uptime / 3600, 1) + " h" : "—") + "</dd>" +
      "<dt>Last reading</dt><dd>" + esc(L.receivedAt ? clock(L.receivedAt) + " (" + ago(L.receivedAt) + ")" : "—") + "</dd></dl>" +
      (Number(L.iaqAcc) < 2 ? '<p class="note">The BME688 calibrates itself against the air it sees. Accuracy climbs to "High" after a few hours of normal use, including some time with fresh air.</p>' : "") + "</div>";

    var addon = ["pm25", "pm10"].some(function (k) { return isNum(L[k]); }) ? "" :
      '<div class="card"><h3>Want particulate readings?</h3><p class="muted" style="margin:6px 0 0">The BME688 senses gases, not dust. Adding a Sensirion SEN5x (PM1–PM10) makes the pet dander meter far more precise, and the firmware already has a hook for it in <code>home_sensors.h</code>.</p></div>';

    window.__sensorData = d;
    return head("Sensors", "Every channel from the BME688 and BSEC2, at full precision.", seg) +
      (sensorRange === "7d" ? '<div class="callout" style="margin-bottom:16px">The 7-day view uses the compact 10-minute history, which keeps temperature, humidity, CO₂ and IAQ.</div>' : "") +
      '<div class="grid g-2">' + cards + "</div>" + '<div class="grid g-2" style="margin-top:16px">' + cal + addon + "</div>";
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
      lineChart(el, { t: d.series.t, series: series, unit: c.unit, label: c.title, fmt: function (v) { return fmt(v, c.d); } });
    });
  }

  // ── Smell ──────────────────────────────────────────────────────────
  var ODORS = ["Flatulence", "Musty", "Cigarette smoke", "Alcohol", "Cannabis", "Cleaning products", "Gasoline", "Smoke", "Cooking", "Coffee", "Garbage", "Body odor", "Perfume", "Laundry", "Sulfur", "Solvent", "Pet / litter", "Sour food", "Burnt / oil", "Citrus"];
  async function pageSmell() {
    var home = await load("home");
    if (!home) return noData();
    var sens = await load("sensors").catch(function () { return null; });
    var sniffs = await load("sniffs").catch(function () { return []; });
    var sm = home.smell || {};
    var latest = (sens && sens.latest) || {};
    var odors = Array.isArray(latest.odors) ? latest.odors : [];
    var ranked = odors.map(function (v, i) { return { i: i, v: Number(v) || 0 }; }).sort(function (a, b) { return b.v - a.v; });
    var bars = ranked.map(function (o) {
      return '<div class="hbar' + (o.v < 20 ? " dim" : "") + '"><span>' + esc(ODORS[o.i]) + '</span><span class="track"><i style="width:' + Math.min(100, o.v) + "%;background:" + (o.v >= 65 ? css("--series-2") : css("--series-1")) + '"></i></span><span class="v">' + fmt(o.v) + "</span></div>";
    }).join("");
    var tone = sm.smellsBad ? (sm.safety ? "bad" : "poor") : sm.tone === "fair" ? "fair" : "good";
    var main = '<div class="card"><p class="kicker">Right now</p><h2 style="font-size:22px;margin:0 0 6px">' + esc(sm.headline || "No reading yet") + "</h2>" +
      '<div class="chips" style="margin:6px 0 10px">' + pill(sm.level || "—", tone) + (sm.confidence ? pill(sm.confidence + " confidence", "na") : "") + (sm.trend ? pill(sm.trend, sm.trend === "worsening" ? "poor" : "na") : "") + "</div>" +
      (sm.action ? '<div class="callout ' + (sm.safety ? "bad" : "fair") + '">' + esc(sm.action) + "</div>" : "") +
      '<p class="note">' + esc(sm.detail || "") + "</p></div>";
    var how = '<div class="card"><h3>How smell detection works</h3><p class="muted" style="margin:6px 0 0">The BME688 heats a metal-oxide plate and measures its resistance; smelly gases lower it. SniffMaster learns this room\'s own clean-air level, corrects for humidity, and only calls a smell when the drop holds for several minutes. A small neural network on the device then guesses the source from the 20 classes on the right.</p></div>';
    var events = (sniffs || []).length
      ? '<ul class="events">' + sniffs.map(function (e) { return "<li><span>" + esc(e.label || e.primary || "Sulfur event") + '</span><span class="muted num">' + esc(e.receivedAt ? clock(e.receivedAt, true) : "") + "</span></li>"; }).join("") + "</ul>"
      : '<p class="muted" style="margin:0">No strong sulfur events recorded recently.</p>';
    return head("Smell", "What the gas sensor and on-device smell model notice, and how sure they are.") +
      '<div class="grid g-2">' + '<div class="stack" style="margin:0">' + main + how + "</div>" +
      '<div class="card"><div class="card-head"><h3>Smell model scores</h3><span class="sub">0–100 per class · live</span></div>' + (bars || '<p class="muted">No classifier output yet.</p>') + '<p class="note">Scores under 20 are background noise. The model holds back until the sensor is calibrated.</p></div></div>' +
      '<div class="card" style="margin-top:16px"><div class="card-head"><h3>Smell timeline</h3><span class="sub">strongest class per interval, last ' + esc(sensorRange === "7d" ? "24h" : sensorRange) + '</span></div><div id="heat"></div></div>' +
      '<div class="card" style="margin-top:16px"><h3 style="margin-bottom:10px">Recent sulfur events</h3>' + events + "</div>";
  }
  function drawHeat() {
    var el = $("#heat");
    var d = window.__sensorData;
    if (!el || !d || !Array.isArray(d.odors) || !d.odors.length) { if (el) el.innerHTML = '<div class="chart-empty" style="height:80px">Not enough history yet</div>'; return; }
    var rows = ODORS.map(function (_, i) { return d.odors.some(function (col) { return col && col[i] >= 20; }) ? i : -1; }).filter(function (i) { return i >= 0; });
    if (!rows.length) { el.innerHTML = '<div class="chart-empty" style="height:80px">Quiet the whole window. Nothing above background.</div>'; return; }
    var cols = d.odors.length, W = el.clientWidth || 800, labelW = 120, rowH = 18, H = rows.length * rowH + 20, cw = (W - labelW) / cols;
    var base = css("--series-1");
    var svg = '<svg class="heat" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Smell class strength over time">';
    rows.forEach(function (oi, r) {
      svg += '<text class="axis-text" x="0" y="' + (r * rowH + 13) + '" fill="currentColor" style="fill:var(--ink-2);font-size:11px">' + esc(ODORS[oi]) + "</text>";
      d.odors.forEach(function (col, c) {
        var v = col ? col[oi] : 0;
        if (!v || v < 8) return;
        svg += '<rect x="' + (labelW + c * cw).toFixed(1) + '" y="' + (r * rowH + 2) + '" width="' + Math.max(1, cw - 0.5).toFixed(1) + '" height="' + (rowH - 4) + '" rx="2" fill="' + base + '" fill-opacity="' + Math.min(1, 0.12 + v / 100).toFixed(2) + '"><title>' + esc(ODORS[oi]) + " " + v + " · " + clock(d.series.t[c]) + "</title></rect>";
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
      bands.map(function (b) { return '<path d="' + arc(b[1] + 0.8, b[2] - 0.8) + '" stroke="' + css(b[0]) + '" stroke-width="18" fill="none" stroke-linecap="butt" opacity="' + (idx !== null && idx >= b[1] && idx < b[2] + (b[2] === 100 ? 1 : 0) ? 1 : 0.28) + '"/>'; }).join("") +
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
      '<div class="grid g-2"><div class="card"><div class="card-head"><h3>Pet dander index</h3><span class="sub">0–100 estimate</span></div>' + meter + '<p class="note">' + esc(pet.note || "") + "</p></div>" +
      '<div class="card"><h3 style="margin-bottom:12px">What goes into it</h3><div class="hbars">' + (basis || '<p class="muted">No pet-related signals yet.</p>') + "</div>" +
      '<p class="note">With a particulate sensor fitted, coarse dust in the 2.5–10 µm range (where dander lives) joins the index and confidence goes up to medium.</p></div></div>' +
      '<div class="card" style="margin-top:16px"><div class="card-head"><h3>Pet / litter smell over time</h3><span class="sub">smell-model class score</span></div><div class="chart" id="petchart"></div></div>' +
      '<div class="card" style="margin-top:16px"><h3>Your personal outlook</h3><p class="muted" style="margin:4px 0 12px">Pick what you react to. It stays on this device.</p>' + chips +
      '<p style="margin:14px 0 10px;font-weight:600">' + esc(ol.headline || "") + "</p>" + (outlook ? '<div class="tips">' + outlook + "</div>" : "") + "</div>" +
      '<div class="grid g-3" style="margin-top:16px">' +
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
    return head("Outside" + (home.city ? " · " + home.city : ""), "Local weather and outdoor air from Open-Meteo, compared with what's inside.") +
      '<div class="grid g-3">' +
      '<div class="card stat"><p class="kicker">Now</p><div class="value num">' + fmt(cur && cur.tempF) + '<small>°F</small></div><div class="line">' + esc(cur ? cur.condition + " · feels " + fmt(cur.feelsLikeF) + "°F" : "—") + '</div><div class="line muted small">' + esc(cur ? "Wind " + (cur.windSpeed || "calm") + " " + (cur.windDir || "") + " · " + fmt(cur.pressHpa) + " hPa" : "") + "</div></div>" +
      '<div class="card stat"><p class="kicker">Outdoor AQI</p><div class="value num">' + fmt(o.usAqi) + '</div><div class="line">' + pill((wx && wx.outdoorLevel) || "—", levelTone(wx && wx.outdoorLevel)) + "</div></div>" +
      '<div class="card stat"><p class="kicker">Windows</p><div class="line" style="font-size:15px;color:var(--ink);margin-top:0">' + esc(advice || "No advice yet.") + "</div></div></div>" +
      (wx && wx.forecast && wx.forecast.length ? '<div class="card" style="margin-top:16px"><h3 style="margin-bottom:10px">Next three days</h3><div class="forecast">' + wx.forecast.map(function (d) { return "<div><b>" + esc(d.label) + '</b><span class="hi">' + fmt(d.highF) + '°</span> <span class="muted">' + fmt(d.lowF) + "°</span><br>" + esc(d.condition) + '<br><span class="small muted">Rain ' + fmt(d.precipChance) + "% · wind " + fmt(d.windMph) + " mph</span></div>"; }).join("") + "</div>" + (wx.briefing ? '<p class="note">' + esc(wx.briefing) + "</p>" : "") + "</div>" : "") +
      '<div class="grid g-2" style="margin-top:16px"><div class="card"><h3 style="margin-bottom:10px">Outdoor pollutants</h3><dl class="kv">' + pollRows + "</dl></div>" +
      '<div class="card"><h3 style="margin-bottom:10px">Inside vs outside</h3><table style="width:100%;border-collapse:collapse;font-size:13.5px"><thead><tr class="muted small"><th style="text-align:left;font-weight:600;padding-bottom:6px">&nbsp;</th><th style="text-align:left;font-weight:600">Inside</th><th style="text-align:left;font-weight:600">Outside</th></tr></thead><tbody>' + cmpRows + "</tbody></table>" +
      '<p class="note">When the outside air holds less moisture than inside, opening up dries the home out. When it holds more, keep the windows shut on humid days.</p></div></div>';
  }

  // ── Alerts ─────────────────────────────────────────────────────────
  var alertState = { step: "form", channel: "email", id: null, masked: "", error: "", ok: "" };
  async function pageAlerts() {
    var info = await load("alerts").catch(function () { return null; });
    if (!info) return head("Alerts") + '<div class="card"><p class="muted">Alerts are unavailable right now.</p></div>';
    var ch = info.channels || {};
    if (!ch[alertState.channel]) alertState.channel = ch.email ? "email" : "sms";
    var none = !ch.email && !ch.sms;
    var saved = store("sm-alert-rules") || {};
    var rules = Object.keys(info.rules).map(function (k) {
      var r = info.rules[k];
      var on = saved[k] !== undefined ? saved[k] !== false : ["iaq", "co2", "humidityHi", "smell", "pet"].indexOf(k) >= 0;
      var val = isNum(saved[k]) ? saved[k] : r.def;
      return '<label class="rule' + (on ? "" : " off") + '"><input type="checkbox" data-rule="' + k + '"' + (on ? " checked" : "") + "><span>" + esc(r.label) + "</span>" +
        (r.dir === "flag" ? '<span class="lim">when detected</span>' : '<span class="lim">' + (r.dir === "above" ? "above" : "below") + ' <input type="number" data-lim="' + k + '" value="' + val + '" min="' + r.min + '" max="' + r.max + '" step="' + (r.max <= 20 ? 0.5 : 1) + '"' + (on ? "" : " disabled") + ">" + esc(r.unit.trim()) + "</span>") + "</label>";
    }).join("");
    var msg = (alertState.error ? '<div class="msg err">' + esc(alertState.error) + "</div>" : "") + (alertState.ok ? '<div class="msg ok">' + esc(alertState.ok) + "</div>" : "");
    var body;
    if (alertState.step === "code") {
      body = '<form class="form" id="codeform"><p style="margin:0">We sent a 6-digit code to <b>' + esc(alertState.masked) + '</b>. Enter it to turn alerts on.</p>' + msg +
        '<div class="field"><label for="code">Code</label><input id="code" class="code-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" type="submit">Confirm</button><button class="btn ghost" type="button" id="restart">Use a different address</button></div></form>';
    } else if (alertState.step === "done") {
      body = '<div class="form">' + msg + '<p class="muted" style="margin:0">Every alert includes a one-tap unsubscribe link.</p><div><button class="btn ghost" type="button" id="restart">Sign up another address</button></div></div>';
    } else {
      body = '<form class="form" id="subform">' + msg +
        '<div class="seg" role="group" aria-label="Alert channel">' +
        '<button type="button" data-ch="email" aria-pressed="' + (alertState.channel === "email") + '"' + (ch.email ? "" : " disabled") + ">Email" + (ch.email ? "" : " (not set up)") + "</button>" +
        '<button type="button" data-ch="sms" aria-pressed="' + (alertState.channel === "sms") + '"' + (ch.sms ? "" : " disabled") + ">Text message" + (ch.sms ? "" : " (not set up)") + "</button></div>" +
        '<div class="field"><label for="addr">' + (alertState.channel === "sms" ? "Mobile number" : "Email address") + "</label>" +
        (alertState.channel === "sms" ? '<input id="addr" type="tel" autocomplete="tel" placeholder="(555) 123-4567" required>' : '<input id="addr" type="email" autocomplete="email" placeholder="you@example.com" required>') + "</div>" +
        '<div class="field"><label>Tell me when…</label><div class="rules">' + rules + "</div></div>" +
        '<p class="muted small" style="margin:0">You\'ll get one message when a reading crosses your limit, a reminder at most every 3 hours if it stays there, and nothing more until it clears.' + (alertState.channel === "sms" ? " Message and data rates may apply." : "") + "</p>" +
        '<div><button class="btn" type="submit"' + (none ? " disabled" : "") + ">Send my code</button></div></form>";
    }
    return head("Alerts", "Get a heads-up by email or text when the air in here crosses a level you choose. Anyone with this link can sign up.") +
      '<div class="grid g-side"><div class="card">' + body + "</div>" +
      '<div class="card"><h3>How it works</h3><ol class="muted" style="padding-left:18px;margin:10px 0 0;display:grid;gap:8px"><li>Pick email or text and the readings you care about.</li><li>Confirm with the code we send, so nobody can sign you up by mistake.</li><li>SniffMaster checks every couple of minutes and only messages you when something changes.</li></ol>' +
      '<p class="note">' + info.subscriberCount + " " + (info.subscriberCount === 1 ? "person is" : "people are") + " signed up." + (none ? " Email and text delivery aren't configured on this dashboard yet." : "") + "</p></div></div>";
  }
  function bindAlerts() {
    view.querySelectorAll("[data-ch]").forEach(function (b) {
      b.addEventListener("click", function () { alertState.channel = b.dataset.ch; alertState.error = ""; rerender(); });
    });
    view.querySelectorAll("[data-rule]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var lim = view.querySelector('[data-lim="' + cb.dataset.rule + '"]');
        if (lim) lim.disabled = !cb.checked;
        cb.closest(".rule").classList.toggle("off", !cb.checked);
      });
    });
    var restart = $("#restart");
    if (restart) restart.addEventListener("click", function () { alertState = { step: "form", channel: alertState.channel, error: "", ok: "" }; rerender(); });
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
      if (!Object.keys(rules).length) { alertState.error = "Pick at least one thing to be alerted about."; return rerender(); }
      var btn = sub.querySelector(".btn"); btn.disabled = true; btn.textContent = "Sending…";
      var r = await post({ action: "subscribe", channel: alertState.channel, address: $("#addr").value, rules: rules });
      if (r.error) { alertState.error = r.error; } else { alertState = { step: "code", channel: alertState.channel, id: r.id, masked: r.masked, error: "", ok: "" }; }
      rerender();
    });
    var cf = $("#codeform");
    if (cf) {
      $("#code").focus();
      cf.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        var btn = cf.querySelector(".btn"); btn.disabled = true;
        var r = await post({ action: "verify", id: alertState.id, code: $("#code").value });
        if (r.error) { alertState.error = r.error; } else { alertState = { step: "done", channel: alertState.channel, ok: "You're signed up. Alerts will go to " + r.masked + "." }; cache.alerts = null; }
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

  // ── router ─────────────────────────────────────────────────────────
  var ROUTES = {
    home: { render: pageHome, poll: ["home", "insights", "weather"], title: "Overview" },
    sensors: { render: pageSensors, poll: ["sensors"], title: "Sensors", after: drawSensorCharts },
    smell: { render: pageSmell, poll: ["home", "sensors"], title: "Smell", after: drawHeat },
    pets: { render: pagePets, poll: ["home", "sensors"], title: "Pet meter", after: drawPetChart, bind: bindPets },
    outside: { render: pageOutside, poll: ["home", "weather"], title: "Outside" },
    alerts: { render: pageAlerts, poll: [], title: "Alerts", bind: bindAlerts },
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

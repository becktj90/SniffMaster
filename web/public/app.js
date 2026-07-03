/**
 * SniffMaster Pro PWA dashboard
 *
 * Mirrors the richer Blynk-style reports while staying readable on phones.
 * Polls /api/latest every 10 seconds, refreshes history periodically,
 * and listens for priority sulfur/VSC events over SSE.
 */
// ── PWA Service Worker Registration + Automatic Update Prompt ──
// (Paste this at the absolute top of app.js)
if ("serviceWorker" in navigator) {
 navigator.serviceWorker.register("/sw.js")
   .then((reg) => {
     console.log("%cService Worker registered (v41)", "color:#0f0; font-family:monospace");
     // Listen for a new service worker becoming available
     reg.addEventListener("updatefound", () => {
       const newWorker = reg.installing;
       if (!newWorker) return;
       newWorker.addEventListener("statechange", () => {
         if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
           // New version is ready
           const reload = window.confirm(
             "🎉 SniffMaster just got a fresh update!\n\n" +
             "Reload now to see the new dashboard layout and fixes?"
           );
           if (reload) {
             newWorker.postMessage({ type: "SKIP_WAITING" });
             // Force reload after the new SW takes over
             navigator.serviceWorker.addEventListener("controllerchange", () => {
               window.location.reload();
             });
           }
         }
       });
     });
   })
   .catch((err) => console.error("SW registration failed:", err));
}
const ODOR_NAMES = [
  "Fart", "Musty", "Cigarette", "Alcohol", "Weed", "Cleaning",
  "Gasoline", "Smoke", "Cooking", "Coffee", "Garbage", "Sweat/BO",
  "Perfume", "Laundry", "Sulfur", "Solvent", "Pet/Litter", "Sour Food",
  "Burnt/Oil", "Citrus"
];

const SPACE_COAST_DAYBOOK = {
  "01-31": [
    { year: 1961, title: "Mercury-Redstone 2", detail: "Ham the chimp rode a suborbital test from Cape Canaveral, clearing a path for America's first crewed Mercury flight." },
  ],
  "02-20": [
    { year: 1962, title: "Friendship 7", detail: "John Glenn launched from Cape Canaveral and became the first American to orbit Earth." },
  ],
  "04-05": [
    { year: 1973, title: "Pioneer 11", detail: "Pioneer 11 departed Cape Canaveral on the mission that would later visit Jupiter and become the first spacecraft to reach Saturn." },
    { year: 1991, title: "STS-37 Atlantis", detail: "Atlantis lifted off from KSC carrying the Compton Gamma Ray Observatory, opening a major new era in space astrophysics." },
    { year: 2010, title: "STS-131 Discovery", detail: "Discovery launched from KSC on a station resupply mission packed with racks, cargo, and the Leonardo MPLM." },
  ],
  "05-05": [
    { year: 1961, title: "Freedom 7", detail: "Alan Shepard launched from Cape Canaveral and became the first American in space." },
  ],
  "07-16": [
    { year: 1969, title: "Apollo 11", detail: "Saturn V thundered off Pad 39A at KSC on the first crewed lunar landing mission." },
  ],
  "08-12": [
    { year: 1960, title: "Echo 1A", detail: "Cape Canaveral launched the giant metallized balloon that became one of the earliest communications-satellite experiments." },
  ],
  "09-05": [
    { year: 1977, title: "Voyager 1", detail: "Voyager 1 left Cape Canaveral and began the grand tour that would rewrite the map of the outer solar system." },
  ],
  "11-12": [
    { year: 1981, title: "STS-2 Columbia", detail: "NASA launched the first reusable crewed spacecraft flight with the same orbiter, Columbia, from KSC." },
  ],
  "12-18": [
    { year: 1999, title: "STS-103 Discovery", detail: "Discovery launched from KSC on the Hubble Space Telescope servicing mission that restored the observatory's science momentum." },
  ],
};

const HEATMAP_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const HEATMAP_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const POLL_MS = 10000;
const STALE_MS = 300000; // 5 minutes
const SNIFF_EVENT_STALE_MS = 180000;
const WEATHER_BRIEFING_TTL_MS = 60 * 60 * 1000; // 1-hour cadence for AI weather prediction
const MAP_PREF_KEY = "sniffmaster-map-layers";
const VIEW_PREF_KEY = "sniffmaster-view";
const THEME_PREF_KEY = "sniffmaster-theme";
const OWNER_KEY_SESSION_KEY = "sniffmaster-owner-key";
const THEME_META = {
  obsidian: {
    label: "Obsidian Lab",
    note: "Refined dark HUD with cyan telemetry, crisp hierarchy, and fast scan readability.",
    tone: "good",
    themeColor: "#050505",
  },
  retro90s: {
    label: "Retro 90s",
    note: "Early-90s workstation skin with neon gradients, chrome edges, and a little arcade swagger.",
    tone: "warn",
    themeColor: "#120d2a",
  },
};
const DEFAULT_THEME = "obsidian";
const DEFAULT_MAP_LAYERS = {
  radar: true,
};
const VIEW_META = {
  dashboard: {
    title: "Overview",
    subtitle: "Current room condition, key metrics, and priority guidance at a glance.",
  },
  environment: {
    title: "Local Area",
    subtitle: "Outdoor conditions, weather context, and live environmental map.",
  },
  analysis: {
    title: "Air & Signal",
    subtitle: "Air classification, odor intensity, occupancy, and room intelligence.",
  },
  history: {
    title: "Trends",
    subtitle: "Daily rhythm patterns and the timestamped event log.",
  },
  space: {
    title: "Space",
    subtitle: "Space Coast launch schedule and NASA Astronomy Picture of the Day.",
  },
  system: {
    title: "System",
    subtitle: "Remote device control, hardware specs, and architecture documentation.",
  },
};

const VIEW_SECTIONS = {
  dashboard: [
    { id: "card-restoration", label: "Restoration Safety Monitor" },
    { id: "card-hero", label: "Room Status" },
    { id: "card-status", label: "System" },
  ],
  environment: [
    { id: "card-telemetry", label: "Raw Sensors" },
    { id: "card-derived", label: "Air Metrics" },
    { id: "card-weather-intel", label: "Weather & Map" },
  ],
  analysis: [
    { id: "card-bro", label: "Room Intel" },
    { id: "card-intel", label: "Air Intel" },
    { id: "card-cause", label: "Cause Engine" },
    { id: "card-office", label: "Vitality" },
    { id: "card-occupancy", label: "Presence" },
    { id: "card-odor", label: "Odor Class" },
    { id: "card-breath", label: "Breath" },
  ],
  history: [
    { id: "card-trend-series", label: "24-Hour Trend" },
    { id: "card-chart", label: "Daily Rhythm" },
    { id: "card-events", label: "Event Log" },
  ],
  space: [
    { id: "card-space", label: "Launch Deck" },
    { id: "card-history", label: "Astro Pic" },
  ],
  system: [
    { id: "card-controls", label: "Control Guide" },
    { id: "card-theme", label: "Theme Studio" },
    { id: "card-device", label: "Hardware Stack" },
    { id: "card-specs", label: "Specifications" },
    { id: "card-method", label: "Detection Pipeline" },
    { id: "card-pseudocode", label: "Pseudocode" },
    { id: "card-confidence", label: "Signal Confidence" },
    { id: "card-architecture", label: "Architecture" },
    { id: "card-usecases", label: "Applications" },
  ],
};

let lastData = null;
let historyData = [];
let sniffHistoryData = [];
let lastSniffEvent = null;
let sniffStream = null;
let weatherMap = null;
let weatherMarker = null;
let weatherBaseLayer = null;
let weatherBriefingState = {
  key: "",
  fetchedAt: 0,
  data: null,
  pending: null,
};
let occupancyBriefingState = {
  fetchedAt: 0,
  data: null,
  pending: null,
};
let launchState = {
  fetchedAt: 0,
  data: null,
  pending: null,
};
let apodState = {
  fetchedAt: 0,
  data: null,
  pending: null,
};
let lastSassyMsg = "";
let activeView = loadViewPref();
let mapLayers = {
  radar: null,
  satellite: null,
  hazards: null,
};
let mapLayerActive = {
  rain: true,
  satellite: false,
  hazards: false,
};
let rainViewerState = {
  fetchedAt: 0,
  tileUrl: "",
};
let radarAnimState = {
  frames: [],        // [{path, time}]
  frameIndex: 0,
  host: "",
  playing: false,
  rafId: 0,
  lastFrameTs: 0,
  FRAME_INTERVAL_MS: 700,
};
let manualRefreshPending = false;
let remoteCommandPending = false;
let viewSubmenuOpen = false;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

applyTheme(loadThemePref(), { skipUi: true });

const $ = (id) => document.getElementById(id);

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function humanLabel(value, fallback = "Unknown") {
  const raw = `${value || ""}`.trim();
  if (!raw) return fallback;
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loadViewPref() {
  try {
    const hash = `${window.location.hash || ""}`.replace(/^#/, "");
    const alias = { home: "dashboard", air: "analysis", weather: "environment" };
    if (VIEW_META[hash]) return hash;
    if (alias[hash] && VIEW_META[alias[hash]]) return alias[hash];
    const raw = localStorage.getItem(VIEW_PREF_KEY);
    if (VIEW_META[raw]) return raw;
    if (alias[raw] && VIEW_META[alias[raw]]) return alias[raw];
  } catch (_) {}
  return "dashboard";
}

function saveViewPref(view) {
  try {
    localStorage.setItem(VIEW_PREF_KEY, view);
  } catch (_) {}
}

function loadThemePref() {
  try {
    const raw = `${localStorage.getItem(THEME_PREF_KEY) || ""}`.trim();
    return THEME_META[raw] ? raw : DEFAULT_THEME;
  } catch (_) {
    return DEFAULT_THEME;
  }
}

function saveThemePref(theme) {
  try {
    localStorage.setItem(THEME_PREF_KEY, theme);
  } catch (_) {}
}

function updateThemeMetaColor(theme) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_META[theme]?.themeColor || THEME_META[DEFAULT_THEME].themeColor);
}

function renderThemeUi(theme = loadThemePref()) {
  const current = THEME_META[theme] ? theme : DEFAULT_THEME;
  const toggle = $("theme-retro-toggle");
  const badge = $("theme-badge");
  const title = $("theme-current-title");
  const note = $("theme-current-note");
  const tag = $("theme-current-tag");
  const panel = $("theme-preview-panel");
  const status = $("theme-status");
  const header = $("header-theme");

  if (toggle) toggle.checked = current === "retro90s";
  if (toggle) toggle.setAttribute("aria-checked", current === "retro90s" ? "true" : "false");
  if (badge) badge.textContent = THEME_META[current].label;
  if (title) title.textContent = THEME_META[current].label;
  if (note) note.textContent = THEME_META[current].note;
  if (tag) tag.textContent = current === "retro90s" ? "Retro mode engaged" : "Default mode active";
  if (header) header.textContent = `Theme: ${THEME_META[current].label}`;
  if (panel) {
    panel.dataset.theme = current;
  }
  if (status) {
    status.textContent = `Current portal theme: ${THEME_META[current].label}. ${THEME_META[current].note}`;
  }
}

function applyTheme(theme, options = {}) {
  const next = THEME_META[theme] ? theme : DEFAULT_THEME;
  document.documentElement.dataset.theme = next;
  document.body.dataset.theme = next;
  updateThemeMetaColor(next);
  saveThemePref(next);
  if (!options.skipUi) renderThemeUi(next);
  return next;
}

function headerCalibrationText(d) {
  if (d.highAccuracyIaq) return "Ready";
  const label = `${d.calibration || ""}`.trim().toLowerCase();
  if (label.includes("learn")) return "Learning room";
  if (label.includes("restor")) return "Restoring cal";
  if (label.includes("warm")) return "Sensor warmup";
  if (label.includes("final") || label.includes("stabil") || label.includes("run-in")) return "Stabilizing";
  return `Accuracy ${Math.round(num(d.iaqAcc))}/3`;
}

function calibrationNarrative(d) {
  if (d.highAccuracyIaq) {
    return {
      short: "Ready",
      detail: "Sensor calibration and room baseline are ready."
    };
  }
  const label = `${d.calibration || ""}`.trim().toLowerCase();
  if (label.includes("learn")) {
    return {
      short: "Learning room",
      detail: "The gas model is live and the device is building a quiet-room baseline."
    };
  }
  if (label.includes("restor")) {
    return {
      short: "Restoring cal",
      detail: "Saved calibration is loading so startup can resume faster."
    };
  }
  if (label.includes("final") || label.includes("stabil") || label.includes("run-in")) {
    return {
      short: "Stabilizing",
      detail: "The sensor is collecting stable packets before full odor logic opens up."
    };
  }
  if (label.includes("warm") || label.includes("calibr")) {
    return {
      short: "Sensor warmup",
      detail: "The heater and gas model are still settling into a clean baseline."
    };
  }
  return {
    short: `Accuracy ${Math.round(num(d.iaqAcc))}/3`,
    detail: "Waiting for a few more reliable sensor packets."
  };
}

function headerPresenceText(_d) {
  return "";
}

function headerNetworkText(d) {
  const ssid = `${d.wifiSsid || ""}`.trim();
  const ip = `${d.wifiIp || ""}`.trim();
  const rssi = num(d.wifiRssi, NaN);
  const parts = [];
  if (ssid) parts.push(ssid);
  if (ip) parts.push(ip);
  if (Number.isFinite(rssi)) parts.push(`${Math.round(rssi)} dBm`);
  return parts.length ? parts.join(" · ") : "Network details pending";
}

function setViewSubmenuOpen(open) {
  const shell = $("view-submenu-shell");
  const toggle = $("view-submenu-toggle");
  const panel = $("view-subnav-panel");
  if (!shell || !toggle || !panel || shell.hidden) return;
  viewSubmenuOpen = Boolean(open);
  shell.classList.toggle("is-open", viewSubmenuOpen);
  toggle.setAttribute("aria-expanded", viewSubmenuOpen ? "true" : "false");
  panel.hidden = !viewSubmenuOpen;
}

function closeViewSubmenu() {
  setViewSubmenuOpen(false);
}

function loadOwnerKey() {
  try {
    return (sessionStorage.getItem(OWNER_KEY_SESSION_KEY) || "").trim();
  } catch (_) {
    return "";
  }
}

function saveOwnerKey(key) {
  try {
    sessionStorage.setItem(OWNER_KEY_SESSION_KEY, `${key || ""}`.trim());
  } catch (_) {}
}

function clearOwnerKey() {
  try {
    sessionStorage.removeItem(OWNER_KEY_SESSION_KEY);
  } catch (_) {}
}

function tierColor(score) {
  if (score >= 80) return "var(--mint)";
  if (score >= 60) return "var(--lime)";
  if (score >= 40) return "var(--amber)";
  if (score >= 20) return "var(--orange)";
  return "var(--red)";
}

function airScoreColor(score) {
  if (score < 15) return "var(--mint)";
  if (score < 30) return "var(--lime)";
  if (score < 50) return "var(--amber)";
  if (score < 70) return "var(--orange)";
  return "var(--red)";
}

function airScoreCondition(score) {
  if (score < 15) return "Pristine environment";
  if (score < 30) return "Fresh room";
  if (score < 50) return "Normal conditions";
  if (score < 70) return "Elevated activity";
  if (score < 85) return "Poor conditions";
  return "Hazardous air";
}

function airScoreMeaning(score) {
  if (score < 15) return "Lower is better: this very low index means clean air, light VOC load, and little immediate concern.";
  if (score < 30) return "Lower is better: this is still a good room. Something may be present, but the overall air load is modest.";
  if (score < 50) return "Lower is better: noticeable activity is building. The room is still manageable, but it is no longer pristine.";
  if (score < 70) return "Lower is better: the room is getting noisy with VOCs, odor confidence, or stuffiness. Ventilation would help.";
  if (score < 85) return "Lower is better: this is a rough room read. Multiple factors are pushing the index into a clearly poor range.";
  return "Lower is better: this high room-quality index means the air is unhealthy or actively nasty right now. Treat it like a real alert.";
}

function airScoreTone(score) {
  if (score < 30) return "good";
  if (score < 60) return "warn";
  return "danger";
}

function officeCfiScore(d) {
  const explicit = num(d.cfiScore, NaN);
  if (Number.isFinite(explicit)) return clamp(explicit, 0, 1);
  let score = 1;
  const co2 = num(d.co2);
  const iaq = num(d.iaq);
  if (co2 > 800) score -= ((co2 - 800) / 100) * 0.05;
  if (iaq > 100) score -= 0.10;
  return clamp(score, 0, 1);
}

function officeCfiPercent(d) {
  const explicit = num(d.cfiPercent, NaN);
  if (Number.isFinite(explicit)) return Math.round(clamp(explicit, 0, 100));
  return Math.round(officeCfiScore(d) * 100);
}

function officeCfiBand(d) {
  const explicit = `${d.cfiBand || ""}`.trim();
  if (explicit) return explicit;
  const percent = officeCfiPercent(d);
  if (percent >= 80) return "Peak";
  if (percent >= 60) return "Reduced";
  return "Drained";
}

function officeCfiColor(percent) {
  if (percent >= 80) return "#00f2ff";
  if (percent >= 60) return "#46b6ff";
  if (percent >= 40) return "#6b59ff";
  return "#5a2a8b";
}

function officeVtrLevel(d) {
  const explicit = num(d.vtrLevel, NaN);
  if (Number.isFinite(explicit)) return clamp(Math.round(explicit), 0, 2);
  const humidity = num(d.humidity);
  const co2 = num(d.co2);
  const iaq = num(d.iaq);
  if (humidity < 30 && co2 > 1200) return 2;
  if (humidity >= 40 && humidity <= 60 && co2 < 800 && iaq <= 100) return 0;
  return 1;
}

function officeVtrLabel(d) {
  const explicit = `${d.vtrLabel || ""}`.trim();
  if (explicit) return explicit;
  const level = officeVtrLevel(d);
  if (level === 0) return "Safe";
  if (level === 2) return "High Bio-Risk";
  return "Elevated";
}

function officeVtrAdvice(d) {
  const explicit = `${d.vtrAdvice || ""}`.trim();
  if (explicit) return explicit;
  const level = officeVtrLevel(d);
  if (level === 0) return "Ventilation and humidity are in a favorable range.";
  if (level === 2) return "Dry, rebreathed air pattern detected. Air cleaning, filtration, or masking is recommended.";
  return "Stagnant or dry air detected. Increase ventilation.";
}

function officeEffectTone(level) {
  if (level >= 2) return "danger";
  if (level >= 1) return "warn";
  return "good";
}

function officeComfortProfile(d) {
  const tempF = num(d.tempF);
  const humidity = num(d.humidity);
  let level = 0;
  const issues = [];

  if (tempF < 67 || tempF > 78) {
    level += 2;
    issues.push(tempF < 67 ? "the room is running cool" : "the room is running warm");
  } else if (tempF < 69 || tempF > 76) {
    level += 1;
    issues.push(tempF < 69 ? "temperature is a bit cool" : "temperature is a bit warm");
  }

  if (humidity < 30 || humidity > 65) {
    level += 2;
    issues.push(humidity < 30 ? "air is dry enough to feel scratchy" : "humidity is high enough to feel sticky");
  } else if (humidity < 40 || humidity > 60) {
    level += 1;
    issues.push(humidity < 40 ? "humidity is slightly dry" : "humidity is a little heavy");
  }

  if (level <= 0) {
    return {
      title: "Comfortable",
      note: `Thermal comfort looks stable at ${tempF.toFixed(0)}F and ${humidity.toFixed(0)}% humidity.`,
      tone: "good",
    };
  }
  if (level <= 2) {
    return {
      title: "Slightly off",
      note: `${issues.join(" and ")}. The room is still workable, but people may start noticing it over longer stretches.`,
      tone: "warn",
    };
  }
  return {
    title: "Comfort strained",
    note: `${issues.join(" and ")}. Expect more fidgeting, lower comfort, and faster meeting fatigue.`,
    tone: "danger",
  };
}

function officeAttentionProfile(d) {
  const cfiPercent = officeCfiPercent(d);
  const co2 = num(d.co2);
  const iaq = num(d.iaq);

  if (cfiPercent >= 80) {
    return {
      title: "Clear for focus",
      note: `CO2eq is around ${Math.round(co2)} ppm and IAQ is ${Math.round(iaq)}, so the air is not adding much cognitive drag.`,
      tone: "good",
    };
  }
  if (cfiPercent >= 60) {
    return {
      title: "Mild attention drag",
      note: `The room should stay usable, but ${co2 > 900 ? "CO2 is climbing" : "air load is building"} and longer work blocks may start to feel heavy.`,
      tone: "warn",
    };
  }
  return {
    title: "Attention compromised",
    note: `CO2eq and stale-air load are high enough to blunt concentration, working memory, and meeting stamina.`,
    tone: "danger",
  };
}

function officeFatigueProfile(d) {
  const co2 = num(d.co2);
  const iaq = num(d.iaq);
  const tempF = num(d.tempF);
  const humidity = num(d.humidity);
  let score = 0;

  if (co2 > 900) score += 1;
  if (co2 > 1200) score += 1;
  if (iaq > 100) score += 1;
  if (tempF > 76 || tempF < 68) score += 1;
  if (humidity < 35 || humidity > 65) score += 1;

  if (score <= 1) {
    return {
      title: "Low fatigue pressure",
      note: "The room is not stacking the usual air-quality conditions that make people feel flat earlier than they should.",
      tone: "good",
    };
  }
  if (score <= 2) {
    return {
      title: "Fatigue building",
      note: "The room is starting to feel more expensive over time. People may get mentally tired faster in longer sessions.",
      tone: "warn",
    };
  }
  return {
    title: "Fatigue amplified",
    note: "Multiple comfort and air-load signals are stacking together, which usually shows up as shorter patience and heavier work blocks.",
    tone: "danger",
  };
}

function officeCollaborationProfile(d, comfort, attention) {
  const vtrLevel = officeVtrLevel(d);
  const cfiPercent = officeCfiPercent(d);
  const score = num(d.airScore);

  if (comfort.tone === "good" && attention.tone === "good" && vtrLevel === 0) {
    return {
      title: "Meeting-ready",
      note: "The room should support longer collaboration without people feeling the air before they notice the conversation.",
      tone: "good",
    };
  }
  if (cfiPercent >= 60 && score < 45 && vtrLevel <= 1) {
    return {
      title: "Needs air breaks",
      note: "Collaboration is still workable, but longer meetings would benefit from a fresh-air reset before the room gets sluggish.",
      tone: "warn",
    };
  }
  return {
    title: "Room friction",
    note: "Shared work will likely feel less crisp here. Expect lower patience, more distraction, and faster meeting drag until the air improves.",
    tone: "danger",
  };
}

function officePersistenceProfile(d) {
  const vtrLevel = officeVtrLevel(d);
  const humidity = num(d.humidity);
  const co2 = num(d.co2);

  if (vtrLevel === 0) {
    return {
      title: "Clear faster",
      note: `Humidity at ${humidity.toFixed(0)}% and CO2eq near ${Math.round(co2)} ppm support better dilution and less persistence pressure.`,
      tone: "good",
    };
  }
  if (vtrLevel === 1) {
    return {
      title: "Persistence elevated",
      note: "Ventilation or humidity is drifting out of the sweet spot, so shared air may hang around longer than ideal.",
      tone: "warn",
    };
  }
  return {
    title: "Persistence favored",
    note: "Dry, rebreathed air is stacking together. This pattern can help respiratory particles linger unless airflow or filtration improves.",
    tone: "danger",
  };
}

function officeBriefingText(d, comfort, attention, fatigue, collaboration, persistence) {
  const windowGuidance = windowCall(d);
  if (persistence.tone === "danger" && attention.tone === "danger") {
    return `${windowGuidance} The room is likely to feel mentally heavy before people can explain why, and the same stale, dry pattern is also helping shared air linger.`;
  }
  if (collaboration.tone === "danger" || fatigue.tone === "danger") {
    return `${windowGuidance} This room is still usable, but the air is working against comfort and meeting stamina enough that people will probably feel it over longer sessions.`;
  }
  if (attention.tone === "warn" || comfort.tone === "warn" || persistence.tone === "warn") {
    return `${windowGuidance} Conditions are acceptable for short work blocks, but the room would benefit from a fresh-air reset before the next long meeting.`;
  }
  return `${windowGuidance} The room is supporting clear attention, stable comfort, and lower shared-air risk right now.`;
}

function officeAttentionState(d) {
  const co2 = num(d.co2);
  const iaq = num(d.iaq);
  const temp = num(d.tempF);
  const voc = num(d.voc);
  let score = 0;

  if (co2 > 1200) score += 2;
  else if (co2 > 950) score += 1;
  else if (co2 > 800) score += 0.5;

  if (iaq > 120) score += 1;
  else if (iaq > 80) score += 0.5;

  if (temp > 79 || temp < 67) score += 0.75;
  else if (temp > 77 || temp < 69) score += 0.35;

  if (voc > 1.2 || Math.abs(num(d.dVoc)) > 0.25) score += 0.5;

  if (score >= 3) {
    return {
      title: "Heavy drag",
      note: "Expect concentration to decay faster and routine work to feel more expensive than it should.",
    };
  }
  if (score >= 1.5) {
    return {
      title: "Moderate drag",
      note: "Attention is still workable, but the room is starting to tax patience, clarity, or pace.",
    };
  }
  return {
    title: "Low drag",
    note: "Air conditions are not likely to be the main thing slowing people down right now.",
  };
}

function officeComfortState(d) {
  const temp = num(d.tempF);
  const humidity = num(d.humidity);

  if (humidity < 30) {
    return {
      title: "Dry air load",
      note: "Low humidity can dry out eyes and throat, which makes long desk sessions feel harsher than the room looks.",
    };
  }
  if (humidity > 65) {
    return {
      title: "Sticky air",
      note: "High humidity makes the room feel heavier and can amplify perceived stuffiness in meetings.",
    };
  }
  if (temp > 79) {
    return {
      title: "Running warm",
      note: "Warm rooms tend to sap alertness and make shared spaces feel sluggish faster.",
    };
  }
  if (temp < 67) {
    return {
      title: "Running cool",
      note: "A cool room can stay usable, but some people will feel it as distraction rather than freshness.",
    };
  }
  return {
    title: "Comfortable band",
    note: "Temperature and humidity are in a range that should stay easy to inhabit for longer work blocks.",
  };
}

function officeCollaborationState(d) {
  const co2 = num(d.co2);
  const iaq = num(d.iaq);

  if (co2 > 1400 || iaq > 130) {
    return {
      title: "Stale room load",
      note: "This is the kind of air that makes group work feel slow, repetitive, and less patient than it should.",
    };
  }
  if (co2 > 1000 || iaq > 90) {
    return {
      title: "Shared-air heavy",
      note: "The room is still workable, but longer meetings will feel flatter unless you give it some turnover.",
    };
  }
  if (co2 > 800) {
    return {
      title: "Occupied but workable",
      note: "There is some rebreathed-air buildup, though the room is still in decent shape for normal collaboration.",
    };
  }
  return {
    title: "Meeting ready",
    note: "Shared-air load is low enough that the room should feel clear and easier to work in.",
  };
}

function officeOdorState(d) {
  const voc = num(d.voc);
  const dvoc = Math.abs(num(d.dVoc));
  const primary = currentPrimary(d, "No dominant odor");
  const confident = hasConfidentPrimary(d);

  if ((confident && num(d.primaryConf) >= 40) || voc >= 1.5 || dvoc >= 0.35) {
    return {
      title: confident ? `${primary} is noticeable` : "Air signature is distracting",
      note: "The room has enough volatile activity that people are more likely to notice the environment, not just the work.",
    };
  }
  if (confident || voc >= 0.9 || dvoc >= 0.18) {
    return {
      title: confident ? `${primary} in the background` : "Mild sensory load",
      note: "There is some environmental character in the room, but it should stay secondary unless people are sensitive to smells.",
    };
  }
  return {
    title: "Easy to ignore",
    note: "The air is quiet enough that odor should not become part of the conversation.",
  };
}

function officeBriefing(d) {
  const attention = officeAttentionState(d);
  const comfort = officeComfortState(d);
  const collab = officeCollaborationState(d);
  const odor = officeOdorState(d);
  const vtrLevel = officeVtrLevel(d);
  const cfiPercent = officeCfiPercent(d);

  if (vtrLevel >= 2) {
    return "The room is stacking multiple human-cost signals at once: dry shared air, weaker attention conditions, and a higher chance that people feel the space before they say anything about it. Fresh air or filtration will improve both comfort and the way the room supports actual work.";
  }
  if (cfiPercent < 60) {
    return "The main hit right now is cognitive, not dramatic. This room is likely making focus, short-term memory, and meeting patience feel worse than they need to. Fixing the air should pay back productivity faster than tweaking the workflow.";
  }
  return `${attention.title}, ${comfort.title.toLowerCase()}, and ${collab.title.toLowerCase()}. ${odor.note}`;
}

function iaqLabel(iaq) {
  if (iaq <= 25) return "Pristine";
  if (iaq <= 50) return "Fresh";
  if (iaq <= 100) return "OK";
  if (iaq <= 150) return "Fair";
  if (iaq <= 200) return "Stale";
  if (iaq <= 300) return "Poor";
  return "Hazard";
}

function smellTierLabel(tier) {
  return ["No smell", "Whiff", "Noticeable", "Strong", "Ripe", "Biohazard"][tier] || `Tier ${tier}`;
}

function aqiColor(aqi) {
  if (aqi <= 50) return "var(--mint)";
  if (aqi <= 100) return "var(--lime)";
  if (aqi <= 150) return "var(--amber)";
  if (aqi <= 200) return "var(--orange)";
  return "var(--red)";
}

function fmtGasR(value) {
  const r = num(value);
  if (r >= 1000000) return `${(r / 1000000).toFixed(2)}M`;
  if (r >= 1000) return `${(r / 1000).toFixed(r >= 100000 ? 0 : 1)}k`;
  return `${Math.round(r)}`;
}

function fmtSigned(value, digits = 1) {
  const n = num(value);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}`;
}

function fmtUptime(sec) {
  const total = num(sec);
  if (!total) return "Waiting for uptime";
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `Up ${d}d ${h}h`;
  if (h > 0) return `Up ${h}h ${m}m`;
  return `Up ${m}m`;
}

function fmtAge(timestamp) {
  const ageSec = Math.floor((Date.now() - timestamp) / 1000);
  if (ageSec < 10) return "just now";
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  return `${Math.floor(ageSec / 3600)}h ago`;
}

function fmtStamp(timestamp) {
  if (!timestamp) return "No update yet";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  }).format(new Date(timestamp));
}

function fmtEventStamp(timestamp) {
  if (!timestamp) return "Time unknown";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function snapshotDate(d) {
  const base = num(d?.receivedAt, Date.now());
  const offsetSec = num(d?.utcOffsetSec, NaN);
  if (!Number.isFinite(offsetSec)) return new Date(base);
  return new Date(base + offsetSec * 1000);
}

function snapshotMonthDayKey(d) {
  const stamp = snapshotDate(d);
  const month = String(stamp.getUTCMonth() + 1).padStart(2, "0");
  const day = String(stamp.getUTCDate()).padStart(2, "0");
  return `${month}-${day}`;
}

function snapshotMonthDayLabel(d) {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(snapshotDate(d));
}

function isFreshTimestamp(timestamp, maxAgeMs) {
  const ts = num(timestamp, NaN);
  return Number.isFinite(ts) && Date.now() - ts <= maxAgeMs;
}

function activeSniffEvent() {
  return lastSniffEvent && isFreshTimestamp(lastSniffEvent.receivedAt, SNIFF_EVENT_STALE_MS)
    ? lastSniffEvent
    : null;
}

function vscProxyConfidence(d) {
  const sulfur = fartSignals(d).sulfur;
  const snapshotConf = num(d?.vscConf, NaN);
  const eventConf = num(activeSniffEvent()?.vsc_conf, NaN);
  return clamp(
    Math.max(
      Number.isFinite(snapshotConf) ? snapshotConf : 0,
      Number.isFinite(eventConf) ? eventConf : 0,
      sulfur
    ),
    0,
    100
  );
}

function mergeSnapshotWithSniff(data) {
  const event = activeSniffEvent();
  if (!event) return data;
  return {
    ...data,
    sniffEvent: event,
    sniffLabel: event.label,
    sniffAt: event.receivedAt,
    sniffSeq: event.seq,
    vscConf: Math.max(num(data?.vscConf, 0), num(event.vsc_conf, 0)),
  };
}

// Fill in fields that the device snapshot may lack using weather briefing data.
// Device values always take priority; briefing values only fill gaps.
function mergeBriefingIntoSnapshot(data, briefing) {
  if (!briefing) return data;
  const updates = {};

  if (num(briefing.outdoorAqi) > 0 && !(num(data.outdoorAqi) > 0)) {
    updates.outdoorAqi = briefing.outdoorAqi;
    updates.outdoorLevel = briefing.outdoorLevel || "";
  }

  const bc = briefing.current;
  if (bc) {
    if (!data.weatherCondition && bc.condition) updates.weatherCondition = bc.condition;
    if (!Number.isFinite(num(data.tempF, NaN)) && Number.isFinite(bc.tempF)) updates.tempF = bc.tempF;
    if (!data.windDir && bc.windDir) updates.windDir = bc.windDir;
    if (!data.windSpeed && bc.windSpeed) updates.windSpeed = bc.windSpeed;
    if (!Number.isFinite(num(data.pressHpa, NaN)) && Number.isFinite(bc.pressHpa)) updates.pressHpa = bc.pressHpa;
  }

  if (briefing.usingDefault && !hasLocationFix(data)) {
    if (num(briefing.lat) && num(briefing.lon)) {
      updates.lat = briefing.lat;
      updates.lon = briefing.lon;
    }
    if (briefing.city && !data.city) updates.city = briefing.city;
  }

  return Object.keys(updates).length > 0 ? { ...data, ...updates } : data;
}

function dewPointF(tempF, humidity) {
  const tC = (num(tempF) - 32) * 5 / 9;
  const rh = clamp(num(humidity), 1, 100);
  const a = 17.27;
  const b = 237.7;
  const gamma = (a * tC) / (b + tC) + Math.log(rh / 100);
  const dpC = (b * gamma) / (a - gamma);
  return dpC * 9 / 5 + 32;
}

function moonInfo(date = new Date()) {
  const synodicSeconds = 2551443;
  const knownNewMoon = Date.UTC(1970, 0, 7, 20, 35, 0);
  const ageSeconds = ((((date.getTime() - knownNewMoon) / 1000) % synodicSeconds) + synodicSeconds) % synodicSeconds;
  const phase = ageSeconds / synodicSeconds;
  const illum = Math.round(((1 - Math.cos(phase * 2 * Math.PI)) / 2) * 100);

  let label = "New Moon";
  if (phase < 0.03 || phase >= 0.97) label = "New Moon";
  else if (phase < 0.22) label = "Waxing Crescent";
  else if (phase < 0.28) label = "First Quarter";
  else if (phase < 0.47) label = "Waxing Gibbous";
  else if (phase < 0.53) label = "Full Moon";
  else if (phase < 0.72) label = "Waning Gibbous";
  else if (phase < 0.78) label = "Last Quarter";
  else label = "Waning Crescent";

  return { label, illum };
}

function topOdors(odors, limit = 5) {
  return (odors || [])
    .map((score, index) => ({ index, name: ODOR_NAMES[index] || `Odor ${index}`, score: num(score) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function hasConfidentPrimary(d) {
  return Boolean(d.primary) && num(d.primaryConf) >= 20;
}

function currentPrimary(d, fallback) {
  if (hasConfidentPrimary(d)) {
    return `${d.primary} (${num(d.primaryConf)}%)`;
  }
  if (fallback !== undefined) return fallback;
  return num(d.airScore) <= 30 ? "Clean Air" : "No dominant odor";
}

function trimHeadline(text, maxLen = 96) {
  const normalized = `${text || ""}`
    .replace(/\s+/g, " ")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
  if (!normalized) return "";

  const firstSentence = normalized.split(/(?<=[.!?])\s+/)[0]?.trim() || normalized;
  const base = firstSentence.length <= maxLen ? firstSentence : normalized;
  if (base.length <= maxLen) return base;

  const cut = base.slice(0, maxLen + 1);
  const comma = Math.max(cut.lastIndexOf(","), cut.lastIndexOf(";"));
  const space = cut.lastIndexOf(" ");
  const end = comma > 48 ? comma : (space > 48 ? space : maxLen);
  return `${cut.slice(0, end).trim()}...`;
}

// Regex matching known device-side AI failure messages that should never be displayed.
const AI_FAILURE_PATTERNS = /gpt is ghosting|openai is|ai is offline|cannot reach|api error|failed to fetch|no response/i;

function heroSummaryText(d) {
  const raw = `${d?.sassy || ""}`.trim();
  // Filter known device-side AI failure messages so we never display them
  const isGhosting = !raw || AI_FAILURE_PATTERNS.test(raw);
  if (!isGhosting) {
    lastSassyMsg = raw; // cache the last good message
  }
  const aiLine = trimHeadline(isGhosting ? (lastSassyMsg || "") : raw, 104);
  return aiLine || roomSummary(d);
}

function primaryNarrative(d) {
  if (hasConfidentPrimary(d)) {
    const primary = `${d.primary || ""}`.trim();
    const contextualLabel = {
      "Fart": "bio drama",
      "Musty": "musty office funk",
      "Cigarette": "smoke residue",
      "Alcohol": "sanitizer or alcohol traces",
      "Weed": "skunky plant funk",
      "Cleaning": "cleaning-product energy",
      "Gasoline": "fuel-like weirdness",
      "Smoke": "smoke trouble",
      "Cooking": "cooking in the mix",
      "Coffee": "coffee in the air",
      "Garbage": "break-room trash drama",
      "Sweat/BO": "occupancy funk",
      "Perfume": "fragrance cloud activity",
      "Laundry": "fresh detergent notes",
      "Sulfur": "sulfur trouble",
      "Solvent": "solvent-heavy air",
      "Pet/Litter": "pet-zone funk",
      "Sour Food": "leftovers getting bold",
      "Burnt/Oil": "burnt equipment notes",
      "Citrus": "citrus-cleaner lift",
    }[primary];
    return contextualLabel || primary.toLowerCase();
  }
  const score = num(d.airScore);
  if (score <= 30) return "clean-air conditions";
  if (score <= 60) return "mixed background VOCs";
  return "diffuse VOC buildup";
}

function vocLoadLabel(voc) {
  const value = num(voc);
  if (value < 0.5) return "Light VOC load";
  if (value < 1.2) return "Manageable VOC activity";
  if (value < 2.5) return "Elevated VOC activity";
  return "Heavy VOC load";
}

function gasResistanceSummary(gasR) {
  const value = num(gasR);
  if (value >= 250000) return "High resistance, which usually tracks with cleaner background air on this sensor.";
  if (value >= 120000) return "Middle resistance band. The room is usable, but not especially clean.";
  return "Lower resistance band, which usually means the gas mix is active or the room baseline is under pressure.";
}

function daybookEntriesForSnapshot(d) {
  const key = snapshotMonthDayKey(d);
  const curated = SPACE_COAST_DAYBOOK[key];
  if (curated?.length) return curated;

  if (d.spaceHistoryLong || d.spaceHistoryShort) {
    return [{
      year: String(d.spaceHistoryShort || "").match(/\d{4}/)?.[0] || "Mission",
      title: d.spaceHistoryShort || "Space Coast milestone",
      detail: d.spaceHistoryContext || d.spaceHistoryLong || "A local spaceflight history note was posted by the device.",
    }];
  }

  return [];
}

function eventSoundProfile(event, history, current) {
  if (event.tag === "Sulfur") return "Sulfur Watch";
  if (event.tag === "Room") return num(current?.airScore) < 30 ? "Success Chime" : "Condition Shift";
  if (event.tag === "Odor") return "Odor Sweep";
  return "No linked tone";
}

function hasLocationFix(d) {
  const lat = num(d.lat, NaN);
  const lon = num(d.lon, NaN);
  return Number.isFinite(lat) && Number.isFinite(lon) && (Math.abs(lat) > 0.0001 || Math.abs(lon) > 0.0001);
}

function fmtCoords(d) {
  return hasLocationFix(d) ? `${num(d.lat).toFixed(4)}, ${num(d.lon).toFixed(4)}` : "No location fix";
}

function fmtLocationTime(timestamp, offsetSec) {
  const ts = num(timestamp, NaN);
  const offset = num(offsetSec, NaN);
  if (!Number.isFinite(ts)) return "--";
  if (!Number.isFinite(offset)) return fmtStamp(ts);

  const local = new Date(ts + offset * 1000);
  let hours = local.getUTCHours();
  const minutes = local.getUTCMinutes();
  const suffix = hours >= 12 ? "PM" : "AM";
  hours %= 12;
  if (hours === 0) hours = 12;

  return `${hours}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function fmtLocationDate(timestamp, offsetSec) {
  const ts = num(timestamp, NaN);
  const offset = num(offsetSec, NaN);
  if (!Number.isFinite(ts)) return "Date pending";
  if (!Number.isFinite(offset)) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      weekday: "short",
    }).format(new Date(ts));
  }
  const local = new Date(ts + offset * 1000);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    weekday: "short",
    timeZone: "UTC",
  }).format(local);
}

function moonFromDay(dayValue) {
  const age = clamp(num(dayValue), 0, 29.53);
  const phase = age / 29.53;
  const illum = Math.round(((1 - Math.cos(phase * 2 * Math.PI)) / 2) * 100);

  let label = "New Moon";
  if (phase < 0.03 || phase >= 0.97) label = "New Moon";
  else if (phase < 0.22) label = "Waxing Crescent";
  else if (phase < 0.28) label = "First Quarter";
  else if (phase < 0.47) label = "Waxing Gibbous";
  else if (phase < 0.53) label = "Full Moon";
  else if (phase < 0.72) label = "Waning Gibbous";
  else if (phase < 0.78) label = "Last Quarter";
  else label = "Waning Crescent";

  return { label, illum };
}

function currentMoon(d) {
  return Number.isFinite(num(d.moonDay, NaN))
    ? moonFromDay(num(d.moonDay))
    : moonInfo(new Date());
}

function moonShadowOffset(label, illum) {
  const waxing = label.includes("Waxing") || label === "First Quarter" || label === "New Moon";
  const offset = clamp(num(illum), 0, 100) * 1.08;
  return waxing ? offset : -offset;
}

function localHourForData(d) {
  const ts = num(d.receivedAt, NaN);
  const offset = num(d.utcOffsetSec, NaN);
  if (!Number.isFinite(ts)) return 12;
  if (!Number.isFinite(offset)) return new Date(ts).getHours();
  const local = new Date(ts + offset * 1000);
  return local.getUTCHours() + local.getUTCMinutes() / 60;
}

function dewComfort(dew) {
  if (dew < 50) return "dry / crisp";
  if (dew < 60) return "comfortable";
  if (dew < 65) return "slightly sticky";
  if (dew < 70) return "muggy";
  return "swampy";
}

function pressureRead(hpa) {
  const press = num(hpa);
  if (press >= 1022) return "high pressure / clearer skies";
  if (press >= 1009) return "steady pressure";
  if (press >= 1000) return "lower pressure / changeable";
  return "stormy pressure drop";
}

function outdoorSeverity(d) {
  const level = (d.outdoorLevel || "").toLowerCase();
  if (level.includes("very poor") || level.includes("hazard") || level.includes("unhealthy")) return 4;
  if (level.includes("poor")) return 3;
  if (level.includes("moderate") || level.includes("sensitive")) return 2;
  if (level.includes("fair")) return 1;
  if (level.includes("good")) return 0;

  const aqi = num(d.outdoorAqi, NaN);
  if (!Number.isFinite(aqi) || aqi <= 0) return -1;
  if (aqi <= 5) return Math.max(0, Math.round(aqi) - 1);
  if (aqi <= 50) return 0;
  if (aqi <= 100) return 1;
  if (aqi <= 150) return 2;
  if (aqi <= 200) return 3;
  return 4;
}

function outdoorBlend(d) {
  const severity = outdoorSeverity(d);
  if (severity < 0) return "Outdoor air chemistry pending";
  if (severity <= 1) return "Outdoor air is friendly enough for ventilation";
  if (severity === 2) return "Outdoor air is usable, but use shorter ventilation bursts";
  return "Outdoor air is rough right now; indoor protection matters more";
}

function windowCall(d) {
  const severity = outdoorSeverity(d);
  const co2 = num(d.co2);
  if (severity >= 3) return "Keep windows mostly shut and ventilate selectively";
  if (severity === 2) return co2 >= 900 ? "Use short fresh-air bursts if the room feels stuffy" : "Ventilate only if you need a quick reset";
  if (co2 >= 1000) return "Open windows or run ventilation soon";
  if (co2 >= 800) return "A small ventilation top-up would help";
  return "No urgent window move needed";
}

function heatBenchmark(d) {
  const dv = num(d.deathValleyTempF, NaN);
  const temp = num(d.tempF, NaN);
  if (!Number.isFinite(dv) || !Number.isFinite(temp)) return "Death Valley benchmark pending";
  const diff = Math.round(Math.abs(dv - temp));
  if (dv >= temp) return `${diff}F cooler than Death Valley`;
  return `${diff}F hotter than Death Valley`;
}

function chemistryItems(d) {
  return [
    { name: "PM2.5", value: num(d.outdoorPm25, NaN), unit: "ug/m3", threshold: 35 },
    { name: "PM10", value: num(d.outdoorPm10, NaN), unit: "ug/m3", threshold: 50 },
    { name: "O3", value: num(d.outdoorO3, NaN), unit: "ug/m3", threshold: 100 },
    { name: "NO2", value: num(d.outdoorNo2, NaN), unit: "ug/m3", threshold: 40 },
    { name: "CO", value: num(d.outdoorCo, NaN), unit: "ug/m3", threshold: 4000 },
    { name: "SO2", value: num(d.outdoorSo2, NaN), unit: "ug/m3", threshold: 20 },
    { name: "NH3", value: num(d.outdoorNh3, NaN), unit: "ug/m3", threshold: 50 },
  ].filter((item) => Number.isFinite(item.value) && item.value > 0);
}

function chemistryRatio(item) {
  return clamp(item.value / Math.max(item.threshold, 1), 0, 2);
}

function chemistryColor(item) {
  const ratio = chemistryRatio(item);
  if (ratio < 0.5) return "var(--mint)";
  if (ratio < 1.0) return "var(--amber)";
  if (ratio < 1.4) return "var(--orange)";
  return "var(--red)";
}

function weatherMapLinks(d) {
  if (!hasLocationFix(d)) return null;
  const lat = num(d.lat);
  const lon = num(d.lon);
  const dx = 0.09;
  const dy = 0.06;
  const bbox = `${(lon - dx).toFixed(4)},${(lat - dy).toFixed(4)},${(lon + dx).toFixed(4)},${(lat + dy).toFixed(4)}`;
  return {
    embed: `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${lat.toFixed(4)},${lon.toFixed(4)}`,
    open: `https://www.openstreetmap.org/?mlat=${lat.toFixed(4)}&mlon=${lon.toFixed(4)}#map=11/${lat.toFixed(4)}/${lon.toFixed(4)}`,
  };
}

function setMapLayerStatus(_text) {
  // no-op: layer status element removed from UI
}

// RainViewer infrared satellite tiles — CORS-enabled, updates ~every 10 minutes.
// Same tile infrastructure as the radar layer, so no new vendor dependency.
const RAINVIEWER_SAT_TILE_URL =
  "https://tilecache.rainviewer.com/v2/satellite/{z}/{x}/{y}/2/1_1.png";

function ensureSatelliteLayer() {
  if (mapLayers.satellite) return mapLayers.satellite;
  if (!window.L) return null;
  mapLayers.satellite = window.L.tileLayer(RAINVIEWER_SAT_TILE_URL, {
    opacity: 0.5,
    attribution: "Satellite &copy; RainViewer",
    maxNativeZoom: 6,
    maxZoom: 18,
    minZoom: 2,
    crossOrigin: true,
  });
  return mapLayers.satellite;
}

// NWS active weather alerts (watches/warnings/advisories) via the CORS-enabled
// NWS public API — the ArcGIS tile service does not send CORS headers and is
// blocked by browsers. The REST API returns GeoJSON and supports CORS.
let nwsAlertsState = { fetchedAt: 0, data: null };
// Tracks the data object currently rendered into mapLayers.hazards so we can
// avoid a redundant clearLayers/addData when the cached reference is unchanged.
let nwsAlertsLastRendered = null;
const NWS_ALERTS_TTL_MS = 5 * 60 * 1000;
const NWS_ALERTS_URL = "https://api.weather.gov/alerts/active?area=FL";

function nwsAlertColor(feature) {
  const event = (feature?.properties?.event || "").toLowerCase();
  if (event.includes("warning")) return "#ff3b30";
  if (event.includes("watch")) return "#ff9500";
  return "#ffcc00";
}

async function fetchNWSAlerts() {
  const now = Date.now();
  if (nwsAlertsState.data && now - nwsAlertsState.fetchedAt < NWS_ALERTS_TTL_MS) {
    return nwsAlertsState.data;
  }
  try {
    const res = await fetch(NWS_ALERTS_URL, {
      headers: { Accept: "application/geo+json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`nws alerts ${res.status}`);
    const data = await res.json();
    nwsAlertsState = { fetchedAt: now, data };
  } catch (_) {
    if (!nwsAlertsState.data) nwsAlertsState = { fetchedAt: now, data: null };
  }
  return nwsAlertsState.data;
}

async function ensureHazardsLayer() {
  if (!window.L) return null;
  const data = await fetchNWSAlerts();
  if (!data) return null;
  if (!mapLayers.hazards) {
    mapLayers.hazards = window.L.geoJSON(data, {
      style: (feature) => ({
        color: nwsAlertColor(feature),
        weight: 2,
        fillColor: nwsAlertColor(feature),
        fillOpacity: 0.18,
        opacity: 0.85,
      }),
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const headline = p.headline || p.event || "Weather Alert";
        const expires = p.expires ? new Date(p.expires).toLocaleString() : "";
        layer.bindPopup(
          `<strong>${escapeHtml(headline)}</strong>${expires ? `<br><small>Expires: ${escapeHtml(expires)}</small>` : ""}`
        );
      },
    });
    nwsAlertsLastRendered = data;
  } else if (nwsAlertsLastRendered !== data) {
    // fetchNWSAlerts preserves the same object reference while data is cached,
    // so this only runs when the TTL expires and a fresh fetch returns new data.
    mapLayers.hazards.clearLayers();
    mapLayers.hazards.addData(data);
    nwsAlertsLastRendered = data;
  }
  return mapLayers.hazards;
}

function renderMapLayerButtons() {
  const rainBtn = $("map-layer-rain");
  const satBtn = $("map-layer-satellite");
  if (rainBtn) {
    rainBtn.classList.toggle("is-active", mapLayerActive.rain);
    rainBtn.onclick = () => {
      mapLayerActive.rain = !mapLayerActive.rain;
      if (!mapLayerActive.rain) stopRadarAnim();
      syncMapLayers();
      renderMapLayerButtons();
    };
  }
  if (satBtn) {
    satBtn.classList.toggle("is-active", mapLayerActive.satellite);
    satBtn.onclick = async () => {
      mapLayerActive.satellite = !mapLayerActive.satellite;
      await syncMapLayers();
      renderMapLayerButtons();
    };
  }
  // Hazards button toggles NWS watch/warning/advisory tile layer
  const hazardsBtn = $("map-layer-hazards");
  if (hazardsBtn) {
    hazardsBtn.classList.toggle("is-active", mapLayerActive.hazards);
    hazardsBtn.onclick = async () => {
      mapLayerActive.hazards = !mapLayerActive.hazards;
      await syncMapLayers();
      renderMapLayerButtons();
    };
  }
  // Wind button just toggles wind badge visibility
  const windBtn = $("map-layer-wind");
  const windBadge = $("map-wind-badge");
  if (windBtn) {
    windBtn.onclick = () => {
      if (windBadge) windBadge.style.display = windBadge.style.display === "none" ? "" : "none";
      windBtn.classList.toggle("is-active");
    };
  }
  // Animate button cycles through radar past frames
  const animBtn = $("map-layer-animate");
  if (animBtn) {
    animBtn.classList.toggle("is-active", radarAnimState.playing);
    animBtn.onclick = async () => {
      if (radarAnimState.playing) {
        stopRadarAnim();
      } else {
        // Ensure radar is on and frames loaded
        if (!mapLayerActive.rain) {
          mapLayerActive.rain = true;
          await syncMapLayers();
          renderMapLayerButtons();
        }
        if (!radarAnimState.frames.length) await fetchRainViewerTileUrl();
        startRadarAnim();
        renderMapLayerButtons();
      }
    };
  }
}

async function fetchRainViewerTileUrl() {
  const now = Date.now();
  const prevUrl = rainViewerState.tileUrl;
  if (prevUrl && now - rainViewerState.fetchedAt < 5 * 60 * 1000) {
    return prevUrl;
  }

  try {
    const res = await fetch("https://api.rainviewer.com/public/weather-maps.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`radar ${res.status}`);
    const data = await res.json();
    const pastFrames = data?.radar?.past;
    const host = data?.host;
    if (!Array.isArray(pastFrames) || !pastFrames.length || !host) throw new Error("missing radar frame");
    // Store all frames for animation
    radarAnimState.frames = pastFrames.map(f => ({ path: f.path, time: f.time }));
    radarAnimState.host = host;
    radarAnimState.frameIndex = radarAnimState.frames.length - 1; // start at latest
    const frame = pastFrames[pastFrames.length - 1];
    const newUrl = `${host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;
    rainViewerState = { fetchedAt: now, tileUrl: newUrl };
    // Live-update the existing radar layer when the URL changes (keeps radar current)
    if (newUrl !== prevUrl && mapLayers.radar && !radarAnimState.playing) {
      mapLayers.radar.setUrl(newUrl);
    }
  } catch (_) {
    if (!rainViewerState.tileUrl) {
      rainViewerState = { fetchedAt: now, tileUrl: "" };
    }
  }

  return rainViewerState.tileUrl;
}

async function ensureRadarLayer() {
  if (mapLayers.radar) return mapLayers.radar;
  if (!window.L) return null;
  const tileUrl = await fetchRainViewerTileUrl();
  if (!tileUrl) return null;

  mapLayers.radar = window.L.tileLayer(tileUrl, {
    opacity: 0.65,
    attribution: "Radar © RainViewer",
    maxNativeZoom: 8,
    maxZoom: 18,
  });
  return mapLayers.radar;
}

function radarAnimTick(nowMs) {
  if (!radarAnimState.playing || !weatherMap || !mapLayers.radar) return;
  if (nowMs - radarAnimState.lastFrameTs >= radarAnimState.FRAME_INTERVAL_MS) {
    radarAnimState.lastFrameTs = nowMs;
    radarAnimState.frameIndex = (radarAnimState.frameIndex + 1) % radarAnimState.frames.length;
    const frame = radarAnimState.frames[radarAnimState.frameIndex];
    if (frame && radarAnimState.host) {
      const newUrl = `${radarAnimState.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;
      mapLayers.radar.setUrl(newUrl);
      // Update timestamp label
      const tsEl = $("map-radar-ts");
      if (tsEl && frame.time) {
        const d = new Date(frame.time * 1000);
        tsEl.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
    }
  }
  radarAnimState.rafId = requestAnimationFrame(radarAnimTick);
}

function startRadarAnim() {
  if (radarAnimState.playing) return;
  if (!radarAnimState.frames.length) return;
  radarAnimState.playing = true;
  radarAnimState.lastFrameTs = 0;
  radarAnimState.rafId = requestAnimationFrame(radarAnimTick);
  const btn = $("map-layer-animate");
  if (btn) btn.classList.add("is-active");
}

function stopRadarAnim() {
  radarAnimState.playing = false;
  if (radarAnimState.rafId) {
    cancelAnimationFrame(radarAnimState.rafId);
    radarAnimState.rafId = 0;
  }
  // Restore to latest frame
  if (radarAnimState.frames.length && radarAnimState.host && mapLayers.radar) {
    radarAnimState.frameIndex = radarAnimState.frames.length - 1;
    const frame = radarAnimState.frames[radarAnimState.frameIndex];
    mapLayers.radar.setUrl(`${radarAnimState.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`);
    const tsEl = $("map-radar-ts");
    if (tsEl) tsEl.textContent = "";
  }
  const btn = $("map-layer-animate");
  if (btn) btn.classList.remove("is-active");
}

function ensureWeatherMap() {
  if (weatherMap || !window.L) return weatherMap;
  const el = $("weather-map");
  // Guard: skip initialization when the container is hidden (zero-size).
  // setDashboardView retries in its RAF callback once the card is visible.
  if (!el || el.offsetWidth === 0) return null;

  weatherMap = window.L.map(el, {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
  });
  window.L.control.zoom({ position: "topright" }).addTo(weatherMap);
  weatherBaseLayer = window.L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; <a href='https://carto.com/'>CARTO</a> &copy; OpenStreetMap contributors",
    subdomains: ["a", "b", "c", "d"],
    maxZoom: 19,
  }).addTo(weatherMap);

  weatherMarker = window.L.circleMarker([CAPE_MAP_LAT, CAPE_MAP_LON], {
    radius: 7,
    color: "rgba(9, 12, 16, 0.92)",
    weight: 2,
    fillColor: "#00f2ff",
    fillOpacity: 0.95,
  }).addTo(weatherMap);

  // Add named launch pad markers for CCSFS/KSC context
  CCSFS_PADS.forEach((pad) => {
    window.L.circleMarker([pad.lat, pad.lon], {
      radius: 6,
      color: "rgba(9, 12, 16, 0.92)",
      weight: 2,
      fillColor: "#ff9500",
      fillOpacity: 0.90,
    }).bindTooltip(pad.name, { permanent: false, direction: "top" }).addTo(weatherMap);
  });

  weatherMap.setView([CAPE_MAP_LAT, CAPE_MAP_LON], 12);
  renderMapLayerButtons();
  syncMapLayers(); // start loading rain radar layer immediately (async, fire-and-forget)
  return weatherMap;
}

async function syncMapLayers() {
  if (!weatherMap) return;

  // Refresh radar URL from RainViewer (cache-backed at 5 min).
  await fetchRainViewerTileUrl();

  const radarLayer = await ensureRadarLayer();
  if (radarLayer) {
    if (mapLayerActive.rain && !weatherMap.hasLayer(radarLayer)) radarLayer.addTo(weatherMap);
    else if (!mapLayerActive.rain && weatherMap.hasLayer(radarLayer)) weatherMap.removeLayer(radarLayer);
  }
  const satLayer = ensureSatelliteLayer();
  if (satLayer) {
    if (mapLayerActive.satellite && !weatherMap.hasLayer(satLayer)) satLayer.addTo(weatherMap);
    else if (!mapLayerActive.satellite && weatherMap.hasLayer(satLayer)) weatherMap.removeLayer(satLayer);
  }
  if (mapLayerActive.hazards) {
    const hazardsLayer = await ensureHazardsLayer();
    if (hazardsLayer && !weatherMap.hasLayer(hazardsLayer)) hazardsLayer.addTo(weatherMap);
  } else if (mapLayers.hazards && weatherMap.hasLayer(mapLayers.hazards)) {
    weatherMap.removeLayer(mapLayers.hazards);
  }
}

// Default map location: LC-36, Cape Canaveral Space Force Station, FL
const CAPE_MAP_LAT = 28.4861;
const CAPE_MAP_LON = -80.5450;

// CCSFS and KSC active launch complex markers
const CCSFS_PADS = [
  { name: "LC-36 — Cape Canaveral", lat: 28.4861, lon: -80.5450 },
  { name: "SLC-40 — SpaceX Falcon 9", lat: 28.5619, lon: -80.5774 },
  { name: "SLC-41 — ULA Vulcan Centaur", lat: 28.5832, lon: -80.5830 },
  { name: "LC-39A — SpaceX Falcon Heavy / Crew Dragon", lat: 28.6083, lon: -80.6041 },
  { name: "LC-39B — NASA Artemis / SLS", lat: 28.6272, lon: -80.6208 },
];

function syncWeatherMapPosition(d) {
    const map = ensureWeatherMap();
    const fallback = $("map-fallback");
    if (!map) {
        if (fallback) fallback.style.display = "flex";
        setMapLayerStatus("Map engine unavailable in this browser.");
        return;
    }

    // Always show the map — use device GPS when available, otherwise default to
    // Cape Canaveral so live weather layers are visible without a GPS fix.
    if (fallback) fallback.style.display = "none";

    const lat = hasLocationFix(d) ? num(d.lat) : CAPE_MAP_LAT;
    const lon = hasLocationFix(d) ? num(d.lon) : CAPE_MAP_LON;
    const label = hasLocationFix(d)
        ? (d.city || "SniffMaster location")
        : "LC-36, Cape Canaveral, FL (default)";
    const target = [lat, lon];
    if (weatherMarker) {
        weatherMarker.setLatLng(target);
        weatherMarker.bindTooltip(`${escapeHtml(label)}<br>${lat.toFixed(4)}, ${lon.toFixed(4)}`);
    }

    const center = weatherMap.getCenter();
    const drift = Math.abs(center.lat - lat) + Math.abs(center.lng - lon);
    if (drift > 0.04) {
        weatherMap.setView(target, 12);
    }

    // Update wind badge on map overlay
    const windBadge = $("map-wind-badge");
    if (windBadge) {
        const windSpd = num(d.windSpeed || d.weatherWindSpeed, NaN);
        const windDir = d.windDir || d.weatherWindDir || "";
        if (Number.isFinite(windSpd) && windSpd > 0) {
            windBadge.textContent = `💨 ${Math.round(windSpd)} mph${windDir ? ` ${windDir}` : ""}`;
            windBadge.style.display = "";
        } else {
            windBadge.style.display = "none";
        }
    }
}

function weatherInsightText(d) {
  const temp = num(d.tempF);
  const feels = num(d.feelsLikeF, temp);
  const humidity = num(d.humidity);
  const dew = dewPointF(temp, humidity);
  const delta = Math.round(feels - temp);
  const outdoorLine = num(d.outdoorAqi) > 0
    ? `Outdoor air is ${d.outdoorLevel || "active"} with AQI ${Math.round(num(d.outdoorAqi))}.`
    : "Outdoor chemistry has not posted yet, so window advice is using the last indoor context only.";
  const heatLine = Number.isFinite(num(d.deathValleyTempF, NaN))
    ? `For perspective, this location is ${heatBenchmark(d).toLowerCase()} right now.`
    : "";
  const feelLine = Math.abs(delta) >= 2
    ? `It feels ${Math.abs(delta)}F ${delta > 0 ? "warmer" : "cooler"} than the raw temperature.`
    : "The air feels close to the measured temperature.";

  return `${d.city || "This location"} is reading ${temp.toFixed(0)}F with ${humidity.toFixed(0)}% humidity, so the room-side comfort read is ${dewComfort(dew)}. ${feelLine} ${outdoorLine} ${windowCall(d)}. ${pressureRead(num(d.pressHpa))}. ${heatLine}`.trim();
}

function weatherBriefingKey(d) {
  // Now that the weather API uses device GPS when available, include a coarse
  // location bucket in the key so a new briefing is fetched when location changes
  // significantly (rounds to ~0.5° ~ 35 miles to avoid excessive re-fetches).
  const bucket = Math.floor(Date.now() / WEATHER_BRIEFING_TTL_MS);
  if (d && hasLocationFix(d)) {
    const latBucket = Math.round(num(d.lat) * 2);
    const lonBucket = Math.round(num(d.lon) * 2);
    return `loc|${latBucket}|${lonBucket}|${bucket}`;
  }
  return `cape-canaveral|${bucket}`;
}

function defaultWeatherBriefing(d) {
  return {
    mode: "deterministic",
    summary: "Local forecast guidance pending",
    briefing: `${windowCall(d)}. Current outdoor context is ${d.weatherCondition || "still syncing"}, and the dashboard will upgrade this note once a forecast model is available.`,
    forecast: [],
    sourceCaption: "Source: device weather snapshot · local ventilation heuristics · OpenStreetMap map · RainViewer radar · NOAA GOES-East satellite · NWS hazards",
  };
}

function renderConditionsSummary(d, briefing) {
  const summaryEl = $("conditions-summary-text");
  const modeEl = $("conditions-summary-mode");
  if (!summaryEl) return;

  const iaq = num(d.iaq, NaN);
  const co2 = num(d.co2, NaN);
  const tempF = num(d.tempF, NaN);
  const humidity = num(d.humidity, NaN);
  const outdoorAqi = num(d.outdoorAqi, NaN);

  const indoorParts = [];
  if (Number.isFinite(iaq)) {
    indoorParts.push(`IAQ ${Math.round(iaq)}${iaq < 50 ? " (good)" : iaq < 100 ? " (moderate)" : " (elevated)"}`);
  }
  if (Number.isFinite(co2)) {
    indoorParts.push(`CO₂eq ${Math.round(co2)} ppm${co2 > 1000 ? " ⚠" : ""}`);
  }
  if (Number.isFinite(tempF) && Number.isFinite(humidity)) {
    indoorParts.push(`${Math.round(tempF)}°F · ${Math.round(humidity)}% RH`);
  }
  if (Number.isFinite(outdoorAqi)) {
    indoorParts.push(`Outdoor AQI ${Math.round(outdoorAqi)}`);
  }

  if (briefing?.briefing) {
    const indoor = indoorParts.length ? `Indoor: ${indoorParts.join(", ")}. ` : "";
    summaryEl.textContent = `${indoor}${briefing.briefing}`;
    summaryEl.dataset.snmFilled = "1";
    if (modeEl) {
      modeEl.textContent = briefing.mode === "openai" ? "Smart brief · OpenAI" : "Deterministic · Local forecast logic";
    }
  } else if (indoorParts.length) {
    summaryEl.textContent = `${indoorParts.join(" · ")}. Forecast data is still loading.`;
    summaryEl.dataset.snmFilled = "1";
    if (modeEl) modeEl.textContent = "Sensor data only";
  } else {
    // Only reset to placeholder if never populated with real data
    if (!summaryEl.dataset.snmFilled) {
      summaryEl.textContent = "Conditions summary will appear once the dashboard has a weather snapshot.";
      if (modeEl) modeEl.textContent = "Awaiting data";
    }
  }
}

function renderWeatherForecast(d, briefing) {
  const payload = briefing || defaultWeatherBriefing(d);
  const summaryEl = $("weather-forecast-summary");
  const gridEl = $("weather-forecast-grid");
  const textEl = $("weather-briefing-text");
  const modeEl = $("weather-briefing-mode");
  const sourceEl = $("source-weather");

  if (textEl) textEl.textContent = payload.briefing || defaultWeatherBriefing(d).briefing;
  if (modeEl) {
    modeEl.textContent = payload.mode === "openai"
      ? "Smart brief · OpenAI"
      : "Deterministic local forecast logic";
  }
  if (summaryEl) summaryEl.textContent = payload.summary || "Forecast guidance pending";
  if (sourceEl) {
    sourceEl.textContent = payload.sourceCaption || "Source: device weather snapshot · Open-Meteo forecast · OpenStreetMap map · RainViewer radar · NOAA GOES-East satellite · NWS hazards";
  }

  if (!gridEl) return;
  const forecast = Array.isArray(payload.forecast) ? payload.forecast.slice(0, 3) : [];
  if (!forecast.length) {
    // Only reset to placeholder state if tiles have never been populated with real data
    if (!gridEl.dataset.snmFilled) {
      gridEl.innerHTML = `
        <div class="forecast-tile">
          <div class="forecast-day">Day 1</div>
          <div class="forecast-condition">Awaiting forecast</div>
          <div class="forecast-temps">-- / --</div>
          <div class="forecast-meta">Precip -- · Wind --</div>
        </div>
        <div class="forecast-tile">
          <div class="forecast-day">Day 2</div>
          <div class="forecast-condition">Awaiting forecast</div>
          <div class="forecast-temps">-- / --</div>
          <div class="forecast-meta">Precip -- · Wind --</div>
        </div>
        <div class="forecast-tile">
          <div class="forecast-day">Day 3</div>
          <div class="forecast-condition">Awaiting forecast</div>
          <div class="forecast-temps">-- / --</div>
          <div class="forecast-meta">Precip -- · Wind --</div>
        </div>
      `;
    }
    return;
  }

  gridEl.innerHTML = forecast.map((day) => `
    <div class="forecast-tile">
      <div class="forecast-day">${escapeHtml(day.label || "Forecast")}</div>
      <div class="forecast-condition">${escapeHtml(day.condition || "Conditions pending")}</div>
      <div class="forecast-temps">${Number.isFinite(num(day.highF, NaN)) ? `${Math.round(num(day.highF))}F` : "--"} / ${Number.isFinite(num(day.lowF, NaN)) ? `${Math.round(num(day.lowF))}F` : "--"}</div>
      <div class="forecast-meta">Precip ${Math.round(num(day.precipChance, 0))}% · Wind ${Math.round(num(day.windMph, 0))} mph</div>
    </div>
  `).join("");
  gridEl.dataset.snmFilled = "1";
}

async function ensureWeatherBriefing(d) {
  if (!d) return;

  const key = weatherBriefingKey(d);
  const cached = weatherBriefingState.data
    && weatherBriefingState.key === key
    && Date.now() - weatherBriefingState.fetchedAt < WEATHER_BRIEFING_TTL_MS;

  // render() already applied mergeBriefingIntoSnapshot, so no extra work on cache hit.
  if (cached) return;

  if (weatherBriefingState.pending) return;

  weatherBriefingState.pending = (async () => {
    try {
      const res = await fetch("/api/weather-briefing", { cache: "no-store" });
      if (!res.ok) throw new Error(`weather-briefing ${res.status}`);
      weatherBriefingState.data = await res.json();
      weatherBriefingState.fetchedAt = Date.now();
      weatherBriefingState.key = key;
    } catch (_) {
      // silent — render will fall back to snapshot fields
    } finally {
      weatherBriefingState.pending = null;
    }

    // Fresh briefing just arrived — merge it into lastData and re-render the affected panels.
    if (lastData) {
      const briefing = weatherBriefingState.data;
      lastData = mergeBriefingIntoSnapshot(lastData, briefing);
      renderWeatherForecast(lastData, briefing);
      renderConditionsSummary(lastData, briefing);
      renderWeatherIntel(lastData);
      $("weather-report").innerHTML = renderStructuredReport(buildWeatherReport(lastData, briefing));
    }
  })();
}

const OCCUPANCY_BRIEFING_TTL_MS = 10 * 60 * 1000; // 10 minutes

function renderOccupancyCard(payload) {
  if (!payload) return;
  const index = num(payload.occupancyIndex, NaN);
  const deviceCount = num(payload.deviceCount, NaN);
  const isCo2Source = payload.source === "co2";

  setHeaderPill("occupancy-badge", payload.densityLabel || "Space density", "neutral");

  const indexEl = $("occupancy-index-value");
  if (indexEl) indexEl.textContent = Number.isFinite(index) ? `${Math.round(index)}` : "--";

  const labelEl = $("occupancy-density-label");
  if (labelEl) labelEl.textContent = payload.densityLabel || "Waiting";

  const noteEl = $("occupancy-density-note");
  if (noteEl) noteEl.textContent = payload.densityNote || "Space density will appear once sensor data arrives.";

  const fillEl = $("occupancy-index-fill");
  if (fillEl && Number.isFinite(index)) {
    fillEl.style.width = `${clamp(index, 0, 100)}%`;
    fillEl.style.background = index < 25 ? "var(--mint)"
      : index < 55 ? "var(--lime)"
      : index < 80 ? "var(--amber)"
      : "var(--red)";
  }

  // Right panel kicker: relabel based on source
  const kickerEl = $("occupancy-signal-kicker");
  if (kickerEl) kickerEl.textContent = isCo2Source ? "CO₂ Reading" : "Signal Quality";

  const rssiEl = $("occupancy-rssi-badge");
  if (rssiEl) {
    if (isCo2Source && payload.co2Reading) {
      rssiEl.textContent = `${payload.co2Reading} ppm CO₂`;
    } else {
      const rssi = num(payload.avgRssi, NaN);
      if (Number.isFinite(rssi)) {
        const quality = rssi > -60 ? "Excellent" : rssi > -70 ? "Good" : rssi > -80 ? "Fair" : "Weak";
        rssiEl.textContent = `${Math.round(rssi)} dBm — ${quality}`;
      } else {
        rssiEl.textContent = "--";
      }
    }
  }

  const countEl = $("occupancy-device-count");
  if (countEl) {
    if (isCo2Source) {
      const co2 = payload.co2Reading || 0;
      if (co2 > 0) {
        const estAbove = Math.max(0, co2 - 400);
        // ~50 ppm noise floor to avoid showing "1 person" from minor fluctuation;
        // ~80 ppm rise per person is a rough occupancy-physiology rule of thumb.
        const estPeople = estAbove < 50 ? 0 : Math.round(estAbove / 80);
        countEl.textContent = estPeople === 0
          ? "CO₂ near ambient — space likely empty or very well-ventilated."
          : `~${estPeople} ${estPeople === 1 ? "person" : "people"} estimated from CO₂ rise above ambient`;
      } else {
        countEl.textContent = "Waiting for CO₂ reading.";
      }
    } else if (Number.isFinite(deviceCount)) {
      const estPeople = Math.max(1, Math.round(deviceCount / 1.5));
      countEl.textContent = deviceCount === 0
        ? "No devices detected — space appears empty."
        : `${deviceCount} device${deviceCount !== 1 ? "s" : ""} detected · ~${estPeople} ${estPeople === 1 ? "person" : "people"} estimated`;
    } else {
      countEl.textContent = "Waiting for first reading.";
    }
  }

  const trendEl = $("occupancy-trend-note");
  if (trendEl && payload.trend) {
    const { direction, delta } = payload.trend;
    const sign = delta > 0 ? "+" : "";
    trendEl.textContent = direction === "stable"
      ? "Occupancy is holding steady."
      : `Occupancy is ${direction} (${sign}${Math.round(delta)} points since last read).`;
  }

  const briefingEl = $("occupancy-briefing");
  if (briefingEl && payload.briefing) briefingEl.textContent = payload.briefing;

  const sourceEl = $("occupancy-source");
  if (sourceEl) {
    const modeNote = payload.mode === "openai" ? "OpenAI occupancy insight" : "deterministic occupancy logic";
    const sensorNote = isCo2Source
      ? "CO₂ proxy · index = (co2 − 400) / 12, saturates at 1 600 ppm"
      : "device passive scan · MAC deduplication · 30-second rolling window";
    sourceEl.textContent = `Source: ${sensorNote} · ${modeNote}`;
  }

  const chartEl = $("occupancy-bar-chart");
  if (chartEl && Array.isArray(payload.history) && payload.history.length > 0) {
    const history = payload.history.slice(0, 24).reverse();
    const maxIdx = Math.max(...history.map((h) => num(h.occupancyIndex, 0)), 1);
    const barTitle = isCo2Source
      ? (h) => `${h.co2 ? `CO₂ ${Math.round(h.co2)} ppm · ` : ""}index ${Math.round(num(h.occupancyIndex, 0))}`
      : (h) => `index ${Math.round(num(h.occupancyIndex, 0))}`;
    const densityText = (idx) => idx >= 80 ? "Packed" : idx >= 55 ? "Busy" : idx >= 25 ? "Moderate" : idx >= 5 ? "Low" : "Empty";
    chartEl.innerHTML = `<div class="occupancy-bar-grid">${history.map((h) => {
      const idx = num(h.occupancyIndex, 0);
      const pct = clamp((idx / maxIdx) * 100, 2, 100);
      const color = idx >= 80 ? "var(--red)" : idx >= 55 ? "var(--amber)" : idx >= 25 ? "var(--lime)" : "var(--mint)";
      return `<div class="occupancy-bar-col" title="${densityText(idx)} (${barTitle(h)})">
        <div class="occupancy-bar-fill" style="height:${pct}%;background:${color}"></div>
      </div>`;
    }).join("")}</div>`;
  }
}

async function ensureOccupancyBriefing() {
  const cached = occupancyBriefingState.data
    && Date.now() - occupancyBriefingState.fetchedAt < OCCUPANCY_BRIEFING_TTL_MS;
  if (cached) {
    renderOccupancyCard(occupancyBriefingState.data);
    return;
  }
  if (occupancyBriefingState.pending) return;

  occupancyBriefingState.pending = (async () => {
    try {
      const res = await fetch("/api/occupancy-briefing", { cache: "no-store" });
      if (res.status === 204) return;
      if (!res.ok) throw new Error(`occupancy-briefing ${res.status}`);
      occupancyBriefingState.data = await res.json();
      occupancyBriefingState.fetchedAt = Date.now();
      renderOccupancyCard(occupancyBriefingState.data);
    } catch (_) {
      // silent — card stays in standby state
    } finally {
      occupancyBriefingState.pending = null;
    }
  })();
}

const LAUNCH_TTL_MS = 60 * 60 * 1000; // 1 hour
const APOD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function ensureLaunchData() {
  // Use fetchedAt (not data) as the cache sentinel so an empty-launch response also
  // prevents re-fetching for the full TTL window.
  const cached = launchState.fetchedAt > 0 && Date.now() - launchState.fetchedAt < LAUNCH_TTL_MS;
  if (cached) return;
  if (launchState.pending) return;

  launchState.pending = (async () => {
    try {
      const res = await fetch("/api/launches", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        launchState.fetchedAt = Date.now(); // always stamp, even for empty results
        if (Array.isArray(json?.launches) && json.launches.length) {
          launchState.data = json.launches;
          // Merge into lastData if device snapshot has no launches
          if (lastData && !(Array.isArray(lastData.launches) && lastData.launches.length)) {
            lastData = { ...lastData, launches: launchState.data };
            renderSpaceCard(lastData);
            renderLaunchDeck(lastData);
            setHeaderPill("launch-badge", `${launchState.data.length} Cape launches`, "good");
          }
        }
      }
    } catch (_) {
      // silent — device data is the primary source
    } finally {
      launchState.pending = null;
    }
  })();
}

async function ensureApod() {
  const cached = apodState.fetchedAt > 0 && Date.now() - apodState.fetchedAt < APOD_TTL_MS;
  if (cached) return;
  if (apodState.pending) return;

  apodState.pending = (async () => {
    try {
      const res = await fetch("/api/apod", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        apodState.fetchedAt = Date.now();
        apodState.data = json;
        renderApod(json);
      }
    } catch (_) {
      // silent — non-critical panel
    } finally {
      apodState.pending = null;
    }
  })();
}

function derivedEventTimestamp(d, uptimeKey) {
  const receivedAt = num(d.receivedAt, NaN);
  const uptime = num(d.uptime, NaN);
  const eventUptime = num(d[uptimeKey], NaN);
  if (!Number.isFinite(receivedAt) || !Number.isFinite(uptime) || !Number.isFinite(eventUptime) || eventUptime > uptime) {
    return 0;
  }
  return Math.round(receivedAt - (uptime - eventUptime) * 1000);
}

function roomSummary(d) {
  const score = num(d.airScore);
  if (score < 15 && !hasConfidentPrimary(d)) return "Clean room, low drama, sensor happy.";
  if (hasConfidentPrimary(d)) {
    const primary = primaryNarrative(d);
    if (score < 30) return `Mostly fresh room with ${primary} in the mix.`;
    if (score < 50) return `Some activity in the air, led by ${primary}.`;
    if (score < 70) return `The room is getting noisy; ${primary} is part of it.`;
    return `Air quality is struggling and ${primary} is the lead suspect.`;
  }
  if (score < 30) return "Mostly fresh room with no dominant odor signal.";
  if (score < 50) return "Some activity is building, but no odor class has taken the lead.";
  if (score < 70) return "The room is getting noisy, though this looks more like mixed VOC buildup than one clear smell.";
  return "Air quality is struggling, but the classifier does not see one dominant odor. This looks more like diffuse VOC buildup.";
}

function eventKey(timestamp, tag, title) {
  return `${Math.round(num(timestamp))}:${tag}:${title}`;
}

function roomBand(score) {
  if (score < 15) return "pristine";
  if (score < 30) return "fresh";
  if (score < 50) return "normal";
  if (score < 70) return "elevated";
  if (score < 85) return "poor";
  return "hazard";
}

function buildEventLogEntries(current, history, sniffHistory) {
  const events = [];
  const seen = new Set();

  const pushEvent = (event) => {
    if (!event || !Number.isFinite(num(event.timestamp, NaN))) return;
    const key = eventKey(event.timestamp, event.tag, event.title);
    if (seen.has(key)) return;
    seen.add(key);
    events.push(event);
  };

  (sniffHistory || []).forEach((item) => {
    pushEvent({
      timestamp: item.receivedAt,
      tag: "Sulfur",
      tone: num(item.vsc_conf) >= 85 ? "danger" : "warn",
      title: `${item.label || "High Sulfur"} priority event`,
      detail: `VSC proxy hit ${Math.round(num(item.vsc_conf))}% with IAQ ${Math.round(num(item.iaq))}.`,
    });
  });

  const ordered = (history || []).slice().reverse();
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    const prevBand = roomBand(num(prev.airScore));
    const currBand = roomBand(num(curr.airScore));
    if (prevBand !== currBand) {
      const improved = num(curr.airScore) < num(prev.airScore);
      pushEvent({
        timestamp: curr.receivedAt,
        tag: "Room",
        tone: airScoreTone(num(curr.airScore)),
        title: `Room quality ${improved ? "shifted cleaner" : "slid worse"} to ${airScoreCondition(num(curr.airScore))}`,
        detail: airScoreMeaning(num(curr.airScore)),
      });
    }

    const prevPrimary = hasConfidentPrimary(prev) ? prev.primary : "";
    const currPrimaryName = hasConfidentPrimary(curr) ? curr.primary : "";
    if (currPrimaryName && currPrimaryName !== prevPrimary) {
      pushEvent({
        timestamp: curr.receivedAt,
        tag: "Odor",
        tone: num(curr.primaryConf) >= 55 ? "warn" : "neutral",
        title: `${currPrimaryName} took the lead`,
        detail: `Classifier confidence reached ${Math.round(num(curr.primaryConf))}% with room score ${Math.round(num(curr.airScore))}/100.`,
      });
    }
  }

  return events
    .sort((a, b) => num(b.timestamp) - num(a.timestamp))
    .slice(0, 10);
}

function fartSignals(d) {
  const odors = d.odors || [];
  return {
    fart: num(odors[0]),
    garbage: num(odors[10]),
    sulfur: num(odors[14]),
    pet: num(odors[16]),
  };
}

function breathProxy(d) {
  const alcohol = num((d.odors || [])[3]);
  const voc = num(d.voc);
  const iaq = num(d.iaq);

  let verdict = "Ambient breath check idle";
  let tone = "good";
  if (alcohol > 60 || (voc > 6 && iaq > 200)) {
    verdict = "Strong alcohol / rough breath signal";
    tone = "danger";
  } else if (alcohol > 30 || (voc > 3 && iaq > 125)) {
    verdict = "Moderate alcohol / stale breath signal";
    tone = "warn";
  } else if (alcohol > 12 || voc > 1.5 || iaq > 75) {
    verdict = "Mild breath activity";
    tone = "neutral";
  }

  return { alcohol, voc, iaq, verdict, tone };
}

function buildMissionReport(d) {
  const lines = [];
  const activeSniff = activeSniffEvent();
  lines.push("--- ROOM SUMMARY ---");
  lines.push(`Condition: ${d.hazard || iaqLabel(num(d.iaq))}`);
  lines.push(`Primary signal: ${currentPrimary(d, "No dominant odor")}`);
  lines.push(`Room quality: ${Math.round(num(d.airScore))}/100 (lower is better)`);
  lines.push("");
  lines.push("--- NEXT STEP ---");
  lines.push(windowCall(d));
  lines.push("");
  lines.push("--- STATUS ---");
  lines.push(`${d.calibration || `Accuracy ${num(d.iaqAcc)}/3`} · Updated ${num(d.receivedAt) ? fmtAge(d.receivedAt) : "waiting"}`);
  if (activeSniff) {
    lines.push(`Priority sulfur watch: ${activeSniff.label} at ${Math.round(num(activeSniff.vsc_conf))}%`);
  }
  return lines.join("\n");
}

function buildWeatherReport(d, briefing = weatherBriefingState.data) {
  const lines = [];
  const temp = num(d.tempF);
  const feels = num(d.feelsLikeF, temp);
  lines.push("--- OUTDOOR READ ---");
  lines.push(`${d.city || "Location pending"} · ${fmtLocationTime(d.receivedAt, d.utcOffsetSec)}`);
  lines.push(`${d.weatherCondition || "Conditions pending"} · ${temp.toFixed(0)}F`);
  lines.push(`Feels like ${feels.toFixed(0)}F · Humidity ${num(d.humidity).toFixed(0)}%`);
  lines.push(`Wind ${(d.windDir || "--")} ${(d.windSpeed || "").trim()}`.trim());
  lines.push(`Outdoor AQI ${num(d.outdoorAqi) > 0 ? `${Math.round(num(d.outdoorAqi))} ${d.outdoorLevel || ""}`.trim() : "pending"}`);
  lines.push("");
  lines.push("--- VENTILATION CALL ---");
  lines.push(windowCall(d));

  const forecast = Array.isArray(briefing?.forecast) ? briefing.forecast.slice(0, 3) : [];
  if (forecast.length) {
    lines.push("");
    lines.push("--- 3-DAY OUTLOOK ---");
    forecast.forEach((day) => {
      const high = Number.isFinite(num(day.highF, NaN)) ? `${Math.round(num(day.highF))}F` : "--";
      const low = Number.isFinite(num(day.lowF, NaN)) ? `${Math.round(num(day.lowF))}F` : "--";
      lines.push(`${day.label || "Forecast"}: ${day.condition || "Conditions pending"} · ${high}/${low} · ${Math.round(num(day.precipChance, 0))}% precip`);
    });
  }

  if (briefing?.briefing) {
    lines.push("");
    lines.push("--- LOCAL INSIGHT ---");
    lines.push(briefing.briefing);
  }
  return lines.join("\n");
}

function buildSpaceReport(d) {
  const lines = [];
  lines.push("--- CAPE STATUS ---");
  if (num(d.launchesYtd) > 0) {
    const yr = new Date().getFullYear();
    lines.push(`${Math.round(num(d.launchesYtd))} launches from KSC/CCSFS in ${yr}`);
  }

  const launches = Array.isArray(d.launches) ? d.launches : [];
  if (launches.length) {
    const first = launches[0];
    lines.push("");
    lines.push("--- NEXT WINDOW ---");
    lines.push(`${first.name || "Unknown mission"}`);
    lines.push(`NET ${first.time || "TBD"} · ${first.status || "--"}`);
    lines.push("Full provider, pad, and manifest details are in the launch cards below.");
  } else {
    lines.push("");
    lines.push("--- NEXT WINDOW ---");
    lines.push("No upcoming Cape launches in the current snapshot.");
  }

  lines.push("");
  lines.push("--- TODAY IN SPACE HISTORY ---");
  lines.push(d.spaceHistoryShort || "History unavailable");
  lines.push(d.spaceHistoryLong || "No history entry in current snapshot");
  if (d.spaceHistoryContext) {
    lines.push(d.spaceHistoryContext);
  }
  return lines.join("\n");
}

function buildOdorReport(d) {
  const lines = [];
  const signals = fartSignals(d);
  const odors = topOdors(d.odors, 4);
  const sniff = activeSniffEvent();

  lines.push("--- CURRENT CLASSIFICATION ---");
  lines.push(`${currentPrimary(d, "No dominant odor")} · ${Math.round(num(d.primaryConf))}% confidence`);
  lines.push("");
  lines.push("--- SIGNAL MIX ---");
  lines.push(`Stank Score: ${Math.round(vscProxyConfidence(d))}% sulfur proxy`);
  lines.push(`Bio channels: Fart ${signals.fart}% | Sulfur ${signals.sulfur}% | Garbage ${signals.garbage}% | Pet ${signals.pet}%`);
  if (sniff) {
    lines.push(`Priority event: ${sniff.label} ${fmtAge(sniff.receivedAt)}`);
  }
  lines.push("");
  lines.push("--- ROOM INTERPRETATION ---");
  lines.push(roomSummary(d));
  if (odors.length) {
    lines.push("");
    lines.push("--- TOP CHANNELS ---");
    odors.forEach((odor) => lines.push(`${odor.name}: ${odor.score}%`));
  }
  return lines.join("\n");
}

function formatDiagnosticReport(raw) {
  const text = `${raw || ""}`.trim();
  if (!text) {
    return '<div class="report-empty">No diagnostic output is available yet.</div>';
  }

  const sections = [];
  let current = null;
  text.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const heading = trimmed.match(/^---\s*(.*?)\s*---$/);
    if (heading) {
      if (current) sections.push(current);
      current = { heading: heading[1], lines: [] };
      return;
    }

    if (!current) current = { heading: "", lines: [] };
    current.lines.push(trimmed);
  });
  if (current) sections.push(current);

  if (!sections.length) {
    return `<div class="report-empty">${escapeHtml(text)}</div>`;
  }

  return sections.map((section) => `
    <section class="report-block">
      ${section.heading ? `<div class="report-kicker">${escapeHtml(section.heading)}</div>` : ""}
      ${section.lines.map((line) => {
        const bullet = line.startsWith("- ");
        const content = bullet ? line.slice(2) : line;
        return `<div class="report-line${bullet ? " is-bullet" : ""}">${escapeHtml(content)}</div>`;
      }).join("")}
    </section>
  `).join("");
}

function broBadgeInfo(d) {
  const bio = fartSignals(d);
  const bioPeak = Math.max(bio.fart, bio.sulfur, bio.garbage, bio.pet);
  const score = num(d.airScore);
  const vsc = vscProxyConfidence(d);
  if (vsc >= 70 || bioPeak >= 55 || score >= 70) return { text: "Needs work", tone: "danger" };
  if (bioPeak >= 30 || score >= 45) return { text: "Worth watching", tone: "warn" };
  return { text: "Looks solid", tone: "good" };
}

function broOpening(d) {
  const score = num(d.airScore);
  const bio = fartSignals(d);
  const bioPeak = Math.max(bio.fart, bio.sulfur, bio.garbage, bio.pet);
  const primary = primaryNarrative(d);
  const cfiPercent = officeCfiPercent(d);
  const vtrLevel = officeVtrLevel(d);

  if (vtrLevel >= 2) return `The room air feels thick and recycled. Humidity and stagnation are stacking against you — this is the kind of air that lingers on people's clothes. Ventilation would make an immediate difference.`;
  if (cfiPercent < 60) return `CO₂ is climbing and it shows. The air is subtly dull right now — not dangerous, but the kind of condition that quietly erodes focus. Moving some air through would help.`;
  if (bioPeak >= 60) return hasConfidentPrimary(d)
    ? `Something biological is leading the room right now — ${primary} is the most likely candidate. The biological channels are elevated and the classifier agrees. Time to ventilate.`
    : `Biological signals are elevated across the board. The classifier is not committing to a single odor class, but the room air is carrying something. A window or fan would help it clear.`;
  if (score >= 75) return `The room is carrying a meaningful air load right now, and ${primary} keeps appearing in the signal. Conditions are not yet critical, but trending in the wrong direction.`;
  if (score >= 50) return `Air quality is in the moderate range — not alarming, but worth watching. ${primary} is the strongest present signal. Good time to consider opening a window before it builds.`;
  if (score >= 25) return `The room is mostly clean with a light background presence of ${primary}. Conditions are stable and no action is needed right now.`;
  return `The room is in good shape. Air is calm, clean, and not asking for attention. Conditions are favorable.`;
}

function broPlayCall(d) {
  const bio = fartSignals(d);
  const bioPeak = Math.max(bio.fart, bio.sulfur, bio.garbage, bio.pet);
  const outdoorAqi = num(d.outdoorAqi);
  const co2 = num(d.co2);
  const primary = primaryNarrative(d);
  const vtrLevel = officeVtrLevel(d);
  const cfiPercent = officeCfiPercent(d);

  if (vtrLevel >= 2) return "Bring in fresh air, add filtration if available, and stop the room from marinating in stale exhale.";
  if (cfiPercent < 60) return "Lower CO₂ first — the room will feel sharper without changing anything else.";
  if (bioPeak >= 55) return "Open a window, run a fan, and give the room a proper reset.";
  if (co2 >= 1100 && (outdoorAqi === 0 || outdoorAqi <= 80)) return "CO₂ is elevated. Air the space out and let it breathe for a few minutes.";
  if (outdoorAqi > 0 && outdoorAqi <= 50 && num(d.airScore) >= 35) return "Outside air is cleaner than inside right now. Opening a window is the easy call.";
  if (hasConfidentPrimary(d) && (primary.includes("laundry") || primary.includes("citrus") || primary.includes("perfume"))) return "Room is fresh. No action needed — the air is carrying a positive signature.";
  return "Hold steady and monitor the trend. Conditions look stable.";
}

function buildBroSummary(d) {
  return broOpening(d);
}

function buildBroReport(d) {
  const lines = [];
  const signals = fartSignals(d);
  const odors = topOdors(d.odors, 3);
  const sniff = activeSniffEvent();
  const cfiPercent = officeCfiPercent(d);
  const vtrLabel = officeVtrLabel(d);

  lines.push("ROOM CONDITION");
  lines.push(buildBroSummary(d));
  lines.push("");
  if (sniff) {
    lines.push("LIVE ALERT");
    lines.push(`Priority sulfur post just landed: ${sniff.label} at ${Math.round(num(sniff.vsc_conf))}% (${fmtAge(sniff.receivedAt)}).`);
    lines.push("");
  }
  lines.push("CURRENT READINGS");
  lines.push(`Primary lead: ${currentPrimary(d, "No dominant odor class")}`);
  lines.push(`Tier: ${smellTierLabel(num(d.tier))} (${num(d.tier)}/5)`);
  lines.push(`Core stats: Score ${Math.round(num(d.airScore))}/100 | IAQ ${Math.round(num(d.iaq))} | VOC ${num(d.voc).toFixed(2)} | dVOC ${fmtSigned(d.dVoc, 2)} | CO2 ${Math.round(num(d.co2))}`);
  lines.push(`Office vitality: Focus ${cfiPercent}% (${officeCfiBand(d)}) | Transmission risk ${vtrLabel}`);
  lines.push(`Bio stack: Fart ${signals.fart}% | Sulfur ${signals.sulfur}% | VSC proxy ${Math.round(vscProxyConfidence(d))}% | Garbage ${signals.garbage}% | Pet ${signals.pet}%`);
  lines.push("");
  lines.push("SIGNAL BREAKDOWN");
  if (odors.length) {
    lines.push(`Top mix: ${odors.map((odor) => `${odor.name} ${odor.score}%`).join(" | ")}`);
  } else {
    lines.push("Top mix: nothing loud enough to separate from background right now.");
  }
  lines.push(`Calibration state: ${d.calibration || `Accuracy ${num(d.iaqAcc)}/3`}`);
  lines.push("");
  lines.push("RECOMMENDED ACTION");
  lines.push(broPlayCall(d));
  return lines.join("\n");
}

function renderMissionHistory() {
  // This function is kept as a no-op for compatibility;
  // the history card has been replaced by the APOD card.
}

const MAX_APOD_EXPLANATION_LENGTH = 400;

/**
 * Called from inline onerror attributes on APOD img elements.
 * Reads the fallback URL from data-apod-page on the containing .apod-image-wrap
 * and replaces the wrap contents with a safe placeholder link.
 */
function apodImageFallback(el) {
  const wrap = el.closest(".apod-image-wrap");
  if (!wrap) return;
  const pageUrl = wrap.dataset.apodPage || "https://apod.nasa.gov/apod/";
  wrap.innerHTML = `<div class="apod-placeholder">Image unavailable — <a href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">view on NASA APOD</a></div>`;
}

function renderApod(data) {
  const apodData = data || apodState.data;
  const dateEl = $("apod-date");
  const titleEl = $("apod-title");
  const imageWrap = $("apod-image-wrap");
  const explanationEl = $("apod-explanation");
  const copyrightEl = $("apod-copyright");
  if (!dateEl && !titleEl) return;

  if (!apodData || (!apodData.url && !apodData.videoUrl && !apodData.explanation)) {
    if (dateEl) dateEl.textContent = "Loading today's picture...";
    setHeaderPill("history-badge", "Loading", "neutral");
    return;
  }

  const dateLabel = apodData.date
    // Use noon UTC so the date always renders correctly regardless of browser timezone
    ? new Date(`${apodData.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "";
  if (dateEl) dateEl.textContent = dateLabel || "NASA APOD";
  if (titleEl) {
    const apodUrl = apodData.apodPageUrl || "https://apod.nasa.gov/apod/";
    titleEl.innerHTML = `<a href="${escapeHtml(apodUrl)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;text-underline-offset:3px;">${escapeHtml(apodData.title || "Astronomy Picture of the Day")}</a>`;
  }

  if (imageWrap) {
    const rawPageUrl = apodData.apodPageUrl || "https://apod.nasa.gov/apod/";
    const apodPageUrl = escapeHtml(rawPageUrl);
    const altText = escapeHtml(apodData.title || "Astronomy Picture of the Day");
    // Store the APOD page URL on the wrap so apodImageFallback() can use it without string injection
    imageWrap.dataset.apodPage = rawPageUrl;

    if (apodData.mediaType === "video") {
      // Prefer thumbnail over an embedded iframe to avoid blank iframes (autoplay / CSP issues)
      const thumb = apodData.thumbnail || null;
      const videoPageUrl = escapeHtml(apodData.videoUrl || rawPageUrl);
      if (thumb) {
        imageWrap.innerHTML = `<a class="apod-video-thumb" href="${videoPageUrl}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(thumb)}" alt="${altText}" loading="lazy" onerror="apodImageFallback(this)"><span class="apod-play-badge" aria-hidden="true">▶</span></a>`;
      } else {
        imageWrap.innerHTML = `<div class="apod-placeholder">Image unavailable — <a href="${apodPageUrl}" target="_blank" rel="noopener noreferrer">view on NASA APOD</a></div>`;
      }
    } else if (apodData.url) {
      const imgSrc = escapeHtml(apodData.url);
      const hdSrc = escapeHtml(apodData.hdurl || apodData.url);
      imageWrap.innerHTML = `<a href="${apodPageUrl}" target="_blank" rel="noopener noreferrer"><img src="${imgSrc}" alt="${altText}" loading="lazy" onerror="this.onerror=null;this.src='${hdSrc}';this.onerror=function(){apodImageFallback(this)}"></a>`;
    } else {
      imageWrap.innerHTML = `<div class="apod-placeholder">Image unavailable — <a href="${apodPageUrl}" target="_blank" rel="noopener noreferrer">view on NASA APOD</a></div>`;
    }
  }

  if (explanationEl) {
    const text = apodData.explanation || "";
    const trimmed = text.length > MAX_APOD_EXPLANATION_LENGTH
      ? `${text.slice(0, MAX_APOD_EXPLANATION_LENGTH).trim()}…`
      : text;
    explanationEl.textContent = trimmed;
  }

  if (copyrightEl) {
    copyrightEl.textContent = apodData.copyright ? `© ${apodData.copyright.trim()}` : "";
  }

  setHeaderPill("history-badge", apodData.title ? apodData.title.slice(0, 28) : "NASA APOD", "good");
}
function renderStructuredReport(text) {
  return formatDiagnosticReport(text);
}

function renderSpaceCard(d) {
  const launches = Array.isArray(d.launches) ? d.launches : [];
  const first = launches[0] || null;
  const historyYear = String(d.spaceHistoryShort || "").match(/\d{4}/)?.[0] || snapshotMonthDayLabel(d);
  const radar = document.querySelector("#card-space .space-radar");
  const title = $("space-title");
  const sub = $("space-sub");
  const statWindow = $("space-stat-window");
  const statCount = $("space-stat-count");
  const statHistory = $("space-stat-history");
  const report = $("space-report");
  const launchMarker = $("space-launch-marker");
  const historyMarker = $("space-history-marker");

  if (title) {
    title.textContent = first
      ? `${first.name || "Cape mission"} is next on deck`
      : num(d.launchesYtd) > 0
        ? `${Math.round(num(d.launchesYtd))} Cape launches tracked this year`
        : "Cape launch feed is standing by";
  }

  if (sub) {
    sub.textContent = first
      ? `${first.status || "Status pending"} · NET ${first.time || "TBD"}. ${d.spaceHistoryShort || "Space Coast history is loaded below."}`
      : (d.spaceHistoryShort || "Next launch timing and daybook context will appear here with the next live snapshot.");
  }

  if (statWindow) statWindow.textContent = first?.time || "TBD";
  if (statCount) statCount.textContent = num(d.launchesYtd) > 0 ? `${Math.round(num(d.launchesYtd))}` : (launches.length ? `${launches.length} queued` : "--");
  if (statHistory) statHistory.textContent = historyYear;

  if (radar) {
    const launchAngle = first ? `${-92 + Math.min(launches.length, 3) * 34}deg` : "-156deg";
    const yearNum = Number.parseInt(historyYear, 10);
    const historyAngle = Number.isFinite(yearNum) ? `${35 + (yearNum % 170)}deg` : "126deg";
    radar.style.setProperty("--launch-angle", launchAngle);
    radar.style.setProperty("--history-angle", historyAngle);
  }

  if (launchMarker) launchMarker.style.opacity = first ? "1" : "0.28";
  if (historyMarker) historyMarker.style.opacity = historyYear ? "0.9" : "0.45";
  if (report) report.innerHTML = renderStructuredReport(buildSpaceReport(d));
}

function odorAccentRgb(d) {
  const primary = num(d.primaryConf);
  const vsc = vscProxyConfidence(d);
  const room = num(d.airScore);
  if (vsc >= 70) return "216, 239, 114";
  if (primary >= 45) return "0, 242, 255";
  if (room <= 25) return "93, 241, 164";
  if (room >= 60) return "255, 142, 88";
  return "255, 210, 92";
}

function renderOdorCard(d) {
  const title = $("odor-title");
  const sub = $("odor-sub");
  const conf = num(d.primaryConf);
  const vsc = vscProxyConfidence(d);
  const top = topOdors(d.odors, 4);
  const report = $("odor-report");
  const bloom = $("odor-bloom");
  const stack = $("odor-channel-stack");
  const intensity = clamp(Math.max(conf, vsc, num(d.airScore)) / 100, 0.14, 1);
  const accentRgb = odorAccentRgb(d);

  if (title) title.textContent = currentPrimary(d, num(d.airScore) <= 30 ? "Clean-air pattern" : "No dominant odor");
  if (sub) {
    sub.textContent = hasConfidentPrimary(d)
      ? `${roomSummary(d)} The classifier currently leans ${d.primary.toLowerCase()} with ${Math.round(conf)}% confidence.`
      : `${roomSummary(d)} The classifier sees a mixed background instead of one clear lead odor.`;
  }

  $("odor-stat-confidence").textContent = `${Math.round(conf)}%`;
  $("odor-stat-vsc").textContent = `${Math.round(vsc)}%`;
  $("odor-stat-tier").textContent = `${num(d.tier)}/5`;

  if (bloom) {
    bloom.style.setProperty("--odor-color", accentRgb);
    bloom.style.setProperty("--odor-core-scale", `${0.64 + intensity * 0.34}`);
    bloom.style.setProperty("--odor-pulse-scale", `${1.08 + intensity * 0.52}`);
  }

  if (stack) {
    stack.innerHTML = top.length
      ? top.map((odor) => `
        <div class="odor-channel-row">
          <div class="odor-channel-head">
            <span class="odor-channel-name">${escapeHtml(odor.name)}</span>
            <span class="odor-channel-score">${Math.round(odor.score)}%</span>
          </div>
          <div class="odor-channel-bar">
            <div class="odor-channel-fill" style="width:${clamp(odor.score, 0, 100)}%"></div>
          </div>
        </div>
      `).join("")
      : '<div class="odor-channel-empty">No classifier channel is strong enough yet to look like a confident dominant odor.</div>';
  }

  if (report) report.innerHTML = renderStructuredReport(buildOdorReport(d));
}

function renderIntelDrawer(d) {
  const iaq = Math.round(num(d.iaq));
  const voc = num(d.voc);
  const vsc = Math.round(vscProxyConfidence(d));
  const room = Math.round(num(d.airScore));
  const summary = d.sassy || roomSummary(d);

  $("intel-summary").textContent = `${summary} Current lead: ${currentPrimary(d, "No dominant odor")}.`;
  $("intel-iaq-range").textContent = `IAQ ${iaq} / 500 · ${iaqLabel(iaq)}. Lower is healthier indoors on this Bosch scale.`;
  $("intel-voc-range").textContent = `${voc.toFixed(2)} ppm · ${vocLoadLabel(voc)}. Estimated concentration of airborne chemicals.`;
  $("intel-vsc-range").textContent = `${vsc}% sulfur/VSC proxy. This is a classifier-driven sulfur watch channel, not a molecule-specific lab instrument.`;
  $("intel-rqi-range").textContent = `${room}/100 · ${airScoreCondition(room)}. This custom room index treats lower values as cleaner conditions.`;
  $("intel-gasr-range").textContent = `${fmtGasR(d.gasR)}Ω · ${gasResistanceSummary(d.gasR)}`;
  $("intel-copy").textContent = `These readings interpret the air directly. Lower IAQ and VOC values indicate cleaner conditions. High gas resistance (Gas R) typically means cleaner air.`;
}

function renderCauseCard(d) {
  const score = num(d.airScore);
  const iaq = num(d.iaq);
  const co2 = num(d.co2);
  const voc = num(d.voc);
  const humidity = num(d.humidity);
  const outdoorAqi = num(d.outdoorAqi);
  const bio = fartSignals(d);
  const bioPeak = Math.max(bio.fart, bio.sulfur, bio.garbage, bio.pet);
  const cfiPercent = officeCfiPercent(d);
  const vtrLevel = officeVtrLevel(d);
  const primary = currentPrimary(d, "background");

  let driverText = "No dominant stressor";
  let driverNote = "Air conditions appear stable across all monitored channels.";
  let actionText = "No action needed — conditions are favorable.";
  let badgeTone = "good";

  if (bioPeak >= 55) {
    driverText = "Biological odor event";
    driverNote = `Active biological signature detected (${primary}). Odor channels are elevated above background.`;
    actionText = "Open a window or run a fan to clear the air.";
    badgeTone = "danger";
  } else if (vtrLevel >= 2) {
    driverText = "Air stagnation";
    driverNote = "The room air is recycled and stale. Humidity and CO₂ are stacking together.";
    actionText = "Ventilate now — fresh air will make an immediate difference.";
    badgeTone = "warn";
  } else if (cfiPercent < 60) {
    driverText = "CO₂ saturation";
    driverNote = `CO₂ is at ${Math.round(co2)} ppm, which is suppressing air quality and focus.`;
    actionText = "Introduce fresh air to bring CO₂ below 1000 ppm.";
    badgeTone = "warn";
  } else if (score >= 65) {
    driverText = `Elevated ${primary}`;
    driverNote = `Room quality index is ${Math.round(score)}/100 — the room is carrying a meaningful air load.`;
    actionText = "Consider ventilating to help the room recover.";
    badgeTone = "warn";
  } else if (outdoorAqi > 100) {
    driverText = "Poor outdoor air quality";
    driverNote = `Outdoor AQI is ${Math.round(outdoorAqi)}, which limits ventilation options.`;
    actionText = "Keep windows closed and monitor indoor conditions.";
    badgeTone = "warn";
  } else if (score >= 35) {
    driverText = `Mild ${primary} presence`;
    driverNote = "Light air load is present. Conditions are manageable but worth watching.";
    actionText = "Monitor trend — no immediate action required.";
    badgeTone = "neutral";
  }

  const airFactor = iaq < 50 ? "Clean" : iaq < 100 ? "Mild" : iaq < 150 ? "Moderate" : iaq < 200 ? "Elevated" : "High";
  const occFactor = co2 < 700 ? "Low / empty" : co2 < 900 ? "Light occupancy" : co2 < 1200 ? "Moderate occupancy" : "High occupancy";
  const outdoorFactor = outdoorAqi <= 0 ? "Pending" : outdoorAqi <= 50 ? "Good" : outdoorAqi <= 100 ? "Moderate" : "Poor";
  const ventFactor = voc < 0.5 && co2 < 800 ? "Well ventilated" : voc < 1.5 && co2 < 1000 ? "Adequate" : "Restricted";

  setHeaderPill("cause-badge", driverText, badgeTone);
  const pd = $("cause-primary-driver"); if (pd) pd.textContent = driverText;
  const pn = $("cause-primary-note"); if (pn) pn.textContent = driverNote;
  const ca = $("cause-action"); if (ca) ca.textContent = actionText;
  const fa = $("cause-factor-air"); if (fa) fa.textContent = airFactor;
  const fo = $("cause-factor-occ"); if (fo) fo.textContent = occFactor;
  const fod = $("cause-factor-outdoor"); if (fod) fod.textContent = outdoorFactor;
  const fv = $("cause-factor-vent"); if (fv) fv.textContent = ventFactor;
}

function setHeaderPill(id, text, tone = "neutral") {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

function renderHero(d) {
  const score = clamp(num(d.airScore), 0, 100);
  const gaugeScore = 100 - score;
  const color = airScoreColor(score);
  const iaq = clamp(num(d.iaq), 0, 500);
  const voc = Math.max(0, num(d.voc));
  const calibrationText = d.calibration || `Accuracy ${num(d.iaqAcc)}/3`;
  const activeSniff = activeSniffEvent();
  const briefLead = d.hazard || iaqLabel(num(d.iaq));
  const briefTone = score < 20 ? "Room is stable and mostly clean." :
    score < 40 ? "Light buildup is present, but the room is still manageable." :
    score < 65 ? "Air load is building and ventilation would help." :
    "The room is running dirty and needs intervention.";
  const statusBits = [
    calibrationText,
    num(d.receivedAt) ? `Updated ${fmtAge(d.receivedAt)}` : "Waiting for live snapshot",
  ];
  if (activeSniff) statusBits.push(`Sulfur watch ${activeSniff.label} ${Math.round(num(activeSniff.vsc_conf))}%`);

  $("air-score").textContent = Math.round(score);
  $("air-label").textContent = "Room Quality";

  const circumference = 2 * Math.PI * 52;
  const offset = circumference * (1 - gaugeScore / 100);
  const arc = $("air-arc");
  if (arc) {
    arc.style.strokeDashoffset = offset;
    arc.style.stroke = color;
  }
  $("air-score").style.color = color;
  $("air-condition-caption").textContent = airScoreCondition(score);
  $("air-condition-caption").style.color = color;
  $("air-condition-note").textContent = airScoreMeaning(score);

  const iaqFill = $("iaq-hud-fill");
  const iaqValue = $("iaq-hud-value");
  const vocFill = $("voc-hud-fill");
  const vocValue = $("voc-hud-value");
  const airFill = $("air-hud-fill");
  const vocCaption = $("voc-hud-caption");
  if (iaqFill) iaqFill.style.width = `${Math.max(3, (iaq / 500) * 100)}%`;
  if (iaqValue) iaqValue.textContent = `${Math.round(iaq)} / 500`;
  if (vocFill) vocFill.style.width = `${Math.max(3, Math.min(100, (voc / 4) * 100))}%`;
  if (vocValue) vocValue.textContent = `${voc.toFixed(2)} ppm`;
  if (airFill) airFill.style.width = `${Math.max(4, score)}%`;
  if (vocCaption) vocCaption.textContent = `${vocLoadLabel(voc)}. This band is relative to indoor VOC activity, not a toxicology limit line.`;

  const calibration = calibrationNarrative(d);
  $("hero-hazard").textContent = d.hazard || iaqLabel(num(d.iaq));
  $("hero-calibration").textContent = calibration.short;
  $("hero-primary").textContent = currentPrimary(d);
  $("hero-summary").textContent = heroSummaryText(d);
  const subtitleParts = [];
  if (num(d.receivedAt)) {
    const age = Date.now() - num(d.receivedAt);
    if (age < 30000) subtitleParts.push("Live");
    else if (age < STALE_MS) subtitleParts.push("Active");
  }
  if (num(d.iaqAcc) >= 3) subtitleParts.push("Sensor calibrated");
  else if (num(d.iaqAcc) > 0) subtitleParts.push(`Calibrating (${num(d.iaqAcc)}/3)`);
  const subtitleLine = subtitleParts.length
    ? subtitleParts.join(" · ")
    : "Your space, monitored continuously.";
  $("hero-subtitle").textContent = subtitleLine;
  $("hero-tier").textContent = `${smellTierLabel(num(d.tier))} · Tier ${num(d.tier)}/5`;
  $("hero-trends").textContent = `IAQ ${d.iaqTrend || "steady"} | VOC ${d.vocTrend || "steady"}`;
  $("hero-brief-title").textContent = `${briefLead} · ${Math.round(score)}/100 room index`;
  $("hero-brief-primary").textContent = currentPrimary(d, "No dominant odor");
  $("hero-brief-next").textContent = `${windowCall(d)} ${briefTone}`.trim();
  $("hero-brief-status").textContent = statusBits.join(" · ");

  const causeParts = [];
  if (num(d.voc) > 1.5) causeParts.push("elevated VOC activity");
  if (num(d.co2) > 1000) causeParts.push("CO₂ buildup from occupancy");
  if (num(d.iaq) > 150) causeParts.push("deteriorating air quality index");
  if (num(d.humidity) > 70) causeParts.push("high humidity");
  if (num(d.outdoorAqi) > 100) causeParts.push("poor outdoor air");
  if (activeSniff) causeParts.push("active odor event detected");
  const causeText = causeParts.length
    ? `Led by ${causeParts.slice(0, 2).join(" and ")}.`
    : "Air conditions appear stable — no dominant stressor.";
  $("hero-cause") && ($("hero-cause").textContent = causeText);

  $("v-iaq").textContent = Math.round(num(d.iaq));
  $("v-voc").textContent = `${num(d.voc).toFixed(2)} ppm`;
  $("v-co2").textContent = `${Math.round(num(d.co2))}`;
  $("v-aqi").textContent = num(d.outdoorAqi) > 0 ? `${Math.round(num(d.outdoorAqi))}` : "--";
  $("v-aqi").style.color = num(d.outdoorAqi) > 0 ? aqiColor(num(d.outdoorAqi)) : "";
  $("v-gasr").textContent = `${fmtGasR(d.gasR)}Ω`;
  $("v-dvoc").textContent = fmtSigned(d.dVoc, 2);
}

function renderStatusStrip(d) {
  const age = Date.now() - num(d.receivedAt, 0);
  const isLive = age < STALE_MS;
  const calibration = calibrationNarrative(d);
  const hasSnapshot = num(d.receivedAt, 0) > 0;
  $("status-sensor").textContent = isLive ? "Online" : "Catching up";
  $("status-bsec").textContent = calibration.short;
  $("status-warmup").textContent = calibration.detail;
  $("status-link").textContent = !hasSnapshot ? "Awaiting first sync" : (isLive ? "Portal linked" : "Feed catching up");
  $("status-updated").textContent = num(d.receivedAt) ? `${fmtAge(d.receivedAt)} · ${fmtStamp(d.receivedAt)}` : "No snapshot yet";
  setHeaderPill("status-badge", isLive ? "Live feed" : (hasSnapshot ? "Feed catching up" : "Awaiting first sync"), isLive ? "good" : "warn");
  $("header-calibration").textContent = calibration.short;
}

function renderTelemetry(d) {
  const tempF = num(d.tempF);
  const humidity = num(d.humidity);
  const gasR = num(d.gasR);
  const gasPct = num(d.gasPct);

  const tempColor = (tempF >= 65 && tempF <= 78) ? "var(--cobalt)" : (tempF >= 55 && tempF < 90) ? "var(--amber)" : "var(--orange)";
  const humColor = (humidity >= 40 && humidity <= 60) ? "var(--cobalt)" : (humidity >= 30 && humidity <= 70) ? "var(--amber)" : "var(--orange)";
  const gasRColor = gasR > 50000 ? "var(--mint)" : gasR > 10000 ? "var(--cobalt)" : gasR > 3000 ? "var(--amber)" : "var(--orange)";
  const gasPctColor = gasPct >= 80 ? "var(--mint)" : gasPct >= 50 ? "var(--cobalt)" : gasPct >= 25 ? "var(--amber)" : "var(--orange)";

  const vTemp = $("v-temp");
  vTemp.textContent = `${tempF.toFixed(1)}F`;
  vTemp.style.color = tempColor;

  const vHum = $("v-hum");
  vHum.textContent = `${humidity.toFixed(0)}%`;
  vHum.style.color = humColor;

  $("v-press").textContent = `${num(d.pressHpa).toFixed(1)} hPa`;

  const vGasR = $("v-gasr-raw");
  vGasR.textContent = `${fmtGasR(d.gasR)}Ω`;
  vGasR.style.color = gasRColor;

  $("v-compgas").textContent = `${fmtGasR(d.compGas)}Ω`;

  const vGasPct = $("v-gaspct");
  vGasPct.textContent = `${gasPct.toFixed(1)}%`;
  vGasPct.style.color = gasPctColor;

  $("v-local-time-card").textContent = fmtLocationTime(d.receivedAt, d.utcOffsetSec);
  $("v-uptime-card").textContent = fmtUptime(d.uptime).replace(/^Up /, "");
  $("header-network").textContent = headerNetworkText(d);
  $("header-city").textContent = d.city || "Location syncing";
  const outdoorTempStr = Number.isFinite(num(d.feelsLikeF, NaN)) ? ` · ${num(d.feelsLikeF).toFixed(0)}F` : "";
  $("header-weather").textContent = d.weatherCondition
    ? `${d.weatherCondition}${outdoorTempStr}`
    : "Weather pending";
  $("header-time").textContent = fmtLocationTime(d.receivedAt, d.utcOffsetSec);
  $("header-date").textContent = fmtLocationDate(d.receivedAt, d.utcOffsetSec);
  $("city-pill").textContent = d.city || "Sensor stream";
}

function renderDerivedMetrics(d) {
  const iaq = num(d.iaq);
  const voc = num(d.voc);
  const co2 = num(d.co2);
  const roomScore = num(d.airScore);
  const aqi = num(d.outdoorAqi);

  const iaqColor = iaq <= 50 ? "var(--mint)" : iaq <= 100 ? "var(--cobalt)" : iaq <= 150 ? "var(--amber)" : iaq <= 200 ? "var(--orange)" : "var(--red)";
  const vocColor = voc < 0.5 ? "var(--mint)" : voc < 1.0 ? "var(--cobalt)" : voc < 2.0 ? "var(--amber)" : voc < 5.0 ? "var(--orange)" : "var(--red)";
  const co2Color = co2 < 700 ? "var(--mint)" : co2 < 1000 ? "var(--cobalt)" : co2 < 1500 ? "var(--amber)" : "var(--red)";
  const roomColor = roomScore >= 80 ? "var(--mint)" : roomScore >= 60 ? "var(--cobalt)" : roomScore >= 40 ? "var(--amber)" : roomScore >= 20 ? "var(--orange)" : "var(--red)";
  const aqiColor = aqi <= 0 ? "var(--muted-strong)" : aqi <= 50 ? "var(--mint)" : aqi <= 100 ? "var(--cobalt)" : aqi <= 150 ? "var(--amber)" : "var(--orange)";

  const elIaq = $("derived-iaq");
  elIaq.textContent = `${Math.round(iaq)}`;
  elIaq.style.color = iaqColor;

  const elVoc = $("derived-voc");
  elVoc.textContent = `${voc.toFixed(2)} ppm`;
  elVoc.style.color = vocColor;

  const elCo2 = $("derived-co2");
  elCo2.textContent = `${Math.round(co2)}`;
  elCo2.style.color = co2Color;

  const elRoom = $("derived-room");
  elRoom.textContent = `${Math.round(roomScore)}/100`;
  elRoom.style.color = roomColor;

  $("derived-dvoc").textContent = fmtSigned(d.dVoc, 2);

  const elAqi = $("derived-aqi");
  elAqi.textContent = aqi > 0 ? `${Math.round(aqi)}` : "--";
  elAqi.style.color = aqiColor;

  $("derived-primary").textContent = currentPrimary(d, "No dominant odor");
  $("derived-confidence").textContent = `${Math.round(num(d.primaryConf))}%`;
  setHeaderPill("derived-badge", d.highAccuracyIaq ? "Inference ready" : "Warming up", d.highAccuracyIaq ? "good" : "warn");
}

function renderOfficeCard(d) {
  const cfiPercent = officeCfiPercent(d);
  const cfiBand = officeCfiBand(d);
  const cfiColor = officeCfiColor(cfiPercent);
  const vtrLevel = officeVtrLevel(d);
  const vtrLabel = officeVtrLabel(d);
  const humidity = num(d.humidity);
  const co2 = num(d.co2);
  const iaq = num(d.iaq);
  const focusDrivers = [];

  if (co2 > 1000) focusDrivers.push("CO2 is high enough to blunt attention");
  else if (co2 > 800) focusDrivers.push("CO2 is climbing above a fresh-room baseline");
  if (iaq > 100) focusDrivers.push("the room is also reading stale on IAQ");
  if (!focusDrivers.length) focusDrivers.push("CO2 saturation and room-air quality are both favorable");

  $("office-cfi-value").textContent = `${cfiPercent}%`;
  $("office-cfi-value").style.color = cfiColor;
  $("office-cfi-band").textContent = cfiBand;
  $("office-cfi-note").textContent = `${focusDrivers.join(", ")}.`;

  const focusFill = $("office-cfi-fill");
  if (focusFill) {
    focusFill.style.width = `${Math.max(4, cfiPercent)}%`;
    focusFill.style.background = `linear-gradient(90deg, #4a2572 0%, ${cfiColor} 100%)`;
    focusFill.style.boxShadow = cfiPercent >= 80
      ? "0 0 22px rgba(0, 242, 255, 0.22)"
      : "0 0 16px rgba(106, 89, 255, 0.16)";
  }

  const riskBadge = $("office-vtr-badge");
  riskBadge.textContent = vtrLabel;
  riskBadge.dataset.tone = vtrLevel === 2 ? "high" : (vtrLevel === 1 ? "elevated" : "safe");
  $("office-vtr-status").textContent = vtrLevel === 2
    ? "High viral persistence risk"
    : vtrLevel === 1
      ? "Stagnant air detected"
      : "Humidity and ventilation are in range";
  $("office-vtr-note").textContent = officeVtrAdvice(d);

  $("office-co2").textContent = `${Math.round(co2)} ppm`;
  $("office-iaq").textContent = `${Math.round(iaq)}`;
  $("office-humidity").textContent = `${humidity.toFixed(0)}%`;
  const rawTemp = num(d.tempF, NaN);
  $("office-temp").textContent = Number.isFinite(rawTemp) ? `${rawTemp.toFixed(1)}°F` : "--";
  $("office-context").textContent = `${windowCall(d)} Humidity is ${humidity.toFixed(0)}%, so the room is tracking as ${vtrLabel.toLowerCase()}.`;

  const attention = officeAttentionState(d);
  const comfort = officeComfortState(d);
  const collab = officeCollaborationState(d);
  const odor = officeOdorState(d);
  const fatigue = officeFatigueProfile(d);
  const persistence = officePersistenceProfile(d);
  $("office-room-load").textContent = `${Math.round(num(d.airScore))}/100`;
  $("office-attention-title").textContent = attention.title;
  $("office-attention-note").textContent = attention.note;
  $("office-comfort-title").textContent = comfort.title;
  $("office-comfort-note").textContent = comfort.note;
  $("office-collab-title").textContent = collab.title;
  $("office-collab-note").textContent = collab.note;
  $("office-odor-title").textContent = odor.title;
  $("office-odor-note").textContent = odor.note;
  $("office-fatigue-title").textContent = fatigue.title;
  $("office-fatigue-note").textContent = fatigue.note;
  $("office-persistence-title").textContent = persistence.title;
  $("office-persistence-note").textContent = persistence.note;
  $("office-briefing").textContent = officeBriefing(d);

  const officeTone = vtrLevel >= 2 ? "danger" : cfiPercent < 60 || vtrLevel === 1 ? "warn" : "good";
  const officeBadgeText = vtrLevel >= 2
    ? `${vtrLabel} · Focus ${cfiPercent}%`
    : `Focus ${cfiPercent}% · ${vtrLabel}`;
  setHeaderPill("office-badge", officeBadgeText, officeTone);
}

function renderBreathCard(d) {
  const breath = breathProxy(d);
  $("breath-verdict").textContent = breath.verdict;
  $("breath-note").textContent = "4x press runs the close-range breath mode on the device. This web panel is an ambient proxy, not the last direct breath test.";
  $("breath-alcohol").textContent = `${Math.round(breath.alcohol)}%`;
  $("breath-voc").textContent = `${breath.voc.toFixed(2)} ppm`;
  $("breath-iaq").textContent = `${Math.round(breath.iaq)}`;
  setHeaderPill(
    "breath-badge",
    "4x press · breathalyzer",
    breath.tone
  );
}

function renderMoonVisual(d) {
  const moon = currentMoon(d);
  const title = $("moon-visual-title");
  const sub = $("moon-visual-sub");
  const shadow = $("moon-shadow");
  if (!title || !sub || !shadow) return;

  title.textContent = moon.label;
  sub.textContent = `${moon.illum}% illuminated`;
  shadow.style.transform = `translateX(${moonShadowOffset(moon.label, moon.illum)}%)`;
}

function renderSkyVisual(d) {
  const stage = $("sky-stage");
  const orb = $("sky-orb");
  const title = $("sky-visual-title");
  const sub = $("sky-visual-sub");
  if (!stage || !orb || !title || !sub) return;

  const severity = outdoorSeverity(d);
  const hour = localHourForData(d);
  const progress = clamp((hour % 24) / 24, 0, 1);
  const x = 12 + progress * 64;
  const arc = Math.sin(progress * Math.PI);
  const y = 60 - arc * 36;
  const orbColor = severity < 0 ? "#9d82ff" : severity >= 3 ? "#ff9958" : severity === 2 ? "#ffd25c" : "#6bccff";
  const glow = severity >= 3
    ? "0 0 20px rgba(255, 153, 88, 0.45)"
    : severity === 2
      ? "0 0 20px rgba(255, 210, 92, 0.42)"
      : severity < 0
        ? "0 0 20px rgba(157, 130, 255, 0.36)"
        : "0 0 20px rgba(107, 204, 255, 0.42)";

  orb.style.left = `${x}px`;
  orb.style.top = `${y}px`;
  orb.style.background = orbColor;
  orb.style.boxShadow = glow;
  title.textContent = severity < 0 ? "Sky signal pending" : severity >= 3 ? "Outside air is rough" : severity === 2 ? "Selective ventilation" : "Window-friendly sky";
  sub.textContent = severity < 0 ? "Outdoor chemistry has not posted yet, so this stays in standby mode." : windowCall(d);
}

function renderWeatherIntel(d) {
    const mapCity = $("map-city");
    const mapLink = $("map-link");

    mapCity.textContent = d.city || "Location pending";
    $("weather-insight").textContent = weatherInsightText(d);
    $("v-weather-condition").textContent = d.weatherCondition || "Conditions pending";
    $("v-weather-temp").textContent = `${num(d.tempF).toFixed(0)}F`;
    $("v-weather-feels").textContent = `${num(d.feelsLikeF, d.tempF).toFixed(0)}F`;
    $("v-weather-hum").textContent = `${num(d.humidity).toFixed(0)}%`;
    $("v-weather-wind").textContent = `${(d.windDir || "--")} ${(d.windSpeed || "").trim()}`.trim();
    $("v-coords").textContent = fmtCoords(d);
    $("v-local-time").textContent = fmtLocationTime(d.receivedAt, d.utcOffsetSec);
    $("v-window-call").textContent = windowCall(d);
    $("v-weather-aqi").textContent = num(d.outdoorAqi) > 0 ? `${Math.round(num(d.outdoorAqi))} ${d.outdoorLevel || ""}`.trim() : "Pending";
    $("v-pressure-read").textContent = pressureRead(num(d.pressHpa));

    const links = weatherMapLinks(d);
    if (links) {
        mapLink.href = links.open;
    } else {
        mapLink.href = "https://www.openstreetmap.org";
    }
    $("weather-report").innerHTML = formatDiagnosticReport(buildWeatherReport(d, weatherBriefingState.data));
    renderMoonVisual(d);
    renderSkyVisual(d);
    syncWeatherMapPosition(d);
    syncMapLayers();
    const srcWx = $("source-weather");
    if (srcWx) srcWx.textContent = "Source: Open-Meteo forecast (Cape Canaveral, FL) · OpenStreetMap · RainViewer radar & infrared satellite · NWS active alerts API · OpenAI weather brief when available";
}

function renderLaunchDeck(d) {
  const shell = $("launch-stack");
  if (!shell) return;

  const allLaunches = Array.isArray(d.launches) ? d.launches : [];
  // Only show KSC / CCSFS launches in the deck
  const launches = allLaunches.filter((l) => l.isCape).slice(0, 3);
  if (!launches.length) {
    // Only reset to placeholder if never populated with real launch data
    if (!shell.dataset.snmFilled) {
      shell.innerHTML = '<div class="launch-empty">No upcoming KSC / CCSFS launches in the current snapshot.</div>';
    }
    return;
  }

  shell.innerHTML = launches.map((launch, index) => {
    const webcast = launch.webcastUrl
      ? ` · <a href="${escapeHtml(launch.webcastUrl)}" target="_blank" rel="noopener noreferrer">Webcast</a>`
      : "";
    return `
    <article class="launch-card is-cape">
      <div class="launch-kicker">KSC/CCSFS · Slot ${index + 1}</div>
      <div class="launch-name">${escapeHtml(launch.name || "Unknown mission")}</div>
      <div class="launch-line"><strong>NET:</strong> ${escapeHtml(launch.time || "TBD")}</div>
      <div class="launch-line"><strong>Provider:</strong> ${escapeHtml(launch.provider || "Unknown")}${webcast}</div>
      <div class="launch-line"><strong>Pad:</strong> ${escapeHtml(launch.pad || "TBD")} · ${escapeHtml(launch.location || "")}</div>
      <div class="launch-line launch-desc">${escapeHtml((launch.missionType || "").slice(0, 100))}</div>
    </article>`;
  }).join("");
  shell.dataset.snmFilled = "1";
}

function renderEventLog(d) {
  const shell = $("events-list");
  if (!shell) return;

  const events = buildEventLogEntries(d, historyData, sniffHistoryData);
  if (!events.length) {
    shell.innerHTML = '<tr><td colspan="4" class="event-empty">Recent timestamped events will appear here once the dashboard has enough history to build a timeline.</td></tr>';
    setHeaderPill("events-badge", "No recent events", "neutral");
    return;
  }

  shell.innerHTML = events.map((event) => `
    <tr class="event-row">
      <td class="event-time-cell">
        <div class="event-time">${fmtEventStamp(event.timestamp)}</div>
        <div class="event-age">${fmtAge(event.timestamp)}</div>
      </td>
      <td class="event-event-cell">
        <div class="event-tag" data-tone="${event.tone || "neutral"}">${event.tag}</div>
        <div class="event-title">${event.title}</div>
      </td>
      <td class="event-sound-cell">${eventSoundProfile(event, historyData, d)}</td>
      <td class="event-detail-cell">${event.detail}</td>
    </tr>
  `).join("");

  setHeaderPill("events-badge", `${events.length} recent events`, events[0].tone || "neutral");
}

function renderOdorMatrix(odors, primaryName) {
  const matrix = $("odor-matrix");
  const entries = (odors || []).map((score, index) => ({
    name: ODOR_NAMES[index] || `Odor ${index}`,
    score: num(score),
    primary: ODOR_NAMES[index] === primaryName
  }));

  $("matrix-note").textContent = entries.some((entry) => entry.score > 0)
    ? "All 20 classifier channels, highest confidence first."
    : "No odor channels have lit up yet.";

  matrix.innerHTML = entries
    .sort((a, b) => b.score - a.score)
    .map((entry) => `
      <div class="matrix-row ${entry.primary ? "is-primary" : ""}">
        <div class="matrix-topline">
          <span class="matrix-name">${entry.name}</span>
          <span class="matrix-score">${entry.score}%</span>
        </div>
        <div class="matrix-bar">
          <div class="matrix-fill" style="width:${entry.score}%;background:${tierColor(entry.score)}"></div>
        </div>
      </div>
    `).join("");
}

function drawHeroScope(current, history) {
  const canvas = $("hero-scope-canvas");
  const meta = $("hero-scope-meta");
  const insights = $("hero-scope-insights");
  if (!canvas || !meta) return;

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 960;
  const height = canvas.clientHeight || 200;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const liveHistory = Array.isArray(history) ? history.slice(0, 32).reverse() : [];
  const usingHistory = liveHistory.length >= 6;
  const now = Date.now() / 1000;
  const synthetic = Array.from({ length: 32 }, (_, index) => {
    const phase = now * 0.9 + index * 0.35;
    const vocBase = Math.max(0.2, num(current?.voc, 0.55));
    const airBase = clamp(num(current?.airScore, 18), 0, 100);
    const dVocBase = num(current?.dVoc, 0.08);
    return {
      voc: clamp(vocBase * (0.88 + 0.22 * Math.sin(phase)), 0, 8),
      airScore: clamp(airBase + 8 * Math.sin(phase * 0.75) + 4 * Math.cos(phase * 0.28), 0, 100),
      dVoc: clamp(dVocBase + 0.45 * Math.sin(phase * 1.4), -4, 4),
    };
  });

  const points = (usingHistory ? liveHistory : synthetic).map((item) => ({
    voc: Math.max(0, num(item.voc)),
    airScore: clamp(num(item.airScore), 0, 100),
    dVoc: clamp(num(item.dVoc), -6, 6),
  }));

  const latest = points[points.length - 1] || { voc: 0, airScore: 0, dVoc: 0 };
  const prev = points[points.length - 2] || latest;
  const cleanSeries = points.map((p) => clamp(100 - p.airScore, 0, 100));
  const latestClean = clamp(100 - latest.airScore, 0, 100);
  const vocTrendNow = latest.voc - prev.voc;
  const cleanTrendNow = latestClean - clamp(100 - prev.airScore, 0, 100);

  meta.textContent = usingHistory
    ? `${points.length} live samples · VOC ${latest.voc.toFixed(2)} ppm · dVOC ${fmtSigned(latest.dVoc, 2)}`
    : "Standby trace · synthetic preview until deeper room history arrives";

  if ($("scope-chip-voc")) $("scope-chip-voc").textContent = `VOC ${latest.voc.toFixed(2)} ppm`;
  if ($("scope-chip-clean")) $("scope-chip-clean").textContent = `Clean ${Math.round(latestClean)}%`;
  if ($("scope-chip-dvoc")) $("scope-chip-dvoc").textContent = `dVOC ${fmtSigned(latest.dVoc, 2)}`;

  const alertItems = [];
  if (latest.voc >= 3.0) {
    alertItems.push({ tone: "danger", text: `VOC heavy at ${latest.voc.toFixed(2)} ppm.` });
  } else if (latest.voc >= 1.5) {
    alertItems.push({ tone: "warn", text: `VOC elevated at ${latest.voc.toFixed(2)} ppm.` });
  }

  if (latest.dVoc >= 1.0 || vocTrendNow >= 0.45) {
    alertItems.push({ tone: "danger", text: `Fresh gas spike: ${fmtSigned(latest.dVoc, 2)} dVOC.` });
  } else if (latest.dVoc >= 0.3 || vocTrendNow >= 0.2) {
    alertItems.push({ tone: "warn", text: `New gas activity rising faster than baseline.` });
  }

  if (latest.airScore >= 60) {
    alertItems.push({ tone: "danger", text: `Room load is poor: ${Math.round(latest.airScore)}/100.` });
  } else if (latest.airScore >= 40 || cleanTrendNow <= -6) {
    alertItems.push({ tone: "warn", text: `Cleanliness is slipping: ${Math.round(latestClean)}% clean.` });
  }

  while (alertItems.length < 3) {
    if (!alertItems.length) {
      alertItems.push({ tone: "good", text: usingHistory ? "Trace is within normal operating bands." : "Waiting for enough real samples to flag anomalies." });
    } else if (alertItems.length === 1) {
      alertItems.push({ tone: "neutral", text: `Room index ${Math.round(latest.airScore)}/100. Lower room score is better.` });
    } else {
      alertItems.push({ tone: "neutral", text: `Latest rate: VOC ${fmtSigned(vocTrendNow, 2)} · Clean ${fmtSigned(cleanTrendNow, 0)}%.` });
    }
  }

  if (insights) {
    insights.innerHTML = alertItems.slice(0, 3).map((item) =>
      `<div class="scope-insight" data-tone="${escapeHtml(item.tone)}">${escapeHtml(item.text)}</div>`
    ).join("");
  }

  const padL = 46;
  const padR = 54;
  const padT = 16;
  const padB = 18;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const centerY = padT + plotH * 0.5;
  const maxVoc = Math.max(3.5, ...points.map((p) => p.voc * 1.08));
  const maxAbsDVoc = Math.max(1.2, ...points.map((p) => Math.abs(p.dVoc)));

  ctx.fillStyle = "rgba(3, 8, 12, 0.86)";
  ctx.fillRect(0, 0, width, height);

  const severeNow = alertItems.some((item) => item.tone === "danger");
  const warnNow = !severeNow && alertItems.some((item) => item.tone === "warn");
  if (severeNow || warnNow) {
    ctx.fillStyle = severeNow ? "rgba(231, 76, 60, 0.09)" : "rgba(255, 208, 92, 0.08)";
    ctx.fillRect(width - padR - 42, padT, 42, plotH);
  }

  ctx.strokeStyle = "rgba(52, 91, 110, 0.20)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const x = padL + (plotW / 8) * i;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, height - padB);
    ctx.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const y = padT + (plotH / 5) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(width - padR, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(255, 208, 92, 0.24)";
  ctx.beginPath();
  ctx.moveTo(padL, centerY);
  ctx.lineTo(width - padR, centerY);
  ctx.stroke();

  const drawDashedGuide = (y, color, label, labelX) => {
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(width - padR, y);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.font = "10px JetBrains Mono, monospace";
    ctx.textAlign = "left";
    ctx.fillText(label, labelX, y - 4);
  };

  const drawTrace = (series, color, glow, yForValue, lineWidth) => {
    ctx.beginPath();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    series.forEach((value, index) => {
      const x = padL + (index / Math.max(series.length - 1, 1)) * plotW;
      const y = yForValue(value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = glow;
    ctx.lineWidth = lineWidth + 3;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  };

  const drawFlag = (x, y, text, color, align = "right") => {
    ctx.save();
    ctx.font = "10px JetBrains Mono, monospace";
    const padX = 6;
    const padY = 4;
    const textW = ctx.measureText(text).width;
    const boxW = textW + padX * 2;
    const boxH = 18;
    const boxX = align === "right" ? x - boxW - 8 : x + 8;
    const boxY = clamp(y - boxH * 0.5, padT + 2, height - padB - boxH - 2);
    ctx.fillStyle = "rgba(5, 10, 14, 0.92)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.fillText(text, boxX + padX, boxY + 12);
    ctx.restore();
  };

  const vocY = (value) => padT + plotH * (1 - clamp(value / maxVoc, 0, 1));
  const cleanY = (value) => padT + plotH * (1 - clamp(value / 100, 0, 1));
  const dVocY = (value) => centerY - clamp(value / maxAbsDVoc, -1, 1) * (plotH * 0.28);

  drawDashedGuide(vocY(1.5), "rgba(73, 232, 255, 0.25)", "VOC 1.5", padL + 6);
  if (maxVoc >= 3.0) {
    drawDashedGuide(vocY(3.0), "rgba(231, 76, 60, 0.24)", "VOC 3.0", padL + 56);
  }
  drawDashedGuide(dVocY(0.3), "rgba(255, 208, 92, 0.18)", "dVOC +0.3", width - padR - 72);

  drawTrace(
    points.map((p) => p.voc),
    "#49e8ff",
    "rgba(73, 232, 255, 0.18)",
    vocY,
    2.2
  );
  drawTrace(
    cleanSeries.map((value) => value / 100),
    "#70f8c1",
    "rgba(112, 248, 193, 0.16)",
    (value) => padT + plotH * (1 - clamp(value, 0, 1)),
    2
  );
  drawTrace(
    points.map((p) => p.dVoc),
    "#ffd05c",
    "rgba(255, 208, 92, 0.16)",
    dVocY,
    1.7
  );

  const lastX = padL + plotW;
  ctx.fillStyle = "#49e8ff";
  ctx.beginPath();
  ctx.arc(lastX, vocY(latest.voc), 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#70f8c1";
  ctx.beginPath();
  ctx.arc(lastX, cleanY(latestClean), 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffd05c";
  ctx.beginPath();
  ctx.arc(lastX, dVocY(latest.dVoc), 3.3, 0, Math.PI * 2);
  ctx.fill();

  drawFlag(lastX, vocY(latest.voc), `${latest.voc.toFixed(2)} ppm`, "#49e8ff");
  drawFlag(lastX, cleanY(latestClean), `${Math.round(latestClean)}% clean`, "#70f8c1");
  drawFlag(lastX, dVocY(latest.dVoc), fmtSigned(latest.dVoc, 2), "#ffd05c");

  ctx.fillStyle = "rgba(188, 199, 216, 0.72)";
  ctx.font = "11px JetBrains Mono, monospace";
  ctx.textAlign = "right";
  ctx.fillText(`${maxVoc.toFixed(1)}`, padL - 8, padT + 4);
  ctx.fillText(`${(maxVoc / 2).toFixed(1)}`, padL - 8, padT + plotH * 0.5 + 4);
  ctx.fillText("0", padL - 8, height - padB + 4);
  ctx.fillStyle = "rgba(73, 232, 255, 0.84)";
  ctx.fillText("VOC ppm", padL - 8, padT - 2);

  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(112, 248, 193, 0.82)";
  ctx.fillText("100", width - padR + 8, padT + 4);
  ctx.fillText("50", width - padR + 8, padT + plotH * 0.5 + 4);
  ctx.fillText("0", width - padR + 8, height - padB + 4);
  ctx.fillText("Clean %", width - padR + 8, padT - 2);

  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255, 208, 92, 0.82)";
  ctx.fillText(`+${maxAbsDVoc.toFixed(1)}`, padL + 6, centerY - plotH * 0.28 - 4);
  ctx.fillText("0", padL + 6, centerY - 4);
  ctx.fillText(`-${maxAbsDVoc.toFixed(1)}`, padL + 6, centerY + plotH * 0.28 + 12);

  ctx.textAlign = "left";
  ctx.fillText("VOC", padL + 6, padT + 14);
  ctx.fillStyle = "rgba(112, 248, 193, 0.74)";
  ctx.fillText("CLEAN", padL + 42, padT + 14);
  ctx.fillStyle = "rgba(255, 208, 92, 0.78)";
  ctx.fillText("dVOC", padL + 94, padT + 14);

  // ── X-axis time labels ──
  ctx.fillStyle = "rgba(188, 199, 216, 0.50)";
  ctx.font = "10px JetBrains Mono, monospace";
  ctx.textAlign = "center";
  const xAxisY = height - padB + 13;
  if (usingHistory && liveHistory.length >= 2) {
    // Show real HH:MM clock times at positions that match the drawn trace (index-based).
    // Using index fractions rather than time fractions keeps labels aligned with the
    // actual data points on screen even when samples are unevenly spaced.
    const n = liveHistory.length;
    [0, 0.25, 0.5, 0.75, 1].forEach((frac) => {
      const idx = Math.round(frac * (n - 1));
      const x = padL + (idx / Math.max(n - 1, 1)) * plotW;
      const ts = num(liveHistory[idx]?.receivedAt, 0);
      const label = frac >= 1 ? "now" : new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      ctx.fillText(label, x, xAxisY);
    });
  } else {
    // Synthetic: estimate ~3s per sample interval, show relative offsets
    const synthCount = 32;
    const secPerSample = 3;
    const totalSec = synthCount * secPerSample;
    [0, 0.25, 0.5, 0.75, 1].forEach((frac) => {
      const x = padL + frac * plotW;
      const ageSec = Math.round(totalSec * (1 - frac));
      const label = ageSec === 0 ? "now" : ageSec < 60 ? `–${ageSec}s` : `–${Math.round(ageSec / 60)}m`;
      ctx.fillText(label, x, xAxisY);
    });
  }
}

function historySamplesForRhythm(history) {
  const pool = [];
  const seen = new Set();
  [lastData, ...(history || [])].forEach((item) => {
    const ts = num(item?.receivedAt, 0);
    if (!ts || seen.has(ts)) return;
    seen.add(ts);
    pool.push(item);
  });
  return pool;
}

function heatmapLevel(score) {
  if (score < 15) return 0;
  if (score < 30) return 1;
  if (score < 45) return 2;
  if (score < 60) return 3;
  if (score < 75) return 4;
  return 5;
}

function bucketBlockLabel(dayIndex, hour) {
  const label = HEATMAP_DAY_LABELS[HEATMAP_DAY_ORDER.indexOf(dayIndex)] || "Day";
  return `${label} ${String(hour).padStart(2, "0")}:00`;
}

function buildDailyRhythm(history) {
  const samples = historySamplesForRhythm(history);
  const buckets = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({
      sum: 0,
      count: 0,
      maxVoc: 0,
      maxDVoc: 0,
      maxIaq: 0,
    }))
  );

  samples.forEach((item) => {
    const ts = num(item?.receivedAt, 0);
    if (!ts) return;
    const stamp = snapshotDate(item);
    const day = stamp.getUTCDay();
    const hour = stamp.getUTCHours();
    const bucket = buckets[day][hour];
    bucket.sum += clamp(num(item.airScore), 0, 100);
    bucket.count += 1;
    bucket.maxVoc = Math.max(bucket.maxVoc, Math.max(0, num(item.voc)));
    bucket.maxDVoc = Math.max(bucket.maxDVoc, Math.abs(num(item.dVoc)));
    bucket.maxIaq = Math.max(bucket.maxIaq, clamp(num(item.iaq), 0, 500));
  });

  let activeSlots = 0;
  let hottest = null;
  let cleanest = null;

  const rows = HEATMAP_DAY_ORDER.map((dayIndex) =>
    Array.from({ length: 24 }, (_, hour) => {
      const bucket = buckets[dayIndex][hour];
      if (!bucket.count) {
        return {
          dayIndex,
          hour,
          label: bucketBlockLabel(dayIndex, hour),
          empty: true,
          avgScore: null,
          level: -1,
          detail: `${bucketBlockLabel(dayIndex, hour)} has no history yet.`,
          short: "",
        };
      }

      const avgScore = bucket.sum / bucket.count;
      const level = heatmapLevel(avgScore);
      const item = {
        dayIndex,
        hour,
        label: bucketBlockLabel(dayIndex, hour),
        empty: false,
        avgScore,
        level,
        sampleCount: bucket.count,
        peakVoc: bucket.maxVoc,
        peakDVoc: bucket.maxDVoc,
        peakIaq: bucket.maxIaq,
        detail: `${bucketBlockLabel(dayIndex, hour)} averaged ${Math.round(avgScore)}/100 room burden across ${bucket.count} sample${bucket.count === 1 ? "" : "s"}. Peak VOC ${bucket.maxVoc.toFixed(2)} ppm, peak dVOC ${fmtSigned(bucket.maxDVoc, 2)}, peak IAQ ${Math.round(bucket.maxIaq)}.`,
        short: level >= 5 ? "!" : level >= 4 ? "•" : "",
      };

      activeSlots += 1;
      if (!hottest || item.avgScore > hottest.avgScore) hottest = item;
      if (!cleanest || item.avgScore < cleanest.avgScore) cleanest = item;
      return item;
    })
  );

  return {
    sampleCount: samples.length,
    activeSlots,
    rows,
    hottest,
    cleanest,
  };
}

function drawTrendSeries(history) {
  const canvas = $("trend-series-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 960;
  const height = canvas.clientHeight || 180;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const nowSec = Date.now() / 1000;
  const windowSec = 24 * 3600;

  const raw = Array.isArray(history) ? history : [];
  const pts = raw
    .filter(h => h.receivedAt && nowSec - h.receivedAt < windowSec)
    .map(h => ({
      t: h.receivedAt,
      voc: Math.max(0, num(h.voc)),
      clean: clamp(100 - num(h.airScore, 100), 0, 100),
    }))
    .sort((a, b) => a.t - b.t);

  const padL = 46, padR = 52, padT = 20, padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  ctx.fillStyle = "rgba(3, 8, 12, 0.92)";
  ctx.fillRect(0, 0, width, height);

  if (!pts.length) {
    ctx.fillStyle = "rgba(120, 140, 160, 0.6)";
    ctx.font = `13px monospace`;
    ctx.textAlign = "center";
    ctx.fillText("Waiting for sensor history — data will appear here once readings arrive.", width / 2, height / 2 + 5);
    return;
  }

  const tEnd = nowSec;
  const tStart = tEnd - windowSec;
  const maxVoc = Math.max(2.0, ...pts.map(p => p.voc)) * 1.08;

  function xOf(t) { return padL + ((t - tStart) / windowSec) * plotW; }
  function yVoc(v) { return padT + (1 - v / maxVoc) * plotH; }
  function yClean(c) { return padT + (1 - c / 100) * plotH; }

  // Hour grid lines + labels
  for (let h = 0; h <= 24; h += 2) {
    const x = padL + (h / 24) * plotW;
    ctx.strokeStyle = "rgba(52, 91, 110, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    const tsec = tStart + h * 3600;
    const d = new Date(tsec * 1000);
    const label = h === 24 ? "now" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    ctx.fillStyle = "rgba(120, 140, 160, 0.55)";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText(label, x, padT + plotH + 14);
  }

  // Horizontal guide lines + y-axis labels
  for (let i = 0; i <= 4; i++) {
    const y = padT + (i / 4) * plotH;
    ctx.strokeStyle = "rgba(52, 91, 110, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();

    const vocVal = maxVoc * (1 - i / 4);
    ctx.fillStyle = "rgba(0, 242, 255, 0.45)";
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    ctx.fillText(vocVal.toFixed(1), padL - 4, y + 4);

    const cleanVal = 100 * (1 - i / 4);
    ctx.fillStyle = "rgba(100, 220, 120, 0.45)";
    ctx.textAlign = "left";
    ctx.fillText(`${Math.round(cleanVal)}%`, padL + plotW + 4, y + 4);
  }

  // "now" vertical marker
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(padL + plotW, padT); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();
  ctx.setLineDash([]);

  // Clean % line (dashed green)
  ctx.strokeStyle = "rgba(100, 220, 120, 0.60)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  pts.forEach((p, i) => {
    i === 0 ? ctx.moveTo(xOf(p.t), yClean(p.clean)) : ctx.lineTo(xOf(p.t), yClean(p.clean));
  });
  ctx.stroke();
  ctx.setLineDash([]);

  // VOC fill under curve (only meaningful with 2+ points)
  if (pts.length >= 2) {
    ctx.fillStyle = "rgba(0, 242, 255, 0.07)";
    ctx.beginPath();
    ctx.moveTo(xOf(pts[0].t), padT + plotH);
    pts.forEach(p => ctx.lineTo(xOf(p.t), yVoc(p.voc)));
    ctx.lineTo(xOf(pts[pts.length - 1].t), padT + plotH);
    ctx.closePath();
    ctx.fill();
  }

  // VOC line (solid cyan)
  ctx.strokeStyle = "rgba(0, 242, 255, 0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => {
    i === 0 ? ctx.moveTo(xOf(p.t), yVoc(p.voc)) : ctx.lineTo(xOf(p.t), yVoc(p.voc));
  });
  ctx.stroke();

  // Dots when sparse
  if (pts.length <= 24) {
    pts.forEach(p => {
      ctx.fillStyle = "rgba(0, 242, 255, 0.9)";
      ctx.beginPath();
      ctx.arc(xOf(p.t), yVoc(p.voc), 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Legend
  ctx.font = "10px monospace";
  ctx.fillStyle = "rgba(0, 242, 255, 0.75)";
  ctx.textAlign = "left";
  ctx.fillText("── VOC (ppm)", padL, padT - 6);
  ctx.fillStyle = "rgba(100, 220, 120, 0.75)";
  ctx.fillText("╌╌ Clean (%)", padL + 95, padT - 6);
  ctx.fillStyle = "rgba(120, 140, 160, 0.55)";
  ctx.textAlign = "right";
  ctx.fillText(`${pts.length} samples · last 24 h`, padL + plotW, padT - 6);
}

function drawChart(history) {
  drawTrendSeries(history);
  const shell = $("history-chart");
  const detail = $("heatmap-detail");
  if (!shell) return;

  const rhythm = buildDailyRhythm(history);
  if (!rhythm.activeSlots) {
    shell.innerHTML = '<div class="heatmap-empty">Waiting for enough history to build the daily rhythm grid.</div>';
    if (detail) detail.textContent = "Select a time block to inspect that weekday/hour pattern in more detail.";
    setHeaderPill("chart-badge", "No rhythm yet", "neutral");
    return;
  }

  const cells = [];
  cells.push('<div class="heatmap-hour"></div>');
  for (let hour = 0; hour < 24; hour += 1) {
    cells.push(`<div class="heatmap-hour">${String(hour).padStart(2, "0")}</div>`);
  }

  rhythm.rows.forEach((row, rowIndex) => {
    cells.push(`<div class="heatmap-day">${HEATMAP_DAY_LABELS[rowIndex]}</div>`);
    row.forEach((cell) => {
      cells.push(`
        <button
          class="heatmap-cell${cell.empty ? " is-empty" : ""}${rhythm.hottest && !cell.empty && rhythm.hottest.dayIndex === cell.dayIndex && rhythm.hottest.hour === cell.hour ? " is-hot" : ""}"
          type="button"
          data-level="${cell.level}"
          data-short="${escapeHtml(cell.short)}"
          data-detail="${escapeHtml(cell.detail)}"
          title="${escapeHtml(cell.detail)}"
          aria-label="${escapeHtml(cell.detail)}"
        ></button>
      `);
    });
  });

  shell.innerHTML = `<div class="heatmap-grid">${cells.join("")}</div>`;
  shell.querySelectorAll(".heatmap-cell[data-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      if (detail) detail.textContent = button.dataset.detail || "";
    });
  });

  if (detail && rhythm.hottest) {
    detail.textContent = `${rhythm.hottest.label} is the hottest recurring block so far at ${Math.round(rhythm.hottest.avgScore)}/100.`;
  }

  const badgeTone = rhythm.hottest && rhythm.hottest.avgScore >= 60 ? "warn" : "good";
  setHeaderPill("chart-badge", `${rhythm.activeSlots} active slots · ${rhythm.sampleCount} samples`, badgeTone);
}

function updateHistoryStats(history) {
  const rhythm = buildDailyRhythm(history);
  if (!rhythm.activeSlots) return;

  $("chart-latest").textContent = rhythm.hottest
    ? `${rhythm.hottest.label} · ${Math.round(rhythm.hottest.avgScore)}/100`
    : "--";
  $("chart-best").textContent = rhythm.cleanest
    ? `${rhythm.cleanest.label} · ${Math.round(rhythm.cleanest.avgScore)}/100`
    : "--";
  $("chart-voc").textContent = `${rhythm.activeSlots} slots from ${rhythm.sampleCount} samples`;
}

// ── Restoration Safety Monitor ────────────────────────────────────────────
// Front-end mirror of lib/thresholds.js — KEEP THESE NUMBERS IN SYNC with the
// backend. Drives the always-visible alert strip, the 24h baseline panel, and
// pulsing-red card states for the switchgear-restoration deployment.
const RESTORATION_THRESHOLDS = {
  HUMIDITY_HIGH: 55, // %RH — condensation risk on open buswork
  TEMP_HIGH_C: 40, // °C — control failure / overheating
  IAQ_POOR: 150, // BME688 IAQ (higher = worse)
  GAS_DROP_RATIO: 0.6, // gasR ≤ 60% of baseline = ≥40% sudden drop
  GAS_MIN_BASELINE: 1000, // Ohms noise floor for the drop test
};
// Map each breach key to the metric element it should pulse red.
const RESTORATION_ALERT_TARGETS = {
  humidity: "v-hum",
  temp: "v-temp",
  gas: "v-gasr-raw",
  iaq: "derived-iaq",
};
let dailySummaryState = { fetchedAt: 0, data: null, pending: false };

function normalizeReadingClient(d) {
  const s = d && typeof d === "object" ? d : {};
  let tempC = num(s.temperature, NaN);
  if (!Number.isFinite(tempC)) tempC = num(s.tempC, NaN);
  if (!Number.isFinite(tempC)) {
    const tempF = num(s.tempF, NaN);
    if (Number.isFinite(tempF)) tempC = ((tempF - 32) * 5) / 9;
  }
  let gasR = num(s.gasR, NaN);
  if (!Number.isFinite(gasR)) gasR = num(s.gas_resistance, NaN);
  if (!Number.isFinite(gasR)) gasR = num(s.gasResistance, NaN);
  return {
    tempC,
    humidity: num(s.humidity, NaN),
    gasR,
    iaq: num(s.iaq, NaN),
    receivedAt: num(s.receivedAt, NaN),
  };
}

function baselineGasRClient() {
  const values = (Array.isArray(historyData) ? historyData : [])
    .slice(1) // drop the newest (current) reading
    .map((h) => normalizeReadingClient(h).gasR)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (!values.length) return NaN;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

function evaluateBreachesClient(r, baseGasR) {
  const out = [];
  const T = RESTORATION_THRESHOLDS;
  if (Number.isFinite(r.humidity) && r.humidity > T.HUMIDITY_HIGH) {
    out.push({ key: "humidity", text: `Humidity ${r.humidity.toFixed(0)}% (>${T.HUMIDITY_HIGH}%) — condensation risk` });
  }
  if (Number.isFinite(r.tempC) && r.tempC > T.TEMP_HIGH_C) {
    out.push({ key: "temp", text: `Temp ${r.tempC.toFixed(1)}°C (>${T.TEMP_HIGH_C}°C) — overheating` });
  }
  if (
    Number.isFinite(r.gasR) &&
    Number.isFinite(baseGasR) &&
    baseGasR >= T.GAS_MIN_BASELINE &&
    r.gasR <= baseGasR * T.GAS_DROP_RATIO
  ) {
    const dropPct = Math.round((1 - r.gasR / baseGasR) * 100);
    out.push({ key: "gas", text: `Gas resistance ↓${dropPct}% — possible smoke/fumes` });
  }
  if (Number.isFinite(r.iaq) && r.iaq >= T.IAQ_POOR) {
    out.push({ key: "iaq", text: `IAQ ${r.iaq.toFixed(0)} (>=${T.IAQ_POOR}) — degraded air` });
  }
  return out;
}

function ensureRestorationDom() {
  let strip = document.getElementById("restoration-alert-strip");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "restoration-alert-strip";
    strip.className = "restoration-alert-strip is-hidden";
    strip.setAttribute("role", "alert");
    strip.setAttribute("aria-live", "assertive");
    document.body.prepend(strip);
  }

  let panel = document.getElementById("card-restoration");
  if (!panel) {
    const dashboard = document.getElementById("dashboard");
    if (dashboard) {
      panel = document.createElement("section");
      panel.className = "card restoration-card";
      panel.id = "card-restoration";
      panel.dataset.view = "dashboard";
      panel.innerHTML = `
        <div class="card-header">
          <span>Restoration Safety Monitor</span>
          <span class="header-pill" id="restoration-pill">Monitoring</span>
        </div>
        <p class="card-summary" id="restoration-live">Watching temperature, humidity, and air quality for switchgear-safe limits.</p>
        <div class="restoration-summary" id="restoration-summary">
          <p class="restoration-empty">Daily 24h baseline will appear after the first morning report.</p>
        </div>`;
      // Honor the current tab's visibility rules on injection.
      panel.classList.toggle("is-hidden", (typeof activeView === "string" ? activeView : "dashboard") !== "dashboard");
      dashboard.prepend(panel);
    }
  }
  return { strip, panel };
}

function renderRestorationMonitor(d) {
  const { strip } = ensureRestorationDom();
  const reading = normalizeReadingClient(d);
  const hasSnapshot = Number.isFinite(reading.receivedAt) && reading.receivedAt > 0;
  const age = hasSnapshot ? Date.now() - reading.receivedAt : Infinity;
  const isStale = hasSnapshot && age > STALE_MS;
  const breaches = evaluateBreachesClient(reading, baselineGasRClient());

  // Pulse the individual metric cards that are breaching.
  const breachKeys = new Set(breaches.map((b) => b.key));
  for (const [key, elId] of Object.entries(RESTORATION_ALERT_TARGETS)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    const target = el.closest(".telemetry-item") || el;
    target.classList.toggle("restoration-alert", breachKeys.has(key));
  }

  // Always-visible alert strip: device offline and/or active breaches.
  const messages = [];
  if (!hasSnapshot) {
    messages.push("Waiting for first telemetry from the device…");
  } else if (isStale) {
    messages.push(`⚠ No telemetry for ${fmtAge(reading.receivedAt).replace(" ago", "")} — check device power / Wi-Fi.`);
  }
  for (const b of breaches) messages.push(`⚠ ${b.text}`);

  if (strip) {
    const active = isStale || breaches.length > 0;
    strip.classList.toggle("is-hidden", !active);
    strip.classList.toggle("is-offline", isStale && breaches.length === 0);
    strip.textContent = active ? messages.join("   ·   ") : "";
  }

  // Live status line + pill on the panel.
  const live = $("restoration-live");
  const pill = $("restoration-pill");
  if (live && pill) {
    if (!hasSnapshot) {
      live.textContent = "Waiting for the first live snapshot from the device.";
      setHeaderPill("restoration-pill", "Connecting", "neutral");
    } else if (isStale) {
      live.textContent = `Device offline — last reading ${fmtAge(reading.receivedAt)}. Check power/Wi-Fi in the field.`;
      setHeaderPill("restoration-pill", "Offline", "danger");
    } else if (breaches.length > 0) {
      live.textContent = breaches.map((b) => b.text).join(" · ");
      setHeaderPill("restoration-pill", `${breaches.length} alert${breaches.length > 1 ? "s" : ""}`, "danger");
    } else {
      live.textContent = "All parameters within switchgear-safe limits.";
      setHeaderPill("restoration-pill", "All clear", "good");
    }
  }

  ensureDailySummary();
}

function ensureDailySummary() {
  const TEN_MIN = 600000;
  if (dailySummaryState.pending) return;
  if (dailySummaryState.data && Date.now() - dailySummaryState.fetchedAt < TEN_MIN) {
    renderDailySummary(dailySummaryState.data);
    return;
  }
  dailySummaryState.pending = true;
  fetch("/api/daily-summary", { cache: "no-store" })
    .then((res) => (res.status === 204 ? null : res.ok ? res.json() : null))
    .then((data) => {
      dailySummaryState.data = data;
      dailySummaryState.fetchedAt = Date.now();
      renderDailySummary(data);
    })
    .catch((err) => console.error("daily-summary fetch failed:", err))
    .finally(() => {
      dailySummaryState.pending = false;
    });
}

function renderDailySummary(s) {
  const wrap = $("restoration-summary");
  if (!wrap) return;
  if (!s || !s.sampleCount) {
    wrap.innerHTML = `<p class="restoration-empty">Daily 24h baseline will appear after the first morning report (06:00 ET).</p>`;
    return;
  }
  const stat = (obj, unit, digits = 0) =>
    obj
      ? `avg ${num(obj.avg).toFixed(digits)}${unit} <span class="rs-range">(${num(obj.min).toFixed(digits)}–${num(obj.max).toFixed(digits)})</span>`
      : "—";
  const gasStat = (obj) => {
    if (!obj) return "—";
    const a = num(obj.avg);
    const label = a >= 1e6 ? `${(a / 1e6).toFixed(2)}MΩ` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}kΩ` : `${Math.round(a)}Ω`;
    return `avg ${label}`;
  };
  const when = num(s.generatedAt) ? fmtStamp(s.generatedAt) : "";
  const esc = (t) => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = [
    ["🌡 Temperature", stat(s.temp, "°C", 1)],
    ["💧 Humidity", stat(s.humidity, "%", 0)],
    ["◈ Pressure", stat(s.pressure, " hPa", 0)],
    ["🔬 Gas resistance", gasStat(s.gas)],
    ["⚗ Air quality (IAQ)", stat(s.iaq, "", 0)],
  ];
  wrap.innerHTML = `
    <div class="restoration-verdict ${s.controlsStabilizing ? "is-good" : "is-bad"}">
      ${s.controlsStabilizing ? "✅" : "❌"} ${s.controlsNote || ""}
    </div>
    ${s.reportText ? `<div class="restoration-bro">💬 This morning's text: &ldquo;${esc(s.reportText)}&rdquo;${s.launchLine ? `<br>🚀 ${esc(s.launchLine)}` : ""}</div>` : ""}
    <div class="restoration-stats">
      ${rows.map(([k, v]) => `<div class="rs-row"><span class="rs-key">${k}</span><span class="rs-val">${v}</span></div>`).join("")}
    </div>
    <div class="restoration-foot">24h baseline · ${s.sampleCount} samples${when ? ` · updated ${when}` : ""}</div>`;
}

function render(data) {
  if (!data) return;
  let merged = mergeBriefingIntoSnapshot(mergeSnapshotWithSniff(data), weatherBriefingState.data);
  // Keep independently-fetched Cape launch data in sync with the space card report
  if (Array.isArray(launchState.data) && launchState.data.length && !(Array.isArray(merged.launches) && merged.launches.length)) {
    merged = { ...merged, launches: launchState.data };
  }
  lastData = merged;

  const age = Date.now() - num(merged.receivedAt, 0);
  const isLive = age < STALE_MS;
  $("conn-dot").className = `dot ${isLive ? "online" : "stale"}`;
  $("conn-label").textContent = num(merged.receivedAt) ? (isLive ? "Live feed" : `Stale · ${fmtAge(merged.receivedAt)}`) : "Waiting for feed";

  renderHero(merged);
  drawHeroScope(merged, historyData);
  renderStatusStrip(merged);
  renderIntelDrawer(merged);
  renderCauseCard(merged);
  renderOfficeCard(merged);
  renderTelemetry(merged);
  renderDerivedMetrics(merged);
  renderBreathCard(merged);
  renderApod(apodState.data);
  renderSpaceCard(merged);
  renderOdorCard(merged);
  renderWeatherIntel(merged);
  renderWeatherForecast(merged, weatherBriefingState.data);
  renderConditionsSummary(merged, weatherBriefingState.data);
  renderLaunchDeck(merged);
  renderEventLog(merged);

  $("bro-summary").textContent = buildBroSummary(merged);
  $("bro-report").innerHTML = renderStructuredReport(buildBroReport(merged));

  setHeaderPill("launch-badge", Array.isArray(merged.launches) && merged.launches.length ? `${merged.launches.length} Cape launches` : "No launch data", Array.isArray(merged.launches) && merged.launches.length ? "good" : "neutral");
  setHeaderPill("odor-badge", `${currentPrimary(merged)} · ${Math.round(num(merged.primaryConf))}%`, num(merged.primaryConf) >= 45 ? "warn" : num(merged.primaryConf) >= 20 ? "neutral" : "good");
  setHeaderPill(
    "weather-intel-badge",
    hasLocationFix(merged) ? (merged.weatherCondition || "Map live") : "Cape Canaveral, FL",
    outdoorSeverity(merged) >= 3 ? "danger" : outdoorSeverity(merged) >= 2 ? "warn" : hasLocationFix(merged) ? "good" : "neutral"
  );
  const broBadge = broBadgeInfo(merged);
  setHeaderPill("bro-badge", broBadge.text, broBadge.tone);

  $("last-update").textContent = num(merged.receivedAt) ? `Updated ${fmtAge(merged.receivedAt)} · ${fmtStamp(merged.receivedAt)}` : "No data yet";
  $("v-uptime").textContent = fmtUptime(merged.uptime);

  renderRestorationMonitor(merged);

  ensureWeatherBriefing(merged);
  ensureLaunchData();
  ensureOccupancyBriefing();
  ensureApod();

  if (historyData.length) {
    drawChart(historyData);
    updateHistoryStats(historyData);
  }
}

function applySniffEvent(event) {
  if (!event || typeof event !== "object") return;
  lastSniffEvent = event;
  if (!sniffHistoryData.some((item) => num(item.seq) === num(event.seq))) {
    sniffHistoryData = [event, ...sniffHistoryData].slice(0, 16);
  }
  if (lastData) {
    render({
      ...lastData,
      sniffEvent: event,
      sniffLabel: event.label,
      sniffAt: event.receivedAt,
      sniffSeq: event.seq,
      vscConf: Math.max(num(lastData.vscConf, 0), num(event.vsc_conf, 0)),
    });
  }
}

async function fetchLatest() {
    try {
        const res = await fetch("/api/latest", {
            cache: "no-store"
        });
        if (res.status === 204) return;
        if (!res.ok) throw new Error(`latest ${res.status}`);

        const data = await res.json();
        lastData = data;
        render(data);
    } catch (err) {
        console.error("fetchLatest failed:", err);
        // Only go amber when the cached data itself is stale; keep green if it
        // is still fresh so a single failed poll does not falsely alarm.
        if (lastData?.receivedAt) {
            const dataAge = Date.now() - lastData.receivedAt;
            if (dataAge >= STALE_MS) {
                $("conn-dot").className = "dot stale";
            }
            $("conn-label").textContent = `Feed unavailable · ${fmtAge(lastData.receivedAt)}`;
        } else {
            $("conn-dot").className = "dot offline";
            $("conn-label").textContent = "Feed unavailable";
        }
    }
}

async function manualRefreshDashboard() {
  if (manualRefreshPending) return;
  manualRefreshPending = true;
  const button = $("manual-refresh-btn");
  const priorLabel = button?.textContent || "Refresh Now";
  const priorConn = $("conn-label")?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing...";
  }
  if ($("conn-label")) $("conn-label").textContent = "Refreshing portal data...";
  try {
    await Promise.all([
      fetchLatest(),
      fetchLatestSniff(),
    ]);
    fetchHistory();
    fetchSniffHistory();
    if (lastData) {
      weatherBriefingState.fetchedAt = 0;
      weatherBriefingState.key = "";
      await ensureWeatherBriefing(lastData);
    }
  } finally {
    manualRefreshPending = false;
    if (button) {
      button.disabled = false;
      button.textContent = priorLabel;
    }
    if ($("conn-label") && !lastData?.receivedAt) $("conn-label").textContent = priorConn || "Waiting for feed";
  }
}

function setRemoteControlsState(message, tone = "neutral") {
  const status = $("remote-controls-status");
  const pill = $("remote-controls-pill");
  if (status) status.textContent = message;
  if (pill) {
    pill.textContent = tone === "good" ? "Unlocked" : tone === "warn" ? "Busy" : "Offline";
    pill.dataset.tone = tone;
  }
}

function syncRemoteControlsUi(options = {}) {
  const preserveStatus = Boolean(options.preserveStatus);
  document.querySelectorAll(".remote-action-btn").forEach((button) => {
    button.disabled = remoteCommandPending;
  });
  if (preserveStatus) return;
  setRemoteControlsState(
    remoteCommandPending
      ? "Waiting for the current action to finish queuing."
      : "Remote actions ready. Queue a live device action without touching the hardware.",
    remoteCommandPending ? "warn" : "good"
  );
}

async function queueRemoteAction(action, extra = {}) {
  remoteCommandPending = true;
  syncRemoteControlsUi();
  setRemoteControlsState("Queueing remote device action...", "warn");

  try {
    const res = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });

    if (!res.ok) {
      throw new Error(`command ${res.status}`);
    }

    const data = await res.json();
    const labels = {
      refresh: "Device sync queued",
      breath_check: "Breath check queued",
      presence_probe: "Presence probe queued",
    };
    setRemoteControlsState(`${labels[action] || "Action queued"}. Device will pick it up on its next command poll.`, "good");

    if (action === "refresh") {
      await manualRefreshDashboard();
    }
  } catch (_) {
    setRemoteControlsState("Action queue failed. Check the portal connection and try again.", "neutral");
  } finally {
    remoteCommandPending = false;
    syncRemoteControlsUi({ preserveStatus: true });
  }
}

async function fetchHistory() {
  try {
    const res = await fetch("/api/history?count=1008", { cache: "no-store" });
    if (!res.ok) return;
    historyData = await res.json();
    drawChart(historyData);
    updateHistoryStats(historyData);
    if (lastData) render(lastData);
  } catch (_) {}
}

async function fetchLatestSniff() {
  try {
    const res = await fetch("/api/sniff", { cache: "no-store" });
    if (res.status === 204) return;
    if (!res.ok) throw new Error(`sniff ${res.status}`);
    applySniffEvent(await res.json());
  } catch (_) {}
}

async function fetchSniffHistory() {
  try {
    const res = await fetch("/api/sniff-history?count=16", { cache: "no-store" });
    if (!res.ok) return;
    sniffHistoryData = await res.json();
    if (lastData) render(lastData);
  } catch (_) {}
}

function startSniffStream() {
  if (!("EventSource" in window)) return;
  if (sniffStream) sniffStream.close();

  const after = activeSniffEvent()?.seq ? `?after=${encodeURIComponent(activeSniffEvent().seq)}` : "";
  sniffStream = new EventSource(`/api/sniff-stream${after}`);

  const handleIncoming = (raw) => {
    try {
      applySniffEvent(JSON.parse(raw.data));
    } catch (_) {}
  };

  sniffStream.addEventListener("sniff", handleIncoming);
  sniffStream.onmessage = handleIncoming;
  sniffStream.onerror = () => {
    fetchLatestSniff();
  };
}

function tickAge() {
  if (!lastData?.receivedAt) return;
  const age = Date.now() - lastData.receivedAt;
  $("last-update").textContent = `Updated ${fmtAge(lastData.receivedAt)} · ${fmtStamp(lastData.receivedAt)}`;
  if (age > STALE_MS) {
    $("conn-dot").className = "dot stale";
    $("conn-label").textContent = `Stale · ${fmtAge(lastData.receivedAt)}`;
  }
}

let _subnav_observer = null;

function activateSubnavObserver() {
  if (_subnav_observer) _subnav_observer.disconnect();
  const panel = $("view-subnav-panel");
  if (!panel) return;
  const targets = Array.from(panel.querySelectorAll("[data-scroll-target]"))
    .map((btn) => ({ btn, el: document.getElementById(btn.dataset.scrollTarget || "") }))
    .filter((e) => e.el);
  if (!targets.length) return;
  _subnav_observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        targets.forEach(({ btn, el }) => btn.classList.toggle("is-active", el === entry.target));
      });
    },
    { rootMargin: "-20% 0px -60% 0px", threshold: 0 }
  );
  targets.forEach(({ el }) => _subnav_observer.observe(el));
}

function renderViewSubnav(view) {
  const shell = $("view-submenu-shell");
  const panel = $("view-subnav-panel");
  const count = $("view-subnav-count");
  if (!shell || !panel || !count) return;
  const items = VIEW_SECTIONS[view] || [];
  shell.hidden = items.length === 0;
  count.textContent = items.length === 1 ? "1 section" : `${items.length} sections`;
  panel.innerHTML = items.map((item, index) =>
    `<button class="view-submenu-item" type="button" data-scroll-target="${escapeHtml(item.id)}">
      <span class="view-submenu-item-eyebrow">Section ${index + 1}</span>
      <span class="view-submenu-item-label">${escapeHtml(item.label)}</span>
    </button>`
  ).join("");

  panel.querySelectorAll("[data-scroll-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.getElementById(button.dataset.scrollTarget || "");
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      closeViewSubmenu();
    });
  });

  closeViewSubmenu();
  activateSubnavObserver();
}

function setDashboardView(view) {
  const nextView = VIEW_META[view] ? view : "dashboard";
  activeView = nextView;
  saveViewPref(nextView);

  if (window.history?.replaceState) {
    const nextUrl = nextView === "dashboard" ? window.location.pathname : `${window.location.pathname}#${nextView}`;
    window.history.replaceState(null, "", nextUrl);
  }

  document.querySelectorAll("[data-view-target]").forEach((button) => {
    const on = button.dataset.viewTarget === nextView;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });

  document.querySelectorAll("#dashboard > [data-view]").forEach((card) => {
    const views = `${card.dataset.view || "dashboard"}`.split(/\s+/).filter(Boolean);
    card.classList.toggle("is-hidden", !views.includes(nextView));
  });

  const meta = VIEW_META[nextView] || VIEW_META.dashboard;
  if ($("view-title")) $("view-title").textContent = meta.title;
  if ($("view-subtitle")) $("view-subtitle").textContent = meta.subtitle;
  renderViewSubnav(nextView);

    window.requestAnimationFrame(() => {
        if (nextView === "environment" || nextView === "analysis") {
            const map = ensureWeatherMap();
            if (map) {
                // Defer so the browser finishes painting the newly-visible card
                // before Leaflet measures the container dimensions.
                setTimeout(() => {
                    map.invalidateSize();
                    syncWeatherMapPosition(lastData || {});
                    syncMapLayers();
                }, 50);
            }
        }
        if (nextView === "space") {
            ensureLaunchData();
            ensureApod();
        }
        if (nextView === "history" && historyData.length) {
            drawChart(historyData);
            updateHistoryStats(historyData);
        }
    });
}

const trajectoryArcade = (() => {
  // ═══════════════════════════════════════════════════════════════
  // GATORNAUTS — 8-bit Rocket Flyer
  // Dodge asteroid walls and alien gators. Steer left/right.
  // Controls: ← → to steer  |  ↑ / SPACE for boost
  // ═══════════════════════════════════════════════════════════════

  const SECRET_SEQUENCE = [
    "arrowup", "arrowup", "arrowdown", "arrowdown",
    "arrowleft", "arrowright", "arrowleft", "arrowright",
    "b", "a"
  ];

  const STATE = {
    START_SCREEN: "start",
    LAUNCHING: "launching",
    PLAYING: "playing",
    GAME_OVER: "gameover",
  };

  const overlay = $("trajectory-overlay");
  const canvas = $("trajectory-canvas");
  const brief = $("trajectory-brief");
  const missionStatus = $("trajectory-mission-status");
  const closeBtn = $("trajectory-close-btn");
  const restartBtn = $("trajectory-restart-btn");
  const mobileControls = $("trajectory-mobile-controls");
  const themeChip = $("header-theme");

  if (!overlay || !canvas) {
    return { init() {} };
  }

  const ctx = canvas.getContext("2d");
  const W = 960;
  const H = 640;

  // Input state
  const input = { left: false, right: false, boost: false, fire: false };
  const touchPointers = new Map();

  // ── 8-bit color palette ──
  const FTL = {
    bg: "#0a0e14",
    panel: "rgba(14, 20, 30, 0.92)",
    panelBorder: "rgba(80, 140, 180, 0.25)",
    text: "#c8d8e8",
    textDim: "#5a7088",
    textBright: "#e8f4ff",
    green: "#4caf50",
    red: "#e05050",
    yellow: "#d4a828",
    blue: "#3888cc",
    blueLight: "#68b8e8",
    blueDark: "#0a3d91",
    orange: "#e88830",
    cyan: "#48c8e8",
    white: "#e0e8f0",
    amber: "#f0a820",
  };

  // ── Game constants ──
  const ROCKET_Y = H - 100;          // fixed screen Y of rocket
  const ROCKET_W = 24;               // full collision width (half = 12px each side)
  const ROCKET_H = 38;               // full collision height (half = 19px each side)
  const STEER_SPEED = 350;           // px/sec lateral
  const SCROLL_BASE = 120;           // starting scroll speed px/sec (reduced for easier start)
  const SCROLL_MAX = 340;            // max scroll speed (reduced from 420)
  const SCROLL_RAMP = 6;             // px/sec faster per row cleared (reduced from 10)
  const GAP_START = 270;             // initial gap width (increased from 210)
  const GAP_MIN = 150;               // minimum gap width (increased from 105)
  const GAP_NARROW = 1.4;            // px narrower per row cleared (reduced from 1.8)
  const OBSTACLE_H = 44;             // height of asteroid block
  const ROW_SPACING = 250;           // vertical px between obstacle rows (increased for more breathing room)
  const SPAWN_DIST = -OBSTACLE_H - 10; // y coord to spawn obstacles (just off top)
  const BOOST_DUR = 0.4;             // seconds of boost
  const BOOST_CD = 1.8;              // boost cooldown seconds
  const BOOST_MULT = 2.0;            // scroll speed multiplier during boost
  const GATOR_EVERY = 3;             // gator appears every N rows (increased from 4)
  const LASER_SPEED = 700;           // laser bolt travel speed px/sec (upward)
  const LASER_CD = 0.5;              // seconds between laser shots
  const LASER_W = 4;                 // laser bolt width px
  const LASER_H = 18;                // laser bolt height px

  // ── Altitude phase helpers ──
  // Returns 0.0–5.0 raw phase for smooth interpolation
  function getRawPhase(rows) {
    if (rows < 8)   return rows / 8;
    if (rows < 25)  return 1 + (rows - 8) / 17;
    if (rows < 55)  return 2 + (rows - 25) / 30;
    if (rows < 110) return 3 + (rows - 55) / 55;
    return 4 + Math.min(1, (rows - 110) / 50);
  }
  // Integer phase: 0=near-earth, 1=LEO, 2=deep-space, 3=outer-system, 4=interstellar
  function getAltitudePhase(rows) {
    return Math.min(4, Math.floor(getRawPhase(rows)));
  }

  // ── Runtime state ──
  const runtime = {
    mode: STATE.START_SCREEN,
    open: false,
    lastTs: 0,
    rafId: 0,
    rocketX: W / 2,
    rocketVX: 0,
    boostTimer: 0,
    boostCooldown: 0,
    scrollSpeed: SCROLL_BASE,
    spawnTimer: 0,
    obstacles: [],
    rowsCleared: 0,
    score: 0,
    highScore: 0,
    particles: [],
    stars: [],
    unlockBuffer: [],
    themeTapCount: 0,
    themeTapTs: 0,
    crashFlash: 0,
    rowsSinceGator: 0,
    launchTimer: 0,
    endReason: "",
    lasers: [],
    laserCooldown: 0,
    gatorsBlasted: 0,
  };

  // ── Stars ──
  function buildStars() {
    runtime.stars = Array.from({ length: 130 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      size: Math.random() < 0.12 ? 2 : 1,
      parallax: 0.15 + Math.random() * 0.7,
      bright: Math.random() < 0.15,
    }));
  }

  // ── Reset to fresh game state ──
  function resetGame() {
    runtime.rocketX = W / 2;
    runtime.rocketVX = 0;
    runtime.boostTimer = 0;
    runtime.boostCooldown = 0;
    runtime.scrollSpeed = SCROLL_BASE;
    runtime.spawnTimer = 0;
    runtime.obstacles = [];
    runtime.rowsCleared = 0;
    runtime.score = 0;
    runtime.particles = [];
    runtime.crashFlash = 0;
    runtime.rowsSinceGator = 0;
    runtime.launchTimer = 0;
    runtime.endReason = "";
    runtime.lasers = [];
    runtime.laserCooldown = 0;
    runtime.gatorsBlasted = 0;
    if (missionStatus) missionStatus.textContent = "T-MINUS NOMINAL · LAUNCH VEHICLE READY · GODSPEED.";
    // Pre-place first obstacle a bit below the top so player has a moment to react
    spawnRow(H * 0.35);
  }

  // ── Spawn one obstacle row at screen y ──
  function spawnRow(y) {
    const gapW = Math.max(GAP_MIN, GAP_START - runtime.rowsCleared * GAP_NARROW);
    const margin = 48;
    const gapX = margin + Math.random() * (W - margin * 2 - gapW);
    runtime.rowsSinceGator++;
    const hasGator = runtime.rowsCleared >= 2 && runtime.rowsSinceGator >= GATOR_EVERY;
    const gators = [];
    if (hasGator) {
      runtime.rowsSinceGator = 0;
      // Late-game rows can have two gators
      const gatorCount = runtime.rowsCleared >= 20 && Math.random() < 0.4 ? 2 : 1;
      for (let gi = 0; gi < gatorCount; gi++) {
        const dir = (gi === 0 ? (Math.random() < 0.5 ? 1 : -1) : -1);
        const spread = gi * (gapW * 0.35);
        const startX = dir > 0 ? gapX + 10 + spread : gapX + gapW - 10 - spread;
        gators.push({
          x: Math.max(gapX + 10, Math.min(gapX + gapW - 10, startX)),
          vx: dir * (55 + Math.random() * 55 + runtime.rowsCleared * 0.5),
          bounceL: gapX + 10,
          bounceR: gapX + gapW - 10,
        });
      }
    }
    runtime.obstacles.push({ y, gapX, gapW, gators, cleared: false });
    // Reset spawn timer
    runtime.spawnTimer = ROW_SPACING / runtime.scrollSpeed;
  }

  // ── Lifecycle ──
  function startPlaying() {
    resetGame();
    runtime.mode = STATE.LAUNCHING;
    runtime.launchTimer = 0;
    startChiptune();
    if (!runtime.rafId) {
      runtime.lastTs = performance.now();
      runtime.rafId = requestAnimationFrame(loop);
    }
  }

  function open() {
    if (runtime.open) return;
    runtime.open = true;
    overlay.hidden = false;
    overlay.removeAttribute("aria-hidden");
    resetGame();
    buildStars();
    runtime.mode = STATE.START_SCREEN;
    if (!runtime.rafId) {
      runtime.lastTs = performance.now();
      runtime.rafId = requestAnimationFrame(loop);
    }
    document.body.style.overflow = "hidden";
  }

  function close() {
    runtime.open = false;
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    if (runtime.rafId) { cancelAnimationFrame(runtime.rafId); runtime.rafId = 0; }
    stopChiptune();
    document.body.style.overflow = "";
  }

  // ── Particles ──
  function spawnBurst(x, y, color, count) {
    for (let i = 0; i < (count || 14); i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 60 + Math.random() * 180;
      const life = 0.4 + Math.random() * 0.5;
      runtime.particles.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        life, maxLife: life,
        color,
        size: 2 + Math.random() * 3,
      });
    }
  }

  function updateParticles(dt) {
    runtime.particles = runtime.particles.filter(p => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 60 * dt;
      p.life -= dt;
      return p.life > 0;
    });
  }

  // ── Game over ──
  function endGame(rawReason) {
    if (runtime.mode !== STATE.PLAYING) return;
    runtime.mode = STATE.GAME_OVER;
    if (runtime.score > runtime.highScore) runtime.highScore = runtime.score;
    spawnBurst(runtime.rocketX, ROCKET_Y, FTL.orange, 24);
    spawnBurst(runtime.rocketX, ROCKET_Y, FTL.yellow, 14);
    runtime.crashFlash = 0.5;
    const phase = getAltitudePhase(runtime.rowsCleared);
    let reason;
    if (rawReason === "Hit the wall!") {
      const msgs = [
        "LATERAL BOUNDARY EXCEEDED · RUD CONFIRMED",
        "ORBITAL CONSTRAINT VIOLATED · RE-ENTRY INITIATED",
        "HELIOSPHERIC MARGIN BREACH · TRAJECTORY LOST",
        "NON-EUCLIDEAN BOUNDARY COLLISION",
        "SPACETIME MANIFOLD EXCEEDED",
      ];
      reason = msgs[Math.min(4, phase)];
    } else if (rawReason === "Asteroid impact!") {
      const msgs = [
        "KESSLER DEBRIS IMPACT · HULL BREACH",
        "ORBITAL DEBRIS COLLISION · STRUCTURAL FAILURE",
        "INTERPLANETARY METEOROID IMPACT",
        "EXOTIC MATTER PARTICLE COLLISION",
        "QUANTUM FOAM DECOHERENCE EVENT",
      ];
      reason = msgs[Math.min(4, phase)];
    } else if (rawReason === "Chomped by a space gator!") {
      const msgs = [
        "XENOBIO ENCOUNTER · HULL BREACH",
        "ANOMALOUS BIOELECTRIC DISCHARGE",
        "NON-BARYONIC LIFE FORM CONTACT",
        "QUANTUM SUPERPOSITION COLLAPSE",
        "ALIEN CONSCIOUSNESS ABSORPTION",
      ];
      reason = msgs[Math.min(4, phase)];
    } else {
      reason = rawReason;
    }
    runtime.endReason = reason;
    if (missionStatus) missionStatus.textContent = `${reason}  ·  ALTITUDE: ${runtime.score}`;
  }

  // ── Update ──
  function updateGame(dt) {
    if (runtime.mode === STATE.LAUNCHING) {
      runtime.launchTimer += dt;
      // Scroll stars during ascent (accelerating)
      const launchSpeed = SCROLL_BASE * Math.min(1, runtime.launchTimer / 1.8);
      for (const s of runtime.stars) {
        s.y += s.parallax * launchSpeed * dt;
        if (s.y > H) s.y -= H;
      }
      // Spawn launch smoke particles
      if (Math.random() < 0.35) {
        spawnBurst(
          runtime.rocketX + (Math.random() - 0.5) * 14,
          ROCKET_Y + 24,
          Math.random() < 0.5 ? FTL.orange : FTL.amber, 1
        );
      }
      updateParticles(dt);
      // Allow player to skip launch (after 0.4s minimum) by pressing boost
      if (runtime.launchTimer >= 2.0 || (input.boost && runtime.launchTimer > 0.4)) {
        input.boost = false;
        runtime.mode = STATE.PLAYING;
      }
      return;
    }

    if (runtime.mode !== STATE.PLAYING) return;

    // Boost timers
    if (runtime.boostTimer > 0) runtime.boostTimer = Math.max(0, runtime.boostTimer - dt);
    if (runtime.boostCooldown > 0) runtime.boostCooldown = Math.max(0, runtime.boostCooldown - dt);

    // Activate boost
    if (input.boost && runtime.boostCooldown <= 0 && runtime.boostTimer <= 0) {
      runtime.boostTimer = BOOST_DUR;
      runtime.boostCooldown = BOOST_CD;
      spawnBurst(runtime.rocketX, ROCKET_Y + 20, FTL.cyan, 10);
    }

    const isBoosting = runtime.boostTimer > 0;

    // Laser cannon cooldown
    if (runtime.laserCooldown > 0) runtime.laserCooldown = Math.max(0, runtime.laserCooldown - dt);

    // Fire laser on keypress (single-fire per press handled by input.fire flag)
    if (input.fire && runtime.laserCooldown <= 0) {
      runtime.lasers.push({ x: runtime.rocketX, y: ROCKET_Y - ROCKET_H / 2 });
      runtime.laserCooldown = LASER_CD;
    }
    input.fire = false;

    // Move lasers upward
    runtime.lasers = runtime.lasers.filter(l => {
      l.y -= LASER_SPEED * dt;
      return l.y + LASER_H > 0;
    });

    // Laser vs gator collision
    for (const obs of runtime.obstacles) {
      const obsTop = obs.y - OBSTACLE_H / 2;
      const obsBot = obs.y + OBSTACLE_H / 2;
      obs.gators = obs.gators.filter(g => {
        for (const l of runtime.lasers) {
          const hit = Math.abs(l.x - g.x) < 22 && l.y < obsBot && l.y + LASER_H > obsTop;
          if (hit) {
            // Blast the gator
            spawnBurst(g.x, obs.y, FTL.green, 18);
            spawnBurst(g.x, obs.y, FTL.amber, 10);
            // Remove the laser that hit
            l.y = -9999;
            runtime.gatorsBlasted++;
            runtime.score += 2; // bonus points per gator blasted
            return false;
          }
        }
        return true;
      });
    }
    // Remove spent lasers
    runtime.lasers = runtime.lasers.filter(l => l.y > -9999);

    // Steer
    if (input.left) runtime.rocketVX = -STEER_SPEED;
    else if (input.right) runtime.rocketVX = STEER_SPEED;
    else runtime.rocketVX *= Math.pow(0.05, dt); // fast lateral friction when no key held

    runtime.rocketX += runtime.rocketVX * dt;
    runtime.rocketX = Math.max(ROCKET_W + 4, Math.min(W - ROCKET_W - 4, runtime.rocketX));

    // Hit side walls
    if (runtime.rocketX <= ROCKET_W + 4 || runtime.rocketX >= W - ROCKET_W - 4) {
      endGame("Hit the wall!");
      return;
    }

    // Scroll speed ramp
    const targetSpeed = Math.min(SCROLL_MAX, SCROLL_BASE + runtime.rowsCleared * SCROLL_RAMP);
    runtime.scrollSpeed += (targetSpeed - runtime.scrollSpeed) * Math.min(1, dt * 1.5);
    const effectiveSpeed = isBoosting ? runtime.scrollSpeed * BOOST_MULT : runtime.scrollSpeed;

    // Move stars (parallax)
    for (const s of runtime.stars) {
      s.y += s.parallax * effectiveSpeed * dt;
      if (s.y > H) s.y -= H;
    }

    // Spawn new rows
    runtime.spawnTimer -= dt;
    if (runtime.spawnTimer <= 0) {
      spawnRow(SPAWN_DIST);
      runtime.spawnTimer = ROW_SPACING / runtime.scrollSpeed;
    }

    // Move and check obstacles
    for (const obs of runtime.obstacles) {
      obs.y += effectiveSpeed * dt;

      // Move gators (bounce within gap)
      for (const g of obs.gators) {
        g.x += g.vx * dt;
        if (g.x <= g.bounceL) { g.x = g.bounceL; g.vx = Math.abs(g.vx); }
        if (g.x >= g.bounceR) { g.x = g.bounceR; g.vx = -Math.abs(g.vx); }
      }

      // Collision check when obstacle reaches rocket zone
      const obsTop = obs.y - OBSTACLE_H / 2;
      const obsBot = obs.y + OBSTACLE_H / 2;
      const rocketTop = ROCKET_Y - ROCKET_H / 2;
      const rocketBot = ROCKET_Y + ROCKET_H / 2;

      if (obsBot > rocketTop && obsTop < rocketBot) {
        // Vertical overlap — check horizontal
        const rx = runtime.rocketX;
        const rl = rx - ROCKET_W / 2 + 4; // small forgiveness
        const rr = rx + ROCKET_W / 2 - 4;

        const inGap = rl >= obs.gapX && rr <= obs.gapX + obs.gapW;
        if (!inGap) {
          endGame("Asteroid impact!");
          return;
        }

        // Gator collision
        for (const g of obs.gators) {
          if (Math.abs(rx - g.x) < 22 && Math.abs(ROCKET_Y - obs.y) < 28) {
            endGame("Chomped by a space gator!");
            return;
          }
        }

        // Award point once per row
        if (!obs.cleared && obs.y > ROCKET_Y) {
          obs.cleared = true;
          runtime.rowsCleared++;
          runtime.score = runtime.rowsCleared;
          const ph = getAltitudePhase(runtime.rowsCleared);
          const statusMsgs = [
            `APOAPSIS +${runtime.score} km · ΔV ${Math.round(runtime.scrollSpeed * 28)} m/s`,
            `LEO TRAJECTORY · ORBIT ${runtime.score} · Δv ${Math.round(runtime.scrollSpeed)} m/s`,
            `HELIOCENTRIC DIST ${runtime.score} AU · v∞ ${Math.round(runtime.scrollSpeed * 0.7)} km/s`,
            `HELIOPAUSE CROSSING ${runtime.score} · Vhyp ${Math.round(runtime.scrollSpeed * 3)} km/s`,
            `INTERSTELLAR ${(runtime.score * 0.0003).toFixed(4)} pc · γ ${(0.8 + runtime.score * 0.002).toFixed(3)}c`,
          ];
          if (missionStatus) missionStatus.textContent = statusMsgs[Math.min(4, ph)];
          spawnBurst(rx, ROCKET_Y - 40, FTL.green, 6);
        }
      }
    }

    // Prune off-screen obstacles
    runtime.obstacles = runtime.obstacles.filter(o => o.y < H + OBSTACLE_H + 20);

    updateParticles(dt);
    if (runtime.crashFlash > 0) runtime.crashFlash = Math.max(0, runtime.crashFlash - dt * 2);
  }

  // ── Drawing ──
  function drawStars() {
    for (const s of runtime.stars) {
      ctx.fillStyle = s.bright ? FTL.blueLight : FTL.textDim;
      ctx.fillRect(Math.round(s.x), Math.round(s.y), s.size, s.size);
    }
  }

  function drawAsteroidBlock(x, y, w, h) {
    // Main body
    ctx.fillStyle = "#1e2838";
    ctx.fillRect(x, y, w, h);
    // Top highlight
    ctx.fillStyle = "#3a4a5e";
    ctx.fillRect(x, y, w, 3);
    // Bottom shadow
    ctx.fillStyle = "#0e1420";
    ctx.fillRect(x, y + h - 3, w, 3);
    // Inner outline
    ctx.strokeStyle = "#4a5a70";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    // Pixel rock texture (craters/pits)
    ctx.fillStyle = "#0e1420";
    const cols = Math.max(1, Math.floor(w / 18));
    for (let i = 0; i < cols; i++) {
      const rx = x + 8 + i * 18 + (i % 2) * 4;
      if (rx + 6 < x + w - 4) {
        ctx.fillRect(rx, y + 10, 5, 5);
        ctx.fillRect(rx + 3, y + h - 14, 4, 4);
      }
    }
    // Glinting pixel on edge
    ctx.fillStyle = "#7a9ab8";
    ctx.fillRect(x + Math.floor(w / 3), y + 1, 2, 2);
  }

  function drawGator(gx, gy, gapY) {
    const t = Date.now() / 280;
    const bob = Math.sin(t + gx * 0.01) * 4;
    const sy = gapY + bob;
    ctx.save();
    ctx.translate(Math.round(gx), Math.round(sy));

    // Shadow / glow
    ctx.fillStyle = "rgba(42, 122, 48, 0.22)";
    ctx.beginPath();
    ctx.ellipse(0, 14, 18, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.fillStyle = "#256a28";
    ctx.fillRect(-15, -7, 30, 14);
    // Belly
    ctx.fillStyle = "#3a8a3e";
    ctx.fillRect(-12, -4, 24, 8);

    // Head
    ctx.fillStyle = "#256a28";
    ctx.fillRect(-13, -13, 18, 10);
    // Snout
    ctx.fillStyle = "#1a5020";
    ctx.fillRect(-19, -10, 8, 7);
    // Nostril
    ctx.fillStyle = "#0e3010";
    ctx.fillRect(-17, -9, 2, 2);

    // Eye
    ctx.fillStyle = FTL.red;
    ctx.fillRect(-7, -16, 5, 5);
    ctx.fillStyle = "#000";
    ctx.fillRect(-6, -15, 3, 3);
    ctx.fillStyle = FTL.white;
    ctx.fillRect(-6, -15, 1, 1);

    // Teeth
    ctx.fillStyle = FTL.white;
    ctx.fillRect(-17, -5, 2, 3);
    ctx.fillRect(-14, -5, 2, 3);
    ctx.fillRect(-11, -5, 2, 3);

    // Tail
    ctx.fillStyle = "#256a28";
    ctx.fillRect(15, -4, 10, 7);
    ctx.fillRect(25, -2, 6, 5);
    ctx.fillRect(31, 0, 4, 3);

    // Legs
    ctx.fillStyle = "#1a5020";
    ctx.fillRect(-13, 7, 5, 6);
    ctx.fillRect(-3, 7, 5, 6);
    ctx.fillRect(7, 7, 5, 6);

    // Scaly pattern
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(-8, -5, 3, 3);
    ctx.fillRect(2, -5, 3, 3);
    ctx.fillRect(-3, 2, 3, 3);

    ctx.restore();
  }

  // ── Phase 2: Crystal/ice asteroid blocks ──
  function drawCrystalBlock(x, y, w, h) {
    if (w <= 0) return;
    ctx.fillStyle = "#0e1e38";
    ctx.fillRect(x, y, w, h);
    // Glowing edges
    ctx.fillStyle = "rgba(73, 232, 255, 0.38)";
    ctx.fillRect(x, y, w, 3);
    ctx.fillStyle = "rgba(73, 232, 255, 0.12)";
    ctx.fillRect(x, y + h - 3, w, 3);
    ctx.strokeStyle = "rgba(73, 232, 255, 0.28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    // Crystal shards
    ctx.fillStyle = "rgba(180, 240, 255, 0.18)";
    const cols = Math.max(1, Math.floor(w / 16));
    for (let i = 0; i < cols; i++) {
      const fx = x + 8 + i * 16;
      if (fx + 8 < x + w - 4) {
        ctx.beginPath();
        ctx.moveTo(fx, y + h / 2);
        ctx.lineTo(fx + 4, y + 4);
        ctx.lineTo(fx + 8, y + h / 2);
        ctx.closePath();
        ctx.fill();
      }
    }
    // Glint
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(x + Math.floor(w / 3), y + 1, 2, 2);
  }

  // ── Phase 3: Alien metallic blocks ──
  function drawAlienBlock(x, y, w, h) {
    if (w <= 0) return;
    ctx.fillStyle = "#1a0530";
    ctx.fillRect(x, y, w, h);
    // Pulsing energy top edge
    const pulse = Math.sin(Date.now() / 550) * 0.5 + 0.5;
    const edgeGrad = ctx.createLinearGradient(x, y, x + w, y);
    edgeGrad.addColorStop(0, `rgba(180, 0, 255, ${0.5 + pulse * 0.3})`);
    edgeGrad.addColorStop(0.5, `rgba(255, 100, 20, ${0.4 + pulse * 0.3})`);
    edgeGrad.addColorStop(1, `rgba(180, 0, 255, ${0.5 + pulse * 0.3})`);
    ctx.fillStyle = edgeGrad;
    ctx.fillRect(x, y, w, 4);
    ctx.strokeStyle = `rgba(200, 50, 255, ${0.22 + pulse * 0.18})`;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
    // Alien runes
    ctx.fillStyle = `rgba(150, 0, 220, ${0.06 + pulse * 0.07})`;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "rgba(120, 0, 200, 0.15)";
    ctx.fillRect(x + Math.floor(w / 4), y + 1, 2, 2);
    ctx.fillRect(x + Math.floor(w * 3 / 4), y + 1, 2, 2);
  }

  // ── Phase 4: Energy barrier ──
  function drawEnergyBarrier(x, y, w, h) {
    if (w <= 0) return;
    const t = Date.now() / 500;
    const pulse = Math.sin(t) * 0.5 + 0.5;
    ctx.fillStyle = "rgba(0, 10, 30, 0.75)";
    ctx.fillRect(x, y, w, h);
    // Wavering energy lattice
    ctx.strokeStyle = `rgba(0, 180, 255, ${0.28 + pulse * 0.22})`;
    ctx.lineWidth = 1;
    const cols2 = Math.max(1, Math.floor(w / 22));
    for (let i = 0; i <= cols2; i++) {
      const lx = x + (w * i / cols2);
      ctx.beginPath();
      ctx.moveTo(lx, y);
      for (let dy = 0; dy < h; dy += 8) {
        ctx.lineTo(lx + Math.sin(dy * 0.4 + t + i) * 3, y + dy);
      }
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(0, 200, 255, ${0.32 + pulse * 0.2})`;
    ctx.fillRect(x, y, w, 4);
    ctx.fillRect(x, y + h - 4, w, 4);
  }

  // ── Phase 3+: Alien gator ──
  function drawAlienGator(gx, gapY, phase) {
    const t = Date.now() / 200;
    const bob = Math.sin(t + gx * 0.01) * 5;
    const sy = gapY + bob;
    const pulse = Math.sin(t * 1.5) * 0.5 + 0.5;
    ctx.save();
    ctx.translate(Math.round(gx), Math.round(sy));

    if (phase >= 4) {
      // Phase 4: Pure plasma entity
      const coreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 20);
      coreGrad.addColorStop(0, `rgba(255, 255, 255, ${0.85 + pulse * 0.15})`);
      coreGrad.addColorStop(0.3, `rgba(100, 0, 255, 0.7)`);
      coreGrad.addColorStop(0.7, `rgba(50, 0, 180, 0.35)`);
      coreGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, 24, 17, 0, 0, Math.PI * 2);
      ctx.fill();
      // Energy tendrils
      ctx.strokeStyle = `rgba(160, 0, 255, ${0.38 + pulse * 0.3})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + t * 0.8;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * (20 + pulse * 6), Math.sin(a) * (13 + pulse * 4));
        ctx.stroke();
      }
    } else {
      // Phase 3: Crystalline alien form
      ctx.fillStyle = "rgba(100, 0, 180, 0.22)";
      ctx.beginPath();
      ctx.ellipse(0, 14, 18, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#3d1060";
      ctx.fillRect(-15, -7, 30, 14);
      ctx.fillStyle = "#6a20a8";
      ctx.fillRect(-12, -4, 24, 8);
      ctx.fillStyle = "#3d1060";
      ctx.fillRect(-13, -13, 18, 10);
      ctx.fillStyle = "#280a40";
      ctx.fillRect(-19, -10, 8, 7);
      // Crystal spines
      ctx.fillStyle = `rgba(180, 100, 255, ${0.3 + pulse * 0.3})`;
      ctx.fillRect(-8, -13, 3, 4);
      ctx.fillRect(-3, -14, 3, 4);
      ctx.fillRect(2, -13, 3, 4);
      // Eye
      ctx.fillStyle = "#ff00cc";
      ctx.fillRect(-7, -16, 5, 5);
      ctx.fillStyle = "#000";
      ctx.fillRect(-6, -15, 3, 3);
      ctx.fillStyle = "#fff";
      ctx.fillRect(-6, -15, 1, 1);
      // Teeth
      ctx.fillStyle = "rgba(220, 180, 255, 0.9)";
      ctx.fillRect(-17, -5, 2, 4);
      ctx.fillRect(-14, -5, 2, 4);
      ctx.fillRect(-11, -5, 2, 4);
      // Tail
      ctx.fillStyle = "#3d1060";
      ctx.fillRect(15, -4, 10, 7);
      ctx.fillRect(25, -2, 6, 5);
      ctx.fillRect(31, 0, 4, 3);
      // Legs
      ctx.fillStyle = "#280a40";
      ctx.fillRect(-13, 7, 5, 6);
      ctx.fillRect(-3, 7, 5, 6);
      ctx.fillRect(7, 7, 5, 6);
      // Energy glow
      ctx.fillStyle = `rgba(150, 0, 220, ${0.08 + pulse * 0.1})`;
      ctx.fillRect(-15, -16, 32, 30);
    }
    ctx.restore();
  }

  function drawRocketAt(x, y, isBoosting, exhaustMult) {
    const mult = exhaustMult || 1;
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));

    // Exhaust plume
    const flameH = (22 + Math.random() * 14) * mult;
    const flameW = Math.min(16, 8 * mult);
    ctx.fillStyle = FTL.orange;
    ctx.beginPath();
    ctx.moveTo(-flameW, 22);
    ctx.lineTo(0, 22 + flameH);
    ctx.lineTo(flameW, 22);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = FTL.amber;
    ctx.beginPath();
    ctx.moveTo(-4, 22);
    ctx.lineTo(0, 22 + flameH * 0.65);
    ctx.lineTo(4, 22);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#fff8e0";
    ctx.beginPath();
    ctx.moveTo(-2, 22);
    ctx.lineTo(0, 22 + flameH * 0.35);
    ctx.lineTo(2, 22);
    ctx.closePath();
    ctx.fill();

    // Boost extra flame
    if (isBoosting) {
      const bH = 38 + Math.random() * 20;
      ctx.fillStyle = FTL.cyan;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(-10, 22);
      ctx.lineTo(0, 22 + bH);
      ctx.lineTo(10, 22);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Rocket body
    ctx.fillStyle = FTL.blueDark;
    ctx.strokeStyle = FTL.blueLight;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-10, 22);
    ctx.lineTo(-10, -8);
    ctx.lineTo(10, -8);
    ctx.lineTo(10, 22);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Center stripe
    ctx.fillStyle = FTL.blue;
    ctx.fillRect(-3, -6, 6, 26);

    // Nose cone
    ctx.fillStyle = FTL.white;
    ctx.strokeStyle = FTL.blueLight;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-10, -8);
    ctx.quadraticCurveTo(-10, -26, 0, -32);
    ctx.quadraticCurveTo(10, -26, 10, -8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Porthole
    ctx.fillStyle = FTL.cyan;
    ctx.strokeStyle = FTL.blueLight;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 4, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Fins
    ctx.fillStyle = FTL.blue;
    ctx.strokeStyle = FTL.blueLight;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-10, 22);
    ctx.lineTo(-20, 32);
    ctx.lineTo(-10, 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(10, 22);
    ctx.lineTo(20, 32);
    ctx.lineTo(10, 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Engine bell
    ctx.fillStyle = "#333";
    ctx.beginPath();
    ctx.moveTo(-5, 22);
    ctx.lineTo(-7, 29);
    ctx.lineTo(7, 29);
    ctx.lineTo(5, 22);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function drawRocket(isBoosting) {
    drawRocketAt(runtime.rocketX, ROCKET_Y, isBoosting, 1);
  }

  function drawParticles() {
    for (const p of runtime.particles) {
      const alpha = p.life / p.maxLife;
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillStyle = p.color;
      ctx.fillRect(
        Math.round(p.x - p.size / 2),
        Math.round(p.y - p.size / 2),
        Math.round(p.size),
        Math.round(p.size)
      );
    }
    ctx.globalAlpha = 1;
  }

  function drawLasers() {
    const phase = getAltitudePhase(runtime.rowsCleared);
    const laserColors = ["#49e8ff", "#49e8ff", "#70f8c1", "#cc44ff", "#ffffff"];
    const glowColors  = ["rgba(73,232,255,0.35)", "rgba(73,232,255,0.35)",
                         "rgba(112,248,193,0.35)", "rgba(204,68,255,0.35)", "rgba(255,255,255,0.4)"];
    const col = laserColors[Math.min(4, phase)];
    const glow = glowColors[Math.min(4, phase)];
    for (const l of runtime.lasers) {
      const lx = Math.round(l.x);
      const ly = Math.round(l.y);
      // Glow halo
      ctx.fillStyle = glow;
      ctx.fillRect(lx - LASER_W - 2, ly, LASER_W * 2 + 4, LASER_H);
      // Bright core bolt
      ctx.fillStyle = col;
      ctx.fillRect(lx - LASER_W / 2, ly, LASER_W, LASER_H);
      // Bright tip
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(lx - 1, ly, 2, 4);
    }
  }

  function drawObstacles() {
    const phase = getAltitudePhase(runtime.rowsCleared);
    for (const obs of runtime.obstacles) {
      const sy = obs.y;
      if (sy < -OBSTACLE_H - 10 || sy > H + OBSTACLE_H + 10) continue;
      const top = sy - OBSTACLE_H / 2;

      if (phase <= 1) {
        // Near-earth / LEO: classic asteroid blocks
        if (obs.gapX > 0) drawAsteroidBlock(0, top, obs.gapX, OBSTACLE_H);
        const rightStart = obs.gapX + obs.gapW;
        if (rightStart < W) drawAsteroidBlock(rightStart, top, W - rightStart, OBSTACLE_H);
      } else if (phase === 2) {
        // Deep space: crystal/ice asteroids
        if (obs.gapX > 0) drawCrystalBlock(0, top, obs.gapX, OBSTACLE_H);
        const rightStart = obs.gapX + obs.gapW;
        if (rightStart < W) drawCrystalBlock(rightStart, top, W - rightStart, OBSTACLE_H);
      } else if (phase === 3) {
        // Outer system: alien metallic formations
        if (obs.gapX > 0) drawAlienBlock(0, top, obs.gapX, OBSTACLE_H);
        const rightStart = obs.gapX + obs.gapW;
        if (rightStart < W) drawAlienBlock(rightStart, top, W - rightStart, OBSTACLE_H);
      } else {
        // Interstellar: pure energy barriers
        if (obs.gapX > 0) drawEnergyBarrier(0, top, obs.gapX, OBSTACLE_H);
        const rightStart = obs.gapX + obs.gapW;
        if (rightStart < W) drawEnergyBarrier(rightStart, top, W - rightStart, OBSTACLE_H);
      }

      // Gap edge highlights (danger indicator — colour shifts with phase)
      const gapColor = phase >= 4 ? "rgba(0, 180, 255, 0.22)" :
                       phase >= 3 ? "rgba(200, 50, 255, 0.22)" :
                       phase >= 2 ? "rgba(73, 232, 255, 0.22)" :
                       "rgba(100, 180, 255, 0.18)";
      ctx.fillStyle = gapColor;
      ctx.fillRect(obs.gapX, top, 3, OBSTACLE_H);
      ctx.fillRect(obs.gapX + obs.gapW - 3, top, 3, OBSTACLE_H);

      // Gators
      for (const g of obs.gators) {
        if (phase >= 3) {
          drawAlienGator(g.x, sy, phase);
        } else {
          drawGator(g.x, sy, sy);
        }
      }
    }
  }

  function drawHud() {
    const isBoosting = runtime.boostTimer > 0;
    const boostReady = runtime.boostCooldown <= 0 && !isBoosting;
    const phase = getAltitudePhase(runtime.rowsCleared);

    const boostLabels = ["ΔV BURN", "ΔV BURN", "ION BURST", "WARP SURGE", "FTL PULSE"];
    const boostLabel = boostLabels[Math.min(4, phase)];
    const scoreLabels = ["ALTITUDE", "ALTITUDE", "HELIO DIST", "HELIOPAUSE", "PARSECS"];
    const scoreLabel = scoreLabels[Math.min(4, phase)];

    // Score block (top left) — shows combined score (altitude rows + gator bonus)
    ctx.fillStyle = "rgba(10, 14, 20, 0.72)";
    ctx.fillRect(14, 12, 206, 52);
    ctx.strokeStyle = FTL.panelBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(14, 12, 206, 52);

    ctx.fillStyle = FTL.textBright;
    ctx.font = "bold 22px monospace";
    ctx.textAlign = "left";
    ctx.fillText(`${scoreLabel}  ${runtime.score}`, 24, 36);
    ctx.fillStyle = FTL.green;
    ctx.font = "13px monospace";
    ctx.fillText(`GATORS BLASTED  ${runtime.gatorsBlasted}  (+${runtime.gatorsBlasted * 2})`, 24, 54);

    // Boost bar (top right)
    const bx = W - 170;
    const by = 12;
    ctx.fillStyle = "rgba(10, 14, 20, 0.72)";
    ctx.fillRect(bx, by, 154, 52);
    ctx.strokeStyle = FTL.panelBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, 154, 52);

    ctx.fillStyle = boostReady ? FTL.cyan : FTL.textDim;
    ctx.font = "bold 13px monospace";
    ctx.textAlign = "left";
    ctx.fillText(
      isBoosting ? `${boostLabel} ACTIVE` : boostReady ? `${boostLabel} READY` : "RECHARGING",
      bx + 10, by + 20
    );

    // Boost bar fill
    const barX = bx + 10;
    const barY = by + 26;
    const barW = 134;
    const barH = 10;
    ctx.fillStyle = "#1a2030";
    ctx.fillRect(barX, barY, barW, barH);
    let pct;
    if (isBoosting) {
      pct = runtime.boostTimer / BOOST_DUR;
      ctx.fillStyle = FTL.cyan;
    } else if (runtime.boostCooldown > 0) {
      pct = 1 - runtime.boostCooldown / BOOST_CD;
      ctx.fillStyle = FTL.blue;
    } else {
      pct = 1;
      ctx.fillStyle = FTL.cyan;
    }
    ctx.fillRect(barX, barY, Math.round(barW * pct), barH);
    ctx.strokeStyle = FTL.panelBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, barH);

    // Speed indicator + gators blasted
    ctx.fillStyle = FTL.textDim;
    ctx.font = "11px monospace";
    ctx.fillText(`ΔV ${Math.round(runtime.scrollSpeed)} m/s`, bx + 10, by + 48);

    // Laser cannon status (bottom left, below score panel)
    const laserReady = runtime.laserCooldown <= 0;
    const lx2 = 14;
    const ly2 = 72;
    ctx.fillStyle = "rgba(10, 14, 20, 0.72)";
    ctx.fillRect(lx2, ly2, 206, 32);
    ctx.strokeStyle = FTL.panelBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(lx2, ly2, 206, 32);
    ctx.fillStyle = laserReady ? FTL.green : FTL.textDim;
    ctx.font = "bold 12px monospace";
    ctx.textAlign = "left";
    ctx.fillText(laserReady ? "LASER  READY" : `LASER  ${runtime.laserCooldown.toFixed(1)}s`, lx2 + 10, ly2 + 14);
    ctx.fillStyle = FTL.textDim;
    ctx.font = "11px monospace";
    ctx.fillText(`BEST  ${runtime.highScore}`, lx2 + 10, ly2 + 26);

    ctx.textAlign = "left";
  }

  function drawStartScreen() {
    ctx.fillStyle = FTL.bg;
    ctx.fillRect(0, 0, W, H);
    drawStars();

    // Title glow
    ctx.fillStyle = "rgba(72, 200, 232, 0.08)";
    ctx.beginPath();
    ctx.ellipse(W / 2, H / 2 - 70, 320, 80, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = FTL.cyan;
    ctx.font = "bold 58px monospace";
    ctx.textAlign = "center";
    ctx.fillText("GATORNAUTS", W / 2, H / 2 - 50);

    ctx.fillStyle = FTL.textDim;
    ctx.font = "15px monospace";
    ctx.fillText("SUBORBITAL ESCAPE SEQUENCE", W / 2, H / 2 - 14);

    ctx.fillStyle = FTL.text;
    ctx.font = "17px monospace";
    ctx.fillText("← →  steer    ↑ / SPACE  boost    Z / X  fire laser", W / 2, H / 2 + 28);
    ctx.fillStyle = FTL.green;
    ctx.font = "bold 16px monospace";
    ctx.fillText("★  BLAST GATORS FOR +2 BONUS POINTS EACH  ★", W / 2, H / 2 + 54);
    ctx.fillStyle = FTL.textDim;
    ctx.font = "14px monospace";
    ctx.fillText("Navigate cosmic asteroid fields · Eliminate alien gators to rack up score!", W / 2, H / 2 + 76);

    const blink = Math.floor(Date.now() / 500) % 2;
    if (blink) {
      ctx.fillStyle = FTL.green;
      ctx.font = "bold 22px monospace";
      ctx.fillText("PRESS ↑  OR  THRUST  TO  INITIATE", W / 2, H / 2 + 112);
    }

    // Draw a decorative rocket on start screen
    ctx.save();
    ctx.translate(W / 2, H / 2 + 165);
    ctx.scale(1.6, 1.6);
    const fH2 = 20 + Math.sin(Date.now() / 80) * 6;
    ctx.fillStyle = FTL.orange;
    ctx.beginPath(); ctx.moveTo(-6, 22); ctx.lineTo(0, 22 + fH2); ctx.lineTo(6, 22); ctx.closePath(); ctx.fill();
    ctx.fillStyle = FTL.blueDark; ctx.strokeStyle = FTL.blueLight; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-10, 22); ctx.lineTo(-10, -8); ctx.lineTo(10, -8); ctx.lineTo(10, 22); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = FTL.white; ctx.beginPath(); ctx.moveTo(-10, -8); ctx.quadraticCurveTo(-10, -26, 0, -32); ctx.quadraticCurveTo(10, -26, 10, -8); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = FTL.blue; ctx.strokeStyle = FTL.blueLight; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-10, 22); ctx.lineTo(-18, 32); ctx.lineTo(-10, 12); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(10, 22); ctx.lineTo(18, 32); ctx.lineTo(10, 12); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();

    ctx.textAlign = "left";
  }

  function drawGameOverScreen() {
    ctx.fillStyle = "rgba(10, 14, 20, 0.78)";
    ctx.fillRect(0, 0, W, H);

    const phase = getAltitudePhase(runtime.rowsCleared);
    const titleColor = phase >= 4 ? "#cc44ff" : phase >= 3 ? "#dd44cc" : phase >= 2 ? "#e05050" : FTL.red;

    ctx.fillStyle = titleColor;
    ctx.font = "bold 52px monospace";
    ctx.textAlign = "center";
    ctx.fillText("MISSION ABORT", W / 2, H / 2 - 84);

    if (runtime.endReason) {
      ctx.fillStyle = FTL.textDim;
      ctx.font = "13px monospace";
      ctx.fillText(runtime.endReason, W / 2, H / 2 - 56);
    }

    ctx.fillStyle = FTL.textBright;
    ctx.font = "bold 28px monospace";
    ctx.fillText(`SCORE  ${runtime.score}`, W / 2, H / 2 - 18);

    // Gator kill breakdown
    ctx.fillStyle = FTL.green;
    ctx.font = "15px monospace";
    ctx.fillText(
      `ROWS ${runtime.rowsCleared}  +  GATORS BLASTED ${runtime.gatorsBlasted} × 2  =  ${runtime.score}`,
      W / 2, H / 2 + 12
    );

    if (runtime.score > 0 && runtime.score >= runtime.highScore) {
      ctx.fillStyle = FTL.yellow;
      ctx.font = "bold 20px monospace";
      ctx.fillText("✦ NEW RECORD ✦", W / 2, H / 2 + 46);
    } else {
      ctx.fillStyle = FTL.textDim;
      ctx.font = "18px monospace";
      ctx.fillText(`BEST  ${runtime.highScore}`, W / 2, H / 2 + 46);
    }

    const blink = Math.floor(Date.now() / 500) % 2;
    if (blink) {
      ctx.fillStyle = FTL.green;
      ctx.font = "bold 20px monospace";
      ctx.fillText("PRESS ↑ OR THRUST TO RELAUNCH", W / 2, H / 2 + 88);
    }

    ctx.textAlign = "left";
  }

  function drawScanlines() {
    ctx.fillStyle = "rgba(0,0,0,0.10)";
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 2);
  }

  function drawVignette() {
    const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.82);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.42)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Launch sequence (STATE.LAUNCHING) ──
  function drawLaunchSequence() {
    const t = Math.min(1, runtime.launchTimer / 2.0);
    const ease = t * t * (3 - 2 * t); // smoothstep

    // Sky: dark blue → pure black as we ascend
    const skyR = Math.round(8 + (1 - ease) * 16);
    const skyG = Math.round(12 + (1 - ease) * 30);
    const skyB = Math.round(22 + (1 - ease) * 58);
    ctx.fillStyle = `rgb(${skyR},${skyG},${skyB})`;
    ctx.fillRect(0, 0, W, H);

    // Stars fade in as atmosphere thins
    if (ease > 0.25) {
      ctx.globalAlpha = Math.min(1, (ease - 0.25) / 0.5);
      drawStars();
      ctx.globalAlpha = 1;
    }

    // Earth surface — large ellipse at bottom, scrolling away
    const earthCenterY = H + 80 - ease * (H + 300);
    if (earthCenterY < H + 200) {
      // Earth body (land)
      ctx.fillStyle = "#183a0e";
      ctx.beginPath();
      ctx.ellipse(W / 2, earthCenterY, W * 0.92, 200, 0, Math.PI, 0, true);
      ctx.fill();
      // Ocean patches
      ctx.fillStyle = "#0f2a60";
      ctx.beginPath();
      ctx.ellipse(W / 2 - 140, earthCenterY - 18, 160, 85, -0.15, Math.PI, 0, true);
      ctx.fill();
      ctx.fillStyle = "#0f2a60";
      ctx.beginPath();
      ctx.ellipse(W / 2 + 110, earthCenterY - 28, 110, 68, 0.15, Math.PI, 0, true);
      ctx.fill();
      // Atmosphere limb glow
      const atmoGrad = ctx.createRadialGradient(W / 2, earthCenterY, 200, W / 2, earthCenterY, 380);
      atmoGrad.addColorStop(0, "rgba(0,0,0,0)");
      atmoGrad.addColorStop(0.55, `rgba(60, 140, 255, ${(1 - ease) * 0.18})`);
      atmoGrad.addColorStop(1, `rgba(60, 140, 255, ${(1 - ease) * 0.52})`);
      ctx.fillStyle = atmoGrad;
      ctx.fillRect(0, 0, W, H);
    }

    // Rocket — stationary at launch position, exhaust grows
    const exhaustMult = 1 + ease * 3.5;
    drawRocketAt(runtime.rocketX, ROCKET_Y, false, exhaustMult);
    drawParticles();

    // Launch telemetry overlay
    const msgs = [
      "MAIN ENGINE IGNITION · T+0s",
      "THROTTLE UP · MAX-Q APPROACHING",
      "MAX-Q CLEARED · NOMINAL TRAJECTORY",
    ];
    const msgIdx = Math.min(2, Math.floor(t * 3));
    ctx.fillStyle = `rgba(10,14,20,0.55)`;
    ctx.fillRect(W / 2 - 260, 22, 520, 62);
    ctx.strokeStyle = FTL.panelBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(W / 2 - 260, 22, 520, 62);

    ctx.fillStyle = FTL.cyan;
    ctx.font = "bold 18px monospace";
    ctx.textAlign = "center";
    ctx.fillText(msgs[msgIdx], W / 2, 50);
    ctx.fillStyle = FTL.textDim;
    ctx.font = "12px monospace";
    ctx.fillText(
      `ΔV: ${Math.round(ease * ease * 9400)} m/s  ·  ALT: ${Math.round(ease * ease * 420)} km  ·  TRAJECTORY: NOMINAL`,
      W / 2, 72
    );
    ctx.textAlign = "left";
  }

  // ── Progressive phase background ──
  function drawPhaseBackground() {
    const rawPhase = getRawPhase(runtime.rowsCleared);
    const t = Date.now() / 1000;

    // Phase 0 (0–8 rows): Near-earth, strong atmosphere glow at bottom
    if (rawPhase < 1) {
      const atmoAlpha = (1 - rawPhase) * 0.38;
      const atmoGrad = ctx.createLinearGradient(0, H * 0.45, 0, H);
      atmoGrad.addColorStop(0, "rgba(0,0,0,0)");
      atmoGrad.addColorStop(0.5, `rgba(25, 70, 180, ${atmoAlpha * 0.6})`);
      atmoGrad.addColorStop(1, `rgba(40, 100, 200, ${atmoAlpha})`);
      ctx.fillStyle = atmoGrad;
      ctx.fillRect(0, 0, W, H);

      const earthGrad = ctx.createRadialGradient(W / 2, H + 70, 30, W / 2, H + 70, 250);
      earthGrad.addColorStop(0, `rgba(40, 100, 200, ${0.5 * (1 - rawPhase * 0.6)})`);
      earthGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = earthGrad;
      ctx.fillRect(0, H - 120, W, 220);
    }

    // Phase 1 (8–25 rows): LEO — fading earth glow, moon hint
    if (rawPhase >= 1 && rawPhase < 2) {
      const t1 = rawPhase - 1;
      const earthGrad = ctx.createRadialGradient(W / 2, H + 70, 30, W / 2, H + 70, 200);
      earthGrad.addColorStop(0, `rgba(40, 100, 200, ${0.3 * (1 - t1)})`);
      earthGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = earthGrad;
      ctx.fillRect(0, H - 110, W, 200);
      // Moon hint fades in
      const moonAlpha = Math.min(0.12, t1 * 0.14);
      ctx.fillStyle = `rgba(200, 210, 230, ${moonAlpha})`;
      ctx.beginPath();
      ctx.arc(W / 2, -30, 90, 0, Math.PI * 2);
      ctx.fill();
    }

    // Phase 2 (25–55 rows): Deep heliocentric — faint nebula colours
    if (rawPhase >= 2 && rawPhase < 3) {
      const t2 = rawPhase - 2;
      ctx.fillStyle = `rgba(73, 232, 255, ${t2 * 0.035})`;
      ctx.beginPath();
      ctx.ellipse(W * 0.84, H * 0.22, 210, 130, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255, 78, 166, ${t2 * 0.025})`;
      ctx.beginPath();
      ctx.ellipse(W * 0.14, H * 0.72, 170, 110, 0.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Phase 3 (55–110 rows): Outer system — alien reddish-purple tones + energy streams
    if (rawPhase >= 3 && rawPhase < 4) {
      const t3 = rawPhase - 3;
      ctx.fillStyle = `rgba(70, 10, 50, ${t3 * 0.14})`;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = `rgba(180, 30, 120, ${t3 * 0.09})`;
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const sx = ((W * i / 4 + t * 22) % (W + 40)) - 20;
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        for (let y = 0; y <= H; y += 20) {
          ctx.lineTo(sx + Math.sin(y * 0.05 + t * 0.7 + i) * 9, y);
        }
        ctx.stroke();
      }
      // Alien distant star
      const alienGrad = ctx.createRadialGradient(W * 0.78, H * 0.12, 0, W * 0.78, H * 0.12, 60);
      alienGrad.addColorStop(0, `rgba(220, 80, 255, ${t3 * 0.28})`);
      alienGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = alienGrad;
      ctx.fillRect(0, 0, W, H);
    }

    // Phase 4 (110+ rows): Interstellar — fully alien
    if (rawPhase >= 4) {
      const t4 = Math.min(1, rawPhase - 4);
      ctx.fillStyle = `rgba(30, 0, 55, ${t4 * 0.22})`;
      ctx.fillRect(0, 0, W, H);
      // Alien star colour wash on existing stars
      ctx.fillStyle = `rgba(80, 0, 120, ${t4 * 0.25})`;
      ctx.fillRect(0, 0, W, H);
      // Energy tendrils
      ctx.strokeStyle = `rgba(110, 0, 200, ${t4 * 0.16})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 7; i++) {
        const sx = W * (i + 0.5) / 7 + Math.sin(t * 0.3 + i) * 28;
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        for (let y = 0; y <= H; y += 14) {
          ctx.lineTo(sx + Math.sin(y * 0.08 + t * 1.4 + i * 2) * 14, y);
        }
        ctx.stroke();
      }
      // Alien sun
      const aSunGrad = ctx.createRadialGradient(W * 0.82, H * 0.1, 0, W * 0.82, H * 0.1, 90);
      aSunGrad.addColorStop(0, `rgba(210, 0, 255, ${t4 * 0.35})`);
      aSunGrad.addColorStop(0.5, `rgba(100, 0, 180, ${t4 * 0.14})`);
      aSunGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = aSunGrad;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawFrame() {
    ctx.fillStyle = FTL.bg;
    ctx.fillRect(0, 0, W, H);

    if (runtime.mode === STATE.START_SCREEN) {
      drawStartScreen();
      drawScanlines();
      return;
    }

    if (runtime.mode === STATE.LAUNCHING) {
      drawLaunchSequence();
      drawScanlines();
      return;
    }

    drawStars();
    drawPhaseBackground();

    drawObstacles();
    drawLasers();
    drawRocket(runtime.boostTimer > 0);
    drawParticles();
    drawHud();

    // Crash flash
    if (runtime.crashFlash > 0) {
      ctx.fillStyle = `rgba(220, 60, 60, ${Math.min(0.55, runtime.crashFlash)})`;
      ctx.fillRect(0, 0, W, H);
    }

    if (runtime.mode === STATE.GAME_OVER) drawGameOverScreen();

    drawScanlines();
    drawVignette();
  }

  // ── Game loop ──
  function loop(ts) {
    if (!runtime.open) { runtime.rafId = 0; return; }
    const dt = Math.min((ts - runtime.lastTs) / 1000, 0.05);
    runtime.lastTs = ts;
    updateGame(dt);
    drawFrame();
    runtime.rafId = requestAnimationFrame(loop);
  }

  // ── Input handling ──
  function normalizedKey(key) {
    return typeof key === "string" ? key.toLowerCase() : "";
  }

  function feedUnlockSequence(key) {
    runtime.unlockBuffer.push(key);
    if (runtime.unlockBuffer.length > SECRET_SEQUENCE.length) runtime.unlockBuffer.shift();
    if (runtime.unlockBuffer.join(",") === SECRET_SEQUENCE.join(",")) {
      runtime.unlockBuffer = [];
      open();
    }
  }

  function isTextInputTarget(target) {
    return target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  }

  function handleKeyDown(event) {
    feedUnlockSequence(normalizedKey(event.key));
    if (!runtime.open) return;
    if (isTextInputTarget(event.target)) return;
    const key = normalizedKey(event.key);
    if (key === "arrowleft") { event.preventDefault(); input.left = true; }
    if (key === "arrowright") { event.preventDefault(); input.right = true; }
    if (key === "arrowup" || key === " " || key === "spacebar") {
      event.preventDefault();
      if (runtime.mode === STATE.LAUNCHING) {
        input.boost = true; // allows skipping launch sequence
      } else if (runtime.mode !== STATE.PLAYING) {
        startPlaying();
      } else {
        input.boost = true;
      }
    }
    if ((key === "z" || key === "x") && runtime.mode === STATE.PLAYING) {
      event.preventDefault();
      input.fire = true;
    }
    if (key === "enter" && runtime.mode === STATE.GAME_OVER) startPlaying();
  }

  function handleKeyUp(event) {
    if (!runtime.open) return;
    const key = normalizedKey(event.key);
    if (key === "arrowleft") input.left = false;
    if (key === "arrowright") input.right = false;
    if (key === "arrowup" || key === " " || key === "spacebar") input.boost = false;
  }

  function bindTouchControls() {
    mobileControls?.querySelectorAll("[data-trajectory-action]").forEach((button) => {
      const action = button.dataset.trajectoryAction;
      const setAction = (pressed) => {
        if (action === "left") input.left = pressed;
        if (action === "right") input.right = pressed;
        if (action === "up" || action === "boost") {
          input.boost = pressed;
          if (pressed && runtime.mode !== STATE.PLAYING && runtime.mode !== STATE.LAUNCHING) startPlaying();
        }
        if (action === "fire" && pressed && runtime.mode === STATE.PLAYING) {
          input.fire = true;
        }
      };
      const releasePointer = (pointerId) => {
        if (touchPointers.get(pointerId) === action) touchPointers.delete(pointerId);
        if (![...touchPointers.values()].includes(action)) setAction(false);
      };
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        if (!runtime.open) return;
        button.setPointerCapture?.(event.pointerId);
        touchPointers.set(event.pointerId, action);
        setAction(true);
      });
      button.addEventListener("pointerup", (event) => { releasePointer(event.pointerId); });
      button.addEventListener("pointercancel", (event) => { releasePointer(event.pointerId); });
      button.addEventListener("pointerleave", (event) => {
        if (event.pointerType !== "mouse") releasePointer(event.pointerId);
      });
    });
  }

  function bindThemeTapUnlock() {
    if (!themeChip) return;
    themeChip.style.cursor = "pointer";
    themeChip.addEventListener("click", () => {
      const now = Date.now();
      runtime.themeTapCount = (now - runtime.themeTapTs <= 4000) ? runtime.themeTapCount + 1 : 1;
      runtime.themeTapTs = now;
      if (runtime.themeTapCount >= 5) {
        runtime.themeTapCount = 0;
        open();
      }
    });
  }

  // ── FTL-style ambient soundtrack (Web Audio API) ──
  const audio = {
    ctx: null,
    playing: false,
    nodes: [],
    masterGain: null,
    arpTimer: null,
  };

  // Arpeggio patterns — minor/spacey chord tones (Hz)
  const ARP_PATTERNS = [
    [130.8, 164.8, 196.0, 261.6, 329.6],   // C minor spread
    [146.8, 174.6, 220.0, 293.7, 349.2],   // D minor spread
    [110.0, 138.6, 164.8, 220.0, 277.2],   // A minor spread
    [123.5, 155.6, 185.0, 246.9, 311.1],   // B minor spread
  ];

  function startChiptune() {
    if (audio.playing) return;
    try {
      if (!audio.ctx) audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
      audio.masterGain = audio.ctx.createGain();
      audio.masterGain.gain.value = 0.12;
      audio.masterGain.connect(audio.ctx.destination);
      audio.playing = true;

      // Layer 1: Deep bass drone (sub-bass sine)
      const bass = audio.ctx.createOscillator();
      bass.type = "sine";
      bass.frequency.value = 55; // A1
      const bassGain = audio.ctx.createGain();
      bassGain.gain.value = 0.35;
      // Slow LFO on bass pitch for movement
      const bassLfo = audio.ctx.createOscillator();
      bassLfo.type = "sine";
      bassLfo.frequency.value = 0.08;
      const bassLfoGain = audio.ctx.createGain();
      bassLfoGain.gain.value = 2;
      bassLfo.connect(bassLfoGain);
      bassLfoGain.connect(bass.frequency);
      bass.connect(bassGain);
      bassGain.connect(audio.masterGain);
      bass.start();
      bassLfo.start();
      audio.nodes.push(bass, bassLfo);

      // Layer 2: Pad (two detuned triangle waves for warm texture)
      const padNotes = [130.8, 196.0, 261.6]; // C3, G3, C4
      padNotes.forEach((freq, i) => {
        const osc = audio.ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = freq;
        const osc2 = audio.ctx.createOscillator();
        osc2.type = "triangle";
        osc2.frequency.value = freq * 1.003; // slight detune for chorusing
        const padGain = audio.ctx.createGain();
        padGain.gain.value = 0.06;
        // Slow amplitude LFO (breathing effect)
        const lfo = audio.ctx.createOscillator();
        lfo.type = "sine";
        lfo.frequency.value = 0.15 + i * 0.05;
        const lfoGain = audio.ctx.createGain();
        lfoGain.gain.value = 0.03;
        lfo.connect(lfoGain);
        lfoGain.connect(padGain.gain);
        osc.connect(padGain);
        osc2.connect(padGain);
        padGain.connect(audio.masterGain);
        osc.start();
        osc2.start();
        lfo.start();
        audio.nodes.push(osc, osc2, lfo);
      });

      // Layer 3: Slow arpeggio (scheduled note-by-note)
      scheduleArpeggio();
    } catch (_) { /* no audio support */ }
  }

  function scheduleArpeggio() {
    if (!audio.playing) return;
    const pattern = ARP_PATTERNS[Math.floor(Math.random() * ARP_PATTERNS.length)];
    let t = audio.ctx.currentTime + 0.1;
    const noteDur = 0.8 + Math.random() * 0.4;
    const gap = 0.3 + Math.random() * 0.2;

    pattern.forEach((freq) => {
      const osc = audio.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq * (Math.random() < 0.3 ? 2 : 1); // occasional octave up
      const env = audio.ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.08, t + 0.08);
      env.gain.setValueAtTime(0.08, t + noteDur * 0.6);
      env.gain.exponentialRampToValueAtTime(0.001, t + noteDur);
      osc.connect(env);
      env.connect(audio.masterGain);
      osc.start(t);
      osc.stop(t + noteDur + 0.05);
      t += noteDur + gap;
    });

    const loopDur = pattern.length * (noteDur + gap) + 1.5 + Math.random() * 2;
    audio.arpTimer = setTimeout(() => {
      if (audio.playing) scheduleArpeggio();
    }, loopDur * 1000);
  }

  function stopChiptune() {
    audio.playing = false;
    audio.nodes.forEach(n => { try { n.stop(); } catch (_) {} });
    audio.nodes = [];
    if (audio.arpTimer) { clearTimeout(audio.arpTimer); audio.arpTimer = null; }
    if (audio.masterGain) { try { audio.masterGain.disconnect(); } catch (_) {} }
  }

  function init() {
    buildStars();
    resetGame();
    bindThemeTapUnlock();
    bindTouchControls();
    closeBtn?.addEventListener("click", close);
    $("trajectory-close-x")?.addEventListener("click", close);
    $("trajectory-launch-btn")?.addEventListener("click", open);
    restartBtn?.addEventListener("click", startPlaying);
    $("trajectory-backdrop")?.addEventListener("click", close);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
  }

  return { init, open, close };
})();


document.querySelectorAll("[data-view-target]").forEach((button) => {
  button.addEventListener("click", () => {
    setDashboardView(button.dataset.viewTarget || "dashboard");
  });
});

$("view-submenu-toggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
  setViewSubmenuOpen(!viewSubmenuOpen);
});

document.addEventListener("click", (event) => {
  const shell = $("view-submenu-shell");
  if (!shell || shell.hidden) return;
  if (!shell.contains(event.target)) closeViewSubmenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeViewSubmenu();
});

window.addEventListener("hashchange", () => {
  setDashboardView(loadViewPref());
});

window.addEventListener("resize", () => {
  if (lastData) drawHeroScope(lastData, historyData);
  if (historyData.length) drawChart(historyData);
});

applyTheme(loadThemePref(), { skipUi: true });
renderThemeUi(loadThemePref());
setDashboardView(activeView);
renderThemeUi(loadThemePref());
trajectoryArcade.init();

fetchLatest();
fetchHistory();
fetchLatestSniff();
fetchSniffHistory();
ensureApod();
startSniffStream();
setInterval(fetchLatest, POLL_MS);
setInterval(fetchHistory, POLL_MS * 8);
setInterval(fetchSniffHistory, POLL_MS * 4);
setInterval(tickAge, 1000);
// Hourly AI weather prediction refresh — force-expire cache so briefing
// regenerates even when device data is not flowing.
setInterval(() => {
  weatherBriefingState.key = "";
  if (lastData) ensureWeatherBriefing(lastData);
}, WEATHER_BRIEFING_TTL_MS);

$("manual-refresh-btn")?.addEventListener("click", () => {
  manualRefreshDashboard();
});

$("theme-retro-toggle")?.addEventListener("change", (event) => {
  applyTheme(event.target.checked ? "retro90s" : "obsidian");
});

document.querySelectorAll("[data-theme-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    const choice = `${button.dataset.themeChoice || ""}`.trim();
    if (!choice) return;
    applyTheme(choice === "retro-90s" ? "retro90s" : choice);
  });
});

$("theme-retro-toggle")?.addEventListener("change", (event) => {
  applyTheme(event.target.checked ? "retro90s" : "obsidian");
});

document.querySelectorAll(".remote-action-btn").forEach((button) => {
  button.addEventListener("click", () => {
    queueRemoteAction(button.dataset.remoteAction || "");
  });
});



(function initWeatherMapFullscreen() {
  const btn = $("map-fullscreen-btn");
  const shell = document.querySelector(".map-shell");
  if (!btn || !shell) return;

  btn.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      shell.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  document.addEventListener("fullscreenchange", () => {
    const isFs = Boolean(document.fullscreenElement);
    btn.textContent = isFs ? "✕" : "⛶";
    btn.title = isFs ? "Exit fullscreen" : "Fullscreen map";
    btn.setAttribute("aria-label", btn.title);
    if (weatherMap) {
      // Leaflet needs a brief delay to let the browser finish the fullscreen
      // CSS transition before recalculating tile layout and viewport bounds.
      setTimeout(() => weatherMap.invalidateSize(), 100);
    }
  });
})();

function syncTopbarSpacing() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  const h = topbar.offsetHeight;
  document.documentElement.style.setProperty("--sticky-rail-top", h + "px");
  document.body.style.paddingTop = h + "px";

  // The tab row (.section-shell) sits sticky right under the topbar. Fixed
  // overlays like the restoration alert strip need to clear BOTH bars, not
  // just the topbar, so publish a second offset that accounts for its full
  // extent too. Measured via getBoundingClientRect (not just offsetHeight)
  // because .section-shell carries its own top margin — a gap that offsetHeight
  // alone doesn't capture — before scrolling triggers its sticky clamp.
  const sectionShell = document.querySelector(".section-shell");
  let alertRailTop = h;
  if (sectionShell) {
    const topbarRect = topbar.getBoundingClientRect();
    const shellRect = sectionShell.getBoundingClientRect();
    const gapBeforeShell = Math.max(0, shellRect.top - topbarRect.bottom);
    alertRailTop = h + gapBeforeShell + sectionShell.offsetHeight;
  }
  document.documentElement.style.setProperty("--alert-rail-top", alertRailTop + "px");
}
syncTopbarSpacing();
document.fonts.ready.then(syncTopbarSpacing);

let _topbarResizeTimer;
window.addEventListener("resize", () => {
  if (historyData.length) drawChart(historyData);
  clearTimeout(_topbarResizeTimer);
  _topbarResizeTimer = setTimeout(syncTopbarSpacing, 60);
});

syncRemoteControlsUi();

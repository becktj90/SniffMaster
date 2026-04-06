/**
 * SniffMaster Pro PWA dashboard
 *
 * Mirrors the richer Blynk-style reports while staying readable on phones.
 * Polls /api/latest every 10 seconds, refreshes history periodically,
 * and listens for priority sulfur/VSC events over SSE.
 */

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
const STALE_MS = 180000;
const SNIFF_EVENT_STALE_MS = 180000;
const WEATHER_BRIEFING_TTL_MS = 30 * 60 * 1000;
const DADABASE_TTL_MS = 15 * 60 * 1000;
const DURATION_MACROS = {
  ML_WHOLE: (bpm) => 240000 / bpm,
  ML_HALF: (bpm) => 120000 / bpm,
  ML_DOTTED_Q: (bpm) => 90000 / bpm,
  ML_QUARTER: (bpm) => 60000 / bpm,
  ML_TRIPLET_Q: (bpm) => 40000 / bpm,
  ML_EIGHTH: (bpm) => 30000 / bpm,
  ML_SIXTEENTH: (bpm) => 15000 / bpm,
  ML_DOTTED_E: (bpm) => 45000 / bpm,
};
const MELODY_ALIASES = {
  "(none yet)": "",
  "Sensor Calibrated!": "Calibration Fanfare",
  "!! SMOKE / GAS ALERT !!": "Smoke Alert",
};
const DAD_JOKES = [
  "I only know 25 letters of the alphabet. I do not know y.",
  "Why do cows wear bells? Because their horns do not work.",
  "I used to hate facial hair, but then it grew on me.",
  "I am reading a book about anti-gravity. It is impossible to put down.",
  "I told my wife she was drawing her eyebrows too high. She looked surprised.",
  "What do you call fake spaghetti? An impasta.",
  "Why did the scarecrow win an award? He was outstanding in his field.",
  "I would avoid the sushi if I were you. It is a little fishy.",
  "Why can’t you hear a pterodactyl go to the bathroom? Because the P is silent.",
  "I used to be addicted to soap, but I am clean now.",
  "Why did the golfer bring two pairs of pants? In case he got a hole in one.",
  "Did you hear about the restaurant on the moon? Great food, no atmosphere.",
  "What do you call cheese that is not yours? Nacho cheese.",
  "I was going to tell a time-travel joke, but you did not like it.",
  "Why are elevator jokes so good? They work on many levels.",
  "I ordered a chicken and an egg from Amazon. I will let you know.",
  "Why did the math book look sad? It had too many problems.",
  "What do you call a factory that makes okay products? A satisfactory.",
  "How do you organize a space party? You planet.",
  "I only trust stairs. They are always up to something.",
  "What did the ocean say to the beach? Nothing, it just waved.",
  "Why did the bicycle fall over? It was two tired.",
  "I used to play piano by ear, but now I use my hands.",
  "What do you call a pile of cats? A meowtain.",
  "Why did the coffee file a police report? It got mugged.",
  "What do you call a belt made of watches? A waist of time.",
  "Why did the computer go to therapy? It had too many bytes from the past.",
  "What kind of tree fits in your hand? A palm tree.",
  "Why did the mushroom get invited to every party? He was a fungi.",
  "What do you call an alligator in a vest? An investigator.",
  "Why was the stadium so cool? It was filled with fans.",
  "What do you call a fish wearing a bowtie? Sofishticated.",
  "Why do bees have sticky hair? Because they use honeycombs.",
  "What did one wall say to the other wall? I will meet you at the corner.",
  "What does a sprinter eat before a race? Nothing, they fast.",
  "Why did the tomato blush? It saw the salad dressing.",
  "What kind of music do planets sing? Nep-tunes.",
  "Why was the broom late? It swept in.",
  "What do you call a sleeping bull? A bulldozer.",
  "Why did the orange stop? It ran out of juice."
];
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
  night: false,
  epa: false,
  crime: false,
};
const VIEW_META = {
  dashboard: {
    title: "Dashboard",
    subtitle: "Live room status, key metrics, and current guidance in one scan-friendly view.",
  },
  environment: {
    title: "Environment",
    subtitle: "Raw inputs, derived air metrics, and simplified outdoor context.",
  },
  analysis: {
    title: "Analysis",
    subtitle: "Classifier output, odor intensity, vitality, and breath-related interpretation.",
  },
  history: {
    title: "History",
    subtitle: "Daily rhythm patterns and the timestamped event log.",
  },
  system: {
    title: "System",
    subtitle: "Hardware, signal path, controls, confidence notes, and use cases.",
  },
  labs: {
    title: "Labs",
    subtitle: "Experimental and playful features separated from the primary instrument views.",
  },
};

const VIEW_SECTIONS = {
  dashboard: [
    { id: "card-hero", label: "Snapshot" },
    { id: "card-status", label: "Status" },
    { id: "card-intel", label: "Metrics" },
    { id: "card-office", label: "Vitality" },
    { id: "card-space", label: "Launches" },
    { id: "card-history", label: "History" },
  ],
  environment: [
    { id: "card-status", label: "Status" },
    { id: "card-telemetry", label: "Raw Inputs" },
    { id: "card-derived", label: "Derived" },
    { id: "card-weather-intel", label: "Weather" },
  ],
  analysis: [
    { id: "card-office", label: "Vitality" },
    { id: "card-odor", label: "Classification" },
    { id: "card-breath", label: "Breath" },
    { id: "card-fart", label: "Stank" },
    { id: "card-classifier", label: "Channels" },
    { id: "card-bro", label: "Readout" },
  ],
  history: [
    { id: "card-chart", label: "Rhythm" },
    { id: "card-events", label: "Events" },
  ],
  system: [
    { id: "card-status", label: "Status" },
    { id: "card-device", label: "Hardware" },
    { id: "card-method", label: "Pipeline" },
    { id: "card-confidence", label: "Confidence" },
    { id: "card-usecases", label: "Use Cases" },
    { id: "card-theme", label: "Theme" },
    { id: "card-controls", label: "Controls" },
  ],
  labs: [
    { id: "card-dadabase", label: "Dadabase" },
    { id: "card-melody", label: "Melodies" },
    { id: "card-paranormal", label: "Paranormal" },
  ],
};

let lastData = null;
let historyData = [];
let sniffHistoryData = [];
let lastSniffEvent = null;
let melodyBankPromise = null;
let melodyBankData = null;
let melodyLibraryState = {
  query: "",
  category: "all",
  selectedTitle: "",
};
let audioCtx = null;
let currentPlayback = null;
let sniffStream = null;
let dadabaseQuery = "";
let weatherMap = null;
let weatherMarker = null;
let weatherBaseLayer = null;
let weatherBriefingState = {
  key: "",
  fetchedAt: 0,
  data: null,
  pending: null,
};
let dadabaseState = {
  fetchedAt: 0,
  data: null,
  pending: null,
  refreshing: false,
  notice: "",
};
let mapLayerPrefs = loadMapLayerPrefs();
let activeView = loadViewPref();
let mapLayers = {
  radar: null,
  night: null,
  epa: null,
};
let rainViewerState = {
  fetchedAt: 0,
  tileUrl: "",
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

function loadMapLayerPrefs() {
  try {
    const raw = localStorage.getItem(MAP_PREF_KEY);
    if (!raw) return { ...DEFAULT_MAP_LAYERS };
    const parsed = JSON.parse(raw);
    return {
      radar: Boolean(parsed.radar ?? DEFAULT_MAP_LAYERS.radar),
      night: false,
      epa: false,
      crime: false,
    };
  } catch (_) {
    return { ...DEFAULT_MAP_LAYERS };
  }
}

function saveMapLayerPrefs() {
  try {
    localStorage.setItem(MAP_PREF_KEY, JSON.stringify({
      radar: Boolean(mapLayerPrefs.radar),
      night: Boolean(mapLayerPrefs.night),
      epa: Boolean(mapLayerPrefs.epa),
    }));
  } catch (_) {}
}

function loadViewPref() {
  try {
    const hash = `${window.location.hash || ""}`.replace(/^#/, "");
    const alias = { home: "dashboard", air: "analysis", weather: "environment", space: "dashboard", paranormal: "labs" };
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

function headerPresenceText(d) {
  const state = `${d.blePresenceState || ""}`.trim();
  const conf = Math.round(num(d.blePresenceConf, NaN));
  const enabled = d.blePresenceEnabled === true
    || Boolean(state)
    || Number.isFinite(conf);
  if (!enabled) return "Presence off";
  const label = humanLabel(state || "Idle", "Idle");
  return Number.isFinite(conf) && conf > 0 ? `${label} ${conf}%` : label;
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

function melodyReasonLabel(reason) {
  const raw = `${reason || ""}`.trim();
  if (!raw) return "manual trigger";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
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

function dailyJokeIndex(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const current = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfYear = Math.floor((current - start) / 86400000);
  return dayOfYear % DAD_JOKES.length;
}

function dailyJokeDateLabel(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

function dadabaseFallbackPayload(date = new Date()) {
  const currentIndex = dailyJokeIndex(date);
  return {
    current: {
      joke: DAD_JOKES[currentIndex],
      dateLabel: dailyJokeDateLabel(date),
      mode: "catalog",
      generatedAt: date.getTime(),
    },
    history: [],
    sourceCaption: "Source: local Dadabase classics baked into the portal shell",
  };
}

function dadabaseModeLabel(mode) {
  if (mode === "openai") return "OpenAI daily joke";
  if (mode === "fallback") return "Server fallback joke";
  return "Dadabase classic";
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

function sniffTone(conf) {
  if (conf >= 85) return { label: "Sulfur spike", tone: "danger" };
  if (conf >= 70) return { label: "High sulfur", tone: "danger" };
  if (conf >= 40) return { label: "Sulfur active", tone: "warn" };
  if (conf >= 20) return { label: "Sulfur trace", tone: "neutral" };
  return { label: "Sulfur quiet", tone: "good" };
}

function stankColor(conf) {
  if (conf >= 85) return "#d8ef72";
  if (conf >= 70) return "#bce85a";
  if (conf >= 40) return "#8de96c";
  if (conf >= 20) return "#6fe59d";
  return "#5df1a4";
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

function cleanArrayTokens(body) {
  return body
    .replace(/\/\/.*$/gm, "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseDurationToken(token) {
  const numeric = Number(token.replace(/U/g, ""));
  if (Number.isFinite(numeric)) return numeric;

  const macroMatch = token.match(/^([A-Z_]+)\s*\(\s*(\d+)\s*\)$/);
  if (!macroMatch) return 0;

  const [, macroName, bpmRaw] = macroMatch;
  const macro = DURATION_MACROS[macroName];
  const bpm = Number(bpmRaw);
  return macro && bpm > 0 ? Math.round(macro(bpm)) : 0;
}

function normalizeMelodyTitle(title) {
  const raw = (title || "").trim();
  return MELODY_ALIASES[raw] ?? raw;
}

function melodySectionLabel(sectionName) {
  const raw = `${sectionName || ""}`.trim().toUpperCase();
  if (raw === "SONGS") return "Songs";
  if (raw === "ICONIC_JINGLES") return "Jingles";
  if (raw === "ALERTS") return "Alerts";
  return raw
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function melodySectionKey(sectionName) {
  const raw = `${sectionName || ""}`.trim().toUpperCase();
  if (raw === "SONGS") return "songs";
  if (raw === "ICONIC_JINGLES") return "jingles";
  if (raw === "ALERTS") return "alerts";
  return raw.toLowerCase() || "misc";
}

function melodyDurationMs(item) {
  if (!item || !Array.isArray(item.durations)) return 0;
  const base = item.durations.reduce((sum, dur) => sum + Math.max(0, num(dur, 0)), 0);
  return Math.round(base * Math.max(1, num(item.repeats, 1)));
}

function melodyTrackTags(item) {
  const tags = [];
  const title = `${item?.title || ""}`.toLowerCase();
  const source = `${item?.source || ""}`.toLowerCase();
  const allText = `${title} ${source}`;

  if (/christmas|jingle bells|we wish you|deck the halls|silent night|carol of the bells|happy birthday/.test(allText)) {
    tags.push("Holiday");
  }
  if (/mario|zelda|tetris|pac-man|sonic|playstation|street fighter|wii/.test(allText)) {
    tags.push("Game");
  }
  if (/theme|stinger|fanfare|stab|sweep|chimes|breaking news|network|commercial|tv/.test(allText)) {
    tags.push("Stinger");
  }
  if (/jurassic|harry potter|lord of the rings|ghostbusters|mission impossible|pink panther|game of thrones|stranger things|simpsons|jaws|fur elise|beethoven|imperial march|under pressure|free bird|funkytown|beat it|thriller|hedwig/.test(allText)) {
    tags.push("Iconic");
  }
  if (/traditional|beethoven|mancini|zimmer|williams|djawadi|griffin|schifrin/.test(source)) {
    tags.push("Classic");
  }
  if ((item?.categoryLabel || "") === "Alerts") {
    tags.push("System");
  }

  return [...new Set(tags)].slice(0, 3);
}

function melodyTrackSearchText(item) {
  return [
    item?.title || "",
    item?.source || "",
    item?.categoryLabel || "",
    item?.sectionLabel || "",
    ...(item?.tags || []),
  ].join(" ").toLowerCase();
}

function parseMelodyHeader(text) {
  const noteValues = new Map();
  const noteArrays = new Map();
  const durationArrays = new Map();
  const byTitle = new Map();
  const byKey = new Map();
  const sections = [];

  const noteValueRegex = /constexpr int16_t\s+(\w+)\s*=\s*(\d+);/g;
  let match;
  while ((match = noteValueRegex.exec(text))) {
    noteValues.set(match[1], Number(match[2]));
  }

  const noteArrayRegex = /static const int16_t\s+(\w+)\[\]\s*=\s*\{([\s\S]*?)\};/g;
  while ((match = noteArrayRegex.exec(text))) {
    noteArrays.set(
      match[1],
      cleanArrayTokens(match[2]).map((token) => noteValues.get(token) ?? Number(token) ?? 0)
    );
  }

  const durationArrayRegex = /static const uint16_t\s+(\w+)\[\]\s*=\s*\{([\s\S]*?)\};/g;
  while ((match = durationArrayRegex.exec(text))) {
    durationArrays.set(
      match[1],
      cleanArrayTokens(match[2]).map(parseDurationToken)
    );
  }

  const melodyInfoRegex = /\{\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*(\w+),\s*(\w+),\s*melodyLen\(\w+\),\s*(\d+)\s*\}/g;
  const sectionRegex = /static const MelodyInfo\s+(\w+)\[\]\s*=\s*\{([\s\S]*?)\n\};/g;
  while ((match = sectionRegex.exec(text))) {
    const [, sectionName, sectionBody] = match;
    melodyInfoRegex.lastIndex = 0;
    const sectionItems = [];
    let entry;
    while ((entry = melodyInfoRegex.exec(sectionBody))) {
      const [, key, title, source, noteArrayName, durationArrayName, repeatsRaw] = entry;
      const notes = noteArrays.get(noteArrayName);
      const durations = durationArrays.get(durationArrayName);
      if (!notes || !durations || !notes.length || !durations.length) continue;
      const item = {
        key,
        title,
        source,
        notes,
        durations,
        repeats: Number(repeatsRaw) || 1,
        sectionName,
        sectionKey: melodySectionKey(sectionName),
        sectionLabel: melodySectionLabel(sectionName),
      };
      item.tags = melodyTrackTags(item);
      item.durationMs = melodyDurationMs(item);
      item.searchText = melodyTrackSearchText(item);
      sectionItems.push(item);
      byTitle.set(title, item);
      byKey.set(key, item);
    }
    if (sectionItems.length) {
      sections.push({
        sectionName,
        sectionKey: melodySectionKey(sectionName),
        sectionLabel: melodySectionLabel(sectionName),
        items: sectionItems,
      });
    }
  }

  const items = sections.flatMap((section) => section.items);
  return { byTitle, byKey, items, sections };
}

async function loadMelodyBank() {
  if (!melodyBankPromise) {
    melodyBankPromise = fetch("/melody_library.h", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`melody ${res.status}`);
        return res.text();
      })
      .then(parseMelodyHeader)
      .then((bank) => {
        melodyBankData = bank;
        return bank;
      });
  }
  return melodyBankPromise;
}

function ensureAudioContext() {
  if (!audioCtx) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) throw new Error("Web Audio unavailable");
    audioCtx = new AudioCtor();
  }
  return audioCtx;
}

function stopMelodyPlayback() {
  if (!currentPlayback) return;
  if (currentPlayback.timeoutId) clearTimeout(currentPlayback.timeoutId);
  currentPlayback.oscillators.forEach((oscillator) => {
    try { oscillator.stop(); } catch (_) {}
  });
  currentPlayback = null;
}

function setMelodyStatus(text) {
  const el = $("melody-status");
  if (el) el.textContent = text;
}

function renderMelodyControls(data) {
  const btn = $("melody-play-btn");
  const titleEl = $("melody-title");
  const metaEl = $("melody-meta");
  if (!btn || !titleEl || !metaEl) return;

  const rawTitle = (data?.lastMelody || "").trim();
  const normalizedTitle = normalizeMelodyTitle(rawTitle);
  const hasMelody = Boolean(rawTitle && normalizedTitle);
  const reason = melodyReasonLabel(data?.lastMelodyReason);
  const eventTs = melodyEventTimestamp(data);
  const isPlaying = Boolean(currentPlayback && currentPlayback.title === normalizedTitle);

  titleEl.textContent = hasMelody ? `Last tune: ${rawTitle}` : "No melody posted yet";
  metaEl.textContent = hasMelody
    ? `${eventTs ? `Played ${fmtAge(eventTs)} · ${fmtStamp(eventTs)}` : "Play time pending"} · ${reason}`
    : "Timing and trigger details will appear here with the first melody event.";

  if (!hasMelody) {
    btn.disabled = true;
    btn.textContent = "Replay Last Melody";
    setMelodyStatus("Browser replay will appear here once the device posts a tune.");
    return;
  }

  btn.disabled = true;
  btn.textContent = isPlaying ? "Stop Melody" : "Loading Melody...";
  if (!isPlaying) {
    setMelodyStatus("Loading the buzzer melody bank for browser replay...");
  }

  loadMelodyBank()
    .then((bank) => {
      const found = bank.byTitle.has(normalizedTitle);
      btn.disabled = !found;
      btn.textContent = isPlaying ? "Stop Melody" : (found ? "Replay Last Melody" : "Replay Unavailable");
      if (isPlaying) {
        setMelodyStatus(`Playing ${rawTitle} in the browser. Tap again to stop.`);
      } else if (found) {
        setMelodyStatus(`Triggered by ${reason.toLowerCase()}. Tap to hear the last buzzer tune in your browser.`);
      } else {
        setMelodyStatus(`No browser replay bank was found for ${rawTitle}.`);
      }
    })
    .catch(() => {
      btn.disabled = true;
      btn.textContent = "Replay Offline";
      setMelodyStatus("Melody replay bank could not be loaded from the web app.");
    });
}

function setMelodyLibrarySelection(title) {
  melodyLibraryState.selectedTitle = `${title || ""}`.trim();
  renderMelodyLibrary(lastData);
}

async function playMelodyByTitle(rawTitle, options = {}) {
  const normalizedTitle = normalizeMelodyTitle(rawTitle);
  if (!normalizedTitle) return false;

  if (currentPlayback && currentPlayback.title === normalizedTitle) {
    stopMelodyPlayback();
    renderMelodyControls(lastData);
    renderMelodyLibrary(lastData);
    return true;
  }

  try {
    const bank = await loadMelodyBank();
    const melody = bank.byTitle.get(normalizedTitle);
    if (!melody) {
      return false;
    }

    stopMelodyPlayback();

    const ctx = ensureAudioContext();
    if (ctx.state === "suspended") await ctx.resume();

    const oscillators = [];
    let cursor = ctx.currentTime + 0.04;
    melody.notes.forEach((freq, index) => {
      const durMs = Math.max(40, melody.durations[index] || 140);
      const durSec = durMs / 1000;
      const gateSec = Math.max(0.03, durSec * 0.88);

      if (freq > 0) {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "square";
        oscillator.frequency.setValueAtTime(freq, cursor);
        gain.gain.setValueAtTime(0.0001, cursor);
        gain.gain.exponentialRampToValueAtTime(0.055, cursor + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, cursor + gateSec);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(cursor);
        oscillator.stop(cursor + gateSec + 0.03);
        oscillators.push(oscillator);
      }

      cursor += durSec + 0.015;
    });

    const totalMs = Math.max(250, Math.round((cursor - ctx.currentTime) * 1000));
    currentPlayback = {
      title: normalizedTitle,
      source: options.source || "browser",
      oscillators,
      timeoutId: window.setTimeout(() => {
        currentPlayback = null;
        renderMelodyControls(lastData);
        renderMelodyLibrary(lastData);
      }, totalMs + 60),
    };

    renderMelodyControls(lastData);
    renderMelodyLibrary(lastData);
    return true;
  } catch (_) {
    setMelodyStatus("Browser audio is unavailable here, so the melody could not be replayed.");
    return false;
  }
}

async function playMelodyFromSnapshot() {
  const rawTitle = (lastData?.lastMelody || "").trim();
  const normalizedTitle = normalizeMelodyTitle(rawTitle);
  if (!normalizedTitle) return;
  await playMelodyByTitle(normalizedTitle, { source: "snapshot" });
}

function melodyLibraryTrackMarkup(item, selectedTitle, playingTitle) {
  const isSelected = item.title === selectedTitle;
  const isPlaying = item.title === playingTitle;
  const durationLabel = item.durationMs ? `${Math.max(1, Math.round(item.durationMs / 1000))}s` : "--";
  const tagMarkup = item.tags.length
    ? item.tags.map((tag) => `<span class="melody-track-tag">${escapeHtml(tag)}</span>`).join("")
    : '<span class="melody-track-tag is-muted">No extra tags</span>';

  return `
    <article
      class="melody-track${isSelected ? " is-selected" : ""}${isPlaying ? " is-playing" : ""}"
      data-melody-title="${escapeHtml(item.title)}"
      tabindex="0"
      role="button"
      aria-pressed="${isSelected ? "true" : "false"}"
      aria-label="Select ${escapeHtml(item.title)}"
    >
      <div class="melody-track-top">
        <div class="melody-track-copy">
          <div class="melody-track-title">${escapeHtml(item.title)}</div>
          <div class="melody-track-source">
            ${escapeHtml(item.source)} · ${escapeHtml(item.sectionLabel)} · ${durationLabel}${item.repeats > 1 ? ` · x${item.repeats}` : ""}
          </div>
        </div>
        <button
          class="chrome-btn melody-track-play"
          type="button"
          data-melody-play="${escapeHtml(item.title)}"
        >${isPlaying ? "Stop" : "Play"}</button>
      </div>
      <div class="melody-track-tags">${tagMarkup}</div>
    </article>
  `;
}

function selectedMelodyItem() {
  return melodyBankData?.byTitle?.get(melodyLibraryState.selectedTitle) || null;
}

function renderMelodyLibrary(d) {
  const bank = melodyBankData;
  const list = $("melody-library-list");
  const count = $("melody-library-count");
  const badge = $("melody-library-badge");
  const selectedTitleEl = $("melody-library-selected-title");
  const selectedMetaEl = $("melody-library-selected-meta");
  const selectedTagsEl = $("melody-library-selected-tags");
  const playSelectedBtn = $("melody-library-play-selected");
  const playDeviceBtn = $("melody-library-play-device");
  const searchInput = $("melody-library-search");
  const filterRow = $("melody-library-filters");
  const empty = $("melody-library-empty");
  const status = $("melody-library-status");
  const deviceNote = $("melody-library-device-note");

  if (searchInput && searchInput.value !== melodyLibraryState.query) {
    searchInput.value = melodyLibraryState.query;
  }

  if (!bank) {
    if (badge) badge.textContent = "Loading";
    if (count) count.textContent = "Loading melody bank...";
    if (selectedTitleEl) selectedTitleEl.textContent = "Loading melody bank...";
    if (selectedMetaEl) selectedMetaEl.textContent = "Browser playback will appear once the melody catalog loads.";
    if (selectedTagsEl) selectedTagsEl.innerHTML = "";
    if (list) list.innerHTML = '<div class="melody-empty">Melody catalog loading...</div>';
    if (status) status.textContent = "Melody bank is loading from the portal.";
    if (playSelectedBtn) {
      playSelectedBtn.disabled = true;
      playSelectedBtn.textContent = "Preview selected";
    }
    if (playDeviceBtn) {
      playDeviceBtn.disabled = true;
      playDeviceBtn.textContent = "Play on device";
    }
    if (filterRow) filterRow.innerHTML = "";
    if (empty) empty.hidden = true;
    if (deviceNote) deviceNote.textContent = "Unlock remote controls on the System page to queue a tune on the device.";
    return;
  }

  const allItems = bank.items || [];
  const sections = bank.sections || [];
  const query = melodyLibraryState.query.trim().toLowerCase();
  const category = melodyLibraryState.category || "all";
  const filtered = allItems.filter((item) => {
    const categoryMatch = category === "all" || item.sectionKey === category;
    const queryMatch = !query || item.searchText.includes(query);
    return categoryMatch && queryMatch;
  });

  const filterButtons = [
    { key: "all", label: `All (${allItems.length})` },
    ...sections.map((section) => ({
      key: section.sectionKey,
      label: `${section.sectionLabel} (${section.items.length})`,
    })),
  ];
  if (filterRow) {
    filterRow.innerHTML = filterButtons.map((button) => `
      <button
        class="melody-filter-chip${melodyLibraryState.category === button.key ? " is-active" : ""}"
        type="button"
        data-melody-filter="${escapeHtml(button.key)}"
      >${escapeHtml(button.label)}</button>
    `).join("");
  }

  const snapshotTitle = normalizeMelodyTitle(d?.lastMelody || "");
  const visibleSelection = melodyLibraryState.selectedTitle
    && filtered.some((item) => item.title === melodyLibraryState.selectedTitle)
      ? melodyLibraryState.selectedTitle
      : "";
  const snapshotSelection = snapshotTitle && filtered.some((item) => item.title === snapshotTitle)
    ? snapshotTitle
    : "";
  let nextSelection = "";
  if (filtered.length) {
    nextSelection = visibleSelection || snapshotSelection || melodyLibraryState.selectedTitle || filtered[0]?.title || "";
  }
  melodyLibraryState.selectedTitle = nextSelection;

  const selectedItem = bank.byTitle.get(nextSelection) || null;
  const playingTitle = currentPlayback?.title || "";
  const selectedPlaying = selectedItem && selectedItem.title === playingTitle;
  const selectedDuration = selectedItem && selectedItem.durationMs ? `${Math.max(1, Math.round(selectedItem.durationMs / 1000))}s` : "--";

  if (badge) badge.textContent = `${allItems.length} tracks`;
  if (count) {
    count.textContent = filtered.length === allItems.length
      ? `${filtered.length} tracks`
      : `${filtered.length} of ${allItems.length} tracks`;
  }
  if (selectedTitleEl) {
    selectedTitleEl.textContent = selectedItem ? selectedItem.title : "Choose a track";
  }
  if (selectedMetaEl) {
    selectedMetaEl.textContent = selectedItem
      ? `${selectedItem.source} · ${selectedItem.sectionLabel} · ${selectedDuration}${selectedItem.repeats > 1 ? ` · ${selectedItem.repeats} passes` : ""}`
      : "Search the catalog and tap any track to hear it in the browser.";
  }
  if (selectedTagsEl) {
    selectedTagsEl.innerHTML = selectedItem
      ? [
          `<span class="melody-selected-tag">${escapeHtml(selectedItem.sectionLabel)}</span>`,
          ...selectedItem.tags.map((tag) => `<span class="melody-selected-tag is-subtle">${escapeHtml(tag)}</span>`),
          `<span class="melody-selected-tag is-subtle">${escapeHtml(selectedDuration)}</span>`,
        ].join("")
      : '<span class="melody-selected-tag is-subtle">Search the catalog to load details</span>';
  }
  if (playSelectedBtn) {
    playSelectedBtn.disabled = !selectedItem;
    playSelectedBtn.textContent = selectedPlaying ? "Stop preview" : "Preview selected";
  }
  if (playDeviceBtn) {
    playDeviceBtn.disabled = !selectedItem || remoteCommandPending;
    playDeviceBtn.textContent = remoteCommandPending ? "Queueing..." : "Play on device";
  }
  if (status) {
    status.textContent = filtered.length
      ? `${filtered.length} ${filtered.length === 1 ? "melody" : "melodies"} ready for browser playback.`
      : "No matches found. Try a different search term or category.";
  }
  if (deviceNote) {
    if (!selectedItem) {
      deviceNote.textContent = "Choose a track to send it to the hardware jukebox.";
    } else if (remoteCommandPending) {
      deviceNote.textContent = `Queueing ${selectedItem.title} on the device now.`;
    } else if (loadOwnerKey()) {
      deviceNote.textContent = `Send ${selectedItem.title} to the live device without touching the button panel.`;
    } else {
      deviceNote.textContent = "Unlock remote controls on the System page to queue a tune on the device.";
    }
  }

  if (list) {
    if (filtered.length) {
      list.innerHTML = filtered.map((item) => melodyLibraryTrackMarkup(item, melodyLibraryState.selectedTitle, playingTitle)).join("");
      list.querySelectorAll("[data-melody-title]").forEach((itemEl) => {
        itemEl.addEventListener("click", (event) => {
          if (event.target.closest("[data-melody-play]")) return;
          setMelodyLibrarySelection(itemEl.dataset.melodyTitle || "");
        });
        itemEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setMelodyLibrarySelection(itemEl.dataset.melodyTitle || "");
          }
        });
      });
      list.querySelectorAll("[data-melody-play]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          const title = button.dataset.melodyPlay || "";
          setMelodyLibrarySelection(title);
          await playMelodyByTitle(title, { source: "library" });
          renderMelodyLibrary(lastData);
        });
      });
    } else {
      list.innerHTML = "";
    }
  }

  if (empty) {
    empty.hidden = filtered.length > 0;
    empty.textContent = "No tracks match that search yet. Try a broader keyword or switch categories.";
  }
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

function heroSummaryText(d) {
  const aiLine = trimHeadline(d?.sassy, 104);
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

function buildGroanArchive(payload = dadabaseFallbackPayload()) {
  const query = dadabaseQuery.trim().toLowerCase();
  const currentText = `${payload?.current?.joke || ""}`.trim().toLowerCase();
  const entries = [];
  const seen = new Set(currentText ? [currentText] : []);

  (Array.isArray(payload?.history) ? payload.history : []).forEach((entry, index) => {
    const text = `${entry?.joke || ""}`.trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      text,
      label: entry?.mode === "openai" ? "Generated" : "Daily",
      meta: entry?.dateLabel || `Entry ${index + 1}`,
      generated: entry?.mode === "openai",
    });
  });

  DAD_JOKES.forEach((text, index) => {
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      text,
      label: "Classic",
      meta: `Catalog ${index + 1}`,
      generated: false,
    });
  });

  return entries.filter((entry) => {
    if (!query) return true;
    return [entry.text, entry.label, entry.meta]
      .some((value) => `${value || ""}`.toLowerCase().includes(query));
  });
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

function closestHistorySnapshot(timestamp, history, current) {
  const pool = [...(history || [])];
  if (current?.receivedAt) pool.push(current);

  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  pool.forEach((item) => {
    const ts = num(item?.receivedAt, NaN);
    if (!Number.isFinite(ts)) return;
    const delta = Math.abs(ts - num(timestamp, 0));
    if (delta < bestDelta) {
      bestDelta = delta;
      best = item;
    }
  });
  return bestDelta <= 30 * 60 * 1000 ? best : null;
}

function eventSoundProfile(event, history, current) {
  const matched = closestHistorySnapshot(event.timestamp, history, current);
  const matchedMelody = normalizeMelodyTitle(matched?.lastMelody || "");
  if (matchedMelody) {
    const reason = `${matched?.lastMelodyReason || ""}`.trim();
    return reason ? `${matchedMelody} · ${reason}` : matchedMelody;
  }

  if (event.tag === "Sulfur") return "Sulfur Watch";
  if (event.tag === "Fart Lab") return "Stank Alert";
  if (event.tag === "Ghost") return "Paranormal Ping";
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

function hashString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function paranormalSignal(d) {
  if (!(d.paranormalEntity || d.paranormalReport)) {
    return {
      strength: 10,
      tone: "neutral",
      title: "Background static",
      note: "No cached anomaly signature is mirrored from the device right now. This Labs view is driven by environmental volatility and themed interpretation.",
    };
  }

  const ts = derivedEventTimestamp(d, "paranormalUptime");
  const ageMinutes = ts ? (Date.now() - ts) / 60000 : 9999;
  let strength = 32;
  if (ageMinutes < 30) strength = 86;
  else if (ageMinutes < 180) strength = 68;
  else if (ageMinutes < 720) strength = 48;

  return {
    strength,
    tone: strength >= 75 ? "danger" : strength >= 45 ? "warn" : "neutral",
    title: strength >= 75 ? "Fresh anomaly" : strength >= 45 ? "Residual anomaly" : "Fading trace",
    note: ts
      ? `${d.paranormalEntity || "Unknown"} was last seen ${fmtAge(ts)}. The radar is visualizing cached scan intensity from the live environmental signal stack.`
      : "A cached anomaly result exists, but its timing could not be reconstructed cleanly. The display is still based on gas and room-context signals.",
  };
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

function setMapLayerStatus(text) {
  const el = $("map-layer-status");
  if (el) el.textContent = text;
}

function renderMapLayerButtons() {
  document.querySelectorAll(".map-layer-chip").forEach((button) => {
    const key = button.dataset.layer;
    const active = Boolean(mapLayerPrefs[key]);
    button.classList.toggle("is-active", active);
    const unavailable = key === "crime";
    button.classList.toggle("is-unavailable", unavailable && !active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

async function fetchRainViewerTileUrl() {
  const now = Date.now();
  if (rainViewerState.tileUrl && now - rainViewerState.fetchedAt < 8 * 60 * 1000) {
    return rainViewerState.tileUrl;
  }

  try {
    const res = await fetch("https://api.rainviewer.com/public/weather-maps.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`radar ${res.status}`);
    const data = await res.json();
    const frame = data?.radar?.past?.[data.radar.past.length - 1];
    const host = data?.host;
    if (!frame?.path || !host) throw new Error("missing radar frame");
    rainViewerState = {
      fetchedAt: now,
      tileUrl: `${host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`,
    };
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
    opacity: 0.58,
    attribution: "Radar © RainViewer",
    maxNativeZoom: 7,
    maxZoom: 18,
  });
  return mapLayers.radar;
}

function ensureNightLightsLayer() {
  if (mapLayers.night) return mapLayers.night;
  if (!window.L) return null;

  mapLayers.night = window.L.tileLayer.wms("https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi", {
    layers: "VIIRS_Black_Marble",
    format: "image/png",
    transparent: true,
    opacity: 0.48,
    attribution: "Night lights © NASA GIBS",
    maxZoom: 12,
  });
  return mapLayers.night;
}

function epaMarkerTone(props) {
  const serious = `${props.FAC_CURR_SNC_FLG || ""}`.toUpperCase() === "Y";
  const count = num(props.CURRENT_VIO_CNT, 0);
  if (serious || count >= 2) return { color: "#e74c3c", radius: 7 };
  if (count >= 1) return { color: "#f1c40f", radius: 6 };
  return { color: "#00f2ff", radius: 5 };
}

function ensureEpaLayer() {
  if (mapLayers.epa) return mapLayers.epa;
  if (!(window.L && window.L.esri)) return null;

  mapLayers.epa = window.L.esri.featureLayer({
    url: "https://echogeo.epa.gov/arcgis/rest/services/ECHO/Facilities/MapServer/0",
    where: "CURRENT_VIO_CNT > 0 OR FAC_CURR_SNC_FLG = 'Y'",
    fields: [
      "FAC_NAME",
      "FAC_CITY",
      "FAC_STATE",
      "FAC_CURR_SNC_FLG",
      "CURRENT_VIO_CNT",
      "FAC_3YR_COMPLIANCE_STATUS",
      "FAC_PROGRAMS_IN_SNC",
    ],
    pointToLayer(geojson, latlng) {
      const tone = epaMarkerTone(geojson.properties || {});
      return window.L.circleMarker(latlng, {
        radius: tone.radius,
        color: "rgba(9, 12, 16, 0.92)",
        weight: 1.6,
        fillColor: tone.color,
        fillOpacity: 0.88,
        className: "epa-marker",
      });
    },
  });

  mapLayers.epa.bindPopup((layer) => {
    const props = layer.feature?.properties || {};
    const count = Math.round(num(props.CURRENT_VIO_CNT, 0));
    const snc = `${props.FAC_CURR_SNC_FLG || ""}`.toUpperCase() === "Y" ? "Yes" : "No";
    const programs = Math.round(num(props.FAC_PROGRAMS_IN_SNC, 0));
    return `
      <strong>${escapeHtml(props.FAC_NAME || "EPA facility")}</strong><br>
      ${escapeHtml(props.FAC_CITY || "")}${props.FAC_STATE ? `, ${escapeHtml(props.FAC_STATE)}` : ""}<br>
      Current violations: ${count}<br>
      Significant noncompliance: ${snc}<br>
      Programs in SNC: ${programs}<br>
      3-year status: ${escapeHtml(props.FAC_3YR_COMPLIANCE_STATUS || "Unknown")}
    `;
  });

  return mapLayers.epa;
}

function ensureWeatherMap() {
  if (weatherMap || !window.L) return weatherMap;
  const el = $("weather-map");
  if (!el) return null;

  weatherMap = window.L.map(el, {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
  });
  window.L.control.zoom({ position: "topright" }).addTo(weatherMap);
  weatherBaseLayer = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(weatherMap);

  weatherMarker = window.L.circleMarker([28.2062, -80.6874], {
    radius: 7,
    color: "rgba(9, 12, 16, 0.92)",
    weight: 2,
    fillColor: "#00f2ff",
    fillOpacity: 0.95,
  }).addTo(weatherMap);
  weatherMap.setView([28.2062, -80.6874], 10);
  renderMapLayerButtons();
  return weatherMap;
}

async function syncMapLayers() {
  if (!weatherMap) return;

  const active = [];

  if (mapLayerPrefs.radar) {
    const radarLayer = await ensureRadarLayer();
    if (radarLayer && !weatherMap.hasLayer(radarLayer)) radarLayer.addTo(weatherMap);
    if (radarLayer) active.push("Radar");
  } else if (mapLayers.radar && weatherMap.hasLayer(mapLayers.radar)) {
    weatherMap.removeLayer(mapLayers.radar);
  }

  if (mapLayerPrefs.night) {
    const nightLayer = ensureNightLightsLayer();
    if (nightLayer && !weatherMap.hasLayer(nightLayer)) nightLayer.addTo(weatherMap);
    if (nightLayer) active.push("Night Lights");
  } else if (mapLayers.night && weatherMap.hasLayer(mapLayers.night)) {
    weatherMap.removeLayer(mapLayers.night);
  }

  if (mapLayerPrefs.epa) {
    const epaLayer = ensureEpaLayer();
    if (epaLayer && !weatherMap.hasLayer(epaLayer)) epaLayer.addTo(weatherMap);
    if (epaLayer) active.push("EPA Watch");
  } else if (mapLayers.epa && weatherMap.hasLayer(mapLayers.epa)) {
    weatherMap.removeLayer(mapLayers.epa);
  }

  let note = active.length
    ? `${active.join(", ")} weather layer active.`
    : "Base weather map active.";

  if (mapLayerPrefs.crime) {
    mapLayerPrefs.crime = false;
    saveMapLayerPrefs();
    note = `${note} Experimental overlays are disabled in the simplified weather view.`;
  }

  renderMapLayerButtons();
  setMapLayerStatus(note);
}

function syncWeatherMapPosition(d) {
  const map = ensureWeatherMap();
  const fallback = $("map-fallback");
  if (!map) {
    if (fallback) fallback.style.display = "flex";
    setMapLayerStatus("Map engine unavailable in this browser.");
    return;
  }

  if (!hasLocationFix(d)) {
    if (fallback) fallback.style.display = "flex";
    setMapLayerStatus("Map will appear once the device posts a location fix.");
    return;
  }

  if (fallback) fallback.style.display = "none";
  const lat = num(d.lat);
  const lon = num(d.lon);
  const target = [lat, lon];
  if (weatherMarker) {
    weatherMarker.setLatLng(target);
    weatherMarker.bindTooltip(`${escapeHtml(d.city || "SniffMaster location")}<br>${lat.toFixed(4)}, ${lon.toFixed(4)}`);
  }

  const center = weatherMap.getCenter();
  const drift = Math.abs(center.lat - lat) + Math.abs(center.lng - lon);
  if (drift > 0.04) {
    weatherMap.setView(target, 11);
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
  const lat = Number.isFinite(num(d?.lat, NaN)) ? num(d.lat).toFixed(2) : "na";
  const lon = Number.isFinite(num(d?.lon, NaN)) ? num(d.lon).toFixed(2) : "na";
  const city = `${d?.city || ""}`.trim().toLowerCase();
  const bucket = Math.floor(Date.now() / WEATHER_BRIEFING_TTL_MS);
  return `${lat}|${lon}|${city}|${bucket}`;
}

function defaultWeatherBriefing(d) {
  return {
    mode: "deterministic",
    summary: "Local forecast guidance pending",
    briefing: `${windowCall(d)}. Current outdoor context is ${d.weatherCondition || "still syncing"}, and the dashboard will upgrade this note once a forecast model is available.`,
    forecast: [],
    sourceCaption: "Source: device weather snapshot · local ventilation heuristics · OpenStreetMap map · RainViewer radar",
  };
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
      ? "Model-generated local area brief"
      : "Deterministic local forecast logic";
  }
  if (summaryEl) summaryEl.textContent = payload.summary || "Forecast guidance pending";
  if (sourceEl) {
    sourceEl.textContent = payload.sourceCaption || "Source: device weather snapshot · Open-Meteo forecast · OpenStreetMap map · RainViewer radar";
  }

  if (!gridEl) return;
  const forecast = Array.isArray(payload.forecast) ? payload.forecast.slice(0, 3) : [];
  if (!forecast.length) {
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
}

async function ensureWeatherBriefing(d) {
  if (!d) return;

  const key = weatherBriefingKey(d);
  const cached = weatherBriefingState.data
    && weatherBriefingState.key === key
    && Date.now() - weatherBriefingState.fetchedAt < WEATHER_BRIEFING_TTL_MS;

  if (cached) {
    renderWeatherForecast(d, weatherBriefingState.data);
    return;
  }

  if (weatherBriefingState.pending && weatherBriefingState.key === key) return;

  weatherBriefingState.key = key;
  weatherBriefingState.pending = (async () => {
    try {
      const res = await fetch("/api/weather-briefing", { cache: "no-store" });
      if (res.status === 204) {
        weatherBriefingState.data = defaultWeatherBriefing(d);
      } else if (!res.ok) {
        throw new Error(`weather-briefing ${res.status}`);
      } else {
        weatherBriefingState.data = await res.json();
      }
      weatherBriefingState.fetchedAt = Date.now();
    } catch (_) {
      if (!weatherBriefingState.data) {
        weatherBriefingState.data = defaultWeatherBriefing(d);
      }
    } finally {
      weatherBriefingState.pending = null;
    }

    if (lastData) {
      renderWeatherForecast(lastData, weatherBriefingState.data);
      $("weather-report").innerHTML = renderStructuredReport(buildWeatherReport(lastData, weatherBriefingState.data));
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

function melodyEventTimestamp(d) {
  return derivedEventTimestamp(d, "lastMelodyUptime");
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
    const prevFarts = num(prev.fartCount);
    const currFarts = num(curr.fartCount);
    if (currFarts > prevFarts) {
      const delta = currFarts - prevFarts;
      pushEvent({
        timestamp: curr.receivedAt,
        tag: "Fart Lab",
        tone: delta >= 2 || num(curr.airScore) >= 70 ? "danger" : "warn",
        title: delta > 1 ? `Fart counter jumped by ${delta}` : "Fart counter increased",
        detail: `Now tracking ${Math.round(currFarts)} today. Primary read: ${currentPrimary(curr, "No dominant odor")}.`,
      });
    }

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

  if (current?.paranormalEntity || current?.paranormalReport) {
    const paranormalTs = derivedEventTimestamp(current, "paranormalUptime");
    if (paranormalTs > 0) {
      pushEvent({
        timestamp: paranormalTs,
        tag: "Ghost",
        tone: "neutral",
        title: `${current.paranormalEntity || "Paranormal"} scan cached`,
        detail: current.paranormalReport || "A paranormal report was mirrored from the device.",
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

function fartStatus(d) {
  const signals = fartSignals(d);
  const strongest = Math.max(signals.fart, signals.sulfur, signals.garbage, signals.pet);
  if (num(d.fartCount) > 7 || strongest >= 65) return "Biological incident";
  if (num(d.fartCount) > 2 || strongest >= 45) return "Suspicious activity";
  if (strongest >= 25) return "Possible mischief";
  return "Quiet room";
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

function paranormalBadgeInfo(d) {
  if (d.paranormalEntity || d.paranormalReport) {
    return {
      text: d.paranormalEntity || "Cached scan",
      tone: num(d.airScore) < 40 || hasConfidentPrimary(d) ? "warn" : "neutral",
    };
  }
  return { text: "No scan yet", tone: "neutral" };
}

function paranormalScienceFactors(d) {
  const factors = [];
  const dvoc = num(d.dVoc);
  const voc = num(d.voc);
  const gasR = num(d.gasR);
  const humidity = num(d.humidity);
  const pressure = num(d.pressHpa);
  const airScore = num(d.airScore);

  if (Math.abs(dvoc) >= 0.2) {
    factors.push(`dVOC is ${fmtSigned(dvoc, 2)}, which suggests a recent change in the gas mix rather than a perfectly steady room.`);
  } else {
    factors.push(`dVOC is ${fmtSigned(dvoc, 2)}, so the room looks fairly steady right now instead of showing a sharp fresh spike.`);
  }

  if (voc >= 1.2) {
    factors.push(`VOC is ${voc.toFixed(2)} ppm, which means the air chemistry is active and easier for the theatrical scan to dramatize.`);
  } else {
    factors.push(`VOC is ${voc.toFixed(2)} ppm, which is a relatively light organic-gas load for an indoor room.`);
  }

  if (gasR > 0) {
    if (gasR < 120000) {
      factors.push(`Gas resistance is ${fmtGasR(gasR)}Ω, a lower-reactance band that usually means the sensor is seeing more reactive gases.`);
    } else {
      factors.push(`Gas resistance is ${fmtGasR(gasR)}Ω, which is a calmer band and usually points to cleaner or more stable background air.`);
    }
  }

  if (hasConfidentPrimary(d)) {
    factors.push(`The odor classifier currently leans ${d.primary} at ${Math.round(num(d.primaryConf))}%, so the spooky label is being colored by a real odor channel, not just random text.`);
  } else {
    factors.push(`The odor classifier does not see one dominant smell, so this reads more like diffuse room drift than one obvious source.`);
  }

  factors.push(`Room Quality Index is ${Math.round(airScore)}/100, where lower is better and higher means the total room load is less healthy.`);

  if (humidity >= 65 || humidity <= 35 || pressure <= 1008) {
    factors.push(`Humidity ${Math.round(humidity)}% and pressure ${pressure.toFixed(1)} hPa can also make the room feel strange, stale, or stormy without implying anything supernatural.`);
  } else {
    factors.push(`Humidity ${Math.round(humidity)}% and pressure ${pressure.toFixed(1)} hPa are fairly ordinary, so the current read is being driven more by gas behavior than weather weirdness.`);
  }

  return factors;
}

function paranormalScienceSummary(d) {
  return "Experimental interpretation layer using VOC, dVOC, gas resistance, humidity, pressure, and odor-classifier context to build a themed anomaly readout.";
}

function buildParanormalReport(d) {
  const lines = [];
  const eventTs = derivedEventTimestamp(d, "paranormalUptime");
  const scienceFactors = paranormalScienceFactors(d);

  lines.push("--- DEEP FIELD DIAGNOSTIC ---");
  if (d.paranormalEntity || d.paranormalReport) {
    lines.push(`Manifestation class: ${d.paranormalEntity || "Unknown"}`);
    lines.push(eventTs ? `Last scan: ${fmtStamp(eventTs)} (${fmtAge(eventTs)})` : "Last scan: cached on device");
    lines.push("");
    lines.push(d.paranormalReport || "No readable paranormal report was captured.");
    lines.push("");
    lines.push("--- LIVE CONTEXT ---");
    lines.push(`Room state: ${roomSummary(d)}`);
    lines.push(`Signal stack: IAQ ${Math.round(num(d.iaq))} | VOC ${num(d.voc).toFixed(2)} | GasR ${fmtGasR(d.gasR)}Ω`);
    lines.push(`Current lead: ${currentPrimary(d, "No dominant odor class")}`);
    lines.push("");
    lines.push("--- INTERPRETATION MODEL ---");
    lines.push(paranormalScienceSummary(d));
    scienceFactors.forEach((factor) => lines.push(`- ${factor}`));
    lines.push("");
    lines.push("Run a fresh scan with 5 button presses on the device.");
  } else {
    lines.push("No cached manifestation is available.");
    lines.push("");
    lines.push("Press the device button 5 times to run a new deep-field diagnostic.");
    lines.push("");
    lines.push("--- LIVE CONTEXT ---");
    lines.push(roomSummary(d));
    lines.push(`Current lead: ${currentPrimary(d, "No dominant odor class")}`);
    lines.push(`VOC ${num(d.voc).toFixed(2)} | IAQ ${Math.round(num(d.iaq))} | GasR ${fmtGasR(d.gasR)}Ω`);
    lines.push("");
    lines.push("--- INTERPRETATION MODEL ---");
    lines.push(paranormalScienceSummary(d));
    scienceFactors.forEach((factor) => lines.push(`- ${factor}`));
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

  if (vtrLevel >= 2) return "Straight read: this room is dry, stale, and starting to feel like shared exhaust. Fix the air before people feel it even more.";
  if (cfiPercent < 60) return "Straight read: the room is dragging focus. It is not the team, it is the air.";
  if (bioPeak >= 60) return hasConfidentPrimary(d)
    ? `Straight read: something biological is driving the room right now, and ${primary} is leading the tape.`
    : "Straight read: something biological is driving the room right now, even if the classifier is not calling one clean winner.";
  if (score >= 75) return `Straight read: the room is in rough shape and ${primary} is wearing most of it.`;
  if (score >= 50) return `Straight read: not catastrophic, but the air is working against the room and ${primary} keeps showing up in the tape.`;
  if (score >= 25) return `Straight read: the room is mostly holding form, though ${primary} is still hanging around the edges.`;
  return "Straight read: the room is in a good place. Air is clean, calm, and not asking for attention.";
}

function broPlayCall(d) {
  const bio = fartSignals(d);
  const bioPeak = Math.max(bio.fart, bio.sulfur, bio.garbage, bio.pet);
  const outdoorAqi = num(d.outdoorAqi);
  const co2 = num(d.co2);
  const primary = primaryNarrative(d);
  const vtrLevel = officeVtrLevel(d);
  const cfiPercent = officeCfiPercent(d);

  if (vtrLevel >= 2) return "Next move: bring in fresh air, add filtration if you have it, and stop letting the room marinate in shared exhale.";
  if (cfiPercent < 60) return "Next move: fix the air first. Lower CO2 and the room will feel sharper without touching anything else.";
  if (bioPeak >= 55) return "Next move: crack a window, hit the fan, clear the evidence, and give the room a proper reset.";
  if (co2 >= 1100 && (outdoorAqi === 0 || outdoorAqi <= 80)) return "Next move: CO2 is running hot. Air the place out and let the room breathe for a minute.";
  if (outdoorAqi > 0 && outdoorAqi <= 50 && num(d.airScore) >= 35) return "Next move: outside air is friendlier than inside right now. Open the window and take the easy win.";
  if (hasConfidentPrimary(d) && (primary.includes("laundry") || primary.includes("citrus") || primary.includes("perfume"))) return "Next move: enjoy the clean-air flex, but maybe do not overdo the fragrance victory lap.";
  return "Next move: hold the line, keep an eye on the trend, and see whether the room settles or drifts.";
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

  lines.push("--- QUICK READ ---");
  lines.push(buildBroSummary(d));
  lines.push("");
  if (sniff) {
    lines.push("--- LIVE ALERT ---");
    lines.push(`Priority sulfur post just landed: ${sniff.label} at ${Math.round(num(sniff.vsc_conf))}% (${fmtAge(sniff.receivedAt)}).`);
    lines.push("");
  }
  lines.push("--- ROOM SNAPSHOT ---");
  lines.push(`Primary lead: ${currentPrimary(d, "No dominant odor class")}`);
  lines.push(`Tier: ${smellTierLabel(num(d.tier))} (${num(d.tier)}/5)`);
  lines.push(`Core stats: Score ${Math.round(num(d.airScore))}/100 | IAQ ${Math.round(num(d.iaq))} | VOC ${num(d.voc).toFixed(2)} | dVOC ${fmtSigned(d.dVoc, 2)} | CO2 ${Math.round(num(d.co2))}`);
  lines.push(`Office vitality: Focus ${cfiPercent}% (${officeCfiBand(d)}) | Transmission risk ${vtrLabel}`);
  lines.push(`Bio stack: Fart ${signals.fart}% | Sulfur ${signals.sulfur}% | VSC proxy ${Math.round(vscProxyConfidence(d))}% | Garbage ${signals.garbage}% | Pet ${signals.pet}%`);
  lines.push("");
  lines.push("--- WHAT STANDS OUT ---");
  if (odors.length) {
    lines.push(`Top mix: ${odors.map((odor) => `${odor.name} ${odor.score}%`).join(" | ")}`);
  } else {
    lines.push("Top mix: nothing loud enough to separate from background right now.");
  }
  lines.push(`Calibration state: ${d.calibration || `Accuracy ${num(d.iaqAcc)}/3`}`);
  const melodyTitle = normalizeMelodyTitle(d.lastMelody || "") ? d.lastMelody : "none queued";
  const melodyReason = `${d.lastMelodyReason || ""}`.trim();
  lines.push(`Audio cue: ${melodyTitle}${melodyReason && melodyTitle !== "none queued" ? ` · ${melodyReason}` : ""}`);
  lines.push("");
  lines.push("--- NEXT MOVE ---");
  lines.push(broPlayCall(d));
  return lines.join("\n");
}

function renderDadabase() {
  const current = $("dadabase-current");
  const archive = $("dadabase-archive");
  const count = $("dadabase-count");
  const status = $("dadabase-status");
  const meta = $("dadabase-meta");
  const source = $("source-dadabase");
  const refreshButton = $("dadabase-refresh-btn");
  if (!current || !archive || !count || !status || !meta || !source || !refreshButton) return;

  const payload = dadabaseState.data || dadabaseFallbackPayload();
  const currentEntry = payload.current || dadabaseFallbackPayload().current;
  const entries = buildGroanArchive(payload);
  const hasOwnerKey = Boolean(loadOwnerKey());

  current.textContent = currentEntry.joke || "A fresh daily dad joke will appear here.";
  if (dadabaseState.refreshing) {
    status.textContent = "Generating a fresh Dadabase entry for today...";
  } else if (dadabaseState.notice) {
    status.textContent = dadabaseState.notice;
  } else if (dadabaseState.data) {
    status.textContent = `Daily joke ready for ${currentEntry.dateLabel || dailyJokeDateLabel(new Date())}.`;
  } else {
    status.textContent = "Using the built-in Dadabase classics while the daily generator warms up.";
  }

  const generatedAt = num(currentEntry.generatedAt, NaN);
  meta.textContent = [
    dadabaseModeLabel(currentEntry.mode),
    Number.isFinite(generatedAt) ? fmtStamp(generatedAt) : (currentEntry.dateLabel || dailyJokeDateLabel(new Date())),
    hasOwnerKey ? "Refresh enabled in this tab" : "Unlock System page to force a new one",
  ].join(" · ");

  source.textContent = payload.sourceCaption || "Source: local Dadabase classics baked into the portal shell";
  count.textContent = dadabaseQuery.trim()
    ? `${entries.length} Dadabase matches`
    : `${entries.length} Dadabase archive entries`;
  refreshButton.disabled = dadabaseState.refreshing;
  refreshButton.textContent = dadabaseState.refreshing ? "Generating..." : "Refresh Joke";
  setHeaderPill(
    "dadabase-badge",
    dadabaseState.refreshing
      ? "Generating"
      : currentEntry.mode === "openai"
        ? "AI daily joke"
        : currentEntry.mode === "fallback"
          ? "Daily fallback"
          : "Classic daily joke",
    currentEntry.mode === "openai" ? "good" : "neutral"
  );

  if (!entries.length) {
    archive.innerHTML = `<div class="archive-empty">${dadabaseQuery.trim()
      ? "No Dadabase entries match this search. Try a broader keyword or clear the filter."
      : "The Dadabase archive is standing by. Fresh generated jokes and classics will appear here."}</div>`;
    return;
  }

  archive.innerHTML = entries.map((entry) => `
    <article class="archive-row${entry.generated ? " is-generated" : ""}">
      <div class="archive-meta">
        <span>${escapeHtml(entry.label)}</span>
        <span>${escapeHtml(entry.meta)}</span>
      </div>
      <div class="archive-text">${escapeHtml(entry.text)}</div>
    </article>
  `).join("");
}

async function ensureDadabase(forceRefresh = false) {
  if (forceRefresh && !loadOwnerKey()) {
    dadabaseState.notice = "Unlock remote actions on the System page to refresh the daily joke.";
    renderDadabase();
    return dadabaseState.data || dadabaseFallbackPayload();
  }

  if (!forceRefresh && dadabaseState.data && Date.now() - dadabaseState.fetchedAt < DADABASE_TTL_MS) {
    return dadabaseState.data;
  }

  if (dadabaseState.pending) return dadabaseState.pending;

  dadabaseState.refreshing = forceRefresh;
  if (forceRefresh) dadabaseState.notice = "Generating a fresh Dadabase entry...";
  renderDadabase();

  dadabaseState.pending = (async () => {
    try {
      const ownerKey = loadOwnerKey();
      const res = await fetch("/api/dad-joke", {
        method: forceRefresh ? "POST" : "GET",
        cache: "no-store",
        headers: forceRefresh ? {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ownerKey}`,
        } : undefined,
        body: forceRefresh ? "{}" : undefined,
      });

      if (res.status === 401) {
        clearOwnerKey();
        syncRemoteControlsUi();
        dadabaseState.notice = "Owner key rejected. Unlock System again to refresh the joke.";
        return dadabaseState.data || dadabaseFallbackPayload();
      }

      if (!res.ok) throw new Error(`dadabase ${res.status}`);

      dadabaseState.data = await res.json();
      dadabaseState.fetchedAt = Date.now();
      dadabaseState.notice = forceRefresh ? "Fresh Dadabase entry generated." : "";
      return dadabaseState.data;
    } catch (_) {
      if (!dadabaseState.data) dadabaseState.data = dadabaseFallbackPayload();
      dadabaseState.notice = forceRefresh
        ? "Dad joke refresh failed. Keeping the current entry."
        : "Using the local Dadabase fallback while the server-side joke engine is unavailable.";
      return dadabaseState.data;
    } finally {
      dadabaseState.refreshing = false;
      dadabaseState.pending = null;
      renderDadabase();
    }
  })();

  return dadabaseState.pending;
}

function renderMissionHistory(d) {
  const title = $("mission-history-title");
  const context = $("mission-history-context");
  const date = $("mission-history-date");
  const list = $("mission-history-list");
  if (!title || !context || !date || !list) return;

  const entries = daybookEntriesForSnapshot(d);
  date.textContent = `Space Coast daybook · ${snapshotMonthDayLabel(d)}`;
  if (!entries.length) {
    title.textContent = "No Space Coast history entry is loaded for this date yet.";
    context.textContent = "The dashboard will fall back to the live device feed once a history note is available.";
    list.innerHTML = '<div class="history-empty">No additional milestones are listed right now.</div>';
    setHeaderPill("history-badge", "No entry", "neutral");
    return;
  }

  title.textContent = `${entries[0].year} · ${entries[0].title}`;
  context.textContent = entries[0].detail;
  list.innerHTML = entries.map((entry) => `
    <article class="history-row">
      <div class="history-year">${entry.year}</div>
      <div>
        <div class="history-row-title">${entry.title}</div>
        <div class="history-row-detail">${entry.detail}</div>
      </div>
    </article>
  `).join("");
  setHeaderPill("history-badge", `${entries.length} milestones`, "good");
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
  $("intel-copy").textContent = `Use this panel for short definitions. Direct signals describe the air itself; derived metrics and classifier channels describe how the system interprets it.`;
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
  $("hero-subtitle").textContent = "Real-time odor intelligence from a BME688-based sensor stack.";
  $("hero-tier").textContent = `${smellTierLabel(num(d.tier))} · Tier ${num(d.tier)}/5`;
  $("hero-trends").textContent = `IAQ ${d.iaqTrend || "steady"} | VOC ${d.vocTrend || "steady"}`;
  $("hero-brief-title").textContent = `${briefLead} · ${Math.round(score)}/100 room index`;
  $("hero-brief-primary").textContent = currentPrimary(d, "No dominant odor");
  $("hero-brief-next").textContent = `${windowCall(d)} ${briefTone}`.trim();
  $("hero-brief-status").textContent = statusBits.join(" · ");
  const melodyTagReason = `${d.lastMelodyReason || ""}`.trim();
  const melodyTitle = `${d.lastMelody || ""}`.trim();
  $("hero-melody").textContent = normalizeMelodyTitle(melodyTitle)
    ? `Melody: ${melodyTitle}${melodyTagReason ? ` · ${melodyTagReason}` : ""}`
    : "Melody: none yet";

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
  $("header-presence").textContent = headerPresenceText(d);
}

function renderTelemetry(d) {
  $("v-temp").textContent = `${num(d.tempF).toFixed(1)}F`;
  $("v-hum").textContent = `${num(d.humidity).toFixed(0)}%`;
  $("v-press").textContent = `${num(d.pressHpa).toFixed(1)} hPa`;
  $("v-gasr-raw").textContent = `${fmtGasR(d.gasR)}Ω`;
  $("v-compgas").textContent = `${fmtGasR(d.compGas)}Ω`;
  $("v-gaspct").textContent = `${num(d.gasPct).toFixed(1)}%`;
  $("v-local-time-card").textContent = fmtLocationTime(d.receivedAt, d.utcOffsetSec);
  $("v-uptime-card").textContent = fmtUptime(d.uptime).replace(/^Up /, "");
  $("header-network").textContent = headerNetworkText(d);
  $("header-city").textContent = d.city || "Location syncing";
  $("header-weather").textContent = d.weatherCondition
    ? `${d.weatherCondition} · ${num(d.tempF).toFixed(0)}F`
    : "Weather pending";
  $("header-time").textContent = fmtLocationTime(d.receivedAt, d.utcOffsetSec);
  $("header-date").textContent = fmtLocationDate(d.receivedAt, d.utcOffsetSec);
  $("city-pill").textContent = d.city || "Sensor stream";
}

function renderDerivedMetrics(d) {
  $("derived-iaq").textContent = `${Math.round(num(d.iaq))}`;
  $("derived-voc").textContent = `${num(d.voc).toFixed(2)} ppm`;
  $("derived-co2").textContent = `${Math.round(num(d.co2))}`;
  $("derived-room").textContent = `${Math.round(num(d.airScore))}/100`;
  $("derived-dvoc").textContent = fmtSigned(d.dVoc, 2);
  $("derived-aqi").textContent = num(d.outdoorAqi) > 0 ? `${Math.round(num(d.outdoorAqi))}` : "--";
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
  $("office-context").textContent = `${windowCall(d)} Humidity is ${humidity.toFixed(0)}%, so the room is tracking as ${vtrLabel.toLowerCase()}.`;

  const attention = officeAttentionState(d);
  const comfort = officeComfortState(d);
  const collab = officeCollaborationState(d);
  const odor = officeOdorState(d);
  $("office-attention-title").textContent = attention.title;
  $("office-attention-note").textContent = attention.note;
  $("office-comfort-title").textContent = comfort.title;
  $("office-comfort-note").textContent = comfort.note;
  $("office-collab-title").textContent = collab.title;
  $("office-collab-note").textContent = collab.note;
  $("office-odor-title").textContent = odor.title;
  $("office-odor-note").textContent = odor.note;
  $("office-briefing").textContent = officeBriefing(d);

  const officeTone = vtrLevel >= 2 ? "danger" : cfiPercent < 60 || vtrLevel === 1 ? "warn" : "good";
  const officeBadgeText = vtrLevel >= 2
    ? `${vtrLabel} · Focus ${cfiPercent}%`
    : `Focus ${cfiPercent}% · ${vtrLabel}`;
  setHeaderPill("office-badge", officeBadgeText, officeTone);
}

function renderStankGauge(d) {
  const conf = vscProxyConfidence(d);
  const event = activeSniffEvent();
  const fill = $("stank-fill");
  const value = $("stank-value");
  const label = $("stank-label");
  const time = $("stank-time");
  const caption = $("stank-caption");
  const tone = sniffTone(conf);
  const color = stankColor(conf);

  fill.style.width = conf > 0 ? `${Math.max(6, conf)}%` : "0%";
  fill.style.background = `linear-gradient(90deg, #5df1a4 0%, ${color} 100%)`;
  fill.style.boxShadow = conf >= 70
    ? "0 0 22px rgba(216, 239, 114, 0.36)"
    : "0 0 14px rgba(93, 241, 164, 0.18)";
  value.textContent = `${Math.round(conf)}%`;
  value.style.color = color;

  if (event) {
    label.textContent = `${event.label} priority event`;
    time.textContent = `${fmtAge(event.receivedAt)} · IAQ ${Math.round(num(event.iaq))}`;
    caption.textContent = `The device escalated this sulfur/VSC proxy event immediately instead of waiting for the normal snapshot timer.`;
  } else {
    label.textContent = tone.label;
    time.textContent = "Waiting for a priority sulfur event";
    caption.textContent = conf >= 40
      ? "Sulfur activity is visible in the main snapshot, but no fresh priority event has been posted yet."
      : "This tracks the sulfur/VSC proxy channel and jumps live when the device posts a high-sulfur event.";
  }
}

function renderFartCard(d) {
  const signals = fartSignals(d);
  const vsc = vscProxyConfidence(d);
  $("fart-count").textContent = `${Math.round(num(d.fartCount))}`;
  $("fart-status").textContent = fartStatus(d);
  $("fart-sub").textContent = `Primary class: ${currentPrimary(d, "No dominant odor")}. dVOC is ${fmtSigned(d.dVoc, 2)} and room quality is ${Math.round(num(d.airScore))}/100.`;
  $("fart-score").textContent = `${signals.fart}%`;
  $("fart-sulfur").textContent = `${signals.sulfur}%`;
  $("fart-garbage").textContent = `${signals.garbage}%`;
  $("fart-pet").textContent = `${signals.pet}%`;
  renderStankGauge(d);
  setHeaderPill(
    "fart-badge",
    vsc >= 70 ? "Priority odor event" : "Stank score",
    vsc >= 70 || signals.fart >= 45 || signals.sulfur >= 45 ? "danger" : signals.fart >= 20 || vsc >= 40 ? "warn" : "good"
  );
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
  $("weather-report").innerHTML = renderStructuredReport(buildWeatherReport(d, weatherBriefingState.data));
  renderMoonVisual(d);
  renderSkyVisual(d);
  syncWeatherMapPosition(d);
  if (hasLocationFix(d)) {
    syncMapLayers();
  }
}

function gasPhaseAxis(d) {
  const voc = Math.max(0, num(d.voc));
  const dVoc = Math.abs(num(d.dVoc));
  const sulfur = vscProxyConfidence(d) / 100;
  const value = clamp((voc / 4.0) * 0.55 + clamp(dVoc / 1.2, 0, 1) * 0.25 + sulfur * 0.2, 0, 1);
  let label = "Calm";
  if (value >= 0.75) label = "Gas surge";
  else if (value >= 0.5) label = "Active";
  else if (value >= 0.25) label = "Light load";
  return {
    key: "gas",
    name: "VOC",
    label,
    value,
    detail: `${Math.round(value * 100)}% · ${voc.toFixed(2)} ppm`,
    standby: false,
  };
}

function presencePhaseAxis(d) {
  const state = `${d.blePresenceState || ""}`.trim();
  const explicitConf = num(d.blePresenceConf, NaN);
  const rssi = num(d.bleTargetRssi, NaN);
  const enabled = d.blePresenceEnabled === true
    || Number.isFinite(explicitConf)
    || state
    || Number.isFinite(rssi);

  if (!enabled) {
    return {
      key: "presence",
      name: "RSSI",
      label: "No BLE feed",
      value: 0.06,
      detail: "Standby",
      standby: true,
    };
  }

  let value = Number.isFinite(explicitConf) ? clamp(explicitConf / 100, 0, 1) : 0.18;
  if (!Number.isFinite(explicitConf)) {
    if (/very/i.test(state)) value = 0.82;
    else if (/near/i.test(state)) value = 0.58;
    else if (/far/i.test(state)) value = 0.18;
  }

  const label = state || (Number.isFinite(rssi) ? `RSSI ${Math.round(rssi)} dBm` : "Presence sync");
  return {
    key: "presence",
    name: "RSSI",
    label,
    value,
    detail: `${Math.round(value * 100)}% · ${Number.isFinite(rssi) ? `${Math.round(rssi)} dBm` : "confidence"}`,
    standby: false,
  };
}

function emfPhaseAxis(d) {
  const surgeMv = num(d.emfSurgeMv, NaN);
  const ionicFlag = Boolean(d.ionicSurgeDetected);
  if (Number.isFinite(surgeMv) || ionicFlag) {
    const value = clamp(Math.max(ionicFlag ? 0.75 : 0, Number.isFinite(surgeMv) ? surgeMv / 300 : 0), 0, 1);
    return {
      key: "emf",
      name: "EMF",
      label: ionicFlag ? "Ionic surge" : "Static active",
      value,
      detail: `${Math.round(value * 100)}% · ${Number.isFinite(surgeMv) ? `${Math.round(surgeMv)} mV` : "flagged"}`,
      standby: false,
    };
  }

  return {
    key: "emf",
    name: "EMF",
    label: "Probe standby",
    value: 0.08,
    detail: "No probe",
    standby: true,
  };
}

function pressurePhaseAxis(d, history) {
  const current = num(d.pressHpa, NaN);
  if (!Number.isFinite(current)) {
    return {
      key: "pressure",
      name: "Pa",
      label: "No pressure feed",
      value: 0.06,
      detail: "Standby",
      standby: true,
    };
  }

  const recent = [d, ...(history || []).slice(0, 6)]
    .map((item) => num(item?.pressHpa, NaN))
    .filter((item) => Number.isFinite(item));
  const baselinePool = recent.slice(1);
  const baseline = baselinePool.length
    ? baselinePool.reduce((sum, item) => sum + item, 0) / baselinePool.length
    : current;
  const prev = recent.length > 1 ? recent[1] : current;
  const delta = Math.abs(current - baseline);
  const rate = Math.abs(current - prev);
  const value = clamp((delta / 6.0) * 0.65 + (rate / 2.5) * 0.35, 0, 1);

  let label = "Calm";
  if (value >= 0.7) label = "Disturbed";
  else if (value >= 0.42) label = "Shifted";
  else if (value >= 0.22) label = "Light drift";

  return {
    key: "pressure",
    name: "Pa",
    label,
    value,
    detail: `${Math.round(value * 100)}% · ${current.toFixed(1)} hPa`,
    standby: false,
  };
}

function phaseCorrelationAxes(d, history) {
  return [
    gasPhaseAxis(d),
    presencePhaseAxis(d),
    emfPhaseAxis(d),
    pressurePhaseAxis(d, history),
  ];
}

function phaseCorrelationNarrative(d, axes) {
  const average = axes.reduce((sum, axis) => sum + axis.value, 0) / Math.max(axes.length, 1);
  const maxAxis = axes.reduce((best, axis) => axis.value > best.value ? axis : best, axes[0]);
  const gas = axes.find((axis) => axis.key === "gas") || axes[0];
  const presence = axes.find((axis) => axis.key === "presence") || axes[0];
  const pressure = axes.find((axis) => axis.key === "pressure") || axes[0];
  const emf = axes.find((axis) => axis.key === "emf") || axes[0];

  let title = "Tight room signature";
  let note = "Small, compact polygons mean the room is steady across gas load, presence, and pressure. That is the healthy shape.";

  if (gas.value >= 0.58 && officeVtrLevel(d) >= 1) {
    title = "Bio-load stretch";
    note = "Gas activity is stretching the polygon harder than the other axes, which looks more like an air-quality or biosecurity issue than a quiet baseline room.";
  } else if (gas.value >= 0.55 && presence.value >= 0.55 && pressure.value >= 0.35) {
    title = "Convergent disturbance";
    note = "Gas, presence, and pressure are all active together, so the room signature is widening into a genuinely distorted shape instead of one isolated spike.";
  } else if (presence.value >= 0.62 && gas.value < 0.45) {
    title = "Occupancy-led distortion";
    note = "The shape is leaning toward the RSSI/presence axis, which usually means someone is close but the gas channel has not fully reacted yet.";
  } else if (pressure.value >= 0.55 && gas.value < 0.45) {
    title = "Pressure-led shift";
    note = "The pressure axis is carrying the shape more than the gas channels, so this looks like environmental drift or a weather/room-pressure change.";
  } else if (average >= 0.46 || maxAxis.value >= 0.72) {
    title = `${maxAxis.name}-weighted distortion`;
    note = `The polygon is no longer compact. ${maxAxis.name} is the strongest axis right now, so that channel is driving the current room signature.`;
  }

  if (emf.standby) {
    note = `${note} The EMF/static axis is still in standby until a physical probe is wired into the device.`;
  }

  return { title, note, average };
}

function drawPhaseCorrelation(d, history) {
  const canvas = $("phase-correlation-canvas");
  if (!canvas) return;

  const axes = phaseCorrelationAxes(d, history);
  const narrative = phaseCorrelationNarrative(d, axes);
  const titleEl = $("phase-title");
  const noteEl = $("phase-note");
  const gasEl = $("phase-axis-gas");
  const presenceEl = $("phase-axis-presence");
  const emfEl = $("phase-axis-emf");
  const pressureEl = $("phase-axis-pressure");

  if (titleEl) titleEl.textContent = narrative.title;
  if (noteEl) noteEl.textContent = narrative.note;
  if (gasEl) gasEl.textContent = axes[0].detail;
  if (presenceEl) presenceEl.textContent = axes[1].detail;
  if (emfEl) emfEl.textContent = axes[2].standby ? "Standby · no probe" : axes[2].detail;
  if (pressureEl) pressureEl.textContent = axes[3].detail;

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 280;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const cx = width * 0.5;
  const cy = height * 0.5;
  const radius = Math.min(width, height) * 0.34;
  const levels = 4;
  const axisAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
  const severity = Math.max(narrative.average, ...axes.map((axis) => axis.value));
  const stroke = severity >= 0.72 ? "#ff8e58" : severity >= 0.45 ? "#ffd25c" : "#6bccff";
  const fill = severity >= 0.72 ? "rgba(255, 142, 88, 0.18)" : severity >= 0.45 ? "rgba(255, 210, 92, 0.16)" : "rgba(107, 204, 255, 0.16)";

  ctx.fillStyle = "rgba(4, 10, 18, 0.86)";
  ctx.fillRect(0, 0, width, height);

  for (let level = 1; level <= levels; level += 1) {
    const r = radius * (level / levels);
    ctx.beginPath();
    axisAngles.forEach((angle, index) => {
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = `rgba(109, 204, 255, ${0.08 + level * 0.04})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  axisAngles.forEach((angle, index) => {
    const axis = axes[index];
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    ctx.save();
    if (axis.standby) ctx.setLineDash([4, 4]);
    ctx.strokeStyle = axis.standby ? "rgba(171, 181, 193, 0.24)" : "rgba(109, 204, 255, 0.2)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();

    const labelX = cx + Math.cos(angle) * (radius + 22);
    const labelY = cy + Math.sin(angle) * (radius + 22);
    ctx.fillStyle = axis.standby ? "rgba(188, 199, 216, 0.52)" : "rgba(188, 199, 216, 0.84)";
    ctx.font = "11px JetBrains Mono, monospace";
    ctx.textAlign = Math.abs(Math.cos(angle)) < 0.2 ? "center" : (Math.cos(angle) > 0 ? "left" : "right");
    ctx.fillText(axis.name, labelX, labelY);
  });

  ctx.beginPath();
  axes.forEach((axis, index) => {
    const angle = axisAngles[index];
    const x = cx + Math.cos(angle) * radius * clamp(axis.value, 0, 1);
    const y = cy + Math.sin(angle) * radius * clamp(axis.value, 0, 1);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();

  axes.forEach((axis, index) => {
    const angle = axisAngles[index];
    const x = cx + Math.cos(angle) * radius * clamp(axis.value, 0, 1);
    const y = cy + Math.sin(angle) * radius * clamp(axis.value, 0, 1);
    ctx.beginPath();
    ctx.arc(x, y, axis.standby ? 3 : 4, 0, Math.PI * 2);
    ctx.fillStyle = axis.standby ? "rgba(188, 199, 216, 0.6)" : stroke;
    ctx.fill();
  });

  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(93, 241, 164, 0.95)";
  ctx.fill();
}

function renderParanormal(d) {
  const signal = paranormalSignal(d);
  const radar = $("ghost-radar");
  const value = $("ghost-signal-value");
  const fill = $("ghost-signal-fill");
  const note = $("ghost-signal-note");
  const blipA = $("ghost-blip-a");
  const blipB = $("ghost-blip-b");

  if (radar && value && fill && note && blipA && blipB) {
    const seed = hashString(`${d.paranormalEntity || "static"}|${d.paranormalReport || ""}`);
    const strength = signal.strength;
    const placeBlip = (el, angleDeg, radiusPct, opacity, hue) => {
      const angle = angleDeg * Math.PI / 180;
      const cx = 50 + Math.cos(angle) * radiusPct;
      const cy = 50 + Math.sin(angle) * radiusPct;
      el.style.left = `calc(${cx}% - ${el.classList.contains("ghost-blip-b") ? 4 : 6}px)`;
      el.style.top = `calc(${cy}% - ${el.classList.contains("ghost-blip-b") ? 4 : 6}px)`;
      el.style.opacity = opacity;
      el.style.background = hue;
      el.style.boxShadow = `0 0 14px ${hue}`;
    };

    const hue = signal.tone === "danger"
      ? "rgba(255, 111, 112, 0.95)"
      : signal.tone === "warn"
        ? "rgba(255, 210, 92, 0.95)"
        : "rgba(109, 204, 255, 0.85)";
    placeBlip(blipA, seed % 360, 18 + (seed % 16), strength > 18 ? 0.95 : 0.18, hue);
    placeBlip(blipB, (seed % 360) + 110, 10 + (seed % 22), strength > 42 ? 0.75 : 0.08, hue);
    radar.style.boxShadow = signal.tone === "danger"
      ? "inset 0 0 0 1px rgba(255,111,112,0.18), 0 18px 40px rgba(5, 8, 18, 0.28)"
      : signal.tone === "warn"
        ? "inset 0 0 0 1px rgba(255,210,92,0.16), 0 18px 40px rgba(5, 8, 18, 0.28)"
        : "inset 0 0 0 1px rgba(109,204,255,0.14), 0 18px 40px rgba(5, 8, 18, 0.28)";
    value.textContent = `${signal.title} · ${Math.round(strength)}%`;
    fill.style.width = `${strength}%`;
    fill.style.background = signal.tone === "danger"
      ? "linear-gradient(90deg, #ff6f70, #9d82ff)"
      : signal.tone === "warn"
        ? "linear-gradient(90deg, #ffd25c, #9d82ff)"
        : "linear-gradient(90deg, #6bccff, #9d82ff)";
    note.textContent = signal.note;
  }

  $("paranormal-report").innerHTML = formatDiagnosticReport(buildParanormalReport(d));
  drawPhaseCorrelation(d, historyData);
  const badge = paranormalBadgeInfo(d);
  setHeaderPill("paranormal-badge", badge.text, badge.tone);
}

function renderLaunchDeck(d) {
  const shell = $("launch-stack");
  if (!shell) return;

  const launches = Array.isArray(d.launches) ? d.launches.slice(0, 3) : [];
  if (!launches.length) {
    shell.innerHTML = '<div class="launch-empty">No KSC/CCSFS launches are in the current snapshot.</div>';
    return;
  }

  shell.innerHTML = launches.map((launch, index) => `
    <article class="launch-card">
      <div class="launch-kicker">Cape Slot ${index + 1}</div>
      <div class="launch-name">${launch.name || "Unknown mission"}</div>
      <div class="launch-line"><strong>NET:</strong> ${launch.time || "TBD"}</div>
      <div class="launch-line"><strong>Status:</strong> ${launch.status || "--"}</div>
      <div class="launch-line"><strong>Provider:</strong> ${launch.provider || "Unknown"}</div>
      <div class="launch-line"><strong>Pad:</strong> ${launch.pad || "Cape pad TBD"}</div>
      <div class="launch-line"><strong>Type:</strong> ${launch.missionType || "Mission"}</div>
    </article>
  `).join("");
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

function drawChart(history) {
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

function render(data) {
  if (!data) return;
  const merged = mergeSnapshotWithSniff(data);
  lastData = merged;

  const age = Date.now() - num(merged.receivedAt, 0);
  const isLive = age < STALE_MS;
  $("conn-dot").className = `dot ${isLive ? "online" : "stale"}`;
  $("conn-label").textContent = num(merged.receivedAt) ? (isLive ? "Live feed" : `Stale · ${fmtAge(merged.receivedAt)}`) : "Waiting for feed";

  renderHero(merged);
  drawHeroScope(merged, historyData);
  renderStatusStrip(merged);
  renderOfficeCard(merged);
  renderTelemetry(merged);
  renderDerivedMetrics(merged);
  renderFartCard(merged);
  renderBreathCard(merged);
  renderDadabase();
  renderMissionHistory(merged);
  renderSpaceCard(merged);
  renderOdorCard(merged);
  renderWeatherIntel(merged);
  renderWeatherForecast(merged, weatherBriefingState.data);
  renderIntelDrawer(merged);
  renderParanormal(merged);
  renderLaunchDeck(merged);
  renderEventLog(merged);
  renderOdorMatrix(merged.odors || [], hasConfidentPrimary(merged) ? merged.primary : "");
  renderMelodyControls(merged);
  renderMelodyLibrary(merged);

  $("bro-summary").textContent = buildBroSummary(merged);
  $("bro-report").innerHTML = renderStructuredReport(buildBroReport(merged));

  setHeaderPill("launch-badge", Array.isArray(merged.launches) && merged.launches.length ? `${merged.launches.length} Cape launches` : "No launch data", Array.isArray(merged.launches) && merged.launches.length ? "good" : "neutral");
  setHeaderPill("odor-badge", `${currentPrimary(merged)} · ${Math.round(num(merged.primaryConf))}%`, num(merged.primaryConf) >= 45 ? "warn" : num(merged.primaryConf) >= 20 ? "neutral" : "good");
  setHeaderPill("matrix-badge", `${Math.round(num(merged.primaryConf))}% confidence`, num(merged.primaryConf) >= 45 ? "warn" : num(merged.primaryConf) >= 20 ? "neutral" : "good");
  setHeaderPill(
    "weather-intel-badge",
    hasLocationFix(merged) ? (merged.weatherCondition || "Map live") : "No map fix",
    outdoorSeverity(merged) >= 3 ? "danger" : outdoorSeverity(merged) >= 2 ? "warn" : hasLocationFix(merged) ? "good" : "neutral"
  );
  const broBadge = broBadgeInfo(merged);
  setHeaderPill("bro-badge", broBadge.text, broBadge.tone);

  $("last-update").textContent = num(merged.receivedAt) ? `Updated ${fmtAge(merged.receivedAt)} · ${fmtStamp(merged.receivedAt)}` : "No data yet";
  $("v-uptime").textContent = fmtUptime(merged.uptime);

  ensureWeatherBriefing(merged);

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
    const res = await fetch("/api/latest", { cache: "no-store" });
    if (res.status === 204) return;
    if (!res.ok) throw new Error(`latest ${res.status}`);
    const data = await res.json();
    render(data);
  } catch (_) {
    $("conn-dot").className = "dot offline";
    $("conn-label").textContent = "Feed unavailable";
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
      ensureDadabase(false),
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
    pill.textContent = tone === "good" ? "Unlocked" : tone === "warn" ? "Busy" : "Locked";
    pill.dataset.tone = tone;
  }
}

function syncRemoteControlsUi(options = {}) {
  const preserveStatus = Boolean(options.preserveStatus);
  const unlocked = Boolean(loadOwnerKey());
  const input = $("remote-owner-key");
  if (input) input.value = "";
  document.querySelectorAll(".remote-action-btn").forEach((button) => {
    button.disabled = !unlocked || remoteCommandPending;
  });
  if (preserveStatus) return;
  if (unlocked) {
    setRemoteControlsState(
      remoteCommandPending
        ? "Remote control unlocked. Waiting for the current action to finish queuing."
        : "Remote control unlocked for this tab. Actions are queued securely through the relay.",
      remoteCommandPending ? "warn" : "good"
    );
  } else {
    setRemoteControlsState(
      "Locked. View access is public, but remote device actions require the owner key for this tab.",
      "neutral"
    );
  }
  renderMelodyLibrary(lastData);
}

async function queueRemoteAction(action, extra = {}) {
  const ownerKey = loadOwnerKey();
  if (!ownerKey) {
    setRemoteControlsState("Enter the owner key first, then queue a device action from here.", "neutral");
    syncRemoteControlsUi();
    return;
  }

  remoteCommandPending = true;
  syncRemoteControlsUi();
  setRemoteControlsState("Queueing remote device action...", "warn");

  try {
    const res = await fetch("/api/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ownerKey}`,
      },
      body: JSON.stringify({ action, ...extra }),
    });

    if (res.status === 401) {
      clearOwnerKey();
      setRemoteControlsState("Owner key rejected. Unlock again with the correct key for this tab.", "neutral");
      syncRemoteControlsUi({ preserveStatus: true });
      return;
    }

    if (!res.ok) {
      throw new Error(`command ${res.status}`);
    }

    const data = await res.json();
    const labels = {
      refresh: "Device sync queued",
      breath_check: "Breath check queued",
      ghost_scan: "Ghost scan queued",
      presence_probe: "Presence probe queued",
      play_melody: "Melody queued",
    };
    const detail = action === "play_melody" && extra?.melodyKey
      ? ` ${String(extra.melodyKey).replaceAll("_", " ")}`
      : "";
    setRemoteControlsState(`${labels[action] || "Action queued"}${detail}. Device will pick it up on its next command poll.`, "good");

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
    if (nextView === "labs") {
      ensureDadabase(false);
    }
    if (nextView === "environment" && weatherMap) {
      weatherMap.invalidateSize();
      if (lastData) syncWeatherMapPosition(lastData);
    }
    if (nextView === "history" && historyData.length) {
      drawChart(historyData);
      updateHistoryStats(historyData);
    }
  });
}

const trajectoryArcade = (() => {
  // ═══════════════════════════════════════════════════════════════
  // TRAJECTORY — New Glenn Lunar Lander
  // FTL-inspired pixel art game · LC-36 Cape Canaveral
  // Controls: HOLD thrust, TAP space to detach, LEFT/RIGHT to steer
  // ═══════════════════════════════════════════════════════════════

  const SECRET_SEQUENCE = [
    "arrowup", "arrowup", "arrowdown", "arrowdown",
    "arrowleft", "arrowright", "arrowleft", "arrowright",
    "b", "a"
  ];

  const STATE = {
    START_SCREEN: "start",
    PLAYING: "playing",
    SUCCESS: "success",
    GAME_OVER: "gameover",
  };

  const PHASE = {
    LAUNCH: 1,
    SEPARATION: 2,
    ORBIT: 3,
    TRANSIT: 4,
    LUNAR: 5,
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
  const input = { up: false, left: false, right: false, detachPressed: false };
  const touchPointers = new Map();
  const runtime = {
    mode: STATE.START_SCREEN,
    phase: PHASE.LAUNCH,
    stageDetached: false,
    open: false,
    lastTs: 0,
    rafId: 0,
    width: 960,
    height: 640,
    camX: 0,
    cameraY: 0,
    zoom: 0.82,
    boosterTimer: 0,
    unlockBuffer: [],
    themeTapCount: 0,
    themeTapTs: 0,
    message: "Hold thrust to build momentum, then separate cleanly.",
    statusLine: "Secret flight deck ready.",
    stars: [],
    particles: [],
    ship: null,
    booster: null,
    lasers: [],
    gators: [],
    laserCooldown: 0,
    gatorsKilled: 0,
    gatorsTotal: 0,
    trail: [],          // breadcrumb positions for trajectory line
    trailTimer: 0,
    deltaV: 0,          // total delta-v expended (m/s)
    periapsis: 0,       // closest approach to Earth (km)
    apoapsis: 0,        // farthest point from Earth (km)
    shake: 0,
    flash: 0,
    bestKills: 0,
    bestLandingSpeed: null,
    moonReached: false,
    hull: 3,
    maxHull: 3,
    score: 0,
    combo: 1,
    comboTimer: 0,
    wave: 1,
    damageCooldown: 0,
    objective: "Launch clean, separate on time, and build a stable transfer.",
  };

  // ── Orbital constants (scaled for gameplay) ──
  // Real New Glenn / Artemis 2 values scaled to game units
  // 1 game unit ≈ 25 km for orbital display
  const EARTH_RADIUS = 255;       // ~6,371 km
  const MOON_DIST = 1540;         // ~384,400 km from Earth center
  const MOON_RADIUS = 70;         // ~1,737 km
  const EARTH_GM = 28000;         // gravitational parameter (scaled)
  const MOON_GM = 340;            // Moon GM (1/81 of Earth)
  const EARTH_CENTER = { x: 0, y: 0 };
  const MOON_CENTER = { x: 0, y: MOON_DIST };
  const GATOR_BEST_KEY = "gatornauts-best-run";

  function palette() {
    const styles = getComputedStyle(document.body);
    return {
      bg: styles.getPropertyValue("--bg").trim() || "#050505",
      cyan: styles.getPropertyValue("--cobalt").trim() || "#00f2ff",
      magenta: styles.getPropertyValue("--violet").trim() || "#ff4ea6",
      lime: styles.getPropertyValue("--mint").trim() || "#39ff14",
      amber: styles.getPropertyValue("--amber").trim() || "#f1c40f",
      orange: styles.getPropertyValue("--orange").trim() || "#ff9958",
      red: styles.getPropertyValue("--red").trim() || "#e74c3c",
      text: styles.getPropertyValue("--text").trim() || "#eafcff",
      muted: styles.getPropertyValue("--muted").trim() || "#7a91a3",
      panel: styles.getPropertyValue("--panel").trim() || "rgba(8, 12, 18, 0.88)",
    };
  }

  // ── Pixel-art rendering mode ──
  function pixelMode(on) {
    ctx.imageSmoothingEnabled = !on;
    ctx.mozImageSmoothingEnabled = !on;
    ctx.webkitImageSmoothingEnabled = !on;
  }

  function withAlpha(hex, alpha) {
    const safe = clamp(alpha, 0, 1);
    const raw = `${hex || ""}`.trim();
    const short = raw.match(/^#([0-9a-f]{3})$/i);
    if (short) {
      const [r, g, b] = short[1].split("").map((c) => parseInt(c + c, 16));
      return `rgba(${r}, ${g}, ${b}, ${safe})`;
    }
    const full = raw.match(/^#([0-9a-f]{6})$/i);
    if (full) {
      const value = full[1];
      const r = parseInt(value.slice(0, 2), 16);
      const g = parseInt(value.slice(2, 4), 16);
      const b = parseInt(value.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${safe})`;
    }
    return raw;
  }

  function pulse(rate = 180, min = 0.25, max = 1) {
    const t = performance.now() / rate;
    return min + (max - min) * (0.5 + 0.5 * Math.sin(t));
  }

  function nudgeShake(power = 10) {
    runtime.shake = Math.max(runtime.shake, power);
    runtime.flash = Math.min(1, runtime.flash + power * 0.015);
  }

  function recordBestRun({ kills = runtime.gatorsKilled, landingSpeed = null } = {}) {
    const payload = {
      kills: Math.max(0, Math.round(kills)),
      landingSpeed: Number.isFinite(landingSpeed) ? landingSpeed : null,
    };
    try {
      const prev = JSON.parse(localStorage.getItem(GATOR_BEST_KEY) || "{}");
      const shouldStore =
        payload.kills > Number(prev.kills || 0) ||
        (payload.kills === Number(prev.kills || 0) &&
          payload.landingSpeed != null &&
          (!Number.isFinite(prev.landingSpeed) || payload.landingSpeed < prev.landingSpeed));
      if (shouldStore) {
        localStorage.setItem(GATOR_BEST_KEY, JSON.stringify(payload));
      }
    } catch (_) {}
    loadBestRun();
  }

  function loadBestRun() {
    try {
      const prev = JSON.parse(localStorage.getItem(GATOR_BEST_KEY) || "{}");
      runtime.bestKills = Math.max(0, Number(prev.kills || 0));
      runtime.bestLandingSpeed = Number.isFinite(prev.landingSpeed) ? Number(prev.landingSpeed) : null;
    } catch (_) {
      runtime.bestKills = 0;
      runtime.bestLandingSpeed = null;
    }
  }


  // FTL color palette
  const FTL = {
    bg: "#0a0e14",
    panel: "rgba(14, 20, 30, 0.92)",
    panelBorder: "rgba(80, 140, 180, 0.25)",
    panelHighlight: "rgba(80, 140, 180, 0.12)",
    text: "#c8d8e8",
    textDim: "#5a7088",
    textBright: "#e8f4ff",
    green: "#4caf50",
    greenDim: "#2a5a2d",
    red: "#e05050",
    yellow: "#d4a828",
    blue: "#3888cc",
    blueLight: "#68b8e8",
    blueDark: "#0a3d91",
    orange: "#e88830",
    cyan: "#48c8e8",
    white: "#e0e8f0",
  };

  function buildStars() {
    runtime.stars = Array.from({ length: 120 }, (_, i) => ({
      x: Math.random(),
      y: Math.random(),
      size: Math.random() < 0.1 ? 2 : 1, // Pixel-sized stars, few large
      drift: 0.1 + Math.random() * 0.5,
      twinkle: Math.random() * Math.PI * 2,
      bright: Math.random() < 0.15, // 15% are bright accent stars
    }));
  }

  function resetMission() {
    runtime.mode = STATE.START_SCREEN;
    runtime.phase = PHASE.LAUNCH;
    runtime.stageDetached = false;
    runtime.lastTs = 0;
    runtime.cameraY = 0;
    runtime.zoom = 0.82;
    runtime.boosterTimer = 0;
    runtime.maxQ = 0;
    runtime.currentQ = 0;
    runtime.propMass = 100;
    runtime.deltaV = 0;
    runtime.periapsis = Infinity;
    runtime.apoapsis = 0;
    runtime.shake = 0;
    runtime.flash = 0;
    runtime.moonReached = false;
    runtime.hull = runtime.maxHull;
    runtime.score = 0;
    runtime.combo = 1;
    runtime.comboTimer = 0;
    runtime.wave = 1;
    runtime.damageCooldown = 0;
    runtime.objective = "Launch clean, separate on time, and build a stable transfer.";
    runtime.trail = [];
    runtime.trailTimer = 0;
    runtime.message = "Burn for orbit, separate on time, survive the gator intercept, then grease the lunar landing. Cleaner run = bigger score.";
    runtime.statusLine = "LC-36 · New Glenn · Ready";
    runtime.ship = {
      x: 0,
      y: EARTH_RADIUS + 1.5, // on Earth's surface
      vx: 0,
      vy: 0,
      angle: 0,
      fuel: 100,
      altitude: 0,
    };
    runtime.booster = null;
    runtime.particles = [];
    runtime.lasers = [];
    runtime.gators = [];
    runtime.laserCooldown = 0;
    runtime.gatorsKilled = 0;
    runtime.gatorsTotal = 0;
    input.up = false;
    input.left = false;
    input.right = false;
    input.detachPressed = false;
    if (brief) {
      brief.textContent = "1) HOLD UP to launch  2) SPACE to separate on cue  3) Pitch over and build transfer energy  4) SPACE to shred gator waves  5) Touch down softly for the clean-run bonus";
    }
    if (missionStatus) {
      missionStatus.textContent = "LC-36 Cape Canaveral · Standing by for launch. 3 hull pips available.";
    }
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || 960));
    const height = Math.max(420, Math.round(rect.height || 640));
    runtime.width = width;
    runtime.height = height;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function worldToScreen(x, y) {
    const camX = runtime.camX || 0;
    const camY = runtime.cameraY;
    return {
      x: runtime.width * 0.5 + (x - camX) * runtime.zoom,
      y: runtime.height * 0.5 - (y - camY) * runtime.zoom,
    };
  }

  function angleDiff(a, b) {
    let diff = (a - b + Math.PI) % (Math.PI * 2);
    if (diff < 0) diff += Math.PI * 2;
    return diff - Math.PI;
  }

  function startPlaying() {
    resetMission();
    runtime.mode = STATE.PLAYING;
    runtime.camX = 0;
    runtime.message = "HOLD UP — 7× BE-4 engines at full thrust. LOX/LNG. Climb to BECO altitude.";
    runtime.statusLine = "Phase 1 · Stage 1 · 7× BE-4 · LOX/Methane";
  }

  function open() {
    overlay.hidden = false;
    overlay.style.display = "";
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("arcade-open", "gatornauts-mode");
    runtime.open = true;
    resetMission();
    resizeCanvas();
    overlay.dataset.phase = `${runtime.phase}`;
    drawFrame();
    if (!runtime.rafId) {
      runtime.rafId = requestAnimationFrame(loop);
    }
    startChiptune();
  }

  function close() {
    stopChiptune();
    runtime.open = false;
    overlay.hidden = true;
    overlay.style.display = "none";
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("arcade-open", "gatornauts-mode");
    if (runtime.rafId) cancelAnimationFrame(runtime.rafId);
    runtime.rafId = 0;
  }

  function emitBriefing(text, status = text) {
    runtime.message = text;
    runtime.statusLine = status;
    if (brief) brief.textContent = text;
    if (missionStatus) missionStatus.textContent = status;
  }

  function detachBooster() {
    if (runtime.phase !== PHASE.SEPARATION || runtime.stageDetached) return;
    const ship = runtime.ship;
    runtime.phase = PHASE.ORBIT;
    runtime.stageDetached = true;
    runtime.booster = {
      x: ship.x,
      y: ship.y - 28,
      vx: ship.vx * 0.7,
      vy: ship.vy - 18,
      spin: 0,
      active: true,
    };
    // Stage 2 ignition — 2× BE-3U, LOX/LH2
    ship.vy += 22;
    ship.fuel = Math.max(ship.fuel, 82);
    runtime.propMass = 82;
    emitBriefing(
      "Stage 1 separated — booster recovery burn initiated. Stage 2 ignition: 2× BE-3U (LOX/LH2). Build orbit, then SPACE to jettison Stage 2 for TLI.",
      "Phase 3 · LEO insertion · 2× BE-3U · LOX/LH2"
    );
  }

  function spawnBurst(count, color) {
    const ship = runtime.ship;
    for (let i = 0; i < count; i += 1) {
      runtime.particles.push({
        x: ship.x + (Math.random() - 0.5) * 18,
        y: ship.y + (Math.random() - 0.5) * 18,
        vx: (Math.random() - 0.5) * 90,
        vy: (Math.random() - 0.5) * 90,
        life: 0.8 + Math.random() * 0.6,
        age: 0,
        color,
      });
    }
  }

  function setObjective(text) {
    runtime.objective = text;
  }

  function awardScore(base, reason = "") {
    const comboValue = Math.max(1, runtime.combo);
    runtime.score += Math.round(base * comboValue);
    runtime.comboTimer = 3.25;
    if (reason) {
      runtime.statusLine = `${reason} · +${Math.round(base * comboValue)} pts · x${comboValue.toFixed(1)} combo`;
    }
  }

  function damageShip(reason) {
    if (runtime.damageCooldown > 0 || runtime.mode !== STATE.PLAYING) return;
    runtime.damageCooldown = 1.25;
    runtime.hull = Math.max(0, runtime.hull - 1);
    runtime.combo = 1;
    runtime.comboTimer = 0;
    nudgeShake(14);
    spawnBurst(16, palette().red);
    if (runtime.hull <= 0) {
      failMission(reason);
      return;
    }
    emitBriefing(`${reason} Hull integrity reduced.`, `Hull ${runtime.hull}/${runtime.maxHull} · Recover and finish the mission.`);
  }

  function failMission(reason) {
    runtime.mode = STATE.GAME_OVER;
    emitBriefing(reason, "Mission lost. Press restart to try again.");
    spawnBurst(22, palette().orange);
    nudgeShake(18);
    recordBestRun();
  }

  function landMission() {
    runtime.mode = STATE.SUCCESS;
    const landingSpeed = Math.sqrt(runtime.ship.vx * runtime.ship.vx + runtime.ship.vy * runtime.ship.vy);
    emitBriefing(
      `Touchdown. ${runtime.gatorsKilled} alien gators neutralized. The moon is safe — for now.`,
      "Mission success. Press restart for another run."
    );
    spawnBurst(12, palette().lime);
    nudgeShake(10);
    const cleanBonus = Math.max(0, Math.round((runtime.hull * 350) + Math.max(0, 28 - landingSpeed) * 35));
    runtime.score += cleanBonus;
    runtime.statusLine = `Touchdown bonus +${cleanBonus} · Final score ${runtime.score}`;
    recordBestRun({ landingSpeed });
  }

  function updateParticles(dt) {
    runtime.particles = runtime.particles
      .map((particle) => ({
        ...particle,
        x: particle.x + particle.vx * dt,
        y: particle.y + particle.vy * dt,
        age: particle.age + dt,
      }))
      .filter((particle) => particle.age < particle.life);
  }

  function updateBooster(dt) {
    if (!runtime.booster?.active) return;
    runtime.booster.vy -= 18 * dt;
    runtime.booster.spin += dt * 1.8;
    runtime.booster.x += runtime.booster.vx * dt;
    runtime.booster.y += runtime.booster.vy * dt;
    if (runtime.booster.y < -120) runtime.booster.active = false;
  }

  function spawnGators(countOverride = null, waveLabel = null) {
    const count = countOverride ?? (6 + Math.floor(Math.random() * 4));
    runtime.gatorsTotal = count;
    runtime.gatorsKilled = 0;
    runtime.gators = [];
    const ship = runtime.ship;
    for (let i = 0; i < count; i++) {
      // Spread gators between current position and Moon
      const t = 0.2 + 0.6 * (i / count);
      const gx = ship.x + (MOON_CENTER.x - ship.x) * t + (Math.random() - 0.5) * 200;
      const gy = ship.y + (MOON_CENTER.y - ship.y) * t + (Math.random() - 0.5) * 200;
      runtime.gators.push({
        x: gx, y: gy,
        vx: (Math.random() - 0.5) * 20,
        vy: (Math.random() - 0.5) * 8,
        alive: true,
        frame: Math.floor(Math.random() * 4),
        flipX: Math.random() < 0.5,
        size: 0.8 + Math.random() * 0.5,
        hp: waveLabel === "reinforcement" ? 2 : 1,
      });
    }
    if (waveLabel) {
      emitBriefing(`Wave ${runtime.wave}: ${count} gators inbound.`, `Hostile intercept ${waveLabel}. Keep the lane clean.`);
    }
  }

  function fireLaser() {
    if (runtime.laserCooldown > 0 || runtime.phase !== PHASE.LUNAR) return;
    const ship = runtime.ship;
    runtime.laserCooldown = 0.18; // faster, more arcade
    // Fire from nose of rocket (opposite direction of thrust)
    runtime.lasers.push({
      x: ship.x + Math.sin(ship.angle) * 20,
      y: ship.y + Math.cos(ship.angle) * 20,
      vx: Math.sin(ship.angle) * 300,
      vy: Math.cos(ship.angle) * 300,
      life: 1.5,
      age: 0,
    });
    nudgeShake(2);
    // Laser sound effect — short high-pitched blip
    if (audio.ctx && audio.playing) {
      try {
        const osc = audio.ctx.createOscillator();
        osc.type = "square";
        osc.frequency.value = 880;
        const env = audio.ctx.createGain();
        env.gain.setValueAtTime(0.15, audio.ctx.currentTime);
        env.gain.exponentialRampToValueAtTime(0.001, audio.ctx.currentTime + 0.08);
        osc.connect(env);
        env.connect(audio.masterGain);
        osc.start();
        osc.stop(audio.ctx.currentTime + 0.1);
      } catch (_) {}
    }
  }

  function updateLasers(dt) {
    runtime.laserCooldown = Math.max(0, runtime.laserCooldown - dt);
    runtime.lasers = runtime.lasers
      .map(l => ({
        ...l,
        x: l.x + l.vx * dt,
        y: l.y + l.vy * dt,
        age: l.age + dt,
      }))
      .filter(l => l.age < l.life);
  }

  function updateGators(dt) {
    const ship = runtime.ship;
    runtime.gators.forEach(g => {
      if (!g.alive) return;
      // Wander + slight drift toward ship x
      g.vx += (Math.random() - 0.5) * 30 * dt;
      g.vx += clamp((ship.x - g.x) * 0.002, -2, 2);
      g.vx = clamp(g.vx, -30, 30);
      g.vy += (Math.random() - 0.5) * 10 * dt;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.frame = (g.frame + dt * 4) % 4;
      g.flipX = g.vx < 0;

      // Collision with ship — gator bites you
      const dx = ship.x - g.x;
      const dy = ship.y - g.y;
      if (Math.sqrt(dx * dx + dy * dy) < 22) {
        g.alive = false;
        damageShip("An alien gator chomped the spacecraft.");
      }
    });

    // Laser-gator collision
    runtime.lasers.forEach(l => {
      runtime.gators.forEach(g => {
        if (!g.alive) return;
        const dx = l.x - g.x;
        const dy = l.y - g.y;
        if (Math.abs(dx) < 24 * g.size && Math.abs(dy) < 18 * g.size) {
          g.hp = Math.max(0, (g.hp || 1) - 1);
          nudgeShake(6);
          if (g.hp > 0) {
            l.age = l.life;
            runtime.statusLine = "Armor cracked on hostile contact.";
            return;
          }
          g.alive = false;
          runtime.gatorsKilled++;
          runtime.combo = Math.min(6, runtime.combo + 0.35);
          awardScore(120, "Hostile neutralized");
          // Gator explosion
          for (let i = 0; i < 8; i++) {
            runtime.particles.push({
              x: g.x + (Math.random() - 0.5) * 12,
              y: g.y + (Math.random() - 0.5) * 12,
              vx: (Math.random() - 0.5) * 60,
              vy: (Math.random() - 0.5) * 60,
              life: 0.5 + Math.random() * 0.3,
              age: 0,
              color: FTL.green,
            });
          }
          // Kill sound
          if (audio.ctx && audio.playing) {
            try {
              const osc = audio.ctx.createOscillator();
              osc.type = "sawtooth";
              osc.frequency.value = 200;
              osc.frequency.exponentialRampToValueAtTime(60, audio.ctx.currentTime + 0.15);
              const env = audio.ctx.createGain();
              env.gain.setValueAtTime(0.12, audio.ctx.currentTime);
              env.gain.exponentialRampToValueAtTime(0.001, audio.ctx.currentTime + 0.2);
              osc.connect(env);
              env.connect(audio.masterGain);
              osc.start();
              osc.stop(audio.ctx.currentTime + 0.25);
            } catch (_) {}
          }
          l.age = l.life; // consume the laser
        }
      });
    });
  }

  function drawGators() {
    runtime.gators.forEach(g => {
      if (!g.alive) return;
      const { x, y } = worldToScreen(g.x, g.y);
      const s = g.size * Math.max(runtime.zoom, 0.5);
      const px = (v) => Math.floor(v);
      ctx.save();
      ctx.translate(px(x), px(y));
      if (g.flipX) ctx.scale(-1, 1);
      ctx.scale(s, s);

      // 8-bit pixel gator — body
      ctx.fillStyle = "#3a8a3a";
      ctx.fillRect(-12, -4, 24, 8);    // torso
      ctx.fillRect(-16, -2, 6, 4);     // tail base
      ctx.fillRect(-20, -1, 5, 2);     // tail tip

      // Head/jaw
      ctx.fillStyle = "#4aaa4a";
      ctx.fillRect(10, -6, 10, 10);    // head
      ctx.fillRect(18, -4, 6, 4);      // snout upper
      ctx.fillRect(18, 0, 6, 3);       // snout lower (jaw)

      // Jaw animation (chomp)
      const chomp = Math.floor(g.frame) % 2;
      if (chomp) {
        ctx.fillRect(18, 2, 6, 2);     // jaw open
      }

      // Teeth
      ctx.fillStyle = "#fff";
      ctx.fillRect(20, -1, 2, 2);
      ctx.fillRect(22, -1, 2, 2);

      // Eye (red — alien!)
      ctx.fillStyle = "#ff2020";
      ctx.fillRect(14, -5, 3, 3);
      // Pupil
      ctx.fillStyle = "#000";
      ctx.fillRect(15, -4, 1, 1);

      // Legs
      ctx.fillStyle = "#3a8a3a";
      const legOff = Math.floor(g.frame) % 2 === 0 ? 0 : 2;
      ctx.fillRect(-6, 4 + legOff, 3, 4);      // back leg
      ctx.fillRect(4, 4 + (2 - legOff), 3, 4);  // front leg

      // Spikes (alien feature)
      ctx.fillStyle = "#80ff80";
      ctx.fillRect(-8, -6, 2, 3);
      ctx.fillRect(-2, -7, 2, 4);
      ctx.fillRect(4, -6, 2, 3);

      ctx.restore();
    });
  }

  function drawLasers() {
    ctx.fillStyle = FTL.cyan;
    runtime.lasers.forEach(l => {
      const { x, y } = worldToScreen(l.x, l.y);
      const angle = Math.atan2(l.vx, l.vy);
      ctx.save();
      ctx.translate(Math.floor(x), Math.floor(y));
      ctx.rotate(-angle);
      // Pixel laser bolt — narrow rectangle
      ctx.fillRect(-1, -6, 2, 12);
      // Bright core
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, -4, 1, 8);
      ctx.fillStyle = FTL.cyan;
      ctx.restore();
    });
  }

  function atmosphericDensity(alt) {
    // Exponential atmosphere model — density falls off with altitude
    // Scale height ~120 game-units (represents ~44km)
    return Math.exp(-Math.max(0, alt) / 120);
  }

  // ── Two-body gravity: Newton's law of gravitation ──
  function gravityAccel(shipX, shipY) {
    // Earth gravity
    let dx = EARTH_CENTER.x - shipX;
    let dy = EARTH_CENTER.y - shipY;
    let r2 = dx * dx + dy * dy;
    let r = Math.sqrt(r2);
    let ax = 0, ay = 0;
    if (r > 2) { // avoid singularity
      const aE = EARTH_GM / r2;
      ax += (dx / r) * aE;
      ay += (dy / r) * aE;
    }
    // Moon gravity
    dx = MOON_CENTER.x - shipX;
    dy = MOON_CENTER.y - shipY;
    r2 = dx * dx + dy * dy;
    r = Math.sqrt(r2);
    if (r > 2) {
      const aM = MOON_GM / r2;
      ax += (dx / r) * aM;
      ay += (dy / r) * aM;
    }
    return { ax, ay };
  }

  function distToEarth(x, y) {
    return Math.sqrt(x * x + y * y);
  }
  function distToMoon(x, y) {
    const dx = x - MOON_CENTER.x;
    const dy = y - MOON_CENTER.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Predict trajectory N steps ahead (for trajectory line)
  function predictTrajectory(x, y, vx, vy, steps, stepDt) {
    const pts = [];
    for (let i = 0; i < steps; i++) {
      const g = gravityAccel(x, y);
      vx += g.ax * stepDt;
      vy += g.ay * stepDt;
      x += vx * stepDt;
      y += vy * stepDt;
      if (i % 3 === 0) pts.push({ x, y });
      // Stop if collided with body
      if (distToEarth(x, y) < EARTH_RADIUS - 5 || distToMoon(x, y) < MOON_RADIUS - 3) break;
    }
    return pts;
  }

  function updateMission(dt) {
    if (runtime.mode !== STATE.PLAYING) {
      updateParticles(dt);
      return;
    }

    const ship = runtime.ship;
    runtime.damageCooldown = Math.max(0, runtime.damageCooldown - dt);
    runtime.comboTimer = Math.max(0, runtime.comboTimer - dt);
    if (runtime.comboTimer <= 0 && runtime.combo > 1) {
      runtime.combo = Math.max(1, runtime.combo - dt * 0.8);
    }
    const earthAlt = distToEarth(ship.x, ship.y) - EARTH_RADIUS;
    const moonAlt = distToMoon(ship.x, ship.y) - MOON_RADIUS;
    ship.altitude = earthAlt;

    // Trail breadcrumbs
    runtime.trailTimer += dt;
    if (runtime.trailTimer > 0.15) {
      runtime.trailTimer = 0;
      runtime.trail.push({ x: ship.x, y: ship.y });
      if (runtime.trail.length > 600) runtime.trail.shift();
    }

    // Compute orbital parameters
    const earthR = distToEarth(ship.x, ship.y);
    const altKm = Math.max(0, (earthR - EARTH_RADIUS) * 25); // 1 unit ≈ 25 km
    runtime.periapsis = Math.min(runtime.periapsis, altKm);
    runtime.apoapsis = Math.max(runtime.apoapsis, altKm);

    // ═══ PHASE: LAUNCH ═══
    if (runtime.phase === PHASE.LAUNCH) {
      ship.angle = 0; // nose up
      const rho = atmosphericDensity(earthAlt);

      if (input.up && ship.fuel > 0) {
        // Stage 1: 7× BE-4 engines, LOX/LNG (methane)
        // Real: 17,100 kN total thrust, Isp 311s sea level
        const thrustForce = 52;
        ship.vy += thrustForce * dt;
        ship.fuel = Math.max(0, ship.fuel - 14 * dt);
        runtime.propMass = Math.max(0, runtime.propMass - 14 * dt);
        runtime.deltaV += thrustForce * dt;
        if (Math.random() < 0.6) {
          runtime.particles.push({
            x: ship.x + (Math.random() - 0.5) * 6,
            y: ship.y - 12,
            vx: (Math.random() - 0.5) * 20,
            vy: -30 - Math.random() * 40,
            life: 0.4 + Math.random() * 0.3, age: 0,
            color: FTL.orange,
          });
        }
      }

      // Atmospheric drag
      const speed = Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy);
      const dragForce = 0.5 * rho * 0.35 * speed;
      if (speed > 0.1) {
        ship.vx -= (ship.vx / speed) * dragForce * dt;
        ship.vy -= (ship.vy / speed) * dragForce * dt;
      }
      runtime.currentQ = 0.5 * rho * speed * speed;
      runtime.maxQ = Math.max(runtime.maxQ, runtime.currentQ);

      // Gravity (simplified vertical during launch)
      const g = gravityAccel(ship.x, ship.y);
      ship.vx += g.ax * dt;
      ship.vy += g.ay * dt;

      // BECO — booster engine cutoff at altitude ~320km
      if (earthAlt >= 65 || ship.fuel <= 38) {
        runtime.phase = PHASE.SEPARATION;
        runtime.boosterTimer = 5.0;
        setObjective("Separate before the timer expires. Late staging ends the run.");
        emitBriefing(
          "BECO — 7× BE-4 shutdown. MECO altitude reached. SPACE to separate Stage 1 for recovery.",
          "Phase 2 · Stage 1 separation · LOX/LNG depleted"
        );
      }
    }

    // ═══ PHASE: SEPARATION ═══
    else if (runtime.phase === PHASE.SEPARATION) {
      runtime.boosterTimer -= dt;
      const g = gravityAccel(ship.x, ship.y);
      ship.vx += g.ax * dt;
      ship.vy += g.ay * dt;
      const rho = atmosphericDensity(earthAlt);
      const speed = Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy);
      const dragForce = 0.5 * rho * 0.2 * speed;
      if (speed > 0.1) {
        ship.vx -= (ship.vx / speed) * dragForce * dt;
        ship.vy -= (ship.vy / speed) * dragForce * dt;
      }
      runtime.currentQ = 0.5 * rho * speed * speed;

      if (input.detachPressed) detachBooster();
      if (!runtime.stageDetached && (runtime.boosterTimer <= 0 || earthAlt <= 10)) {
        failMission("Stage 1 separation too late. Spent booster dragged the stack back through the atmosphere.");
      }
    }

    // ═══ PHASE: ORBIT (Stage 2 burn — LEO insertion) ═══
    else if (runtime.phase === PHASE.ORBIT) {
      if (input.left) ship.angle -= 2.8 * dt;
      if (input.right) ship.angle += 2.8 * dt;
      ship.angle = ((ship.angle % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2);

      // Two-body gravity
      const g = gravityAccel(ship.x, ship.y);
      ship.vx += g.ax * dt;
      ship.vy += g.ay * dt;

      if (input.up && ship.fuel > 0) {
        // Stage 2: 2× BE-3U engines, LOX/LH2
        // Real: 1,600 kN total, Isp 450s vacuum
        const thrust = 35;
        ship.vx += Math.sin(ship.angle) * thrust * dt;
        ship.vy += Math.cos(ship.angle) * thrust * dt;
        ship.fuel = Math.max(0, ship.fuel - 8 * dt);
        runtime.propMass = Math.max(0, runtime.propMass - 8 * dt);
        runtime.deltaV += thrust * dt;
        if (Math.random() < 0.5) {
          runtime.particles.push({
            x: ship.x + (Math.random() - 0.5) * 4, y: ship.y,
            vx: -Math.sin(ship.angle) * 30 + (Math.random() - 0.5) * 15,
            vy: -Math.cos(ship.angle) * 30 + (Math.random() - 0.5) * 15,
            life: 0.3, age: 0, color: FTL.blueLight,
          });
        }
      }

      runtime.currentQ = 0;

      // Stage 2 separation when fuel runs low — payload (Stage 3) continues
      if (input.detachPressed && ship.fuel < 50) {
        runtime.phase = PHASE.TRANSIT;
        ship.fuel = Math.max(ship.fuel, 60); // Stage 3 has its own propellant
        runtime.propMass = 60;
        spawnGators();
        runtime.wave = 1;
        setObjective("Clear the gator wave while preserving hull before lunar arrival.");
        emitBriefing(
          "Stage 2 jettisoned. Payload stage free — hydrazine RCS active. SPACE to fire laser. Clear gators, then lunar orbit insertion.",
          "Phase 4 · Trans-lunar coast · Gators detected!"
        );
      }

      // Auto transition if enough altitude/velocity for TLI
      const orbitalV = Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy);
      if (earthAlt > 200 && orbitalV > 55 && ship.fuel < 45) {
        runtime.phase = PHASE.TRANSIT;
        ship.fuel = Math.max(ship.fuel, 60);
        runtime.propMass = 60;
        spawnGators();
        runtime.wave = 1;
        setObjective("Clear the gator wave while preserving hull before lunar arrival.");
        emitBriefing(
          "TLI burn complete. Trans-lunar injection achieved. Payload coast phase — engage hostiles.",
          "Phase 4 · Trans-lunar coast · HOSTILES DETECTED"
        );
      }

      if (distToEarth(ship.x, ship.y) <= EARTH_RADIUS) {
        failMission("Orbital decay — Stage 2 re-entered Earth's atmosphere at " + Math.round(earthAlt * 25) + " km.");
      }
    }

    // ═══ PHASE: TRANSIT (coast to Moon, shoot gators) ═══
    else if (runtime.phase === PHASE.TRANSIT) {
      if (input.detachPressed) fireLaser();
      if (input.left) ship.angle -= 2.8 * dt;
      if (input.right) ship.angle += 2.8 * dt;
      ship.angle = ((ship.angle % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2);

      // Two-body gravity (slingshot!)
      const g = gravityAccel(ship.x, ship.y);
      ship.vx += g.ax * dt;
      ship.vy += g.ay * dt;

      if (input.up && ship.fuel > 0) {
        // Stage 3: Payload RCS — hydrazine thrusters
        // Real: ~4.4 kN, Isp 220s
        const thrust = 22;
        ship.vx += Math.sin(ship.angle) * thrust * dt;
        ship.vy += Math.cos(ship.angle) * thrust * dt;
        ship.fuel = Math.max(0, ship.fuel - 6 * dt);
        runtime.propMass = Math.max(0, runtime.propMass - 6 * dt);
        runtime.deltaV += thrust * dt;
        if (Math.random() < 0.4) {
          runtime.particles.push({
            x: ship.x, y: ship.y,
            vx: -Math.sin(ship.angle) * 25 + (Math.random() - 0.5) * 10,
            vy: -Math.cos(ship.angle) * 25 + (Math.random() - 0.5) * 10,
            life: 0.25, age: 0, color: FTL.cyan,
          });
        }
      }

      runtime.currentQ = 0;
      updateLasers(dt);
      updateGators(dt);
      if (!runtime.gators.some(g => g.alive) && moonAlt > 260 && runtime.wave < 2) {
        runtime.wave += 1;
        spawnGators(4 + runtime.wave, "reinforcement");
        setObjective("Second wave inbound. Clear the lane, then set up lunar arrival.");
      }

      // Transition to lunar phase when close to moon
      if (moonAlt < 120) {
        runtime.phase = PHASE.LUNAR;
        runtime.moonReached = true;
        setObjective("Eliminate remaining hostiles, rotate legs-down, and land under 18 m/s.");
        emitBriefing(
          "Lunar sphere of influence. LOI burn — orient for landing. Legs toward surface (angle ≈ 180°).",
          "Phase 5 · Lunar orbit insertion · Landing approach"
        );
      }

      // Crash into Earth
      if (distToEarth(ship.x, ship.y) <= EARTH_RADIUS) {
        failMission("Re-entry into Earth's atmosphere. Trajectory did not achieve escape velocity.");
      }
      // Fly off into deep space
      if (distToEarth(ship.x, ship.y) > MOON_DIST * 1.5 && distToMoon(ship.x, ship.y) > MOON_DIST * 0.5) {
        failMission("Trajectory diverged beyond cislunar space. Unrecoverable.");
      }
    }

    // ═══ PHASE: LUNAR LANDING ═══
    else if (runtime.phase === PHASE.LUNAR) {
      if (input.detachPressed) fireLaser();
      if (input.left) ship.angle -= 2.8 * dt;
      if (input.right) ship.angle += 2.8 * dt;
      if (!input.left && !input.right) {
        const radialAngle = Math.atan2(ship.x - MOON_CENTER.x, ship.y - MOON_CENTER.y) + Math.PI;
        ship.angle += angleDiff(radialAngle, ship.angle) * dt * 1.1;
      }
      ship.angle = ((ship.angle % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2);

      // Moon gravity dominates
      const g = gravityAccel(ship.x, ship.y);
      ship.vx += g.ax * dt;
      ship.vy += g.ay * dt;

      if (input.up && ship.fuel > 0) {
        const thrust = 22;
        ship.vx += Math.sin(ship.angle) * thrust * dt;
        ship.vy += Math.cos(ship.angle) * thrust * dt;
        ship.fuel = Math.max(0, ship.fuel - 6 * dt);
        runtime.propMass = Math.max(0, runtime.propMass - 6 * dt);
        runtime.deltaV += thrust * dt;
        if (Math.random() < 0.4) {
          runtime.particles.push({
            x: ship.x, y: ship.y,
            vx: -Math.sin(ship.angle) * 25 + (Math.random() - 0.5) * 10,
            vy: -Math.cos(ship.angle) * 25 + (Math.random() - 0.5) * 10,
            life: 0.25, age: 0, color: FTL.cyan,
          });
        }
      }

      runtime.currentQ = 0;
      updateLasers(dt);
      updateGators(dt);

      // Landing check
      if (moonAlt <= 3) {
        const gatorsAlive = runtime.gators.filter(g => g.alive).length;
        // Velocity relative to Moon surface
        const speed = Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy);
        // Angle relative to moon-radial (pointing away from moon center)
        const radialAngle = Math.atan2(ship.x - MOON_CENTER.x, ship.y - MOON_CENTER.y);
        const tiltFromUpright = Math.abs(angleDiff(ship.angle, radialAngle + Math.PI));

        if (gatorsAlive > 0) {
          failMission(`${gatorsAlive} gator${gatorsAlive > 1 ? "s" : ""} still lurking. Clear all hostiles before landing!`);
        } else if (speed < 18 && tiltFromUpright < 0.55) {
          landMission();
        } else {
          const reasons = [];
          if (speed >= 18) reasons.push(`speed ${speed.toFixed(1)} m/s`);
          if (tiltFromUpright >= 0.55) reasons.push(`tilt ${(tiltFromUpright * 180 / Math.PI).toFixed(0)}°`);
          failMission(`Hard lunar contact: ${reasons.join(", ")}. Requires <18 m/s, <32° tilt.`);
        }
      }

      // Crash into Moon interior
      if (moonAlt < -5) {
        failMission("Lithobraking is not a valid landing technique.");
      }
    }

    input.detachPressed = false;

    // Position update
    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;

    // Crash into Earth surface during launch
    if (runtime.phase === PHASE.LAUNCH && distToEarth(ship.x, ship.y) <= EARTH_RADIUS && ship.vy < 0) {
      failMission("New Glenn fell back onto LC-36. Insufficient thrust-to-weight ratio.");
    }

    // ── Camera tracking ──
    let targetCamX = ship.x;
    let targetCamY = ship.y;
    let targetZoom;

    if (runtime.phase === PHASE.LAUNCH) {
      targetCamX = 0;
      targetCamY = ship.y;
      targetZoom = 0.84;
    } else if (runtime.phase === PHASE.SEPARATION) {
      targetZoom = 0.66;
    } else if (runtime.phase === PHASE.ORBIT) {
      targetZoom = clamp(0.25 - earthAlt * 0.0003, 0.08, 0.3);
    } else if (runtime.phase === PHASE.TRANSIT) {
      // Zoom to show both Earth and Moon
      const span = Math.max(distToEarth(ship.x, ship.y), distToMoon(ship.x, ship.y));
      targetZoom = clamp(runtime.height * 0.3 / span, 0.04, 0.2);
    } else {
      // Lunar landing — zoom into moon
      targetZoom = clamp(0.4 - moonAlt * 0.002, 0.15, 0.5);
    }

    runtime.camX = (runtime.camX || 0) + (targetCamX - (runtime.camX || 0)) * Math.min(1, dt * 2.5);
    runtime.cameraY += (targetCamY - runtime.cameraY) * Math.min(1, dt * 2.5);
    runtime.zoom += (targetZoom - runtime.zoom) * Math.min(1, dt * 2.0);

    overlay.dataset.phase = `${runtime.phase}`;
    runtime.shake = Math.max(0, runtime.shake - dt * 22);
    runtime.flash = Math.max(0, runtime.flash - dt * 1.8);
    updateBooster(dt);
    updateParticles(dt);
  }

  function drawStars() {
    runtime.stars.forEach((star, i) => {
      const twinkle = 0.5 + 0.5 * Math.sin(performance.now() / 900 + star.twinkle + i);
      const alpha = star.bright ? (0.6 + twinkle * 0.35) : (0.2 + twinkle * 0.25);
      const color = star.bright ? withAlpha(FTL.blueLight, alpha) : withAlpha(FTL.textDim, alpha);
      const sx = star.x * runtime.width;
      const sy = (star.y * runtime.height + runtime.cameraY * star.drift * 0.015) % runtime.height;
      ctx.fillStyle = color;
      ctx.fillRect(Math.floor(sx), Math.floor(sy), star.size, star.size);
    });
  }

  function drawNebula(p) {
    const offset = (runtime.cameraY || 0) * 0.02;
    const gradA = ctx.createRadialGradient(runtime.width * 0.2, runtime.height * 0.2 + offset, 10, runtime.width * 0.2, runtime.height * 0.2 + offset, runtime.width * 0.45);
    gradA.addColorStop(0, withAlpha(p.magenta, 0.14));
    gradA.addColorStop(0.45, withAlpha(p.cyan, 0.08));
    gradA.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradA;
    ctx.fillRect(0, 0, runtime.width, runtime.height);

    const gradB = ctx.createRadialGradient(runtime.width * 0.82, runtime.height * 0.3 - offset * 0.7, 8, runtime.width * 0.82, runtime.height * 0.3 - offset * 0.7, runtime.width * 0.34);
    gradB.addColorStop(0, withAlpha(p.cyan, 0.1));
    gradB.addColorStop(0.5, withAlpha(p.lime, 0.05));
    gradB.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradB;
    ctx.fillRect(0, 0, runtime.width, runtime.height);
  }

  function drawEarth(p) {
    const ec = worldToScreen(EARTH_CENTER.x, EARTH_CENTER.y);
    const r = EARTH_RADIUS * runtime.zoom;
    if (ec.y - r > runtime.height + 50 || ec.y + r < -50) return; // off-screen
    if (r < 2) return;

    ctx.save();
    // Atmosphere glow
    if (r > 10) {
      const grd = ctx.createRadialGradient(ec.x, ec.y, r, ec.x, ec.y, r + 12);
      grd.addColorStop(0, "rgba(100, 180, 255, 0.15)");
      grd.addColorStop(1, "rgba(100, 180, 255, 0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(ec.x, ec.y, r + 12, 0, Math.PI * 2);
      ctx.fill();
    }

    // Earth body
    ctx.beginPath();
    ctx.arc(ec.x, ec.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#0a2a5a";
    ctx.fill();

    // Continents (pixel rectangles when zoomed enough)
    if (r > 15) {
      ctx.fillStyle = "#1a5a2a";
      // North America
      ctx.fillRect(Math.floor(ec.x - r * 0.5), Math.floor(ec.y - r * 0.3), Math.floor(r * 0.3), Math.floor(r * 0.25));
      // South America
      ctx.fillRect(Math.floor(ec.x - r * 0.25), Math.floor(ec.y + r * 0.1), Math.floor(r * 0.15), Math.floor(r * 0.35));
      // Africa/Europe
      ctx.fillRect(Math.floor(ec.x + r * 0.1), Math.floor(ec.y - r * 0.3), Math.floor(r * 0.2), Math.floor(r * 0.5));
      // Polar ice
      ctx.fillStyle = "#c8d8e8";
      ctx.fillRect(Math.floor(ec.x - r * 0.15), Math.floor(ec.y - r * 0.9), Math.floor(r * 0.3), Math.floor(r * 0.1));
    }

    // Gravity well rings
    ctx.strokeStyle = "rgba(100, 180, 255, 0.08)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(ec.x, ec.y, r + i * 40 * runtime.zoom, 0, Math.PI * 2);
      ctx.stroke();
    }

    // LC-36 marker on surface (when zoomed in enough)
    if (r > 60) {
      const padAngle = 0; // top of Earth
      const padX = ec.x + Math.sin(padAngle) * r;
      const padY = ec.y - Math.cos(padAngle) * r;
      ctx.fillStyle = FTL.cyan;
      ctx.fillRect(Math.floor(padX - 3), Math.floor(padY - 2), 6, 2);
      ctx.fillStyle = FTL.textDim;
      ctx.font = "9px JetBrains Mono, monospace";
      ctx.fillText("LC-36", Math.floor(padX + 8), Math.floor(padY + 3));
    }

    ctx.restore();
  }

  function drawMoonBody(p) {
    const mc = worldToScreen(MOON_CENTER.x, MOON_CENTER.y);
    const r = MOON_RADIUS * runtime.zoom;
    if (mc.y - r > runtime.height + 50 || mc.y + r < -50) return;
    if (r < 2) return;

    ctx.save();
    // Moon body
    ctx.beginPath();
    ctx.arc(mc.x, mc.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#1a1d22";
    ctx.fill();

    // Crater details (when zoomed)
    if (r > 10) {
      ctx.fillStyle = "#22262e";
      const craters = [
        { a: 0.3, d: 0.5, s: 0.15 }, { a: 1.8, d: 0.6, s: 0.1 },
        { a: 3.2, d: 0.4, s: 0.12 }, { a: 4.5, d: 0.7, s: 0.08 },
      ];
      craters.forEach(c => {
        const cx = mc.x + Math.cos(c.a) * r * c.d;
        const cy = mc.y + Math.sin(c.a) * r * c.d;
        const cs = r * c.s;
        ctx.fillRect(Math.floor(cx - cs), Math.floor(cy - cs), Math.floor(cs * 2), Math.floor(cs * 2));
      });
    }

    // Gravity well rings
    ctx.strokeStyle = "rgba(200, 220, 255, 0.06)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(mc.x, mc.y, r + i * 30 * runtime.zoom, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Landing pad marker
    if (r > 15) {
      const padX = mc.x;
      const padY = mc.y - r; // top of moon
      ctx.fillStyle = FTL.green;
      ctx.fillRect(Math.floor(padX - 4), Math.floor(padY - 1), 8, 2);
      if (r > 30) {
        ctx.fillStyle = FTL.textDim;
        ctx.font = "9px JetBrains Mono, monospace";
        ctx.fillText("LUNAR PAD", Math.floor(padX + 8), Math.floor(padY + 3));
      }
    }

    ctx.restore();
  }

  function drawMoon(p) {
    const moonPadY = 2560;
    const moonCenter = worldToScreen(0, moonPadY + 170);
    const z = runtime.zoom;
    const px = (v) => Math.floor(v);

    // Moon surface — pixel-art: large rectangle with terrain texture
    const surfW = px(400 * z);
    const surfH = px(200 * z);
    const surfX = px(moonCenter.x - surfW / 2);
    const surfY = px(moonCenter.y - surfH * 0.3);

    // Base surface
    ctx.fillStyle = "#1a1d22";
    ctx.fillRect(surfX, surfY, surfW, surfH);

    // Surface terrain detail lines
    ctx.fillStyle = "#22262e";
    for (let i = 0; i < 8; i++) {
      const lx = surfX + px((30 + i * 48) * z);
      const ly = surfY + px((10 + (i % 3) * 18) * z);
      ctx.fillRect(lx, ly, px((20 + i * 4) * z), px(2 * z));
    }

    // Pixel-art craters (rectangles, not circles)
    const craters = [
      { x: -60, y: 30, w: 36, h: 18 },
      { x: 50, y: 20, w: 28, h: 14 },
      { x: -20, y: 50, w: 22, h: 10 },
      { x: 80, y: 45, w: 18, h: 8 },
    ];
    craters.forEach(c => {
      const cx = px(moonCenter.x + c.x * z);
      const cy = px(surfY + c.y * z);
      // Crater rim (lighter)
      ctx.fillStyle = "#2a2e38";
      ctx.fillRect(cx, cy, px(c.w * z), px(c.h * z));
      // Crater floor (darker)
      ctx.fillStyle = "#12151a";
      ctx.fillRect(px(cx + 3 * z), px(cy + 3 * z), px((c.w - 6) * z), px((c.h - 6) * z));
    });

    // Landing pad — pixel blocks
    const padLeft = worldToScreen(-56, moonPadY).x;
    const padRight = worldToScreen(56, moonPadY).x;
    const padY = worldToScreen(0, moonPadY).y;
    const padW = px(padRight - padLeft);

    // Pad base
    ctx.fillStyle = FTL.green;
    ctx.fillRect(px(padLeft), px(padY - 2), padW, px(4 * z));

    // Approach markers (alternating blocks)
    ctx.fillStyle = FTL.greenDim;
    for (let i = 0; i < 6; i++) {
      ctx.fillRect(px(padLeft + i * padW / 6), px(padY - 6), px(padW / 12), px(3 * z));
    }

    // Label
    ctx.fillStyle = FTL.textDim;
    ctx.font = "10px JetBrains Mono, monospace";
    ctx.fillText("LUNAR PAD", px(padRight + 8), px(padY + 4));
  }

  function drawRocketBody(ship, isBoosterPhase, thrusterOn, p, boosterSpin = 0) {
    const { x, y } = worldToScreen(ship.x, ship.y);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ship.angle + boosterSpin);
    ctx.scale(Math.max(runtime.zoom, 0.42), Math.max(runtime.zoom, 0.42));

    const blue = "#0a3d91";         // Blue Origin blue
    const blueLight = "#1a6dd4";
    const blueAccent = "#4da6ff";

    if (thrusterOn) {
      // 7-engine BE-4 exhaust plume (booster) or single BE-3U (second stage)
      const engines = isBoosterPhase ? 7 : 1;
      const spread = isBoosterPhase ? 5 : 0;
      for (let i = 0; i < engines; i++) {
        const ex = (i - (engines - 1) / 2) * spread;
        // Outer plume
        ctx.beginPath();
        ctx.moveTo(ex - 4, 32);
        ctx.lineTo(ex, 52 + Math.random() * 12);
        ctx.lineTo(ex + 4, 32);
        ctx.closePath();
        ctx.fillStyle = p.orange;
        ctx.fill();
        // Inner plume
        ctx.beginPath();
        ctx.moveTo(ex - 2, 32);
        ctx.lineTo(ex, 44 + Math.random() * 8);
        ctx.lineTo(ex + 2, 32);
        ctx.closePath();
        ctx.fillStyle = p.amber;
        ctx.fill();
      }
    }

    ctx.lineWidth = 2;

    if (isBoosterPhase) {
      // ── New Glenn full stack: tall first stage + second stage + fairing ──
      // First stage body (tall cylinder)
      ctx.fillStyle = blue;
      ctx.strokeStyle = blueAccent;
      ctx.beginPath();
      ctx.moveTo(-14, 30);   // Engine base
      ctx.lineTo(-14, -8);   // Top of first stage
      ctx.lineTo(14, -8);
      ctx.lineTo(14, 30);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Interstage ring
      ctx.fillStyle = blueLight;
      ctx.fillRect(-15, -10, 30, 4);
      ctx.strokeRect(-15, -10, 30, 4);

      // Second stage (shorter, slightly narrower)
      ctx.fillStyle = blue;
      ctx.beginPath();
      ctx.moveTo(-12, -10);
      ctx.lineTo(-12, -28);
      ctx.lineTo(12, -28);
      ctx.lineTo(12, -10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Payload fairing (ogive nose)
      ctx.fillStyle = "rgba(220, 230, 245, 0.92)";
      ctx.strokeStyle = blueAccent;
      ctx.beginPath();
      ctx.moveTo(-12, -28);
      ctx.quadraticCurveTo(-12, -42, 0, -50);
      ctx.quadraticCurveTo(12, -42, 12, -28);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Blue Origin feather logo on fairing
      ctx.strokeStyle = blueAccent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -48);
      ctx.lineTo(-4, -36);
      ctx.moveTo(0, -48);
      ctx.lineTo(4, -36);
      ctx.moveTo(0, -48);
      ctx.lineTo(0, -36);
      ctx.stroke();

      // "BO" on Stage 1 body
      ctx.fillStyle = blueAccent;
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "center";
      ctx.fillText("BO", 0, 6);
      ctx.textAlign = "left";

      // Engine bells (7-engine cluster dots)
      ctx.fillStyle = "#333";
      const bellPositions = [[0, 0], [-5, -3], [5, -3], [-5, 3], [5, 3], [-9, 0], [9, 0]];
      bellPositions.forEach(([bx, by]) => {
        ctx.beginPath();
        ctx.arc(bx, 30 + by * 0.3, 2.2, 0, Math.PI * 2);
        ctx.fill();
      });

      // Grid fins (New Glenn has them)
      ctx.strokeStyle = blueAccent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-14, 22);
      ctx.lineTo(-20, 28);
      ctx.moveTo(-14, 24);
      ctx.lineTo(-20, 30);
      ctx.moveTo(14, 22);
      ctx.lineTo(20, 28);
      ctx.moveTo(14, 24);
      ctx.lineTo(20, 30);
      ctx.stroke();
    } else if (runtime.phase === PHASE.ORBIT) {
      // ── Stage 2 only (LEO insertion) — 2× BE-3U, LOX/LH2 ──
      ctx.fillStyle = blue;
      ctx.strokeStyle = blueAccent;
      ctx.lineWidth = 2;

      // Stage 2 body
      ctx.beginPath();
      ctx.moveTo(-12, 20);
      ctx.lineTo(-12, -10);
      ctx.lineTo(12, -10);
      ctx.lineTo(12, 20);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Payload fairing (Stage 3 inside)
      ctx.fillStyle = "rgba(220, 230, 245, 0.92)";
      ctx.beginPath();
      ctx.moveTo(-12, -10);
      ctx.quadraticCurveTo(-12, -26, 0, -32);
      ctx.quadraticCurveTo(12, -26, 12, -10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // "S2" label
      ctx.fillStyle = blueAccent;
      ctx.font = "bold 7px monospace";
      ctx.textAlign = "center";
      ctx.fillText("S2", 0, 8);
      ctx.textAlign = "left";

      // 2× BE-3U engines
      ctx.fillStyle = "#333";
      ctx.beginPath(); ctx.arc(-4, 20, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(4, 20, 2.5, 0, Math.PI * 2); ctx.fill();
    } else {
      // ── Stage 3: Payload spacecraft (post-TLI) ──
      ctx.fillStyle = "#c8d0d8";
      ctx.strokeStyle = blueAccent;
      ctx.lineWidth = 1.5;

      // Payload bus body
      ctx.fillRect(-8, -6, 16, 18);
      ctx.strokeRect(-8, -6, 16, 18);

      // Solar panels (deployed)
      ctx.fillStyle = "#1a3a6a";
      ctx.fillRect(-22, -2, 13, 8);
      ctx.fillRect(9, -2, 13, 8);
      // Panel lines
      ctx.strokeStyle = "#2a4a8a";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(-15, -2); ctx.lineTo(-15, 6);
      ctx.moveTo(15, -2); ctx.lineTo(15, 6);
      ctx.stroke();

      // Laser cannon (mounted on nose)
      ctx.fillStyle = "#e04040";
      ctx.fillRect(-2, -10, 4, 5);
      // Laser barrel
      ctx.fillStyle = "#ff6060";
      ctx.fillRect(-1, -13, 2, 4);

      // RCS thrusters
      ctx.fillStyle = "#888";
      ctx.fillRect(-10, 2, 3, 2);
      ctx.fillRect(7, 2, 3, 2);

      // Landing legs (extended in lunar phase)
      if (runtime.phase === PHASE.LUNAR) {
        ctx.strokeStyle = FTL.green;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-8, 10); ctx.lineTo(-16, 18); ctx.lineTo(-5, 18);
        ctx.moveTo(8, 10); ctx.lineTo(16, 18); ctx.lineTo(5, 18);
        ctx.stroke();
      }

      // Main engine
      ctx.fillStyle = "#333";
      ctx.beginPath(); ctx.arc(0, 12, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    ctx.restore();
  }

  function drawParticles() {
    runtime.particles.forEach((particle) => {
      const { x, y } = worldToScreen(particle.x, particle.y);
      const alpha = 1 - particle.age / particle.life;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      const sz = Math.floor(2 + alpha * 3);
      ctx.fillRect(Math.floor(x), Math.floor(y), sz, sz);
    });
    ctx.globalAlpha = 1;
  }

  function drawHud(p) {
    const ship = runtime.ship;
    const earthR = distToEarth(ship.x, ship.y);
    const moonR = distToMoon(ship.x, ship.y);
    const earthAlt = (earthR - EARTH_RADIUS) * 25; // km
    const moonAlt = (moonR - MOON_RADIUS) * 25;    // km
    const speed = Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy);
    const orbitalV = speed * 25; // scale to km/s
    const font = "11px JetBrains Mono, monospace";

    // ── Left panel: orbital data ──
    const lw = 252, lh = 236;
    ctx.fillStyle = FTL.panel;
    ctx.fillRect(14, 14, lw, lh);
    ctx.strokeStyle = FTL.panelBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(14, 14, lw, lh);
    // Header bar
    ctx.fillStyle = FTL.blue;
    ctx.fillRect(15, 15, lw - 2, 18);

    ctx.fillStyle = FTL.textBright;
    ctx.font = "10px JetBrains Mono, monospace";
    ctx.fillText("ORBITAL MECHANICS", 26, 28);
    ctx.font = font;
    const phaseNames = {
      1: "LAUNCH · 7× BE-4 · LOX/LNG",
      2: "STAGE SEPARATION",
      3: "LEO · 2× BE-3U · LOX/LH2",
      4: "TLI · COAST · N2H4 RCS",
      5: "LOI · LUNAR DESCENT",
    };
    ctx.fillStyle = FTL.yellow;
    ctx.fillText(phaseNames[runtime.phase] || "---", 26, 48);

    ctx.fillStyle = FTL.text;
    let ly = 64;
    const row = (label, val) => { ctx.fillText(`${label} ${val}`, 26, ly); ly += 14; };

    // Stage info
    const stageInfo = runtime.phase <= 2 ? "S1: LOX/LNG · 3,740t"
      : runtime.phase === 3 ? "S2: LOX/LH2 · 80t"
      : "S3: N2H4 · 2.4t";
    ctx.fillStyle = FTL.textDim;
    ctx.fillText(stageInfo, 26, ly); ly += 16;

    ctx.fillStyle = FTL.text;
    row("ALT(E)", `${Math.max(0, earthAlt).toFixed(0).padStart(7, " ")} km`);
    row("ALT(L)", `${Math.max(0, moonAlt).toFixed(0).padStart(7, " ")} km`);
    row("V    ", `${orbitalV.toFixed(1).padStart(7, " ")} km/s`);
    row("ΔV   ", `${(runtime.deltaV * 25).toFixed(0).padStart(7, " ")} m/s`);
    row("Pe   ", `${runtime.periapsis.toFixed(0).padStart(7, " ")} km`);
    row("Ap   ", `${runtime.apoapsis.toFixed(0).padStart(7, " ")} km`);
    row("SCORE", `${String(runtime.score).padStart(7, " ")} pts`);
    row("COMBO", `x${runtime.combo.toFixed(1).padStart(6, " ")}`);

    // Fuel bar
    ly += 4;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(26, ly, 198, 8);
    const fuelPct = clamp(ship.fuel, 0, 100) / 100;
    ctx.fillStyle = ship.fuel > 45 ? FTL.green : ship.fuel > 20 ? FTL.yellow : FTL.red;
    ctx.fillRect(26, ly, 198 * fuelPct, 8);
    ctx.fillStyle = FTL.text;
    ctx.fillText(`PROP ${Math.round(runtime.propMass)}t  ${Math.round(ship.fuel)}%`, 26, ly + 18);
    const hullY = ly + 30;
    ctx.fillStyle = FTL.textDim;
    ctx.fillText("HULL", 26, hullY);
    for (let i = 0; i < runtime.maxHull; i += 1) {
      ctx.fillStyle = i < runtime.hull ? FTL.green : "rgba(255,255,255,0.08)";
      ctx.fillRect(64 + i * 18, hullY - 8, 12, 8);
    }

    // ── Right panel: subsystems + gators ──
    const rw = 220, rh = 180, rx = runtime.width - rw - 14;
    ctx.fillStyle = FTL.panel;
    ctx.fillRect(rx, 14, rw, rh);
    ctx.strokeStyle = FTL.panelBorder;
    ctx.strokeRect(rx, 14, rw, rh);
    ctx.fillStyle = FTL.blue;
    ctx.fillRect(rx + 1, 15, rw - 2, 18);

    ctx.fillStyle = FTL.textBright;
    ctx.font = "10px JetBrains Mono, monospace";
    ctx.fillText("SUBSYSTEMS", rx + 12, 28);
    ctx.font = font;

    const subsystems = [
      { name: "ENGINES", pct: ship.fuel, thresh: 30 },
      { name: "PROPELLANT", pct: runtime.propMass, thresh: 25 },
      { name: "GUIDANCE", pct: runtime.phase >= PHASE.TRANSIT ? 100 : 60, thresh: 0 },
      { name: "WEAPONS", pct: runtime.gators.length ? (runtime.gatorsKilled / Math.max(1, runtime.gatorsTotal)) * 100 : 100, thresh: 0 },
    ];
    let sy = 48;
    subsystems.forEach(s => {
      const barW = 80, barH = 6;
      const fill = clamp(s.pct, 0, 100) / 100;
      ctx.fillStyle = FTL.textDim;
      ctx.fillText(s.name, rx + 12, sy);
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(rx + 100, sy - 7, barW, barH);
      ctx.fillStyle = s.pct > s.thresh ? FTL.green : FTL.red;
      ctx.fillRect(rx + 100, sy - 7, barW * fill, barH);
      ctx.fillStyle = FTL.text;
      ctx.fillText(`${Math.round(s.pct)}%`, rx + 186, sy);
      sy += 16;
    });

    // Aero data (launch/separation only)
    if (runtime.phase <= 2) {
      sy += 4;
      ctx.fillStyle = FTL.yellow;
      ctx.font = "10px JetBrains Mono, monospace";
      ctx.fillText("AERODYNAMICS", rx + 12, sy);
      ctx.font = font;
      sy += 14;
      ctx.fillStyle = runtime.currentQ > runtime.maxQ * 0.9 && runtime.currentQ > 20 ? FTL.red : FTL.text;
      ctx.fillText(`Q ${runtime.currentQ.toFixed(0).padStart(5)} Pa`, rx + 12, sy);
      ctx.fillStyle = FTL.text;
      ctx.fillText(`MAX ${runtime.maxQ.toFixed(0).padStart(4)} Pa`, rx + 125, sy);
    }

    // Gator tracker
    if (runtime.gatorsTotal > 0) {
      sy += 18;
      const alive = runtime.gators.filter(g => g.alive).length;
      ctx.fillStyle = alive > 0 ? FTL.red : FTL.green;
      ctx.font = "10px JetBrains Mono, monospace";
      ctx.fillText("HOSTILES", rx + 12, sy);
      ctx.font = font;
      ctx.fillStyle = alive > 0 ? FTL.orange : FTL.green;
      ctx.fillText(`${runtime.gatorsKilled}/${runtime.gatorsTotal}`, rx + 80, sy);
      if (alive === 0) {
        ctx.fillStyle = FTL.green;
        ctx.fillText("CLEAR", rx + 120, sy);
      }
    }

    // Mini-map
    const mapW = 132, mapH = 132, mapX = rx + rw - mapW - 12, mapY = rh - mapH + 50;
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(mapX, mapY, mapW, mapH);
    ctx.strokeStyle = FTL.panelBorder;
    ctx.strokeRect(mapX, mapY, mapW, mapH);
    ctx.fillStyle = FTL.textDim;
    ctx.font = "9px JetBrains Mono, monospace";
    ctx.fillText("CISLUNAR MAP", mapX + 8, mapY + 12);

    const mapPad = 14;
    const mapInnerH = mapH - 28;
    const mapScale = (mapInnerH - 8) / (MOON_DIST + MOON_RADIUS * 2);
    const mx = mapX + mapW * 0.5;
    const earthMy = mapY + mapH - mapPad - EARTH_RADIUS * mapScale;
    const moonMy = earthMy - MOON_DIST * mapScale;
    ctx.fillStyle = "#18457b";
    ctx.fillRect(Math.floor(mx - EARTH_RADIUS * mapScale), Math.floor(earthMy - EARTH_RADIUS * mapScale), Math.max(4, Math.floor(EARTH_RADIUS * 2 * mapScale)), Math.max(4, Math.floor(EARTH_RADIUS * 2 * mapScale)));
    ctx.fillStyle = "#575d69";
    ctx.fillRect(Math.floor(mx - MOON_RADIUS * mapScale), Math.floor(moonMy - MOON_RADIUS * mapScale), Math.max(3, Math.floor(MOON_RADIUS * 2 * mapScale)), Math.max(3, Math.floor(MOON_RADIUS * 2 * mapScale)));
    const shipMapX = mx + ship.x * mapScale;
    const shipMapY = earthMy - ship.y * mapScale;
    ctx.fillStyle = runtime.phase >= PHASE.LUNAR ? FTL.green : FTL.cyan;
    ctx.fillRect(Math.floor(shipMapX) - 1, Math.floor(shipMapY) - 1, 3, 3);
    ctx.strokeStyle = withAlpha(FTL.blueLight, 0.3);
    ctx.beginPath();
    ctx.moveTo(mx, earthMy);
    ctx.lineTo(mx, moonMy);
    ctx.stroke();

    // Objective + mission status bars
    ctx.fillStyle = FTL.panel;
    ctx.fillRect(14, runtime.height - 78, runtime.width - 28, 26);
    ctx.strokeStyle = FTL.panelBorder;
    ctx.strokeRect(14, runtime.height - 78, runtime.width - 28, 26);
    ctx.fillStyle = FTL.yellow;
    ctx.font = "10px JetBrains Mono, monospace";
    wrapCanvasText(`OBJECTIVE · ${runtime.objective}`, 26, runtime.height - 61, runtime.width - 52, 13);

    ctx.fillStyle = FTL.panel;
    ctx.fillRect(14, runtime.height - 44, runtime.width - 28, 30);
    ctx.strokeStyle = FTL.panelBorder;
    ctx.strokeRect(14, runtime.height - 44, runtime.width - 28, 30);
    ctx.fillStyle = FTL.textDim;
    ctx.font = font;
    wrapCanvasText(runtime.statusLine, 26, runtime.height - 26, runtime.width - 52, 14);

    // Separation / staging alert
    if (runtime.phase === PHASE.SEPARATION) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
      ctx.fillStyle = `rgba(212, 168, 40, ${0.2 + pulse * 0.4})`;
      const alertW = 340, alertH = 34;
      ctx.fillRect(runtime.width * 0.5 - alertW / 2, 14, alertW, alertH);
      ctx.strokeStyle = FTL.yellow;
      ctx.lineWidth = 2;
      ctx.strokeRect(runtime.width * 0.5 - alertW / 2, 14, alertW, alertH);
      ctx.fillStyle = "#111";
      ctx.font = "13px JetBrains Mono, monospace";
      ctx.textAlign = "center";
      ctx.fillText(`STAGE 1 SEPARATION  [${runtime.boosterTimer.toFixed(1)}s]`, runtime.width * 0.5, 36);
      ctx.textAlign = "left";
    }
  }

  function wrapCanvasText(text, x, y, maxWidth, lineHeight) {
    const words = `${text || ""}`.split(/\s+/).filter(Boolean);
    let line = "";
    let lineY = y;
    words.forEach((word) => {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        ctx.fillText(line, x, lineY);
        line = word;
        lineY += lineHeight;
      } else {
        line = next;
      }
    });
    if (line) ctx.fillText(line, x, lineY);
  }

  function drawTrajectory() {
    // Past trail
    if (runtime.trail.length > 1) {
      ctx.strokeStyle = "rgba(72, 200, 232, 0.2)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      const p0 = worldToScreen(runtime.trail[0].x, runtime.trail[0].y);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < runtime.trail.length; i++) {
        const pt = worldToScreen(runtime.trail[i].x, runtime.trail[i].y);
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
    }

    // Predicted trajectory (dotted line)
    if (runtime.mode === STATE.PLAYING && runtime.ship) {
      const pred = predictTrajectory(
        runtime.ship.x, runtime.ship.y,
        runtime.ship.vx, runtime.ship.vy,
        300, 0.1
      );
      ctx.fillStyle = "rgba(72, 200, 232, 0.12)";
      pred.forEach(pt => {
        const s = worldToScreen(pt.x, pt.y);
        ctx.fillRect(Math.floor(s.x), Math.floor(s.y), 2, 2);
      });
    }
  }

  function drawScanlines() {
    ctx.fillStyle = "rgba(0, 0, 0, 0.06)";
    for (let y = 0; y < runtime.height; y += 3) {
      ctx.fillRect(0, y, runtime.width, 1);
    }
  }

  function drawVignette() {
    const grd = ctx.createRadialGradient(
      runtime.width * 0.5, runtime.height * 0.5, runtime.height * 0.3,
      runtime.width * 0.5, runtime.height * 0.5, runtime.height * 0.9
    );
    grd.addColorStop(0, "rgba(0,0,0,0)");
    grd.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, runtime.width, runtime.height);
  }

  function drawFrame() {
    resizeCanvas();
    pixelMode(true);
    const p = palette();

    const shakeX = runtime.shake ? (Math.random() - 0.5) * runtime.shake : 0;
    const shakeY = runtime.shake ? (Math.random() - 0.5) * runtime.shake : 0;
    ctx.save();
    ctx.translate(shakeX, shakeY);

    // FTL deep space background
    ctx.fillStyle = FTL.bg;
    ctx.fillRect(0, 0, runtime.width, runtime.height);

    drawNebula(p);
    drawStars(p);
    drawEarth(p);
    drawMoonBody(p);
    drawTrajectory();

    if (runtime.booster?.active) {
      drawRocketBody({
        x: runtime.booster.x,
        y: runtime.booster.y,
        angle: 0,
      }, true, false, p, runtime.booster.spin);
    }

    const thrusterOn = runtime.mode === STATE.PLAYING && input.up && runtime.ship.fuel > 0;
    const isFullStack = runtime.phase <= PHASE.SEPARATION;
    const isStage2 = runtime.phase === PHASE.ORBIT;
    drawRocketBody(runtime.ship, isFullStack || isStage2, thrusterOn, p);
    drawGators();
    drawLasers();
    drawParticles();

    // FTL-style overlay effects
    drawVignette();
    drawScanlines();

    drawHud(p);
    ctx.restore();

    if (runtime.flash > 0.01) {
      ctx.fillStyle = withAlpha(p.text, runtime.flash * 0.16);
      ctx.fillRect(0, 0, runtime.width, runtime.height);
    }

    if (runtime.mode !== STATE.PLAYING) {
      // FTL-style modal panel
      const panX = Math.floor(runtime.width * 0.15);
      const panY = Math.floor(runtime.height * 0.22);
      const panW = Math.floor(runtime.width * 0.7);
      const panH = Math.floor(runtime.height * 0.32);

      // Panel background with double border (FTL style)
      ctx.fillStyle = FTL.panel;
      ctx.fillRect(panX, panY, panW, panH);
      // Outer border
      ctx.strokeStyle = runtime.mode === STATE.SUCCESS ? FTL.green
        : runtime.mode === STATE.GAME_OVER ? FTL.red : FTL.panelBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(panX, panY, panW, panH);
      // Inner border highlight
      ctx.strokeStyle = FTL.panelHighlight;
      ctx.lineWidth = 1;
      ctx.strokeRect(panX + 3, panY + 3, panW - 6, panH - 6);

      // Header bar
      const hdrColor = runtime.mode === STATE.SUCCESS ? FTL.green
        : runtime.mode === STATE.GAME_OVER ? FTL.red : FTL.blue;
      ctx.fillStyle = hdrColor;
      ctx.fillRect(panX + 1, panY + 1, panW - 2, 28);

      ctx.textAlign = "center";
      ctx.fillStyle = FTL.textBright;
      ctx.font = "700 18px JetBrains Mono, monospace";
      const title = runtime.mode === STATE.SUCCESS
        ? "TOUCHDOWN CONFIRMED"
        : runtime.mode === STATE.GAME_OVER
          ? "MISSION LOST"
          : "G A T O R N A U T S";
      ctx.fillText(title, runtime.width * 0.5, panY + 20);

      // Subtitle
      ctx.font = "11px JetBrains Mono, monospace";
      ctx.fillStyle = FTL.text;
      wrapCanvasText(runtime.message, panX + 24, panY + 52, panW - 48, 16);

      // Best run summary + action prompt
      ctx.fillStyle = FTL.textDim;
      ctx.font = "10px JetBrains Mono, monospace";
      const bestLine = runtime.bestKills
        ? `BEST RUN  ${runtime.bestKills} GATORS${runtime.bestLandingSpeed != null ? ` · ${runtime.bestLandingSpeed.toFixed(1)} M/S` : ""}`
        : "BEST RUN  NONE YET";
      ctx.fillText(bestLine, runtime.width * 0.5, panY + panH - 52);
      const extra = runtime.mode === STATE.START_SCREEN
        ? "3 HULL · COMBO SCORING · BONUS FOR CLEAN TOUCHDOWN"
        : `FINAL SCORE ${runtime.score} · HULL ${runtime.hull}/${runtime.maxHull}`;
      ctx.fillText(extra, runtime.width * 0.5, panY + panH - 34);
      const prompt = runtime.mode === STATE.START_SCREEN
        ? "[ ENTER / TAP RESTART TO LAUNCH ]"
        : "[ ENTER / RESTART TO FLY AGAIN ]";
      ctx.fillText(prompt, runtime.width * 0.5, panY + panH - 16);
      ctx.textAlign = "left";
    }
  }

  function loop(ts) {
    if (!runtime.open) return;
    const dt = clamp((ts - (runtime.lastTs || ts)) / 1000, 0.008, 0.033);
    runtime.lastTs = ts;
    updateMission(dt);
    drawFrame();
    runtime.rafId = requestAnimationFrame(loop);
  }

  function normalizedKey(key) {
    return `${key || ""}`.toLowerCase();
  }

  function feedUnlockSequence(key) {
    runtime.unlockBuffer.push(key);
    if (runtime.unlockBuffer.length > SECRET_SEQUENCE.length) runtime.unlockBuffer.shift();
    const matches = SECRET_SEQUENCE.every((token, index) => runtime.unlockBuffer[index] === token);
    if (matches) {
      runtime.unlockBuffer = [];
      open();
    }
  }

  function isTextInputTarget(target) {
    const tag = target?.tagName?.toLowerCase();
    return tag === "input" || tag === "textarea" || target?.isContentEditable;
  }

  function handleKeyDown(event) {
    const key = normalizedKey(event.key);
    if (!runtime.open) {
      if (!isTextInputTarget(event.target)) feedUnlockSequence(key);
      return;
    }

    if (["arrowup", "arrowleft", "arrowright", " ", "space", "enter", "escape", "r"].includes(key)) {
      event.preventDefault();
    }

    if (key === "escape") {
      close();
      return;
    }

    if (key === "r") {
      startPlaying();
      return;
    }

    if (runtime.mode !== STATE.PLAYING && (key === "enter" || key === " ")) {
      startPlaying();
      return;
    }

    if (key === "arrowup") input.up = true;
    if (key === "arrowleft") input.left = true;
    if (key === "arrowright") input.right = true;
    if (key === " " || key === "spacebar") input.detachPressed = true;
  }

  function handleKeyUp(event) {
    const key = normalizedKey(event.key);
    if (key === "arrowup") input.up = false;
    if (key === "arrowleft") input.left = false;
    if (key === "arrowright") input.right = false;
  }

  function bindTouchControls() {
    mobileControls?.querySelectorAll("[data-trajectory-action]").forEach((button) => {
      const action = button.dataset.trajectoryAction;
      const setAction = (pressed) => {
        if (action === "up") input.up = pressed;
        if (action === "left") input.left = pressed;
        if (action === "right") input.right = pressed;
        if (action === "detach" && pressed) input.detachPressed = true;
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
        if (runtime.mode !== STATE.PLAYING && action === "up") {
          startPlaying();
        }
        setAction(true);
      });
      button.addEventListener("pointerup", (event) => {
        releasePointer(event.pointerId);
      });
      button.addEventListener("pointercancel", (event) => {
        releasePointer(event.pointerId);
      });
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
    loadBestRun();
    resetMission();
    bindThemeTapUnlock();
    bindTouchControls();
    closeBtn?.addEventListener("click", close);
    $("trajectory-close-x")?.addEventListener("click", close);
    $("trajectory-launch-btn")?.addEventListener("click", open);
    restartBtn?.addEventListener("click", () => {
      startPlaying();
    });
    $("trajectory-backdrop")?.addEventListener("click", close);
    window.addEventListener("resize", () => {
      if (runtime.open) drawFrame();
    });
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
renderDadabase();
ensureDadabase(false);
loadMelodyBank()
  .then(() => {
    renderMelodyLibrary(lastData);
  })
  .catch(() => {});
startSniffStream();
setInterval(fetchLatest, POLL_MS);
setInterval(fetchHistory, POLL_MS * 8);
setInterval(fetchSniffHistory, POLL_MS * 4);
setInterval(tickAge, 1000);
setInterval(() => ensureDadabase(false), DADABASE_TTL_MS);
setInterval(() => renderDadabase(), 60000);

$("melody-play-btn")?.addEventListener("click", () => {
  playMelodyFromSnapshot();
});

$("manual-refresh-btn")?.addEventListener("click", () => {
  manualRefreshDashboard();
});

$("dadabase-refresh-btn")?.addEventListener("click", async () => {
  await ensureDadabase(true);
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

$("remote-owner-save-btn")?.addEventListener("click", () => {
  const field = $("remote-owner-key");
  const key = `${field?.value || ""}`.trim();
  if (!key) {
    setRemoteControlsState("Enter the owner key, then unlock this tab for remote actions.", "neutral");
    return;
  }
  saveOwnerKey(key);
  syncRemoteControlsUi();
});

$("remote-owner-clear-btn")?.addEventListener("click", () => {
  clearOwnerKey();
  syncRemoteControlsUi();
});

$("theme-retro-toggle")?.addEventListener("change", (event) => {
  applyTheme(event.target.checked ? "retro90s" : "obsidian");
});

document.querySelectorAll(".remote-action-btn").forEach((button) => {
  button.addEventListener("click", () => {
    queueRemoteAction(button.dataset.remoteAction || "");
  });
});

$("dadabase-search")?.addEventListener("input", (event) => {
  dadabaseQuery = event.target.value || "";
  renderDadabase();
});

$("melody-library-search")?.addEventListener("input", (event) => {
  melodyLibraryState.query = `${event.target.value || ""}`;
  renderMelodyLibrary(lastData);
});

$("melody-library-filters")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-melody-filter]");
  if (!button) return;
  melodyLibraryState.category = button.dataset.melodyFilter || "all";
  renderMelodyLibrary(lastData);
});

$("melody-library-play-selected")?.addEventListener("click", async () => {
  const selected = melodyBankData?.byTitle.get(melodyLibraryState.selectedTitle);
  if (!selected) return;
  setMelodyLibrarySelection(selected.title);
  await playMelodyByTitle(selected.title, { source: "library" });
  renderMelodyLibrary(lastData);
});

$("melody-library-play-device")?.addEventListener("click", async () => {
  const selected = selectedMelodyItem();
  if (!selected) return;
  setMelodyLibrarySelection(selected.title);
  await queueRemoteAction("play_melody", { melodyKey: selected.key });
  renderMelodyLibrary(lastData);
});

document.querySelectorAll(".map-layer-chip").forEach((button) => {
  button.addEventListener("click", async () => {
    const key = button.dataset.layer;
    if (!key) return;
    mapLayerPrefs[key] = !mapLayerPrefs[key];
    if (key === "crime") {
      renderMapLayerButtons();
      setMapLayerStatus("Crime toggle acknowledged, but no free anonymous nationwide U.S. crime map feed is wired into this dashboard yet.");
      return;
    }
    saveMapLayerPrefs();
    renderMapLayerButtons();
    await syncMapLayers();
  });
});

window.addEventListener("resize", () => {
  if (historyData.length) drawChart(historyData);
});

window.addEventListener("pagehide", () => {
  stopMelodyPlayback();
});

syncRemoteControlsUi();

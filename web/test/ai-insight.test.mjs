import test from "node:test";
import assert from "node:assert/strict";
import {
  aiInsightFacts,
  aiInsightCacheKey,
  generateAiInsight,
  fallbackInsight,
  resolveInsightCache,
  sanitizeInsightText,
  AI_INSIGHT_MIN_INTERVAL_MS,
  AI_INSIGHT_BREACH_FLOOR_MS,
} from "../lib/aiInsight.js";

const now = Date.now();

// 24 h of 10-minute samples, flat and calm.
function flatSeries({ co2 = 700, iaq = 55, humidity = 49 } = {}) {
  const t = [];
  const c = [];
  const q = [];
  const h = [];
  for (let i = 143; i >= 0; i--) {
    t.push(now - i * 600000);
    c.push(co2);
    q.push(iaq);
    h.push(humidity);
  }
  return { t, co2: c, iaq: q, humidity: h };
}

// Same shape, but CO2 ramps 700 → ~1420 over the last hour.
function risingSeries() {
  const s = flatSeries();
  for (let i = 0; i < s.t.length; i++) {
    const minsAgo = (now - s.t[i]) / 60000;
    if (minsAgo <= 60) s.co2[i] = 700 + (60 - minsAgo) * 12;
  }
  return s;
}

function homeFixture({ series = flatSeries(), co2 = 700, iaq = 55, humidity = 49, outlookItems = [] } = {}) {
  return {
    score: {
      value: 82,
      grade: "Good",
      drivers: [{ key: "ventilation", label: "Ventilation (CO₂)", score: 70 }],
    },
    climate: { tempF: 72, humidity, dewPointC: 10 },
    gases: { iaq, co2, bvoc: 0.5 },
    particulate: { pm25: 5 },
    biological: { mold: { category: "Low" }, dustMite: { category: "Low" } },
    outdoor: { usAqi: 37 },
    smell: { smellsBad: false, headline: "Air smells fresh." },
    outlook: { level: "Low", items: outlookItems },
    ventilation: { action: "none", text: "No ventilation needed right now." },
    petAllergen: { index: 10, level: "Low" },
    series,
  };
}

function latestFixture(extra = {}) {
  return { receivedAt: now, iaqAcc: 3, tempF: 72, humidity: 49, co2: 700, iaq: 55, gasR: 180000, ...extra };
}

const homeSettings = { environmentType: "home" };

test("facts assemble score, environment, triggers with severity, and steady air", () => {
  const f = aiInsightFacts(homeFixture(), latestFixture(), homeSettings, "cat,pollen", "cat:severe", { nowMs: now });
  assert.equal(f.score, 82);
  assert.equal(f.environment, "home");
  assert.deepEqual(f.triggers, [
    { key: "cat", severity: "severe" },
    { key: "pollen", severity: "moderate" },
  ]);
  assert.equal(f.indoor.co2, 700);
  assert.equal(f.steady, true);
  assert.equal(f.sensorCalibrated, true);
  assert.deepEqual(f.breaches, []);
});

test("facts include real breaches from the effective thresholds", () => {
  const f = aiInsightFacts(
    homeFixture({ co2: 1300, iaq: 160 }),
    latestFixture({ co2: 1300, iaq: 160 }),
    homeSettings,
    "",
    "",
    { nowMs: now }
  );
  const keys = f.breaches.map((b) => b.key);
  assert.ok(keys.includes("co2"), JSON.stringify(f.breaches));
  assert.ok(keys.includes("iaq"), JSON.stringify(f.breaches));
  // Breach labels come from the threshold engine, never invented here.
  assert.ok(f.breaches.every((b) => b.label && b.level));
});

test("facts surface a severe trigger only when its outlook rank is elevated", () => {
  const items = [{ key: "cat", label: "Cat allergen", level: "High", rank: 3, severity: "severe" }];
  const f = aiInsightFacts(homeFixture({ outlookItems: items }), latestFixture(), homeSettings, "cat", "cat:severe", { nowMs: now });
  assert.equal(f.topTriggers.length, 1);
  assert.equal(f.topTriggers[0].key, "cat");
  assert.equal(f.topTriggers[0].severity, "severe");
  const calm = aiInsightFacts(homeFixture(), latestFixture(), homeSettings, "cat", "cat:severe", { nowMs: now });
  assert.equal(calm.topTriggers.length, 0);
});

test("steady flips to false when CO2 climbs in the last hour", () => {
  const calm = aiInsightFacts(homeFixture(), latestFixture(), homeSettings, "", "", { nowMs: now });
  assert.equal(calm.steady, true);
  assert.equal(calm.trends.co2, "stable");
  const rising = aiInsightFacts(homeFixture({ series: risingSeries() }), latestFixture(), homeSettings, "", "", { nowMs: now });
  assert.equal(rising.steady, false);
  assert.equal(rising.trends.co2, "rising");
});

test("cache key is stable under small wiggles, changes on breach, steady flip, or trigger shift", () => {
  const base = aiInsightFacts(homeFixture(), latestFixture(), homeSettings, "cat", "", { nowMs: now });
  const key = aiInsightCacheKey(base);
  const wiggle = aiInsightFacts(homeFixture({ co2: 710 }), latestFixture({ co2: 710 }), homeSettings, "cat", "", { nowMs: now });
  assert.equal(aiInsightCacheKey(wiggle), key);
  const breached = aiInsightFacts(homeFixture({ co2: 1300 }), latestFixture({ co2: 1300 }), homeSettings, "cat", "", { nowMs: now });
  assert.notEqual(aiInsightCacheKey(breached), key);
  const rising = aiInsightFacts(homeFixture({ series: risingSeries() }), latestFixture(), homeSettings, "cat", "", { nowMs: now });
  assert.notEqual(aiInsightCacheKey(rising), key);
  const items = [{ key: "cat", label: "Cat allergen", level: "High", rank: 3, severity: "severe" }];
  const trig = aiInsightFacts(homeFixture({ outlookItems: items }), latestFixture(), homeSettings, "cat", "cat:severe", { nowMs: now });
  assert.notEqual(aiInsightCacheKey(trig), key);
});

test("generateAiInsight calls OpenAI with the facts and returns cleaned text", async () => {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    let seen;
    const fetchFn = async (url, opts) => {
      seen = { url, opts };
      return { ok: true, json: async () => ({ output_text: "  Air is fine, focus away.  " }) };
    };
    const f = aiInsightFacts(homeFixture(), latestFixture(), homeSettings, "", "", { nowMs: now });
    const text = await generateAiInsight(f, { fetchFn });
    assert.equal(text, "Air is fine, focus away.");
    assert.equal(seen.url, "https://api.openai.com/v1/responses");
    assert.match(seen.opts.headers.Authorization, /^Bearer sk-test$/);
    const body = JSON.parse(seen.opts.body);
    assert.match(body.input, /700/); // the real CO2 reading rides along
    assert.doesNotMatch(body.input, /sk-test/); // the key never goes in the prompt
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test("generateAiInsight returns null without a key and never calls fetch", async () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    let calls = 0;
    const f = aiInsightFacts(homeFixture(), latestFixture(), homeSettings, "", "", { nowMs: now });
    const text = await generateAiInsight(f, { fetchFn: async () => { calls++; return { ok: true, json: async () => ({}) }; } });
    assert.equal(text, null);
    assert.equal(calls, 0);
  } finally {
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  }
});

test("generateAiInsight returns null when the API fails", async () => {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    const f = aiInsightFacts(homeFixture(), latestFixture(), homeSettings, "", "", { nowMs: now });
    assert.equal(await generateAiInsight(f, { fetchFn: async () => ({ ok: false, status: 429 }) }), null);
    assert.equal(await generateAiInsight(f, { fetchFn: async () => { throw new Error("boom"); } }), null);
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test("sanitizer strips markdown and AI self-reference", () => {
  assert.equal(sanitizeInsightText("**Great air!** As an AI, I think it's fine."), "Great air! I think it's fine.");
});

test("fallback names the real breach and one practical move", () => {
  const f = aiInsightFacts(
    homeFixture({ co2: 1300, iaq: 55 }),
    latestFixture({ co2: 1300, iaq: 55 }),
    homeSettings,
    "",
    "",
    { nowMs: now }
  );
  assert.deepEqual(f.breaches.map((b) => b.key), ["co2"]);
  const text = fallbackInsight(f);
  assert.match(text, /1,300 ppm/);
  assert.match(text, /window/i);
  assert.doesNotMatch(text, /\b(AI|GPT|model)\b/i);
});

test("fallback mentions a severe trigger running high, and stays calm when air is settled", () => {
  const items = [{ key: "cat", label: "Cat allergen", level: "High", rank: 3, severity: "severe" }];
  const f = aiInsightFacts(homeFixture({ outlookItems: items }), latestFixture(), homeSettings, "cat", "cat:severe", { nowMs: now });
  assert.match(fallbackInsight(f), /cat allergen/i);
  const calm = aiInsightFacts(homeFixture(), latestFixture(), homeSettings, "", "", { nowMs: now });
  assert.match(fallbackInsight(calm), /settled and in good shape/);
});

test("resolveInsightCache: per-state hit wins, recent last is reused, old last regenerates", () => {
  const last = { mode: "openai", generatedAt: now - 60 * 1000, breaches: [] };
  assert.equal(resolveInsightCache({ perState: { text: "x" }, last, breaches: [], nowMs: now }), "per-state");
  assert.equal(resolveInsightCache({ perState: null, last, breaches: [], nowMs: now }), "last");
  const old = { mode: "openai", generatedAt: now - AI_INSIGHT_MIN_INTERVAL_MS - 1000, breaches: [] };
  assert.equal(resolveInsightCache({ perState: null, last: old, breaches: [], nowMs: now }), "generate");
  assert.equal(resolveInsightCache({ perState: null, last: { mode: "deterministic", generatedAt: now }, breaches: [], nowMs: now }), "generate");
});

test("resolveInsightCache: a new breach regenerates inside the quiet window, but not faster than the floor", () => {
  const recent = { mode: "openai", generatedAt: now - 5 * 60 * 1000, breaches: [] };
  assert.equal(resolveInsightCache({ perState: null, last: recent, breaches: ["co2"], nowMs: now }), "generate");
  const fresh = { mode: "openai", generatedAt: now - 60 * 1000, breaches: [] };
  assert.equal(resolveInsightCache({ perState: null, last: fresh, breaches: ["co2"], nowMs: now }), "last");
  const cleared = { mode: "openai", generatedAt: now - 5 * 60 * 1000, breaches: ["co2"] };
  assert.equal(resolveInsightCache({ perState: null, last: cleared, breaches: [], nowMs: now }), "generate");
});

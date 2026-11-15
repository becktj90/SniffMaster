import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAddress, normalizeRules, decideSubscriberAlerts, alertContext, alertText, maskAddress, RULES,
} from "../lib/subscribers.js";
import { fallbackInsights, insightFacts, insightCacheKey } from "../lib/insights.js";

test("addresses are validated and normalized", () => {
  assert.equal(normalizeAddress("email", " Pat@Example.COM "), "pat@example.com");
  assert.equal(normalizeAddress("email", "nope"), null);
  assert.equal(normalizeAddress("sms", "(321) 555-0142"), "+13215550142");
  assert.equal(normalizeAddress("sms", "+44 7700 900123"), "+447700900123");
  assert.equal(normalizeAddress("sms", "555"), null);
  assert.equal(normalizeAddress("fax", "x"), null);
});

test("rules keep known keys, clamp to range, and default when empty", () => {
  assert.deepEqual(Object.keys(normalizeRules({})).sort(), ["co2", "humidityHi", "iaq", "pet", "smell"]);
  const r = normalizeRules({ co2: 99999, iaq: "120", bogus: 5, humidityLo: false, smell: true });
  assert.equal(r.co2, RULES.co2.max);
  assert.equal(r.iaq, 120);
  assert.equal(r.smell, 1);
  assert.ok(!("bogus" in r) && !("humidityLo" in r));
});

test("an alert fires once, stays quiet while tripped, re-arms after clearing", () => {
  const sub = { id: "a", verified: true, rules: { co2: 1200, humidityLo: 25 }, state: {} };
  const hi = alertContext({ co2: 1500, humidity: 40 });
  const t0 = 1_000_000;
  let r = decideSubscriberAlerts([sub], hi, t0);
  assert.equal(r.sends.length, 1);
  assert.deepEqual(r.sends[0].tripped.map((x) => x.key), ["co2"]);
  r = decideSubscriberAlerts(r.subs, hi, t0 + 60_000);
  assert.equal(r.sends.length, 0, "no repeat while still high");
  r = decideSubscriberAlerts(r.subs, alertContext({ co2: 700, humidity: 40 }), t0 + 120_000);
  assert.equal(r.sends.length, 0);
  r = decideSubscriberAlerts(r.subs, hi, t0 + 180_000);
  assert.equal(r.sends.length, 1, "re-arms after clearing");
});

test("unverified subscribers and missing readings never alert", () => {
  const r = decideSubscriberAlerts([{ id: "b", verified: false, rules: { co2: 600 } }], alertContext({ co2: 2000 }));
  assert.equal(r.sends.length, 0);
  const r2 = decideSubscriberAlerts([{ id: "c", verified: true, rules: { pet: 10 } }], alertContext({}, {}));
  assert.equal(r2.sends.length, 0);
});

test("alert text is human and specific; addresses are masked", () => {
  const ctx = alertContext({ co2: 1510 }, { smell: { smellsBad: true, headline: "Strong smell: probably garbage." } });
  const text = alertText([{ key: "co2", rule: RULES.co2, value: 1510, limit: 1200 }, { key: "smell", rule: RULES.smell, value: 1, limit: 1 }], ctx);
  assert.match(text, /stuffy, about 1510 ppm/);
  assert.match(text, /garbage/);
  assert.match(text, /window/);
  assert.equal(maskAddress("sms", "+13215550142"), "••••••••0142");
  assert.ok(maskAddress("email", "pat@example.com").endsWith("@example.com"));
});

test("easy alerts fire for pet dander, mold, and pollen in plain words", () => {
  const home = {
    petAllergen: { index: 72 },
    biological: { mold: { pct: 80 }, dustMite: { pct: 10 } },
    pollen: { ok: true, types: [{ name: "Ragweed", value: 4, category: "High" }] },
    smell: { smellsBad: false },
    score: { value: 90 },
  };
  const ctx = alertContext({}, home);
  const sub = { id: "s", verified: true, rules: { pet: 50, mold: 60, pollen: 3, dustMite: 60 }, state: {} };
  const r = decideSubscriberAlerts([sub], ctx, 1_000);
  assert.deepEqual(r.sends[0].tripped.map((t) => t.key).sort(), ["mold", "pet", "pollen"]);
  const text = alertText(r.sends[0].tripped, ctx);
  assert.match(text, /Pet allergens are at 72/);
  assert.match(text, /Mold risk is 80/);
  assert.match(text, /pollen is 4 out of 5/);
  assert.match(text, /dehumidifier/);
});

test("fallback insights always produce the card shape", () => {
  const home = { score: { value: 62, grade: "Fair" }, climate: { tempF: 78, humidity: 66 }, gases: { co2: 1250, iaq: 90 }, petAllergen: { level: "Moderate" }, outdoor: { usAqi: 30, tempC: 20 } };
  const f = insightFacts(home, { iaqAcc: 3 }, null);
  const out = fallbackInsights(f);
  assert.ok(out.headline && out.summary && out.tips.length >= 2 && out.tips.length <= 4);
  assert.ok(out.tips.every((t) => ["good", "fair", "bad"].includes(t.tone)));
  assert.equal(typeof insightCacheKey(f), "string");
  const empty = fallbackInsights(insightFacts({}, {}, null));
  assert.match(empty.headline, /Waiting/);
});

test("missing readings stay missing in insight facts", () => {
  const f = insightFacts({ climate: { tempF: null, humidity: null }, outdoor: { tempC: null, usAqi: null } }, {}, null);
  assert.equal(f.indoor.tempF, null);
  assert.equal(f.outdoor.tempC, null);
  const out = fallbackInsights(f);
  assert.ok(!/32°F/.test(out.summary), out.summary);
});

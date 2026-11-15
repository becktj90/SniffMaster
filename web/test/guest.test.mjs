import test from "node:test";
import assert from "node:assert/strict";
import { toGuestView, decideGuestAlerts, guestTopic } from "../lib/guest.js";

const payload = {
  receivedAt: 1, city: "Secretville", lat: 1.23, lon: 4.56, located: true,
  score: { value: 80, grade: "Good", components: [{ x: 1 }] },
  smell: { state: "ok", smellsBad: false, headline: "Air smells fresh.", cause: { index: 1, name: "Musty" } },
  outlook: { level: "Low", headline: "ok", items: [], triggers: ["cat"] },
  climate: { tempF: 72, humidity: 45, comfort: "Comfortable", dewPointC: 9 },
  gases: { co2Category: "Fresh", iaq: 40, gasR: 123 },
  petAllergen: { level: "Low", confidence: "low", index: 10, basis: [] },
  biological: { mold: { category: "Low", pct: 3 }, dustMite: { category: "Low", pct: 5 } },
  pollen: { ok: false }, series: { t: [1] }, coverage: [], visitor: {}, outdoor: { pm25: 3 },
};

test("guest view is a whitelist: no location, history or device data", () => {
  const v = toGuestView(payload, { topic: "t1" });
  const json = JSON.stringify(v);
  for (const leak of ["Secretville", "1.23", "4.56", '"lat"', '"lon"', '"city"', '"series"', '"coverage"', '"gasR"', '"dewPointC"', '"pm25"']) {
    assert.ok(!json.includes(leak), "leaked " + leak);
  }
  assert.equal(v.score.value, 80);
  assert.equal(v.alerts.topic, "t1");
  assert.equal(v.smell.cause, "Musty");
});

test("guest topic is stable, secret-derived, and not the owner's topic", () => {
  process.env.SNIFFMASTER_API_KEY = "abc";
  delete process.env.NTFY_GUEST_TOPIC;
  const t = guestTopic();
  assert.match(t, /^sniffmaster-guest-[0-9a-f]{16}$/);
  assert.ok(!t.includes("abc"));
  assert.equal(guestTopic(), t);
  process.env.NTFY_GUEST_TOPIC = "custom";
  assert.equal(guestTopic(), "custom");
  delete process.env.NTFY_GUEST_TOPIC;
});

test("alerts fire once when smell turns bad, then stay quiet until cleared", () => {
  const bad = { smell: { smellsBad: true, headline: "Noticeable smell: probably garbage.", action: "Take the trash out." }, score: { value: 70 } };
  const ok = { smell: { smellsBad: false }, score: { value: 70 } };
  const t0 = 1e9;
  let r = decideGuestAlerts(bad, {}, t0);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].title, "Room smells bad");
  r = decideGuestAlerts(bad, r.state, t0 + 10 * 60000);
  assert.equal(r.messages.length, 0);
  r = decideGuestAlerts(ok, r.state, t0 + 20 * 60000);
  assert.equal(r.messages.length, 0);
  r = decideGuestAlerts(bad, r.state, t0 + 30 * 60000);
  assert.equal(r.messages.length, 1);
});

test("re-alerts after the 3 hour cooldown if still bad; poor air alerts separately; safety is urgent", () => {
  const bad = { smell: { smellsBad: true, safety: true, headline: "Strong smell: probably sulfur." }, score: { value: 40 } };
  let r = decideGuestAlerts(bad, {}, 0);
  assert.deepEqual(r.messages.map((m) => m.kind).sort(), ["air", "smell"]);
  assert.equal(r.messages.find((m) => m.kind === "smell").priority, 5);
  assert.equal(decideGuestAlerts(bad, r.state, 2 * 3600e3).messages.length, 0);
  assert.equal(decideGuestAlerts(bad, r.state, 3.1 * 3600e3).messages.length, 2);
});

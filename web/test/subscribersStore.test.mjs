import test from "node:test";
import assert from "node:assert/strict";
import { startFakeUpstash } from "./fakeUpstash.mjs";

const up = await startFakeUpstash();
Object.assign(process.env, { UPSTASH_REDIS_REST_URL: up.url, UPSTASH_REDIS_REST_TOKEN: "t", CLICKSEND_USERNAME: "u", CLICKSEND_API_KEY: "k" });
const sent = [];
let failNext = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("clicksend")) {
    const m = JSON.parse(opts.body).messages[0];
    if (failNext > 0) { failNext--; return new Response(JSON.stringify({ data: { queued_count: 0, total_count: 1 } }), { status: 200 }); }
    sent.push(m);
    return new Response(JSON.stringify({ data: { queued_count: 1, total_count: 1 } }), { status: 200 });
  }
  return realFetch(url, opts);
};
const S = await import("../lib/subscribers.js");
test.after(() => { globalThis.fetch = realFetch; up.close(); });

async function signUp(phone, rules, ip) {
  const before = sent.length;
  const { id } = await S.startSubscription({ channel: "sms", address: phone, rules, ip });
  return { id, code: sent[before].body.match(/\d{6}/)[0] };
}

test("two confirmations at the same time both stay subscribed", async () => {
  const a = await signUp("3215550101", { co2: 1000 }, "a");
  const b = await signUp("3215550102", { co2: 1000 }, "b");
  await Promise.all([S.confirmSubscription(a), S.confirmSubscription(b)]);
  const list = await S.loadSubscribers();
  assert.deepEqual(list.map((s) => s.address).sort(), ["+13215550101", "+13215550102"]);
});

test("a failed alert send is retried on the next check", async () => {
  const before = sent.length;
  failNext = 2; // both subscribers' first alert fails
  assert.equal(await S.runSubscriberAlerts({ co2: 1500 }, {}), 0);
  assert.equal(await S.runSubscriberAlerts({ co2: 1500 }, {}), 2, "retried, not suppressed for 3h");
  assert.equal(sent.length - before, 2);
  assert.equal(await S.runSubscriberAlerts({ co2: 1500 }, {}), 0, "no repeat after success");
});

test("unsubscribing while alerts run is not undone", async () => {
  const [first] = await S.loadSubscribers();
  await Promise.all([S.unsubscribe(first.token), S.runSubscriberAlerts({ co2: 700 }, {})]);
  const list = await S.loadSubscribers();
  assert.equal(list.length, 1);
  assert.ok(!list.some((s) => s.id === first.id));
});

test("outdoor AQI uses the US scale, not the device's 1-5 index", () => {
  assert.equal(S.alertContext({ outdoorAqi: 5 }, { outdoor: { usAqi: 180 } }).outdoorAqi, 180);
  assert.ok(Number.isNaN(S.alertContext({ outdoorAqi: 5 }, {}).outdoorAqi));
  assert.equal(S.alertContext({ outdoorAqi: 120 }, {}).outdoorAqi, 120);
});

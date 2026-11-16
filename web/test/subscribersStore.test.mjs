import test from "node:test";
import assert from "node:assert/strict";
import { startFakeUpstash } from "./fakeUpstash.mjs";

const up = await startFakeUpstash();
Object.assign(process.env, { UPSTASH_REDIS_REST_URL: up.url, UPSTASH_REDIS_REST_TOKEN: "t", CLICKSEND_USERNAME: "u", CLICKSEND_API_KEY: "k" });
const sent = [];
const pushed = [];
let failNext = 0;
let creditFail = false;
let rejectOwnedFrom = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/v3/account")) {
    return new Response(JSON.stringify({ data: { balance: creditFail ? "0" : "5.00" } }), { status: 200 });
  }
  if (u.includes("ntfy.sh")) {
    if (failNext > 0) { failNext--; return new Response("{}", { status: 500 }); }
    pushed.push({ url: u, body: String(opts?.body || ""), title: opts?.headers?.Title || "" });
    return new Response("{}", { status: 200 });
  }
  if (u.includes("/sms/send")) {
    const m = JSON.parse(opts.body).messages[0];
    if (creditFail || (rejectOwnedFrom && m.from)) {
      return new Response(JSON.stringify({ data: { queued_count: 0, total_count: 1, messages: [{ status: "INSUFFICIENT_CREDIT" }] } }), { status: 200 });
    }
    if (failNext > 0) { failNext--; return new Response(JSON.stringify({ data: { queued_count: 0, total_count: 1 } }), { status: 200 }); }
    sent.push(m);
    return new Response(JSON.stringify({ data: { queued_count: 1, total_count: 1 } }), { status: 200 });
  }
  return realFetch(url, opts);
};
const S = await import("../lib/subscribers.js");
test.after(() => { globalThis.fetch = realFetch; up.close(); });

async function signUpPush(rules, ip) {
  const before = pushed.length;
  const { id } = await S.startSubscription({ channel: "push", rules, ip });
  return { id, code: pushed[before].body.match(/\d{6}/)[0] };
}

test("two confirmations at the same time both stay subscribed", async () => {
  const a = await signUpPush({ co2: 1000 }, "a");
  const b = await signUpPush({ co2: 1000 }, "b");
  await Promise.all([S.confirmSubscription(a), S.confirmSubscription(b)]);
  const list = await S.loadSubscribers();
  assert.equal(list.filter((s) => s.channel === "push" && s.verified).length, 2);
});

test("a failed alert send is retried on the next check", async () => {
  const before = pushed.length;
  failNext = 2; // both subscribers' first alert fails
  assert.equal(await S.runSubscriberAlerts({ co2: 1500 }, {}), 0);
  assert.equal(await S.runSubscriberAlerts({ co2: 1500 }, {}), 2, "retried, not suppressed for 3h");
  assert.equal(pushed.length - before, 2);
  assert.equal(await S.runSubscriberAlerts({ co2: 1500 }, {}), 0, "no repeat after success");
});

test("unsubscribing while alerts run is not undone", async () => {
  const [first] = await S.loadSubscribers();
  await Promise.all([S.unsubscribe(first.token), S.runSubscriberAlerts({ co2: 700 }, {})]);
  const list = await S.loadSubscribers();
  assert.equal(list.length, 1);
  assert.ok(!list.some((s) => s.id === first.id));
});

test("Text is retired: the channel is never offered and sign-ups are refused", async () => {
  const { channels, smsReason } = await S.alertChannels();
  assert.equal(channels.sms, false);
  assert.equal(smsReason, null);
  // Even with ClickSend reporting no credit, the reason is retirement, not credit.
  const { setJsonCache } = await import("../lib/store.js");
  await setJsonCache("clicksend-balance", { balance: 0.03, at: Date.now() }, 600);
  await setJsonCache("clicksend-credit-block", { at: Date.now() }, 600);
  const still = await S.alertChannels();
  assert.equal(still.channels.sms, false);
  assert.equal(still.smsReason, null);
  await assert.rejects(
    () => S.startSubscription({ channel: "sms", address: "3215550199", rules: { co2: 1000 }, ip: "retired" }),
    (err) => {
      assert.equal(err.status, 503);
      assert.match(err.message, /no longer available/);
      return true;
    }
  );
  // Refusing the signup must not burn any limit for a real signup right after.
  const ok = await S.startSubscription({ channel: "push", rules: { co2: 1000 }, ip: "retired" });
  assert.ok(ok.id);
});

test("an already-verified text subscriber still gets alerts (legacy delivery)", async () => {
  await S.updateSubscribers((subs) => [...subs, { id: "legacy-sms", channel: "sms", address: "+13215550199", rules: { co2: 1000 }, token: "legacy-token", verified: true, createdAt: Date.now(), state: {} }]);
  const before = sent.length;
  // The surviving phone subscriber trips too, but its send goes to ntfy.
  creditFail = true;
  assert.equal(await S.runSubscriberAlerts({ co2: 1500 }, {}), 1, "phone alert lands; the text send fails for credit");
  assert.equal(sent.length, before, "no text queued while credit fails");
  creditFail = false;
  assert.equal(await S.runSubscriberAlerts({ co2: 1500 }, {}), 1, "failed text send is retried, not suppressed");
  assert.equal(sent.length - before, 1);
});

test("a rejected sender number is retried without that From", async () => {
  await S.updateSubscribers((subs) => [...subs, { id: "legacy-sms-2", channel: "sms", address: "+13215550188", rules: { humidityHi: 65 }, token: "legacy-token-2", verified: true, createdAt: Date.now(), state: {} }]);
  rejectOwnedFrom = true;
  const before = sent.length;
  assert.equal(await S.runSubscriberAlerts({ humidity: 70 }, {}), 1);
  rejectOwnedFrom = false;
  assert.equal(sent[sent.length - 1].from, undefined);
  assert.ok(sent.length > before);
});

test("a phone notification delivers the code and later alerts", async () => {
  const before = pushed.length;
  const started = await S.startSubscription({ channel: "push", rules: { co2: 1000 }, ip: "push" });
  assert.ok(started.push.web.startsWith("https://ntfy.sh/sniff-"));
  const code = pushed[before].body.match(/\d{6}/)[0];
  const confirmed = await S.confirmSubscription({ id: started.id, code });
  assert.equal(confirmed.masked, "your phone");
  const mine = () => pushed.filter((p) => p.url.includes(started.push.topic));
  const beforeAlerts = mine().length;
  assert.ok(await S.runSubscriberAlerts({ co2: 1500 }, {}) >= 1);
  assert.equal(mine().length, beforeAlerts + 1);
  assert.match(mine().at(-1).body, /stuffy/);
  assert.ok(pushed.length >= before + 2);
});

test("outdoor AQI uses the US scale, not the device's 1-5 index", () => {
  assert.equal(S.alertContext({ outdoorAqi: 5 }, { outdoor: { usAqi: 180 } }).outdoorAqi, 180);
  assert.ok(Number.isNaN(S.alertContext({ outdoorAqi: 5 }, {}).outdoorAqi));
  assert.equal(S.alertContext({ outdoorAqi: 120 }, {}).outdoorAqi, 120);
});

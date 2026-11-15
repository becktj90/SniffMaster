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

test("no ClickSend credit explains itself and does not burn the resend limit", async () => {
  creditFail = true;
  await assert.rejects(
    () => S.startSubscription({ channel: "sms", address: "3215550199", rules: { co2: 1000 }, ip: "credit" }),
    (err) => {
      assert.equal(err.status, 503);
      assert.match(err.message, /out of credit/);
      assert.doesNotMatch(err.message, /Double-check/);
      return true;
    }
  );
  creditFail = false;
  // ClickSend's balance endpoint still says $5, but a real send was just
  // refused for credit: Text must stay hidden instead of failing the next signup.
  const hidden = await S.alertChannels();
  assert.equal(hidden.channels.sms, false);
  assert.equal(hidden.smsReason, "credit");
  const { setJsonCache } = await import("../lib/store.js");
  await setJsonCache("clicksend-credit-block", { at: Date.now() - 31 * 60 * 1000 }, 5);
  await setJsonCache("clicksend-balance", { balance: 5, at: Date.now() }, 600);
  const back = await S.alertChannels();
  assert.equal(back.channels.sms, true, "after the block lapses the next signup probes again");
  const again = await signUp("3215550199", { co2: 1000 }, "credit-ok");
  assert.equal(again.code.length, 6);
});

test("a balance too small for one text hides Text before anyone tries", async () => {
  const { setJsonCache } = await import("../lib/store.js");
  await setJsonCache("clicksend-balance", { balance: 0.03, at: Date.now() }, 600);
  const low = await S.alertChannels();
  assert.equal(low.channels.sms, false);
  assert.equal(low.smsReason, "credit");
  await setJsonCache("clicksend-balance", { balance: 5, at: Date.now() }, 600);
  assert.equal((await S.alertChannels()).channels.sms, true);
});

test("a credit rejection while sending alerts also pauses Text", async () => {
  const { loadSubscribers } = S;
  const subs = await loadSubscribers();
  assert.ok(subs.some((x) => x.channel === "sms"));
  creditFail = true;
  await S.runSubscriberAlerts({ co2: 3000, iaq: 400 }, {});
  creditFail = false;
  const after = await S.alertChannels();
  assert.equal(after.channels.sms, false);
  assert.equal(after.smsReason, "credit");
  const { setJsonCache } = await import("../lib/store.js");
  await setJsonCache("clicksend-credit-block", { at: 0 }, 5);
});

test("a rejected sender number is retried without that From", async () => {
  rejectOwnedFrom = true;
  const before = sent.length;
  const { code } = await signUp("3215550188", { co2: 1000 }, "from");
  rejectOwnedFrom = false;
  assert.equal(code.length, 6);
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

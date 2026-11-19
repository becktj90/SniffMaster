import test from "node:test";
import assert from "node:assert/strict";
import { startFakeUpstash } from "./fakeUpstash.mjs";

const up = await startFakeUpstash();
Object.assign(process.env, { UPSTASH_REDIS_REST_URL: up.url, UPSTASH_REDIS_REST_TOKEN: "t" });
const pushed = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("ntfy.sh")) {
    pushed.push({ url: u, body: String(opts?.body || "") });
    return new Response("{}", { status: 200 });
  }
  return realFetch(url, opts);
};
const S = await import("../lib/subscribers.js");
const handler = (await import("../api/extras.js")).default;
test.after(() => { globalThis.fetch = realFetch; up.close(); });

async function signUpPush(rules, ip) {
  const before = pushed.length;
  const { id } = await S.startSubscription({ channel: "push", rules, ip });
  const code = pushed[before].body.match(/\d{6}/)[0];
  await S.confirmSubscription({ id, code });
  const [sub] = (await S.loadSubscribers()).filter((s) => s.id === id);
  return sub;
}

function mockRes() {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { res.headers[k] = v; },
    status(c) { res.statusCode = c; return res; },
    json(o) { res.body = o; return res; },
    send(s) { res.body = s; return res; },
  };
  return res;
}

async function callAlerts({ method, query = {}, body = null }) {
  const req = { method, query: { fn: "alerts", ...query }, body, headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  const res = mockRes();
  await handler(req, res);
  return res;
}

test("update with a valid token changes and clamps the rules", async () => {
  const sub = await signUpPush({ humidityHi: 65, co2: 1200 }, "upd-1");
  assert.ok(sub.token);
  const out = await S.updateSubscriberRules({ token: sub.token, rules: { humidityHi: 70, co2: 99999, bogus: 5 } });
  assert.equal(out.masked, "your phone");
  assert.equal(out.channel, "push");
  assert.equal(out.rules.humidityHi, 70);
  assert.equal(out.rules.co2, S.RULES.co2.max, "clamped to the rule max");
  assert.ok(!("bogus" in out.rules), "unknown rule keys are dropped");
  assert.ok(!("address" in out), "the raw address is never returned");
  const [saved] = (await S.loadSubscribers()).filter((s) => s.id === sub.id);
  assert.equal(saved.rules.humidityHi, 70);
  assert.equal(saved.rules.co2, S.RULES.co2.max);
});

test("a wrong token cannot update anything — 404, and nothing changes", async () => {
  const sub = await signUpPush({ humidityHi: 65 }, "upd-2");
  await assert.rejects(
    () => S.updateSubscriberRules({ token: "definitely-not-a-real-token", rules: { humidityHi: 70 } }),
    (err) => { assert.equal(err.status, 404); return true; }
  );
  const [saved] = (await S.loadSubscribers()).filter((s) => s.id === sub.id);
  assert.equal(saved.rules.humidityHi, 65);
});

test("empty rules and unknown-only rules are refused — 400", async () => {
  const sub = await signUpPush({ humidityHi: 65 }, "upd-3");
  for (const bad of [{}, { bogus: 5 }, null, "humidityHi"]) {
    await assert.rejects(
      () => S.updateSubscriberRules({ token: sub.token, rules: bad }),
      (err) => { assert.equal(err.status, 400); return true; }
    );
  }
  const [saved] = (await S.loadSubscribers()).filter((s) => s.id === sub.id);
  assert.equal(saved.rules.humidityHi, 65);
});

test("GET by token returns only that subscriber's rules", async () => {
  const mine = await signUpPush({ humidityHi: 68, co2: 1500 }, "get-1");
  const other = await signUpPush({ humidityHi: 80 }, "get-2");
  const found = await S.getSubscriberByToken(mine.token);
  assert.ok(found);
  const pub = S.publicSubscriber(found);
  assert.deepEqual(pub.rules, { humidityHi: 68, co2: 1500 });
  assert.ok(!("address" in pub) && !JSON.stringify(pub).includes(other.token));
  assert.equal(await S.getSubscriberByToken("no-such-token"), null);
  assert.equal(await S.getSubscriberByToken(""), null);
  // And through the HTTP route: 200 for the right token, 404 for a wrong one.
  const okRes = await callAlerts({ method: "GET", query: { token: mine.token } });
  assert.equal(okRes.statusCode, 200);
  assert.deepEqual(okRes.body.rules, { humidityHi: 68, co2: 1500 });
  const badRes = await callAlerts({ method: "GET", query: { token: "no-such-token" } });
  assert.equal(badRes.statusCode, 404);
  const updRes = await callAlerts({ method: "POST", body: { action: "update", token: "no-such-token", rules: { humidityHi: 70 } } });
  assert.equal(updRes.statusCode, 404);
  const updOk = await callAlerts({ method: "POST", body: { action: "update", token: mine.token, rules: { humidityHi: 70 } } });
  assert.equal(updOk.statusCode, 200);
  assert.equal(updOk.body.rules.humidityHi, 70);
});

test("raising a limit re-arms the rule when it clears an active breach", async () => {
  const sub = await signUpPush({ humidityHi: 65 }, "rearm-1");
  const t0 = 1_000_000;
  const damp = S.alertContext({ humidity: 68 });
  // Humidity 68 trips the 65 limit.
  let r = S.decideSubscriberAlerts([{ ...sub, state: {} }], damp, t0);
  assert.equal(r.sends.length, 1);
  assert.equal(r.subs[0].state.humidityHi.active, true);
  // The subscriber raises the limit to 70. Same damp air, next check:
  // the rule goes inactive and nothing is sent.
  const updated = await S.updateSubscriberRules({ token: sub.token, rules: { humidityHi: 70 } });
  assert.equal(updated.rules.humidityHi, 70);
  const [live] = (await S.loadSubscribers()).filter((s) => s.id === sub.id);
  r = S.decideSubscriberAlerts([{ ...live, state: r.subs[0].state }], damp, t0 + 60_000);
  assert.equal(r.sends.length, 0, "no alert once the raised limit clears the breach");
  assert.equal(r.subs[0].state.humidityHi.active, false, "rule re-armed");
  // And it fires again if humidity later crosses the new limit.
  r = S.decideSubscriberAlerts(r.subs, S.alertContext({ humidity: 72 }), t0 + 120_000);
  assert.equal(r.sends.length, 1);
});

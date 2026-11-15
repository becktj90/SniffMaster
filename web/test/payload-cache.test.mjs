import test from "node:test";
import assert from "node:assert/strict";
import { startFakeUpstash } from "./fakeUpstash.mjs";

test("buildHomePayload caches 60s per trigger set", async () => {
  const up = await startFakeUpstash();
  process.env.UPSTASH_REDIS_REST_URL = up.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = "t";
  const { putSnapshot } = await import("../lib/store.js");
  const { buildHomePayload } = await import("../api/extras.js");
  // No lat/lon: the build skips every outdoor/Google fetch, so no network stub is needed.
  await putSnapshot({
    voc: 0.5, iaq: 55, co2: 700, tempF: 72, humidity: 52, pressHpa: 1013,
    pm25: 12, pm10: 20, airScore: 24, tier: 1, primary: "Clean Air", primaryConf: 0,
  });
  const first = await buildHomePayload("");
  assert.ok(first && first.mode === "home");
  // Key carries the trigger set plus the severity suffix ("std" = all moderate).
  assert.ok([...up.kv.keys()].includes("sniffmaster:cache:home-payload:none|std"));
  // Wipe the source data: a rebuild would return null, a cache hit returns the same payload.
  for (const k of ["sniffmaster:latest", "sniffmaster:history", "sniffmaster:home_fine", "sniffmaster:home_coarse"]) {
    up.kv.delete(k);
  }
  const second = await buildHomePayload("");
  assert.deepEqual(second, first);
  // A different trigger set is a different cache key — no stale cross-talk.
  assert.equal(await buildHomePayload("cat"), null);
  // Same triggers but a different severity is a different cache key too.
  assert.equal(await buildHomePayload("", "cat:severe"), null);
  up.close();
});

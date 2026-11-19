import test from "node:test";
import assert from "node:assert/strict";
import { startLocalStore, wipeSourceData } from "./localStore.mjs";

test("buildHomePayload caches 300s per trigger set", async () => {
  const local = startLocalStore();
  const { putSnapshot, getJsonCache } = await import("../lib/store.js");
  const { buildHomePayload } = await import("../api/extras.js");
  // No lat/lon: the build skips every outdoor/Google fetch, so no network stub is needed.
  await putSnapshot({
    voc: 0.5, iaq: 55, co2: 700, tempF: 72, humidity: 52, pressHpa: 1013,
    pm25: 12, pm10: 20, airScore: 24, tier: 1, primary: "Clean Air", primaryConf: 0,
  });
  const first = await buildHomePayload("");
  assert.ok(first && first.mode === "home");
  // Key carries the trigger set plus the severity suffix ("std" = all moderate).
  assert.ok(await getJsonCache("home-payload:none|std"));
  // Wipe the source data: a rebuild would return null, a cache hit returns the same payload.
  await wipeSourceData(local.file);
  const second = await buildHomePayload("");
  assert.deepEqual(second, first);
  // A different trigger set is a different cache key — no stale cross-talk.
  assert.equal(await buildHomePayload("cat"), null);
  // Same triggers but a different severity is a different cache key too.
  assert.equal(await buildHomePayload("", "cat:severe"), null);
  local.close();
});

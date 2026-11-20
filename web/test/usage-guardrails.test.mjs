// Free-plan guardrails: monthly usage counters + /api/health readout,
// read-cap circuit breaker (80% of Turso's 500M monthly row reads),
// 6h full-history retention. Tests run against a local file DB.
import test from "node:test";
import assert from "node:assert/strict";
import { startLocalStore, sql, wipeSourceData } from "./localStore.mjs";

const local = startLocalStore();
test.after(() => local.close());

const {
  putSnapshot, getLatest, getHistory, putSettings,
  getMonthlyUsage, isReadBreakerTripped, resetBreakerCacheForTests,
  READ_CAP_ROWS, WRITE_CAP_ROWS, READ_BREAKER_TRIP_ROWS, BREAKER_TRIP_FRACTION,
  MAX_HISTORY, currentMonthKey,
} = await import("../lib/store.js");
const { buildHomePayload } = await import("../api/extras.js");
const healthHandler = (await import("../api/health.js")).default;

const TRIP = READ_BREAKER_TRIP_ROWS; // 400,000,000
const monthKey = () => currentMonthKey();

/** Set the current month's usage row to absolute values (bypasses counting). */
async function seedUsage(month, reads, writes) {
  await sql(local.file,
    `INSERT INTO usage_monthly(month, rows_read, rows_written, updated_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(month) DO UPDATE SET rows_read = excluded.rows_read, rows_written = excluded.rows_written, updated_at = excluded.updated_at`,
    [month, reads, writes, Date.now()]);
}

/** Delete a ring, then insert `n` rows oldest-first (newest at `newestTs`). */
async function seedRing(file, ring, n, newestTs, stepMs, makePoint) {
  const client = (await import("@libsql/client")).createClient({ url: `file:${file}` });
  try {
    const stmts = [{ sql: "DELETE FROM rings WHERE ring = ?", args: [ring] }];
    for (let i = 0; i < n; i++) {
      const t = newestTs - (n - 1 - i) * stepMs;
      stmts.push({ sql: "INSERT INTO rings (ring, ts, payload) VALUES (?, ?, ?)", args: [ring, t, JSON.stringify(makePoint(i, t))] });
    }
    await client.batch(stmts);
  } finally {
    client.close();
  }
}

const snap = (rh) => ({
  voc: 0.5, iaq: 55, co2: 700, tempF: 72, humidity: rh, pressHpa: 1013,
  pm25: 12, pm10: 20, airScore: 24, tier: 1, primary: "Clean Air", primaryConf: 0,
});

test("usage counters track store reads/writes; a new month starts at zero", async () => {
  assert.equal(BREAKER_TRIP_FRACTION, 0.8);
  assert.equal(READ_CAP_ROWS, 500_000_000);
  assert.equal(WRITE_CAP_ROWS, 10_000_000);
  assert.equal(TRIP, 400_000_000);

  // Fresh DB: nothing counted yet.
  let usage = await getMonthlyUsage();
  assert.equal(usage.month, monthKey());
  assert.equal(usage.rowsRead, 0);
  assert.equal(usage.rowsWritten, 0);
  assert.equal(usage.readCap, READ_CAP_ROWS);
  assert.equal(usage.writeCap, WRITE_CAP_ROWS);
  assert.equal(usage.readPct, 0);
  assert.equal(usage.writePct, 0);
  assert.equal(usage.breakerTripped, false);

  // putSettings = 1 SELECT (0 rows: settings unset) + 1 upsert.
  await putSettings({ guardrailProbe: 1 });
  usage = await getMonthlyUsage();
  assert.equal(usage.rowsRead, 0);
  assert.equal(usage.rowsWritten, 1);

  // Second putSettings: getSettings now returns 1 row, then 1 upsert.
  await putSettings({ guardrailProbe: 2 });
  usage = await getMonthlyUsage();
  assert.equal(usage.rowsRead, 1);
  assert.equal(usage.rowsWritten, 2);

  // History reads count rows returned: seed 5, read 5.
  await seedRing(local.file, "sniffmaster:history", 5, Date.now(), 60000, (i, t) => ({ receivedAt: t, humidity: i }));
  assert.equal((await getHistory(5)).length, 5);
  usage = await getMonthlyUsage();
  assert.equal(usage.rowsRead, 6);
  assert.equal(usage.rowsWritten, 2);

  // A row for another month is invisible to the current month.
  await seedUsage("1999-01", 123456, 789);
  usage = await getMonthlyUsage();
  assert.equal(usage.month, monthKey());
  assert.equal(usage.rowsRead, 6);
  assert.equal(usage.rowsWritten, 2);
});

test("/api/health exposes the usage object", async () => {
  let status = 0, payload = null;
  const res = { setHeader() {}, status(c) { status = c; return this; }, json(p) { payload = p; return this; }, end() { return this; } };
  await healthHandler({ method: "GET" }, res);
  assert.equal(status, 200);
  assert.equal(payload.storage, "turso");
  assert.equal(payload.reachable, true);
  const usage = payload.usage;
  assert.equal(usage.month, monthKey());
  assert.equal(usage.readCap, READ_CAP_ROWS);
  assert.equal(usage.writeCap, WRITE_CAP_ROWS);
  assert.equal(typeof usage.rowsRead, "number");
  assert.equal(typeof usage.rowsWritten, "number");
  assert.equal(typeof usage.readPct, "number");
  assert.equal(typeof usage.writePct, "number");
  assert.equal(usage.breakerTripped, false);
});

test("retention: history ring trims at 360 and the payload window is 6h", async () => {
  assert.equal(MAX_HISTORY, 360);
  const now = Date.now();
  await seedRing(local.file, "sniffmaster:history", MAX_HISTORY, now - 60000, 60000, (i, t) => ({ receivedAt: t, humidity: i }));
  await putSnapshot(snap(42));
  const hist = await getHistory(1000);
  assert.equal(hist.length, MAX_HISTORY);
  assert.equal(hist[0].humidity, 42);
  assert.equal(hist.at(-1).humidity, 1); // oldest seeded row (humidity 0) trimmed

  // The home payload pulls at most 390 full rows: its trend window spans
  // ~6h, not 24h. A distinct trigger set keeps earlier tests' cached
  // payloads from answering instead of a fresh build.
  const payload = await buildHomePayload("mold");
  assert.ok(payload && payload.mode === "home");
  assert.ok(Array.isArray(payload.series.t) && payload.series.t.length > 0);
  assert.ok(payload.series.t.length <= 390);
  const oldest = Math.min(...payload.series.t);
  const ageMs = Date.now() - oldest;
  assert.ok(ageMs > 5 * 3600 * 1000, `oldest trend point is ${ageMs}ms old, expected >5h`);
  assert.ok(ageMs < 7 * 3600 * 1000, `oldest trend point is ${ageMs}ms old, expected <7h`);
});

test("breaker: just under the trip line rebuilds still run", async () => {
  await putSnapshot(snap(44));
  // Seed 1,000 rows below the trip line: the snapshot's own reads/writes
  // (a handful of rows, flushed by the breaker check) must not push it over.
  await seedUsage(monthKey(), TRIP - 1000, 0);
  resetBreakerCacheForTests();
  // Drop any cached payload for this trigger set so the build really runs.
  await sql(local.file, "DELETE FROM cache WHERE key = ?", ["sniffmaster:cache:home-payload:none|std"]);
  const payload = await buildHomePayload("");
  assert.ok(payload && payload.mode === "home");
  assert.equal(payload.breakerTripped, undefined);
  assert.equal(payload.receivedAt, (await getLatest()).receivedAt);
});

test("breaker: at the trip line the rebuild serves stale cache without touching history", async () => {
  await putSnapshot(snap(45));
  // A stale cached payload for the same trigger set (expired 60 s ago).
  const marker = { mode: "home", marker: "stale-cache", receivedAt: 1234567890000 };
  await sql(local.file,
    `INSERT INTO cache(key, value, expires_at) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    ["sniffmaster:cache:home-payload:none|std", JSON.stringify(marker), Date.now() - 60000]);
  await seedUsage(monthKey(), TRIP, 0);
  resetBreakerCacheForTests();
  const before = await getMonthlyUsage();
  assert.equal(before.breakerTripped, true);

  // Wipe every source the rebuild could read: with the breaker tripped the
  // stale payload must still come back, proving history was never touched.
  await wipeSourceData(local.file);
  const payload = await buildHomePayload("");
  assert.ok(payload);
  assert.equal(payload.marker, "stale-cache");
  assert.equal(payload.receivedAt, 1234567890000);
  assert.equal(payload.breakerTripped, true);
  assert.equal(payload.stale, true);

  // The tripped build cost ~1 counted row (the stale cache read), not a
  // ~400-row history pull.
  const after = await getMonthlyUsage();
  assert.equal(after.rowsRead - before.rowsRead, 1);
});

test("breaker resets when the month rolls over", async () => {
  await seedUsage(monthKey(), TRIP + 1000000, 0);
  resetBreakerCacheForTests();
  assert.equal(await isReadBreakerTripped(), true);

  // Simulate the rollover: the tripped month's row moves to another month
  // ('1998-06' is unused elsewhere in this file; '1999-01' is taken by the
  // counter test above).
  await sql(local.file, "UPDATE usage_monthly SET month = ? WHERE month = ?", ["1998-06", monthKey()]);
  resetBreakerCacheForTests();
  assert.equal(await isReadBreakerTripped(), false);
  const usage = await getMonthlyUsage();
  assert.equal(usage.month, monthKey());
  assert.equal(usage.breakerTripped, false);
  assert.ok(usage.rowsRead < 1000); // fresh month: only this process's own recent rows
  // The old month's counts are still stored, just scoped to that month.
  const old = await sql(local.file, "SELECT rows_read FROM usage_monthly WHERE month = ?", ["1998-06"]);
  assert.ok(Number(old.rows[0].rows_read) >= TRIP);
});

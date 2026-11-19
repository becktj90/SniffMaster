// Turso (libSQL) storage backend — behavior tests against a local file DB.
// Covers the same contract the old Upstash Redis store had: latest put/get,
// ring trims at the caps, home fine/coarse sampling, settings round-trip,
// cache TTL, lock acquire/release/expiry, counters with TTL, sniff/command
// latest + history, alert state/snapshot, daily summary, BLE occupancy.
import test from "node:test";
import assert from "node:assert/strict";
import { startLocalStore, sql } from "./localStore.mjs";

const local = startLocalStore();
test.after(() => local.close());

const {
  putSnapshot, getLatest, getHistory, getHomeSeries,
  putSettings, getSettings, getJsonCache, setJsonCache,
  acquireDailySummaryLock, acquireManualReportLock,
  getCounter, incrCounter, withLock, getStorageHealth,
  putSniffEvent, getLatestSniff, getSniffHistory,
  putCommand, getPendingCommand, getLatestCommand, getCommandHistory,
  setAlertState, getAlertState, putAlertSnapshot, getAlertSnapshot,
  putDailySummary, getDailySummary, getDailySummaryHistory,
  markDailySummaryDelivered, putBleOccupancyEntry, getLatestBleOccupancy,
  getBleOccupancyHistory, isStoreConfigured,
  MAX_HISTORY, MAX_HOME_FINE, MAX_HOME_COARSE, COMMAND_TTL_MS,
} = await import("../lib/store.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  voc: 0.5, iaq: 55, co2: 700, tempF: 72, humidity: rh, pressHpa: 1013, pm25: 12,
});

test("store is configured from TURSO_DATABASE_URL", () => {
  assert.equal(isStoreConfigured(), true);
});

// Runs FIRST: it is the only test that asserts absolute fine/coarse counts
// on a fresh DB (later tests add snapshots of their own).
test("home fine/coarse sampling and trims", async () => {
  const now = Date.now();
  // First snapshot seeds both rings; a second within 10 min adds fine only.
  await putSnapshot(snap(50));
  let series = await getHomeSeries();
  assert.equal(series.fine.length, 1);
  assert.equal(series.coarse.length, 1);
  await putSnapshot(snap(51));
  series = await getHomeSeries();
  assert.equal(series.fine.length, 2);
  assert.equal(series.coarse.length, 1);
  assert.equal(series.fine[0].rh, 51);
  // Age the coarse point 11 min: the next snapshot must sample coarse again.
  await sql(local.file, "UPDATE rings SET ts = ?, payload = ? WHERE ring = 'sniffmaster:home_coarse'",
    [now - 11 * 60000, JSON.stringify({ t: now - 11 * 60000, rh: 50 })]);
  await putSnapshot(snap(52));
  series = await getHomeSeries();
  assert.equal(series.fine.length, 3);
  assert.equal(series.coarse.length, 2);
  assert.equal(series.coarse[0].rh, 52);
  // Trims: seed both rings to their caps (newest coarse row 11 min old, so
  // the next snapshot samples coarse), then one snapshot trims both back.
  await seedRing(local.file, "sniffmaster:home_fine", MAX_HOME_FINE, now - 60000, 60000, (i, t) => ({ t, rh: i }));
  await seedRing(local.file, "sniffmaster:home_coarse", MAX_HOME_COARSE, now - 11 * 60000, 600000, (i, t) => ({ t, rh: i }));
  await putSnapshot(snap(53));
  series = await getHomeSeries();
  assert.equal(series.fine.length, MAX_HOME_FINE);
  assert.equal(series.coarse.length, MAX_HOME_COARSE);
  assert.equal(series.fine[0].rh, 53);
  assert.equal(series.coarse[0].rh, 53);
});

test("latest put/get and history ring trims at MAX_HISTORY", async () => {
  const now = Date.now();
  await putSnapshot(snap(41));
  const latest = await getLatest();
  assert.equal(latest.humidity, 41);
  assert.ok(Math.abs(latest.receivedAt - now) < 5000);
  // Seed the full 24h ring, then one more snapshot must trim it back to the cap.
  await seedRing(local.file, "sniffmaster:history", MAX_HISTORY, now - 60000, 60000, (i, t) => ({ receivedAt: t, humidity: i }));
  await putSnapshot(snap(42));
  const hist = await getHistory(MAX_HISTORY);
  assert.equal(hist.length, MAX_HISTORY);
  assert.equal(hist[0].humidity, 42);
  assert.equal(hist.at(-1).humidity, 1); // oldest seeded row (humidity 0) trimmed
  assert.equal((await getHistory(2)).length, 2);
});

test("settings round-trip", async () => {
  const before = await getSettings();
  assert.equal(typeof before, "object");
  await putSettings({ humidityHigh: 70, environment: "home" });
  const after = await getSettings();
  assert.equal(after.humidityHigh, 70);
  assert.equal(after.environment, "home");
  await putSettings({ humidityHigh: 60 });
  assert.equal((await getSettings()).humidityHigh, 60);
});

test("cache set/get + TTL expiry", async () => {
  await setJsonCache("turso-test", { a: 1 }, 1);
  assert.deepEqual(await getJsonCache("turso-test"), { a: 1 });
  await sleep(1100);
  assert.equal(await getJsonCache("turso-test"), null);
  // Expired rows are deleted on read, not left to pile up.
  const rows = await sql(local.file, "SELECT COUNT(*) AS n FROM cache WHERE key = ?", ["sniffmaster:cache:turso-test"]);
  assert.equal(Number(rows.rows[0].n), 0);
  // No TTL means no expiry.
  await setJsonCache("turso-forever", { b: 2 });
  assert.deepEqual(await getJsonCache("turso-forever"), { b: 2 });
});

test("daily summary + manual report locks: acquire, second caller loses, expiry reopens", async () => {
  assert.equal(await acquireDailySummaryLock(3600), true);
  assert.equal(await acquireDailySummaryLock(3600), false);
  await sql(local.file, "UPDATE locks SET expires_at = ? WHERE name = ?", [Date.now() - 1000, "sniffmaster:daily_summary_lock"]);
  assert.equal(await acquireDailySummaryLock(3600), true);
  assert.equal(await acquireManualReportLock(120), true);
  assert.equal(await acquireManualReportLock(120), false);
  await sql(local.file, "UPDATE locks SET expires_at = ? WHERE name = ?", [Date.now() - 1000, "sniffmaster:manual_report_lock"]);
  assert.equal(await acquireManualReportLock(120), true);
});

test("withLock serializes, releases on error, and times out when busy", async () => {
  const order = [];
  const first = withLock("turso-serial", async () => {
    order.push("first-start");
    await sleep(600);
    order.push("first-end");
    return "first";
  });
  const second = withLock("turso-serial", async () => {
    order.push("second");
    return "second";
  });
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
  await assert.rejects(
    withLock("turso-serial", async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(await withLock("turso-serial", async () => "after-error"), "after-error");
  // Held lock + short wait => "lock busy" instead of hanging.
  const held = withLock("turso-busy", async () => { await sleep(1500); return "held"; });
  await assert.rejects(
    withLock("turso-busy", async () => "never", { waitMs: 200 }),
    /lock busy/,
  );
  assert.equal(await held, "held");
});

test("counter incr with TTL: increments, expires, repairs a missing expiry", async () => {
  assert.equal(await getCounter("turso-c1"), 0);
  assert.equal(await incrCounter("turso-c1", 60), 1);
  assert.equal(await incrCounter("turso-c1", 60), 2);
  assert.equal(await getCounter("turso-c1"), 2);
  // Expired value resets to 1 with a fresh expiry.
  await sql(local.file, "UPDATE counters SET expires_at = ? WHERE key = ?", [Date.now() - 1000, "sniffmaster:counter:turso-c1"]);
  assert.equal(await getCounter("turso-c1"), 0);
  assert.equal(await incrCounter("turso-c1", 60), 1);
  // Missing expiry (NULL) repairs instead of resetting: value survives.
  await sql(local.file, "UPDATE counters SET expires_at = NULL WHERE key = ?", ["sniffmaster:counter:turso-c1"]);
  assert.equal(await incrCounter("turso-c1", 60), 2);
  const exp = await sql(local.file, "SELECT expires_at AS e FROM counters WHERE key = ?", ["sniffmaster:counter:turso-c1"]);
  assert.ok(Number(exp.rows[0].e) > Date.now());
});

test("sniff events: latest + history + incrementing seq", async () => {
  const first = await putSniffEvent({ note: "a" });
  const second = await putSniffEvent({ note: "b" });
  assert.equal(second.seq, first.seq + 1);
  assert.equal((await getLatestSniff()).note, "b");
  const hist = await getSniffHistory();
  assert.equal(hist.length, 2);
  assert.equal(hist[0].note, "b");
  assert.equal(hist[1].note, "a");
});

test("commands: pending while fresh, null after COMMAND_TTL_MS, seq increments", async () => {
  const cmd = await putCommand({ command: "ping" });
  assert.equal(typeof cmd.seq, "number");
  assert.equal((await getPendingCommand(0)).command, "ping");
  assert.equal(await getPendingCommand(cmd.seq), null);
  assert.equal((await getLatestCommand()).command, "ping");
  assert.equal((await getCommandHistory())[0].command, "ping");
  // Age the stored command past its TTL: no longer pending.
  const stale = Date.now() - COMMAND_TTL_MS - 60000;
  const staleJson = JSON.stringify({ ...cmd, receivedAt: stale });
  await sql(local.file,
    "INSERT INTO kv (key, value) VALUES ('sniffmaster:command', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [staleJson]);
  assert.equal(await getPendingCommand(0), null);
});

test("alert state/snapshot, daily summary, BLE occupancy round-trips", async () => {
  await setAlertState({ activeKeys: ["humidity"], sentAt: { humidity: 123 } });
  assert.deepEqual(await getAlertState(), { activeKeys: ["humidity"], sentAt: { humidity: 123 } });
  await putAlertSnapshot({ mold: { risk: "high" } });
  assert.deepEqual((await getAlertSnapshot()).mold, { risk: "high" });
  const summary = await putDailySummary({ text: "morning report" });
  assert.equal((await getDailySummary()).text, "morning report");
  assert.equal((await getDailySummaryHistory())[0].text, "morning report");
  assert.equal((await markDailySummaryDelivered(true)).smsDelivered, true);
  assert.equal((await getDailySummary()).smsDelivered, true);
  const ble = await putBleOccupancyEntry({ bleDeviceCount: 2, bleOccupancyIndex: 1, bleAvgRssi: -60, bleStrongestRssi: -50, bleSeenRecently: true, blePresenceEnabled: true });
  assert.equal(ble.deviceCount, 2);
  assert.equal((await getLatestBleOccupancy()).deviceCount, 2);
  assert.equal((await getBleOccupancyHistory())[0].deviceCount, 2);
});

test("getStorageHealth reports turso + depths", async () => {
  const health = await getStorageHealth();
  assert.equal(health.storage, "turso");
  assert.equal(health.configured, true);
  assert.equal(health.reachable, true);
  assert.equal(health.pong, "PONG");
  assert.ok(typeof health.snapshotHistoryDepth === "number" && health.snapshotHistoryDepth >= 1);
  assert.ok(health.latestPresent);
});

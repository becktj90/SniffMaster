/**
 * store.js — Upstash Redis data store for SniffMaster web relay
 *
 * Keys:
 *   sniffmaster:latest   — most recent sensor snapshot (JSON)
 *   sniffmaster:history  — sorted list of recent snapshots (last 1440 = 24h @ 1min)
 *   sniffmaster:home_fine — compact climate points, last 26h at the post interval
 *   sniffmaster:home_coarse — compact climate points, 7d at 10-minute steps
 *   sniffmaster:sniff    — most recent priority sulfur/VSC event (JSON)
 *   sniffmaster:sniff_history — recent priority sulfur/VSC events
 *   sniffmaster:sniff_seq — monotonic sequence for live event streaming
 *   sniffmaster:command  — most recent owner-triggered device command (JSON)
 *   sniffmaster:command_history — recent owner-triggered device commands
 *   sniffmaster:command_seq — monotonic sequence for remote commands
 */

import { Redis } from "@upstash/redis";

let redis = null;

function redisEnv() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
}

export function isRedisConfigured() {
  const { url, token } = redisEnv();
  return Boolean(url && token);
}

function getRedis() {
  if (!isRedisConfigured()) {
    throw new Error("Upstash Redis environment variables are missing");
  }
  if (!redis) {
    redis = Redis.fromEnv();
  }
  return redis;
}

const KEY_LATEST = "sniffmaster:latest";
const KEY_HISTORY = "sniffmaster:history";
const KEY_SNIFF = "sniffmaster:sniff";
const KEY_SNIFF_HISTORY = "sniffmaster:sniff_history";
const KEY_SNIFF_SEQ = "sniffmaster:sniff_seq";
const KEY_COMMAND = "sniffmaster:command";
const KEY_COMMAND_HISTORY = "sniffmaster:command_history";
const KEY_COMMAND_SEQ = "sniffmaster:command_seq";
const KEY_BLE_OCCUPANCY = "sniffmaster:ble_occupancy";
const KEY_BLE_OCCUPANCY_HISTORY = "sniffmaster:ble_occupancy_history";
const KEY_ALERT_STATE = "sniffmaster:alert_state";
const KEY_ALERT_SNAPSHOT = "sniffmaster:alert_snapshot";
const KEY_DAILY_SUMMARY = "sniffmaster:daily_summary";
const KEY_DAILY_SUMMARY_HISTORY = "sniffmaster:daily_summary_history";
const KEY_SETTINGS = "sniffmaster:settings";
const MAX_HISTORY = 24 * 60; // 24 hours at the firmware's 1-minute post interval
export { MAX_HISTORY };
export const HOME_COARSE_STEP_MS = 10 * 60 * 1000;
export const MAX_HOME_COARSE = 7 * 24 * 6; // 7 days at 10-minute steps
export const MAX_HOME_FINE = 26 * 60; // 26 hours at a 1-minute post
const KEY_HOME_COARSE = "sniffmaster:home_coarse";
const KEY_HOME_FINE = "sniffmaster:home_fine";
const MAX_SNIFF_HISTORY = 96;
const MAX_COMMAND_HISTORY = 48;
const MAX_BLE_OCCUPANCY_HISTORY = 288; // 24 hours at 5-minute intervals
const MAX_DAILY_SUMMARY_HISTORY = 30; // ~1 month of morning reports
export const COMMAND_TTL_MS = 10 * 60 * 1000;

/**
 * One Upstash REST round-trip for a latest-value overwrite plus its history ring.
 * Each command inside the pipeline still counts toward the Redis quota.
 */
async function writeLatestAndRing(redis, latestKey, historyKey, json, max) {
  const pipe = redis.pipeline();
  pipe.set(latestKey, json);
  pipe.lpush(historyKey, json);
  pipe.ltrim(historyKey, 0, max - 1);
  await pipe.exec();
}

/**
 * Store a new sensor snapshot.
 * Overwrites latest and appends to history ring buffer.
 */
export async function putSnapshot(data) {
  const redis = getRedis();
  const entry = { ...data, receivedAt: Date.now() };
  const json = JSON.stringify(entry);
  await writeLatestAndRing(redis, KEY_LATEST, KEY_HISTORY, json, MAX_HISTORY);

  // Compact climate series for the Home tab. A failure here must not reject
  // the snapshot the device just posted.
  try {
    await recordHomeSeries(redis, entry);
  } catch (err) {
    console.error("home series append failed:", err);
  }

  return entry;
}

/** True when this reading should start a new 10-minute coarse sample. */
export function shouldSampleCoarse(lastTimestamp, nowMs, stepMs = HOME_COARSE_STEP_MS) {
  const last = Number(lastTimestamp);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= stepMs;
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Small climate point stored for mold, mite, and 24h home charts. */
export function compactClimatePoint(entry) {
  const t = Number(entry?.receivedAt);
  const point = {};
  if (!Number.isFinite(t)) return null;
  point.t = t;
  const rh = finiteOrNull(entry.humidity);
  if (rh !== null) point.rh = Math.round(rh * 10) / 10;
  let c = finiteOrNull(entry.temperature);
  if (c === null) c = finiteOrNull(entry.tempC);
  if (c === null) {
    const f = finiteOrNull(entry.tempF);
    if (f !== null) c = ((f - 32) * 5) / 9;
  }
  if (c !== null) point.tc = Math.round(c * 10) / 10;
  const co2 = finiteOrNull(entry.co2True) ?? finiteOrNull(entry.co2);
  if (co2 !== null) point.co2 = Math.round(co2);
  const iaq = finiteOrNull(entry.iaq);
  if (iaq !== null) point.iaq = Math.round(iaq);
  const pm25 = finiteOrNull(entry.pm25);
  if (pm25 !== null) point.pm25 = Math.round(pm25 * 10) / 10;
  return point;
}

function parseStored(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

async function recordHomeSeries(redis, entry) {
  const point = compactClimatePoint(entry);
  if (!point) return;
  const json = JSON.stringify(point);
  const last = parseStored(await redis.lindex(KEY_HOME_COARSE, 0));
  const pipe = redis.pipeline();
  pipe.lpush(KEY_HOME_FINE, json);
  if (shouldSampleCoarse(last?.t, point.t)) pipe.lpush(KEY_HOME_COARSE, json);
  pipe.ltrim(KEY_HOME_FINE, 0, MAX_HOME_FINE - 1);
  pipe.ltrim(KEY_HOME_COARSE, 0, MAX_HOME_COARSE - 1);
  await pipe.exec();
}

/**
 * Compact home climate history. `coarse` is up to 7 days at 10 minutes;
 * `fine` is the last 26 hours at the device's post interval.
 */
export async function getHomeSeries() {
  const redis = getRedis();
  const [coarse, fine] = await Promise.all([
    redis.lrange(KEY_HOME_COARSE, 0, MAX_HOME_COARSE - 1),
    redis.lrange(KEY_HOME_FINE, 0, MAX_HOME_FINE - 1),
  ]);
  const parseList = (items) => (items || []).map(parseStored).filter(Boolean);
  return { coarse: parseList(coarse), fine: parseList(fine) };
}

/**
 * Get the most recent snapshot.
 */
export async function getLatest() {
  const redis = getRedis();
  const raw = await redis.get(KEY_LATEST);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * Get recent history (newest first).
 * @param {number} count — max entries to return (default 48). Capped at 24h of 1-minute posts.
 */
export async function getHistory(count = 48) {
  const redis = getRedis();
  const n = Math.min(count, MAX_HISTORY);
  const items = await redis.lrange(KEY_HISTORY, 0, n - 1);
  return items.map((item) =>
    typeof item === "string" ? JSON.parse(item) : item
  );
}

/**
 * Store a priority sulfur/VSC event so the dashboard can react immediately.
 */
export async function putSniffEvent(data) {
  const redis = getRedis();
  const seq = await redis.incr(KEY_SNIFF_SEQ);
  const entry = {
    ...data,
    seq,
    receivedAt: Date.now(),
  };
  const json = JSON.stringify(entry);
  await writeLatestAndRing(redis, KEY_SNIFF, KEY_SNIFF_HISTORY, json, MAX_SNIFF_HISTORY);
  return entry;
}

/**
 * Get the most recent priority sulfur/VSC event.
 */
export async function getLatestSniff() {
  const redis = getRedis();
  const raw = await redis.get(KEY_SNIFF);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * Get recent priority sulfur/VSC events (newest first).
 */
export async function getSniffHistory(count = 12) {
  const redis = getRedis();
  const n = Math.min(count, MAX_SNIFF_HISTORY);
  const items = await redis.lrange(KEY_SNIFF_HISTORY, 0, n - 1);
  return items.map((item) =>
    typeof item === "string" ? JSON.parse(item) : item
  );
}

/**
 * Store a remote device command requested from the portal.
 */
export async function putCommand(data) {
  const redis = getRedis();
  const seq = await redis.incr(KEY_COMMAND_SEQ);
  const entry = {
    ...data,
    seq,
    receivedAt: Date.now(),
  };
  const json = JSON.stringify(entry);
  await writeLatestAndRing(redis, KEY_COMMAND, KEY_COMMAND_HISTORY, json, MAX_COMMAND_HISTORY);
  return entry;
}

/**
 * Latest owner command the device has not already applied and that is still
 * inside COMMAND_TTL_MS. `after` is the last seq the device executed.
 */
export function commandIfPending(latest, after = 0, now = Date.now()) {
  if (!latest || typeof latest !== "object") return null;
  const seq = Number(latest.seq || 0);
  const afterSeq = Number(after || 0);
  if (!Number.isFinite(seq) || seq <= (Number.isFinite(afterSeq) ? afterSeq : 0)) return null;
  const at = Number(latest.receivedAt || 0);
  if (!Number.isFinite(at) || now - at > COMMAND_TTL_MS) return null;
  return latest;
}

export async function getPendingCommand(after = 0) {
  return commandIfPending(await getLatestCommand(), after);
}

/**
 * Get the most recent remote device command.
 */
export async function getLatestCommand() {
  const redis = getRedis();
  const raw = await redis.get(KEY_COMMAND);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * Get recent remote commands (newest first).
 */
export async function getCommandHistory(count = 12) {
  const redis = getRedis();
  const n = Math.min(count, MAX_COMMAND_HISTORY);
  const items = await redis.lrange(KEY_COMMAND_HISTORY, 0, n - 1);
  return items.map((item) =>
    typeof item === "string" ? JSON.parse(item) : item
  );
}

export async function getStorageHealth() {
  if (!isRedisConfigured()) {
    return {
      storage: "upstash-redis",
      configured: false,
      reachable: false,
      latestPresent: false,
      latestSniffPresent: false,
      latestCommandPresent: false,
      snapshotHistoryDepth: 0,
      sniffHistoryDepth: 0,
      commandHistoryDepth: 0,
      error: "missing redis environment variables",
    };
  }

  try {
    const redis = getRedis();
    const [pong, latest, latestSniff, latestCommand, snapshotHistoryDepth, sniffHistoryDepth, commandHistoryDepth] = await Promise.all([
      redis.ping(),
      redis.get(KEY_LATEST),
      redis.get(KEY_SNIFF),
      redis.get(KEY_COMMAND),
      redis.llen(KEY_HISTORY),
      redis.llen(KEY_SNIFF_HISTORY),
      redis.llen(KEY_COMMAND_HISTORY),
    ]);

    return {
      storage: "upstash-redis",
      configured: true,
      reachable: true,
      pong,
      latestPresent: Boolean(latest),
      latestSniffPresent: Boolean(latestSniff),
      latestCommandPresent: Boolean(latestCommand),
      snapshotHistoryDepth: Number(snapshotHistoryDepth || 0),
      sniffHistoryDepth: Number(sniffHistoryDepth || 0),
      commandHistoryDepth: Number(commandHistoryDepth || 0),
    };
  } catch (err) {
    return {
      storage: "upstash-redis",
      configured: true,
      reachable: false,
      latestPresent: false,
      latestSniffPresent: false,
      latestCommandPresent: false,
      snapshotHistoryDepth: 0,
      sniffHistoryDepth: 0,
      commandHistoryDepth: 0,
      error: err?.message || String(err),
    };
  }
}

/**
 * Store a BLE occupancy snapshot for the history ring buffer.
 * Called from the /api/update handler whenever the snapshot includes BLE data.
 */
export async function putBleOccupancyEntry(data) {
  const redis = getRedis();
  const entry = {
    deviceCount: data.bleDeviceCount ?? 0,
    occupancyIndex: data.bleOccupancyIndex ?? 0,
    avgRssi: data.bleAvgRssi ?? -100,
    strongestRssi: data.bleStrongestRssi ?? -100,
    seenRecently: Boolean(data.bleSeenRecently),
    enabled: Boolean(data.blePresenceEnabled),
    receivedAt: data.receivedAt || Date.now(),
  };
  const json = JSON.stringify(entry);
  await writeLatestAndRing(redis, KEY_BLE_OCCUPANCY, KEY_BLE_OCCUPANCY_HISTORY, json, MAX_BLE_OCCUPANCY_HISTORY);
  return entry;
}

/**
 * Get the most recent BLE occupancy snapshot.
 */
export async function getLatestBleOccupancy() {
  const redis = getRedis();
  const raw = await redis.get(KEY_BLE_OCCUPANCY);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * Get recent BLE occupancy history (newest first).
 * @param {number} count — max entries to return (default 48)
 */
export async function getBleOccupancyHistory(count = 48) {
  const redis = getRedis();
  const n = Math.min(count, MAX_BLE_OCCUPANCY_HISTORY);
  const items = await redis.lrange(KEY_BLE_OCCUPANCY_HISTORY, 0, n - 1);
  return items.map((item) =>
    typeof item === "string" ? JSON.parse(item) : item
  );
}

/**
 * Alert de-dupe state for threshold SMS alerts.
 * Shape: { activeKeys: string[], sentAt: { [key]: epochMs } }
 * Lets /api/update fire an SMS only when a breach newly appears (state
 * transition) and re-fire the same breach only after a per-key cooldown.
 */
export async function getAlertState() {
  const redis = getRedis();
  const raw = await redis.get(KEY_ALERT_STATE);
  if (!raw) return { activeKeys: [], sentAt: {} };
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return {
    activeKeys: Array.isArray(parsed.activeKeys) ? parsed.activeKeys : [],
    sentAt: parsed.sentAt && typeof parsed.sentAt === "object" ? parsed.sentAt : {},
  };
}

export async function setAlertState(state) {
  const redis = getRedis();
  const entry = {
    activeKeys: Array.isArray(state?.activeKeys) ? state.activeKeys : [],
    sentAt: state?.sentAt && typeof state.sentAt === "object" ? state.sentAt : {},
    updatedAt: Date.now(),
  };
  await redis.set(KEY_ALERT_STATE, JSON.stringify(entry));
  return entry;
}

/**
 * Latest real-time-alert summary (24h stats + baseline + weather outlook,
 * same shape as a daily summary) — a single slot, no history, distinct from
 * putDailySummary/getDailySummary (the morning cron's record, which has its
 * own resend-guard/lock semantics this must not disturb). /api/report-card
 * reads whichever of the two is newer, so an alert's visual reflects the
 * alert's own numbers instead of a stale morning report.
 */
export async function putAlertSnapshot(data) {
  const redis = getRedis();
  const entry = { ...data, generatedAt: data?.generatedAt || Date.now() };
  await redis.set(KEY_ALERT_SNAPSHOT, JSON.stringify(entry));
  return entry;
}

export async function getAlertSnapshot() {
  const redis = getRedis();
  const raw = await redis.get(KEY_ALERT_SNAPSHOT);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * Atomically claim the right to generate+send today's daily summary.
 * Uses SET NX EX so a double cron fire (or a manual trigger racing the cron)
 * can never double-text: exactly one caller wins the lock per window.
 * @param {number} ttlSeconds — how long the claim blocks re-sends
 * @returns {Promise<boolean>} true if this caller won the lock
 */
export async function acquireDailySummaryLock(ttlSeconds) {
  const redis = getRedis();
  const result = await redis.set(
    "sniffmaster:daily_summary_lock",
    String(Date.now()),
    { nx: true, ex: Math.max(60, Math.floor(ttlSeconds)) }
  );
  // Upstash returns "OK" when the key was set, null when it already existed.
  return result === "OK";
}

/**
 * Rate-limit for the unauthenticated "send me a test report now" trigger
 * (see api/daily-summary.js's ?manual=true path). Distinct key/lock from
 * acquireDailySummaryLock — that one guards the cron's own dedup window (up
 * to 6h) and would otherwise block a manual test for hours; this one is a
 * short, tight cooldown whose only job is capping how often an
 * unauthenticated caller can trigger a real (costs-money) send.
 * @param {number} ttlSeconds
 * @returns {Promise<boolean>} true if this caller won the lock
 */
export async function acquireManualReportLock(ttlSeconds) {
  const redis = getRedis();
  const result = await redis.set(
    "sniffmaster:manual_report_lock",
    String(Date.now()),
    { nx: true, ex: Math.max(30, Math.floor(ttlSeconds)) }
  );
  return result === "OK";
}

/**
 * Store a daily summary snapshot (the morning 24h report) so the dashboard
 * panel and follow-up runs can read it. Overwrites latest + appends to history.
 */
export async function putDailySummary(data) {
  const redis = getRedis();
  const entry = { ...data, generatedAt: data?.generatedAt || Date.now() };
  const json = JSON.stringify(entry);
  await writeLatestAndRing(redis, KEY_DAILY_SUMMARY, KEY_DAILY_SUMMARY_HISTORY, json, MAX_DAILY_SUMMARY_HISTORY);
  return entry;
}

/**
 * Set smsDelivered on the stored latest summary (and its history head)
 * WITHOUT re-appending to history the way putDailySummary would — used both
 * after a successful retry send (delivered=true) and to record the outcome
 * of a send that ran after the summary was already stored (see
 * api/daily-summary.js: the summary is stored before sending so the
 * report-card image reflects today's numbers by the time a provider fetches
 * it, then this records how the send went).
 * @param {boolean} [delivered]
 */
export async function markDailySummaryDelivered(delivered = true) {
  const redis = getRedis();
  const raw = await redis.get(KEY_DAILY_SUMMARY);
  if (!raw) return null;
  const entry = typeof raw === "string" ? JSON.parse(raw) : raw;
  entry.smsDelivered = delivered;
  const json = JSON.stringify(entry);
  await redis.set(KEY_DAILY_SUMMARY, json);
  // Best effort: the history head is the same record; keep it consistent. The
  // latest key above is the source of truth for the retry guard, so a failure
  // here (empty list, rotated head) is cosmetic.
  try {
    await redis.lset(KEY_DAILY_SUMMARY_HISTORY, 0, json);
  } catch {}
  return entry;
}

export async function getDailySummary() {
  const redis = getRedis();
  const raw = await redis.get(KEY_DAILY_SUMMARY);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * Owner-adjustable settings (currently alert-threshold overrides). Returns {}
 * when unset so callers fall back to built-in defaults.
 */
export async function getSettings() {
  const redis = getRedis();
  const raw = await redis.get(KEY_SETTINGS);
  if (!raw) return {};
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return parsed && typeof parsed === "object" ? parsed : {};
}

/**
 * Merge a partial patch into stored settings and persist. Only defined keys in
 * the patch overwrite; returns the full merged object.
 */
export async function putSettings(patch) {
  const redis = getRedis();
  const current = await getSettings();
  const next = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v !== undefined) next[k] = v;
  }
  next.updatedAt = Date.now();
  await redis.set(KEY_SETTINGS, JSON.stringify(next));
  return next;
}

export async function getDailySummaryHistory(count = 14) {
  const redis = getRedis();
  const n = Math.min(count, MAX_DAILY_SUMMARY_HISTORY);
  const items = await redis.lrange(KEY_DAILY_SUMMARY_HISTORY, 0, n - 1);
  return items.map((item) =>
    typeof item === "string" ? JSON.parse(item) : item
  );
}

// ── Generic short-lived cache + counters (outdoor feeds, API-quota guards) ──

/** Read a JSON value cached with setJsonCache; null when absent/expired. */
export async function getJsonCache(key) {
  const redis = getRedis();
  const raw = await redis.get(`sniffmaster:cache:${key}`);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * Run `fn` while holding a short Redis lock (SET NX PX + token-checked
 * release). Waits up to ~3s for the lock; throws if it can't get it.
 */
export async function withLock(name, fn, { ttlMs = 8000, waitMs = 3000 } = {}) {
  const redis = getRedis();
  const key = `sniffmaster:lock:${name}`;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + waitMs;
  while ((await redis.set(key, token, { nx: true, px: ttlMs })) !== "OK") {
    if (Date.now() > deadline) throw new Error(`lock busy: ${name}`);
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 90));
  }
  try {
    return await fn();
  } finally {
    try {
      if ((await redis.get(key)) === token) await redis.del(key);
    } catch (err) {
      console.error(`lock release failed: ${name}`, err?.message || err);
    }
  }
}

/** Cache a JSON value for `ttlSec` seconds. */
export async function setJsonCache(key, value, ttlSec) {
  const redis = getRedis();
  await redis.set(`sniffmaster:cache:${key}`, JSON.stringify(value), { ex: Math.max(1, Math.floor(ttlSec)) });
}

/**
 * Atomically increment a counter and (on first increment) give it a TTL so it
 * resets itself. Returns the new value. Used to hard-cap paid API calls.
 */
export async function incrCounter(key, ttlSec) {
  const redis = getRedis();
  const k = `sniffmaster:counter:${key}`;
  const n = await redis.incr(k);
  // Repair a missing expiry on later calls too. The first increment is the
  // common case; if that EXPIRE failed, the month counter would otherwise
  // never reset and pollen would stay capped.
  let ttl = -1;
  try {
    ttl = await redis.ttl(k);
  } catch {
    ttl = -1;
  }
  if (typeof ttl !== "number" || ttl < 0) {
    await redis.expire(k, Math.max(1, Math.floor(ttlSec)));
  }
  return n;
}

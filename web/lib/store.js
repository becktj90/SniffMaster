/**
 * store.js — Upstash Redis data store for SniffMaster web relay
 *
 * Keys:
 *   sniffmaster:latest   — most recent sensor snapshot (JSON)
 *   sniffmaster:history  — sorted list of recent snapshots (last 1008 = 7d @ 10min)
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
const MAX_HISTORY = 1008; // 7 days at 10-minute intervals
const MAX_SNIFF_HISTORY = 96;
const MAX_COMMAND_HISTORY = 48;
const MAX_BLE_OCCUPANCY_HISTORY = 288; // 24 hours at 5-minute intervals
const MAX_DAILY_SUMMARY_HISTORY = 30; // ~1 month of morning reports

/**
 * Store a new sensor snapshot.
 * Overwrites latest and appends to history ring buffer.
 */
export async function putSnapshot(data) {
  const redis = getRedis();
  const entry = { ...data, receivedAt: Date.now() };
  const json = JSON.stringify(entry);

  await Promise.all([
    redis.set(KEY_LATEST, json),
    redis.lpush(KEY_HISTORY, json),
  ]);

  // Trim history to MAX_HISTORY entries
  await redis.ltrim(KEY_HISTORY, 0, MAX_HISTORY - 1);

  return entry;
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
 * @param {number} count — max entries to return (default 48 = 8 hours @ 10min)
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

  await Promise.all([
    redis.set(KEY_SNIFF, json),
    redis.lpush(KEY_SNIFF_HISTORY, json),
  ]);

  await redis.ltrim(KEY_SNIFF_HISTORY, 0, MAX_SNIFF_HISTORY - 1);
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

  await Promise.all([
    redis.set(KEY_COMMAND, json),
    redis.lpush(KEY_COMMAND_HISTORY, json),
  ]);

  await redis.ltrim(KEY_COMMAND_HISTORY, 0, MAX_COMMAND_HISTORY - 1);
  return entry;
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

  await Promise.all([
    redis.set(KEY_BLE_OCCUPANCY, json),
    redis.lpush(KEY_BLE_OCCUPANCY_HISTORY, json),
  ]);

  await redis.ltrim(KEY_BLE_OCCUPANCY_HISTORY, 0, MAX_BLE_OCCUPANCY_HISTORY - 1);
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
 * Store a daily summary snapshot (the morning 24h report) so the dashboard
 * panel and follow-up runs can read it. Overwrites latest + appends to history.
 */
export async function putDailySummary(data) {
  const redis = getRedis();
  const entry = { ...data, generatedAt: data?.generatedAt || Date.now() };
  const json = JSON.stringify(entry);

  await Promise.all([
    redis.set(KEY_DAILY_SUMMARY, json),
    redis.lpush(KEY_DAILY_SUMMARY_HISTORY, json),
  ]);

  await redis.ltrim(KEY_DAILY_SUMMARY_HISTORY, 0, MAX_DAILY_SUMMARY_HISTORY - 1);
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

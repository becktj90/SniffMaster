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
 *   sniffmaster:dad_joke — latest server-side dad joke payload
 *   sniffmaster:dad_joke_history — recent generated daily jokes
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
const KEY_DAD_JOKE = "sniffmaster:dad_joke";
const KEY_DAD_JOKE_HISTORY = "sniffmaster:dad_joke_history";
const MAX_HISTORY = 1008; // 7 days at 10-minute intervals
const MAX_SNIFF_HISTORY = 96;
const MAX_COMMAND_HISTORY = 48;
const MAX_DAD_JOKE_HISTORY = 60;

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

export async function putDadJoke(data) {
  const redis = getRedis();
  const entry = {
    ...data,
    generatedAt: Date.now(),
  };
  const json = JSON.stringify(entry);

  await Promise.all([
    redis.set(KEY_DAD_JOKE, json),
    redis.lpush(KEY_DAD_JOKE_HISTORY, json),
  ]);

  await redis.ltrim(KEY_DAD_JOKE_HISTORY, 0, MAX_DAD_JOKE_HISTORY - 1);
  return entry;
}

export async function getLatestDadJoke() {
  const redis = getRedis();
  const raw = await redis.get(KEY_DAD_JOKE);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function getDadJokeHistory(count = 18) {
  const redis = getRedis();
  const n = Math.min(count, MAX_DAD_JOKE_HISTORY);
  const items = await redis.lrange(KEY_DAD_JOKE_HISTORY, 0, n - 1);
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

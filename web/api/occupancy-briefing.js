/**
 * GET /api/occupancy-briefing — returns a BLE occupancy analysis with an
 * AI-generated insight using the same OpenAI pattern as weather-briefing.
 *
 * Response shape:
 * {
 *   occupancyIndex: 0–100,
 *   deviceCount: number,
 *   avgRssi: dBm | null,
 *   strongestRssi: dBm | null,
 *   seenRecently: boolean,
 *   enabled: boolean,
 *   densityLabel: "Empty" | "Low" | "Moderate" | "Busy" | "Packed",
 *   densityNote: string,
 *   trend: { direction: "rising" | "falling" | "stable", delta: number },
 *   history: [{occupancyIndex, deviceCount, receivedAt}, ...],
 *   briefing: string,
 *   mode: "openai" | "deterministic",
 *   receivedAt: number | null,
 *   generatedAt: number,
 * }
 */

import { getLatest, getLatestBleOccupancy, getBleOccupancyHistory, getHistory } from "../lib/store.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Map occupancy index (0–100) to a human-readable density label. */
function densityLabel(index) {
  if (index <= 5)  return "Empty";
  if (index <= 25) return "Low";
  if (index <= 55) return "Moderate";
  if (index <= 80) return "Busy";
  return "Packed";
}

/** Contextual note explaining the density label. */
function densityNote(index, source) {
  const co2ctx = source === "co2" ? " (derived from CO₂ reading)" : "";
  if (index <= 5)  return `No elevated CO₂ detected. The space appears unoccupied or very well-ventilated${co2ctx}.`;
  if (index <= 25) return `CO₂ is only slightly above ambient. Light occupancy or excellent ventilation${co2ctx}.`;
  if (index <= 55) return `CO₂ at a moderate level consistent with normal occupancy — typical for an active work session${co2ctx}.`;
  if (index <= 80) return `Elevated CO₂ indicates meaningful occupancy. Shared-air buildup is accelerating${co2ctx}.`;
  return `High CO₂ suggests the space is at or near capacity. Ventilate promptly${co2ctx}.`;
}

/** Derive a simple trend from the two most recent history entries. */
function deriveTrend(history) {
  if (!Array.isArray(history) || history.length < 2) {
    return { direction: "stable", delta: 0 };
  }
  const latest = num(history[0]?.occupancyIndex);
  const prior  = num(history[1]?.occupancyIndex);
  const delta  = latest - prior;
  const direction = delta > 5 ? "rising" : delta < -5 ? "falling" : "stable";
  return { direction, delta };
}

/**
 * Compute a CO₂-based occupancy index (0–100).
 * Baseline outdoor CO₂ is ~400 ppm; index saturates at ~1600 ppm (400 + 12×100).
 * Each index point ≈ 12 ppm above ambient, which loosely tracks one person's
 * CO₂ contribution in a typical small-to-medium room.
 */
const CO2_BASELINE_PPM   = 400; // outdoor ambient
const CO2_PPM_PER_INDEX  = 12;  // ~12 ppm per index point → 100 at 1 600 ppm

function co2ToOccupancyIndex(co2) {
  if (!co2 || co2 < 350) return 0;
  return clamp(Math.round((co2 - CO2_BASELINE_PPM) / CO2_PPM_PER_INDEX), 0, 100);
}

/**
 * Build a synthetic occupancy history from raw sensor snapshots.
 * Each entry becomes {occupancyIndex, co2, receivedAt}.
 */
function buildCo2History(sensorHistory) {
  if (!Array.isArray(sensorHistory)) return [];
  return sensorHistory
    .filter((h) => num(h.co2) > 0)
    .map((h) => ({
      occupancyIndex: co2ToOccupancyIndex(num(h.co2)),
      co2: num(h.co2),
      receivedAt: h.receivedAt || null,
    }));
}

/** Deterministic fallback briefing when OpenAI is unavailable. */
function fallbackBriefing(index, deviceCount, trend, snapshot, source) {
  const label = densityLabel(index);
  const trendStr = trend.direction === "rising"
    ? "and occupancy is climbing"
    : trend.direction === "falling"
      ? "and occupancy is declining"
      : "with stable occupancy";
  const co2 = num(snapshot?.co2);
  if (source === "co2" && co2 > 0) {
    return `${label} occupancy (index ${index}) estimated from CO₂ at ${Math.round(co2)} ppm ${trendStr}. CO₂ is a reliable proxy for room occupancy — elevated readings indicate more people or reduced ventilation.`;
  }
  const co2Line = co2 > 900
    ? ` CO2 is elevated at ${Math.round(co2)} ppm — consistent with the detected occupancy load.`
    : co2 > 0
      ? ` CO2 is at ${Math.round(co2)} ppm, which aligns with current occupancy.`
      : "";
  return `${label} occupancy (index ${index}) with ${deviceCount} BLE device${deviceCount !== 1 ? "s" : ""} detected ${trendStr}.${co2Line}`;
}

function extractOutputText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }
  const parts = [];
  const output = Array.isArray(responseJson?.output) ? responseJson.output : [];
  output.forEach((item) => {
    const content = Array.isArray(item?.content) ? item.content : [];
    content.forEach((piece) => {
      if (typeof piece?.text === "string" && piece.text.trim()) parts.push(piece.text.trim());
    });
  });
  return parts.join("\n").trim();
}

async function generateOpenAiBriefing(occupancyData, snapshot, trend, fallback, source) {
  const apiKey = `${process.env.OPENAI_API_KEY || ""}`.trim();
  if (!apiKey) return null;

  const model = `${process.env.OPENAI_OCCUPANCY_MODEL || process.env.OPENAI_WEATHER_MODEL || "gpt-5.4-nano"}`.trim();
  const index    = num(occupancyData?.occupancyIndex);
  const devices  = num(occupancyData?.deviceCount);
  const avgRssi  = num(occupancyData?.avgRssi, NaN);
  const co2      = num(snapshot?.co2);
  const iaq      = num(snapshot?.iaq);
  const tempF    = num(snapshot?.tempF);
  const humidity = num(snapshot?.humidity);
  const trendStr = trend.direction;

  const sourceNote = source === "co2"
    ? `Occupancy is estimated from CO₂ (${Math.round(co2)} ppm). CO₂ above ~400 ppm ambient indicates people are present.`
    : `${devices} BLE device(s) detected.${Number.isFinite(avgRssi) ? ` Average signal: ${Math.round(avgRssi)} dBm.` : ""}`;

  const prompt = [
    "Write a concise occupancy insight for a professional indoor air quality and space management dashboard.",
    "Keep it to 2 or 3 sentences, under 80 words.",
    "Focus on occupancy level, any air quality implications, and actionable ventilation or density guidance.",
    "Do not be chatty or mention AI.",
    `Current occupancy index: ${index}/100 (${densityLabel(index)}), trend: ${trendStr}.`,
    sourceNote,
    co2 > 0 ? `Indoor CO2: ${Math.round(co2)} ppm, IAQ: ${Math.round(iaq)}, Temp: ${Math.round(tempF)}F, Humidity: ${Math.round(humidity)}%.` : "",
    `Fallback: ${fallback}`,
  ].filter(Boolean).join("\n");

  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: 130,
    }),
  });

  if (!res.ok) throw new Error(`openai ${res.status}`);

  const json = await res.json();
  const text = extractOutputText(json);
  return text || null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  try {
    const [bleEntry, snapshot, bleHistory, sensorHistory] = await Promise.all([
      getLatestBleOccupancy(),
      getLatest(),
      getBleOccupancyHistory(48),
      getHistory(48),
    ]);

    // Return 204 if no data at all
    if (!bleEntry && !snapshot) return res.status(204).end();

    // Determine source: prefer BLE if available, otherwise fall back to CO₂
    const co2 = num(snapshot?.co2);
    const hasBle = Boolean(bleEntry || num(snapshot?.bleDeviceCount));
    const source = hasBle ? "ble" : co2 > 0 ? "co2" : "none";

    let index, devices, avgRssi, strongest, history;

    if (source === "ble") {
      // Merge: prefer dedicated BLE entry; fall back to fields in the latest snapshot
      const entry = bleEntry || {
        deviceCount:     num(snapshot?.bleDeviceCount),
        occupancyIndex:  num(snapshot?.bleOccupancyIndex),
        avgRssi:         num(snapshot?.bleAvgRssi, NaN),
        strongestRssi:   num(snapshot?.bleStrongestRssi, NaN),
        seenRecently:    Boolean(snapshot?.bleSeenRecently),
        enabled:         Boolean(snapshot?.blePresenceEnabled),
        receivedAt:      snapshot?.receivedAt || null,
      };
      index    = clamp(num(entry.occupancyIndex), 0, 100);
      devices  = Math.max(0, num(entry.deviceCount));
      avgRssi  = num(entry.avgRssi, NaN);
      strongest = num(entry.strongestRssi, NaN);
      history  = bleHistory.slice(0, 48).map((h) => ({
        occupancyIndex: num(h.occupancyIndex),
        deviceCount:    num(h.deviceCount),
        co2:            null,
        receivedAt:     h.receivedAt || null,
      }));
    } else if (source === "co2") {
      // CO₂-based occupancy: index saturates at ~1600 ppm
      index    = co2ToOccupancyIndex(co2);
      devices  = 0;
      avgRssi  = NaN;
      strongest = NaN;
      history  = buildCo2History(sensorHistory).slice(0, 48);
    } else {
      return res.status(204).end();
    }

    const trend   = deriveTrend(history.length >= 2 ? history : []);
    const fallback = fallbackBriefing(index, devices, trend, snapshot, source);

    let briefing = fallback;
    let mode = "deterministic";

    try {
      const occupancyData = { occupancyIndex: index, deviceCount: devices, avgRssi };
      const aiBriefing = await generateOpenAiBriefing(occupancyData, snapshot, trend, fallback, source);
      if (aiBriefing) {
        briefing = aiBriefing;
        mode = "openai";
      }
    } catch (err) {
      console.error("occupancy-briefing openai error:", err);
    }

    return res.status(200).json({
      occupancyIndex:  index,
      deviceCount:     devices,
      avgRssi:         Number.isFinite(avgRssi)   ? Math.round(avgRssi)   : null,
      strongestRssi:   Number.isFinite(strongest) ? Math.round(strongest) : null,
      seenRecently:    source === "ble" ? Boolean(snapshot?.bleSeenRecently) : true,
      enabled:         true,
      densityLabel:    densityLabel(index),
      densityNote:     densityNote(index, source),
      source,
      co2Reading:      co2 > 0 ? Math.round(co2) : null,
      trend,
      history:         history.slice(0, 48).map((h) => ({
        occupancyIndex: num(h.occupancyIndex),
        deviceCount:    num(h.deviceCount),
        co2:            h.co2 || null,
        receivedAt:     h.receivedAt || null,
      })),
      briefing,
      mode,
      receivedAt:      snapshot?.receivedAt || null,
      generatedAt:     Date.now(),
    });
  } catch (err) {
    console.error("occupancy-briefing error:", err);
    return res.status(500).json({ error: "occupancy briefing error" });
  }
}

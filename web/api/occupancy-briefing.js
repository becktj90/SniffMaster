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

import { getLatest, getLatestBleOccupancy, getBleOccupancyHistory } from "../lib/store.js";

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
function densityNote(index) {
  if (index <= 5)  return "No BLE devices detected. The space appears unoccupied or all devices are out of range.";
  if (index <= 25) return "A small number of devices are present. The space is likely lightly occupied.";
  if (index <= 55) return "Several devices detected. Moderate occupancy — typical for a normal work session.";
  if (index <= 80) return "High device density. The space is busy and shared-air buildup will accelerate.";
  return "Very high device density. The space is at or near capacity.";
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

/** Deterministic fallback briefing when OpenAI is unavailable. */
function fallbackBriefing(index, deviceCount, trend, snapshot) {
  const label = densityLabel(index);
  const trendStr = trend.direction === "rising"
    ? "and occupancy is climbing"
    : trend.direction === "falling"
      ? "and occupancy is declining"
      : "with stable occupancy";
  const co2 = num(snapshot?.co2);
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

async function generateOpenAiBriefing(bleEntry, snapshot, trend, fallback) {
  const apiKey = `${process.env.OPENAI_API_KEY || ""}`.trim();
  if (!apiKey) return null;

  const model = `${process.env.OPENAI_OCCUPANCY_MODEL || process.env.OPENAI_WEATHER_MODEL || "gpt-5.4-nano"}`.trim();
  const index      = num(bleEntry?.occupancyIndex);
  const devices    = num(bleEntry?.deviceCount);
  const avgRssi    = num(bleEntry?.avgRssi, NaN);
  const co2        = num(snapshot?.co2);
  const iaq        = num(snapshot?.iaq);
  const tempF      = num(snapshot?.tempF);
  const humidity   = num(snapshot?.humidity);
  const trendStr   = trend.direction;

  const prompt = [
    "Write a concise occupancy insight for a professional indoor air quality and space management dashboard.",
    "Keep it to 2 or 3 sentences, under 80 words.",
    "Focus on occupancy level, any air quality implications, and actionable ventilation or density guidance.",
    "Do not mention Bluetooth, BLE, or device counting directly — frame it as space occupancy or room density.",
    "Do not be chatty or mention AI.",
    `Current occupancy index: ${index}/100 (${densityLabel(index)}), ${devices} device(s) detected, trend: ${trendStr}.`,
    Number.isFinite(avgRssi) ? `Average signal strength: ${Math.round(avgRssi)} dBm.` : "",
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
    const [bleEntry, snapshot, history] = await Promise.all([
      getLatestBleOccupancy(),
      getLatest(),
      getBleOccupancyHistory(48),
    ]);

    // Return 204 if no BLE data has ever been posted
    if (!bleEntry && !snapshot) return res.status(204).end();

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

    const index     = clamp(num(entry.occupancyIndex), 0, 100);
    const devices   = Math.max(0, num(entry.deviceCount));
    const avgRssi   = num(entry.avgRssi, NaN);
    const strongest = num(entry.strongestRssi, NaN);
    const trend     = deriveTrend(history);
    const fallback  = fallbackBriefing(index, devices, trend, snapshot);

    let briefing = fallback;
    let mode = "deterministic";

    try {
      const aiBriefing = await generateOpenAiBriefing(entry, snapshot, trend, fallback);
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
      seenRecently:    Boolean(entry.seenRecently),
      enabled:         Boolean(entry.enabled),
      densityLabel:    densityLabel(index),
      densityNote:     densityNote(index),
      trend,
      history:         history.slice(0, 48).map((h) => ({
        occupancyIndex: num(h.occupancyIndex),
        deviceCount:    num(h.deviceCount),
        receivedAt:     h.receivedAt || null,
      })),
      briefing,
      mode,
      receivedAt:      entry.receivedAt || null,
      generatedAt:     Date.now(),
    });
  } catch (err) {
    console.error("occupancy-briefing error:", err);
    return res.status(500).json({ error: "occupancy briefing error" });
  }
}

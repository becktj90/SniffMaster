/**
 * GET /api/office-stats — returns office-oriented derived room metrics
 *
 * Includes focus and ventilation-risk heuristics derived from the latest
 * sensor snapshot. Returns 204 if no snapshot exists yet.
 */

import { getLatest } from "../lib/store.js";

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function deriveCfiScore(snapshot) {
  const explicit = num(snapshot?.cfiScore, NaN);
  if (Number.isFinite(explicit)) return clamp(explicit, 0, 1);
  let score = 1;
  const co2 = num(snapshot?.co2);
  const iaq = num(snapshot?.iaq);
  if (co2 > 800) score -= ((co2 - 800) / 100) * 0.05;
  if (iaq > 100) score -= 0.10;
  return clamp(score, 0, 1);
}

function deriveCfiPercent(snapshot) {
  const explicit = num(snapshot?.cfiPercent, NaN);
  if (Number.isFinite(explicit)) return Math.round(clamp(explicit, 0, 100));
  return Math.round(deriveCfiScore(snapshot) * 100);
}

function deriveCfiBand(snapshot) {
  const explicit = `${snapshot?.cfiBand || ""}`.trim();
  if (explicit) return explicit;
  const percent = deriveCfiPercent(snapshot);
  if (percent >= 80) return "Peak";
  if (percent >= 60) return "Reduced";
  return "Drained";
}

function deriveVtrLevel(snapshot) {
  const explicit = num(snapshot?.vtrLevel, NaN);
  if (Number.isFinite(explicit)) return clamp(Math.round(explicit), 0, 2);
  const humidity = num(snapshot?.humidity);
  const co2 = num(snapshot?.co2);
  const iaq = num(snapshot?.iaq);
  if (humidity < 30 && co2 > 1200) return 2;
  if (humidity >= 40 && humidity <= 60 && co2 < 800 && iaq <= 100) return 0;
  return 1;
}

function deriveVtrLabel(level) {
  if (level === 0) return "Safe";
  if (level === 2) return "High Bio-Risk";
  return "Elevated";
}

function deriveVtrAdvice(level) {
  if (level === 0) return "Ventilation and humidity are in a favorable range.";
  if (level === 2) return "Dry, rebreathed air pattern detected. Air cleaning, filtration, or masking is recommended.";
  return "Stagnant or dry air detected. Increase ventilation.";
}

function deriveAttention(snapshot) {
  const co2 = num(snapshot?.co2);
  const iaq = num(snapshot?.iaq);
  const temp = num(snapshot?.tempF);
  const voc = num(snapshot?.voc);
  const dVoc = Math.abs(num(snapshot?.dVoc));
  let score = 0;

  if (co2 > 1200) score += 2;
  else if (co2 > 950) score += 1;
  else if (co2 > 800) score += 0.5;
  if (iaq > 120) score += 1;
  else if (iaq > 80) score += 0.5;
  if (temp > 79 || temp < 67) score += 0.75;
  else if (temp > 77 || temp < 69) score += 0.35;
  if (voc > 1.2 || dVoc > 0.25) score += 0.5;

  if (score >= 3) return { title: "Heavy drag", note: "Expect concentration to decay faster and routine work to feel more expensive than it should." };
  if (score >= 1.5) return { title: "Moderate drag", note: "Attention is still workable, but the room is starting to tax patience, clarity, or pace." };
  return { title: "Low drag", note: "Air conditions are not likely to be the main thing slowing people down right now." };
}

function deriveComfort(snapshot) {
  const temp = num(snapshot?.tempF);
  const humidity = num(snapshot?.humidity);
  if (humidity < 30) return { title: "Dry air load", note: "Low humidity can dry out eyes and throat, which makes long desk sessions feel harsher than the room looks." };
  if (humidity > 65) return { title: "Sticky air", note: "High humidity makes the room feel heavier and can amplify perceived stuffiness in meetings." };
  if (temp > 79) return { title: "Running warm", note: "Warm rooms tend to sap alertness and make shared spaces feel sluggish faster." };
  if (temp < 67) return { title: "Running cool", note: "A cool room can stay usable, but some people will feel it as distraction rather than freshness." };
  return { title: "Comfortable band", note: "Temperature and humidity are in a range that should stay easy to inhabit for longer work blocks." };
}

function deriveCollaboration(snapshot) {
  const co2 = num(snapshot?.co2);
  const iaq = num(snapshot?.iaq);
  if (co2 > 1400 || iaq > 130) return { title: "Stale room load", note: "This is the kind of air that makes group work feel slow, repetitive, and less patient than it should." };
  if (co2 > 1000 || iaq > 90) return { title: "Shared-air heavy", note: "The room is still workable, but longer meetings will feel flatter unless you give it some turnover." };
  if (co2 > 800) return { title: "Occupied but workable", note: "There is some rebreathed-air buildup, though the room is still in decent shape for normal collaboration." };
  return { title: "Meeting ready", note: "Shared-air load is low enough that the room should feel clear and easier to work in." };
}

function deriveOdorDistraction(snapshot) {
  const voc = num(snapshot?.voc);
  const dVoc = Math.abs(num(snapshot?.dVoc));
  const primary = `${snapshot?.primary || ""}`.trim();
  const primaryConf = num(snapshot?.primaryConf);
  const confident = Boolean(primary && primaryConf >= 20);
  if ((confident && primaryConf >= 40) || voc >= 1.5 || dVoc >= 0.35) {
    return { title: confident ? `${primary} is noticeable` : "Air signature is distracting", note: "The room has enough volatile activity that people are more likely to notice the environment, not just the work." };
  }
  if (confident || voc >= 0.9 || dVoc >= 0.18) {
    return { title: confident ? `${primary} in the background` : "Mild sensory load", note: "There is some environmental character in the room, but it should stay secondary unless people are sensitive to smells." };
  }
  return { title: "Easy to ignore", note: "The air is quiet enough that odor should not become part of the conversation." };
}

function deriveBriefing(snapshot, cfiPercent, vtrLevel) {
  const attention = deriveAttention(snapshot);
  const comfort = deriveComfort(snapshot);
  const collab = deriveCollaboration(snapshot);
  const odor = deriveOdorDistraction(snapshot);
  if (vtrLevel >= 2) {
    return "The room is stacking multiple human-cost signals at once: dry shared air, weaker attention conditions, and a higher chance that people feel the space before they say anything about it.";
  }
  if (cfiPercent < 60) {
    return "The main hit right now is cognitive. This room is likely making focus, short-term memory, and meeting patience feel worse than they need to.";
  }
  return `${attention.title}, ${comfort.title.toLowerCase()}, and ${collab.title.toLowerCase()}. ${odor.note}`;
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
    const snapshot = await getLatest();
    if (!snapshot) return res.status(204).end();

    const cfiScore = deriveCfiScore(snapshot);
    const cfiPercent = deriveCfiPercent(snapshot);
    const cfiBand = deriveCfiBand(snapshot);
    const vtrLevel = deriveVtrLevel(snapshot);
    const attention = deriveAttention(snapshot);
    const comfort = deriveComfort(snapshot);
    const collaboration = deriveCollaboration(snapshot);
    const odorDistraction = deriveOdorDistraction(snapshot);

    return res.status(200).json({
      cfiScore,
      cfiPercent,
      cfiBand,
      vtrLevel,
      vtrLabel: deriveVtrLabel(vtrLevel),
      vtrAdvice: deriveVtrAdvice(vtrLevel),
      attention,
      comfort,
      collaboration,
      odorDistraction,
      briefing: deriveBriefing(snapshot, cfiPercent, vtrLevel),
      co2: num(snapshot.co2),
      iaq: num(snapshot.iaq),
      humidity: num(snapshot.humidity),
      receivedAt: snapshot.receivedAt || null,
      city: snapshot.city || "",
    });
  } catch (err) {
    console.error("office-stats error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}

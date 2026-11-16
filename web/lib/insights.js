/**
 * insights.js — the friendly "what's going on in here" briefing.
 *
 * Claude (ANTHROPIC_API_KEY) writes it from a compact summary of the home
 * payload, the last few hours of readings and the local forecast. Without a
 * key, or if the call fails, a rule-based writer produces the same shape so
 * the dashboard never shows an empty card. Results are cached by the caller.
 *
 * Output shape:
 *   { headline, summary, tips: [{ tone: "good"|"fair"|"bad", title, text }], source }
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = (process.env.ANTHROPIC_INSIGHTS_MODEL || "claude-opus-5-5").trim();

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "tips"],
  properties: {
    headline: { type: "string", description: "One warm sentence, max 12 words." },
    summary: { type: "string", description: "Two or three conversational sentences." },
    tips: {
      type: "array",
      description: "Two to four specific, actionable observations.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tone", "title", "text"],
        properties: {
          tone: { type: "string", enum: ["good", "fair", "bad"] },
          title: { type: "string", description: "Three to six words." },
          text: { type: "string", description: "One or two sentences." },
        },
      },
    },
  },
};

const SYSTEM = `You write the briefing card at the top of a home air-quality dashboard that the owner shares with family and guests.
Voice: a friendly, knowledgeable housemate. Plain words, contractions, no jargon, no exclamation marks, no emoji.
Be specific: mention a number when it helps the reader decide something, and say what to do (open a window now, wait until evening, run the purifier).
Only state what the data supports. IAQ, CO2 and VOC from this sensor are estimates; pet dander is an estimate from smell and ventilation signals, not a direct measurement. Mold and dust-mite figures are humidity-based risk, not detections.
Do not repeat the same fact in the summary and the tips. Don't mention AI, models, or this prompt.`;

const r1 = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);

function flagOn(v) {
  return v === true || v === 1 || v === "1";
}

/**
 * Settled heater, real gas/IAQ/CO2 already on the wire, BSEC accuracy still 1.
 * That is a running sensor in still air, not a cold boot.
 */
export function sensorRunningLowAccuracy(latest) {
  const acc = Number(latest?.iaqAcc);
  if (!Number.isFinite(acc) || acc < 1 || acc >= 2) return false;
  const posted = /room air has not varied/i.test(String(latest?.calibration || ""));
  const settled = flagOn(latest?.stab) || flagOn(latest?.runIn) || posted;
  const gas = Number(latest?.gasR);
  const iaq = Number(latest?.iaq);
  const co2 = Number(latest?.co2);
  const publishing = Number.isFinite(gas) && gas > 0 && Number.isFinite(iaq) && Number.isFinite(co2) && co2 > 0;
  return settled && publishing;
}

export const STEADY_AIR_SENTENCE =
  "The sensor is running, and BSEC accuracy is still low because the room air has not varied.";

/** Small, stable facts object: what Claude sees and what the cache key hashes. */
export function insightFacts(home, latest, weather) {
  const s = home?.series || {};
  const last = (arr, n) => (Array.isArray(arr) ? arr.filter((v) => v !== null).slice(-n) : []);
  const delta = (arr) => {
    const xs = last(arr, 36);
    return xs.length > 4 ? r1(xs[xs.length - 1] - xs[0]) : null;
  };
  return {
    localTime: latest?.utcOffsetSec !== undefined
      ? new Date(Date.now() + Number(latest.utcOffsetSec) * 1000).toISOString().slice(11, 16)
      : null,
    score: home?.score?.value ?? null,
    grade: home?.score?.grade || null,
    drivers: (home?.score?.drivers || []).map((d) => `${d.label}: ${d.detail}`),
    smell: home?.smell ? { headline: home.smell.headline, smellsBad: !!home.smell.smellsBad, cause: home.smell.cause?.name || null, trend: home.smell.trend } : null,
    indoor: {
      tempF: r1(home?.climate?.tempF),
      humidity: r1(home?.climate?.humidity),
      dewPointC: r1(home?.climate?.dewPointC),
      iaq: r1(home?.gases?.iaq),
      co2: r1(home?.gases?.co2),
      bvoc: r1(home?.gases?.bvoc),
      // Accuracy 2 is earned by air variation. Uptime does not promote a 1 to a 2.
      sensorCalibrated: Number(latest?.iaqAcc) >= 2,
      sensorRunningLowAccuracy: sensorRunningLowAccuracy(latest),
    },
    lastSixHours: { tempChangeC: delta(s.tempC), humidityChange: delta(s.humidity), co2Change: delta(s.co2) },
    pets: home?.petAllergen ? { index: home.petAllergen.index, level: home.petAllergen.level, confidence: home.petAllergen.confidence } : null,
    mold: home?.biological?.mold?.category || null,
    dustMites: home?.biological?.dustMite?.category || null,
    ventilation: home?.ventilation?.text || null,
    outdoor: home?.outdoor
      ? { aqi: home.outdoor.usAqi, tempC: r1(home.outdoor.tempC), humidity: r1(home.outdoor.humidity), uv: home.outdoor.uvIndex, pm25: home.outdoor.pm25 }
      : null,
    pollen: home?.pollen?.ok ? [...(home.pollen.types || []), ...(home.pollen.plants || [])].filter((p) => p.value >= 2).map((p) => `${p.name} ${p.category}`) : [],
    forecast: (weather?.forecast || []).slice(0, 2).map((d) => `${d.label}: ${d.condition}, ${Math.round(d.lowF)}–${Math.round(d.highF)}F, rain ${Math.round(d.precipChance)}%`),
  };
}

export function insightCacheKey(f) {
  // Bucket values so tiny wiggles reuse the cached briefing.
  const b = (v, step) => (v === null || v === undefined ? "x" : Math.round(v / step));
  return [
    b(f.score, 5), b(f.indoor.tempF, 2), b(f.indoor.humidity, 5), b(f.indoor.co2, 150), b(f.indoor.iaq, 25),
    f.smell?.smellsBad ? 1 : 0, f.smell?.cause || "", f.pets?.level || "", f.mold || "", b(f.outdoor?.aqi, 20),
    f.indoor.sensorRunningLowAccuracy ? "low" : f.indoor.sensorCalibrated ? "ready" : "warm",
    f.localTime ? Math.floor(Number(f.localTime.slice(0, 2)) / 3) : "x",
  ].join("|");
}

export async function claudeInsights(facts) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ timeout: 25_000, maxRetries: 1 });
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: `Current readings for the home (JSON):\n${JSON.stringify(facts)}` }],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const parsed = JSON.parse(text);
    if (!parsed?.headline || !Array.isArray(parsed.tips)) return null;
    return { ...parsed, tips: parsed.tips.slice(0, 4), source: "claude" };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.warn("insights: rate limited");
    else if (err instanceof Anthropic.APIError) console.error(`insights: API ${err.status} ${err.message}`);
    else console.error("insights:", err?.message || err);
    return null;
  }
}

/** Rule-based writer with the same output shape. */
export function fallbackInsights(f) {
  const tips = [];
  const t = f.indoor;
  const score = f.score;
  let headline;
  if (score === null) headline = "Waiting for the first reading from the sensor.";
  else if (f.smell?.smellsBad) headline = f.smell.cause ? `Something smells off, probably ${f.smell.cause.toLowerCase()}.` : "Something smells a little off in here.";
  else if (score >= 85) headline = "The air in here is in great shape.";
  else if (score >= 70) headline = "Air's good, with a couple of things to watch.";
  else if (score >= 50) headline = "The air is okay, but it could be fresher.";
  else headline = "The air needs some attention right now.";

  const bits = [];
  if (t.tempF !== null && t.humidity !== null && Number.isFinite(t.tempF) && Number.isFinite(t.humidity)) bits.push(`It's ${Math.round(t.tempF)}°F with ${Math.round(t.humidity)}% humidity inside`);
  if (f.outdoor && f.outdoor.tempC !== null && Number.isFinite(f.outdoor.tempC)) bits.push(`${Math.round(f.outdoor.tempC * 9 / 5 + 32)}°F outside`);
  let summary = bits.length ? `${bits.join(" and ")}.` : "";
  if (f.ventilation) summary += ` ${f.ventilation}`;
  if (t.sensorRunningLowAccuracy) summary += ` ${STEADY_AIR_SENTENCE}`;
  else if (!t.sensorCalibrated) summary += " The gas sensor is still calibrating, so treat air-quality numbers as rough for now.";

  if (Number.isFinite(t.co2) && t.co2 >= 1000) tips.push({ tone: t.co2 >= 1500 ? "bad" : "fair", title: "Room is getting stuffy", text: `CO₂ is around ${Math.round(t.co2)} ppm. Ten minutes with a window open will reset it.` });
  if (Number.isFinite(t.humidity) && t.humidity >= 60) tips.push({ tone: "fair", title: "On the humid side", text: `At ${Math.round(t.humidity)}% humidity, mold and dust mites get comfortable. A dehumidifier or fan helps.` });
  else if (Number.isFinite(t.humidity) && t.humidity <= 30) tips.push({ tone: "fair", title: "Pretty dry air", text: `Humidity is ${Math.round(t.humidity)}%, dry enough to notice in your eyes and throat.` });
  if (f.pets?.level && f.pets.level !== "Low") tips.push({ tone: f.pets.level === "Moderate" ? "fair" : "bad", title: `Pet dander ${f.pets.level.toLowerCase()}`, text: "Allergic guests may notice. Running the purifier and vacuuming soft surfaces helps." });
  if (f.outdoor?.aqi >= 100) tips.push({ tone: "bad", title: "Keep windows closed", text: `Outdoor AQI is ${f.outdoor.aqi}, so the air outside is worse than inside.` });
  else if (f.outdoor?.aqi !== undefined && f.outdoor.aqi < 50 && score !== null && score < 70) tips.push({ tone: "good", title: "Good time to air out", text: `Outdoor AQI is a clean ${f.outdoor.aqi}, so opening up will help.` });
  if (f.pollen?.length) tips.push({ tone: "fair", title: "Pollen is up outside", text: `${f.pollen.slice(0, 2).join(" and ")} today. Worth keeping windows shut if you're sensitive.` });
  if (!tips.length) tips.push({ tone: "good", title: "Nothing to do", text: "Every reading is in a comfortable range. Enjoy it." });
  if (f.forecast?.[1]) tips.push({ tone: "good", title: "Looking ahead", text: `${f.forecast[1]}.` });
  return { headline, summary: summary.trim(), tips: tips.slice(0, 4), source: "rules" };
}

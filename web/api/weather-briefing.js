/**
 * GET /api/weather-briefing — returns a local forecast bundle plus
 * a concise weather insight. Uses Open-Meteo for forecast data and,
 * when OPENAI_API_KEY is configured, an OpenAI-generated local briefing.
 */

import { getLatest } from "../lib/store.js";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasLocationFix(snapshot) {
  const lat = num(snapshot?.lat, NaN);
  const lon = num(snapshot?.lon, NaN);
  return Number.isFinite(lat) && Number.isFinite(lon) && (Math.abs(lat) > 0.0001 || Math.abs(lon) > 0.0001);
}

function weatherCodeLabel(code) {
  const value = Math.round(num(code, -1));
  if (value === 0) return "Clear";
  if ([1, 2].includes(value)) return "Partly cloudy";
  if (value === 3) return "Overcast";
  if ([45, 48].includes(value)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(value)) return "Drizzle";
  if ([61, 63, 65, 66, 67].includes(value)) return "Rain";
  if ([71, 73, 75, 77].includes(value)) return "Snow";
  if ([80, 81, 82].includes(value)) return "Showers";
  if ([85, 86].includes(value)) return "Snow showers";
  if ([95, 96, 99].includes(value)) return "Thunderstorms";
  return "Weather active";
}

function dayLabel(isoDate) {
  if (!isoDate) return "Forecast";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function conditionSummary(forecast) {
  if (!forecast.length) return "Forecast guidance pending";
  const warmest = [...forecast].sort((a, b) => num(b.highF) - num(a.highF))[0];
  const wettest = [...forecast].sort((a, b) => num(b.precipChance) - num(a.precipChance))[0];
  const breeziest = [...forecast].sort((a, b) => num(b.windMph) - num(a.windMph))[0];
  return `${warmest?.label || "The next few days"} top out around ${Math.round(num(warmest?.highF, 0))}F, with the wettest window on ${wettest?.label || "the current forecast"} and peak winds near ${Math.round(num(breeziest?.windMph, 0))} mph.`;
}

function ventilationWindow(snapshot, forecast) {
  if (!forecast.length) return "Ventilation window is being estimated from current outdoor conditions only.";
  const best = [...forecast].sort((a, b) => {
    const aScore = num(a.precipChance) * 0.7 + Math.max(0, num(a.highF) - 82) + Math.max(0, num(a.windMph) - 16);
    const bScore = num(b.precipChance) * 0.7 + Math.max(0, num(b.highF) - 82) + Math.max(0, num(b.windMph) - 16);
    return aScore - bScore;
  })[0];
  if (!best) return "Ventilation window is being estimated from current outdoor conditions only.";
  return `${best.label} currently looks like the easiest ventilation window, with ${Math.round(num(best.precipChance, 0))}% rain risk and winds near ${Math.round(num(best.windMph, 0))} mph.`;
}

function fallbackBriefing(snapshot, forecast) {
  const city = snapshot?.city || "This area";
  const current = snapshot?.weatherCondition || "conditions in flux";
  const outdoor = num(snapshot?.outdoorAqi, NaN);
  const outdoorLine = Number.isFinite(outdoor) && outdoor > 0
    ? `Outdoor AQI is ${Math.round(outdoor)}${snapshot?.outdoorLevel ? ` (${snapshot.outdoorLevel})` : ""}.`
    : "Outdoor AQI is still syncing from the device feed.";
  return `${city} is trending ${current.toLowerCase()} right now. ${conditionSummary(forecast)} ${ventilationWindow(snapshot, forecast)} ${outdoorLine}`.trim();
}

function sourceCaption(mode, hasForecast) {
  const parts = ["device weather snapshot"];
  if (hasForecast) parts.push("Open-Meteo forecast");
  parts.push("OpenStreetMap map", "RainViewer radar");
  parts.push(mode === "openai" ? "OpenAI local forecast brief" : "deterministic local forecast logic");
  return `Source: ${parts.join(" · ")}`;
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

async function fetchForecast(snapshot) {
  if (!hasLocationFix(snapshot)) return [];

  const params = new URLSearchParams({
    latitude: num(snapshot.lat).toFixed(4),
    longitude: num(snapshot.lon).toFixed(4),
    timezone: "auto",
    forecast_days: "3",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
  });

  const res = await fetch(`${OPEN_METEO_BASE}?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const json = await res.json();
  const daily = json?.daily;
  if (!daily?.time?.length) return [];

  return daily.time.map((date, index) => ({
    date,
    label: dayLabel(date),
    condition: weatherCodeLabel(daily.weather_code?.[index]),
    highF: num(daily.temperature_2m_max?.[index], NaN),
    lowF: num(daily.temperature_2m_min?.[index], NaN),
    precipChance: num(daily.precipitation_probability_max?.[index], 0),
    windMph: num(daily.wind_speed_10m_max?.[index], 0),
  })).slice(0, 3);
}

async function generateOpenAiBrief(snapshot, forecast, fallback) {
  const apiKey = `${process.env.OPENAI_API_KEY || ""}`.trim();
  if (!apiKey || !forecast.length) return null;

  const model = `${process.env.OPENAI_WEATHER_MODEL || "gpt-5.4-nano"}`.trim();
  const prompt = [
    "Write a concise local weather forecast insight for a professional sensor dashboard.",
    "Keep it to 2 or 3 sentences, under 90 words.",
    "Focus on local comfort, ventilation timing, rain risk, and anything notable over the next 3 days.",
    "Do not mention AI, models, or probabilities unless they are useful. Do not be chatty.",
    `Location: ${snapshot.city || "Local area"}.`,
    `Current outdoor context: ${snapshot.weatherCondition || "Conditions syncing"}, ${Math.round(num(snapshot.tempF, NaN))}F, humidity ${Math.round(num(snapshot.humidity, NaN))}%, AQI ${Number.isFinite(num(snapshot.outdoorAqi, NaN)) ? Math.round(num(snapshot.outdoorAqi)) : "unknown"}.`,
    `Forecast: ${forecast.map((day) => `${day.label}: ${day.condition}, high ${Math.round(num(day.highF, 0))}F, low ${Math.round(num(day.lowF, 0))}F, precip ${Math.round(num(day.precipChance, 0))}%, wind ${Math.round(num(day.windMph, 0))} mph`).join(" | ")}`,
    `If the forecast is unremarkable, say so cleanly. Baseline fallback: ${fallback}`,
  ].join("\n");

  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: 150,
    }),
  });

  if (!res.ok) {
    throw new Error(`openai ${res.status}`);
  }

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
    const snapshot = await getLatest();
    if (!snapshot) return res.status(204).end();

    let forecast = [];
    try {
      forecast = await fetchForecast(snapshot);
    } catch (err) {
      console.error("weather-briefing forecast error:", err);
    }

    const fallback = fallbackBriefing(snapshot, forecast);
    let briefing = fallback;
    let mode = "deterministic";

    try {
      const aiBrief = await generateOpenAiBrief(snapshot, forecast, fallback);
      if (aiBrief) {
        briefing = aiBrief;
        mode = "openai";
      }
    } catch (err) {
      console.error("weather-briefing openai error:", err);
    }

    return res.status(200).json({
      city: snapshot.city || "",
      lat: hasLocationFix(snapshot) ? num(snapshot.lat) : null,
      lon: hasLocationFix(snapshot) ? num(snapshot.lon) : null,
      briefing,
      mode,
      summary: conditionSummary(forecast),
      forecast,
      receivedAt: snapshot.receivedAt || null,
      generatedAt: Date.now(),
      sourceCaption: sourceCaption(mode, forecast.length > 0),
    });
  } catch (err) {
    console.error("weather-briefing error:", err);
    return res.status(500).json({ error: "weather briefing error" });
  }
}

/**
 * GET /api/weather-briefing — returns a local forecast bundle plus
 * a concise weather insight. Uses Open-Meteo for forecast data and,
 * when OPENAI_API_KEY is configured, an OpenAI-generated local briefing.
 * Always uses the manually configured Cape Canaveral coordinates — does not
 * rely on device WiFi-derived geolocation for weather API calls.
 */

import { getLatest } from "../lib/store.js";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_AQ_BASE = "https://air-quality-api.open-meteo.com/v1/air-quality";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

// Default location: Cape Canaveral Space Force Station, FL
// This is also the manual location always used for weather data — the app does
// not rely on the device's WiFi-derived geolocation for weather API calls.
const DEFAULT_LAT = 28.4889;
const DEFAULT_LON = -80.5778;
const DEFAULT_CITY = "Cape Canaveral, FL";

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getEffectiveLocation(snapshot) {
  // Use the device's GPS coordinates when they are a genuine fix (not 0,0).
  // Fall back to the hardcoded Cape Canaveral position when no GPS fix is available.
  const lat = Number(snapshot?.lat);
  const lon = Number(snapshot?.lon);
  const city = snapshot?.city;
  if (Number.isFinite(lat) && Number.isFinite(lon) && (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001)) {
    return {
      lat,
      lon,
      city: city || "Device location",
      usingDefault: false,
    };
  }
  return {
    lat: DEFAULT_LAT,
    lon: DEFAULT_LON,
    city: DEFAULT_CITY,
    usingDefault: true,
  };
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

function windDirLabel(deg) {
  const d = num(deg, NaN);
  if (!Number.isFinite(d)) return "";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(d / 45) % 8] || "";
}

function aqiLevel(aqi) {
  const v = num(aqi, NaN);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v <= 50) return "Good";
  if (v <= 100) return "Moderate";
  if (v <= 150) return "Sensitive Groups";
  if (v <= 200) return "Unhealthy";
  if (v <= 300) return "Very Unhealthy";
  return "Hazardous";
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

function fallbackBriefing(snapshot, forecast, outdoorAqi) {
  const city = snapshot?.city || DEFAULT_CITY;
  const current = snapshot?.weatherCondition || "conditions in flux";
  const outdoor = num(outdoorAqi, NaN);
  const outdoorLine = Number.isFinite(outdoor) && outdoor > 0
    ? `Outdoor AQI is ${Math.round(outdoor)} (${aqiLevel(outdoor)}).`
    : "Outdoor AQI is still syncing.";
  return `${city} is trending ${current.toLowerCase()} right now. ${conditionSummary(forecast)} ${ventilationWindow(snapshot, forecast)} ${outdoorLine}`.trim();
}

function sourceCaption(mode, hasForecast, usingDefault) {
  const parts = usingDefault ? ["Cape Canaveral default location"] : ["device weather snapshot"];
  if (hasForecast) parts.push("Open-Meteo forecast", "Open-Meteo air quality");
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

async function fetchForecastAndCurrent(loc) {
  const params = new URLSearchParams({
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
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
  const forecast = daily?.time?.length
    ? daily.time.map((date, index) => ({
        date,
        label: dayLabel(date),
        condition: weatherCodeLabel(daily.weather_code?.[index]),
        highF: num(daily.temperature_2m_max?.[index], NaN),
        lowF: num(daily.temperature_2m_min?.[index], NaN),
        precipChance: num(daily.precipitation_probability_max?.[index], 0),
        windMph: num(daily.wind_speed_10m_max?.[index], 0),
      })).slice(0, 3)
    : [];

  const cur = json?.current;
  const current = cur ? {
    condition: weatherCodeLabel(cur.weather_code),
    tempF: num(cur.temperature_2m, NaN),
    feelsLikeF: num(cur.apparent_temperature, NaN),
    humidity: num(cur.relative_humidity_2m, NaN),
    windSpeed: num(cur.wind_speed_10m, NaN) > 0 ? `${Math.round(num(cur.wind_speed_10m))} mph` : "",
    windDir: windDirLabel(cur.wind_direction_10m),
    pressHpa: num(cur.pressure_msl, NaN),
    isDay: Boolean(cur.is_day),
  } : null;

  return { forecast, current };
}

async function fetchAirQuality(loc) {
  const params = new URLSearchParams({
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
    current: "us_aqi",
  });

  const res = await fetch(`${OPEN_METEO_AQ_BASE}?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`open-meteo-aq ${res.status}`);
  const json = await res.json();
  const aqi = num(json?.current?.us_aqi, NaN);
  if (!Number.isFinite(aqi) || aqi < 0) return null;
  return { aqi: Math.round(aqi), level: aqiLevel(aqi) };
}

async function generateOpenAiBrief(snapshot, loc, forecast, outdoorAqi, fallback) {
  const apiKey = `${process.env.OPENAI_API_KEY || ""}`.trim();
  if (!apiKey || !forecast.length) return null;

  const model = `${process.env.OPENAI_WEATHER_MODEL || "gpt-5.4-nano"}`.trim();
  const prompt = [
    "Write a concise local weather forecast insight for a professional sensor dashboard.",
    "Keep it to 2 or 3 sentences, under 90 words.",
    "Focus on local comfort, ventilation timing, rain risk, and anything notable over the next 3 days.",
    "Do not mention AI, models, or probabilities unless they are useful. Do not be chatty.",
    `Location: ${loc.city || snapshot.city || "Local area"}.`,
    `Current outdoor context: ${snapshot.weatherCondition || "Conditions syncing"}, ${Number.isFinite(num(snapshot.tempF, NaN)) ? `${Math.round(num(snapshot.tempF))}F` : "temp unknown"}, humidity ${Number.isFinite(num(snapshot.humidity, NaN)) ? `${Math.round(num(snapshot.humidity))}%` : "unknown"}, AQI ${Number.isFinite(num(outdoorAqi, NaN)) ? Math.round(num(outdoorAqi)) : "unknown"}.`,
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

    const loc = getEffectiveLocation(snapshot);

    let forecast = [];
    let currentConditions = null;
    try {
      const result = await fetchForecastAndCurrent(loc);
      forecast = result.forecast;
      currentConditions = result.current;
    } catch (err) {
      console.error("weather-briefing forecast error:", err);
    }

    let outdoorAqi = num(snapshot.outdoorAqi, NaN);
    let outdoorLevel = snapshot.outdoorLevel || "";
    try {
      const aq = await fetchAirQuality(loc);
      if (aq) {
        outdoorAqi = aq.aqi;
        outdoorLevel = aq.level;
      }
    } catch (err) {
      console.error("weather-briefing AQ error:", err);
    }

    const fallback = fallbackBriefing(snapshot, forecast, outdoorAqi);
    let briefing = fallback;
    let mode = "deterministic";

    try {
      const aiBrief = await generateOpenAiBrief(snapshot, loc, forecast, outdoorAqi, fallback);
      if (aiBrief) {
        briefing = aiBrief;
        mode = "openai";
      }
    } catch (err) {
      console.error("weather-briefing openai error:", err);
    }

    return res.status(200).json({
      city: loc.city || snapshot.city || "",
      lat: loc.lat,
      lon: loc.lon,
      usingDefault: loc.usingDefault,
      briefing,
      mode,
      summary: conditionSummary(forecast),
      forecast,
      current: currentConditions,
      outdoorAqi: Number.isFinite(outdoorAqi) && outdoorAqi > 0 ? outdoorAqi : null,
      outdoorLevel: outdoorLevel || null,
      receivedAt: snapshot.receivedAt || null,
      generatedAt: Date.now(),
      sourceCaption: sourceCaption(mode, forecast.length > 0, loc.usingDefault),
    });
  } catch (err) {
    console.error("weather-briefing error:", err);
    return res.status(500).json({ error: "weather briefing error" });
  }
}

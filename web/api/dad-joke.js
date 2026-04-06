/**
 * /api/dad-joke
 *
 * GET  — return the current daily dad joke and recent generated history
 * POST — owner-trigger a fresh joke generation
 *
 * Public reads stay easy; forced refresh is owner-gated to avoid abuse.
 */

import { requireOwnerAuth } from "../lib/auth.js";
import { getDadJokeHistory, getLatestDadJoke, putDadJoke } from "../lib/store.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const PORTAL_TIME_ZONE = process.env.SNIFFMASTER_PORTAL_TZ || "America/New_York";
const FALLBACK_JOKES = [
  "I used to be a banker, but I lost interest.",
  "I wanted to be a doctor, but I did not have the patients.",
  "I told my calendar a joke. It still cannot get over the dates.",
  "I tried to make a belt out of spare sensors, but it was a waist of parts.",
  "My Wi-Fi told me a joke, but the punchline was in another packet.",
  "I named my vacuum cleaner Datacake because it keeps collecting everything.",
  "I asked the CO2 sensor for career advice. It said I needed more fresh ideas.",
  "I bought a map of wind patterns. It really blew me away.",
  "The launch schedule and I have a lot in common. We both slip under pressure.",
  "I told the pressure sensor to lighten up. It said the atmosphere was too heavy.",
  "My device wanted a raise, but I said it was already getting plenty of input.",
  "I told the humidity graph to relax. It said things were getting sticky.",
];

function setHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-SniffMaster-Key");
  res.setHeader("Cache-Control", "no-store");
}

function dateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PORTAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function displayDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PORTAL_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

function fallbackJoke(seedKey) {
  let hash = 0;
  for (let i = 0; i < seedKey.length; i += 1) {
    hash = ((hash << 5) - hash + seedKey.charCodeAt(i)) | 0;
  }
  return FALLBACK_JOKES[Math.abs(hash) % FALLBACK_JOKES.length];
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

function normalizeJoke(text, seedKey) {
  const clean = `${text || ""}`
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  return clean || fallbackJoke(seedKey);
}

async function generateOpenAiJoke(seedKey, previous = []) {
  const apiKey = `${process.env.OPENAI_API_KEY || ""}`.trim();
  if (!apiKey) return null;

  const model = `${process.env.OPENAI_DAD_JOKE_MODEL || "gpt-5-mini"}`.trim();
  const prompt = [
    "Write one original dad joke for a premium environmental sensor dashboard called Dadabase.",
    "Keep it clean, genuinely groan-worthy, and concise.",
    "Return only the joke text.",
    "Avoid these recent jokes:",
    ...previous.slice(0, 6).map((line) => `- ${line}`),
    `Seed for variety: ${seedKey}`,
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
      max_output_tokens: 70,
    }),
  });

  if (!res.ok) throw new Error(`openai ${res.status}`);
  const json = await res.json();
  return normalizeJoke(extractOutputText(json), seedKey);
}

async function ensureDailyJoke(forceRefresh = false) {
  const todayKey = dateKey();
  const latest = await getLatestDadJoke();

  if (!forceRefresh && latest?.dateKey === todayKey && latest?.joke) {
    const history = await getDadJokeHistory();
    return { current: latest, history };
  }

  const history = await getDadJokeHistory();
  const previous = history.map((entry) => entry?.joke).filter(Boolean);

  let joke = fallbackJoke(`${todayKey}:${history.length}`);
  let mode = "fallback";
  try {
    const aiJoke = await generateOpenAiJoke(`${todayKey}:${Date.now()}`, previous);
    if (aiJoke) {
      joke = aiJoke;
      mode = "openai";
    }
  } catch (err) {
    console.error("dad-joke openai error:", err);
  }

  const stored = await putDadJoke({
    dateKey: todayKey,
    dateLabel: displayDate(),
    joke,
    mode,
  });
  const freshHistory = await getDadJokeHistory();
  return { current: stored, history: freshHistory };
}

export default async function handler(req, res) {
  setHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method === "GET") {
      const payload = await ensureDailyJoke(false);
      return res.status(200).json({
        ...payload,
        sourceCaption: payload.current?.mode === "openai"
          ? "Source: OpenAI daily dad joke generator · Dadabase history in Upstash Redis"
          : "Source: deterministic Dadabase fallback · Dadabase history in Upstash Redis",
      });
    }

    if (req.method === "POST") {
      if (!requireOwnerAuth(req, res)) return;
      const payload = await ensureDailyJoke(true);
      return res.status(200).json({
        ok: true,
        ...payload,
        sourceCaption: payload.current?.mode === "openai"
          ? "Source: OpenAI daily dad joke generator · Dadabase history in Upstash Redis"
          : "Source: deterministic Dadabase fallback · Dadabase history in Upstash Redis",
      });
    }

    return res.status(405).json({ error: "GET/POST only" });
  } catch (err) {
    console.error("dad-joke error:", err);
    return res.status(500).json({ error: "dad joke error" });
  }
}

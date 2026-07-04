/**
 * brogpt.js — short personal-voice ("bro") narrative generator for SMS.
 *
 * Used to prepend a friendly, plain-spoken one-liner to threshold-alert texts
 * so an alert reads like a trusted site tech texting the owner, not a raw
 * sensor dump. OpenAI writes it when OPENAI_API_KEY is set; otherwise a
 * deterministic template is used. Output is always GSM-7-safe ASCII and never
 * presents itself as AI-written.
 *
 * Kept deliberately self-contained (its own OpenAI call + sanitizer) so the
 * alert path in api/update.js has no coupling to the daily-summary cron.
 */

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

/** Strip to GSM-7-safe ASCII and scrub any AI self-reference. */
export function sanitizeSmsAscii(text) {
  return String(text || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/\b(BroGPT|ChatGPT|GPT[-\w]*|AI|A\.I\.|AI-generated|language model|chatbot)\b/gi, "")
    .replace(/\bas an\s+(from\s+)?[,.]?\s*/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
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

/**
 * Compose a one-line "bro" summary for a set of active threshold breaches.
 * Returns GSM-7-safe ASCII. Never throws — on any OpenAI error it falls back
 * to a deterministic line, so the alert always ships.
 *
 * @param {Array<{key:string,label:string,message:string}>} breaches
 * @param {{ timeoutMs?:number, maxChars?:number }} [opts]
 * @returns {Promise<string>}
 */
export async function buildAlertBroSummary(breaches, opts = {}) {
  const list = Array.isArray(breaches) ? breaches : [];
  if (!list.length) return "";
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 4000;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 200;

  const fallback = alertFallbackText(list);

  const apiKey = `${process.env.OPENAI_API_KEY || ""}`.trim();
  if (!apiKey) return fallback;

  const model = `${process.env.OPENAI_REPORT_MODEL || "gpt-5.4-nano"}`.trim();
  const prompt = [
    "Write ONE short line for an SMS alert from an environmental monitor to its owner.",
    "Context: a sensor watches a temporary enclosure protecting electrical switchgear drying out after an incident; AC and dehumidifiers run to keep it safe.",
    "The specific alarms that just tripped are listed below; summarize the situation and the practical next move in a calm, direct, human voice - like a trusted site tech texting their boss.",
    "Requirements: max 200 characters, ONE sentence or two very short ones, plain ASCII only (no emoji, no degree symbols). Use Fahrenheit if you mention temperature.",
    "Never mention AI, GPT, chatbots, models, or that this message is generated.",
    "Do not repeat the raw numbers verbatim - the detailed readings follow separately.",
    "",
    `Active alarms: ${list.map((b) => b.label || b.key).join(", ")}.`,
    `Details: ${list.map((b) => b.message).join(" ")}`,
  ].join("\n");

  try {
    const res = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: prompt, max_output_tokens: 120 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`openai ${res.status}`);
    const text = sanitizeSmsAscii(extractOutputText(await res.json()));
    return text ? text.slice(0, maxChars) : fallback;
  } catch (err) {
    console.error("brogpt: alert summary generation failed, using fallback:", err?.message || err);
    return fallback;
  }
}

/** Deterministic personal-voice line keyed to which alarms are active. */
export function alertFallbackText(breaches) {
  const keys = new Set((breaches || []).map((b) => b.key));
  if (keys.has("humidity") && (keys.has("gas") || keys.has("iaq"))) {
    return "Heads up - the enclosure is both damp and showing bad air right now. Worth getting eyes on the dehumidifiers and checking for fumes.";
  }
  if (keys.has("humidity")) {
    return "Heads up - humidity in the enclosure just crossed the safe line. Condensation risk on the buswork; check the dehumidifiers.";
  }
  if (keys.has("temp")) {
    return "Heads up - it is running hot in the enclosure. Check the AC and look for anything overheating.";
  }
  if (keys.has("gas") || keys.has("iaq")) {
    return "Heads up - air quality in the enclosure just went off. Possible smoke or fumes; worth checking it out.";
  }
  return "Heads up - the enclosure just tripped a safety alarm. Worth a look when you can.";
}

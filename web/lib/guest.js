/**
 * guest.js — the public, read-only guest view and its push alerts.
 *
 * Privacy: a guest link is shared with people outside the household, so the
 * guest payload is a WHITELIST. It carries air and allergy status only — no
 * address, city, coordinates, device details, history, or occupancy.
 *
 * Alerts use ntfy.sh topics: guests subscribe in the free ntfy app, so the
 * site never collects a guest's phone number or email. The topic name is
 * derived from a secret hash (or NTFY_GUEST_TOPIC) and is separate from the
 * owner's private alert topic. Anyone who has the link can follow it.
 */

import { createHash } from "node:crypto";
import { sendViaNtfy, PUBLIC_BASE_URL } from "./notify.js";

export function guestTopic() {
  const explicit = (process.env.NTFY_GUEST_TOPIC || "").trim();
  if (explicit) return explicit;
  const seed = process.env.SNIFFMASTER_API_KEY || process.env.UPSTASH_REDIS_REST_URL || "";
  if (!seed) return "";
  return "sniffmaster-guest-" + createHash("sha256").update("guest:" + seed).digest("hex").slice(0, 16);
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));

/** Whitelisted public view of a home payload. */
export function toGuestView(p, { topic = "" } = {}) {
  const sm = p.smell || {};
  const ol = p.outlook || {};
  const pol = p.pollen || {};
  const pet = p.petAllergen || {};
  const bio = p.biological || {};
  return {
    updatedAt: p.receivedAt || null,
    score: pick(p.score, ["value", "grade"]),
    smell: {
      ...pick(sm, ["state", "smellsBad", "level", "tone", "headline", "action", "safety", "trend", "sinceMinutes", "confidence"]),
      cause: sm.cause ? sm.cause.name : null,
    },
    outlook: {
      triggers: ol.triggers || [],
      level: ol.level ?? null,
      headline: ol.headline || "",
      items: (ol.items || []).map((i) => pick(i, ["key", "label", "level", "reason", "action", "confidence"])),
    },
    ventilation: pick(p.ventilation, ["action", "text"]),
    climate: pick(p.climate, ["tempF", "humidity", "comfort"]),
    gases: pick(p.gases, ["co2Category"]),
    pets: pet.level ? { level: pet.level, confidence: pet.confidence } : null,
    mold: bio.mold ? { category: bio.mold.category } : null,
    dustMite: bio.dustMite ? { category: bio.dustMite.category } : null,
    pollen: pol.ok
      ? { ok: true, items: [...(pol.types || []), ...(pol.plants || [])].map((x) => pick(x, ["name", "category", "value"])) }
      : { ok: false },
    alerts: topic ? { topic, server: "https://ntfy.sh" } : null,
  };
}

const COOLDOWN_MS = 3 * 3600 * 1000;

/**
 * Decide which guest alerts to send. Each kind alerts once when it turns bad,
 * then stays quiet until it has cleared (or 3 hours pass).
 * @param {{smell?:object, score?:{value?:number}}} view
 * @param {{[kind:string]:{active:boolean,sentAt:number}}} state
 */
export function decideGuestAlerts(view, state = {}, now = Date.now()) {
  const next = { ...state };
  const messages = [];
  const consider = (kind, bad, title, text, priority) => {
    const prev = state[kind] || { active: false, sentAt: 0 };
    if (bad) {
      if (!prev.active || now - prev.sentAt > COOLDOWN_MS) {
        messages.push({ kind, title, text, priority });
        next[kind] = { active: true, sentAt: now };
      } else next[kind] = prev;
    } else if (prev.active) {
      next[kind] = { active: false, sentAt: prev.sentAt };
    }
  };
  const sm = view?.smell || {};
  consider(
    "smell",
    !!sm.smellsBad,
    sm.safety ? "Safety: strong smell" : "Room smells bad",
    [sm.headline, sm.action].filter(Boolean).join(" "),
    sm.safety ? 5 : 3
  );
  const score = view?.score?.value;
  consider("air", Number.isFinite(score) && score < 50, "Air quality is poor", `Home air score is ${score}. Open the guest page for what is affecting it.`, 3);
  return { messages, state: next };
}

const ascii = (t) => String(t || "").replace(/[^\x20-\x7e]/g, "").slice(0, 400);

export async function publishGuestAlerts(messages) {
  const topic = guestTopic();
  if (!topic || !messages.length) return 0;
  let sent = 0;
  for (const m of messages) {
    const r = await sendViaNtfy(ascii(m.text) || "See the guest page.", {
      url: `https://ntfy.sh/${encodeURIComponent(topic)}`,
      title: ascii(m.title),
      priority: m.priority,
      clickUrl: `${PUBLIC_BASE_URL}/guest`,
    });
    sent += r.sent;
  }
  return sent;
}

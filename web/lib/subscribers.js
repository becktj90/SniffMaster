/**
 * subscribers.js — public email / text alert sign-ups.
 *
 * Anyone with the dashboard link can sign up to be told when a reading they
 * care about gets too high. Flow:
 *   1. POST subscribe {channel, address, rules}  → a 6-digit code is sent to
 *      that address (proves they own it; stops someone signing up a stranger).
 *   2. POST verify {id, code}                     → subscription goes live.
 *   3. Every alert carries a one-tap unsubscribe link (/api/alerts?unsub=…).
 *
 * Delivery: email through Brevo (BREVO_API_KEY + ALERT_EMAIL_FROM), text
 * through ClickSend (the same account the owner alerts use), and phone
 * notifications through a private ntfy.sh topic (no account credit). A
 * channel whose credentials are missing, or a texting account with no
 * credit, is reported as unavailable instead of pretending to work.
 *
 * Storage is one small JSON document (capped at MAX_SUBSCRIBERS) plus
 * short-lived pending-code entries, all through the existing Redis cache
 * helpers, so no new Redis commands are needed.
 *
 * The rule evaluation (decideSubscriberAlerts) is pure and unit-tested.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { getJsonCache, setJsonCache, getCounter, incrCounter, withLock } from "./store.js";
import { sendViaClickSend, sendViaNtfy, clickSendBalance, PUBLIC_BASE_URL } from "./notify.js";

export const MAX_SUBSCRIBERS = 100;
const SUBS_KEY = "subscribers:v1"; // stored via setJsonCache with a long TTL
const SUBS_TTL_SEC = 10 * 365 * 24 * 3600;
const PENDING_TTL_SEC = 15 * 60;
const COOLDOWN_MS = 3 * 3600 * 1000;
const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

/**
 * Every rule a subscriber can switch on. `get` reads the value from the
 * merged {reading, home} context; `above` rules fire when value >= limit,
 * `below` rules when value <= limit. Ranges keep values sane.
 */
export const RULES = {
  pet:        { easy: 1, label: "Pet allergens", hint: "Message me when pet dander is higher than usual.", unit: "/100", dir: "above", def: 50, min: 10, max: 100, get: (c) => c.petIndex, say: (v) => `Pet allergens are at ${Math.round(v)} out of 100, which is higher than usual.` },
  mold:       { easy: 2, label: "Mold risk", hint: "Message me when the house has been damp enough for mold.", unit: "", dir: "above", def: 60, min: 20, max: 100, get: (c) => c.moldPct, say: (v) => `Mold risk is ${Math.round(v)} out of 100, which is higher than usual.` },
  dustMite:   { easy: 3, label: "Dust mites", hint: "Message me when the air has favored dust mites.", unit: "", dir: "above", def: 60, min: 20, max: 100, get: (c) => c.dustMitePct, say: (v) => `Dust-mite risk is ${Math.round(v)} out of 100, which is higher than usual.` },
  pollen:     { easy: 4, label: "Outdoor pollen", hint: "Message me when pollen outside is moderate or worse.", unit: "/5", dir: "above", def: 3, min: 1, max: 5, get: (c) => c.pollenIndex, say: (v) => `Outdoor pollen is ${Number(v).toFixed(0)} out of 5, which is moderate or worse.` },
  smell:      { easy: 5, label: "A bad smell", hint: "Message me when the room smells off.", unit: "", dir: "flag", def: 1, min: 1, max: 1, get: (c) => (c.smellsBad ? 1 : 0) },
  humidityHi: { easy: 6, label: "Too damp", hint: "Message me when the air in the house is too humid.", unit: "%", dir: "above", def: 65, min: 40, max: 95, get: (c) => c.humidity, say: (v) => `Humidity is ${Math.round(v)}%, which is damper than usual.` },
  airScore:   { easy: 7, label: "Health score drops", hint: "Message me when the home health score gets low.", unit: "/100", dir: "below", def: 60, min: 20, max: 80, get: (c) => c.airScore, say: (v) => `The home health score is ${Math.round(v)} out of 100, which is lower than usual.` },
  co2:        { easy: 8, label: "Stuffy air", hint: "Message me when the room needs a window or a fan.", unit: " ppm", dir: "above", def: 1200, min: 600, max: 3000, get: (c) => c.co2, say: (v) => `The air is stuffy, about ${Math.round(v)} ppm of CO₂.` },
  iaq:        { label: "Indoor air quality", hint: "Message me when the air-quality index is poor.", unit: "", dir: "above", def: 150, min: 50, max: 400, get: (c) => c.iaq },
  voc:        { label: "Chemical smells", hint: "Message me when chemical vapors are high.", unit: " ppm", dir: "above", def: 2.5, min: 0.5, max: 20, get: (c) => c.voc },
  humidityLo: { label: "Too dry", hint: "Message me when the air is very dry.", unit: "%", dir: "below", def: 25, min: 5, max: 45, get: (c) => c.humidity },
  tempHi:     { label: "Too warm", hint: "Message me when the house is too warm.", unit: "°F", dir: "above", def: 85, min: 70, max: 110, get: (c) => c.tempF },
  tempLo:     { label: "Too cool", hint: "Message me when the house is too cool.", unit: "°F", dir: "below", def: 60, min: 32, max: 72, get: (c) => c.tempF },
  outdoorAqi: { label: "Outdoor air", hint: "Message me when the air outside is unhealthy.", unit: "", dir: "above", def: 100, min: 25, max: 300, get: (c) => c.outdoorAqi },
};

const env = (n) => (typeof process.env[n] === "string" ? process.env[n].trim() : "");

export function channelStatus() {
  return {
    email: Boolean(env("BREVO_API_KEY") && env("ALERT_EMAIL_FROM")),
    sms: Boolean(env("CLICKSEND_USERNAME") && env("CLICKSEND_API_KEY")),
    // ntfy.sh accepts a publish to any topic. No API key and no credit.
    push: true,
  };
}

const BALANCE_KEY = "clicksend-balance";
const BALANCE_TTL_SEC = 2 * 60;
// A real send that ClickSend rejected for credit is the strongest evidence we
// get: the balance endpoint can still show a few cents (or fail) while every
// message is refused. Trust the rejection for a while instead of re-offering
// Text a minute later and failing the next person's signup too.
const CREDIT_BLOCK_KEY = "clicksend-credit-block";
const CREDIT_BLOCK_TTL_SEC = 30 * 60;
// One US text costs a few cents. A balance below this cannot send one.
const DEFAULT_MIN_BALANCE = 0.1;

function minBalance() {
  const raw = env("CLICKSEND_MIN_BALANCE");
  const v = raw === "" ? NaN : Number(raw); // Number("") is 0, which would disable the check
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MIN_BALANCE;
}

async function creditBlocked() {
  try {
    const hit = await getJsonCache(CREDIT_BLOCK_KEY);
    return Boolean(hit && Date.now() - Number(hit.at) < CREDIT_BLOCK_TTL_SEC * 1000);
  } catch {
    return false;
  }
}

/** Channels the page can offer right now. Text is hidden when it can't be paid for. */
export async function alertChannels() {
  const channels = channelStatus();
  let smsReason = null;
  if (channels.sms) {
    if (await creditBlocked()) {
      channels.sms = false;
      smsReason = "credit";
    } else {
      const balance = await cachedClickSendBalance();
      if (balance !== null && balance < minBalance()) {
        channels.sms = false;
        smsReason = "credit";
      }
    }
  }
  return { channels, smsReason };
}

async function cachedClickSendBalance() {
  try {
    const cached = await getJsonCache(BALANCE_KEY);
    if (cached && typeof cached.balance === "number" && Date.now() - Number(cached.at) < BALANCE_TTL_SEC * 1000) {
      return cached.balance;
    }
  } catch { /* a cache miss just means we ask ClickSend */ }
  try {
    const balance = await clickSendBalance();
    if (balance === null) return null;
    await setJsonCache(BALANCE_KEY, { balance, at: Date.now() }, BALANCE_TTL_SEC).catch(() => {});
    return balance;
  } catch {
    return null;
  }
}

/** Called when ClickSend itself rejected a send for credit. */
async function rememberEmptyBalance() {
  await setJsonCache(CREDIT_BLOCK_KEY, { at: Date.now() }, CREDIT_BLOCK_TTL_SEC).catch(() => {});
}

// ── Validation ────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;

export function normalizeAddress(channel, raw) {
  const v = String(raw || "").trim();
  if (channel === "email") return EMAIL_RE.test(v) ? v.toLowerCase() : null;
  if (channel === "sms") {
    const digits = v.replace(/[^0-9]/g, "");
    if (v.startsWith("+") && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  }
  return null;
}

/** Keep only known rules, clamp limits into range. Empty input → sensible defaults. */
export function normalizeRules(input) {
  const out = {};
  const src = input && typeof input === "object" ? input : null;
  if (!src || !Object.keys(src).length) {
    for (const k of ["iaq", "co2", "humidityHi", "smell", "pet"]) out[k] = RULES[k].def;
    return out;
  }
  for (const [k, v] of Object.entries(src)) {
    const r = RULES[k];
    if (!r || v === false || v === null) continue;
    const n = r.dir === "flag" ? 1 : Number(v === true ? r.def : v);
    if (!Number.isFinite(n)) continue;
    out[k] = Math.min(r.max, Math.max(r.min, n));
  }
  return out;
}

export function maskAddress(channel, address) {
  if (channel === "push") return "your phone";
  if (channel === "email") {
    const [u, d] = address.split("@");
    return `${u.slice(0, 2)}${"•".repeat(Math.max(1, u.length - 2))}@${d}`;
  }
  return `${"•".repeat(Math.max(0, address.length - 4))}${address.slice(-4)}`;
}

/** What to tell the person when a code can't be delivered. */
export function explainDeliveryFailure(channel, err) {
  const msg = String(err?.message || err || "");
  if (/INSUFFICIENT_CREDIT/i.test(msg)) {
    return { status: 503, message: "Text alerts are paused because the texting account is out of credit." };
  }
  if (/INVALID_RECIPIENT|INVALID_NUMBER/i.test(msg)) {
    return {
      status: 400,
      message: channel === "sms"
        ? "That phone number can't receive texts. Check the number and try again."
        : "That address can't receive messages. Check it and try again.",
    };
  }
  if (/timeout/i.test(msg)) {
    return { status: 504, message: "The message service didn't answer. Try again in a minute." };
  }
  if (channel === "push") return { status: 502, message: "We couldn't send the notification. Try again in a minute." };
  if (channel === "email") return { status: 502, message: "We couldn't send the email. Check the address and try again." };
  return { status: 502, message: "We couldn't send the text. Try again in a minute." };
}

export function pushLinks(topic) {
  const path = encodeURIComponent(topic);
  return {
    topic,
    web: `https://ntfy.sh/${path}`,
    app: `ntfy://ntfy.sh/${path}`,
  };
}

// ── Rule evaluation (pure) ────────────────────────────────────────────────

/** Flatten a snapshot + home payload into the values rules read. */
export function alertContext(snapshot = {}, home = {}) {
  const n = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  return {
    iaq: n(snapshot.iaq),
    co2: n(snapshot.co2True ?? snapshot.co2),
    voc: n(snapshot.voc),
    humidity: n(snapshot.humidity),
    tempF: n(snapshot.tempF),
    // Prefer the server's normalized US AQI. The device may post a 1-5
    // OpenWeatherMap index as outdoorAqi, which isn't on the same scale.
    outdoorAqi: isFinite(n(home?.outdoor?.usAqi)) ? n(home.outdoor.usAqi) : n(snapshot.outdoorAqi) > 5 ? n(snapshot.outdoorAqi) : NaN,
    petIndex: n(home?.petAllergen?.index),
    moldPct: n(home?.biological?.mold?.pct),
    dustMitePct: n(home?.biological?.dustMite?.pct),
    pollenIndex: pollenIndex(home?.pollen),
    airScore: n(home?.score?.value),
    smellsBad: !!home?.smell?.smellsBad,
    smellHeadline: home?.smell?.headline || "",
  };
}

const POLLEN_CAT = { "Very low": 1, Low: 2, Moderate: 3, High: 4, "Very high": 5 };

function pollenIndex(pollen) {
  if (!pollen?.ok) return NaN;
  const vals = [...(pollen.types || []), ...(pollen.plants || [])].map((x) => {
    const v = Number(x?.value);
    if (Number.isFinite(v)) return v;
    return POLLEN_CAT[x?.category] ?? NaN;
  }).filter((v) => Number.isFinite(v));
  return vals.length ? Math.max(...vals) : NaN;
}

function fmtVal(rule, v) {
  if (rule.dir === "flag") return "";
  const d = Math.abs(v) < 10 && !Number.isInteger(v) ? 1 : 0;
  return `${Number(v).toFixed(d)}${rule.unit}`;
}

/**
 * Which subscribers should hear about what. A rule alerts once when it trips,
 * stays quiet while it stays tripped (re-reminding after COOLDOWN_MS), and
 * re-arms once it clears. Returns the messages and the updated per-sub state.
 */
export function decideSubscriberAlerts(subs, ctx, now = Date.now()) {
  const sends = [];
  const next = subs.map((s) => {
    if (!s.verified) return s;
    const state = { ...(s.state || {}) };
    const tripped = [];
    for (const [key, limit] of Object.entries(s.rules || {})) {
      const rule = RULES[key];
      if (!rule) continue;
      const v = rule.get(ctx);
      const bad = rule.dir === "flag" ? v === 1 : Number.isFinite(v) && (rule.dir === "above" ? v >= limit : v <= limit);
      const prev = state[key] || { active: false, sentAt: 0 };
      if (bad) {
        if (!prev.active || now - prev.sentAt > COOLDOWN_MS) {
          tripped.push({ key, rule, value: v, limit });
          state[key] = { active: true, sentAt: now };
        }
      } else if (prev.active) {
        state[key] = { active: false, sentAt: prev.sentAt };
      }
    }
    if (tripped.length) sends.push({ sub: s, tripped });
    return { ...s, state };
  });
  return { sends, subs: next };
}

/** Friendly, short alert text (also the email body). */
export function alertText(tripped, ctx) {
  const parts = tripped.map(({ key, rule, value, limit }) => {
    if (key === "smell") return ctx.smellHeadline || "The room smells off.";
    if (typeof rule.say === "function") return rule.say(value, limit);
    const word = rule.dir === "above" ? "above" : "below";
    return `${rule.label} is ${fmtVal(rule, value)}, ${word} your ${fmtVal(rule, limit)} limit.`;
  });
  const tips = [];
  const keys = new Set(tripped.map((t) => t.key));
  if (keys.has("co2") || keys.has("iaq") || keys.has("voc") || keys.has("smell") || keys.has("airScore")) tips.push("Cracking a window or running a fan for 10–15 minutes usually clears it.");
  if (keys.has("humidityHi") || keys.has("mold") || keys.has("dustMite")) tips.push("A dehumidifier or the bathroom fan will bring the dampness down.");
  if (keys.has("humidityLo")) tips.push("A humidifier or a few plants will help with the dry air.");
  if (keys.has("pet")) tips.push("Running an air purifier and vacuuming soft surfaces helps with dander.");
  if (keys.has("outdoorAqi") || keys.has("pollen")) tips.push("Keep the windows shut for now. Outdoor air is worse than usual.");
  return [...parts, tips[0]].filter(Boolean).join(" ");
}

// ── Storage ───────────────────────────────────────────────────────────────

export async function loadSubscribers() {
  return (await getJsonCache(SUBS_KEY)) || [];
}

export async function saveSubscribers(list) {
  await setJsonCache(SUBS_KEY, list, SUBS_TTL_SEC);
}

/** Read-modify-write the subscriber list under a lock so concurrent writers don't drop each other's changes. */
export async function updateSubscribers(fn) {
  return withLock("subscribers", async () => {
    const list = await loadSubscribers();
    const next = await fn(list);
    if (next !== list) await saveSubscribers(next);
    return next;
  });
}

const hashCode = (id, code) => createHash("sha256").update(`${id}:${code}`).digest("hex");

function sameHash(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── Delivery ──────────────────────────────────────────────────────────────

export async function sendEmail(to, subject, text, unsubUrl) {
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d2433;max-width:520px">
<p style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#5b6b85;margin:0 0 8px">SniffMaster</p>
<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>
<p><a href="${PUBLIC_BASE_URL}" style="color:#2f6fed">Open the dashboard</a></p>
${unsubUrl ? `<p style="font-size:12px;color:#8a96aa">Don't want these? <a href="${unsubUrl}" style="color:#8a96aa">Unsubscribe</a>.</p>` : ""}
</div>`;
  const resp = await fetch(BREVO_URL, {
    method: "POST",
    headers: { "api-key": env("BREVO_API_KEY"), "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: env("ALERT_EMAIL_FROM"), name: env("ALERT_EMAIL_NAME") || "SniffMaster" },
      to: [{ email: to }],
      subject,
      textContent: unsubUrl ? `${text}\n\nUnsubscribe: ${unsubUrl}` : text,
      htmlContent: html,
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => "")).slice(0, 200);
    throw new Error(`brevo ${resp.status} ${detail}`);
  }
}

async function deliver(sub, subject, text, withUnsub = true) {
  const unsubUrl = withUnsub && sub.token ? `${PUBLIC_BASE_URL}/api/alerts?unsub=${encodeURIComponent(sub.token)}` : null;
  if (sub.channel === "email") return sendEmail(sub.address, subject, text, unsubUrl);
  if (sub.channel === "push") {
    const body = ascii(unsubUrl ? `${text} Stop: ${unsubUrl}` : text).slice(0, 400);
    const r = await sendViaNtfy(body || "SniffMaster alert", {
      url: pushLinks(sub.address).web,
      title: ascii(subject).slice(0, 80) || "SniffMaster",
      clickUrl: unsubUrl ? PUBLIC_BASE_URL : `${PUBLIC_BASE_URL}/#/alerts`,
      priority: 4,
    });
    if (!r.sent) throw new Error(r.failures?.[0]?.error || "push not sent");
    return;
  }
  const body = ascii(`SniffMaster: ${text}${unsubUrl ? ` Stop: ${unsubUrl}` : ""}`).slice(0, 600);
  const r = await sendViaClickSend(body, [sub.address]);
  if (!r.sent) throw new Error(r.failures?.[0]?.error || r.failures?.[0]?.status || "sms not sent");
}

const ascii = (t) =>
  String(t || "")
    .replace(/₂/g, "2").replace(/°/g, " deg").replace(/[–—]/g, "-").replace(/•/g, "*")
    .replace(/[^\x20-\x7e]/g, "");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── Public operations ─────────────────────────────────────────────────────

export class AlertError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function startSubscription({ channel, address, rules, ip }) {
  if (!["email", "sms", "push"].includes(channel)) throw new AlertError(400, "Pick email, text, or a phone notification.");
  if (channel === "sms") {
    const availability = await alertChannels();
    if (!availability.channels.sms) {
      throw new AlertError(503, availability.smsReason === "credit"
        ? "Text alerts are paused because the texting account is out of credit."
        : "Text alerts aren't set up on this dashboard yet.");
    }
  } else if (channel === "email" && !channelStatus().email) {
    throw new AlertError(503, "Email alerts aren't set up on this dashboard yet.");
  }
  const addr = channel === "push"
    ? `sniff-${randomBytes(12).toString("hex")}`
    : normalizeAddress(channel, address);
  if (!addr) throw new AlertError(400, channel === "sms" ? "That phone number doesn't look right." : "That email address doesn't look right.");

  const ipKey = createHash("sha256").update(String(ip || "?")).digest("hex").slice(0, 16);
  if ((await incrCounter(`alerts-ip:${ipKey}`, 3600)) > 12) throw new AlertError(429, "Too many sign-ups from here. Try again in an hour.");
  const addrKey = `alerts-addr:${createHash("sha256").update(addr).digest("hex").slice(0, 16)}`;
  // Count only codes that actually went out. A provider failure must not
  // turn into "we just sent a code" on the next try.
  if ((await getCounter(addrKey)) >= 3) throw new AlertError(429, "We just sent a code there. Give it a few minutes.");

  const subs = await loadSubscribers();
  if (subs.filter((s) => s.verified).length >= MAX_SUBSCRIBERS) throw new AlertError(409, "This dashboard has reached its alert limit.");

  const id = randomBytes(9).toString("base64url");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const pendingKey = `alerts-pending:${id}`;
  await setJsonCache(pendingKey, { channel, address: addr, rules: normalizeRules(rules), codeHash: hashCode(id, code), tries: 0 }, PENDING_TTL_SEC);

  const msg = `Your SniffMaster code is ${code}. It expires in 15 minutes.`;
  try {
    await deliver({ channel, address: addr }, "Your SniffMaster code", msg, false);
  } catch (err) {
    console.error("alerts: code delivery failed:", err?.message || err);
    await setJsonCache(pendingKey, { dead: true }, 1).catch(() => {});
    if (/INSUFFICIENT_CREDIT/i.test(String(err?.message || err))) await rememberEmptyBalance();
    const explained = explainDeliveryFailure(channel, err);
    throw new AlertError(explained.status, explained.message);
  }
  await incrCounter(addrKey, 3600);
  return {
    id,
    masked: maskAddress(channel, addr),
    ...(channel === "push" ? { push: pushLinks(addr) } : {}),
  };
}

export async function confirmSubscription({ id, code }) {
  const key = `alerts-pending:${String(id || "")}`;
  const pending = await getJsonCache(key);
  if (!pending) throw new AlertError(410, "That code expired. Start again.");
  if (pending.tries >= 5) throw new AlertError(429, "Too many wrong codes. Start again.");
  if (!sameHash(hashCode(id, String(code || "").trim()), pending.codeHash)) {
    await setJsonCache(key, { ...pending, tries: pending.tries + 1 }, PENDING_TTL_SEC);
    throw new AlertError(400, "That code isn't right.");
  }
  await setJsonCache(key, { ...pending, tries: 99 }, 1);

  const sub = {
    id,
    channel: pending.channel,
    address: pending.address,
    rules: pending.rules,
    token: randomBytes(18).toString("base64url"),
    verified: true,
    createdAt: Date.now(),
    state: {},
  };
  await updateSubscribers((subs) => [...subs.filter((s) => !(s.channel === pending.channel && s.address === pending.address)), sub]);

  const list = Object.entries(sub.rules).map(([k, v]) => (RULES[k].dir === "flag" ? RULES[k].label.toLowerCase() : `${RULES[k].label} ${RULES[k].dir} ${fmtVal(RULES[k], v)}`));
  try {
    await deliver(sub, "You're signed up for SniffMaster alerts", `You're all set. We'll let you know when: ${list.join("; ")}.`);
  } catch (err) {
    console.error("alerts: welcome delivery failed:", err?.message || err);
  }
  return { masked: maskAddress(sub.channel, sub.address), rules: sub.rules };
}

export async function unsubscribe(token) {
  const t = String(token || "");
  if (!t) return false;
  let removed = false;
  await updateSubscribers((subs) => {
    const left = subs.filter((s) => !sameHash(s.token, t));
    removed = left.length !== subs.length;
    return removed ? left : subs;
  });
  return removed;
}

/** Called after each device post (rate-gated by the caller). Never throws. */
export async function runSubscriberAlerts(snapshot, home) {
  const subs = await loadSubscribers();
  if (!subs.length) return 0;
  const ctx = alertContext(snapshot, home);
  const { sends, subs: next } = decideSubscriberAlerts(subs, ctx);
  const failed = new Set();
  let sent = 0;
  await Promise.all(
    sends.map(async ({ sub, tripped }) => {
      try {
        await deliver(sub, `SniffMaster: ${tripped.map((t) => t.rule.label).join(", ")}`, alertText(tripped, ctx));
        sent += 1;
      } catch (err) {
        failed.add(sub.id);
        console.error("alerts: subscriber send failed:", err?.message || err);
        if (sub.channel === "sms" && /INSUFFICIENT_CREDIT/i.test(String(err?.message || err))) await rememberEmptyBalance();
      }
    })
  );
  // A failed send keeps the subscriber's previous state, so the next check retries it.
  const stateById = new Map(next.filter((s) => !failed.has(s.id)).map((s) => [s.id, s.state]));
  const prevById = new Map(subs.map((s) => [s.id, JSON.stringify(s.state || {})]));
  const changed = [...stateById].some(([id, st]) => JSON.stringify(st || {}) !== prevById.get(id));
  if (changed) {
    // Merge only alert state into a fresh read, so a sign-up or unsubscribe
    // that landed while we were sending isn't overwritten.
    await updateSubscribers((fresh) => fresh.map((s) => (stateById.has(s.id) ? { ...s, state: stateById.get(s.id) } : s)));
  }
  return sent;
}

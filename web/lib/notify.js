/**
 * notify.js — Twilio SMS helper for SniffMaster alerts.
 *
 * Sends plain-text SMS via the Twilio REST API using native `fetch`
 * (no extra npm deps — same pattern as the weather-briefing OpenAI fetch).
 *
 * Environment variables (set in Vercel dashboard / .env.local):
 *   TWILIO_ACCOUNT_SID  — Twilio Account SID (starts with "AC...")
 *   TWILIO_AUTH_TOKEN   — Twilio Auth Token
 *   TWILIO_FROM         — Twilio-provisioned sender number (E.164, e.g. +13215551234)
 *   ALERT_SMS_TO        — recipient number(s), comma-separated (E.164)
 *
 * Design note: sendSms() NEVER throws. Telemetry ingestion and the daily-summary
 * cron must succeed even if Twilio is down or misconfigured, so all failures are
 * caught, logged, and surfaced only via the returned {sent, failures} summary.
 */

const TWILIO_BASE = "https://api.twilio.com/2010-04-01";

function env(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

/** Parse ALERT_SMS_TO into a de-duplicated list of E.164 recipients. */
export function getRecipients() {
  return env("ALERT_SMS_TO")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .filter((n, i, arr) => arr.indexOf(n) === i);
}

/** True only when every credential needed to actually send is present. */
export function isSmsConfigured() {
  return Boolean(
    env("TWILIO_ACCOUNT_SID") &&
      env("TWILIO_AUTH_TOKEN") &&
      env("TWILIO_FROM") &&
      getRecipients().length > 0
  );
}

/**
 * Send an SMS to every configured recipient.
 * @param {string} body — message text (Twilio segments long bodies automatically)
 * @returns {Promise<{configured:boolean, sent:number, failures:Array<{to:string,error:string}>}>}
 */
export async function sendSms(body) {
  const text = String(body || "").trim();
  if (!text) {
    return { configured: isSmsConfigured(), sent: 0, failures: [] };
  }

  if (!isSmsConfigured()) {
    console.warn("notify: SMS not configured — skipping send");
    return { configured: false, sent: 0, failures: [] };
  }

  const sid = env("TWILIO_ACCOUNT_SID");
  const token = env("TWILIO_AUTH_TOKEN");
  const from = env("TWILIO_FROM");
  const recipients = getRecipients();
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const url = `${TWILIO_BASE}/Accounts/${encodeURIComponent(sid)}/Messages.json`;

  let sent = 0;
  const failures = [];

  for (const to of recipients) {
    try {
      const params = new URLSearchParams({ To: to, From: from, Body: text });
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      if (resp.ok) {
        sent += 1;
      } else {
        const detail = await resp.text().catch(() => "");
        failures.push({ to, error: `HTTP ${resp.status} ${detail}`.trim() });
        console.error(`notify: Twilio send to ${to} failed — HTTP ${resp.status} ${detail}`);
      }
    } catch (err) {
      const message = err?.message || String(err);
      failures.push({ to, error: message });
      console.error(`notify: Twilio send to ${to} threw — ${message}`);
    }
  }

  return { configured: true, sent, failures };
}

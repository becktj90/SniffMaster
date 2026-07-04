/**
 * notify.js — SMS helper for SniffMaster alerts (AWS SNS primary, Twilio fallback).
 *
 * Providers, tried in order (first one that delivers wins):
 *   1. AWS SNS  — configured via SNS_AWS_* env vars (see below)
 *   2. Twilio   — configured via TWILIO_* env vars
 *   3. ntfy     — free push notification (https://ntfy.sh), configured via
 *                 NTFY_TOPIC (or NTFY_URL for a self-hosted server). Not SMS,
 *                 but needs no carrier registration, so it guarantees the
 *                 message reaches the owner's phone even while SMS providers
 *                 are pending approval or having an outage.
 *
 * ⚠ Env naming: Vercel functions run on AWS Lambda, which RESERVES the standard
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION names and injects its
 * own execution-role credentials into them — you cannot set them in the Vercel
 * dashboard, and reading them would pick up an identity with no SNS rights.
 * So the SNS credentials use prefixed names, passed to the client explicitly:
 *
 *   SNS_AWS_ACCESS_KEY_ID      — IAM access key ("AKIA...") with sns:Publish
 *   SNS_AWS_SECRET_ACCESS_KEY  — matching IAM secret key
 *   SNS_AWS_REGION             — optional, defaults to us-east-1
 *   ALERT_SMS_TO               — recipient number(s), comma-separated (E.164)
 *
 *   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN — optional fallback, plus one of:
 *   TWILIO_MESSAGING_SERVICE_SID — preferred: an MG... Messaging Service whose
 *                                  sender pool holds your registered number
 *   TWILIO_FROM                  — or a bare from-number (E.164)
 *
 * (For local dev outside Vercel, the standard AWS_* names also work as a
 * fallback source for the SNS credentials.)
 *
 * Design note: sendSms() NEVER throws. Telemetry ingestion and the daily-summary
 * cron must succeed even if the SMS provider is down or misconfigured, so all
 * failures are caught, logged, and surfaced only via the returned summary.
 */

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const TWILIO_BASE = "https://api.twilio.com/2010-04-01";
// Hard cap per provider request. Recipients are sent in parallel, so this also
// bounds total send time — the ESP32 is waiting on /api/update's response, and
// Vercel Hobby functions have a ~10s budget. A hung provider call must not eat it.
const SEND_TIMEOUT_MS = 5000;

function env(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

// Owner's cell — used when ALERT_SMS_TO is not set, so alerts still reach the
// field even if the env var is missing after a redeploy. Note this number is
// public in the repo; set ALERT_SMS_TO to override without a code change.
const DEFAULT_ALERT_SMS_TO = "+15104324862";

/** Parse ALERT_SMS_TO into a de-duplicated list of E.164 recipients. */
export function getRecipients() {
  const configured = (env("ALERT_SMS_TO") || DEFAULT_ALERT_SMS_TO)
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    // Tolerate "15104324862" / "1-510-432-4862" style input: strip separators,
    // then ensure a leading + (assume US "1" prefix already present or add it).
    .map((n) => {
      if (n.startsWith("+")) return n;
      const digits = n.replace(/[^0-9]/g, "");
      if (!digits) return "";
      return `+${digits.length === 10 ? "1" : ""}${digits}`;
    })
    .filter(Boolean);
  return configured.filter((n, i, arr) => arr.indexOf(n) === i);
}

function snsCreds() {
  return {
    accessKeyId: env("SNS_AWS_ACCESS_KEY_ID") || env("AWS_ACCESS_KEY_ID"),
    secretAccessKey: env("SNS_AWS_SECRET_ACCESS_KEY") || env("AWS_SECRET_ACCESS_KEY"),
    region: env("SNS_AWS_REGION") || env("AWS_REGION") || "us-east-1",
  };
}

export function isSnsConfigured() {
  const { accessKeyId, secretAccessKey } = snsCreds();
  // On Vercel, only the SNS_AWS_* names can be user-set; the unprefixed names
  // hold Lambda's own execution-role creds, which cannot publish SMS. Require
  // the explicit prefix when running inside Vercel to avoid that trap.
  if (process.env.VERCEL) {
    return Boolean(env("SNS_AWS_ACCESS_KEY_ID") && env("SNS_AWS_SECRET_ACCESS_KEY") && getRecipients().length > 0);
  }
  return Boolean(accessKeyId && secretAccessKey && getRecipients().length > 0);
}

export function isTwilioConfigured() {
  return Boolean(
    env("TWILIO_ACCOUNT_SID") &&
      env("TWILIO_AUTH_TOKEN") &&
      (env("TWILIO_MESSAGING_SERVICE_SID") || env("TWILIO_FROM")) &&
      getRecipients().length > 0
  );
}

export function isNtfyConfigured() {
  return Boolean(env("NTFY_URL") || env("NTFY_TOPIC"));
}

/** True when at least one delivery channel (SMS or push) is fully configured. */
export function isSmsConfigured() {
  return isSnsConfigured() || isTwilioConfigured() || isNtfyConfigured();
}

export async function sendViaSns(text, recipients) {
  const { accessKeyId, secretAccessKey, region } = snsCreds();
  const client = new SNSClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  let sent = 0;
  const failures = [];

  // Parallel sends: total wall time stays bounded by SEND_TIMEOUT_MS.
  await Promise.all(
    recipients.map(async (phoneNumber) => {
      try {
        const command = new PublishCommand({
          Message: text,
          PhoneNumber: phoneNumber,
          MessageAttributes: {
            // Transactional = delivery-optimized routing (alerts, not marketing).
            "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
          },
        });
        const response = await client.send(command, {
          abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (response.MessageId) {
          sent += 1;
        } else {
          failures.push({ to: phoneNumber, error: "no MessageId in SNS response" });
        }
      } catch (err) {
        const message =
          err?.name === "TimeoutError" || err?.name === "AbortError"
            ? `timeout after ${SEND_TIMEOUT_MS}ms`
            : err?.message || String(err);
        failures.push({ to: phoneNumber, error: message.slice(0, 300) });
        console.error(`notify: SNS send to ${phoneNumber} failed — ${message}`);
      }
    })
  );

  return { sent, failures };
}

export async function sendViaTwilio(text, recipients) {
  const sid = env("TWILIO_ACCOUNT_SID");
  const token = env("TWILIO_AUTH_TOKEN");
  const messagingServiceSid = env("TWILIO_MESSAGING_SERVICE_SID");
  const from = env("TWILIO_FROM");
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const url = `${TWILIO_BASE}/Accounts/${encodeURIComponent(sid)}/Messages.json`;

  let sent = 0;
  const failures = [];

  await Promise.all(
    recipients.map(async (to) => {
      try {
        // A Messaging Service (MG...) is Twilio's recommended sender for
        // A2P/toll-free-registered traffic: it picks the right number from its
        // sender pool. A bare From number still works for unregistered routes.
        const params = new URLSearchParams(
          messagingServiceSid
            ? { To: to, MessagingServiceSid: messagingServiceSid, Body: text }
            : { To: to, From: from, Body: text }
        );
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });

        if (resp.ok) {
          sent += 1;
        } else {
          const detail = await resp.text().catch(() => "");
          failures.push({ to, error: `HTTP ${resp.status} ${detail}`.trim().slice(0, 300) });
          console.error(`notify: Twilio send to ${to} failed — HTTP ${resp.status} ${detail}`);
        }
      } catch (err) {
        const message = err?.name === "TimeoutError" ? `timeout after ${SEND_TIMEOUT_MS}ms` : err?.message || String(err);
        failures.push({ to, error: message });
        console.error(`notify: Twilio send to ${to} threw — ${message}`);
      }
    })
  );

  return { sent, failures };
}

/**
 * Publish to an ntfy topic (push notification, not SMS). One POST regardless
 * of recipient count — the topic itself is the destination. Timeout is kept
 * shorter than the SMS providers' because ntfy only runs after both of them
 * have already had their turn, and /api/update's total budget is tight.
 */
export async function sendViaNtfy(text) {
  const url = env("NTFY_URL") || `https://ntfy.sh/${encodeURIComponent(env("NTFY_TOPIC"))}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { Title: "SniffMaster", "Content-Type": "text/plain" },
      body: text,
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) return { sent: 1, failures: [] };
    const detail = await resp.text().catch(() => "");
    const error = `HTTP ${resp.status} ${detail}`.trim().slice(0, 300);
    console.error(`notify: ntfy publish failed — ${error}`);
    return { sent: 0, failures: [{ to: "ntfy", error }] };
  } catch (err) {
    const message = err?.name === "TimeoutError" ? "timeout after 3000ms" : err?.message || String(err);
    console.error(`notify: ntfy publish threw — ${message}`);
    return { sent: 0, failures: [{ to: "ntfy", error: message }] };
  }
}

/**
 * Send an SMS to every configured recipient via the first working provider.
 * @param {string} body — message text (keep it GSM-7-safe ASCII; see thresholds.js)
 * @returns {Promise<{configured:boolean, sent:number, failures:Array<{to:string,error:string}>, provider:string|null}>}
 */
export async function sendSms(body) {
  const text = String(body || "").trim();
  if (!text) {
    return { configured: isSmsConfigured(), sent: 0, failures: [], provider: null };
  }

  if (!isSmsConfigured()) {
    console.warn("notify: SMS not configured — skipping send");
    return { configured: false, sent: 0, failures: [], provider: null };
  }

  const recipients = getRecipients();
  const allFailures = [];
  let lastProvider = null;

  if (isSnsConfigured()) {
    const { sent, failures } = await sendViaSns(text, recipients);
    allFailures.push(...failures.map((f) => ({ ...f, provider: "sns" })));
    if (sent > 0) return { configured: true, sent, failures: allFailures, provider: "sns" };
    lastProvider = "sns";
    console.warn("notify: all SNS sends failed — trying next provider");
  }

  if (isTwilioConfigured()) {
    const { sent, failures } = await sendViaTwilio(text, recipients);
    allFailures.push(...failures.map((f) => ({ ...f, provider: "twilio" })));
    if (sent > 0) return { configured: true, sent, failures: allFailures, provider: "twilio" };
    lastProvider = "twilio";
    console.warn("notify: all Twilio sends failed" + (isNtfyConfigured() ? " — trying ntfy" : ""));
  }

  if (isNtfyConfigured()) {
    const { sent, failures } = await sendViaNtfy(text);
    allFailures.push(...failures.map((f) => ({ ...f, provider: "ntfy" })));
    if (sent > 0) return { configured: true, sent, failures: allFailures, provider: "ntfy" };
    lastProvider = "ntfy";
  }

  return { configured: true, sent: 0, failures: allFailures, provider: lastProvider };
}

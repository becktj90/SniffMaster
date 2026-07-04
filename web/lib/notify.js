/**
 * notify.js — SMS helper for SniffMaster alerts (AWS SNS primary, Twilio fallback).
 *
 * Channels:
 *   SMS chain (first success wins): AWS SNS (SNS_AWS_* env vars), then
 *   Twilio (TWILIO_* env vars).
 *
 *   ntfy — free push notification (https://ntfy.sh), configured via
 *   NTFY_TOPIC (or NTFY_URL for a self-hosted server). ALWAYS sent in
 *   parallel with the SMS chain, not as a fallback: both SNS (sandbox) and
 *   Twilio (pre-A2P/toll-free registration) will happily return success for
 *   messages the carrier then drops silently, so an SMS provider's "sent" is
 *   not proof of delivery. The push needs no carrier registration and is the
 *   one channel we can actually trust; when real SMS also lands, the owner
 *   simply gets the message twice (remove NTFY_TOPIC to stop that).
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

export async function sendViaTwilio(text, recipients, opts = {}) {
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
        const base = messagingServiceSid
          ? { To: to, MessagingServiceSid: messagingServiceSid, Body: text }
          : { To: to, From: from, Body: text };
        // MediaUrl turns this into an MMS. Optional — a fetch failure on
        // Twilio's side degrades to plain SMS, it never blocks the send.
        if (opts.mediaUrl) base.MediaUrl = opts.mediaUrl;
        const params = new URLSearchParams(base);
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
 * of recipient count — the topic itself is the destination. Runs in parallel
 * with the SMS chain, so its shorter timeout never extends total send time.
 *
 * @param {string} text
 * @param {{imageUrl?:string, clickUrl?:string}} [opts] — imageUrl: ntfy
 *   downloads it server-side and attaches it to the notification (e.g. an NWS
 *   forecast icon). clickUrl: tapping the notification opens this (e.g. a
 *   radar page). Both optional and best-effort — a bad URL degrades to a
 *   plain text push, it never blocks the send.
 */
export async function sendViaNtfy(text, opts = {}) {
  const url = env("NTFY_URL") || `https://ntfy.sh/${encodeURIComponent(env("NTFY_TOPIC"))}`;
  // Header values must be single-line; strip anything that would break the
  // request rather than trust an upstream API to never return a stray newline.
  const headerSafe = (v) => String(v || "").replace(/[\r\n]/g, "").trim();
  const headers = { Title: "SniffMaster", "Content-Type": "text/plain" };
  if (opts.imageUrl) headers.Attach = headerSafe(opts.imageUrl);
  if (opts.clickUrl) headers.Click = headerSafe(opts.clickUrl);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
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
 * @param {{imageUrl?:string, clickUrl?:string}} [opts] — optional graphic: an
 *   image attached via Twilio MMS (if configured) and/or the ntfy push;
 *   clickUrl only applies to ntfy (SMS has no concept of a tap-through link).
 *   Both best-effort — never blocks or fails the underlying text send.
 * @returns {Promise<{configured:boolean, sent:number, failures:Array<{to:string,error:string}>, provider:string|null}>}
 */
export async function sendSms(body, opts = {}) {
  const text = String(body || "").trim();
  if (!text) {
    return { configured: isSmsConfigured(), sent: 0, failures: [], provider: null };
  }

  if (!isSmsConfigured()) {
    console.warn("notify: SMS not configured — skipping send");
    return { configured: false, sent: 0, failures: [], provider: null };
  }

  const recipients = getRecipients();

  // SNS → Twilio, first API-level success wins. SNS has no MMS/attachment
  // capability at all, so opts.imageUrl only ever reaches Twilio.
  const smsChain = async () => {
    const failures = [];
    if (isSnsConfigured()) {
      const r = await sendViaSns(text, recipients);
      failures.push(...r.failures.map((f) => ({ ...f, provider: "sns" })));
      if (r.sent > 0) return { sent: r.sent, failures, provider: "sns" };
      console.warn("notify: all SNS sends failed" + (isTwilioConfigured() ? " — trying Twilio" : ""));
    }
    if (isTwilioConfigured()) {
      const r = await sendViaTwilio(text, recipients, { mediaUrl: opts.imageUrl });
      failures.push(...r.failures.map((f) => ({ ...f, provider: "twilio" })));
      if (r.sent > 0) return { sent: r.sent, failures, provider: "twilio" };
    }
    return { sent: 0, failures, provider: null };
  };

  // ntfy runs alongside the SMS chain, never gated on its outcome — see the
  // header note on SMS providers reporting success for undeliverable messages.
  const [sms, ntfy] = await Promise.all([
    smsChain(),
    isNtfyConfigured() ? sendViaNtfy(text, opts) : Promise.resolve(null),
  ]);

  const allFailures = [
    ...sms.failures,
    ...(ntfy ? ntfy.failures.map((f) => ({ ...f, provider: "ntfy" })) : []),
  ];
  const providers = [];
  if (sms.sent > 0) providers.push(sms.provider);
  if (ntfy?.sent > 0) providers.push("ntfy");

  return {
    configured: true,
    sent: sms.sent + (ntfy?.sent || 0),
    failures: allFailures,
    provider: providers.join("+") || null,
  };
}

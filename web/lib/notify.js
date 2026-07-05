/**
 * notify.js — SMS helper for SniffMaster alerts (AWS SNS primary, ClickSend fallback).
 *
 * Channels:
 *   SMS chain (first success wins): AWS SNS (SNS_AWS_* env vars), then
 *   ClickSend (CLICKSEND_* env vars).
 *
 *   ntfy — free push notification (https://ntfy.sh), configured via
 *   NTFY_TOPIC (or NTFY_URL for a self-hosted server). ALWAYS sent in
 *   parallel with the SMS chain, not as a fallback: SNS (sandbox) will happily
 *   return success for messages the carrier then drops silently, so an SMS
 *   provider's "sent" is not proof of delivery. The push needs no carrier
 *   registration and is the one channel we can actually trust; when real SMS
 *   also lands, the owner simply gets the message twice (remove NTFY_TOPIC to
 *   stop that).
 *
 * Twilio support has been removed: Twilio's US SMS requires A2P 10DLC brand
 * registration through The Campaign Registry before real messages deliver —
 * on a Trial account this is stuck behind an auto-generated "Mock Brand" that
 * never delivers. ClickSend needs no per-sender brand registration for
 * low-volume personal alerts, so it is the sole SMS fallback now.
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
 *   CLICKSEND_USERNAME / CLICKSEND_API_KEY — ClickSend account credentials.
 *
 * (For local dev outside Vercel, the standard AWS_* names also work as a
 * fallback source for the SNS credentials.)
 *
 * Design note: sendSms() NEVER throws. Telemetry ingestion and the daily-summary
 * cron must succeed even if the SMS provider is down or misconfigured, so all
 * failures are caught, logged, and surfaced only via the returned summary.
 */

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const CLICKSEND_URL = "https://rest.clicksend.com/v3/sms/send";
const CLICKSEND_MMS_URL = "https://rest.clicksend.com/v3/mms/send";
// Hard cap per provider request. Recipients are sent in parallel, so this also
// bounds total send time — the ESP32 is waiting on /api/update's response, and
// Vercel Hobby functions have a ~10s budget. A hung provider call must not eat it.
const SEND_TIMEOUT_MS = 5000;
// MMS carries an image fetch on ClickSend's side (they pull media_file
// themselves), so it needs more headroom than a plain SMS post.
const MMS_SEND_TIMEOUT_MS = 9000;

// Public site the report-card image and dashboard link resolve against. Set
// PUBLIC_BASE_URL if the app ever moves off this domain.
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://sniffmaster-web.vercel.app").trim().replace(/\/+$/, "");

function env(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

// Owner's cell — used when ALERT_SMS_TO is not set, so alerts still reach the
// field even if the env var is missing after a redeploy. Note this number is
// public in the repo; set ALERT_SMS_TO to override without a code change.
const DEFAULT_ALERT_SMS_TO = "+15104324862";

// ClickSend sender number (the "From"). Set CLICKSEND_FROM to override.
const DEFAULT_CLICKSEND_FROM = "+18335304015";

function clickSendFrom() {
  return env("CLICKSEND_FROM") || DEFAULT_CLICKSEND_FROM;
}

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

export function isClickSendConfigured() {
  return Boolean(env("CLICKSEND_USERNAME") && env("CLICKSEND_API_KEY") && getRecipients().length > 0);
}

export function isNtfyConfigured() {
  return Boolean(env("NTFY_URL") || env("NTFY_TOPIC"));
}

/** True when at least one delivery channel (SMS or push) is fully configured. */
export function isSmsConfigured() {
  return isSnsConfigured() || isClickSendConfigured() || isNtfyConfigured();
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

function clickSendAuthHeader() {
  const username = env("CLICKSEND_USERNAME");
  const apiKey = env("CLICKSEND_API_KEY");
  return `Basic ${Buffer.from(`${username}:${apiKey}`).toString("base64")}`;
}

/**
 * Shared success check + diagnostic-detail extraction for both ClickSend SMS
 * and MMS responses — same response shape, same "HTTP 200 but queued_count:0"
 * failure mode either way.
 */
function evaluateClickSendResponse(resp, data) {
  const msg = data?.data?.messages?.[0];
  const msgStatus = msg?.status;
  // queued_count is ClickSend's ground truth: the API can return HTTP 200
  // with response_code "SUCCESS" (the *request* was well-formed) while
  // still queuing zero of the messages (the send itself was rejected —
  // e.g. insufficient account balance, unapproved sender, unsupported media).
  // Trust that over the per-message status string, which the docs don't
  // guarantee is present.
  const queuedCount = Number(data?.data?.queued_count);
  const totalCount = Number(data?.data?.total_count);
  const ok = resp.ok && (
    Number.isFinite(queuedCount) && Number.isFinite(totalCount)
      ? queuedCount > 0
      : msgStatus === "SUCCESS" || msgStatus === "QUEUED" || !msgStatus
  );
  const detail = JSON.stringify({
    response_code: data?.response_code,
    response_msg: data?.response_msg,
    queued_count: data?.data?.queued_count,
    total_count: data?.data?.total_count,
    status: msg?.status,
    error_code: msg?.error_code,
    error_text: msg?.error_text,
  });
  return { ok, detail };
}

export async function sendViaClickSend(text, recipients) {
  let sent = 0;
  const failures = [];

  await Promise.all(
    recipients.map(async (to) => {
      try {
        const resp = await fetch(CLICKSEND_URL, {
          method: "POST",
          headers: {
            Authorization: clickSendAuthHeader(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messages: [{ to, from: clickSendFrom(), body: text, source: "sniffmaster" }] }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });

        const data = await resp.json().catch(() => null);
        const { ok, detail } = data
          ? evaluateClickSendResponse(resp, data)
          : { ok: false, detail: await resp.text().catch(() => "") };
        if (ok) {
          sent += 1;
        } else {
          // Log enough of the payload to see msg.status/error_text — the old
          // 300-char cap cut the response off mid-body, hiding the actual
          // rejection reason on every failure.
          failures.push({ to, error: `HTTP ${resp.status} ${detail}`.trim().slice(0, 500) });
          console.error(`notify: ClickSend send to ${to} failed — HTTP ${resp.status} ${detail}`);
        }
      } catch (err) {
        const message = err?.name === "TimeoutError" ? `timeout after ${SEND_TIMEOUT_MS}ms` : err?.message || String(err);
        failures.push({ to, error: message });
        console.error(`notify: ClickSend send to ${to} threw — ${message}`);
      }
    })
  );

  return { sent, failures };
}

/**
 * Send an MMS via ClickSend — same account/auth as SMS, different endpoint
 * and payload shape (adds `media_file`, a URL ClickSend fetches server-side;
 * carriers expect a raster image, not SVG, so callers should point this at a
 * PNG/JPEG endpoint).
 * @param {string} text — message body
 * @param {string[]} recipients — E.164 numbers
 * @param {string} mediaUrl — publicly reachable image URL
 * @param {string} [subject] — MMS subject line (required by some carriers)
 */
export async function sendViaClickSendMms(text, recipients, mediaUrl, subject = "SniffMaster Report") {
  let sent = 0;
  const failures = [];

  await Promise.all(
    recipients.map(async (to) => {
      try {
        const resp = await fetch(CLICKSEND_MMS_URL, {
          method: "POST",
          headers: {
            Authorization: clickSendAuthHeader(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: [{ to, from: clickSendFrom(), body: text, subject, media_file: mediaUrl, source: "sniffmaster" }],
          }),
          signal: AbortSignal.timeout(MMS_SEND_TIMEOUT_MS),
        });

        const data = await resp.json().catch(() => null);
        const { ok, detail } = data
          ? evaluateClickSendResponse(resp, data)
          : { ok: false, detail: await resp.text().catch(() => "") };
        if (ok) {
          sent += 1;
        } else {
          failures.push({ to, error: `HTTP ${resp.status} ${detail}`.trim().slice(0, 500) });
          console.error(`notify: ClickSend MMS to ${to} failed — HTTP ${resp.status} ${detail}`);
        }
      } catch (err) {
        const message = err?.name === "TimeoutError" ? `timeout after ${MMS_SEND_TIMEOUT_MS}ms` : err?.message || String(err);
        failures.push({ to, error: message });
        console.error(`notify: ClickSend MMS to ${to} threw — ${message}`);
      }
    })
  );

  return { sent, failures };
}

/**
 * Publish to an ntfy topic (push notification, not SMS). One POST regardless
 * of recipient count — the topic itself is the destination. Runs in parallel
 * with the SMS chain, so its shorter timeout never extends total send time.
 */
export async function sendViaNtfy(text, opts = {}) {
  const url = env("NTFY_URL") || `https://ntfy.sh/${encodeURIComponent(env("NTFY_TOPIC"))}`;
  const headers = { Title: "SniffMaster", "Content-Type": "text/plain" };
  // Visual report card: ntfy renders an image URL passed via Attach as an
  // inline thumbnail, and opens Click's URL when the notification is tapped.
  if (opts.imageUrl) headers.Attach = opts.imageUrl;
  if (opts.clickUrl) headers.Click = opts.clickUrl;
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
 * @param {{imageUrl?:string, clickUrl?:string}} [opts] — visual report card;
 *   SMS providers here are text-only so this only reaches the ntfy push.
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

  // SNS → ClickSend, first API-level success wins.
  const smsChain = async () => {
    const failures = [];
    if (isSnsConfigured()) {
      const r = await sendViaSns(text, recipients);
      failures.push(...r.failures.map((f) => ({ ...f, provider: "sns" })));
      if (r.sent > 0) return { sent: r.sent, failures, provider: "sns" };
      console.warn("notify: all SNS sends failed" + (isClickSendConfigured() ? " — trying ClickSend" : ""));
    }
    if (isClickSendConfigured()) {
      // Carry the report-card image as an MMS when one's supplied — SNS has
      // no MMS path in this codebase, but ClickSend does.
      const r = opts.imageUrl
        ? await sendViaClickSendMms(text, recipients, opts.imageUrl, opts.subject)
        : await sendViaClickSend(text, recipients);
      const provider = opts.imageUrl ? "clicksend-mms" : "clicksend";
      failures.push(...r.failures.map((f) => ({ ...f, provider })));
      if (r.sent > 0) return { sent: r.sent, failures, provider };
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

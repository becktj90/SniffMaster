/**
 * GET /api/test-sms — test SMS configuration (AWS SNS and Brevo)
 *
 * This endpoint checks if SMS is properly configured and optionally sends a test message.
 * Query parameters:
 *   ?send=true       — actually send a test SMS
 *   ?send=false      — just report configuration status (default)
 *   ?provider=sns    — force the send through one provider, skipping the
 *   ?provider=brevo    normal SNS → Brevo → ntfy fallback order (diagnostic
 *   ?provider=ntfy     use only — lets you confirm one provider actually
 *                       delivers even when another reports success but the
 *                       text never arrives, e.g. an unverified number in the
 *                       SNS SMS sandbox: Publish returns a MessageId with no
 *                       error, but the carrier never receives it).
 *
 * Response:
 * {
 *   configured: boolean,
 *   snsConfigured: boolean,
 *   brevoConfigured: boolean,
 *   recipients: string[],
 *   test: {
 *     sent: number,
 *     failures: Array<{to, error, provider}>,
 *     provider: string | null,
 *     timestamp: number
 *   } | null
 * }
 */

import {
  isSmsConfigured,
  isSnsConfigured,
  isBrevoConfigured,
  isNtfyConfigured,
  getRecipients,
  sendSms,
  sendViaSns,
  sendViaBrevo,
  sendViaNtfy,
} from "../lib/notify.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const shouldSend = req.query?.send === "true";
  const recipients = getRecipients();

  const response = {
    configured: isSmsConfigured(),
    snsConfigured: isSnsConfigured(),
    brevoConfigured: isBrevoConfigured(),
    ntfyConfigured: isNtfyConfigured(),
    recipients,
    test: null,
  };

  if (!shouldSend) {
    return res.status(200).json(response);
  }

  // Send a test SMS
  if (!response.configured) {
    return res.status(400).json({
      ...response,
      error: "SMS is not configured. Set SNS_AWS_* or BREVO_* environment variables.",
    });
  }

  const requested = String(req.query?.provider || "");
  const forceProvider = ["brevo", "sns", "ntfy"].includes(requested) ? requested : null;
  if (forceProvider === "brevo" && !isBrevoConfigured()) {
    return res.status(400).json({ ...response, error: "Brevo is not configured." });
  }
  if (forceProvider === "sns" && !isSnsConfigured()) {
    return res.status(400).json({ ...response, error: "AWS SNS is not configured." });
  }
  if (forceProvider === "ntfy" && !isNtfyConfigured()) {
    return res.status(400).json({ ...response, error: "ntfy is not configured. Set NTFY_TOPIC (or NTFY_URL)." });
  }

  try {
    const timestamp = new Date().toISOString();
    const testMessage = `SniffMaster SMS Test - ${timestamp}. If you received this, SMS is working!`;

    let result;
    if (forceProvider === "brevo") {
      const { sent, failures } = await sendViaBrevo(testMessage, recipients);
      result = { sent, failures: failures.map((f) => ({ ...f, provider: "brevo" })), provider: "brevo" };
    } else if (forceProvider === "sns") {
      const { sent, failures } = await sendViaSns(testMessage, recipients);
      result = { sent, failures: failures.map((f) => ({ ...f, provider: "sns" })), provider: "sns" };
    } else if (forceProvider === "ntfy") {
      const { sent, failures } = await sendViaNtfy(testMessage);
      result = { sent, failures: failures.map((f) => ({ ...f, provider: "ntfy" })), provider: "ntfy" };
    } else {
      result = await sendSms(testMessage);
    }

    response.test = {
      sent: result.sent,
      failures: result.failures,
      provider: result.provider,
      timestamp: Date.now(),
      message: testMessage,
    };

    const status = result.sent > 0 ? 200 : 500;
    return res.status(status).json(response);
  } catch (err) {
    console.error("test-sms error:", err);
    return res.status(500).json({
      ...response,
      error: err?.message || String(err),
    });
  }
}

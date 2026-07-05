/**
 * GET /api/test-sms — test SMS configuration (AWS SNS and ClickSend)
 *
 * This endpoint checks if SMS is properly configured and optionally sends a test message.
 * Query parameters:
 *   ?send=true         — actually send a test SMS
 *   ?send=false        — just report configuration status (default)
 *   ?provider=sns       — force the send through one provider, skipping the
 *   ?provider=clicksend   normal SNS → ClickSend → ntfy fallback order
 *   ?provider=ntfy        (diagnostic use only — lets you confirm one
 *                          provider actually delivers even when another
 *                          reports success but the text never arrives, e.g.
 *                          an unverified number in the SNS SMS sandbox:
 *                          Publish returns a MessageId with no error, but
 *                          the carrier never receives it).
 *   ?mms=true           — send an MMS via ClickSend instead of plain SMS:
 *                          the report-card PNG attached, body text is the
 *                          latest stored daily report (weather/lightning
 *                          risk/Cape launches included) if one exists, else
 *                          a generic test message. Ignores ?provider.
 *
 * Response:
 * {
 *   configured: boolean,
 *   snsConfigured: boolean,
 *   clickSendConfigured: boolean,
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
  isClickSendConfigured,
  isNtfyConfigured,
  getRecipients,
  sendSms,
  sendViaSns,
  sendViaClickSend,
  sendViaClickSendMms,
  sendViaNtfy,
  REPORT_CARD_PNG_URL,
} from "../lib/notify.js";
import { getDailySummary } from "../lib/store.js";

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
    clickSendConfigured: isClickSendConfigured(),
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
      error: "SMS is not configured. Set SNS_AWS_* or CLICKSEND_* environment variables.",
    });
  }

  const requested = String(req.query?.provider || "");
  const forceProvider = ["clicksend", "sns", "ntfy"].includes(requested) ? requested : null;
  if (forceProvider === "clicksend" && !isClickSendConfigured()) {
    return res.status(400).json({ ...response, error: "ClickSend is not configured." });
  }
  if (forceProvider === "sns" && !isSnsConfigured()) {
    return res.status(400).json({ ...response, error: "AWS SNS is not configured." });
  }
  if (forceProvider === "ntfy" && !isNtfyConfigured()) {
    return res.status(400).json({ ...response, error: "ntfy is not configured. Set NTFY_TOPIC (or NTFY_URL)." });
  }

  const wantsMms = req.query?.mms === "true";
  if (wantsMms && !isClickSendConfigured()) {
    return res.status(400).json({ ...response, error: "ClickSend is not configured (MMS requires it)." });
  }

  try {
    const timestamp = new Date().toISOString();
    const testMessage = `SniffMaster SMS Test - ${timestamp}. If you received this, SMS is working!`;

    let result;
    if (wantsMms) {
      // Prefer the latest real daily report (already has weather, lightning
      // risk, and today's Cape launches baked in) over a placeholder string.
      const latest = await getDailySummary().catch(() => null);
      const body = latest?.smsText || `${testMessage} (no stored daily report yet — this is placeholder text.)`;
      // Diagnostic overrides (isolating ClickSend's "Invalid input" 400):
      //   ?mediaUrl=<url>  — swap the image URL (e.g. a known-good external host)
      //   ?subject=<text>  — override the subject line
      //   ?noSubject=true  — omit subject entirely
      const mediaUrl = req.query?.mediaUrl || REPORT_CARD_PNG_URL;
      const subject = req.query?.noSubject === "true" ? undefined : (req.query?.subject ?? "SniffMaster Report");
      const { sent, failures } = await sendViaClickSendMms(body, recipients, mediaUrl, subject);
      result = { sent, failures: failures.map((f) => ({ ...f, provider: "clicksend-mms" })), provider: "clicksend-mms" };
      response.test = { sent: result.sent, failures: result.failures, provider: result.provider, timestamp: Date.now(), message: body, mediaUrl, subject };
      const status = result.sent > 0 ? 200 : 500;
      return res.status(status).json(response);
    } else if (forceProvider === "clicksend") {
      const { sent, failures } = await sendViaClickSend(testMessage, recipients);
      result = { sent, failures: failures.map((f) => ({ ...f, provider: "clicksend" })), provider: "clicksend" };
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

/**
 * GET /api/test-sms — test SMS configuration (AWS SNS and Twilio)
 *
 * This endpoint checks if SMS is properly configured and optionally sends a test message.
 * Query parameters:
 *   ?send=true  — actually send a test SMS
 *   ?send=false — just report configuration status (default)
 *
 * Response:
 * {
 *   configured: boolean,
 *   snsConfigured: boolean,
 *   twilioConfigured: boolean,
 *   recipients: string[],
 *   test: {
 *     sent: number,
 *     failures: Array<{to, error, provider}>,
 *     provider: string | null,
 *     timestamp: number
 *   } | null
 * }
 */

import { isSmsConfigured, isSnsConfigured, isTwilioConfigured, getRecipients, sendSms } from "../lib/notify.js";

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
    twilioConfigured: isTwilioConfigured(),
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
      error: "SMS is not configured. Set SNS_AWS_* or TWILIO_* environment variables.",
    });
  }

  try {
    const timestamp = new Date().toISOString();
    const testMessage = `SniffMaster SMS Test - ${timestamp}. If you received this, SMS is working!`;

    const result = await sendSms(testMessage);

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

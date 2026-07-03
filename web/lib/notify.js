/**
 * notify.js — Amazon SNS SMS helper for SniffMaster alerts.
 *
 * 100 free SMS/month to US numbers (perpetual free tier). No per-message cost
 * after that quota is exceeded — you only pay for what exceeds 100/month at
 * ~$0.00645/SMS. Credentials are set via environment variables.
 *
 * Environment variables (set in Vercel dashboard / .env.local):
 *   AWS_ACCESS_KEY_ID      — AWS IAM access key (starts with "AKIA...")
 *   AWS_SECRET_ACCESS_KEY  — AWS IAM secret access key
 *   AWS_REGION             — AWS region (e.g., "us-east-1")
 *   ALERT_SMS_TO           — recipient number(s), comma-separated (E.164)
 *
 * Design note: sendSms() NEVER throws. Telemetry ingestion and the daily-summary
 * cron must succeed even if AWS is down or misconfigured, so all failures are
 * caught, logged, and surfaced only via the returned {sent, failures} summary.
 */

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

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
    env("AWS_ACCESS_KEY_ID") &&
      env("AWS_SECRET_ACCESS_KEY") &&
      env("AWS_REGION") &&
      getRecipients().length > 0
  );
}

/**
 * Send an SMS to every configured recipient via AWS SNS.
 * @param {string} body — message text
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

  const client = new SNSClient({
    region: env("AWS_REGION"),
    credentials: {
      accessKeyId: env("AWS_ACCESS_KEY_ID"),
      secretAccessKey: env("AWS_SECRET_ACCESS_KEY"),
    },
  });

  let sent = 0;
  const failures = [];
  const recipients = getRecipients();

  // Parallel sends to all recipients
  await Promise.all(
    recipients.map(async (phoneNumber) => {
      try {
        const command = new PublishCommand({
          Message: text,
          PhoneNumber: phoneNumber,
        });
        const response = await client.send(command);
        if (response.MessageId) {
          sent += 1;
          console.log(`notify: SMS sent to ${phoneNumber} (MessageId: ${response.MessageId})`);
        }
      } catch (err) {
        const message = err?.message || String(err);
        failures.push({ to: phoneNumber, error: message });
        console.error(`notify: SNS send to ${phoneNumber} failed — ${message}`);
      }
    })
  );

  return { configured: true, sent, failures };
}

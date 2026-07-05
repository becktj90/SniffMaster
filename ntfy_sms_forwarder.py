#!/usr/bin/env python3
"""
ntfy_sms_forwarder.py — Background service that forwards push notifications from ntfy.sh
to your phone as SMS text messages via Brevo.

This is the SMS half of the SniffMaster alert pipeline. The Vercel web app
publishes every alert and the daily report to an ntfy topic (it does NOT send
its own Brevo SMS — Brevo credentials live here, in this forwarder, so there
is exactly one SMS sender and no duplicate texts). This script:

1. Connects to that ntfy topic via a streaming JSON subscription
2. Forwards each notification to your phone via the Brevo transactional SMS
   API (the real SMS network, not an email-to-SMS carrier gateway)
3. Reconnects automatically on network failure, catching up on anything
   published during the outage without re-texting duplicates

INTEGRATION — the one thing that must be true:
    NTFY_TOPIC here must EXACTLY match the NTFY_TOPIC the web app publishes to
    (its Vercel env var). Same topic string = the dashboard's pushes arrive
    here and become SMS. A mismatch means silence with no error.

Why not an email-to-SMS gateway: live testing showed AT&T's
txt.att.net/mms.att.net gateways silently drop mail with no bounce or error —
the sending SMTP server reports success even though the phone never receives
anything. A real SMS API sends over the actual SMS network and returns a
real HTTP error when a send fails.

Note on Brevo specifically: a 201/`reference` from send_sms_via_brevo() means
Brevo ACCEPTED the message for sending — not that the carrier delivered it.
Unlike Twilio (which offers a simple GET-by-message-id status endpoint),
Brevo's transactional SMS API does not expose a per-message delivery-status
lookup; delivery confirmation is via the `webUrl` webhook callback (needs a
publicly reachable endpoint, out of scope for this simple script) or by
checking Transactional -> SMS -> Logs in the Brevo dashboard. So this script
logs acceptance (and Brevo's credit/segment counts) and stops there — if a
text never arrives, check the Brevo dashboard logs for the real carrier
status rather than assuming this script's "accepted" means "delivered."

Usage:
    python3 ntfy_sms_forwarder.py

To run in background (Unix/Mac):
    nohup python3 ntfy_sms_forwarder.py > ntfy_forwarder.log 2>&1 &

To run in background (Windows):
    pythonw ntfy_sms_forwarder.py
"""

import json
import logging
import os
import time
from collections import deque
from pathlib import Path

import requests
from dotenv import load_dotenv

# ═══════════════════════════════════════════════════════════════════════════
# LOGGING SETUP
# ═══════════════════════════════════════════════════════════════════════════

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("ntfy_forwarder.log"),
    ],
)
logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# ENVIRONMENT CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════

# Load .env file from current directory
env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=env_path)

# ntfy configuration
NTFY_BASE_URL = os.getenv("NTFY_BASE_URL", "https://ntfy.sh").rstrip("/")
NTFY_TOPIC = os.getenv("NTFY_TOPIC", "").strip()

# Brevo configuration (real SMS network, replaces the old email-to-SMS gateway).
# Verified against Brevo's official server SDK (sib-api-v3-sdk 7.6.0): POST
# /transactionalSMS/sms, auth via the `api-key` header, body
# {sender, recipient, content, type}.
BREVO_API_BASE = "https://api.brevo.com/v3"
BREVO_API_KEY = os.getenv("BREVO_API_KEY", "").strip()
# Sender name/number shown to the recipient. Max 15 chars: up to 11 if
# alphanumeric, up to 15 if numeric (a real phone number). Some countries
# require this sender to be pre-approved in the Brevo dashboard
# (Transactional -> SMS -> Senders) before sends will succeed.
BREVO_SMS_SENDER = os.getenv("BREVO_SMS_SENDER", "").strip()


def _to_e164(raw: str) -> str:
    """
    Best-effort normalize a phone number to E.164 (e.g. "+17543379692").
    Tolerates display formats like "(754) 337-9692" or "1-754-337-9692"
    so a copy/paste from a dashboard's "friendly name" field still works.
    """
    raw = (raw or "").strip()
    if not raw:
        return ""
    if raw.startswith("+"):
        return "+" + "".join(ch for ch in raw[1:] if ch.isdigit())
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits:
        return ""
    if len(digits) == 10:
        digits = "1" + digits
    return "+" + digits


# Destination phone number in E.164 format (e.g. +15104324862)
ALERT_SMS_TO = _to_e164(os.getenv("ALERT_SMS_TO", ""))


def _to_brevo_recipient(e164: str) -> str:
    """
    Brevo's `recipient` field is documented as "mobile number with the
    country code" — every real-world example is digits only, no leading
    "+". Convert from our internal E.164 form at the call site only.
    """
    return "".join(ch for ch in (e164 or "") if ch.isdigit())


# Reconnection settings
RECONNECT_DELAY_BASE = 5  # Start with 5 seconds
RECONNECT_DELAY_MAX = 300  # Max 5 minutes
# Streaming timeouts, as a (connect, read) pair. The READ timeout MUST be
# larger than ntfy's keepalive interval (~45s by default) or the stream is
# torn down mid-idle every read-timeout seconds, reconnecting forever and
# risking dropped messages. 75s comfortably clears the keepalive.
CONNECT_TIMEOUT_SEC = 10
READ_TIMEOUT_SEC = 75
# Plain request timeout for the one-shot Brevo send call.
BREVO_TIMEOUT_SEC = 30

# Brevo segments content over 160 chars into multiple concatenated SMS parts
# automatically (same behavior class as other SMS APIs). The morning report
# (personal note + stats + LC-36 weather + launches) runs several hundred
# chars, so a naive 160-char hard cap would silently drop everything past the
# first line. No documented hard ceiling was found; 1600 is a generous safety
# cap carried over from the previous provider to bound worst-case cost.
SMS_MAX_CHARS = 1600

# ═══════════════════════════════════════════════════════════════════════════
# VALIDATION
# ═══════════════════════════════════════════════════════════════════════════


def validate_config():
    """Ensure all required environment variables are set."""
    errors = []

    if not NTFY_TOPIC:
        errors.append("NTFY_TOPIC is not set in .env")
    if not BREVO_API_KEY:
        errors.append("BREVO_API_KEY is not set in .env")
    if not BREVO_SMS_SENDER:
        errors.append("BREVO_SMS_SENDER is not set in .env")
    if not ALERT_SMS_TO:
        errors.append("ALERT_SMS_TO is not set in .env")

    if errors:
        logger.error("Configuration errors:")
        for error in errors:
            logger.error(f"  - {error}")
        raise ValueError("Invalid configuration. Check .env file.")

    logger.info("✓ Configuration validated")
    logger.info(f"  ntfy topic: {NTFY_TOPIC}")
    logger.info(f"  Brevo sender: {BREVO_SMS_SENDER}")
    logger.info(f"  SMS destination: {ALERT_SMS_TO}")


# ═══════════════════════════════════════════════════════════════════════════
# SMS SENDING
# ═══════════════════════════════════════════════════════════════════════════


def send_sms_via_brevo(message_body: str):
    """
    Send an SMS via the Brevo transactional SMS API (real SMS network, not an
    email gateway). Returns the response's `reference` string on acceptance,
    or None on failure.

    A returned reference means Brevo ACCEPTED the message for sending — not
    that the carrier delivered it. Brevo does not expose a per-message
    delivery-status lookup (unlike Twilio's GET-by-SID); check Transactional
    -> SMS -> Logs in the Brevo dashboard to confirm actual carrier delivery.
    """
    body = message_body if len(message_body) <= SMS_MAX_CHARS else message_body[:SMS_MAX_CHARS]
    recipient = _to_brevo_recipient(ALERT_SMS_TO)

    url = f"{BREVO_API_BASE}/transactionalSMS/sms"
    payload = {
        "sender": BREVO_SMS_SENDER,
        "recipient": recipient,
        "content": body,
        "type": "transactional",
    }

    try:
        logger.info(f"Sending SMS to {ALERT_SMS_TO} via Brevo ({len(body)} chars)...")
        response = requests.post(
            url,
            json=payload,
            headers={
                "api-key": BREVO_API_KEY,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            timeout=BREVO_TIMEOUT_SEC,
        )
        if response.ok:
            data = response.json()
            reference = data.get("reference")
            logger.info(
                f"✓ Brevo accepted the message (reference: {reference}, "
                f"smsCount: {data.get('smsCount')}, "
                f"remainingCredits: {data.get('remainingCredits')})"
            )
            return reference or True
        logger.error(f"Brevo API error: HTTP {response.status_code} — {response.text}")
        return None
    except requests.exceptions.RequestException as e:
        logger.error(f"Failed to reach Brevo API: {e}")
        return None
    except Exception as e:
        logger.error(f"Failed to send SMS: {e}")
        return None


# ═══════════════════════════════════════════════════════════════════════════
# ntfy STREAMING
# ═══════════════════════════════════════════════════════════════════════════

# Bounded dedup of already-forwarded ntfy message ids. On reconnect we ask
# ntfy to replay anything published during the outage (via `since`), which can
# re-deliver the boundary message; this stops it becoming a duplicate text.
_seen_ids = deque(maxlen=1000)
_seen_set = set()


def _already_seen(msg_id: str) -> bool:
    if not msg_id:
        return False
    if msg_id in _seen_set:
        return True
    if len(_seen_ids) == _seen_ids.maxlen:
        _seen_set.discard(_seen_ids[0])
    _seen_ids.append(msg_id)
    _seen_set.add(msg_id)
    return False


def listen_to_ntfy_topic():
    """
    Connect to the ntfy topic via a streaming JSON subscription and forward
    each message. Reconnects with exponential backoff, and on reconnect uses
    `since` to catch up on messages published during the gap (deduped by id).
    """
    reconnect_delay = RECONNECT_DELAY_BASE
    # None on first connect → ntfy streams only messages published from now on
    # (we don't want the whole topic history texted at startup). After that,
    # the last-seen message time so a reconnect catches up without a gap.
    last_event_time = None

    while True:
        try:
            ntfy_url = f"{NTFY_BASE_URL}/{NTFY_TOPIC}/json"
            params = {}
            if last_event_time is not None:
                # ntfy accepts a Unix timestamp; replay anything at/after it.
                params["since"] = str(last_event_time)
            logger.info(
                f"Connecting to {ntfy_url}"
                + (f" (catching up since {last_event_time})" if last_event_time else "")
                + "..."
            )

            response = requests.get(
                ntfy_url,
                params=params,
                stream=True,
                timeout=(CONNECT_TIMEOUT_SEC, READ_TIMEOUT_SEC),
                headers={"Accept": "application/x-ndjson"},
            )
            response.raise_for_status()

            logger.info("✓ Connected to ntfy topic")
            reconnect_delay = RECONNECT_DELAY_BASE  # Reset backoff on success

            for line in response.iter_lines(decode_unicode=True):
                if not line or line.startswith(":"):
                    # Skip empty lines and keep-alive comments
                    continue

                try:
                    notification = json.loads(line)
                    event_time = handle_notification(notification)
                    if event_time is not None:
                        # Track the newest message time for reconnect catch-up.
                        if last_event_time is None or event_time > last_event_time:
                            last_event_time = event_time
                except json.JSONDecodeError as e:
                    logger.warning(f"Failed to parse JSON: {e}")
                except Exception as e:
                    logger.error(f"Error processing notification: {e}")

        except requests.exceptions.Timeout:
            logger.warning("Connection timeout")
        except requests.exceptions.ConnectionError as e:
            logger.warning(f"Connection error: {e}")
        except requests.exceptions.RequestException as e:
            logger.error(f"Request failed: {e}")
        except Exception as e:
            logger.error(f"Unexpected error: {e}")

        # Exponential backoff for reconnection
        logger.info(f"Reconnecting in {reconnect_delay} seconds...")
        time.sleep(reconnect_delay)
        reconnect_delay = min(reconnect_delay * 2, RECONNECT_DELAY_MAX)


def build_sms_body(notification: dict) -> str:
    """
    Turn an ntfy notification into the SMS text. Includes the title, the
    message body, and — since the SniffMaster morning report attaches an NWS
    radar tap-through link (ntfy `click`) and forecast icon (ntfy
    `attachment`) — appends the click URL so it still reaches a plain-SMS
    recipient. Text-only: the image itself can't ride an SMS, but the link can.
    """
    title = notification.get("title", "Notification")
    message = notification.get("message", "")
    body = f"{title}: {message}" if message else title

    click = (notification.get("click") or "").strip()
    attachment = notification.get("attachment") or {}
    attachment_url = (attachment.get("url") or "").strip()

    # Prefer the click URL (the radar page); fall back to the attachment URL.
    link = click or attachment_url
    if link and link not in body:
        candidate = f"{body}\n{link}"
        # Only append if it fits the segment budget; never truncate the link.
        if len(candidate) <= SMS_MAX_CHARS:
            body = candidate

    return body[:SMS_MAX_CHARS]


def handle_notification(notification: dict):
    """
    Process an incoming ntfy notification and forward it as SMS.

    Returns the notification's `time` (Unix seconds) when it was a real message
    we acted on (so the caller can track reconnect catch-up position), or None
    for skipped events (open/keepalive/duplicate).

    Expected ntfy JSON message shape:
    {
        "id": "...", "time": 1234567890, "event": "message",
        "title": "SniffMaster", "message": "...",
        "click": "https://radar...", "attachment": {"url": "https://..."}
    }
    """
    try:
        event = notification.get("event", "message")
        if event != "message":
            # open / keepalive / poll_request — not something to text.
            logger.debug(f"Skipping non-message event: {event}")
            return None

        msg_id = notification.get("id", "")
        event_time = notification.get("time")

        if _already_seen(msg_id):
            logger.debug(f"Skipping already-forwarded message id: {msg_id}")
            return event_time

        sms_body = build_sms_body(notification)
        preview = sms_body.replace("\n", " ")
        logger.info(f"Forwarding notification: {preview[:120]}")

        reference = send_sms_via_brevo(sms_body)
        if not reference:
            logger.error("✗ Failed to forward notification (Brevo did not accept it)")

        return event_time

    except Exception as e:
        logger.error(f"Error handling notification: {e}")
        return None


# ═══════════════════════════════════════════════════════════════════════════
# MAIN ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════


def main():
    """Main entry point."""
    logger.info("=" * 70)
    logger.info("ntfy SMS Forwarder starting...")
    logger.info("=" * 70)

    try:
        validate_config()
        listen_to_ntfy_topic()
    except KeyboardInterrupt:
        logger.info("Shutting down gracefully...")
    except Exception as e:
        logger.critical(f"Fatal error: {e}")
        raise


if __name__ == "__main__":
    main()

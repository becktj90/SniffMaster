#!/usr/bin/env python3
"""
ntfy_sms_forwarder.py — Background service that forwards push notifications from ntfy.sh
to your phone as SMS text messages via ClickSend.

This script:
1. Connects to a specified ntfy topic via Server-Sent Events (SSE)
2. Listens for incoming JSON notifications
3. Forwards them to a phone number via the ClickSend API (real SMS
   network, not an email-to-SMS carrier gateway)
4. Automatically reconnects on network failures
5. Loads all configuration from .env (no hardcoded secrets)

Why not an Email-to-SMS gateway: live testing showed AT&T's
txt.att.net/mms.att.net gateways silently drop mail with no bounce or error —
the sending SMTP server reports success even though the phone never receives
anything. Real SMS APIs return a message ID plus a real HTTP error (not
silence) when a send fails, so failures are actually observable. See
README.md for details.

Why ClickSend instead of Twilio: Twilio's US SMS requires A2P 10DLC brand
registration through The Campaign Registry before real messages will
deliver — on a Twilio Trial account this is stuck behind an auto-generated
"Mock Brand" that never actually delivers, and even on a paid account real
registration can take hours to days to approve. ClickSend does not require
this per-sender brand registration step for low-volume personal alerts, so
it can send immediately. Twilio support has been removed entirely.

Usage:
    python3 ntfy_sms_forwarder.py

To run in background (Unix/Mac):
    nohup python3 ntfy_sms_forwarder.py > ntfy_forwarder.log 2>&1 &

To run in background (Windows):
    pythonw ntfy_sms_forwarder.py
"""

import base64
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
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

# ClickSend configuration (sole SMS provider — no A2P 10DLC brand
# registration required for low-volume personal alerts).
CLICKSEND_API_BASE = "https://rest.clicksend.com/v3"
CLICKSEND_USERNAME = os.getenv("CLICKSEND_USERNAME", "").strip()
CLICKSEND_API_KEY = os.getenv("CLICKSEND_API_KEY", "").strip()
# Optional custom sender ID/number. Many countries (incl. US) don't allow a
# custom alphanumeric sender for two-way numbers; leave blank to let
# ClickSend pick a default shared number automatically.
CLICKSEND_FROM = os.getenv("CLICKSEND_FROM", "").strip()


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

# Reconnection settings
RECONNECT_DELAY_BASE = 5  # Start with 5 seconds
RECONNECT_DELAY_MAX = 300  # Max 5 minutes
TIMEOUT_SEC = 30

# ═══════════════════════════════════════════════════════════════════════════
# VALIDATION
# ═══════════════════════════════════════════════════════════════════════════


def validate_config():
    """Ensure all required environment variables are set."""
    errors = []

    if not NTFY_TOPIC:
        errors.append("NTFY_TOPIC is not set in .env")

    if not CLICKSEND_USERNAME:
        errors.append("CLICKSEND_USERNAME is not set in .env")
    if not CLICKSEND_API_KEY:
        errors.append("CLICKSEND_API_KEY is not set in .env")

    if not ALERT_SMS_TO:
        errors.append("ALERT_SMS_TO is not set in .env")

    if errors:
        logger.error("Configuration errors:")
        for error in errors:
            logger.error(f"  - {error}")
        raise ValueError("Invalid configuration. Check .env file.")

    logger.info("✓ Configuration validated")
    logger.info(f"  ntfy topic: {NTFY_TOPIC}")
    logger.info(f"  SMS provider: clicksend")
    logger.info(f"  ClickSend sender: {CLICKSEND_FROM or '(default shared number)'}")
    logger.info(f"  SMS destination: {ALERT_SMS_TO}")


# ═══════════════════════════════════════════════════════════════════════════
# SMS SENDING
# ═══════════════════════════════════════════════════════════════════════════


def send_sms_via_clicksend_raw(message_body: str):
    """
    Send an SMS via the ClickSend REST API and return full details.

    Returns:
        dict with keys:
          - accepted (bool): True if ClickSend queued the message successfully
          - message_id (str | None): ClickSend message ID, if accepted
          - error (str | None): error detail, if not accepted
    """
    body = message_body[:160] if len(message_body) > 160 else message_body

    url = f"{CLICKSEND_API_BASE}/sms/send"

    message = {"to": ALERT_SMS_TO, "body": body}
    if CLICKSEND_FROM:
        message["from"] = CLICKSEND_FROM

    payload = json.dumps({"messages": [message]}).encode("utf-8")

    auth = base64.b64encode(
        f"{CLICKSEND_USERNAME}:{CLICKSEND_API_KEY}".encode("utf-8")
    ).decode("ascii")

    request = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/json",
        },
    )

    try:
        logger.info(f"Sending SMS to {ALERT_SMS_TO} via ClickSend...")
        with urllib.request.urlopen(request, timeout=TIMEOUT_SEC) as response:
            result = json.loads(response.read().decode("utf-8"))
            messages = (result.get("data") or {}).get("messages") or []
            if not messages:
                logger.error(f"ClickSend response missing message data: {result}")
                return {"accepted": False, "message_id": None, "error": f"no message data in response: {result}"}

            first = messages[0]
            status = (first.get("status") or "").upper()
            message_id = first.get("message_id")
            # ClickSend returns status "SUCCESS" when the message is queued.
            if status == "SUCCESS":
                logger.info(f"✓ SMS sent successfully (ClickSend message_id: {message_id})")
                return {"accepted": True, "message_id": message_id, "error": None}
            error_text = first.get("status") or "unknown error"
            logger.error(f"ClickSend rejected message: {first}")
            return {"accepted": False, "message_id": message_id, "error": error_text}

    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        logger.error(f"ClickSend API error: HTTP {e.code} — {detail}")
        return {"accepted": False, "message_id": None, "error": f"HTTP {e.code} — {detail}"}
    except urllib.error.URLError as e:
        logger.error(f"Failed to reach ClickSend API: {e.reason}")
        return {"accepted": False, "message_id": None, "error": f"unreachable: {e.reason}"}
    except Exception as e:
        logger.error(f"Failed to send SMS: {e}")
        return {"accepted": False, "message_id": None, "error": str(e)}


def send_sms_via_clicksend(message_body: str) -> bool:
    """Bool-returning wrapper around send_sms_via_clicksend_raw()."""
    return send_sms_via_clicksend_raw(message_body)["accepted"]


def send_sms(message_body: str) -> bool:
    """Send an SMS via ClickSend."""
    return send_sms_via_clicksend(message_body)


# ═══════════════════════════════════════════════════════════════════════════
# ntfy STREAMING
# ═══════════════════════════════════════════════════════════════════════════


def listen_to_ntfy_topic():
    """
    Connect to ntfy topic via SSE and listen for incoming notifications.
    Automatically reconnects on failure with exponential backoff.
    """
    reconnect_delay = RECONNECT_DELAY_BASE

    while True:
        try:
            ntfy_url = f"{NTFY_BASE_URL}/{NTFY_TOPIC}/json"
            logger.info(f"Connecting to {ntfy_url}...")

            response = requests.get(
                ntfy_url,
                stream=True,
                timeout=TIMEOUT_SEC,
                headers={"Accept": "application/x-ndjson"},
            )
            response.raise_for_status()

            logger.info("✓ Connected to ntfy topic")
            reconnect_delay = RECONNECT_DELAY_BASE  # Reset backoff on success

            # Process incoming lines
            for line in response.iter_lines(decode_unicode=True):
                if not line or line.startswith(":"):
                    # Skip empty lines and keep-alive comments
                    continue

                try:
                    notification = json.loads(line)
                    handle_notification(notification)
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


def handle_notification(notification: dict):
    """
    Process an incoming ntfy notification and forward it as SMS.

    Expected notification structure (from ntfy JSON):
    {
        "id": "...",
        "time": 1234567890,
        "event": "message",
        "title": "Alert Title",
        "message": "Alert message body",
        "tags": ["tag1", "tag2"]
    }
    """
    try:
        # Extract relevant fields
        title = notification.get("title", "Notification")
        message = notification.get("message", "")
        event = notification.get("event", "message")

        if event != "message":
            logger.debug(f"Skipping non-message event: {event}")
            return

        # Construct SMS body (keep it short for SMS character limit)
        sms_body = f"{title}: {message}" if message else title
        sms_body = sms_body[: 160]  # Truncate to SMS limit

        logger.info(f"Forwarding notification: {sms_body}")

        # Send via the configured SMS provider (ClickSend by default)
        if send_sms(sms_body):
            logger.info("✓ Notification forwarded successfully")
        else:
            logger.error("✗ Failed to forward notification")

    except Exception as e:
        logger.error(f"Error handling notification: {e}")


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

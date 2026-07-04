#!/usr/bin/env python3
"""
ntfy_sms_forwarder.py — Background service that forwards push notifications from ntfy.sh
to your phone as SMS text messages via Twilio.

This is the SMS half of the SniffMaster alert pipeline. The Vercel web app
publishes every alert and the daily report to an ntfy topic (it does NOT send
its own Twilio SMS — Twilio credentials live here, in this forwarder, so there
is exactly one SMS sender and no duplicate texts). This script:

1. Connects to that ntfy topic via a streaming JSON subscription
2. Forwards each notification to your phone via the Twilio SMS API (the real
   SMS network, not an email-to-SMS carrier gateway)
3. Verifies delivery with Twilio (a message SID is NOT proof of delivery — see
   below) and logs the real carrier status, including the A2P-registration
   block (error 30034)
4. Reconnects automatically on network failure, catching up on anything
   published during the outage without re-texting duplicates

INTEGRATION — the one thing that must be true:
    NTFY_TOPIC here must EXACTLY match the NTFY_TOPIC the web app publishes to
    (its Vercel env var). Same topic string = the dashboard's pushes arrive
    here and become SMS. A mismatch means silence with no error.

Why Twilio instead of an email-to-SMS gateway: live testing showed AT&T's
txt.att.net/mms.att.net gateways silently drop mail with no bounce or error —
the sending SMTP server reports success even though the phone never receives
anything. Twilio sends over the real SMS network and returns a message SID
plus a real HTTP error when a send fails. But note: a Twilio SID still is not
proof of delivery for US numbers — the carrier can mark it `undelivered` with
error 30034 if the sending number hasn't completed A2P 10DLC registration.
This script polls the message status so that block is visible in the log
instead of looking like success. See README.md for details.

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

# Twilio configuration (real SMS network, replaces the old email-to-SMS gateway)
TWILIO_API_BASE = "https://api.twilio.com/2010-04-01"
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
# NOTE: TWILIO_AUTH_TOKEN_V2 is preferred over TWILIO_AUTH_TOKEN. On this
# environment, the TWILIO_AUTH_TOKEN secret repeatedly got silently truncated
# to 25 of its 32 characters no matter how it was re-entered, which produced
# HTTP 401s from Twilio despite the token being correct at the source. Storing
# the same value under a different key name (TWILIO_AUTH_TOKEN_V2) was not
# affected by the truncation, so that's the reliable source of truth here —
# TWILIO_AUTH_TOKEN is kept only as a fallback for a normal, unaffected setup.
TWILIO_AUTH_TOKEN = (os.getenv("TWILIO_AUTH_TOKEN_V2") or os.getenv("TWILIO_AUTH_TOKEN", "")).strip()
# Either a Messaging Service SID (preferred — picks the right sender from a
# registered pool) or a bare From number (E.164) works. Messaging Service
# takes priority if both are set.
TWILIO_MESSAGING_SERVICE_SID = os.getenv("TWILIO_MESSAGING_SERVICE_SID", "").strip()


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


TWILIO_FROM = _to_e164(os.getenv("TWILIO_FROM", ""))

# Destination phone number in E.164 format (e.g. +15104324862)
ALERT_SMS_TO = _to_e164(os.getenv("ALERT_SMS_TO", ""))

# Reconnection settings
RECONNECT_DELAY_BASE = 5  # Start with 5 seconds
RECONNECT_DELAY_MAX = 300  # Max 5 minutes
# Streaming timeouts, as a (connect, read) pair. The READ timeout MUST be
# larger than ntfy's keepalive interval (~45s by default) or the stream is
# torn down mid-idle every read-timeout seconds, reconnecting forever and
# risking dropped messages. 75s comfortably clears the keepalive.
CONNECT_TIMEOUT_SEC = 10
READ_TIMEOUT_SEC = 75
# Plain request timeout for one-shot Twilio calls (send + status poll).
TWILIO_TIMEOUT_SEC = 30

# Twilio accepts up to 1600 chars in one API call and segments it into
# concatenated SMS parts automatically. The morning report (personal note +
# stats + LC-36 weather + launches) runs several hundred chars, so the old
# 160-char hard cap silently dropped everything past the first line.
SMS_MAX_CHARS = 1600

# Delivery-status verification: how many times to re-check the message after
# sending, and how long to wait between checks. A SID comes back immediately
# but the carrier status (delivered / undelivered+30034) lands a few seconds
# later, so poll briefly. Kept short so it never stalls the listener for long.
STATUS_POLL_ATTEMPTS = 4
STATUS_POLL_DELAY_SEC = 2

# ═══════════════════════════════════════════════════════════════════════════
# VALIDATION
# ═══════════════════════════════════════════════════════════════════════════


def validate_config():
    """Ensure all required environment variables are set."""
    errors = []

    if not NTFY_TOPIC:
        errors.append("NTFY_TOPIC is not set in .env")
    if not TWILIO_ACCOUNT_SID:
        errors.append("TWILIO_ACCOUNT_SID is not set in .env")
    if not TWILIO_AUTH_TOKEN:
        errors.append("TWILIO_AUTH_TOKEN is not set in .env")
    if not TWILIO_MESSAGING_SERVICE_SID and not TWILIO_FROM:
        errors.append(
            "Either TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM must be set in .env"
        )
    if not ALERT_SMS_TO:
        errors.append("ALERT_SMS_TO is not set in .env")

    if errors:
        logger.error("Configuration errors:")
        for error in errors:
            logger.error(f"  - {error}")
        raise ValueError("Invalid configuration. Check .env file.")

    logger.info("✓ Configuration validated")
    logger.info(f"  ntfy topic: {NTFY_TOPIC}")
    logger.info(
        f"  Twilio sender: {TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM}"
    )
    logger.info(f"  SMS destination: {ALERT_SMS_TO}")


# ═══════════════════════════════════════════════════════════════════════════
# SMS SENDING
# ═══════════════════════════════════════════════════════════════════════════


def _twilio_auth_header() -> str:
    token = base64.b64encode(
        f"{TWILIO_ACCOUNT_SID}:{TWILIO_AUTH_TOKEN}".encode("utf-8")
    ).decode("ascii")
    return f"Basic {token}"


def send_sms_via_twilio(message_body: str):
    """
    Send an SMS via the Twilio REST API (real SMS network, not an email
    gateway). Returns the Twilio message SID on acceptance, or None on failure.

    A returned SID means Twilio ACCEPTED the message for sending — not that the
    carrier delivered it. Delivery is confirmed separately by
    poll_delivery_status().
    """
    # Twilio segments long bodies into concatenated SMS automatically; only
    # guard against an absurdly long body (10 segments) to bound cost.
    body = message_body if len(message_body) <= SMS_MAX_CHARS else message_body[:SMS_MAX_CHARS]

    url = f"{TWILIO_API_BASE}/Accounts/{urllib.parse.quote(TWILIO_ACCOUNT_SID)}/Messages.json"

    form = {"To": ALERT_SMS_TO, "Body": body}
    if TWILIO_MESSAGING_SERVICE_SID:
        form["MessagingServiceSid"] = TWILIO_MESSAGING_SERVICE_SID
    else:
        form["From"] = TWILIO_FROM

    data = urllib.parse.urlencode(form).encode("utf-8")

    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": _twilio_auth_header(),
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )

    try:
        logger.info(f"Sending SMS to {ALERT_SMS_TO} via Twilio ({len(body)} chars)...")
        with urllib.request.urlopen(request, timeout=TWILIO_TIMEOUT_SEC) as response:
            payload = json.loads(response.read().decode("utf-8"))
            sid = payload.get("sid")
            if sid:
                logger.info(f"✓ Twilio accepted the message (SID: {sid}, status: {payload.get('status')})")
                return sid
            logger.error(f"Twilio response missing SID: {payload}")
            return None

    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        logger.error(f"Twilio API error: HTTP {e.code} — {detail}")
        return None
    except urllib.error.URLError as e:
        logger.error(f"Failed to reach Twilio API: {e.reason}")
        return None
    except Exception as e:
        logger.error(f"Failed to send SMS: {e}")
        return None


def poll_delivery_status(sid: str) -> str:
    """
    Poll Twilio for the real carrier delivery status of a sent message.

    A SID from send_sms_via_twilio() only means "accepted"; the carrier verdict
    (delivered / undelivered / failed) and any error_code arrive a few seconds
    later. This surfaces the common US block — error 30034, sending number not
    A2P-10DLC-registered — which otherwise looks exactly like success.

    Returns the last observed status string (best-effort; never raises).
    """
    if not sid:
        return "unknown"
    url = (
        f"{TWILIO_API_BASE}/Accounts/{urllib.parse.quote(TWILIO_ACCOUNT_SID)}"
        f"/Messages/{urllib.parse.quote(sid)}.json"
    )
    request = urllib.request.Request(
        url, method="GET", headers={"Authorization": _twilio_auth_header()}
    )

    last_status = "unknown"
    for attempt in range(STATUS_POLL_ATTEMPTS):
        time.sleep(STATUS_POLL_DELAY_SEC)
        try:
            with urllib.request.urlopen(request, timeout=TWILIO_TIMEOUT_SEC) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - status check must never crash the loop
            logger.warning(f"Could not check delivery status for {sid}: {e}")
            return last_status

        last_status = payload.get("status", "unknown")
        error_code = payload.get("error_code")

        if last_status == "delivered":
            logger.info(f"✓ Carrier confirmed delivery (SID: {sid})")
            return last_status
        if last_status in ("undelivered", "failed"):
            if str(error_code) == "30034":
                logger.error(
                    f"✗ Carrier BLOCKED the SMS (SID: {sid}, error 30034): the "
                    f"sending number is not A2P 10DLC registered. This is a "
                    f"one-time Twilio Console step (Messaging → Regulatory "
                    f"Compliance → A2P 10DLC), not a code fix."
                )
            else:
                logger.error(
                    f"✗ Carrier did not deliver the SMS (SID: {sid}, status: "
                    f"{last_status}, error_code: {error_code})"
                )
            return last_status

    # Still queued/sending/sent after the poll window — accepted, delivery pending.
    logger.info(
        f"… Delivery still pending for {sid} (status: {last_status}). Twilio "
        f"accepted it; the carrier receipt may land shortly."
    )
    return last_status


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

        sid = send_sms_via_twilio(sms_body)
        if sid:
            # Confirm the carrier actually took it (surfaces the 30034 A2P block).
            poll_delivery_status(sid)
        else:
            logger.error("✗ Failed to forward notification (Twilio did not accept it)")

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

#!/usr/bin/env python3
"""
ntfy_sms_forwarder.py — Background service that forwards push notifications from ntfy.sh
to your phone as SMS text messages via Email-to-SMS gateway.

This script:
1. Connects to a specified ntfy topic via Server-Sent Events (SSE)
2. Listens for incoming JSON notifications
3. Forwards them to an Email-to-SMS gateway (e.g., vtext.com, txt.att.net)
4. Automatically reconnects on network failures
5. Loads all configuration from .env (no hardcoded secrets)

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
import smtplib
import time
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
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

# Email-to-SMS gateway configuration
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "").strip()
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "").strip()
SENDER_EMAIL = os.getenv("SENDER_EMAIL", "").strip()

# SMS gateway address (e.g., "15105551234@vtext.com")
SMS_GATEWAY_ADDRESS = os.getenv("SMS_GATEWAY_ADDRESS", "").strip()

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
    if not SMTP_USERNAME:
        errors.append("SMTP_USERNAME is not set in .env")
    if not SMTP_PASSWORD:
        errors.append("SMTP_PASSWORD is not set in .env")
    if not SENDER_EMAIL:
        errors.append("SENDER_EMAIL is not set in .env")
    if not SMS_GATEWAY_ADDRESS:
        errors.append("SMS_GATEWAY_ADDRESS is not set in .env")

    if errors:
        logger.error("Configuration errors:")
        for error in errors:
            logger.error(f"  - {error}")
        raise ValueError("Invalid configuration. Check .env file.")

    logger.info("✓ Configuration validated")
    logger.info(f"  ntfy topic: {NTFY_TOPIC}")
    logger.info(f"  SMTP server: {SMTP_SERVER}:{SMTP_PORT}")
    logger.info(f"  SMS gateway: {SMS_GATEWAY_ADDRESS}")


# ═══════════════════════════════════════════════════════════════════════════
# SMS SENDING
# ═══════════════════════════════════════════════════════════════════════════


def send_sms_via_email(message_body: str, subject: str = "SniffMaster Notification") -> bool:
    """
    Send an SMS via Email-to-SMS gateway using SMTP.

    Args:
        message_body: Text content to send
        subject: Email subject (many gateways ignore this for SMS, but good to have)

    Returns:
        True if sent successfully, False otherwise
    """
    try:
        # Create email message
        msg = MIMEMultipart()
        msg["From"] = SENDER_EMAIL
        msg["To"] = SMS_GATEWAY_ADDRESS
        msg["Subject"] = subject

        # Keep message body short (SMS character limit)
        body = message_body[: 160] if len(message_body) > 160 else message_body
        msg.attach(MIMEText(body, "plain"))

        # Send via SMTP
        logger.info(f"Sending SMS to {SMS_GATEWAY_ADDRESS}...")
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=TIMEOUT_SEC) as server:
            server.starttls()
            server.login(SMTP_USERNAME, SMTP_PASSWORD)
            server.send_message(msg)

        logger.info("✓ SMS sent successfully")
        return True

    except smtplib.SMTPException as e:
        logger.error(f"SMTP error: {e}")
        return False
    except Exception as e:
        logger.error(f"Failed to send SMS: {e}")
        return False


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

        # Send via SMS gateway
        if send_sms_via_email(sms_body, subject=title):
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

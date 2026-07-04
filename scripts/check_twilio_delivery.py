#!/usr/bin/env python3
"""
check_twilio_delivery.py — Automatically re-checks Twilio SMS delivery
status until A2P 10DLC registration is confirmed working.

Background: A2P 10DLC brand/campaign registration approval timing varies
(near-instant to a couple of days), and it's easy to forget to manually
follow up with curl once it's done. This script periodically sends the same
test message documented in README.md ("Quick way to verify delivery"),
polls Twilio for that message's carrier delivery status, and keeps retrying
on an interval until a send comes back `delivered` — then it reports clear
success and exits. It never silently gives up: every attempt is logged with
enough detail (status, Twilio error code/message) to see what's going on.

Cost safety: A2P 10DLC approval can reportedly take "up to a couple of
days," and each retry attempt is a real, billed Twilio send. To avoid an
unattended run silently racking up sends for days, this script by default
(a) caps the total number of attempts, and (b) doubles the wait interval
after each failed attempt (up to a max interval) instead of hammering on a
fixed cadence. Together the defaults span roughly the "couple of days"
window while sending far fewer than one message per interval-tick. Override
any of this via the flags below if you want to check more aggressively (or
pass --max-attempts 0 for unlimited retries).

Usage:
    # Keep re-checking with growing backoff (default) until delivered or
    # the default attempt cap is reached:
    python3 scripts/check_twilio_delivery.py

    # Custom starting interval between attempts, in seconds:
    python3 scripts/check_twilio_delivery.py --interval 900

    # Give up after N attempts (0 = unlimited) instead of the default cap:
    python3 scripts/check_twilio_delivery.py --max-attempts 20

    # Disable backoff and retry on a fixed interval:
    python3 scripts/check_twilio_delivery.py --backoff-multiplier 1

    # Single check-and-exit, no retry loop (useful for cron):
    python3 scripts/check_twilio_delivery.py --once

Exit codes:
    0 — delivery confirmed (`delivered` status observed)
    1 — gave up after --max-attempts without confirming delivery
    2 — configuration error (see ntfy_sms_forwarder.validate_config)

Run it unattended the same way as the forwarder itself, e.g.:
    nohup python3 scripts/check_twilio_delivery.py > twilio_delivery_check.log 2>&1 &
"""

import argparse
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ntfy_sms_forwarder as forwarder

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(
            str(Path(__file__).resolve().parent.parent / "twilio_delivery_check.log")
        ),
    ],
)
logger = logging.getLogger(__name__)

TEST_MESSAGE = "Test: A2P 10DLC registration verification"

# Terminal states per Twilio's message status lifecycle. Anything not in
# this set (queued, sending, sent, accepted) means we should keep polling
# a little longer before concluding the attempt was inconclusive.
TERMINAL_STATUSES = {"delivered", "undelivered", "failed"}

DEFAULT_INTERVAL_SEC = 30 * 60  # starting re-attempt interval, 30 minutes
DEFAULT_MAX_INTERVAL_SEC = 4 * 60 * 60  # backoff never waits longer than 4h between attempts
DEFAULT_BACKOFF_MULTIPLIER = 2.0  # interval doubles after each failed attempt, up to the max above
DEFAULT_MAX_ATTEMPTS = 16  # ~ enough attempts, at the backoff schedule above, to cover a couple of days
POLL_INTERVAL_SEC = 5
POLL_TIMEOUT_SEC = 60


def poll_until_terminal(sid: str, poll_interval: int = POLL_INTERVAL_SEC, poll_timeout: int = POLL_TIMEOUT_SEC):
    """Poll a message's status until it reaches a terminal state or times out."""
    deadline = time.monotonic() + poll_timeout
    last = None
    while True:
        last = forwarder.get_message_status(sid)
        status = last.get("status")
        if status in TERMINAL_STATUSES:
            return last
        if time.monotonic() >= deadline:
            logger.warning(
                f"Gave up waiting for a terminal status after {poll_timeout}s "
                f"(last status: {status!r})"
            )
            return last
        logger.info(f"  status={status!r}, still waiting...")
        time.sleep(poll_interval)


def attempt_once() -> bool:
    """Send the test SMS and poll for delivery. Returns True iff delivered."""
    logger.info(f"Sending test SMS to {forwarder.ALERT_SMS_TO}...")
    result = forwarder.send_sms_via_twilio_raw(TEST_MESSAGE)

    if not result["accepted"]:
        logger.error(f"✗ Twilio rejected the send: {result['error']}")
        return False

    sid = result["sid"]
    logger.info(f"✓ Twilio accepted the message (SID: {sid}); polling for delivery status...")

    status_result = poll_until_terminal(sid)
    status = status_result.get("status")
    error_code = status_result.get("error_code")
    error_message = status_result.get("error_message")

    if status == "delivered":
        logger.info(f"✓✓✓ CONFIRMED DELIVERED — SID {sid} was delivered to {forwarder.ALERT_SMS_TO}.")
        logger.info("A2P 10DLC registration is working. No further action needed.")
        return True

    if status in ("undelivered", "failed"):
        logger.error(
            f"✗ Message {sid} ended in status={status!r} "
            f"(error_code={error_code}, error_message={error_message!r}). "
            "Registration likely still pending — will keep re-checking."
        )
        return False

    logger.warning(
        f"? Message {sid} did not reach a terminal status in time "
        f"(last observed status={status!r}). Treating this attempt as inconclusive."
    )
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--interval",
        type=int,
        default=DEFAULT_INTERVAL_SEC,
        help=f"Starting seconds to wait between re-attempts (default: {DEFAULT_INTERVAL_SEC})",
    )
    parser.add_argument(
        "--max-interval",
        type=int,
        default=DEFAULT_MAX_INTERVAL_SEC,
        help=f"Cap on the backed-off interval, in seconds (default: {DEFAULT_MAX_INTERVAL_SEC})",
    )
    parser.add_argument(
        "--backoff-multiplier",
        type=float,
        default=DEFAULT_BACKOFF_MULTIPLIER,
        help=f"Multiply the interval by this after each failed attempt, up to --max-interval "
             f"(default: {DEFAULT_BACKOFF_MULTIPLIER}; use 1 to disable backoff)",
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=DEFAULT_MAX_ATTEMPTS,
        help="Give up after this many attempts instead of retrying forever. "
             f"Each attempt is a real, billed Twilio send, so this defaults to a cost ceiling "
             f"(default: {DEFAULT_MAX_ATTEMPTS}; pass 0 for unlimited retries)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single attempt and exit (equivalent to --max-attempts 1)",
    )
    args = parser.parse_args()

    if args.once:
        max_attempts = 1
    elif args.max_attempts == 0:
        max_attempts = None  # explicit opt-in to unlimited retries
    else:
        max_attempts = args.max_attempts

    logger.info("=" * 70)
    logger.info("Twilio delivery status auto-checker starting...")
    if max_attempts is None:
        logger.info("Retry cap: unlimited (--max-attempts 0) — will retry forever until delivered.")
    else:
        logger.info(
            f"Retry cap: {max_attempts} attempt(s), backing off from {args.interval}s "
            f"up to {args.max_interval}s between attempts (x{args.backoff_multiplier} each time) "
            "to limit billed Twilio sends while carrier approval is pending."
        )
    logger.info("=" * 70)

    try:
        forwarder.validate_config()
    except ValueError as e:
        logger.critical(f"Configuration error, cannot proceed: {e}")
        sys.exit(2)

    attempt = 0
    interval = args.interval
    while True:
        attempt += 1
        logger.info(f"--- Attempt {attempt}"
                    + (f"/{max_attempts}" if max_attempts else "") + " ---")

        if attempt_once():
            sys.exit(0)

        if max_attempts is not None and attempt >= max_attempts:
            logger.error(
                f"✗ Gave up after {attempt} attempt(s) without confirming delivery. "
                "Check A2P 10DLC registration status in the Twilio Console. "
                "(Re-run with --max-attempts 0 to retry indefinitely.)"
            )
            sys.exit(1)

        logger.info(f"Will re-check again in {interval}s...")
        time.sleep(interval)
        interval = min(int(interval * args.backoff_multiplier), args.max_interval)


if __name__ == "__main__":
    main()

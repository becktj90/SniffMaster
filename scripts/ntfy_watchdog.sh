#!/bin/bash
# Cron-friendly watchdog for ntfy_sms_forwarder.py.
#
# Use this on systems without systemd (or if you'd rather not set up a
# service unit). It checks whether the forwarder process is running and
# (re)starts it if not, so it survives both crashes and reboots when paired
# with the @reboot cron entry documented in README.md.
#
# Setup:
#   crontab -e
#   # start on boot:
#   @reboot /full/path/to/sniffmaster-pro/scripts/ntfy_watchdog.sh
#   # and check every 5 minutes in case it crashed:
#   */5 * * * * /full/path/to/sniffmaster-pro/scripts/ntfy_watchdog.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_DIR/ntfy_sms_forwarder.py"
LOG="$REPO_DIR/ntfy_forwarder.log"
PIDFILE="$REPO_DIR/.ntfy_forwarder.pid"

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

if is_running; then
  exit 0
fi

cd "$REPO_DIR"
nohup python3 "$SCRIPT" >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"

#!/bin/bash
# Restart the macOS menu bar agent and report what it did.
set -uo pipefail

LABEL="dev.austin.moonshine-tray"
UID_NUM="$(id -u)"

: > /tmp/moonshine-tray.log
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
sleep 12

echo "=== process ==="
pgrep -fl "tray_macos.py" || echo "NOT RUNNING"

echo
echo "=== log ==="
cat /tmp/moonshine-tray.log 2>/dev/null || echo "(empty)"

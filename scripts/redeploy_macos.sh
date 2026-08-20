#!/bin/bash
# Rebuild the macOS app bundle and restart the menu bar agent.
set -uo pipefail

SHARE="$HOME/.local/share/moonshine"
LABEL="dev.austin.moonshine-tray"
UID_NUM="$(id -u)"

echo "=== ~/Applications writability ==="
ls -lad "$HOME/Applications" 2>&1 || echo "(does not exist)"

echo
echo "=== stopping existing agent ==="
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
pkill -f tray_macos.py 2>/dev/null || true
sleep 2
: > /tmp/moonshine-tray.log

echo
echo "=== building bundle ==="
"$SHARE/../../../tmp/build_macos_app.sh" 2>/dev/null || /tmp/build_macos_app.sh

echo
echo "=== installing autostart ==="
"$SHARE/venv/bin/python" "$SHARE/tray_macos.py" --install-autostart

sleep 8

echo
echo "=== is it running from the bundle? ==="
ps ax -o command | grep "[R]emote.app" || echo "NOT RUNNING VIA BUNDLE"

echo
echo "=== launchctl ==="
launchctl list | grep -F "$LABEL" || echo "(not listed)"

echo
echo "=== log ==="
cat /tmp/moonshine-tray.log 2>/dev/null || echo "(empty)"

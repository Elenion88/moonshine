#!/bin/bash
# Isolate why the menu bar item isn't visible: quit Ice (which auto-rehides
# items every 15s) and restart the agent, so nothing else can hide it.
set -uo pipefail

SHARE="$HOME/.local/share/moonshine"
LABEL="dev.austin.moonshine-tray"
UID_NUM="$(id -u)"

echo "=== what does the LaunchAgent actually run? ==="
/usr/libexec/PlistBuddy -c "Print :ProgramArguments" \
  "$HOME/Library/LaunchAgents/${LABEL}.plist" 2>/dev/null || echo "(cannot read)"

echo
echo "=== bundle present? ==="
ls -la "$SHARE/Moonshine.app/Contents/MacOS/Moonshine" 2>/dev/null || echo "(no bundle exec)"

echo
echo "=== quitting Ice so it cannot hide anything ==="
osascript -e 'tell application "Ice" to quit' 2>/dev/null || pkill -f "/Applications/Ice.app" 2>/dev/null || true
sleep 2
ps ax -o command | grep "[/]Applications/Ice.app" >/dev/null && echo "Ice STILL running" || echo "Ice stopped"

echo
echo "=== restarting the agent ==="
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
sleep 12

echo
echo "=== process ==="
pgrep -fl "tray_macos.py" || echo "NOT RUNNING"

echo
echo "=== log ==="
cat /tmp/moonshine-tray.log 2>/dev/null || echo "(empty)"

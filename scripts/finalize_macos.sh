#!/bin/bash
# Put Moonshine.app where Spotlight will index it, and make sure both the window
# app and the menu bar agent are in place.
set -uo pipefail

SHARE="$HOME/.local/share/moonshine"
LABEL="dev.austin.moonshine-tray"
UID_NUM="$(id -u)"

echo "=== moving Moonshine.app to /Applications ==="
if [ -w /Applications ]; then
  rm -rf /Applications/Moonshine.app
  cp -R "$SHARE/Moonshine.app" /Applications/Moonshine.app
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f /Applications/Moonshine.app 2>/dev/null || true
  echo "installed: /Applications/Moonshine.app"
else
  echo "/Applications not writable, leaving it at $SHARE/Moonshine.app"
fi

echo
echo "=== restarting the menu bar agent ==="
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/${UID_NUM}" "$HOME/Library/LaunchAgents/${LABEL}.plist" 2>&1 || true
sleep 6

echo
echo "=== state ==="
pgrep -fl window.py >/dev/null && echo "window app     : running" || echo "window app     : not running"
pgrep -fl tray_macos.py >/dev/null && echo "menu bar agent : running" || echo "menu bar agent : NOT running"
launchctl list | grep -F "$LABEL" || echo "(agent not listed)"

echo
echo "=== what the agent runs ==="
/usr/libexec/PlistBuddy -c "Print :ProgramArguments" \
  "$HOME/Library/LaunchAgents/${LABEL}.plist" 2>/dev/null || echo "(cannot read)"

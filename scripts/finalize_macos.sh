#!/bin/bash
# Put Moonshine.app where Spotlight will index it, and confirm the window app is
# in place.
set -uo pipefail

SHARE="$HOME/.local/share/moonshine"

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
echo "=== state ==="
pgrep -fl window.py >/dev/null && echo "window app : running" || echo "window app : not running"
ls -d "$SHARE/Moonshine.app" /Applications/Moonshine.app 2>/dev/null

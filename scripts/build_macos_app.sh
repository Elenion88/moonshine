#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

# Build Moonshine.app - a real macOS bundle for the window app.
#
# A bundle is what makes this a real application rather than a script: it gets a
# Dock icon, a Spotlight entry, and a stable identity for TCC to hang
# permissions on, instead of attributing them to whatever python binary happened
# to run.
set -euo pipefail

SHARE="$HOME/.local/share/moonshine"
LABEL="dev.austin.moonshine"

# Prefer ~/Applications so the app shows up where apps are expected, but fall
# back to our own directory if it is not writable. On this managed Mac an SSH
# session without Full Disk Access is refused ~/Applications outright.
if mkdir -p "$HOME/Applications" 2>/dev/null && [ -w "$HOME/Applications" ]; then
  APP="$HOME/Applications/Moonshine.app"
else
  APP="$SHARE/Moonshine.app"
  echo "note: ~/Applications not writable, building into $SHARE instead" >&2
fi

if [ ! -x "$SHARE/venv/bin/python" ]; then
  echo "error: $SHARE/venv/bin/python not found - deploy the app files first" >&2
  exit 1
fi

echo "Building $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Icon. Best effort: without Pillow, or without scripts/ deployed, the bundle
# still builds - it just inherits the generic Python rocket, as it always did.
ICON_KEY=""
if [ -f "$SHARE/scripts/make_icons.py" ]; then
  "$SHARE/venv/bin/python" "$SHARE/scripts/make_icons.py" || true
fi
if [ -f "$SHARE/assets/moonshine.icns" ]; then
  cp "$SHARE/assets/moonshine.icns" "$APP/Contents/Resources/Moonshine.icns"
  ICON_KEY=$'    <key>CFBundleIconFile</key>\n    <string>Moonshine</string>'
else
  echo "note: no assets/moonshine.icns - build one with" \
       "'$SHARE/venv/bin/pip install pillow && $SHARE/venv/bin/python $SHARE/scripts/make_icons.py'" >&2
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Moonshine</string>
    <key>CFBundleDisplayName</key>
    <string>Moonshine</string>
    <key>CFBundleIdentifier</key>
    <string>${LABEL}</string>
    <key>CFBundleExecutable</key>
    <string>Moonshine</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
${ICON_KEY}
    <key>NSHighResolutionCapable</key>
    <true/>
    <!-- Deliberately NOT LSUIElement. This bundle opens the window, so it should
         own a Dock icon and be findable in Spotlight. -->
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/Moonshine" <<LAUNCHER
#!/bin/bash
# Homebrew and Tailscale live outside the minimal PATH that launchd and Finder
# hand to a bundle, so put them back before the app looks for its tools.
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec "$SHARE/venv/bin/python" "$SHARE/window.py" "\$@"
LAUNCHER

chmod +x "$APP/Contents/MacOS/Moonshine"

# Let Launch Services notice the new bundle so Spotlight can find it.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" 2>/dev/null || true

echo "Built: $APP"

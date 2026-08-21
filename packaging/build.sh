#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

# Build the macOS release. Run this on the Mac - PyInstaller cannot cross-compile.
#
#   bash packaging/build.sh              # Moonshine.app
#   bash packaging/build.sh --sign       # also codesign and staple, needs certs
#
# Output:
#   dist/Moonshine.app
#   dist/Moonshine-<version>.dmg
#
# Signing is opt-in because it needs a paid Developer ID and credentials this
# script will not invent. Unsigned, Gatekeeper blocks the app on every Mac but
# the one that built it - see packaging/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SIGN=0
[ "${1:-}" = "--sign" ] && SIGN=1

VERSION="$(python3 -c 'import brand; print(brand.VERSION)')"
APP="dist/Moonshine.app"
DMG="dist/Moonshine-${VERSION}.dmg"
echo "Building Moonshine ${VERSION}"

# The .icns needs iconutil, which is why this half of the build only runs here.
python3 scripts/make_icons.py --png

rm -rf build dist
python3 -m PyInstaller packaging/macos.spec --noconfirm --distpath dist --workpath build

[ -d "$APP" ] || { echo "error: $APP was not produced" >&2; exit 1; }
[ -x "$APP/Contents/MacOS/moonshine" ] || {
  echo "error: the CLI is missing from the bundle - check the case-collision" \
       "note in packaging/macos.spec" >&2; exit 1; }

# The bundled CLI has to run before anything is shipped: a bundle that opens
# but whose CLI cannot start is a product that lists hosts and streams nothing.
"$APP/Contents/MacOS/moonshine" --help >/dev/null || {
  echo "error: the bundled CLI failed to run" >&2; exit 1; }
echo "  bundle built, CLI answers --help"

if [ "$SIGN" = "1" ]; then
  : "${DEVELOPER_ID:?set DEVELOPER_ID to your 'Developer ID Application: ...' identity}"
  : "${NOTARY_PROFILE:?set NOTARY_PROFILE to a notarytool keychain profile}"

  # --deep is deprecated and does not sign nested code correctly; signing every
  # Mach-O inside out is what actually passes notarisation.
  find "$APP/Contents" -type f \( -name "*.dylib" -o -name "*.so" \) -print0 |
    xargs -0 -I{} codesign --force --timestamp --options runtime \
      --sign "$DEVELOPER_ID" {}
  codesign --force --timestamp --options runtime \
    --sign "$DEVELOPER_ID" "$APP/Contents/MacOS/moonshine"
  codesign --force --timestamp --options runtime \
    --sign "$DEVELOPER_ID" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  echo "  signed"
fi

# Python, Tcl/Tk and Pillow are all inside the bundle, so their licence texts
# have to ship with it. pystray is excluded from the macOS build, so the LGPL
# question in THIRD-PARTY-NOTICES.md does not arise here.
python3 packaging/collect_licences.py "$APP/Contents/Resources"

rm -f "$DMG"
hdiutil create -volname "Moonshine" -srcfolder "$APP" -ov -format UDZO "$DMG" >/dev/null
echo "  wrote $DMG"

if [ "$SIGN" = "1" ]; then
  codesign --force --timestamp --sign "$DEVELOPER_ID" "$DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  echo "  notarised and stapled"
else
  echo "NOT SIGNED: Gatekeeper will block this on any Mac but this one."
  echo "See packaging/README.md."
fi

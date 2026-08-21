#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

# Build the macOS release. Run this on the Mac - neither toolchain cross-compiles.
#
#   bash packaging/build.sh              # Moonshine.app and a .dmg
#   bash packaging/build.sh --cli        # also the Python CLI
#
# Signing is not done here. electron-builder will sign and notarise when the
# right credentials are in the environment; without them it produces an
# unsigned build that Gatekeeper will refuse on any Mac but this one. See
# packaging/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CLI=0
[ "${1:-}" = "--cli" ] && CLI=1

VERSION="$(python3 -c 'import brand; print(brand.VERSION)')"
echo "Building Moonshine ${VERSION}"

# The .icns needs iconutil, which is why this half of the build only runs here.
python3 scripts/make_icons.py --png
python3 app/resources/generate-assets.py
[ -f assets/moonshine.icns ] && cp assets/moonshine.icns app/resources/icon.icns

cd app
[ -d node_modules ] || npm install
npm run build
npx electron-builder --mac
cd "$ROOT"

ls app/dist/*.dmg >/dev/null 2>&1 || { echo "error: no dmg produced" >&2; exit 1; }
echo "  built $(ls app/dist/*.dmg)"

if [ "$CLI" = "1" ]; then
  python3 -m PyInstaller packaging/macos.spec --noconfirm --distpath dist --workpath build
  ./dist/moonshine/moonshine --help >/dev/null || {
    echo "error: the built CLI failed to run" >&2; exit 1; }
  echo "  built dist/moonshine/moonshine"
fi

echo "NOT SIGNED unless credentials were present. See packaging/README.md."

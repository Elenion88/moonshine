# -*- mode: python ; coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""PyInstaller spec for the macOS build. Run this on the Mac.

One `.app` holding two binaries. The bundle is what gives the window app a Dock
icon, a Spotlight entry and - the part that actually matters here - a stable
identity for TCC to hang Screen Recording and Accessibility on, instead of
attributing them to whichever Python happened to run it.

The CLI rides inside the same bundle rather than being built separately,
because a second build would mean a second 40 MB copy of the interpreter for
the same code. `moonshine setup` symlinks it onto PATH.

There is no tray target. macOS silently refuses to draw new status items on a
notched display - the API reports success and nothing appears - so the tray is
a Windows-only app.

    pyinstaller packaging/macos.spec --noconfirm

Output: dist/Moonshine.app
"""

import os
import sys

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
sys.path.insert(0, ROOT)
import brand  # noqa: E402

ICON = os.path.join(ROOT, "assets", f"{brand.APP_ID}.icns")
if not os.path.exists(ICON):
    # make_icons.py needs iconutil, which only exists here. Without it the
    # bundle still builds; it just inherits the generic rocket.
    print(f"note: {ICON} missing - run python scripts/make_icons.py first")
    ICON = None

DATAS = [
    (os.path.join(ROOT, "assets"), "assets"),
    (os.path.join(ROOT, "configs"), "configs"),
]
EXCLUDES = ["numpy", "matplotlib", "scipy", "pytest", "setuptools", "pip",
            "pystray"]


def analyse(script):
    return Analysis(
        [os.path.join(ROOT, script)],
        pathex=[ROOT],
        binaries=[],
        datas=DATAS,
        hiddenimports=[],
        hookspath=[],
        runtime_hooks=[],
        excludes=EXCLUDES,
        noarchive=False,
    )


app_a = analyse("window.py")
cli_a = analyse("moonshine.py")

app_pyz = PYZ(app_a.pure)
cli_pyz = PYZ(cli_a.pure)

# APFS is case-insensitive by default, exactly like NTFS, so `Moonshine` and
# `moonshine` would be one file in Contents/MacOS and one would overwrite the
# other. The CLI keeps the bare name because that is what gets symlinked onto
# PATH and typed; CFBundleName below is what the Finder and the menu bar show,
# and it is unaffected by the executable's filename.
app_exe = EXE(
    app_pyz, app_a.scripts, [],
    exclude_binaries=True,
    name=f"{brand.NAME} App",
    debug=False, strip=False, upx=False,
    console=False,
    # Apple Silicon only. The Mac this targets is arm64, and a universal2
    # build needs a universal2 Python plus universal2 wheels for Pillow -
    # neither of which Homebrew ships. See the Rosetta note in the README:
    # a translated parent process makes a native app look Intel.
    target_arch="arm64",
    icon=ICON,
)
cli_exe = EXE(
    cli_pyz, cli_a.scripts, [],
    exclude_binaries=True,
    name=brand.APP_ID,
    debug=False, strip=False, upx=False,
    console=True,
    target_arch="arm64",
    icon=ICON,
)

coll = COLLECT(
    app_exe, app_a.binaries, app_a.datas,
    cli_exe, cli_a.binaries, cli_a.datas,
    strip=False, upx=False,
    name=brand.NAME,
)

app = BUNDLE(
    coll,
    name=brand.APP_BUNDLE,
    icon=ICON,
    bundle_identifier=brand.BUNDLE_ID,
    version=brand.VERSION,
    info_plist={
        "CFBundleName": brand.NAME,
        "CFBundleDisplayName": brand.NAME,
        "CFBundleShortVersionString": brand.VERSION,
        "CFBundleVersion": brand.VERSION,
        "NSHighResolutionCapable": True,
        # Deliberately not LSUIElement: this bundle opens a window, so it
        # should own a Dock icon and be findable in Spotlight.
        "LSUIElement": False,
        "LSMinimumSystemVersion": "12.0",
        # TCC shows these strings in the permission prompt. Sunshine is what
        # actually captures, but the app triggers the prompts from setup.
        "NSScreenCaptureUsageDescription":
            f"{brand.NAME} streams this Mac's display to your other machines.",
        "NSAppleEventsUsageDescription":
            f"{brand.NAME} opens Terminal to show setup output.",
    },
)

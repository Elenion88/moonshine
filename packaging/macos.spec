# -*- mode: python ; coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""PyInstaller spec for the macOS CLI. Run this on the Mac.

There is no .app bundle here any more. The window was a Tk app that needed a
bundle to give it a Dock icon and, more importantly, a stable identity for TCC
to hang Screen Recording and Accessibility on. That is the Electron app's job
now - it is built from app/ and gets a bundle from electron-builder.

    pyinstaller packaging/macos.spec --noconfirm

Output: dist/moonshine/moonshine

Not shipped by the installer. Symlink it onto PATH if you want the CLI.
"""

import os
import sys

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
sys.path.insert(0, ROOT)
import brand  # noqa: E402

DATAS = [
    (os.path.join(ROOT, "assets"), "assets"),
    (os.path.join(ROOT, "configs"), "configs"),
]
EXCLUDES = [
    "PIL", "tkinter", "numpy", "matplotlib", "scipy",
    "pytest", "setuptools", "pip",
]

analysis = Analysis(
    [os.path.join(ROOT, "moonshine.py")],
    pathex=[ROOT],
    binaries=[],
    datas=DATAS,
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=EXCLUDES,
    noarchive=False,
)

pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name=brand.APP_ID,
    debug=False,
    strip=False,
    upx=False,
    console=True,
    # Apple Silicon only. A universal2 build needs a universal2 Python plus
    # universal2 wheels, which Homebrew does not ship.
    target_arch="arm64",
)

COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name=brand.APP_ID,
)

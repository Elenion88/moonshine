# -*- mode: python ; coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""PyInstaller spec for the Windows CLI.

One console executable. The window and the tray used to be built from here
too - Windows fixes the subsystem at link time, so a GUI binary cannot write
to a console and the three genuinely had to be separate files. They are an
Electron app now, built from app/, and this spec is only the CLI.

    pyinstaller packaging/windows.spec --noconfirm

Output: dist/moonshine/moonshine.exe

Not shipped by the installer. The installer packages the Electron app; this is
for people who want `moonshine list` and `moonshine bench` on PATH.
"""

import os
import sys

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
sys.path.insert(0, ROOT)
import brand  # noqa: E402

ICON = os.path.join(ROOT, "assets", f"{brand.APP_ID}.ico")

# The version resource Explorer reads in a file's Properties. Generated here so
# `brand.VERSION` stays the only place a version number is written down.
VERSION_TUPLE = tuple(int(part) for part in brand.VERSION.split(".")) + (0,) * 4
VERSION_FILE = os.path.join(SPECPATH, "version_info.txt")
with open(VERSION_FILE, "w", encoding="utf-8") as fh:
    fh.write(f"""VSVersionInfo(
  ffi=FixedFileInfo(
    filevers={VERSION_TUPLE[:4]}, prodvers={VERSION_TUPLE[:4]},
    mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)
  ),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', '{brand.NAME}'),
      StringStruct('FileDescription', '{brand.TAGLINE}'),
      StringStruct('FileVersion', '{brand.VERSION}'),
      StringStruct('InternalName', '{brand.APP_ID}'),
      StringStruct('ProductName', '{brand.NAME}'),
      StringStruct('ProductVersion', '{brand.VERSION}'),
    ])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
""")

# Box art that `moonshine setup` installs into Sunshine's config directory, and
# the icon it puts on the stream window. `asset_path()` resolves both through
# sys._MEIPASS.
DATAS = [
    (os.path.join(ROOT, "assets"), "assets"),
    (os.path.join(ROOT, "configs"), "configs"),
]

# The CLI imports nothing beyond the standard library. Pillow, tkinter and the
# plotting stack that Pillow drags in as optional imports are all dead weight
# here - excluding them is most of the binary.
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
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX-packed binaries are a reliable antivirus hit
    console=True,
    disable_windowed_traceback=False,
    icon=ICON,
    version=VERSION_FILE,
)

COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name=brand.APP_ID,
)

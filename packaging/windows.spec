# -*- mode: python ; coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""PyInstaller spec for the Windows build.

Three executables, one folder. Windows fixes the subsystem at link time, so a
windowed binary cannot write to a console and a console binary always shows
one: the CLI and the two GUI apps genuinely have to be separate files. They are
collected into a single directory so the interpreter, the Tcl/Tk runtime and
Pillow's DLLs are shared rather than shipped three times - about 40 MB saved.

    pyinstaller packaging/windows.spec --noconfirm

Output: dist/Moonshine/ - the folder the installer packages.
"""

import os
import sys

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
sys.path.insert(0, ROOT)
import brand  # noqa: E402

ICON = os.path.join(ROOT, "assets", f"{brand.APP_ID}.ico")

# The version resource Explorer reads in a file's Properties, and the one
# SmartScreen and any future code signature are attached to. Generated here so
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

# Shipped beside the code: icons for the window and the tray, box art that
# `moonshine setup` installs into Sunshine's config directory, and the sample
# Sunshine config. `asset_path()` resolves these through sys._MEIPASS.
DATAS = [
    (os.path.join(ROOT, "assets"), "assets"),
    (os.path.join(ROOT, "configs"), "configs"),
]

# pystray picks its backend at import time by trying each one, so PyInstaller's
# static analysis never sees the Windows backend being used.
HIDDEN = ["pystray._win32"]

# Nothing here needs numpy or a plotting stack, and Pillow drags both in as
# optional imports. Excluding them is ~60 MB off the installer.
EXCLUDES = ["numpy", "matplotlib", "scipy", "pytest", "setuptools", "pip"]


def analyse(script):
    return Analysis(
        [os.path.join(ROOT, script)],
        pathex=[ROOT],
        binaries=[],
        datas=DATAS,
        hiddenimports=HIDDEN,
        hookspath=[],
        runtime_hooks=[],
        excludes=EXCLUDES,
        noarchive=False,
    )


cli_a = analyse("moonshine.py")
app_a = analyse("window.py")
tray_a = analyse("tray_windows.pyw")

cli_pyz = PYZ(cli_a.pure)
app_pyz = PYZ(app_a.pure)
tray_pyz = PYZ(tray_a.pure)


def executable(analysis, pyz, name, console):
    return EXE(
        pyz,
        analysis.scripts,
        [],
        exclude_binaries=True,
        name=name,
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,          # UPX-packed binaries are a reliable antivirus hit
        console=console,
        disable_windowed_traceback=False,
        icon=ICON,
        version=VERSION_FILE,
    )


# The CLI keeps the bare name and the GUI apps are qualified, which is the
# opposite of what it looks like it should be. NTFS is case-insensitive, so
# `Moonshine.exe` and `moonshine.exe` are one filename and COLLECT silently
# wrote the second over the first - a build where `moonshine --help` opened a
# window and never returned. Only one of the three can hold the plain name, and
# it has to be the CLI: `moonshine` is what a user types, and PATHEXT resolves
# .exe before any .cmd shim, so a GUI called `Moonshine.exe` would answer that
# command instead. The GUI filenames are seen in Task Manager and nowhere else;
# the Start Menu shows whatever the shortcut is called.
cli_exe = executable(cli_a, cli_pyz, brand.APP_ID, console=True)
app_exe = executable(app_a, app_pyz, f"{brand.NAME} App", console=False)
tray_exe = executable(tray_a, tray_pyz, f"{brand.NAME} Tray", console=False)

COLLECT(
    cli_exe, cli_a.binaries, cli_a.datas,
    app_exe, app_a.binaries, app_a.datas,
    tray_exe, tray_a.binaries, tray_a.datas,
    strip=False,
    upx=False,
    name=brand.NAME,
)

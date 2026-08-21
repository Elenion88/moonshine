# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""Copy the licence texts of everything bundled into the build output.

The installers carry a Python interpreter, Tcl/Tk, Pillow and (on Windows)
pystray inside them. Redistributing those means shipping their licences, and a
notices file that links to a URL is not the same as shipping the text - URLs
rot, and an offline installer cannot follow one.

This pulls the real files out of the installed packages rather than keeping
copies in the repo, so they track whatever version was actually built against.

    python packaging/collect_licences.py dist/Moonshine

Missing licences are reported and do not stop the build: a build that fails
because Tcl moved its licence file is worse than one that tells you about it.
"""

from __future__ import annotations

import importlib.metadata as metadata
import os
import shutil
import sys
import sysconfig
import tkinter


def _from_distribution(name: str) -> list[tuple[str, str]]:
    """Every licence-looking file a pip-installed distribution declares."""
    try:
        dist = metadata.distribution(name)
    except metadata.PackageNotFoundError:
        return []
    found = []
    for entry in dist.files or []:
        base = os.path.basename(str(entry)).upper()
        if base.startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE")):
            path = str(dist.locate_file(entry))
            if os.path.exists(path):
                found.append((f"{name}-{os.path.basename(str(entry))}", path))
    return found


def _python_licence() -> list[tuple[str, str]]:
    for candidate in (
        os.path.join(sys.base_prefix, "LICENSE.txt"),
        os.path.join(sysconfig.get_path("stdlib"), "LICENSE.txt"),
        os.path.join(sys.base_prefix, "lib", "LICENSE.txt"),
    ):
        if os.path.exists(candidate):
            return [("python-LICENSE.txt", candidate)]
    return []


def _tk_licence() -> list[tuple[str, str]]:
    """Tk ships `license.terms` inside its script library, wherever that is."""
    try:
        root = tkinter.Tcl()
        library = root.eval("info library")           # .../tcl8.6
    except tkinter.TclError:
        return []
    found = []
    for name, folder in (("tcl", library),
                         ("tk", library.replace("tcl8", "tk8"))):
        candidate = os.path.join(folder, "license.terms")
        if os.path.exists(candidate):
            found.append((f"{name}-license.terms", candidate))
    return found


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        print("usage: collect_licences.py <output-dir>", file=sys.stderr)
        return 2

    out = os.path.join(sys.argv[1], "licences")
    os.makedirs(out, exist_ok=True)

    wanted: list[tuple[str, str]] = _python_licence() + _tk_licence()
    for package in ("pillow", "pystray"):
        wanted += _from_distribution(package)

    for name, source in wanted:
        shutil.copyfile(source, os.path.join(out, name))
        print(f"  {name}")

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for name in ("LICENSE", "THIRD-PARTY-NOTICES.md"):
        source = os.path.join(root, name)
        if os.path.exists(source):
            shutil.copyfile(source, os.path.join(sys.argv[1], name))
            print(f"  {name}")

    # pystray is LGPL-3.0 and gets frozen into the tray executable. That is fine
    # under GPL-3.0 - LGPLv3 is upward-compatible with it, and the relinking
    # requirement is met by the source being public - but its licence text
    # still has to travel with the binary, which is what this copied.

    if not wanted:
        print("  warning: no licence files found", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""
Generate the app icons from the same glyph the apps draw at runtime.

Without this the Start Menu entry inherits pythonw.exe's icon and the macOS
bundle gets the generic Python rocket, which is a shame when the app itself is
already drawing a perfectly good mark.

    python scripts/make_icons.py            # assets/moonshine.ico (+ .icns on macOS)
    python scripts/make_icons.py --png      # also a 512px PNG, for anything else

macOS icons are rendered with a transparent margin because the system does not
mask them: a full-bleed tile sits noticeably larger in the Dock than every icon
beside it.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import brand  # noqa: E402
import ui  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")

ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256]
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]


def mark(size: int, margin: float = 0.0):
    """The app mark at `size`, optionally inset inside a transparent square."""
    from PIL import Image

    if not margin:
        return ui.glyph_image(size, ui.DARK["accent"])

    inner = max(1, round(size * (1 - 2 * margin)))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(ui.glyph_image(inner, ui.DARK["accent"]),
                           ((size - inner) // 2, (size - inner) // 2))
    return canvas


def write_ico(path: str) -> None:
    master = mark(256)
    master.save(path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"wrote {path}")


def write_icns(path: str) -> bool:
    if not shutil.which("iconutil"):
        print("skipped .icns: iconutil not found (macOS only)")
        return False

    iconset = path.replace(".icns", ".iconset")
    shutil.rmtree(iconset, ignore_errors=True)
    os.makedirs(iconset)
    for size in ICNS_SIZES:
        image = mark(size, margin=0.09)
        image.save(os.path.join(iconset, f"icon_{size}x{size}.png"))
        if size > 16:
            # The @2x of the next size down, which is the same pixels.
            image.save(os.path.join(iconset, f"icon_{size // 2}x{size // 2}@2x.png"))

    result = subprocess.run(["iconutil", "-c", "icns", iconset, "-o", path],
                            capture_output=True, text=True)
    shutil.rmtree(iconset, ignore_errors=True)
    if result.returncode != 0:
        print(f"iconutil failed: {result.stderr.strip()}")
        return False
    print(f"wrote {path}")
    return True


def main() -> int:
    if not ui.HAVE_PIL:
        print("error: Pillow is required to generate icons", file=sys.stderr)
        return 1

    os.makedirs(ASSETS, exist_ok=True)
    write_ico(os.path.join(ASSETS, f"{brand.APP_ID}.ico"))
    write_icns(os.path.join(ASSETS, f"{brand.APP_ID}.icns"))
    if "--png" in sys.argv:
        path = os.path.join(ASSETS, f"{brand.APP_ID}.png")
        mark(512).save(path)
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

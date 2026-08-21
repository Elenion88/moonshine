# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""
Generate the box art Moonlight shows for each app on a Sunshine host.

Sunshine ships `desktop.png` and `steam.png` under `Program Files`, which means
two things: they are generic, and anything written over them is replaced by the
next Sunshine update. Covers referenced from the *config* directory are user
data and survive updates, so these are generated here, committed like the app
icons, and installed by `moonshine setup`.

    python scripts/make_covers.py

The proportions are Moonlight's: it lays tiles out as 3:4 box art, so a square
image is letterboxed against a grey field and looks like a mistake.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import brand  # noqa: E402
import glyph  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")

WIDTH, HEIGHT = 300, 400

# Segoe UI on Windows, the system face on macOS, then whatever Pillow has. The
# last one is a bitmap font and looks it, so the text is allowed to be absent
# rather than ugly - the mark carries the tile on its own.
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuisb.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def _font(size: int):
    from PIL import ImageFont

    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return None


def _centre(draw, text, font, y, fill):
    if font is None:
        return
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    draw.text(((WIDTH - (right - left)) / 2 - left, y - top), text,
              font=font, fill=fill)


def cover(label: str):
    """One tile: the mark on a dark card, the app name under it."""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (WIDTH, HEIGHT), glyph.DARK["bg"])
    draw = ImageDraw.Draw(image)

    # A slow wash toward the accent, brightest at the top. Flat black reads as a
    # missing image in Moonlight's grid; this reads as a deliberate one.
    top = glyph.DARK["surface_alt"]
    r1, g1, b1 = int(top[1:3], 16), int(top[3:5], 16), int(top[5:7], 16)
    r0, g0, b0 = (int(glyph.DARK["bg"][i:i + 2], 16) for i in (1, 3, 5))
    for y in range(HEIGHT):
        blend = (1 - y / HEIGHT) ** 2
        draw.line([(0, y), (WIDTH, y)],
                  fill=(round(r0 + (r1 - r0) * blend),
                        round(g0 + (g1 - g0) * blend),
                        round(b0 + (b1 - b0) * blend)))

    mark = glyph.glyph_image(132, glyph.DARK["accent"])
    image.paste(mark, ((WIDTH - 132) // 2, 96), mark)

    _centre(draw, label, _font(34), 258, glyph.DARK["text"])
    _centre(draw, brand.NAME.upper(), _font(15), 316, glyph.DARK["faint"])

    # A hairline the same colour as the window's cards, so a tile sitting in
    # Moonlight's grid belongs to the same family as the app that launched it.
    draw.rectangle([0, 0, WIDTH - 1, HEIGHT - 1], outline=glyph.DARK["border"])
    return image


def main() -> int:
    if not glyph.HAVE_PIL:
        print("error: Pillow is required to generate covers", file=sys.stderr)
        return 1

    os.makedirs(ASSETS, exist_ok=True)
    for label, filename in brand.COVERS.values():
        path = os.path.join(ASSETS, filename)
        cover(label).save(path)
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

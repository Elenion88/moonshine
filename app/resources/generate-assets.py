# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""Emit the icons and box art the Electron app ships, from the Python assets.

Electron's nativeImage reads PNG, not SVG, and the main process has no
rasteriser - so the four status colours are baked at build time rather than
drawn at runtime. Reusing the existing glyph means the tray, the window and the
app icon cannot drift apart.

    python app/resources/generate-assets.py

Temporary. When the Python UI is retired the mark should move to SVG in the
renderer, and these PNGs should be generated from that instead.
"""

import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
import brand  # noqa: E402
import traycore  # noqa: E402
import ui  # noqa: E402

OUT = os.path.join(ROOT, "app", "resources", "tray")

# Windows tray draws at 16pt; @2x and @3x cover 200% and 300% scaling.
SIZES = [(16, ""), (32, "@2x"), (48, "@3x")]


def main() -> int:
    if not ui.HAVE_PIL:
        print("error: Pillow is required", file=sys.stderr)
        return 1
    os.makedirs(OUT, exist_ok=True)
    for health, colour in traycore.HEALTH_HEX.items():
        for size, suffix in SIZES:
            ui.glyph_image(size, colour).save(os.path.join(OUT, f"{health}{suffix}.png"))
        print(f"wrote app/resources/tray/{health}*.png")
    ui.glyph_image(512, ui.DARK["accent"]).save(
        os.path.join(ROOT, "app", "resources", "icon.png"))
    print("wrote app/resources/icon.png")

    # Box art. `moonshine setup` writes these into Sunshine's config directory,
    # so the Electron app needs its own copy rather than reaching back into the
    # Python tree at runtime - a packaged app has no Python tree to reach into.
    covers = os.path.join(ROOT, "app", "resources", "covers")
    os.makedirs(covers, exist_ok=True)
    for _, filename in brand.COVERS.values():
        source = os.path.join(ROOT, "assets", filename)
        if os.path.exists(source):
            shutil.copyfile(source, os.path.join(covers, filename))
            print(f"wrote app/resources/covers/{filename}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

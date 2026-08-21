# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""The palette and the app mark, for the scripts that generate artwork.

Extracted from `ui.py` when the Tk UI was retired on 2026-08-21. The window
and the tray are an Electron app now, and it draws the same mark as SVG from
the same measurements - but the icons Electron's tray needs are raster, and
Sunshine's box art is a PNG, so something still has to draw them. This is the
smallest thing that can.

Nothing imports this at runtime. It exists for `scripts/make_icons.py`,
`scripts/make_covers.py` and `app/resources/generate-assets.py`.
"""

from __future__ import annotations

try:
    from PIL import Image, ImageChops, ImageDraw

    HAVE_PIL = True
except ImportError:  # pragma: no cover - depends on the machine
    HAVE_PIL = False


# --------------------------------------------------------------------------
# Colour
# --------------------------------------------------------------------------

DARK = {
    "bg": "#111317",
    "surface": "#191C21",
    "surface_alt": "#22262D",
    "surface_hover": "#2A2F37",
    "border": "#2B303A",
    "text": "#ECEFF4",
    "muted": "#949AA6",
    "faint": "#6B717C",
    "accent": "#4C7DFF",
    "accent_hover": "#638EFF",
    "accent_text": "#FFFFFF",
    "health": {
        "ok": "#3ED598",
        "degraded": "#F5B23D",
        "relayed": "#FF6B6B",
        "offline": "#7C838F",
    },
}

LIGHT = {
    "bg": "#F2F4F7",
    "surface": "#FFFFFF",
    "surface_alt": "#EDF0F4",
    "surface_hover": "#E3E8EF",
    "border": "#DDE2EA",
    "text": "#151920",
    "muted": "#606774",
    "faint": "#8B93A1",
    "accent": "#2F6BF0",
    "accent_hover": "#255CDA",
    "accent_text": "#FFFFFF",
    "health": {
        "ok": "#0E9F62",
        "degraded": "#B87708",
        "relayed": "#DA3633",
        "offline": "#8B93A1",
    },
}


def _rgb(colour: str) -> tuple[int, int, int]:
    colour = colour.lstrip("#")
    return tuple(int(colour[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def mix(a: str, b: str, t: float) -> str:
    """Blend `a` towards `b` by `t` (0..1), as a hex string."""
    ra, ga, ba = _rgb(a)
    rb, gb, bb = _rgb(b)
    return "#%02x%02x%02x" % (
        round(ra + (rb - ra) * t),
        round(ga + (gb - ga) * t),
        round(ba + (bb - ba) * t),
    )

# The tile colour carries host health, so a bad path is visible in the tray
# before you click anything. Lifted from traycore.py, which went with the Tk UI.
HEALTH_HEX = {
    "ok": DARK["health"]["ok"],
    "degraded": DARK["health"]["degraded"],
    "relayed": DARK["health"]["relayed"],
    "offline": DARK["health"]["offline"],
}


# --------------------------------------------------------------------------
# The mark
# --------------------------------------------------------------------------

_SS = 4  # supersampling factor

def glyph_image(size: int, colour: str, accent_screen: str = "#FFFFFF"):
    """The app mark: a moon throwing a beam onto a screen, on a status tile.

    The moon is the name - Moonlight plus Sunshine - and the screen is what the
    thing actually does. The tile stays the status colour because that is the
    part doing real work: health is readable in the tray without opening
    anything, and no amount of glyph is worth losing it.

    Everything below is measured in a 512-unit grid and scaled to the requested
    size, so the mark is one drawing rather than a set of per-size tweaks.

    The light is a cone in perspective: the screen is its near face, and its
    edges run back to a single apex at (356, 159) - 62 units inside the moon's
    white and clear of the bite - which is what makes the beam read as coming
    from behind the moon rather than beside it. The cone never reaches the
    lower-left corner; that corner staying solid tile is what keeps it a cone
    rather than a wash.

    The moon is bitten from the lower left rather than the upper right. An
    upper-right bite leaves the moon's mass in the lower left, exactly where
    the screen is, and the two fuse into one blob at tray size; biting the far
    side throws the mass up and away. It is also drawn *past* the rounded
    corner on purpose - overflowing the tile is what makes it read as bigger
    than the frame rather than arranged inside it - so it is composited after
    the tile mask rather than through it.

    Below 32 pixels the 42% cone greys into the tile and the ray is a third of
    a pixel wide, so both are drawn harder. The geometry is identical; only the
    contrast changes.
    """
    if not HAVE_PIL:
        return None
    n = size * _SS
    u = n / 512.0                       # one unit of the drawing grid, in pixels
    white = _rgb(accent_screen)

    def at(x: float, y: float) -> tuple[float, float]:
        return (x * u, y * u)

    # The tile: a gentle vertical gradient of the status colour, rounded off.
    top = mix(colour, "#FFFFFF", 0.18)
    bottom = mix(colour, "#000000", 0.14)
    ground = Image.new("RGB", (n, n))
    gd = ImageDraw.Draw(ground)
    for y in range(n):
        gd.line([(0, y), (n, y)], fill=mix(top, bottom, y / max(1, n - 1)))

    tile_mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(tile_mask).rounded_rectangle(
        [at(24, 24), at(488, 488)], radius=112 * u, fill=255)
    tile = ground.convert("RGBA")
    tile.putalpha(tile_mask)

    # Beam and ray. Both run off the left edge of the tile, so they are drawn
    # on their own layer and clipped by the tile mask before compositing.
    if size >= 32:
        cone_a, ray_a, ray_top, ray_bottom = 0.42, 0.80, 153, 166
    else:
        cone_a, ray_a, ray_top, ray_bottom = 0.56, 0.96, 149, 170

    beam = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    bd = ImageDraw.Draw(beam)
    bd.polygon([at(356, 159), at(74, 269), at(74, 408), at(270, 408)],
               fill=white + (round(255 * cone_a),))
    bd.polygon([at(-20, ray_top), at(356, 159), at(-20, ray_bottom)],
               fill=white + (round(255 * ray_a),))
    beam.putalpha(ImageChops.multiply(beam.getchannel("A"), tile_mask))
    tile.alpha_composite(beam)

    # The screen: the near face of the cone, solid over the band.
    ImageDraw.Draw(tile).rounded_rectangle(
        [at(74, 269), at(270, 408)], radius=24 * u, fill=white + (255,))

    # The crescent: an r150 circle bitten by a much larger r218 one. Composited
    # through its own mask so the bite restores whatever is underneath rather
    # than a flat colour that would band against the gradient.
    moon = Image.new("L", (n, n), 0)
    md = ImageDraw.Draw(moon)
    md.ellipse([at(317 - 150, 207 - 150), at(317 + 150, 207 + 150)], fill=255)
    md.ellipse([at(160 - 218, 302 - 218), at(160 + 218, 302 + 218)], fill=0)
    tile.paste(Image.new("RGBA", (n, n), white + (255,)), (0, 0), moon)

    return tile.resize((size, size), Image.LANCZOS)

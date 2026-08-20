"""
Shared look and feel for the remote apps.

Tk gives you two problems. Its stock widgets look like Windows 95, and its
drawing primitives have no antialiasing, so anything with a curve comes out
jagged. Both are solved the same way here: the pieces that carry the design -
cards, buttons, the status dot, the toggle, the app icon - are drawn with
Pillow at 4x and downsampled with LANCZOS, then shown as an image on a bare
Canvas. Everything else is a plain tk widget with the theme's colours and
fonts applied, which is sharp because text is rendered by the OS.

The other half of "blurry" is DPI. An unaware process on a scaled display is
handed a 96dpi canvas and has the result bitmap-stretched by Windows, which is
exactly as soft as it sounds. `enable_hidpi()` opts out of that, and must be
called before the Tk root exists.

Pillow is optional. Without it every drawn element falls back to a flat
Canvas rectangle - square corners, same colours - so the macOS window still
runs on a bare interpreter.
"""

from __future__ import annotations

import subprocess
import sys
import tkinter as tk
import tkinter.font as tkfont

try:
    from PIL import Image, ImageDraw, ImageTk

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


# --------------------------------------------------------------------------
# Platform integration
# --------------------------------------------------------------------------

def enable_hidpi() -> None:
    """Opt out of Windows' bitmap scaling. Call before creating the Tk root."""
    if sys.platform != "win32":
        return
    import ctypes

    try:
        # Per-monitor v2: we render at real pixels on whichever display we are
        # on. Tk 8.6 will not re-scale itself when the window is dragged to a
        # different display, so RemoteWindow re-reads the DPI and rebuilds.
        ctypes.windll.user32.SetProcessDpiAwarenessContext(-4)
        return
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def claim_taskbar_identity(app_id: str = "dev.austin.remote") -> None:
    """Give the app its own taskbar button, with its own icon.

    Without an explicit AppUserModelID, Windows files the window under
    pythonw.exe: it shares a taskbar button with every other Python GUI and
    wears the Python icon regardless of what the window itself carries.
    """
    if sys.platform != "win32":
        return
    import ctypes

    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id)
    except Exception:
        pass


def system_dark() -> bool:
    """True if the OS is in dark mode. Falls back to dark, which suits this app."""
    if sys.platform == "win32":
        try:
            import winreg

            key = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
                light, _ = winreg.QueryValueEx(handle, "AppsUseLightTheme")
            return not light
        except OSError:
            return True
    if sys.platform == "darwin":
        try:
            proc = subprocess.run(
                ["defaults", "read", "-g", "AppleInterfaceStyle"],
                capture_output=True, text=True, timeout=3,
            )
            return "dark" in proc.stdout.lower()
        except (OSError, subprocess.TimeoutExpired):
            return True
    return True


def screen_dpi(root: tk.Misc) -> float:
    if sys.platform == "darwin":
        # Aqua Tk reports 72dpi and handles Retina itself; scaling on top of
        # that would draw everything at three-quarter size.
        return 96.0
    try:
        return float(root.winfo_fpixels("1i"))
    except tk.TclError:
        return 96.0


def paint_titlebar(root: tk.Tk, theme: "Theme") -> None:
    """Match the Windows caption bar to the app instead of leaving it white."""
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import byref, c_int

    try:
        root.update_idletasks()
        hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
        dwm = ctypes.windll.dwmapi

        dark = c_int(1 if theme.dark else 0)
        for attribute in (20, 19):  # DWMWA_USE_IMMERSIVE_DARK_MODE, then pre-20H1
            dwm.DwmSetWindowAttribute(hwnd, attribute, byref(dark), 4)

        # Win11 only; harmless elsewhere. COLORREF is 0x00BBGGRR.
        def colorref(value: str) -> c_int:
            r, g, b = _rgb(value)
            return c_int(b << 16 | g << 8 | r)

        dwm.DwmSetWindowAttribute(hwnd, 35, byref(colorref(theme.bg)), 4)
        dwm.DwmSetWindowAttribute(hwnd, 36, byref(colorref(theme.text)), 4)
        dwm.DwmSetWindowAttribute(hwnd, 34, byref(colorref(theme.border)), 4)
    except Exception:
        pass


# --------------------------------------------------------------------------
# Theme
# --------------------------------------------------------------------------

_UI_FAMILIES = {
    "win32": ["Segoe UI Variable Text", "Segoe UI"],
    "darwin": ["SF Pro Text", ".AppleSystemUIFont", "Helvetica Neue"],
}
_DISPLAY_FAMILIES = {
    "win32": ["Segoe UI Variable Display", "Segoe UI"],
    "darwin": ["SF Pro Display", "SF Pro Text", "Helvetica Neue"],
}
_SEMIBOLD_FAMILIES = {
    "win32": ["Segoe UI Variable Text Semibold", "Segoe UI Semibold"],
    "darwin": ["SF Pro Text Semibold"],
}
_MONO_FAMILIES = {
    "win32": ["Cascadia Mono", "Consolas"],
    "darwin": ["SF Mono", "Menlo"],
}


class Theme:
    """Palette, type scale and pixel scale for one window."""

    # Type scale, in points. Tk turns these into pixels using the scaling
    # factor we set from the real DPI, so they stay honest on a 4K display.
    title = 15
    heading = 11
    body = 10
    small = 9

    def __init__(self, root: tk.Misc, dark: bool | None = None) -> None:
        self.root = root
        self.dark = system_dark() if dark is None else dark
        self.dpi = screen_dpi(root)
        self.scale = self.dpi / 96.0

        palette = DARK if self.dark else LIGHT
        self.bg: str = palette["bg"]
        self.surface: str = palette["surface"]
        self.surface_alt: str = palette["surface_alt"]
        self.surface_hover: str = palette["surface_hover"]
        self.border: str = palette["border"]
        self.text: str = palette["text"]
        self.muted: str = palette["muted"]
        self.faint: str = palette["faint"]
        self.accent: str = palette["accent"]
        self.accent_hover: str = palette["accent_hover"]
        self.accent_text: str = palette["accent_text"]
        self.health: dict[str, str] = dict(palette["health"])

        families = set(tkfont.families(root))

        def pick(candidates: list[str], fallback: str | None) -> str | None:
            for name in candidates:
                if name in families:
                    return name
            return fallback

        # Resolves the *family* behind Tk's named font rather than the name
        # itself - "TkDefaultFont" is not a family, and handing it to a font
        # tuple gets you whatever Tk substitutes.
        def named(name: str) -> str:
            try:
                return tkfont.nametofont(name, root).actual("family")
            except tk.TclError:
                return "Helvetica"

        if sys.platform == "darwin":
            # families() hides the dot-prefixed system fonts, so a candidate
            # list can never find SF - the best it turns up is Helvetica Neue,
            # which is a 1980s typeface and looks it next to the rest of the OS.
            # TkDefaultFont resolves to .AppleSystemUIFont, which is SF, and Tk
            # accepts that name in a font tuple even though it will not list it.
            system_ui = named("TkDefaultFont")
            self.ui_family = system_ui
            self.display_family = system_ui
            # Aqua Tk has no semibold face; bold is the only heavier weight.
            self.semibold_family = None
            self.mono_family = pick(_MONO_FAMILIES["darwin"], named("TkFixedFont"))
        else:
            plat = sys.platform if sys.platform in _UI_FAMILIES else "win32"
            self.ui_family = pick(_UI_FAMILIES[plat], named("TkDefaultFont"))
            self.display_family = pick(_DISPLAY_FAMILIES[plat], self.ui_family)
            self.semibold_family = pick(_SEMIBOLD_FAMILIES[plat], None)
            self.mono_family = pick(_MONO_FAMILIES[plat], named("TkFixedFont"))

    # -- units ---------------------------------------------------------

    def px(self, value: float) -> int:
        """Logical pixels to device pixels."""
        return max(1, round(value * self.scale))

    # -- fonts ---------------------------------------------------------

    def font(self, size: int, weight: str = "regular", display: bool = False):
        family = self.display_family if display else self.ui_family
        if weight == "semibold" and self.semibold_family:
            return (self.semibold_family, size)
        if weight in ("semibold", "bold"):
            return (family, size, "bold")
        return (family, size)

    def mono(self, size: int):
        return (self.mono_family, size)

    def measure(self, text: str, font) -> int:
        return tkfont.Font(root=self.root, font=font).measure(text)

    # -- derived colours -----------------------------------------------

    def tint(self, colour: str, amount: float = 0.86, over: str | None = None) -> str:
        """A colour faded into the background, for pill and badge fills."""
        return mix(colour, over or self.bg, amount)


# --------------------------------------------------------------------------
# Drawing
# --------------------------------------------------------------------------

_SS = 4  # supersampling factor
_cache: dict = {}
# Rendered images are cached by their exact geometry and colours, which means
# dragging a window edge mints one per pixel of width. Capped rather than
# managed: a full clear costs one repaint, and repaints are already happening.
_CACHE_LIMIT = 512


def _remember(key, photo):
    if len(_cache) >= _CACHE_LIMIT:
        _cache.clear()
    _cache[key] = photo
    return photo


def _rounded_photo(theme: Theme, w: int, h: int, radius: int, fill: str,
                   bg: str, outline: str | None = None, width: int = 1):
    """A rounded rectangle, antialiased, composited over `bg`.

    Tk has no alpha channel for widgets, so the background colour has to be
    baked in - which is why every drawn widget is told what it sits on.
    """
    if not HAVE_PIL:
        return None
    key = ("rect", w, h, radius, fill, bg, outline, width)
    cached = _cache.get(key)
    if cached is not None:
        return cached

    img = Image.new("RGB", (w * _SS, h * _SS), bg)
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [0, 0, w * _SS - 1, h * _SS - 1],
        radius=radius * _SS,
        fill=fill,
        outline=outline,
        width=width * _SS if outline else 0,
    )
    return _remember(key, ImageTk.PhotoImage(img.resize((w, h), Image.LANCZOS)))


def _dot_photo(size: int, colour: str, bg: str, halo: bool = True):
    """A status dot with a soft ring, so it reads as a light rather than a blob."""
    if not HAVE_PIL:
        return None
    key = ("dot", size, colour, bg, halo)
    cached = _cache.get(key)
    if cached is not None:
        return cached

    n = size * _SS
    img = Image.new("RGB", (n, n), bg)
    draw = ImageDraw.Draw(img)
    if halo:
        draw.ellipse([0, 0, n - 1, n - 1], fill=mix(colour, bg, 0.74))
        inset = n * 0.27
    else:
        inset = 0
    draw.ellipse([inset, inset, n - 1 - inset, n - 1 - inset], fill=colour)
    return _remember(key, ImageTk.PhotoImage(img.resize((size, size), Image.LANCZOS)))


def glyph_image(size: int, colour: str, accent_screen: str = "#FFFFFF"):
    """The app mark: a screen with a crescent moon, on a status-coloured tile.

    The moon is the name - Moonlight plus Sunshine - and the screen is what the
    thing actually does. The tile stays the status colour because that is the
    part doing real work: health is readable in the tray without opening
    anything, and no amount of glyph is worth losing it.

    Two shapes at 16 pixels is the whole difficulty. The moon is bitten from
    the lower left rather than the upper right, which is the non-obvious half:
    an upper-right bite leaves the moon's mass in the lower left, exactly where
    the screen is, and the two fuse into one blob at tray size. Biting the far
    side throws the mass up and away and keeps a clean gap between them.
    """
    if not HAVE_PIL:
        return None
    n = size * _SS
    top = mix(colour, "#FFFFFF", 0.18)
    bottom = mix(colour, "#000000", 0.14)

    tile = Image.new("RGB", (n, n))
    draw = ImageDraw.Draw(tile)
    for y in range(n):
        draw.line([(0, y), (n, y)], fill=mix(top, bottom, y / max(1, n - 1)))

    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, n - 1, n - 1], radius=int(n * 0.26), fill=255)

    # Screen and a detached base bar, shifted down and left of centre to clear
    # the moon. A connecting neck fuses with the screen at this size, so the
    # gap plus a wide bar is what still reads as a monitor.
    screen = ImageDraw.Draw(tile)
    sw, sh = n * 0.46, n * 0.30
    x0, y0 = n * 0.09, n * 0.40
    screen.rounded_rectangle([x0, y0, x0 + sw, y0 + sh],
                             radius=max(1, int(n * 0.055)), fill=accent_screen)
    bw, bh = n * 0.28, n * 0.075
    bx, by = x0 + (sw - bw) / 2, y0 + sh + n * 0.06
    screen.rounded_rectangle([bx, by, bx + bw, by + bh],
                             radius=int(bh / 2), fill=accent_screen)

    # The crescent, composited through its own mask so the bite restores the
    # tile gradient underneath rather than a flat colour that would band.
    moon = Image.new("L", (n, n), 0)
    md = ImageDraw.Draw(moon)
    # Thickness is the constraint, not elegance. Near-equal radii give the
    # slim crescent you would draw at poster size and about 1.7 pixels of
    # white at 16, which greys out; a smaller bite offset further down-left
    # keeps roughly 2.5 pixels at the waist, which survives.
    ox, oy, r_out = n * 0.700, n * 0.280, n * 0.175
    md.ellipse([ox - r_out, oy - r_out, ox + r_out, oy + r_out], fill=255)
    ix, iy, r_in = n * 0.628, n * 0.376, n * 0.140
    md.ellipse([ix - r_in, iy - r_in, ix + r_in, iy + r_in], fill=0)
    tile.paste(Image.new("RGB", (n, n), accent_screen), (0, 0), moon)

    tile.putalpha(mask)
    return tile.resize((size, size), Image.LANCZOS)


# --------------------------------------------------------------------------
# Widgets
# --------------------------------------------------------------------------

class Button(tk.Canvas):
    """A flat, rounded button with hover and press states.

    ttk was the alternative and it loses either way: the stock themes are
    dated, and a restyled one still cannot draw a rounded corner cleanly.
    """

    def __init__(self, master, theme: Theme, text: str, command=None,
                 kind: str = "secondary", bg: str | None = None,
                 height: int = 32, radius: int = 8, padx: int = 14,
                 min_width: int = 0) -> None:
        self.theme = theme
        self.kind = kind
        self.command = command
        self._bg = bg or theme.bg
        self._text = text
        self._enabled = True
        self._hovered = False
        self._radius = theme.px(radius)
        self._height = theme.px(height)
        self._padx = theme.px(padx)
        self._min_width = theme.px(min_width)
        self._font = theme.font(theme.small, "semibold")

        width = self._width_for(text)
        super().__init__(master, width=width, height=self._height, bg=self._bg,
                         highlightthickness=0, bd=0, takefocus=0)

        self._image_id = self.create_image(0, 0, anchor="nw")
        self._text_id = self.create_text(width // 2, self._height // 2,
                                         text=text, font=self._font)
        self._paint()

        self.bind("<Enter>", self._on_enter)
        self.bind("<Leave>", self._on_leave)
        self.bind("<ButtonPress-1>", lambda _e: self._paint(pressed=True))
        self.bind("<ButtonRelease-1>", self._on_release)

    # -- appearance ----------------------------------------------------

    def _width_for(self, text: str) -> int:
        return max(self._min_width, self.theme.measure(text, self._font) + 2 * self._padx)

    def _colours(self, pressed: bool) -> tuple[str, str | None, str]:
        t = self.theme
        if not self._enabled:
            return (t.surface_alt if self.kind != "ghost" else self._bg,
                    None, t.faint)
        if self.kind == "primary":
            fill = t.accent_hover if self._hovered else t.accent
            if pressed:
                fill = mix(t.accent, "#000000", 0.18)
            return fill, None, t.accent_text
        if self.kind == "ghost":
            if pressed:
                return t.surface_hover, None, t.text
            return (t.surface_alt if self._hovered else self._bg), None, (
                t.text if self._hovered else t.muted)
        fill = t.surface_hover if self._hovered else t.surface_alt
        if pressed:
            fill = mix(t.surface_hover, "#000000", 0.10)
        return fill, t.border, t.text

    def _paint(self, pressed: bool = False) -> None:
        fill, outline, text_colour = self._colours(pressed)
        width = int(self["width"])
        photo = _rounded_photo(self.theme, width, self._height, self._radius,
                               fill, self._bg, outline)
        if photo is not None:
            self.itemconfigure(self._image_id, image=photo)
            self._photo = photo  # keep a reference alive on the widget
        else:  # Pillow missing: square corners, same colours
            self.delete("fallback")
            self.create_rectangle(0, 0, width, self._height, fill=fill,
                                  outline=outline or fill, tags="fallback")
            self.tag_lower("fallback")
        self.itemconfigure(self._text_id, fill=text_colour)
        self.configure(cursor="hand2" if self._enabled else "")

    # -- state ---------------------------------------------------------

    def set_text(self, text: str) -> None:
        if text == self._text:
            return
        self._text = text
        width = self._width_for(text)
        self.configure(width=width)
        self.coords(self._text_id, width // 2, self._height // 2)
        self.itemconfigure(self._text_id, text=text)
        self._paint()

    def set_enabled(self, enabled: bool) -> None:
        if enabled == self._enabled:
            return
        self._enabled = enabled
        self._hovered = False
        self._paint()

    def set_bg(self, bg: str) -> None:
        self._bg = bg
        self.configure(bg=bg)
        self._paint()

    # -- events --------------------------------------------------------

    def _on_enter(self, _event) -> None:
        if not self._enabled:
            return
        self._hovered = True
        self._paint()

    def _on_leave(self, _event) -> None:
        self._hovered = False
        self._paint()

    def _on_release(self, event) -> None:
        self._paint()
        inside = 0 <= event.x <= int(self["width"]) and 0 <= event.y <= self._height
        if self._enabled and inside and self.command:
            self.command()


class Switch(tk.Canvas):
    """A pill toggle. The knob slides, because an instant jump reads as a glitch."""

    def __init__(self, master, theme: Theme, value: bool = False,
                 command=None, bg: str | None = None) -> None:
        self.theme = theme
        self.command = command
        self._bg = bg or theme.bg
        self._value = value
        self._pos = 1.0 if value else 0.0
        self._animation = None

        # Not _w/_h: tkinter keeps the widget's Tcl path name in self._w, and
        # the Canvas constructor would quietly overwrite the width with it.
        self._track_w, self._track_h = theme.px(40), theme.px(22)
        super().__init__(master, width=self._track_w, height=self._track_h, bg=self._bg,
                         highlightthickness=0, bd=0, takefocus=0, cursor="hand2")
        self._track_id = self.create_image(0, 0, anchor="nw")
        self._knob_id = self.create_image(0, 0, anchor="nw")
        self._render()
        self.bind("<Button-1>", lambda _e: self.toggle())

    def get(self) -> bool:
        return self._value

    def toggle(self) -> None:
        self._value = not self._value
        self._animate()
        if self.command:
            self.command(self._value)

    def _animate(self, step: int = 0) -> None:
        target = 1.0 if self._value else 0.0
        steps = 6
        self._pos += (target - self._pos) * 0.5
        if step >= steps:
            self._pos = target
        self._render()
        if step < steps:
            self._animation = self.after(14, self._animate, step + 1)

    def _render(self) -> None:
        t = self.theme
        off = t.surface_hover if t.dark else mix(t.border, "#000000", 0.06)
        track = mix(off, t.accent, self._pos)
        w, h = self._track_w, self._track_h
        photo = _rounded_photo(t, w, h, h // 2, track, self._bg)
        if photo is not None:
            self.itemconfigure(self._track_id, image=photo)
            self._track_photo = photo
        else:
            self.delete("fallback")
            self.create_rectangle(0, 0, w, h, fill=track,
                                  outline=track, tags="fallback")
            self.tag_lower("fallback")

        size = h - t.px(6)
        knob = _dot_photo(size, "#FFFFFF", track, halo=False)
        travel = w - size - t.px(6)
        x = t.px(3) + travel * self._pos
        if knob is not None:
            self.itemconfigure(self._knob_id, image=knob)
            self._knob_photo = knob
            self.coords(self._knob_id, x, t.px(3))
        else:
            self.delete("knob")
            self.create_oval(x, t.px(3), x + size, t.px(3) + size,
                             fill="#FFFFFF", outline="#FFFFFF", tags="knob")


class Pill(tk.Canvas):
    """A tinted status chip: dot plus a word, sized to whatever it is given."""

    def __init__(self, master, theme: Theme, bg: str | None = None) -> None:
        self.theme = theme
        self._bg = bg or theme.bg
        self._font = theme.font(theme.small, "semibold")
        self._height = theme.px(26)
        super().__init__(master, width=theme.px(120), height=self._height,
                         bg=self._bg, highlightthickness=0, bd=0, takefocus=0)
        self._image_id = self.create_image(0, 0, anchor="nw")
        self._dot_id = self.create_image(0, 0, anchor="nw")
        self._text_id = self.create_text(0, self._height // 2, anchor="w",
                                         font=self._font)

    def set(self, text: str, colour: str) -> None:
        t = self.theme
        dot = t.px(8)
        pad = t.px(11)
        gap = t.px(7)
        width = pad + dot + gap + t.measure(text, self._font) + pad
        self.configure(width=width)

        fill = t.tint(colour, 0.88 if t.dark else 0.9, over=t.bg)
        photo = _rounded_photo(t, width, self._height, self._height // 2,
                               fill, self._bg, mix(colour, t.bg, 0.7))
        if photo is not None:
            self.itemconfigure(self._image_id, image=photo)
            self._photo = photo
        else:
            self.delete("fallback")
            self.create_rectangle(0, 0, width, self._height, fill=fill,
                                  outline=fill, tags="fallback")
            self.tag_lower("fallback")

        dot_photo = _dot_photo(dot, colour, fill, halo=False)
        if dot_photo is not None:
            self.itemconfigure(self._dot_id, image=dot_photo)
            self._dot_photo = dot_photo
            self.coords(self._dot_id, pad, (self._height - dot) // 2)
        else:
            self.delete("dot")
            top = (self._height - dot) // 2
            self.create_oval(pad, top, pad + dot, top + dot, fill=colour,
                             outline=colour, tags="dot")

        self.itemconfigure(self._text_id, text=text,
                           fill=colour if t.dark else mix(colour, "#000000", 0.15))
        self.coords(self._text_id, pad + dot + gap, self._height // 2)


class Dot(tk.Canvas):
    """A standalone status light."""

    def __init__(self, master, theme: Theme, colour: str, size: int = 12,
                 bg: str | None = None) -> None:
        self.theme = theme
        self._bg = bg or theme.bg
        px = theme.px(size)
        super().__init__(master, width=px, height=px, bg=self._bg,
                         highlightthickness=0, bd=0, takefocus=0)
        photo = _dot_photo(px, colour, self._bg)
        if photo is not None:
            self.create_image(0, 0, anchor="nw", image=photo)
            self._photo = photo
        else:
            self.create_oval(0, 0, px - 1, px - 1, fill=colour, outline=colour)


class Card(tk.Canvas):
    """A rounded panel you pack normal widgets into via `.body`.

    The body frame is inset far enough that its square corners stay inside the
    rounded shape, which is the whole trick to faking a rounded container in a
    toolkit that has no notion of one.
    """

    def __init__(self, master, theme: Theme, radius: int = 12, padx: int = 16,
                 pady: int = 13, fill: str | None = None, bg: str | None = None,
                 outline: str | None = None) -> None:
        self.theme = theme
        self._bg = bg or theme.bg
        self._fill = fill or theme.surface
        self._outline = outline if outline is not None else theme.border
        self._radius = theme.px(radius)
        self._padx = theme.px(padx)
        self._pady = theme.px(pady)

        super().__init__(master, bg=self._bg, highlightthickness=0, bd=0,
                         height=theme.px(64))
        self._image_id = self.create_image(0, 0, anchor="nw")
        self.body = tk.Frame(self, bg=self._fill, highlightthickness=0, bd=0)
        self._body_id = self.create_window(self._padx, self._pady, anchor="nw",
                                           window=self.body)
        self.bind("<Configure>", self._on_configure)

    def autosize(self) -> None:
        """Fit the card to its contents. Fonts differ per machine; guessing a
        pixel height clips text on any display scaled past the one it was
        written on."""
        self.body.update_idletasks()
        self.configure(height=self.body.winfo_reqheight() + 2 * self._pady)

    def _on_configure(self, event) -> None:
        width, height = event.width, event.height
        if width <= 1 or height <= 1:
            return
        photo = _rounded_photo(self.theme, width, height, self._radius,
                               self._fill, self._bg, self._outline)
        if photo is not None:
            self.itemconfigure(self._image_id, image=photo)
            self._photo = photo
        else:
            self.delete("fallback")
            self.create_rectangle(0, 0, width - 1, height - 1, fill=self._fill,
                                  outline=self._outline or self._fill,
                                  tags="fallback")
            self.tag_lower("fallback")
        self.itemconfigure(self._body_id, width=width - 2 * self._padx,
                           height=height - 2 * self._pady)


def separator(master, theme: Theme, bg: str | None = None) -> tk.Frame:
    return tk.Frame(master, height=max(1, theme.px(1)), bg=theme.border,
                    highlightthickness=0, bd=0)


def label(master, theme: Theme, text: str, size: int | None = None,
          weight: str = "regular", colour: str | None = None,
          bg: str | None = None, mono: bool = False, display: bool = False,
          **kwargs) -> tk.Label:
    size = theme.body if size is None else size
    font = theme.mono(size) if mono else theme.font(size, weight, display)
    return tk.Label(master, text=text, font=font, bg=bg or theme.bg,
                    fg=colour or theme.text, highlightthickness=0, bd=0, **kwargs)

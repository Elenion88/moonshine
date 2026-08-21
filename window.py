# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""
remote - desktop window.

A normal application window listing every streamable tailnet host with its live
path quality and a button per profile. This exists because the macOS menu bar
turned out to be a dead end on this machine: macOS reports a status item as
created and visible, allocates it a width, and then silently declines to draw it
when the bar is full - which on a notched display it is. A window depends on no
such real estate, and works identically on Windows.

The look is built from `ui.py` rather than ttk: rounded cards, a filled accent
button per profile, and a status chip in the header. Text is sharp because the
process declares itself DPI aware before Tk starts, and the curves are sharp
because they are drawn oversampled with Pillow.

Run it directly, or from Moonshine.app on macOS.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tkinter as tk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brand  # noqa: E402
import moonshine  # noqa: E402
import traycore  # noqa: E402
import ui  # noqa: E402

STATUS_HINT = {
    "ok": "Direct",
    "degraded": "Above one frame",
    "relayed": "Relayed",
    "offline": "Nothing online",
}

PROFILE_LABELS = {
    "desktop": "Desktop",
    "gaming": "Gaming",
    "mac": "Connect",
}


class RemoteWindow:
    def __init__(self) -> None:
        ui.enable_hidpi()
        ui.claim_taskbar_identity(brand.BUNDLE_ID)
        self.root = tk.Tk()
        self.root.title(brand.NAME)

        self.theme = ui.Theme(self.root)
        if sys.platform == "win32":
            self.root.tk.call("tk", "scaling", self.theme.dpi / 72.0)
            # Re-read after scaling: Tk reports slightly different metrics once
            # it knows the real DPI, and every pixel size below derives from it.
            self.theme = ui.Theme(self.root, dark=self.theme.dark)

        self.cache = traycore.StatusCache()
        self.overlay_on = False
        self._rendered_at = -1.0
        self._was_refreshing = False
        self._was_streaming = False
        self._ticks = 0

        self._apply_window_style()
        self._build_chrome()
        self._render_status()

        self.cache.start()
        self._poll()

    # ------------------------------------------------------------------
    # Window chrome
    # ------------------------------------------------------------------

    def _apply_window_style(self) -> None:
        theme = self.theme
        self.root.configure(bg=theme.bg)
        self.root.minsize(theme.px(560), theme.px(320))

        icon = ui.glyph_image(64, theme.accent)
        if icon is not None:
            from PIL import ImageTk

            self._icon = ImageTk.PhotoImage(icon)
            self.root.iconphoto(True, self._icon)

        ui.paint_titlebar(self.root, theme)

        width, height = theme.px(660), theme.px(440)
        x = (self.root.winfo_screenwidth() - width) // 2
        y = (self.root.winfo_screenheight() - height) // 3
        self.root.geometry(f"{width}x{height}+{max(x, 0)}+{max(y, 0)}")

    def _build_chrome(self) -> None:
        theme = self.theme
        outer = tk.Frame(self.root, bg=theme.bg,
                         padx=theme.px(20), pady=theme.px(18))
        outer.pack(fill="both", expand=True)
        self.outer = outer

        header = tk.Frame(outer, bg=theme.bg)
        header.pack(fill="x", pady=(0, theme.px(16)))

        mark = ui.glyph_image(theme.px(26), theme.accent)
        if mark is not None:
            from PIL import ImageTk

            self._mark = ImageTk.PhotoImage(mark)
            tk.Label(header, image=self._mark, bg=theme.bg,
                     highlightthickness=0, bd=0).pack(
                side="left", padx=(0, theme.px(10)))

        ui.label(header, theme, brand.NAME, size=theme.title, weight="semibold",
                 display=True).pack(side="left")

        self.pill = ui.Pill(header, theme)
        self.pill.pack(side="right")

        self.hosts_frame = tk.Frame(outer, bg=theme.bg)
        self.hosts_frame.pack(fill="both", expand=True)

        ui.separator(outer, theme).pack(fill="x", pady=(theme.px(16), 0))

        footer = tk.Frame(outer, bg=theme.bg)
        footer.pack(fill="x", pady=(theme.px(14), 0))

        self.refresh_btn = ui.Button(footer, theme, "Refresh",
                                     command=self._on_refresh, min_width=90)
        self.refresh_btn.pack(side="left")

        what = "Mac" if sys.platform == "darwin" else "PC"
        ui.Button(footer, theme, f"Set up this {what}", kind="ghost",
                  command=traycore.run_setup).pack(side="left", padx=(theme.px(6), 0))

        ui.Button(footer, theme, "Session logs", kind="ghost",
                  command=self._open_logs).pack(side="left", padx=(theme.px(6), 0))

        # Off by default: the overlay is a diagnostic, not something you want
        # sitting on top of the picture during normal use.
        self.overlay_switch = ui.Switch(footer, theme, value=self.overlay_on,
                                        command=self._on_overlay)
        self.overlay_switch.pack(side="right")
        ui.label(footer, theme, "Latency overlay", size=theme.small,
                 colour=theme.muted).pack(side="right", padx=(0, theme.px(9)))

    def _open_logs(self) -> None:
        directory = moonshine.sessions_dir()
        if sys.platform == "win32":
            os.startfile(directory)  # noqa: S606 - opening a folder we created
        else:
            subprocess.Popen(["open", directory])

    # ------------------------------------------------------------------
    # Rendering
    # ------------------------------------------------------------------

    def _render_hosts(self) -> None:
        for child in self.hosts_frame.winfo_children():
            child.destroy()

        if not self.cache.hosts:
            self._render_placeholder()
            return

        for host in self.cache.hosts:
            self._render_host(host)

        self._fit_height()

    def _render_placeholder(self) -> None:
        theme = self.theme
        card = ui.Card(self.hosts_frame, theme, pady=28)
        card.pack(fill="x")
        message = ("Looking for hosts on the tailnet..."
                   if self.cache.refreshing else "No streamable hosts found")
        ui.label(card.body, theme, message, colour=theme.muted,
                 bg=theme.surface).pack(anchor="center")
        card.autosize()

    def _render_host(self, host: traycore.HostStatus) -> None:
        theme = self.theme
        colour = theme.health[host.health]

        card = ui.Card(self.hosts_frame, theme)
        card.pack(fill="x", pady=(0, theme.px(10)))
        body = card.body

        if host.online:
            buttons = tk.Frame(body, bg=theme.surface)
            buttons.pack(side="right")
            keys = traycore.profiles_for(host)
            for index, key in enumerate(keys):
                ui.Button(
                    buttons, theme, PROFILE_LABELS.get(key, key.capitalize()),
                    kind="primary" if index == 0 else "secondary",
                    bg=theme.surface, min_width=86,
                    command=lambda h=host.name, p=key: traycore.launch_session(
                        h, p, overlay=self.overlay_on),
                ).pack(side="left", padx=(theme.px(8), 0))
        else:
            ui.label(body, theme, "Offline", size=theme.small,
                     colour=theme.faint, bg=theme.surface).pack(
                side="right", padx=(theme.px(8), theme.px(4)))

        ui.Dot(body, theme, colour, size=12, bg=theme.surface).pack(
            side="left", padx=(0, theme.px(12)))

        text = tk.Frame(body, bg=theme.surface)
        text.pack(side="left", fill="x", expand=True)

        ui.label(text, theme, host.name, size=theme.heading, weight="semibold",
                 colour=theme.text if host.online else theme.muted,
                 bg=theme.surface).pack(anchor="w")

        ui.label(text, theme, self._detail(host), size=theme.small, mono=True,
                 colour=theme.faint if host.health != "relayed" else colour,
                 bg=theme.surface).pack(anchor="w", pady=(theme.px(3), 0))

        card.autosize()

    def _detail(self, host: traycore.HostStatus) -> str:
        if not host.online:
            return "not reachable"
        if not host.direct:
            return f"relayed via {host.relay}  ·  will stutter"
        parts = [f"direct  ·  {host.median:.0f} ms"] if host.median is not None else [
            "direct"]
        if host.jitter is not None:
            parts.append(f"±{host.jitter:.0f} ms")
        return "  ·  ".join(parts)

    def _render_status(self) -> None:
        theme = self.theme
        if self.cache.streaming:
            self.pill.set("Session in progress", theme.accent)
        elif self.cache.refreshing and not self.cache.hosts:
            self.pill.set("Checking", theme.muted)
        else:
            health = self.cache.overall_health
            self.pill.set(STATUS_HINT[health], theme.health[health])

        self.refresh_btn.set_text(
            "Refreshing" if self.cache.refreshing else "Refresh")
        self.refresh_btn.set_enabled(not self.cache.refreshing)

    def _fit_height(self) -> None:
        """Grow the window to fit the host list, but never past the screen."""
        self.root.update_idletasks()
        needed = self.outer.winfo_reqheight() + self.theme.px(4)
        limit = int(self.root.winfo_screenheight() * 0.8)
        height = min(needed, limit)
        if height > self.root.winfo_height():
            self.root.geometry(f"{self.root.winfo_width()}x{height}")

    # ------------------------------------------------------------------

    def _on_overlay(self, value: bool) -> None:
        self.overlay_on = value

    def _on_refresh(self) -> None:
        # Explicit click overrides the streaming pause - if you asked for it,
        # you get it.
        self.cache.refresh_soon(force=True)

    def _rebuild(self) -> None:
        """Tear the UI down and build it again under the current theme and DPI.

        Both can change while the window is open - the system switching to dark
        mode at sunset, or the window being dragged to a display with different
        scaling - and every colour and pixel size here was resolved once at
        startup.
        """
        self.theme = ui.Theme(self.root)
        if sys.platform == "win32":
            self.root.tk.call("tk", "scaling", self.theme.dpi / 72.0)
        self.root.configure(bg=self.theme.bg)
        ui.paint_titlebar(self.root, self.theme)
        self.outer.destroy()
        self._build_chrome()
        self._render_hosts()
        self._render_status()

    def _poll(self) -> None:
        """Repaint only when the background cache actually changed."""
        changed = (
            self.cache.last_refresh != self._rendered_at
            or self.cache.refreshing != self._was_refreshing
            or self.cache.streaming != self._was_streaming
        )
        if changed:
            self._rendered_at = self.cache.last_refresh
            self._was_refreshing = self.cache.refreshing
            self._was_streaming = self.cache.streaming
            self._render_hosts()
            self._render_status()

        # Appearance is checked far less often than status: on macOS the dark
        # mode probe shells out to `defaults`, and doing that twice a second
        # for the life of the app would be absurd.
        self._ticks += 1
        if self._ticks % 14 == 0:
            if (ui.system_dark() != self.theme.dark
                    or abs(ui.screen_dpi(self.root) - self.theme.dpi) > 1):
                self._rebuild()

        self.root.after(700, self._poll)

    def run(self) -> None:
        self.root.mainloop()
        self.cache.stop()


def main() -> int:
    RemoteWindow().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())

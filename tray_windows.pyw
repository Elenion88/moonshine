"""
remote - Windows system tray app.

Run with pythonw.exe so no console window appears. Use --install-autostart to
register it to launch at login, --uninstall-autostart to remove it.
"""

from __future__ import annotations

import os
import sys
import winreg

import pystray
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brand  # noqa: E402
import moonshine  # noqa: E402
import traycore  # noqa: E402
import ui  # noqa: E402

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = f"{brand.APP_ID}-tray"

APP_NAME = brand.NAME


# --------------------------------------------------------------------------
# Icon
# --------------------------------------------------------------------------

def make_icon(health: str) -> Image.Image:
    """A rounded tile in the status colour, carrying a white screen.

    The previous icon drew a full monitor - bezel, stand, base - in 64 pixels,
    and the tray shows 16. Every one of those details collapsed into a grey
    smear. This is the same information with one shape and one colour, drawn
    oversampled so the corners stay clean at the size it is actually seen at.
    """
    return ui.glyph_image(64, traycore.HEALTH_HEX[health])


# --------------------------------------------------------------------------
# Autostart
# --------------------------------------------------------------------------

def autostart_command() -> str:
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if not os.path.exists(pythonw):
        pythonw = sys.executable
    return f'"{pythonw}" "{os.path.abspath(__file__)}"'


# The value was named `remote-tray` until 2026-08-20 and points at a path that
# no longer exists. Windows does not report a broken Run entry - it fails
# silently at login - so it has to be cleared deliberately rather than left to
# be noticed.
OLD_RUN_VALUE = "remote-tray"


def _drop_old_run_value() -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0,
                            winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, OLD_RUN_VALUE)
    except OSError:
        pass


def autostart_enabled() -> bool:
    _drop_old_run_value()
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, RUN_VALUE)
            return value == autostart_command()
    except FileNotFoundError:
        return False


def set_autostart(enabled: bool) -> None:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, RUN_VALUE, 0, winreg.REG_SZ, autostart_command())
        else:
            try:
                winreg.DeleteValue(key, RUN_VALUE)
            except FileNotFoundError:
                pass


# --------------------------------------------------------------------------
# Menu
# --------------------------------------------------------------------------

class TrayApp:
    def __init__(self) -> None:
        self.overlay = False
        self.cache = traycore.StatusCache()
        self.icon = pystray.Icon(
            APP_NAME, make_icon("offline"), APP_NAME, menu=self.build_menu()
        )
        self.cache.on_change(self.on_status_change)

    def on_status_change(self) -> None:
        self.icon.icon = make_icon(self.cache.overall_health)
        self.icon.title = self.tooltip()
        self.icon.menu = self.build_menu()
        self.icon.update_menu()

    def tooltip(self) -> str:
        if self.cache.refreshing and not self.cache.hosts:
            return f"{APP_NAME}  ·  checking..."
        online = [h for h in self.cache.hosts if h.online]
        if not online:
            return f"{APP_NAME}  ·  no hosts online"
        best = min(
            (h for h in online if h.direct),
            key=lambda h: h.median if h.median is not None else 9999,
            default=None,
        )
        if best:
            return f"{APP_NAME}  ·  {best.name} direct {best.median:.0f} ms"
        return f"{APP_NAME}  ·  all paths relayed"

    def host_items(self, host: traycore.HostStatus) -> pystray.Menu:
        keys = traycore.profiles_for(host)
        items = [
            pystray.MenuItem(
                key.capitalize(),
                self._connect(host.name, key, "Desktop"),
                enabled=host.online,
            )
            for key in keys
        ]
        if "gaming" in keys:
            items.append(pystray.Menu.SEPARATOR)
            items.append(
                pystray.MenuItem(
                    "Steam Big Picture",
                    self._connect(host.name, "gaming", "Steam Big Picture"),
                    enabled=host.online,
                )
            )
        return pystray.Menu(*items)

    def _connect(self, host: str, profile: str, app: str):
        def action(icon, item):
            traycore.launch_session(host, profile, app, overlay=self.overlay)
        return action

    def _toggle_overlay(self, icon, item) -> None:
        self.overlay = not self.overlay

    def build_menu(self) -> pystray.Menu:
        items = []

        if not self.cache.hosts:
            items.append(
                pystray.MenuItem(
                    "Checking..." if self.cache.refreshing else "No hosts found",
                    None,
                    enabled=False,
                )
            )
        else:
            for host in self.cache.hosts:
                dot = traycore.HEALTH_DOT[host.health]
                items.append(
                    pystray.MenuItem(
                        f"{dot}  {host.label}",
                        self.host_items(host),
                        enabled=host.online,
                    )
                )

        items += [
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "Session in progress - status paused" if self.cache.streaming
                else ("Refreshing..." if self.cache.refreshing else "Refresh"),
                lambda icon, item: self.cache.refresh_soon(force=True),
                enabled=not self.cache.refreshing,
            ),
            pystray.MenuItem(
                "Show latency overlay",
                self._toggle_overlay,
                checked=lambda item: self.overlay,
            ),
            pystray.MenuItem(
                "Session logs",
                lambda icon, item: os.startfile(moonshine.sessions_dir()),
            ),
            pystray.MenuItem(
                "Set up this PC as a host...",
                lambda icon, item: traycore.run_setup(),
            ),
            pystray.MenuItem(
                "Start at login",
                lambda icon, item: set_autostart(not autostart_enabled()),
                checked=lambda item: autostart_enabled(),
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", self.quit),
        ]
        return pystray.Menu(*items)

    def quit(self, icon, item) -> None:
        self.cache.stop()
        icon.stop()

    def run(self) -> None:
        self.cache.start()
        self.icon.run()


def main() -> int:
    if "--install-autostart" in sys.argv:
        set_autostart(True)
        print("autostart enabled")
        return 0
    if "--uninstall-autostart" in sys.argv:
        set_autostart(False)
        print("autostart disabled")
        return 0
    TrayApp().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())

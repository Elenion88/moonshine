"""
remote - macOS menu bar app.

Use --install-autostart to register a LaunchAgent that starts it at login,
--uninstall-autostart to remove it.
"""

from __future__ import annotations

import os
import subprocess
import sys

import rumps  # noqa: I001

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brand  # noqa: E402
import moonshine  # noqa: E402
import traycore  # noqa: E402

LAUNCH_AGENT_LABEL = brand.LAUNCH_AGENT_LABEL
LAUNCH_AGENT_PATH = os.path.expanduser(
    f"~/Library/LaunchAgents/{LAUNCH_AGENT_LABEL}.plist"
)

PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
{args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/moonshine-tray.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/moonshine-tray.log</string>
</dict>
</plist>
"""


APP_BUNDLE_CANDIDATES = [
    os.path.expanduser(f"~/Applications/{brand.APP_BUNDLE}/Contents/MacOS/{brand.NAME}"),
    os.path.expanduser(f"~/.local/share/{brand.APP_ID}/{brand.APP_BUNDLE}/Contents/MacOS/{brand.NAME}"),
]


def find_app_bundle() -> str | None:
    for path in APP_BUNDLE_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def install_autostart() -> None:
    os.makedirs(os.path.dirname(LAUNCH_AGENT_PATH), exist_ok=True)

    # Always launch this script directly. Moonshine.app is the *window* app now, so
    # pointing the agent at the bundle would open a window at every login.
    program, script = sys.executable, os.path.abspath(__file__)

    args = f"        <string>{program}</string>\n"
    if script:
        args += f"        <string>{script}</string>\n"

    with open(LAUNCH_AGENT_PATH, "w") as fh:
        fh.write(PLIST.format(label=LAUNCH_AGENT_LABEL, args=args.rstrip("\n")))
    uid = os.getuid()
    # bootout first so a re-install replaces cleanly; it fails harmlessly if absent.
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LAUNCH_AGENT_LABEL}"],
                   capture_output=True)
    subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", LAUNCH_AGENT_PATH],
                   capture_output=True)
    print(f"autostart installed: {LAUNCH_AGENT_PATH}")


def uninstall_autostart() -> None:
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LAUNCH_AGENT_LABEL}"],
                   capture_output=True)
    if os.path.exists(LAUNCH_AGENT_PATH):
        os.remove(LAUNCH_AGENT_PATH)
    print("autostart removed")


def autostart_enabled() -> bool:
    return os.path.exists(LAUNCH_AGENT_PATH)


class RemoteApp(rumps.App):
    def __init__(self) -> None:
        super().__init__(brand.NAME, title=traycore.HEALTH_TITLE["offline"],
                         quit_button=None)
        self.overlay = False
        self.cache = traycore.StatusCache()
        self._last_rendered = -1.0
        self._was_refreshing = False
        self._was_streaming = False
        self.rebuild_menu()

    # rumps requires menu mutation on the main thread, so the background cache
    # only stores data - this timer picks up changes and re-renders.
    @rumps.timer(2)
    def tick(self, _) -> None:
        changed = (
            self.cache.last_refresh != self._last_rendered
            or self.cache.refreshing != self._was_refreshing
            or self.cache.streaming != self._was_streaming
        )
        if changed:
            self._last_rendered = self.cache.last_refresh
            self._was_refreshing = self.cache.refreshing
            self._was_streaming = self.cache.streaming
            self.rebuild_menu()

    def rebuild_menu(self) -> None:
        self.title = traycore.HEALTH_TITLE[self.cache.overall_health]
        print(f"[remote] menu rebuilt: title={self.title!r} "
              f"health={self.cache.overall_health} hosts={len(self.cache.hosts)}",
              flush=True)
        self.menu.clear()

        items = []
        if not self.cache.hosts:
            placeholder = rumps.MenuItem(
                "Checking..." if self.cache.refreshing else "No hosts found"
            )
            placeholder.set_callback(None)
            items.append(placeholder)
        else:
            for host in self.cache.hosts:
                dot = traycore.HEALTH_DOT[host.health]
                parent = rumps.MenuItem(f"{dot}  {host.label}")
                if host.online:
                    keys = traycore.profiles_for(host)
                    for key in keys:
                        parent.add(
                            rumps.MenuItem(
                                key.capitalize(),
                                callback=self._connect(host.name, key, "Desktop"),
                            )
                        )
                    if "gaming" in keys:
                        parent.add(rumps.separator)
                        parent.add(
                            rumps.MenuItem(
                                "Steam Big Picture",
                                callback=self._connect(
                                    host.name, "gaming", "Steam Big Picture"
                                ),
                            )
                        )
                else:
                    parent.set_callback(None)
                items.append(parent)

        items.append(rumps.separator)

        if self.cache.streaming:
            label = "Session in progress - status paused"
        elif self.cache.refreshing:
            label = "Refreshing..."
        else:
            label = "Refresh"
        refresh = rumps.MenuItem(
            label, callback=None if self.cache.refreshing else self.on_refresh)
        items.append(refresh)

        overlay_item = rumps.MenuItem("Show latency overlay",
                                      callback=self.on_toggle_overlay)
        overlay_item.state = 1 if self.overlay else 0
        items.append(overlay_item)

        items.append(rumps.MenuItem("Session logs", callback=self.on_open_logs))
        items.append(rumps.MenuItem("Set up this Mac as a host...",
                                    callback=self.on_setup))

        autostart = rumps.MenuItem("Start at login", callback=self.on_toggle_autostart)
        autostart.state = 1 if autostart_enabled() else 0
        items.append(autostart)

        items.append(rumps.separator)
        items.append(rumps.MenuItem("Quit", callback=self.on_quit))

        self.menu = items

    def _connect(self, host: str, profile: str, app: str):
        def action(_):
            traycore.launch_session(host, profile, app, overlay=self.overlay)
        return action

    def on_toggle_overlay(self, sender) -> None:
        self.overlay = not self.overlay
        sender.state = 1 if self.overlay else 0

    def on_open_logs(self, _) -> None:
        subprocess.Popen(["open", moonshine.sessions_dir()])

    def on_refresh(self, _) -> None:
        self.cache.refresh_soon(force=True)

    def on_setup(self, _) -> None:
        traycore.run_setup()

    def on_toggle_autostart(self, sender) -> None:
        if autostart_enabled():
            uninstall_autostart()
        else:
            install_autostart()
        sender.state = 1 if autostart_enabled() else 0

    def on_quit(self, _) -> None:
        self.cache.stop()
        rumps.quit_application()

    def run(self, **kwargs):
        self.cache.start()
        super().run(**kwargs)


def main() -> int:
    if "--install-autostart" in sys.argv:
        install_autostart()
        return 0
    if "--uninstall-autostart" in sys.argv:
        uninstall_autostart()
        return 0

    # Logged so a menu bar item that never appears can be told apart from a
    # process that died silently. Goes to /tmp/moonshine-tray.log via the plist.
    print(f"[remote] starting, python={sys.executable}", flush=True)
    print(f"[remote] bundle={os.environ.get('__CFBundleIdentifier', '(none)')}",
          flush=True)
    app = RemoteApp()
    print(f"[remote] app constructed, title={app.title!r}", flush=True)
    app.run()
    print("[remote] run loop exited", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

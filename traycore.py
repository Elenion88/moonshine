# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""
Shared logic for the remote tray/menu-bar apps.

Keeps the platform frontends thin: they render a menu and an icon, this module
decides what goes in them. Status is refreshed on a background thread and cached,
because measuring a path costs about a second per ping and the menu has to open
instantly.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import moonshine  # noqa: E402  - the CLI module, reused for tailscale + profiles

# Machines worth offering a stream from. Phones are on the tailnet but can't host.
STREAMABLE_OS = {"windows", "macos", "linux"}

REFRESH_SECONDS = 60
PINGS_PER_REFRESH = 3

# How long to wait between checks while a session is running. Short, because we
# want to resume normal refreshing promptly once the stream ends.
STREAMING_POLL_SECONDS = 15


def is_streaming() -> bool:
    """True while a stream is actually in progress, on either side of it.

    Refreshing status during a session is actively harmful. Measuring a path
    means running `tailscale ping` against every online host, a few seconds
    each, so one refresh is roughly fifteen seconds of continuous probing - and
    with a tray app and a window app on each of two machines, each on its own
    timer, that lands often enough to sit on top of a stream. Austin saw picture
    and audio alternate clean and rough in 11-26 second stretches, which is this.

    Two checks, because a machine can be either end of a session:

    * client - a marker file written by `remote connect` for the life of the
      session, so it is recorded rather than inferred;
    * host - Sunshine's own log, whose last CLIENT CONNECTED/DISCONNECTED line
      says whether a client is attached right now.

    Both earlier attempts were wrong, and the reasons are worth keeping.
    Matching on process name reported true almost permanently, because Moonlight
    lingers for hours after a session ends - three were still resident. Looking
    for an established TCP connection on Sunshine's control port never fired at
    all, because the session runs over UDP: the TCP port is used for setup and
    then closed, so it only ever shows LISTEN.
    """
    marker = moonshine.session_marker_path()
    if os.path.exists(marker):
        try:
            age = time.time() - os.path.getmtime(marker)
        except OSError:
            age = 0.0
        # The marker is removed in a finally block, so it outlives its session
        # only if the process was killed outright. Ignore very stale ones.
        if age < 12 * 3600:
            return True

    if moonshine.host_session_active():
        return True

    return _moonlight_streaming()


def _moonlight_streaming() -> bool:
    """Fallback for sessions this tool did not start.

    Matches on `stream` in the command line, not merely on the process
    existing - the leftover Moonlight processes are `list` and `pair`
    invocations, and counting those made every check report a session.
    """
    try:
        if sys.platform == "win32":
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "(Get-CimInstance Win32_Process -Filter \"Name='Moonlight.exe'\")"
                 ".CommandLine"],
                capture_output=True, text=True, timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            return any(" stream " in line for line in proc.stdout.splitlines())
        proc = subprocess.run(
            ["pgrep", "-f", "MacOS/Moonlight stream"],
            capture_output=True, text=True, timeout=10,
        )
        return proc.returncode == 0 and bool(proc.stdout.strip())
    except (subprocess.TimeoutExpired, OSError):
        return False


# Latency past this reads as "direct but degraded" rather than healthy. One 60fps
# frame is 16.7ms, so a median above that means the path itself is eating frames.
DEGRADED_MS = 17.0


@dataclass
class HostStatus:
    name: str
    os: str
    ip: str
    online: bool
    direct: bool = False
    median: float | None = None
    jitter: float | None = None
    relay: str | None = None

    @property
    def health(self) -> str:
        """One of: ok, degraded, relayed, offline."""
        if not self.online:
            return "offline"
        if not self.direct:
            return "relayed"
        if self.median is not None and self.median > DEGRADED_MS:
            return "degraded"
        return "ok"

    @property
    def label(self) -> str:
        if not self.online:
            return f"{self.name}  ·  offline"
        if not self.direct:
            return f"{self.name}  ·  relayed via {self.relay}"
        parts = [f"{self.median:.0f} ms"] if self.median is not None else []
        if self.jitter is not None:
            parts.append(f"±{self.jitter:.0f} ms")
        return f"{self.name}  ·  direct  ·  {'  '.join(parts)}"


# Glyph shown beside each host inside the menu. Emoji is fine here - it sits in
# a list next to text, on a normal menu background.
HEALTH_DOT = {"ok": "🟢", "degraded": "🟡", "relayed": "🔴", "offline": "⚪"}

# Glyph for the macOS menu bar itself, where emoji is a bad choice: its colours
# are fixed, so a white circle on a light menu bar is invisible. Text glyphs
# inherit the menu bar's own colour and therefore render in both themes. Healthy
# and idle states use text and stay quiet; only problems use a loud colour.
HEALTH_TITLE = {"ok": "●", "degraded": "🟡", "relayed": "🔴", "offline": "○"}

# Tile colour for the drawn Windows tray icon. Kept in step with the window's
# palette (ui.DARK["health"]) so the same status is the same colour everywhere.
HEALTH_HEX = {
    "ok": "#3ED598",
    "degraded": "#F5B23D",
    "relayed": "#FF6B6B",
    "offline": "#7C838F",
}


class StatusCache:
    """Polls Tailscale in the background so opening the menu is instant."""

    def __init__(self) -> None:
        self.hosts: list[HostStatus] = []
        self.last_refresh: float = 0.0
        self.refreshing = False
        self.streaming = False
        self._lock = threading.Lock()
        self._listeners: list = []
        self._stop = threading.Event()

    def on_change(self, callback) -> None:
        self._listeners.append(callback)

    def _notify(self) -> None:
        for callback in self._listeners:
            try:
                callback()
            except Exception:
                pass

    @property
    def overall_health(self) -> str:
        """Worst-case health across hosts we could actually stream from."""
        usable = [h for h in self.hosts if h.online]
        if not usable:
            return "offline"
        if any(h.health == "ok" for h in usable):
            return "ok"
        if any(h.health == "degraded" for h in usable):
            return "degraded"
        return "relayed"

    def refresh(self, force: bool = False) -> None:
        # Never probe the network out from under a live session.
        if not force and is_streaming():
            self.streaming = True
            self._notify()
            return
        self.streaming = False

        with self._lock:
            if self.refreshing:
                return
            self.refreshing = True
        self._notify()
        try:
            ts = moonshine.find_binary("tailscale", moonshine.TAILSCALE_CANDIDATES)
            # Re-read each cycle so `remote hide` takes effect without a restart.
            hidden = moonshine.hidden_hosts()
            peers = [
                p for p in moonshine.tailscale_peers(ts)
                if p.os.lower() in STREAMABLE_OS and p.name not in hidden
            ]

            results = []
            for peer in peers:
                status = HostStatus(
                    name=peer.name, os=peer.os, ip=peer.ip, online=peer.online
                )
                if peer.online:
                    report = moonshine.measure_path(ts, peer.name, count=PINGS_PER_REFRESH)
                    status.direct = report.is_direct
                    status.median = report.median
                    status.jitter = report.jitter
                    status.relay = report.relay
                results.append(status)

            self.hosts = results
            self.last_refresh = time.time()
        except SystemExit:
            # find_binary calls die() when tailscale is missing; keep the app alive.
            self.hosts = []
        except Exception:
            self.hosts = []
        finally:
            self.refreshing = False
            self._notify()

    def start(self) -> None:
        def loop():
            while not self._stop.is_set():
                self.refresh()
                # While streaming, poll often but cheaply - is_streaming() is a
                # process check, not network traffic - so status comes back
                # quickly once the session ends.
                self._stop.wait(
                    STREAMING_POLL_SECONDS if self.streaming else REFRESH_SECONDS
                )

        threading.Thread(target=loop, daemon=True).start()

    def refresh_soon(self, force: bool = False) -> None:
        threading.Thread(target=self.refresh, args=(force,), daemon=True).start()

    def stop(self) -> None:
        self._stop.set()


def profiles_for(host: HostStatus) -> list[str]:
    """Profiles that make sense for a given host.

    Offering "Gaming" for a macOS host is noise - that machine is something you
    drive a desktop on, and the profile it needs is the one that forwards the
    Command key.
    """
    if host.os.lower() == "macos":
        return ["mac"]
    return ["desktop", "gaming"]


def run_setup() -> None:
    """Run `moonshine setup` in a visible terminal so its output can be read."""
    argv = moonshine.cli_command() + ["setup"]

    if sys.platform == "win32":
        quoted = " ".join(f'"{part}"' for part in argv)
        subprocess.Popen(
            ["cmd", "/c", "start", "", "cmd", "/k", quoted],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    else:
        # osascript so the output lands in Terminal rather than a log file the
        # user would have to know about.
        cmd = " ".join(shlex_quote(part) for part in argv)
        subprocess.Popen(
            ["osascript", "-e",
             f'tell application "Terminal" to do script "{cmd}"',
             "-e", 'tell application "Terminal" to activate'],
            start_new_session=True,
        )


def shlex_quote(value: str) -> str:
    import shlex
    return shlex.quote(value)


def launch_session(host: str, profile: str, app: str = "Desktop",
                   overlay: bool = False) -> None:
    """Start a stream via the CLI, so the path gate and session log still apply."""
    cmd = moonshine.cli_command() + ["connect", host, app, "--profile", profile]
    if overlay:
        cmd.append("--overlay")

    kwargs: dict = {}
    if sys.platform == "win32":
        # Detach so the tray app isn't the parent, and show no console window.
        kwargs["creationflags"] = (
            subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
        )
    else:
        kwargs["start_new_session"] = True

    subprocess.Popen(cmd, **kwargs)

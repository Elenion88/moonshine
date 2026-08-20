#!/usr/bin/env python3
"""
moonshine - low-latency remote desktop over Tailscale.

Moonlight decodes, Sunshine encodes; Moonshine is the part that makes the two
behave like one product.

Wraps Sunshine (host) and Moonlight (client) with the piece neither provides:
a check that the Tailscale path is actually *direct* before a session starts.

A relayed path is the failure mode that matters here. Tailscale falls back to a
shared DERP relay whenever NAT traversal fails, and it does so silently - the
peer still shows as online and the internet still works. The result is ~50ms of
TCP-relayed latency instead of single-digit UDP, which no encoder setting can
compensate for. `connect` refuses to start a session over a relay unless you
pass --force, so a bad path gets reported instead of being mistaken for a
software problem.

Usage:
    moonshine list                 Show tailnet peers and their path quality
    moonshine check <host>         Verify the path to a host is direct
    moonshine bench <host>         Latency and jitter benchmark
    moonshine connect <host>       Start a streaming session
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import shutil
import socket
import statistics
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime

import brand
import chrome
from brand import APP_ID

# --------------------------------------------------------------------------
# Locating the binaries we drive
# --------------------------------------------------------------------------

TAILSCALE_CANDIDATES = [
    r"C:\Program Files\Tailscale\tailscale.exe",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/bin/tailscale",
]

# Order matters. The macOS app bundle MUST come before /opt/homebrew/bin/moonlight,
# which is only a symlink into the bundle: Qt resolves its plugin directory
# relative to the executable path, so launching through the symlink makes it look
# in /opt/homebrew/PlugIns, find no qtquickcontrols2plugin, and die instantly with
#     QQmlApplicationEngine failed to load component
# `pair` and `list` survive that because they never start the QML GUI - only
# `stream` does, which is why streaming failed while pairing worked.
MOONLIGHT_CANDIDATES = [
    "/Applications/Moonlight.app/Contents/MacOS/Moonlight",
    r"C:\Program Files\Moonlight Game Streaming\Moonlight.exe",
    "/opt/homebrew/bin/moonlight",
    "/usr/local/bin/moonlight",
    "/usr/bin/moonlight",
]


# --------------------------------------------------------------------------
# Terminal styling
#
# `moonshine setup` is opened in a fresh console window by the tray and window
# apps, so its output is a user interface whether or not it was meant to be
# one. Colour is applied to the parts that carry a verdict and nowhere else.
#
# Everything degrades: no codes when the output is piped or NO_COLOR is set,
# and the tick and cross fall back to ASCII when the stream cannot encode them,
# which is exactly what happens when Windows hands us a cp1252 pipe.
# --------------------------------------------------------------------------

def _colour_enabled() -> bool:
    # sys.stdout is None under pythonw.exe, which is how the tray and the
    # Start Menu shortcut both run. Touching it unguarded takes those down at
    # import time, with no console to show the traceback in.
    if sys.stdout is None or os.environ.get("NO_COLOR") is not None:
        return False
    if not sys.stdout.isatty() or os.environ.get("TERM") == "dumb":
        return False
    if sys.platform == "win32":
        # Windows Terminal understands ANSI already; conhost needs telling.
        try:
            import ctypes

            handle = ctypes.windll.kernel32.GetStdHandle(-11)
            mode = ctypes.c_uint32()
            if not ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                return False
            ctypes.windll.kernel32.SetConsoleMode(handle, mode.value | 0x0004)
        except Exception:
            return False
    return True


COLOUR = _colour_enabled()

_CODES = {
    "bold": "1", "dim": "2",
    "green": "32", "yellow": "33", "red": "31", "blue": "34", "cyan": "36",
}


def paint(text: str, *styles: str) -> str:
    if not COLOUR or not styles:
        return text
    codes = ";".join(_CODES[s] for s in styles)
    return f"\033[{codes}m{text}\033[0m"


ANSI_RE = re.compile(r"\033\[[0-9;]*m")


def unpaint(text: str) -> str:
    """Strip styling. Anything written to a file goes through here - a session
    log full of escape codes is worse than one with no colour in it."""
    return ANSI_RE.sub("", text)


def _encodable(text: str) -> bool:
    try:
        text.encode(getattr(sys.stdout, "encoding", None) or "ascii")
        return True
    except (UnicodeEncodeError, LookupError):
        return False


UNICODE_OK = _encodable("✓─·")

# (unicode glyph, ascii fallback, colour)
MARKS = {
    "ok": ("✓", "ok", "green"),
    "bad": ("✗", "x", "red"),
    "warn": ("!", "!", "yellow"),
    "info": ("?", "?", "blue"),
}


def status_line(kind: str, text: str, indent: str = "  ") -> None:
    """One status line: a coloured glyph, then plain text."""
    fancy, plain, colour = MARKS[kind]
    glyph = fancy if UNICODE_OK else plain
    print(f"{indent}{paint(glyph, colour)}  {text}")


def heading(text: str) -> None:
    rule = ("─" if UNICODE_OK else "-") * len(text)
    print(f"{paint(text, 'bold')}\n{paint(rule, 'dim')}\n")


# Not `field`: dataclasses.field is imported above and PathReport depends on it.
def kv(name: str, value: str, width: int = 8, indent: str = "  ") -> None:
    print(f"{indent}{paint(name.ljust(width), 'dim')} {value}")


def find_binary(name: str, candidates: list[str]) -> str:
    """Return a usable path for `name`.

    Curated absolute paths are checked before PATH, because a PATH entry can be a
    symlink that breaks the program (see MOONLIGHT_CANDIDATES) and because
    launchd/Finder hand us a minimal PATH anyway.
    """
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    on_path = shutil.which(name)
    if on_path:
        return on_path
    die(
        f"could not find {name}.\n"
        f"  Looked on PATH and in:\n" + "\n".join(f"    {c}" for c in candidates)
    )


def die(message: str, code: int = 1) -> None:
    # Painted only when stdout is a terminal; stderr is assumed to follow it,
    # which it does in every way this is actually run.
    print(f"{paint(f'{APP_ID}:', 'red', 'bold')} {message}", file=sys.stderr)
    sys.exit(code)


def run(cmd: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    """Run a command and capture its output, without flashing a console window.

    tailscale.exe is a console program, so on Windows every invocation opens and
    closes a console window unless CREATE_NO_WINDOW is passed. From a background
    refresh that reads as the screen flickering.
    """
    kwargs: dict = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, **kwargs
        )
    except (FileNotFoundError, NotADirectoryError) as exc:
        # A missing tool is an ordinary answer here, not a crash. Over SSH the
        # PATH is far shorter than the one a login shell or an app bundle gets,
        # so `brew` and friends simply are not there - and every caller already
        # reads returncode or stdout to decide what to do.
        return subprocess.CompletedProcess(cmd, 127, "", str(exc))


# --------------------------------------------------------------------------
# Config
#
# Mainly a hide list. A machine can end up on the tailnet more than once - two
# Tailscale installs on one laptop each register their own node - and the extra
# entries are noise in a menu you are trying to click through quickly.
# --------------------------------------------------------------------------

def state_dir() -> str:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(base, APP_ID)
    return os.path.expanduser(f"~/.config/{APP_ID}")


def _migrate_state_dir() -> None:
    """Move state left behind by the pre-rename `remote` directory.

    The project was called `remote` until 2026-08-20. Renaming the state
    directory outright would strand the hide list and every recorded session
    log, and the two machines update on their own schedules - the Mac only
    picks this up whenever it next runs - so the move has to happen in code
    rather than as a one-off by hand. Runs once; after that the old path is
    gone and this is a single failed isdir() check.
    """
    new_dir = state_dir()
    if os.path.isdir(new_dir):
        return
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        old_dir = os.path.join(base, "remote")
    else:
        old_dir = os.path.expanduser("~/.config/remote")
    if not os.path.isdir(old_dir):
        return
    try:
        os.makedirs(os.path.dirname(new_dir), exist_ok=True)
        shutil.move(old_dir, new_dir)
    except OSError:
        # Not worth failing a session over: a fresh directory is created
        # below, and the only loss is the hide list and old logs.
        pass


def config_path() -> str:
    _migrate_state_dir()
    return os.path.join(state_dir(), "config.json")


def load_config() -> dict:
    try:
        with open(config_path()) as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_config(config: dict) -> None:
    path = config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(config, fh, indent=2)
        fh.write("\n")


def hidden_hosts() -> set[str]:
    return set(load_config().get("hide", []))


def asset_path(name: str) -> str:
    """An icon or image that ships beside the code, by filename."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", name)


def session_marker_path() -> str:
    return os.path.join(os.path.dirname(config_path()), "active-session")


def mark_session(active: bool) -> None:
    """Record that this machine is running a session, for the tray apps.

    Written by the process that owns the session, so it is exact - no guessing
    from process names, which was wrong twice: Moonlight lingers for hours after
    a session ends, and the session itself runs over UDP so there is no
    established TCP connection to look for either.
    """
    path = session_marker_path()
    try:
        if active:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as fh:
                fh.write(f"{os.getpid()}\n{time.time()}\n")
        elif os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


# Sunshine writes these on the host side either way round.
SUNSHINE_LOGS = [
    r"C:\Program Files\Sunshine\config\sunshine.log",
    os.path.expanduser("~/.config/sunshine/sunshine.log"),
]
SESSION_MARKERS = re.compile(r"CLIENT (CONNECTED|DISCONNECTED)")


def host_session_active() -> bool:
    """True if Sunshine on this machine currently has a client connected."""
    for path in SUNSHINE_LOGS:
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                markers = SESSION_MARKERS.findall(fh.read()[-200000:])
        except OSError:
            continue
        if markers and markers[-1] == "CONNECTED":
            return True
    return False


def sessions_dir() -> str:
    path = os.path.join(os.path.dirname(config_path()), "sessions")
    os.makedirs(path, exist_ok=True)
    return path


# Moonlight announces where it writes its own log, on both platforms:
#   Redirecting log output to /tmp/Moonlight-1786480353.log
MOONLIGHT_LOG_RE = re.compile(r"Redirecting log output to (.+\.log)")

# Moonlight logs plenty of transient noise - hosts going "offline", serverinfo
# retries - while it is still going to succeed. This is the one line that means
# it has given up, and it is what separates a slow start from a dead one.
CONNECT_FAILED_RE = re.compile(r"Qt Critical: Failed to connect to (.+)")

# Health signals Moonlight writes into its own log. Audio is listed first
# because it is the fragile one: video carries 20% FEC and can conceal a loss,
# while audio moves in 5ms packets inside a rigid 4-shard block - lose two and
# that audio is gone rather than merely degraded.
LOG_SIGNALS = [
    ("unrecoverable audio blocks", re.compile(r"Unable to recover audio")),
    ("dropped audio events", re.compile(r"Network dropped audio data")),
    ("audio queue overflows", re.compile(r"Audio packet queue overflow")),
    ("dropped video frames", re.compile(r"Network dropped \d+ frames")),
]

LATENCY_RE = re.compile(r"Average network latency: (\d+) ms \(variance: (\d+)")


def summarise_moonlight_log(text: str) -> list[str]:
    """Turn Moonlight's log into a few lines worth reading."""
    lines = []
    for label, pattern in LOG_SIGNALS:
        count = len(pattern.findall(text))
        if count:
            lines.append(f"  {label:<28} {count}")

    latencies = [(int(a), int(b)) for a, b in LATENCY_RE.findall(text)]
    if latencies:
        means = [a for a, _ in latencies]
        variances = [b for _, b in latencies]
        lines.append(f"  {'network latency':<28} "
                     f"mean {statistics.mean(means):.1f} ms, "
                     f"peak {max(means)} ms, "
                     f"peak variance {max(variances)} ms")
    return lines or ["  clean - no loss or latency events recorded"]


# --------------------------------------------------------------------------
# Tailscale
# --------------------------------------------------------------------------

@dataclass
class Peer:
    name: str
    hostname: str
    os: str
    online: bool
    ip: str
    # The address tailscale is actually using for this peer, e.g.
    # "192.168.0.195:41641" when the path is direct over the LAN, or empty when
    # the traffic is being relayed. This is what makes LAN-direct possible
    # without any discovery of our own.
    cur_addr: str = ""


def tailscale_peers(ts: str) -> list[Peer]:
    proc = run([ts, "status", "--json"])
    if proc.returncode != 0:
        die(f"`tailscale status` failed: {proc.stderr.strip()}")
    data = json.loads(proc.stdout)

    peers = []
    for entry in (data.get("Peer") or {}).values():
        ips = entry.get("TailscaleIPs") or []
        peers.append(
            Peer(
                name=(entry.get("DNSName") or "").split(".")[0],
                hostname=entry.get("HostName") or "",
                os=entry.get("OS") or "",
                online=bool(entry.get("Online")),
                ip=ips[0] if ips else "",
                cur_addr=entry.get("CurAddr") or "",
            )
        )
    # Unnamed entries are shared devices we can't address by name.
    return sorted((p for p in peers if p.name), key=lambda p: p.name)


# --------------------------------------------------------------------------
# LAN-direct
#
# Even on a direct path, Tailscale still moves every packet through userspace
# WireGuard. Measured against one machine reachable both ways:
#
#     ICMP via the tunnel (100.126.31.123) : 4.33 ms mean, 2-9 ms spread
#     ICMP over the LAN   (192.168.0.169)  : 0 ms, no spread at all
#
# So when both machines are on the same network there is about 4 ms and nearly
# all the jitter to reclaim by addressing the host directly. Tailscale already
# tells us the LAN address it is using, so this needs no discovery of our own -
# we just have to notice and use it.
# --------------------------------------------------------------------------

SUNSHINE_PORT = 47989


def _is_ip_literal(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def _is_private(address: str) -> bool:
    try:
        return ipaddress.ip_address(address).is_private
    except ValueError:
        return False


def _port_open(address: str, port: int, timeout: float = 1.0) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((address, port)) == 0


def measure_lan(address: str, port: int, count: int = 10) -> list[float]:
    """Time TCP connects as a latency proxy for the tunnel-free path.

    Not directly comparable to an ICMP round trip - a connect is a handshake
    plus accept - but it is measured against the exact port the stream uses, and
    the spread across samples is what matters for judging jitter.
    """
    timings: list[float] = []
    for _ in range(count):
        start = time.perf_counter()
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(3.0)
            if sock.connect_ex((address, port)) == 0:
                timings.append((time.perf_counter() - start) * 1000)
    return timings


def lan_endpoint(peer: Peer) -> str | None:
    """Return the peer's LAN address if we can reach Sunshine on it directly.

    Proving it by connecting is deliberate. Comparing subnets would guess; an
    actual connection accounts for firewalls, client isolation and VLANs, which
    is exactly the class of problem that made this project necessary.
    """
    if not peer.cur_addr:
        return None
    address = peer.cur_addr.rsplit(":", 1)[0].strip("[]")
    if not _is_private(address):
        return None
    return address if _port_open(address, SUNSHINE_PORT) else None


# `pong from macbook (100.80.245.37) via 192.168.0.195:52433 in 8ms`
# `pong from macbook (100.80.245.37) via DERP(den) in 49ms`
PONG_RE = re.compile(r"via\s+(?P<route>DERP\([a-z]+\)|[\d.]+:\d+)\s+in\s+(?P<ms>\d+)ms")


@dataclass
class PathReport:
    host: str
    samples: list[tuple[str, int]] = field(default_factory=list)  # (route, ms)
    unreachable: bool = False

    @property
    def direct_samples(self) -> list[int]:
        return [ms for route, ms in self.samples if not route.startswith("DERP")]

    @property
    def is_direct(self) -> bool:
        """Direct if the path settled on a direct route.

        Tailscale often relays the first packets while NAT traversal completes,
        so the tail of the run is what reflects the steady state - not the head.
        """
        if not self.samples:
            return False
        return not self.samples[-1][0].startswith("DERP")

    @property
    def relay(self) -> str | None:
        for route, _ in reversed(self.samples):
            if route.startswith("DERP"):
                return route
        return None

    @property
    def median(self) -> float | None:
        pool = self.direct_samples or [ms for _, ms in self.samples]
        return statistics.median(pool) if pool else None

    @property
    def jitter(self) -> float | None:
        pool = self.direct_samples or [ms for _, ms in self.samples]
        return statistics.stdev(pool) if len(pool) > 1 else None

    @property
    def worst(self) -> int | None:
        pool = self.direct_samples or [ms for _, ms in self.samples]
        return max(pool) if pool else None


def measure_path(ts: str, host: str, count: int = 10) -> PathReport:
    """Ping a peer `count` times and summarise the route and timing.

    One `tailscale ping -c N` rather than N calls of `-c 1`: same samples, a
    single process instead of N, and it lets tailscale report the route settling
    from relayed to direct within one run.
    """
    report = PathReport(host=host)
    try:
        # --until-direct=false is essential: by default `tailscale ping` stops
        # the moment it establishes a direct path, so -c N returns a single
        # sample and any jitter figure computed from it is meaningless.
        proc = run(
            [ts, "ping", "--until-direct=false", "-c", str(count), host],
            timeout=15 + 3 * count,
        )
    except subprocess.TimeoutExpired:
        report.unreachable = True
        return report

    for match in PONG_RE.finditer(proc.stdout):
        report.samples.append((match.group("route"), int(match.group("ms"))))
    report.unreachable = not report.samples
    return report


# --------------------------------------------------------------------------
# Streaming profiles
#
# Shared across profiles: HEVC (the RTX 3090 is Ampere, so NVENC has no AV1
# encoder), hardware decode, and V-Sync plus frame pacing off - both buffer a
# frame to smooth output, which is the opposite of what we want.
# --------------------------------------------------------------------------

COMMON_FLAGS = [
    "--video-codec", "HEVC",
    "--video-decoder", "hardware",
    "--no-vsync",
    "--no-frame-pacing",
    "--keep-awake",
]

# Moonlight's in-session shortcuts, all Ctrl+Alt+Shift + a letter. Worth keeping
# here because the useful ones are not guessable and there is no in-app menu.
SHORTCUTS = [
    ("D", "minimize the session, leaving it running"),
    ("K", "toggle system key capture (hand Alt-Tab back to Windows)"),
    ("Z", "release the mouse"),
    ("M", "switch absolute <-> relative mouse"),
    ("X", "toggle fullscreen"),
    ("S", "stats overlay"),
    ("V", "paste local clipboard as keystrokes"),
    ("Q", "quit the session"),
]

PROFILES: dict[str, dict] = {
    "desktop": {
        "description": "Dev and desktop work - sharp text, precise pointer",
        "fps": 60,
        "bitrate": 40000,
        "resolution": "1920x1200",
        # A real resizable window, not "borderless" - borderless is still a
        # screen-filling window and reads as fullscreen even though you can
        # Alt-Tab out of it. Desktop work means having the remote machine
        # alongside local windows, so windowed is the honest default.
        "display_mode": "windowed",
        "flags": [
            # 4:4:4 keeps small text legible. It costs roughly 30-50% more
            # bandwidth than 4:2:0, which is affordable on a LAN and is the
            # single biggest quality factor when reading code.
            "--yuv444",
            # Absolute mouse maps the pointer 1:1 instead of capturing it,
            # so the cursor behaves like a normal remote desktop.
            "--absolute-mouse",
            "--no-game-optimization",
            "--audio-config", "stereo",
        ],
    },
    "mac": {
        "description": "Control a macOS host from Windows - Command key forwarded",
        "fps": 60,
        # Was briefly dropped to 20 Mbps on the theory that video airtime was
        # starving audio packets. The session logs did not support it: 7 audio
        # events across 27 minutes cannot produce audio that breaks up every
        # minute, and the host logged no audio errors at all. Put back to 30.
        "bitrate": 30000,
        "resolution": "1920x1200",
        "display_mode": "windowed",
        "flags": [
            "--yuv444",
            "--absolute-mouse",
            "--no-game-optimization",
            # The whole reason this profile exists. Moonlight swallows
            # SDL_SCANCODE_LGUI locally unless system key capture is on:
            #
            #     case SDL_SCANCODE_LGUI:
            #         if (!isSystemKeyCaptureActive()) return;
            #         keyCode = 0x5B;
            #
            # Sunshine's macOS side already maps 0x5B to kVK_Command and injects
            # kCGEventFlagMaskCommand, so this single flag is what makes Cmd-C,
            # Cmd-Tab and Cmd-Space reach the Mac instead of the local machine.
            #
            # Trade-off: while streaming, the Windows key and Alt-Tab go to the
            # Mac rather than Windows. That is the intended behaviour here, and
            # Ctrl+Alt+Shift toggles it off mid-session if you need it back.
            "--capture-system-keys", "always",
            "--audio-config", "stereo",
        ],
    },
    "gaming": {
        "description": "Games - relative mouse, controllers, headroom for motion",
        # 120, not 60. The host was capped at 60 only because Windows had the
        # AW2724DM set to 59Hz; the panel does 2560x1440 at up to 165Hz, and
        # Sunshine cannot capture faster than the desktop is running. The cap
        # was never the Parsec Virtual Display Adapter's absence.
        #
        # 120 rather than 165 because it divides evenly into 165Hz-adjacent
        # capture and is what a client is likely to be able to present; raise
        # it per-session with `--fps` when both ends can take it.
        "fps": 120,
        # More frames need more bits to stay clean in motion. 50 Mbps at 60fps
        # is ~830 Kbit/frame; keeping that at 120fps means roughly doubling it.
        "bitrate": 80000,
        "resolution": "1920x1080",
        # Exclusive fullscreen: lowest latency path for games, and switching
        # away mid-game is not the common case.
        "display_mode": "fullscreen",
        "flags": [
            # 4:2:0 spends the bitrate on motion rather than chroma detail.
            "--no-yuv444",
            # Relative mouse capture is what games expect.
            "--no-absolute-mouse",
            "--game-optimization",
            "--multi-controller",
            "--audio-config", "stereo",
        ],
    },
}


# --------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------

def describe_path(report: PathReport) -> str:
    if report.unreachable:
        return paint("unreachable", "red")
    if report.is_direct:
        detail = paint(f"direct  {report.median:.0f}ms", "green")
    else:
        detail = paint(f"RELAYED via {report.relay}  {report.median:.0f}ms", "red")
    if report.jitter is not None:
        detail += paint(f"  (jitter {report.jitter:.1f}ms, worst {report.worst}ms)",
                        "dim")
    return detail


def print_path_verdict(report: PathReport) -> None:
    if report.is_direct:
        kv("route", paint("direct", "green", "bold"))
    else:
        kv("route", paint(f"RELAYED via {report.relay}", "red", "bold"))
    if report.median is not None:
        # One 60fps frame is the line between "fine" and "the path is the
        # problem", so the number is coloured on the same threshold the apps use.
        colour = "green" if report.median <= 17 else "yellow"
        kv("median", paint(f"{report.median:.0f} ms", colour))
    if report.jitter is not None:
        kv("jitter", f"{report.jitter:.1f} ms")
    if report.worst is not None:
        kv("worst", f"{report.worst} ms")
    kv("samples", str(len(report.samples)))


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Setup
#
# Does everything that can be done without a human, and for the one thing that
# cannot - granting TCC permissions - opens the exact settings pane and says
# precisely what to click. macOS deliberately makes Screen Recording and
# Accessibility ungrantable by any process, including one running as you; the
# only non-interactive path is an MDM profile pushed by IT. So this automates
# the services, config and verification around that single click.
# --------------------------------------------------------------------------

SUNSHINE_MACOS_CANDIDATES = [
    "/opt/homebrew/opt/sunshine/bin/sunshine",
    "/usr/local/opt/sunshine/bin/sunshine",
]

SETTINGS_PANES = {
    "Screen Recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    "Accessibility": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
}

# Sunshine runs from a LaunchAgent on macOS, not a brew service - the tap it
# came from is untrusted by current Homebrew, so `brew services` cannot even
# read the formula. This label is what launchctl answers to.
MACOS_AGENT = "homebrew.mxcl.sunshine"


def _sunshine_macos_bin() -> str | None:
    for path in SUNSHINE_MACOS_CANDIDATES:
        if os.path.exists(path):
            return os.path.realpath(path)
    return None


TCC_DBS = [
    "/Library/Application Support/com.apple.TCC/TCC.db",
    os.path.expanduser("~/Library/Application Support/com.apple.TCC/TCC.db"),
]

# What Sunshine actually needs, and what breaks without each one. PostEvent is
# the subtle one: it governs CGEventPost to the HID tap, which is how mouse
# input is injected, so losing it kills the pointer while the keyboard keeps
# working through the session tap.
REQUIRED_TCC = {
    "kTCCServiceScreenCapture": "Screen Recording - video capture",
    "kTCCServiceAccessibility": "Accessibility - input injection",
    "kTCCServicePostEvent": "Post Event - mouse movement",
}


def _tcc_grants(binary: str) -> dict[str, int] | None:
    """Read the granted TCC services for a binary, or None if unreadable.

    The databases are usually protected, but where they can be read this turns
    "I cannot detect this permission, please go and check" into a real answer.
    """
    grants: dict[str, int] = {}
    readable = False
    for db in TCC_DBS:
        if not os.path.exists(db):
            continue
        proc = run([
            "sqlite3", db,
            f"select service, auth_value from access where client = '{binary}';",
        ], timeout=20)
        if proc.returncode != 0:
            continue
        readable = True
        for line in proc.stdout.splitlines():
            if "|" in line:
                service, value = line.rsplit("|", 1)
                try:
                    grants[service] = int(value)
                except ValueError:
                    pass
    return grants if readable else None


# dyld names the first library it could not find, and Homebrew's layout puts the
# formula name right there in the path: /opt/homebrew/opt/<formula>/lib/...
DYLD_MISSING_RE = re.compile(r"Library not loaded:\s*(\S+)")
HOMEBREW_FORMULA_RE = re.compile(r"/opt/homebrew/opt/([^/]+)/")


def _sunshine_libraries_ok(binary: str) -> tuple[bool, str]:
    """Check Sunshine can actually start, and name the formula if it cannot.

    This exists because of 2026-08-20, when Sunshine had been silently dead for
    days. Homebrew had pruned `curl` and `miniupnpc` out from under it, and the
    only symptom was that the Mac stopped answering on 47989 - which looks
    exactly like the Tailscale and firewall failures this project has hit
    before, so that is what got checked first. launchd knew the truth all along
    and filed it under `OS_REASON_DYLD`, where nobody was looking.

    One `--version` reproduces it in a second, and dyld names the missing
    library, so setup can print the command that fixes it.
    """
    proc = run([binary, "--version"], timeout=30)
    match = DYLD_MISSING_RE.search(f"{proc.stdout}{proc.stderr}")
    if not match:
        return True, "libraries resolve"

    library = match.group(1)
    formula = HOMEBREW_FORMULA_RE.search(library)
    remedy = (f"brew install {formula.group(1)}" if formula
              else f"reinstall whatever provides {library}")
    return False, f"cannot load {os.path.basename(library)} - {remedy}"


def _tap_is_trusted() -> tuple[bool, str]:
    """Check Homebrew will read Sunshine's formula, because autoremove depends on it.

    Sunshine comes from the third-party tap `lizardbyte/homebrew`. Current
    Homebrew refuses to read formulae from untrusted taps, and an unreadable
    formula has no visible dependencies - so `brew autoremove` concludes that
    nothing needs curl or miniupnpc and deletes them. That is the root cause of
    the failure `_sunshine_libraries_ok` detects, and it fires on a schedule:
    this Mac runs a weekly cache cleanup.
    """
    proc = run(["brew", "deps", "--installed", "sunshine"], timeout=60)
    if proc.returncode == 127:
        return True, ""  # no brew on PATH - not our business to report here
    if "untrusted tap" in f"{proc.stdout}{proc.stderr}":
        return False, ("Homebrew distrusts Sunshine's tap, so `brew autoremove` "
                       "cannot see\n      its dependencies and will delete them. "
                       "Fix it once with:")
    return True, ""


def _macos_log_verdict() -> tuple[bool, str]:
    """Read Sunshine's log to decide whether screen capture is actually working."""
    log = os.path.expanduser("~/.config/sunshine/sunshine.log")
    try:
        with open(log, errors="replace") as fh:
            text = fh.read()
    except FileNotFoundError:
        return False, "no log yet - has Sunshine run?"

    tail = text[-20000:]
    if "Unable to find display or encoder" in tail.split("Found H.264 encoder")[-1]:
        return False, "encoders failing - Screen Recording not granted"
    if "Found H.264 encoder" in tail or "Found HEVC encoder" in tail:
        return True, "hardware encoder initialised"
    return False, "no encoder result in log"


def setup_macos() -> int:
    heading("Setting up this Mac as a stream host")
    ok = True

    binary = _sunshine_macos_bin()
    if not binary:
        status_line("bad", "Sunshine is not installed.")
        print(paint("      brew tap LizardByte/homebrew && brew install sunshine",
                    "cyan"))
        return 1
    status_line("ok", "Sunshine installed")
    print(paint(f"       {binary}", "dim"))

    libraries_ok, detail = _sunshine_libraries_ok(binary)
    if libraries_ok:
        status_line("ok", f"Libraries - {detail}")
    else:
        ok = False
        status_line("bad", f"Libraries - {detail}")
        print(paint("      Sunshine cannot start at all until that is installed;"
                    " it will look\n      like a network fault from every other "
                    "machine.", "dim"))

    trusted, advice = _tap_is_trusted()
    if not trusted:
        ok = False
        status_line("warn", advice)
        print(paint("      brew trust lizardbyte/homebrew", "cyan"))

    # Branded before the restart rather than after, so one restart picks up both
    # the config change and the permissions check below - restarting Sunshine
    # twice in one setup drops any client that happens to be connected twice.
    brand_sunshine()

    # Not `brew services`: Sunshine is a plain LaunchAgent here, and its tap is
    # untrusted by current Homebrew, so brew refuses to read the formula at all.
    # launchctl talks to the agent that actually exists.
    print(paint("\n  Restarting Sunshine...", "dim"))
    restart_sunshine()
    time.sleep(10)

    capture_ok, detail = _macos_log_verdict()
    if capture_ok:
        status_line("ok", f"Encoder - {detail}")
    else:
        ok = False
        status_line("bad", f"Encoder - {detail}")

    print()
    grants = _tcc_grants(binary)
    missing: list[str] = []

    if grants is None:
        status_line("info", "Permissions - the TCC databases are not readable here, so")
        print("      these cannot be verified. Check them by hand if something")
        print("      misbehaves: no video means Screen Recording, a dead mouse")
        print("      means Accessibility.")
    else:
        for service, description in REQUIRED_TCC.items():
            if grants.get(service) == 2:
                status_line("ok", description)
            else:
                missing.append(service)
                ok = False
                status_line("bad", f"{description}  - {paint('NOT granted', 'red')}")

    if not missing:
        if grants is not None:
            print(paint("\n  All permissions granted. Nothing for you to click.",
                        "green"))
        return 0 if ok else 1

    # Only interrupt with a settings window when something is actually missing.
    print("\n  Opening the settings panes you need...")
    if "kTCCServiceScreenCapture" in missing:
        run(["open", SETTINGS_PANES["Screen Recording"]], timeout=30)
    if {"kTCCServiceAccessibility", "kTCCServicePostEvent"} & set(missing):
        run(["open", SETTINGS_PANES["Accessibility"]], timeout=30)

    print("\n  Add this binary to the list(s) (Cmd-Shift-G to paste the path):")
    print(paint(f"      {binary}", "cyan"))
    print("\n  Then re-run setup to verify.")
    return 1


SUNSHINE_CONFIG_DIRS = [
    r"C:\Program Files\Sunshine\config",
    os.path.expanduser("~/.config/sunshine"),
]


def sunshine_config_dir() -> str:
    """Sunshine's config directory on this machine, or "" if it has none."""
    for path in SUNSHINE_CONFIG_DIRS:
        if os.path.isdir(path):
            return path
    return ""


def brand_sunshine() -> bool:
    """Put our box art and host name into Sunshine's config, and say if it changed.

    Moonlight is Qt compiled into one executable and cannot be skinned, and
    Sunshine's own art lives under Program Files where every update replaces it.
    What is left is the config directory - apps.json, sunshine.conf, and the
    covers folder Sunshine's own cover downloader writes into. That is user
    data, it survives upgrades, and it is enough to own both the tiles and the
    name Moonlight puts on this machine.
    """
    config = sunshine_config_dir()
    if not config:
        status_line("warn", "no Sunshine config directory - skipping branding")
        return False

    changed = False

    covers = os.path.join(config, "covers")
    os.makedirs(covers, exist_ok=True)
    installed: dict[str, str] = {}
    for app_name, (_, filename) in brand.COVERS.items():
        source = asset_path(filename)
        if not os.path.exists(source):
            continue
        target = os.path.join(covers, filename)
        shutil.copyfile(source, target)
        installed[app_name] = target

    apps_path = os.path.join(config, "apps.json")
    try:
        with open(apps_path, encoding="utf-8") as fh:
            apps = json.load(fh)
    except (OSError, ValueError):
        apps = None

    if apps and isinstance(apps.get("apps"), list):
        for app in apps["apps"]:
            target = installed.get(app.get("name", ""))
            if target and app.get("image-path") != target:
                app["image-path"] = target
                changed = True
        if changed:
            with open(apps_path, "w", encoding="utf-8") as fh:
                json.dump(apps, fh, indent=2)
                fh.write("\n")
            status_line("ok", f"box art installed for {len(installed)} apps")
    else:
        status_line("warn", f"could not read {apps_path}")

    # Sunshine falls back to the raw hostname, so the tower announces itself as
    # `The_Tower`. An existing setting is left alone - that would be someone's
    # deliberate choice, and this runs on every setup.
    conf_path = os.path.join(config, "sunshine.conf")
    try:
        with open(conf_path, encoding="utf-8") as fh:
            conf = fh.read()
    except OSError:
        conf = None

    if conf is not None and not re.search(r"^\s*sunshine_name\s*=", conf, re.M):
        display = brand.host_display_name(socket.gethostname())
        with open(conf_path, "a", encoding="utf-8") as fh:
            fh.write("\n# The name Moonlight shows for this machine.\n")
            fh.write(f"sunshine_name = {display}\n")
        status_line("ok", f"Moonlight will show this host as {display}")
        changed = True

    return changed


def restart_sunshine() -> None:
    """Reload Sunshine so config changes take effect - unless someone is on it."""
    if host_session_active():
        status_line("warn", "a client is connected - restart Sunshine later to "
                            "pick up the new branding")
        return
    if sys.platform == "win32":
        run(["powershell", "-NoProfile", "-Command",
             "Restart-Service SunshineService -Force"], timeout=90)
    else:
        run(["launchctl", "kickstart", "-k",
             f"gui/{os.getuid()}/{MACOS_AGENT}"], timeout=60)
    status_line("ok", "Sunshine restarted")


def setup_windows() -> int:
    heading("Setting up this PC as a stream host")
    ok = True

    proc = run(["powershell", "-NoProfile", "-Command",
                "(Get-Service SunshineService -ErrorAction SilentlyContinue).Status"])
    status = proc.stdout.strip()
    if not status:
        status_line("bad", "Sunshine is not installed.")
        print(paint("      winget install LizardByte.Sunshine", "cyan"))
        return 1

    if status != "Running":
        status_line("warn", f"Sunshine service is {status} - starting it...")
        run(["powershell", "-NoProfile", "-Command",
             "Start-Service SunshineService"], timeout=60)
        status_line("ok", "Sunshine service started")
    else:
        status_line("ok", "Sunshine service running")

    proc = run(["powershell", "-NoProfile", "-Command",
                "(Get-NetFirewallRule -DisplayName 'Sunshine' | "
                "Get-NetFirewallAddressFilter).RemoteAddress -join ','"])
    remote_addr = proc.stdout.strip()
    if "100.64.0.0" in remote_addr:
        status_line("ok", "Firewall scoped to the tailnet")
    else:
        ok = False
        status_line("warn", f"Firewall is open to: {remote_addr or 'Any'}")
        print("      Scope it with (elevated):")
        print(paint("      Get-NetFirewallRule -DisplayName 'Sunshine' | "
                    "Set-NetFirewallRule -RemoteAddress 100.64.0.0/10", "cyan"))

    if brand_sunshine():
        restart_sunshine()

    print(paint("\n  Windows needs no capture permission - nothing else to grant.",
                "dim"))
    return 0 if ok else 1


def cmd_setup(args) -> int:
    if sys.platform == "darwin":
        return setup_macos()
    if sys.platform == "win32":
        return setup_windows()
    print(f"{APP_ID}: no setup routine for {sys.platform}")
    return 1


def cmd_logs(args) -> int:
    directory = sessions_dir()
    logs = sorted(
        (os.path.join(directory, name) for name in os.listdir(directory)
         if name.endswith(".log")),
        key=os.path.getmtime,
        reverse=True,
    )

    if not logs:
        print(f"No session logs yet. They land in {directory}")
        return 0

    if args.show:
        newest = logs[0]
        print(f"=== {newest} ===\n")
        with open(newest, encoding="utf-8", errors="replace") as fh:
            print(fh.read())
        return 0

    print(f"{directory}\n")
    for path in logs[: args.limit]:
        size = os.path.getsize(path)
        stamp = datetime.fromtimestamp(os.path.getmtime(path))
        print(f"  {stamp:%Y-%m-%d %H:%M}  {size / 1024:7.1f} KB  {os.path.basename(path)}")
    if len(logs) > args.limit:
        print(f"\n  ...and {len(logs) - args.limit} older")
    return 0


def cmd_display(args) -> int:
    """Show the host's displays, or change the primary's refresh rate.

    Sunshine captures the physical desktop, so the desktop's refresh rate is a
    hard ceiling on stream fps. This is the knob for that ceiling.
    """
    if sys.platform != "win32":
        die("display control is Windows-only")

    import display as display_mod

    monitors = display_mod.monitors()
    if not monitors:
        die("no active displays found")

    target = display_mod.primary() or monitors[0]

    if args.fps is None:
        heading("Displays")
        for monitor in monitors:
            glyph = paint("*", "cyan") if monitor.primary else " "
            print(f"  {glyph} {paint(monitor.name, 'bold')}  "
                  f"{monitor.width}x{monitor.height} "
                  f"@ {paint(str(monitor.refresh) + 'Hz', 'green')}")
            print(paint(f"      {monitor.adapter}", "dim"))
            rates = display_mod.refresh_rates(monitor.name, monitor.width,
                                              monitor.height)
            print(paint(f"      available: {', '.join(str(r) for r in rates)} Hz",
                        "dim"))
        print()
        print(paint(f"  Sunshine captures {target.name} at "
                    f"{target.refresh}Hz, so that is the fps ceiling.", "dim"))
        return 0

    rates = display_mod.refresh_rates(target.name, target.width, target.height)
    if args.fps not in rates:
        die(f"{target.name} does not support {args.fps}Hz at "
            f"{target.width}x{target.height}.\n"
            f"  Available: {', '.join(str(r) for r in rates)}")

    ok, message = display_mod.set_mode(target.name, target.width, target.height,
                                       args.fps)
    if not ok:
        die(f"could not set {args.fps}Hz: {message}")

    now = display_mod.primary()
    status_line("ok", f"{target.name} is now {now.width}x{now.height} "
                      f"@ {now.refresh}Hz")
    print(paint("      Restart Sunshine for it to pick up the new rate:\n"
                "      powershell -Command \"Restart-Service SunshineService\"",
                "dim"))
    return 0


def cmd_hide(args) -> int:
    config = load_config()
    hide = set(config.get("hide", []))
    hide.add(args.host)
    config["hide"] = sorted(hide)
    save_config(config)
    print(f"hiding {args.host}  ({config_path()})")
    return 0


def cmd_unhide(args) -> int:
    config = load_config()
    hide = set(config.get("hide", []))
    if args.host not in hide:
        print(f"{args.host} was not hidden")
        return 0
    hide.discard(args.host)
    config["hide"] = sorted(hide)
    save_config(config)
    print(f"showing {args.host} again")
    return 0


def cmd_list(args) -> int:
    ts = find_binary("tailscale", TAILSCALE_CANDIDATES)
    peers = tailscale_peers(ts)

    hidden = hidden_hosts()
    if hidden and not args.all:
        peers = [p for p in peers if p.name not in hidden]

    header = f"{'HOST':<22} {'OS':<9} {'IP':<16} STATUS"
    print(paint(header, "bold"))
    print(paint(("─" if UNICODE_OK else "-") * len(header), "dim"))
    for peer in peers:
        if not peer.online:
            status = paint("offline", "dim")
        elif args.quick:
            status = "online"
        else:
            status = describe_path(measure_path(ts, peer.name, count=3))
        suffix = paint("  (hidden)", "dim") if peer.name in hidden else ""
        name = peer.name if peer.online else paint(peer.name, "dim")
        # Padding is computed on the unpainted name: escape codes are zero
        # width on screen but very much not zero length to str.ljust.
        pad = " " * max(0, 22 - len(peer.name))
        print(f"{name}{pad} {peer.os:<9} {peer.ip:<16} {status}{suffix}")
    return 0


def _require_online(ts: str, host: str) -> None:
    """Fail fast on an offline peer instead of waiting out the ping timeout."""
    peers = {p.name: p for p in tailscale_peers(ts)}
    peer = peers.get(host)
    if peer is None:
        die(f"{host} is not on this tailnet.\n"
            f"  Known hosts: {', '.join(sorted(peers)) or '(none)'}")
    if not peer.online:
        die(f"{host} is offline - nothing to measure.")


def cmd_check(args) -> int:
    ts = find_binary("tailscale", TAILSCALE_CANDIDATES)
    _require_online(ts, args.host)
    heading(f"Path to {args.host}")
    # Measuring takes about a second per ping, so say so rather than leaving
    # the window blank underneath a heading.
    print(paint(f"  sampling {args.count} pings...", "dim"), flush=True)
    report = measure_path(ts, args.host, count=args.count)

    if report.unreachable:
        die(f"{args.host} is unreachable over Tailscale.")

    print_path_verdict(report)

    if not report.is_direct:
        print()
        print(f"  Traffic is going through the {paint(str(report.relay), 'bold')} "
              "relay rather than")
        print("  straight to the peer. Streaming over a relay will stutter no")
        print("  matter how the encoder is tuned. Common causes:")
        for cause in ("one machine is on a guest SSID with client isolation",
                      "a network blocks outbound UDP",
                      "Windows classified the network as Public"):
            print(f"    {paint('-', 'dim')} {cause}")
        return 1
    return 0


def cmd_bench(args) -> int:
    ts = find_binary("tailscale", TAILSCALE_CANDIDATES)
    _require_online(ts, args.host)
    heading(f"Benchmarking {args.host} - {args.count} samples")
    print(paint("  sampling...", "dim"), flush=True)
    report = measure_path(ts, args.host, count=args.count)

    if report.unreachable:
        die(f"{args.host} is unreachable over Tailscale.")

    print(paint("  through the Tailscale tunnel", "bold"))
    print_path_verdict(report)
    kv("raw", paint(", ".join(str(ms) for _, ms in report.samples), "dim"))

    # The tunnel figure is not what a session experiences when LAN-direct
    # applies, so measure the path the stream would actually take.
    peer = next((p for p in tailscale_peers(ts) if p.name == args.host), None)
    lan = lan_endpoint(peer) if peer else None
    if lan:
        timings = measure_lan(lan, SUNSHINE_PORT, count=args.count)
        if timings:
            print()
            print(paint(f"  direct to {lan} (what streaming actually uses)", "bold"))
            kv("median", f"{statistics.median(timings):.1f} ms")
            if len(timings) > 1:
                kv("jitter", f"{statistics.stdev(timings):.1f} ms")
            kv("worst", f"{max(timings):.1f} ms")
            print(paint("  (TCP connect timing, so it includes a handshake - "
                        "compare the spread, not the absolute value)", "dim"))

    # At 60fps a frame is 16.7ms, so anything past that is a visible hitch.
    frame_ms = 1000 / 60
    spikes = [ms for _, ms in report.samples if ms > frame_ms]
    if spikes:
        print()
        print(paint(f"  {len(spikes)} of {len(report.samples)} samples exceeded one "
                    f"60fps frame ({frame_ms:.1f}ms);", "yellow"))
        print(paint(f"  each is a visible hitch of about "
                    f"{max(spikes) / frame_ms:.0f} frames.", "yellow"))
    return 0


def watch_for_failure(log_path: str, proc) -> list[str]:
    """Tail our own log and stop Moonlight once it reports it cannot connect.

    Left alone a refused connection is oddly quiet: Moonlight falls back to its
    own host picker and sits there, so the session marker stays set, the window
    apps keep believing a stream is live, and the only sign of trouble is a line
    buried in a log. Watching for that line lets `connect` fail where it was
    started, which is where someone is actually looking.

    Returns a list that stays empty unless the session failed. It is filled in
    from the watcher thread, so read it only once the process has exited.
    """
    reason: list[str] = []

    def watch() -> None:
        offset = 0
        while proc.poll() is None:
            try:
                with open(log_path, encoding="utf-8", errors="replace") as fh:
                    fh.seek(offset)
                    chunk = fh.read()
                    offset = fh.tell()
            except OSError:
                chunk = ""
            match = CONNECT_FAILED_RE.search(chunk)
            if match:
                reason.append(match.group(1).strip())
                proc.terminate()
                return
            time.sleep(0.5)

    threading.Thread(target=watch, daemon=True).start()
    return reason


def cmd_connect(args) -> int:
    moonlight = find_binary("moonlight", MOONLIGHT_CANDIDATES)
    profile = PROFILES[args.profile]

    # A literal address bypasses Tailscale entirely - useful on your own LAN, and
    # the fallback when Tailscale itself is broken.
    if _is_ip_literal(args.host):
        if not _port_open(args.host, SUNSHINE_PORT, timeout=2.0):
            die(f"nothing is answering Sunshine on {args.host}:{SUNSHINE_PORT}.")
        print(f"Connecting straight to {args.host} (no Tailscale involved)")
        target = args.host
        path_summary = "direct by address, no Tailscale"
    else:
        ts = find_binary("tailscale", TAILSCALE_CANDIDATES)

        # The gate: never start a session over a relay by accident.
        print(paint(f"Checking path to {args.host} ...", "dim"), flush=True)
        report = measure_path(ts, args.host, count=args.check_count)

        if report.unreachable:
            die(f"{args.host} is unreachable over Tailscale.\n"
                f"  If Tailscale itself is down but you are on the same network,\n"
                f"  connect by address instead: moonshine connect <its LAN IP>")

        path_summary = describe_path(report)
        print(f"  {path_summary}")

        if not report.is_direct and not args.force:
            print()
            die(
                f"path to {args.host} is relayed through {report.relay}, not direct.\n"
                f"  Streaming over a relay will stutter regardless of encoder settings.\n"
                f"  Run `moonshine check {args.host}` for likely causes, or pass --force\n"
                f"  to connect anyway.",
                code=1,
            )

        # Prefer the LAN address when the host is on this network. Same machine,
        # same session - just without the tunnel in the middle.
        target = args.host
        if not args.no_lan:
            peer = next((p for p in tailscale_peers(ts) if p.name == args.host), None)
            if peer:
                lan = lan_endpoint(peer)
                if lan:
                    target = lan
                    print(f"  on your LAN - going direct to {lan}, skipping the tunnel")

    cmd = [moonlight, "stream", target, args.app]
    cmd += COMMON_FLAGS
    cmd += profile["flags"]
    cmd += ["--resolution", args.resolution or profile["resolution"]]
    cmd += ["--fps", str(args.fps or profile["fps"])]
    cmd += ["--bitrate", str(args.bitrate or profile["bitrate"])]
    cmd += ["--display-mode", args.display_mode or profile["display_mode"]]
    if args.overlay:
        cmd += ["--performance-overlay"]
    if args.hdr:
        cmd += ["--hdr"]

    print()
    print(paint(f"Starting '{args.app}' on {args.host}", "bold")
          + paint(f"  [{args.profile}]", "cyan"))
    print(paint(f"  {args.resolution or profile['resolution']} @ "
                f"{args.fps or profile['fps']}fps, "
                f"{(args.bitrate or profile['bitrate']) // 1000} Mbps, "
                f"{args.display_mode or profile['display_mode']}", "dim"))
    print()
    print("  In-session shortcuts (Ctrl+Alt+Shift + key):")
    for key, description in SHORTCUTS:
        print(f"    {paint(key, 'cyan')}   {paint(description, 'dim')}")

    if args.dry_run:
        print()
        print(paint("  " + " ".join(cmd), "dim"))
        return 0

    log_path = os.path.join(
        sessions_dir(),
        f"{datetime.now():%Y%m%d-%H%M%S}-{args.host.replace('.', '_')}-{args.profile}.log",
    )
    print(paint(f"\n  logging to {log_path}", "dim"))

    started = time.time()
    with open(log_path, "w", encoding="utf-8", errors="replace") as fh:
        fh.write(f"host      : {args.host}\n")
        fh.write(f"target    : {target}"
                 f"{'  (LAN-direct)' if target != args.host else ''}\n")
        fh.write(f"app       : {args.app}\n")
        fh.write(f"profile   : {args.profile}\n")
        fh.write(f"started   : {datetime.now():%Y-%m-%d %H:%M:%S}\n")
        if path_summary:
            fh.write(f"path      : {unpaint(path_summary)}\n")
        fh.write(f"command   : {' '.join(cmd)}\n")
        fh.write("\n--- moonlight output ---\n")
        fh.flush()

        mark_session(True)
        try:
            proc = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT)
            # Moonlight cannot be skinned, so its window is renamed from out
            # here instead. chrome.py explains why this runs for the whole
            # session rather than once at startup.
            chrome.brand(
                proc.pid,
                f"{brand.NAME} — {args.host}",
                asset_path(f"{brand.APP_ID}.ico"),
                lambda: proc.poll() is None,
            )
            failure = watch_for_failure(log_path, proc)
            proc.wait()
        finally:
            mark_session(False)

    duration = time.time() - started

    # Moonlight keeps its own, far more detailed log. Fold it in so one file has
    # everything - that log is where decode time and dropped frames live.
    captured = ""
    try:
        with open(log_path, encoding="utf-8", errors="replace") as fh:
            captured = fh.read()
    except OSError:
        pass

    match = MOONLIGHT_LOG_RE.search(captured)
    detail = ""
    if match and os.path.exists(match.group(1)):
        try:
            with open(match.group(1), encoding="utf-8", errors="replace") as ml:
                detail = ml.read()
        except OSError:
            pass

    summary = summarise_moonlight_log(detail) if detail else []

    with open(log_path, "a", encoding="utf-8", errors="replace") as fh:
        fh.write(f"\n--- session ended after {duration:.0f}s, exit {proc.returncode} ---\n")
        if summary:
            fh.write("\n--- health ---\n")
            fh.write("\n".join(summary) + "\n")
        if detail:
            fh.write(f"\n--- moonlight's own log ({match.group(1)}) ---\n")
            fh.write(detail)

    if failure:
        print()
        status_line("bad", f"Moonlight could not reach {failure[0]}")
        print("      Sunshine is not answering there - usually stopped, or")
        print("      holding a phantom session from an earlier stream.")
        print(paint(f"      moonshine check {args.host}", "cyan"))
    else:
        print(paint(f"  session ended after {duration:.0f}s", "bold"))
    if summary:
        print()
        for line in summary:
            print(line)
    print(paint(f"\n  log: {log_path}", "dim"))
    return 1 if failure else proc.returncode


# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=brand.APP_ID,
        description=f"{brand.NAME} - {brand.TAGLINE}",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="show tailnet peers and path quality")
    p_list.add_argument("--quick", action="store_true",
                        help="skip path measurement (much faster)")
    p_list.add_argument("--all", action="store_true",
                        help="include hidden hosts")
    p_list.set_defaults(func=cmd_list)

    p_logs = sub.add_parser("logs", help="list recorded session logs")
    p_logs.add_argument("--show", action="store_true",
                        help="print the most recent log in full")
    p_logs.add_argument("-n", "--limit", type=int, default=15)
    p_logs.set_defaults(func=cmd_logs)

    p_setup = sub.add_parser("setup", help="configure this machine as a host")
    p_setup.set_defaults(func=cmd_setup)

    p_display = sub.add_parser(
        "display", help="show host displays, or set the primary's refresh rate")
    p_display.add_argument("--fps", type=int, default=None, metavar="HZ",
                           help="set the primary display's refresh rate")
    p_display.set_defaults(func=cmd_display)

    p_hide = sub.add_parser("hide", help="hide a host from listings and the menu")
    p_hide.add_argument("host")
    p_hide.set_defaults(func=cmd_hide)

    p_unhide = sub.add_parser("unhide", help="stop hiding a host")
    p_unhide.add_argument("host")
    p_unhide.set_defaults(func=cmd_unhide)

    p_check = sub.add_parser("check", help="verify the path to a host is direct")
    p_check.add_argument("host")
    p_check.add_argument("-n", "--count", type=int, default=10)
    p_check.set_defaults(func=cmd_check)

    p_bench = sub.add_parser("bench", help="latency and jitter benchmark")
    p_bench.add_argument("host")
    p_bench.add_argument("-n", "--count", type=int, default=20)
    p_bench.set_defaults(func=cmd_bench)

    p_conn = sub.add_parser("connect", help="start a streaming session")
    p_conn.add_argument("host")
    p_conn.add_argument("app", nargs="?", default="Desktop",
                        help="app to stream (default: Desktop)")
    p_conn.add_argument("-p", "--profile", choices=sorted(PROFILES), default="desktop")
    p_conn.add_argument("--resolution", help="override, e.g. 2560x1600")
    p_conn.add_argument("--fps", type=int, help="override profile fps")
    p_conn.add_argument("--bitrate", type=int, help="override profile bitrate (Kbps)")
    p_conn.add_argument("--display-mode", choices=["borderless", "fullscreen", "windowed"],
                        help="override the profile's window mode")
    p_conn.add_argument("--overlay", action="store_true",
                        help="show Moonlight's performance overlay")
    p_conn.add_argument("--hdr", action="store_true", help="enable HDR")
    p_conn.add_argument("--no-lan", action="store_true",
                        help="always use the Tailscale address, even on the LAN")
    p_conn.add_argument("--force", action="store_true",
                        help="connect even if the path is relayed")
    p_conn.add_argument("--dry-run", action="store_true",
                        help="print the Moonlight command without running it")
    p_conn.add_argument("--check-count", type=int, default=5,
                        help="pings used for the path check (default: 5)")
    p_conn.set_defaults(func=cmd_connect)

    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())

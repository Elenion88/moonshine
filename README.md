# Moonshine

**Moonlight and Sunshine, tuned for your tailnet.**

Low-latency remote desktop between machines on the tailnet, replacing Parsec.

Sunshine encodes on the host and Moonlight decodes on the client. They are two
good programs that have never heard of each other, and the name is the seam
between them: Moonshine is what makes the pair behave like one product, and it
adds the piece neither provides - a check that the Tailscale path is actually
**direct** before a session starts.

## Why the path check exists

The original problem was never the streaming software. The tower had drifted
onto `Young-2.4`, a guest SSID with AP/client isolation enabled. It could reach
the router but no other device on the LAN, so Tailscale silently fell back to a
shared DERP relay in Denver:

```
pong from macbook (100.80.245.37) via DERP(den) in 49ms ... 110ms ... 168ms
direct connection not established
```

Nothing surfaces this. The peer shows as online, the internet works, and every
remote desktop tool just feels bad. After rejoining the main `Young Family`
network the same ping goes direct:

```
pong from macbook (100.80.245.37) via 192.168.0.195:52433 in 8ms
```

That is a 7-20x improvement, over UDP instead of a TCP relay, and no encoder
setting can substitute for it. So `moonshine connect` refuses to start a session
over a relay unless you pass `--force`.

## Apps

No terminal needed.

- **`window.py`** - a normal application window listing every host with live
  latency and a button per profile. Windows: Start Menu > **Moonshine**.
  macOS: **Moonshine.app**.
- **`tray_windows.pyw`** - Windows system tray icon

### Why there is no macOS menu bar item

On a notched MacBook with a full menu bar, macOS **silently refuses to draw new
status items**. Not an error, not an overflow arrow - the API reports success and
nothing appears. A minimal probe with no rumps, no launchd and none of this
project's code proved it:

```
status item created : True
title set to        : 'REMOTETEST'
item visible        : True
button width        : 105.0
```

macOS created the item, called it visible, gave it 105 points of width, and drew
nothing. `isVisible()` reports the application's intent, not whether the system
rendered anything. No fix to this code could have helped.

There was a `tray_macos.py` agent for a while, kept on the theory that it would
appear by itself whenever space freed up. It never did, and it cost three
dependencies - `rumps`, `pyobjc-core` and `pyobjc-framework-Cocoa` - to render
nothing, so it was **removed on 2026-08-20**. `Moonshine.app` is the entry point
on macOS. Windows still has a tray icon, where status items are not rationed.

The icon carries the status, so a bad path is visible before you click anything:

| | Meaning |
|---|---|
| 🟢 green | Direct path, healthy latency |
| 🟡 amber | Direct, but median above one 60fps frame (16.7ms) |
| 🔴 red | Relayed through DERP - will stutter |
| ⚪ grey | Nothing online |

The menu lists every streamable tailnet host with its live latency and jitter.
Hover a host and pick **Desktop** or **Gaming** to start a session. Status
refreshes every 60 seconds on a background thread, so the menu opens instantly.

### Why the window is not made of ttk widgets

Two things make a Tk app look its age, and both have the same cause: Tk draws
nothing itself that a modern UI needs. Curves come out aliased, and an unaware
process on a scaled display gets handed a 96dpi canvas which Windows then
bitmap-stretches, so every glyph is soft.

`ui.py` fixes both. The process declares per-monitor DPI awareness before the Tk
root exists, so text is rendered by the OS at real pixels, and the window
rebuilds itself if it is dragged to a display with different scaling or the
system flips to dark mode. Everything with a curve - cards, buttons, the toggle,
the status dots, the app icon - is drawn with Pillow at 4x and downsampled,
which is also why every drawn widget is told which colour it sits on: Tk has no
alpha, so the background has to be baked into the image. Pillow is optional;
without it the same widgets fall back to square-cornered rectangles in the same
palette.

The tray icon was redrawn for the size it is actually seen at. The old one drew
a full monitor - bezel, stand, base - in 64 pixels and the tray shows 16, where
all of it collapsed into a grey smear.

### The CLI is a user interface too

`Set up this PC` opens a console window, which makes `moonshine setup` something
you look at whether or not it was designed to be. Verdicts are coloured - green
for a direct path, red for a relay, dim for anything secondary - and the setup
checks report `✓` and `✗` rather than `[ok]` and `[x]`.

All of it degrades rather than breaking. Colour is dropped when the output is
piped, when `NO_COLOR` is set, or when `TERM=dumb`, and the glyphs fall back to
ASCII when the stream cannot encode them, which is what Windows hands you on a
cp1252 pipe. Anything written to a file is stripped first, so session logs never
contain escape codes. Older consoles are switched into VT mode explicitly;
Windows Terminal already understands the codes.

### Session logs

Every session records itself. No flags, no setup - start a stream and a log
appears in `sessions/` next to `config.json`:

```
%APPDATA%\moonshine\sessions\        (Windows)
~/.config/moonshine/sessions/        (macOS)
```

Each file captures the host, the address actually used (and whether LAN-direct
applied), the profile and settings, the measured path before connecting, how long
the session ran, the exit code, and **Moonlight's own log folded in at the end** -
which is where decode time, dropped frames and network stalls live.

```
moonshine logs           # list recent sessions
moonshine logs --show    # print the most recent in full
```

The **Session logs** button in the app opens that folder directly.

### Status refresh pauses during a session

Measuring a path means running `tailscale ping` against every online host, a few
seconds each - about **nine seconds of continuous probing** per refresh. With a
tray app and a window app on each of two machines, four independent 60-second
timers staggered against each other put that on top of a stream every ~30
seconds.

The symptom was picture and audio alternating clean and rough in **11-26 second
stretches**, in both directions. It was not the network, the WiFi, the codec or
the macOS audio tap - it was this project measuring the link it was streaming
over.

So refreshing pauses while a session is live. Detection is by **established TCP
connection on Sunshine's control port**, not by process name: Moonlight
processes linger long after sessions end - three were still resident hours
later, holding 60-90 MB each - so "is Moonlight running" reports true almost
permanently. A connection on 47989 exists only during a real session, and works
identically on the host and the client.

Clicking **Refresh** still forces a measurement, on the principle that an
explicit request should be honoured.

### Latency overlay

**Show latency overlay** in the app turns on Moonlight's live stats for the next
session. It is off by default because it sits on top of the picture - it is a
diagnostic, not a permanent fixture. Turn it on when a session feels wrong; the
numbers it shows are the real ones, unlike idle `ping` measurements which
exaggerate WiFi power saving and settling behaviour.

### Setup, from the menu

**Set up this PC / Mac as a host...** runs `moonshine setup`, which does everything
that can be automated:

- starts or restarts the Sunshine service
- reads Sunshine's log to confirm the hardware encoder actually initialised
- checks the Windows firewall is still scoped to the tailnet
- installs the box art and host name (see *Branding two programs we do not own*)
- opens the exact macOS permission panes and prints the exact binary path
- on macOS, checks Sunshine's libraries actually load - and why they might not

That last one earns its place. On 2026-08-20 Sunshine on the Mac had been dead
for days, and the only symptom was that the machine stopped answering on 47989 -
indistinguishable from the Tailscale and firewall failures this project has
already hit, so those got checked first. launchd knew all along and had filed it
under `OS_REASON_DYLD`. Homebrew had deleted `curl` and `miniupnpc` out from
under Sunshine, because Sunshine comes from the third-party tap
`lizardbyte/homebrew`, Homebrew refuses to read formulae from untrusted taps, and
a formula it cannot read has no visible dependencies - so `brew autoremove`
concluded nothing needed them. `brew trust lizardbyte/homebrew` fixes the cause
once. Setup now checks both, and one `sunshine --version` reproduces the symptom
in a second:

```
  x  Libraries - cannot load libcurl.4.dylib - brew install curl
```

**What it deliberately does not do:** grant the macOS permissions. Screen
Recording and Accessibility live behind TCC, which no process can grant to
itself or to another - not as your user, not with your password. The only
non-interactive path is an MDM profile pushed by IT, which for this JumpCloud
Mac is actually an option worth asking about. Everything around that one click
is automated.

### The macOS bundle

`Moonshine.app` is a real `.app` bundle (`scripts/build_macos_app.sh`), not a bare
script under launchd, so it gets a Dock icon, a Spotlight entry and a stable
identity for TCC to hang permissions on. Note `~/Applications` on this Mac is
**owned by root** courtesy of MDM, so the bundle is built into
`~/.local/share/moonshine/` instead.

Autostart applies to the Windows tray only:

```bash
python tray_windows.pyw --install-autostart
```

## CLI

```
moonshine list                    # tailnet peers and path quality
moonshine list --quick            # skip path measurement (much faster)
moonshine check <host>            # verify the path is direct; exits 1 if relayed
moonshine bench <host>            # latency and jitter, flags spikes over one frame
moonshine connect <host> [app]    # gated session start
moonshine hide <host>             # drop a host from listings and the menu
moonshine unhide <host>           # bring it back
```

`hide` exists because one machine can appear on the tailnet more than once. The
MacBook ran both a Homebrew `tailscaled` and the Tailscale.app system extension,
each registering its own node - `macbook` (100.80.245.37) and `macbook-air`
(100.99.22.42) - so the same laptop showed up twice in every menu. Both resolved
to the same LAN address, `192.168.0.195`, on different ports.

The hide list is stored per machine at `%APPDATA%\moonshine\config.json` on Windows
and `~/.config/moonshine/config.json` on macOS, and is re-read every refresh cycle,
so changes apply without restarting the tray app.

Useful flags on `connect`:

| Flag | Effect |
|---|---|
| `-p, --profile` | `desktop` (default) or `gaming` |
| `--resolution` | Override, e.g. `2560x1600` |
| `--fps` / `--bitrate` | Override the profile |
| `--overlay` | Moonlight's performance overlay - live latency and FPS |
| `--dry-run` | Print the Moonlight command without running it |
| `--force` | Connect even over a relay |

Examples:

```bash
moonshine connect win-tower                              # desktop session
moonshine connect win-tower -p gaming --overlay          # game, with stats
moonshine connect win-tower "Steam Big Picture" -p gaming
```

## LAN-direct

Tailscale finding a direct path is not the same as there being no tunnel. Even
on a direct path every packet still goes through userspace WireGuard. Measured
against one machine reachable both ways:

| Path to the same host | Mean | Spread |
|---|---|---|
| ICMP through the tunnel (`100.126.31.123`) | **4.33 ms** | 2-9 ms |
| ICMP over the LAN (`192.168.0.169`) | **0 ms** | none |

About 4 ms and nearly all the jitter, for encrypt / tunnel driver / decrypt on
both ends. At 60fps that is a quarter of a frame.

So `connect` uses the LAN address when it can. Tailscale already publishes the
address it is using, which means no discovery of our own is needed:

```
macbook-air   active; direct 192.168.0.195:41641
                            ^^^^^^^^^^^^^ this
```

If that address is private *and* Sunshine answers on port 47989 there, the
session goes straight to it and skips the tunnel. Otherwise it uses the tailnet
address as before. Away from home nothing changes. `--no-lan` forces the tunnel.

Reachability is proven by connecting rather than by comparing subnets. Guessing
from subnet maths would have been wrong in exactly the situation that started
this project - a machine on the "right" subnet that could not reach anything
because of client isolation.

Two things that make this work without extra setup:

- **Pairing is by server identity, not address.** `moonlight list 192.168.0.136`
  returns the app list on a host paired as `win-tower`, so no re-pairing.
- **The Windows firewall was widened** from `100.64.0.0/10` to
  `LocalSubnet, 100.64.0.0/10`. That is a real if modest loosening: anything on
  your home network can now reach Sunshine's port, though it still cannot pair
  without the PIN from the web UI. Revert with
  `Get-NetFirewallRule -DisplayName 'Sunshine' | Set-NetFirewallRule -RemoteAddress 100.64.0.0/10`.

### Why not replace Tailscale

Building our own overlay would mean reimplementing WireGuard, NAT traversal, a
coordination server, key distribution and tunnel drivers for two platforms - and
it would not win back that 4 ms, because the cost is inherent to moving packets
through a userspace VPN. The cheap win was noticing when the tunnel is not needed
at all, not replacing it.

## Profiles

Both use HEVC with hardware decode, and turn off V-Sync and frame pacing (each
buffers a frame to smooth output, which trades latency for smoothness).

|  | desktop | gaming | mac |
|---|---|---|---|
| Chroma | **YUV 4:4:4** - sharp text | 4:2:0 - bitrate goes to motion | **YUV 4:4:4** |
| Mouse | Absolute (1:1 pointer) | Relative (captured) | Absolute |
| Bitrate | 40 Mbps | 50 Mbps | 30 Mbps |
| Resolution | 1920x1200 | 1920x1080 | 1920x1200 |
| Extras | - | Game optimizations, multi-controller | **System key capture** |

## Controlling the Mac from Windows

The obvious objection to using Moonlight against a macOS host is that the
Command key doesn't work. That turns out to be false, and the fix is one flag.

Tracing it end to end - Moonlight's `keyboard.cpp`:

```cpp
case SDL_SCANCODE_LGUI:
    if (!isSystemKeyCaptureActive()) {
        return;          // swallowed locally, never sent
    }
    keyCode = 0x5B;      // otherwise sent to the host
```

and Sunshine's macOS `input.cpp`:

```cpp
0x5B → kVK_Command → kCGEventFlagMaskCommand
```

The wiring is already complete. The Windows key is just gated behind
`--capture-system-keys`, which is off by default for a good reason: capturing it
means Win+L and Alt+Tab go to the *remote* machine instead of the local one. The
`mac` profile turns it on. Ctrl+Alt+Shift toggles it back mid-session.

LizardByte's docs still claim "Command Keys are not forwarded by Moonlight. Right
Option-Key is mapped to CMD-Key." That is stale - there is no Right-Option hack
anywhere in the current source.

**Setup on the Mac** (`brew install sunshine` from the `lizardbyte/homebrew` tap,
config in `configs/sunshine-macos.conf`):

Sunshine needs **several separate permissions**, and they fail in different ways:

| TCC service | Without it |
|---|---|
| `kTCCServiceScreenCapture` | Every encoder fails at startup with `Unable to find display or encoder` - displays still enumerate, because enumeration doesn't need it but capture does |
| `kTCCServiceAccessibility` | Video and **keyboard work, but the mouse does nothing** |
| `kTCCServicePostEvent` | Same - this is the one `CGEventPost` to the HID tap actually consults |
| `kTCCServiceAudioCapture` | No audio |

The keyboard/mouse split is visible in Sunshine's source: keyboard events post to
`kCGSessionEventTap`, while `post_mouse` uses `kCGHIDEventTap`. The HID-level tap
is the one behind Accessibility/PostEvent, so a half-granted setup gives a
working keyboard and a dead pointer - which reads like a bug rather than a
permission.

`moonshine setup` reads these directly out of the TCC databases:

```sql
select service, auth_value from access where client = '<sunshine path>';
-- auth_value: 0 = denied, 2 = allowed
```

Those databases are normally protected, but they are readable on this machine, so
setup reports the real state rather than telling you to go and check. It only
opens a settings pane when something is actually missing.

### In-session shortcuts

All are **Ctrl+Alt+Shift** plus a key. None are discoverable in the UI, and the
first two are the ones that make a session usable rather than a trap:

| Key | Action |
|---|---|
| **D** | **Minimize the session, leaving it running** |
| **K** | Toggle system key capture - hands Alt-Tab back to Windows |
| Z | Release the mouse |
| M | Switch absolute <-> relative mouse |
| X | Toggle fullscreen |
| S | Stats overlay |
| V | Paste local clipboard as keystrokes |
| Q | Quit the session |

The `desktop` and `mac` profiles stream **borderless** rather than exclusive
fullscreen, so the session is an ordinary window you can move away from. Only
`gaming` uses exclusive fullscreen, where the latency matters more than
switching does.

Note this Mac is MDM-enrolled (JumpCloud), so a PPPC profile could block that
permission outright. If the toggle won't stick, that's why.

## Current setup

**Host - win-tower** (Windows 11, Ryzen 5 9600X, RTX 3090, `100.89.7.111`)

- Sunshine 2026.516.143833, running as an automatic service
- Config: `C:\Program Files\Sunshine\config\sunshine.conf`
- NVENC preset P1, two-pass and spatial AQ off, realtime HAGS and
  latency-over-power on
- `upnp = disabled` so the host can never expose itself to the public internet
- Firewall scoped to `100.64.0.0/10` - reachable from the tailnet only, not
  from the LAN or the internet
- Web UI: <https://localhost:47990> (user `austinyoung88`)

**Client - ayoung-MacBook-Air** (macOS 26.5.2, arm64, 2560x1664, `100.80.245.37`)

- Moonlight installed, paired with the host
- CLI at `~/.local/bin/moonshine`

## Constraints worth knowing

- **No AV1.** The RTX 3090 is Ampere; NVENC AV1 encode starts with the 40-series.
  HEVC is the best codec available here. Both H.264 and HEVC do support 4:4:4
  (HEVC also 10-bit), negotiated from the client.
- ~~**Host display is 60Hz**, which caps physical-display capture at 60fps.~~
  **Wrong, and fixed.** The panel is an Alienware AW2724DM, which enumerates
  2560x1440 at 59, 60, 75, 100, 120, 144 and **165Hz**. Windows simply had it
  set to 59Hz. Sunshine cannot capture faster than the desktop runs, so that
  setting - not the hardware, and not the absence of a virtual display - was the
  entire 60fps cap. The desktop now runs at 165Hz (`Display refresh rate
  [164.958Hz]` in Sunshine's log) and the `gaming` profile streams at 120fps.
  Check or change it with `moonshine display`.
- **Both machines are on WiFi.** Typical latency is 7-9ms with ~2ms jitter, but
  runs intermittently show spikes to 80-93ms - roughly a 5-frame stall at 60fps.
  The tower has an unused Realtek 5GbE port; using it should give 2-4ms with
  near-zero jitter and is the largest remaining quality win.
- `macbook-air` (`100.99.22.42`) resolves to the same LAN address as `macbook`
  and appears to be a **stale duplicate node**. Target `macbook`.

## Layout

```
moonshine.py       CLI and the shared Tailscale/profile logic
brand.py           Every user-visible name, in one place
chrome.py          Our title and icon on Moonlight's window (ctypes, Windows)
display.py         Windows display modes - the stream's fps ceiling
traycore.py        Status cache polled on a background thread
ui.py              Theme and drawn widgets for the window (Pillow, optional)
window.py          Desktop window (tkinter + ui.py)
tray_windows.pyw   Windows tray app  (pystray + Pillow)
assets/            App icons and box art, generated by scripts/
```

### Branding two programs we do not own

Sunshine and Moonlight stay on their own upstream releases - that is the whole
point of not writing a capture stack. So the branding has to be arranged so that
an update cannot undo it. Three surfaces, three different tricks:

**Moonlight's window, at runtime.** Moonlight is Qt Quick compiled into
`Moonlight.exe`: no QML on disk, no resource bundle, nothing skinnable. Two of
the three profiles stream in a real window, so its title and taskbar icon are
what you look at all day. `chrome.py` finds the window by process id after
`connect` launches it and sets both through `user32` - `SetWindowTextW` and
`WM_SETICON`, via `ctypes`, no dependency. Nothing under Program Files is
touched, so an update cannot revert it; the next launch simply does it again.
It re-reads the title on a timer rather than setting it once, because Moonlight
builds a *new* window when the stream starts and Qt rewrites the title on its
own.

**Sunshine's box art and host name, in config.** Sunshine has two `apps.json`
files. `assets/apps.json` is the shipped default and is replaced by every
update; `config/apps.json` is the live one and is user data. Same for cover art
- Sunshine's own cover downloader writes into a `covers` directory beside the
config, never into `assets/`. So `moonshine setup` installs the generated tiles
there and points `image-path` at them, and sets `sunshine_name`, which is
Sunshine's own supported knob for "the name displayed by Moonlight". Without it
a host announces its raw hostname, which is why the tower used to appear as
`The_Tower`.

**What stays theirs.** Sunshine's web config page lives under Program Files and
is wiped by each update, so it is left alone. Moonlight's in-stream performance
overlay is compiled in. Both are surfaces you look at rarely, and owning either
would mean giving up the updates.

### The mark

A screen with a crescent moon, on a tile in the host's status colour. The moon is
the name; the screen is the job. The tile stays the status colour because that is
the part doing real work - health is readable in the tray without opening
anything.

Two shapes at 16 pixels is the whole difficulty, and the bite decides it. Biting
the moon from the upper right leaves its mass in the lower left, exactly where
the screen is, and the two fuse into one blob at tray size. Biting the far side
throws the mass up and away and keeps the gap clean. Thickness is the other
constraint: near-equal radii give the slim crescent you would draw at poster size
and about 1.7 pixels of white at 16, which greys out, so the bite is smaller and
offset further, holding roughly 2.5 pixels at the waist.

### Renamed from `remote`

The project was called `remote` until 2026-08-20, and the name was spread across
nine files - a window title, an argparse prog, a bundle identifier, a registry
value, two icon filenames and a state directory. It lives in `brand.py` now, so
the next change is one line.

The rename moves state that the two machines cannot be trusted to migrate by
hand, so all of it happens in code and runs once:

- `config.json` and the session logs move from `remote/` to `moonshine/` on
  first run, on both platforms (`moonshine.py`).
- The stale `remote-tray` registry Run entry is deleted - Windows fails a broken
  Run entry silently at login (`tray_windows.pyw`).
- The Mac's `~/.local/share/remote`, its `dev.austin.remote-tray` launch agent
  and every leftover `Remote.app` are migrated or removed on the next update
  (`scripts/install_macos_update.sh`).

`scripts/make_icons.py` renders `assets/moonshine.ico` from the same mark the apps
draw at runtime, and `assets/moonshine.icns` as well when run on macOS, where
`build_macos_app.sh` picks it up for the bundle. Re-run it after changing the
glyph or the accent colour. The Windows Start Menu shortcut points at the `.ico`
directly, so it updates in place.

On the Mac these live in `~/.local/share/moonshine/`, with `~/.local/bin/moonshine`
symlinked to the CLI. The macOS app runs from a venv because Homebrew's Python is
externally managed (PEP 668). Binary lookup falls back to absolute paths rather
than relying on `PATH`, since LaunchAgents start with a minimal one.

## Not done yet

- Reverse direction (controlling the Mac from Windows)
- Per-session resolution and refresh matching. The host's mode is now set once
  and left alone; matching it to whatever each client asks for means Sunshine
  prep commands (`do`/`undo`) calling `moonshine display --fps $SUNSHINE_CLIENT_FPS`
  and restoring afterwards.

### The Parsec Virtual Display Adapter is a dead end here

It is installed, and it is not what this project should use. The control device
opens (`\\?\root#display#0000#{00b41627-...}`) but this build rejects the
documented IOCTLs - `VERSION` (`0x0022E900`) completes with
`ERROR_INVALID_FUNCTION`, as do `ADD` and `REMOVE`. It predates the interface
that nomi-san's `parsec-vdd` targets, so driving it would mean guessing IOCTL
codes against a live kernel display driver.

It was never needed for the thing it was being kept around for. A virtual
display is only worth revisiting for headless operation, or to offer a client a
resolution the physical panel cannot do - and then by installing a maintained
driver with a supported CLI, not by reverse-engineering this one.

# Moonshine

**Moonlight and Sunshine, tuned for your tailnet.**

Low-latency remote desktop between your own machines, over Tailscale.

[Sunshine](https://github.com/LizardByte/Sunshine) encodes on the host and
[Moonlight](https://moonlight-stream.org) decodes on the client. They are two
good programs that have never heard of each other. Moonshine is the seam
between them: it makes the pair behave like one product, and it adds the piece
neither provides - a check that the Tailscale path is actually **direct**
before a session starts.

## Why that check is the whole point

Tailscale prefers a direct UDP connection between two machines and falls back
to a shared DERP relay when it cannot get one. Nothing tells you when it falls
back. The peer still shows as online, the internet still works, and every
remote desktop tool just feels bad:

```
pong from macbook (100.101.10.22) via DERP(den) in 49ms ... 110ms ... 168ms
direct connection not established
```

The same ping, once the path is direct:

```
pong from macbook (100.101.10.22) via 192.168.1.50:52433 in 8ms
```

That is a 7-20x difference, over UDP instead of a TCP relay, and no encoder
setting can make up for it. So `moonshine connect` refuses to start a session
over a relay unless you pass `--force`, and the tray icon carries the answer
before you click anything.

| | Meaning |
|---|---|
| 🟢 green | Direct path, healthy latency |
| 🟡 amber | Direct, but median above one 60fps frame (16.7ms) |
| 🔴 red | Relayed through DERP - will stutter |
| ⚪ grey | Nothing online |

## Four ways in

Tailscale is the best of them, not the only one. Moonshine looks for a machine
every way it can and uses whichever answers best:

| | Needs |
|---|---|
| **Tailscale** | signed in on both machines |
| **Local network** | being on the same network — nothing else at all |
| **Your account** | signing in, so two machines can find each other |
| **Saved address** | knowing an address |

A machine reachable several ways is listed once, with the routes behind a
disclosure. The local network wins when it answers, because it has the least in
the middle.

## What you need first

Moonshine does not install or configure any of these, and does not join a
tailnet or pair a host for you. That is the biggest rough edge in this release.

- **[Tailscale](https://tailscale.com)** on both machines, signed in to the
  same tailnet.
- **Sunshine** on the machine you want to control, installed and paired.
  `winget install LizardByte.Sunshine` on Windows,
  `brew install --cask sunshine` on macOS.
- **Moonlight** on the machine you want to control it from.

`moonshine setup` checks all of it, reports what is missing, and automates
everything around it that can be automated - starting the Sunshine service,
confirming the hardware encoder actually initialised, checking the firewall is
still scoped to the tailnet, installing the box art, and opening the exact
macOS permission panes.

## Install

**Windows** - run `Moonshine-<version>-setup.exe`. It installs per-user, needs
no administrator account, and offers to start the tray at login and put the
`moonshine` command on PATH.

**macOS** - build it (see below). There is no signed release yet.

> **Nothing is code-signed yet.** Windows SmartScreen will warn, and macOS
> Gatekeeper will refuse to open an unsigned bundle downloaded from the
> internet. Both are telling the truth: nobody has vouched for these binaries.
> Building from source sidesteps it entirely, which is the point of the source
> being here. See [packaging/README.md](packaging/README.md).

## Using it

**The app** lists every streamable host on your tailnet with live latency and
jitter, and a button per profile. Closing the window leaves it running in the
tray, where the icon carries the status colour — so a bad path is visible
before you click anything. **Set up** checks Sunshine, the firewall and capture
permissions on this machine, and fixes what it can.

**The CLI** is a separate, optional binary that the installer does not include.
It covers what the app does not:

```
moonshine bench <host>            # latency and jitter, flags spikes over one frame
moonshine check <host>            # verify the path is direct; exits 1 if relayed
moonshine display                 # host displays and the stream's fps ceiling
moonshine list                    # tailnet peers and path quality
moonshine connect <host> [app]    # gated session start
moonshine logs [--show]           # recorded sessions
```

### Session logs

Every session records itself - no flags, no setup. Each log captures the host,
the address actually used, the profile and settings, the measured path before
connecting, how long it ran, the exit code, and **Moonlight's own log folded in
at the end**, which is where decode time, dropped frames and network stalls
live.

```
%APPDATA%\moonshine\sessions\        (Windows)
~/.config/moonshine/sessions/        (macOS)
```

## Building from source

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build.ps1   # on Windows
```
```bash
bash packaging/build.sh                                        # on macOS
```

PyInstaller cannot cross-compile, so each platform's build has to run on that
platform. Full detail, including what code signing will take, is in
[packaging/README.md](packaging/README.md).

To run it straight from a checkout instead:

```bash
cd app && npm install && npm run dev     # the app
python moonshine.py list                 # the CLI
```

## Layout

```
app/               The app: TypeScript, React, Electron. The product.
server/            The coordinator: accounts and a device registry
moonshine.py       The CLI, and the Tailscale/profile logic it shares
brand.py           Every user-visible name, in one place
chrome.py          Our title and icon on Moonlight's window (ctypes, Windows)
display.py         Windows display modes - the stream's fps ceiling
glyph.py           The palette and the mark, for the artwork generators
assets/            App icons and box art, generated by scripts/
packaging/         Build scripts, CLI specs, and what is still missing
docs/DESIGN.md     Why everything is shaped the way it is
```

The window and the tray were tkinter and pystray until 2026-08-21. What they
looked like and why they were built that way is in the design notes; the code
is in the history.

## Status

Pre-1.0, and honest about it. Moonshine has been run in earnest on exactly two
machines - one Windows host with an RTX 3090 and one Apple Silicon MacBook. It
has not been tested on Intel Macs, on non-NVIDIA hosts, on Linux, or with
multiple monitors. [docs/DESIGN.md](docs/DESIGN.md) records what is known not
to work and why.

Sunshine and Moonlight are separate programs. Moonshine launches them, it does
not include or modify them, and it stays on their own upstream releases.

## Licence

**GPL-3.0-or-later.** See [LICENSE](LICENSE).

The same licence Sunshine and Moonlight use, which is not a coincidence: this
project exists in their ecosystem and it would be odd to take from it without
giving back on the same terms. Fork it, change it, ship it - the source of what
you ship has to stay open too.

Third-party components bundled into the installers, and what selling a GPL
binary requires, are covered in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

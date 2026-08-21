# The Electron app

The new Moonshine UI: TypeScript, React and Electron, replacing the tkinter
window and the pystray tray at the repository root.

```
src/main/          Node side. Everything that touches the network, the disk or
                   another process.
  core/            The logic, ported from moonshine.py
  index.ts         Window, tray, lifecycle
  ipc.ts           The only calls the page can make
src/preload/       The bridge. Context isolation is on; this is the whole
                   surface the page has.
src/renderer/      The page. No Node, no shell, no filesystem.
resources/         Icons, generated from the Python glyph
```

## Running it

```bash
npm install
npm run dev          # hot reload
npm run build        # typecheck, then bundle to out/
npm start            # run the bundle
npm run dist         # installer into dist/
```

`npm run build` typechecks both projects first, so a build that succeeds is a
build that compiles.

## Why two TypeScript projects

`tsconfig.node.json` and `tsconfig.web.json` compile against different lib sets
- Node's globals on one side, the DOM on the other - because they genuinely are
different environments. It also means the types crossing the bridge are written
out twice, in `src/main/core` and in `src/renderer/src/types.ts`. That
duplication is deliberate: widening the bridge should take an edit on both
sides, not happen by accident through a shared import.

## What is not here yet

- **The CLI.** `moonshine.py` still owns `bench`, `check` and `display`. The
  app covers the rest. The tkinter window and the pystray tray it used to sit
  beside were deleted on 2026-08-21.
- **Hiding hosts.** The IPC call exists; nothing in the UI calls it.

## Tailscale is one transport, not the only one

`core/transport.ts` is where "how do we reach this machine" lives. A transport
finds hosts, says what address to hand the stream client, and measures the
path. Three exist:

| Transport | Finds hosts by | Needs |
|---|---|---|
| Tailscale | `tailscale status` | Tailscale signed in |
| Local network | Sunshine's own mDNS advertisement | being on the same network |
| Saved address | what you typed | nothing |

`core/mdns.ts` is a small mDNS client written out rather than pulled in - the
query is one packet and the reply is one well-specified format, and a package
to do it would be thousands of lines to send 34 bytes.

A machine that answers on several transports is listed once, with every route
behind a disclosure. Ranking is by health first, then the local network wins
outright, then the median breaks ties.

**The local network wins by rule, not by measurement**, and that matters:
a tailnet route is timed with ICMP and a local one by TCP connects, and a
connect carries the server's accept latency inside it. A healthy Mac measured
19 ms by connect and 7 ms by ping. Comparing those directly would penalise the
faster path for being measured more honestly, so instead: fewer things in the
middle wins, and connect timings are shown as upper bounds ("under 19 ms").
The one-frame budget is only applied to round-trip measurements; a
connect-measured route is judged on jitter, which a constant overhead does not
inflate.

The interesting transport is the one that does not exist yet - a hole-punched
direct connection with our own coordination, which is what makes this work for
someone who has never heard of Tailscale. It plugs in here.

### Known limitation

Hosts are merged by name, normalised to letters and digits, so Tailscale's
`macbook-air` and mDNS's `MacBook Air` are one machine. A saved address you
name yourself is not merged with the machine it points at - it appears as you
named it, which is usually what you meant, but it does mean the same machine
can be listed twice if you add it by hand.

## Setup is a checklist now, not a console report

`moonshine setup` printed its findings, and the Python CLI put real effort into
making that print readable - coloured verdicts, ASCII fallbacks, VT mode on old
consoles - because a terminal was the only surface it had.

`core/setup.ts` returns structure instead: each check has a state, a detail, and
either a command to copy or an action the app can perform. The Windows service,
the firewall scope and the branding are all one button. The macOS dylib check,
the untrusted-tap check and the TCC reads are ported intact.

What it still will not do is grant the macOS permissions. Screen Recording and
Accessibility live behind TCC, which no process can grant to itself or to
another - not as your user, not with your password. The app opens the exact
pane and names the exact binary; the click is not ours to make.

## The icons are generated

`resources/tray/*.png`, `resources/icon.png` and `resources/covers/*.png` come from `glyph.py` via
`python app/resources/generate-assets.py`, so the tray icon, the app icon and
Sunshine's box art all come from one drawing. They are not committed.

`src/renderer/src/components/Mark.tsx` draws the same mark as SVG, from the
same 512-unit measurements. The two should eventually be one source, but
Electron's tray needs raster and the main process has no rasteriser - so today
`glyph.py` is what produces it.

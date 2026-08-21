# Contributing

Moonshine is GPL-3.0-or-later. Anything you contribute is under the same
licence.

## Running it from a checkout

```bash
pip install -e ".[tray]"
python window.py            # the app
python moonshine.py list    # the CLI
python tray_windows.pyw     # the tray (Windows)
```

Pillow is optional at runtime - `ui.py` falls back to square-cornered Canvas
rectangles in the same palette without it - but you want it, because it draws
every rounded element and generates the icons and box art.

The apps read source only at launch. Restart them after a change or you are
testing the old build.

## Building a release

See [packaging/README.md](packaging/README.md). PyInstaller cannot
cross-compile, so the Windows build has to run on Windows and the macOS build
on a Mac.

## What this project is trying to be

A thin, well-behaved seam between Sunshine and Moonlight, plus the direct-path
check that neither of them has. Two things follow from that:

- **It does not fork Sunshine or Moonlight.** They stay on their own upstream
  releases. Branding is applied at runtime and to config directories, never by
  patching either program. `docs/DESIGN.md` explains how and what an update
  wipes.
- **Dependencies are load-bearing or they go.** Three macOS packages were
  removed for rendering nothing. pystray was kept because it does real work.
  A new dependency should be able to survive that question.

## Style

Read the surrounding code before writing. The comments in this project explain
*why* - usually which failure produced the code, and what looked like the cause
and was not. A patch that changes behaviour and leaves the comment above it
describing the old behaviour is worse than no patch.

`docs/DESIGN.md` is where the long version of that reasoning lives. If you fix
something that took a while to understand, put the understanding there.

## Reporting a streaming problem

Include the session log. Every session writes one with no flags and no setup:

```
moonshine logs --show
```

It has the measured path before connecting, the address actually used, the
profile, the exit code, and Moonlight's own log folded in at the end. Almost
every "it feels bad" report is answered somewhere in that file - most often by
`route relayed`, which is the problem this project was built to catch.

# Contributing

Moonshine is GPL-3.0-or-later. Anything you contribute is under the same
licence.

## Running it from a checkout

```bash
cd app && npm install && npm run dev     # the app, with hot reload
python moonshine.py list                 # the CLI
```

The CLI needs nothing but the standard library. Pillow is needed only to
regenerate the icons and box art:

```bash
pip install -e ".[art]"
python scripts/make_icons.py --png
python app/resources/generate-assets.py
```

`npm run dev` reloads the renderer on save; changes under `src/main` need a
restart. The CLI reads source at launch, so there is nothing to restart there.

## Building a release

See [packaging/README.md](packaging/README.md). PyInstaller cannot
cross-compile, so the Windows build has to run on Windows and the macOS build
on a Mac.

## What this project is trying to be

A thin, well-behaved seam between Sunshine and Moonlight, plus the direct-path
check that neither of them has. Two things follow from that:

- **It does not patch software your users install.** Sunshine and Moonlight
  stay on their own upstream releases; branding is applied at runtime and to
  config directories, never by modifying either program. Building our own
  client from their GPL source is a different thing, and is on the roadmap -
  what is ruled out is shipping a patch that alters somebody's install.
- **Dependencies are load-bearing or they go.** Three macOS packages were
  removed for rendering nothing, and pystray left with the tray it existed
  for. A new dependency should be able to survive that question - which is
  not an argument against Electron: it is the product now, not a helper.

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

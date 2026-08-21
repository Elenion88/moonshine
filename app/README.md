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

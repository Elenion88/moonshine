# Packaging

Two artifacts, two toolchains.

```
app/                    the product. electron-builder makes the installer.
packaging/windows.spec  the CLI on Windows  (PyInstaller, optional)
packaging/macos.spec    the CLI on macOS    (PyInstaller, optional)
packaging/build.ps1     the whole Windows build
packaging/build.sh      the whole macOS build
```

## Building

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build.ps1        # the app
powershell -ExecutionPolicy Bypass -File packaging\build.ps1 -Cli   # and the CLI
```
```bash
bash packaging/build.sh          # the app
bash packaging/build.sh --cli    # and the CLI
```

Neither toolchain cross-compiles: the Windows build runs on Windows, the macOS
build on a Mac. Both scripts generate the icons and box art first, because
those are drawn from `glyph.py` rather than committed.

## The app is the product

`app/dist/Moonshine-<version>-setup.exe` is what ships. Per-user, no
administrator account, about 92 MB - most of which is Chromium.

The CLI is a separate, optional binary and is **not** in the installer. It
exists for `moonshine bench`, `moonshine check` and `moonshine display`, which
the app does not cover yet. When it does, this half goes away.

## What changed, and why the old installer is gone

There used to be an Inno Setup script here that packaged three PyInstaller
executables: a tkinter window, a pystray tray and the CLI. It worked - it
installed, uninstalled cleanly and scoped its registry writes properly - and it
packaged the app that has now been replaced.

Two problems it had are worth remembering, because they were not obvious:

- **NTFS is case-insensitive.** `Moonshine.exe` and `moonshine.exe` are one
  filename, so the GUI silently overwrote the CLI and the first build shipped a
  `moonshine.exe` that opened a window and never answered `--help`.
- **Uninstalling by name is not uninstalling your own thing.** Removing the
  login registry entry by its name took out the entry belonging to a *separate*
  install running from source. Deleting by name deletes by name; check what the
  value points at first.

## Not done: code signing

**Neither build is signed. That is the remaining blocker for selling
downloads** - not for the project, which anyone can build from source without
meeting a warning at all.

- **Windows.** An unsigned installer downloaded from a website triggers
  SmartScreen's "Windows protected your PC" panel. Reputation accrues per
  certificate, so a fresh one warns for a while regardless. A standard OV
  certificate is roughly $200-400/year and now requires the key on a hardware
  token or cloud HSM. electron-builder signs automatically when `CSC_LINK` and
  `CSC_KEY_PASSWORD` are in the environment.
- **macOS.** Gatekeeper refuses an unsigned bundle downloaded from the internet
  outright - the quarantine attribute makes it a notarisation check, not a
  signature check. That needs an Apple Developer account ($99/year), a
  *Developer ID Application* certificate, and notarisation. electron-builder
  does all of it given `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.

## Selling a GPL build

Allowed, with one condition: conveying a binary means conveying its
Corresponding Source. Because the repository is public, GPL-3.0 section 6(d) is
satisfied by pointing at it - the download page and the installer both have to
carry a link to the source for the exact version being sold, and it has to stay
reachable for as long as the binary is offered.

`app/package.json` sets that link. It is a placeholder today.

## Not done: everything the installer assumes is already there

The installer ships Moonshine. It does not ship or install **Tailscale**,
**Sunshine** or **Moonlight**, and it does not join a tailnet or pair a host.
The app's Set up screen checks for them and says what is missing. For a paid
download that is the wrong division of labour, and it is the next thing to fix
after signing.

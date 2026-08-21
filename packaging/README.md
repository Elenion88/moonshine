# Packaging

Turning the source tree into something a stranger can download and run.

```
pyproject.toml          dependency and entry-point metadata (pip installs)
packaging/windows.spec  PyInstaller: three executables in one folder
packaging/macos.spec    PyInstaller: one .app holding the window app and the CLI
packaging/moonshine.iss Inno Setup: dist\Moonshine -> a single setup.exe
packaging/build.ps1     the whole Windows build, with checks
packaging/build.sh      the whole macOS build, signing optional
```

## Building

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build.ps1   # on Windows
```
```bash
bash packaging/build.sh                                        # on the Mac
```

PyInstaller cannot cross-compile: the Windows build has to run on Windows and
the macOS build on the Mac. Both scripts generate the icons first, because
`assets/*.ico` and `assets/*.icns` are produced by `scripts/make_icons.py`
rather than committed.

## Why three executables on Windows

Windows fixes the subsystem at link time. A windowed binary has no console to
write to and a console binary always shows one, so the CLI and the two GUI apps
cannot be the same file. They share a folder, and PyInstaller ships the
interpreter, Tcl/Tk and Pillow's DLLs once for all three - about 47 MB total.

The names are deliberate and look backwards:

| File | What it is |
|---|---|
| `moonshine.exe` | the CLI |
| `Moonshine App.exe` | the window |
| `Moonshine Tray.exe` | the tray icon |

NTFS is case-insensitive, so `Moonshine.exe` and `moonshine.exe` are one
filename - the first build of this shipped a `moonshine.exe` that was really
the GUI, opened a window, and never answered `--help`. Only one binary can hold
the plain name, and it has to be the CLI: `moonshine` is what a person types,
and PATHEXT resolves `.exe` ahead of any `.cmd` shim, so a GUI holding that
name would answer the command instead. The GUI filenames appear in Task Manager
and nowhere else - the Start Menu shows whatever the shortcut is called.

APFS is case-insensitive too, so the same split applies inside the `.app`.

## What a frozen build changes at runtime

Three things in the source assume a checkout, and all three are handled in
`moonshine.py`:

- `bundle_dir()` - PyInstaller unpacks bundled data to a temporary directory
  and points `sys._MEIPASS` at it, so `__file__` names a path inside the
  archive that nothing can open. Every read of a shipped file goes through here.
- `cli_command()` - the apps shell out to the CLI rather than importing it, so
  a session started from a menu goes through the same path gate and writes the
  same session log as one started by hand. Frozen, that is the sibling
  executable; from source it is the interpreter plus `moonshine.py`.
- `tray_windows.autostart_command()` - registers the executable at login rather
  than `pythonw.exe` plus a script that is not installed.

## Not done: code signing

**Neither build is signed. That is the remaining blocker for selling downloads**
- not for the project, which anyone can now build from source without meeting a
warning at all.

- **Windows.** An unsigned installer downloaded from a website triggers
  SmartScreen's "Windows protected your PC" panel, where running it means
  clicking through *More info -> Run anyway*. Reputation is per-certificate and
  accrues over installs, so a fresh certificate warns for a while regardless. A
  standard OV code-signing certificate is roughly $200-400/year and now
  requires the key on a hardware token or a cloud HSM; an EV certificate skips
  the reputation wait and costs more. Sign both the three `.exe` files and the
  installer, with `signtool sign /fd sha256 /tr <timestamp-url> /td sha256`.
- **macOS.** Gatekeeper refuses to open an unsigned bundle downloaded from the
  internet outright - not a warning, a refusal - because the quarantine
  attribute makes it a notarisation check rather than a signature check. That
  needs an Apple Developer account ($99/year), a *Developer ID Application*
  certificate, and `notarytool` submission. `build.sh --sign` does all of it
  and expects `DEVELOPER_ID` and `NOTARY_PROFILE` in the environment.

Until both exist, anyone who pays for this has to be talked past an OS warning
that is telling them the truth: nobody has vouched for the binary.

## Not done: everything the installer assumes is already there

The installer ships Moonshine. It does not ship or install **Tailscale**,
**Sunshine** or **Moonlight**, and it does not join a tailnet or pair a host.
`moonshine setup` checks for them and prints what to run. For a paid download
that is the wrong division of labour - the setup is most of the work - and it
is the next thing to fix after signing.

## The wheel is not the product

`pyproject.toml` exists for dependency metadata and `pip install -e .` in a
checkout. A built wheel carries the modules but not `assets/`, because
setuptools can only attach data files to a package and this is a flat layout of
single modules. Both asset callers degrade quietly - no Sunshine box art, no
icon on Moonlight's window - so a plain `pip install .` produces something that
runs and looks wrong. The PyInstaller builds bundle the assets explicitly and
are what actually ships.

## Licences travel with the build

`collect_licences.py` copies the licence texts of everything bundled - CPython,
Tcl/Tk, Pillow and pystray - out of the installed packages and into
`licences/` in the build output, along with `LICENSE` and
`THIRD-PARTY-NOTICES.md`. Both build scripts run it, so the shipped folder
carries the texts rather than a link.

Moonshine is GPL-3.0-or-later, and every bundled component is compatible with
that - including pystray, whose LGPL-3.0 relinking requirement is satisfied by
the source being public and this build being reproducible from it.

**Selling a build has one condition:** conveying a binary means conveying its
Corresponding Source. Point the download page and the installer at the public
repository, at the tag the build came from, and keep it reachable for as long
as the binary is offered. `THIRD-PARTY-NOTICES.md` has the detail.

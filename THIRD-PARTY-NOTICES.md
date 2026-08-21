# Third-party notices

Moonshine is GPL-3.0-or-later. Its installers are self-contained: the Python
interpreter and every library it uses are packaged inside them, which makes
those components *redistributed software* with obligations that attach to the
download rather than to the source tree.

All of it is compatible, and shipping the source is what makes it so.

## Bundled inside the installers

| Component | Licence | Compatible with GPL-3.0 |
|---|---|---|
| CPython | PSF License 2.0 | Yes - permissive |
| Tcl/Tk | BSD-style (`license.terms`) | Yes - permissive |
| Pillow | MIT-CMU (HPND) | Yes - permissive |
| pystray | LGPL-3.0 | Yes - LGPLv3 is upward-compatible with GPLv3 |
| PyInstaller bootloader | GPL-2.0 with the bootloader exception, which explicitly permits linking it into any application | Yes - by the exception |

`packaging/collect_licences.py` copies the real licence texts out of the
installed packages into `licences/` in the build output, alongside `LICENSE`
and this file. Both build scripts run it, so a shipped folder carries the texts
rather than a link to them.

## pystray, and why it stopped being a problem

pystray is LGPL-3.0 and PyInstaller freezes it into `Moonshine Tray.exe`.

While Moonshine was proprietary this was a genuine blocker: LGPL section 4
requires that whoever receives the binary be able to replace the covered
library with their own version and still run the program, and a frozen
executable defeats that. Attribution does not cure it.

Publishing the source under GPL-3.0 resolves it two ways over. LGPLv3 grants
the option to convey the work under GPLv3 instead, so the combined program is
simply GPL-3.0. And the relinking requirement is satisfied by construction:
the complete source is public and `packaging/build.ps1` rebuilds the whole
thing, so anyone can substitute their own pystray and produce a working binary.

The macOS build never carried this at all - `packaging/macos.spec` excludes
pystray, because macOS silently refuses to draw new status items on a notched
display and there is no menu bar app to need it.

## Selling binaries under the GPL

This is allowed, and it has one condition worth stating plainly: conveying a
binary means conveying its Corresponding Source. Because the repository is
public, GPL-3.0 section 6(d) is satisfied by pointing at it - the download page
and the installer both have to carry a link to the source for the exact version
being sold, and it has to stay reachable for as long as the binary is offered.

The tag the release was built from is the version that matters. Selling a build
from an unpushed commit does not comply.

## Not bundled

Sunshine, Moonlight and Tailscale are **not** included in or modified by
Moonshine. It launches them as separate programs and stays on their own
upstream releases. Sunshine and Moonlight are GPL-3.0, the same licence
Moonshine now uses, so nothing about that relationship is strained either way.

Moonshine does write into Sunshine's *configuration* directory - box art and a
host name - which is user data, not the program. `moonshine setup` reports
every change it makes.

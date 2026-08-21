# Third-party notices

Moonshine is GPL-3.0-or-later. Its installer is self-contained, which makes
what is inside it *redistributed software* with obligations that attach to the
download rather than to the source tree.

## Bundled in the app installer

| Component | Licence | Compatible with GPL-3.0 |
|---|---|---|
| Electron | MIT | Yes - permissive |
| Chromium and its dependencies | BSD-3-Clause and others | Yes - permissive |
| Node.js | MIT | Yes - permissive |
| React | MIT | Yes - permissive |

electron-builder writes `LICENSE.electron.txt` and `LICENSES.chromium.html`
into the installed folder, so the licence texts travel with the binary without
anything here having to arrange it.

## Bundled in the CLI, if you build it

| Component | Licence | Compatible with GPL-3.0 |
|---|---|---|
| CPython | PSF License 2.0 | Yes - permissive |
| PyInstaller bootloader | GPL-2.0 with the bootloader exception, which explicitly permits linking it into any application | Yes - by the exception |

`packaging/collect_licences.py` copies CPython's licence text into the build
output. The CLI is not shipped by the installer.

## pystray, and why it is no longer here

pystray is LGPL-3.0, and while the tray was a Python app PyInstaller froze it
into the executable. That was a genuine blocker for selling: LGPL section 4
requires the recipient be able to replace the covered library and still run the
program, and a frozen executable defeats that.

Going GPL-3.0 resolved it twice over - LGPLv3 grants the option to convey under
GPLv3, and public reproducible source satisfies the relinking requirement. Then
the tray became an Electron app and the dependency left the project entirely.
It is recorded here because "we removed the dependency" is the answer that
stays true no matter what the licence does next.

Tkinter and Pillow left the shipped product the same way. Pillow is still used
by the scripts that draw the icons and box art, but nothing a user runs imports
it.

## Selling binaries under the GPL

Allowed, with one condition: conveying a binary means conveying its
Corresponding Source. Because the repository is public, GPL-3.0 section 6(d) is
satisfied by pointing at it - the download page and the installer both have to
carry a link to the source for the exact version being sold, and it has to stay
reachable for as long as the binary is offered.

The tag the release was built from is the version that matters. Selling a build
from an unpushed commit does not comply.

## Not bundled

Sunshine, Moonlight and Tailscale are **not** included in or modified by
Moonshine. It launches them as separate programs and stays on their own
upstream releases. Sunshine and Moonlight are GPL-3.0, the same licence
Moonshine uses, so nothing about that relationship is strained either way.

Moonshine does write into Sunshine's *configuration* directory - box art and a
host name - which is user data, not the program. The Set up screen reports
every change it makes.

# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

"""
Every user-visible name in one place.

The project was called `remote` until 2026-08-20 and the name was spread across
nine files - a window title, an argparse prog, a bundle identifier, a registry
value, two icon filenames and a state directory. Renaming it meant touching all
nine and missing one would have left a half-renamed app that still worked, so
the second name lives here instead.

`Moonshine` is Moonlight (the client) plus Sunshine (the host): the two pieces
this wraps, and the reason the name is not just decorative.
"""

from __future__ import annotations

# The name as written to a person - window titles, menus, headings.
NAME = "Moonshine"

# The name as written to a machine - directories, filenames, CLI prog, the
# registry value. Lowercase and safe for a path on either platform.
APP_ID = "moonshine"

# The shipped version. Read by the installers, the macOS bundle and anything
# that has to answer "which build is this" from a machine we cannot log into.
VERSION = "0.1.0"

# One line under the heading, and the CLI description.
TAGLINE = "Moonlight and Sunshine, tuned for your tailnet."

# Short form, where the full tagline does not fit.
SUBTITLE = "Low-latency desktop over your tailnet"

# Reverse-DNS identifier. The macOS bundle identifier, the launch agent label
# and the Windows AppUserModelID all come from here.
#
# `dev.austin` is a placeholder: reverse-DNS is supposed to be a domain you
# control, and this one is not registered. Change it before publishing - but
# know that changing it is not free. macOS keys TCC grants to the bundle
# identifier, so a build with a new one is a new app to the system: Screen
# Recording and Accessibility both have to be granted again, by hand, on every
# Mac that already had them. Do it once, before anyone else installs this.
BUNDLE_ID = f"dev.austin.{APP_ID}"

# The macOS bundle, and the executable inside it.
APP_BUNDLE = f"{NAME}.app"

# Box art for the apps Sunshine defines out of the box, keyed by the `name` in
# apps.json. Sunshine's own covers live under Program Files and are replaced by
# every update; these are installed into its config directory instead, which is
# user data and survives. Value is (label drawn on the tile, file in assets/).
COVERS = {
    "Desktop": ("Desktop", "cover-desktop.png"),
    "Steam Big Picture": ("Steam", "cover-steam.png"),
}


def host_display_name(hostname: str) -> str:
    """What Moonlight should call this machine, given its hostname.

    Sunshine defaults to the raw hostname, so the tower announces itself as
    `The_Tower`. This keeps the machine identifiable - several hosts in one
    list, and "Moonshine" alone would name the tool rather than the PC - while
    marking it as one of ours.
    """
    return f"{hostname.replace('_', ' ').strip()} — {NAME}"

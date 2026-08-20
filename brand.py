"""
Every user-visible name in one place.

The project was called `remote` until 2026-08-20 and the name was spread across
nine files - a window title, a menu bar title, an argparse prog, a launch agent
label, a registry value, two icon filenames and a state directory. Renaming it
meant touching all nine and missing one would have left a half-renamed app that
still worked, so the second name lives here instead.

`Moonshine` is Moonlight (the client) plus Sunshine (the host): the two pieces
this wraps, and the reason the name is not just decorative.
"""

from __future__ import annotations

# The name as written to a person - window titles, menus, headings.
NAME = "Moonshine"

# The name as written to a machine - directories, filenames, CLI prog, the
# registry value. Lowercase and safe for a path on either platform.
APP_ID = "moonshine"

# One line under the heading, and the CLI description.
TAGLINE = "Moonlight and Sunshine, tuned for your tailnet."

# Short form, where the full tagline does not fit.
SUBTITLE = "Low-latency desktop over your tailnet"

# Reverse-DNS identifiers. The launch agent label doubles as the plist
# filename and the `launchctl` target, so it has to stay stable.
BUNDLE_ID = f"dev.austin.{APP_ID}"
LAUNCH_AGENT_LABEL = f"dev.austin.{APP_ID}-tray"

# The macOS bundle, and the executable inside it.
APP_BUNDLE = f"{NAME}.app"

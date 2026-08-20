#!/bin/bash
# Apply a UI update, then rebuild Moonshine.app. Run it on the Mac.
#
# The normal route is SSH from the tower - `ssh ayoung@macbook-air`, note the
# username, it is not the Windows one. This script exists for when that is not
# available and the files arrive by Taildrop instead:
#
#   mkdir -p /tmp/moonshine-update        # tar -C will not create it
#   tar xzf ~/Downloads/moonshine-ui-update.tar.gz -C /tmp/moonshine-update
#   bash /tmp/moonshine-update/scripts/install_macos_update.sh
set -uo pipefail

SHARE="$HOME/.local/share/moonshine"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- rename migration, 2026-08-20 -------------------------------------------
# The project was `remote` until 2026-08-20. This Mac still has the old
# directory, launch agent and bundle, and none of them rename themselves. Doing
# it here means the Mac heals on the next update instead of needing a hand.
OLD_SHARE="$HOME/.local/share/remote"
OLD_LABEL="dev.austin.remote-tray"

if [ ! -d "$SHARE" ] && [ -d "$OLD_SHARE" ]; then
  echo "=== migrating $OLD_SHARE -> $SHARE ==="
  mv "$OLD_SHARE" "$SHARE"
fi

# Stop and remove the old agent before the new one is bootstrapped, or both run
# and two menu bar items fight over the same log file.
if launchctl print "gui/$(id -u)/${OLD_LABEL}" >/dev/null 2>&1; then
  echo "=== removing the old launch agent ==="
  launchctl bootout "gui/$(id -u)/${OLD_LABEL}" 2>/dev/null || true
fi
rm -f "$HOME/Library/LaunchAgents/${OLD_LABEL}.plist"

# The old bundle keeps its own Dock icon and Spotlight entry, so leaving it
# behind means two apps with the same purpose and different names.
for old_app in "$HOME/Applications/Remote.app" "$SHARE/Remote.app"                "/Applications/Remote.app"; do
  [ -e "$old_app" ] && rm -rf "$old_app" && echo "removed $old_app"
done

# The module was renamed, not copied, so the old one lingers in the deployment
# and would shadow nothing but still confuse the next person reading it.
rm -f "$SHARE/remote.py" "$SHARE/assets/remote.icns"       "$SHARE/assets/remote.ico" "$SHARE/assets/remote.png"

# The CLI symlink was made by hand, so nothing recreates it. Repoint it rather
# than leaving `remote` on PATH aimed at a file that has been renamed.
if [ -L "$HOME/.local/bin/remote" ] || [ -e "$HOME/.local/bin/remote" ]; then
  rm -f "$HOME/.local/bin/remote"
  echo "removed the old ~/.local/bin/remote"
fi
mkdir -p "$HOME/.local/bin"
ln -sf "$SHARE/moonshine.py" "$HOME/.local/bin/moonshine"
chmod +x "$SHARE/moonshine.py" 2>/dev/null || true
# ---------------------------------------------------------------------------

if [ ! -d "$SHARE" ]; then
  echo "error: $SHARE does not exist - this Mac has no deployment to update" >&2
  exit 1
fi

echo "=== copying updated files ==="
mkdir -p "$SHARE/scripts"
for file in ui.py window.py traycore.py moonshine.py brand.py; do
  if [ -f "$SOURCE/$file" ]; then
    cp "$SOURCE/$file" "$SHARE/$file"
    echo "  $file"
  fi
done
for file in make_icons.py build_macos_app.sh install_macos_update.sh; do
  if [ -f "$SOURCE/scripts/$file" ]; then
    cp "$SOURCE/scripts/$file" "$SHARE/scripts/$file"
    echo "  scripts/$file"
  fi
done
chmod +x "$SHARE/scripts/"*.sh

# Pillow is what makes the window's rounded cards and antialiased dots possible.
# Without it everything still runs, with square corners - so this is allowed to
# fail without taking the update down with it.
echo
echo "=== Pillow ==="
if "$SHARE/venv/bin/python" -c "import PIL" 2>/dev/null; then
  echo "  already installed"
else
  "$SHARE/venv/bin/pip" install --quiet pillow \
    && echo "  installed" \
    || echo "  FAILED - the window will fall back to square corners"
fi

echo
echo "=== icons ==="
"$SHARE/venv/bin/python" "$SHARE/scripts/make_icons.py" || true

echo
echo "=== rebuilding Moonshine.app ==="
bash "$SHARE/scripts/build_macos_app.sh"

echo
echo "=== restarting the menu bar agent ==="
LABEL="dev.austin.moonshine-tray"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/${LABEL}.plist" 2>/dev/null || true

echo
echo "Done. Open Moonshine.app to see the new window."

"""Put Moonshine's name and icon on Moonlight's window.

Moonlight is Qt Quick compiled into `Moonlight.exe` - there is no theme file, no
QML on disk, no resource bundle to swap. Nothing in its installation is
skinnable, and rebuilding it from source would mean giving up its updates, which
is the whole reason we use it.

So the branding happens at runtime instead. Two of the three profiles stream in
a real window, which means Moonlight's title and Moonlight's icon are what sit
in the taskbar all day. Once the process is up we find its windows by process id
and set both through `user32`. Nothing under Program Files is touched, so a
Moonlight update cannot undo this - it simply runs again on the next launch.

The loop keeps running for the life of the session on purpose: Moonlight builds
a new window when the stream starts, and Qt rewrites the title on its own
whenever the app or the host name changes. Re-reading the title and correcting
it when it is not ours is self-healing, where branding once at startup is not.
"""

from __future__ import annotations

import sys
import threading
import time

WINDOWS = sys.platform == "win32"

# Fast enough that the original title is never really seen, idle enough to be
# free - this is one EnumWindows call against a single process.
POLL_SECONDS = 0.4

if WINDOWS:
    import ctypes
    from ctypes import wintypes

    _user32 = ctypes.WinDLL("user32", use_last_error=True)

    _WM_SETICON = 0x0080
    _ICON_SMALL = 0
    _ICON_BIG = 1
    _IMAGE_ICON = 1
    _LR_LOADFROMFILE = 0x0010
    _GW_OWNER = 4
    _SM_CXSMICON = 49
    _SM_CXICON = 11

    _ENUM_PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    _user32.EnumWindows.argtypes = [_ENUM_PROC, wintypes.LPARAM]
    _user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND,
                                                 ctypes.POINTER(wintypes.DWORD)]
    _user32.IsWindowVisible.argtypes = [wintypes.HWND]
    _user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    _user32.GetWindow.restype = wintypes.HWND
    _user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    _user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _user32.SetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPCWSTR]
    _user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT,
                                     wintypes.WPARAM, wintypes.LPARAM]
    _user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR,
                                   wintypes.UINT, ctypes.c_int, ctypes.c_int,
                                   wintypes.UINT]
    _user32.LoadImageW.restype = wintypes.HANDLE

# The icons stay loaded for the life of the process. Destroying them would blank
# the very taskbar entry we just set, and there is exactly one session per run.
_icon_cache: dict[str, tuple[int, int]] = {}


def _windows_of(pid: int) -> list[int]:
    """Top-level, visible, captioned windows belonging to `pid`.

    The owner test is what separates the real window from Qt's tooltips, menus
    and off-screen helpers, which are owned windows and must not be retitled.
    """
    found: list[int] = []

    def callback(hwnd, _lparam):
        owner_pid = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner_pid))
        if (owner_pid.value == pid
                and _user32.IsWindowVisible(hwnd)
                and not _user32.GetWindow(hwnd, _GW_OWNER)
                and _user32.GetWindowTextLengthW(hwnd) > 0):
            found.append(hwnd)
        return True

    _user32.EnumWindows(_ENUM_PROC(callback), 0)
    return found


def _title_of(hwnd: int) -> str:
    length = _user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buffer = ctypes.create_unicode_buffer(length + 1)
    _user32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value


def _icons_for(icon_path: str) -> tuple[int, int]:
    """Load the icon at the two sizes Windows asks for, once per path.

    Small is the title bar and the taskbar; big is Alt-Tab. Loading a single
    size and letting Windows scale it is what makes an icon look muddy in one
    place and sharp in the other.
    """
    if icon_path not in _icon_cache:
        small = _user32.GetSystemMetrics(_SM_CXSMICON)
        big = _user32.GetSystemMetrics(_SM_CXICON)
        _icon_cache[icon_path] = (
            _user32.LoadImageW(None, icon_path, _IMAGE_ICON, small, small,
                               _LR_LOADFROMFILE) or 0,
            _user32.LoadImageW(None, icon_path, _IMAGE_ICON, big, big,
                               _LR_LOADFROMFILE) or 0,
        )
    return _icon_cache[icon_path]


def _apply(hwnd: int, title: str, icons: tuple[int, int]) -> None:
    _user32.SetWindowTextW(hwnd, title)
    small, big = icons
    if small:
        _user32.SendMessageW(hwnd, _WM_SETICON, _ICON_SMALL, small)
    if big:
        _user32.SendMessageW(hwnd, _WM_SETICON, _ICON_BIG, big)


def _loop(pid: int, title: str, icon_path: str, still_running) -> None:
    icons = _icons_for(icon_path)
    while still_running():
        try:
            for hwnd in _windows_of(pid):
                if _title_of(hwnd) != title:
                    _apply(hwnd, title, icons)
        except OSError:
            # A window can die between the enumeration and the call. That is
            # normal during teardown and never worth taking the session down.
            pass
        time.sleep(POLL_SECONDS)


def brand(pid: int, title: str, icon_path: str, still_running) -> threading.Thread | None:
    """Keep `pid`'s windows wearing our title and icon until it exits.

    A no-op anywhere but Windows: macOS gives a process no way to retitle
    another application's window without an accessibility grant, which is a
    permission prompt for a cosmetic change and not worth asking for.
    """
    if not WINDOWS:
        return None
    thread = threading.Thread(
        target=_loop, args=(pid, title, icon_path, still_running), daemon=True)
    thread.start()
    return thread

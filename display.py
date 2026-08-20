"""
Windows display modes - listing them, and changing the host's refresh rate.

This exists because of a wrong assumption. The README recorded the host display
as 60Hz, and concluded that going past 60fps required the Parsec Virtual Display
Adapter. The panel is an Alienware AW2724DM, which enumerates 2560x1440 at up to
165Hz; Windows simply had it set to 59Hz. The cap was a setting, not hardware, so
no virtual display is involved in lifting it.

Sunshine captures the physical desktop, so whatever refresh rate the desktop is
running at is the ceiling on capture. Raising it raises the ceiling.

Windows-only. Everything here is ctypes over user32 - no dependencies, because
this has to work from the same interpreter the tray app runs under.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes
from dataclasses import dataclass

DISPLAY_DEVICE_ACTIVE = 0x1
DISPLAY_DEVICE_PRIMARY = 0x4

ENUM_CURRENT_SETTINGS = -1
ENUM_REGISTRY_SETTINGS = -2

DM_PELSWIDTH = 0x00080000
DM_PELSHEIGHT = 0x00100000
DM_DISPLAYFREQUENCY = 0x00400000

CDS_UPDATEREGISTRY = 0x00000001
CDS_TEST = 0x00000002

# ChangeDisplaySettingsEx return codes worth naming.
DISP_CHANGE = {
    0: "ok",
    -1: "restart required",
    -2: "the display driver refused the mode",
    -3: "the mode change failed",
    -4: "bad mode",
    -5: "not updated - registry write failed",
    -6: "bad flags",
    -9: "bad parameters",
}


class DISPLAY_DEVICE(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD),
                ("DeviceName", wintypes.WCHAR * 32),
                ("DeviceString", wintypes.WCHAR * 128),
                ("StateFlags", wintypes.DWORD),
                ("DeviceID", wintypes.WCHAR * 128),
                ("DeviceKey", wintypes.WCHAR * 128)]


class DEVMODE(ctypes.Structure):
    _fields_ = [("dmDeviceName", wintypes.WCHAR * 32),
                ("dmSpecVersion", wintypes.WORD),
                ("dmDriverVersion", wintypes.WORD),
                ("dmSize", wintypes.WORD),
                ("dmDriverExtra", wintypes.WORD),
                ("dmFields", wintypes.DWORD),
                ("dmPositionX", ctypes.c_long),
                ("dmPositionY", ctypes.c_long),
                ("dmDisplayOrientation", wintypes.DWORD),
                ("dmDisplayFixedOutput", wintypes.DWORD),
                ("dmColor", ctypes.c_short),
                ("dmDuplex", ctypes.c_short),
                ("dmYResolution", ctypes.c_short),
                ("dmTTOption", ctypes.c_short),
                ("dmCollate", ctypes.c_short),
                ("dmFormName", wintypes.WCHAR * 32),
                ("dmLogPixels", wintypes.WORD),
                ("dmBitsPerPel", wintypes.DWORD),
                ("dmPelsWidth", wintypes.DWORD),
                ("dmPelsHeight", wintypes.DWORD),
                ("dmDisplayFlags", wintypes.DWORD),
                ("dmDisplayFrequency", wintypes.DWORD),
                ("dmICMMethod", wintypes.DWORD),
                ("dmICMIntent", wintypes.DWORD),
                ("dmMediaType", wintypes.DWORD),
                ("dmDitherType", wintypes.DWORD),
                ("dmReserved1", wintypes.DWORD),
                ("dmReserved2", wintypes.DWORD),
                ("dmPanningWidth", wintypes.DWORD),
                ("dmPanningHeight", wintypes.DWORD)]


@dataclass
class Monitor:
    name: str          # "\\.\DISPLAY1" - what Sunshine's output_name expects
    adapter: str
    primary: bool
    width: int
    height: int
    refresh: int

    @property
    def label(self) -> str:
        star = " (primary)" if self.primary else ""
        return f"{self.name}{star}  {self.width}x{self.height} @ {self.refresh}Hz"


def _user32():
    if sys.platform != "win32":
        raise RuntimeError("display control is Windows-only")
    return ctypes.WinDLL("user32", use_last_error=True)


def monitors() -> list[Monitor]:
    """Every display currently attached to the desktop."""
    user32 = _user32()
    found: list[Monitor] = []
    index = 0
    while True:
        device = DISPLAY_DEVICE()
        device.cb = ctypes.sizeof(device)
        if not user32.EnumDisplayDevicesW(None, index, ctypes.byref(device), 0):
            break
        index += 1
        if not device.StateFlags & DISPLAY_DEVICE_ACTIVE:
            continue

        current = DEVMODE()
        current.dmSize = ctypes.sizeof(current)
        if not user32.EnumDisplaySettingsW(device.DeviceName, ENUM_CURRENT_SETTINGS,
                                           ctypes.byref(current)):
            continue
        found.append(Monitor(
            name=device.DeviceName,
            adapter=device.DeviceString,
            primary=bool(device.StateFlags & DISPLAY_DEVICE_PRIMARY),
            width=current.dmPelsWidth,
            height=current.dmPelsHeight,
            refresh=current.dmDisplayFrequency,
        ))
    return found


def primary() -> Monitor | None:
    for monitor in monitors():
        if monitor.primary:
            return monitor
    return None


def modes(name: str) -> list[tuple[int, int, int]]:
    """Every (width, height, refresh) the display will accept."""
    user32 = _user32()
    seen: set[tuple[int, int, int]] = set()
    index = 0
    while True:
        dm = DEVMODE()
        dm.dmSize = ctypes.sizeof(dm)
        if not user32.EnumDisplaySettingsW(name, index, ctypes.byref(dm)):
            break
        index += 1
        seen.add((dm.dmPelsWidth, dm.dmPelsHeight, dm.dmDisplayFrequency))
    return sorted(seen)


def refresh_rates(name: str, width: int, height: int) -> list[int]:
    return sorted({hz for w, h, hz in modes(name) if (w, h) == (width, height)})


def set_mode(name: str, width: int, height: int, refresh: int,
             test_only: bool = False) -> tuple[bool, str]:
    """Change one display's mode. Returns (ok, human-readable result).

    The mode is always tested before it is applied. A refresh rate the panel
    cannot do is otherwise a black screen you have to wait fifteen seconds to
    get out of, which is a poor thing to do to somebody's only monitor.
    """
    user32 = _user32()
    dm = DEVMODE()
    dm.dmSize = ctypes.sizeof(dm)
    # Start from the current mode so untouched fields stay valid.
    if not user32.EnumDisplaySettingsW(name, ENUM_CURRENT_SETTINGS, ctypes.byref(dm)):
        return False, f"could not read the current mode of {name}"

    dm.dmPelsWidth = width
    dm.dmPelsHeight = height
    dm.dmDisplayFrequency = refresh
    dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY

    result = user32.ChangeDisplaySettingsExW(name, ctypes.byref(dm), None,
                                             CDS_TEST, None)
    if result != 0:
        return False, DISP_CHANGE.get(result, f"rejected ({result})")
    if test_only:
        return True, "mode is supported"

    result = user32.ChangeDisplaySettingsExW(name, ctypes.byref(dm), None,
                                             CDS_UPDATEREGISTRY, None)
    if result != 0:
        return False, DISP_CHANGE.get(result, f"failed ({result})")
    return True, "ok"


def best_refresh(name: str, width: int, height: int, cap: int | None = None) -> int | None:
    """Highest refresh the display supports at a resolution, optionally capped."""
    rates = refresh_rates(name, width, height)
    if cap is not None:
        rates = [hz for hz in rates if hz <= cap]
    return max(rates) if rates else None

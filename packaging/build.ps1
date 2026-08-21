# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

<#
Build the Windows release: three executables, then an installer.

    powershell -ExecutionPolicy Bypass -File packaging\build.ps1

Output:
    dist\Moonshine\                     the unpacked app, runnable in place
    dist\Moonshine-<version>-setup.exe  the installer, if Inno Setup is present

The installer step is skipped rather than fatal when Inno Setup is missing, so
this still produces something testable on a machine that only has Python.
#>
[CmdletBinding()]
param(
    [switch]$SkipInstaller,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (python -c "import brand; print(brand.VERSION)").Trim()
Write-Host "Building Moonshine $version" -ForegroundColor Cyan

if ($Clean) {
    Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue
    Write-Host "  cleaned build\ and dist\"
}

# The icons are generated rather than committed, so a checkout that has never
# run this has no .ico for PyInstaller to embed.
python scripts\make_icons.py --png
if ($LASTEXITCODE -ne 0) { throw "icon generation failed" }

python -m PyInstaller packaging\windows.spec --noconfirm --distpath dist --workpath build
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

# A build where the CLI silently became the GUI is the failure this catches:
# NTFS is case-insensitive, so a naming mistake in the spec produces a folder
# that looks right and a `moonshine.exe` that opens a window and never returns.
$expected = @("Moonshine App.exe", "Moonshine Tray.exe", "moonshine.exe")
foreach ($exe in $expected) {
    if (-not (Test-Path "dist\Moonshine\$exe")) { throw "missing dist\Moonshine\$exe" }
}
$help = & "dist\Moonshine\moonshine.exe" --help 2>&1 | Out-String
if ($help -notmatch "tuned for your tailnet") { throw "the built CLI did not answer --help" }
Write-Host "  three executables, CLI answers --help" -ForegroundColor Green

# The installer redistributes a Python interpreter, Tcl/Tk, Pillow and pystray.
# Their licence texts have to travel with it, so they are collected into the
# folder Inno Setup is about to package.
python packaging\collect_licences.py dist\Moonshine
if ($LASTEXITCODE -ne 0) { throw "licence collection failed" }

if ($SkipInstaller) { Write-Host "Done (installer skipped)."; exit 0 }

# Inno Setup 6.7 installs per-user under LOCALAPPDATA by default - the winget
# package does not go to Program Files, and looking only there is how the first
# run of this script reported it as missing while it was already installed.
$iscc = @(
    (Get-Command iscc -ErrorAction SilentlyContinue).Source,
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $iscc) {
    Write-Warning "Inno Setup 6 not found - skipping the installer."
    Write-Warning "  winget install JRSoftware.InnoSetup"
    exit 0
}

& $iscc "packaging\moonshine.iss" "/DAppVersion=$version"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed" }

Write-Host "Built dist\Moonshine-$version-setup.exe" -ForegroundColor Green
Write-Host "NOT SIGNED: SmartScreen will warn on download. See packaging\README.md." -ForegroundColor Yellow
Write-Host "Selling this build means linking to the source it came from - GPL-3.0 section 6(d). See THIRD-PARTY-NOTICES.md." -ForegroundColor Yellow

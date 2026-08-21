# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Austin

<#
Build the Windows release.

    powershell -ExecutionPolicy Bypass -File packaging\build.ps1
    powershell -ExecutionPolicy Bypass -File packaging\build.ps1 -Cli

The app is the product: an Electron build, packaged by electron-builder into
an installer. The Python CLI is a separate, optional artifact - it is not in
the installer, and -Cli is what builds it.

Output:
    app\dist\Moonshine-<version>-setup.exe    the installer
    dist\moonshine\moonshine.exe              the CLI, with -Cli
#>
[CmdletBinding()]
param(
    [switch]$Cli,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (python -c "import brand; print(brand.VERSION)").Trim()
Write-Host "Building Moonshine $version" -ForegroundColor Cyan

if ($Clean) {
    Remove-Item -Recurse -Force build, dist, app\out, app\dist -ErrorAction SilentlyContinue
    Write-Host "  cleaned"
}

# The icons and box art are generated rather than committed, so a fresh
# checkout has nothing for either build to embed.
python scripts\make_icons.py --png
if ($LASTEXITCODE -ne 0) { throw "icon generation failed" }
python app\resources\generate-assets.py
if ($LASTEXITCODE -ne 0) { throw "app asset generation failed" }

Push-Location app
try {
    if (-not (Test-Path node_modules)) {
        Write-Host "  installing app dependencies..."
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }

    # `npm run build` typechecks both projects before bundling, so a build that
    # succeeds is a build that compiles.
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "app build failed" }

    npx electron-builder --win
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
}
finally { Pop-Location }

$installer = Get-ChildItem "app\dist\*-setup.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $installer) { throw "no installer was produced" }
Write-Host "Built $($installer.FullName)" -ForegroundColor Green

if ($Cli) {
    python -m PyInstaller packaging\windows.spec --noconfirm --distpath dist --workpath build
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

    $help = & "dist\moonshine\moonshine.exe" --help 2>&1 | Out-String
    if ($help -notmatch "tuned for your tailnet") { throw "the built CLI did not answer --help" }
    Write-Host "Built dist\moonshine\moonshine.exe" -ForegroundColor Green
}

Write-Host "NOT SIGNED: SmartScreen will warn on download. See packaging\README.md." -ForegroundColor Yellow
Write-Host "Selling this build means linking to the source it came from - GPL-3.0 section 6(d)." -ForegroundColor Yellow

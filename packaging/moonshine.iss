; SPDX-License-Identifier: GPL-3.0-or-later
; Copyright (C) 2026 Austin

; Inno Setup script for the Moonshine installer.
;
; Builds a single Moonshine-<version>-setup.exe from dist\Moonshine, which
; packaging\build.ps1 produces by running PyInstaller first.
;
;   iscc packaging\moonshine.iss /DAppVersion=0.1.0
;
; Per-user by default. PrivilegesRequired=lowest means no UAC prompt and no
; admin account needed, which matters because the people this ships to are
; installing it on their own machine. `moonshine setup` is the thing that
; wants elevation, and only to scope the firewall - it prints that command
; rather than requiring the whole installer to run as administrator.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#define AppName    "Moonshine"
#define AppId      "moonshine"
#define AppExe     "Moonshine App.exe"
#define TrayExe    "Moonshine Tray.exe"
#define CliExe     "moonshine.exe"
; TODO: set this to the public repository before the first release. It is
; not decoration - GPL-3.0 section 6(d) is satisfied by pointing at the
; source, and this is where the installer points.
#define SourceUrl  "https://example.invalid/moonshine"

[Setup]
AppId={{8F3C1E2A-6B47-4D91-9E5C-0A2D7B4F1C88}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
AppPublisherURL={#SourceUrl}
AppSupportURL={#SourceUrl}
AppUpdatesURL={#SourceUrl}
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename={#AppName}-{#AppVersion}-setup
SetupIconFile=..\assets\moonshine.ico
; The GPL is not an EULA and does not need to be accepted to install - but
; showing it is how a binary tells its recipient what they are allowed to do
; with it, which is most of section 6.
LicenseFile=..\LICENSE
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; \
  GroupDescription: "Shortcuts:"
Name: "traystartup"; Description: "Start the &tray icon when I sign in"; \
  GroupDescription: "Startup:"
Name: "addtopath"; Description: "Add the &moonshine command to PATH"; \
  GroupDescription: "Command line:"; Flags: unchecked

[Files]
Source: "..\dist\Moonshine\*"; DestDir: "{app}"; \
  Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\{#AppName} Tray"; Filename: "{app}\{#TrayExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; \
  Tasks: desktopicon

[Registry]
; The tray writes this same value from its own menu, so the installer and the
; app share one entry rather than leaving two behind. Removal is handled in
; [Code] rather than with uninsdeletevalue - see the note there.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "{#AppId}-tray"; ValueData: """{app}\{#TrayExe}"""; \
  Tasks: traystartup
; Prepend rather than append so `moonshine` resolves to this install even if an
; older copy is on PATH. Inno expands {olddata} to the existing value.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{app};{olddata}"; Flags: preservestringtype; Tasks: addtopath

[Run]
Filename: "{app}\{#CliExe}"; Parameters: "setup"; \
  Description: "Set up this PC as a stream host"; \
  Flags: postinstall shellexec skipifsilent
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; \
  Flags: postinstall nowait skipifsilent

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  RunName = '{#AppId}-tray';

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  // Take the login entry out only when it points into THIS installation.
  //
  // The tray writes the same value name wherever it runs from, so a copy
  // running from a source checkout owns an entry that looks identical. The
  // first version of this script removed it unconditionally - an
  // [UninstallRun] calling `--uninstall-autostart` - and uninstalling a test
  // build silently disabled the autostart of a separate, unrelated install.
  // `uninsdeletevalue` has the same flaw: it deletes by name, not by owner.
  if CurUninstallStep = usUninstall then
  begin
    if RegQueryStringValue(HKCU, RunKey, RunName, Data) then
      if Pos(Lowercase(ExpandConstant('{app}')), Lowercase(Data)) > 0 then
        RegDeleteValue(HKCU, RunKey, RunName);
  end;

  // Nothing is removed from %APPDATA%\moonshine: it holds the hide list and
  // every session log, and a reinstall should find them again. Say so rather
  // than deleting them quietly - or leaving them silently.
  //
  // SuppressibleMsgBox, not MsgBox: MsgBox ignores /SUPPRESSMSGBOXES, so an
  // unattended uninstall hangs on a dialog with nobody there to click it.
  if CurUninstallStep = usPostUninstall then
    SuppressibleMsgBox('Your session logs and settings are still in' + #13#10 +
           ExpandConstant('{userappdata}\{#AppId}') + #13#10#13#10 +
           'Delete that folder by hand if you want them gone.',
           mbInformation, MB_OK, IDOK);
end;

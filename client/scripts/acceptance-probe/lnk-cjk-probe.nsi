; ACCEPTANCE-ONLY fixture (#50 extension A1: Start Menu shortcut target under a
; CJK/space install directory). Same calls as installer.nsi
; CreateOrUpdateStartMenuShortcut: CreateShortcut, then utils.nsh
; SetLnkAppUserModelId. Run with /S /D=<dir>; current user's Start Menu only.
Unicode true
!addincludedir "..\..\windows-electron"
!include LogicLib.nsh
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "utils.nsh"
!define BUNDLEID "com.tarobot.client.cjkprobe"
Name "TaroBird CJK shortcut probe"
OutFile "${OUT}"
RequestExecutionLevel user
SilentInstall silent
InstallDir "$LOCALAPPDATA\TaroBird CJK Probe Default"
Section
  CreateShortcut "$SMPROGRAMS\TaroBird CJK Probe.lnk" "$INSTDIR\tarocub-client.exe"
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\TaroBird CJK Probe.lnk"
SectionEnd

; ACCEPTANCE-ONLY fixture (#50 shortcut AppID probe). Uses the installer's own
; utils.nsh SetLnkAppUserModelId on a probe shortcut (probe AppID, notepad
; target) beside a plain control shortcut. Current user's Start Menu only.
Unicode true
!addincludedir "..\..\windows-electron"
!include LogicLib.nsh
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "utils.nsh"
!define BUNDLEID "com.tarobot.client.appidprobe"
Name "TaroBird AppID probe"
OutFile "${OUT}"
RequestExecutionLevel user
SilentInstall silent
Section
  CreateDirectory "$SMPROGRAMS\TaroBird AppID Probe"
  CreateShortcut "$SMPROGRAMS\TaroBird AppID Probe\TaroBird AppID Probe.lnk" "$WINDIR\notepad.exe"
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\TaroBird AppID Probe\TaroBird AppID Probe.lnk"
  CreateShortcut "$SMPROGRAMS\TaroBird AppID Probe\TaroBird AppID Probe Plain.lnk" "$WINDIR\notepad.exe"
SectionEnd

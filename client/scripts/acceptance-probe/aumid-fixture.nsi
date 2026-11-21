; Acceptance-only fixture (#50 follow-up, install/notification-aumid): the
; product's own utils.nsh SetLnkAppUserModelId, exactly as installer.nsi uses
; it after CreateShortcut, on a per-user Start Menu link to a copy of a system
; exe. Installs nothing else. Build: makensis /DUTILS=... /DTARGET=... /DOUT=...
Unicode true
RequestExecutionLevel user
SilentInstall silent
!define BUNDLEID "com.tarobot.aumidprobe.nsis"
!define /ifndef LINK "TaroBird AUMID Probe Nsis"
!include LogicLib.nsh
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "${UTILS}"
OutFile "${OUT}"
Section
  SetShellVarContext current
  CreateShortcut "$SMPROGRAMS\${LINK}.lnk" "${TARGET}"
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${LINK}.lnk"
SectionEnd

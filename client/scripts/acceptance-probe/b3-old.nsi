; Acceptance-only fixture (#50 extension B-3 driver pre-check): an "old
; installed app" whose UNINSTALLER, like 1.5.x, asks for a language
; (MUI_UNGETLANGUAGE without a stored language) and has confirm/instfiles pages.
; /S install writes only the uninstaller and HKCU\Software\TaroBirdAcceptanceB3.
Unicode true
RequestExecutionLevel user
Name "TaroBird"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\TaroBirdB3Fixture"
!include MUI2.nsh
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "Software\TaroBirdAcceptanceB3Lang"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
Section
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\TaroBirdAcceptanceB3" "" "$INSTDIR"
  WriteRegStr HKCU "Software\TaroBirdAcceptanceB3" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
SectionEnd
Function un.onInit
  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd
Section Uninstall
  Delete "$INSTDIR\uninstall.exe"
  DeleteRegKey HKCU "Software\TaroBirdAcceptanceB3"
  RMDir "$INSTDIR"
SectionEnd

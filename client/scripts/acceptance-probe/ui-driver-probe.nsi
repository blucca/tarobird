; ACCEPTANCE-ONLY fixture (#50 UI driver probe). Same MUI LangDLL chooser as
; the TaroBird installer, then one TB- diagnostic with Retry/Cancel and the
; aborted page's Close button. Installs nothing; probe registry key only.
Unicode true
!include "MUI2.nsh"
Name "TaroBird probe"
OutFile "${OUT}"
RequestExecutionLevel user
InstallDir "$TEMP\tarobird-ui-probe"
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "Software\tarobird-ui-probe"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_RESERVEFILE_LANGDLL
Function .onInit
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd
Section "probe"
  probe_retry:
  MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "TaroBird probe — Removing program files$\r$\nTaroBird 0.0.0 · TB-PROBE" /SD IDCANCEL IDRETRY probe_retry
  Abort "probe stopped (TB-PROBE)"
SectionEnd

; ACCEPTANCE-ONLY. Never ship or merge into main.
; run.mjs appends this to a variant's installer.nsi text up to its
; `Var PassiveMode` line, unchanged, and replaces the marker below with that
; variant's own `Function PageLeaveReinstall … FunctionEnd`, verbatim. The
; reinstall page is driven as /P drives it (same version, "uninstall" choice),
; with the product's uninstall and product keys pointed at a lab key.

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

!undef UNINSTKEY
!define UNINSTKEY "${PROBE_KEY}\Uninstall"
!undef MANUPRODUCTKEY
!define MANUPRODUCTKEY "${PROBE_KEY}\Product"

Name "TaroBird reinstall language probe"
OutFile "${PROBE_OUT}"
InstallDir "$TEMP\tarobird-reinstall-probe-unused"
RequestExecutionLevel user
ShowInstDetails show

!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"
!include "installer-language.nsh"

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_RESERVEFILE_LANGDLL
  !include "SimpChinese.nsh"
  !include "English.nsh"

!macro ProbeWrite FILE TEXT
  ClearErrors
  FileOpen $9 "$INSTDIR\${FILE}" w
  ${IfNot} ${Errors}
    FileWriteUTF16LE /BOM $9 "${TEXT}"
    FileClose $9
  ${EndIf}
!macroend

;@@PAGELEAVEREINSTALL@@

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro BirdChooseLanguage
  !endif
  !insertmacro SetContext
FunctionEnd

Section Probe
  SetOutPath $INSTDIR
  ; As PageReinstall hands over in /P: same version ($R0 = 0) and no radio
  ; control ($R1 = 0, "uninstall"), which leads to reinst_uninstall.
  StrCpy $R0 0
  StrCpy $R2 ""
  Call PageLeaveReinstall
  !insertmacro ProbeWrite "new-continued.txt" "$LANGUAGE"
  SetAutoClose true
SectionEnd

Function .onInstSuccess
  !insertmacro BirdKeepSavedLanguage
FunctionEnd

Section Uninstall
SectionEnd

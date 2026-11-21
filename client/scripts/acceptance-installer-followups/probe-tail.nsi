; ACCEPTANCE-ONLY. Never ship or merge into main.
; run.mjs appends this to the product's installer.nsi text up to its
; `Var PassiveMode` line, unchanged: so the product's own defines and its
; hooks -> diagnostics -> notes includes are compiled in the product's order
; (VERSION comes from the product's `!define VERSION "${TB_VERSION}"`, never
; from this probe). Below, the probe declares what installer.nsi declares
; after that line, pointed at a lab registry key, and mirrors .onInit,
; .onInstSuccess, un.onInit and un.onUninstSuccess. It installs nothing.
;   PROBE_LANG keep      .onInit/un.onInit as 185a175+, .onInstSuccess keeps the saved language
;              choose    as 8a86382 (no pick, no keep)
;              baseline  as cfbf8f0/47450f7 (MUI_LANGDLL_DISPLAY, MUI_UNGETLANGUAGE before /P)
;   /CASE=makeun   write probe-uninstall.exe into $INSTDIR
;   /CASE=stop     run the product's TaroBotStopLocalHost on the $INSTDIR layout
;   /PICK=<id> /SAVED=<value>   (keep only) BirdPassiveLanguagePick with driven inputs

Var PassiveMode
Var UpdateMode
Var ProbeCase

Name "TaroBird installer follow-ups probe"
OutFile "${PROBE_OUT}"
InstallDir "$TEMP\tarobird-followups-probe-unused"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show
!addplugindir "${ADDITIONALPLUGINSPATH}"

!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${PROBE_KEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_RESERVEFILE_LANGDLL
  !include "SimpChinese.nsh"
  !include "English.nsh"
!if "${PROBE_LANG}" != "baseline"
  !include "installer-language.nsh"
!endif

LangString probeLanguage ${LANG_SIMPCHINESE} "zh"
LangString probeLanguage ${LANG_ENGLISH} "en"

!macro ProbeOptions
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
!macroend

!macro ProbeWrite FILE TEXT
  ClearErrors
  FileOpen $9 "$INSTDIR\${FILE}" w
  ${IfNot} ${Errors}
    FileWriteUTF16LE /BOM $9 "${TEXT}"
    FileClose $9
  ${EndIf}
!macroend

Function .onInit
  !insertmacro ProbeOptions
  !if "${PROBE_LANG}" == "keep"
    ${GetOptions} $CMDLINE "/PICK=" $0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/SAVED=" $1
      !insertmacro BirdPassiveLanguagePick
      !insertmacro ProbeWrite "pick.txt" "$0"
      Quit
    ${EndIf}
  !endif
  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !if "${PROBE_LANG}" == "baseline"
      !insertmacro MUI_LANGDLL_DISPLAY
    !else
      !insertmacro BirdChooseLanguage
    !endif
  !endif
  !insertmacro SetContext
FunctionEnd

Section Probe
  SetOutPath $INSTDIR
  ; As NSIS_HOOK_PREINSTALL does first in every product install.
  StrCpy $BirdOperation "$(birdInstall)"
  StrCpy $BirdBackupState "$(birdNotRequested)"
  StrCpy $BirdNoticeState ""
  !insertmacro ProbeWrite "install-language.txt" "$LANGUAGE $(probeLanguage)"
  ${GetOptions} $CMDLINE "/CASE=" $ProbeCase
  ${If} $ProbeCase == "makeun"
    WriteUninstaller "$INSTDIR\probe-uninstall.exe"
  ${ElseIf} $ProbeCase == "stop"
    !insertmacro TaroBotStopLocalHost 1
    !insertmacro ProbeWrite "stop-confirmed.txt" "installer"
  ${EndIf}
  SetAutoClose true
SectionEnd

Function .onInstSuccess
  !if "${PROBE_LANG}" == "keep"
    !insertmacro BirdKeepSavedLanguage
  !endif
  !insertmacro BirdNoteDone
FunctionEnd

Function un.onInit
  !insertmacro SetContext
  !if "${PROBE_LANG}" == "baseline"
    !insertmacro MUI_UNGETLANGUAGE
  !endif
  !insertmacro ProbeOptions
  !if "${PROBE_LANG}" != "baseline"
    !insertmacro BirdChooseLanguage
  !endif
FunctionEnd

Section Uninstall
  ; As NSIS_HOOK_PREUNINSTALL does first in every product uninstall.
  StrCpy $BirdOperation "$(birdUninstall)"
  StrCpy $BirdBackupState "$(birdNotRequested)"
  StrCpy $BirdNoticeState ""
  !insertmacro ProbeWrite "uninstall-language.txt" "$LANGUAGE $(probeLanguage)"
  ${GetOptions} $CMDLINE "/CASE=" $ProbeCase
  ${If} $ProbeCase == "stop"
    !insertmacro TaroBotStopLocalHost 0
    !insertmacro ProbeWrite "stop-confirmed.txt" "uninstaller"
  ${EndIf}
  SetAutoClose true
SectionEnd

Function un.onUninstSuccess
  !insertmacro BirdNoteDone
FunctionEnd

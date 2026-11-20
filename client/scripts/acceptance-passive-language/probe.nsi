; ACCEPTANCE-ONLY (Windows /P language). Never ship or merge into main.
; A tiny installer/uninstaller with the product's language setup: the same MUI
; languages and registry defines (pointed at a lab key), the same .onInit and
; un.onInit option reading, and the product's installer-language.nsh. With
; /DBASELINE it instead uses cfbf8f0's two lines (MUI_LANGDLL_DISPLAY in
; .onInit, MUI_UNGETLANGUAGE before /P in un.onInit) as the negative control.
; It installs nothing; $INSTDIR is a lab folder given with /D= or _?=.
; Each run writes the language it ended up using (UTF-16LE) to the lab folder.
;   /MAKEUN   also write probe-uninstall.exe beside it
Unicode true
ManifestDPIAware true
!ifndef TEMPLATE
  !error "TEMPLATE (product client\windows-electron folder) is required"
!endif
!ifndef OUT
  !error "OUT is required"
!endif
!ifndef KEY
  !error "KEY (lab HKCU key) is required"
!endif

Name "TaroBird language probe"
OutFile "${OUT}"
RequestExecutionLevel user
InstallDir "$TEMP\tarobird-language-probe-unused"
ShowInstDetails show
ShowUninstDetails show

!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh

Var PassiveMode
Var UpdateMode

; As installer.nsi, but a lab key instead of Software\tarocub\TaroBot.
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${KEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_RESERVEFILE_LANGDLL
!ifndef BASELINE
  !include "${TEMPLATE}\installer-language.nsh"
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

!macro ProbeRecord FILE
  ClearErrors
  FileOpen $0 "$INSTDIR\${FILE}" w
  ${IfNot} ${Errors}
    FileWriteUTF16LE /BOM $0 "$LANGUAGE $(probeLanguage) passive=$PassiveMode update=$UpdateMode"
    FileClose $0
  ${EndIf}
!macroend

Function .onInit
  !insertmacro ProbeOptions
  !ifdef BASELINE
    !insertmacro MUI_LANGDLL_DISPLAY
  !else
    !insertmacro BirdChooseLanguage
  !endif
FunctionEnd

Section Probe
  SetOutPath $INSTDIR
  !insertmacro ProbeRecord "install-language.txt"
  ${GetOptions} $CMDLINE "/MAKEUN" $1
  ${IfNot} ${Errors}
    WriteUninstaller "$INSTDIR\probe-uninstall.exe"
  ${EndIf}
  SetAutoClose true
SectionEnd

Function un.onInit
  !ifdef BASELINE
    !insertmacro MUI_UNGETLANGUAGE
  !endif
  !insertmacro ProbeOptions
  !ifndef BASELINE
    !insertmacro BirdChooseLanguage
  !endif
FunctionEnd

Section Uninstall
  !insertmacro ProbeRecord "uninstall-language.txt"
  SetAutoClose true
SectionEnd

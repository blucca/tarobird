; ACCEPTANCE-ONLY (#50 local setup notes). Never ship or merge into main.
; A tiny installer/uninstaller that includes the product's own
; installer-diagnostics.nsh (with installer-notes.nsh when present) and
; language files, then reaches BirdProblem exactly as the product does, so a
; disposable Windows runner can observe what is left after setup closes.
; It installs nothing; $INSTDIR is a lab folder given with /D=.
;   /CASE=files|host|backup  diagnosed stop (exit code 2)
;   /CASE=ok                 finished run
;   /CASE=repeat /COUNT=n    n finished-run notes in one process; exit code =
;                            notes written, including .onInstSuccess's own
;   /CASE=uninstaller        write probe-uninstall.exe beside it
;   /ZH                      Simplified Chinese strings
; .onInstFailed/un.onUninstFailed save the assembled dialog text to the lab
; folder so the runner can check the retrieval hint without a UI.
Unicode true
ManifestDPIAware true
!ifndef TEMPLATE
  !error "TEMPLATE (product client\windows-electron folder) is required"
!endif
!ifndef OUT
  !error "OUT is required"
!endif
!ifndef VERSION
  !error "VERSION is required"
!endif
!define PRODUCTNAME "TaroBot"
!define DISPLAYNAME "TaroBird"

Name "TaroBird setup notes probe"
OutFile "${OUT}"
RequestExecutionLevel user
InstallDir "$TEMP\tarobird-notes-probe-unused"
ShowInstDetails show
ShowUninstDetails show

!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh

Var PassiveMode
Var ProbeCase
Var ProbeCount
Var ProbeWritten

; The product compiles from one folder; its includes resolve there.
!addincludedir "${TEMPLATE}"
!include "${TEMPLATE}\installer-diagnostics.nsh"

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!include "${TEMPLATE}\SimpChinese.nsh"
!include "${TEMPLATE}\English.nsh"

!macro ProbeInit
  SetShellVarContext current
  StrCpy $PassiveMode 0
  StrCpy $ProbeWritten 0
  ${GetOptions} $CMDLINE "/ZH" $0
  ${IfNot} ${Errors}
    StrCpy $LANGUAGE ${LANG_SIMPCHINESE}
  ${Else}
    StrCpy $LANGUAGE ${LANG_ENGLISH}
  ${EndIf}
  ${GetOptions} $CMDLINE "/CASE=" $ProbeCase
  ${GetOptions} $CMDLINE "/COUNT=" $ProbeCount
!macroend

!macro ProbeRun PREFIX
  StrCpy $BirdBackupState "$(birdNotRequested)"
  StrCpy $BirdNoticeState ""
  ${If} $ProbeCase == "uninstaller"
    !ifndef __UNINSTALL__
      WriteUninstaller "$INSTDIR\probe-uninstall.exe"
    !endif
  ${ElseIf} $ProbeCase == "files"
    StrCpy $BirdNoticeState "$(birdNoticeCleared)"
    !insertmacro BirdProblem "$(birdFilesStage)" "$(birdFilesFailed)" "$(birdFilesStep)" "FILES-REMOVE" ""
  ${ElseIf} $ProbeCase == "host"
    ; As TaroBotStopLocalHost after helper exit code 41.
    StrCpy $BirdCode 41
    Call ${PREFIX}BirdDescribeReason
    !insertmacro BirdProblem "$(birdHostStage)" "$BirdReason" "$BirdNext" "H$BirdCode" ""
  ${ElseIf} $ProbeCase == "backup"
    ; As BirdBackup after helper exit code 152 (move refused, rolled back).
    StrCpy $R0 152
    IntOp $BirdCode $R0 - 100
    StrCpy $BirdBackupState "$(birdRolledBack)"
    Call ${PREFIX}BirdDescribeReason
    !insertmacro BirdProblem "$(birdUninstallBackup)" "$BirdReason" "$BirdNext" "B$R0" ""
  ${ElseIf} $ProbeCase == "repeat"
    !ifmacrodef BirdNoteDone
      ${For} $1 1 $ProbeCount
        !insertmacro BirdNoteDone
        IntOp $ProbeWritten $ProbeWritten + $BirdNoteKept
      ${Next}
    !endif
  ${EndIf}
!macroend

!macro ProbeFinished
  !ifmacrodef BirdNoteDone
    !insertmacro BirdNoteDone
    ${If} $ProbeCase == "repeat"
      IntOp $ProbeWritten $ProbeWritten + $BirdNoteKept
      SetErrorLevel $ProbeWritten
    ${EndIf}
  !endif
!macroend

!macro ProbeFailed
  ClearErrors
  FileOpen $0 "$INSTDIR\probe-message.txt" w
  ${IfNot} ${Errors}
    !ifdef BIRDNOTESDIR
      FileWriteUTF16LE /BOM $0 "kept=$BirdNoteKept$\r$\n"
    !else
      FileWriteUTF16LE /BOM $0 "kept=baseline$\r$\n"
    !endif
    FileWriteUTF16LE $0 "$BirdMessage"
    FileClose $0
  ${EndIf}
!macroend

Function .onInit
  !insertmacro ProbeInit
FunctionEnd

Section "probe"
  SetOutPath "$INSTDIR"
  StrCpy $BirdOperation "$(birdInstall)"
  !insertmacro ProbeRun ""
SectionEnd

Function .onInstSuccess
  !insertmacro ProbeFinished
FunctionEnd

Function .onInstFailed
  !insertmacro ProbeFailed
FunctionEnd

Function un.onInit
  !insertmacro ProbeInit
FunctionEnd

Section "Uninstall"
  StrCpy $BirdOperation "$(birdUninstall)"
  !insertmacro ProbeRun "un."
SectionEnd

Function un.onUninstSuccess
  !insertmacro ProbeFinished
FunctionEnd

Function un.onUninstFailed
  !insertmacro ProbeFailed
FunctionEnd

; Acceptance-only fixture (#50 extension D pre-check): the product's own
; installer-diagnostics.nsh / installer-notes.nsh / English.nsh / SimpChinese.nsh,
; built like the product (makensis -INPUTCHARSET UTF8), raising the real
; BirdProblem dialog (FILES-REMOVE, Retry/Cancel) once. /ZH selects 2052.
; Build: makensis -INPUTCHARSET UTF8 -DSRC=<client\windows-electron> -DOUT=...
Unicode true
RequestExecutionLevel user
ManifestDPIAware true
!define VERSION "1.5.1"
!define PRODUCTNAME "TaroBot"
!define DISPLAYNAME "TaroBird"
Name "TaroBird"
OutFile "${OUT}"
InstallDir "$TEMP\TaroBirdDialogFixture"
!addincludedir "${SRC}"
!include LogicLib.nsh
!include FileFunc.nsh
Var PassiveMode
Var Tries
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"
!include "English.nsh"
!include "SimpChinese.nsh"
!include "installer-diagnostics.nsh"
Page instfiles
Function .onInit
  StrCpy $PassiveMode 0
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/ZH" $R1
  ${IfNot} ${Errors}
    StrCpy $LANGUAGE 2052
  ${EndIf}
FunctionEnd
Var RunHelper
Section
  StrCpy $BirdOperation "$(birdUninstall)"
  StrCpy $BirdBackupState "$(birdNotRequested)"
  StrCpy $BirdNoticeState "$(birdNoticeCleared)"
  StrCpy $Tries 0
  ; /HELPER: run a stand-in "tarobot-installer-helper.exe" (a whoami.exe copy,
  ; which exits non-zero on an unknown switch) first, as the Host stop does.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/HELPER" $RunHelper
  ${IfNot} ${Errors}
    ExecWait '"$EXEDIR\tarobot-installer-helper.exe" --stop-desktop-host' $R5
    DetailPrint "stand-in helper exit $R5"
  ${EndIf}
  bird_fixture_retry:
  IntOp $Tries $Tries + 1
  ${If} $Tries = 1
    !insertmacro BirdProblem "$(birdFilesStage)" "$(birdFilesFailed)" "$(birdFilesStep)" "FILES-REMOVE" bird_fixture_retry
  ${EndIf}
SectionEnd

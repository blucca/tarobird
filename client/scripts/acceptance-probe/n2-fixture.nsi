; Acceptance-only fixture (#50 extension pre-check, review N2): the product's
; in-place test `${If} $EXEPATH != "$INSTDIR\uninstall.exe"` (installer.nsi)
; and its registry shapes, on a /D= directory with spaces and CJK. Installs only
; an uninstaller. /REINST replays installer.nsi's reinst_uninstall call
; (`UninstallString /S _?=<remembered dir>`). Build: makensis /DOUT=...
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
Name "TB N2 Fixture"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\TBN2Fixture"
!define KEY "Software\TaroBirdAcceptanceN2Fixture"
!define RESULT "Software\TaroBirdAcceptanceN2Result"
Function .onInit
  ${GetParameters} $R9
  ClearErrors
  ${GetOptions} $R9 "/REINST" $R8
  ${IfNot} ${Errors}
    ReadRegStr $4 HKCU "${KEY}" ""
    ReadRegStr $R1 HKCU "${KEY}" "UninstallString"
    StrCpy $R1 "$R1 /S _?=$4"
    ExecWait '$R1' $0
    WriteRegStr HKCU "${RESULT}" "reinstExit" "$0"
    WriteRegStr HKCU "${RESULT}" "reinstCommand" "$R1"
    Quit
  ${EndIf}
FunctionEnd
Section
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${KEY}" "" "$INSTDIR"
  WriteRegStr HKCU "${KEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "${KEY}" "InstallLocation" "$\"$INSTDIR$\""
SectionEnd
Section Uninstall
  ${If} $EXEPATH != "$INSTDIR\uninstall.exe"
    StrCpy $0 "delete-branch"
    ClearErrors
    Delete "$INSTDIR\uninstall.exe"
    ${If} ${Errors}
      StrCpy $0 "delete-branch-FAILED"
    ${EndIf}
  ${Else}
    StrCpy $0 "self-kept-branch"
  ${EndIf}
  WriteRegStr HKCU "${RESULT}" "last" "$0|EXEPATH=$EXEPATH|INSTDIR=$INSTDIR"
  DeleteRegKey HKCU "${KEY}"
  RMDir "$INSTDIR"
SectionEnd

; Acceptance-only fixture (#50 extension B-3 driver pre-check): a "new setup"
; shaped like installer.nsi's GUI upgrade: language chooser, welcome page, a
; reinstall page whose LEAVE function ExecWaits the installed uninstaller in
; place on the UI thread (`UninstallString _?=<dir>`), then instfiles and a
; finish page with a "Run TaroBird" box. Installs nothing.
Unicode true
RequestExecutionLevel user
Name "TaroBird"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\TaroBirdB3Fixture"
!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh
!define MUI_LANGDLL_ALWAYSSHOW
Var Radio
!insertmacro MUI_PAGE_WELCOME
Page custom ReinstallPage ReinstallLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunNothing
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd
Function ReinstallPage
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "TaroBird is already installed. Select the operation you want to perform and click Next to continue."
  Pop $0
  ${NSD_CreateRadioButton} 30u 50u -30u 8u "Uninstall before installing"
  Pop $Radio
  ${NSD_Check} $Radio
  ${NSD_CreateRadioButton} 30u 70u -30u 8u "Do not uninstall"
  Pop $0
  nsDialogs::Show
FunctionEnd
Function ReinstallLeave
  ${NSD_GetState} $Radio $1
  ${If} $1 == ${BST_CHECKED}
    ReadRegStr $4 HKCU "Software\TaroBirdAcceptanceB3" ""
    ReadRegStr $R1 HKCU "Software\TaroBirdAcceptanceB3" "UninstallString"
    HideWindow
    ExecWait '$R1 _?=$4' $0
    BringToFront
    WriteRegStr HKCU "Software\TaroBirdAcceptanceB3Result" "oldUninstallerExit" "$0"
  ${EndIf}
FunctionEnd
Function RunNothing
  WriteRegStr HKCU "Software\TaroBirdAcceptanceB3Result" "runRequested" "1"
FunctionEnd
Section
SectionEnd

; Electron installer hooks. Same semantics as client/src-tauri/windows/
; installer-hooks.nsh (fresh start only with consent, Host stopped before files
; change, notification shortcut ownership, history kept on update). Changes:
;   - recovery and fresh start use the standalone tarobot-installer-helper.exe:
;     an Electron executable cannot run from $PLUGINSDIR;
;   - Host shutdown asks the helper of an Electron install, or the main
;     executable of a Tauri install (`--stop-desktop-host`), whichever owns $INSTDIR.
; Notification registration/history stay with tarocub-client.exe, which must
; be the shortcut target.
!define TAROBOTHELPER "tarobot-installer-helper.exe"
Var TaroBotHostStopper

; Remember installation ownership BEFORE the upgrade page invokes the previous
; uninstaller. An interactive upgrade may not pass /UPDATE to that uninstaller.
; It must never be mistaken for a clean reinstall after its registry is removed.
Var TaroBotHadInstallation
Var TaroBotFreshPrepared
Var TaroBotClearSettings
!define MUI_CUSTOMFUNCTION_GUIINIT TaroBotRememberInstallation
Function TaroBotRememberInstallation
  ReadRegStr $TaroBotHadInstallation HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TaroBot" "UninstallString"
  ${If} $TaroBotHadInstallation == ""
    ReadRegStr $TaroBotHadInstallation HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\TaroBot" "UninstallString"
  ${EndIf}
FunctionEnd

!include "installer-diagnostics.nsh"

!macro BirdBackup HELPER PHASE PREFIX
  StrCpy $BirdBackupState "$(birdNotStarted)"
  bird_backup_retry:
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${DISPLAYNAME}"
  DetailPrint "$BirdOperation — ${PHASE}"
  ClearErrors
  SetDetailsPrint none
  ExecWait '"${HELPER}" --prepare-fresh-install-v2' $R0
  SetDetailsPrint lastused
  ${If} ${Errors}
    !insertmacro BirdProblem "${PHASE}" "$(birdLaunch)" "$(birdRepair)" "BACKUP-LAUNCH" bird_backup_retry
  ${EndIf}
  ${If} $R0 = 0
    StrCpy $BirdBackupState "$(birdCompleted)"
  ${ElseIf} $R0 = 10
    StrCpy $BirdBackupState "$(birdNoData)"
  ${ElseIf} $R0 = 60
    StrCpy $BirdBackupState "$(birdNotFinal)"
    !insertmacro BirdProblem "${PHASE}" "$(birdFinalKey)" "$(birdPreserve)" "B60" ""
  ${Else}
    StrCpy $BirdCode $R0
    ${If} $R0 >= 240
    ${AndIf} $R0 <= 258
      IntOp $BirdCode $R0 - 200
      StrCpy $BirdBackupState "$(birdPartial)"
    ${ElseIf} $R0 >= 140
    ${AndIf} $R0 <= 158
      IntOp $BirdCode $R0 - 100
      StrCpy $BirdBackupState "$(birdRolledBack)"
    ${Else}
      StrCpy $BirdBackupState "$(birdNotStarted)"
    ${EndIf}
    Call ${PREFIX}BirdDescribeReason
    ${If} $BirdNext == ""
      StrCpy $BirdBackupState "$(birdUnknownState)"
      !insertmacro BirdProblem "${PHASE}" "$(birdUnknown)" "$(birdPreserve)" "B-UNKNOWN" ""
    ${ElseIf} $R0 >= 240
      !insertmacro BirdProblem "${PHASE}" "$BirdReason" "$(birdPreserve)" "B$R0" ""
    ${Else}
      !insertmacro BirdProblem "${PHASE}" "$BirdReason" "$BirdNext" "B$R0" bird_backup_retry
    ${EndIf}
  ${EndIf}
  DetailPrint "$BirdOperation — $BirdBackupState"
!macroend

!macro TaroBotStageRecovery
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=tarobot-recovery.exe "${TB_HELPER}"
  SetOutPath "$INSTDIR"
!macroend

; Tauri CLI 2.12.1 invokes POSTINSTALL after its owned Start Menu shortcuts.
; Reuse those links, including upgrade locations; never create another shortcut.
!macro TaroBotRegisterNotificationShortcut LINK
  !insertmacro IsShortcutTarget "${LINK}" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $R0
  ${If} $R0 = 1
    ClearErrors
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --register-notification-shortcut "${LINK}"' $R0
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      DetailPrint "TaroBird notification shortcut registration failed."
      MessageBox MB_ICONSTOP|MB_OK "TaroBird 通知注册失败，请保留开始菜单快捷方式后重试安装。$\r$\nNotification registration failed. Retry installation with a Start Menu shortcut." /SD IDOK
      Abort
    ${EndIf}
    StrCpy $R1 1
  ${EndIf}
!macroend

!macro TaroBotStopLocalHost INSTALLER
  ; Use only the stopper for this installation. Old Tauri installations use
  ; their main executable. Companion installations have no runtime.
  StrCpy $TaroBotHostStopper ""
  ${If} ${FileExists} "$INSTDIR\${TAROBOTHELPER}"
    StrCpy $TaroBotHostStopper "$INSTDIR\${TAROBOTHELPER}"
  ${ElseIf} ${FileExists} "$INSTDIR\host\node.exe"
    ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $TaroBotHostStopper "$INSTDIR\${MAINBINARYNAME}.exe"
  ${EndIf}
  ${If} $TaroBotHostStopper != ""
    bird_stop_retry:
    DetailPrint "$BirdOperation — $(birdHostStage)"
    ClearErrors
    SetDetailsPrint none
    ExecWait '"$TaroBotHostStopper" --stop-desktop-host' $R0
    SetDetailsPrint lastused
    ${If} ${Errors}
      StrCpy $R0 1
    ${EndIf}
    !if "${INSTALLER}" == "1"
      ; Preserve the read-only fallback for old/broken stoppers, including
      ; a launch failure or timeout. Never override explicit ownership refusals.
      ${If} $R0 != 0
        ${If} $R0 < 40
        ${OrIf} $R0 > 58
        ${OrIf} $R0 = 55
        ${OrIf} $R0 = 56
          !insertmacro TaroBotStageRecovery
          ClearErrors
          SetDetailsPrint none
          ExecWait '"$PLUGINSDIR\tarobot-recovery.exe" --confirm-host-stopped-v2' $R0
          SetDetailsPrint lastused
          ${If} ${Errors}
            StrCpy $R0 1
          ${EndIf}
          Delete "$PLUGINSDIR\tarobot-recovery.exe"
        ${EndIf}
      ${EndIf}
    !endif
    ${If} $R0 != 0
      StrCpy $BirdCode $R0
      !if "${INSTALLER}" == "1"
        Call BirdDescribeReason
      !else
        Call un.BirdDescribeReason
      !endif
      ${If} $BirdCode = 40
        StrCpy $BirdNext "$(birdCheckService)"
      ${EndIf}
      ${If} $BirdNext == ""
        !insertmacro BirdProblem "$(birdHostStage)" "$(birdStop)" "$(birdCloseHost)" "HOST-UNCONFIRMED" bird_stop_retry
      ${Else}
        !insertmacro BirdProblem "$(birdHostStage)" "$BirdReason" "$BirdNext" "H$BirdCode" bird_stop_retry
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $BirdOperation "$(birdInstall)"
  StrCpy $BirdBackupState "$(birdNotRequested)"
  StrCpy $TaroBotFreshPrepared 0
  ; Silent/passive installs and every upgrade keep state. Only an interactive
  ; reinstall with residual data offers a fresh start, and only after consent.
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $TaroBotHadInstallation == ""
    ${If} ${FileExists} "$APPDATA\com.tarobot.client"
    ${OrIf} ${FileExists} "$LOCALAPPDATA\com.tarobot.client"
    ${OrIf} ${FileExists} "$APPDATA\com.tarocub.client"
    ${OrIf} ${FileExists} "$LOCALAPPDATA\com.tarocub.client"
      MessageBox MB_ICONQUESTION|MB_YESNOCANCEL|MB_DEFBUTTON2 "$(birdInstallConsent)" IDYES tarobot_fresh_install IDNO tarobot_keep_data
      Abort
      tarobot_fresh_install:
      !insertmacro TaroBotStageRecovery
      !insertmacro BirdBackup "$PLUGINSDIR\tarobot-recovery.exe" "$(birdInstallBackup)" ""
      StrCpy $TaroBotFreshPrepared 1
      Delete "$PLUGINSDIR\tarobot-recovery.exe"
      tarobot_keep_data:
    ${EndIf}
  ${EndIf}
  ${If} $TaroBotFreshPrepared <> 1
    !insertmacro TaroBotStopLocalHost 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  StrCpy $R1 0
  !insertmacro TaroBotRegisterNotificationShortcut "$SMPROGRAMS\$AppStartMenuFolder\${DISPLAYNAME}.lnk"
  ${If} $R1 = 0
    !insertmacro TaroBotRegisterNotificationShortcut "$SMPROGRAMS\${DISPLAYNAME}.lnk"
  ${EndIf}
  ${If} $R1 = 0
    !insertmacro TaroBotRegisterNotificationShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} $R1 = 0
    !insertmacro TaroBotRegisterNotificationShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} $R1 = 0
    ; /NS or an upgrade with a deleted shortcut: do not report notification-ready.
    Delete "$INSTDIR\tarocub-notification-shortcut.json"
    DetailPrint "No owned Start Menu shortcut; TaroBird desktop notifications are unavailable."
  ${EndIf}
  ; Tauri -> Electron: an update skips the old uninstaller, so the Tauri Host
  ; runtime in host\ would stay forever. The helper takes no path: it removes
  ; exactly host\ beside itself, only an identified bundled runtime without
  ; reparse points, after resources\host is written and the Host is stopped.
  ; A refusal keeps the folder and never fails the installation.
  ${If} ${FileExists} "$INSTDIR\host\*.*"
    ClearErrors
    ExecWait '"$INSTDIR\${TAROBOTHELPER}" --remove-legacy-host-runtime' $R0
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      DetailPrint "TaroBird kept the previous host folder (code $R0)."
    ${EndIf}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\tarocub-notification-shortcut.json"
  RMDir "$INSTDIR"
  ${If} $TaroBotClearSettings = 1
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $BirdOperation "$(birdUninstall)"
  StrCpy $BirdBackupState "$(birdNotRequested)"
  ${If} $UpdateMode <> 1
  ${AndIf} $DeleteAppDataCheckboxState = 1
    StrCpy $BirdBackupState "$(birdNotStarted)"
  ${EndIf}
  !insertmacro TaroBotStopLocalHost 0
  ${If} $UpdateMode <> 1
  ${AndIf} $DeleteAppDataCheckboxState = 1
    MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "$(birdUninstallConsent)" IDYES tarobot_uninstall_fresh
    Abort
    tarobot_uninstall_fresh:
    !insertmacro BirdBackup "$INSTDIR\${TAROBOTHELPER}" "$(birdUninstallBackup)" "un."
    ; Clear installer settings only after the backup returned a known success.
    StrCpy $DeleteAppDataCheckboxState 0
    StrCpy $TaroBotClearSettings 1
  ${EndIf}
  ; Updates retain history. An old install must not clear a newer owner's notices.
  ${If} $UpdateMode <> 1
    Push $R0
    bird_notice_retry:
    ReadRegStr $R0 SHCTX "Software\Classes\tarocub\shell\open\command" ""
    ${If} $R0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
      !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${DISPLAYNAME}"
      DetailPrint "$BirdOperation — $(birdNoticeStage)"
      ClearErrors
      SetDetailsPrint none
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --clear-notification-history' $R0
      SetDetailsPrint lastused
      ${If} ${Errors}
      ${OrIf} $R0 <> 0
        !insertmacro BirdProblem "$(birdNoticeStage)" "$(birdNotice)" "$(birdNoticeStep)" "NOTICE-CLEAR" bird_notice_retry
      ${EndIf}
    ${EndIf}
    Pop $R0
  ${EndIf}
!macroend

; ACCEPTANCE-ONLY. A stand-in program for the follow-ups probe: appends its
; command line to ${MARKS}\${NAME}.ran and exits with ${CODE}. Used as the
; Electron tarocub-client.exe (64, it refuses --stop-desktop-host), a Tauri
; tarocub-client.exe and the helper (0).
Unicode true
!include LogicLib.nsh
SilentInstall silent
RequestExecutionLevel user
Name "TaroBird probe stand-in"
OutFile "${OUT}"

Section
  ClearErrors
  FileOpen $0 "${MARKS}\${NAME}.ran" a
  ${If} ${Errors}
    Goto done
  ${EndIf}
  FileSeek $0 0 END
  FileWrite $0 "$CMDLINE$\r$\n"
  FileClose $0
  done:
  SetErrorLevel ${CODE}
SectionEnd

; Local setup notes, used by installer-diagnostics.nsh (kept apart so that
; the dialog file itself never touches a path or reads a file).
; Dialogs and Details are gone once setup closes, and /S shows neither. One
; line per diagnosed stop or finished run stays readable afterwards in
; %LOCALAPPDATA%\TaroBird Setup Notes: this Windows user only, not roamed,
; never uploaded, outside the data folders the backup moves. A line holds only
; the time, operation, stage, allowlisted TB code, backup/notification state
; strings and version: no path, account, process, helper output or log.
; Best effort: a failure here never prompts or changes what setup does.
; At most BIRDNOTESMAX lines per file plus one previous file; one writer at a
; time, and a writer that cannot get its turn quickly skips its line.
Var BirdNotePhase
Var BirdNoteCode
Var BirdNoteKept

!define BIRDNOTESDIR "TaroBird Setup Notes"
!define BIRDNOTESFILE "setup-notes.txt"
!define BIRDNOTESPREVIOUS "setup-notes.previous.txt"
!define BIRDNOTESMAX 20
!define BIRDNOTESWAIT 2000

; $BirdNoteCode empty: a finished run. Sets $BirdNoteKept to 1 only when the
; line was written. Keeps registers and the error flag.
!macro BirdNoteFunction PREFIX
Function ${PREFIX}BirdNote
  StrCpy $BirdNoteKept 0
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  StrCpy $9 0
  ${If} ${Errors}
    StrCpy $9 1
  ${EndIf}
  SetDetailsPrint none
  StrCpy $8 "$LOCALAPPDATA\${BIRDNOTESDIR}"
  StrCpy $7 0
  ${If} $BirdOperation == ""
  ${OrIf} $LOCALAPPDATA == ""
  ${OrIf} $8 == $INSTDIR
    Goto bird_note_end
  ${EndIf}
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\TaroBirdSetupNotes") p .r7'
  ${If} $7 P= 0
    Goto bird_note_end
  ${EndIf}
  System::Call 'kernel32::WaitForSingleObject(p r7, i ${BIRDNOTESWAIT}) i .r6'
  ${If} $6 <> 0
  ${AndIf} $6 <> 0x80
    Goto bird_note_close
  ${EndIf}
  ClearErrors
  CreateDirectory "$8"
  ; Never write through a link or junction: a plain folder and plain files only.
  System::Call 'kernel32::GetFileAttributesW(w r8) i .r6'
  IntOp $5 $6 & 0x410
  ${If} $6 = -1
  ${OrIf} $5 <> 0x10
    Goto bird_note_release
  ${EndIf}
  StrCpy $5 "$8\${BIRDNOTESFILE}"
  System::Call 'kernel32::GetFileAttributesW(w r5) i .r6'
  IntOp $5 $6 & 0x410
  ${If} $6 <> -1
  ${AndIf} $5 <> 0
    Goto bird_note_release
  ${EndIf}
  StrCpy $5 "$8\${BIRDNOTESPREVIOUS}"
  System::Call 'kernel32::GetFileAttributesW(w r5) i .r6'
  IntOp $5 $6 & 0x410
  ${If} $6 <> -1
  ${AndIf} $5 <> 0
    Goto bird_note_release
  ${EndIf}
  ; Count up to BIRDNOTESMAX lines; a full file becomes the previous file.
  StrCpy $5 0
  ClearErrors
  FileOpen $4 "$8\${BIRDNOTESFILE}" r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileReadUTF16LE $4 $3
      ${If} ${Errors}
        ${ExitDo}
      ${EndIf}
      IntOp $5 $5 + 1
    ${LoopUntil} $5 >= ${BIRDNOTESMAX}
    FileClose $4
  ${EndIf}
  ${If} $5 >= ${BIRDNOTESMAX}
    Delete "$8\${BIRDNOTESPREVIOUS}"
    Rename "$8\${BIRDNOTESFILE}" "$8\${BIRDNOTESPREVIOUS}"
    ; Skip this line rather than grow past the limit.
    ${If} ${FileExists} "$8\${BIRDNOTESFILE}"
      Goto bird_note_release
    ${EndIf}
  ${EndIf}
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  StrCpy $3 "$2-$1-$0 $4:$5:$6 · $BirdOperation — "
  ${If} $BirdNoteCode == ""
    StrCpy $3 "$3$(birdNoteDone)"
  ${Else}
    StrCpy $3 "$3$BirdNotePhase · TB-$BirdNoteCode"
  ${EndIf}
  StrCpy $3 "$3 · $BirdBackupState"
  ${If} $BirdNoticeState != ""
    StrCpy $3 "$3 · $BirdNoticeState"
  ${EndIf}
  StrCpy $3 "$3 · TaroBird ${VERSION}$\r$\n"
  ClearErrors
  FileOpen $4 "$8\${BIRDNOTESFILE}" a
  ${IfNot} ${Errors}
    FileSeek $4 0 END
    ClearErrors
    FileWriteUTF16LE /BOM $4 "$3"
    ${IfNot} ${Errors}
      StrCpy $BirdNoteKept 1
    ${EndIf}
    FileClose $4
  ${EndIf}
  bird_note_release:
  System::Call 'kernel32::ReleaseMutex(p r7)'
  bird_note_close:
  System::Call 'kernel32::CloseHandle(p r7)'
  bird_note_end:
  SetDetailsPrint lastused
  ClearErrors
  ${If} $9 = 1
    SetErrors
  ${EndIf}
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend
!insertmacro BirdNoteFunction ""
!insertmacro BirdNoteFunction "un."

!macro BirdNoteCall
  !ifdef __UNINSTALL__
    Call un.BirdNote
  !else
    Call BirdNote
  !endif
!macroend

; .onInstSuccess / un.onUninstSuccess: the run finished.
!macro BirdNoteDone
  StrCpy $BirdNoteCode ""
  !insertmacro BirdNoteCall
!macroend

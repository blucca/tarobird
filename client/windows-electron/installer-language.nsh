; Which language setup speaks, without a dialog nobody can answer in /P.
; MUI saves the chosen language only when a shown files page closes, so a /S
; install saves none. Without this, the next /P run (the updater's
; `/P /UPDATE /R`, or a passive reinstall and the uninstaller it starts with /P)
; stopped at the "Installer Language" dialog and never finished.
; Interactive runs keep MUI's behaviour: a saved language is used, otherwise the
; dialog asks. A /P run never asks: it uses the saved language when it is one of
; this setup's languages; otherwise Simplified Chinese when the Windows display
; language is Chinese and English for every other language (not NSIS's own
; fallback, the first language of the script). A /P run also never saves a
; language nobody chose: the installer puts the saved value back as it found
; it (BirdKeepSavedLanguage), so the next interactive run still asks.
; /S is unchanged: MUI never shows the dialog there and never saves.
; Insert BirdChooseLanguage after $PassiveMode is read. $0 and $1 are preserved.

Var BirdLanguageRestore
Var BirdLanguageFound
Var BirdLanguageValue

; In: $0 Windows display language id, $1 saved value. Out: $0 the /P language.
; Only maps its two inputs, so a probe can drive it with any language id.
!macro BirdPassiveLanguagePick
  ${If} $1 == ${LANG_SIMPCHINESE}
  ${OrIf} $1 == ${LANG_ENGLISH}
    StrCpy $0 $1
  ${Else}
    ; Primary language: the low 10 bits of a LANGID; LANG_CHINESE is 0x04.
    IntOp $0 $0 & 0x3FF
    ${If} $0 = 4
      StrCpy $0 ${LANG_SIMPCHINESE}
    ${Else}
      StrCpy $0 ${LANG_ENGLISH}
    ${EndIf}
  ${EndIf}
!macroend

!macro BirdPassiveLanguage
  Push $0
  Push $1
  ClearErrors
  ReadRegStr $1 ${MUI_LANGDLL_REGISTRY_ROOT} "${MUI_LANGDLL_REGISTRY_KEY}" "${MUI_LANGDLL_REGISTRY_VALUENAME}"
  ${If} ${Errors}
    StrCpy $BirdLanguageFound 0
  ${Else}
    StrCpy $BirdLanguageFound 1
  ${EndIf}
  StrCpy $BirdLanguageValue $1
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  !insertmacro BirdPassiveLanguagePick
  ; Not the saved choice: MUI would save it when the files page closes.
  ${If} $0 != $1
    StrCpy $BirdLanguageRestore 1
  ${EndIf}
  StrCpy $LANGUAGE $0
  Pop $1
  Pop $0
!macroend

!macro BirdChooseLanguage
  ${If} $PassiveMode = 1
    !insertmacro BirdPassiveLanguage
  ${Else}
    !ifdef __UNINSTALL__
      !insertmacro MUI_UNGETLANGUAGE
    !else
      !insertmacro MUI_LANGDLL_DISPLAY
    !endif
  ${EndIf}
!macroend

; .onInstSuccess runs after the files page closed, where MUI saved $LANGUAGE.
; The uninstaller never saves a language.
!macro BirdKeepSavedLanguage
  ${If} $BirdLanguageRestore = 1
    ${If} $BirdLanguageFound = 1
      WriteRegStr ${MUI_LANGDLL_REGISTRY_ROOT} "${MUI_LANGDLL_REGISTRY_KEY}" "${MUI_LANGDLL_REGISTRY_VALUENAME}" $BirdLanguageValue
    ${Else}
      DeleteRegValue ${MUI_LANGDLL_REGISTRY_ROOT} "${MUI_LANGDLL_REGISTRY_KEY}" "${MUI_LANGDLL_REGISTRY_VALUENAME}"
    ${EndIf}
  ${EndIf}
!macroend

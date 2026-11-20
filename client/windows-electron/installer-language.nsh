; Which language setup speaks, without a dialog nobody can answer in /P.
; MUI saves the chosen language only when a shown files page closes, so a /S
; install saves none. Without this, the next /P run (the updater's
; `/P /UPDATE /R`, or a passive reinstall and the uninstaller it starts with /P)
; stopped at the "Installer Language" dialog and never finished.
; Interactive runs keep MUI's behaviour: a saved language is used, otherwise the
; dialog asks. A /P run never asks: it uses the saved language when it is one of
; this setup's languages, otherwise the one NSIS matched to the Windows display
; language before .onInit (exact, then primary language, then the first one).
; /S is unchanged: MUI never shows the dialog there.
; Insert after $PassiveMode is read. $0 is preserved.

!macro BirdPassiveLanguage
  Push $0
  ReadRegStr $0 ${MUI_LANGDLL_REGISTRY_ROOT} "${MUI_LANGDLL_REGISTRY_KEY}" "${MUI_LANGDLL_REGISTRY_VALUENAME}"
  ${If} $0 == ${LANG_SIMPCHINESE}
  ${OrIf} $0 == ${LANG_ENGLISH}
    StrCpy $LANGUAGE $0
  ${EndIf}
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

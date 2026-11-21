; Acceptance-only fixture (#50 extension A pre-check): NSIS CreateShortcut (as
; installer.nsi) from a Unicode installer placed in a CJK/space folder, to
; "$EXEDIR\target.exe", in the per-user Start Menu. /S only.
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "TaroBird Link Probe"
OutFile "${OUT}"
Section
  SetShellVarContext current
  CreateShortcut "$SMPROGRAMS\TaroBird Link Probe.lnk" "$EXEDIR\target.exe"
SectionEnd

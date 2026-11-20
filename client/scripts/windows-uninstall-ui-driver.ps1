# Acceptance-only UI Automation driver for the interactive TaroBird
# uninstaller on a DISPOSABLE Windows runner (#50). It only reads window text
# and presses the uninstaller's own buttons; it never types into other apps.
#   -Mode consent  tick "Back up and reset local data" and answer Yes
#   -Mode keep     leave the box unticked (data kept)
# A diagnostic dialog (text with TB-<code>) is recorded verbatim. With
# -ReleaseFile, the driver signals the caller to remove the induced cause,
# waits for -ReleasedFile, then presses Retry; otherwise it presses Cancel/OK.
param(
  [ValidateSet('consent', 'keep')][string]$Mode = 'keep',
  [int]$TimeoutSec = 300,
  [string]$ReleaseFile = '',
  [string]$ReleasedFile = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$Any = [System.Windows.Automation.Condition]::TrueCondition
$start = Get-Date
$events = New-Object System.Collections.ArrayList
function Note([string]$kind, [string]$detail) {
  [void]$events.Add([ordered]@{ ms = [int]((Get-Date) - $start).TotalMilliseconds; kind = $kind; detail = $detail })
}
function Clean([string]$s) { $s.Replace('&', '').Trim() }
function Kids($el) { @($el.FindAll($TS::Descendants, $Any)) }
function Btn($el, [string]$name) {
  foreach ($c in (Kids $el)) { if ($c.Current.ControlType -eq $CT::Button -and (Clean $c.Current.Name) -eq $name) { return $c } }
  return $null
}
function Press($el) { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Text($el) { ((Kids $el | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join ' | ') }
# The uninstaller and its message boxes carry the product name; NSIS's own
# language picker (if Windows shows it) is "Installer/Uninstaller Language".
function Windows { @($AE::RootElement.FindAll($TS::Children, $Any) | Where-Object { $_.Current.Name -like '*TaroBird*' -or $_.Current.Name -like '*Language*' }) }

$closed = $false; $seen = $false; $answered = 0; $guard = 0; $empty = 0
while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
  $wins = Windows
  if ($wins.Count) { $seen = $true; $empty = 0 } else { $empty++ }
  if ($closed -and -not $wins.Count) { break }
  # The uninstaller may close itself after success: gone for ~7 s after it was seen.
  if ($seen -and $empty -ge 10) { Note 'gone' 'no TaroBird window for ~7 s'; break }
  foreach ($w in $wins) {
    try {
      $yes = Btn $w 'Yes'; $no = Btn $w 'No'; $retry = Btn $w 'Retry'; $ok = Btn $w 'OK'
      $uninstall = Btn $w 'Uninstall'; $close = Btn $w 'Close'
      $text = Text $w
      if ($ok -and $text -match 'select a language|Language') {
        Note 'language' $text; Press $ok
      } elseif ($yes -and $no) {
        Note 'question' $text
        if ($text -match 'Back up this computer') { if ($Mode -eq 'consent') { Press $yes; Note 'answer' 'Yes' } else { Press $no; Note 'answer' 'No' } }
        else { Press $no; Note 'answer' 'No (unexpected question)' }
        $answered++
      } elseif ($retry -or ($ok -and -not $close -and -not $uninstall -and $text -match 'TB-')) {
        Note 'problem' $text
        if ($retry -and $ReleaseFile -and -not (Test-Path -LiteralPath $ReleasedFile)) {
          Set-Content -LiteralPath $ReleaseFile -Value 'release'
          $waited = 0
          while (-not (Test-Path -LiteralPath $ReleasedFile) -and $waited -lt 120) { Start-Sleep -Seconds 1; $waited++ }
          Note 'released' "caller released the induced cause after ${waited}s: $(Test-Path -LiteralPath $ReleasedFile)"
          Press $retry; Note 'answer' 'Retry'
        } else {
          $cancel = Btn $w 'Cancel'
          if ($cancel) { Press $cancel; Note 'answer' 'Cancel' } elseif ($ok) { Press $ok; Note 'answer' 'OK' }
        }
        $answered++
      } elseif ($uninstall -and $uninstall.Current.IsEnabled) {
        $box = $null
        foreach ($c in (Kids $w)) { if ($c.Current.ControlType -eq $CT::CheckBox -and $c.Current.Name -like '*Back up and reset local data*') { $box = $c } }
        if ($box) {
          $toggle = $box.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
          $want = $(if ($Mode -eq 'consent') { 'On' } else { 'Off' })
          if ([string]$toggle.Current.ToggleState -ne $want) { $toggle.Toggle() }
          Note 'confirm-page' "checkbox=$([string]$toggle.Current.ToggleState) mode=$Mode"
        } else { Note 'confirm-page' "checkbox not found; text: $(Text $w)" }
        Press $uninstall; Note 'answer' 'Uninstall'
      } elseif ($close -and $close.Current.IsEnabled) {
        Note 'finished' (Text $w)
        Press $close; $closed = $true
      }
    } catch { Note 'error' $_.Exception.Message }
  }
  if (++$guard -gt 2000) { break }
  Start-Sleep -Milliseconds 700
}
$left = @(Windows | ForEach-Object { "$($_.Current.Name) [$($_.Current.ClassName)] pid=$($_.Current.ProcessId)" })
ConvertTo-Json -InputObject ([ordered]@{ seen = $seen; closed = $closed; answered = $answered; seconds = [int]((Get-Date) - $start).TotalSeconds; left = $left; events = $events }) -Depth 4 -Compress

# Acceptance-only UI Automation driver for the interactive TaroBird
# uninstaller on a DISPOSABLE Windows runner (#50). It only reads window text
# and presses the uninstaller's own buttons; it never types into other apps.
#   -Mode consent  tick "Back up and reset local data" and answer Yes
#   -Mode keep     leave the box unticked (data kept)
# NSIS's language chooser ("Installer Language") is answered with its own
# default language and OK, as a user would; UI Automation first, then the
# dialog's own OK button by Win32 message. A window that stays unanswered for
# -SceneTimeoutSec ends the run early with its title and control tree.
# A diagnostic dialog (text with TB-<code>) is recorded verbatim. With
# -ReleaseFile, the driver signals the caller to remove the induced cause,
# waits for -ReleasedFile, then presses Retry; otherwise it presses Cancel/OK.
param(
  [ValidateSet('consent', 'keep')][string]$Mode = 'keep',
  [int]$TimeoutSec = 300,
  [int]$SceneTimeoutSec = 30,
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
Add-Type -Namespace BirdProbe -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
'@
function Win32Button([int]$hwnd, [string]$name) {
  $child = [IntPtr]::Zero
  do {
    $child = [BirdProbe.Win32]::FindWindowEx([IntPtr]$hwnd, $child, 'Button', $null)
    if ($child -ne [IntPtr]::Zero) {
      $sb = New-Object System.Text.StringBuilder 64; [void][BirdProbe.Win32]::GetWindowText($child, $sb, 64)
      if ($sb.ToString().Replace('&', '').Trim() -eq $name) { return $child }
    }
  } while ($child -ne [IntPtr]::Zero)
  return [IntPtr]::Zero
}
function Tree($el) { ((Kids $el | Select-Object -First 30 | ForEach-Object { "$($_.Current.ControlType.ProgrammaticName -replace 'ControlType\.','')/$($_.Current.ClassName)/$($_.Current.Name)" }) -join ' ; ') }
$firstSeen = @{}; $acted = @{}
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

$closed = $false; $seen = $false; $answered = 0; $guard = 0; $empty = 0; $stuck = $false
while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
  $wins = Windows
  if ($wins.Count) { $seen = $true; $empty = 0 } else { $empty++ }
  if ($closed -and -not $wins.Count) { break }
  # The uninstaller may close itself after success: gone for ~7 s after it was seen.
  if ($seen -and $empty -ge 10) { Note 'gone' 'no TaroBird window for ~7 s'; break }
  foreach ($w in $wins) {
    $key = "$($w.Current.NativeWindowHandle)|$($w.Current.Name)"
    if (-not $firstSeen.ContainsKey($key)) { $firstSeen[$key] = Get-Date }
    elseif (-not $acted.ContainsKey($key) -and ((Get-Date) - $firstSeen[$key]).TotalSeconds -ge $SceneTimeoutSec) {
      Note 'stuck' "unanswered for ${SceneTimeoutSec}s: $($w.Current.Name) [$($w.Current.ClassName)] pid=$($w.Current.ProcessId); tree: $(Tree $w)"
      $stuck = $true
    }
    try {
      if ($w.Current.Name -match '^(Installer|Uninstaller) Language$') {
        # MUI's LangDLL: keep its preselected language (the Windows display
        # language when one matches) and press OK.
        $choice = ''
        foreach ($c in (Kids $w)) { if ($c.Current.ControlType -eq $CT::ComboBox) { try { $choice = $c.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { $choice = $c.Current.Name } } }
        $okLang = Btn $w 'OK'
        if ($okLang) { Press $okLang; Note 'language' "$($w.Current.Name): $choice (UI Automation OK)"; $acted[$key] = $true; continue }
        $native = Win32Button $w.Current.NativeWindowHandle 'OK'
        if ($native -ne [IntPtr]::Zero) { [void][BirdProbe.Win32]::SendMessage($native, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero); Note 'language' "$($w.Current.Name): $choice (Win32 OK)"; $acted[$key] = $true; continue }
        if (-not $acted.ContainsKey("$key|tree")) { Note 'language-unanswerable' "no OK button found; tree: $(Tree $w)"; $acted["$key|tree"] = $true }
        continue
      }
      $yes = Btn $w 'Yes'; $no = Btn $w 'No'; $retry = Btn $w 'Retry'; $ok = Btn $w 'OK'
      $uninstall = Btn $w 'Uninstall'; $close = Btn $w 'Close'
      $text = Text $w
      if ($yes -and $no) {
        Note 'question' $text
        if ($text -match 'Back up this computer') { if ($Mode -eq 'consent') { Press $yes; Note 'answer' 'Yes' } else { Press $no; Note 'answer' 'No' } }
        else { Press $no; Note 'answer' 'No (unexpected question)' }
        $answered++; $acted[$key] = $true
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
        $answered++; $acted[$key] = $true
      } elseif ($uninstall -and $uninstall.Current.IsEnabled) {
        $box = $null
        foreach ($c in (Kids $w)) { if ($c.Current.ControlType -eq $CT::CheckBox -and $c.Current.Name -like '*Back up and reset local data*') { $box = $c } }
        if ($box) {
          $toggle = $box.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
          $want = $(if ($Mode -eq 'consent') { 'On' } else { 'Off' })
          if ([string]$toggle.Current.ToggleState -ne $want) { $toggle.Toggle() }
          Note 'confirm-page' "checkbox=$([string]$toggle.Current.ToggleState) mode=$Mode"
        } else { Note 'confirm-page' "checkbox not found; text: $(Text $w)" }
        Press $uninstall; Note 'answer' 'Uninstall'; $acted[$key] = $true
      } elseif ($close -and $close.Current.IsEnabled) {
        Note 'finished' (Text $w)
        Press $close; $closed = $true; $acted[$key] = $true
      }
    } catch { Note 'error' $_.Exception.Message }
  }
  if ($stuck) { break }
  if (++$guard -gt 2000) { break }
  Start-Sleep -Milliseconds 700
}
$left = @(Windows | ForEach-Object { "$($_.Current.Name) [$($_.Current.ClassName)] pid=$($_.Current.ProcessId)" })
ConvertTo-Json -InputObject ([ordered]@{ seen = $seen; closed = $closed; stuck = $stuck; answered = $answered; seconds = [int]((Get-Date) - $start).TotalSeconds; left = $left; events = $events }) -Depth 4 -Compress

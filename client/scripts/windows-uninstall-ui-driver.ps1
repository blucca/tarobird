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
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, System.Text.StringBuilder text);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
'@
function Win32Button([int]$hwnd, [string]$name) {
  $child = [IntPtr]::Zero
  do {
    $child = [BirdProbe.Win32]::FindWindowEx([IntPtr]$hwnd, $child, 'Button', $null)
    if ($child -ne [IntPtr]::Zero) {
      $sb = New-Object System.Text.StringBuilder 64; [void][BirdProbe.Win32]::SendMessage($child, 0x000D, [IntPtr]64, $sb)
      if ($sb.ToString().Replace('&', '').Trim() -eq $name) { return $child }
    }
  } while ($child -ne [IntPtr]::Zero)
  return [IntPtr]::Zero
}
function Tree($el) { ((Kids $el | Select-Object -First 30 | ForEach-Object { "$($_.Current.ControlType.ProgrammaticName -replace 'ControlType\.','')/$($_.Current.ClassName)/$($_.Current.Name)$(if ($_.Current.ClassName -eq 'Button') { if ([BirdProbe.Win32]::IsWindowEnabled([IntPtr]$_.Current.NativeWindowHandle)) { '+' } else { '-' } })" }) -join ' ; ') }
$since = @{}; $seenText = @{}; $acted = @{}
function Note([string]$kind, [string]$detail) {
  [void]$events.Add([ordered]@{ ms = [int]((Get-Date) - $start).TotalMilliseconds; kind = $kind; detail = $detail })
}
function Clean([string]$s) { $s.Replace('&', '').Trim() }
function Kids($el) { @($el.FindAll($TS::Descendants, $Any)) }
# NSIS buttons and check boxes are Win32 "Button" controls; UI Automation on a
# runner exposed them as Pane (probe run 44837580710), so match the class too
# and fall back to the control's own BM_CLICK / BM_GETCHECK.
function IsButton($c) { $c.Current.ControlType -eq $CT::Button -or $c.Current.ClassName -eq 'Button' }
function Btn($el, [string]$name) {
  foreach ($c in (Kids $el)) { if ((IsButton $c) -and (Clean $c.Current.Name) -eq $name) { return $c } }
  return $null
}
function Press($el) {
  try { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  catch { [void][BirdProbe.Win32]::SendMessage([IntPtr]$el.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) }
}
# UI Automation lists an owned message box under its owner window, so a
# dialog's buttons are taken from the dialog that holds them, never the first
# matching name in the owner's whole tree.
$Walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
function Scope($btn) { $parent = $Walker.GetParent($btn); if ($parent) { $parent } else { $btn } }
# Enabled state from the control's own window (UIA's IsEnabled was not reliable
# for these Pane-typed Win32 buttons, probe run 44838505643).
function Enabled($btn) {
  $h = [IntPtr]$btn.Current.NativeWindowHandle
  if ($h -ne [IntPtr]::Zero) { return [BirdProbe.Win32]::IsWindowEnabled($h) }
  return $btn.Current.IsEnabled
}
function Checked($box) {
  try { return [string]$box.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -eq 'On' }
  catch { return [int][BirdProbe.Win32]::SendMessage([IntPtr]$box.Current.NativeWindowHandle, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero) -eq 1 }
}
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
    # A scene is stuck when its visible text has not changed and nothing was
    # pressed for -SceneTimeoutSec: progress pages keep changing their text.
    $key = "$($w.Current.NativeWindowHandle)|$($w.Current.Name)"
    $now = Text $w
    if (-not $since.ContainsKey($key) -or $seenText[$key] -ne $now -or $acted.ContainsKey($key)) { $since[$key] = Get-Date; $seenText[$key] = $now; [void]$acted.Remove($key) }
    elseif (((Get-Date) - $since[$key]).TotalSeconds -ge $SceneTimeoutSec) {
      Note 'stuck' "unchanged and unanswered for ${SceneTimeoutSec}s: $($w.Current.Name) [$($w.Current.ClassName)] pid=$($w.Current.ProcessId); tree: $(Tree $w)"
      $stuck = $true
    }
    try {
      if ($w.Current.Name -match '^(Installer|Uninstaller) Language$') {
        # MUI's LangDLL: keep its preselected language (the Windows display
        # language when one matches) and press OK.
        $choice = ''
        foreach ($c in (Kids $w)) { if ($c.Current.ControlType -eq $CT::ComboBox -or $c.Current.ClassName -eq 'ComboBox') { try { $choice = $c.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { $choice = $c.Current.Name } } }
        $okLang = Btn $w 'OK'
        if ($okLang) { Press $okLang; Note 'language' "$($w.Current.Name): $choice (OK, $($okLang.Current.ControlType.ProgrammaticName))"; $acted[$key] = $true; continue }
        $native = Win32Button $w.Current.NativeWindowHandle 'OK'
        if ($native -ne [IntPtr]::Zero) { [void][BirdProbe.Win32]::SendMessage($native, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero); Note 'language' "$($w.Current.Name): $choice (Win32 OK)"; $acted[$key] = $true; continue }
        if (-not $acted.ContainsKey("$key|tree")) { Note 'language-unanswerable' "no OK button found; tree: $(Tree $w)"; $acted["$key|tree"] = $true }
        continue
      }
      $yes = Btn $w 'Yes'; $no = Btn $w 'No'; $retry = Btn $w 'Retry'; $ok = Btn $w 'OK'
      $uninstall = Btn $w 'Uninstall'; $close = Btn $w 'Close'
      $text = Text $w
      if ($yes -and (Btn (Scope $yes) 'No')) {
        $dialog = Scope $yes; $no = Btn $dialog 'No'; $text = Text $dialog
        Note 'question' $text
        if ($text -match 'Back up this computer') { if ($Mode -eq 'consent') { Press $yes; Note 'answer' 'Yes' } else { Press $no; Note 'answer' 'No' } }
        else { Press $no; Note 'answer' 'No (unexpected question)' }
        $answered++; $acted[$key] = $true
      } elseif ($retry -or ($ok -and (Text (Scope $ok)) -match 'TB-')) {
        $dialog = Scope $(if ($retry) { $retry } else { $ok }); $text = Text $dialog
        $retry = Btn $dialog 'Retry'; $ok = Btn $dialog 'OK'
        Note 'problem' $text
        if ($retry -and $ReleaseFile -and -not (Test-Path -LiteralPath $ReleasedFile)) {
          Set-Content -LiteralPath $ReleaseFile -Value 'release'
          $waited = 0
          while (-not (Test-Path -LiteralPath $ReleasedFile) -and $waited -lt 120) { Start-Sleep -Seconds 1; $waited++ }
          Note 'released' "caller released the induced cause after ${waited}s: $(Test-Path -LiteralPath $ReleasedFile)"
          Press $retry; Note 'answer' 'Retry'
        } else {
          $cancel = Btn $dialog 'Cancel'
          if ($cancel) { Press $cancel; Note 'answer' 'Cancel' } elseif ($ok) { Press $ok; Note 'answer' 'OK' }
        }
        $answered++; $acted[$key] = $true
      } elseif ($uninstall -and (Enabled $uninstall)) {
        $box = $null
        foreach ($c in (Kids $w)) { if (($c.Current.ControlType -eq $CT::CheckBox -or $c.Current.ClassName -eq 'Button') -and $c.Current.Name -like '*Back up and reset local data*') { $box = $c } }
        if ($box) {
          $want = $Mode -eq 'consent'
          if ((Checked $box) -ne $want) { Press $box }
          Start-Sleep -Milliseconds 300
          Note 'confirm-page' "checkbox=$(if (Checked $box) { 'On' } else { 'Off' }) mode=$Mode"
        } else { Note 'confirm-page' "checkbox not found; text: $(Text $w)" }
        Press $uninstall; Note 'answer' 'Uninstall'; $acted[$key] = $true
      } elseif ($close -and (Enabled $close)) {
        Note 'finished' (Text $w)
        Press $close; $closed = $true; $acted[$key] = $true
      } elseif ($text -match 'Aborted|not completed successfully') {
        # NSIS's failed page disables Close and leaves only Cancel enabled
        # (probe run 44838848838). The caller judges the outcome from state.
        $cancel = Btn $w 'Cancel'
        if ($cancel -and (Enabled $cancel)) { Note 'finished' "aborted: $text"; Press $cancel; $closed = $true; $acted[$key] = $true }
      }
    } catch { Note 'error' $_.Exception.Message }
  }
  if ($stuck) { break }
  if (++$guard -gt 2000) { break }
  Start-Sleep -Milliseconds 700
}
$left = @(Windows | ForEach-Object { "$($_.Current.Name) [$($_.Current.ClassName)] pid=$($_.Current.ProcessId)" })
ConvertTo-Json -InputObject ([ordered]@{ seen = $seen; closed = $closed; stuck = $stuck; answered = $answered; seconds = [int]((Get-Date) - $start).TotalSeconds; left = $left; events = $events }) -Depth 4 -Compress

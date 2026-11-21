# Acceptance-only UI Automation driver (#50 extension D): reads the TaroBird
# uninstaller's diagnostic dialog on a DISPOSABLE Windows runner and reports the
# text as UTF-16 code units in hex, read two ways (UI Automation names and the
# dialog's own Static controls via WM_GETTEXT), so a lost character in a
# console pipe cannot be mistaken for a character on screen. It answers the
# language chooser, presses Uninstall on the confirm page (data box untouched),
# signals -ReleaseFile, waits for -ReleasedFile, presses Retry, then Close.
# Button names match English and Simplified Chinese NSIS pages; Windows message
# box buttons follow the OS language. Results also go to -OutFile as UTF-8.
param([int]$TimeoutSec = 240, [int]$SceneTimeoutSec = 40, [string]$ReleaseFile = '', [string]$ReleasedFile = '', [string]$OutFile = '')
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
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

function BtnRx($el, [string]$rx) {
  foreach ($c in (Kids $el)) { if ((IsButton $c) -and (Clean $c.Current.Name) -match $rx) { return $c } }
  return $null
}
function Hex([string]$s) { (($s.ToCharArray() | ForEach-Object { '{0:X4}' -f [int]$_ }) -join ' ') }
function StaticTexts([int]$hwnd) {
  $parts = @(); $child = [IntPtr]::Zero
  do {
    $child = [BirdProbe.Win32]::FindWindowEx([IntPtr]$hwnd, $child, 'Static', $null)
    if ($child -ne [IntPtr]::Zero) { $sb = New-Object System.Text.StringBuilder 8192; [void][BirdProbe.Win32]::SendMessage($child, 0x000D, [IntPtr]8192, $sb); if ($sb.Length) { $parts += $sb.ToString() } }
  } while ($child -ne [IntPtr]::Zero)
  return ($parts -join ' | ')
}
$closed = $false; $seen = $false; $guard = 0; $empty = 0; $stuck = $false; $captured = $false
while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
  $wins = Windows
  if ($wins.Count) { $seen = $true; $empty = 0 } else { $empty++ }
  if ($closed -and -not $wins.Count) { break }
  if ($seen -and $empty -ge 12) { Note 'gone' 'no TaroBird window for ~8 s'; break }
  foreach ($w in $wins) {
    $key = "$($w.Current.NativeWindowHandle)|$($w.Current.Name)"
    $now = Text $w
    if (-not $since.ContainsKey($key) -or $seenText[$key] -ne $now -or $acted.ContainsKey($key)) { $since[$key] = Get-Date; $seenText[$key] = $now; [void]$acted.Remove($key) }
    elseif (((Get-Date) - $since[$key]).TotalSeconds -ge $SceneTimeoutSec) { Note 'stuck' "unchanged for ${SceneTimeoutSec}s: $($w.Current.Name) pid=$($w.Current.ProcessId); tree: $(Tree $w)"; $stuck = $true }
    try {
      if ($w.Current.Name -match '^(Installer|Uninstaller) Language$') {
        $okLang = Btn $w 'OK'
        if ($okLang) { Press $okLang; Note 'language' "$($w.Current.Name) (OK)"; $acted[$key] = $true; continue }
        $native = Win32Button $w.Current.NativeWindowHandle 'OK'
        if ($native -ne [IntPtr]::Zero) { [void][BirdProbe.Win32]::SendMessage($native, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero); Note 'language' "$($w.Current.Name) (Win32 OK)"; $acted[$key] = $true }
        continue
      }
      $retry = BtnRx $w '^(Retry|重试)'
      if ($retry) {
        $dialog = Scope $retry
        if (-not $captured) {
          $uia = Text $dialog; $raw = StaticTexts $dialog.Current.NativeWindowHandle
          Note 'problem-uia' $uia; Note 'problem-uia-hex' (Hex $uia); Note 'problem-win32' $raw; Note 'problem-win32-hex' (Hex $raw)
          $captured = $true
        }
        if ($ReleaseFile -and -not (Test-Path -LiteralPath $ReleasedFile)) {
          Set-Content -LiteralPath $ReleaseFile -Value 'release'
          $waited = 0; while (-not (Test-Path -LiteralPath $ReleasedFile) -and $waited -lt 120) { Start-Sleep -Seconds 1; $waited++ }
          Note 'released' "after ${waited}s"
        }
        Press (BtnRx $dialog '^(Retry|重试)'); Note 'answer' 'Retry'; $acted[$key] = $true; continue
      }
      $yes = Btn $w 'Yes'
      if ($yes -and (Btn (Scope $yes) 'No')) { $q = Scope $yes; Note 'question' (Text $q); Press (Btn $q 'No'); Note 'answer' 'No'; $acted[$key] = $true; continue }
      $un = BtnRx $w '^(Uninstall|卸载)'; $close = BtnRx $w '^(Close|关闭)'
      if ($un -and (Enabled $un)) { Note 'confirm-page' "$($w.Current.Name): $now"; Press $un; Note 'answer' 'Uninstall'; $acted[$key] = $true }
      elseif ($close -and (Enabled $close)) { Note 'finished' $now; Press $close; $closed = $true; $acted[$key] = $true }
      elseif ($now -match 'Aborted|not completed successfully|中止|未能') { $cancel = BtnRx $w '^(Cancel|取消)'; if ($cancel -and (Enabled $cancel)) { Note 'finished' "aborted: $now"; Press $cancel; $closed = $true; $acted[$key] = $true } }
    } catch { Note 'error' $_.Exception.Message }
  }
  if ($stuck) { break }
  if (++$guard -gt 2000) { break }
  Start-Sleep -Milliseconds 700
}
$left = @(Windows | ForEach-Object { "$($_.Current.Name) [$($_.Current.ClassName)] pid=$($_.Current.ProcessId)" })
$json = ConvertTo-Json -InputObject ([ordered]@{ seen = $seen; closed = $closed; stuck = $stuck; captured = $captured; seconds = [int]((Get-Date) - $start).TotalSeconds; left = $left; events = $events }) -Depth 4 -Compress
if ($OutFile) { [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false)) }
$json

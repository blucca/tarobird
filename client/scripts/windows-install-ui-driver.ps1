# Acceptance-only UI Automation driver for the interactive TaroBird SETUP on a
# DISPOSABLE Windows runner (#50 extension B3: GUI default upgrade). It only
# reads window text and presses the setup's and the old uninstaller's own
# buttons. Helpers are copied from windows-uninstall-ui-driver.ps1 (NSIS
# buttons are Win32 "Button" controls that UI Automation may report as Pane).
#   language chooser  -> its preselected language and OK
#   reinstall page    -> keep the default choice, record it, Next
#   old uninstaller   -> Uninstall (no data box touched), then Close
#   finish page       -> untick "Run TaroBird", Finish
#   anything else     -> I Agree / Next > / Install, else recorded as stuck
param([int]$TimeoutSec = 300, [int]$SceneTimeoutSec = 40, [string]$SetupPath = '', [string]$OutFile = '')
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


# --- #50 extension overrides ---------------------------------------------
# Only NSIS's own Win32 buttons: class "Button" with a window handle. A window's
# title-bar Close is a UI Automation Button without either, and pressing it
# mid-uninstall is what this excludes (run 44853329237, D).
function IsButton($c) { $c.Current.ClassName -eq 'Button' -and $c.Current.NativeWindowHandle -ne 0 }
function Desc($el) { "'$($el.Current.Name)' class=$($el.Current.ClassName) hwnd=$($el.Current.NativeWindowHandle)" }
Add-Type -Namespace BirdProbe -Name Win32Alive -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
[DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
"@
# A window whose UI thread is blocked (setup's page-leave ExecWait) would hang
# every UI Automation call on it; ask it a WM_NULL with a 400 ms limit first.
function Responsive($w) {
  $h = [IntPtr]$w.Current.NativeWindowHandle
  if ($h -eq [IntPtr]::Zero) { return $true }
  $r = [IntPtr]::Zero
  return [BirdProbe.Win32Alive]::SendMessageTimeout($h, 0, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 400, [ref]$r) -ne [IntPtr]::Zero
}
function OwnerPath($w) { try { [string](Get-CimInstance Win32_Process -Filter "ProcessId=$($w.Current.ProcessId)").ExecutablePath } catch { '' } }
$seen = $false; $guard = 0; $empty = 0; $stuck = $false; $noted = @{}
function Once([string]$kind, [string]$key, [string]$detail) { if (-not $noted.ContainsKey("$kind|$key")) { $noted["$kind|$key"] = $true; Note $kind $detail } }
while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
  $wins = Windows
  if ($wins.Count) { $seen = $true; $empty = 0 } else { $empty++ }
  if ($seen -and $empty -ge 12) { Note 'gone' 'no TaroBird window for ~8 s'; break }
  foreach ($w in $wins) {
    if (-not (Responsive $w)) { Once 'unresponsive' "$($w.Current.NativeWindowHandle)" "$($w.Current.Name) pid=$($w.Current.ProcessId) (UI thread busy; skipped while it is)"; continue }
    $key = "$($w.Current.NativeWindowHandle)|$($w.Current.Name)"
    $now = Text $w
    if (-not $since.ContainsKey($key) -or $seenText[$key] -ne $now -or $acted.ContainsKey($key)) { $since[$key] = Get-Date; $seenText[$key] = $now; [void]$acted.Remove($key) }
    elseif (((Get-Date) - $since[$key]).TotalSeconds -ge $SceneTimeoutSec) {
      Note 'stuck' "unchanged and unanswered for ${SceneTimeoutSec}s: $($w.Current.Name) [$($w.Current.ClassName)] pid=$($w.Current.ProcessId); tree: $(Tree $w)"
      $stuck = $true
    }
    try {
      if ($w.Current.Name -match '^(Installer|Uninstaller) Language$') {
        # Setup's own chooser is expected in a GUI run; the INSTALLED old
        # uninstaller asking (review N6) is recorded with its process.
        $owner = OwnerPath $w
        $kind = $(if ($SetupPath -and $owner -and $owner -ieq $SetupPath) { 'language' } else { 'old-uninstaller-language' })
        $okLang = Btn $w 'OK'
        if ($okLang) { Press $okLang; Note $kind "$($w.Current.Name) pid=$($w.Current.ProcessId) owner=$owner (OK $(Desc $okLang))"; $acted[$key] = $true; continue }
        $native = Win32Button $w.Current.NativeWindowHandle 'OK'
        if ($native -ne [IntPtr]::Zero) { [void][BirdProbe.Win32]::SendMessage($native, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero); Note $kind "$($w.Current.Name) owner=$owner (Win32 OK)"; $acted[$key] = $true }
        continue
      }
      $yes = Btn $w 'Yes'
      if ($yes -and (Btn (Scope $yes) 'No')) { $dialog = Scope $yes; Note 'question' (Text $dialog); Press (Btn $dialog 'No'); Note 'answer' 'No'; $acted[$key] = $true; continue }
      $retry = Btn $w 'Retry'; $ok = Btn $w 'OK'
      if ($retry -or ($ok -and (Text (Scope $ok)) -match 'TB-')) {
        $dialog = Scope $(if ($retry) { $retry } else { $ok }); Note 'problem' (Text $dialog)
        $cancel = Btn $dialog 'Cancel'; if ($cancel) { Press $cancel } elseif ($ok) { Press $ok }
        $acted[$key] = $true; continue
      }
      $isUninstaller = $w.Current.Name -like '*Uninstall*'
      if ($isUninstaller) {
        Once 'old-uninstaller' "$($w.Current.ProcessId)" "$($w.Current.Name) pid=$($w.Current.ProcessId) path=$((Get-CimInstance Win32_Process -Filter "ProcessId=$($w.Current.ProcessId)").ExecutablePath): $now"
        $un = Btn $w 'Uninstall'; $close = Btn $w 'Close'
        if ($un -and (Enabled $un)) { Press $un; Note 'pressed' "Uninstall on old uninstaller $(Desc $un), data boxes untouched"; $acted[$key] = $true }
        elseif ($close -and (Enabled $close)) { Press $close; Note 'pressed' "Close on old uninstaller $(Desc $close)"; $acted[$key] = $true }
        continue
      }
      $finish = Btn $w 'Finish'
      if ($finish -and (Enabled $finish)) {
        foreach ($c in (Kids $w)) { if ((IsButton $c) -and $c.Current.Name -like 'Run *' -and (Checked $c)) { Press $c; Start-Sleep -Milliseconds 300 } }
        Note 'finish-page' $now; Press $finish; $acted[$key] = $true; continue
      }
      if ($now -match 'Uninstall before installing|Do not uninstall|Add/Reinstall|already installed') {
        $choices = @(Kids $w | Where-Object { (IsButton $_) -and $_.Current.Name -match 'install' -and $_.Current.Name -notmatch '^(Install|Uninstall)$' } | ForEach-Object { "$($_.Current.Name)=$(if (Checked $_) { 'on' } else { 'off' })" }) -join '; '
        Once 'reinstall-page' $key "default choice: $choices"
      }
      foreach ($name in @('I Agree', 'Next >', 'Install')) {
        $b = Btn $w $name
        if ($b -and (Enabled $b)) { Press $b; Note 'pressed' "$name $(Desc $b)"; $acted[$key] = $true; break }
      }
    } catch { Note 'error' $_.Exception.Message }
  }
  if ($stuck) { break }
  if (++$guard -gt 2500) { break }
  Start-Sleep -Milliseconds 700
}
$left = @(Windows | ForEach-Object { "$($_.Current.Name) [$($_.Current.ClassName)] pid=$($_.Current.ProcessId)" })
$json = ConvertTo-Json -InputObject ([ordered]@{ seen = $seen; stuck = $stuck; seconds = [int]((Get-Date) - $start).TotalSeconds; left = $left; events = $events }) -Depth 4 -Compress
if ($OutFile) { [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false)) }
$json

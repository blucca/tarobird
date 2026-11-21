# ACCEPTANCE-ONLY: lists every visible top-level window (title, class, pid,
# owner, process path) and the uninstaller-related processes, once. Run by
# Windows PowerShell 5.1; appends one UTF-8 JSON line to $Out.
param([string]$Out, [int]$At)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class TopWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public static List<string> List() {
    var r = new List<string>();
    EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; var t = new StringBuilder(512); GetWindowText(h, t, 512); var c = new StringBuilder(256); GetClassName(h, c, 256); uint pid; GetWindowThreadProcessId(h, out pid); r.Add(pid + "\t" + c + "\t" + t + "\towner=" + GetWindow(h, 4)); return true; }, IntPtr.Zero);
    return r; } }
"@
$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(uninstall|Un_A|Au_|tarocub-client|tarobot-installer-helper)\.exe$' -or $_.ExecutablePath -like '*\TaroBird\*' } | ForEach-Object { "$($_.ProcessId) <- $($_.ParentProcessId) $($_.Name) $($_.CommandLine)" })
$wins = @([TopWindows]::List() | Where-Object { $_ -notmatch "`t(Shell_TrayWnd|Progman|WorkerW|Windows.UI.Core.CoreWindow|ApplicationFrameWindow|Shell_SecondaryTrayWnd)`t" } | ForEach-Object {
  $p = [int]($_ -split "`t")[0]; $path = (Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue).ExecutablePath; "$_`tpath=$path" })
$line = [ordered]@{ at = $At; processes = $procs; windows = $wins } | ConvertTo-Json -Compress -Depth 3
[IO.File]::AppendAllText($Out, "$line`n", [Text.UTF8Encoding]::new($false))

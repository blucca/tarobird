# Acceptance-only probe for a DISPOSABLE GitHub-hosted Windows runner (#50
# follow-up, install/notification-aumid). It never builds or installs
# TaroBird. It creates per-user Start Menu shortcuts to copies of a system exe,
# stamps them the way the product does (System.AppUserModel.ID plus
# ToastActivatorCLSID) or not at all, reads the properties back, then polls
# Get-StartApps (Windows PowerShell 5.1, like windows-acceptance.mjs) to see
# whether and when each AppID is listed.
param([int]$PollSeconds = 180, [int]$IntervalSeconds = 3)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Only a disposable GitHub-hosted runner may run this probe' }
$started = Get-Date
function Out-Line([string]$kind, $data) {
  $line = [ordered]@{ s = [math]::Round(((Get-Date) - $started).TotalSeconds, 1); kind = $kind; data = $data }
  Write-Output (ConvertTo-Json -InputObject $line -Compress -Depth 5)
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LinkProps {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint c);
    [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
    [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
    [PreserveSig] int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr pbc, int flags, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);
  [DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr a, IntPtr b);
  static readonly Guid AUM = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  static PROPERTYKEY Key(uint pid) { return new PROPERTYKEY { fmtid = AUM, pid = pid }; }
  static IPropertyStore Open(string path, bool write) {
    Guid iid = typeof(IPropertyStore).GUID; IPropertyStore store;
    int hr = SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, write ? 2 : 0, ref iid, out store);
    if (hr != 0) throw new Exception("SHGetPropertyStoreFromParsingName 0x" + hr.ToString("X8"));
    return store;
  }
  public static void Stamp(string path, string id, bool clsid) {
    IPropertyStore store = Open(path, true);
    PROPVARIANT v = new PROPVARIANT { vt = 31, p = Marshal.StringToCoTaskMemUni(id) };
    PROPERTYKEY k = Key(5);
    int hr = store.SetValue(ref k, ref v); PropVariantClear(ref v);
    if (hr != 0) throw new Exception("SetValue(ID) 0x" + hr.ToString("X8"));
    if (clsid) {
      IntPtr g = Marshal.AllocCoTaskMem(16); Marshal.StructureToPtr(new Guid("5e8c5c51-d485-4c46-b76a-02547bcd6776"), g, false);
      PROPVARIANT c = new PROPVARIANT { vt = 72, p = g }; PROPERTYKEY kc = Key(26);
      hr = store.SetValue(ref kc, ref c); PropVariantClear(ref c);
      if (hr != 0) throw new Exception("SetValue(CLSID) 0x" + hr.ToString("X8"));
    }
    hr = store.Commit(); Marshal.ReleaseComObject(store);
    if (hr != 0) throw new Exception("Commit 0x" + hr.ToString("X8"));
  }
  public static string Read(string path) {
    IPropertyStore store = Open(path, false);
    PROPERTYKEY k = Key(5), kc = Key(26); PROPVARIANT v, c; string id = "<none>", clsid = "<none>";
    if (store.GetValue(ref k, out v) == 0) { if (v.vt == 31) id = Marshal.PtrToStringUni(v.p); else if (v.vt != 0) id = "<vt " + v.vt + ">"; PropVariantClear(ref v); }
    if (store.GetValue(ref kc, out c) == 0) { if (c.vt == 72) clsid = ((Guid)Marshal.PtrToStructure(c.p, typeof(Guid))).ToString(); else if (c.vt != 0) clsid = "<vt " + c.vt + ">"; PropVariantClear(ref c); }
    Marshal.ReleaseComObject(store);
    return id + " | " + clsid;
  }
}
'@

$os = Get-CimInstance Win32_OperatingSystem
$shell = @('explorer', 'StartMenuExperienceHost', 'ShellExperienceHost', 'SearchHost', 'sihost', 'ctfmon') | ForEach-Object {
  $p = @(Get-Process -Name $_ -ErrorAction SilentlyContinue); "$_=$($p.Count)" }
Out-Line 'environment' ([ordered]@{ os = "$($os.Caption) $($os.Version) build $($os.BuildNumber)"; edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').InstallationType
  session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId; interactive = [Environment]::UserInteractive; ps = $PSVersionTable.PSVersion.ToString(); shell = ($shell -join ' ')
  getStartApps = [string](Get-Command Get-StartApps -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Source) $($_.Version)" }) })
try {
  $before = @(Get-StartApps)
  Out-Line 'start-apps-before' ([ordered]@{ count = $before.Count; desktopLike = @($before | Where-Object { $_.AppID -notmatch '!' }).Count; sample = @($before | Select-Object -First 8 | ForEach-Object { "$($_.Name) => $($_.AppID)" }) })
} catch { Out-Line 'start-apps-before-error' $_.Exception.Message }

$programs = [Environment]::GetFolderPath('Programs')
$work = Join-Path $env:LOCALAPPDATA 'TaroBirdAumidProbe'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$wsh = New-Object -ComObject WScript.Shell
# name, AppID stamped (empty = none), stamp the toast CLSID too
$cases = @(
  @{ key = 'product-props'; name = 'TaroBird AUMID Probe'; id = 'com.tarobot.aumidprobe'; clsid = $true },
  @{ key = 'id-only'; name = 'TaroBird AUMID Probe IdOnly'; id = 'com.tarobot.aumidprobe.idonly'; clsid = $false },
  @{ key = 'no-id-control'; name = 'TaroBird AUMID Probe NoId'; id = ''; clsid = $false }
)
foreach ($c in $cases) {
  $exe = Join-Path $work "$($c.key).exe"
  Copy-Item -LiteralPath "$env:SystemRoot\System32\whoami.exe" -Destination $exe -Force
  $lnk = Join-Path $programs "$($c.name).lnk"
  $s = $wsh.CreateShortcut($lnk); $s.TargetPath = $exe; $s.Save()
  if ($c.id) { [LinkProps]::Stamp($lnk, $c.id, $c.clsid) }
  $c.lnk = $lnk; $c.exe = $exe
  Out-Line 'shortcut' ([ordered]@{ case = $c.key; lnk = $lnk; readBack = [LinkProps]::Read($lnk); target = $wsh.CreateShortcut($lnk).TargetPath })
}

$seen = @{}
$notified = $false
$deadline = $started.AddSeconds($PollSeconds + 30)
while ((Get-Date) -lt $deadline) {
  try { $apps = @(Get-StartApps) } catch { Out-Line 'poll-error' $_.Exception.Message; $apps = @() }
  foreach ($c in $cases) {
    if ($seen.ContainsKey($c.key)) { continue }
    $hit = @($apps | Where-Object { $_.Name -eq $c.name })
    if ($hit.Count) {
      $seen[$c.key] = $true
      $exact = if ($c.id) { [bool]($hit | Where-Object { $_.AppID -eq $c.id }) } else { $null }
      Out-Line 'listed' ([ordered]@{ case = $c.key; appIds = @($hit | ForEach-Object { $_.AppID }); exactIdMatch = $exact; totalApps = $apps.Count })
    }
  }
  if ($seen.Count -eq $cases.Count) { break }
  # Halfway with something still missing: ask the shell to refresh once, and record that.
  if (-not $notified -and ((Get-Date) - $started).TotalSeconds -gt ($PollSeconds / 2)) {
    [LinkProps]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)  # SHCNE_ASSOCCHANGED
    $notified = $true; Out-Line 'shell-refresh-requested' 'SHChangeNotify(SHCNE_ASSOCCHANGED)'
  }
  Start-Sleep -Seconds $IntervalSeconds
}
$apps = @(Get-StartApps)
Out-Line 'summary' ([ordered]@{ listed = @($seen.Keys); notListed = @($cases | Where-Object { -not $seen.ContainsKey($_.key) } | ForEach-Object { $_.key }); totalApps = $apps.Count
  probeEntries = @($apps | Where-Object { $_.Name -like 'TaroBird AUMID Probe*' } | ForEach-Object { "$($_.Name) => $($_.AppID)" }); shell = (@('explorer', 'StartMenuExperienceHost') | ForEach-Object { "$_=$(@(Get-Process -Name $_ -ErrorAction SilentlyContinue).Count)" }) -join ' ' })

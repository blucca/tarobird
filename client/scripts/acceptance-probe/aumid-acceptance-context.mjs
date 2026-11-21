// Acceptance-only (#50 follow-up): run the exact install/notification-aumid
// query of windows-acceptance.mjs through its own windowsSystem().powershell,
// from the same `shell: pwsh` -> node -> powershell.exe chain, and keep the
// stderr and exit code that the check itself discards.
import { windowsSystem } from '../windows-acceptance.mjs';
const sys = windowsSystem();
const ids = process.argv.slice(2);
const show = (label, result) => console.log(JSON.stringify({ label, code: result.code, stdout: result.stdout.trim().slice(0, 1500), stderr: result.stderr.trim().slice(0, 1500) }));
show('PSModulePath (inherited by powershell.exe)', { code: 0, stdout: process.env.PSModulePath ?? '<unset>', stderr: '' });
show('module lookup', await sys.powershell(`$PSVersionTable.PSVersion.ToString(); (Get-Command Get-StartApps -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Source) $($_.Version) $($_.Module.Path)" }); $env:PSModulePath`));
for (const id of ids) {
  // Byte-for-byte the check's command (windows-acceptance.mjs: notification-aumid).
  const result = await sys.powershell(`Get-StartApps | Where-Object { $_.AppID -eq '${id}' } | ForEach-Object { $_.AppID }`);
  show(`acceptance query for ${id}`, result);
  console.log(JSON.stringify({ label: `acceptance verdict for ${id}`, pass: result.stdout.trim().split(/\r?\n/).includes(id) }));
}
show('Get-StartApps count', await sys.powershell('@(Get-StartApps).Count'));
// The shortcut-appusermodel-id query of accept/50-final-20261121 143c1c6, verbatim except the path.
const q = value => value.replaceAll("'", "''");
const programs = `${process.env.APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs`;
for (const [link, expected] of [['TaroBird AUMID Probe Lpwstr.lnk', 'com.tarobot.aumidprobe.lpwstr'], ['TaroBird AUMID Probe BstrProduct.lnk', 'com.tarobot.aumidprobe.bstrproduct'],
  ['TaroBird AUMID Probe Nsis.lnk', 'com.tarobot.aumidprobe.nsis'], ['TaroBird AUMID Probe NoId.lnk', '']]) {
  const result = await sys.powershell(`$i = (New-Object -ComObject Shell.Application).Namespace('${q(programs)}').ParseName('${q(link)}'); [string]$i.ExtendedProperty('System.AppUserModel.ID')`);
  show(`143c1c6 shortcut-appusermodel-id query on ${link}`, result);
  console.log(JSON.stringify({ label: `143c1c6 verdict on ${link}`, expected, got: result.stdout.trim(), matches: result.stdout.trim() === expected }));
}

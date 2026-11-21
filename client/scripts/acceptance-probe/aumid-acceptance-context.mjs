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

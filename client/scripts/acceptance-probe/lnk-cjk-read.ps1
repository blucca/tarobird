# ACCEPTANCE-ONLY: reads the CJK probe shortcut's target three ways and prints
# UTF-16 code units in hex (ASCII-safe, independent of console encoding).
param([string]$Link, [string]$Expected, [string]$Out)
$ErrorActionPreference = 'Stop'
function Hex([string]$s) { if ($null -eq $s) { return '<null>' }; ($s.ToCharArray() | ForEach-Object { '{0:X4}' -f [int]$_ }) -join ' ' }
$r = [ordered]@{ host = "$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"; expectedHex = Hex $Expected }
$wsh = (New-Object -ComObject WScript.Shell).CreateShortcut($Link).TargetPath
$r.wshHex = Hex $wsh; $r.wshEqual = ($wsh -eq $Expected)
$item = (New-Object -ComObject Shell.Application).Namespace([IO.Path]::GetDirectoryName($Link)).ParseName([IO.Path]::GetFileName($Link))
$shell = $item.GetLink.Path
$r.shellHex = Hex $shell; $r.shellEqual = ($shell -eq $Expected)
$r.appId = [string]$item.ExtendedProperty('System.AppUserModel.ID')
$bytes = [IO.File]::ReadAllBytes($Link)
$needle = [Text.Encoding]::Unicode.GetBytes([IO.Path]::GetDirectoryName($Expected))
$hit = -1
for ($i = 0; $i -le $bytes.Length - $needle.Length -and $hit -lt 0; $i++) { $ok = $true; for ($j = 0; $j -lt $needle.Length; $j++) { if ($bytes[$i + $j] -ne $needle[$j]) { $ok = $false; break } }; if ($ok) { $hit = $i } }
$r.bytesHaveUtf16Dir = ($hit -ge 0); $r.utf16Offset = $hit; $r.lnkBytes = $bytes.Length
[IO.File]::WriteAllText($Out, ($r | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
"probe $($r.host): wshEqual=$($r.wshEqual) shellEqual=$($r.shellEqual) bytesHaveUtf16Dir=$($r.bytesHaveUtf16Dir) appId=$($r.appId)"
"  expected $($r.expectedHex)"
"  wsh      $($r.wshHex)"
"  shell    $($r.shellHex)"

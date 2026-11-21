# Acceptance-only step watchdog (#50 ext2) for a DISPOSABLE GitHub-hosted runner.
# Runs `node <ArgumentLine>` with stdout/stderr redirected to files, so no
# installer, uninstaller or App process it starts can inherit the step's pipes
# (packages 44824551439 and 44863289041 stayed "in progress" past their step
# timeout and never uploaded logs). After -Minutes it prints what is still
# running and which windows are open, ends the node tree and the processes this
# suite can start, prints the captured output and fails the step.
param([Parameter(Mandatory = $true)][string]$Name, [int]$Minutes = 30, [Parameter(Mandatory = $true)][string]$ArgumentLine)
$out = Join-Path $env:RUNNER_TEMP "$Name.stdout.log"; $err = Join-Path $env:RUNNER_TEMP "$Name.stderr.log"
$started = Get-Date
$p = Start-Process -FilePath node -ArgumentList $ArgumentLine -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -PassThru
[void]$p.Handle
$code = 0
if (-not $p.WaitForExit($Minutes * 60000)) {
  "WATCHDOG: $Name still running after $Minutes min. Processes started since $($started.ToString('HH:mm:ss')):"
  Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -ge $started } | ForEach-Object { "  $($_.ProcessId) <- $($_.ParentProcessId) $($_.Name) $($_.CommandLine)" }
  'Open windows:'
  Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "  $($_.Id) $($_.ProcessName): $($_.MainWindowTitle)" }
  taskkill.exe /PID $p.Id /T /F | Out-Host
  $own = '^(tarocub-client|tarobot-installer-helper|tarobot-desktop-core|tarobot-desktop-updater|tarobot-migration-exporter|uninstall|Un|Un_A|Au_|TaroBird_.*-setup|TaroBot-.*-setup)\.exe$'
  Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -ge $started -and ($_.Name -match $own -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'resources\\host')) } | ForEach-Object { "  ending $($_.ProcessId) $($_.Name)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $code = 124
} else { $code = $p.ExitCode }
"===== $Name stdout ====="; Get-Content -LiteralPath $out -ErrorAction SilentlyContinue
"===== $Name stderr ====="; Get-Content -LiteralPath $err -ErrorAction SilentlyContinue
"===== $Name exit $code ====="
exit $code

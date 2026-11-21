// Acceptance-only probe helper: a node process that never exits and starts a
// grandchild that inherits its stdout/stderr, like an execFile-driven installer
// whose App child lingers. Prints one line first. Used only under the watchdog.
import { spawn } from 'node:child_process';
console.log('pipe-holder: started, spawning a grandchild that inherits stdio');
spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 900'], { stdio: 'inherit' });
setInterval(() => {}, 1000);

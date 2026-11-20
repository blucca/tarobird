// #48 Windows remote-screen acceptance driver for a DISPOSABLE GitHub-hosted
// Windows runner. Verifies official functionality only (service registration,
// legacy client gate, synthetic frame stream, pointer/click/double-click/text,
// held-key journal, and foreground-loss abort + release) using Fable's reviewed
// stage3-test-window.cjs and an isolated Electron target wired to a real
// HubServer + real Windows named pipe + synthetic capture host.
//
// Never connects to user devices, never captures the real desktop, never opens
// OS permissions, never bypasses desktop/foreground restrictions, and emits
// redacted results only.
import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { build as esbuild } from 'esbuild';
import { WebSocket, WebSocketServer } from 'ws';
import { HubServer } from '../../dist/src/hub/server.js';
import { startHubControl } from '../../dist/src/hub/service.js';
import { deviceProof, hashSecret } from '../../dist/src/hub/auth.js';
import { deviceActionProofText } from '../../dist/src/client-protocol/device-actions.js';
import { screenConfigureText, screenJoinSchema, screenStatusSchema } from '../../dist/src/client-protocol/remote-screen.js';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(20);
  }
  return Boolean(await check());
};

class Receipt {
  checks = [];
  add(phase, id, status, detail = '') {
    this.checks.push({ phase, id, status, detail: String(detail).slice(0, 1500) });
    return status === 'pass';
  }
  expect(phase, id, ok, detail) { return this.add(phase, id, ok ? 'pass' : 'fail', detail); }
  skip(phase, id, detail) { return this.add(phase, id, 'skip', detail); }
  info(phase, id, detail) { return this.add(phase, id, 'info', detail); }
  get outcome() {
    if (this.checks.some(c => c.status === 'fail')) return 'fail';
    if (this.checks.some(c => c.status === 'skip')) return 'incomplete';
    return 'pass';
  }
  markdown(meta) {
    const icon = { pass: 'pass', fail: 'FAIL', skip: 'skip (not pass)', info: 'info (not judged)' };
    const rows = this.checks.map(c => `| ${c.phase} | ${c.id} | ${icon[c.status]} | ${c.detail.replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', ' ')} |`);
    return [
      `# #48 Windows Remote-Screen Disposable Runner Acceptance`,
      ``,
      `- Started: ${meta.startedAt}`,
      `- Outcome: **${this.outcome}** (skips are never passes)`,
      `- Source commit: \`${meta.sourceCommit}\``,
      `- Native addon sha256: \`${meta.addonSha256}\``,
      `- Stage3 script sha256: \`${meta.stage3Sha256}\``,
      ``,
      `| phase | check | status | detail |`,
      `| --- | --- | --- | --- |`,
      ...rows,
      ``,
    ].join('\n');
  }
}

async function windowsOsPreflight() {
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinDesktopProbe {
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetUserObjectInformationW(IntPtr hObj, int nIndex, StringBuilder pvInfo, uint nLength, out uint lpnLengthNeeded);
  public static string InputDesktopName() {
    IntPtr h = OpenInputDesktop(0, false, 0x0001);
    if (h == IntPtr.Zero) return "unavailable:" + Marshal.GetLastWin32Error();
    try {
      uint needed = 0;
      var sb = new StringBuilder(128);
      if (GetUserObjectInformationW(h, 2, sb, 256, out needed)) return sb.ToString();
      return "unreadable:" + Marshal.GetLastWin32Error();
    } finally { CloseDesktop(h); }
  }
}
"@
$proc = [System.Diagnostics.Process]::GetCurrentProcess()
$console = [WinDesktopProbe]::WTSGetActiveConsoleSessionId()
$desktop = [WinDesktopProbe]::InputDesktopName()
$groups = (whoami /groups /fo csv 2>$null | Out-String)
$integrity = 'unknown'
if ($groups -match 'S-1-16-16384') { $integrity = 'system' }
elseif ($groups -match 'S-1-16-12288') { $integrity = 'high' }
elseif ($groups -match 'S-1-16-8192') { $integrity = 'medium' }
elseif ($groups -match 'S-1-16-4096') { $integrity = 'low' }
$out = @{
  processSessionId = $proc.SessionId
  activeConsoleSessionId = $console
  onConsoleSession = ($proc.SessionId -eq $console)
  userInteractive = [Environment]::UserInteractive
  inputDesktop = $desktop
  integrity = $integrity
}
$out | ConvertTo-Json -Compress
`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { timeout: 20000 });
    return JSON.parse(stdout.trim());
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 200) };
  }
}

async function runHookWireProbe(workDir, triggerAddon) {
  const readyFile = path.join(workDir, 'hook-probe.ready');
  const stopFile = path.join(workDir, 'hook-probe.stop');
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class HookWireProbe {
  private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  private static HookProc _mouseProc;
  private static HookProc _keyProc;
  private static List<string> _events = new List<string>();
  private static string _phase = "addon";

  [StructLayout(LayoutKind.Sequential)]
  private struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)]
  private struct MSLLHOOKSTRUCT {
    public POINT pt;
    public uint mouseData;
    public uint flags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct KBDLLHOOKSTRUCT {
    public uint vkCode;
    public uint scanCode;
    public uint flags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct HARDWAREINPUT {
    public uint uMsg; public ushort wParamL; public ushort wParamH;
  }
  [StructLayout(LayoutKind.Explicit)]
  private struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct INPUT {
    public uint type;
    public INPUTUNION u;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct MSG {
    public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT pt;
  }

  [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWindowsHookExW(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetModuleHandleW(string lpModuleName);
  [DllImport("user32.dll")] private static extern bool PeekMessageW(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);
  [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  private static IntPtr MouseCb(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0 && lParam != IntPtr.Zero && _events.Count < 40) {
      MSLLHOOKSTRUCT s = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
      _events.Add(string.Format("{{\\"p\\":\\"{0}\\",\\"k\\":\\"m\\",\\"wp\\":\\"{1:x}\\",\\"fl\\":\\"{2:x}\\",\\"ex\\":\\"{3:x16}\\"}}",
        _phase, wParam.ToInt64(), s.flags, s.dwExtraInfo.ToUInt64()));
    }
    return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
  }
  private static IntPtr KeyCb(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0 && lParam != IntPtr.Zero && _events.Count < 40) {
      KBDLLHOOKSTRUCT s = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
      _events.Add(string.Format("{{\\"p\\":\\"{0}\\",\\"k\\":\\"k\\",\\"wp\\":\\"{1:x}\\",\\"fl\\":\\"{2:x}\\",\\"ex\\":\\"{3:x16}\\"}}",
        _phase, wParam.ToInt64(), s.flags, s.dwExtraInfo.ToUInt64()));
    }
    return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
  }
  private static void Pump(int ms) {
    int end = Environment.TickCount + ms;
    MSG m;
    while (Environment.TickCount < end) {
      while (PeekMessageW(out m, IntPtr.Zero, 0, 0, 1)) {}
      Thread.Sleep(5);
    }
  }
  public static string Run(string readyPath, string stopPath) {
    _mouseProc = new HookProc(MouseCb);
    _keyProc = new HookProc(KeyCb);
    IntPtr mod = GetModuleHandleW(null);
    IntPtr hm = SetWindowsHookExW(14, _mouseProc, mod, 0);
    IntPtr hk = SetWindowsHookExW(13, _keyProc, mod, 0);
    if (hm == IntPtr.Zero || hk == IntPtr.Zero) {
      if (hm != IntPtr.Zero) UnhookWindowsHookEx(hm);
      if (hk != IntPtr.Zero) UnhookWindowsHookEx(hk);
      return "{\\"error\\":\\"hook_install_failed\\"}";
    }
    try {
      File.WriteAllText(readyPath, "ok");
      int deadline = Environment.TickCount + 8000;
      MSG m;
      while (!File.Exists(stopPath) && Environment.TickCount < deadline) {
        while (PeekMessageW(out m, IntPtr.Zero, 0, 0, 1)) {}
        Thread.Sleep(5);
      }
      Pump(120);
      int sz = Marshal.SizeOf(typeof(INPUT));
      // Self-control test: 64-bit tag vs 32-bit tag via SendInput (mouse move + ShiftLeft down/up).
      _phase = "self64";
      INPUT[] m64 = new INPUT[1];
      m64[0].type = 0;
      m64[0].u.mi.dx = 32768; m64[0].u.mi.dy = 20000;
      m64[0].u.mi.dwFlags = 0x0001 | 0x8000 | 0x4000;
      m64[0].u.mi.dwExtraInfo = new UIntPtr(0x1122334455667789UL);
      uint sm64 = SendInput(1, m64, sz);
      INPUT[] k64 = new INPUT[2];
      k64[0].type = 1; k64[0].u.ki.wScan = 0x2a; k64[0].u.ki.dwFlags = 0x0008; k64[0].u.ki.dwExtraInfo = new UIntPtr(0x1122334455667789UL);
      k64[1].type = 1; k64[1].u.ki.wScan = 0x2a; k64[1].u.ki.dwFlags = 0x0008 | 0x0002; k64[1].u.ki.dwExtraInfo = new UIntPtr(0x1122334455667789UL);
      uint sk64 = SendInput(2, k64, sz);
      Pump(120);

      _phase = "self32";
      INPUT[] m32 = new INPUT[1];
      m32[0].type = 0;
      m32[0].u.mi.dx = 32800; m32[0].u.mi.dy = 20000;
      m32[0].u.mi.dwFlags = 0x0001 | 0x8000 | 0x4000;
      m32[0].u.mi.dwExtraInfo = new UIntPtr(0x0000000055667789UL);
      uint sm32 = SendInput(1, m32, sz);
      INPUT[] k32 = new INPUT[2];
      k32[0].type = 1; k32[0].u.ki.wScan = 0x2a; k32[0].u.ki.dwFlags = 0x0008; k32[0].u.ki.dwExtraInfo = new UIntPtr(0x0000000055667789UL);
      k32[1].type = 1; k32[1].u.ki.wScan = 0x2a; k32[1].u.ki.dwFlags = 0x0008 | 0x0002; k32[1].u.ki.dwExtraInfo = new UIntPtr(0x0000000055667789UL);
      uint sk32 = SendInput(2, k32, sz);
      Pump(120);

      return string.Format("{{\\"inputSize\\":{0},\\"sent\\":{{\\"m64\\":{1},\\"k64\\":{2},\\"m32\\":{3},\\"k32\\":{4}}},\\"events\\":[{5}]}}",
        sz, sm64, sk64, sm32, sk32, string.Join(",", _events.ToArray()));
    } finally {
      UnhookWindowsHookEx(hm);
      UnhookWindowsHookEx(hk);
    }
  }
}
"@
[HookWireProbe]::Run($args[0], $args[1])
`;
  const scriptFile = path.join(workDir, 'hook-wire-probe.ps1');
  await writeFile(scriptFile, psScript);
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', scriptFile, readyFile, stopFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += String(d); });
    child.stderr.on('data', d => { if (stderr.length < 1000) stderr += String(d); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 20000);
    (async () => {
      const ready = await wait(() => existsSync(readyFile), 8000);
      if (ready) {
        try { await triggerAddon(); } catch { /* ignore */ }
      }
      await writeFile(stopFile, 'stop').catch(() => {});
    })();
    child.once('exit', code => {
      clearTimeout(timer);
      const start = stdout.indexOf('{');
      const end = stdout.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { resolve(JSON.parse(stdout.slice(start, end + 1))); return; } catch { /* ignore */ }
      }
      resolve({ error: `exit_${code}`, stderr: stderr.slice(0, 400) });
    });
  });
}

async function injectForeignMouseInsideWindow(workDir, absDx, absDy) {
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ForeignMouseSender {
  [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] private struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] private struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public static string Send(int dx, int dy) {
    int sz = Marshal.SizeOf(typeof(INPUT));
    INPUT[] arr = new INPUT[1];
    arr[0].type = 0;
    arr[0].u.mi.dx = dx;
    arr[0].u.mi.dy = dy;
    arr[0].u.mi.dwFlags = 0x0001 | 0x8000 | 0x4000;
    arr[0].u.mi.dwExtraInfo = UIntPtr.Zero;
    uint sent = SendInput(1, arr, sz);
    return string.Format("{{\\"sent\\":{0},\\"inputSize\\":{1}}}", sent, sz);
  }
}
"@
[ForeignMouseSender]::Send([int]$args[0], [int]$args[1])
`;
  const scriptFile = path.join(workDir, 'foreign-mouse-sender.ps1');
  await writeFile(scriptFile, psScript);
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', scriptFile, String(absDx), String(absDy)], { timeout: 15000 });
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  return start >= 0 && end > start ? JSON.parse(stdout.slice(start, end + 1)) : { sent: 0 };
}

function makeDevice(deviceId) {
  const keys = generateKeyPairSync('ed25519');
  return {
    deviceId,
    name: deviceId,
    platform: 'web',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: keys.privateKey,
  };
}

async function loginFor(auth, device) {
  const connection = `acc_${randomBytes(8).toString('hex')}`;
  const clientNonce = randomBytes(32).toString('base64url');
  const { nonce } = await auth.challenge(connection, device.deviceId, clientNonce, '127.0.0.1');
  const signature = sign(null, deviceProof(device.deviceId, nonce, clientNonce), device.privateKey).toString('base64');
  const { token } = await auth.authenticate(connection, signature);
  const session = await auth.authorize(token, '127.0.0.1');
  return { token, session };
}

function connectWs(url, cleanups) {
  const ws = new WebSocket(url);
  const values = [];
  ws.on('message', (data, binary) => {
    values.push(binary ? new Uint8Array(data) : JSON.parse(data.toString()));
  });
  ws.on('error', () => {});
  cleanups.push(async () => { try { ws.terminate(); } catch { /* ignore */ } });
  const ready = new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, values, ready, send: v => ws.send(JSON.stringify(v)) };
}

async function spawnTarget(electronBin, entryFile, { addon, hostDir, appState, profile }) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const addr = wss.address();
  const rpcUrl = `ws://127.0.0.1:${addr.port}`;

  let nextId = 1;
  let clientWs = null;
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  wss.on('connection', ws => {
    clientWs = ws;
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.event === 'ready') { readyResolve(); return; }
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error || 'target_rpc_failed'));
      }
    });
  });

  const child = spawn(electronBin, [
    entryFile,
    '--addon', addon,
    '--host-dir', hostDir,
    '--app-state', appState,
    '--profile', profile,
    '--rpc-url', rpcUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });

  child.once('error', err => readyReject(err));
  child.once('exit', code => {
    for (const [, entry] of pending) entry.reject(new Error(`target_exited_${code}`));
    pending.clear();
    readyReject(new Error(`target_exited_before_ready_${code}`));
  });

  const stderrChunks = [];
  child.stderr.on('data', chunk => {
    if (stderrChunks.length < 40) stderrChunks.push(String(chunk).slice(0, 400));
  });

  const call = (op, payload = {}, timeoutMs = 35000) => new Promise((resolve, reject) => {
    if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
      reject(new Error(`target_rpc_not_connected:${op}`));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`target_rpc_timeout:${op}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    clientWs.send(JSON.stringify({ id, op, ...payload }));
  });

  const close = async () => {
    try { await call('shutdown', {}, 5000); } catch { /* ignore */ }
    try { clientWs?.terminate(); } catch { /* ignore */ }
    try { wss.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
  };

  return { child, ready, call, close, stderr: () => stderrChunks.join('').slice(0, 600) };
}

async function runStage3(electronBin, stage3Script, addonPath, workDir) {
  const dir = path.join(workDir, 'stage3-run');
  await mkdir(dir, { recursive: true });
  const scriptCopy = path.join(dir, 'stage3-test-window.cjs');
  await copyFile(stage3Script, scriptCopy);
  return new Promise(resolve => {
    const child = spawn(electronBin, [scriptCopy, addonPath], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += String(chunk); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 60000);
    child.once('exit', code => {
      clearTimeout(timer);
      let parsed = null;
      const start = stdout.indexOf('{');
      const end = stdout.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(stdout.slice(start, end + 1)); } catch { /* ignore */ }
      }
      resolve({ code, parsed, rawStderr: stderr.slice(0, 500) });
    });
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ code: -1, parsed: null, rawStderr: String(error?.message ?? error) });
    });
  });
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'confirm-disposable-windows': { type: 'boolean', default: false },
      electron: { type: 'string' },
      addon: { type: 'string' },
      report: { type: 'string' },
      'stage3-script': { type: 'string' },
      'source-commit': { type: 'string', default: 'unknown' },
    },
  });

  if (process.platform !== 'win32' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.TAROBOT_WINDOWS_ACCEPTANCE !== 'disposable' || !values['confirm-disposable-windows']) {
    throw new Error('Refusing to run: requires a disposable GitHub-hosted Windows runner with TAROBOT_WINDOWS_ACCEPTANCE=disposable and --confirm-disposable-windows');
  }
  const electronBin = path.resolve(values.electron || '');
  const addonPath = path.resolve(values.addon || '');
  const reportDir = path.resolve(values.report || '');
  const stage3Script = path.resolve(values['stage3-script'] || path.join(HERE, 'windows-screen-acceptance-stage3.cjs'));
  if (!existsSync(electronBin)) throw new Error('Electron binary not found');
  if (!existsSync(addonPath)) throw new Error('Native addon not found');
  if (!existsSync(stage3Script)) throw new Error('Stage3 test script not found');

  await mkdir(reportDir, { recursive: true });
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'tarobird-48-acc-'));
  const cleanups = [() => rm(workDir, { recursive: true, force: true })];

  const addonSha256 = createHash('sha256').update(await readFile(addonPath)).digest('hex');
  const stage3Raw = await readFile(stage3Script);
  const stage3Sha256 = createHash('sha256').update(stage3Raw).digest('hex');
  const stage3LfSha256 = createHash('sha256').update(Buffer.from(stage3Raw.toString('utf8').replaceAll('\r\n', '\n'), 'utf8')).digest('hex');
  const receipt = new Receipt();
  const meta = {
    startedAt: new Date().toISOString(),
    sourceCommit: values['source-commit'],
    addonSha256,
    stage3Sha256,
    stage3LfSha256,
  };
  const evidence = { meta, osPreflight: null, stage3: null, e2ePreflight: null, e2eControlEvents: null, observations: null, hookWireProbe: null };

  try {
    // 1. OS interactive desktop preflight (no guesses).
    const osPre = await windowsOsPreflight();
    evidence.osPreflight = osPre;
    receipt.info('preflight', 'windows-os-session', JSON.stringify(osPre));

    // 2. Run Fable's reviewed stage3-test-window.cjs inside real Electron with real native addon.
    const stage3 = await runStage3(electronBin, stage3Script, addonPath, workDir);
    if (!stage3.parsed) {
      receipt.expect('stage3', 'electron-stage3-json', false, `exit=${stage3.code}, no JSON output; stderr=${stage3.rawStderr}`);
    } else {
      const s = stage3.parsed;
      evidence.stage3 = {
        exit: stage3.code,
        aborted: s.aborted,
        passed: s.passed,
        failed: s.failed,
        postedCount: s.posted?.length ?? 0,
        pendingAtExit: s.pendingAtExit,
        monitor: s.monitor,
        steps: s.steps,
      };
      const noDesktop = s.aborted === 'test_window_not_in_front' || s.steps?.some(step => step.name === 'the session can be controlled' && !step.ok);
      if (noDesktop) {
        receipt.skip('stage3', 'fable-stage3-test-window', `no interactive foreground desktop (aborted=${s.aborted}, steps=${JSON.stringify(s.steps?.slice(0, 3))})`);
      } else {
        receipt.expect('stage3', 'fable-stage3-test-window', stage3.code === 0 && !s.aborted && s.failed.length === 0 && s.pendingAtExit === 0,
          `passed=${s.passed}, failed=${JSON.stringify(s.failed)}, aborted=${s.aborted}, monitor=${JSON.stringify(s.monitor)}, pendingAtExit=${s.pendingAtExit}`);
      }
    }

    // 3. Bundle the isolated App target (using real unmodified ScreenService + screen-host-control).
    const bundleFile = path.join(workDir, 'target-bundle.cjs');
    await esbuild({
      entryPoints: [path.join(HERE, 'windows-screen-acceptance-target.mjs')],
      outfile: bundleFile,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node24',
      external: ['electron', '*.node'],
    });

    // 4. Start real HubServer + real Windows named pipe control socket.
    const hostDir = path.join(workDir, 'hub');
    const appState = path.join(workDir, 'app-state');
    const profileDir = path.join(workDir, 'electron-profile');
    await mkdir(hostDir, { recursive: true });
    await mkdir(appState, { recursive: true });

    const hub = await HubServer.start({ stateDir: hostDir });
    cleanups.push(() => hub.close());

    const owner = makeDevice('acc-local');
    const viewer = makeDevice('acc-viewer');
    await hub.enrollLocalController({ deviceId: owner.deviceId, name: owner.name, platform: owner.platform, publicKey: owner.publicKey });
    const { code } = await hub.auth.pair({ deviceId: viewer.deviceId, name: viewer.name, platform: viewer.platform, publicKey: viewer.publicKey }, '127.0.0.1');
    await hub.auth.approve(code, 'local-owner', 'owner');
    const local = await loginFor(hub.auth, owner);
    const remote = await loginFor(hub.auth, viewer);

    const cfgCommand = {
      operation: 'screen.configure',
      expectedRevision: 0,
      enabled: true,
      requestId: randomUUID(),
      grants: [{ deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission: 'control' }],
    };
    const statement = await hub.auth.prepareDeviceAction({ operation: 'screen-grant', target: hashSecret(screenConfigureText(cfgCommand)) }, local.token, local.session);
    await hub.remoteScreen.configure(local.session, cfgCommand, {
      nonce: statement.nonce,
      signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString('base64'),
    });

    const stopControl = await startHubControl(
      hostDir,
      () => ({ running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }),
      () => {},
      { screenServiceTicket: id => hub.remoteScreen.serviceTicket(id) },
    );
    cleanups.push(stopControl);

    // 5. Launch isolated Electron target with real native addon + real ScreenService + synthetic capture.
    const target = await spawnTarget(electronBin, bundleFile, { addon: addonPath, hostDir, appState, profile: profileDir });
    cleanups.push(() => target.close());
    await target.ready;

    const started = await target.call('start-service', {}, 35000);
    evidence.e2ePreflight = { preflight: started.preflight, serviceStatus: started.status };

    receipt.expect('service', 'native-addon-windows-platform', started.preflight.targetPlatform === 'windows' && started.preflight.monitorCount > 0,
      `targetPlatform=${started.preflight.targetPlatform}, monitorCount=${started.preflight.monitorCount}, displays=${started.preflight.displays.length}`);
    receipt.expect('service', 'named-pipe-and-hub-registration',
      started.registered && started.status.desktop?.platform === 'windows' && started.status.desktop?.loginSessionPrefix === 'wts-' && started.status.desktop?.displayCount > 0,
      `registered=${started.registered}, phase=${started.status.phase}, error=${started.status.error}, desktop=${JSON.stringify(started.status.desktop)}`);

    const api = (route, token, body) => fetch(hub.url + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    // 6. Legacy client gate (without ?includeWindows=1).
    const legacyStatusRes = await (await api('/api/screens/status', remote.token)).json();
    const currentStatusRes = screenStatusSchema.parse(await (await api('/api/screens/status?includeWindows=1', remote.token)).json());
    const display = currentStatusRes.desktop?.displays?.[0];
    const legacyOpenRes = display ? await api('/api/screens/sessions', remote.token, {
      desktopId: currentStatusRes.desktop.desktopId, displayId: display.id, displayRevision: display.revision,
      requestId: randomUUID(), codecs: ['h264'],
    }) : null;
    const legacyOpenBody = legacyOpenRes ? await legacyOpenRes.json() : null;
    receipt.expect('service', 'legacy-client-opt-in-gate',
      legacyStatusRes.desktop === null && currentStatusRes.desktop?.platform === 'windows' && legacyOpenRes?.status === 409 && legacyOpenBody?.error === 'screen_client_update_required',
      `legacyDesktop=${legacyStatusRes.desktop}, currentPlatform=${currentStatusRes.desktop?.platform}, legacyOpen=${legacyOpenRes?.status}:${legacyOpenBody?.error}`);

    // 7. Open session + synthetic capture frame delivery.
    const openedRes = await api('/api/screens/sessions?includeWindows=1', remote.token, {
      desktopId: currentStatusRes.desktop.desktopId,
      displayId: display.id,
      displayRevision: display.revision,
      requestId: randomUUID(),
      codecs: ['h264'],
    });
    const join = openedRes.status === 201 ? screenJoinSchema.parse(await openedRes.json()) : null;
    receipt.expect('synthetic-frame', 'open-session', openedRes.status === 201 && Boolean(join), `httpStatus=${openedRes.status}`);

    if (join) {
      const wsBase = hub.instanceUrl.replace('http:', 'ws:');
      const control = connectWs(`${wsBase}/screen/v1/control`, cleanups);
      const media = connectWs(`${wsBase}/screen/v1/media`, cleanups);
      await Promise.all([control.ready, media.ready]);
      control.send({ type: 'hello', ticket: join.controlTicket });
      media.send({ type: 'hello', ticket: join.mediaTicket });

      const capStart = await target.call('wait-capture-start', { count: 1 });
      const encodeSize = capStart.last?.encode ?? { width: 1024, height: 768 };
      const firstFrame = await target.call('emit-frame', { sessionId: join.session.id, generation: 1, size: encodeSize });
      const gotBinary = await wait(() => media.values.some(v => v instanceof Uint8Array && v.byteLength > 32), 6000);
      control.send({ type: 'ack', sessionId: join.session.id, generation: join.session.generation, frameSequence: firstFrame.sequence });
      const gotReady = await wait(() => control.values.some(v => v.type === 'frame-ready' && v.frameSequence === firstFrame.sequence), 6000);
      receipt.expect('synthetic-frame', 'synthetic-stream-and-frame-ready', capStart.ok && gotBinary && gotReady,
        `captureStarted=${capStart.ok}, encode=${JSON.stringify(encodeSize)}, binaryReceived=${gotBinary}, frameReady=${gotReady}`);

      // 8. Control lease + interactive input tests ONLY when interactive desktop & synthetic window foreground preflight PASS!
      const canInteract = started.preflight.interactive && started.preflight.windowInFront;
      if (!canInteract) {
        const why = `interactive=${started.preflight.interactive}, windowInFront=${started.preflight.windowInFront}, session=${JSON.stringify(started.preflight.session)}`;
        receipt.skip('e2e-input', 'control-lease-and-interactive-input', `skipping real input to avoid false pass: ${why}`);
        receipt.skip('e2e-input', 'foreground-loss-abort-and-release', `skipped due to non-interactive/non-foreground runner: ${why}`);
      } else {
        // Request control lease.
        control.send({ type: 'control', sessionId: join.session.id, generation: join.session.generation, frameSequence: firstFrame.sequence });
        const resetOk = await target.call('wait-capture-reset', { count: 1 });
        const nextGen = resetOk.last?.[1] ?? 2;
        const freshFrame = await target.call('emit-frame', { sessionId: join.session.id, generation: nextGen, size: encodeSize });
        control.send({ type: 'ack', sessionId: join.session.id, generation: join.session.generation, frameSequence: freshFrame.sequence });
        const leaseGranted = await wait(() => control.values.some(v => v.type === 'state' && v.lease && v.session.state === 'controlling'), 6000);
        const stateMsg = control.values.findLast(v => v.type === 'state' && v.lease);
        const wsState0 = await target.call('window-state');
        receipt.expect('e2e-input', 'control-lease-granted', leaseGranted && wsState0.activeMarkerExists,
          `leaseGranted=${leaseGranted}, activeMarker=${wsState0.activeMarkerExists}, inFront=${wsState0.inFront}`);

        let inputSeq = 0;
        let currentGen = nextGen;
        const freshReady = async () => {
          const emitted = await target.call('emit-frame', { sessionId: join.session.id, generation: currentGen, size: encodeSize });
          control.send({ type: 'ack', sessionId: join.session.id, generation: join.session.generation, frameSequence: emitted.sequence });
          await wait(() => control.values.some(v => v.type === 'frame-ready' && v.frameSequence === emitted.sequence), 4000);
          return control.values.findLast(v => v.type === 'frame-ready');
        };
        const sendInput = async (event, cachedReady) => {
          const ready = cachedReady ?? await freshReady();
          const st = await target.call('window-state');
          if (!st.inFront) throw new Error('aborted_window_lost_foreground');
          control.send({
            type: 'input',
            sessionId: join.session.id,
            desktopId: currentStatusRes.desktop.desktopId,
            generation: join.session.generation,
            displayId: display.id,
            displayRevision: display.revision,
            leaseId: stateMsg.lease.id,
            sequence: ++inputSeq,
            frameSequence: ready.frameSequence,
            expiresAt: ready.expiresAt,
            event,
          });
        };

        let expectedStarts = 1;
        let expectedResets = 1;
        if (leaseGranted) {
          // 8a. Pointer move inside synthetic test window (distinct pixel from Stage 3's 0.5, 0.25).
          const pMove = await target.call('window-point', { fx: 0.35, fy: 0.25, displayId: display.id });
          const fromMove = (await target.call('window-state')).seenCount;
          await sendInput({ kind: 'move', x: pMove.norm.x, y: pMove.norm.y });
          await sleep(320);
          const moveEvents = (await target.call('get-seen', { from: fromMove })).events.filter(e => e.type === 'mousemove');
          const afterMove = await target.call('window-state');
          const lastMove = moveEvents.at(-1);
          const moveOk = Boolean(lastMove) && Math.abs(lastMove.x - pMove.page.x) <= 2 && Math.abs(lastMove.y - pMove.page.y) <= 2
            && afterMove.cursor?.x === pMove.physical.x && afterMove.cursor?.y === pMove.physical.y
            && afterMove.activeMarkerExists;
          receipt.expect('e2e-input', 'pointer-move', moveOk,
            `askedPage=${JSON.stringify(pMove.page)}, saw=${JSON.stringify(lastMove ?? null)}, askedPhys=${JSON.stringify(pMove.physical)}, cursor=${JSON.stringify(afterMove.cursor)}, activeMarkerAfter320ms=${afterMove.activeMarkerExists}`);

          // Check whether #48 mouse hook self-takeover closed the session right after pointer-move.
          const mouseClosed = control.values.findLast(v => v.type === 'state' && (v.session?.state === 'closed' || v.session?.reason));
          const leaseAliveAfterMove = !mouseClosed || mouseClosed.session?.state === 'controlling';

          if (leaseAliveAfterMove) {
            // 8b. Primary click (share one fresh frame across down/up).
            const fromClick = (await target.call('window-state')).seenCount;
            const clickReady = await freshReady();
            await sendInput({ kind: 'button', x: pMove.norm.x, y: pMove.norm.y, button: 0, down: true, clicks: 1 }, clickReady);
            await sleep(40);
            await sendInput({ kind: 'button', x: pMove.norm.x, y: pMove.norm.y, button: 0, down: false, clicks: 1 }, clickReady);
            await sleep(220);
            const clickEvents = (await target.call('get-seen', { from: fromClick })).events.filter(e => ['mousedown', 'mouseup', 'click'].includes(e.type));
            receipt.expect('e2e-input', 'primary-click',
              clickEvents.map(e => e.type).join(',') === 'mousedown,mouseup,click',
              `events=${JSON.stringify(clickEvents.map(e => ({ type: e.type, button: e.button, x: e.x, y: e.y })))}`);

            // 8c. Double-click (share one fresh frame so both presses land well inside Windows double-click window).
            await sleep(700);
            const fromDbl = (await target.call('window-state')).seenCount;
            const dblReady = await freshReady();
            for (let press = 1; press <= 2; press++) {
              await sendInput({ kind: 'button', x: pMove.norm.x, y: pMove.norm.y, button: 0, down: true, clicks: press }, dblReady);
              await sleep(30);
              await sendInput({ kind: 'button', x: pMove.norm.x, y: pMove.norm.y, button: 0, down: false, clicks: press }, dblReady);
              if (press === 1) await sleep(60);
            }
            await sleep(250);
            const dblEvents = (await target.call('get-seen', { from: fromDbl })).events.filter(e => ['click', 'dblclick'].includes(e.type));
            receipt.expect('e2e-input', 'double-click',
              dblEvents.filter(e => e.type === 'dblclick').length === 1,
              `events=${JSON.stringify(dblEvents.map(e => ({ type: e.type, detail: e.detail })))}`);
          } else {
            const closeWhy = mouseClosed?.session?.reason ?? mouseClosed?.reason ?? 'closed';
            receipt.expect('e2e-input', 'primary-click', false, `blocked: session ended right after pointer-move with reason=${closeWhy}`);
            receipt.expect('e2e-input', 'double-click', false, `blocked: session ended right after pointer-move with reason=${closeWhy}`);
          }

          // Record redacted control channel transitions for Session 1.
          evidence.e2eControlEvents = control.values
            .filter(v => v && typeof v === 'object' && v.type !== 'frame-ready')
            .map(v => ({
              type: v.type,
              reason: v.session?.reason ?? v.reason ?? v.error ?? null,
              state: v.session?.state ?? null,
              hasLease: Boolean(v.lease),
            }));
          receipt.info('e2e-input', 'control-channel-transitions', JSON.stringify(evidence.e2eControlEvents));

          // Helper to open a clean controlled session.
          const openControlledSession = async () => {
            const openedN = await api('/api/screens/sessions?includeWindows=1', remote.token, {
              desktopId: currentStatusRes.desktop.desktopId,
              displayId: display.id,
              displayRevision: display.revision,
              requestId: randomUUID(),
              codecs: ['h264'],
            });
            const j = openedN.status === 201 ? screenJoinSchema.parse(await openedN.json()) : null;
            if (!j) return null;
            const c = connectWs(`${wsBase}/screen/v1/control`, cleanups);
            const m = connectWs(`${wsBase}/screen/v1/media`, cleanups);
            await Promise.all([c.ready, m.ready]);
            c.send({ type: 'hello', ticket: j.controlTicket });
            m.send({ type: 'hello', ticket: j.mediaTicket });
            await target.call('wait-capture-start', { count: ++expectedStarts });
            const f1 = await target.call('emit-frame', { sessionId: j.session.id, generation: 1, size: encodeSize });
            await wait(() => m.values.some(v => v instanceof Uint8Array && v.byteLength > 32), 6000);
            c.send({ type: 'ack', sessionId: j.session.id, generation: j.session.generation, frameSequence: f1.sequence });
            await wait(() => c.values.some(v => v.type === 'frame-ready' && v.frameSequence === f1.sequence), 6000);
            c.send({ type: 'control', sessionId: j.session.id, generation: j.session.generation, frameSequence: f1.sequence });
            const r = await target.call('wait-capture-reset', { count: ++expectedResets });
            const gen = r.last?.[1] ?? 2;
            const f2 = await target.call('emit-frame', { sessionId: j.session.id, generation: gen, size: encodeSize });
            c.send({ type: 'ack', sessionId: j.session.id, generation: j.session.generation, frameSequence: f2.sequence });
            const ok = await wait(() => c.values.some(v => v.type === 'state' && v.lease && v.session.state === 'controlling'), 6000);
            const leaseState = c.values.findLast(v => v.type === 'state' && v.lease);
            let seq = 0;
            const sendOn = async (event, cachedReady) => {
              let ready = cachedReady;
              if (!ready) {
                const emitted = await target.call('emit-frame', { sessionId: j.session.id, generation: gen, size: encodeSize });
                c.send({ type: 'ack', sessionId: j.session.id, generation: j.session.generation, frameSequence: emitted.sequence });
                await wait(() => c.values.some(v => v.type === 'frame-ready' && v.frameSequence === emitted.sequence), 4000);
                ready = c.values.findLast(v => v.type === 'frame-ready');
              }
              const st = await target.call('window-state');
              if (!st.inFront) throw new Error('aborted_window_lost_foreground');
              c.send({
                type: 'input',
                sessionId: j.session.id,
                desktopId: currentStatusRes.desktop.desktopId,
                generation: j.session.generation,
                displayId: display.id,
                displayRevision: display.revision,
                leaseId: leaseState.lease.id,
                sequence: ++seq,
                frameSequence: ready.frameSequence,
                expiresAt: ready.expiresAt,
                event,
              });
              return ready;
            };
            return { join: j, control: c, media: m, lease: leaseState, gen, ok, sendOn };
          };

          // 8d-8e. Focus textarea (real remote mouse click when lease alive), Unicode + Enter text,
          // NumLock toggle via real protocol, held key journal, and foreground-loss abort + release.
          let kbJoin = join, kbControl = control, kbLease = stateMsg;
          let sendKbInput = sendInput;
          if (!leaseAliveAfterMove) {
            const s2 = await openControlledSession();
            if (s2?.ok) {
              kbJoin = s2.join; kbControl = s2.control; kbLease = s2.lease; sendKbInput = s2.sendOn;
            } else {
              kbJoin = null; kbLease = null;
            }
          }

          if (kbJoin && kbLease?.lease) {
            if (leaseAliveAfterMove) {
              const pBox = await target.call('window-point', { fx: 0.5, fy: 0.7, displayId: display.id });
              const boxReady = await freshReady();
              await sendKbInput({ kind: 'button', x: pBox.norm.x, y: pBox.norm.y, button: 0, down: true, clicks: 1 }, boxReady);
              await sleep(40);
              await sendKbInput({ kind: 'button', x: pBox.norm.x, y: pBox.norm.y, button: 0, down: false, clicks: 1 }, boxReady);
              await sleep(200);
              await target.call('clear-textarea');
            } else {
              await target.call('focus-textarea');
            }
            const expectedText = 'hello 中文😀\nline2';
            await sendKbInput({ kind: 'text', text: expectedText });
            await sleep(320);
            const afterText = await target.call('window-state');
            receipt.expect('e2e-input', 'unicode-and-enter-text',
              afterText.activeElement === 'text' && afterText.textareaValue === expectedText,
              `activeElement=${afterText.activeElement}, expectedLen=${expectedText.length}, gotMatch=${afterText.textareaValue === expectedText}`);

            // 8d-2. Verify NumLock through real protocol (2cfba74: plain 0x45 toggles NumLock).
            const fromNum = (await target.call('window-state')).seenCount;
            const numReady = leaseAliveAfterMove ? await freshReady() : undefined;
            for (let t = 0; t < 2; t++) {
              await sendKbInput({ kind: 'key', code: 'NumLock', down: true }, numReady);
              await sleep(35);
              await sendKbInput({ kind: 'key', code: 'NumLock', down: false }, numReady);
              await sleep(85);
            }
            const numEvents = (await target.call('get-seen', { from: fromNum })).events.filter(e => e.type === 'keydown' || e.type === 'keyup');
            const numKeydowns = numEvents.filter(e => e.type === 'keydown');
            const numToggled = numKeydowns.length === 2 && numKeydowns[0].numLock !== numKeydowns[1].numLock && numKeydowns.every(e => e.key === 'NumLock');
            receipt.expect('e2e-input', 'numlock-toggle-via-protocol', numToggled,
              `keydowns=${JSON.stringify(numKeydowns.map(e => ({ code: e.code, key: e.key, numLock: e.numLock })))}`);

            // 8e. Hold ShiftLeft -> verify held journal + pending -> trigger foreground loss -> abort further input & release!
            const fromHold = (await target.call('window-state')).seenCount;
            await sendKbInput({ kind: 'key', code: 'ShiftLeft', down: true });
            await sleep(120);
            const whileHeld = await target.call('window-state');
            const heldRecorded = whileHeld.pending === 1 && whileHeld.heldJournal.state === 'valid' && whileHeld.heldJournal.keys.includes(0x2a);
            receipt.expect('e2e-input', 'held-key-recorded-before-loss', heldRecorded,
              `pending=${whileHeld.pending}, journal=${JSON.stringify(whileHeld.heldJournal)}`);

            const loss = await target.call('trigger-foreground-loss');
            let abortedNextInput = false;
            try {
              await sendKbInput({ kind: 'key', code: 'KeyA', down: true });
            } catch (err) {
              abortedNextInput = String(err?.message).includes('aborted_window_lost_foreground');
            }
            // Release control lease immediately on foreground loss.
            kbControl.send({ type: 'release', sessionId: kbJoin.session.id, generation: kbJoin.session.generation });
            const releasedClean = await wait(async () => {
              const st = await target.call('window-state');
              return st.pending === 0 && !st.activeMarkerExists && st.heldJournal.state === 'missing';
            }, 5000);
            const afterRelease = await target.call('window-state');
            const holdKeyEvents = (await target.call('get-seen', { from: fromHold })).events.filter(e => e.type === 'keydown' || e.type === 'keyup');
            const noKeyAAfterLoss = !holdKeyEvents.some(e => e.code === 'KeyA');
            receipt.expect('e2e-input', 'foreground-loss-abort-and-release',
              !loss.inFront && loss.lostFocus && abortedNextInput && noKeyAAfterLoss && releasedClean && afterRelease.pending === 0 && !afterRelease.activeMarkerExists && afterRelease.heldJournal.state === 'missing',
              `loss=${JSON.stringify(loss)}, abortedNextInput=${abortedNextInput}, noKeyA=${noKeyAAfterLoss}, pendingAfter=${afterRelease.pending}, activeMarker=${afterRelease.activeMarkerExists}, journal=${afterRelease.heldJournal.state}, keyEvents=${holdKeyEvents.map(e => `${e.type}:${e.code}`).join(',')}`);

            kbControl.send({ type: 'disconnect', sessionId: kbJoin.session.id, generation: kbJoin.session.generation });
            await sleep(150);
          } else {
            receipt.expect('e2e-input', 'unicode-and-enter-text', false, 'failed to open keyboard E2E session');
            receipt.expect('e2e-input', 'numlock-toggle-via-protocol', false, 'failed to open keyboard E2E session');
            receipt.expect('e2e-input', 'held-key-recorded-before-loss', false, 'failed to open keyboard E2E session');
            receipt.expect('e2e-input', 'foreground-loss-abort-and-release', false, 'failed to open keyboard E2E session');
          }

          // 8f. Positive takeover test: restore focus to our synthetic test window, open fresh controlled session,
          // verify own mouse + held key stay alive, then inject ONE foreign untagged mouse event strictly inside
          // our synthetic window -> verify immediate `screen_local_takeover`, session close, marker removal, and held-key release!
          await target.call('close-focus-window');
          const takeoverSession = await openControlledSession();
          if (takeoverSession?.ok) {
            const pOwn = await target.call('window-point', { fx: 0.4, fy: 0.3, displayId: display.id });
            await takeoverSession.sendOn({ kind: 'move', x: pOwn.norm.x, y: pOwn.norm.y });
            await takeoverSession.sendOn({ kind: 'key', code: 'ShiftLeft', down: true });
            await sleep(350);
            const beforeForeign = await target.call('window-state');
            const aliveBefore = beforeForeign.activeMarkerExists && beforeForeign.pending === 1 && beforeForeign.heldJournal.state === 'valid';

            // Foreign untagged SendInput (dwExtraInfo = 0) shifted +2px strictly inside our synthetic test window.
            // Keep synthetic frames fresh while powershell.exe compiles Add-Type so the lease cannot expire from frame staleness.
            const fx = pOwn.physical.x + 2;
            const fy = pOwn.physical.y;
            const absDx = Math.floor((2 * (fx - pOwn.rect.x) + 1) * 32768 / pOwn.rect.width);
            const absDy = Math.floor((2 * (fy - pOwn.rect.y) + 1) * 32768 / pOwn.rect.height);
            let keepAlive = true;
            const pulse = (async () => {
              while (keepAlive) {
                try {
                  const f = await target.call('emit-frame', { sessionId: takeoverSession.join.session.id, generation: takeoverSession.gen, size: encodeSize });
                  if (takeoverSession.control.ws.readyState === WebSocket.OPEN) {
                    takeoverSession.control.send({ type: 'ack', sessionId: takeoverSession.join.session.id, generation: takeoverSession.join.session.generation, frameSequence: f.sequence });
                  }
                } catch { break; }
                await sleep(500);
              }
            })();
            let foreignSend;
            try {
              foreignSend = await injectForeignMouseInsideWindow(workDir, absDx, absDy);
            } finally {
              keepAlive = false;
              await pulse.catch(() => {});
            }

            const gotTakeoverClose = await wait(() => takeoverSession.control.values.some(
              v => v.type === 'state' && v.session?.state === 'closed' && v.session?.reason === 'screen_local_takeover',
            ), 2500);
            const cleanedAfterForeign = await wait(async () => {
              const st = await target.call('window-state');
              return st.pending === 0 && !st.activeMarkerExists && st.heldJournal.state === 'missing';
            }, 2500);
            const afterForeign = await target.call('window-state');
            const takeoverTransitions = takeoverSession.control.values
              .filter(v => v && typeof v === 'object' && v.type !== 'frame-ready')
              .map(v => ({ type: v.type, state: v.session?.state ?? null, reason: v.session?.reason ?? v.reason ?? null, hasLease: Boolean(v.lease) }));
            receipt.expect('e2e-input', 'foreign-input-immediate-takeover',
              aliveBefore && foreignSend.sent === 1 && gotTakeoverClose && cleanedAfterForeign,
              `aliveBefore=${aliveBefore} (pending=${beforeForeign.pending}, marker=${beforeForeign.activeMarkerExists}), foreignSend=${JSON.stringify(foreignSend)}, gotTakeoverClose=${gotTakeoverClose}, afterForeign={pending:${afterForeign.pending},marker:${afterForeign.activeMarkerExists},journal:${afterForeign.heldJournal.state}}, transitions=${JSON.stringify(takeoverTransitions.slice(-4))}`);
          } else {
            receipt.expect('e2e-input', 'foreign-input-immediate-takeover', false, 'failed to open fresh controlled session for foreign-input takeover test');
          }

          // 9. Record-only non-gating observations from Fable's Section 5 checklist + Win32 hook wire probe.
          const obs = await target.call('run-observations', {}, 30000);
          evidence.observations = obs;
          receipt.info('observations', 'fable-section5-checklist', JSON.stringify(obs));

          const wireProbe = await runHookWireProbe(workDir, () => target.call('probe-addon-inputs'));
          evidence.hookWireProbe = wireProbe;
          receipt.info('observations', 'win32-hook-wire-probe', JSON.stringify(wireProbe));
        }
      }
    }
  } catch (error) {
    receipt.expect('harness', 'unexpected-error', false, String(error?.message ?? error).slice(0, 400));
  } finally {
    for (const fn of cleanups.reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    const reportJson = path.join(reportDir, 'windows-screen-acceptance.json');
    const reportMd = path.join(reportDir, 'windows-screen-acceptance.md');
    await writeFile(reportJson, JSON.stringify({ outcome: receipt.outcome, checks: receipt.checks, evidence }, null, 2));
    await writeFile(reportMd, receipt.markdown(meta));
    process.stdout.write(receipt.markdown(meta));
  }
  if (receipt.outcome === 'fail') process.exitCode = 1;
}

main().catch(error => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});

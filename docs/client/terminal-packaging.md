# Host Terminal Packaging & Security Notes (#100)

## Runtime PTY Architecture

`HubHostTerminal` (`src/hub/host-terminal.ts`) resolves shell backends in order:

1. **`node-pty` (preferred for release packages)**: dynamically loaded when bundled with the Host runtime, providing full ConPTY support on Windows and native PTY support on macOS (`arm64` / `x64`) and Linux.
2. **POSIX `script` PTY fallback (macOS)**: allocates a real PTY via `/usr/bin/script -q /dev/null <shell> -i` when `node-pty` is absent (e.g. source builds).
3. **Standard pipe shell fallback (Linux / Windows)**: spawns the configured shell (`$SHELL`, `powershell.exe`, or `ComSpec`) with `windowsHide: true` and clean process-tree teardown via `killProcessTree`.

## Packaging `node-pty` for macOS & Windows Releases

When bundling `node-pty` into packaged Desktop / Host builds:

- **macOS (`arm64` & `x64`)**:
  - Ship architecture-matched `pty.node` and `spawn-helper` binaries inside the unpacked app resources (`asarUnpack`).
  - Ensure `spawn-helper` retains executable permissions (`0755`) and is codesigned with the Hardened Runtime entitlement before notarizing the `.dmg` / `.app`.
- **Windows (`x64` / `arm64`)**:
  - Ship the ConPTY native binaries (`conpty.node`, `conpty_console_list.node`, and `OpenConsole.exe` when applicable) unpacked from `app.asar`, signed with the Authenticode certificate alongside the desktop binary.

## Security & Audit Model

- **Off by default**: `terminal-policy:v1` defaults to `{ revision: 0, enabled: false, grants: [] }`.
- **Per-device opt-in**: enabled per device (`deviceId` + `publicKey`) via owner-signed `device_action` proof (`tarobot/terminal-policy/v1`, Control level).
- **Hidden when unauthorized**: devices without a matching grant do not see the Terminal panel button and receive `403 terminal_not_authorized` from all `/api/terminals/*` routes.
- **Desktop only**: the terminal panel is hidden on mobile viewports.
- **Audit trail**: every `terminal.policy`, `terminal.opened`, and `terminal.closed` event is persisted in the Host's `audit_log`.

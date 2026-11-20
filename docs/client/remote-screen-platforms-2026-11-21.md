# Remote screen targets

This source change addresses the implementation gap behind #48 (Windows target).
It does not publish a release or establish installed-device acceptance.

## Windows target

The Electron target service uses the Windows native addon for monitor geometry,
session readiness, input and local takeover. Capture retains the existing
Electron media pipeline. Native input runs at the App's own integrity level;
there is no elevation, desktop switching or remote operation of consent screens.
An unknown, locked or non-interactive desktop refuses control. A local lock or
desktop change stops capture; unlocking does not restore a previous session.

Windows coordinates are physical monitor pixels, verified against the native
monitor enumeration. A display whose Electron and native geometry cannot be
matched is unavailable rather than guessed. Key events represent physical
positions; characters follow the target's keyboard layout. Platform-specific
shortcut buttons avoid assuming letter positions on another layout. Committed
text uses explicit text input, not clipboard synchronization.

The target requires the Host's `screen-windows-v1` capability. App and CLI status
and open requests opt in with `includeWindows=1`. Legacy requests receive no
Windows desktop, and cannot open a Windows control session. Mac descriptions
and signed device-grant policy bodies retain their prior contract. A missing
native addon, an older Host and a missing device grant are separate conditions.

## Maintenance and validation

- Windows logic and integration: `screen_windows.rs`, Electron
  `screen-windows.test.mjs`, root `screen-service-hub-windows.test.ts` and
  `remote-screen-keys-windows.test.ts`; browser `remote-screen-windows` and
  `screen-settings`.

Native Windows input/capture on an interactive desktop, mixed-DPI monitors and
sustained real-network performance remain separate acceptance work. Do not
describe cross-compilation or a read-only addon load as those checks. CLI
status uses the same Host routes with `includeWindows=1`.

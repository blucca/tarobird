# Remote screen targets and mobile viewers

This source change addresses the implementation gaps behind #48 and #49. It
does not publish a release or establish installed-device acceptance.

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

## iOS and Android viewers

Ordinary conversations offer View screen through their existing actions menu;
connection settings also expose the selected Host's viewer. Mobile ADHD panes
do not gain screen buttons. The viewer fills the available mobile window and
keeps the Host identity, connection status and stop/close actions visible.

Viewing alone does not request control. After an explicit control action, tap,
hold, drag and two-finger movement map to click, secondary click, drag and scroll.
Repeated taps at one position use the desktop mouse path's interval and
distance limits, so they arrive as double and triple clicks.
Pinching changes the local picture scale. The keyboard panel sends committed
text only when the user presses Send; composing an IME draft does not send it. While a keyboard candidate is pending,
Send is disabled and an inline hint explains how to confirm the candidate.
Leaving the viewer, backgrounding, locking or retiring its document ends the
session. Returning foreground requires an explicit new connection and control
request. This is deliberate: recovery never replays queued input.

Mobile starts with the smooth quality profile when the Host and target support
quality negotiation. A legacy target uses the existing default-quality path.
Quality remains an explicit selection; this change does not claim automatic
bandwidth adaptation. A quality change retires the previous session and lease.

Both platforms use their native pinned transport, not WebView WebSockets. A
screen allocation shares the page's existing document lease and owns exactly
two fixed viewer endpoints. It cannot claim a replacement document or retire
ordinary chat. Native scene/activity gates close admission before asynchronous
teardown, including calls queued before a background/foreground transition.
Focus generations discard old queued input even after the page gains focus again.

The native bridge bounds outstanding JSON, binary delivery and queued commands.
Binary reads are sequential and at most 256 KiB; a delivery acknowledgment
requires a complete read. Native consumption acknowledgment is distinct from
the Host's decoded-frame readiness acknowledgment. Target leases and fresh-frame
checks remain authoritative. A dedicated iOS screen URLSession avoids inheriting
the ordinary request's absolute resource duration, and is cancelled when the
screen group closes; other groups and chat retain their own lifetime.

A Host close frame with code 4000 and a bounded `screen_[a-z_]` reason remains
the session's terminal reason on both platforms, as do the exact sign-in codes
`session_expired`, `device_revoked` and `device_revoked_or_expired` (a screen
session ends with its sign-in, within 15 minutes); any other close reports a
generic network closure. Every terminal reason the Host, a native session or
the viewer can end a connection with has its own explanation;
`tests/client-screen-errors.test.ts` scans those sources to keep it so.
The iOS attach deadline starts when both sockets resume, after route
preparation, so a slow identity check does not consume it.

## Maintenance and validation

- Windows logic and integration: `screen_windows.rs`, Electron
  `screen-windows.test.mjs`, root `screen-service-hub-windows.test.ts` and
  `remote-screen-keys-windows.test.ts`.
- Shared viewer and mobile UI: existing desktop screen tests plus
  `screen-mobile`, `screen-mobile-transport` and `screen-touch` browser specs.
- Native loopback: `node client/scripts/ios-screen-audit.mjs <private-output>`
  on Apple Foundation; `node client/scripts/android-transport-audit.mjs
  <private-output>` on a JVM. Both use synthetic TLS peers. The client workflow's
  native jobs run these checks in addition to platform compilation.
- Native mobile checks have separately exercised real WKWebView/Capacitor and
  Android WebView decoding, document retirement and background handling in
  isolated simulator/emulator Apps. Browser fixtures and native-plugin fixtures
  are different evidence; neither alone proves the complete installed product.

Native Windows input/capture on an interactive desktop, physical-phone viewing
of a real desktop, mixed-DPI monitors and sustained real-network performance
remain separate acceptance work. Do not describe cross-compilation or synthetic
frames as those checks. CLI policy/status/open operations use the same Host
routes; a phone's touch UI does not create a second Host implementation.

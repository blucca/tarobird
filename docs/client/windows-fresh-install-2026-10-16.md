# Windows reinstall and native startup recovery

## User-facing behavior

Windows 1.0.75 offers **全新开始 / Start fresh** when an interactive installer
finds data left behind by an uninstalled copy. Yes backs up this Windows account's
TaroBot configuration, local host data and WebView profile, then starts from
first-time setup. No retains the old state; Cancel stops installation.

An existing installation is recorded **before** the upgrade UI invokes its old
uninstaller. Normal upgrades, `/UPDATE`, silent and passive installations never
offer or perform this reset. The existing uninstaller's optional “删除应用程序数据”
checkbox uses the same guarded backup helper instead of recursively deleting data.

Backups are sibling `TaroBot-backup-<unique ID>` directories in the current user's
Roaming/Local Known Folders. They are not automatically imported into the new
installation. This is an application fresh start, not secure erasure: the backups
remain private local data and orphaned Windows credential entries are retained.
New setup creates a new device identity and requires pairing again. Existing
authorization records on remote hosts are not revoked by a local reset.

Mac mini, other network members, and custom CLI state directories are not touched.
An installed CLI service, an active host process or an unreadable owner record
blocks resetting shared data. Close the App and stop/uninstall the owning CLI
service first; do not start another CLI while installing. Ordinary App upgrades
continue to preserve independently installed CLI services.

### Setup notes (`%LOCALAPPDATA%\TaroBird Setup Notes`)

Dialogs and the Details list disappear when setup closes, and `/S` shows
neither. So the installer and the uninstaller also keep a short local record:

- **Where:** `%LOCALAPPDATA%\TaroBird Setup Notes\setup-notes.txt`, plus at most
  one older `setup-notes.previous.txt` in the same folder. It is in this
  Windows user's Local AppData (not roamed), outside the install folder and
  outside the data folders that a reset backs up. Nothing uploads it.
- **What:** one line for each stop that setup diagnoses with a `TB-` code (each
  Retry adds another line) and one line for each finished install, update or
  uninstall. A line holds only the local time, the operation, the stage, the
  `TB-` code, the backup and notification state and `TaroBird <version>`, all
  as fixed localized text. It never holds a path, account or computer name,
  process name, registry value, helper output or log. A cancelled run, a
  declined consent prompt or an NSIS error without a `TB-` code adds nothing,
  so the last line can be an older run.
- **How large:** at most 20 lines per file. When the current file is full, the
  previous file is deleted and the current one becomes the previous one, so
  there are never more than 40 lines in all (UTF-16LE text, a few hundred
  characters per line).
- **Never in the way:** one writer at a time; a writer that cannot get its
  turn within 2 seconds skips its line. Setup never writes through a link or
  junction, and any failure only skips the line: it never prompts, aborts or
  changes what setup does. A dialog points to the folder only when its line
  was written. In English it says:
  "This step is also saved in this Windows user's local folder and is not uploaded. To see it and earlier steps after setup closes, press Win+R, enter %LOCALAPPDATA% and open the TaroBird Setup Notes folder."
  In Chinese:
  "此步骤也已保存在本机当前 Windows 用户的本地目录中，不会上传。安装程序关闭后如需查看本次及之前的步骤，请按 Win+R 输入 %LOCALAPPDATA%，再打开其中的 TaroBird Setup Notes 文件夹。"
- **After uninstall:** the folder stays, both when data is kept and after
  "back up and reset local data"; a successful uninstall writes its own
  "finished" line, so it can create the folder. The next installer's fresh
  start offer ignores it.
- **Removing it:** you can delete the folder or its files at any time. Nothing
  else reads them, and setup creates the folder again the next time it writes
  a line.

## Implementation and review

- `fresh_install.rs` runs before WebView/single-instance initialization and is
  independent of the bundled Node/module graph. It accepts no path arguments and
  resolves the same OS Known Folders as Tauri. It refuses redirected application
  roots, checks both roots before moving either, and retains both originals if a
  second move fails and rollback is possible. It never overwrites newly created
  data during rollback. An incomplete rollback aborts with a distinct message.
- `installer-hooks.nsh` records installation ownership at GUI initialization,
  asks for an explicit fresh-start choice, invokes the new executable from the
  installer staging directory, and stops installation on recovery errors.
- If the old Node stop command fails, the new App can still uninstall when native
  checks independently establish that no host/service owns the state. It never
  kills a process based solely on a PID file.
  The new installer's staged helper can also verify shutdown when the installed
  old executable lacks this fallback. A recorded Windows process creation time
  is checked to distinguish a reused PID from the original owner.
- The local-controller cache open is now within its recovery boundary. A known
  local cache failure leaves that host pending while independently paired remote
  hosts can connect. An unknown local identity remains a fatal startup failure.
- Native Windows/Android shells no longer register the browser PWA worker.
  Windows also removes an existing TaroBot root worker at document start, without
  deleting IndexedDB, credentials or drafts. Retry and reload are bounded; a page
  cache cleanup failure does not block the new renderer. Browser PWAs keep their
  offline worker. The Windows title includes the actual App version.
- Startup diagnostics classify additional control-pipe, schema, runtime and ESM
  errors without sending raw stderr or private paths to the WebView.

Opus 5.5 xhigh independently reviewed the previous startup candidate and the
native cache patch. Its confirmed cache-open and diagnostic gaps were addressed;
its reload watchdog and best-effort cache cleanup recommendations were included.
Its separate reinstall review identified the old-executable upgrade trap, process
identity reuse, installer working-directory restoration and misleading deletion
wording. The new native shutdown probe, FILETIME comparison, explicit SetOutPath,
backup confirmation and registry cleanup address these points.
The exact reported 1.0.74 `resume/status` exit-1 cause is **not established**.
An old service worker cannot explain the user's new versioned diagnostics by
itself, and a fresh install is not evidence that the original root cause is fixed.

An older uninstaller cannot be changed retrospectively. If 1.0.74's own uninstall
fails because its stop command fails, run the new installer using its keep/overlay
option first; the new preinstall check can verify an already stopped host. Then
use the new uninstaller. Existing old uninstallers also retain their old optional
recursive-delete behavior, so do not use their data-delete checkbox on a shared
CLI host.

## Verification boundary

The native backup/rollback tests use isolated temporary directories. Chromium
tests exercise worker recovery, user-data preservation, CSP, timeout/retry,
production worker registration and local/remote cache isolation. Windows code is
cross-compiled against the actual Windows target and the generated NSIS installer
is compiled. The final extracted executable's version and compressed frontend
assets are checked, separately from its bundled Hub web UI.

Verified for this candidate: the full standalone gate passed (3,942 tests, one
skipped); ten isolated native recovery tests and the native error-classifier test
passed; 37 focused browser tests passed, plus eight cache tests after adding CSP,
browser-registration and failed-cleanup coverage. The recovery module is included
under `cfg(test)` on non-Windows too; OS process-query behavior still requires
Windows. Windows x64/MSVC compilation and NSIS packaging passed.

These checks do **not** exercise a real Windows installer, WebView2 or Task
Scheduler. Native acceptance still needs uninstall/reinstall with retained data,
the fresh-start and keep choices, an ordinary upgrade, a running/installed CLI,
and a successful new pairing on the affected Windows computer.

An unrelated existing startup byte-budget regression was reproduced on the exact
released 1.0.74 frontend: 805,181 bytes against a 700,000-byte budget. The budget
was not relaxed and is not included in the passing focused startup tests.

## Release scope

App candidate: **1.0.75**. Bundled host/CLI stays **0.1.425**, protocol v1,
schema 15. Host APIs, engine adapters and the standalone CLI implementation are
unchanged. CLI parity is not a new command: this is a Windows installer recovery
operation, with explicit protection for shared headless-host ownership. No mobile
or macOS installer is republished for this Windows-only candidate. It remains a
prerelease without an automatic update feed until real Windows acceptance.

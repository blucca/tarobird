# TaroBird 1.6.0 preflight

This release starts from published 1.5.1 source
`352a6c8ae25080580cbf758c721da76f662492b8`. Main has moved 300 commits since
then. It is a MINOR release under the [version policy](../versioning.md): new
functionality that existing installations upgrade into without a manual step.

## Owner instruction and explicit scope

Owner, 2026-11-23, current App conversation:

> 额度不够了这次直接发版。mac， ios的appstore, 安卓，windows, 以及playstore(目前封闭测试中)，还有 ios testflight, 就是和上次发版一样。然后发版说明也是英文，所有端放一个页面。

This is a direct stable release for this version only. The standing
owner trial → RC → stable path in the [release checklist](../release-checklist.md#candidate-and-stable-publication)
is not changed by it and applies again to the next release. The owner has run
main builds of this cycle daily on their own Mac, Windows PC and phones; the
last Mac build they ran is `f93fba5`, which is not the frozen commit. No
package built from the frozen commit was used by the owner before publication.

Platforms, as for 1.5.1: macOS (Apple silicon) and Windows (x64) desktop with
their updater channels, Android GitHub APK, Google Play bundle for the closed
test track, iOS through App Store Connect (TestFlight and App Store), and the
standalone Host / CLI archive. One English download page; the three platform
compatibility releases stay as the installed updaters' discovery path.

All newly built App and CLI artifacts use version **1.6.0** and one frozen
source commit. Android GitHub APK and Play AAB both reserve code
**2026110416**, one above the 1.5.1 code. The Play Console was not read for
this preflight: the highest accepted bundle there is assumed to be the 1.5.1
bundle `2026110415`, and whoever uploads must confirm that before uploading.
iOS uses build **1**.

## Integrations, dependencies and advisories

Checked on 2026-11-23 against the npm registry:

| Integrated product | Bundled | Latest stable | Result |
| --- | --- | --- | --- |
| Excalidraw (`@excalidraw/excalidraw`) | 0.18.1 | 0.18.1 | unchanged |
| Vditor (`vditor`) | 4.0.1 | 4.0.1 (4.0.2 is alpha only) | unchanged |

Baoyu Design/PPT pins are kept, as the checklist allows. No dependency was
changed for this release.

Security advisories, check only: `npm audit --omit=dev` on the same day reports
no advisory for the 104 production packages of the Host and none for the 485
of the client. Cargo, Gradle and iOS package dependencies were not checked
against an advisory source; that is not a "no advisory" result.

Electron stays at **45.3.0**. Upstream is at 45.4.1: 45.3.1 stops trusting
certificates from one authority's revoked intermediates, and 45.3.2 and 45.4.1
carry fixes backported from Chromium, V8 and related libraries (their notes
name no CVE). The 1.5.1 preflight deferred this to the next cycle. Asked again
on 2026-11-23, the owner chose "这次仍保持 45.3.0", with the upgrade to follow
as its own small release. This is a second explicit deferral, not a claim that
the bundled browser runtime has no outstanding risk.

## What changed since 1.5.1

Host schema moves from 25 to 26. A desktop-managed Host migrates its database
when the new App (or `tarobot start`) starts it; a Host installed as a
background service is upgraded with `tarobot update stage` and `apply`. The
owner's Mac and Windows Hosts went through this migration on main builds
during the cycle. New in this cycle, among others: the Pi engine and the
Antigravity ACP runtime, native conversation fork and rewind, remote screen
viewing on phones and Windows with a shared relay line, model quota and
context indicators, the conversation workspace rail, Bot-to-Bot message
delivery and steering between computers, Kimi task panel, and the share inbox
fix for one unreadable record.

Widgets stay offline, as in 1.5.1. Main allowed https/wss in widgets from
2026-11-21; on 2026-11-23, after the first freeze (`344f0d9`), the owner
withdrew it ("感觉还是卡片不要联网了，和以前一样", then "恢复，然后继续发版吧",
written as "回复"). The restored policy and what is enforced are in
[security boundaries](../security-boundaries.md#widget-network-access-2026-11-21).
This moved the frozen commit; the owner asked for the related tests only, not
another full run, so the validation figures below are from before this change
plus the widget unit, Electron and browser specs after it.

Android Play Console follow-ups carried from 1.5.0 (edge-to-edge and
deprecated system-bar calls): the source state recorded in the checklist on
2026-11-18 is unchanged, and the Console's reading for a new bundle is not yet
known. The R8 / DEX item was removed by the owner on 2026-11-22.

## Validation state at freeze

On main `14ed33b`, 2026-11-22/23, this Mac: unit suite 10920 passed, 24
skipped, 1 timing case that passes alone. Browser suite, 3350 tests: 3186
passed and 66 skipped; of the 98 that failed, 30 pass when run alone, 49 also
fail on the 1.5.1 tag on this Mac (not investigated one by one; `inline-audio`
is 9 of them), and 19 passed on 1.5.1. Of those 19: 15 were specs that had
fallen behind the App and are corrected in `1a5c060`; 3 specs (4 tests) pass
three times out of three on both versions when the machine is quiet; and
`message-clear` fails intermittently on both versions (2 of 17 runs on 1.5.1, 4
of 28 on main). That last one is a real, older defect: clearing a long history
on a phone can stop part-way with "清理未完成"; "继续清理" then resumes, and no
record is lost. It is not fixed in this release.

GitHub Actions did not run for this cycle's commits (no quota). Every gate
named here was run locally; "not run" is not "passed".

Not established by this preflight: Windows native install, upgrade and
uninstall acceptance; physical-phone acceptance of the release packages; live
FCM/APNs delivery; real-engine journeys for every engine on the frozen commit.
Release notes must say so.

## Publication boundaries

Verify source bindings, final signatures, unpacked artifact privacy and
downloaded bytes for every published asset. Store upload, review, test-track
availability and physical-device acceptance are separate states and are
reported separately. Synchronize the official homepage after publication.
This preflight is not a publication or installed-App acceptance receipt.

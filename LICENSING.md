# TaroBot licensing

Copyright (c) 2026 Cloveric.

Except for components carrying their own license or attribution, TaroBot is
licensed under the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`). The complete, unmodified license text is in [LICENSE](LICENSE).
This applies to the shared host, CLI, desktop/mobile client, optional adapter
code and other project-owned material in this repository.

TaroBot is distributed without any warranty; see sections 15 and 16 of LICENSE.
The SPDX identifier explicitly selects version 3, rather than granting an
automatic option to use a later version.

## Separately licensed components

Their existing copyright, license and attribution notices remain in force.
The project license does not replace those component notices.

The table below and the in-App **Settings → About → Acknowledgements** screen are
generated from [`third-party/acknowledgements.json`](third-party/acknowledgements.json)
plus bundled npm runtime dependencies via `npm run acknowledgements:generate`.

<!-- acknowledgements:table:start -->
| Component | Version / commit | License | Location & usage |
| --- | --- | --- | --- |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | `2.x` | OFL-1.1 | `client/public/licenses/JetBrains-Mono.txt` — Monospace code and terminal font bundled in the App |
| [Sarasa Term SC](https://github.com/be5invis/Sarasa-Gothic) | `1.x` | OFL-1.1 | `client/src/assets/fonts/sarasa-term-sc/` — CJK monospace font used for code blocks and terminal views |
| [LobeHub Model Brand Icons](https://github.com/lobehub/lobe-icons) | `bcdb7c82792a854c2967f7328e11a30205ea584d` | MIT | `client/src/assets/model-brands/` — Model provider brand icons (OpenAI, Claude, Gemini, DeepSeek, Kimi); trademarks belong to their respective owners |
| [Pi Project Mark](https://pi.dev) | `monochrome mark` | Trademark notice | `assets/product/engines.png` — Monochrome mark identifying the supported Pi engine in product documentation artwork |
| [Bricolage Grotesque](https://github.com/ateliertriay/bricolage) | `1.x` | OFL-1.1 | `assets/product/fonts/BricolageGrotesque-Bold.ttf` — Display typeface used in product artwork |
| [Instrument Sans](https://github.com/Instrument/instrument-sans) | `1.x` | OFL-1.1 | `assets/product/fonts/InstrumentSans-Regular.ttf` — Sans-serif typeface used in product artwork |
| [IBM Plex Mono](https://github.com/IBM/plex) | `1.x` | OFL-1.1 | `assets/product/fonts/IBMPlexMono-Regular.ttf` — Monospace typeface used in product artwork |
| [baoyu-design](https://github.com/JimLiu/baoyu-design) | `2.15.2 (016a68e1b1ac1c7c291b2cb88d66ff087e50b017)` | Mixed (MIT / upstream notices) | `client/vendor/baoyu-design/, skills/baoyu-design/` — Vendored design canvas editor, references and runtime notices |
| [baoyu-slides](https://github.com/JimLiu/baoyu-design) | `2.15.2 (016a68e1b1ac1c7c291b2cb88d66ff087e50b017)` | Mixed (MIT / upstream notices) | `client/vendor/baoyu-slides/, skills/baoyu-ppt/` — Vendored slides editor, compiler and runtime notices |
| [deepseek-harness-plugin](https://github.com/cloveric/tarobird) | `workspace` | MIT | `deepseek-harness-plugin/` — Independently published DeepSeek search MCP plugin |
| [@anthropic-ai/claude-agent-sdk](https://code.claude.com/docs/en/legal-and-compliance) | `0.3.329` | Anthropic Terms | `dist/licenses/claude-agent-sdk/` — Bundled Claude Code history helper (not covered by AGPL-3.0-only) |
| [xlsx (SheetJS Community Edition)](https://cdn.sheetjs.com) | `0.20.3` | Apache-2.0 | `client/package.json` — Spreadsheet parsing and preview in the App |
| [Scrapling (skill reference)](https://github.com/D4Vinci/Scrapling) | `0.5 reference` | Upstream notice | `skills/scrapling/SKILL.md` — Upstream fetching reference attributed in the Scrapling skill guide |
| [OkHttp](https://github.com/square/okhttp) | `5.5.1` | Apache-2.0 | `client/android/app/build.gradle` — Android native HTTPS transport with pinned certificate verification |
| [Java-WebSocket](https://github.com/TooTallNate/Java-WebSocket) | `1.6.0` | MIT | `client/android/app/build.gradle` — Android native WebSocket transport to self-hosted Hubs |
| [SLF4J](https://github.com/qos-ch/slf4j) | `2.0.20` | MIT | `client/android/app/build.gradle` — Android logging facade for native networking dependencies |
| [Bouncy Castle (bcprov-jdk15to18)](https://github.com/bcgit/bc-java) | `1.86` | MIT | `client/android/app/build.gradle` — Android Ed25519 cryptography and certificate handling |
| [UnifiedPush Android Connector](https://codeberg.org/UnifiedPush/android-connector) | `3.3.5` | Apache-2.0 | `client/android/app/build.gradle` — Optional self-hosted push notifications on Android |
| [Firebase Cloud Messaging (Android)](https://github.com/firebase/firebase-android-sdk) | `26.0.1` | Apache-2.0 | `client/android/app/build.gradle` — Optional FCM push notification delivery on Android |
| [AndroidX Libraries (Activity, AppCompat, CoordinatorLayout, Core SplashScreen)](https://github.com/androidx/androidx) | `AndroidX` | Apache-2.0 | `client/android/app/build.gradle` — Android platform UI shell, insets, and splash screen support |
| [Capacitor Swift Package (capacitor-swift-pm)](https://github.com/ionic-team/capacitor-swift-pm) | `8.6.0` | MIT | `client/ios/App/CapApp-SPM/Package.swift` — iOS Capacitor and Cordova native runtime bridge |
| Bundled npm runtime dependencies | Pinned in `package-lock.json` & `client/package-lock.json` | Various (MIT, Apache-2.0, ISC, BSD, etc.) | Generated into `client/src/generated/acknowledgements.json` and viewable in Settings → About → Acknowledgements |
<!-- acknowledgements:table:end -->

### Reusing third-party code

- Place copied third-party code in its own folder with its unmodified upstream
  `LICENSE` file beside it and add one entry to `third-party/acknowledgements.json`
  (re-running `npm run acknowledgements:generate`). Per-file source headers are
  not required.
- For Apache-2.0 code, also keep its `NOTICE` file and record modifications
  (either a short line at the top of each modified file or a `CHANGES` note in
  that folder).
- Listing a component does not make an incompatible license usable.

The standalone CLI package includes this notice, the project LICENSE and the
independent DeepSeek plugin's MIT license. Its bundled web client retains the
runtime notices under `client/dist/licenses/`.

## Transition

The project license changes on 2026-10-18, after release 1.0.91 / CLI 0.1.439.
The change applies to this revision and subsequent project revisions unless
expressly stated otherwise. Earlier releases and source snapshots keep the
licenses supplied with them; their artifacts and Git tags are not rewritten.

The repository's privacy setting is separate from its license and is unchanged.

## 中文说明

TaroBot 主项目从本次修订起采用 **AGPL-3.0-only**（仅第 3 版）。完整条款以
[LICENSE](LICENSE) 为准。独立 DeepSeek 插件、第三方库、字体和图标保留各自的
许可与版权声明。本次变更不追溯修改此前已发布的安装包、源码快照及标签，
也不改变 GitHub 仓库的可见性。

References: [GNU license text](https://www.gnu.org/licenses/agpl-3.0.html) ·
[SPDX identifier](https://spdx.org/licenses/AGPL-3.0-only.html).

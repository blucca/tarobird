# Native model quota visibility

The owner can inspect model quotas in Settings or with `tarobird engines quota`.
This is separate from conversation token counts and estimated costs: those do
not establish an account's remaining allowance.

## Supported native sources

| Engine | Source and limits |
| --- | --- |
| Codex | Explicit read of native account and rate-limit APIs for a subscription identity. API-key/provider balances are not inferred. A cold reader uses a temporary CLI helper without creating a thread or sending a prompt. When the Host cannot verify the credential source from files (no `auth.json`, a keyring/auto store or an external helper), an explicit refresh still asks Codex's public `account/read`: "not signed in" becomes login required, and an account answer is shown for that one read only after the before/after identity check and only when the replies tie one stable user (`userId`), the workspace (`workspaceRouting.chatgptAccountId`, identical in both `account/read` replies) and the usage snapshot's own `accountId` to the same account, each a bounded whitespace-free token. Codex 0.170.0 documents none of these as guaranteed and does not scope `account/rateLimits/read` to the routed workspace in its protocol, so a missing usage account is never filled in from routing; such a reply, or one with only a type, plan or email, stays unverifiable and shows no values. A JSON-RPC -32603 reply with the CLI's exact unauthorized text from these quota calls (`workspace routing discovery unauthorized (401)`, `failed to fetch codex rate limits: … 401 Unauthorized`) is shown as login required; other native failures stay unavailable. Such a reading is never cached or reused. |
| Claude | Native quota events observed during an ordinary conversation. Reading the card does not start a conversation or request a model response. An identity that cannot be verified, including an opaque Keychain credential source, remains unknown. |
| Antigravity | No active reader until a successful public quota response and identity contract are verified. |
| Kimi | The currently integrated ACP contract has no verified quota reader. |
| DeepSeek / Pi | No generic balance estimate is made across arbitrary providers. |

Each Bot is a separate displayed scope. Different Bots can share an account;
the App does not add their values together or infer sharing from a home path.
Native windows and credits retain their own units and reset times. An unknown
value is not zero or unlimited. Independent native restrictions can block use
even when a percentage is low.

## Official viewing guidance

When a card has no current reading (unsupported, unknown, login required,
unverifiable, stale or offline), Settings shows the engine's official viewing
method from the snapshot's `help` code. `tarobird engines quota` prints the
same guidance to standard error; its JSON output is unchanged. The sources were
checked against the local CLIs' own help/changelog text and official docs:

| `help` | Guidance | Evidence |
| --- | --- | --- |
| `codex_usage` | Codex CLI `/usage` after a ChatGPT sign-in | Codex CLI 0.170.0 built-in help text |
| `claude_usage` | Claude Code `/usage`, or `claude.ai/settings/usage` | Claude Code 2.1.329 command list and limit message |
| `antigravity_usage` | Antigravity CLI `/usage`, `/quota`, `/credits`; a `GEMINI_API_KEY` has no account quota (Google AI Studio) | `agy changelog` (1.5.13) |
| `gemini_api_usage` | Google AI Studio for a `GEMINI_API_KEY` | `agy changelog` (1.5.13) |
| `kimi_usage` | Interactive Kimi Code CLI `/usage`; ACP `/usage` only reports session tokens | Kimi Code 2.7.0 command definitions |
| `deepseek_balance` | DeepSeek Platform balance for the official API; other providers' own consoles | DeepSeek API balance docs; DSH 0.2.2-rc.5 account plugin default origin |

The guidance never triggers a read, a login or a model request. Claude's
passive source stays hidden when its credential source cannot be verified
(for example, a macOS Keychain login); the card states that limit instead of
showing values that could belong to another account.

## Read and refresh behavior

Opening the page and refreshing the directory reads worker caches only. Codex's
per-card refresh is explicit, coalesced and limited to once per minute for the
same identity revision. Claude reads passive observations only. Expired values
are marked stale; reaching a reset time does not manufacture a full allowance.
One shared rule (`quotaReadingExpired`) decides this for the Gateway, CLI output
and the App: the reading's TTL, any window/credit expiry, or any reported reset
time, including an independent constraint's reset, ends the current reading.
The last restriction remains visible as a last reading until a new read.
No background polling, automatic retry, login, or token refresh is added.

The owner-only HTTP entry points are `GET /api/engine-quotas` and
`GET /api/engine-quotas/:scopeId`. A single active refresh additionally requires
`refresh=1&revision=<last-read-revision>`. The Host and worker advertise
`engines.quota.v1`; old/offline workers return an explicit unavailable state.

CLI examples:

```sh
tarobird engines quota --json
tarobird engines quota --bot BOT --json
tarobird engines quota --bot BOT --refresh --revision REV --json
```

Credential or worker changes discard cached observations. The caller receives
the new revision without old account values and must choose a new refresh.
Revocation, owner-role changes, deleted Bots and replaced worker connections are
checked across asynchronous reads. Internal execution workers are not listed.

Account IDs, emails, credentials, paths and private identity proofs never enter
the public DTO. Credential material is read with bounded buffers and retained
only in host-private identity hashing. Raw native failures are not forwarded.
Cancelling a quota read must not destroy a shared chatting worker; dedicated
helpers must actually exit before their reservation is released.

## Validation boundary

Parser, cache, revision, cancellation, authenticated HTTP/Gateway and App UI
tests cover this contract. Real Codex and Claude executables were also checked
against isolated loopback providers with synthetic identities. This establishes
the native protocol and no-extra-prompt behavior, not subscription acceptance
against every real account or installed device. Unsupported sources remain
explicitly unsupported until that source has an implemented and verified path.

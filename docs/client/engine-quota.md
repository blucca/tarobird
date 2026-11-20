# Native model quota visibility

The owner can inspect model quotas in Settings or with `tarobird engines quota`.
This is separate from conversation token counts and estimated costs: those do
not establish an account's remaining allowance.

## Supported native sources

| Engine | Source and limits |
| --- | --- |
| Codex | Explicit read of native account and rate-limit APIs for a verifiable subscription identity. API-key/provider balances are not inferred. A cold reader uses a temporary CLI helper without creating a thread or sending a prompt. |
| Claude | Native quota events observed during an ordinary conversation. Reading the card does not start a conversation or request a model response. An identity that cannot be verified, including an opaque Keychain credential source, remains unknown. |
| Antigravity | No active reader until a successful public quota response and identity contract are verified. |
| Kimi | The currently integrated ACP contract has no verified quota reader. |
| DeepSeek / Pi | No generic balance estimate is made across arbitrary providers. |

Each Bot is a separate displayed scope. Different Bots can share an account;
the App does not add their values together or infer sharing from a home path.
Native windows and credits retain their own units and reset times. An unknown
value is not zero or unlimited. Independent native restrictions can block use
even when a percentage is low.

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

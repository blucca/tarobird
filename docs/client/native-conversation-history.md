# Native conversation history

The owner can use the history operations a Bot's native engine actually supports.
Availability comes from the current Gateway and native session. Unsupported
operations are omitted; the Host does not rebuild context by replaying messages
or operating a terminal interface.

The initial scope is an ordinary owner-owned direct conversation with one Bot.
Groups/topics, dispatcher/ticket workers, delegated inputs and temporary side
conversations do not receive history controls. A source must be idle: queued or
paused inputs, pending actions, native goals and background work prevent changes.
Shared native bindings are rejected rather than changing another conversation.

A rewind changes native context before the selected native user input. App
messages and files remain in place. Only inputs explicitly identified as excluded
by the native result, and Bot replies to those inputs, receive an exclusion mark.
This does not undo workspace file changes.

A fork creates a new App conversation with a new persistent native session and
source attribution. It does not copy or replay the source transcript. Whole-session
fork and anchored fork are separate capabilities. Anchored forks explicitly state
whether they stop before the selected input or after its native turn. Existing
native slash commands retain their native semantics.

The whole-conversation action lives in the existing conversation menu. Exact
message actions live in the message menu, when the engine supplied an attributable
native anchor for that input. The new conversation starts with a link to its
source; the old App transcript is not duplicated into a second message history.

## Native capability boundaries

| Engine connection | Whole fork | Message fork | Immediate persistent context rewind |
| --- | --- | --- | --- |
| Codex app-server | Yes | Through the selected native turn | Before the selected native input |
| Codex exec | Yes, through a temporary app-server using the same native home | Not advertised: exec does not supply an attributable turn anchor | Not advertised |
| Claude Code | Official SDK disk fork | Through the last main-session assistant message of the selected turn | Not advertised: file rewind and next-query resume options are different operations |
| Kimi ACP | Yes, with native list/load/fork/close support | Not advertised: no attributable message boundary | Not advertised |
| DeepSeek Harness web | Native event-prefix fork | Through the selected native turn's end event | Not advertised: the native event history is append-only |
| Pi RPC | Native persistent clone | Use the native `/fork` picker; App anchors are not guessed from extension-added messages | Not advertised: tree navigation alone is not persisted across restart |
| Antigravity | Not advertised without a supported programmatic native operation | Not advertised | Not advertised |

Capabilities still depend on the installed engine and current session. A missing
or unreadable source never falls back to creating a blank replacement session.
The Claude SDK is an exact build-only dependency bundled into a dedicated helper;
its original component notices ship with the Host. It does not add another Claude
CLI installation or send a model request to create a fork.

A turn the upstream refused as an invalid input is explained only from the
engine's own structured terminal signal: Codex app-server `codexErrorInfo:
badRequest` on a failed foreground turn (0.170.0 raises it for an invalid image
or unsupported audio) and Claude Code `terminal_reason: image_error`; Antigravity
keeps its native `INVALID_ARGUMENT` terminal. A provider's plain HTTP 400 (Codex
`other`, Claude `api_error`, DeepSeek Harness `INVALID_REQUEST`), context
overflow, a missing model, message text, stderr and tool output do not qualify,
and one refusal is not presented as a damaged conversation. The request is never
replayed. Only Codex app-server main threads add the conditional advice to use
"Rewind to before this message" on the message that brought the content in,
because the refused input stays in that thread; other engines suggest a new
conversation if valid requests keep failing.

Kimi's native load can reset session preferences. The adapter restores acknowledged
preferences before releasing its read reservation. If a read times out while
native replay continues, an ordinary pending message waits for that same replay
and restoration, with cancellation; it does not start a second load. Uncertain
mutations and unconfirmed preferences remain blocked. Temporary helpers must exit
before successful cleanup is reported.

## Owner API and CLI

All endpoints use the existing signed owner connection and the same authorization
as the App. Native session IDs and paths are not accepted from clients.

| Request | Purpose |
| --- | --- |
| `GET /api/conversations/:id/history?botId=...` | Current capability, opaque source revision and pending request |
| `GET /api/conversations/:id/history/anchors?botId=...&messageId=...` | Exact App user-message anchor; omit `messageId` for bounded cursor pages |
| `POST /api/conversations/:id/history/operations` | One explicit rewind or fork with request ID and expected revision |
| `GET /api/conversations/:id/history/operations/:requestId?botId=...` | Read an existing operation receipt without replay |
| `POST /api/conversations/:id/history/operations/:requestId/reconcile` | With the exact original change, inspect native receipt and finish confirmed local state; tombstone a never-admitted request |

```sh
tarobot history snapshot CHAT --bot BOT
tarobot history anchors CHAT --bot BOT --message MESSAGE
tarobot history rewind CHAT --bot BOT --anchor ANCHOR --revision REV --request-id REQUEST
tarobot history fork CHAT --bot BOT --revision REV --request-id REQUEST --title "New branch"
tarobot history fork CHAT --bot BOT --anchor ANCHOR --revision REV --request-id REQUEST
tarobot history status CHAT --bot BOT --request-id REQUEST
tarobot history reconcile CHAT --bot BOT --action fork --revision REV --request-id REQUEST --title "New branch"
```

`rewind`, `fork` and `reconcile` print the receipt and exit with status 1 when
the operation was rejected or its outcome is not yet confirmed (`unknown` or
`pending`), as `steer send` does. Earlier versions exited 0 in those cases.
`snapshot`, `anchors` and `status` are reads and exit 0 whatever they report.

Use a fresh snapshot for each new operation. An operation's `resultingRevision`
records local persistence; it is not a replacement for the next snapshot's
`expectedRevision`. `sourceEventSeq` on a committed rewind identifies the App
projection event to wait for before displaying fully synchronized success.

## Persistence and uncertain outcomes

`conversations.history.v1` is negotiated between Hub and Gateway and advertised
in the App server capabilities. Older Hosts or workers cannot perform the new
operations. The ordinary message schema carries optional Host-owned
`historyContext` and `historyOrigin` metadata; older App readers retain the plain
history and system receipt.

Hub schema 26 adds `history_operations` and `history_anchors`, plus small display
columns on existing messages/conversations. Nonterminal operation rows fence new
sends, queue claims, steering, actions and session binding. The existing
SessionStore holds the corresponding durable generation and local fence.

GatewayReceipts reserves the full operation identity and fsyncs the native result
before local binding finalization. Duplicate requests reuse that receipt. Native
mutation is never replayed by the Gateway outbox; only anchor/result evidence is
replayed. Reconnect recovery reads existing receipts and can complete local
binding or Hub projection for a confirmed native result.

A disconnect, timeout, interrupted receipt or unconfirmed native result remains
unknown. The source remains fenced, for at most 10 minutes from admission:
longer than a live Gateway can spend on one operation (Codex allows 180 s for
`thread/fork` and as long again to read the fork back). The Hub then reads the
Gateway receipt once more; a recorded result is finalized as usual. Otherwise
the operation is released as rejected (`cancelled`): the Gateway clears its
fence unless it is still running the operation itself, and the conversation can
be used and forked again. A fork or rewind the engine did complete but never
recorded stays outside TaroBird: a fork remains an unbound native session, a
rewind remains in effect natively while App messages keep no exclusion mark. Status lookup does not invoke the mutation
again. Do not change the request ID to retry an uncertain mutation. No generic
reset/rebind bypass is provided by this feature.

Explicit reconciliation carries the original full request. If it never reached
the Hub, a rejected tombstone prevents a delayed original POST from executing.
If admitted, reconciliation only reads the durable Gateway receipt and retries
local finalization of a confirmed result. It never invokes native apply. A
missing receipt for an admitted operation remains unknown and fenced. GET status
is always a pure read; a 404 alone does not prove that a delayed POST cannot arrive.

Each operation that ends, or whose outcome becomes unknown, writes one line to
the Host log with its kind, state, reason and opaque operation and Bot ids. The
Gateway records each apply and its outcome in the Bot timeline. A Claude helper
that fails writes its phase and code to the Bot log; App receipts carry only
the reason.

Codex persists dynamic App tool definitions in native forks. Before requesting a
fork, Gateway durably captures the source's exact local tool-version registration.
Finalization inherits that version before exposing the new binding, without
upgrading its frozen definitions or copying permissions, delivery receipts or a
previous turn's App context. Corrupt/conflicting registration stops finalization;
explicit reconciliation can retry local finalization without repeating the fork.
Authorization is rechecked after awaited persistence and inside the binding lock.

The expected revision fences TaroBird binding changes and compares the native
history head before mutation. It is not an atomic compare-and-swap API provided
by an external native CLI. Engine-specific boundary parameters and readback must
remain explicit; local locks do not claim to lock unrelated native clients.

Older runtimes must refuse schema 26 because they cannot honor these fences.
Instance JSON state separately advances to schema 2: older JsonStore readers
must reject it before an older session parser can strip the durable fence.
Existing schema-1 session data remains load-compatible and is upgraded on write.
Host backups retain the operation state and managed Bot receipts, but native
engine history remains external to a Host backup. Restoring Host state is not a
native-history rollback.

## Implementation and checks

Shared schemas live in `src/client-protocol/conversation-history.ts`. Hub
orchestration is in `src/hub/conversation-history.ts`; Gateway receipt handling
is in `src/gateway/conversation-history.ts`; the runtime controller and
SessionStore own native identity, CAS and lock boundaries. Adapters supply exact
native anchors and supported operations. The CLI uses `src/host-cli/history.ts`.

Focused regressions cover native-effect deduplication, request conflicts,
unknown outcomes, restart receipt inspection, owner and source checks, exact
exclusions, source-preserving fork finalization and signed HTTP/Gateway routing:
`hub-conversation-history`, `gateway-conversation-history`,
`history-gateway-roundtrip`, `host-cli-history`, plus runtime controller, session
store and adapter suites. Existing queue, binding, backup and host upgrade tests
remain relevant. Synthetic/source checks do not establish real native-engine,
packaged-App or physical-device acceptance.

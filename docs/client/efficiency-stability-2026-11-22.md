# Efficiency and stability check — 2026-11-22

Requested after the features added since 1.5.1 (284 commits). The baseline is
`c4619817bf43c8d0c8b9d99ca77aaf9700572ddf`; the 1.5.1 tag was built and measured
beside it. Nothing was published or installed for this check.

## Method

Measured before changing anything:

- the installed Host and desktop App on one Mac (process list, CPU and idle
  wake-ups, database page counts, the Host log by kind of line; no message
  content was read);
- the App in headless Chromium against a fixture Hub: main-thread time from
  `Performance.getMetrics`, the number of elements each style recalculation
  touched from the `devtools.timeline` trace, React commits per update in an
  unminified build, and every HTTP request of an idle open conversation.

A count from the browser's trace does not depend on how fast the machine is;
the millisecond figures below are from one Apple-silicon Mac and are for
comparison only.

## What the features since 1.5.1 cost

| | 1.5.1 | baseline |
| --- | --- | --- |
| All JavaScript in the build | 13.79 MB | 14.02 MB |
| Entry script / entry stylesheet | 0.50 MB / 462 KB | 0.52 MB / 477 KB |
| Main thread, idle conversation, 8 s | 0.04 s | 0.04 s |
| Main thread, 80 updates of a long streamed reply | 2.29 s | 2.44 s |

The App did not get heavier in these measurements. The costs found below were
already there in 1.5.1.

## Changed

**A streamed update restyled the whole message.** Each update of a long reply
made the browser recalculate about 2,500 to 2,900 elements, although only a
paragraph was added. Six rules caused it in the measured view; with all 249
`:has()` rules neutralised the largest recalculation was 100 elements, and
with those six rewritten it is about 150 (desktop) and 290 (phone). A seventh
of the same kind, loaded with the board, was rewritten with them. They were:

- `.message-body:has(…):not(:has(…)) > *` (the fitted reply card): now
  `.message.bot:not(.is-discussion-input) .message-body > *`. Block children
  ignore `min-width`, so the rule only acts where the body is the fitted grid.
- `body:has(.prompt-queue-list[data-dragging]) *` and its board counterpart
  (no text selection during a drag): the drag now marks the root element
  (`drag-select-lock.ts`), and one rule in `styles.css` reads the mark.
- `.conversation-row:has(.unread-badge) strong` (three rules): the row now has
  the class `has-unread`, set where the badge is rendered.
- `.desktop-menu > button:has(.desktop-menu-text) .desktop-menu-text > :first-child`:
  the `:has()` was redundant.

Per update of a long reply the main thread went from 33.4 ms to 21.0 ms
(desktop layout) and from 28.0 ms to 18.4 ms (phone layout); style
recalculation fell from 0.90 s to 0.15 s over 60 updates.
`client/e2e/streaming-restyle-budget.spec.ts` holds the largest recalculation
of a streamed update under 400 elements on both layouts; it fails on the
baseline.

**For new styles:** a `:has()` on an ancestor is safe when the rule ends at
that ancestor or at a class. Followed by a bare tag, `*` or a structural
pseudo-class (`strong`, `> *`, `:first-child`), it makes every DOM change
below any `:has()` ancestor restyle whole subtrees. Prefer a class or
attribute set by the component.

**The waiting-message queue was read on a timer.** An open conversation asked
`GET /api/conversations/<id>/queue` every two seconds and again 150 ms after
every change of the conversation, which during a streamed reply is every
update. An idle conversation made 15 such requests in 30 seconds. An entry can
only appear with a new message, which is announced, so now:

- the two-second timer runs only while the last reading holds entries, or
  before a first reading exists;
- a message arriving or leaving is read after 150 ms, as before;
- other changes are read at most once a second.

An idle open conversation now makes 23 requests in 30 seconds on desktop (38
before) and 18 on a phone (33 before); the rest are listed under "Not
changed". `client/e2e/prompt-queue-reads.spec.ts` covers the three rules and
that a queued message still shows at once.

**Each Bot's Gateway process woke four times a second for nothing.** The worker
polled every 250 ms whether a requested restart or drain could proceed, for
its whole life. The check now runs only while a restart or drain is pending
(`gateway/idle-watch.ts`); a timer that practically never fires keeps the
process alive as the poll did.

**Time formatters were rebuilt for every row on every render.**
`formatMessageTime` and `formatRowTime` build each `Intl.DateTimeFormat` once
per locale and shape, and again after the device's time zone offset changes.

## Found, not changed

- **Old databases keep their free pages.** A Host database created before
  incremental vacuum was introduced has `auto_vacuum=0`. On the measured Mac
  the file was 6.1 GB, of which 4.5 GB were free pages; the data was about
  1.5 GB (`run_journal` 843 MB, `events` 297 MB). The space returns only
  through the offline `hub compact`, which needs the Host stopped and free disk
  space of twice the file. It is disk space, not speed: backups use
  `VACUUM INTO` and are compact already.
- **Nine React commits per streamed update.** The conversation view re-renders
  as a whole for each of them (the store subscription, the directory effect,
  the virtualizer's `flushSync`). About 8 ms of the remaining 21 ms per update
  is script. Reducing it means memoising parts of `App.tsx`; not attempted
  here.
- **Route and profile sync every four seconds.** `NetworkSync` reads
  `/api/network` and `/api/host-profile` every 4 s while the App is visible,
  and the desktop sidebar reads `/api/agent-buses` every 6 s. They decide how
  fast a changed address or a new Bus is noticed.
- **Idle Bot processes.** Each Bot has its own Gateway process of about 80 MB;
  twelve Bots hold about 1 GB while idle.
- **`relay_connection_failed` in the Host log** is written for an error on any
  tunnel socket, including one phone connection ending, so its count (about 20
  a day on the measured Host) does not say the relay itself dropped.

## Tests that fail on the baseline too

Seen while verifying, and present on 1.5.1 or the baseline with unchanged
code, in headless Chromium on this Mac:

- `e2e/claude-interaction.spec.ts` (2) and `e2e/async-answer-feedback.spec.ts`
  (6) fail on the 1.5.1 tag, on `4803293` and on the baseline.
- `e2e/widget-mobile-parity.spec.ts` "workbench 320x740" and "workbench
  844x390" fail on `4803293` and on the baseline; with waits added the first
  passes, so the clicks appear to land during the enlarge/collapse handover.

They were not investigated further.

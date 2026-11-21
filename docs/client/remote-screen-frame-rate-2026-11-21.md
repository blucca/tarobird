# Remote screen frame rate — 2026-11-21

Baseline: `c9d3ec0`. A source change with no release. Measured on one Mac with
the real capture renderer and hardware encoder fed by a hidden synthetic page;
see "Not verified" for what that leaves out.

## What limited the rate

Every quality profile (`smooth`, `balanced`, `sharp`) named 15 frames a second,
and the capture renderer clamped any rate to 15 as well. The network, the Hub
and the viewers set no frame-rate limit of their own. Three smaller effects sat
behind that cap:

- The next encode was allowed one interval after the previous encode actually
  ran, so a late pacing timer pushed every later frame back by its lateness.
- The viewer's receipt for each frame drew on the Hub's per-session input
  budget (120 a second, burst 180) together with pointer, wheel and key
  events. At 15 receipts a second that was harmless; at 60 it would have left
  too little for fast input and could end a session as rate limited.
- Every session had the same byte budget (500 B/ms, 4 Mbit/s) whether its
  viewer sat on the same network or behind a relay.

## What changed

**Rate.** A profile's rate is a ceiling, not a target. `smooth` and `balanced`
take up to 120 frames a second and `sharp` up to 60; the source delivers its
display's own rate (60 on most screens). A session opened without a quality
(an older viewer) gets the `balanced` profile and so the same ceiling. The
renderer accepts up to 120.

**Stepping down.**

- An encoder that cannot take a rate at the encoded size gets the next lower
  standard rate (`screenRateLadder`: the ceiling, then 60, 30, 15). H.264 at a
  lower rate is preferred to VP8 at any rate.
- A viewer returns one receipt per decoded frame and the target keeps a bounded
  number of frames unacknowledged (the flight window, below), so a slower
  viewer receives fewer frames without any setting.
- A busy picture that reaches the byte budget is paced, and its quantizer
  rises, as before.

**H.264 level.** The stream still declares the level of its size alone
(`screenH264Codec`: 4.0, or 5.1 above 1080p-class), the same string viewers
were always given. The encoder is configured with the level its size needs at
that rate (`screenH264EncoderCodec`): 1080p-class is 4.0 up to 30, 4.2 at 60
and 5.1 at 120; `sharp` at 60 is 5.2. Decoders follow the level in the
bitstream.

**Cadence.** Encodes follow a schedule of slots one interval apart. A frame may
be encoded up to a quarter interval before its slot, so ordinary source jitter
needs no timer; the slots still advance by exactly one interval, and a gap of
more than one interval restarts the schedule instead of being made up.

**When the quantizer rises for a slow viewer.** Only a frame replaced while the
viewer still owed receipts for a full window counts as crowding; a frame the
schedule skipped does not. At the legacy 15 frames a second more than two such
frames in a second coarsen the picture, as before. Above it the share decides:
only when fewer than a quarter of the frames that wanted to go got through. A
viewer that follows at 20 or 40 of 60 keeps its picture quality, and so does a
short burst of motion over a long round trip.

**Receipts.** The first receipt of a frame the Hub forwarded no longer draws on
the input budget: it is bounded by the stream itself. Unknown or repeated
receipts are still charged, and the budget is unchanged.

**Flight window.** The target kept at most three frames unacknowledged, which
over a long path means three frames per round trip (30 a second at 100 ms). A
viewer may now name how many frames it can hold (`flight` on `screenOpen`, 16
for the desktop viewer and the phone apps) and say on each receipt how long it
held the frame (`heldMs`: decode, draw and the wait for a repaint). The target
then knows two things about the path:

- the network round trip: the time since the frame left less `heldMs`, the
  shortest value of the session (a figure that would be negative is left out);
- the pace receipts really come back at while frames are still owed, per
  frame, smoothed over the last few. An idle screen gives no sample.

The window is the whole frames in the round trip at that pace (the pace never
taken as faster than the session's interval, and a quarter of a frame allowed
for noise in the two measurements), plus two, never below three and never
above the viewer's capacity. It stays three until eight receipts have shown the pace. A
path that is long and returns receipts at the frame rate widens the window to
the frames really in transit. A viewer, a link or a phone bridge that returns
frames slowly keeps it near three however long the path, because more frames
in flight would only queue in front of it. Beyond three frames the
unacknowledged bytes are bounded as well (512 KiB, half of what the Hub lets
wait for a viewer before it ends the session).

**Byte budget by route.** A viewer whose media socket reaches the Hub straight
from a local-network address (RFC 1918, link-local, unique-local) gets
5000 B/ms (40 Mbit/s) for that session. Every other viewer keeps 500 B/ms: a
relay arrives from loopback, and overlay ranges such as Tailscale's are not
counted as local, so traffic that may leave the local network or be metered
stays where it was. The Hub tells the target the session's budget on `start`
(`mediaBytesPerMs`, only when it is not the default) and holds it to that; the
capture renderer paces itself 15% below. Sessions on the default budget share
the Hub-wide allowance of twice that, as before; a local-network session does
not draw on it.

**Compatibility.**

- The Host advertises `screen-rate-v1` on its control socket. A target runs
  above 15, and offers the budget feature (`screen.pace.v1`), only for a Host
  that does: an older Host counts every receipt as input and would end a busy
  60-frame session as rate limited. With an older Host the hello and the rate
  are exactly what they were.
- An older target is never sent `mediaBytesPerMs`: it goes only to a target
  that offered the feature, and such a target keeps its 15.
- The flight window needs all three ends: the Hub advertises
  `desktop.screen.flight.v1` (a Host-only capability, never in a client hello),
  a viewer names `flight` and sends `heldMs` only to such a Hub, and the Hub
  passes both only to a target that offered `screen.flight.v1`. With any older
  end the window is three and every message is what it was.
- The phone native layers now hold 16 packets of one stream generation (was 3)
  and report that number to the page (`screenWindow`). A page on a native
  layer that cannot report it names no capacity.

The target remembers 512 sent frames (was 64) and the Hub up to 480 (was 90),
four seconds at 120.

## Measured

Real capture renderer and hardware encoder on one Apple Silicon Mac with a
60 Hz display, synthetic source, a hidden viewer that decoded every packet and
returned the credit from its decode callback. No network and no Hub.

| Run | Frames/s | Gap p50 / p95 (ms) | kbit/s |
|---|---|---|---|
| before, 15, 1280×800, pointer-sized motion | 14.7 | 67.6 / 69.7 | 37 |
| before, 15, 1920×1080, full-window text scroll | 14.8 | 66.7 / 68.0 | 369 |
| 60, 1280×800, pointer-sized motion | 59.4 | 16.6 / 17.7 | 149 |
| 60, 1920×1080, full-window text scroll | 59.7 | 16.7 / 20.2 | 1151 |
| 120 asked, 1920×1080, source repainting at 120, default budget | 59.5 | 16.7 / 19.2 | 3288 |
| 120 asked, 1920×1080, source repainting at 120, local-network budget | 59.5 | 16.7 / 19.0 | 3316 |
| 60, 2880×1800, source repainting at 120, default budget | 56.5 | 16.8 / 23.9 | 2833 |
| 60, 2880×1800, source repainting at 120, local-network budget | 59.5 | 15.6 / 21.3 | 5056 |

The 120 runs delivered 60 because the display is 60 Hz. At 2880×1800 the
default budget was the limit (the quantizer rose and three frames in a hundred
were paced out); with the local-network budget it was not.

Flight window, same harness with a delay added on each leg (1920×1080,
full-window text scroll, the viewer's receipt carrying its held time):

| Round trip | Three frames | Capacity 16 |
|---|---|---|
| 10 ms | — | 59.6 |
| 100 ms | 25.9 | 59.5 |
| 150 ms | — | 59.1 |
| 200 ms | 13.9 | 56.9 |

A decoder configured with `avc1.640028` decoded a level 4.2 stream of
1920×1080 at 60 without an error (Chromium on this Mac).

Modelled, not measured (the real capture core on a virtual clock, with a
link, a phone bridge and a decoder that take frames one at a time; frames a
second, and the median time from leaving the target to being decoded):

| Path and viewer | Three frames | Capacity 16 |
|---|---|---|
| keeps up, 100 ms round trip | 30.0, 50 ms | 59.4, 50 ms |
| keeps up, 200 ms | 15.0, 100 ms | 58.8, 100 ms |
| decodes in 25 ms, 100 ms | 23.8, 75 ms | 39.2, 100 ms |
| decodes in 40 ms, 100 ms | 21.0, 90 ms | 24.6, 110 ms |
| decodes in 60 ms, 100 ms | 16.2, 130 ms | 16.2, 130 ms |
| decodes in 100 ms, 250 ms | 8.4, 225 ms | 9.8, 275 ms |
| 1 Mbit/s link, text scrolling, 100 ms | 24.9, 69 ms | 50.8, 105 ms |
| 2 Mbit/s link, whole picture repainting, 100 ms | 17.6, 118 ms | 17.5, 174 ms |
| phone bridge of 35 ms a frame, 4 ms | 28.0, 103 ms | 28.0, 103 ms |

Also modelled: motion in
spurts with receipts 100 ms after each frame keeps the resting quantizer; a
viewer that takes 40 ms a frame receives about 25 a second at the resting
quantizer; one that takes 100 ms a frame is coarsened to the ceiling.

## Costs to know about

- A viewer that cannot follow the source now always has three frames in
  flight, where at 15 it usually had one. It receives more frames and waits
  longer for each: in an independent model, a decoder at 25 ms a frame went
  from 15 frames a second with 35 ms from send to receipt to 40 with 71 ms; one
  at 60 ms a frame from 15 with 70 ms to 17 with 176 ms.
- With an older viewer, Hub or target the window stays three: through a relay
  that is about three frames per round trip (60 needs 50 ms or less, 100 ms
  gives 30).
- Where the path is long and the viewer or the link is the slower part, the
  wider window can add delay for few or no extra frames (rows above: 20 to
  56 ms). A viewer that decodes in 60 ms or more keeps a window of three.

## Not verified

- Real screen capture (ScreenCaptureKit, Windows capture), the Hub hop, a real
  network and a phone's decoder. The numbers are the capture renderer's own
  cadence and the encoder's throughput on one Mac.
- A display that repaints at 120, so no run delivered more than 60.
- A Windows encoder at these rates and levels. The target steps down for its
  own encoder.
- A phone's WebView decoder given a stream whose level is above the declared
  string. A viewer whose decoder refuses it has no fallback.
- The local-network budget over a real network: the route test stands in for a
  local-network address, and the address rule is tested on its own.
- The phone bridge at 60: each frame costs several bridge calls there.
- The flight window on a real relay path and on real phones. The phone native
  layers were exercised by the host-run audits (Android sources on a JVM, iOS
  sources compiled for macOS) against this checkout's Hub, not on devices.

# Remote screen frame rate — 2026-11-21

Baseline: `c9d3ec0`. A source change with no release. Measured on one Mac with
the real capture renderer and hardware encoder fed by a hidden synthetic page;
see "Not verified" for what that leaves out.

## What limited the rate

Every quality profile (`smooth`, `balanced`, `sharp`) named 15 frames a second,
and the capture renderer clamped any rate to 15 as well. The network, the Hub
and the viewers set no frame-rate limit of their own. Two smaller effects sat
behind that cap:

- The next encode was allowed one interval after the previous encode actually
  ran, so a late pacing timer pushed every later frame back by its lateness.
- The viewer's receipt for each frame drew on the Hub's per-session input
  budget (120 a second, burst 180) together with pointer, wheel and key
  events. At 15 receipts a second that was harmless; at 60 it would have left
  too little for fast input and could end a session as rate limited.

## What changed

- Profiles: `smooth` and `balanced` ask for 60, `sharp` for 30. A start that
  names no rate keeps the earlier 15. The renderer accepts up to 60.
- The H.264 level follows size and rate together (`screenH264Codec`): 1280×800
  at 60 still fits level 4.0 (`avc1.640028`); a 1080p-class picture at 60 is
  level 4.2 (`avc1.64002A`); `sharp` at 30 stays level 5.1. Sizes at the
  earlier rate keep their earlier strings. Every viewer already accepts any
  `avc1.` string and passes it to its decoder.
- An encoder that cannot take the profile's rate at the encoded size gets the
  next lower standard rate (30, then 15) with the level that rate needs.
  H.264 at a lower rate is preferred to VP8 at any rate, as before.
- Cadence follows a schedule of slots one interval apart. A frame may be
  encoded up to a quarter interval before its slot, so ordinary source jitter
  needs no timer; the slots still advance by exactly one interval, and a gap of
  more than one interval restarts the schedule instead of being made up.
- Above the earlier rate, frames a viewer could not take count as congestion
  only once fewer than 13 a second got through. A viewer that follows at 20 of
  60 keeps its picture quality; byte starvation coarsens the picture as before.
- The first receipt of a frame the Hub forwarded no longer draws on the input
  budget: it is bounded by the stream itself. Unknown or repeated receipts are
  still charged, and the budget is unchanged.
- The target remembers 256 sent frames (was 64) and the Hub up to 240 (was
  90), four seconds at 60.

The byte budget is unchanged: 425 B/ms at the renderer under the Hub's
500 B/ms per source.

## Measured (10 s each, after 1.5 s of start-up)

| Run | Frames/s | Gap p50 / p95 (ms) | Capture→encoded p50 (ms) | kbit/s |
|---|---|---|---|---|
| before, 15, 1280×800, pointer-sized motion | 14.7 | 67.6 / 69.7 | 34 | 37 |
| before, 15, 1920×1080, full-window text scroll | 14.8 | 66.7 / 68.0 | 7 | 369 |
| after, 60, 1280×800, pointer-sized motion | 59.4 | 16.6 / 17.7 | 13 | 149 |
| after, 60, 1280×800, full-window text scroll | 59.6 | 16.7 / 18.3 | 7 | 1028 |
| after, 60, 1920×1080, pointer-sized motion | 59.7 | 16.7 / 20.1 | 11 | 211 |
| after, 60, 1920×1080, full-window text scroll | 59.7 | 16.7 / 20.2 | 13 | 1151 |
| after, 30, 2880×1800, full-window text scroll | 29.8 | 33.5 / 35.5 | 14 | 2747 |

The source repainted at 60 Hz; a hidden viewer decoded every packet and its
decode callback returned the credit. No run waited on the byte budget.

## Not verified

- Real screen capture (ScreenCaptureKit, Windows capture), the Hub hop, a
  network and a phone's decoder. The numbers are the capture renderer's own
  cadence and the encoder's throughput on one Apple Silicon Mac.
- A Windows encoder at 1080p60, and whether a phone's WebView decoder accepts
  the level 4.2 string. The target falls back for its own encoder; a viewer
  whose decoder refuses the string has no fallback.
- Motion heavier than scrolling text (video). It is expected to reach the byte
  budget, where the existing pacing lowers the rate and coarsens the picture.
- A viewer whose page repaints below 60 a second (for example a phone in a
  power-saving mode) returns receipts at its own repaint rate and receives
  about that many frames.

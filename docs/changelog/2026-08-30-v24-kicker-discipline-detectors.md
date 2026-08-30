# V24 kicker discipline detectors (2026-08-30)

The 2026-08-29 daily analysis' GTO sweep found the top of the loss list
untagged: the three biggest showdown losses of the day (453.9bb, 440bb,
437bb) were all trips on a paired board with a dominated kicker, and two of
the next five were top pair with a rag kicker jamming 300bb. The nut
discipline detectors know flushes, straights and boats; nothing covered the
pair ladder, so every one of those hands carried only the generic
`river_aggr_lost`.

Added to `detectLeaks` in `server/src/services/HorseHandReview.ts`:

- `weak_kicker_trips_stackoff` — NLH-family showdown loss, 40bb+ invested,
  hero makes trips by pairing a doubled board rank with exactly one hole
  card, and the kicker is below the ace. Quads (pocket pair on the board
  pair) and full houses (kicker also matching the board) are excluded.
- `top_pair_weak_kicker_stackoff` — same gate, hero pairs the unpaired top
  board rank and the kicker is nine or below.

Counting only: no strategy dial moves with this change. Per the standing
rule, any kicker-demotion strategy layer must first be measured in the
league — which is what these tags exist to justify (or refute) with real
counts. Pinned by `server/src/services/HorseLeakDetectorsV24.test.ts` using
the three real hands from the sweep as fixtures.

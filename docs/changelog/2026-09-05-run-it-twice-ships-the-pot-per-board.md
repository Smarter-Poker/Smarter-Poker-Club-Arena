# Run It Twice ships the pot per board (2026-09-05)

Dan: "it does not ship the pot individually and is broken."

The three PokerBros recordings were re-cut a third time — 6-10fps, with each
seat's stack, each floating badge and the pot block cropped and tiled into
per-timestamp montages so the money could be read digit by digit instead of
inferred from card motion. That produced one correction to the parity spec and
one real bug.

## What the recordings show

**RUN IT 3X** (pot 8.81, three boards): chips leave the middle at 24.3s and
land at 25.0s with a gold burst and a float, and **Gordo Chris steps 0 → 2.73**.
Canelo is paid at 27.3s (3.51 → 6.24). Gordo is paid again at 30.5s
(2.73 → 5.46). Three awards, three visible steps.

**RUN IT TWICE + SPLIT POT** (main 20.32 / side 1.95 / total 22.27): Player2 at
23.4s (0 → 10.61); Player1 **and** Player5 paid in the same beat at 26.4s
(+0.44 each, the side pot chopped); Player1 again at 28.4s (8.94 → 18.66).

## Fixed

**The stack now rises with every board.** The engine credits ONE merged total
and the client held all of it behind a single boolean (`stackHoldReleased`)
that flipped only after the LAST award group's fan landed. Chips fanned three
times; the number moved once. `pendingStackHold` now takes a per-player ledger
of what has already been delivered, and each award group releases its own
shares ~700ms after its fan launches. Subtraction is in integer cents so
repeated releases cannot strand a rounding crumb.

**The pot rows match the reference.** The counter does NOT tick down — it read
8.81 before the first ship and 8.81 after it, and after the second. In the
split-pot hand both rows stayed up and the **1.95 side-pot row vanished on its
own at 26.5s**, the moment that pot had paid both runs, while 20.32 stayed.
`potShipRemaining` (one decrementing number, side-pot rows blanked for the
whole sequence) is replaced by `potShipView`: the rows frozen at POT_WIN, each
at its full contested amount, retired individually as each pot finishes paying
every run. Frozen because the engine settles synchronously — on a RIT hand the
snapshot pot is already zero seconds before the last board is revealed.

**`hand_history.pots` was NULL on every RIT hand ever played.**
`currentHandPots` is captured only in the WINNERS handler behind
`hasWinners && state.pots`, and a RIT hand satisfies neither: it settles via
`finalizeRunout(true)` (WINNERS emitted empty) and never reaches
`completeHandInner()`, the only assigner of `state.pots`. Measured before the
fix: **6,939 of 6,939** recorded RIT hands had `pots` NULL. The RIT path now
records the live pots it evaluates the boards against.

**`pot_distributed` shipped `pots: []` on every RIT hand** — same capture, same
cause. It now falls back to that record.

**Degraded payloads no longer ship the whole pot on run 1's beat.** The board
axis exists only inside `pot_awards`; every fallback path stamps `board: 1`
because it has nothing better. Combined with a live multi-run ribbon timeline
that fired every group on run 1's ribbon, the entire pot shipped while boards
2..N were still face down. When several runs are being revealed and no group
claims a board past the first, the axis is treated as missing and the uniform
stagger is used — it is already anchored past the end of the reveal timeline.

## Built and withdrawn

A `hand_history.rit_pot_awards` column was added to persist the per-(run, pot)
breakdown, and removed before it shipped: `hand_history.winners_by_board`
(2026-09-04, while this was in flight) already answers "who won which board",
through a path that is complete end to end and live on 299 hands. The only
thing the new column added was the pot axis within a run, which is not worth a
second source of truth for the same question — the exact thing
`HandHistoryPanel.tsx` warns against. Dropped the same day with zero rows
written and no reader (`drop_redundant_hand_history_rit_pot_awards`).

## Verification

Server 3800/3800. Client: 180 affected spec files run in chunks, all green
apart from `discardedErrorReadRatchet` which was already red on this branch for
`src/services/UnionService.ts`, a file this work does not touch. Both sides
typecheck; 0 lint errors in the changed files.

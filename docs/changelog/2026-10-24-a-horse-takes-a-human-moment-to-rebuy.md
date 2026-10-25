# A horse takes a human moment to rebuy

Follow-up to #7911 (a horse answers its rebuy offer like a click), CLAUDE.md
10.5: "TIMING IS PART OF THE TREATMENT."

## What was measured (production, read-only, 2026-10-24)

Purchase-receipt claim time minus the bust row (`tournament_knockout_candidates
.created_at`) for every `rebought` candidate:

- Humans, inside the 30 s window: 9.0 s, 14.5 s, 14.5 s. That is the whole
  record (n = 3). Three more humans bought after their prompt had closed
  (32.9, 36.2, 39.5 s).
- Horses, last 7 days: p5 1.2 s, p25 1.6 s, p50 2.3 s, p95 8.2 s
  (n = 31,812). Before #7911 that latency was the sweep's; after it, the input
  device answered within milliseconds of the bust.
- Offer windows: 99.5% of the last 7 days are 25-30 s; a few hundred are
  shorter (down to 0.1 s).

A watching table saw horses back in faster than any human has ever bought back
in. Same offer, different rhythm.

## Fix

`server/src/tournament/horseTournamentRebuyTiming.ts`:

- `horseRebuyDecisionDelayMs(tournament, horse, bustHand)`: triangular over
  [3.5 s, 16 s], mode 9.75 s (mean of two sha256-derived uniforms). The bulk is
  where the measured human clicks sit; 3.5 s is a decided player; 16 s leaves
  6 s of a 30 s window before the margin, room for three 2 s retries. Bound to
  the busting hand like `horseChoosesTournamentRebuy`, so a retry, restart or
  the other path gets the same moment.
- `horseRebuyAnswerDueAtMs`: bust + delay, capped at `rebuy_prompt_until` minus
  8 s (half the window when it is shorter than 16 s), never before the bust.
  An unknown bust moment has no due time and is never answered.

`tryTournamentRebuys` (used by both the input device and the elimination
sweep) now takes each generation's timing and, for a horse that chose to rebuy
and is within its allowance, sends no purchase before it is due. Such a horse
is returned in `deferredUntil`, NOT in `answered`: it keeps its decision grace
exactly like an undecided human. The sweep reads `created_at` and
`rebuy_prompt_until` in its existing bust-order read and wakes the input
device at the earliest due moment. The device reschedules itself for the
earliest due moment instead of polling, and a wait for a due moment does not
spend one of its 16 retry passes; transient-error retries stay at 2 s.

Unchanged: the choice (`horseChoosesTournamentRebuy`, 75%), the free-buy
allowance, the purchase door. A decline is still recorded at once: it is not
visible, because a declining player's window is waited out by the sweep either
way (2026-10-09).

Pinned by `server/src/tournament/aHorseTakesAHumanMomentToRebuy.law.test.ts`
(no purchase before the delay, purchase after it, never past the margin, same
moment for the same inputs, both paths). Engine change: activates with the
daily 04:00 Chicago engine release.

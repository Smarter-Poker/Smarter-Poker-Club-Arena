# Phase 9 money defects: uncalled ante-only money raked, multi-board odd cent

Found by the Phase 9 natural-evidence re-settlement (PR #5908, artifact
`docs/evidence/phase9/phase9-natural-evidence-2026-10-03-f5322827.json`).
Both are fixed at the line that produced the wrong number. No historical money
was repaired and no production row was written; the historical impact below is
for the owner.

## F1: uncalled money behind an ante-only all-in was raked

**Cause.** `HandController.returnUncalledBet` measured the uncalled excess in
LIVE investment (total minus every kind of dead money, individual antes
included), while `PokerEngine.calculatePots` has counted the individual ante as
a matched contribution since #3885 (2026-09-08). When everyone else still in the
hand had matched only an ante, live investment saw a single contributor and
returned nothing; `calculatePots` then built a pot only the bettor could win,
and `priceDeductions` raked the whole `state.pot`.

Hand 0e68afa3 (evidence hash bad804ab1731), PLO6 run three times, heads-up,
2026-09-30: BB 2.00 + ante 1.00 against a 0.70 ante all-in. Pots 1.40 [both]
and 2.30 [BB]; rake 5% of 3.70 = 0.19 instead of 5% of 1.40 = 0.07.

**Fix.** The uncalled excess is now the top MATCHED contribution minus the next
one, matched contribution being exactly `calculatePots`' level measure
(total - shared dead money + individual ante). It is refunded from the live
portion first and then from the individual ante, with `deadInvested` and
`individualAnteInvested` reduced together. Shared dead money (BBA, dead small
blind) is still never refundable, so the documented pooled-BBA rule is
unchanged. Where two or more players have live money behind equal antes the
result is identical to before; the change bites only when the bettor is the
sole live contributor.

**Scope.** Every variant and mode that posts individual antes
(`ante` without `bigBlindAnte`): NLH, FLH, PLO4/5/6, PLO8, FLO8, short deck,
pineapple; single board, run-it-N (the run-it path calls the same
`settleUncalledBet`) and the all-in runout/insurance pricing (same function).
Diamond cash settles through the same controller path, so any raked Diamond table with individual antes was exposed too; none appears in the retained window. Tournaments are
structurally affected but take no rake, so the one-player pot simply went back
to its owner. BBA tables and bomb antes (live money) were never affected. In a
preflop walk on an ante table with no small blind the BB is now refunded the
uncalled blind before winning the antes; the net is identical and no flop means
no drop.

**History (read-only SELECTs).**

- Retained `hand_history` (2026-09-25 03:26Z to 2026-10-03 04:19Z), exact
  classifier over the action log, rake recomputed from each hand's captured
  rake configuration (it reproduces the recorded rake on all three): 3 cash
  hands, all heads-up, 0.27 chips over-raked, 5.38 of uncalled money raked.
  0e68afa3 plo6 RIT3 (0.19 v 0.07), 5dc18b8b flo8 (0.07 v 0.02, 2026-10-01),
  647703fd short deck (0.15 v 0.05, 2026-10-02). No BBJ drop was affected.
- Before that window `hand_history` is pruned. A `rake_records` heuristic
  (unique top contribution on individual-ante tables, excluding a gap equal to
  the small blind; it matches the exact classifier hand for hand on the
  retained window) estimates 37 hands and about 5.55 over-raked from
  2026-09-08 22:55Z to 2026-09-25, and 13 hands and about 0.23 from 2026-07-19
  to 2026-09-08 (lower confidence: antes were pooled then).

## F2: the odd cent of a raked multi-board pot

**Cause.** Multi-board hands scaled merged gross awards to the post-rake total
with `scaleWinnerUnitsForRake`, which rounds each share to nearest and pulls
any overshoot from index 0. On a multi-board hand index 0 is the board-1
winner. Hand 177246036add: net 15.70, exact 7.85 / 3.925 / 3.925, paid
7.84 / 3.93 / 3.93. The evidence counts 91 two-board bombs with one player
exactly a cent off (89 short, 2 over), about 0.91 moved between players; the
house total was conserved.

**Fix.** `scaleMultiBoardWinnerUnits`: every player gets the floor of the exact
pro-rata share, the leftover units go to the largest remainders, and equal
remainders go by the engine's odd-chip rule (first clockwise of the button,
button last, as `distributePot`). Everyone is strictly within one unit of
exact, a whole exact share (a sole board winner) is paid exactly, and nobody
exceeds the pre-rake entitlement. Used only when two or more boards settle;
single-board and run-it-N hands keep `scaleWinnerUnitsForRake` unchanged.

## Tests

- `server/src/engine/PartialIndividualAnte.test.ts`: the production hand
  through the run-it settlement steps, and a single-board NLH completion.
  Both failed before the fix (no refund; rake 0.20 instead of 0.10).
- `server/src/engine/Phase9MultiboardUnits.test.ts`: hand 177246036add
  through the real controller (failed before: 7.84 / 3.93 / 3.93), plus the
  allocator against exact integer arithmetic over 500 seeded hands.

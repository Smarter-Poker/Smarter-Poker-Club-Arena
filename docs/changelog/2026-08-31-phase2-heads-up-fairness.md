# 2026-08-31 -- Phase 2 of 7: fairness in the hand

Merged as PR #2197 (`d3bc0aa5`). Hetzner engine deploy for that commit finished
14:10 UTC; verified against production behaviour, not against the workflow's own
green tick.

## Three defects, all measured before the fix

**The heads-up first button was never randomised.** The Spin draws its first button
in `TournamentManagerBase.scheduleSpinPostReveal`; a 2-max SNG (the Heads-Up duel,
~11k games a week) never reaches that path and fell through to `buttonSeats[0]` --
the LOWEST occupied seat. Seating is seat-first, so that is whoever arrived first,
and heads-up the button IS the small blind: first to act preflop, last postflop.

    first hands of 2-max SNG tables, by button seat (ordered by started_at):
      before  seat 1 ... 151     seat 2 ... 5      (96.8% on the low seat)
      after   both seats occur, and `tables.first_button_seat` is written
              once per table at the draw -- 1 and 2 both present in the
              first tables to deal after the restart

Drawn now with `secureRandomInt` -- the same generator as the deck -- for every
two-handed first hand, and persisted to `tables.first_button_seat` so a restart
before the first settled hand cannot re-draw it (`restoreDrawnFirstButtons`
already re-applies that column on resume).

**One player posted the big blind twice when a 3-handed table went heads-up.** The
rotation moved the BUTTON forward, which at two players makes the previous big
blind post it again. TDA Rule 33: the blinds advance and the button follows.

    3-handed -> heads-up transitions (ordered by started_at):
      before 12:00-14:08 UTC ... 298 transitions, 62 double big blinds (20.8%)
      after  14:13 UTC+      ...  34 transitions,  0 double big blinds (0.0%)

`lastBigBlindSeat` is recorded off the one shared sb/bb computation and restored
from `hand_history` in the same read that restores the button -- widened to
`select('button_seat, players')`, no extra round trip. Without that restore, a
restart between two heads-up hands drops the rule for one hand.

Gated on both players having been dealt in already, so Dan's binding rule from
2026-08-25 still holds: a newcomer sitting down opposite an incumbent gets the big
blind, never the button.

**`resume()` read the blind level by array index.** The one caller that ignored
`resolveBlindLevel`'s own closing instruction. Every ladder here is 10-12 rows and
both heads-up formats run past the end (a measured Spin reached level 158), so the
index resolved to `undefined`, the `|| blindStructure[0]` fallback took over, and a
restarted late-stage game armed its level clock with LEVEL ONE's duration. Engine
restarts are frequent -- `server/**` auto-deploys.

## Files

`server/src/engine/headsUpButton.ts` (new, pure seat arithmetic),
`ServerTableEngineDealing.ts`, `ServerTableEngineBase.ts`,
`TournamentManagerBase.ts`, plus `HeadsUpButtonFairness.test.ts` (14) and
`ResumeBlindClock.test.ts` (3). Seven of those seventeen fail against the code as
it stood. `RestartFidelity.test.ts`'s select pin was widened in the same commit,
deliberately, with the reason written into the test.

## Note for whoever does Phase 3

`predictButtonSeat` (the wait-for-BB gate) still predicts the LOW seat for the very
first hand of a two-handed table, because the draw happens at deal time. It is a
prediction used to hold a joiner out for one hand and a table starting 2-handed has
no joiner to hold out, so nothing is wrong today -- but the two walks now disagree
for one hand, and `headsUpSpec.ts` is the place to unify them.

## A measurement trap, recorded because it nearly produced a false report

`hand_history.hand_number` is a GLOBAL allocator and `created_at` is the row
WRITE time. Neither is the order the hands were dealt in, and within a single
table the two disagree -- table `6bbdd70c` has hand 3908670 written at 14:22
and hand 3908724 written at 14:20. Ordering a per-table analysis by either one
mispairs consecutive hands, and a `lead()` over that mispairing invented a
"still broken, 20% after the fix" result for the dead-button rule that a
by-hand read of the same table disproved.

**Order by `started_at`.** Both numbers above are computed that way, and any
future forensic query that walks a table hand by hand must be too.

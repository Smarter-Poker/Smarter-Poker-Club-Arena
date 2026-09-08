# Phase Two Cash Conservation And Rules

Status: in progress; no phase completion or deployment claim.

This is phase 2 of the user's 118-item, 12-phase execution mapping, not the older parallel programme's phase counter. Baseline: eeb5ced46bfe41396c0624c1960e133cfc5ceadf. Owner: Codex.

## Confirmed Amount Boundary Defect

The real HandController accepted 6.001, 6.005 and 6.009 as raise-to amounts, and accepted the string '6'. The shared validator also accepted fractional opening bets and numeric strings. Seven new cases failed before the correction; nine existing-valid/invalid expectations passed. Independent stack/pot snapshots require a rejected action to leave every monetary field and action count unchanged.

The shared validator now rejects nonnumeric, nonfinite, unsafe and genuine sub-cent bet/raise amounts before mutation. IEEE representation noise is tolerated at 1e-9 chips, far below one cent. No rounding repair, watcher or reconciler is introduced.

## Remaining Phase Scope

Departure ordering, occupancy-bound cashout identity, seat/escrow ownership, legal actions, short-all-in reopening, side pots, odd chips, blinds/position, every configured variant, RNG/card privacy, showdown/muck, bomb pots/runouts and decision timers still need their complete recorded acceptance evidence. Existing departure/PostgreSQL fixes on main are being reused and reverified, not counted as new work.

Rule comparison sources checked September 8, 2026: Poker TDA rule 47 and its cumulative-all-in examples (https://www.pokertda.com/view-poker-tda-rules/), and PokerStars' betting/side-pot rules (https://www.pokerstars.com/help/articles/poker-rules-master/217459/). These are rule benchmarks, not fairness certification. Preliminary reopening findings remain under behavioral verification.

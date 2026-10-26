# Tournament horses barrel the turn

Dan, 2026-10-25: "IT IS SO PASSIVE AND EASY", with players' screenshots calling
the tournament horses soft.

## What production showed after Phases 1-3 went live

Preflop moved (fold to an open 81.8 -> 76.9%, 3-bet 5.6 -> 7.3%, big blind
fold 58.9 -> 49.7%), but the turn did not: heads-up NLH tournament flop bettors
fired the turn 24.6% of the time when checked to before the change and 24.5%
after. Humans fire 47%.

## Why the turn did not move

`HorseLogic` asks the compact solver table (`gto_postflop_compact`) for a turn
open-action mix before any barrel heuristic runs, and its answer is final. The
cells are keyed by street, family, seat, depth and texture, never by who bet
the flop, and every tournament turn cell averages a 16% bet frequency for the
button and the big blind alike. A horse that bet the flop and was called was
reading the mix for "checked to on the turn, no lead": check, and give up.
The Phase 3 barrel boosts never ran because the cell had already answered.

## The change

- `server/src/engine/HorseLogic.ts`: on a tournament NLH turn (not Omaha, not
  all-in-or-fold) where the horse holds the initiative, the turn cell is not
  consulted (`v57_turn_cell_initiative_skip` telemetry); the barrel plan, the
  value ladder and the continuation decide, exactly as in a spot the table does
  not cover.
- A flop bet chosen by the solver now records the barrel plan too, so the turn
  knows the flop bet was part of a line.

Unchanged: cash games, Omaha, all-in-or-fold, and any turn where the horse does
not hold the lead still read the cell exactly.

Pinned by `server/src/engine/HorseTurnInitiative.law.test.ts`.

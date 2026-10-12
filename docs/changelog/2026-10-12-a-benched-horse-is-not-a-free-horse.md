# A Benched Horse Is Not A Free Horse

## What Was Wrong

Every seat-first board (Spins, Heads-Up, SNGs, the past-start top-up and the board opener) is filled from `pickFreeHorses` in `server/src/services/TournamentRecurringService.ts`. Its fleet read took every `is_horse` profile, including the 62 identities retired on 2026-10-06 (horse_status `disabled`, profile status `deleted`, zero chips in every club wallet).

A benched horse is never seated, so it is never busy, so it was always in the free pool. As the live fleet filled its games the free pool became mostly benched horses, and every fill offered them to the seat door, which refused each one for `insufficient_balance`.

Measured on engine 0a8f92f4 from 00:06 to 03:06 UTC on 2026-10-12: 5,288 `insufficient_balance` refusals, 9 `GameServer.seat_first_board_stuck` reports, Midway Spins waiting 15 to 30 minutes for their third seat, and one Spin (5c54093f) cancelled with its two paid entrants refunded in full.

## What Changed

The fleet read in `pickFreeHorses` now reads only horses whose horse_status is not `disabled`, the same rule `HorseFleetManager` already uses for cash ("disabled is the only status that stops a horse playing"). An active horse is offered exactly as before. This is fleet state, not a horse versus human rule.

Pinned by `server/src/services/aBenchedHorseIsNotAFreeHorse.law.test.ts`, which runs the real `pickFreeHorses` against a fleet holding both kinds.

## Also In This Change

`TournamentRecurring.top_up_refused_pool_finalized` was raised as an error when the overlay guard or the freeroll filler asked to top up a RUNNING event two to four minutes after its late registration closed on time (Late Night PKO d4a393c0 and a0feb545; both finished with every place filled and the whole pool paid). The fill is still refused exactly as before; the error report is kept for the case it was written for, a pool that finalized while the row still reads as registering. Pinned in `server/src/services/aFinalizedPoolIsNotFilled.test.ts`.

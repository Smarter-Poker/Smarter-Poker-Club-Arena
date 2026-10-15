# Lightning Pilot Horses Meet The Bankroll Floor

`20261015032740` funded the 72 pilot horses to 40 chips each. After it installed
(05:32 UTC) the fleet seated nobody in the pilot; the 05:38:11 heartbeat
recorded 531 `seat_refused_underrolled`.

The fleet sits a horse only when its club roll covers `buyInsToSit` reference
buy-ins (`HorseBankroll.ts` `canSit`): nit 40, standard 25, gambler 12. The
reference buy-in is 2.00 at the 6-max and 4.00 at the 9-max, so a nit needs 160
chips for the 9-max and no horse could sit there with 40. The 40-chip floor was
sized against the table maximum buy-in instead of the fleet's bankroll rule;
that was the error.

`20261015053941` tops each pilot horse up to 200 chips from the pilot's own
treasury through `fn_seed_horses_to_floor`, within Dan's 2026-10-14 ruling.
Rolled-back probe at 05:39 UTC: 72 horses, 11,534.00 chips, treasury 96,820.00
to 85,286.00. The apply asserts conservation, every horse at or above 200,
exactly 72 horses, no other human, and no Lightning state change.

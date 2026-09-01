# The SNG board never opened for a club that had switched its games on

2026-09-01. Branch `feat/club-owner-sng-boards`.

Dan's Deep Stack Society directive: after the cash catalog and the weekly
tournament schedule, "ADD IN THE SPINS AND HEADS UP TABLES."

Spins already worked per owner: `checkAndLaunchSpins` opens the house board
first, then loops `activatedSpinOwners()` and opens one board per activated,
funded owner. The SNG pass did not — `checkAndLaunchSNGs` ran exactly one
`ensureBoardOpen` against `this.houseOwner`, so a standalone club with an
activated pool (Deep Stack Society, club 11192, re-activated today with the
canonical `fn_spin_activate`, 20,000 repayable seed, max stake 100) could
never list a heads-up game or SNG in its own lobby.

`createSNG` was already owner-ready — it takes a `BoardOwner` and stamps
`club_id`/`union_id` from it ("these two fields are the ONLY thing that
decides which lobby the game appears in"). The loop was the only missing
piece. This adds it, byte-for-byte in the shape of the Spin pass: house board
first so it is never starved, shared `BURST` budget, `maxStake` clamping the
buy-ins an owner's board may offer.

Pinned by `src/services/clubOwnerSngBoards.test.ts` (4 source pins on the
call site, each observed red against the pre-change source): the owner loop
exists, the stake clamp exists, the house board opens first, the shared
budget is respected. `tsc` clean; HorsesStayInTheirClub,
ClosedTableHuskCannotAbsorbTheBoard, heldEmptyRotationAndSoleOpen and
pickFreeHorsesLimits all green beside it (57 tests).

Product note: `activatedSpinOwners()` — gated on `spin_bonus_pools`
activation — now doubles as the "this club runs its own seat-first games"
switch for SNGs as well as Spins. If a club ever wants heads-up without
Spins, that gate needs its own flag; today no such club exists.

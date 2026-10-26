# The add-on break serves the whole field (2026-10-26)

Dan, 2026-10-25: "EVERY HORSE, IF THEY ARE IN THE TOURNAMENT, AND HAVE THE CHIPS
AVAILABLE TO ADD ON, SHOULD 100% BE ADDING ON IN EVERY SINGLE TOURNAMENT IF THEY
ARE STILL HAVE THERE SEAT!"

## What the first 60-second break on the 100% engine showed

Sunrise Bounty (NLH), 2026-10-26 13:48:55-13:49:55 UTC, engine with #8111:
104 of 186 seated horses bought the add-on before the deadline. Every one of
the 104 replies was a success and none was refused, so nothing was choosing
not to buy. The field simply was not reached in time.

The purchase receipts show how purchases were paced. Groups of four started together,
about a second apart, three groups per admission, then a 4-5 second gap
before the next admission re-read its four snapshots (players, tables, seats,
profiles). That is twelve purchases every ~7 seconds, about 1.7 per second, against
a 60-second window that needs about three per second for this field. The work
budget (`SWEEP_WORK_BUDGET_MS`, 5 s) ended each admission after three groups.

## What changed

While the add-on offer is open and a break holds every table (the add-on
break itself, or a :55 break the add-on opened inside), `tryTournamentAddOns`
offers the whole remaining field in one pass through a pool of
`ADD_ON_BREAK_CONCURRENCY` (8) requests (`offerAddOnsWhileTheFieldIsHeld`).

- No hand is dealt during the break, so there is nothing in this tournament for
  the work budget to protect. The pass opens the mutation batch, which keeps
  the budget from cutting it short. Manager stop, the sweep's abort signal and
  the maintenance freeze still end it before the next request.
- A pass ends at the persisted deadline or after `ADD_ON_BREAK_PASS_MS`
  (20 s), well inside `ELIMINATION_SWEEP_STUCK_MS`. The next admission continues
  from the cursor, so no scheduler slot is held for long.
- It uses the same RPC (`process_tournament_rebuy`), receipts, attempted set and
  cursor, and keeps the same retained identity on an ambiguous reply. Only the
  pacing differs. Outside a held break (Free Buy's early tranche while play
  runs) the ordinary bounded batch of twenty, four in flight, is unchanged.

`process_tournament_rebuy` locks the tournament row, so one event's purchases
are still one at a time in the database (mean 196 ms per call measured in
`pg_stat_statements`). Eight in flight hides the network round trip behind that
lock instead of paying it every four purchases.

Pinned by `server/src/tournament/TheAddOnBreakServesTheWholeField.test.ts`.

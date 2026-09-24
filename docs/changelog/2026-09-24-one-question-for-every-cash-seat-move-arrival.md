# One question for every cash seat move arrival (2026-09-24)

The 18:55 UTC engine release (run 36042895085) was the first to carry the
guard's progress record, and the record said where the twenty seconds went:

```
"reason":"inspector operation outcome unknown",
"progress":{"elapsedMs":663,"stage":"preflight","note":"proveBanksHeldNothing",
            "attemptedTables":0,"completedCalls":0,"verifiedTables":0}
```

The guard entered the residue row proof 663 ms in and never came back. The
Supabase edge logs for the same minute say why: 767 calls to
`fn_cash_seat_move_arrivals` between 18:55:11.975 and 18:55:24.755, eight at a
time - one per destination table an open seat of a residue player sat at -
thirteen seconds of the publisher's 20000 ms work budget. Every one returned
200 and the database side of each is under 10 ms (measured by EXPLAIN); the
cost was the round trips. The open-seat read, the moves read and the snapshot
reads each cost tens of milliseconds.

## The fix

The same question, asked once. `fn_cash_seat_move_arrivals_for_players(uuid[])`
(migration `20260924190214`) returns every cash seat move receipt for the
given players whose destination seat is still open: the same join, the same
`ENGINE_ONLY` gate, the same `SECURITY DEFINER` shape as the per-table
function, which is left exactly as it was for every other caller. The guard
asks it once per 500 residue players and filters the answer to the exact
(table, occupancy) pairs it holds no bank for - the union of the per-table
answers, so nothing the per-table question would have refused is admitted and
nothing it would have admitted is refused. Errors and full pages still refuse
and still name the read.

Until the function exists on the box, PostgREST answers `PGRST202` and the
guard asks the per-table question exactly as before, so a release that arrives
ahead of the migration is no worse off than it was. `bankDisposition` now
records which question was asked (`arrivalQuestion=perPlayer|perTable`) and
how many players.

## Pinned

`tests/legacyEngineCheckpointGuard.test.ts`: the question is asked once for
every residue player and never per table; an arrival into a seat the guard did
not ask about does not count; a box without the function is asked per table
exactly as before; a batched answer that errors refuses and names the read.
Every existing residue, transit and unreadable-read case now runs through the
batched path.

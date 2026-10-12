# The Welcome Reset Receipt Is Measured Against Two Snapshots

`Club Create Certification` was red on `main` for a fifth distinct cause tonight,
after four earlier ones were cleared: run 37088553929 (head `cda1656744`) died at

```
scripts/ci/certify-club-create.mjs:230, certifyWelcomeResetInsideRollback
Welcome Reset Receipt Did Not Name The Complete Independent Package Graph.
```

and the very next run, 37089969671, sailed past that same line and died further
down instead. Nothing in the script or in
`fn_remove_first_club_welcome_games` had changed between them. The assertion was
not measuring the reset. It was measuring whether the platform happened to be
still.

## The fifth cause: one assertion, two snapshots

`certifyWelcomeResetInsideRollback` opens one transaction and runs three things
in it as separate statements:

1. as `service_role`, read the club's whole game graph independently
   (`expected`: every `cash_games`, `tables`, `tournament_schedules` and
   `tournaments` row with this `club_id`);
2. as `authenticated`, call `fn_remove_first_club_welcome_games`;
3. read the result back.

The transaction is READ COMMITTED, so **each statement takes its own snapshot.**
Step 1 and step 2 do not see the same database, and the gap between them is tens
of seconds on a loaded box.

A first-club welcome package ships a `tournament_schedules` row, and a schedule
**spawns** tournaments, and their tables, in the background. This repo already
knows that: `20261002065156_welcome_certification_retires_idle_schedule_spawns.sql`
exists because the certification cleanup had to learn to retire them. So a spawn
that commits between step 1 and step 2 is invisible to `expected` and correctly
named by the receipt, because `fn_remove_first_club_welcome_games` collects
`tournaments WHERE schedule_id = ANY(v_schedules)` at its own, later snapshot.

The assertion compared the two with `sameIds`, strict set equality. A receipt
naming one spawn more than the preimage saw tripped it, with a message that reads
as an omission. That is why it was red on one run and green on the next, and why
re-running it looked like a fix.

## The fix

The guard keeps everything it was entitled to guard, and stops asserting a
property of the clock:

- **Completeness, unchanged in strength.** The receipt must name _every_ entity
  the independent preimage observed (`namesEveryId`). An omission is a reset that
  leaves a live welcome game behind, which is the defect this certification
  exists to refuse, and it still fails with the same message.
- **Honesty, newly guarded.** Every id the receipt names must be a row of this
  club, read back by `club_id` in the same transaction, or
  `Welcome Reset Receipt Named An Entity Outside The Certification Club.`
- **Nothing extra goes unchecked.** The zero-state readback is now driven by the
  receipt's own ids instead of the stale preimage's, so a spawn the reset removed
  is proved closed, dormant or cancelled like everything else. Under the old code
  a spawn was compared and then never state-checked at all.

Net: the chain is `preimage` subset of `receipt` subset of `this club`, with every
member of the receipt verified in the zero state. Strictly stronger than set
equality in the "nothing invented, nothing unchecked" direction, and no longer
dependent on nothing else committing while the probe runs.

## The sixth cause, found by getting past the fifth

Run 37089969671 reached step 3 and raised

```
error: column "id" does not exist   code 42703   position 1424
```

Position 1424 of that readback lands on
`SELECT id,status FROM public.managed_game_schedules`.
That table is keyed on **`schedule_id`**
(`20260902210000_table_management_scale_and_scheduling.sql`:
`schedule_id uuid PRIMARY KEY`). The column `id` has never existed on it. The
statement was simply never reached before, because every run in this family died
earlier. Fixed to `schedule_id`, in the projection and in the `ORDER BY`.

## Pinned

`tests/unit/clubCreateCertificationContract.test.ts` now pins the subset
comparisons, both failure messages, the receipt-driven readback and its four
length comparisons, and that `managed_game_schedules` is read by `schedule_id`
and never by `id`. Reverting either fix turns it red.

## Left alone

The same runs show `canceling statement due to statement timeout` on reads that
the script's transient retry absorbs. That is a database-capacity problem
(multixact SLRU buffers undersized), diagnosed separately, and it needs a
Postgres restart-level configuration change rather than code. It is not this
assertion failing, and nothing here tries to paper over it.

No migration: both defects were in the certification script.

# tests/the-display-stakes-follow-their-own-blinds.law.test.ts

## The law

`public.tables.stakes` must agree with the same row's `small_blind` and
`big_blind`, on every write path, for tournament tables. Cash tables are not
this law's subject and must be left alone.

## What went wrong

The only thing enforcing the invariant was `reconcile-tournament-denormals`, a
cron job running every minute whose second branch rewrote the column for
tournaments in `REGISTERING`, `ANNOUNCED` or `RUNNING`.

Measured 2026-09-19: 40,998 of 265,022 tournament tables (15.5%) carried a
`stakes` contradicting their own blinds, and every single one of them sat
outside that status filter. Inside it: zero. The job held the invariant exactly
where anyone would look for it and nowhere else.

28,651 of the bad rows read `undefined/undefined`, a JavaScript template
literal from `server/src/tournament/TournamentManagerBase.ts:6497` reaching the
database. That path stopped producing rows in May 2026; the rows remain.

## Why the existing authority did not hold

`20260913200859` added `fn_tournament_table_inherits_committed_blinds`, which is
the right idea. It had two holes:

1. `IF v_state IS NULL THEN RETURN NEW; END IF;` returned without deriving
   anything, and 167,997 tournaments have no `blind_level_state` (346 of them
   active).
2. It was registered `BEFORE INSERT` only, so it had never run on an UPDATE.

## How hole 2 was found

Hole 1 was fixed, every structural assertion passed, and the drift was
untouched. A behavioural probe then wrote `PROBE/WRONG` to a real row from an
ended tournament and read it back:

    PROBE FAILED: trigger did not normalise; stakes is still PROBE/WRONG

A structural assertion proves the text changed, not that the behaviour did.
That is why this law pins the trigger's EVENT list and not just its body.

## The band-aids that were refused

**A generated column** is the strongest form. `public.tables` is 222 MB over
272,707 rows with 20 indexes, and adding a stored generated column rewrites the
whole table under `ACCESS EXCLUSIVE` while 194 tables are dealing. It also
forbids every writer from supplying `stakes`, which means changing five
functions that currently do. Correct, and not safe while the felt is live.

**Adding `UPDATE` to the existing trigger** would take a `FOR SHARE` lock on
`public.tournaments` on every blind write, including the reconciler's own and
`fn_publish_tournament_blind_level`'s while it is already updating that same
tournament. Keeping a display string true to its own row does not need the
tournament at all, so the UPDATE trigger does no lookup and takes no lock.

**Widening the cron job** is the thing the standing brief forbids by name.

## Cash tables

Excluded in the `WHEN` clause and again in the function body. They use
`fn_cash_stakes_label` via `fn_cash_money_text`, and 1,017 of them carry a
`$0.05/$0.10` form the tournament expression would destroy. A fix that
"normalises stakes" everywhere passes a naive test and breaks them, so the law
asserts the exclusion in both places and asserts the ordering on the INSERT
side.

## Still open, deliberately

The 40,996 historical rows are not corrected here, and branch 2 of
`fn_reconcile_tournament_denormals` is not removed. Phase 3.3 of the standing
brief requires observing the compensation find zero work for a full cycle
before deleting it.

## Forward guard

Binds from 20260920. From then on, no migration may drop the UPDATE trigger
without recreating it in the same file, recreate it without the UPDATE event,
or recreate it without the cash exclusion.

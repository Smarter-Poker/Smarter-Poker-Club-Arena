# A pass commits what it did (2026-09-06)

## The defect

`fn_cash_clusters_tick_all` is one RPC per 5-second controller pass
(#3119). The engine calls it as `service_role`, whose `statement_timeout` is
pinned at 8 s (2026-08-31, the PGRST002 outage; not to be raised). Read from
`pg_stat_statements` at 09:40 CDT:

    calls 15,922   mean 1,187 ms   max 7,993 ms   total 18,902 s

and the engine log carried nine `ClusterController.pass_failed` rows
(`57014 canceling statement due to statement timeout`) in three hours. A pass
that crosses the ceiling is rolled back WHOLE: every game it ticked is
un-ticked, no feeder opens, no table breaks, no move is planned, and eight
seconds are gone. Nothing pages on nine an hour (`ClusterPassErrors` needs
ten in fifteen minutes), and nothing should; it is a tax, paid every twenty
minutes.

## What was measured

A rolled-back probe (psql, `BEGIN ... ROLLBACK`, 10:08 CDT) ticked every
enabled game in sequence:

    108 games   tick 2,652 ms   balance 185 ms   census 425 ms
    avg 25 ms a game   worst 675 ms (PLO6 1/2 Madness, 3 seated, 1 table)
    dormant 41 x 17.8 ms   live 67 x 28.7 ms

3.3 s for everything, with no contention. The 8-second passes are WAITING,
not work: the per-game tick takes `cash_games ... FOR UPDATE` and writes
`tables` and `table_seats`, rows the engine and the fleet write every second.

## What changed

Migration `20260906150956_a_pass_commits_what_it_did.sql`, re-declaring
`fn_cash_clusters_tick_all` from the live body (md5
`8dadda13170127ec2b571790d198d79e`, 20260906011318's; checked before writing,
as that migration's header asks). Two changes to the pass, none to
`fn_cash_cluster_tick` or `fn_cash_cluster_balance`:

1. **A budget.** The pass stops STARTING games at 5.5 s; a game already in
   its tick finishes. Games not started are `deferred`: counted, returned as
   identity rows beside `rested_games` (so the controller's row map knows
   them and a wake finds Main 1), and left with `last_tick_at` untouched.
   The budget is checked after the rest test, so a resting game is still
   `rested` and `deferred` means due-but-not-started. 5.5 s under 8 s leaves
   2.5 s, the worst measured game three times over.
2. **A lock bound.** `lock_timeout` is set transaction-locally to 2,000 ms
   before the loop. Unlike `statement_timeout` it is checked at each lock
   acquisition, so it can be set from inside the statement it governs. A
   game whose tick waits longer raises `55P03` inside its own sub-block, is
   rolled back alone, and lands in `cash_cluster_events` as a
   `controller_tick_error` naming the lock. The pass goes on.
3. **Oldest-ticked first.** The worklist was `ORDER BY g.created_at`; with a
   budget that would defer the same tail every pass. It is
   `ORDER BY g.last_tick_at NULLS FIRST, g.created_at` now, so a deferred
   game is first in line five seconds later.

Engine: `ClusterController` reads `deferred` and `elapsed_ms`, warns when a
pass deferred anything, and `ClusterMetrics` publishes
`poker_cluster_pass_deferred`. The pin in
`TheTablesOpenAndCloseThemselves.law.test.ts` moved to the new file
(`TICK_ALL_PASS`); `fn_cash_cluster_balance` is still pinned by the old one.

## Proof

Rolled back (10:11 CDT): the live pass and the new pass over the same
worklist in one transaction; the new one returned `deferred 0, elapsed_ms
3762`, `lock_timeout` read `2s` afterwards; with the budget forced to 0 ms
the pass ticked nothing, rested 43, deferred 65, and still returned identity
rows for all 108. Applied at 10:15 CDT and recorded under its own version:
54 games ticked in the next 20 s, zero `controller_tick_error` rows.

## What to watch

`poker_cluster_pass_deferred` after the :55 cutover. Zero is the normal
reading. A pass that defers occasionally is a slow database that committed
what it did. A pass that defers EVERY time is a controller running behind
its cadence, and then the per-game tick is the thing to profile
(`scripts/dev/probe-cluster-boards.sql` is the harness).

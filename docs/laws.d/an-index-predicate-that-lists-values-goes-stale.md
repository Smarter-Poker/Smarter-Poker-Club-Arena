# tests/an-index-predicate-that-lists-values-goes-stale.law.test.ts

Three scheduled jobs were `critical` in `fn_ca_cron_health()` on 2026-09-19,
each having run and never once succeeded:
`tourney_money_conservation_hourly` 24 runs 0 ok,
`ca-pay-backed-payout-shortfalls-hourly` 24 runs 0 ok, and
`tourney_money_conservation_deep_daily` 1 run 0 ok. All three died on a
statement timeout inside `fn_tournament_conservation_delta`, and
`cron.job_run_details` puts their last successes within minutes of each other on
2026-09-12, which is the day the `seat_income` term learned about tickets and
went from `source = 'satellite_seat'` to
`source IN ('satellite_seat','satellite_ticket')`. Nobody widened
`idx_tournament_payouts_satellite_target`, whose predicate still named one
value. A partial index whose predicate does not cover the query's cannot be used
at all, because the planner cannot prove the rows are in it, so the term read
all 161,772 rows of `tournament_payouts` per tournament, 200 tournaments an
hour. Nothing was wrong with the arithmetic; three money-conservation checks
simply stopped being affordable and produced no verdict for seven days. Widening
the predicate to match is not the fix and migration 20260919154808 says so in
its own header: it repairs today's query and leaves the next widening free to do
the identical thing silently, because the predicate is a copy of a value list
that lives in a function body and a copy of a fact goes stale. So 20260919155648
removes the predicate entirely; there is no list left to fall behind, and the
migration proves it by checking that a source value nobody has invented yet
still reaches the index, alongside the real 200-tournament workload timed
against the job's own 120s budget. Measured: over 120,000 ms and timing out
before, 207 ms after, and the hourly job then ran clean for the first time since
2026-09-12. The forward guard is that no later migration may give this index a
predicate again, because the next person here will be looking at a slow query
and a partial index is the obvious tool, and it is the tool that broke it.

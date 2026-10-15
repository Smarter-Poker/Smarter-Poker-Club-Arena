# The Currency Meter Reads What Is Owed, And Runs On Its Own

## What Broke

`ca-ledger-replay-nightly` (pg_cron job 286, 06:40 UTC) failed on 2026-10-14
at its 600 s statement timeout inside `fn_ca_currency_meter()`, in the agent
commission aggregate over the `agent_commissions_unsettled` view. The job ran
the ledger replay and the meter as one command, so one transaction: the
meter's timeout rolled that night's replay back too.

## Why

- 21.2 million `agent_commissions` rows have `settled_at IS NULL`, because a
  settlement records the period it covered and never stamps the rows. Only
  6,184,371 of them are owed.
- Migration 20261012181905 put `fn_ca_launch_accounting_accepts()` into the
  view. It is a SECURITY DEFINER SQL function with a `SET search_path`, which
  Postgres never inlines, so the aggregate made two definer calls per row over
  all 21 million rows.

## The Fix

Migration `20261015034439_the_currency_meter_reads_what_is_owed_and_runs_on_its_own`:

- The meter's commission statement reads the cutoff once per club, the
  complement of each agent's settlement periods as ranges, and one index-only
  range scan of `agent_commissions_open_idx` per uncovered range. Row for row
  it is the view's predicate. Read-only on production it matched the rollup to
  the cent and to the row (239 accounts, 6,184,371 rows, 0 drifted) in 90 s
  cold, and it grows with what is owed, not with history.
- The meter leaves job 286 for its own job, `ca-currency-meter-nightly`
  (07:20 UTC, 600 s), so the replay and the meter can no longer roll each
  other back.

## Pinned By

`scripts/ci/test-currency-meter-reads-what-is-owed.py` on native PostgreSQL
(workflow `currency-meter-reads-what-is-owed.yml`): the exact production meter
and job command, 40 randomized books where the new read equals the view per
club and agent, the meter's verdict unchanged, the derived postimage md5, the
split jobs, and a refused second run. The cron roster moves 133 -> 134.

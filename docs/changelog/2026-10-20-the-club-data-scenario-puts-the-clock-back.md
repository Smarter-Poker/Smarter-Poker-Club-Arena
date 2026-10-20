# The Club Data scenario puts the clock back (2026-10-20)

CI shard 2 ("Accounting transactions (PostgreSQL 17) shard 2/4") failed on every pull request between
00:00 and 02:00 UTC. The failure was job 118406110340 on #7519, at 01:40 UTC:

> club_table_daily rebuilt from facts differs from the live writers on 4 rows ... vs NULL

## Cause

`tests/fixtures/club-data-fact-db/scenario.sql` proves the seed reproduces what the triggers wrote. It
simulates two hours passing by moving every source row (`rake_records`, `wallet_transactions`,
`chip_ledger`, `table_seats`) back two hours. Then it re-seeds `ca_club_data_fact` from them.

The Report tables the live writers had already filled keep the day the rows were written. That covers
`club_table_daily` and the four `ca_club_*_daily` tables. The Report scenario then runs against the
same database. It compares those tables for their latest day with `fn_ca_reporting_rollups_from_facts`
of that day.

Near midnight UTC, the two hours moved the facts onto the previous day, so the rebuild found none.

## Not a product bug

The live writers and the rebuild both date a row by its own `created_at` in UTC. See
`(NEW.created_at AT TIME ZONE 'UTC')::date` in the writers and `(wt.created_at AT TIME ZONE 'UTC')::date`
in the rebuild, in 20261017204111. There is no club or report time zone on either side. Only the
harness's simulation moved one side.

## Fix

After its seed check, the fact scenario puts the clock back:

- the sources return to the instants the writers saw;
- `ca_club_data_fact` returns to what the triggers wrote, which the seed was just proved equal to.

The Report comparison is unchanged: still every column of all five tables, for the live day.

The fault was reproduced locally at 01:43 UTC with the identical error, and the harness passes after
the change. `scripts/ci/test-club-data-fact-db-postgres.py` passes too.

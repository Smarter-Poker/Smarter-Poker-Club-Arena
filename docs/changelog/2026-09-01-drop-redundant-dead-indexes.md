# Dropping the 130 redundant, never-scanned indexes

2026-09-01, authorised by Dan: "IF WE DON'T NEED THEM REMOVE THEM".

**Result: 130 of 130 dropped, 106 MB reclaimed, every one recoverable.**
`fn_redundant_dead_indexes()` now reports 0. Never-scanned droppable indexes fell
from 1,146 / 414 MB to **1,008 / 307 MB**; total indexes in `public` from 3,032 to
2,902.

## The criterion

Each index qualified on **both** counts, not either:

1. `idx_scan = 0` for the lifetime of the database, and
2. its key columns are a leading **prefix** of another btree index on the same
   table, neither index partial or expression-based.

(2) is what makes it safe rather than plausible: every query that could use the
narrow index can use the wider one, and the planner never once preferred the narrow
one. (1) alone is weak evidence; (2) alone would be wrong, because the narrow index
might be the one in use. None backed a constraint.

`idx_scan` was verified trustworthy first: `stats_reset IS NULL`, and there is **no
read replica** - 2 replication slots, both logical (`wal2json` + `pgoutput`,
Supabase Realtime), 0 physical. A physical replica keeps its own index stats and
would have made "never scanned here" meaningless.

## The first attempt deadlocked, and that was the useful part

```
40P01 deadlock detected
DETAIL: Process 1329679 waits for AccessExclusiveLock on relation 124761;
        blocked by process 1329705, which waits for AccessShareLock on 124689.
CONTEXT: SQL statement "DROP INDEX IF EXISTS public.idx_home_games_by_group_date"
```

It rolled back whole and dropped nothing, which is the correct outcome but not a
thing to simply retry. `DROP INDEX` takes ACCESS EXCLUSIVE on the parent table, and
one transaction dropping 130 of them holds every one of those locks until commit,
against a platform dealing ~221k hands a day. **The first version was a lock storm
dressed as a cleanup.** A queued ACCESS EXCLUSIVE is worse than a slow one: it
blocks every reader that arrives behind it, which is how an index drop becomes an
outage.

v2 takes the locks one at a time and refuses to wait:

- `SET LOCAL lock_timeout = '3s'` - a busy table loses _that_ index, immediately;
- each drop runs in its own PL/pgSQL subtransaction, so a timeout on one is caught,
  reported, and the other 129 still land;
- the ledger row and the drop share the subtransaction, so a failed drop cannot
  leave a ledger row claiming an index was removed.

129 landed. `idx_union_clubs_union` was skipped twice because `union_clubs` is
consulted on union attribution and stayed busy; it landed on the third pass. That
is the mechanism working, not failing.

## Reversibility is the point

Every index was written to `ca_dropped_index_ledger` with its exact
`pg_get_indexdef` output **before** being dropped. To restore any one:

```sql
SELECT ddl FROM ca_dropped_index_ledger WHERE index_name = '<name>';
-- then run it with CONCURRENTLY added
```

All 130 rows carry a usable `CREATE INDEX` statement; asserted in the migration.

## A mistake I made and then had to fix

`20260901125712` created `ca_dropped_index_ledger` with
`REVOKE ALL ... FROM PUBLIC` and granted SELECT to `service_role` - and asserted
nothing about the outcome. Checked afterwards,
`has_table_privilege('anon', 'ca_dropped_index_ledger', 'SELECT')` was still
**true**.

`REVOKE ... FROM PUBLIC` removes the grant held by the PUBLIC pseudo-role. It does
not touch grants held _directly_ by `anon` and `authenticated`, and Supabase's
`ALTER DEFAULT PRIVILEGES` hands those out on every new table in `public`. This is
the table-shaped twin of the Phase 3 function finding - and I walked into it while
writing the migration that cites that law.

No rows were exposed: RLS is enabled on the table and it has no policies, so `anon`
reads zero rows regardless. But the grant was wrong, and "RLS happened to save it"
is not the standard. Closed in `20260901130030`, and this time the migration
asserts `anon` and `authenticated` are false before it commits.

**The generalisable lesson: on this database, `REVOKE ... FROM PUBLIC` alone is
never sufficient for a new object in `public`. Name `anon` and `authenticated`
explicitly, and assert the result.**

## What is left

1,008 never-scanned indexes / 307 MB remain. They are _not_ redundant - no wider
index covers them - so "never scanned" is the only evidence against them, and that
is not enough on its own. `fn_redundant_dead_indexes()` will surface any that
become redundant later.

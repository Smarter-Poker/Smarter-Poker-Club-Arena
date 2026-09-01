# Proposal: drop 130 redundant, never-scanned indexes

Status: **APPLIED 2026-09-01.** Dan authorised it ("IF WE DON'T NEED THEM REMOVE THEM").
All 130 dropped, 106 MB reclaimed, every one recoverable from `ca_dropped_index_ledger`.
Kept as the written record of why they were safe to drop and how to put any of them back.
Author: Cowork Claude, 2026-09-01 (Phase 4).

## What

130 indexes in `public` are both never scanned and structurally redundant.
Dropping them reclaims 106 MB and removes 130 index maintenance operations from
the write paths of the tables that carry them.

The live list is always available - it is not a list that can rot:

```sql
SELECT * FROM public.fn_redundant_dead_indexes();   -- service_role
```

## The criterion, and why it is stronger than "unused"

An index qualifies only if **both** hold:

1. `idx_scan = 0` - it has never been scanned in the lifetime of the database, and
2. its key columns are a **leading prefix** of another btree index on the same
   table, with neither index partial (`indpred IS NULL`) nor expression-based.

Condition 2 is what makes this safe rather than merely plausible. Any query that
could use the narrow index can use the wider one instead; the planner's only reason
to prefer the narrow one is that it is smaller, and it has never once done so.
Condition 1 alone would be weak - an index may exist for a monthly report or a path
not yet exercised. Condition 2 alone would be wrong - the narrow index may be the
one actually in use.

None of the 130 backs a constraint: 0 rows in `pg_constraint.conindid` and 0
internal `pg_depend` edges.

## Why `idx_scan` is trustworthy here

Two things had to be checked first, because either would have made these counters
a lie:

- `pg_stat_database.stats_reset IS NULL` - the counters are lifetime, never reset.
- **There is no read replica.** `pg_stat_replication` shows one connection, which
  looks like a replica, but `pg_replication_slots` shows 2 slots, both **logical**
  (`wal2json` + `pgoutput` - Supabase Realtime decoding WAL) and **0 physical**. A
  physical replica keeps its own index statistics, and "never scanned on the
  primary" would have meant nothing.

## The prize is write amplification, not disk

414 MB of never-scanned droppable indexes in a 108 GB database is 0.4% - disk is
not the argument. Every index on a table is maintained on every insert, update and
delete. 103 MB of the 106 MB reclaimed is a single index:

| index          | table               | size   | scans | covered by            | coverer scans |
| -------------- | ------------------- | ------ | ----- | --------------------- | ------------- |
| `idx_ssg_game` | `solved_spots_gold` | 103 MB | 0     | `idx_ssg_next_street` | 1,140,656     |

The remaining 129 are 8-16 kB each. Their value is not space; it is 129 fewer
things maintained on write and 129 fewer things to reason about.

## One honest caveat

`idx_venue_reviews_venue_categories` carries INCLUDE columns its coverer lacks, so
dropping it removes a potential index-only-scan path. It has never been scanned in
the lifetime of the database, so nothing relies on it today - but that is the one
entry whose redundancy is behavioural rather than purely structural. It can be held
back without affecting the other 129.

## Safety of the migration itself

The prepared migration:

1. carries the explicit 130-name list, reviewed by name, so the change is auditable
   in review rather than being a black-box sweep;
2. **re-evaluates the full predicate against the live catalog at apply time** and
   drops only entries that still qualify, so an index that started being used
   between measurement and apply is skipped and reported rather than destroyed;
3. writes every dropped index into `ca_dropped_index_ledger` with the exact
   `pg_get_indexdef` output **before** dropping it, so each one is recreatable:

   ```sql
   SELECT ddl FROM ca_dropped_index_ledger WHERE index_name = '<name>';
   ```

4. aborts if more than 5 of the 130 no longer qualify, on the grounds that the
   analysis behind the list would then be wrong.

Nothing in it is unrecoverable.

## Why it is not applied

A destructive sweep across 130 production indexes is a decision, not a chore, and
this estate's own history is the argument for asking. On 2026-08-31 the previous
agent stopped short of bulk-closing 55 pull requests on a criterion that had been
right 9 times out of 9, precisely because being right nine times is not the same as
being right the tenth. `#1971` was the tenth.

The same reasoning applies here. Say the word and it goes.

# Eliminating One Player Read 3 GB Of Ledger To Ask "Did They Rebuy"

**2026-09-12** · `fn_eliminate_tournament_player_atomic`, `chip_ledger`

## 2.3 Seconds To Bust One Player

From `pg_stat_statements`:

|       |                                             |
| ----- | ------------------------------------------- |
| calls | 45,639                                      |
| mean  | **2,290.6 ms**                              |
| max   | **7,968.0 ms**                              |
| total | 104,541.9 s — **29 hours of database time** |

The max is the statement timeout, and the engine log shows what reaching it
costs:

```
[Tournament.elimination_write_failed] atomic elimination FAILED for 2d6c5e7a
at place 395 after exact transport replay:
canceling statement due to statement timeout
```

The function takes `FOR UPDATE` on the tournament row, so eliminations within
one event are strictly serial. At 2.3 seconds each, a field busting in bursts
queues until the ones at the back hit the timeout and are **never eliminated at
all**. They stay `status='playing'` holding zero chips, the event can never count
down to one player, and it hangs with its prize pool unpaid.

Measured the same day: **30 MTTs RUNNING for over six hours**, the oldest three
days and six hours, holding **15,570.00 of buy-ins across 1,485 players**, of
whom **1,397 hold zero chips** and have simply never been eliminated. Small
fields finish normally. The failures are at place 395.

## Where The 2.3 Seconds Went

The rebuy check. `EXPLAIN (ANALYZE, BUFFERS)` against production, one probe:

```
Index Scan using idx_chip_ledger_from_entity_created on chip_ledger l
  (actual time=429.626..429.626 rows=0 loops=1)
  Index Cond: (from_entity_id = ...)
  Filter: (amount > 0 AND tournament_id = ... AND category = 'rebuy'
           AND from_type = 'player_wallet' AND to_type = 'prize_liability'
           AND status = 'posted')
  Rows Removed by Filter: 644
  Buffers: shared hit=317 read=333
Execution Time: 429.771 ms
```

**429 ms to return nothing.** The only usable index was
`(from_entity_id, created_at DESC)`, so Postgres walked every ledger row that
player had ever written and discarded all 644 in the heap, reading 333 blocks
off disk to do it. `chip_ledger` is 3,506,751 rows and 3,050 MB.

That probe sits inside a correlated `EXISTS` that runs per knockout candidate, so
a handful of them is the whole 2.3 second mean.

## The Index

Partial, on exactly the four constants the probe fixes.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_rebuy_probe
  ON public.chip_ledger (from_entity_id, tournament_id, created_at)
  WHERE category = 'rebuy'
    AND from_type = 'player_wallet'
    AND to_type = 'prize_liability'
    AND status = 'posted';
```

`category = 'rebuy'` is 14,468 rows of 3,506,751 — **0.41% of the table** — so the
index is small and the write cost on the money path is negligible. `created_at`
is third because the probe also bounds the row to a window between two knockout
candidates, so the range is answered from the index rather than the heap.

`CONCURRENTLY` because `chip_ledger` is the money ledger of a live platform and a
plain `CREATE INDEX` would hold a write lock over 3 GB while it built.
`statement_timeout = 0` for the same reason every other concurrent index in this
directory sets it.

## Measured After

Same probe, same production database, immediately after the build:

```
Index Scan using idx_chip_ledger_rebuy_probe on chip_ledger l
  (actual time=1.164..1.164 rows=0 loops=1)
Execution Time: 1.277 ms
```

|                            | Before     | After        |
| -------------------------- | ---------- | ------------ |
| Probe                      | 429.771 ms | **1.277 ms** |
| Rows discarded in the heap | 644        | 0            |
| Blocks read from disk      | 333        | 0            |
| Index size                 | —          | **848 kB**   |

**336 times faster.** The planner chose it without a hint.

## What This Does Not Change

Nothing about the function. Same question, asked of an index that can answer it.
The `FOR UPDATE` serialisation stays, and so does every check in the elimination
path; they simply stop queueing behind a 3 GB scan.

It also does not, by itself, unstick the thirty tournaments already hung — their
busted players still have to be eliminated, and that backlog runs through a
four-slot scheduler. What it does is stop new ones joining them.

## Applied

Applied to production 2026-09-12 12:10 UTC via psql, because
`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block and the
migration tool wraps one. Recorded in `supabase_migrations.schema_migrations` as
`20260912121000`.

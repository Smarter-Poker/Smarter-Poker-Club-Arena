# The bounty evidence read stops at the seat

2026-09-09

## The defect

`loadPersistedBountyEvidence` proves a bust before a bounty elimination is
allowed to mutate anything. It asked:

```
table_id = ?  AND status = 'succeeded'
AND result @> '{"written":{"<user>":0}}'
ORDER BY completed_at DESC LIMIT 1
```

`settlement_idempotency_keys` is **4,409,643 rows / 3,172 MB** and carried only
its primary key `(table_id, hand_id)` plus a partial index on in-flight rows. So
`table_id` was indexable and nothing else was. Every settlement a table had ever
written was read off disk, JSONB-matched, and sorted.

Measured on production, table `bd52ccec` with 5,617 settlements:

```
Index Scan using settlement_idempotency_keys_pkey
  Index Cond: (table_id = ...)
  Filter: (result @> ...) AND (status = 'succeeded')
  Rows Removed by Filter: 5613
  Buffers: shared hit=2599 read=3156
Execution Time: 8523.518 ms
```

**`service_role`'s statement timeout is 8s.** So that read did not return
slowly - it _errored_. `defer()` re-armed, the next sweep ran the same query,
and it errored again. Every bust in a bounty event on a long-running table was
in that loop, permanently.

## What it cost

Read at 06:58 the same morning: **sixteen RUNNING tournaments had dealt no hand
for over an hour**, and ten of them were bounty events:

| tournament                       | stalled | playing | at zero chips |
| -------------------------------- | ------- | ------- | ------------- |
| `Afternoon Bounty (NLH)`         | 815m    | 13      | 9             |
| `Union PKO Afternoon (PLO4)`     | 718m    | 18      | 13            |
| `Evening Mystery Bounty (PLO5)`  | 701m    | 7       | 2             |
| `Union Mystery Bounty (PLO5)`    | 569m    | 8       | 2             |
| `Union Grand Championship (NLH)` | 495m    | 8       | 1             |
| `Late Night PKO (PLO4)`          | 492m    | 9       | 5             |
| `Night Owl Special (NLH)`        | 465m    | 14      | 8             |
| `Night Owl Special (NLH)`        | 350m    | 8       | 4             |
| `DSS Tuesday Bounty Hunter`      | 345m    | 15      | 12            |
| `Pre-Dawn Mystery Bounty (PLO5)` | 105m    | 7       | 3             |

In every one of them, the count of pending knockout candidates equalled the
count of players sitting at zero chips exactly. Those players could not be
eliminated, so they kept their seats, so **no table could reach two live players
and no hand could be dealt at all**. The events were not slow. They were over,
and could not say so.

## The fix, in two halves

### 1. The read stops where it was already required to stop

```ts
.eq('status', 'succeeded')
.gte('completed_at', seatJoinedAt)   // new
.contains('result', { written: { [userId]: 0 } })
```

**This is not a new rule.** Twenty lines below the read, a settlement older than
`seatJoinedAt` is already refused - "accepted zero-stack settlement predates this
seat generation" - because a rebuy starts a new seat generation and an older zero
must never authorise it. Every row before the seat was being read off disk and
then thrown away by that guard. The bound simply moves the condition into the
query, so it cannot change which row is chosen: the rows it no longer reads are
exactly the rows already refused.

### 2. An index shaped like the question

```sql
CREATE INDEX CONCURRENTLY idx_settlement_idem_table_completed_succeeded
  ON public.settlement_idempotency_keys (table_id, completed_at DESC)
  WHERE status = 'succeeded';
```

Both the equality and the range become an `Index Cond`, and the sort disappears.
Measured after, same table, same user:

```
Index Scan using idx_settlement_idem_table_completed_succeeded
  Index Cond: ((table_id = ...) AND (completed_at >= ...))
  Rows Removed by Filter: 1156
  Buffers: shared hit=69 read=1093
Execution Time: 88.536 ms
```

**8,523 ms -> 88.5 ms, a factor of 96**, with room for a table an order of
magnitude older than this one.

## For the next person who builds an index through the Supabase MCP

Written down because the first attempt failed and the failure mode is nasty:

- the MCP session's `statement_timeout` is **2 minutes**, and it does **not**
  survive between calls - `SET statement_timeout` then `SHOW` on the next call
  reads `2min` again;
- `CREATE INDEX CONCURRENTLY` cannot be combined with a `SET` in one call,
  because multi-statement calls are wrapped in a transaction (`25001: CREATE
INDEX CONCURRENTLY cannot run inside a transaction block`);
- when the first attempt timed out it left the index **`indisvalid = false` at
  168 MB**, which is strictly worse than no index: the planner ignores it and
  every write still maintains it. Check `pg_index.indisvalid`, `DROP INDEX
CONCURRENTLY`, and retry. The retry succeeded.

The migration records the index **without** `CONCURRENTLY` and with
`IF NOT EXISTS`, the same pattern as
`20260903152934_the_guarantee_exposure_scan_reads_140_rows_not_25851.sql`: a
rebuild from these files has no concurrent traffic to protect, and
`CONCURRENTLY` cannot run inside a migration's transaction.

## Pinned

`server/src/tournament/theBountyEvidenceReadStopsAtTheSeat.test.ts` - eight
pins, windows bounded by structure:

- the read carries the seat bound;
- it still asks for the newest single match under the same predicates;
- **the seat-generation guard that the bound mirrors is still there** - if that
  guard is ever removed the bound stops being equivalent and becomes a behaviour
  change, so they are pinned together;
- an unreadable answer still defers rather than reading as "no evidence"
  (CLAUDE.md 10.86 rule 2: UNKNOWN is not NONE - the refusal was always correct,
  it was the infinite retry that was the defect);
- the index is recorded in a migration, with the right columns and predicate;
- the recorded copy does not try `CONCURRENTLY` inside a transaction;
- the header still explains how production got it, including the invalid-index
  trap.

## Verification

- `npx tsc --noEmit` in `server/`: clean.
- `npx vitest run src/tournament`: **117 files, 1215 tests, all passing.**
- `tests/unit/noFixedSizeSourceWindows.test.ts`: passing.
- Production: index built `CONCURRENTLY`, verified `indisvalid = true`, 168 MB,
  and the plan above re-measured through it.

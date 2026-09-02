# The bust sweep scanned every live seat on the platform

2026-09-01. Phase 5, found by asking `pg_stat_statements` what production
actually spends time on rather than reading a linter.

## The measurement

| calls  | mean  | total       | statement                         |
| ------ | ----- | ----------- | --------------------------------- |
| 68,049 | 45 ms | **3,085 s** | the elimination sweep's seat read |

That is the largest single component of the 6% of all database time that
`table_seats` reads account for.

## What it was doing

`TournamentManagerEliminations` read the tournament's seats like this:

```ts
.select('user_id, stack, joined_at, tables!inner(tournament_id)')
.eq('tables.tournament_id', this.tournamentId)
.is('left_at', null)
.order('user_id', { ascending: true })
.range(page * 1000, page * 1000 + 999);
```

PostgREST compiles an embedded `!inner` resource to a LATERAL join, and the
**outer** table carries no tournament predicate at all:

```sql
FROM table_seats
INNER JOIN LATERAL (SELECT 1 FROM tables
                    WHERE tables.tournament_id = $1
                      AND tables.id = table_seats.table_id) ON true
WHERE table_seats.left_at IS NULL
ORDER BY table_seats.user_id LIMIT 1000
```

So every call walked **every live seat on the platform** and probed `tables`
once per seat, discarding the ones belonging to other tournaments. Under an
inner join with a LIMIT it cannot stop early either. 811 live seats today, but
207,451 rows in the table and the cost scales with the platform, not with the
tournament.

**The previous author was not wrong.** The comment above this code records why
it became one query: it used to be a `for (const [tableId] of this.tableEngines)`
loop doing one round trip per table, which made a 37-table field take 5.5
seconds and miss its own 5-second interval, and which was blind to any table
this process held no engine for. Reading by `tournament_id` fixed both. Only the
SHAPE of the read was wrong, and the fix here keeps the coverage exactly.

## What it does now

Two reads, each hitting an index that already existed and is already hot:

| read                        | index                      | lifetime scans |
| --------------------------- | -------------------------- | -------------- |
| `tables` by `tournament_id` | `idx_tables_tournament_id` | 946,647        |
| `table_seats` by `table_id` | `idx_table_seats_table`    | 131,417        |

The `IN` list is chunked at 200; the largest field on record is 1,076 tables,
and an unbounded `IN` list is its own outage.

## The correctness bug found alongside it

The old read paged with `.order('user_id')`. **`user_id` is not unique in
`table_seats`** - the duplicate-seat handling directly above this code exists
precisely because one user can hold several open seats, and it documents
1,461,180 chips being double counted by that same fact.

Two seats of the same user straddling a 1000-row page boundary can be returned
twice or not at all, depending on how Postgres breaks the tie. This sweep is
what decides who is eliminated. It now pages on `id`, the primary key.

This is the same class of bug `server/src/services/PagedReadsAreDeterministic.law.test.ts`
was written for; that law only covers `HorseSelfTuner.ts` and
`TournamentRecurringService.ts`, so this file was never checked.

## Verification

- `tsc --noEmit` clean, server and client
- 55 tournament test files, 659 tests, 0 failures
- Pinned by `server/src/tournament/eliminationSweepReadsAreIndexed.law.test.ts`,
  verified red-before-green: restoring the old query turns all four pins red.
- The law is scoped to the sweep only. `tournamentTableForUser` and
  `lastTournamentTableForUser` further down the same file use the same
  `tables!inner` embed **legitimately** - they filter `.eq('user_id', userId)`
  first, which is selective and indexed. The bug is an inner embed with no
  selective predicate on the outer table, not the embed itself.

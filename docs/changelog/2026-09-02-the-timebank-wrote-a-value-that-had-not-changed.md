# The time bank wrote a value that had not changed, 408,000 times

Date: 2026-09-02
Branch: `fix/the-timebank-writes-a-value-that-did-not-change`

## What the profile said

The single largest consumer of this database is not a query anybody wrote:

```
realtime.list_changes   15,080 calls   mean 460 ms   17.46% of ALL database time
```

That is Supabase Realtime decoding the write-ahead log and running
`realtime.apply_rls` for every subscriber. A 460 ms mean means Realtime is
running behind, and Realtime running behind is felt at the table as lag.

I first read that as a table-count problem - 114 tables in the
`supabase_realtime` publication against 65 live subscriptions - and it is not.
Measured by write volume, the 19 published tables with no subscriber anywhere
in either repo account for **0.01%** of published writes. Dropping them would
have saved nothing. The cost is not how many tables are published, it is how
many rows change on the busy ones:

| Table                | Share of published writes |
| -------------------- | ------------------------- |
| `table_seats`        | **36.19%**                |
| `table_hole_cards`   | 35.28%                    |
| `tournament_players` | 9.31%                     |
| `tables`             | 8.35%                     |

And inside `table_seats`, one statement:

```
UPDATE table_seats SET time_bank_remaining    408,121 calls   1,389,020 ms
```

**98.7% of every write to that table**, and therefore roughly a third of
everything Realtime decodes.

## Why it was happening

`syncStacks` persists the non-money seat fields after a hand settles, and it
did so for every seated player on every hand:

```ts
.update(payload)
.eq('table_id', tableId)
.eq('user_id', p.user_id)
.is('left_at', null);
```

A time bank only moves on the hands where somebody actually burns it. Live
values are stable and clustered - 28% of seats sit at 0, the rest at the pool
size for their format (20, 30, 40 ... 160). So the overwhelming majority of
those 408,121 statements set a column to the value it already held.

Postgres barely notices. Realtime does: `table_seats` is in the publication, so
each of those no-op writes produced a WAL record that had to be decoded and
RLS-filtered for every subscriber watching the table.

## The change

One clause. The UPDATE now matches only when something actually differs:

```ts
.or(timeBankChangedFilter({ ... }))
// time_bank_remaining.neq.30,time_bank_remaining.is.null,
// time_bank_uses_remaining.neq.3,time_bank_uses_remaining.is.null
```

If neither column differs, zero rows match, Postgres writes nothing, and no WAL
record exists to decode.

**It is a filter, not a diff held in memory.** That matters: there is no cache
to go stale, it is correct across an engine restart, and it is correct against
any concurrent writer. A genuine change still writes exactly as it did before.

Semantics proved read-only against production before writing any code - an
unchanged pair matches 0 rows, a changed pair matches 1.

## The `is.null` arm is not decoration

PostgREST `neq` uses SQL three-valued logic, so a NULL column does **not**
satisfy `neq` and the row would be filtered out - silently skipping a write
that is genuinely needed, which after a restart would hand a player back a time
bank they had already spent.

Both columns are NOT NULL with defaults today (`20260313_time_bank_*`, pinned
by `RestartFidelity`), and production currently holds zero NULLs in either. The
`is.null` arm is what keeps the guard correct if that ever stops being true.

## What is pinned

`TimeBankWritesOnlyWhatChanged.test.ts`, six properties, all aimed at the
dangerous direction - which is not "writes too often", it is a filter that
fails to match when a value HAS changed:

- a differing value matches;
- either column differing is enough (it is a disjunction, not a conjunction);
- every filtered column carries its `is.null` arm;
- it never filters on a column it is not writing;
- **zero is a real value, not absence** - 28% of live seats sit at 0, and an
  `if (x)` test would have dropped the guard for all of them;
- an empty write applies no filter at all.

`RestartFidelity.test.ts` and `RestartFidelity.behaviour.test.ts` run green
alongside it: 31 tests, 3 files.

## What this does NOT touch

No schema change, no new column, no deadline. That matters because CLAUDE.md
13.4 requires any new wall-clock deadline a player can lose to be added to
`fn_thaw_platform` in the same pull request - the maintenance break would
otherwise eat five minutes of it. This change introduces no such deadline, so
that obligation does not arise. The stored `time_bank_remaining` remains the
same integer with the same meaning; it is simply not rewritten when it is
already correct.

## How to tell it worked

`realtime.list_changes` should fall well below 17.5% of total database time and
its 460 ms mean should come down. In `pg_stat_statements`, the
`SET time_bank_remaining` call count should drop from ~408k toward the number
of hands on which a time bank was actually used.

The next-largest target after this is `table_hole_cards` at 35.28%, which is a
genuine insert per player per hand and so a different kind of problem.

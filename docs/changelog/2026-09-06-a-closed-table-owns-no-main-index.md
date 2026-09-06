# A closed table owns no main index, and the guard now watches the write that stamps one

2026-09-06. Migration `20260906090311_a_closed_table_owns_no_main_index.sql`,
law `tests/aClosedTableOwnsNoMainIndex.law.test.ts`.

## The general lesson, first, because it is bigger than this table

**A guard whose trigger column list is narrower than the invariant its
function enforces is a guard that reads as armed while being unreachable.**

`pg_get_triggerdef` prints it. `tgenabled` says `'O'`. The catalogue says the
object exists. Every review that asks "is the guard there?" gets yes. And it
never fires for the write that actually breaks the rule, because that write
touches a column the trigger was not told to watch. The function is not wrong,
the trigger is not disabled, and nothing anywhere is red. This is the same
family as the three armed-but-unreachable guards recorded in the
engine-restart handoff, and it is worth checking for by hand: for every
`BEFORE ... UPDATE OF <cols>` trigger, the columns the FUNCTION READS must be
a subset of the columns the TRIGGER WATCHES.

## What happened, measured

`20260905155400` created `fn_closed_cluster_main_releases_index` to hold one
invariant: a cluster table that is closed or soft-deleted carries no
`main_index`. It nulled every row that already broke it, and its own assertion
passed when it ran.

Its trigger was:

```sql
BEFORE INSERT OR UPDATE OF lifecycle, is_deleted
```

That is the event that CLOSES a table. It is not the event that STAMPS one. A
renumber pass writes `main_index` and `name` and touches neither watched
column, so the trigger never fired and a closed row silently acquired an index.

Read on 2026-09-06: **2,935 closed tables carried a `main_index` again.** Every
one of them

- belonged to ONE game, `37ac7634` (NLH 0.05/0.10 Classic) - the game whose R3
  repair had looped and opened 3,000 Main 1 tables between 08:01 and 10:29 CDT
  on 2026-09-05, before `20260905194329` fixed the loop;
- had `role = 'main'` and a `main_index` from 2 to 2993, sequential, which is
  the shape of a renumber over every table of a game in creation order;
- was written at exactly **2026-09-05 10:57:38 CDT**, one statement, three
  minutes AFTER `20260905155400` had nulled them.

No other game had a single such row. 542 closed cluster tables correctly held
NULL. Nothing has been stamped since.

## What the migration did

1. Re-created the trigger over **`lifecycle, is_deleted, main_index,
cluster_id`**. Those four are every column whose write can put an index on a
   closed cluster table: closing it, deleting it, stamping it, or making it a
   cluster table while it already carries one. The function body was not
   touched.
2. Nulled the 2,935 rows. An UPDATE of one column to NULL, never a DELETE: the
   rows are real closed tables carrying real hand and seat history, and only
   the stamp was wrong.

Verified live after apply: **0** stale rows, every enabled must-move game has
exactly one live Main 1, 109 live tables hold an index, 0 tick errors.

## Why it is two transactions, and why that must not be undone

The first attempt put the trigger DDL and the repair UPDATE in one transaction
and **deadlocked** against the cluster controller. Any trigger change on
`public.tables` needs an ACCESS EXCLUSIVE lock; the tick writes that table
every five seconds; a transaction that already holds something else can
deadlock rather than simply wait. Nothing applied - it rolled back whole.

The shipped file is therefore:

- **Transaction 1, the data.** It touches only rows that are already closed,
  which the tick never writes, so it takes no lock the controller wants.
- **Transaction 2, the DDL, holding nothing else.** It opens by asking for the
  table lock explicitly, `LOCK TABLE public.tables IN ACCESS EXCLUSIVE MODE`,
  under a 4s `lock_timeout`. Holding nothing, it can only wait for a quiet
  moment between ticks or fail immediately having held nothing, which cannot be
  half of a cycle.

It took two runs in practice: the first got the data and timed out on the lock,
the second got the window. That is the design working, not a failure - a
timeout there costs a re-run of one idempotent transaction, where a deadlock
cost the whole migration.

The law test pins this shape, not just the column list: the DDL must stay in
its own transaction, must take ACCESS EXCLUSIVE before the DROP TRIGGER, must
set `lock_timeout`, and must not carry the UPDATE.

## Why not a CHECK constraint

It would be stronger, and it is deliberately not there. `public.tables` is
172,072 rows and 110 MB and the cluster controller writes it every five
seconds; on 2026-09-05 a `CREATE UNIQUE INDEX` on this same table deadlocked
against that tick and rolled a migration back whole. A BEFORE trigger nulls the
value before any constraint is evaluated, so a CHECK could only ever fire if
the trigger were dropped - it would buy the guarantee that the trigger still
exists, at the price of a second ACCESS EXCLUSIVE lock on a hot table. The repo
holds that guarantee more cheaply: the law test pins the trigger's column list,
so it cannot be narrowed again without a red test.

## How to verify

```sql
select count(*)
  from tables
 where cluster_id is not null
   and main_index is not null
   and (lifecycle = 'closed' or coalesce(is_deleted, false));
```

Must be **0**.

And the trigger itself:

```sql
select pg_get_triggerdef(oid)
  from pg_trigger
 where tgname = 'trg_tables_closed_main_releases_index';
```

must name all four of `lifecycle`, `is_deleted`, `main_index`, `cluster_id`.

## No new schema objects

The migration re-creates an existing trigger and updates rows. It creates no
table, function or column, so nothing is declared in
`scripts/ci/schema-manifest.d/` - those manifests track tables, functions and
columns, and a re-declared trigger is none of them.

# The chip circulation proof reads one snapshot

2026-10-04. Diamond Arena, Phase 9, cross-format conservation. The migration
that teaches the three chip circulation readers to count no Diamond is applied
and live. It could not be applied as merged, and this is what was wrong with
it, what changed, and what was measured.

## What was blocked

`20261004124546_the_chip_circulation_marks_count_no_diamond.sql` merged on
`main` and was dispatched twice through `apply-merged-migration.yml`. Both
times it **refused itself** and rolled back cleanly, its own section 4
post-image assertion firing. Verbatim:

```
attempt 1 (run 37210153821):
ERROR P0001: the chip member wallet total moved: 174066724.55 -> 174066739.55

attempt 2 (run 37210433597):
ERROR P0001: the chip supply measurement moved: club 174066957.78 -> 174066957.78,
  cash 86094.98 -> 86094.98, tourney 8039400.00 -> 8039400.00, seats 1632 -> 1631
```

Attempt 2 is the whole diagnosis. Every money figure held **identical to the
cent**. The only thing that changed was `seats 1632 -> 1631`: one player stood
up during the 334 ms the transaction was open.

The substance of that migration was never in question. It is launch critical:
`fn_ca_circulation_total()` sums a chip figure and a Diamond figure into one
number, and that number is what `fn_ca_record_break_scorecard` uses to decide
whether the hourly platform freeze conserved. Once a Diamond sits on a seat,
the break records "chips did not conserve" when no chip moved.

## The cause

Section 0 captured absolute figures into a temp table `ca_p9b_before`. Section
4 re-read the same figures **after** the substitutions and required equality.
Those are two statements at two instants, and at the default READ COMMITTED
each statement takes a new snapshot. So the assertion conflated two claims:

- the claim that matters: **this migration's filter changes no chip figure**;
- the claim it actually tested: **no unrelated player did anything anywhere on
  the platform while my transaction was open**.

The second can essentially never hold on a live floor where horses sit, stand
and rebuy continuously. 1632 live seats were on the felt when it ran.

## The fix, and why it is stronger rather than looser

`20261004194622_the_chip_circulation_proof_reads_one_snapshot.sql` carries the
whole of the superseded file unchanged: the same three readers, the same three
md5 pins, the same clause occurrence counts, the same reverse substitution
checks, the same refusals (a Diamond switch already on, a live Diamond seat, a
diamonds club membership carrying chips, no diamonds club, any pinned md5
drifted, the report losing or gaining a chip club, the Diamond identity whole,
the watched guards on their baseline) and the same closing block. Not one money
comparison was deleted, loosened, widened or given a tolerance. The three
amount comparisons held perfectly on production and are the evidence that the
change is correct.

What changed is **how** the proof is read. Every comparison now reads the
filtered figure and the unfiltered figure **inside a single SQL statement**. A
single statement is evaluated against a single snapshot even at READ COMMITTED,
so `raw` and `filtered` computed as subqueries of one `SELECT` cannot be
separated by concurrent churn, and their equality is a statement about this
migration's filter and about nothing else.

Where the substituted reader can be called, it **is** called, inside the
comparing statement, so the new function text is exercised rather than assumed:

| reader                       | how it is proved                                                                                                   | why                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_ca_circulation_total()`  | called; its three outputs and the three unfiltered expressions its pinned text was built from read in one `SELECT` | STABLE, so a call inside the statement uses the calling statement's snapshot                                                                                                                                                           |
| `fn_club_chip_circulation()` | called; its rows `FULL JOIN`ed against the per club aggregates computed raw, in one statement                      | STABLE; and this is **more** than before, which only counted the rows. Every chip club's name and all four figures are now compared, no chip club may be missing, no row may exist without a club, and no diamonds club may be present |
| `fn_snapshot_chip_supply()`  | not called; its four measurements read unfiltered and filtered as eight subqueries of one statement                | VOLATILE and it **writes** a snapshot row. CLAUDE.md 11.5: never probe a money path in a way that commits. Its own new text is executed for real in the isolated fixture instead                                                       |

Two assertions were added rather than assumed, which is CLAUDE.md 10.86 rule 1
applied to this proof:

- the migration refuses if either called reader is **not STABLE**
  (`provolatile <> 's'`), because the one snapshot property the whole section
  rests on would silently stop holding if one became VOLATILE;
- it refuses if any figure reads as **NULL**, because a figure that could not
  be read is not a figure that did not move.

The seat count is still compared. It is simply compared against itself at the
same instant, which is the comparison the superseded file meant to make.

## Why not REPEATABLE READ, measured and not assumed

`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` as the first statement after
`BEGIN` was the obvious alternative. Two things were measured on an isolated
PostgreSQL 17.11 before choosing against it.

**1. It would take effect.** `scripts/ci/apply-recorded-migration.mjs` sends
the whole file as one simple query (`client.query(sql)`) and does **not** wrap
it in a transaction of its own, so the file's own `BEGIN` is the real
transaction start. Measured, sending a multi statement simple query:

```
BEGIN; SET LOCAL lock_timeout='3s'; SELECT current_setting('transaction_isolation');
  -> read committed
BEGIN; SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; SET LOCAL lock_timeout='3s'; SELECT ...
  -> repeatable read
BEGIN; SELECT 1; SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; ...
  -> ERROR: SET TRANSACTION ISOLATION LEVEL must be called before any query
```

So it works, and it would have to be the first statement.

**2. It would introduce a new false refusal in this very file.** Under
REPEATABLE READ the **data** snapshot is pinned at the first statement while
**catalog** lookups stay current. Measured: inside one REPEATABLE READ
transaction, a second session replaced a function and updated the table row
holding its hash; the transaction then read the OLD stored hash
(`9a97c375da54402928ed1e0322a26f3e`) and the NEW `pg_get_functiondef` text
(`9497bd4d46c1ef69f9046a8325e1b4de`), disagreeing with each other while the two
agreed in reality.

Section 5 of this migration compares `ca_guard_defs.def_hash` (data) against
live `pg_get_functiondef` (catalog) for every watched guard. Other lanes apply
guard migrations on this estate continuously, so REPEATABLE READ would make a
concurrent lane's correctly paired redefinition read as `watched guards off
their baseline` and abort this file for something nobody did wrong. That is the
same class of defect as the one being fixed, an assertion that answers about
someone else's work, so it was not added. The single statement comparison needs
no isolation level at all and is unaffected by how the applier transmits the
file.

## The superseded file

`20261004124546_the_chip_circulation_marks_count_no_diamond.sql` keeps its
bytes and gains a header: `-- SUPERSEDED BY 20261004194622
(the_chip_circulation_proof_reads_one_snapshot)`, `THIS FILE MUST NEVER RUN`,
both verbatim refusals and the cause. `check-migrations-are-live.mjs` and
`check-migrations-applied.mjs` both honour that marker only when it NAMES a
version whose file exists in the same directory, which it does. History is
never deleted.

## Proof that executes

`tests/sql/run-diamond-cross-format-conservation.py` now points at the
successor and gained a section. It builds its own isolated PostgreSQL 17
cluster, loads the six readers in production's own md5 pinned text, reproduces
each defect as an assertion that PASSES on the installed text, applies the real
file verbatim and proves the figures afterwards. **35 checks passed** on
PostgreSQL 17.11, up from 30.

The new section, `TWO INSTANTS VERSUS ONE SNAPSHOT`, pins the cause so it
cannot come back. It runs in production's state, where no Diamond seat is live
and the filtered and unfiltered figures are therefore the same number, which is
the migration's whole claim:

```
reproduced the apply failure - 15.00 of CHIPS moving between a read and a later
  read reads as "the chip felt total moved: 900.00 -> 915.00", which is what
  refused on production
and the one-statement comparison holds at the moved figure (915.00 = 915.00),
  because it asks only whether the Diamond filter changed the number
a player standing up moves the seat count 1 -> 0 and the one-statement
  comparison still reads 0 = 0, so no seat answers for the Diamond filter
the felt and the wallets are back at 900.00 and 250.00, exactly as the baseline
  took them
```

It also reads the superseded file's head and refuses to run if the marker is
missing or names the wrong version.

The runner remains one of the 25 registered Diamond runners and one of the 12
on a private cluster. No runner was added, renamed or removed, so
`scripts/ci/run-diamond-sql-acceptance.py`, its `PRIVATE_CLUSTER_RUNNERS` list
and the literal counts in `tests/unit/diamondAcceptanceCi.test.ts` are
unchanged.

`tests/no-chip-reader-sums-a-diamond.law.test.ts` now names the successor
explicitly (`files.find` returns the first match, so the law would otherwise
have kept pinning the dead file) and gained two cases: that the proof is read
on one snapshot (the `ca_p9b_before` capture is gone, each money comparison
says which snapshot it read, both callable readers are called inside the
comparing statement, `fn_snapshot_chip_supply` is never called, no comparison
has an `abs()`, a `GREATEST()` or any tolerance, and all seven money and seat
comparisons are exact `IS DISTINCT FROM`), and that the file it replaced is
marked, names its successor and records both refusals.

## What this does not change

No economics. No rate, price, fee, guarantee or destination. Both
`ca_arena_settings` switches stay false and the migration refuses to commit if
either is on. No row is rewritten, swept, backfilled or reconciled: the chip
snapshots and freeze marks already taken were taken when no Diamond seat
existed, so they are correct as they stand (CLAUDE.md 10.11, 10.12). The three
lines of Phase 9 that wait on owner decisions are still open and no checkbox in
`docs/POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md` moves.

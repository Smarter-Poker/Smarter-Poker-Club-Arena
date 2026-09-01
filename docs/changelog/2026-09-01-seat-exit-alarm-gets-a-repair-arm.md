# 2026-09-01 - The seat-exit alarm gets a repair arm, and the write-failure count learns to reach zero

## What was wrong

Two Phase 1 alarms were reading non-zero this morning. Neither was a false
positive, and neither could ever return to zero on its own.

**1. Twelve stacks left the felt with no wallet credit.** At 11:00:37 UTC a
single pooler session set `left_at` on 12 live cash seats across two Deep Stack
Society tables in one statement, carrying 1,216.54 chips. Three minutes later
the same operator deleted all 416 `club_members` rows and all 32 `agents` rows
for that club, which is what
`20260901110603_deep_stack_society_cannot_be_deleted_by_accident` was written
to make impossible a second time. The memberships were restored. The chips on
the felt were not, because vacating a seat by stamping `left_at` credits
nobody, and the eleven previous repairs of this exact shape were each
hand-written as their own one-off migration. The detector existed and worked.
Nothing on the platform could act on what it found.

**2. `ca_ledger_write_failures` could only ever climb.** The table is
append-only. Failure 6 was compensated at 00:42:51 UTC by
`fn_ca_repair_write_failure`, which writes a `correction:lwf:<id>` entry, but
the raw row count still read 1 and always would. A number that cannot return to
zero stops being read, which is the failure mode the alarm exists to prevent.

## What changed

`fn_repay_unaccounted_seat_exits(p_since, p_max_total)` pays exactly what
`fn_unaccounted_seat_exits` still reports at the instant it runs. A stack some
other process has already returned is therefore never paid twice, and a second
run over a clean sweep is a no-op. Each payment writes the
`Correction: seat exit <id>` wallet row that the detector reads as settled, so
the detector and the repair agree by construction instead of by convention. A
missing membership is skipped rather than paid, because crediting a wallet that
does not exist mints chips into nothing.

It is deliberately **not** scheduled. An alarm that quietly repays itself is an
alarm nobody reads, and a leak that funds itself back is a leak nobody finds.
Detection stays loud; the repair stays a decision.

`fn_ca_unresolved_write_failures()` asks the question the raw count was trying
to ask: swallowed journal rows with no compensating `correction:lwf:<id>`
entry.

## Horses

Nothing in either function reads `is_horse`. All 12 repaid stacks belonged to
horses, and they were repaid on identical terms to a human (CLAUDE.md 10.5).

## Verified in production

Probed first inside a transaction that was rolled back by RAISE (CLAUDE.md
11.5); the probe returned `repaid: 12, chips: 1216.54, skipped: 0` and moved
nothing. Then run for real, returning the same. After:

```
unaccounted_exits_now      0   (was 12, 1,216.54 chips)
unresolved_write_failures  0   (was 1)
raw_write_failures         1   (unchanged and correct: the row is history)
reconciler criticals       0
```

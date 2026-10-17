# A close that lost a lock race keeps its cadence (2026-10-17)

Job 272 calls the weekly close every 5 minutes only while a book is mid-close,
or after a time-budget failure in the last 3 hours (plus a few named cases).
Any other failure waits for the :40 tick.

On 2026-10-17, round 3 of the 2026-10-05 Midway close deadlocked (40P01) at
12:15, 15:10 and 17:16 UTC; `20261017161610` fixes the cause. Each deadlock
rolled the attempt back and marked the run `failed`, which put it on the
hourly cadence. The report an attempt needs to fit its budget is kept for 30
minutes (`20261017131056`), so every hourly attempt found it expired,
re-proved it, hit the 240 s statement timeout and was rolled back without
changing the run. The book could not reach round 3 again on its own.

`20261017174849` adds one condition to job 272's gate. A run that failed on a
transient lock error (deadlock `40P01`, serialization `40001`, lock not
available `55P03`) is retried on the same 5-minute cadence, for the same 3
hours, as a time-budget failure. Every other failure keeps the hourly retry.
The call, its budgets, its timeout and its schedule are unchanged.

## Verified

- The command preimage `b8be947f` and postimage `c74214f0` were read and
  derived on production (read-only).
- On native PG16 with a stand-in `cron.job`, the migration runs twice to the
  exact postimage, keeping `*/5` and active.
- The new condition is true for a deadlock 30 minutes ago, and false for a
  lock timeout 4 hours ago or an integrity failure (`23514`).

## Pinned by

`tests/a-close-that-lost-a-lock-race-keeps-its-cadence.law.test.ts`.

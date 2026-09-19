# tests/one-row-of-cron-health-must-describe-one-run.law.test.ts

## The law

`fn_ca_cron_health()` returns one row per active scheduled job. Every evidence
column in that row must describe the SAME run.

## What went wrong

The function paired `max(r.start_time)` (the most recent run, any status) with
`left(max(r.return_message) filter (where status = 'failed'), 200)`, which is an
aggregate over failure TEXT and therefore returns the lexicographically greatest
message in the window. The two values came from different runs and were printed
side by side under names that invite the opposite reading.

On 2026-09-19 three jobs that had been fixed and had already succeeded still
displayed stale statement-timeout errors beside current timestamps, and a fourth
displayed one while its five most recent runs had all succeeded. An agent read
that output and started re-diagnosing work that was already finished.

## What the fix does

`last_run_status`, `last_error` and `last_error_at` are columns of a single
`DISTINCT ON (w.jobid) ... ORDER BY w.start_time DESC` row, so they cannot
disagree. A job whose most recent finished run succeeded reports
`last_error IS NULL`; its `failures` count still records that it failed earlier
in the window.

Verdict logic is deliberately unchanged. `critical` still means ran and never
once succeeded across the whole window, which is a window property rather than a
last-run property.

## The band-aid that was refused

Ordering the failures by time instead of by text:

    (array_agg(r.return_message ORDER BY r.start_time DESC))[1]

This picks the most recent failure, which is better, and is still wrong in the
way that caused the misreading: a job that failed at 12:12 and has succeeded
every hour since would still print a red error beside a green run. The defect
was never which failure got chosen. It was that one row described two runs.

## Forward guard

Binds from 20260920. Exactly two migrations in the whole history carry an
aggregate over `return_message`, `20260831193608` and `20260831193846`, and both
are the ones that built the shape this replaces. Everything from 20260920 on is
covered.

## Asserting the negative

The migration header quotes the band-aid it refuses, so every negative assertion
in the law runs against a SQL-comment-stripped copy. `blankNonCode` in
`tests/helpers/sourceWindow.ts` handles JavaScript comments and does not know
about SQL's `--`, which is why this law carries its own `sqlCode` stripper, and
why that stripper blanks string literals before line comments: a literal such as
`'----'` would otherwise swallow the rest of its line.

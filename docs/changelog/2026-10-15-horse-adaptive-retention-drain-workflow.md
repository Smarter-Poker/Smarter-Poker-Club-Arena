# Horse Adaptive Retention Drain Workflow

## Why

After `20261015022307`, a continuous drain of `fn_prune_horse_adaptive_journal()`
retires about 33 hands per second against about 18 arriving, but the backlog
(about 937,000 hands on 2026-10-15) needs roughly 22 hours of uninterrupted
calls. The engine lane alone barely keeps pace, and a management-API session
is ended within about two minutes, so no existing route can run the drain to
completion.

## What

`.github/workflows/horse-adaptive-retention-drain.yml`, dispatch only, runs
`scripts/ci/drain-horse-adaptive-retention.mjs` through the same
`DATABASE_URL` credential and pinned provider CA as apply-merged-migration.
The script calls the installed bounded owner in a loop, one committed
statement per call, and adds no SQL logic: protection, certificates,
compaction, statistics, the capacity lock and budgets all stay in the
function. It stops by itself when fewer than `stop_below` hands are pending
or after `max_minutes` (at most 345), and a person dispatches it again to
continue. Its own lock timeout refusals are counted and tolerated up to 20 in
a row; any other failure stops the run as UNKNOWN. No schedule, no push
trigger, no money.

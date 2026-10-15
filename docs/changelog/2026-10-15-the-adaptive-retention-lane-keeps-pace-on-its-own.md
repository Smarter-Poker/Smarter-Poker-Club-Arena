# The Adaptive Retention Lane Keeps Pace On Its Own

## What Was Wrong

After the grouped retirement owner (`20261015022307`) was installed, one full
`fn_prune_horse_adaptive_journal()` pass retires about 240 hands and takes
about 4.9 s. The engine's journal loop called it through the shared 5 s journal
transport ceiling (`ADAPTIVE_JOURNAL_LIMITS.timeoutMs`). Passes that crossed
5 s were aborted client-side, read as `unknown`, and deferred for 60 s; passes
that finished were revisited after 5 s.

Measured on production 2026-10-15 11:30 UTC, after the dispatched drain
workflow ended: in 5 minutes the engine lane retired 942 hands while 4,206
qualified (about 3 per second against about 14). Without a hand-dispatched
drain the backlog grows by roughly 900,000 hands a day.

## The Fix

- `HorseAdaptiveJournalRetention.ts`: the adaptive pass gets its own transport
  ceiling, `ADAPTIVE_RETENTION_TIMEOUT_MS = 7500`, below the 8 s statement
  timeout pinned on `service_role`, so the database still ends a runaway pass
  first. Every other journal RPC keeps 5 s.
- `horseAdaptiveJournal/loop.ts`: a v3 adaptive pass that reports
  `retirementPending` or `budgetReached` is revisited after
  `ADAPTIVE_RETIREMENT_BACKLOG_DELAY_MS = 1000` instead of 5 s. Every other
  owner and receipt keeps its existing deadline.

Expected lane capacity: about 240 hands per 4.9 s pass plus a 1 s revisit and
the loop's own pause, about 35 to 40 hands per second, against about 14
arriving.

Appends share the capacity lock and retry through journal work. Evidence that
a near-continuous lane does not starve them: the six-hour drain workflow run
38688005802 held the lane almost continuously and left no journal work
unfinished (852 completed, 0 pending, 01:01 to 11:35 UTC).

No database change, job, schedule, repair or backfill.

## Proof

- `loop.test.ts`: a v3 pass with `retirementPending` or `budgetReached` is
  revisited every 1 s; a completed pass is not revisited; the existing capped
  owners stay fair and serial on their own deadlines.
- `HorseAdaptiveJournalRetention.test.ts`: the pass uses its own 7.5 s ceiling,
  above 5 s and below 8 s.

# A Timed-Out Period Recompute Reads Its Durable Receipt (2026-09-26)

## What Broke

The rakeback settler's watermark stopped at 2026-09-22T10:37:05Z. Every cycle
called `fn_rakeback_recompute_periods` for club `2a1132b9` week 2026-09-21 with
46 players. The function sets its own `statement_timeout` of 300 s and took about
71 s warm and 127 s cold; the engine client gives up at `DB_TIMEOUT_MS` (15 s).
The server committed every attempt (`accounting_period_recompute_requests.attempts`
reached 531 for that week) while the client counted each one as a failure and held
the watermark, correctly refusing to advance past a recompute it could not prove.
About 227,500 of the week's rake records sat above the mark, so the 2026-09-28
weekly close would have refused with `weekly_rake_source_not_fully_accrued`.

## The Fix

`RakebackSettlerService` now treats an outcome it could not observe (a client
deadline or transport failure, with no SQLSTATE or PostgREST code) as unknown and
reads the durable request row that the function writes in the same transaction. It
accepts the row only when `attempted_at` is at or after the moment this call was
sent, `status` is `pending` (the user-scoped success state) and `last_result` passes
the same canonical receipt check a direct response must pass (version 2, this club
and week, `ready`, `confirmed_players` equal to the submitted players). A stale,
blocked, cleared, whole-period or absent receipt is a failure exactly as before and
the watermark is held. The wait is bounded by the server's own 300 s budget plus
15 s, belongs to the original call, and `stop()` ends it immediately.
`DB_TIMEOUT_MS` is unchanged.

The catch-up (60 s) now also re-arms after a cycle that acknowledged at least one
page and then halted, so the remaining backlog is not left for the full 30-minute
interval. A cycle that halts on its first page still waits the interval.

The cash-source retry and credit batches already have durable receipts and are
replayed cheaply by the source authority on the next cycle, so they converge
without a readback and were left unchanged.

## Regression Protection

`server/src/services/rakebackWatermark.test.ts`: timeout plus fresh committed
receipt advances; stale receipt, no receipt, blocked, cleared, whole-period and
mismatched receipts hold; a definite server error is not read back; catch-up arms
after progress then halt and after the drain cap, and not after a first-page halt
or an empty range.

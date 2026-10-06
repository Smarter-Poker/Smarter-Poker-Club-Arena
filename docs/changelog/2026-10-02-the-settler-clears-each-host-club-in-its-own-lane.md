# The settler clears each host club's cash in its own lane (2026-10-02)

## Symptom

After #5864 (5-item cash batches, deployed 21:07 UTC) the rakeback settler moved
again but accrued 105-110 cash sources a minute against 129-150 arriving; the
cursor sat 80+ minutes behind and the cash backlog held near 9,600 at 21:43.
`fn_settler_lag_check` calls a lag over 6 h unhealthy (critical via
`fn_union_treasury_selftest`), and a cursor still inside a closed week holds the
weekly close (`weekly_rake_source_not_fully_accrued`).

## Cause (read on production 21:40-21:50 UTC)

The settler ran one 5-item `fn_credit_agent_commissions_batch` at a time. Its
backend was active in 169 of 200 samples; 121 of those were IO DataFileRead and
16 were advisory-key waits. One item costs about 0.4 s of mostly cold index
reads, so a single lane cannot go faster however the batch is sized, and a longer
batch would give back the finish wait #5864 removed.

## Fix

`server/src/services/RakebackSettlerService.ts`: a page's cash rows are split by
host club into at most `MAX_CASH_LANES` (4) lanes that run side by side, each with
the same batch size and order. Cash rake comes from two host clubs, one per
union, whose commission keys were disjoint over the two hours read, so a lane
never waits for another. The cursor is still saved once per page, only after
every lane has stopped; a failed lane halts the page as before.

Tests: `server/src/services/cashSourceLanes.test.ts` pins the split and runs one
settler page across two host clubs: both lanes' batches are in flight before
either answers, the cursor is written only after both, and a failed lane halts
the page only after the other lane has stopped. Both page cases fail against the
previous one-lane loop. The 105 cursor tests in `rakebackWatermark.test.ts` pass
unchanged (one host club is one lane).

# Rakeback Attribution Failures Retain The Source Page

The cash rakeback settler counted commission and player statistics failures, then
advanced its durable cursor if period recomputation happened to succeed. A lost
response, partial batch failure, or missing JSON receipt could permanently skip
an obligation. Period recomputation does not reconstruct either missing write.

`RakebackSettlerService._runSettlementInner` now requires a valid batch receipt
and retains the source cursor when either attribution stage fails. The next
cycle submits the same source identities to the existing idempotent RPCs.
Commission receipts must account for every submitted input; the statistics RPC
counts only newly inserted rows, so a successful replay with zero inserts is
accepted. No balance, rate, historical record, or production schema is changed.
This only pauses advancement of this background worker's page, not games,
clubs, tables, wallets, or user access.

## Verification

Before correction: 23 failing and 15 passing behavioral cases in
`server/src/services/rakebackWatermark.test.ts` reproduced skipped source pages.
After correction: 45 tests passed across that suite and
`server/src/services/rakebackWatermark.guard.test.ts`. Server TypeScript passed.
Negative cases cover transport errors, partial batches, missing/malformed
receipts, invalid counters, excess counts, and error bodies. Retry cases verify
the identical payload is resubmitted and the cursor advances only after success.

Source baseline: `09c01fba4`. These are local tests and a source correction.
Publication and deployed engine verification remain release coordinator gates.
Full hierarchy accounting and commission allocation are not certified here.

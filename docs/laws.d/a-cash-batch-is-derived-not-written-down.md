# tests/a-cash-batch-is-derived-not-written-down.law.test.ts

The cash rakeback settler halted on 2026-09-17 07:28:31 and did not move for
three days; 264,835 cash rake records carrying 485,712.99 of rake sat behind a
cursor that never advanced, and no cash agent commission was written anywhere
on the platform in that time. Nothing threw. Every cycle opened with
`fn_retry_cash_accounting_sources(50)`, which took ~20.6s against the engine
client's 15s `DB_TIMEOUT_MS`; the client aborted, the settler returned
'halted', and the server committed the work anyway - 5,294 receipts for 150
records. Both batch sizes had been sized honestly and both had outlived what
they were sized against: 150 was chosen against a server statement timeout that
the functions then raised to 300s, and migration 20260917181100 later took one
item from cheap to ~290ms. This law pins both sizes to
`cashAccountingBatchSize(DB_TIMEOUT_MS)` so they are computed from the budget
that binds, and forbids either being written down as a literal again. The
matching cost fix is `idx_rake_attributions_rake_record_id`; the two are
separate defects and both were live.

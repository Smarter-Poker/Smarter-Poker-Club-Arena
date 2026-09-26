# tests/the-period-recompute-outlives-its-server.law.test.ts

`fn_rakeback_recompute_periods` rebuilds a whole (club, week) rakeback book and
declares a 300 s server `statement_timeout`, but the rakeback settler called it
through the 15 s hand client. On 2026-09-26 the Deep Stack Society week
2026-09-21 recompute ran 137 s and committed while the client reported
`supabase_timeout`; the settler held its cursor at 2026-09-22 10:37:05 for 3.6
days with 234,593 rake_records behind it. This law pins the recompute's client
deadline to `periodRecomputeClientTimeoutMs()` - the SQL's declared budget plus a
transport margin, checked against the latest definition in the repo - and
requires the settler to make that call only through `accountingPeriodSupabase`.

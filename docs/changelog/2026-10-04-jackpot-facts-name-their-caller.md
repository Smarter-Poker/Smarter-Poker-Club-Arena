# Jackpot facts name their caller (2026-10-04)

Migration `20261004135612`. Law `tests/jackpot-facts-name-their-caller.law.test.ts`.

`fn_check_ungated_money_rpcs` (job 150, 04:15 UTC) paged a critical for
`fn_bbj_pool_facts(uuid)` (incident 0fc14cd0). The function's only write is the
hourly reporting cache `bbj_pool_contribution_hours`; it gated callers through
`auth.role()`, which the detector does not recognise. The gate is now stated by
identity (`auth.uid() IS NULL AND role <> service_role` refuses), admitting
exactly the same callers; the migration asserts inside its own transaction that
`fn_ungated_money_rpcs()` no longer lists it. Proved in `pg_temp`: compiles,
returns the facts row, detector verdict false.

Not live yet: the apply from this session was refused. Apply after merge.

# 2026-10-01: the reroll balance-refresh pin reads the owner door

Follows `2026-10-01-post-deploy-e2e-two-deterministic-reds.md`. The same-SHA
rerun of Post-Deploy run 36803327636 (attempt 2, a quiet hour) failed
`production-daily-missions.spec.ts:310` again, in the same place. That rules
out load.

## Cause: a pin on a read the client no longer makes

After `reroll_daily_challenge` the spec waited for
`GET /rest/v1/profiles?select=...diamonds...`, the global wallet's Diamond
re-read. #5679 (ruling 25, migration `20260930234500`, merged 01:14 UTC) took
SELECT on `profiles.diamonds` away from `authenticated` and moved every
own-balance read to the owner door `ownProfile()` (`src/lib/ownProfile.ts`).
The request is now
`POST /rest/v1/rpc/get_my_full_profile?select=diamonds&id=eq.<uid>`. The
behaviour is unchanged: the reroll still emits `BALANCE_UPDATED` and
`DynamicWallet` still re-reads the balance. The GET the spec waited for is
never sent, so the wait ran out at 60 s every time. The spec first failed on
the first Post-Deploy run after #5679 merged.

Fix: the wait now matches the owner-door request (POST,
`/rest/v1/rpc/get_my_full_profile`, `select` includes `diamonds`) and still
requires it to succeed. The pin moves with the behaviour it tracks (CLAUDE.md
5.8). It should have moved in #5679. No other e2e spec pins a now-private
profiles column through the authenticated client.

## Named, not fixed: Cashier Statements totals still exceed 8 s cold

`production-cashier-statements.spec.ts:41` also failed in the quiet hour.
`fn_cashier_statement_totals` -> `fn_cashier_statement_rows` (line 384, the
summing branch) hit the authenticated 8 s statement timeout at 11:23:28 UTC,
and PostgREST answered 500.

Measured on production, 2026-10-01, club `a41434bb`, default 7-day range:

- pg_stat_statements, totals RPC via PostgREST: 26 calls, mean 3,326 ms,
  max 7,969 ms.
- The same rows call made directly: 4,458 ms cold, then 92 ms warm. The work
  is small. The time goes to cold reads.
- `idx_chip_tx_club_time_idempotency_key` (from `20260930183001`) is present
  and valid (160 kB), so the O(all time) dedup scan is gone.
- Branch scans warm: receipts are an index-only scan on
  `idx_chip_tx_club_time_totals`, 60,820 rows, **814 heap fetches**, 31 ms.
  Movements are an index-only scan on `idx_chip_ledger_cashier_totals_cover`,
  33,217 rows, **1,650 heap fetches**, 23 ms. Both were measured minutes after
  autovacuum. Both tables show 99.7% and 98.1% of pages all-visible, so the
  fetches land on the pages still being appended to, which are never
  all-visible.
- The inner statements read 676 to 2,389 cold blocks per call, which took
  2.8 to 6.1 s: about 2.5 ms per random read.

So about 2,460 heap fetches at cold random-read latency reach the 8 s ceiling.
No index or rewrite removes heap fetches on pages still being written, and
this is not a small, provably safe change, so nothing ships here. Not raising
`statement_timeout`, and not adding a cache or a warmer (CLAUDE.md section 2,
10.11, 10.12). The two candidate root fixes are (a) a totals path that does not
read the newest receipt and movement pages through the heap, or (b) storage
read latency. Either one needs its own measured design.

# A union's earned plan reads each source once (2026-10-03)

## What happened

`fn_accounting_union_earned_plan_v3` proves every union earned plan: the weekly close (through the
memo, once per attempt), `fn_union_club_rake_basis`, and the open-week snapshot that
`union-integrity-sweep` (job 123) refreshes every hour. It ran nine statements: four re-read the
window's earning sources (the `contract` jsonb is stored compressed inline, ~1.2 KB a row, 4.4 GB
heap) and one probed `rake_records`, `accounting_cash_accrual_batches` and the sources once per bank
receipt by random uuid.

Measured read-only on production (Midway, 2026-10-02 07:00-15:00, 15,750 receipts): 52.8 s, about
3.4 ms a receipt. The open week already held ~320k receipts and ~1.05M cash sources after five days
(2.3x the previous week), so a full-week proof extrapolates to ~28 minutes; job 123's 300 s could no
longer refresh the snapshot (last refresh 2026-09-28 21:35). In the 2026-10-01 22:43 close the
memoised proof of the 09-21 week took 249 s.

## Fix

Migration `20261003081000_a_union_earned_plan_reads_each_source_once`:

- `fn_accounting_union_earned_plan_sets` computes the same six proofs, conservation test, totals,
  fingerprint and basis in one statement. Each table's rows of the window are read once by range;
  the sources are projected once with the contract decompressed once per row; the per-receipt
  random probes become hash joins on the window's rows plus a count of all cash sources of each rake
  record (so a source outside the window or union is still seen).
- It only certifies. Any finding, a failed conservation test, a NULL verdict or any error answers
  NULL, and the wrapper then runs v3, which refuses exactly as before.
- `fn_accounting_union_earned_plan` (the wrapper) asks the set path first; the memo is unchanged.
  No client role can execute the new function.

## Proof

- `md5(v3::text) = md5(sets::text)` on three windows of both weeks (rolled back).
- The whole closed week 2026-09-21..09-28 through the set path (one-shot pg_cron job 405, pg_temp
  copy, rolled back) reproduced the stored close: fingerprint `30f4c9f2978d859b43ad595d35affe7a`,
  period rake, house rake and all 10 basis rows, in 164 s.

## What does not change

Rates, payees, amounts, rounding, routing and the set of sources that count; every refusal
message (it is v3's); tables, indexes and schedules.

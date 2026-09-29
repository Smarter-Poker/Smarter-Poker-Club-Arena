# A Page Recompute Of An Unfinished Week Answers From One Unaccrued Hand (2026-09-26)

## Where The Settler's Time Went

`daemon_state.rakeback_settler` sat at 2026-09-22 20:15 at 08:57Z on 09-26, about
84 hours behind. Measured from the engine log, the receipt timestamps and
`pg_stat_activity`:

- A page of ~860 cash sources spends ~37 s inside `fn_process_cash_accounting_source`
  (~40 ms per source, 28 credit batches) and 67-86 s wall; a cycle is three pages
  plus the 60 s catch-up delay.
- The first page after every engine start took 209 s (08:59Z): three
  `fn_rakeback_recompute_periods` calls for the open week, 20-138 s each, IO bound
  (`DataFilePrefetch`), every one refused with `cash_source_receipts_incomplete`.
  The in-memory skip (`openWeekIncomplete`, "an open-week refusal is not asked
  again") dies with the process, and the engine restarted 11 times between 03:23
  and 09:06Z. `pg_stat_statements` since 09-10: 2,753 recompute calls, mean 5.2 s,
  max 220.8 s, 14,428 s total - as much database time as every source-credit batch.
- While a recompute runs it holds the club-week advisory lock and the
  `accounting_period_recompute_requests` row, which the source-credit batches and
  `fn_recognize_accounting_tournament_fees` also take.

The "3.5 minute recompute" and the "11-28 s recompute" were the same call: cold
after a restart, warm otherwise.

## The Fix

`fn_rakeback_recompute_periods`, page-scoped calls only (`p_user_ids IS NOT
NULL`): under the same lock and after the same request upsert, look at the 200
newest cash hands of the club-week. If one carries an attribution to this club
and has no accrued batch, the calculator's own `incomplete` count is non-zero,
so its answer is already known - blocked, written 0 - and it is returned in the
calculator's refusal shape with `source_count` = the attributions seen (a lower
bound, which is how the settler reads it). Otherwise the unchanged calculator
runs. Whole-period calls and `fn_prepare_accounting_week` are untouched.

Migration `20260926091232_a_page_recompute_of_an_unfinished_week_answers_from_one_unaccrued_hand`
(preimage md5 `0aaa0130...`, postimage md5 `37a114ec...`, both asserted).

## Proof (rolled back, one club per transaction)

- a41434bb, 90 players: same refusal, 574 ms. a0000000, 99 players: same refusal,
  1,098 ms, periods and certificates md5 unchanged. 2a1132b9: same refusal,
  periods and certificates unchanged; fall-through on week 09-14 identical to the
  installed function.
- A pg_temp copy of the installed calculator on a0000000's week did not finish
  inside the 120 s client budget.
- A first probe that locked three clubs' request rows in one transaction
  deadlocked against a live credit batch and was the victim; the proofs lock one
  club each.

## Regression Protection

`tests/a-page-cannot-certify-an-unfinished-week.law.test.ts` pins the page-only
guard, the accrued-batch and this-club conditions, the order (lock, door,
calculator) and the refusal shape, with five planted regressions that must fail.

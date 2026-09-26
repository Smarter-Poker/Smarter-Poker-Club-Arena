# A Page Recompute Waits For Its Witness (2026-09-26)

## Where The Settler Stood

`daemon_state.rakeback_settler` was at 2026-09-22 20:15 at 08:57 UTC, about 84
hours behind. It was current at 13:19 UTC the same day. Source receipts per 15
minutes (from `accounting_cash_source_receipts.recorded_at`):

| window (UTC) | receipts           | newest `earned_at` reached |
| ------------ | ------------------ | -------------------------- |
| 07:30-07:45  | 4,743              | 09-22 20:15                |
| 08:00-08:45  | 0-217              | (engine restarts)          |
| 09:00-09:30  | 4,565-5,036        | 09-22 21:53                |
| 09:45-12:45  | 10,014-15,431 each | 09-26 09:27                |
| 13:00-13:15  | 6,411              | live edge                  |

So the catch-up rate rose about threefold from 09:45 (the `NOTIFY` removal at
09:26 and a steady engine after 09:05) and cleared 84 hours of source in about
four hours, 20-40 times the ~40 cash hands a minute being dealt. Pages then
took 22-141 s for ~950 records, almost all of it in
`fn_credit_agent_commissions_batch` (1.46 s mean per batch); the page
recompute was skipped by the engine's memory of the incomplete week, and when
it was sent, 20260926091232 (applied 13:11:29 UTC by
`apply-merged-migration.yml`, history and md5 byte-exact,
prosrc md5 `37a114ec...`) answered it in 41-945 ms.

## What Went Wrong At The Live Edge

Once current, the only unaccrued hands of an open week are the ones dealt since
the settler's last page, and a call made a second after that page often found
none for its club. Its next attributed hand is a median 1.10 / 1.45 / 1.68 s
away (p95 5.33 / 6.15 / 8.64 s) on the three clubs with cash rake this week.
Every miss fell through to the full-week calculator, which saw the hands dealt
meanwhile and refused anyway, after 20-130 s:

- 13:21:46 2a1132b9: `supabase_timeout`, page 130,286 ms, cursor held and the
  page retried;
- 13:23:44 2a1132b9: refused after 40,886 ms; 13:25:35 a0000000: refused after
  20,301 ms.

While it ran it held the club-week lock and the request row.
`pg_stat_activity` at 13:20:45: the recompute (66 s, `IO:DataFileRead`) blocked
`fn_complete_tournament_terminal` (24.5 s on `Lock:transactionid`), which
blocked ten more sessions including `fn_ca_process_hand_post_commit_obligations`
and `fn_project_hand_side_effects`.

## The Fix

Migration `20260926133201_a_page_recompute_waits_briefly_for_its_witness`: a
page-scoped call of an open week, before it takes the lock or touches the
request row and without writing, waits at most 16 x 0.5 s for one unaccrued
hand of its club dealt in the last minute. The unchanged door then decides under
the lock and the unchanged calculator runs when it finds nothing. Whole-period
calls, `fn_prepare_accounting_week`, closed weeks and unknown clubs never wait.

## Proof (rolled back)

- a0000000, 24 page players: blocked in 41.5 ms, waited 0, periods and
  certificates md5 unchanged.
- 002c2d27 (no cash rake this week): installed function `ready, written 0` in
  1,761 ms; wait-then-installed identical receipt after 16 waits, 8,948 ms.

## Regression Protection

`tests/a-page-waits-for-its-witness-before-it-holds-anything.law.test.ts`
(seven planted regressions) and the 20260926091232 law, whose guard now anchors
after the lock.

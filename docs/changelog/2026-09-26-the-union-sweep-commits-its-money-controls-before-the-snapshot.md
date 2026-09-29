# The union sweep commits its money controls before the snapshot

2026-09-26. Migration `20260926073120`. Law
`tests/the-union-sweep-commits-its-money-controls-before-the-snapshot.law.test.ts`.

## What was wrong

pg_cron job 123 (`union-integrity-sweep`, :35 hourly) runs
`fn_union_integrity_sweep_all()` as one statement under the postgres role's
2 minute `statement_timeout`. Every step inside it is wrapped in
`EXCEPTION WHEN OTHERS`, and `OTHERS` does not match `query_canceled`. A
timeout anywhere therefore rolled back everything the sweep did that hour:
stop-loss suspensions, invoice ageing, settlement lock hygiene, period closes.

`20260926042119` made `fn_union_rake_basis_refresh` read the open week through
the rakeback settler's cursor, so it stopped failing fast and now runs the
certified plan (`fn_accounting_union_earned_plan`) every hour. It ran FIRST in
the per-union loop, ahead of the stop-loss.

| measured (UTC)       | value                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| sweep 05:35          | 22.4 s                                                                |
| sweep 06:35          | 85.3 s (snapshot compute 77,637 ms)                                   |
| sweep 07:35          | 94.6 s (snapshot compute 69,160 ms)                                   |
| plan alone, 1.5 days | 70.9 s, 29.5 s, 25.8 s, 14.8 s (rolled back, 07:24-07:41; load bound) |
| money controls alone | 1.2-1.3 s                                                             |

The plan is linear in the rows the cursor has reached. The settler is catching
up about 15x faster than real time (cursor 19:39 -> 19:45 on 09-22 in 25 s of
wall time at 07:40), so the window is about to grow from 1.5 days toward the
whole week.

## What changed

1. The sweep runs every money control first and the snapshot refresh last, in
   its own subtransaction that traps `query_canceled`, stops refreshing for the
   hour (the timer is spent) and files one deduplicated warning. A slow report
   can no longer roll a suspension or a period close back.
2. The refresh stores `input_stamp` (the cursor-bounded `through` plus the row
   counts of its append-only inputs in the window) and skips when the stamp is
   unchanged. Every input table carries an immutability trigger, so equal
   counts are equal rows and a recompute would write the same detail.

## Proof (rolled back, one DO block each, new bodies as pg_temp functions)

- Cursor moved between two calls (19:39:08 -> 19:45:27): recomputed. Cursor
  unchanged at the sweep's call: skipped (`rake_basis {refreshed 0, skipped 1}`).
- `union_club_terms` identical before and after: Club JAQK
  (a0000000-...-0001) and SHARK CLUB (a41434bb) remain `suspended`;
  `clubs_suspended 0`, `clubs_restored 0`; every `union_weekly_squareup`
  invoice and every `settlement_periods` row unchanged. The stop-loss result:
  `held 0, restored 0, suspended 0, exposure_error invalid_closed_pnl_evidence_period`
  (the open week is still not certifiable, exactly as #5292 left it).
- `statement_timeout` 8 s: the timer fired inside the refresh at 8.0 s, the
  handler trapped it (`out_of_time true`), the sweep returned normally, and a
  write made after the money controls survived.

## What reads `union_club_terms.status`

Read from `pg_proc`, `pg_views`, `pg_matviews`, `pg_policies`, triggers, cron
and both repositories (Club Arena `src`, `server/src`, `supabase/functions`;
World Hub `pages`, `src`, `lib`, `components` on `origin/main`):

- `fn_union_enforce_stop_loss` writes it (the only writer).
- `fn_union_club_exposure` reports it as a column.
- `fn_union_credit_risk_check` excludes suspended clubs from its
  "breached and still active" count.
- `fn_union_governance_check` and `fn_ca_conservation_sweep` call
  `fn_union_club_exposure` (reporting).
- Nothing else. No seating, buy-in, table, cashier, club or player path, no RLS
  policy and no client code reads it.

So the 06:35 suspension of Club JAQK and SHARK CLUB for non-payment is a
recorded status and two critical alerts. It does not stop
either club's players or tables from doing anything. If the union's rule is
meant to stop a non-paying club from playing, that enforcement does not exist
yet, and it is Dan's decision what it should do.

## What this does not fix

When the settler reaches the present, the cursor moves every hour, so the skip
will rarely fire, and a full-week plan may not fit what is left of the 120 s.
The refresh will then time out, and it now does that alone: the money controls
commit, and one open warning (`kind: out_of_time`) says so. The snapshot has no
reader today (the only function naming `union_rake_basis_snapshot` is its
writer), so nothing is served stale. Making the certified plan itself cheaper
is the real cure. Most of its time is per-row jsonb verification over roughly
70,000 sources per 1.5 days; that belongs with the accounting plan's owner.

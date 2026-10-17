# A ready report is proved once a half hour (2026-10-17)

## What happened

The 2026-10-05 Midway union close paid round 1 at 2026-10-16 21:15 and has
paid nothing since. Job 272 runs it every 5 minutes with a 240 s statement
timeout and a 3-minute scope budget. In 24 hours 104 ticks hit the timeout and
4 more ran out of budget at 3m10s-3m19s, just before the settlement cascade.
Timed-out visits roll back whole.

Even with every P&L certificate fresh, preparation re-reads what no
certificate covers, cold, on every attempt: the report's award-owner check
(>60 s), the cash source refusals (29 s), the per-club freshness checks
(14-17 s). The chunked close already hands a report proved earlier in the
same attempt to every later caller through `app.union_pnl_evidence_memo`, but
that memo dies with the attempt, so the next attempt proved it again.

## The fix

`20261017131056_a_ready_report_is_proved_once_a_half_hour`:

- `accounting_close_report_receipts` keeps the last READY report per union and
  closed week, with the original inventory generation it was proved under
  (service role read only, RLS on).
- `fn_process_weekly_accounting_scope`, in a chunked union attempt only, seeds
  the report's own memo from a receipt under 30 minutes old and of the current
  generation, before preparation. An attempt that proved the report itself
  keeps it after preparation, outside the money block, so it survives that
  attempt's deadline. A seeded attempt never refreshes the receipt, so the
  report is proved again at least every 30 minutes.

No rate, payee, amount, rounding, routing, receipt, idempotency key, refusal
or certificate changes. The money rounds still re-verify their own
certificates. The 240 s timeout is not raised: it protects the replication
slot.

## Verified

It installs on either reviewed live body: `56eb1c0d` (after `20261017132500`) -> `31c80083`, or `86c6a68e` (after `20261017132354` too) -> `63eea798`. On native Postgres 16: the migration runs twice cleanly, the scope readback
is the exact postimage with its ACL unchanged; keep then seed restores the
memo under the report's exact key; a different generation, an unchunked
session, a receipt over 30 minutes old and a warming report are refused.

## Pinned by

`tests/a-ready-report-is-proved-once-a-half-hour.law.test.ts`.

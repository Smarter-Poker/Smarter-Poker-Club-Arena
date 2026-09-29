# A terminal verdict leaves the retry queue

2026-09-21. Migration `20260921033321_a_terminal_verdict_leaves_the_retry_queue`.

## What was wrong

`accounting_cash_source_work` held 36,131 rows at `status='blocked'`, and
**35,994 of them could never succeed**. Each had an
`accounting_cash_accrual_batches` row at `legacy_unverified`, and that verdict
is latched: `fn_accrue_cash_hand_commissions` looks the batch row up _first_
and returns the stored status before it consults the cutover or anything else.
Nothing can un-latch it - no function updates or deletes that table, two
triggers refuse both, and the CHECK constraints mean a legacy row (inserted
with no plan) could not become `accrued` even if an update were allowed.

`fn_process_cash_accounting_source` recorded that permanent verdict as a
_transient_ failure, falling through to the common write that gives every
blocked row a backoff capped at one hour. That one line was the defect:
a verdict that can never change was being given a date to be tried again.

`fn_retry_cash_accounting_sources` - which the settler calls at the top of
every cycle - then drew 50 rows per cycle from that 36,000-row pool.

### Measured cost, on a live settler

Receipts per minute, 03:26-03:28 UTC: 50 `cash_source_legacy_unverified`
every minute, every minute. `p_limit` is 50, so the **entire retry budget**
was spent on guaranteed-futile work, about 72,000 attempts a day. Individual
rows had reached 38 attempts.

It also starved the real queue. Ranked by the selector's own
`ORDER BY next_attempt_at, rake_record_id`, the best-placed genuinely
retryable source sat at **rank 22,895**; all 137 were still at `attempts=1`,
never once reached.

This is the defect that caused the original three-day settler outage, when
the pool was 150 rows. It was 240x larger.

## The fix, and the option that was rejected

The obvious repair - a terminal status on the work row - would have been a
serious mistake. `status='blocked'` is read by
`fn_cash_source_refusals_for_period`, whose sole caller is
`fn_prepare_accounting_week`: it is the gate that stops a weekly accounting
close running over sources that were never accounted for. Moving these rows
off `blocked` would have silently un-blocked weekly closes over the orphaned
window and made it look settled.

So the status is untouched, and the fix goes to the column whose job is to
answer _when should this be tried again_. For a latched verdict the honest
answer is never, and `timestamptz` can say so: `next_attempt_at = 'infinity'`.

This is not a silent skip (10.86). The row still reads `blocked`; its receipt
still reads `cash_source_legacy_unverified` / 55000; the weekly-close gate
still counts it; and it now states in its own scheduling column that nothing
further is due. `fn_retry_cash_accounting_sources` additionally reports
`terminal_parked` - the count it is deliberately not attempting - in the
receipt it returns every cycle, so a caller is told the number every time.
The selection predicate itself is deliberately unchanged.

Not a repair job (10.12): no function, no cron, no schedule is created; it
pays nobody, moves no chips and writes no wallet row. The single UPDATE is
the settling of damage already done that 10.11 step 3 requires.

## Effect

|                               | before    | after     |
| ----------------------------- | --------- | --------- |
| rows the retry lane considers | 36,124    | **60**    |
| futile receipts per minute    | 50        | **0**     |
| `status='blocked'` total      | unchanged | unchanged |

Before the commit (03:36) the settler wrote its usual 50 futile receipts. At
03:37 and 03:38 it wrote none, and the starved deadlock rows began to be
served - that pool fell from 137 to 70 within a minute.

The 35,994 parked sources remain fully countable: 35,994 distinct hands,
70,266.67 rake, earned 2026-09-17 07:28 to 18:24 (the cutover). They are
still `blocked`, still carried by the weekly-close gate, and still awaiting
the owner decision in task #68. Nothing was deleted, hidden or settled.

## Note for whoever picks up task #68

Only 35,994 of the pre-cutover cash sources have work rows at all. The full
pre-cutover population is **2,546,462 sources / 6,221,101.59 rake**. If
anything ever feeds those into the work queue they will each take one
attempt and then park, rather than joining a permanently futile retry pool -
which is the main reason the fix belongs in
`fn_process_cash_accounting_source` and not in a one-time data change.

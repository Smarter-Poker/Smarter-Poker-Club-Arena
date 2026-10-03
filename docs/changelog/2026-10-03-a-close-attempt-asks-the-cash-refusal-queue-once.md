# A close attempt asks the cash refusal queue once (2026-10-03)

## What happened

A union close attempt prepares its book twice: `fn_process_weekly_accounting_scope` calls
`fn_prepare_accounting_week`, and `fn_union_settlement_cascade` calls it again for the same
(union, week) in the same transaction. Each preparation reads the whole blocked refusal queue
(`fn_cash_source_refusals_for_period`, 35,994 blocked rows): 95 s and then 98 s in the auto_explain
log of the 2026-10-01 Midway close. At low traffic it measured 11.4 s cold on 2026-10-03.

## Fix

Migration `20261003095444_a_close_attempt_asks_the_cash_refusal_queue_once`: inside one union close
attempt (`app.accounting_close_memo = 'on'`, set only by `fn_weekly_accounting_attempt_begin(true)`)
a `ready` answer for a book is remembered in the transaction-local setting
`app.accounting_cash_refusal_memo`, and the cascade's preparation of the same book reuses it. The
reused value is exactly the empty-queue answer. A blocked answer is never remembered; standalone club
attempts and every call outside an attempt ask the queue as before. `attempt_begin` and
`attempt_end` clear the setting with the other close memos.

## What it trades

Both preparations run under the book's week lock, held from the first to the end of the attempt, but
the refusal writer (`fn_process_cash_accounting_source`) does not take that lock. A row that turns
blocked between the two checks of one attempt is now seen by the next attempt's first check instead
of this attempt's second. The coordinator decided this trade on 2026-10-03.

# tests/an-amount-that-cannot-be-computed-is-not-a-number.law.test.ts

`fn_ca_cron_health()` calls a scheduled job that has run and never once
succeeded `critical`, and Cron Health fails the run on one. Measured 2026-09-19,
`rake-law-wide-daily` had 1 run and 0 successes and `rake-law-adherence-hourly`
1 success in 24 runs, both dying on `null value in column "ledger_balance" of
relation "ledger_reconcile_log" violates not-null constraint`.
`fn_rake_law_violations` returns eight kinds of finding and three of them return
NULL for the allowed rake on purpose: `board_not_recorded`,
`players_not_recorded` and `impossible_showdown` all mean the hand record is
incomplete, and what the spec allows cannot be computed from an incomplete
record. `fn_rake_law_check` wrote that NULL into a NOT NULL column, the INSERT
raised, and because the check is one statement every finding in the window died
with it: a warn-level row about a missing board was destroying the `over_spec`
and `under_spec` violations found beside it, and the last rake_law row the
estate recorded was 2026-09-17 04:40. The fix that would have been wrong is
`COALESCE(v.allowed, 0)`, because a fabricated zero in an accounting log either
invents a drift that did not happen or erases a violation that did. Instead both
amount columns may be absent, and a CHECK admits a NULL only when
`metadata->'unknowable'` names that column and carries a reason, with the
`COALESCE` that a CHECK needs because a constraint whose expression is NULL
passes. The migration proves both directions before committing: an unexplained
NULL is still refused, and the real check runs to completion on the window that
had been failing. The forward guard is that no later migration may put the NOT
NULL back or fill an uncomputable amount with a number, because the one-line fix
that makes the red job go away is exactly the wrong one.

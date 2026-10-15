# A Close Proving Loop Stops On The Statement Clock (2026-10-15)

Migration `20261015181721_a_close_proving_loop_stops_on_the_statement_clock.sql` (held draft, installed by the owner).

## What Happened

The Midway Union close for the week 2026-10-05 07:00 UTC to 2026-10-12 07:00 UTC (union `fade0000`) reached stage `prepared` at 17:30 UTC on 2026-10-15 and began proving round 2's 84 two-hour windows (`accounting_close_partials` kind `round2_union_window`, about 13 to 15 s each). The 17:30, 17:35 and 17:40 visits of job 272 proved six. The 18:05 visit was cancelled by job 272's 240 s statement timeout (`weekly_accounting_scheduler_visits.last_outcome = 'statement_timeout'`, `financial_alerts` "A weekly accounting scope did not finish its scheduler visit") and kept nothing.

## Cause (Read From Rows)

- Job 272 is one 240 s statement. Before the union attempt it selects scopes and visits the standalone club scope `2a1132b9` (a completed week). That visit ended 20 s into the 17:40 tick (17:40:20) but 102 s into the 18:05 tick (18:06:42), under I/O load.
- The attempt then prepares the book (cash refusals, P&L close quality, week clubs): about 50 to 75 s.
- `fn_settle_accounting_commission_advance` then proves windows until 120 s after the attempt began. It never asks how much of the statement is left, so an attempt that begins 100 s into the tick keeps starting windows until about 220 s, and the window running at 240 s is cancelled together with every window that attempt proved.
- `fn_settle_accounting_rakeback_advance` (round 3's windows and its plan) has the same rule.
- `fn_accounting_union_earned_plan_advance` had the same defect and was fixed on 2026-10-15 (installed as `20261015101400`); the two round advances were left on the attempt-only clock.

## Fix

Each of the two advances computes, once, the instant one minute before the statement would be cancelled (`statement_timestamp() + statement_timeout - 60 s`, never when the statement has no timeout) and starts no window, and no round-3 plan, after it. A late attempt commits as a `prepared` step with what it has instead of being cancelled and rolled back. The 120 s and 60 s attempt rules, the windows, the plan and the money rounds are unchanged, and an attempt with time left behaves exactly as before.

## Proof

`scripts/ci/test-a-close-proving-loop-stops-on-the-statement-clock.py` on native PostgreSQL loads both production definitions (md5 `962cc580...` and `53dadff0...`), shows the baseline starting windows and the plan with under a minute left and being cancelled with nothing kept, then applies the migration and shows: no window or plan started late, windows kept when the statement is short, every window and the plan proved with time left, the 120 s rule unchanged, a finished round 3 never holding back the money round, production's derived postimage md5s (`e91c4077...`, `2c3f36a8...`), unchanged owner, volatility, settings and grants, and a refused second run. 22 of 22 checks pass.

## Related

- `#6994` (a calculating week advances on its own tick) covers the split recompute stage of the same week, which ran 15:26 to 17:13 UTC.
- The 2026-09-07 week's `failed` run (511 attempts) is not revisited: the scheduler starts each union from `union_settlement_floor` (2026-09-21 since Dan's 2026-09-20 ruling), and the row's last visit is 2026-09-21 00:20 UTC. Its pending rakeback stays recorded in `accounting_deferred_obligations`.

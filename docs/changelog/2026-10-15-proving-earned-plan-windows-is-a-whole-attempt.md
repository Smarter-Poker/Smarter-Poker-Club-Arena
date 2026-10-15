# Proving earned-plan windows is a whole attempt (2026-10-15)

## What happened

The original week (union fade0000, 2026-10-05 to 2026-10-12) got past its retention refusal at 00:41 UTC (migration 20261014225815). It then certified the opening boundary at 00:43 and proved 76 of its 84 earned-plan windows over attempts 72 to 75. Each attempt proved windows for about 120 seconds and then stopped cleanly.

From 01:30 every scheduler visit (01:30, 01:35, 01:40, 02:05) was killed by job 272's 240-second statement timeout (`weekly_scope_statement_budget_exhausted`). A killed attempt rolls back everything it proved, so each visit re-proved the same 8 windows and lost them again.

## Cause

The last 8 windows take about 11 seconds each, so they finished inside the advance's 120-second cut. `fn_accounting_union_earned_plan_advance` ran off the end of its loop and returned TRUE. `fn_union_pnl_evidence_report` then went straight on to the closing boundary in the same attempt, and that boundary had to be re-proved for the new original-inventory generation (the raw inventory alone measured 29 seconds). The windows, the closing boundary and the attempt's preparation do not fit in 240 seconds together. The attempt that finishes the windows is therefore the one attempt that can never commit.

## Fix

Migration `20261015021138_proving_earned_plan_windows_is_a_whole_attempt.sql`: an attempt that proved any window returns false, even when it proved the last one. The report answers "warming" and the attempt commits as a certifying chunk, exactly as it already did when it ran out of time mid-loop. The next attempt finds every window fresh, proves none, and reaches the boundary with its whole budget. An attempt that proved nothing is unchanged byte for byte.

## Proof

- Production self-aborting trial (successor built in pg_temp only):
  - with only the newest window stale, the successor returned false after proving it;
  - with every window then fresh, it returned true;
  - outside a chunked close it returned NULL.
- Preimage `b2013d3a…`, postimage `42d6add3…`; owner, security, volatility, config and ACL are unchanged.
- Law: `tests/proving-earned-plan-windows-is-a-whole-attempt.law.test.ts`.

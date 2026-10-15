# The Week's Original Flows Are Proved Two Hours At A Time (2026-10-15)

## What Happened

PR #6898 (20261015021138) let the original week (union fade0000, 2026-10-05 to 2026-10-12) finish its earned-plan windows and, at 02:38:56 UTC, commit its closing boundary (attempt 76, `{"stage":"certifying","chunk_committed":true}`). Every job 272 visit after that, 26 in a row from 02:40 to 06:09 UTC, ended in `weekly_scope_statement_budget_exhausted` (240 s) and rolled back.

## Measured (Production, Read-Only)

| Step of the post-boundary attempt | Cost |
| --- | --- |
| Tick scope selection (cursor form) | 40 s |
| Deep Stack Society scope visit (nothing due) | 9 s alone; the 06:05 tick finished it at 06:05:44 |
| Cash source refusals | 14 s |
| Generation, boundary and window cache reads, hand counts | about 3 s |
| `fn_union_pnl_original_flow_evidence`, whole week | 162 s alone (137 s on a second run), 814,510 flows, 1.1 GB of rows, 2.0 GB of temporary files |

Every cancelled visit (02:44, 04:09, ..., 06:09) logged exactly the two temporary files of the flow proof (1,073,741,824 and 1,006,069,532 bytes) at the moment it was cancelled: it was inside that one statement. The 06:05 tick's union attempt started about 60 s into its 240 s statement and was still in it at 06:09:00.

## Cause

The report's flow proof was the one whole-week step with no chunking. The boundaries are one statement of about 2 minutes each and the earned plan is proved two hours at a time, but the flows had to be proved, aggregated into a 190 MB certificate and written inside a single attempt that also pays for its preparation and for whatever the tick ran before it. That attempt could never commit, so each visit repeated it and lost it.

A bigger timeout would only move the edge; the step had to become divisible.

## Fix

Migration `20261015061812_the_week_s_original_flows_are_proved_two_hours_at_a_time.sql`:

- `smarter_private.union_pnl_original_flow_evidence_window(union, start, end, window_start, window_end)` is the week proof byte for byte with one added predicate (the flow's `recognized_at` inside the window) and without the two whole-week return families. Each flow's evidence comes from its own row and the week's bounds, so the windows partition the week exactly.
- `fn_accounting_union_earned_plan_advance` (already called by the report right after the opening boundary) now, after the earned-plan windows, proves the flows one plan window at a time into `accounting_close_partials` (new kind `pnl_flows_window`; 12 h freshness, a window that found a problem is re-proved after 1 h like the report's problem steps), ends the attempt after proving, and when every window is fresh assembles the windows plus the two return families into the very certificate the report reads (`pnl_flows` or `pnl_flows_problem` through `inventory_basis_cache_write`, same generation), in an attempt of its own.
- It windows only while `fn_union_pnl_original_flow_evidence` and `fn_union_pnl_evidence_report` are the reviewed definitions (md5 checked on every call); otherwise it returns true and the report proves the week as before. Neither function changes, so the original-inventory generation and every certificate already earned stay valid.
- Each proving loop also stops 60 s before the statement's own timeout, not only 120 s after the attempt began, because an attempt can begin late in its tick.

## Proof

- Production, read-only (one self-aborting DO block, no writes): the 84 windows plus the two families against the whole-week proof: 814,543 rows on both sides, identical multiset hash (`8007442006702600141382`), 22 invalid on both sides, `equal=t`. Longest window 6.2 s.
- Local PostgreSQL 16 with the production preimages rebuilt from the repo (advance `42d6add3...`, week proof `09745f78...`, report `edecfc52...`, all reproduced): the migration applies, its `@live-proof` is true, and a second run refuses on the preimage. A behavioural run proved all windows, assembled the certificate in the next call (window rows plus the return family, same sums and keys), then returned true.
- Law: `tests/the-weeks-original-flows-are-proved-two-hours-at-a-time.law.test.ts`.

## Still Open

- The week's flows contain 22 invalid flows (both proofs agree), so the assembled certificate will be `pnl_flows_problem` and the report will answer `original_money_flow_basis_incomplete` (count 22) instead of timing out. That is a data finding to resolve on its own; this change makes it visible.
- The steps after the flows (touched registrations, union credits about 30 s, the club P&L) are each still one statement; whether each fits its own attempt is the next measurement.
- Not applied to production by this change; it installs through the recorded migration path.

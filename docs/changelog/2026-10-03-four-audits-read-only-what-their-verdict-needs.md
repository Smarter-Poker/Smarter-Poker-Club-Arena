# Four audits read only what their verdict needs (2026-10-03)

Launch-gate sweep. Migration `20261003025434`.

## Why

Read from `cron.job_run_details` (6 hours to 02:20 UTC): ca-ratchet-watch-hourly 5 of 6 cancelled at 300 s, spin_unpaid_check 3 of 6 at 120 s, ca-settlement-correctness 3 of 6 at 120 s, ca-stats-witness-audit-15m 49-283 s per run with cancellations at 300 s. The stats witness audit runs every 15 minutes, so it can reach `fn_ca_cron_failure_watch`'s threshold (5 failures, no success, 2 hours) and file an unresolved "unknown" warning that holds `fn_ca_midway_burnin_gate` red. It did on 2026-09-30 and 2026-10-01.

## What changed, and what it measured

| function | what it read | now | measured |
|---|---|---|---|
| `fn_ca_ratchet_watch` | all nine kinds of `fn_rake_law_violations('2 hours')` (SQL function with SET search_path, never inlined) to count three, two of which it never emits | `no_flop_no_drop` counted directly with that function's rule | 7.5 s (old call: cancelled at 300 s) |
| `fn_spin_unpaid_check` | `v_spin_unpaid_settlements` twice, the second time with the full `tournament_players` aggregate | one pass; seat columns per alerted tournament (40 ms each, `tournament_id` pushed into every aggregate) | 9.6 s (old: up to 117 s) |
| `fn_ca_settlement_correctness_check` (section G) | ~885,000 hands of 24 h and their receipts, every hour | the hour first (17.3 s); the day, unchanged, only when the hour would fire | 10.5 s whole function |
| `ca_stats_witness_audit` 2d | 37,949 per-seat probes on the user-keyed primary key (27.3 s) | the window's index rows fetched once by `hand_id` | 16.0 s |
| `ca_stats_witness_audit` 2f | 801,620 seven-day seats hashed (spilled to temp) and joined to ~3,600 per-hand verdicts (32-35 s) | one pass; the action log read only for seats with no figure | 21.5 s cold; whole function 31.7 s |

The whole-function timings come from rolled-back `pg_temp` copies of the rewritten bodies run against production; the stats witness copy produced the same counts the live job logged (802,095 owed seats, 1,305 without a figure).

## How

Each body is edited by exact substitution through a `pg_temp` helper: the live text must hash to the pinned preimage, each anchor must occur exactly once, the result must hash to the derived postimage (computed read-only on production), and owner, SECURITY DEFINER, `proconfig` and grants must not move. `fn_ca_settlement_correctness_check` is a watched guard; its redefinition is declared. No schedule, grant, index or table changes.

# Zero-Drift Phase 6: Restore Drill, Epoch-3 Rehearsal, Capacity Plan, Revenue Digest

Date: 2026-09-01 (00:00-00:25 UTC). Project: kuklfnapbkmacvwxktbh (production).

## 1. Epoch-3 Rehearsal (Executed On Real Production Data, Rolled Back)

The real reset - `fn_ca_execute_epoch3_reset('MIDWAY-EPOCH-3-RESET', p_dry_run
=> false)` - was executed inside a transaction that was deliberately rolled
back, against live production data. This is a stronger rehearsal than a
database branch would give: Supabase preview branches clone the schema, not
the data, so a branch rehearsal would have retired zero chips and proven
nothing. A rolled-back transaction exercises the exact code against the exact
rows with zero persistence risk.

Result: the reset REFUSED to run, which is the safety rail working. Its
preflight reported, precisely:

| Check                   | State At Rehearsal          | State After Same-Night Fixes                                 |
| ----------------------- | --------------------------- | ------------------------------------------------------------ |
| no_open_incidents       | FAIL (4 open)               | PASS                                                         |
| guards_all_present      | PASS                        | PASS                                                         |
| ledger_chain_clean      | PASS (41,274 rows verified) | PASS                                                         |
| zero_suspense_flow      | FAIL (108 rows / 24h)       | FAIL - decays to green about 24h after the last suspense row |
| no_unregistered_rpcs    | FAIL (3 functions)          | PASS (audited + registered)                                  |
| fresh_supply_snapshot   | PASS (unexplained 62.76)    | PASS                                                         |
| zero_write_failures_24h | PASS                        | PASS                                                         |

The rehearsal itself found the last uncategorized money writer on the
platform: `fn_spin_move_owner_wallet`, the spin-margin mover for STANDALONE
club owners, which only started firing tonight because the newly opened club
is the first standalone club to run spins since the suspense drain. Fixed in
`ca_phase6_last_uncategorized_writers_learn_their_names` (margin journals as
rake vs spin_reserve; owner funding journals as overlay), and
`fn_agent_claim_commission` now declares the commission category.

Follow-up the same night: the engine's tournament-exit noise was made
structurally impossible (`ca_tournament_seats_close_quietly` - a tournament
seat closes with no credit attempt at all), and the daily suspense rollup now
floors at the last writer fix (`ca_suspense_rollup_floor_at_last_writer_fix`),
so only a money writer never seen before can raise it.

Path to a green gate: (1) PR #2346's engine deploy, (2) about 24 hours of
clean flow ages the suspense window out. Then: preflight green,
`fn_ca_midway_burnin_gate(24)` green, and the reset is one deliberate call
away.

## 2. Restore Drill / PITR Runbook

The MCP surface cannot read backup configuration, so the enablement check is
a dashboard item (Settings -> Database -> Backups). The drill, when Dan wants
to run it (creates a temporary second project, billed while it exists):

1. Dashboard -> Backups -> PITR: pick a timestamp (e.g. 10 minutes ago),
   restore INTO A NEW PROJECT (never in place).
2. On the restored copy run, in order:
   `SELECT public.fn_ca_epoch3_preflight();` (chain + registry intact),
   `SELECT count(*), sum(amount) FROM chip_ledger;` vs production at the
   same timestamp via `fn_ca_balance_asof`,
   `SELECT public.fn_ca_supply_snapshot();` (totals reconcile).
3. Time the wall clock from click to first successful query - that is the
   real RPO/RTO number, and it belongs in this file when measured.
4. Delete the restored project.

Success criterion: restored ledger chain verifies and the supply totals match
`fn_ca_balance_asof` on production for the same instant.

## 3. Capacity And Partitioning Plan

Measured 2026-09-01 (sizes include indexes):

| Table                | Size   | Rows  | Growth                                                              |
| -------------------- | ------ | ----- | ------------------------------------------------------------------- |
| solved_spots_gold    | 80 GB  | 6.1M  | static solver corpus - archive candidate, not a partition candidate |
| hand_state_snapshots | 6.3 GB | 2.0M  | high churn - already pruned; verify retention window                |
| hand_history         | 4.5 GB | 2.0M  | append-heavy                                                        |
| ca_hand_player_idx   | 3.8 GB | 12.4M | append-heavy                                                        |
| chip_ledger          | 174 MB | 259K  | 58,234 rows/day measured = ~21M rows/yr, ~15 GB/yr                  |

Recommendations, in order:

1. chip_ledger: RANGE partition by month on created_at BEFORE it reaches
   ~5 GB (around 4 months out). The append-only trigger, hash chain
   (chain_seq/prev_hash) and partial-unique dedupe indexes must be recreated
   per-partition; do it as a dedicated migration with a rehearsal on a
   branch (schema-only is sufficient for THIS rehearsal since it is DDL).
2. hand_state_snapshots + hand_history: confirm the prune cron's retention
   (hand facts are already captured at prune into ca_hand_facts /
   ca_hand_transfers, so aggressive retention is safe).
3. solved_spots_gold: 80 GB of static data dominates the disk bill; move to
   cheaper storage or a separate project if the trainer can read it there.
4. Re-check pg_stat_user_indexes for never-scanned indexes after the
   corrected statistics have aged a week (1,461 candidates / 1.35 GB were
   flagged before ANALYZE fixed the estimates - recount before dropping).

## 4. Weekly Revenue Digest (Live)

`fn_ca_weekly_revenue_digest(7)` + cron `ca-revenue-digest-weekly` (Mondays
13:00 UTC, one push to the registered recipients - kingfish only). Sums come
from clean ledger categories; cert/bot flow is broken out, not hidden.
First real run's 7-day numbers (verification run, rolled back):
cash rake 27,882.75 | tournament and spin rake 5,640.60 | minted 400,000 |
burned 500,000 | bbj contributions 1,570.94 | suspense flow 334,890.96
(pre-fix era) | cert player flow 5,595,296.03 (excluded from the headline) |
unexplained supply net 3,288,324.67 (dominated by the pre-guard mint era,
before 2026-08-31 20:00 UTC).

## 5. What Phase 6 Deliberately Did NOT Do

- No Supabase branch was created: $0.01344/hr is trivial, but a schema-only
  branch cannot rehearse a data reset, and the rolled-back-transaction
  rehearsal is strictly stronger. A branch IS the right tool for the
  partitioning DDL rehearsal (item 3.1) when that lands.
- No PITR restore was executed: it creates a billable second project and is
  Dan's call; the runbook above is ready.

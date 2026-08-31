# Deployment Report, Midway Epoch Integration, Acceptance Criteria, Remaining Work

## 1. What was deployed (2026-08-31, production `kuklfnapbkmacvwxktbh`)

Applied via Supabase MCP, mirrored byte-exactly in `supabase/migrations/`:

| Version        | Name                                        | Contents                                                                                                                                                                         |
| -------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20260831142753 | ca_incident_core                            | incidents, events (append-only), recipients, raise/notify/escalate/action/dashboard fns, reconcile-log + financial-alerts wiring, escalation cron                                |
| 20260831143501 | ca_ledger_hardening                         | chip_ledger full-record columns, widened account/category vocab, exact-scale, append-only on 5 journals, checksum enrichment + verifier, epochs, account registry, suspense view |
| 20260831144023 | ca_full_ledger_coverage_fn                  | generic auto-ledger writer (+ trigger attaches, applied as separate short transactions to avoid deadlocking live traffic)                                                        |
| 20260831144351 | ca_ledger_guc_plumbing_rake_bbj_horse       | rake/BBJ/horse RPCs declare categories + autoskip                                                                                                                                |
| 20260831144826 | ca_leak_fixes                               | promo_apply_playthrough lockdown+precision, rebuy seat guard, fn_credit_chips precision, bbj promo payout → club promo + idempotency, log_wallet_transaction balance fix         |
| 20260831144915 | ca_ledger_categories_addon_cashout_transfer | category GUCs                                                                                                                                                                    |
| 20260831145042 | ca_ledger_categories_buyin_credit           | category GUCs (buy-in + shared credit path)                                                                                                                                      |
| 20260831145242 | ca_quick_reconcile_and_settlements          | settlement state machine, supply snapshots, quick-reconcile, auto-repair tick, 4 crons                                                                                           |

Deployment notes: two DDL attempts deadlocked against live traffic (40P01) — resolved by
grouping hot-table DDL, `SET LOCAL lock_timeout`, and applying trigger attaches as separate
short transactions. One side effect was caught by the new system itself (a winner credit
retried into the lock window), repaired automatically by the standing reconciler, and
root-caused in the incident trail. No tables, games, or wallets were locked at any point; no
chips were lost.

Verification: live rows enriched within seconds; append-only rejection verified against
production; all 15 probes PASS (rolled back); auto-journal rows observed for union rake wallet,
club wallet accumulator, BBJ pools (main/backup/promo per hand), spin reserve; categorized
`rake` rows flowing within seconds of the patch.

## 2. This PR (repo integration)

Migration mirrors; `/financial-incidents` dashboard (service + page + CSS + route + Financial
Admin Hub tile/KPI); probe suite; these documents. Companion World Hub PR: player-retention raw
mint → capped `fn_credit_chips`; parseFloat fixes; durable idempotency on settle-period,
rakeback, manage-agent, leave-club, union-invoice.

## 3. Midway Union master reset — financial epoch 3 procedure

The hardened ledger is live now, so the reset lands on already-hardened rails. When Dan calls it:

1. Freeze intake: pause new Midway tournaments/schedules (operational choice, not a drift lock).
2. Run the full reconciliation set + probes; resolve all open incidents (nothing `unknown`).
3. Take backups + a supply snapshot; verify checksum chain.
4. Post the reset as balanced ledger entries in one correlation: player/club/union balances to
   their reset values via explicit `chip_retirement` / `issuance_reserve` entries — never direct
   balance UPDATEs (the auto-journal would flag them as suspense anyway). Include the frozen
   `public.wallets` 732.59M disposition: formal retirement entries, then drop-guard the table.
5. `UPDATE ca_financial_epochs SET is_current=false WHERE is_current; INSERT ... epoch-3-midway-reset, is_current=true;`
   New baselines: `ca_treasury_baseline`, `ca_chip_baseline`, `ca_frozen_pool_baseline`,
   fresh `ca_supply_snapshots` row.
6. Re-run probes + one shadow reconcile cycle clean (all detectors green for 24h of horse-only
   play) BEFORE Midway/Shark/JAQK reopen normal tables — the acceptance gate the directive sets.

## 4. Acceptance criteria mapping

Met at the database layer (enforced + verified): every chip movement journaled; posted rows
balanced-by-construction and immutable; corrections traceable; historical evidence immutable;
idempotency-key uniqueness; duplicate settlements/payouts rejected (state machine + existing
unique claims); exact 2dp amounts; every discrepancy → management push + immediate automated
reconciliation + 5/10/15/20 escalation; no drift response locks anything; invalid transactions
roll back atomically; rake/BBJ/tournament/spin reconcile via the standing checks now wired to
incidents; cross-club/cross-union isolation checks (existing union-law guards + commingling
reports feed alerts→incidents); cached balances rebuildable from ledger + baselines; incident
dashboard with acknowledge/assign/comment/resolve.

Partially met (named follow-ups): direct-mutation elimination (all mutations journaled +
suspense-visible; DB permission lockdown of balance columns pending), category coverage
(top-volume paths done; mid-volume RPCs pending — measured daily by the suspense incident),
settlement state machine (DB machine live; engine adoption pending), weighted-rake exactness
(attribution allocator + mismatch alerts pre-existing; per-hand sum check feeds incidents),
credit lines (cannot mint by design in agent-wallet paths; explicit receivable modeling pending),
observability metrics (DB-side counters live; Grafana/engine metric export pending).

Pending: engine `syncStacks` atomicity (see §5), property-based random-game-sequence CI tests
(DB probe suite live today), World Hub PR merge, removal of legacy posting paths (two paths never
run concurrently for the same movement today — autoskip enforces single-posting — but legacy
primitives still exist and are journaled rather than removed).

## 5. Remaining risks (ranked) and next steps

1. **Engine `syncStacks`** — last multi-step JS money path; hard-kill can strand a partial hand
   write. Next: post per-hand net deltas through a settlement RPC keyed by
   `settlement_idempotency_keys`, adopting `ca_settlements`; until then `drainHands()` covers
   deploys and the per-hand StateVerifier + session equation detect residue.
2. **`fn_union_settle_player_pnl`** partial-failure trap; add resumable leg claims.
3. **Un-idempotent movers** (`fn_union_send_to_member`, `transfer_chips_agent_to_player`,
   `fn_mint_club_chips`, treasury primitives, `fn_union_credit/debit_wallet`) — add op_id claims.
4. **`buyin.js` diamonds→chips** contradiction + `orb1_buyin_transaction` overload ambiguity —
   needs Dan's ruling; then revoke like `purchase-chips`.
5. **Grant sweep**: revoke latent anon/authenticated DML on journals + idempotency tables;
   forbid balance-column UPDATE for app roles outside approved RPCs.
6. **Parallel balance columns** (`clubs.chip_pool`, `unions.*`, `bbj_pools.pool_amount`) —
   consolidate; divergence is at least journaled now.
7. **`club_wallets.chip_balance` accumulator** — verify period settlement never double-pays
   accumulator + treasury for the same rake; retire the accumulator or rename it.
8. **Browser-resident settlement cron** (`FinancialCronService`) — move to Workers.
9. **Tournament play-chip 0.012% fractional drift** — root-cause the multi-table split.
10. **`fn_tournament_chip_conservation_check`** lives only in the live DB — export to a
    versioned migration.

## 6. Round 2 (same day, 15:40–16:00 UTC) — follow-ups closed

Applied and verified live (`20260831154012` … `20260831154426` + grant revokes):

- **Severity-aware escalation**: criticals keep the full 5/10/15/20-minute drumbeat + controlled
  post-target repeats; warnings get one 5-minute update and one past-target notice; info stays
  dashboard-only. (The suspense-flow rollup is info now — it is a category-migration metric,
  not a discrepancy.)
- **Repair-wiring bug found and fixed**: `fn_rake_bbj_audit` incidents classified as
  `incorrect_rake`, so the repair tick ran only the rake redrive and 10 unbanked BBJ drops sat
  from 14:10–15:07 (all Midway club). Both redrives now run for either classification, those
  incidents auto-verify against the live unbanked counts, and a standing 15-minute
  `ca-bbj-repair-unbanked-15m` cron self-heals unbanked drops even with no incident open. The 10
  drops were banked into the Midway union pool (verified zero remain). Engine-side root cause
  (~2% of banking calls dropped under load) is an open engine follow-up — now harmless.
- **Quick-reconcile v2**: credit-line members are checked against their BOUND
  (balance < −credit_limit ⇒ `credit_line_error`); stuck `union_pnl_settlements`
  (`in_progress` > 10 min — the half-collected trap) raise critical incidents.
- **Auto-repair v2**: winner-prize incidents self-resolve once the payout reconciler's credit is
  verified in `wallet_transactions`; rake/BBJ audit incidents self-resolve when the 2-hour window
  shows zero unbanked fees.
- **Browser write-blocks** added to `union_wallets`, `club_wallets`, `bbj_pools`,
  `spin_bonus_pools` (service/definer paths unaffected).
- **Grant sweep**: INSERT/UPDATE/DELETE revoked from `anon`/`authenticated` on all five journals,
  both idempotency key tables, `ca_seat_stack_exits`, and `ledger_reconcile_log` (latent risk
  behind RLS, now structural).
- **Duplicate suppression** (20-second identity window, no signature changes):
  `fn_mint_club_chips` (also now journals as `mint` against `issuance_reserve`) and
  `fn_union_send_to_member` (also journals one clean `union_send`/`promo_send` row per send).
  `transfer_chips_agent_to_player` no longer exists (replaced by the concurrent agent-wallet
  workstream) — dropped from the follow-up list.
- **Supply snapshot v2**: in-flight tournament prize/bounty/fee liabilities are now counted, so
  open tournaments no longer read as unexplained supply loss (first reading was 20.6K of exactly
  that). The first snapshot after the change carries a one-time baseline shift (~79K), noted here
  so nobody chases it.
- **Dashboard fixes from line-by-line review**: `fn_ca_incident_dashboard(NULL)` now returns ALL
  statuses (the Resolved tab was structurally empty); event-timeline `detail` (jsonb) is
  normalized to a string in the service (rendering an object as a React child crashes); the page
  gained Auto-Repairing and Unclassified-Flow-Today stat cards fed by `fn_ca_drift_metrics()`.
  The three dashboard files typecheck clean (permissive stubs; the repo's strict `TypeScript
Check` gate does the final pass on PR).

Live incident-board state at close: zero open incidents; 30 resolved today, every one with a
recorded root cause; the day's real finds (12 winner-prize credit failures during the DDL lock
windows, 10 unbanked BBJ drops, 1 rake-law evidence gap) all repaired and verified.

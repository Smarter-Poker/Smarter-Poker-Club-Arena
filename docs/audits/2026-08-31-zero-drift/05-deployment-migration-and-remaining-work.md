# Deployment Report, Midway Epoch Integration, Acceptance Criteria, Remaining Work

## 1. What was deployed (2026-08-31, production `kuklfnapbkmacvwxktbh`)

Applied via Supabase MCP, mirrored byte-exactly in `supabase/migrations/`:

| Version | Name | Contents |
|---------|------|----------|
| 20260831142753 | ca_incident_core | incidents, events (append-only), recipients, raise/notify/escalate/action/dashboard fns, reconcile-log + financial-alerts wiring, escalation cron |
| 20260831143501 | ca_ledger_hardening | chip_ledger full-record columns, widened account/category vocab, exact-scale, append-only on 5 journals, checksum enrichment + verifier, epochs, account registry, suspense view |
| 20260831144023 | ca_full_ledger_coverage_fn | generic auto-ledger writer (+ trigger attaches, applied as separate short transactions to avoid deadlocking live traffic) |
| 20260831144351 | ca_ledger_guc_plumbing_rake_bbj_horse | rake/BBJ/horse RPCs declare categories + autoskip |
| 20260831144826 | ca_leak_fixes | promo_apply_playthrough lockdown+precision, rebuy seat guard, fn_credit_chips precision, bbj promo payout → club promo + idempotency, log_wallet_transaction balance fix |
| 20260831144915 | ca_ledger_categories_addon_cashout_transfer | category GUCs |
| 20260831145042 | ca_ledger_categories_buyin_credit | category GUCs (buy-in + shared credit path) |
| 20260831145242 | ca_quick_reconcile_and_settlements | settlement state machine, supply snapshots, quick-reconcile, auto-repair tick, 4 crons |

Deployment notes: two DDL attempts deadlocked against live traffic (40P01) - resolved by
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

## 3. Midway Union master reset - financial epoch 3 procedure

The hardened ledger is live now, so the reset lands on already-hardened rails. When Dan calls it:

1. Freeze intake: pause new Midway tournaments/schedules (operational choice, not a drift lock).
2. Run the full reconciliation set + probes; resolve all open incidents (nothing `unknown`).
3. Take backups + a supply snapshot; verify checksum chain.
4. Post the reset as balanced ledger entries in one correlation: player/club/union balances to
   their reset values via explicit `chip_retirement` / `issuance_reserve` entries - never direct
   balance UPDATEs (the auto-journal would flag them as suspense anyway). Include the frozen
   `public.wallets` 732.59M disposition: formal retirement entries, then drop-guard the table.
5. `UPDATE ca_financial_epochs SET is_current=false WHERE is_current; INSERT ... epoch-3-midway-reset, is_current=true;`
   New baselines: `ca_treasury_baseline`, `ca_chip_baseline`, `ca_frozen_pool_baseline`,
   fresh `ca_supply_snapshots` row.
6. Re-run probes + one shadow reconcile cycle clean (all detectors green for 24h of horse-only
   play) BEFORE Midway/Shark/JAQK reopen normal tables - the acceptance gate the directive sets.

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
(top-volume paths done; mid-volume RPCs pending - measured daily by the suspense incident),
settlement state machine (DB machine live; engine adoption pending), weighted-rake exactness
(attribution allocator + mismatch alerts pre-existing; per-hand sum check feeds incidents),
credit lines (cannot mint by design in agent-wallet paths; explicit receivable modeling pending),
observability metrics (DB-side counters live; Grafana/engine metric export pending).

Pending: engine `syncStacks` atomicity (see §5), property-based random-game-sequence CI tests
(DB probe suite live today), World Hub PR merge, removal of legacy posting paths (two paths never
run concurrently for the same movement today - autoskip enforces single-posting - but legacy
primitives still exist and are journaled rather than removed).

## 5. Remaining risks (ranked) and next steps

1. **Engine `syncStacks`** - last multi-step JS money path; hard-kill can strand a partial hand
   write. Next: post per-hand net deltas through a settlement RPC keyed by
   `settlement_idempotency_keys`, adopting `ca_settlements`; until then `drainHands()` covers
   deploys and the per-hand StateVerifier + session equation detect residue.
2. **`fn_union_settle_player_pnl`** partial-failure trap; add resumable leg claims.
3. **Un-idempotent movers** (`fn_union_send_to_member`, `transfer_chips_agent_to_player`,
   `fn_mint_club_chips`, treasury primitives, `fn_union_credit/debit_wallet`) - add op_id claims.
4. **`buyin.js` diamonds→chips** contradiction + `orb1_buyin_transaction` overload ambiguity -
   needs Dan's ruling; then revoke like `purchase-chips`.
5. **Grant sweep**: revoke latent anon/authenticated DML on journals + idempotency tables;
   forbid balance-column UPDATE for app roles outside approved RPCs.
6. **Parallel balance columns** (`clubs.chip_pool`, `unions.*`, `bbj_pools.pool_amount`) -
   consolidate; divergence is at least journaled now.
7. **`club_wallets.chip_balance` accumulator** - verify period settlement never double-pays
   accumulator + treasury for the same rake; retire the accumulator or rename it.
8. **Browser-resident settlement cron** (`FinancialCronService`) - move to Workers.
9. **Tournament play-chip 0.012% fractional drift** - root-cause the multi-table split.
10. **`fn_tournament_chip_conservation_check`** lives only in the live DB - export to a
    versioned migration.

## 6. Round 2 (same day, 15:40-16:00 UTC) - follow-ups closed

Applied and verified live (`20260831154012` … `20260831154426` + grant revokes):

- **Severity-aware escalation**: criticals keep the full 5/10/15/20-minute drumbeat + controlled
  post-target repeats; warnings get one 5-minute update and one past-target notice; info stays
  dashboard-only. (The suspense-flow rollup is info now - it is a category-migration metric,
  not a discrepancy.)
- **Repair-wiring bug found and fixed**: `fn_rake_bbj_audit` incidents classified as
  `incorrect_rake`, so the repair tick ran only the rake redrive and 10 unbanked BBJ drops sat
  from 14:10-15:07 (all Midway club). Both redrives now run for either classification, those
  incidents auto-verify against the live unbanked counts, and a standing 15-minute
  `ca-bbj-repair-unbanked-15m` cron self-heals unbanked drops even with no incident open. The 10
  drops were banked into the Midway union pool (verified zero remain). Engine-side root cause
  (~2% of banking calls dropped under load) is an open engine follow-up - now harmless.
- **Quick-reconcile v2**: credit-line members are checked against their BOUND
  (balance < −credit_limit ⇒ `credit_line_error`); stuck `union_pnl_settlements`
  (`in_progress` > 10 min - the half-collected trap) raise critical incidents.
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
  workstream) - dropped from the follow-up list.
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

## 7. Phased build-out log

**Phase 1 of 5 - structural watchdogs (16:05-16:10 UTC, `20260831160515` + regex fix).**
`ca_guard_inventory` (63 guards: every zero-drift trigger, cron, constraint, index, function and
grant revoke) with a daily integrity check that raises a critical incident if any guard is
dropped; `ca_money_rpc_registry` (190 grandfathered functions) with a daily scan that flags any
NEW function writing balance columns; supply-snapshot unexplained-drift thresholds (warning >100,
critical >1000); idempotency-key retention 48h → 30 days; escrow TTL sweep. Verified with live
fault-injection sims (dropped trigger detected; unregistered probe function detected), all
rolled back. The verification itself caught a real bug: `\b` is BACKSPACE in Postgres regex
(`\y` is the word boundary) - the registry had seeded 0 rows and the detector matched nothing.

**Phase 2 of 5 - suspense drain (18:58-19:08 UTC, `20260831185816`-`190800`).**
The four top producers of unclassified (`settlement_suspense`) ledger flow now declare
category/counterparty via the GUC contract: `fn_spin_settle_game` (spin_entry/spin_prize vs
prize_liability entity=tournament; seed repayment as one clean treasury_transfer row with the
destination leg autoskipped), `fn_settle_tournament_rake` (rake vs prize_liability),
`fn_apply_prize_guarantee` (overlay vs prize_liability), `fn_bbj_repair_unbanked`
(bbj_contribution vs table_stack; header keeps its DEFAULTs - the first apply attempt failed on
42P13). A dropped inner race guard in the bbj function was caught in self-review and restored
25 seconds later (`20260831185841`). The last bare producer turned out to be the engine calling
`increment_union_wallet` directly for spin rake - it now self-declares 'rake' when the caller
set no richer context (`20260831190041`). Found + fixed along the way: the money-RPC drift
detector missed upsert-style writers (`INSERT ... ON CONFLICT DO UPDATE`) - scan widened, 14
upsert writers audited and grandfathered (`20260831190500`). New standing watchdog:
`ca-suspense-regression-15m` (warning incident if >10 rows / >50 chips of new suspense flow in
an hour). Verified live: 541 ledger rows in the first 5 minutes post-cutover with ZERO suspense
rows (vs ~16 suspense rows per 10 minutes before); watchdogs green; fault-injection sim of a
forged suspense row raised the warning (rolled back).

**Phase 3 of 5 - settlement correctness (19:10-19:17 UTC).**
`fn_union_settle_player_pnl` hardened: the entire money section runs in a guarded sub-block -
any error rolls every chip movement back, persists the claim as `failed` (excluded from the
uniqueness index, so a retry just works), records detail on `ca_settlements`, raises a CRITICAL
settlement_error incident, and returns `{success:false}` instead of exploding; every run now
walks the `ca_settlements` state machine (open → … → final, single-step guard) and its
collect/pay legs journal as `pnl_settlement` (the last regular suspense producer). Verified with
a sabotage-trigger sim: failure path lands claim=failed, machine=failed, incident raised, zero
chips moved - and the happy path walks to `final`. New 30-minute
`fn_ca_settlement_correctness_check` sweep: cross-club direct postings (warning
`cross_club_posting`), rakeback over-attribution (attributions > rake collected), rakeback
over-payout (paid > the player's ENTIRE contribution - critical), rakeback dual-write evidence
gaps, ticket conservation, and insurance pair-match (net = payout − premium). All six verified
by forged-violation sims (4 incidents raised, rolled back); the live estate scanned clean.
`fn_ca_gdpr_financial_precheck` reports every financial reason an account cannot close
(balances, seats, pending rakeback, outstanding tickets, agent balances/credit) and is wired
into `fn_delete_user_gdpr` - a user holding chips is refused with the blocker list instead of
being half-anonymized (verified: 45 blockers on a live busy account, rolled back). Deliberate
scope call: insurance mismatch auto-repair is not wired because the class has never fired;
detection is standing and repair is a projection rebuild away if it ever does.

**Phase 4 of 5 - evidence & forensics (19:21-19:45 UTC).**
Shipped: `ca_hand_financial_facts` (a BEFORE DELETE trigger on `hand_history` captures the
compact money facts - pot, rake, BBJ, winners - of any money-bearing hand the instant the prune
sweep deletes it; never blocks a prune; 90-day self-retention); `fn_ca_balance_asof` (point-in-
time balance of any account from the ledger's recorded pre/post balances, backed by two new
concurrently-built entity+time indexes); the daily attestation digest (06:10 UTC push to
platform recipients - green days say "all green" explicitly); and `ca_ledger_day_manifests`
(daily SHA-256 manifest over each day's ledger rows - recompute mismatch = CRITICAL tamper
incident; verified by a rolled-back forge sim).

**The first live attestation caught two real problems immediately.** (1) Three hands' rake
(7.2 chips + 0.5 BBJ) failed to queue at 19:23 because PostgREST reloads its schema cache after
DDL - recovered by re-queuing from the alert metadata and running the standing redrive (which
now also stamps `resolved_at`; it never did, so banked queue rows were rescanned forever).
(2) **The supply monitor's 2.69M "unexplained" was real minting**: the engine calls
`atomic_table_cashout` for horse seats on tournament-attached tables, crediting play-chip
stacks to `club_members.chip_balance` as real chips - zero matching debits, **46.4M chips
created into horse wallets since 2026-08-24**. Blocked at the DB layer 19:33 UTC: tournament-
table seats now close with no wallet credit (tournament results settle only through the payout
path), each blocked attempt raises a warning incident, and the guard was verified by a
rolled-back probe. The minted 46.4M sits in house horse wallets and is queued for formal
`chip_retirement` entries at the Midway epoch-3 reset (§3), alongside the frozen
`public.wallets` pool. Engine-side exit-path fix is a tracked follow-up. Incident board at
phase close: zero open criticals; every resolution carries a root cause.

**Phase 5 of 5 - engine landing pad + ship (19:50-20:05 UTC).**
`fn_ca_settle_hand_stacks` is live: one RPC settles a hand's stack deltas atomically or not at
all - idempotent on `settlement_idempotency_keys` (replays return the stored result),
conservation-checked to the cent, state-machined through `ca_settlements`, stacks-only. Five
rolled-back probes verified happy path, replay, conservation reject, negative-stack reject, and
ghost-seat reject. `ca_pending_promo_accruals` + a 10-minute retry cron give failed promo
accruals the same queue-and-redrive safety rake already has. `fn_ca_midway_burnin_gate(hours)`
is the executable form of §3 step 6: eleven named pass/fail checks; reopening
Midway/Shark/JAQK requires `pass:true` over 24 hours of horse-only play after the epoch-3
reset (on 2026-08-31 it correctly fails on the two criteria the mint discovery dirtied). The
engine adoption guide - syncStacks call contract, promo/rake enqueue-on-failure, the
tournament-exit branch fix, and the byte-exact migration export script - is doc 06; repo
integration of the phase 2-5 migrations rides `scripts/dev/export-applied-migrations.sh`
(coordinates with CA #2309's name-keyed check). The parallel workstream merged CA #2300 and
WH #1135, so the original bundle's dashboard + round-1 migrations are already on main.

**Phase-5 close-out sweep (19:50-20:15 UTC), after Dan's 404 report.** The notification 404
was deploy lag, not a wiring bug: the tap at 19:34 hit the production build from 19:29, which
predates #2300; the 19:37 sync contains the route, verified live in the deployed bundle
(`index-BChw_tB7-v6.js` carries `financial-incidents`). Notification deep links now also land
on, expand, and flash the exact incident (`?id=` handling, in the phase-5 PR). Implemented both
outstanding rulings: buyin.js (dead since 04-29's hard-fail stub) becomes an honest 410 and
`fn_atomic_buyin` journals diamond→chip conversion as `mint` vs `issuance_reserve`;
split-pot bounties split by claim weight (cents, largest remainder, conserving) via
`fn_collect_bounty(p_claimants)` - probe-verified, legacy single-collector calls unchanged.
The epoch-3 reset is now EXECUTABLE: `fn_ca_epoch3_preflight()` +
`fn_ca_execute_epoch3_reset(confirm, dry_run)` - dry-run by default (live dry-run measured the
full retirement: 89.76M of horse tournament-mint across 424 accounts, all-time, plus the
732.59M frozen pool), execute mode refuses without the literal confirmation AND a passing
preflight. The engine adoption is one added argument (`fn_ca_settle_hand_stacks_absolute`
computes deltas server-side, conservation-strict once rake is wired). The regression watchdog
also caught tonight's New Club Opening Bank (#2311) writing 100K floats as suspense within 20
minutes of it shipping - now journaled as mint. Blocked-mint warnings consolidated to one
deduped incident per day (31 per-table incidents for one root cause was notification spam).

Phase-5 verification earned its keep twice: the final sweep found tournament-mint rows STILL
flowing after the first guard - the engine exits seats through a second path
(`atomic_credit_wallet_and_log(..., 'cashout', table_id)`), guarded at 19:41 UTC. Since then:
zero mint, with the guards actively refusing 212K+ chips of attempted tournament cashouts in
the first two minutes (deduped `tourney-cashout-blocked:*` warnings per table). The burn-in
gate honestly fails today on `no_new_criticals_in_window`, `zero_blocked_tournament_mints`,
and `last_supply_snapshot_explained` - all three clear once the engine exit path is fixed and
a clean snapshot day passes.

# 2026-08-29 — Weighted Contributed Rake (equal-dealt attribution retired)

Dan, 2026-08-29, binding: cash-game player rake credit moves from equal-dealt
split (FIX 144 / DECISION D-001 — reversed by Dan in this directive) to
**weighted contributed rake**, plus per-player BBJ contribution tracking.

    playerWeightedRakeCredit =
      playerEligibleContribution / totalEligibleContributions x regularRake

## A. Previous architecture (equal-dealt)

- The engine captured per-player eligible contribution (`totalInvested`, net
  of returned uncalled bets — `returnUncalledBet()` decrements it before
  capture) into `rake_records.player_contributions` — but the value was used
  only as a `> 0` filter.
- Every consumer then split `rake_amount / N` equally over positive
  contributors: `RakebackSettlerService.equalShareCents` (rakeback periods,
  agent commissions, player_stats), `fn_rakeback_recompute_periods`,
  `fn_club_rake_rollup_day`, `fn_agent_downline_rake` (edge window),
  `fn_close_settlement_period` (which divided by ALL dealt keys, zero
  contributors included — an outlier), `fn_bbj_rollup_day`.
- Two consumers were ALREADY weighted (`fn_agent_roster_report`,
  `fn_agent_weekly_statement`, plus `ca_hand_facts.rake_paid` and
  `fn_bbj_my_contribution`) — the estate attributed the same rake two ways.
- Cash VIP points accrued on raw chips wagered (mislabelled "1 pt per rake
  chip"), while tournament VIP accrued on attributed rake.
- `rake_attributions` existed with a unique (hand_id, player_id) guard and 0
  rows — no per-player rake was ever persisted.

## B. New architecture (weighted contributed)

- **One allocator.** `public.fn_allocate_rake_credits(amount, contributions,
method)` (SQL) and `server/src/services/rakeAllocation.ts` (TS mirror,
  BigInt-exact). Integer cents, floor + largest remainder, ties by user_id
  ASC. Deterministic; Σ credits == round(rake, 2) exactly, every hand.
  Method `'DEALT_EQUAL'` reproduces the historical equal split bit-for-bit and
  exists ONLY to process historical rows.
- **Per-player ledger.** `atomic_distribute_rake` (money legs unchanged) now
  stamps `rake_records.rake_method` + `returned_uncalled` and writes one
  `rake_attributions` row per contributor in the same transaction:
  gross/returned/eligible contribution, weight, weighted_rake_credit,
  bbj_attributed_contribution, rake_method. Idempotent on first-claim +
  (hand_id, player_id).
- **BBJ per-player tracking (Dan's second ask).** The hand's BBJ drop is
  attributed with the same contribution weights into
  `rake_attributions.bbj_attributed_contribution`, and `fn_bbj_rollup_day`
  (feeding `bbj_daily_user` → union BBJ reports) is now weighted per-record.
  Accounting attribution only: BBJ eligibility, payout split and pool banking
  are untouched.
- **Migration boundary is per-hand and deterministic.** The RPC's
  `p_rake_method` defaults to `'DEALT_EQUAL'`; the old engine (until deploy)
  keeps producing equal rows, the new engine passes
  `'WEIGHTED_CONTRIBUTED'`. Every consumer branches per row on
  `rake_method`. Historical rows are never re-attributed.

## C. Files changed (Club Arena)

- `supabase/migrations/20260829_weighted_contributed_rake.sql` (new; applied
  to production via Supabase MCP) — schema, allocator,
  `atomic_distribute_rake` v2, `fn_rakeback_recompute_periods`,
  `fn_close_settlement_period`, `fn_club_rake_rollup_day`,
  `fn_agent_downline_rake`, `fn_bbj_rollup_day`,
  `fn_award_vip_points_from_rake`, `fn_hand_rake_breakdown` (admin
  drill-down), `fn_rake_attribution_drift` (watchdog), self-test DO block
  asserting the directive's §35–§38 reference hands.
- `server/src/services/rakeAllocation.ts` (new) + `rakeAllocation.test.ts` (new)
- `server/src/services/RakebackSettlerService.ts` — method-aware shares at all
  three credit sites (periods, commissions, player_stats)
- `server/src/services/FeeReconciler.ts` — queue carries
  `rake_method`/`returned_uncalled`; re-drive preserves methodology; new
  `auditRakeAttributionDrift`
- `server/src/GameServer.ts` — drift audit wired into the reconcile cycle
- `server/src/types.ts`, `server/src/engine/HandController.ts` —
  `returnedUncalled` per-player first-class state
- `server/src/engine/ServerTableEngineBase.ts`, `...Dealing.ts`,
  `...HandEvents.ts`, `...Settlement.ts` — capture + pass returned-uncalled
  and the method stamp
- `server/src/services/supabase/handFacts.ts` — `ca_hand_facts.rake_paid` now
  uses the canonical allocator (was an inline float split)
- `src/services/AgentRakeService.ts` — header corrected to the weighted law
- `tests/config/weightedContributedRake.law.test.ts` (new law pins)
- `scripts/verification-harness/02-weighted-contributed-rake.sql` (new);
  `02-equal-share-rake.sql` retired (it referenced dropped tables and could
  not run)
- `.memory/decisions/004-weighted-contributed-rake.md` (new);
  `001-rake-equal-share.md` marked superseded; SUMMARY.md updated

## D. Database changes

- `rake_records`: + `rake_method` (default `'DEALT_EQUAL'`, CHECK), +
  `returned_uncalled jsonb`
- `rake_attributions`: + rake_record_id, table_id, club_id,
  gross_contribution, returned_uncalled, eligible_contribution,
  contribution_weight, weighted_rake_credit, bbj_attributed_contribution,
  rake_method
- `pending_fee_distributions`: + `rake_method`, `returned_uncalled`
- Functions as listed in C. `atomic_distribute_rake` old signature dropped;
  new signature appends two DEFAULTed params so the pre-deploy engine keeps
  calling it unchanged.

## E. Downstream systems audited

| System                                                       | Basis now                                              |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| Rakeback periods (settler + recompute + close)               | weighted per-row method                                |
| Agent commissions (`rake_credit` input)                      | weighted per-row method                                |
| player_stats (`total_rake`)                                  | weighted per-row method                                |
| Agent downline live view / daily rollups                     | weighted per-row method                                |
| Agent roster/weekly statement RPCs                           | already weighted — unchanged                           |
| VIP points (cash trigger)                                    | **weighted rake credit** for new hands (see risk 1)    |
| ca_hand_facts.rake_paid                                      | canonical allocator (already weighted, now cent-exact) |
| BBJ per-player attribution (`bbj_daily_user`, ledger column) | weighted                                               |
| BBJ banking / eligibility / payouts                          | untouched                                              |
| Club/union rake collection (wallet legs)                     | untouched                                              |
| Tournament fees                                              | untouched (out of scope per directive §29)             |

## F. Invariants + observability

- Migration aborts if the allocator disagrees with the directive's reference
  hands (§35–§38) or the legacy parity vector.
- `fn_rake_attribution_drift` + `FeeReconciler.auditRakeAttributionDrift`
  (daily cycle) file a **critical** `financial_alerts` row
  (`RAKE_ALLOCATION_MISMATCH`) if any weighted hand's ledger stops summing to
  its rake.
- `fn_hand_rake_breakdown(hand_id)` gives admins the full per-hand
  reconciliation object (gross pot, rake, BBJ, per-player contributions,
  weights, credits, valid flag).

## G. Known risks / flagged decisions

1. **Cash VIP point magnitude.** The old trigger awarded ~1 pt per chip
   WAGERED; the directive (§20) makes weighted rake credit the authoritative
   basis, so per-hand VIP accrual drops to rake scale (matching the
   tournament path). Historical points are untouched. If Dan wants the old
   wagered-chip economy back, it is one trigger function to revert —
   flagged loudly in the handoff.
2. **CLOSED in the residue sweep (same PR):** `RakebackDashboard.tsx` used to
   derive an independent rakeback estimate from `wallet_transactions`
   category 'rake' debits (a category cash players never receive) with its
   own 10-30% ladder. It now reads `rakeback_periods` (authoritative weighted
   pipeline), real rakeback wallet credits, and `player_stats.hands_played`,
   with the server's 5/10/15/20/30 weekly ladder mirrored for display.
3. **CLOSED in the residue sweep (same PR):** `server/src/engine/
RakebackEngine.ts` (the FIX 144 equal-share accumulator, inert since
   RAKE-AUDIT 2026-07-24) is DELETED, along with its instantiation, configure
   and dispose wiring in `ServerTableEngineBase.ts`.
4. **CLOSED in the residue sweep (same PR):** `CommissionService.attributeRake`
   and `getPlayerRakeTotal` (dead client-side attribution writers/readers from
   the pre-server-authoritative era, zero callers, writes already blocked by
   rake_attributions RLS) are deleted. rake_attributions is written
   exclusively by atomic_distribute_rake.
5. World Hub `pages/api/club-arena/rakeback.js` performs no splitting (safe);
   its stale equal-share comments are refreshed in World Hub PR #919.

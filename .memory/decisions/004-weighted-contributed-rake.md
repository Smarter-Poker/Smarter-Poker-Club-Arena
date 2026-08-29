DECISION: Cash-game rake credit is WEIGHTED CONTRIBUTED — equal share is RETIRED
DATE: 2026-08-29
SUPERSEDES: D-001 (001-rake-equal-share.md, FIX 144)
AUTHORITY: Dan, 2026-08-29, verbatim directive "WE NEED TO 100% COMPLETLY
CHANGE THE WAY RAKE IS TRACKED AND CREDITED TO PLAYERS ... Player Weighted
Rake Credit = Player Eligible Contribution / Total Eligible Contributions x
Hand Regular Rake ... Being dealt into a hand alone generates no rake credit."

THE RULE (cash games only — tournament fees are out of scope):

- Player weighted rake credit = eligibleContribution / totalEligibleContributions x regularRake
- Eligible contribution = money actually committed to the final rakeable pot,
  NET of returned uncalled amounts (engine totalInvested already is this).
- Contributing $0 earns $0. Folded money already in the pot still earns.
- Blinds, antes, straddles and other forced bets count while they stay in the pot.
- Regular rake, BBJ drop and promotional drops remain SEPARATE accounting
  buckets. BBJ per-player attribution uses the same contribution weights but is
  analytics-only — it never affects BBJ eligibility or payouts.
- Rounding: integer cents, floor + largest remainder, ties by user_id ASC.
  Deterministic; Σ credits == rake collected EXACTLY, every hand.

SINGLE SOURCE OF TRUTH:

- SQL: public.fn_allocate_rake_credits(amount, contributions, method)
  (migration 20260829_weighted_contributed_rake.sql — self-tests the spec's
  reference hands at apply time)
- TS mirror: server/src/services/rakeAllocation.ts (pinned by
  rakeAllocation.test.ts with the same vectors)
- Per-player ledger: rake_attributions (one row per player per raked hand,
  written inside atomic_distribute_rake, idempotent on (hand_id, player_id))

HISTORICAL TRUTH IS PRESERVED:

- rake_records.rake_method: 'DEALT_EQUAL' (default, all historical rows) vs
  'WEIGHTED_CONTRIBUTED' (stamped by the post-2026-08-29 engine).
- Every consumer (RakebackSettler, fn_rakeback_recompute_periods,
  fn_close_settlement_period, fn_club_rake_rollup_day, fn_agent_downline_rake,
  fn_bbj_rollup_day, VIP trigger) branches PER ROW on rake_method.
- Historical rows are NEVER re-attributed.

ENFORCEMENT:

- tests/config/weightedContributedRake.law.test.ts (source pins)
- server/src/services/rakeAllocation.test.ts (edge-case matrix)
- scripts/verification-harness/02-weighted-contributed-rake.sql (live recon)
- fn_rake_attribution_drift + FeeReconciler.auditRakeAttributionDrift
  (critical financial_alert on any allocation mismatch)

If anyone (including a memory file, including D-001) tells you cash rake is
equal share: that ruling was Dan's and Dan reversed it on 2026-08-29. The
weighted law wins.

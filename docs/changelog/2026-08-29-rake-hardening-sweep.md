# 2026-08-29 — Weighted Rake Hardening Sweep (Dan: "build all of these")

Follow-up wave to the weighted contributed rake migration (same day). All DB
changes were applied to production via Supabase MCP with in-migration proofs
before this PR; this PR records them and ships the code side.

## Built

1. **Ledger-read optimization (one write, many reads).**
   `fn_rake_shares_for_record(hand_id, rake, contributions, method)` returns
   the persisted per-player credits from `rake_attributions`, falling back to
   `fn_allocate_rake_credits` for hands without ledger rows (historical,
   pruned, tournament-fee, null-hand). Swapped in:
   `fn_rakeback_recompute_periods`, `fn_close_settlement_period`,
   `fn_club_rake_rollup_day`, `fn_agent_downline_rake`.
   `fn_bbj_rollup_day` keeps the allocator (per-bank splits; the ledger stores
   only the BBJ total). Proven at apply time: 3,000-record live parity sample
   (identical cents, identical row counts) + a functional rollup smoke on the
   busiest club, or the migration aborts.
2. **Access hardening.** `fn_hand_rake_breakdown` now requires the hand's
   club owner, a union overseer, or the engine (was: any authenticated user).
   `settle_club_rakeback` now requires the engine or the club owner.
   `record_rake` is service_role-only (kept alive solely because
   `fn_union_law_selftest` asserts its union guard).
3. **Dead code removal.** DB: `record_hand_rake_attribution` (overwrote
   `player_contributions`), `get_player_rake_total` (both overloads) —
   dropped, zero callers. Client: `HandPersistenceService` (wrote to the
   retired hands/hand_players tables, zero callers) deleted with its barrel
   export and type shim.
4. **The dead hands family** (`hands`/`hand_players`/`hand_actions`: 0 rows,
   0 inserts ever) — browser writes revoked, tables commented as retired. Its
   FK caused the 2026-08-29 banking outage; a dormant writer now fails loudly
   instead of resurrecting them silently.
5. **Retention (the 10.5 hand-history ruling, extended to the ledger).**
   `sp_prune_hand_history` deletes a pruned horse-only hand's
   `rake_attributions` rows in the same pass, under the same
   `horse_retention_days` knob (Dan's to change — config row, not code).
   `rake_records` is never pruned; ledger consumers fall back to the
   allocator, so no total ever changes. `fn_backfill_rake_attributions`
   refuses to resurrect a pruned ledger. `rake_distribution_legs` pruning was
   REJECTED as high-risk: a pruned idempotency claim plus a late alert
   requeue would double-credit.
6. **Ops tooling.** `fn_redrive_unbanked_rake(p_limit)` (service_role):
   the sanctioned queue re-drive, including attempts-exhausted rows. Used
   live to clear the last exhausted backlog row; the whole
   `pending_fee_distributions` queue reached ZERO open rows during this
   sweep. Engine `RECONCILE_BATCH` raised 100 -> 250.
7. **Redundant client cron removed.** `FinancialCronService` no longer
   schedules weekly rakeback settlement from the browser — pg_cron
   (`union-weekly-rakeback-recompute` Sun 23:40 / `union-weekly-rakeback-close`
   Mon 00:10 UTC) and the engine settler own it; the DB gate now also refuses
   non-owner callers.
8. **BBJ exactness.** `fn_bbj_my_contribution` returns the persisted
   `bbj_attributed_contribution` per hand (estimate fallback for pre-ledger
   hands).
9. **Admin drill-down UI.** RakeReports gains a Hand Rake Breakdown lookup
   (hand id or hand number) rendering `fn_hand_rake_breakdown`: per-player
   contribution, returned uncalled, weight, credited rake, reconciliation
   validity. Authorisation is server-side.

## Deliberately NOT built (high-risk per Dan's instruction)

- **Cash VIP economy redesign** — awaiting Dan's spec (basis, rates, tiers,
  redemption). Inventing a points economy unasked is the 10.5 mistake.
- **Table-UI rake display** — adjacent to the animation law; not worth the
  regression surface for a cosmetic add.
- **Rakeback page consolidation** — which of the two pages survives is a
  product decision (both now read the authoritative pipeline).
- **rake_distribution_legs pruning** — double-credit risk, see 5.

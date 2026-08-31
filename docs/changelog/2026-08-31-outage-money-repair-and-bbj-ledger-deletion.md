# 2026-08-31 — Outage money repair + BBJ payout-ledger deletion found and guarded

Agent: Claude (Cowork). Phase 2 of the completion plan. Two production
migrations applied via Supabase MCP: `outage_money_repair_requeue_and_reconcile`
and `bbj_ledger_deletion_found_and_guarded` (repo copies in
`supabase/migrations/`).

## Part 1 — 2026-08-30 outage money damage, fully settled

Every critical raised during the outage window was audited and dispositioned:

- **21 lost rake hands (33.76 chips)**: queue inserts failed during the
  timeout storm and nothing retried. Re-queued into
  `pending_fee_distributions` kind='rake' (guarded NOT EXISTS on both
  `rake_records` and the queue); the FeeReconciler banked all 21 within one
  tick. Verified: all 21 in `rake_records`, queue open rows 0.
- **1,033 seat_stack_exit criticals (431,906 chips)**: all cash-table exits
  in the 17:00–21:00 restart storms. `fn_unaccounted_seat_exits('30 hours')`
  = 0 — the boot cash-out sweeps credited every one; the 20:00 reconciler
  snapshot was mid-recovery. Rows annotated as audited-conserved. No chips
  owed.
- **61 fn_spin_unpaid_check alerts**: `v_spin_unpaid_settlements` now returns
  zero rows with chips_short > 0. Resolved, gated per-tournament on the view
  staying clean.
- **147 FeeReconciler.queue_failed alerts**: every one mapped to its hand;
  124 banked anyway, 2 queued, 21 were the lost set above. Resolved only
  where the hand is banked or queued.
- **14 fn_rake_bbj_audit alerts (outage day)**: live audit now returns 0
  violations. Resolved gated on that.
- **FeeReconciler.exhausted (hand 1835578)**: its pending row is resolved
  (banked). Resolved.
- **fn_bbj_contributions_total_verify (-8.46, Aug 21)**: recomputation now
  reports drift 0. Resolved.
- **fn_apply_prize_guarantee (treasury -7,161)**: treasury recovered to
  0.00; the alert's own rule was "escalate only if it survives a weekly
  close". Resolved.
- **fn_tournament_payout_reconcile (0.01 overpay, place 9)**: rounding
  epsilon, reported-only by design. Resolved.

Kept open on purpose: `lapsed_week_unclosed` + `rakeback_settler_lagging`
(Phase 3 is the settler), and `mystery_bounty_double_pay_backlog` (claw-back
is Dan's decision, not an agent's).

## Part 2 — the 71,749.31 BBJ conservation drift: deleted ledger rows

`fn_union_treasury_selftest` showed `bbj_pool_conservation_drift` of
71,749.31 against the 2026-08-25 baseline — and the alert dedup had hidden
it behind the stale Aug-21 alert. Forensic decomposition (read-only, every
claim queried):

- **No chips were lost.** Sixteen `bbj_payouts` rows for the union pool
  f9806a7f — jackpot hits genuinely paid to players July → Aug 21 — were
  DELETED from the ledger between 2026-08-25 22:23Z and 2026-08-30 by an
  un-migrated write. Their `bbj_payout_recipients` cascaded away with them.
- Fingerprint: `bbj_pools.total_paid_out` 172,740.21 − surviving payout rows
  100,990.90 = **71,749.31, exactly the drift**. `last_hit_at` 2026-08-21
  06:04 / 7,883.95 is stamped only in the same transaction as a payout
  insert, yet the newest surviving union payout row is 2026-08-18. Union
  `hit_count` 45 = 5 surviving + 24 merged + 16 missing.
- Cleared suspects: backup→promo transfers (none exist), the selftest's own
  payout probe (rolls back), `sp_prune_hand_history` (protects jackpot
  hands, never touches `bbj_payouts`), all migrations (none delete these
  tables).

Repair: **re-baseline, not reinsertion** — `bbj_payouts` requires winner and
loser user ids we cannot recover, and fabricating a 71k payout against a
real player's name would poison player-facing history. `total_paid_out`
still asserts the truth. Baseline moved to 74,321.90 (2,572.59 accepted
residue + 71,749.31 deleted rows), tolerance stays 1.00 so any new movement
goes red at once. `fn_bbj_conservation_check()` healthy again.

Guard: `fn_bbj_ledger_delete_guard` — BEFORE DELETE triggers on
`bbj_payouts`, `bbj_winners`, `bbj_payout_recipients` copy every deleted row
to the new `bbj_ledger_deletions` table (role + application recorded) and
file a critical alert (deduped hourly). The trigger never blocks — it makes
the failure loud, which is what was missing.

## End state

`fn_union_treasury_selftest` failing checks: only `lapsed_week_unclosed` and
`rakeback_settler_lagging` (Phase 3). Unresolved criticals: those two plus
the mystery-bounty decision for Dan. Conservation healthy: true.

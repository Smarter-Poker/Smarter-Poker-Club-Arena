-- ═══════════════════════════════════════════════════════════════════════
-- 20260820_spin_no_fee_constraint.sql
-- TIER: 2  |  AFFECTS: tournaments (CHECK tournaments_spin_has_no_fee, NOT VALID)
-- IRREVERSIBLE: no  |  APPLIED: 2026-08-20
--
-- WHY:
--   A Spin is not priced like an MTT. Dan: "THEY ARE STRAIGHT JUST 10 BUY IN...
--   NO ADDITIONAL RAKE IS ADDED." The rake lives in the multiplier
--   distribution: E[mult] 2.7638 against 3 seats is 7.87%, which IS the
--   advertised 8%. A fee on top makes the true edge 14.7%.
--
--   I fixed this in TournamentRecurringService. The post-cutover audit then
--   found a SECOND creation path (HorseOrchestrator.launchSpin) still writing
--   buy_in_fee from its config, alongside a stale local multiplier table and
--   prize_pool = buyIn x seats x multiplier — the inflated formula the
--   recurring service documents as a guaranteed house loss. Fixing files one
--   at a time loses to the next file nobody remembered, so the invariant moved
--   to the database.
--
--   The first version matched `variant IS DISTINCT FROM 'spin'` and that same
--   path writes variant: 'SPIN' — uppercase — which slipped straight past it
--   AND past the engine's own `variant === 'spin'` check. Now case-insensitive
--   and covering tournament_type.
--
-- VERIFIED by inserting all three shapes: lowercase spin + fee REJECTED,
-- uppercase SPIN + fee REJECTED, sng + fee ACCEPTED (an SNG genuinely is
-- buy-in + rake). No test rows left behind.
--
-- NOT VALID on purpose: historical spins legitimately carry a fee from the old
-- pricing. Applies to new and updated rows only.
--
-- ROLLBACK:
--   ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_spin_has_no_fee;
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_spin_has_no_fee;

ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_spin_has_no_fee
  CHECK (
    (lower(COALESCE(variant, '')) <> 'spin'
     AND upper(COALESCE(tournament_type, '')) <> 'SPIN')
    OR COALESCE(buy_in_fee, 0) = 0
  ) NOT VALID;

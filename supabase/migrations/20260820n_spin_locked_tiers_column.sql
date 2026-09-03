-- ═══════════════════════════════════════════════════════════════════════
-- 20260820n_spin_locked_tiers_column.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER: 2  |  AFFECTS: public.tournaments (one new nullable jsonb column)
-- IRREVERSIBLE: no  |  APPLIED: 2026-08-20 (migration `spin_locked_tiers_column`)
--
-- WHY
--   SpinWheel already accepted `lockedMultipliers`, rendered
--   `.sw__seg--locked`, shipped the CSS for it and was covered by tests --
--   and nothing ever passed the value. The feature was dead on arrival.
--
--   fn_spin_draw_multiplier ALREADY computes exactly what the wheel needs: a
--   `locked` array of {multiplier, reason, unlocksAt} describing every tier
--   the Reserve Pool could not fund at the moment of THIS draw. That answer
--   was being discarded.
--
--   Persisting it on the tournament row beats recomputing it in the client
--   for two reasons. It is the gate that actually applied to this draw rather
--   than a re-derivation from a pool balance that has since moved; and it
--   needs no new client permission on spin_bonus_pools, which would otherwise
--   expose every club's reserve balance to any authenticated user. (All
--   fn_spin_* functions are SECURITY DEFINER and granted to service_role
--   only -- deliberately.)
--
-- SHAPE
--   [{"multiplier": 500, "reason": "threshold", "unlocksAt": 5000.00}, ...]
--   reason is 'unaffordable' (the pool plus this game's own contribution
--   cannot cover the prize) or 'threshold' (affordable, but not yet backed by
--   the required multiple of its own jackpot at the biggest stake running).
--   NULL means "not recorded" -- every Spin created before this column
--   existed -- and the wheel shows no locked tiers, which is exactly the
--   pre-existing behaviour.
--
-- SAFETY
--   Additive and nullable, so no table rewrite and no existing read or write
--   changes meaning. Nothing reads it until the client is deployed.
--
-- POST-APPLY
--   SELECT count(*) FROM tournaments
--    WHERE lower(coalesce(variant,''))='spin' AND spin_locked_tiers IS NOT NULL;
--   -- rises from 0 once the engine deploy lands
--
-- ROLLBACK
--   ALTER TABLE public.tournaments DROP COLUMN IF EXISTS spin_locked_tiers;
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS spin_locked_tiers jsonb;

COMMENT ON COLUMN public.tournaments.spin_locked_tiers IS
  'Spins only. Tiers the Reserve Pool could not fund at the moment of this draw, '
  'as returned by fn_spin_draw_multiplier: [{multiplier, reason, unlocksAt}]. '
  'Drives the locked segments on the spin wheel. NULL = not recorded.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tournaments'
      AND column_name = 'spin_locked_tiers' AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'spin_locked_tiers was not created as jsonb';
  END IF;
END $$;

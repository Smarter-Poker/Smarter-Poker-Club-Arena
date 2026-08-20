-- ═══════════════════════════════════════════════════════════════════════
-- 20260820p_spin_tier_availability_public_view.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER: 2  |  AFFECTS: new view public.v_spin_tier_availability
-- IRREVERSIBLE: no  |  APPLIED: 2026-08-20 (migration `spin_tier_availability_public_view`)
--
-- WHY
--   "500x available now" is the strongest marketing the Spin format has, and
--   no player-facing surface could say it: everything about the Reserve Pool
--   (spin_bonus_pools, v_spin_reserve_health, the fn_spin_* functions) is
--   deliberately service-role only, because a club's reserve BALANCE is
--   operator-private.
--
--   This view exposes exactly two booleans per club -- can the pool currently
--   fund a 100x, can it fund a 500x -- and NOTHING that lets a reader recover
--   the balance: no amounts, no thresholds, no stake. Both booleans use the
--   same jackpot-threshold arithmetic as fn_spin_draw_multiplier (1.5x its
--   jackpot for 100x, 2.0x for 500x, at the club's highest stake), so what
--   the lobby advertises is what the wheel will actually offer.
--
-- SECURITY
--   Owned by postgres, no security_invoker, so it reads spin_bonus_pools
--   with owner rights -- intentional and the entire point: the underlying
--   table stays closed while these two bits are public. SELECT granted to
--   authenticated AND anon (the lobby renders pre-login).
--
-- POST-APPLY (verified 2026-08-20):
--   anon GET /rest/v1/v_spin_tier_availability  -> 200, 3 rows, 3 columns
--   anon GET /rest/v1/v_spin_reserve_health     -> 401 (still closed)
--
-- ROLLBACK
--   DROP VIEW IF EXISTS public.v_spin_tier_availability;
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_spin_tier_availability AS
SELECT
  p.club_id,
  (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x,
  (p.balance >= p.highest_stake * 500::numeric * 2.0) AS can_draw_500x
FROM public.spin_bonus_pools p;

REVOKE ALL ON public.v_spin_tier_availability FROM PUBLIC;
GRANT SELECT ON public.v_spin_tier_availability TO authenticated, anon, service_role;

DO $$
DECLARE v_cols int;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.columns
  WHERE table_schema='public' AND table_name='v_spin_tier_availability';
  IF v_cols <> 3 THEN
    RAISE EXCEPTION 'v_spin_tier_availability must expose exactly 3 columns, found %', v_cols;
  END IF;
END $$;

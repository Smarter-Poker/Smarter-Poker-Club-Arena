-- v_spin_tier_availability promised TWO booleans and shipped one.
--
-- useSpinTierAvailability.ts selects 'club_id, can_draw_100x, can_draw_500x'.
-- can_draw_500x had never existed, so PostgREST answered 42703 for the WHOLE
-- request. The hook bails on error and keeps its (empty) cache, so no club
-- ever got a badge -- the 100x badge was collateral damage of the missing
-- 500x column. The Spin tier badge was entirely dead, silently, because the
-- hook's failure mode is "render no badge", which is indistinguishable from
-- "no club qualifies".
--
-- The threshold is not invented here. fn_spin_draw_multiplier gates a tier on
--     v_bal >= multiplier * v_stake * v_thr
-- and SPIN_TIERS in server/src/config/spinSpec.ts sets reserveThresholdX to
-- 1.5 for the 100x tier and 2.0 for the 500x. can_draw_100x already encodes
-- 100 * 1.5; can_draw_500x therefore encodes 500 * 2.0, NOT 500 * 1.5.
-- Copying the 1.5 would advertise a jackpot the draw would then refuse to
-- select -- exactly the mismatch this view exists to prevent.
--
-- The draw compares against GREATEST(highest_stake, this game's buy-in). A
-- lobby badge has no buy-in yet, so highest_stake alone is the honest input,
-- and the conservative one: a larger buy-in only raises the bar.
--
-- Applied to production 2026-08-21 via Supabase MCP apply_migration as
-- spin_tier_view_finally_has_its_second_boolean.

CREATE OR REPLACE VIEW public.v_spin_tier_availability AS
SELECT
  club_id,
  balance >= (highest_stake * 100::numeric * 1.5) AS can_draw_100x,
  balance >= (highest_stake * 500::numeric * 2.0) AS can_draw_500x
FROM spin_bonus_pools p;

DO $$
DECLARE
  v_cols text[];
  v_bad  int;
BEGIN
  SELECT array_agg(column_name::text ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'v_spin_tier_availability';

  IF v_cols IS DISTINCT FROM ARRAY['club_id','can_draw_100x','can_draw_500x'] THEN
    RAISE EXCEPTION 'view shape wrong: %', v_cols;
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.spin_bonus_pools p
    JOIN public.v_spin_tier_availability v USING (club_id)
   WHERE v.can_draw_100x IS DISTINCT FROM (p.balance >= p.highest_stake * 100 * 1.5)
      OR v.can_draw_500x IS DISTINCT FROM (p.balance >= p.highest_stake * 500 * 2.0);

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'badge disagrees with the draw threshold on % pool(s)', v_bad;
  END IF;
END $$;

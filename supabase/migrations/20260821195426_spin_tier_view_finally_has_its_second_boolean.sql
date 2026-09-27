-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821195426 "spin_tier_view_finally_has_its_second_boolean"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 94ca6a2ed7ef09fff6ca71aba8cbd273 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v_spin_tier_availability promised TWO booleans and shipped one.
--
-- useSpinTierAvailability.ts selects 'club_id, can_draw_100x, can_draw_500x'.
-- can_draw_500x has never existed, so PostgREST answered 42703 for the WHOLE
-- request. The hook bails on error and keeps its (empty) cache, so no club
-- ever got a badge -- the 100x badge was collateral damage of the missing
-- 500x column. The Spin tier badge has been entirely dead, silently, and
-- nothing noticed because the hook's failure mode is "render no badge",
-- which is indistinguishable from "no club qualifies".
--
-- The threshold is not invented here. fn_spin_draw_multiplier gates a tier on
--     v_bal >= multiplier * v_stake * v_thr
-- and SPIN_TIERS in server/src/config/spinSpec.ts sets reserveThresholdX to
-- 1.5 for the 100x tier and 2.0 for the 500x. The existing can_draw_100x
-- already encodes 100 * 1.5; can_draw_500x therefore encodes 500 * 2.0, NOT
-- 500 * 1.5. Copying the 1.5 would have advertised a jackpot the draw would
-- then refuse to select, which is exactly the mismatch the view exists to
-- prevent.
--
-- The draw compares against GREATEST(highest_stake, this game's buy-in). A
-- lobby badge has no buy-in yet, so highest_stake alone is the honest input --
-- and it is the conservative one, since a larger buy-in only raises the bar.
--
-- CREATE OR REPLACE VIEW appends the column and preserves grants and options.
-- Still no balance, no total_drawn, nothing that lets a reader recover the
-- pool: two booleans, as documented.

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

  -- The badge must never claim a tier the draw would lock. Recompute the
  -- draw's own rule over every real pool and demand agreement.
  SELECT count(*) INTO v_bad
    FROM public.spin_bonus_pools p
    JOIN public.v_spin_tier_availability v USING (club_id)
   WHERE v.can_draw_100x IS DISTINCT FROM (p.balance >= p.highest_stake * 100 * 1.5)
      OR v.can_draw_500x IS DISTINCT FROM (p.balance >= p.highest_stake * 500 * 2.0);

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'badge disagrees with the draw threshold on % pool(s)', v_bad;
  END IF;

  RAISE NOTICE 'v_spin_tier_availability: both booleans present and agreeing with the draw';
END $$;

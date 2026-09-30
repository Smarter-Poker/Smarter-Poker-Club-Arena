-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260821201702 as "spin_availability_can_draw_500x_compat_shim"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- MY REGRESSION, AND THE FIX.
--
-- retire_500x_spin_tier dropped can_draw_500x from v_spin_tier_availability.
-- I reasoned that was safe because useSpinTierAvailability swallows the error
-- (`if (error || !Array.isArray(data)) return;`), and it does -- nothing
-- throws. But swallowing the error means keeping the previous cache, which on
-- a fresh page load is EMPTY, so the hook returns null and the lobby renders
-- no badge at all.
--
-- The client that stops asking for the column is on a branch that cannot merge
-- while main's CI is frozen. So every deployed bundle still selects
-- can_draw_500x, gets a 400 from PostgREST, and the Spin badge is dead for as
-- long as the freeze lasts. "The old client degrades gracefully" was true and
-- still not good enough: graceful degradation of a feature nobody asked to
-- degrade is a regression.
--
-- The column comes back as a literal false. That is honest -- a 500x genuinely
-- can never be drawn now -- and it makes the deployed client correct rather
-- than merely non-crashing: its `can_draw_500x ? 500 : can_draw_100x ? 100`
-- cascade falls through to the real 100x answer and the badge lights again.
--
-- REMOVE THIS SHIM once the client change has been in production long enough
-- that no cached bundle still selects the column. Tracked on PR #160.

DROP VIEW IF EXISTS public.v_spin_tier_availability;

CREATE VIEW public.v_spin_tier_availability AS
SELECT
  p.club_id,
  -- The same jackpot-threshold arithmetic fn_spin_draw_multiplier enforces
  -- (SPIN_TIERS gives 100x a reserveThresholdX of 1.5).
  (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x,
  -- COMPATIBILITY SHIM, 2026-08-21. Always false: the 500x tier is retired.
  -- Kept only so already-deployed bundles that still name this column get a
  -- 200 instead of a 400. Drop once PR #160 has shipped and settled.
  false AS can_draw_500x
FROM public.spin_bonus_pools p;

COMMENT ON VIEW public.v_spin_tier_availability IS
  'Public, balance-hiding availability of the TOP spin tier (100x). One real boolean per club and nothing that lets a reader recover the reserve balance. can_draw_500x is a false-valued compatibility shim for deployed bundles that still select it; the 500x tier was retired 2026-08-21 and the column should be dropped once no client asks for it.';

REVOKE ALL ON public.v_spin_tier_availability FROM PUBLIC;
GRANT SELECT ON public.v_spin_tier_availability TO authenticated, anon, service_role;

DO $$
DECLARE v_anon boolean; v_false boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='v_spin_tier_availability'
      AND column_name='can_draw_500x'
  ) THEN
    RAISE EXCEPTION 'the shim column is missing - deployed clients would still 400';
  END IF;

  -- The shim must be a constant false, never a live threshold: a lobby must
  -- not be able to advertise a tier the draw cannot produce.
  SELECT bool_or(can_draw_500x) INTO v_false FROM public.v_spin_tier_availability;
  IF COALESCE(v_false, false) THEN
    RAISE EXCEPTION 'can_draw_500x returned true for some club - the shim is not a constant';
  END IF;

  SELECT has_table_privilege('anon','public.v_spin_tier_availability','SELECT') INTO v_anon;
  IF NOT v_anon THEN
    RAISE EXCEPTION 'anon lost SELECT - the pre-login lobby badge would stay dead';
  END IF;
END $$;

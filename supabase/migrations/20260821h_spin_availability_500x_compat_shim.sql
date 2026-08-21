-- ═══════════════════════════════════════════════════════════════════════
-- 20260821h_spin_availability_500x_compat_shim.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER: 2  |  AFFECTS: public.v_spin_tier_availability (column restored)
-- IRREVERSIBLE: no  |  TEMPORARY: yes, delete once PR #160 has settled
-- APPLIED: 2026-08-21 via Supabase MCP `spin_availability_can_draw_500x_compat_shim`
--
-- MY REGRESSION, AND THE FIX.
--
-- 20260821g dropped can_draw_500x from v_spin_tier_availability. I reasoned
-- that was safe because useSpinTierAvailability swallows a query error
-- (`if (error || !Array.isArray(data)) return;`), and it does -- nothing
-- throws. But swallowing the error means KEEPING THE PREVIOUS CACHE, and on a
-- fresh page load that cache is empty, so the hook returns null and the lobby
-- renders no Spin badge at all.
--
-- The client that stops asking for the column sits on a branch that cannot
-- merge while main's CI is frozen. So every deployed bundle still selects
-- can_draw_500x, takes a 400 from PostgREST, and the badge stays dark for as
-- long as the freeze lasts. Another agent's audit found it before I did, which
-- is the part worth remembering: "the old client degrades gracefully" was a
-- true sentence that still described a feature going dark for real users.
--
-- THE LESSON. A column a deployed client selects is part of that client's
-- contract, and the client is whatever is CACHED in browsers, not whatever is
-- on main. Drop such a column in two steps -- ship the client that stops
-- asking, wait, then drop -- and never in the order that leaves a window.
--
-- WHY A CONSTANT AND NOT THE OLD ARITHMETIC. `false` is the honest answer: a
-- 500x genuinely cannot be drawn any more. It also makes the deployed client
-- CORRECT rather than merely non-crashing -- its
-- `can_draw_500x ? 500 : can_draw_100x ? 100 : null` cascade falls through to
-- the real 100x answer, so the badge lights again and says the right thing.
--
-- POST-APPLY (verified 2026-08-21): 3 club rows, can_draw_500x false on every
-- one, can_draw_100x true on the two funded pools.
--
-- REMOVING IT: re-apply 20260821g. Do that only once no cached bundle still
-- names the column.
-- ═══════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS public.v_spin_tier_availability;

CREATE VIEW public.v_spin_tier_availability AS
SELECT
  p.club_id,
  -- The same jackpot-threshold arithmetic fn_spin_draw_multiplier enforces
  -- (SPIN_TIERS gives 100x a reserveThresholdX of 1.5).
  (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x,
  -- COMPATIBILITY SHIM. Always false: the 500x tier is retired. Kept only so
  -- already-deployed bundles that still name this column get a 200, not a 400.
  false AS can_draw_500x
FROM public.spin_bonus_pools p;

COMMENT ON VIEW public.v_spin_tier_availability IS
  'Public, balance-hiding availability of the TOP spin tier (100x). One real boolean per club and nothing that lets a reader recover the reserve balance. can_draw_500x is a false-valued compatibility shim for deployed bundles that still select it; the 500x tier was retired 2026-08-21 and the column should be dropped once no client asks for it.';

REVOKE ALL ON public.v_spin_tier_availability FROM PUBLIC;
GRANT SELECT ON public.v_spin_tier_availability TO authenticated, anon, service_role;

DO $$
DECLARE v_anon boolean; v_any_true boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='v_spin_tier_availability'
      AND column_name='can_draw_500x'
  ) THEN
    RAISE EXCEPTION 'the shim column is missing - deployed clients would still 400';
  END IF;

  -- The shim must be a CONSTANT false, never a live threshold: a lobby must
  -- never be able to advertise a tier the draw cannot produce.
  SELECT bool_or(can_draw_500x) INTO v_any_true FROM public.v_spin_tier_availability;
  IF COALESCE(v_any_true, false) THEN
    RAISE EXCEPTION 'can_draw_500x returned true for some club - the shim is not a constant';
  END IF;

  SELECT has_table_privilege('anon','public.v_spin_tier_availability','SELECT') INTO v_anon;
  IF NOT v_anon THEN
    RAISE EXCEPTION 'anon lost SELECT - the pre-login lobby badge would stay dead';
  END IF;
END $$;

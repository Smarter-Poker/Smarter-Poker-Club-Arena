-- ═══════════════════════════════════════════════════════════════════════
-- 20260821g_retire_500x_spin_tier.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER: 2  |  AFFECTS: public.v_spin_tier_availability (column dropped)
-- IRREVERSIBLE: no (rollback pasted below)
-- APPLIED: 2026-08-21 via Supabase MCP migration `retire_500x_spin_tier`
--
-- WHY
--   Dan, 2026-08-21: "REMOVE THE 500X WE WILL ONLY EVER DO 100X.
--   (CHANGE THAT IN THE DATA BASE AS WELL)"
--
--   The ladder itself is NOT in a table. fn_spin_draw_multiplier takes
--   `p_tiers jsonb` from its caller, and the caller reads src/config/spinSpec.ts
--   (mirrored byte-identically at server/src/config/spinSpec.ts). So the code
--   change alone already stops a 500x from ever being drawn again. This
--   migration closes the one place the retired tier was baked into SCHEMA.
--
-- WHAT CHANGED
--   v_spin_tier_availability published two booleans per club:
--     can_draw_100x  = balance >= highest_stake * 100 * 1.5
--     can_draw_500x  = balance >= highest_stake * 500 * 2.0
--   The second now describes a tier that does not exist. Left in place it
--   would answer `false` forever and, on a big enough pool, eventually light a
--   lobby badge for a prize nobody can win. Dropped.
--
--   CREATE OR REPLACE VIEW cannot remove a column, so the view is dropped and
--   rebuilt. It has no dependent objects: grants are re-issued below, and
--   nothing inside the database selects from it -- only the client hook does.
--
-- WHAT WAS DELIBERATELY NOT CHANGED
--   Nothing in `tournaments`, `spin_bonus_pools` or any ledger is rewritten.
--   A game that already drew a 500x drew it under the rules in force at the
--   time and its prize is owed; rewriting settled history to match a new
--   configuration is how an audit trail stops being one.
--   Verified before applying: `select count(*) from tournaments where
--   spin_multiplier = 500` returned 0, so the question was moot here -- the
--   500x was live in the spec but never actually landed.
--
--   Also untouched: public.spin_pool_draw, whose `v_max_negative := -500` is a
--   dollar overdraft floor, not a multiplier. (It is legacy and does conflict
--   with the newer non-negative-pool design, but that is a separate question
--   from this one and not something to fold into a wheel change.)
--
-- CLIENT COORDINATION
--   src/hooks/useSpinTierAvailability.ts stops selecting `can_draw_500x` in
--   the same change. Either order is safe: selecting a subset of columns works
--   against the old view, and a stale cached bundle still asking for the
--   dropped column gets a PostgREST error the hook already swallows
--   (`if (error || !Array.isArray(data)) return;` keeps the previous cache).
--   The badge stops rendering for that session. Nothing throws.
--
-- ROLLBACK
--   DROP VIEW IF EXISTS public.v_spin_tier_availability;
--   CREATE VIEW public.v_spin_tier_availability AS
--   SELECT
--     p.club_id,
--     (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x,
--     (p.balance >= p.highest_stake * 500::numeric * 2.0) AS can_draw_500x
--   FROM public.spin_bonus_pools p;
--   REVOKE ALL ON public.v_spin_tier_availability FROM PUBLIC;
--   GRANT SELECT ON public.v_spin_tier_availability
--     TO authenticated, anon, service_role;
-- ═══════════════════════════════════════════════════════════════════════

-- ─── PRE-FLIGHT: abort rather than half-apply on an unexpected shape ────
DO $$
DECLARE v_cols int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'v_spin_tier_availability'
  ) THEN
    RAISE EXCEPTION 'v_spin_tier_availability does not exist - nothing to retire';
  END IF;
  SELECT count(*) INTO v_cols FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'v_spin_tier_availability';
  IF v_cols <> 3 THEN
    RAISE EXCEPTION 'expected the 3-column view, found % columns', v_cols;
  END IF;
END $$;

-- ─── APPLY ─────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.v_spin_tier_availability;

CREATE VIEW public.v_spin_tier_availability AS
SELECT
  p.club_id,
  -- The same jackpot-threshold arithmetic fn_spin_draw_multiplier enforces
  -- (SPIN_TIERS gives 100x a reserveThresholdX of 1.5), so what the lobby
  -- advertises is what the wheel will actually offer.
  (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x
FROM public.spin_bonus_pools p;

COMMENT ON VIEW public.v_spin_tier_availability IS
  'Public, balance-hiding availability of the TOP spin tier (100x). One boolean per club and nothing that lets a reader recover the reserve balance. can_draw_500x was dropped 2026-08-21 when the 500x tier was retired.';

-- Owner rights are the point: spin_bonus_pools stays closed while this one bit
-- is public. The lobby renders pre-login, so anon needs SELECT too.
REVOKE ALL ON public.v_spin_tier_availability FROM PUBLIC;
GRANT SELECT ON public.v_spin_tier_availability TO authenticated, anon, service_role;

-- ─── POST-APPLY ASSERTIONS ─────────────────────────────────────────────
DO $$
DECLARE
  v_cols int;
  v_def  text;
  v_anon boolean;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'v_spin_tier_availability';
  IF v_cols <> 2 THEN
    RAISE EXCEPTION 'view must expose exactly 2 columns, found %', v_cols;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'v_spin_tier_availability'
      AND column_name = 'can_draw_500x'
  ) THEN
    RAISE EXCEPTION 'can_draw_500x survived the rebuild';
  END IF;

  -- A leftover 500 anywhere in the arithmetic is the exact failure mode this
  -- migration exists to remove, so assert on the definition itself.
  SELECT pg_get_viewdef('public.v_spin_tier_availability'::regclass, true) INTO v_def;
  IF v_def LIKE '%500%' THEN
    RAISE EXCEPTION 'the rebuilt view still references 500: %', v_def;
  END IF;

  SELECT has_table_privilege('anon', 'public.v_spin_tier_availability', 'SELECT') INTO v_anon;
  IF NOT v_anon THEN
    RAISE EXCEPTION 'anon lost SELECT - the pre-login lobby would stop showing the badge';
  END IF;
END $$;

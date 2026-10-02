-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260821194938 as "retire_500x_spin_tier"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- Dan 2026-08-21: "REMOVE THE 500X WE WILL ONLY EVER DO 100X."
--
-- The ladder itself lives in src/config/spinSpec.ts and its byte-identical
-- server mirror, NOT in a table -- fn_spin_draw_multiplier takes `p_tiers
-- jsonb` from the caller -- so the code change already stops a 500x being
-- drawn. This closes the one place the retired tier was baked into SCHEMA:
-- v_spin_tier_availability published a can_draw_500x boolean that now
-- describes a tier which does not exist, and left alone would eventually
-- light a lobby badge for a prize nobody can win.
--
-- CREATE OR REPLACE cannot drop a column, so the view is rebuilt. Verified
-- before applying: zero tournaments have ever drawn a 500x, so no settled
-- history is affected. Settled rows would NOT be rewritten in any case --
-- a prize drawn under the old rules is owed.
--
-- ROLLBACK: recreate the view with the second column:
--   (p.balance >= p.highest_stake * 500::numeric * 2.0) AS can_draw_500x

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

DROP VIEW IF EXISTS public.v_spin_tier_availability;

CREATE VIEW public.v_spin_tier_availability AS
SELECT
  p.club_id,
  (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x
FROM public.spin_bonus_pools p;

COMMENT ON VIEW public.v_spin_tier_availability IS
  'Public, balance-hiding availability of the TOP spin tier (100x). One boolean per club and nothing that lets a reader recover the reserve balance. can_draw_500x was dropped 2026-08-21 when the 500x tier was retired.';

REVOKE ALL ON public.v_spin_tier_availability FROM PUBLIC;
GRANT SELECT ON public.v_spin_tier_availability TO authenticated, anon, service_role;

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

  SELECT pg_get_viewdef('public.v_spin_tier_availability'::regclass, true) INTO v_def;
  IF v_def LIKE '%500%' THEN
    RAISE EXCEPTION 'the rebuilt view still references 500: %', v_def;
  END IF;

  SELECT has_table_privilege('anon', 'public.v_spin_tier_availability', 'SELECT') INTO v_anon;
  IF NOT v_anon THEN
    RAISE EXCEPTION 'anon lost SELECT - the pre-login lobby would stop showing the badge';
  END IF;
END $$;

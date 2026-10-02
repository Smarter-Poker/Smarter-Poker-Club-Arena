-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260821204940 as "reapply_500x_retirement_view"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- Re-applies PR #170's view. Dan: "REMOVE THE 500X WE WILL ONLY EVER DO 100X.
-- (CHANGE THAT IN THE DATA BASE AS WELL)"
--
-- Why re-applying at all: #160's retirement ran, then my
-- spin_tier_view_finally_has_its_second_boolean ran on top and put
-- can_draw_500x back. list_migrations shows the retirement as applied, so the
-- database looked right and was not.
--
-- Safe to drop now: #160 removed the select from useSpinTierAvailability.ts,
-- so there is no 42703 to cause. No other view or rule depends on this one, so
-- the bare DROP cannot take anything with it.
--
-- Applied through the Supabase MCP rather than waiting on a merge because no
-- workflow in either repo runs `supabase db push` or `supabase migration up`.
-- Merging the PR adds a file; it does not change production.
--
-- ONE CORRECTION to #170, which its own assertion would not have caught:
--
--   REVOKE ALL ON ... FROM PUBLIC;
--   GRANT SELECT ON ... TO authenticated, anon, service_role;
--
-- does not remove anon/authenticated's write grants. Supabase ships
-- ALTER DEFAULT PRIVILEGES granting ALL on newly created objects in `public`
-- to those roles, and they are granted to the roles by name -- not through the
-- PUBLIC pseudo-role -- so revoking from PUBLIC leaves all six of them
-- (INSERT/UPDATE/DELETE x 2 roles) in place on the brand-new view. Verified:
-- the first attempt at this migration aborted on exactly that assertion.
--
-- Revoking from the roles by name is what actually tightens it. Harmless in
-- practice either way (the view is not auto-updatable and the underlying table
-- is not writable by them) but the grant should say what is true.
--
-- security_invoker is deliberately left unset, as before, so the view runs as
-- owner -- which is what lets anon read a pool-derived boolean without any
-- grant on spin_bonus_pools itself.

DROP VIEW IF EXISTS public.v_spin_tier_availability;

CREATE VIEW public.v_spin_tier_availability AS
SELECT
  p.club_id,
  (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x
FROM public.spin_bonus_pools p;

COMMENT ON VIEW public.v_spin_tier_availability IS
  'Public, balance-hiding availability of the TOP spin tier (100x). One boolean per club and nothing that lets a reader recover the reserve balance. can_draw_500x was dropped 2026-08-21 when the 500x tier was retired.';

REVOKE ALL ON public.v_spin_tier_availability FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_spin_tier_availability TO authenticated, anon, service_role;

DO $$
DECLARE
  v_cols   text[];
  v_bad    int;
  v_writes int;
  v_reads  int;
BEGIN
  SELECT array_agg(column_name::text ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'v_spin_tier_availability';
  IF v_cols IS DISTINCT FROM ARRAY['club_id','can_draw_100x'] THEN
    RAISE EXCEPTION 'view shape wrong, expected club_id + can_draw_100x, got %', v_cols;
  END IF;

  -- The badge must agree with the draw: fn_spin_draw_multiplier gates on
  -- v_bal >= multiplier * v_stake * v_thr, and SPIN_TIERS keeps
  -- reserveThresholdX = 1.5 for the 100x tier.
  SELECT count(*) INTO v_bad
    FROM public.spin_bonus_pools p
    JOIN public.v_spin_tier_availability v USING (club_id)
   WHERE v.can_draw_100x IS DISTINCT FROM (p.balance >= p.highest_stake * 100 * 1.5);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'badge disagrees with the draw threshold on % pool(s)', v_bad;
  END IF;

  SELECT count(*) INTO v_writes
    FROM information_schema.role_table_grants
   WHERE table_name = 'v_spin_tier_availability'
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF v_writes > 0 THEN
    RAISE EXCEPTION 'anon/authenticated still hold % write grant(s)', v_writes;
  END IF;

  -- ...and the badge is still actually readable, or the lobby goes dark.
  SELECT count(*) INTO v_reads
    FROM information_schema.role_table_grants
   WHERE table_name = 'v_spin_tier_availability'
     AND grantee IN ('anon','authenticated')
     AND privilege_type = 'SELECT';
  IF v_reads <> 2 THEN
    RAISE EXCEPTION 'expected SELECT for both anon and authenticated, found %', v_reads;
  END IF;
END $$;

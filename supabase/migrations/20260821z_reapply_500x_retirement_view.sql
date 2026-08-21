DROP VIEW IF EXISTS public.v_spin_tier_availability;

CREATE VIEW public.v_spin_tier_availability AS
SELECT
  p.club_id,
  (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x
FROM public.spin_bonus_pools p;

COMMENT ON VIEW public.v_spin_tier_availability IS
  'Public, balance-hiding availability of the TOP spin tier (100x). One boolean per club and nothing that lets a reader recover the reserve balance. can_draw_500x was dropped 2026-08-21 when the 500x tier was retired.';

-- Supabase ships ALTER DEFAULT PRIVILEGES granting ALL on newly created objects
-- in `public` to anon and authenticated BY ROLE NAME, not through the PUBLIC
-- pseudo-role. A DROP + CREATE therefore hands the brand-new view a fresh set
-- of write grants, and revoking from PUBLIC alone leaves all six of them
-- (INSERT/UPDATE/DELETE x 2 roles) in place. Naming the roles is what actually
-- tightens it. Harmless either way in practice - the view is not auto-updatable
-- and spin_bonus_pools is not writable by those roles - but the grant should
-- say what is true, and the next DROP/CREATE inherits whatever this file says.
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

  -- The badge must keep agreeing with the draw: fn_spin_draw_multiplier gates a
  -- tier on v_bal >= multiplier * v_stake * v_thr, and SPIN_TIERS keeps
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

  -- ...and the badge is still readable, or this "tightening" darkens the lobby.
  SELECT count(*) INTO v_reads
    FROM information_schema.role_table_grants
   WHERE table_name = 'v_spin_tier_availability'
     AND grantee IN ('anon','authenticated')
     AND privilege_type = 'SELECT';
  IF v_reads <> 2 THEN
    RAISE EXCEPTION 'expected SELECT for both anon and authenticated, found %', v_reads;
  END IF;
END $$;

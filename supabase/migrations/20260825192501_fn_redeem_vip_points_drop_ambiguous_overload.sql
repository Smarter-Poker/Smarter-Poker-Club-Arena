-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825192501; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The previous migration added a third defaulted parameter, which in Postgres
-- creates a SECOND function rather than replacing the first. Both then match a
-- two-argument call, and PostgREST answers PGRST203 "could not choose the best
-- candidate function" - so every existing caller of fn_redeem_vip_points(cost,
-- reason) would have broken. Drop the two-argument version: the three-argument
-- one defaults p_reward_id to NULL and behaves identically without it.

DROP FUNCTION IF EXISTS public.fn_redeem_vip_points(bigint, text);

DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_redeem_vip_points';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_redeem_vip_points has % overloads, expected exactly 1', v_n;
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_redeem_vip_points(bigint, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on the surviving fn_redeem_vip_points';
  END IF;
END $$;

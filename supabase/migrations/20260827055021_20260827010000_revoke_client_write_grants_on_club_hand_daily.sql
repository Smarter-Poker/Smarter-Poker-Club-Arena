-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827055021; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'club_hand_daily' AND c.relkind = 'v'
  ) THEN
    RAISE EXCEPTION 'public.club_hand_daily is not a view here -- schema drifted, do not apply blindly';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'club_hand_daily_shard'
  ) THEN
    RAISE NOTICE 'club_hand_daily_shard now has RLS policies -- verify no client write path depends on these grants';
  END IF;
END $$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.club_hand_daily FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.club_hand_daily FROM authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.club_hand_daily_shard FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.club_hand_daily_shard FROM authenticated;

DO $$
DECLARE v_bad int;
BEGIN
  SELECT COUNT(*) INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE c.relkind = 'v'
     AND c.relname NOT IN ('geography_columns', 'geometry_columns')
     AND (has_table_privilege('anon', c.oid, 'INSERT, UPDATE, DELETE')
       OR has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'no_client_writable_views still fails: % view(s) remain client-writable', v_bad;
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.club_hand_daily', 'SELECT') THEN
    RAISE EXCEPTION 'SELECT was revoked from authenticated on club_hand_daily -- that was not the intent';
  END IF;
  IF NOT has_table_privilege('anon', 'public.club_hand_daily', 'SELECT') THEN
    RAISE EXCEPTION 'SELECT was revoked from anon on club_hand_daily -- that was not the intent';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.club_hand_daily_shard', 'INSERT') THEN
    RAISE EXCEPTION 'service_role lost INSERT on club_hand_daily_shard -- the stats writer is now broken';
  END IF;

  RAISE NOTICE 'no_client_writable_views now passes; SELECT and service_role writes intact';
END $$;

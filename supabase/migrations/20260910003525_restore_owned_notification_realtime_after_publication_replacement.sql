-- TIER: 2. AUTHOR: Codex. IRREVERSIBLE: no.
-- AFFECTS: supabase_realtime membership for public.notifications only.
-- Reserved by scripts/new-migration.mjs as 20260910003022.
--
-- The September 8 publication SET TABLE replaced every unrelated membership.
-- NotificationsPage still subscribes to notifications but production no longer
-- publishes it. Verified September 10: 113 notification inserts in 24 hours,
-- owner-only SELECT RLS, and five other publication tables.
-- Restore this proven caller additively. Preserve all other table/column lists.
-- No cron, row writes, policy changes, or engine restart.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
DO $restore$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_policy_count integer;
  v_owner_policy_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.notifications'::regclass
      AND relrowsecurity AND relreplident = 'f'
  ) THEN
    RAISE EXCEPTION 'Notification RLS or replica identity changed; review before publishing';
  END IF;
  SELECT count(*), count(*) FILTER (
    WHERE cmd = 'SELECT' AND qual = '(( SELECT auth.uid() AS uid) = user_id)'
  ) INTO v_policy_count, v_owner_policy_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'notifications'
     AND cmd IN ('SELECT', 'ALL')
     AND roles && ARRAY['public', 'authenticated', 'anon']::name[];
  IF v_policy_count <> 1 OR v_owner_policy_count <> 1 THEN
    RAISE EXCEPTION 'Notification read policy is not the verified owner-only policy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE EXCEPTION 'Realtime publication is missing';
  END IF;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname, tablename) INTO v_before
    FROM pg_publication_tables p WHERE pubname = 'supabase_realtime'
     AND NOT (schemaname = 'public' AND tablename = 'notifications');
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname, tablename) INTO v_after
    FROM pg_publication_tables p WHERE pubname = 'supabase_realtime'
     AND NOT (schemaname = 'public' AND tablename = 'notifications');
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'An unrelated publication table or column list changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'notifications'
      AND attnames::text[] @> ARRAY['id', 'user_id', 'read', 'is_read']
  ) THEN
    RAISE EXCEPTION 'Notification publication did not restore its owner and read fields';
  END IF;
END
$restore$;
COMMIT;
-- ROLLBACK, only as a new migration:
-- BEGIN;
-- SET LOCAL lock_timeout = '2s';
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.notifications;
-- COMMIT;

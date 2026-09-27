-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821182052 "client_crash_log_allow_insert"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6d22e4cbbc2bf61703c39059d6b4ec8d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- client_crash_log has RLS enabled and ZERO policies, so nothing except
-- service_role could ever write to it. That is why the Club Arena stats page
-- could crash in production and leave no trace: PageErrorBoundary only called
-- console.error, and even if it had tried to log, the insert would have been
-- silently refused.
--
-- Crash telemetry is write-only by design: a client may report, and may never
-- read. There is no SELECT policy here on purpose - the table carries stack
-- traces, routes and user ids, and no end user has any business reading
-- another user's crash.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'client_crash_log'
      AND policyname = 'client_crash_log_insert_only'
  ) THEN
    CREATE POLICY client_crash_log_insert_only ON public.client_crash_log
      FOR INSERT TO anon, authenticated
      WITH CHECK (true);
  END IF;
END $$;

DO $$
DECLARE
  v_insert int;
  v_select int;
BEGIN
  SELECT count(*) INTO v_insert FROM pg_policies
   WHERE schemaname='public' AND tablename='client_crash_log' AND cmd='INSERT';
  SELECT count(*) INTO v_select FROM pg_policies
   WHERE schemaname='public' AND tablename='client_crash_log' AND cmd='SELECT';

  IF v_insert < 1 THEN
    RAISE EXCEPTION 'ASSERT FAILED: no INSERT policy on client_crash_log.';
  END IF;
  -- Guard the intent: if somebody later adds a read policy, this migration's
  -- assumption is broken and they should have to think about it.
  IF v_select > 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: client_crash_log gained a SELECT policy - stack traces must stay unreadable by clients.';
  END IF;

  RAISE NOTICE 'client_crash_log is now write-only for clients.';
END $$;

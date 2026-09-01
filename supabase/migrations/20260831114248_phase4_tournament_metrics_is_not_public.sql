-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831114248; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- THE SURFACE GREW BACK WITHIN THE HOUR — which is the point worth recording
--
-- Immediately after the phase-4 sweep took the anon-executable SECURITY
-- DEFINER count from 83 to 22, it read 23 again. The new one is
-- fn_tournament_metrics, shipped by another agent minutes earlier:
--
--   RETURNS TABLE(running, registering, overdue_start, stuck_completing,
--                 seatless_phantoms, unpaid_completed, seat_first_waiting)
--
-- It does not consult auth.uid(). That is a live readout of the platform's
-- OPERATIONAL FAILURE COUNTS — how many tournaments are overdue to start,
-- stuck COMPLETING, carrying phantom seats or completed-but-unpaid — readable
-- by anyone with no account. Not player data, but precisely the thing that
-- tells an outsider when the floor is degraded.
--
-- This is not a criticism of that change; it is the default doing what the
-- default does. Postgres grants EXECUTE to PUBLIC on every new function and
-- Supabase publishes it as an RPC, so an operator watchdog is born public
-- unless someone says otherwise. It will keep happening, which is why the
-- changelog for this phase names the pattern rather than only the 61 doors.
--
-- Zero references in club-arena (src, server/src, scripts, .github, docs,
-- migrations) or the World Hub — it is called with service_role. anon is
-- revoked; `authenticated` is deliberately KEPT so that any admin dashboard
-- that picks this up later is not broken by a guess.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE sig text;
BEGIN
  FOR sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_tournament_metrics'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig);
  END LOOP;
END $$;

-- Heal the fees outstanding right now: unbanked BBJ from rake_records, and
-- any cash hand whose rake never reached the queue.
DO $$
DECLARE n_bbj int; n_rake int;
BEGIN
  SELECT count(*) INTO n_bbj  FROM public.fn_bbj_repair_unbanked(24, 200);
  SELECT count(*) INTO n_rake FROM public.fn_requeue_unbanked_cash_rake(48, 10, 500);
  RAISE NOTICE 'healed % BBJ contribution(s), re-queued % cash rake hand(s)', n_bbj, n_rake;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='fn_tournament_metrics'
                AND has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'fn_tournament_metrics is still readable by anon';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_tournament_metrics'
                    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'fn_tournament_metrics lost its authenticated grant';
  END IF;
END $$;


-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831115346; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
--  fn_truly_unused_indexes IS OPERATOR TELEMETRY, NOT PUBLIC SURFACE
-- ══════════════════════════════════════════════════════════════════════════
--
-- Found by the Phase 4 re-sweep. It returns, to any caller with no account:
--
--     relname, indexrelname, index_bytes, pretty_size,
--     scans_in_window, window_days, epochs_observed
--
-- That is the schema's table names, its index names, the size of each, and
-- which ones the workload actually touches. Index names on this project encode
-- their columns, so this hands an unauthenticated caller a partial column map
-- plus a read of which access paths are hot -- the reconnaissance step, free.
--
-- It never calls auth.uid(), auth.role() or auth.jwt(), so SECURITY DEFINER
-- runs it as the owner with nothing standing behind it.
--
-- SAFE TO CLOSE, checked both ways before touching it:
--   * zero RLS policies reference it (unlike fn_home_is_group_staff, which
--     backs 15 policies across 8 tables and must keep its grant, because a
--     policy expression evaluates as the QUERYING role -- revoking that one
--     would deny every SELECT on those tables);
--   * zero callers in club-arena/src, club-arena/server/src, or the World Hub's
--     pages/ and src/. Nothing on the platform invokes it.
--
-- service_role already holds EXECUTE independently and is re-granted here
-- explicitly, so the revoke cannot quietly break the operator path it is
-- named for.
--
-- THIS IS THE THIRD ONE THIS PHASE. fn_tournament_metrics and this function
-- both arrived anon-executable after the sweep that was supposed to have
-- finished the job. The durable fix ships beside this migration:
-- scripts/ci/check-definer-authorization.mjs now also fails a NEW SECURITY
-- DEFINER function that anon can execute, not only one that writes -- all
-- three of these are read-only, which is precisely how they walked past a
-- gate that only ever looked at writers.

REVOKE ALL ON FUNCTION public.fn_truly_unused_indexes(integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_truly_unused_indexes(integer)
  TO service_role;

DO $$
DECLARE v_anon boolean; v_auth boolean; v_svc boolean;
BEGIN
  SELECT has_function_privilege('anon',          'public.fn_truly_unused_indexes(integer)', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.fn_truly_unused_indexes(integer)', 'EXECUTE'),
         has_function_privilege('service_role',  'public.fn_truly_unused_indexes(integer)', 'EXECUTE')
    INTO v_anon, v_auth, v_svc;

  IF v_anon OR v_auth THEN
    RAISE EXCEPTION 'fn_truly_unused_indexes still reachable from a browser role (anon=%, authenticated=%)',
      v_anon, v_auth;
  END IF;
  IF NOT v_svc THEN
    RAISE EXCEPTION 'fn_truly_unused_indexes lost service_role - the operator path is broken';
  END IF;

  -- The policy helper must be untouched. Asserted, not assumed.
  IF NOT has_function_privilege('authenticated',
        'public.fn_home_is_group_staff(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_home_is_group_staff lost EXECUTE - 15 RLS policies just broke';
  END IF;
END $$;

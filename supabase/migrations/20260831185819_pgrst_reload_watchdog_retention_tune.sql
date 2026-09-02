-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831185819; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Watchdog tune (2026-08-31, same day as pgrst_reload_watchdog):
-- ca_ddl_events captured ~8k rows in its first 3 hours, almost all runtime
-- GRANT/REVOKE churn that does NOT trigger reloads (~45/min). Keep the
-- reload-relevant rows 14 days for attribution, but cap the noise at 3 days
-- so the table stays small. Retention runs inside the watchdog, so the delete
-- below in the function replaces the single-tier one.
CREATE OR REPLACE FUNCTION public.fn_pgrst_reload_watchdog()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_breaches jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_result   jsonb;
  v_reloads_1h int;
  v_timeout_raw text;
  v_timeout interval;
  r record;
  c_reloads_per_hour_breach constant int := 60;
  c_reloads_per_hour_warn   constant int := 20;
BEGIN
  SELECT count(*) INTO v_reloads_1h
    FROM public.ca_ddl_events
   WHERE occurred_at > now() - interval '1 hour'
     AND triggers_pgrst_reload;

  IF v_reloads_1h >= c_reloads_per_hour_warn THEN
    FOR r IN
      SELECT coalesce(application_name,'?') AS app, role_name,
             count(*) AS events,
             max(occurred_at) AS last_at
        FROM public.ca_ddl_events
       WHERE occurred_at > now() - interval '1 hour'
         AND triggers_pgrst_reload
       GROUP BY 1, 2 ORDER BY events DESC LIMIT 5
    LOOP
      IF v_reloads_1h >= c_reloads_per_hour_breach THEN
        v_breaches := v_breaches || jsonb_build_object(
          'check','pgrst_reload_storm','reloads_last_hour',v_reloads_1h,
          'application',r.app,'role',r.role_name,'events',r.events,'last_at',r.last_at,
          'why','Each reload-triggering DDL statement makes PostgREST re-read a ~970-relation schema cache (~28s). '
             || 'At this rate reloading is near-continuous - the precursor of the 2026-08-31 PGRST002 503 storm. '
             || 'Batch DDL into single transactions and stop any migration retry loop (CLAUDE.md, Production DDL policy).');
      ELSE
        v_warnings := v_warnings || jsonb_build_object(
          'check','pgrst_reload_rate_elevated','reloads_last_hour',v_reloads_1h,
          'application',r.app,'role',r.role_name,'events',r.events,'last_at',r.last_at);
      END IF;
    END LOOP;
  END IF;

  SELECT split_part(cfg, '=', 2) INTO v_timeout_raw
    FROM pg_roles, unnest(coalesce(rolconfig, '{}'::text[])) AS cfg
   WHERE rolname = 'authenticator' AND cfg LIKE 'statement_timeout=%'
   LIMIT 1;
  BEGIN
    IF v_timeout_raw IS NULL THEN
      v_timeout := NULL;
    ELSIF v_timeout_raw ~ '^[0-9]+$' THEN
      v_timeout := (v_timeout_raw || ' milliseconds')::interval;
    ELSE
      v_timeout := v_timeout_raw::interval;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_timeout := NULL;
  END;
  IF v_timeout IS NOT NULL AND v_timeout < interval '2 minutes' THEN
    v_breaches := v_breaches || jsonb_build_object(
      'check','authenticator_timeout_reverted','statement_timeout',v_timeout_raw,
      'why','PostgREST loads its schema cache as authenticator; the load takes ~28s here. A timeout below 2min '
         || 'kills the load and recreates the 2026-08-31 PGRST002 outage. '
         || 'Restore with: ALTER ROLE authenticator SET statement_timeout = ''5min'' '
         || '(migration fix_pgrst002_schema_cache_timeout), then recycle authenticator backends.');
  END IF;

  FOR r IN
    SELECT expected.evtname AS name, et.evtenabled
      FROM (VALUES ('pgrst_ddl_watch'), ('pgrst_drop_watch'),
                   ('ca_ddl_watchdog_log'), ('ca_ddl_watchdog_drop_log')) AS expected(evtname)
      LEFT JOIN pg_event_trigger et ON et.evtname = expected.evtname
  LOOP
    IF r.evtenabled IS NULL OR r.evtenabled = 'D' THEN
      v_breaches := v_breaches || jsonb_build_object(
        'check','event_trigger_missing_or_disabled','trigger',r.name,
        'why','pgrst_* watches keep PostgREST''s schema cache honest; ca_ddl_watchdog_* feed this watchdog.');
    END IF;
  END LOOP;

  v_result := jsonb_build_object(
    'checked_at', now(),
    'reloads_last_hour', v_reloads_1h,
    'breaches', v_breaches,
    'warnings', v_warnings);

  INSERT INTO public.pgrst_reload_watchdog_log (breach_count, warn_count, result)
  VALUES (jsonb_array_length(v_breaches), jsonb_array_length(v_warnings), v_result);

  -- Retention: watchdog log 30 days; reload-relevant DDL events 14 days;
  -- non-reload DDL noise (runtime GRANT/REVOKE churn, ~45/min) 3 days.
  DELETE FROM public.pgrst_reload_watchdog_log WHERE ran_at < now() - interval '30 days';
  DELETE FROM public.ca_ddl_events
   WHERE (triggers_pgrst_reload AND occurred_at < now() - interval '14 days')
      OR (NOT triggers_pgrst_reload AND occurred_at < now() - interval '3 days');

  IF jsonb_array_length(v_breaches) > 0 THEN
    RAISE WARNING 'pgrst_reload_watchdog: % breach(es): %',
      jsonb_array_length(v_breaches), v_breaches;
  END IF;

  RETURN v_result;
END;
$$;

-- Remove the synthetic self-test rows and the log entry they produced.
DELETE FROM public.ca_ddl_events WHERE application_name = 'watchdog-selftest';
DELETE FROM public.pgrst_reload_watchdog_log
 WHERE result -> 'breaches' @> '[{"application":"watchdog-selftest"}]'::jsonb;

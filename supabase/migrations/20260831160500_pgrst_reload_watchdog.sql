-- Applied to production 2026-08-31 via mgmt API as two migrations
-- (pgrst_reload_watchdog ~16:05 UTC, pgrst_reload_watchdog_retention_tune
-- ~18:58 UTC); this file is their consolidated final state.
--
-- PGRST RELOAD WATCHDOG. Companion to the PGRST002 root fix: makes the next
-- reload storm LOUD instead of a silent afternoon of 503s. Modeled on
-- fn_db_saturation_selftest: selftest fn -> log table -> RAISE WARNING,
-- scheduled via pg_cron with an advisory-lock overlap guard.

CREATE TABLE IF NOT EXISTS public.ca_ddl_events (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  command_tag           text NOT NULL,
  object_type           text,
  object_identity       text,
  schema_name           text,
  triggers_pgrst_reload boolean NOT NULL DEFAULT false,
  role_name             text NOT NULL DEFAULT current_user,
  application_name      text,
  query_snippet         text
);
CREATE INDEX IF NOT EXISTS idx_ca_ddl_events_occurred
  ON public.ca_ddl_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ca_ddl_events_reload
  ON public.ca_ddl_events (occurred_at DESC) WHERE triggers_pgrst_reload;
ALTER TABLE public.ca_ddl_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.pgrst_reload_watchdog_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at       timestamptz NOT NULL DEFAULT now(),
  breach_count int NOT NULL,
  warn_count   int NOT NULL,
  result       jsonb NOT NULL
);
ALTER TABLE public.pgrst_reload_watchdog_log ENABLE ROW LEVEL SECURITY;

-- Event-trigger loggers: must NEVER raise (an erroring event trigger breaks
-- every DDL statement on the platform).
CREATE OR REPLACE FUNCTION public.ca_log_ddl_event()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    INSERT INTO public.ca_ddl_events
      (command_tag, object_type, object_identity, schema_name,
       triggers_pgrst_reload, application_name, query_snippet)
    VALUES
      (cmd.command_tag, cmd.object_type, cmd.object_identity, cmd.schema_name,
       cmd.command_tag IN (
         'CREATE SCHEMA','ALTER SCHEMA','CREATE TABLE','CREATE TABLE AS',
         'SELECT INTO','ALTER TABLE','CREATE FOREIGN TABLE',
         'ALTER FOREIGN TABLE','CREATE VIEW','ALTER VIEW',
         'CREATE MATERIALIZED VIEW','ALTER MATERIALIZED VIEW',
         'CREATE FUNCTION','ALTER FUNCTION','CREATE TRIGGER','CREATE TYPE',
         'ALTER TYPE','CREATE RULE','COMMENT'
       ) AND cmd.schema_name IS DISTINCT FROM 'pg_temp',
       current_setting('application_name', true), left(current_query(), 300));
  END LOOP;
EXCEPTION WHEN OTHERS THEN NULL;
END; $$;

CREATE OR REPLACE FUNCTION public.ca_log_ddl_drop()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
    INSERT INTO public.ca_ddl_events
      (command_tag, object_type, object_identity, schema_name,
       triggers_pgrst_reload, application_name, query_snippet)
    VALUES
      ('DROP ' || upper(coalesce(obj.object_type, 'OBJECT')),
       obj.object_type, obj.object_identity, obj.schema_name,
       obj.object_type IN ('schema','table','foreign table','view',
         'materialized view','function','trigger','type','rule')
         AND obj.is_temporary IS FALSE,
       current_setting('application_name', true), left(current_query(), 300));
  END LOOP;
EXCEPTION WHEN OTHERS THEN NULL;
END; $$;

REVOKE ALL ON FUNCTION public.ca_log_ddl_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_log_ddl_drop() FROM PUBLIC, anon, authenticated;

DROP EVENT TRIGGER IF EXISTS ca_ddl_watchdog_log;
CREATE EVENT TRIGGER ca_ddl_watchdog_log ON ddl_command_end
  EXECUTE FUNCTION public.ca_log_ddl_event();
DROP EVENT TRIGGER IF EXISTS ca_ddl_watchdog_drop_log;
CREATE EVENT TRIGGER ca_ddl_watchdog_drop_log ON sql_drop
  EXECUTE FUNCTION public.ca_log_ddl_drop();

CREATE OR REPLACE FUNCTION public.fn_pgrst_reload_watchdog()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
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
  SELECT count(*) INTO v_reloads_1h FROM public.ca_ddl_events
   WHERE occurred_at > now() - interval '1 hour' AND triggers_pgrst_reload;

  IF v_reloads_1h >= c_reloads_per_hour_warn THEN
    FOR r IN
      SELECT coalesce(application_name,'?') AS app, role_name,
             count(*) AS events, max(occurred_at) AS last_at
        FROM public.ca_ddl_events
       WHERE occurred_at > now() - interval '1 hour' AND triggers_pgrst_reload
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
   WHERE rolname = 'authenticator' AND cfg LIKE 'statement_timeout=%' LIMIT 1;
  BEGIN
    IF v_timeout_raw IS NULL THEN v_timeout := NULL;
    ELSIF v_timeout_raw ~ '^[0-9]+$' THEN v_timeout := (v_timeout_raw || ' milliseconds')::interval;
    ELSE v_timeout := v_timeout_raw::interval;
    END IF;
  EXCEPTION WHEN OTHERS THEN v_timeout := NULL;
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

  v_result := jsonb_build_object('checked_at', now(),
    'reloads_last_hour', v_reloads_1h, 'breaches', v_breaches, 'warnings', v_warnings);

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
END; $$;

REVOKE ALL ON FUNCTION public.fn_pgrst_reload_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pgrst_reload_watchdog() TO service_role;

SELECT cron.schedule('pgrst-reload-watchdog', '6,21,36,51 * * * *',
  $job$
  SELECT CASE
           WHEN pg_try_advisory_lock(hashtext('pgrst-reload-watchdog'))
             THEN (SELECT set_config('statement_timeout','30s',true) IS NOT NULL
                     AND (public.fn_pgrst_reload_watchdog()) IS NOT NULL)
           ELSE false
         END;
  $job$);

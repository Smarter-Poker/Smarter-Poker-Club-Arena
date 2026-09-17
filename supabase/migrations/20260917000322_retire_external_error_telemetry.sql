-- Owner-authorized provider retirement. Preserve historical rows privately.
-- Apply only after all affected application images have removed the callers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $retire$
DECLARE
  table_name text;
  role_name text;
  object_oid oid;
  before_rows bigint;
  after_rows bigint;
  sequence_oid oid := to_regclass('public.sentry_error_log_id_seq');
BEGIN
  IF to_regnamespace('retired_error_telemetry_20260916') IS NOT NULL THEN
    RAISE EXCEPTION 'Retirement archive already exists; inspect rather than replay';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('public.fn_sentry_budget_take(text,integer,integer)')
      AND md5(p.prosrc) = 'cf0cb8cd19e95a7ac00d6fa5ecde98a0'
      AND p.proowner = 'postgres'::regrole AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'Provider budget function differs from reviewed source';
  END IF;
  IF sequence_oid IS NULL THEN
    RAISE EXCEPTION 'Provider sequence is absent';
  END IF;

  LOCK TABLE public.sentry_error_log, public.sentry_event_budget,
             public.sentry_event_fingerprints IN ACCESS EXCLUSIVE MODE;
  CREATE SCHEMA retired_error_telemetry_20260916 AUTHORIZATION postgres;
  REVOKE ALL ON SCHEMA retired_error_telemetry_20260916
    FROM PUBLIC, anon, authenticated, service_role;
  DROP FUNCTION public.fn_sentry_budget_take(text, integer, integer) RESTRICT;
  REVOKE ALL ON SEQUENCE public.sentry_error_log_id_seq
    FROM PUBLIC, anon, authenticated, service_role;
  DROP POLICY service_role_full_access_sentry ON public.sentry_error_log;

  FOREACH table_name IN ARRAY ARRAY[
    'sentry_error_log', 'sentry_event_budget', 'sentry_event_fingerprints'
  ] LOOP
    object_oid := to_regclass(format('public.%I', table_name));
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = object_oid
                   AND relowner = 'postgres'::regrole AND relrowsecurity) THEN
      RAISE EXCEPTION 'Provider table ownership or row security changed: %', table_name;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', table_name) INTO before_rows;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', table_name);
    EXECUTE format('ALTER TABLE public.%I SET SCHEMA retired_error_telemetry_20260916', table_name);
    EXECUTE format('SELECT count(*) FROM retired_error_telemetry_20260916.%I', table_name) INTO after_rows;
    IF before_rows <> after_rows OR object_oid IS DISTINCT FROM
       to_regclass(format('retired_error_telemetry_20260916.%I', table_name)) THEN
      RAISE EXCEPTION 'Retirement changed table identity or rows: %', table_name;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_table_privilege(role_name, object_oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_schema_privilege(role_name, 'retired_error_telemetry_20260916', 'USAGE,CREATE') THEN
        RAISE EXCEPTION 'Application role retains archive access: %', role_name;
      END IF;
    END LOOP;
  END LOOP;
  IF sequence_oid IS DISTINCT FROM to_regclass('retired_error_telemetry_20260916.sentry_error_log_id_seq') THEN
    RAISE EXCEPTION 'Retirement changed sequence identity';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_sequence_privilege(role_name, sequence_oid, 'USAGE,SELECT,UPDATE') THEN
      RAISE EXCEPTION 'Application role retains sequence access: %', role_name;
    END IF;
  END LOOP;
END
$retire$;
COMMIT;

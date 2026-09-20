"""Run the exact provider-retirement migration against nonempty PostgreSQL fixtures."""
import os
import subprocess
from pathlib import Path

here = Path(__file__).resolve().parent
root = here.parents[3]
migration = root / 'supabase/migrations/20260917000322_retire_external_error_telemetry.sql'
fixture = r"""
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE TABLE public.sentry_error_log(id bigserial PRIMARY KEY, detail text);
CREATE TABLE public.sentry_event_budget(day date PRIMARY KEY, sent integer);
CREATE TABLE public.sentry_event_fingerprints(day date, fingerprint text, sent integer,
  PRIMARY KEY(day,fingerprint));
ALTER TABLE public.sentry_error_log OWNER TO postgres;
ALTER TABLE public.sentry_event_budget OWNER TO postgres;
ALTER TABLE public.sentry_event_fingerprints OWNER TO postgres;
ALTER TABLE public.sentry_error_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sentry_event_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sentry_event_fingerprints ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_access_sentry ON public.sentry_error_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.sentry_error_log, public.sentry_event_budget,
  public.sentry_event_fingerprints TO anon, authenticated, service_role;
GRANT ALL ON SEQUENCE public.sentry_error_log_id_seq TO anon, authenticated, service_role;
INSERT INTO public.sentry_error_log(detail) VALUES ('preserve first record'), ('preserve second record');
INSERT INTO public.sentry_event_budget VALUES ('2026-09-15',7), ('2026-09-16',11);
INSERT INTO public.sentry_event_fingerprints VALUES ('2026-09-16','synthetic-one',3), ('2026-09-16','synthetic-two',2);
CREATE TABLE public.retirement_first_party_sentinel(id integer PRIMARY KEY, forwarded_to_sentry boolean);
INSERT INTO public.retirement_first_party_sentinel VALUES(1,true),(2,false);
CREATE FUNCTION public.retirement_first_party_read() RETURNS bigint LANGUAGE sql AS
  'SELECT count(*) FROM public.retirement_first_party_sentinel';
CREATE TEMP TABLE retirement_before AS SELECT
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.sentry_error_log t) AS errors,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY day) FROM public.sentry_event_budget t) AS budget,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY day,fingerprint) FROM public.sentry_event_fingerprints t) AS fingerprints,
  'public.sentry_error_log_id_seq'::regclass::oid AS sequence_oid,
  (SELECT last_value FROM public.sentry_error_log_id_seq) AS sequence_value,
  md5(pg_get_functiondef('public.retirement_first_party_read()'::regprocedure)) AS sentinel_hash;
"""
original = (here / 'retired-telemetry-rpc-before.sql').read_text()
setup = fixture + original + r"""
ALTER FUNCTION public.fn_sentry_budget_take(text,integer,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_sentry_budget_take(text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_sentry_budget_take(text,integer,integer) TO service_role;
"""
assertions = r"""
DO $$ DECLARE before retirement_before%ROWTYPE; name text; role_name text; BEGIN
  SELECT * INTO STRICT before FROM retirement_before;
  IF before.errors IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM retired_error_telemetry_20260916.sentry_error_log t)
  OR before.budget IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(t) ORDER BY day) FROM retired_error_telemetry_20260916.sentry_event_budget t)
  OR before.fingerprints IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(t) ORDER BY day,fingerprint) FROM retired_error_telemetry_20260916.sentry_event_fingerprints t) THEN
    RAISE EXCEPTION 'Historical record changed';
  END IF;
  IF before.sequence_oid <> 'retired_error_telemetry_20260916.sentry_error_log_id_seq'::regclass::oid
  OR before.sequence_value <> (SELECT last_value FROM retired_error_telemetry_20260916.sentry_error_log_id_seq) THEN
    RAISE EXCEPTION 'Sequence identity/value changed';
  END IF;
  FOREACH name IN ARRAY ARRAY['sentry_error_log','sentry_event_budget','sentry_event_fingerprints'] LOOP
    IF to_regclass('public.' || name) IS NOT NULL THEN RAISE EXCEPTION 'Public table survives'; END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_schema_privilege(role_name,'retired_error_telemetry_20260916','USAGE,CREATE')
      OR has_table_privilege(role_name,'retired_error_telemetry_20260916.' || name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_sequence_privilege(role_name,before.sequence_oid,'SELECT,UPDATE,USAGE') THEN
        RAISE EXCEPTION 'Application role retains retired access';
      END IF;
    END LOOP;
  END LOOP;
  IF to_regprocedure('public.fn_sentry_budget_take(text,integer,integer)') IS NOT NULL THEN RAISE EXCEPTION 'Public RPC survives'; END IF;
  IF public.retirement_first_party_read() <> 2
  OR before.sentinel_hash <> md5(pg_get_functiondef('public.retirement_first_party_read()'::regprocedure))
  OR NOT (SELECT forwarded_to_sentry FROM public.retirement_first_party_sentinel WHERE id=1)
  OR (SELECT forwarded_to_sentry FROM public.retirement_first_party_sentinel WHERE id=2) THEN
    RAISE EXCEPTION 'First-party history/function changed';
  END IF;
END $$;
SET ROLE service_role;
DO $$ BEGIN
  BEGIN
    PERFORM 1 FROM retired_error_telemetry_20260916.sentry_error_log;
    RAISE EXCEPTION 'Direct archive access unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
"""
args = [os.environ['PGNODE'], str(here / 'postgres-runtime/query.mjs')]
result = subprocess.run(args, input=setup + migration.read_text() + assertions,
                        text=True, capture_output=True)
if result.returncode:
    raise RuntimeError(result.stderr)
print('PASS exact retirement migration: nonempty rows, sequence identity, access denial, and first-party history')

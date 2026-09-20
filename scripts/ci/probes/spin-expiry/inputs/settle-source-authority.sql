-- SOURCE ONLY / UNRUN. Restore one authentic authority-registry row in the
-- isolated FIFO5 provider; not a production migration or financial operation.
-- Source: settle-source-capture.json, observed 2026-09-16 13:17:03.183284 UTC.
-- SHA256 0563d57cf9a00065bb74abe3f20f8fceb5350c2bc315a84b8a50a52f44beb404.
-- Apply after sequence authority restoration, before catalog/funding. Refuse
-- nonempty state and replay. No function, trigger, privilege or balance changes.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL timezone = 'UTC';
SET LOCAL statement_timeout = '15s';

DO $settle_source_boundary$
DECLARE
  execution_uuid text := current_setting('qualification.execution_uuid');
BEGIN
  IF current_user <> 'fixture_bootstrap' OR session_user <> 'fixture_bootstrap'
     OR execution_uuid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR current_database() <> 'qual_spin_expiry_' || replace(execution_uuid, '-', '')
     OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR inet_server_addr() IS NOT NULL
     OR current_setting('session_replication_role') <> 'origin'
     OR (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres') IS DISTINCT FROM false
  THEN
    RAISE EXCEPTION 'settle source requires exact isolated bootstrap boundary';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'ca_settle_sources'
      AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = 'postgres'
  ) THEN
    RAISE EXCEPTION 'settle source provider table authority differs';
  END IF;
END $settle_source_boundary$;

LOCK TABLE public.ca_settle_sources IN EXCLUSIVE MODE;
DO $settle_source_preimage$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_settle_sources) THEN
    RAISE EXCEPTION 'settle source provider must be empty; replay or drift refused';
  END IF;
END $settle_source_preimage$;

SET LOCAL ROLE postgres;
INSERT INTO public.ca_settle_sources (source, note, added_at)
VALUES (
  'atomic_cancel_tournament',
  '20260909014444: atomic cancellation receipt authority',
  TIMESTAMPTZ '2026-09-05 20:33:01.099866+00'
);
RESET ROLE;

DO $settle_source_postimage$
BEGIN
  IF (SELECT count(*) FROM public.ca_settle_sources) <> 1
     OR (SELECT count(*) FROM public.ca_settle_sources s
         WHERE s.source = 'atomic_cancel_tournament'
           AND s.note = '20260909014444: atomic cancellation receipt authority'
           AND s.added_at = TIMESTAMPTZ '2026-09-05 20:33:01.099866+00'
           AND to_jsonb(s) = jsonb_build_object(
             'source', 'atomic_cancel_tournament',
             'note', '20260909014444: atomic cancellation receipt authority',
             'added_at', TIMESTAMPTZ '2026-09-05 20:33:01.099866+00')) <> 1
  THEN
    RAISE EXCEPTION 'settle source provider exact single-row postimage differs';
  END IF;
END $settle_source_postimage$;
COMMIT;

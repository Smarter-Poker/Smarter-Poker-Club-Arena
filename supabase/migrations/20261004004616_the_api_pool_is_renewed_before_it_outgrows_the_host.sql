-- ============================================================================
-- THE API POOL IS RENEWED BEFORE IT OUTGROWS THE HOST
-- ============================================================================
--
-- WHY (measured on production 2026-10-03/04;
-- docs/changelog/2026-10-03-the-database-keeps-memory-headroom.md)
--
-- Every PostgREST pool connection (role authenticator) keeps a private catalog
-- cache, compiled PL/pgSQL functions and cached plans for the ~1,100 statement
-- shapes and 3,368 functions it serves. Measured on the host, that memory grows
-- by about 20 MB a minute per connection and is freed only when PostgREST
-- replaces its pool. Since PostgREST 12 the pool is replaced whenever it
-- receives a schema cache reload:
--   00:11-00:18  70 connections: AnonPages 9.2 -> 19.2 GB
--   00:18:06     reload (pool re-initialised): 19.2 -> 8.1 GB, no request failed
--   00:26        pool restarted at 40: 20.6 -> 5.0 GB
-- All four Postgres stops on 2026-10-03 (16:34, 19:50, 20:18, 23:44) came 25-29
-- minutes after the previous pool replacement. That was enough time for 70
-- connections to fill a 32 GB host that also holds 8.9 GB of shared buffers.
--
-- The settings that would bound this inside PostgREST (db-pool-max-lifetime,
-- db-pool-max-idletime, db-prepared-statements) are not exposed by the
-- Supabase Management API (PATCH /v1/projects/{ref}/postgrest accepts only
-- db_schema, db_extra_search_path, db_pool, db_pool_acquisition_timeout and
-- max_rows). db_pool was lowered from 70 to 40 on 2026-10-04 00:26 UTC.
--
-- periodic-work: renewing the API connection pool IS the product. PostgREST on
-- Supabase offers no pool lifetime setting, so the renewal is the only bound on
-- per-connection memory. It repairs no data and compensates for no writer.
--
-- WHAT THIS DOES
--
-- Every ten minutes it sends the same schema cache reload a migration already
-- sends. PostgREST re-initialises its pool: in-flight requests finish on their
-- old connections, new requests get fresh ones. No backend is signalled.
-- Terminating idle authenticator backends was tried first, 00:43:35: it hit a
-- connection PostgREST had just handed to a request (one 503, SQLSTATE 57P01)
-- and the PostgREST LISTEN connection, so it is not used. A manual
-- `NOTIFY pgrst, 'reload schema'` at 00:45:22 replaced 39 of 41 connections in
-- under a second, with a 3.0 s schema query and no failed request.
-- ('reload config' does not replace the pool. Tested at 00:44:29.)
--
-- It skips a run when a DDL statement has already reloaded PostgREST in the
-- last eight minutes (public.ca_ddl_events.triggers_pgrst_reload), because
-- the pool is fresh then. Each run costs one schema cache query, 2-4 s
-- measured on 4XL, under the authenticator's 5 min statement_timeout. Six runs
-- an hour is far below fn_pgrst_reload_watchdog's warning rate. The watchdog
-- counts DDL events only, so it does not count these runs.
--
-- Bound: 40 connections x about 10 minutes of growth stays under ~8 GB, where
-- the unbounded pool had reached 20 GB within 15 minutes.
-- ============================================================================

-- @live-proof: (SELECT count(*) = 1 FROM cron.job WHERE jobname = 'postgrest-pool-renew-10m' AND active AND schedule = '2,12,22,32,42,52 * * * *') AND to_regprocedure('smarter_private.fn_renew_postgrest_pool()') IS NOT NULL

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION smarter_private.fn_renew_postgrest_pool()
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.ca_ddl_events
     WHERE occurred_at > clock_timestamp() - interval '8 minutes'
       AND triggers_pgrst_reload
  ) THEN
    RETURN 'skipped: a DDL reload renewed the pool within 8 minutes';
  END IF;
  PERFORM pg_notify('pgrst', 'reload schema');
  RETURN 'renewed';
END
$function$;

COMMENT ON FUNCTION smarter_private.fn_renew_postgrest_pool() IS
  'Sends PostgREST a schema cache reload, which re-initialises its connection pool, so no authenticator backend outlives ~10 minutes of cache growth (20261004004616 the_api_pool_is_renewed_before_it_outgrows_the_host).';

REVOKE ALL ON FUNCTION smarter_private.fn_renew_postgrest_pool() FROM PUBLIC, anon, authenticated, service_role;

SELECT cron.schedule(
  'postgrest-pool-renew-10m',
  '2,12,22,32,42,52 * * * *',
  $cron$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('postgrest-pool-renew-10m'))
           THEN (SELECT smarter_private.fn_renew_postgrest_pool()) ELSE 'skipped: overlap' END; $cron$
);

DO $assert$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'postgrest-pool-renew-10m' AND active) <> 1 THEN
    RAISE EXCEPTION 'postgrest-pool-renew-10m is not scheduled exactly once';
  END IF;
  IF has_function_privilege('authenticated', 'smarter_private.fn_renew_postgrest_pool()', 'EXECUTE')
     OR has_function_privilege('anon', 'smarter_private.fn_renew_postgrest_pool()', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_renew_postgrest_pool is executable by a browser role';
  END IF;
END
$assert$;

COMMIT;

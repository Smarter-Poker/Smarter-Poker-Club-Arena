-- ===========================================================================
--  THE LEASE HEARTBEAT HAS ITS OWN LOGIN (2026-10-02)
-- ===========================================================================
--
-- THE STORM. About fifteen times in 24 hours (2026-10-01 22:49 .. 2026-10-02
-- 22:27 UTC) the engine lost every table and tournament lease at once, killed
-- and rebuilt ~340 tables and voided the hands in flight (~160 critical
-- financial_alerts per storm). At 22:27:07 the last heartbeat answered in
-- 338 ms; the next two never came back and the third took 13.4 s, because
-- PostgREST's pool (~71 connections, ~36 busy even when calm) was full of
-- slow readers and answered PGRST003 "Timed out acquiring connection from
-- connection pool". The 20 s local proof ran out at 22:27:27 and every
-- manager and table fenced itself, although the lease rows still named this
-- one instance and its generations.
--
-- THE DESIGN WAS ALREADY THERE. #5166 (2026-09-24) gave each lease scope a
-- persistent Postgres session of its own that game traffic cannot fill, and
-- left it inert until ENGINE_PG_LISTEN_URL is set on the engine host. It never
-- was, because the engine host holds no database password
-- (docs/changelog/2026-09-24-lease-renewal-cannot-queue-behind-game-traffic.md,
-- pg_stat_activity 2026-10-02 22:35Z: no engine session of any kind). Every
-- heartbeat since has queued for a PostgREST pool slot.
--
-- THIS MIGRATION gives the heartbeat a least-privilege login whose password
-- nobody sees, and hands its connection string to the one caller that already
-- holds the service-role key:
--
--   * engine_lease_heartbeat: LOGIN, no inheritance, EXECUTE on the two
--     heartbeat functions and nothing else. Both are SECURITY DEFINER, take
--     their authority from their arguments (instance id, exact generation) and
--     write only heartbeat_at. LISTEN (the hand-projection wake that reads the
--     same variable) needs no privilege at all.
--   * A random password, generated here and kept in Vault as the full
--     Supavisor SESSION-mode URL (port 5432, never the 6543 transaction pool).
--     Re-applying keeps an existing secret, so a running engine's credential
--     is never rotated underneath it.
--   * fn_engine_lease_session_url(): service_role only. The engine reads it at
--     boot when ENGINE_PG_LISTEN_URL is unset. The service-role key already
--     grants far more than this login can do.
--
-- Connections: two heartbeat sessions plus one LISTEN session per engine
-- process; CONNECTION LIMIT 8 covers a release overlap of two processes.
--
-- No hot table is touched: a role, two grants, one Vault row, one function.
-- One transaction, so PostgREST reloads its schema cache once.

BEGIN;

DO $role$
DECLARE
  v_pw     text;
  v_secret uuid;
BEGIN
  SELECT id INTO v_secret FROM vault.secrets WHERE name = 'engine_lease_heartbeat_url';

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'engine_lease_heartbeat') THEN
    CREATE ROLE engine_lease_heartbeat LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION
      CONNECTION LIMIT 8;
  END IF;
  ALTER ROLE engine_lease_heartbeat LOGIN NOINHERIT CONNECTION LIMIT 8;

  IF v_secret IS NULL THEN
    v_pw := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    EXECUTE format('ALTER ROLE engine_lease_heartbeat PASSWORD %L', v_pw);
    PERFORM vault.create_secret(
      format('postgresql://engine_lease_heartbeat.kuklfnapbkmacvwxktbh:%s@aws-0-us-west-2.pooler.supabase.com:5432/postgres', v_pw),
      'engine_lease_heartbeat_url',
      'engine lease heartbeat + hand-projection LISTEN session (20261002223745): Supavisor session mode, engine_lease_heartbeat login');
  END IF;
END $role$;

ALTER ROLE engine_lease_heartbeat SET statement_timeout = '8s';
ALTER ROLE engine_lease_heartbeat SET lock_timeout = '2s';
ALTER ROLE engine_lease_heartbeat SET idle_in_transaction_session_timeout = '10s';
GRANT USAGE ON SCHEMA public TO engine_lease_heartbeat;
GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases_v4(text, jsonb, integer) TO engine_lease_heartbeat;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v4(text, jsonb, integer) TO engine_lease_heartbeat;

CREATE OR REPLACE FUNCTION public.fn_engine_lease_session_url()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT decrypted_secret
    FROM vault.decrypted_secrets
   WHERE name = 'engine_lease_heartbeat_url'
   LIMIT 1;
$function$;

COMMENT ON FUNCTION public.fn_engine_lease_session_url() IS
  'The engine''s dedicated lease-heartbeat session URL (engine_lease_heartbeat login, Supavisor session mode). service_role only. 20261002223745.';

REVOKE ALL ON FUNCTION public.fn_engine_lease_session_url() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_engine_lease_session_url() TO service_role;

COMMIT;

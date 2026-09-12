-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909224349; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909224349   (the stamp IS the apply time, UTC: 2026-09-09 22:43:49)
--   name        tournament_launch_supply_version_is_manager_only
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 6057 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909224349 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_ca_tournament_launch_supply_version
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- tournament_launch_receipts is intentionally owner-only: service_role cannot
-- SELECT it. The tournament manager nevertheless read supply_version directly
-- through PostgREST when the older begin/complete RPC wrappers omitted that
-- new field. Once supply_version became explicit, that fallback still failed
-- with 42501 and could prevent a tournament from launching or completing.
--
-- Publish the one read the manager needs behind the same transaction-local
-- actor and tournament context that the Data API pre-request hook derives from
-- a current protocol-2 manager lease. The table remains private. The function
-- returns only the exact receipt's 0-or-1 protocol version, moves no state, and
-- creates no retry, watcher, repair, cron, or broader table grant.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '45s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('public.tournament_launch_receipts') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_attribute a
        WHERE a.attrelid = 'public.tournament_launch_receipts'::regclass
          AND a.attname = 'supply_version'
          AND a.attnum > 0
          AND NOT a.attisdropped
     )
     OR to_regprocedure(
          'smarter_private.fn_smarter_data_api_pre_request()'
        ) IS NULL THEN
    RAISE EXCEPTION
      'manager supply-version reader requires the sealed receipt version and request fence';
  END IF;

  IF has_table_privilege(
       'service_role',
       'public.tournament_launch_receipts',
       'SELECT'
     ) THEN
    RAISE EXCEPTION
      'manager supply-version reader refuses a database where service_role can read private launch receipts';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_launch_supply_version(
  p_tournament_id uuid,
  p_launch_id uuid
)
RETURNS smallint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
SET row_security TO 'off'
SET statement_timeout TO '5s'
AS $manager_supply_version$
DECLARE
  v_actor text := NULLIF(
    pg_catalog.current_setting('app.smarter_data_actor', true),
    ''
  );
  v_context_tournament text := NULLIF(
    pg_catalog.current_setting('app.smarter_tournament_id', true),
    ''
  );
  v_version smallint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     OR v_actor IS DISTINCT FROM 'tournament-manager'
     OR v_context_tournament IS DISTINCT FROM p_tournament_id::text THEN
    RAISE EXCEPTION
      'launch supply-version evidence requires the current tournament manager authority'
      USING ERRCODE = '28000';
  END IF;

  IF p_tournament_id IS NULL OR p_launch_id IS NULL THEN
    RAISE EXCEPTION 'invalid launch supply-version evidence identity'
      USING ERRCODE = '22023';
  END IF;

  SELECT r.supply_version
    INTO v_version
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
     AND r.launch_id = p_launch_id;

  IF v_version IS NOT NULL AND v_version NOT IN (0, 1) THEN
    RAISE EXCEPTION 'invalid launch supply-version value: %', v_version
      USING ERRCODE = '22023';
  END IF;

  RETURN v_version;
END;
$manager_supply_version$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_launch_supply_version(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_launch_supply_version(uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_ca_tournament_launch_supply_version(uuid, uuid) IS
  'Service-only, current-manager-bound protocol version for one owner-only tournament launch receipt. Moves no state.';

DO $verify$
DECLARE
  v_oid regprocedure :=
    'public.fn_ca_tournament_launch_supply_version(uuid,uuid)'::regprocedure;
  v_source text;
  v_result text;
  v_config text[];
  v_owner oid;
  v_table_owner oid;
  v_security_definer boolean;
  v_volatility "char";
BEGIN
  SELECT p.prosrc,
         pg_catalog.pg_get_function_result(p.oid),
         p.proconfig,
         p.proowner,
         p.prosecdef,
         p.provolatile
    INTO v_source,
         v_result,
         v_config,
         v_owner,
         v_security_definer,
         v_volatility
    FROM pg_catalog.pg_proc p
   WHERE p.oid = v_oid;

  SELECT c.relowner
    INTO v_table_owner
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.tournament_launch_receipts'::regclass;

  IF v_source IS NULL
     OR v_security_definer IS DISTINCT FROM true
     OR v_volatility IS DISTINCT FROM 'v'
     OR v_owner IS DISTINCT FROM v_table_owner
     OR v_result IS DISTINCT FROM 'smallint'
     OR NOT (v_config @> ARRAY[
          'search_path=""',
          'row_security=off',
          'statement_timeout=5s'
        ]::text[])
     OR v_source NOT LIKE
          '%auth.role() IS DISTINCT FROM ''service_role''%'
     OR v_source NOT LIKE
          '%v_actor IS DISTINCT FROM ''tournament-manager''%'
     OR v_source NOT LIKE
          '%v_context_tournament IS DISTINCT FROM p_tournament_id::text%'
     OR v_source NOT LIKE
          '%FROM public.tournament_launch_receipts r%'
     OR v_source NOT LIKE '%r.tournament_id = p_tournament_id%'
     OR v_source NOT LIKE '%r.launch_id = p_launch_id%'
     OR v_source ~* '\m(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\M'
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc p
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
         ) privilege
        WHERE p.oid = v_oid
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
     )
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_table_privilege(
          'service_role',
          'public.tournament_launch_receipts',
          'SELECT'
        ) THEN
    RAISE EXCEPTION
      'launch supply-version reader is not narrow, owner-capable and manager-only';
  END IF;
END;
$verify$;

COMMIT;

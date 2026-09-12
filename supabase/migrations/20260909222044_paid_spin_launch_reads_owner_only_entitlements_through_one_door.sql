-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909222044; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909222044   (the stamp IS the apply time, UTC: 2026-09-09 22:20:44)
--   name        paid_spin_launch_reads_owner_only_entitlements_through_one_door
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 5972 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909222044 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_ca_paid_spin_launch_entitlements
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

-- 20260909221616_paid_spin_launch_reads_owner_only_entitlements_through_one_door.sql
--
-- tournament_refund_entitlements is intentionally owner-only: service_role
-- cannot SELECT it. TournamentManagerBase nevertheless read that table through
-- PostgREST while deciding whether a paid Spin may launch, so every paid Spin
-- stood down on permission_denied before it could deal.
--
-- This is the only read the launch gate needs. It returns exactly user_id,
-- gross and created_at for the requested tournament and roster. The existing
-- PostgREST request hook must first prove the service JWT, current manager lease
-- generation and exact tournament id; this function rechecks the resulting
-- transaction-local identity before its owner privileges can read one row.
-- The private table keeps every direct privilege revoked. No retry, watcher,
-- repair path or financial mutation is added.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '45s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('public.tournament_refund_entitlements') IS NULL
     OR to_regprocedure(
          'smarter_private.fn_smarter_data_api_pre_request()'
        ) IS NULL THEN
    RAISE EXCEPTION
      'paid Spin entitlement reader requires owner-only entitlements and the manager request fence';
  END IF;

  IF has_table_privilege(
       'service_role',
       'public.tournament_refund_entitlements',
       'SELECT'
     ) THEN
    RAISE EXCEPTION
      'paid Spin entitlement reader refuses a database where service_role can read the private table';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_ca_paid_spin_launch_entitlements(
  p_tournament_id uuid,
  p_user_ids uuid[]
)
RETURNS TABLE(user_id uuid, gross numeric, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
SET row_security TO 'off'
SET statement_timeout TO '5s'
AS $paid_spin_entitlements$
DECLARE
  v_actor text := NULLIF(
    pg_catalog.current_setting('app.smarter_data_actor', true),
    ''
  );
  v_context_tournament text := NULLIF(
    pg_catalog.current_setting('app.smarter_tournament_id', true),
    ''
  );
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     OR v_actor IS DISTINCT FROM 'tournament-manager'
     OR v_context_tournament IS DISTINCT FROM p_tournament_id::text THEN
    RAISE EXCEPTION
      'paid Spin entitlement evidence requires the current tournament manager authority'
      USING ERRCODE = '28000';
  END IF;

  IF p_tournament_id IS NULL
     OR p_user_ids IS NULL
     OR pg_catalog.cardinality(p_user_ids) NOT BETWEEN 1 AND 3
     OR pg_catalog.array_position(p_user_ids, NULL::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid paid Spin entitlement evidence identity'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT e.user_id, e.gross, e.created_at
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id = p_tournament_id
     AND e.entitlement_kind = 'wallet_charge'
     AND e.charge_category = 'tournament_buyin'
     AND e.user_id = ANY(p_user_ids)
   ORDER BY e.user_id, e.created_at, e.id;
END;
$paid_spin_entitlements$;

REVOKE ALL ON FUNCTION public.fn_ca_paid_spin_launch_entitlements(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_paid_spin_launch_entitlements(uuid, uuid[])
  TO service_role;

COMMENT ON FUNCTION public.fn_ca_paid_spin_launch_entitlements(uuid, uuid[]) IS
  'Service-only, current-manager-bound paid Spin launch evidence. Returns only user_id, gross and created_at from the owner-only refund entitlement ledger and moves no state.';

DO $verify$
DECLARE
  v_oid regprocedure :=
    'public.fn_ca_paid_spin_launch_entitlements(uuid,uuid[])'::regprocedure;
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
   WHERE c.oid = 'public.tournament_refund_entitlements'::regclass;

  IF v_source IS NULL
     OR v_security_definer IS DISTINCT FROM true
     OR v_volatility IS DISTINCT FROM 's'
     OR v_owner IS DISTINCT FROM v_table_owner
     OR v_result IS DISTINCT FROM
          'TABLE(user_id uuid, gross numeric, created_at timestamp with time zone)'
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
          '%FROM public.tournament_refund_entitlements e%'
     OR v_source NOT LIKE
          '%e.entitlement_kind = ''wallet_charge''%'
     OR v_source NOT LIKE
          '%e.charge_category = ''tournament_buyin''%'
     OR v_source NOT LIKE '%e.user_id = ANY(p_user_ids)%'
     OR v_source ~* '\m(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\M'
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_table_privilege(
          'service_role',
          'public.tournament_refund_entitlements',
          'SELECT'
        ) THEN
    RAISE EXCEPTION
      'paid Spin entitlement evidence reader is not narrow, owner-capable and service-only';
  END IF;
END;
$verify$;

COMMIT;

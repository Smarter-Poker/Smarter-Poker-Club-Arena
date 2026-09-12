-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909220613; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909220613   (the stamp IS the apply time, UTC: 2026-09-09 22:06:13)
--   name        tournament_chip_supply_rpc_names_are_sealed_until_activation
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 5327 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909220613 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_issue_tournament_launch_stacks, public.fn_materialize_tournament_launch_seats, public.fn_project_tournament_launch_seat_stacks
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

-- 20260909034148_tournament_chip_supply_rpc_names_are_sealed_until_activation.sql
--
-- Reserve the immutable tournament chip-supply RPC signatures before the
-- capable engine caller is deployed. The full ledger cannot activate until
-- the stopped-engine whole-chip normalization has completed, so these exact
-- signatures deliberately fail closed and are executable by no application
-- role. The activation migration replaces the same signatures atomically and
-- grants only service_role after all conservation invariants exist.

BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

DO $precondition_tournament_chip_supply_rpc_seal$
BEGIN
  IF to_regprocedure(
       'public.fn_issue_tournament_launch_stacks(uuid,uuid,uuid,uuid[])'
     ) IS NOT NULL
     OR to_regprocedure(
       'public.fn_materialize_tournament_launch_seats(uuid,uuid,uuid,uuid[],jsonb)'
     ) IS NOT NULL
     OR to_regprocedure(
       'public.fn_project_tournament_launch_seat_stacks(uuid,uuid,uuid,uuid[])'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'TOURNAMENT_CHIP_SUPPLY_RPC_SEAL_PRECONDITION_FAILED: a reserved signature already exists';
  END IF;

  IF to_regclass('public.tournament_launch_receipts') IS NULL THEN
    RAISE EXCEPTION
      'TOURNAMENT_CHIP_SUPPLY_RPC_SEAL_PRECONDITION_FAILED: launch receipts are absent';
  END IF;
END;
$precondition_tournament_chip_supply_rpc_seal$;

CREATE FUNCTION public.fn_issue_tournament_launch_stacks(
  p_tournament_id uuid,
  p_launch_id uuid,
  p_lease_generation uuid,
  p_expected_user_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION
    'TOURNAMENT_CHIP_SUPPLY_NOT_ACTIVE: immutable supply activation has not completed'
    USING ERRCODE = '55000';
END;
$function$;

CREATE FUNCTION public.fn_materialize_tournament_launch_seats(
  p_tournament_id uuid,
  p_launch_id uuid,
  p_lease_generation uuid,
  p_expected_user_ids uuid[],
  p_assignments jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION
    'TOURNAMENT_CHIP_SUPPLY_NOT_ACTIVE: immutable supply activation has not completed'
    USING ERRCODE = '55000';
END;
$function$;

CREATE FUNCTION public.fn_project_tournament_launch_seat_stacks(
  p_tournament_id uuid,
  p_launch_id uuid,
  p_lease_generation uuid,
  p_expected_user_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION
    'TOURNAMENT_CHIP_SUPPLY_NOT_ACTIVE: immutable supply activation has not completed'
    USING ERRCODE = '55000';
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_issue_tournament_launch_stacks(
  uuid, uuid, uuid, uuid[]
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_materialize_tournament_launch_seats(
  uuid, uuid, uuid, uuid[], jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_project_tournament_launch_seat_stacks(
  uuid, uuid, uuid, uuid[]
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_issue_tournament_launch_stacks(uuid,uuid,uuid,uuid[]) IS
  'Fail-closed compatibility seal. Immutable tournament chip-supply activation must replace this body before service_role receives EXECUTE.';
COMMENT ON FUNCTION public.fn_materialize_tournament_launch_seats(uuid,uuid,uuid,uuid[],jsonb) IS
  'Fail-closed compatibility seal. Immutable tournament chip-supply activation must replace this body before service_role receives EXECUTE.';
COMMENT ON FUNCTION public.fn_project_tournament_launch_seat_stacks(uuid,uuid,uuid,uuid[]) IS
  'Fail-closed compatibility seal. Immutable tournament chip-supply activation must replace this body before service_role receives EXECUTE.';

DO $assert_tournament_chip_supply_rpc_seal$
DECLARE
  v_signature text;
  v_oid oid;
  v_source text;
  v_role name;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_issue_tournament_launch_stacks(uuid,uuid,uuid,uuid[])',
    'public.fn_materialize_tournament_launch_seats(uuid,uuid,uuid,uuid[],jsonb)',
    'public.fn_project_tournament_launch_seat_stacks(uuid,uuid,uuid,uuid[])'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION
        'TOURNAMENT_CHIP_SUPPLY_RPC_SEAL_ASSERTION_FAILED: missing %',
        v_signature;
    END IF;

    SELECT p.prosrc
      INTO STRICT v_source
      FROM pg_proc p
     WHERE p.oid = v_oid
       AND p.prosecdef
       AND NOT p.proretset
       AND p.prorettype = 'jsonb'::regtype
       AND p.proconfig @> ARRAY['search_path=public, pg_temp'];

    IF position('TOURNAMENT_CHIP_SUPPLY_NOT_ACTIVE' in v_source) = 0 THEN
      RAISE EXCEPTION
        'TOURNAMENT_CHIP_SUPPLY_RPC_SEAL_ASSERTION_FAILED: body is not sealed for %',
        v_signature;
    END IF;

    FOREACH v_role IN ARRAY ARRAY[
      'anon'::name,
      'authenticated'::name,
      'service_role'::name
    ] LOOP
      IF has_function_privilege(v_role, v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION
          'TOURNAMENT_CHIP_SUPPLY_RPC_SEAL_ASSERTION_FAILED: % can execute %',
          v_role,
          v_signature;
      END IF;
    END LOOP;
  END LOOP;
END;
$assert_tournament_chip_supply_rpc_seal$;

COMMIT;

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

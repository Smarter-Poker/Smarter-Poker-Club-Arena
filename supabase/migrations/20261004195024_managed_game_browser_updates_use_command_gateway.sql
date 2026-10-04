-- 20261004195024_managed_game_browser_updates_use_command_gateway
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-04 19:50:24 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- Table Management has one browser write door.
--
-- The managed command gateway is SECURITY DEFINER and owns the durable
-- command receipt.  Leaving UPDATE on either managed relation granted to a
-- browser role lets a caller skip the expected-version check, idempotency key,
-- refusal receipt, and operator audit trail.  The particularly old quoted
-- table policy was worse: it admitted every row (`USING (true)`).
--
-- Revoke only browser UPDATE authority.  INSERT/SELECT/DELETE privileges and
-- policies are untouched.  service_role and the SECURITY DEFINER command
-- gateway retain their existing privileges, so engine writes and the
-- supported management path continue unchanged.
-- @live-proof: NOT has_any_column_privilege('anon', 'public.tables', 'UPDATE') AND NOT has_any_column_privilege('authenticated', 'public.tables', 'UPDATE') AND NOT has_any_column_privilege('anon', 'public.tournaments', 'UPDATE') AND NOT has_any_column_privilege('authenticated', 'public.tournaments', 'UPDATE') AND has_table_privilege('service_role', 'public.tables', 'UPDATE') AND has_table_privilege('service_role', 'public.tournaments', 'UPDATE') AND has_function_privilege('authenticated', 'public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb)', 'EXECUTE') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'tables' AND policyname IN ('Club admins can update tables', 'tables_update'))

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "Club admins can update tables" ON public.tables;
DROP POLICY IF EXISTS tables_update ON public.tables;

REVOKE UPDATE ON TABLE public.tables, public.tournaments
  FROM PUBLIC, anon, authenticated;

-- PostgreSQL table and column grants are independent.  Remove any historical
-- column-level UPDATE grant as well, including one that is absent from the
-- checked-in migrations but may survive in a long-lived installation.
DO $revoke_column_updates$
DECLARE
  v_relation regclass;
  v_columns text;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.tables'::regclass,
    'public.tournaments'::regclass
  ] LOOP
    SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum)
      INTO v_columns
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = v_relation
       AND a.attnum > 0
       AND NOT a.attisdropped;

    EXECUTE format(
      'REVOKE UPDATE (%s) ON TABLE %s FROM PUBLIC, anon, authenticated',
      v_columns,
      v_relation
    );
  END LOOP;
END;
$revoke_column_updates$;

DO $verify$
DECLARE
  v_gateway regprocedure :=
    to_regprocedure(
      'public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb)'
    );
  v_gateway_owner name;
  v_gateway_security_definer boolean;
BEGIN
  IF has_any_column_privilege('anon', 'public.tables', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.tables', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.tournaments', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.tournaments', 'UPDATE') THEN
    RAISE EXCEPTION
      'managed game browser UPDATE privilege survived the one-door migration';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.tables', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.tournaments', 'UPDATE') THEN
    RAISE EXCEPTION
      'service_role managed game UPDATE privilege is missing';
  END IF;

  IF v_gateway IS NULL THEN
    RAISE EXCEPTION 'managed game command gateway is missing';
  END IF;

  SELECT r.rolname, p.prosecdef
    INTO v_gateway_owner, v_gateway_security_definer
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
   WHERE p.oid = v_gateway;

  IF NOT v_gateway_security_definer
     OR NOT has_function_privilege(
       'authenticated', v_gateway, 'EXECUTE'
     )
     OR NOT has_table_privilege(
       v_gateway_owner, 'public.tables', 'UPDATE'
     )
     OR NOT has_table_privilege(
       v_gateway_owner, 'public.tournaments', 'UPDATE'
     ) THEN
    RAISE EXCEPTION
      'managed game command gateway cannot retain its supported write path';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policy p
     WHERE p.polrelid = 'public.tables'::regclass
       AND p.polname IN ('Club admins can update tables', 'tables_update')
  ) THEN
    RAISE EXCEPTION 'legacy table UPDATE policy survived the one-door migration';
  END IF;
END;
$verify$;

COMMIT;

-- @live-proof: md5(pg_get_functiondef('public.fn_ca_break_window_ddl_guard()'::regprocedure))='a44aba0631deeeb6c6cf688daa2e25ba'
BEGIN;
SET LOCAL lock_timeout='2s';
DO $pre$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_break_window_ddl_guard()'::regprocedure))<>'40659a691919fbc55fe90f18827c834a'THEN RAISE EXCEPTION 'runtime_privilege_guard_preimage_changed';END IF;END $pre$;
CREATE OR REPLACE FUNCTION public.fn_ca_break_window_ddl_guard()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_now      timestamptz := clock_timestamp();
  v_refusal  text;
  v_app      text := '';
  v_what     text;
  v_schema   text;
  v_override text;
  v_switch   boolean := false;
  v_stage_b_bootstrap boolean := false;
BEGIN
  BEGIN
    v_app := coalesce(current_setting('application_name', true), '');
    IF NOT public.fn_ca_break_window_governs(session_user::text, v_app) THEN RETURN; END IF;

    -- GRANT/REVOKE change privileges, not the served schema (owner rule 5).
    -- Their event rows have no object address, including for pg_temp. Use
    -- PostgreSQL's authoritative tag; never parse a query or trust a GUC.
    IF TG_EVENT='ddl_command_end' AND TG_TAG IN('GRANT','REVOKE') THEN RETURN; END IF;

    IF TG_EVENT = 'sql_drop' THEN
      SELECT 'DROP ' || upper(d.object_type) || coalesce(' ' || d.object_identity, ''),
             d.schema_name
        INTO v_what, v_schema
        FROM pg_catalog.pg_event_trigger_dropped_objects() d
       WHERE NOT d.is_temporary
       LIMIT 1;
    ELSE
      SELECT c.command_tag || coalesce(' ' || c.object_identity, ''), c.schema_name
        INTO v_what, v_schema
        FROM pg_catalog.pg_event_trigger_ddl_commands() c
       WHERE c.schema_name IS DISTINCT FROM 'pg_temp'
         AND coalesce(c.object_identity, '') NOT LIKE 'pg_temp.%'
       LIMIT 1;
    END IF;

    IF v_what IS NULL THEN RETURN; END IF;

    -- Serialize migration completion with the existing announcement owner.
    -- A busy owner or unreadable freeze cannot silently admit governed DDL.
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(530090, 1) THEN
      RAISE EXCEPTION 'engine maintenance announcement owns the DDL boundary' USING ERRCODE = '55000';
    END IF;
    v_refusal := public.fn_ca_break_window_refuses_migrations(clock_timestamp());
    IF v_refusal IS NULL THEN RETURN; END IF;

    -- This branch does not set the general override marker.  Every one of the
    -- fixed bootstrap ALTER events must prove the exact query, catalog and
    -- stopped-engine freeze independently.  The marker only makes its audit
    -- record one-per-transaction.
    IF TG_EVENT = 'ddl_command_end'
       AND v_schema = 'supabase_migrations'
       AND v_what = 'ALTER TABLE supabase_migrations.schema_migrations'
       AND public.fn_ca_stage_b_ledger_bootstrap_allowed(
             current_query(), v_app, session_user::text) THEN
      v_stage_b_bootstrap := true;
      IF current_setting('ca.stage_b_ledger_bootstrap_audited', true)
           IS DISTINCT FROM txid_current()::text THEN
        PERFORM set_config('ca.stage_b_ledger_bootstrap_audited', txid_current()::text, true);
        INSERT INTO public.ca_break_window_migration_overrides
          (txid, reason, session_role, application_name, first_command, query_snippet)
        VALUES
          (txid_current(),
           'Stage-B transport: exact no-op schema_migrations bootstrap under authenticated :55 stopped-engine freeze',
           session_user::text, v_app, v_what, left(current_query(), 500));
      END IF;
      RETURN;
    END IF;

    -- Original one-transaction emergency contract, unchanged.  Stage-B's
    -- checked-in SET LOCAL reasons arrive here; the compatibility path above
    -- never sets this marker.
    IF current_setting('ca.break_window_override_in_force', true) = txid_current()::text THEN
      RETURN;
    END IF;

    v_override := nullif(btrim(coalesce(current_setting('ca.break_window_migration_override', true), '')), '');
    v_switch := lower(coalesce(v_override, ''))
                IN ('on', 'off', 'true', 'false', 't', 'f', 'yes', 'no', 'y', 'n', '1', '0');

    IF v_override IS NOT NULL AND NOT v_switch THEN
      PERFORM set_config('ca.break_window_override_in_force', txid_current()::text, true);
      PERFORM set_config('ca.break_window_migration_override', '', false);
      INSERT INTO public.ca_break_window_migration_overrides
        (txid, reason, session_role, application_name, first_command, query_snippet)
      VALUES
        (txid_current(), v_override, session_user::text, nullif(v_app, ''), v_what,
         left(current_query(), 500));
      RAISE WARNING 'break window override: % allowed at % UTC, inside the maintenance break window. Reason: %',
        v_what, to_char(v_now AT TIME ZONE 'UTC', 'HH24:MI:SS'), v_override;
      RETURN;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- The narrow admission is permitted only with its durable audit row. An
    -- audit failure must abort the bootstrap transaction, never inherit the
    -- legacy guard's availability-oriented fail-open behavior.
    IF v_stage_b_bootstrap OR v_what IS NOT NULL THEN
      RAISE;
    END IF;
    RAISE WARNING 'fn_ca_break_window_ddl_guard could not decide (% %), so it allowed the command',
      SQLSTATE, SQLERRM;
    RETURN;
  END;

  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'migration refused: ' || v_refusal,
    DETAIL  = format(
      '%s was refused and nothing in this transaction was applied (login role %s, application %s). '
      'The hourly or event-owned recovery break must finish its durable thaw before migration; '
      'DDL in this window reloads PostgREST''s schema cache (~28 s) or holds locks the break needs until it commits.',
      v_what, session_user, coalesce(nullif(v_app, ''), 'none')),
    HINT    = CASE
      WHEN v_switch THEN format(
        'ca.break_window_migration_override is %L, which is a switch, not a reason. Say why this cannot wait until :03.',
        v_override)
      WHEN v_schema = 'supabase_migrations' THEN
        'This is a migration tool preparing its history table: the Supabase MCP runs these no-op ALTERs '
        'before list_migrations and apply_migration, and they reload PostgREST like any other DDL. '
        'Inside the window, read the history with execute_sql instead: '
        'SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC. '
        'club-arena CLAUDE.md, Production DDL policy, rule 8 (the break window).'
      ELSE
        'Apply once after :03 UTC and after any event-owned maintenance thaw (never in a retry loop). An emergency fix that cannot wait: '
        'BEGIN; SET LOCAL ca.break_window_migration_override = ''<why>''; <migration>; COMMIT; '
        'every override is recorded in public.ca_break_window_migration_overrides. '
        'club-arena CLAUDE.md, Production DDL policy, rule 8 (the break window).'
    END;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_break_window_ddl_guard()FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_break_window_ddl_guard()TO service_role;
DO $post$ BEGIN IF NOT(md5(pg_get_functiondef('public.fn_ca_break_window_ddl_guard()'::regprocedure))='a44aba0631deeeb6c6cf688daa2e25ba')THEN RAISE EXCEPTION 'runtime_privilege_guard_postimage_changed';END IF;END $post$;
COMMIT;

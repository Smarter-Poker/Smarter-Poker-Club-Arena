-- 20260910160841_the_break_window_refusal_names_its_rule_and_explains_list_migrations.sql
--
-- Version reserved by scripts/new-migration.mjs as 20260910154914, then
-- aligned to 20260910160841, the version apply_migration recorded when it ran
-- at 16:08:41 UTC, so the repo and supabase_migrations agree.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES, AND WHY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260910154446 made the database refuse migrations inside the hourly
-- maintenance break window (:50-:03 UTC). Its first window, 15:50-16:03 UTC
-- on 2026-09-10, taught two things about its own refusal text.
--
-- ── 1. IT CITED THE WRONG RULE ─────────────────────────────────────────────
-- The HINT sent a refused agent to "club-arena CLAUDE.md, Production DDL
-- policy, rule 7". Rule 7 is taken: it is the 2026-09-08 rule that a probe
-- never carries DDL, and four documents already cite it as "section 2 rule
-- 7". The break-window rule was written down as rule 8. The HINT now says
-- "rule 8 (the break window)", and tests/the-break-clocks-agree.law.test.ts
-- reads the number from CLAUDE.md so a renumbering fails a test instead of
-- pointing agents at somebody else's rule.
--
-- ── 2. BOTH OF ITS FIRST REFUSALS WERE list_migrations ────────────────────
-- It refused twice in that window, at 15:58:04 and 16:02:40 (postgres logs,
-- sql_state 55000). Neither was a migration body. Both were the Supabase MCP
-- (-- source: POST /mcp) preparing the history table it reads:
--
--     begin;
--     create schema if not exists supabase_migrations;
--     create table if not exists supabase_migrations.schema_migrations (...);
--     alter table supabase_migrations.schema_migrations add column if not exists statements text[];
--     ... four more add column if not exists ...
--     commit;
--
-- The MCP runs that before list_migrations as well as before apply_migration
-- (15:45:37 on 2026-09-10 is a list_migrations with nothing applied after
-- it). The five ALTERs change nothing, but pg_event_trigger_ddl_commands()
-- still reports every one as ALTER TABLE, so pgrst_ddl_watch reloads
-- PostgREST's whole schema cache each time. ca_ddl_events: 1,389 of these
-- bootstraps from mgmt-api between 2026-08-31 and 2026-09-10, about 140 a
-- day, 334 of them inside :50-:03. Every one was a ~28 s reload, and one in
-- the break window is exactly what the guard exists to stop, so it stays
-- refused. What changes is what the refused agent is told: when the refused
-- command is in supabase_migrations, the HINT says this was a migration tool
-- preparing its history and that SELECT ... FROM
-- supabase_migrations.schema_migrations through execute_sql reads the same
-- history without any DDL.
--
-- Nothing else in fn_ca_break_window_ddl_guard changes: it now also keeps
-- the refused command's schema (v_schema) to choose the HINT. The event
-- triggers keep pointing at the same function, and CREATE OR REPLACE keeps
-- its grants.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_break_window_ddl_guard()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_now      timestamptz := clock_timestamp();
  v_refusal  text;
  v_app      text := '';
  v_what     text;
  v_schema   text;
  v_override text;
  v_switch   boolean := false;
BEGIN
  BEGIN
    -- 1. Outside the window there is nothing to decide: 47 minutes of every
    --    hour end here, before anything else is read.
    v_refusal := public.fn_ca_break_window_refuses_migrations(v_now);
    IF v_refusal IS NULL THEN
      RETURN;
    END IF;

    -- 2. Only the sessions that apply migrations. Never pg_cron, never
    --    Supabase's own roles, never PostgREST.
    v_app := coalesce(current_setting('application_name', true), '');
    IF NOT public.fn_ca_break_window_governs(session_user::text, v_app) THEN
      RETURN;
    END IF;

    -- 3. Only schema changes that outlive the session. Temporary objects are
    --    how probes work and are always allowed.
    IF TG_EVENT = 'sql_drop' THEN
      SELECT 'DROP ' || upper(d.object_type) || coalesce(' ' || d.object_identity, ''), d.schema_name
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

    IF v_what IS NULL THEN
      RETURN;
    END IF;

    -- 4. The emergency override, honoured for the one transaction that set
    --    it. The marker is this transaction's id, so it cannot be carried
    --    into another transaction or typed in by accident.
    IF current_setting('ca.break_window_override_in_force', true) = txid_current()::text THEN
      RETURN;
    END IF;

    v_override := nullif(btrim(coalesce(current_setting('ca.break_window_migration_override', true), '')), '');
    v_switch := lower(coalesce(v_override, ''))
                IN ('on', 'off', 'true', 'false', 't', 'f', 'yes', 'no', 'y', 'n', '1', '0');

    IF v_override IS NOT NULL AND NOT v_switch THEN
      PERFORM set_config('ca.break_window_override_in_force', txid_current()::text, true);
      -- Consumed: a session-level SET must not outlive this transaction.
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
    -- Fail open: see the header. A guard on every DDL statement in a shared
    -- database must never turn its own defect into an outage.
    RAISE WARNING 'fn_ca_break_window_ddl_guard could not decide (% %), so it allowed the command',
      SQLSTATE, SQLERRM;
    RETURN;
  END;

  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'migration refused: ' || v_refusal,
    DETAIL  = format(
      '%s was refused and nothing in this transaction was applied (login role %s, application %s). '
      'The engine announces the break at :53, parks every table at :55, restarts at :57-:58 and thaws at :00; '
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
        'Apply it once after :03 UTC (never in a retry loop). An emergency fix that cannot wait: '
        'BEGIN; SET LOCAL ca.break_window_migration_override = ''<why>''; <migration>; COMMIT; '
        'every override is recorded in public.ca_break_window_migration_overrides. '
        'club-arena CLAUDE.md, Production DDL policy, rule 8 (the break window).'
    END;
END;
$fn$;

DO $check$
DECLARE
  v_def text := pg_get_functiondef('public.fn_ca_break_window_ddl_guard()'::regprocedure);
BEGIN
  IF v_def NOT LIKE '%Production DDL policy, rule 8 (the break window).%'
     OR v_def LIKE '%Production DDL policy, rule 7.%'
     OR v_def NOT LIKE '%WHEN v_schema = ''supabase_migrations'' THEN%' THEN
    RAISE EXCEPTION 'the guard does not carry the corrected HINT';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_event_trigger
       WHERE evtname IN ('ca_break_window_refuses_ddl', 'ca_break_window_refuses_drops')
         AND evtenabled = 'O'
         AND evtfoid = 'public.fn_ca_break_window_ddl_guard()'::regprocedure) <> 2 THEN
    RAISE EXCEPTION 'the break-window event triggers are not both installed and enabled';
  END IF;
END
$check$;

COMMIT;

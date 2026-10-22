-- Native fixture for the daily-maintenance window route.
--
-- Run as the cluster superuser (supabase_admin, as on Supabase). The break
-- window functions, the DDL guard and the freeze predicates below are copied
-- from production (PokerIQ-Production, read 2026-10-22 with
-- pg_get_functiondef); only fn_ca_stage_b_ledger_bootstrap_allowed is a stub,
-- because the window route never takes the Stage-B bootstrap branch.
\set ON_ERROR_STOP on

CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE PASSWORD 'window-fixture';
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
GRANT CREATE, USAGE ON SCHEMA public TO postgres;

CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
GRANT USAGE ON SCHEMA auth TO postgres;

CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[],
  name text
);
GRANT USAGE ON SCHEMA supabase_migrations TO postgres;
GRANT SELECT, INSERT ON supabase_migrations.schema_migrations TO postgres;

-- The three live tables the incident was about, owned by the migrating role.
CREATE TABLE public.clubs (id bigint PRIMARY KEY, name text);
CREATE TABLE public.tables (id bigint PRIMARY KEY, club_id bigint);
CREATE TABLE public.hand_history (id bigint PRIMARY KEY, table_id bigint);
ALTER TABLE public.clubs OWNER TO postgres;
ALTER TABLE public.tables OWNER TO postgres;
ALTER TABLE public.hand_history OWNER TO postgres;
INSERT INTO public.clubs VALUES (1, 'fixture club');

CREATE TABLE public.engine_maintenance_break (
  id boolean PRIMARY KEY DEFAULT true,
  phase text NOT NULL,
  announced_at timestamptz NOT NULL DEFAULT now(),
  break_started_at timestamptz,
  break_ends_at timestamptz,
  reason text NOT NULL DEFAULT 'Scheduled Engine Maintenance'::text,
  declared_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  enforce_freeze boolean NOT NULL DEFAULT false,
  ownership_token uuid NOT NULL
);
CREATE TABLE public.engine_maintenance_thaws (
  id bigserial PRIMARY KEY,
  contract_version integer NOT NULL,
  release_target_at timestamptz,
  shifted jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE public.ca_break_window_migration_overrides (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid bigint NOT NULL,
  reason text NOT NULL,
  session_role text NOT NULL,
  application_name text,
  first_command text NOT NULL,
  query_snippet text
);
GRANT SELECT ON public.engine_maintenance_break, public.engine_maintenance_thaws,
  public.ca_break_window_migration_overrides TO postgres;

CREATE FUNCTION public.fn_active_maintenance_release_boundary()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
  v_trusted_database_actor boolean;
  v_release_target timestamptz;
BEGIN
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role', 'supabase_auth_admin')
         OR COALESCE(r.rolsuper, false)
         OR pg_catalog.pg_has_role(session_user, 'postgres', 'SET')
    INTO v_trusted_database_actor
    FROM (SELECT session_user AS role_name) s
    LEFT JOIN pg_catalog.pg_roles r ON r.rolname = s.role_name;

  IF v_request_role IS NOT NULL
     AND v_request_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REFUSED'
      USING ERRCODE = '42501';
  END IF;
  IF v_request_role IS NULL AND NOT COALESCE(v_trusted_database_actor, false) THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  SELECT max(t.release_target_at) INTO v_release_target
    FROM (SELECT t.release_target_at, t.shifted
            FROM public.engine_maintenance_thaws t
           WHERE t.contract_version = 3
             AND t.release_target_at > clock_timestamp()
          OFFSET 0) t
   WHERE COALESCE((t.shifted->>'complete')::boolean, false)
     AND t.shifted ?& c_required_steps;
  RETURN v_release_target;
END;
$function$;

CREATE FUNCTION public.fn_platform_frozen()
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                  AND b.announced_at + INTERVAL '2 minutes' <= clock_timestamp()
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$;

CREATE FUNCTION public.fn_entry_purchases_frozen()
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$;

CREATE FUNCTION public.fn_ca_break_window_refuses_migrations(p_at timestamp with time zone)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  c_window_opens_minute  CONSTANT integer := 50;
  c_window_closes_minute CONSTANT integer := 3;
  v_minute integer;
BEGIN
  IF p_at IS NULL THEN
    RETURN NULL;
  END IF;

  v_minute := extract(minute FROM (p_at AT TIME ZONE 'UTC'))::integer;

  IF v_minute >= c_window_opens_minute OR v_minute < c_window_closes_minute THEN
    RETURN to_char(p_at AT TIME ZONE 'UTC', 'HH24:MI:SS')
        || ' UTC is inside the hourly maintenance break window (:'
        || lpad(c_window_opens_minute::text, 2, '0') || '-:'
        || lpad(c_window_closes_minute::text, 2, '0') || ' UTC); apply after :'
        || lpad(c_window_closes_minute::text, 2, '0')
        || ', or for an emergency fix SET LOCAL ca.break_window_migration_override'
        || ' = ''<reason>'' in the same transaction';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RETURN 'an announced engine maintenance window or its thaw is active; apply after its durable release';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE FUNCTION public.fn_ca_break_window_governs(p_session_role text, p_application text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(p_application, '') <> 'pg_cron'
     AND EXISTS (
           SELECT 1
             FROM pg_catalog.pg_roles r
            WHERE r.rolname = p_session_role
              AND NOT r.rolsuper
              AND pg_catalog.pg_has_role(r.oid, 'postgres', 'MEMBER')
         );
$function$;

-- Stub: the window route never takes the Stage-B bootstrap branch.
CREATE FUNCTION public.fn_ca_stage_b_ledger_bootstrap_allowed(p_query text, p_app text, p_role text)
 RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

CREATE FUNCTION public.fn_ca_break_window_ddl_guard()
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

    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(530090, 1) THEN
      RAISE EXCEPTION 'engine maintenance announcement owns the DDL boundary' USING ERRCODE = '55000';
    END IF;
    v_refusal := public.fn_ca_break_window_refuses_migrations(clock_timestamp());
    IF v_refusal IS NULL THEN RETURN; END IF;

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
      '%s was refused and nothing in this transaction was applied (login role %s, application %s).',
      v_what, session_user, coalesce(nullif(v_app, ''), 'none'));
END;
$function$;

CREATE EVENT TRIGGER ca_break_window_refuses_ddl ON ddl_command_end
  EXECUTE FUNCTION public.fn_ca_break_window_ddl_guard();
CREATE EVENT TRIGGER ca_break_window_refuses_drops ON sql_drop
  EXECUTE FUNCTION public.fn_ca_break_window_ddl_guard();

-- Test controls, run by the harness as the superuser.
CREATE FUNCTION public.fixture_open_window(p_seconds_left integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  -- The most recent 04:00 America/Chicago instant: the break the route serves.
  v_start timestamptz := (date_trunc('day', now() AT TIME ZONE 'America/Chicago') + interval '4 hours')
                         AT TIME ZONE 'America/Chicago';
BEGIN
  IF v_start > now() THEN v_start := v_start - interval '1 day'; END IF;
  DELETE FROM public.engine_maintenance_break;
  DELETE FROM public.engine_maintenance_thaws;
  -- The countdown row of that break, its end moved to "now + p_seconds_left".
  INSERT INTO public.engine_maintenance_break
    (phase, announced_at, break_started_at, break_ends_at, enforce_freeze, ownership_token)
  VALUES ('counting_down', v_start - interval '2 minutes', v_start,
          clock_timestamp() + make_interval(secs => p_seconds_left), true, gen_random_uuid());
  -- The freeze stays confirmed through the certified release boundary branch
  -- of fn_platform_frozen, because the fixture's wall clock is not 04:00.
  INSERT INTO public.engine_maintenance_thaws (contract_version, release_target_at, shifted)
  VALUES (3, clock_timestamp() + make_interval(secs => p_seconds_left),
          jsonb_build_object('complete', true, 'sit_out_at', 0, 'hold_expires_at', 0,
            'addon_period_ends_at', 0, 'reversible_until', 0, 'reveal_deadline_at', 0,
            'rebuy_prompt_until', 0, 'bomb_pot_next_due_at', 0, 'cash_stay_last_tick_at', 0,
            'cash_rejoin_expires_at', 0, 'level_started_at', 0, 'cluster_break_eligible_since', 0,
            'cluster_move_expires_at', 0, 'reconnect_presence', 0, 'reconnect_snapshots', 0));
END $$;

CREATE FUNCTION public.fixture_close_window() RETURNS void
LANGUAGE sql AS $$
  DELETE FROM public.engine_maintenance_break;
  DELETE FROM public.engine_maintenance_thaws;
$$;

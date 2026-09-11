-- 20260910152737_the_database_refuses_migrations_inside_the_break_window.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES, AND WHY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every hour the platform stands still on a schedule (CLAUDE.md section 13):
-- :53 the engine announces the break (fn_save_engine_maintenance_break, under
-- pg_advisory_xact_lock(530090,1)), :55 every table is parked, ~:57-:58 the
-- deploy restarts the engine, :00 fn_thaw_platform gives the frozen minutes
-- back and the fleet resumes in waves, :12 pg_cron grades the break.
--
-- Agents kept applying migrations inside that window. Every DDL statement
-- fires pgrst_ddl_watch, PostgREST reloads its whole schema cache (~28 s on
-- this database), and the DDL holds its locks until it commits. At 23:52:36
-- UTC on 2026-09-09 a migration landed on top of the :53 announcement, the
-- announcement failed, and the 00:00 break was cancelled. The DDL policy in
-- CLAUDE.md section 2 already told agents to batch and be careful; nothing
-- told them "not now", and nothing could make it stick. Now the DATABASE
-- refuses.
--
-- ── WHY THE GUARD IS NOT ON supabase_migrations.schema_migrations ──────────
--
-- The obvious place is a BEFORE INSERT trigger on the migration history: the
-- management API records every migration it applies there. Measured on
-- production on 2026-09-10 it would have been worse than nothing. Comparing
-- the xmin of each history row with the xmin of the catalog rows its own
-- migration wrote:
--
--   * migrations with NO explicit BEGIN/COMMIT in their text: the catalog
--     rows carry EXACTLY the history row's xmin. 20260910051447 = 6 pg_proc +
--     10 pg_class rows at 372892307; 20260910035435 = 9 pg_proc rows at
--     371948401; 20260910062308 = 1 at 374419038. One transaction.
--
--   * migrations WITH BEGIN/COMMIT, which this repo requires (section 2 rule
--     1): every one of the 40+ checked has its catalog rows 3 to 2,359 xids
--     BELOW the history row, never equal. 20260910145833: pg_proc 381901597,
--     history 381901600. 20260910143719: 381583631 vs 381583679. The API
--     wraps the body as "begin; -- apply sql from post body ..." (visible in
--     ca_ddl_events.query_snippet) and records the history row after it, so
--     the migration's own COMMIT ends that transaction and the history INSERT
--     runs in a new one.
--
-- So for every migration written the way this repo requires, a trigger on
-- schema_migrations fires AFTER the DDL has committed and after PostgREST was
-- told to reload. Raising there would prevent nothing and would leave the
-- migration applied but unrecorded, which invites exactly the retry the DDL
-- policy forbids.
--
-- The guard is an EVENT TRIGGER instead. It runs inside the transaction of
-- the DDL statement itself, so when it raises that transaction aborts:
-- nothing it did is kept, the NOTIFY that pgrst_ddl_watch queued is
-- discarded, its locks are released, and no history row is written. How the
-- SQL arrived stops mattering: management API, MCP apply_migration or
-- execute_sql, psql, the pooler, the CLI, the dashboard.
--
-- ── WHAT IS REFUSED ────────────────────────────────────────────────────────
--
-- Inside minute-of-hour [:50, :03) UTC, any schema change that outlives the
-- session (a command ddl_command_end or sql_drop reports, outside pg_temp),
-- from a session that applies migrations.
--
-- Not only the command tags pgrst_ddl_watch reloads on. CREATE INDEX holds a
-- SHARE lock that blocks every write to its table for the whole build and
-- CREATE POLICY an ACCESS EXCLUSIVE one; the thaw at :00 writes, so a lock
-- held across it is a late thaw. ca_ddl_events shows both inside this window
-- (135 CREATE INDEX and 6 CREATE POLICY from mgmt-api in ten days), always as
-- part of an agent's migration. Refusing every non-temporary command also
-- means the guard does not have to track Supabase's reload list.
--
-- ── WHO IT GOVERNS, MEASURED RATHER THAN GUESSED ──────────────────────────
--
-- ca_ddl_events has logged every non-temporary DDL statement since
-- 2026-08-31. Inside :50-:03, every one from these applications was an
-- agent's migration: mgmt-api, Supavisor, psql, (empty), chip-std-migrate,
-- chip-std-migrate-split. All of them log in as postgres, and the Supabase
-- CLI logs in as cli_login_postgres, a member of postgres. That is the scope:
-- a session whose LOGIN role is postgres or a non-superuser member of it.
--
-- Never governed:
--   * application_name 'pg_cron'. Its only DDL is fn_refresh_active_poker_
--     locations' REFRESH MATERIALIZED VIEW, 330 times inside the window in
--     three days. It must never be refused, and it is exempt by name as well
--     as by the fact that nothing else about it would be.
--   * supabase_admin (a superuser) and Supabase's own platform roles
--     (supabase_auth_admin, supabase_storage_admin, ...), none of which is a
--     member of postgres. Platform upgrades run when Supabase runs them.
--   * authenticator, i.e. PostgREST: the engine and every browser.
--   * temporary objects, from anyone. CREATE TEMP TABLE is how probes work.
--
-- Nothing automated applies migrations: no workflow or script in this repo
-- or the World Hub does (applied-migrations-recorded.yml only reads), and
-- nothing but pg_cron has run DDL on a schedule in ten days of ca_ddl_events.
-- So no automation has to learn to wait; an agent who hits the refusal reads
-- when to come back in the message itself.
--
-- ── THE EMERGENCY OVERRIDE ────────────────────────────────────────────────
--
--     BEGIN;
--     SET LOCAL ca.break_window_migration_override = '<why this cannot wait>';
--     ... the migration ...
--     COMMIT;
--
-- * The reason must be a reason. Blank is refused, and so is a switch
--   ('on', 'true', '1', 'yes', ...): the record exists to say why.
-- * It is honoured for ONE transaction, the one that set it. A session-level
--   SET is consumed by the first transaction that uses it, so a pooled
--   connection can never carry it into somebody else's migration an hour
--   later.
-- * Every honoured transaction writes one row to
--   public.ca_break_window_migration_overrides (reason, login role,
--   application, first command, query) and raises a WARNING. The row commits
--   or rolls back with the migration it describes.
--
-- ── KNOWN LIMITS, WRITTEN DOWN ────────────────────────────────────────────
--
-- * The clock is read at each DDL statement, not at COMMIT. A transaction
--   whose last DDL ran at :49:59 and that commits at :50:30 is not caught.
--   That is what the three minutes between :50 and the :53 announcement are
--   for; keep migrations short.
-- * The guard fails OPEN on its own internal error (a WARNING, and the
--   command proceeds). It sits on every DDL statement in a database shared
--   with Supabase's own services and the World Hub, and a defect in it must
--   never become an outage of everything it was not built to refuse.
--
-- The window's two minutes are pinned by
-- tests/the-break-clocks-agree.law.test.ts beside the :53 announcement and
-- the :00 thaw they have to enclose. Change them together with that law.

BEGIN;

-- ── 1. THE WINDOW, AS A PURE FUNCTION ─────────────────────────────────────
-- NULL when a migration may be applied at p_at, otherwise the reason it may
-- not. Testable at any timestamp with a plain SELECT.
CREATE OR REPLACE FUNCTION public.fn_ca_break_window_refuses_migrations(p_at timestamptz)
RETURNS text
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- Pinned by tests/the-break-clocks-agree.law.test.ts: the window has to
  -- enclose the :53 announcement and the :00 thaw with margin.
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

  RETURN NULL;
END;
$fn$;

-- ── 2. WHICH SESSIONS THE WINDOW GOVERNS ──────────────────────────────────
-- The login role (session_user, which SET ROLE and SECURITY DEFINER do not
-- change) is postgres or a non-superuser member of postgres, and the session
-- is not pg_cron. A role that does not exist governs nothing.
CREATE OR REPLACE FUNCTION public.fn_ca_break_window_governs(
  p_session_role text,
  p_application  text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT coalesce(p_application, '') <> 'pg_cron'
     AND EXISTS (
           SELECT 1
             FROM pg_catalog.pg_roles r
            WHERE r.rolname = p_session_role
              AND NOT r.rolsuper
              AND pg_catalog.pg_has_role(r.oid, 'postgres', 'MEMBER')
         );
$fn$;

-- ── 3. THE RECORD OF EVERY OVERRIDE ───────────────────────────────────────
CREATE TABLE public.ca_break_window_migration_overrides (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid             bigint      NOT NULL,
  reason           text        NOT NULL CHECK (btrim(reason) <> ''),
  session_role     text        NOT NULL,
  application_name text,
  first_command    text        NOT NULL,
  query_snippet    text
);

ALTER TABLE public.ca_break_window_migration_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_break_window_migration_overrides FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_break_window_migration_overrides TO service_role;

-- ── 4. THE GUARD ──────────────────────────────────────────────────────────
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
      SELECT 'DROP ' || upper(d.object_type) || coalesce(' ' || d.object_identity, '')
        INTO v_what
        FROM pg_catalog.pg_event_trigger_dropped_objects() d
       WHERE NOT d.is_temporary
       LIMIT 1;
    ELSE
      SELECT c.command_tag || coalesce(' ' || c.object_identity, '')
        INTO v_what
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
      ELSE
        'Apply it once after :03 UTC (never in a retry loop). An emergency fix that cannot wait: '
        'BEGIN; SET LOCAL ca.break_window_migration_override = ''<why>''; <migration>; COMMIT; '
        'every override is recorded in public.ca_break_window_migration_overrides. '
        'club-arena CLAUDE.md, Production DDL policy, rule 7.'
    END;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_break_window_ddl_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_break_window_governs(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_break_window_governs(text, text) TO service_role;

-- ── 5. WIRED TO BOTH EVENTS ───────────────────────────────────────────────
-- ddl_command_end sees creates and alters; a DROP is reported to sql_drop
-- (pg_event_trigger_ddl_commands() does not list it), exactly as
-- pgrst_ddl_watch and pgrst_drop_watch split the same work.
DROP EVENT TRIGGER IF EXISTS ca_break_window_refuses_ddl;
DROP EVENT TRIGGER IF EXISTS ca_break_window_refuses_drops;

CREATE EVENT TRIGGER ca_break_window_refuses_ddl
  ON ddl_command_end
  EXECUTE FUNCTION public.fn_ca_break_window_ddl_guard();

CREATE EVENT TRIGGER ca_break_window_refuses_drops
  ON sql_drop
  EXECUTE FUNCTION public.fn_ca_break_window_ddl_guard();

-- These come after the event triggers on purpose: applied inside the window,
-- this migration refuses itself here and nothing above is kept.
COMMENT ON FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz) IS
  'NULL when a migration may be applied at p_at; otherwise why not. The hourly maintenance break window is minute-of-hour [:50, :03) UTC. Pinned by tests/the-break-clocks-agree.law.test.ts.';
COMMENT ON FUNCTION public.fn_ca_break_window_governs(text, text) IS
  'True when a session with this LOGIN role and application_name applies migrations: postgres or a non-superuser member of it, and not pg_cron.';
COMMENT ON FUNCTION public.fn_ca_break_window_ddl_guard() IS
  'Event trigger: refuses non-temporary DDL from migration sessions inside the hourly maintenance break window, unless SET LOCAL ca.break_window_migration_override = <reason> in the same transaction (recorded in ca_break_window_migration_overrides). Fails open on its own error.';
COMMENT ON TABLE public.ca_break_window_migration_overrides IS
  'One row per transaction that applied DDL inside the maintenance break window under ca.break_window_migration_override, with the reason it gave.';

-- ── 6. PROVE THE BOUNDARIES BEFORE COMMITTING ─────────────────────────────
DO $check$
BEGIN
  IF public.fn_ca_break_window_refuses_migrations('2026-09-10 14:49:59.999+00') IS NOT NULL
     OR public.fn_ca_break_window_refuses_migrations('2026-09-10 14:50:00+00') IS NULL
     OR public.fn_ca_break_window_refuses_migrations('2026-09-10 14:53:00+00') IS NULL
     OR public.fn_ca_break_window_refuses_migrations('2026-09-10 14:59:59.999+00') IS NULL
     OR public.fn_ca_break_window_refuses_migrations('2026-09-10 15:00:00+00') IS NULL
     OR public.fn_ca_break_window_refuses_migrations('2026-09-10 15:02:59.999+00') IS NULL
     OR public.fn_ca_break_window_refuses_migrations('2026-09-10 15:03:00+00') IS NOT NULL
     OR public.fn_ca_break_window_refuses_migrations('2026-09-10 15:30:00+00') IS NOT NULL
     -- 10:52 in UTC-5 is 15:52 UTC: the session time zone never matters.
     OR public.fn_ca_break_window_refuses_migrations('2026-09-10 10:52:00-05') IS NULL
     OR public.fn_ca_break_window_refuses_migrations(NULL) IS NOT NULL
  THEN
    RAISE EXCEPTION 'fn_ca_break_window_refuses_migrations does not refuse exactly [:50, :03) UTC';
  END IF;

  IF NOT public.fn_ca_break_window_governs('postgres', 'mgmt-api')
     OR NOT public.fn_ca_break_window_governs('postgres', '')
     OR public.fn_ca_break_window_governs('postgres', 'pg_cron')
     OR public.fn_ca_break_window_governs('supabase_admin', 'mgmt-api')
     OR public.fn_ca_break_window_governs('authenticator', 'PostgREST')
     OR public.fn_ca_break_window_governs('a_role_that_does_not_exist', 'psql')
  THEN
    RAISE EXCEPTION 'fn_ca_break_window_governs does not govern exactly the migration sessions';
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
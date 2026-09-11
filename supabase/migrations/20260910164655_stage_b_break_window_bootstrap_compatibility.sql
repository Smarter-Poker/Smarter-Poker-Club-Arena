-- 20260910161205_stage_b_break_window_bootstrap_compatibility
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-10 16:12:05 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
--
-- The break-window event trigger correctly refuses persistent DDL between
-- :50 and :03 UTC.  Supabase's apply_migration transport, however, sends a
-- fixed schema_migrations bootstrap transaction *before* the submitted SQL.
-- On an already-initialised project that transaction is a catalog no-op, but
-- its five ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements still reach
-- ddl_command_end.  That made it impossible to apply the Stage-B authority
-- chain in the one interval in which it is safe: the durable :55 stopped-
-- engine freeze.
--
-- This is not a general override and it is not a retry mechanism.  The event
-- trigger admits only that exact, whitespace-normalised mgmt-api transaction
-- plus the transport's exact three-line request provenance suffix,
-- only when the canonical migration-history catalog already exists unchanged,
-- the exact break-window guard receipt is already recorded, the authenticated
-- maintenance writer contract is intact, a durable counting_down break has at
-- least three minutes of headroom, and every engine authority heartbeat is
-- stale.  It takes the same shared maintenance key and canonical NOWAIT locks
-- as Stage B before deciding.  Any missing column, constraint, index, trigger,
-- policy, receipt, freeze fact or lock makes it return false; the original
-- refusal then fires.  Each ALTER event is revalidated.  A private transaction
-- marker merely deduplicates the audit row and never bypasses validation.
--
-- The five DDL-bearing Stage-B migrations still carry their own checked-in
-- transaction-local reasons.  This compatibility only gets the transport's
-- preceding no-op ledger bootstrap to those migrations; it cannot authorize
-- their DDL or anybody else's.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL transaction_timeout = '45s';

DO $authenticate_preimage$
DECLARE
  v_guard_receipts integer;
  v_hint_receipts integer;
BEGIN
  SELECT count(*)
    INTO v_guard_receipts
    FROM supabase_migrations.schema_migrations sm
   WHERE sm.version = '20260910154446'
     AND sm.name = 'the_database_refuses_migrations_inside_the_break_window'
     AND cardinality(sm.statements) = 1
     AND octet_length(sm.statements[1]) = 20519
     AND encode(extensions.digest(convert_to(sm.statements[1], 'UTF8'), 'sha256'), 'hex') =
         '772758b80f3a5f44296b84aabdb1def68278f541a1d49b8b58c49f33c5d9f082';

  IF v_guard_receipts <> 1 THEN
    RAISE EXCEPTION 'Stage-B ledger compatibility requires the exact applied 20260910154446 guard receipt';
  END IF;

  SELECT count(*)
    INTO v_hint_receipts
    FROM supabase_migrations.schema_migrations sm
   WHERE sm.version = '20260910160841'
     AND sm.name = 'the_break_window_refusal_names_its_rule_and_explains_list_migrations'
     AND cardinality(sm.statements) = 1
     AND octet_length(sm.statements[1]) = 9261
     AND encode(extensions.digest(convert_to(sm.statements[1], 'UTF8'), 'sha256'), 'hex') =
         '7e018da306ab9d56e82fa603f84535174a2975793aa7a74c4a4e931fc83ef34d';

  IF v_hint_receipts <> 1 THEN
    RAISE EXCEPTION 'Stage-B ledger compatibility requires the exact applied 20260910160841 guard postimage receipt';
  END IF;

  IF to_regprocedure('public.fn_ca_stage_b_ledger_bootstrap_allowed(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'fn_ca_stage_b_ledger_bootstrap_allowed already exists; refusing an unproved replacement';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
        WHERE n.nspname = 'public'
          AND p.proname = 'fn_ca_break_window_ddl_guard'
          AND pg_catalog.pg_get_function_identity_arguments(p.oid) = ''
          AND p.prorettype = 'event_trigger'::regtype
          AND p.prosecdef
          AND p.provolatile = 'v'
          AND o.rolname = 'postgres'
          AND md5(p.prosrc) = '838c294990ba4e53743b5f3df0304b1c'
          AND md5(pg_catalog.pg_get_functiondef(p.oid)) = 'fe9c0a7069362892dbc40ac025e2294f'
          AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
          AND (SELECT count(*) FROM pg_catalog.aclexplode(p.proacl)) = 2
          AND (SELECT count(DISTINCT acl.grantee)
                 FROM pg_catalog.aclexplode(p.proacl) acl
                 JOIN pg_catalog.pg_roles grantor_role
                   ON grantor_role.oid = acl.grantor
                 JOIN pg_catalog.pg_roles grantee_role
                   ON grantee_role.oid = acl.grantee
                WHERE grantor_role.rolname = 'postgres'
                  AND grantee_role.rolname IN ('postgres', 'service_role')
                  AND acl.privilege_type = 'EXECUTE'
                  AND NOT acl.is_grantable) = 2
     ) THEN
    RAISE EXCEPTION 'break-window guard preimage is not the exact applied 20260910160841 function';
  END IF;

  IF (SELECT count(*)
        FROM pg_catalog.pg_event_trigger e
       WHERE e.evtname IN ('ca_break_window_refuses_ddl', 'ca_break_window_refuses_drops')
         AND e.evtenabled = 'O'
         AND e.evtfoid = 'public.fn_ca_break_window_ddl_guard()'::regprocedure) <> 2 THEN
    RAISE EXCEPTION 'both canonical break-window event triggers must be installed and enabled';
  END IF;
END
$authenticate_preimage$;

CREATE FUNCTION public.fn_ca_stage_b_ledger_bootstrap_allowed(
  p_query        text,
  p_application  text,
  p_session_role text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  c_exact_query CONSTANT text :=
    'begin; create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text not null primary key); alter table supabase_migrations.schema_migrations add column if not exists statements text[]; alter table supabase_migrations.schema_migrations add column if not exists name text; alter table supabase_migrations.schema_migrations add column if not exists created_by text; alter table supabase_migrations.schema_migrations add column if not exists idempotency_key text unique; alter table supabase_migrations.schema_migrations add column if not exists rollback text[]; commit;';
  c_provenance_separator CONSTANT text :=
    pg_catalog.chr(10) || pg_catalog.chr(10) ||
    '-- source: POST /mcp' || pg_catalog.chr(10);
  v_raw_query text;
  v_query text;
  v_separator_at integer;
  v_suffix text;
BEGIN
  -- Fail closed. The transport appends exactly three provenance lines after
  -- the SQL. Split at their fixed boundary and normalize only the SQL prefix;
  -- arbitrary comments, extra commands, extra lines and alternate spellings
  -- therefore do not match.
  v_raw_query := pg_catalog.btrim(coalesce(p_query, ''));
  v_separator_at := pg_catalog.strpos(v_raw_query, c_provenance_separator);
  IF v_separator_at <= 0
     OR pg_catalog.strpos(
          pg_catalog.substr(
            v_raw_query, v_separator_at + pg_catalog.length(c_provenance_separator)
          ),
          c_provenance_separator
        ) > 0 THEN
    RETURN false;
  END IF;

  v_query := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.substr(v_raw_query, 1, v_separator_at - 1)),
    '[[:space:]]+', ' ', 'g'
  );
  v_suffix := pg_catalog.substr(v_raw_query, v_separator_at + 2);
  IF p_session_role IS DISTINCT FROM 'postgres'
     OR p_application IS DISTINCT FROM 'mgmt-api'
     OR v_query IS DISTINCT FROM c_exact_query
     OR v_suffix !~ '^-- source: POST /mcp\n-- user: oauth:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n-- date: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' THEN
    RETURN false;
  END IF;

  -- The already-recorded guard receipt makes this a continuation of the
  -- guarded history, never a way to create a fresh history catalog.
  IF (SELECT count(*)
        FROM supabase_migrations.schema_migrations sm
       WHERE sm.version = '20260910154446'
         AND sm.name = 'the_database_refuses_migrations_inside_the_break_window'
         AND cardinality(sm.statements) = 1
         AND octet_length(sm.statements[1]) = 20519
         AND encode(extensions.digest(convert_to(sm.statements[1], 'UTF8'), 'sha256'), 'hex') =
             '772758b80f3a5f44296b84aabdb1def68278f541a1d49b8b58c49f33c5d9f082') <> 1 THEN
    RETURN false;
  END IF;

  IF (SELECT count(*)
        FROM supabase_migrations.schema_migrations sm
       WHERE sm.version = '20260910160841'
         AND sm.name = 'the_break_window_refusal_names_its_rule_and_explains_list_migrations'
         AND cardinality(sm.statements) = 1
         AND octet_length(sm.statements[1]) = 9261
         AND encode(extensions.digest(convert_to(sm.statements[1], 'UTF8'), 'sha256'), 'hex') =
             '7e018da306ab9d56e82fa603f84535174a2975793aa7a74c4a4e931fc83ef34d') <> 1 THEN
    RETURN false;
  END IF;

  -- Exact canonical history catalog.  A missing/drifted column would make an
  -- IF NOT EXISTS statement mutating DDL, so it must not be admitted.
  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_namespace n
         JOIN pg_catalog.pg_roles o ON o.oid = n.nspowner
        WHERE n.nspname = 'supabase_migrations'
          AND o.rolname = 'postgres'
          AND n.nspacl IS NULL)
     OR to_regclass('supabase_migrations.schema_migrations') IS NULL
     OR (SELECT count(*) FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = 'supabase_migrations.schema_migrations'::regclass
            AND a.attnum > 0 AND NOT a.attisdropped) <> 6
     OR EXISTS (
          SELECT 1
            FROM (VALUES
              (1, 'version',        'text',   true),
              (2, 'statements',     'text[]', false),
              (3, 'name',           'text',   false),
              (4, 'created_by',     'text',   false),
              (5, 'idempotency_key','text',   false),
              (6, 'rollback',       'text[]', false)
            ) expected(attnum, attname, atttype, attnotnull)
           WHERE NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_attribute a
              WHERE a.attrelid = 'supabase_migrations.schema_migrations'::regclass
                AND a.attnum = expected.attnum
                AND a.attname = expected.attname
                AND pg_catalog.format_type(a.atttypid, a.atttypmod) = expected.atttype
                AND a.attnotnull = expected.attnotnull
                AND a.atthasdef = false
                AND a.attidentity = ''
                AND a.attgenerated = ''
           ))
     OR (SELECT count(*) FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = 'supabase_migrations.schema_migrations'::regclass) <> 2
     OR NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint c
           WHERE c.conrelid = 'supabase_migrations.schema_migrations'::regclass
             AND c.contype = 'p'
             AND pg_catalog.pg_get_constraintdef(c.oid, true) = 'PRIMARY KEY (version)')
     OR NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint c
           WHERE c.conrelid = 'supabase_migrations.schema_migrations'::regclass
             AND c.contype = 'u'
             AND pg_catalog.pg_get_constraintdef(c.oid, true) = 'UNIQUE (idempotency_key)')
     OR (SELECT count(*) FROM pg_catalog.pg_index i
          WHERE i.indrelid = 'supabase_migrations.schema_migrations'::regclass) <> 2
     OR NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_index i
            JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
           WHERE i.indrelid = 'supabase_migrations.schema_migrations'::regclass
             AND x.relname = 'schema_migrations_pkey'
             AND i.indisunique AND i.indisprimary AND i.indisvalid
             AND i.indisready AND i.indislive AND i.indimmediate
             AND i.indnkeyatts = 1 AND i.indnatts = 1
             AND i.indpred IS NULL
             AND pg_catalog.pg_get_indexdef(i.indexrelid) =
                 'CREATE UNIQUE INDEX schema_migrations_pkey ON supabase_migrations.schema_migrations USING btree (version)')
     OR NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_index i
            JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
           WHERE i.indrelid = 'supabase_migrations.schema_migrations'::regclass
             AND x.relname = 'schema_migrations_idempotency_key_key'
             AND i.indisunique AND NOT i.indisprimary AND i.indisvalid
             AND i.indisready AND i.indislive AND i.indimmediate
             AND i.indnkeyatts = 1 AND i.indnatts = 1
             AND i.indpred IS NULL
             AND pg_catalog.pg_get_indexdef(i.indexrelid) =
                 'CREATE UNIQUE INDEX schema_migrations_idempotency_key_key ON supabase_migrations.schema_migrations USING btree (idempotency_key)')
     OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_trigger t
           WHERE t.tgrelid = 'supabase_migrations.schema_migrations'::regclass
             AND NOT t.tgisinternal)
     OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_policy p
           WHERE p.polrelid = 'supabase_migrations.schema_migrations'::regclass)
     OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
           WHERE n.nspname = 'supabase_migrations'
             AND c.relname = 'schema_migrations'
             AND (c.relkind <> 'r' OR c.relpersistence <> 'p'
                  OR c.relrowsecurity OR c.relforcerowsecurity
                  OR c.relreplident <> 'd' OR o.rolname <> 'postgres'
                  OR c.relacl IS NOT NULL)) THEN
    RETURN false;
  END IF;

  -- Authenticate the maintenance writer surface before trusting the row.
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_catalog.pg_roles o ON o.oid=p.proowner
       WHERE n.nspname='public' AND p.proname='fn_platform_frozen'
         AND pg_catalog.pg_get_function_identity_arguments(p.oid)=''
         AND NOT p.prosecdef AND p.provolatile='v' AND o.rolname='postgres'
         AND md5(p.prosrc)='112b1265824ee082b8adc67ea367d826'
         AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[])
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_catalog.pg_roles o ON o.oid=p.proowner
       WHERE n.nspname='public' AND p.proname='fn_entry_purchases_frozen'
         AND pg_catalog.pg_get_function_identity_arguments(p.oid)=''
         AND NOT p.prosecdef AND p.provolatile='v' AND o.rolname='postgres'
         AND md5(p.prosrc)='a29498531e4b7d3889532e80fafc8d57'
         AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[])
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_catalog.pg_roles o ON o.oid=p.proowner
       WHERE n.nspname='public' AND p.proname='fn_serialize_engine_maintenance_break_write'
         AND pg_catalog.pg_get_function_identity_arguments(p.oid)=''
         AND NOT p.prosecdef AND p.provolatile='v' AND o.rolname='postgres'
         AND md5(p.prosrc)='084ed24f99e9d08765bd86ff8b920284'
         AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[])
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid='public.engine_maintenance_break'::regclass
          AND t.tgname='aa_serialize_maintenance_break_write'
          AND t.tgenabled='O' AND NOT t.tgisinternal
          AND t.tgfoid='public.fn_serialize_engine_maintenance_break_write()'::regprocedure) THEN
    RETURN false;
  END IF;

  -- Exact ownership/admission serialization.  Nothing waits behind a live
  -- engine writer or a concurrent schema-cache subscriber operation.
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(530090, 1) THEN
    RETURN false;
  END IF;
  EXECUTE 'LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT';
  EXECUTE 'LOCK TABLE public.engine_maintenance_break IN SHARE MODE NOWAIT';
  EXECUTE 'LOCK TABLE public.engine_leader IN EXCLUSIVE MODE NOWAIT';
  EXECUTE 'LOCK TABLE public.engine_table_leases IN EXCLUSIVE MODE NOWAIT';
  EXECUTE 'LOCK TABLE public.engine_tournament_leases IN EXCLUSIVE MODE NOWAIT';

  IF (SELECT count(*)
        FROM public.engine_maintenance_break b
       WHERE b.id = true
         AND b.enforce_freeze IS TRUE
         AND b.phase = 'counting_down'
         AND b.break_started_at IS NOT NULL
         AND b.announced_at IS NOT NULL
         AND b.break_ends_at IS NOT NULL
         AND b.break_started_at >= b.announced_at
         AND b.break_ends_at > b.break_started_at
         AND b.break_ends_at < b.announced_at + interval '15 minutes'
         AND b.break_ends_at >= clock_timestamp() + interval '3 minutes') <> 1
     OR public.fn_platform_frozen() IS DISTINCT FROM true
     OR public.fn_entry_purchases_frozen() IS DISTINCT FROM true
     OR EXISTS (SELECT 1 FROM public.engine_leader l
                 WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds')
     OR EXISTS (SELECT 1 FROM public.engine_table_leases l
                 WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds')
     OR EXISTS (SELECT 1 FROM public.engine_tournament_leases l
                 WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds') THEN
    RETURN false;
  END IF;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  -- The outer guard deliberately fails open for platform availability.  This
  -- narrow admission must do the opposite: any uncertainty means "not this
  -- exception", after which the ordinary break-window refusal is raised.
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_stage_b_ledger_bootstrap_allowed(text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_ca_stage_b_ledger_bootstrap_allowed(text,text,text) IS
  'Private event-trigger predicate: admits only Supabase mgmt-api exact no-op schema_migrations bootstrap during an authenticated durable stopped-engine Stage-B freeze. Returns false on every mismatch or error.';

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
  v_stage_b_bootstrap boolean := false;
BEGIN
  BEGIN
    v_refusal := public.fn_ca_break_window_refuses_migrations(v_now);
    IF v_refusal IS NULL THEN RETURN; END IF;

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
    IF v_stage_b_bootstrap THEN
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

DO $prove_postimage$
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
         JOIN pg_catalog.pg_roles o ON o.oid=p.proowner
        WHERE n.nspname='public'
          AND p.proname='fn_ca_stage_b_ledger_bootstrap_allowed'
          AND pg_catalog.pg_get_function_identity_arguments(p.oid)='p_query text, p_application text, p_session_role text'
          AND p.prosecdef AND p.provolatile='v' AND o.rolname='postgres'
          AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
          AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
          AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND NOT pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'private Stage-B ledger-bootstrap predicate postimage is not exact';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_event_trigger e
       WHERE e.evtname IN ('ca_break_window_refuses_ddl','ca_break_window_refuses_drops')
         AND e.evtenabled='O'
         AND e.evtfoid='public.fn_ca_break_window_ddl_guard()'::regprocedure) <> 2
     OR pg_catalog.strpos(
          (SELECT p.prosrc FROM pg_catalog.pg_proc p
            WHERE p.oid='public.fn_ca_break_window_ddl_guard()'::regprocedure),
          'ca.stage_b_ledger_bootstrap_audited') = 0
     OR pg_catalog.strpos(
          (SELECT p.prosrc FROM pg_catalog.pg_proc p
            WHERE p.oid='public.fn_ca_break_window_ddl_guard()'::regprocedure),
          'ca.break_window_override_in_force') = 0 THEN
    RAISE EXCEPTION 'break-window guard compatibility postimage is not exact';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc p
        WHERE p.oid = 'public.fn_ca_break_window_ddl_guard()'::regprocedure
          AND (SELECT count(*) FROM pg_catalog.aclexplode(p.proacl)) = 2
          AND (SELECT count(DISTINCT acl.grantee)
                 FROM pg_catalog.aclexplode(p.proacl) acl
                 JOIN pg_catalog.pg_roles grantor_role
                   ON grantor_role.oid = acl.grantor
                 JOIN pg_catalog.pg_roles grantee_role
                   ON grantee_role.oid = acl.grantee
                WHERE grantor_role.rolname = 'postgres'
                  AND grantee_role.rolname IN ('postgres', 'service_role')
                  AND acl.privilege_type = 'EXECUTE'
                  AND NOT acl.is_grantable) = 2) THEN
    RAISE EXCEPTION 'break-window guard compatibility changed its exact ACL';
  END IF;
END
$prove_postimage$;

COMMENT ON FUNCTION public.fn_ca_break_window_ddl_guard() IS
  'Event trigger: refuses non-temporary DDL from migration sessions inside [:50,:03). The exact no-op mgmt-api schema_migrations bootstrap is admitted only under an authenticated durable stopped-engine Stage-B freeze; all actual migration DDL still requires its own recorded SET LOCAL reason.';

COMMIT;

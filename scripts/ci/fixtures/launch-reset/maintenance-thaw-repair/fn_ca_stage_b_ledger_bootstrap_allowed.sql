CREATE OR REPLACE FUNCTION public.fn_ca_stage_b_ledger_bootstrap_allowed(p_query text, p_application text, p_session_role text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
$function$;

-- Retire the legacy automatic mutation paths after their source
-- implementations were removed. Historical rows are preserved in a locked
-- archive schema; no runtime role can call or read these retired surfaces.
--
-- ca_engine_deploy_attempts and fn_ca_record_engine_deploy_attempt are not a
-- watcher or dispatcher. They are the append-only release receipt written by
-- the deployment itself, so they deliberately remain active and private.

BEGIN;

-- Remember the exact objects and row counts that exist in this environment.
-- Moving a table between schemas preserves its OID and rows; the final block
-- proves both facts before this transaction may commit. The snapshot is
-- transaction-local and disappears at COMMIT, so a completed migration can be
-- replayed safely.
CREATE TEMP TABLE ca_retirement_relation_snapshot (
  relation_name text PRIMARY KEY,
  relation_oid oid NOT NULL,
  row_count bigint NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE ca_retirement_receipt_snapshot (
  relation_oid oid PRIMARY KEY,
  row_count bigint NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
  v_relation record;
  v_receipt_oid oid;
  v_row_count bigint;
BEGIN
  FOR v_relation IN
    SELECT c.oid, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND (
         c.relname ~ '^autofix_'
         OR c.relname IN (
           'ca_deploy_dispatch_config',
           'ca_deploy_dispatch_log',
           'ca_engine_deploy_runs_started',
           'ca_engine_deploy_watch_state'
         )
       )
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', v_relation.relname)
      INTO v_row_count;
    INSERT INTO ca_retirement_relation_snapshot
      (relation_name, relation_oid, row_count)
    VALUES
      (v_relation.relname, v_relation.oid, v_row_count);
  END LOOP;

  SELECT c.oid
    INTO v_receipt_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'ca_engine_deploy_attempts'
     AND c.relkind IN ('r', 'p');

  IF v_receipt_oid IS NULL THEN
    RAISE EXCEPTION 'append-only Club Arena deployment receipt table is absent';
  END IF;

  SELECT count(*) INTO v_row_count
    FROM public.ca_engine_deploy_attempts;
  INSERT INTO ca_retirement_receipt_snapshot (relation_oid, row_count)
  VALUES (v_receipt_oid, v_row_count);
END
$$;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  FOR v_job_id IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN (
            'ca-deploy-dispatch',
            'ca-deploy-run-marker-prune',
            'ca-engine-deploy-truth-10m',
            'ca-engine-deploy-truth-1m'
          )
       OR lower(jobname) ~ '(^|[^a-z])sentry.?autofix([^a-z]|$)|(^|[^a-z])autofix([^a-z]|$)'
       OR lower(command) ~
          '(fn_ca_deploy_dispatch_tick|fn_ca_deploy_run_exists_this_hour|fn_ca_record_engine_deploy_start|fn_ca_prune_deploy_run_markers|fn_ca_engine_deploy_truth_watch|sentry.?autofix|autofix_)'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;
END
$$;

-- Remove every retired autofix view, including any environment-only view that
-- was created after the original source migration. Do not use CASCADE: an
-- unknown dependent must stop this migration for review rather than being
-- silently destroyed.
DO $$
DECLARE
  v_relation record;
BEGIN
  FOR v_relation IN
    SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname ~ '^autofix_'
       AND c.relkind IN ('v', 'm')
  LOOP
    EXECUTE format(
      CASE v_relation.relkind
        WHEN 'm' THEN 'DROP MATERIALIZED VIEW public.%I'
        ELSE 'DROP VIEW public.%I'
      END,
      v_relation.relname
    );
  END LOOP;
END
$$;

-- Detach every retired autofix trigger before dropping its trigger function.
DO $$
DECLARE
  v_trigger record;
BEGIN
  FOR v_trigger IN
    SELECT c.relname AS relation_name, t.tgname AS trigger_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = 'public'
       AND NOT t.tgisinternal
       AND c.relname ~ '^autofix_'
       AND p.proname ~ '^autofix_'
  LOOP
    EXECUTE format(
      'DROP TRIGGER %I ON public.%I',
      v_trigger.trigger_name,
      v_trigger.relation_name
    );
  END LOOP;
END
$$;

-- Drop every overload of every retired function. This includes environment-
-- only Sentry autofix helpers as well as every known deploy-control function.
DO $$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT n.nspname AS schema_name,
           p.proname AS function_name,
           pg_get_function_identity_arguments(p.oid) AS identity_arguments
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (
         p.proname ~ '^autofix_'
         OR p.proname IN (
           'fn_ca_deploy_dispatch_tick',
           'fn_ca_deploy_run_exists_this_hour',
           'fn_ca_record_engine_deploy_start',
           'fn_ca_prune_deploy_run_markers',
           'fn_ca_engine_deploy_truth_watch'
         )
       )
  LOOP
    EXECUTE format(
      'DROP FUNCTION %I.%I(%s)',
      v_function.schema_name,
      v_function.function_name,
      v_function.identity_arguments
    );
  END LOOP;
END
$$;

-- This secret existed solely so the retired database dispatcher could call
-- GitHub. Delete the named secret without selecting or logging its value.
DO $$
BEGIN
  IF to_regclass('vault.secrets') IS NOT NULL THEN
    EXECUTE 'DELETE FROM vault.secrets WHERE name = $1'
      USING 'ca_deploy_dispatch_token';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS ca_archive;
COMMENT ON SCHEMA ca_archive IS
  'Locked historical records for retired Club Arena automation. No runtime access.';

DO $$
DECLARE
  v_relation record;
BEGIN
  FOR v_relation IN
    SELECT relation_name
      FROM ca_retirement_relation_snapshot
     ORDER BY relation_name
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I SET SCHEMA ca_archive',
      v_relation.relation_name
    );
  END LOOP;
END
$$;

REVOKE ALL ON SCHEMA ca_archive FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA ca_archive FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ca_archive FROM PUBLIC, anon, authenticated, service_role;

-- Runtime roles may read the audit receipts only through the service role, and
-- may append only through the SECURITY DEFINER recorder. No runtime role can
-- insert, rewrite, truncate, or delete the underlying evidence table directly.
REVOKE ALL ON TABLE public.ca_engine_deploy_attempts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_engine_deploy_attempts TO service_role;

DO $$
DECLARE
  v_sequence text;
BEGIN
  v_sequence := pg_get_serial_sequence('public.ca_engine_deploy_attempts', 'id');
  IF v_sequence IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',
      v_sequence
    );
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.fn_ca_record_engine_deploy_attempt(text, boolean, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_record_engine_deploy_attempt(text, boolean, text, text, text)
  TO service_role;

COMMENT ON TABLE public.ca_engine_deploy_attempts IS
  'Append-only audit receipts written by Club Arena engine release runs; not a dispatcher or polling watcher.';
COMMENT ON FUNCTION public.fn_ca_record_engine_deploy_attempt(text, boolean, text, text, text) IS
  'Records one append-only Club Arena engine release receipt for audit and incident review.';

-- Fail closed if any executable legacy route survived retirement. These
-- assertions intentionally abort the migration instead of leaving a partial
-- cleanup that appears successful.
DO $$
DECLARE
  v_relation record;
  v_role text;
  v_row_count bigint;
  v_remaining text;
  v_secret_count bigint := 0;
BEGIN
  SELECT string_agg(format('%s: %s', jobname, command), E'\n' ORDER BY jobid)
    INTO v_remaining
    FROM cron.job
   WHERE jobname IN (
           'ca-deploy-dispatch',
           'ca-deploy-run-marker-prune',
           'ca-engine-deploy-truth-10m',
           'ca-engine-deploy-truth-1m'
         )
      OR lower(jobname) ~ '(^|[^a-z])sentry.?autofix([^a-z]|$)|(^|[^a-z])autofix([^a-z]|$)'
      OR lower(command) ~
         '(fn_ca_deploy_dispatch_tick|fn_ca_deploy_run_exists_this_hour|fn_ca_record_engine_deploy_start|fn_ca_prune_deploy_run_markers|fn_ca_engine_deploy_truth_watch|sentry.?autofix|autofix_)';

  IF v_remaining IS NOT NULL THEN
    RAISE EXCEPTION 'retired Club Arena deployment cron paths remain: %', v_remaining;
  END IF;

  SELECT string_agg(
           format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
           ', ' ORDER BY p.proname, p.oid
         )
    INTO v_remaining
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (
       p.proname ~ '^autofix_'
       OR p.proname IN (
         'fn_ca_deploy_dispatch_tick',
         'fn_ca_deploy_run_exists_this_hour',
         'fn_ca_record_engine_deploy_start',
         'fn_ca_prune_deploy_run_markers',
         'fn_ca_engine_deploy_truth_watch'
       )
     );

  IF v_remaining IS NOT NULL THEN
    RAISE EXCEPTION 'retired Club Arena deployment functions remain: %', v_remaining;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
    INTO v_remaining
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND (
       c.relname ~ '^autofix_'
       OR c.relname IN (
         'ca_deploy_dispatch_config',
         'ca_deploy_dispatch_log',
         'ca_engine_deploy_runs_started',
         'ca_engine_deploy_watch_state'
       )
     );

  IF v_remaining IS NOT NULL THEN
    RAISE EXCEPTION 'retired Club Arena relations remain public: %', v_remaining;
  END IF;

  IF to_regclass('vault.secrets') IS NOT NULL THEN
    EXECUTE $query$
      SELECT count(*)
        FROM vault.secrets
       WHERE name = $1
          OR lower(name) ~ 'sentry.?autofix|autofix'
    $query$
      INTO v_secret_count
      USING 'ca_deploy_dispatch_token';
  END IF;

  IF v_secret_count <> 0 THEN
    RAISE EXCEPTION 'retired Club Arena autofix or deployment dispatcher secret remains';
  END IF;

  IF to_regclass('public.ca_engine_deploy_attempts') IS NULL THEN
    RAISE EXCEPTION 'append-only Club Arena deployment receipt was removed';
  END IF;

  FOR v_relation IN
    SELECT relation_name, relation_oid, row_count
      FROM ca_retirement_relation_snapshot
  LOOP
    IF to_regclass(format('ca_archive.%I', v_relation.relation_name)) IS NULL
       OR to_regclass(format('ca_archive.%I', v_relation.relation_name))::oid
          <> v_relation.relation_oid THEN
      RAISE EXCEPTION 'retired relation % was not preserved at the same OID',
        v_relation.relation_name;
    END IF;

    EXECUTE format('SELECT count(*) FROM ca_archive.%I', v_relation.relation_name)
      INTO v_row_count;
    IF v_row_count <> v_relation.row_count THEN
      RAISE EXCEPTION 'retired relation % changed row count (% -> %)',
        v_relation.relation_name, v_relation.row_count, v_row_count;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_row_count FROM public.ca_engine_deploy_attempts;
  IF v_row_count <> (SELECT row_count FROM ca_retirement_receipt_snapshot) THEN
    RAISE EXCEPTION 'append-only Club Arena deployment receipt history changed';
  END IF;

  FOR v_role IN SELECT unnest(ARRAY['anon', 'authenticated', 'service_role'])
  LOOP
    IF has_schema_privilege(v_role, 'ca_archive', 'USAGE') THEN
      RAISE EXCEPTION 'runtime role % can use the retired archive schema', v_role;
    END IF;

    FOR v_relation IN
      SELECT c.oid, c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ca_archive'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
    LOOP
      IF (v_relation.relkind = 'S' AND (
            has_sequence_privilege(v_role, v_relation.oid, 'USAGE')
            OR has_sequence_privilege(v_role, v_relation.oid, 'SELECT')
            OR has_sequence_privilege(v_role, v_relation.oid, 'UPDATE')
          ))
         OR (v_relation.relkind <> 'S' AND (
            has_table_privilege(v_role, v_relation.oid, 'SELECT')
            OR has_table_privilege(v_role, v_relation.oid, 'INSERT')
            OR has_table_privilege(v_role, v_relation.oid, 'UPDATE')
            OR has_table_privilege(v_role, v_relation.oid, 'DELETE')
            OR has_table_privilege(v_role, v_relation.oid, 'TRUNCATE')
            OR has_table_privilege(v_role, v_relation.oid, 'REFERENCES')
            OR has_table_privilege(v_role, v_relation.oid, 'TRIGGER')
          )) THEN
        RAISE EXCEPTION 'runtime role % retains privileges on archived relation %',
          v_role, v_relation.relname;
      END IF;
    END LOOP;
  END LOOP;

  IF has_table_privilege('anon', 'public.ca_engine_deploy_attempts', 'SELECT')
     OR has_table_privilege('anon', 'public.ca_engine_deploy_attempts', 'INSERT')
     OR has_table_privilege('anon', 'public.ca_engine_deploy_attempts', 'UPDATE')
     OR has_table_privilege('anon', 'public.ca_engine_deploy_attempts', 'DELETE')
     OR has_table_privilege('authenticated', 'public.ca_engine_deploy_attempts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ca_engine_deploy_attempts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ca_engine_deploy_attempts', 'DELETE')
     OR has_table_privilege('authenticated', 'public.ca_engine_deploy_attempts', 'SELECT')
     OR has_table_privilege('service_role', 'public.ca_engine_deploy_attempts', 'INSERT')
     OR has_table_privilege('service_role', 'public.ca_engine_deploy_attempts', 'UPDATE')
     OR has_table_privilege('service_role', 'public.ca_engine_deploy_attempts', 'DELETE')
     OR has_table_privilege('service_role', 'public.ca_engine_deploy_attempts', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.ca_engine_deploy_attempts', 'REFERENCES')
     OR has_table_privilege('service_role', 'public.ca_engine_deploy_attempts', 'TRIGGER')
     OR NOT has_table_privilege('service_role', 'public.ca_engine_deploy_attempts', 'SELECT') THEN
    RAISE EXCEPTION 'append-only Club Arena deployment receipt table grants are unsafe';
  END IF;

  IF to_regprocedure(
       'public.fn_ca_record_engine_deploy_attempt(text,boolean,text,text,text)'
     ) IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = to_regprocedure(
          'public.fn_ca_record_engine_deploy_attempt(text,boolean,text,text,text)'
        )::oid
          AND p.prosecdef
          AND 'search_path=public, pg_temp' = ANY(coalesce(p.proconfig, ARRAY[]::text[]))
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_record_engine_deploy_attempt(text,boolean,text,text,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.fn_ca_record_engine_deploy_attempt(text,boolean,text,text,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_record_engine_deploy_attempt(text,boolean,text,text,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'append-only Club Arena deployment receipt function grants are unsafe';
  END IF;
END
$$;

COMMIT;

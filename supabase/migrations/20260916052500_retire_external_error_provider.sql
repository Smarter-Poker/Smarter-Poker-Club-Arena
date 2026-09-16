-- Retire the removed external error provider after all application cutovers.
-- Preserve first-party signup diagnostics and their existing archive behavior.
-- Before application, retain the provider-only incident snapshots in the
-- owner's restricted evidence archive. No audit/business table is renamed.
-- Existing historical migrations remain byte-identical. No CASCADE is allowed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $retirement_preflight$
DECLARE
  archive_oid oid := to_regprocedure('public.archive_signup_errors(integer)');
  definition_hash text;
  unexpected_callers text;
  retired_table text;
  has_records boolean;
BEGIN
  IF archive_oid IS NULL THEN
    RAISE EXCEPTION 'Existing signup archive function is required before provider retirement';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = archive_oid
       AND proowner = 'postgres'::regrole
       AND prosecdef
       AND proconfig = ARRAY['search_path=public']::text[]
       AND (
         SELECT count(*) = 2 AND bool_and(
           acl.grantor = 'postgres'::regrole
           AND acl.grantee IN ('postgres'::regrole, 'service_role'::regrole)
           AND acl.privilege_type = 'EXECUTE'
           AND NOT acl.is_grantable
         )
         FROM aclexplode(COALESCE(proacl, acldefault('f', proowner))) acl
       )
  ) OR has_function_privilege('anon', archive_oid, 'EXECUTE')
    OR has_function_privilege('authenticated', archive_oid, 'EXECUTE')
    OR NOT has_function_privilege('service_role', archive_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Signup archive authority changed; review current owner and grants';
  END IF;
  SELECT md5(prosrc) INTO definition_hash FROM pg_proc WHERE oid = archive_oid;
  IF definition_hash NOT IN ('97dfc291e85719410a9a42e8b2f8571b', '57f561df4f3f3c932bcc1b72982dd308') THEN
    RAISE EXCEPTION 'Signup archive definition changed; review the current source before retirement';
  END IF;

  SELECT string_agg(format('%I.%I(%s)', n.nspname, p.proname,
                          pg_get_function_identity_arguments(p.oid)), ', ')
    INTO unexpected_callers
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prokind IN ('f', 'p')
     AND p.oid <> archive_oid
     AND p.oid <> COALESCE(to_regprocedure('public.fn_sentry_budget_take(text,integer,integer)'), 0)
     AND p.prosrc ~* '\m(sentry_error_log|sentry_event_budget|sentry_event_fingerprints|forwarded_to_sentry|fn_sentry_budget_take)\M';
  IF unexpected_callers IS NOT NULL THEN
    RAISE EXCEPTION 'Retired provider still has function callers: %', unexpected_callers;
  END IF;
  -- All three tables were empty in the protected export. Hold their locks
  -- until commit so any newly arrived audit record refuses retirement.
  FOREACH retired_table IN ARRAY ARRAY[
    'public.sentry_error_log',
    'public.sentry_event_budget',
    'public.sentry_event_fingerprints'
  ] LOOP
    IF to_regclass(retired_table) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', to_regclass(retired_table));
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', to_regclass(retired_table)) INTO has_records;
      IF has_records THEN
        RAISE EXCEPTION 'Provider table % acquired data; obtain a new protected export before retirement', retired_table;
      END IF;
    END IF;
  END LOOP;
END;
$retirement_preflight$;

CREATE OR REPLACE FUNCTION public.archive_signup_errors(older_than_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    moved_count int := 0;
    cutoff timestamptz := now() - (older_than_days || ' days')::interval;
BEGIN
    -- Idempotent: skip rows we've already archived
    WITH moved AS (
        INSERT INTO public.signup_errors_archive
            (original_id, user_id, email, trigger_name, error_code, error_msg,
             raw_meta, occurred_at)
        SELECT id, user_id, email, trigger_name, error_code, error_msg,
               raw_meta, occurred_at
        FROM public.signup_errors
        WHERE occurred_at < cutoff
          AND NOT EXISTS (
              SELECT 1 FROM public.signup_errors_archive a
              WHERE a.original_id = signup_errors.id
          )
        RETURNING original_id
    )
    DELETE FROM public.signup_errors WHERE id IN (SELECT original_id FROM moved);

    GET DIAGNOSTICS moved_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'moved', moved_count,
        'cutoff', cutoff,
        'older_than_days', older_than_days
    );
END;
$function$;

-- Retain the observed service-only ACL and existing scheduled business job.
REVOKE ALL ON FUNCTION public.archive_signup_errors(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_signup_errors(integer) TO service_role;

DROP INDEX IF EXISTS public.signup_errors_pending_forward_idx;
ALTER TABLE public.signup_errors DROP COLUMN IF EXISTS forwarded_to_sentry RESTRICT;
ALTER TABLE public.signup_errors_archive DROP COLUMN IF EXISTS forwarded_to_sentry RESTRICT;
DROP FUNCTION IF EXISTS public.fn_sentry_budget_take(text, integer, integer) RESTRICT;
DROP TABLE IF EXISTS public.sentry_event_fingerprints RESTRICT;
DROP TABLE IF EXISTS public.sentry_event_budget RESTRICT;
DROP TABLE IF EXISTS public.sentry_error_log RESTRICT;

COMMIT;

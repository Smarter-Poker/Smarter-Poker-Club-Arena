-- The pulse remains SECURITY INVOKER for all product rows and their RLS.
-- Only its two fixed operational counts use a narrow privileged boundary.
-- Browser roles gain no cron schema/table access, job names, SQL or errors.
-- Anonymous execution remains refused. The helper has no caller parameters,
-- dynamic SQL, writes, product-table access or public default EXECUTE grant.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.get_smarter_poker_pulse()'::regprocedure)) = '47427f7876c3dd77027917e10f6d46dd' AND NOT has_schema_privilege('authenticated','cron','USAGE'))
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '8s';
DO $preflight$
BEGIN
  IF md5(pg_get_functiondef('public.get_smarter_poker_pulse()'::regprocedure))
       IS DISTINCT FROM '0a02c2f8a126f55a921a71763112a350'
     OR EXISTS (SELECT FROM pg_proc WHERE oid='public.get_smarter_poker_pulse()'::regprocedure AND prosecdef)
     OR NOT EXISTS (SELECT FROM pg_proc WHERE oid='public.get_smarter_poker_pulse()'::regprocedure AND proowner='postgres'::regrole)
     OR has_function_privilege('anon','public.get_smarter_poker_pulse()','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.get_smarter_poker_pulse()','EXECUTE')
     OR NOT has_function_privilege('service_role','public.get_smarter_poker_pulse()','EXECUTE')
     OR to_regprocedure('public.fn_smarter_poker_pulse_cron_counts()') IS NOT NULL THEN
    RAISE EXCEPTION 'PULSE_CRON_BOUNDARY_PREIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
END
$preflight$;

CREATE FUNCTION public.fn_smarter_poker_pulse_cron_counts()
RETURNS TABLE(cron_jobs_active bigint, cron_failures_24h numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''
SET statement_timeout TO '8s'
AS $function$
  SELECT
    (SELECT count(*) FROM cron.job j WHERE j.active
       AND (j.jobname LIKE 'home%' OR j.jobname LIKE 'pnm%')),
    (SELECT count(*)::numeric FROM cron.job j
       JOIN cron.job_run_details d ON d.jobid=j.jobid
       WHERE d.start_time > now()-interval '24 hours' AND d.status='failed');
$function$;
ALTER FUNCTION public.fn_smarter_poker_pulse_cron_counts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_smarter_poker_pulse_cron_counts() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_smarter_poker_pulse_cron_counts() TO authenticated, service_role;

DO $patch$
DECLARE
  v_target regprocedure := 'public.get_smarter_poker_pulse()'::regprocedure;
  v_old text := pg_get_functiondef(v_target);
  v_new text;
  v_catalog record;
BEGIN
  SELECT oid,proowner,proacl,proconfig,prosecdef INTO STRICT v_catalog FROM pg_proc WHERE oid=v_target;
  v_new := replace(v_old, $old$            -- Fixed: parenthesize the OR on jobname patterns
            'cron_jobs_active', (SELECT COUNT(*) FROM cron.job
                                  WHERE active = true
                                    AND (jobname LIKE 'home%' OR jobname LIKE 'pnm%')),
            'cron_failures_24h', (
                SELECT COALESCE(SUM(failures_24h), 0)
                  FROM v_system_health_cron
            ),
$old$, $new$            'cron_jobs_active', pulse_cron.cron_jobs_active,
            'cron_failures_24h', pulse_cron.cron_failures_24h,
$new$);
  v_new := replace(v_new, '    ) INTO v_pulse;',
    '    ) INTO v_pulse FROM public.fn_smarter_poker_pulse_cron_counts() AS pulse_cron;');
  IF md5(v_new) IS DISTINCT FROM '47427f7876c3dd77027917e10f6d46dd' THEN
    RAISE EXCEPTION 'PULSE_CRON_BOUNDARY_PATCH_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE v_new;
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid=v_catalog.oid
                  AND proowner=v_catalog.proowner
                  AND proacl IS NOT DISTINCT FROM v_catalog.proacl
                  AND proconfig IS NOT DISTINCT FROM v_catalog.proconfig
                  AND prosecdef=v_catalog.prosecdef)
     OR md5(pg_get_functiondef(v_target)) <> '47427f7876c3dd77027917e10f6d46dd' THEN
    RAISE EXCEPTION 'PULSE_CRON_BOUNDARY_READBACK_CHANGED' USING ERRCODE='55000';
  END IF;
END
$patch$;
COMMIT;

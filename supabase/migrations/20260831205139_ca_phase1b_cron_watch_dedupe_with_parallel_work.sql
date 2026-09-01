-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 20:51:39 UTC on kuklfnapbkmacvwxktbh.

-- Phase 1b fixup: a parallel session shipped fn_ca_cron_health(interval
-- DEFAULT ...) (a reporting function) minutes before phase 1b shipped
-- fn_ca_cron_health() (an incident raiser) — the zero-arg call is now
-- ambiguous, which would also have broken my new cron on its first tick.
-- Mine renames to fn_ca_cron_failure_watch; theirs keeps the name.
DROP FUNCTION IF EXISTS public.fn_ca_cron_health();

CREATE OR REPLACE FUNCTION public.fn_ca_cron_failure_watch()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r record; n integer := 0; v_is_guard boolean;
BEGIN
  FOR r IN
    SELECT j.jobname,
           count(*) FILTER (WHERE d.status = 'failed')    AS fails,
           count(*) FILTER (WHERE d.status = 'succeeded') AS successes,
           max(d.start_time) FILTER (WHERE d.status = 'succeeded') AS last_success,
           max(left(d.return_message, 200)) FILTER (WHERE d.status = 'failed') AS sample_error
    FROM cron.job j
    JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.active AND d.start_time > now() - interval '2 hours'
    GROUP BY j.jobname
    HAVING count(*) FILTER (WHERE d.status = 'failed') >= 5
       AND count(*) FILTER (WHERE d.status = 'succeeded') = 0
    LIMIT 20
  LOOP
    SELECT EXISTS (SELECT 1 FROM public.ca_guard_inventory g
                    WHERE g.kind = 'cron' AND g.object_a = r.jobname AND g.active)
      INTO v_is_guard;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_cron_failure_watch', 'unknown',
      CASE WHEN v_is_guard THEN 'critical' ELSE 'warning' END,
      'cron-failing:' || r.jobname || ':' || CURRENT_DATE::text,
      0, NULL, NULL, 'reporting', 'cron.job_run_details',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'scheduled job ' || r.jobname || ' has failed ' || r.fails
        || ' times in 2h with zero successes. Last error: ' || COALESCE(r.sample_error, '?'),
      NULL, jsonb_build_object('jobname', r.jobname, 'fails_2h', r.fails,
                               'last_success', r.last_success));
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_cron_failure_watch() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-cron-health-30m', '7,37 * * * *',
  $$SELECT public.fn_ca_cron_failure_watch();$$);

UPDATE public.ca_guard_inventory SET object_a = 'fn_ca_cron_failure_watch'
 WHERE kind = 'function' AND object_a = 'fn_ca_cron_health';
UPDATE public.ca_money_rpc_registry SET proname = 'fn_ca_cron_failure_watch'
 WHERE proname = 'fn_ca_cron_health'
   AND NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry WHERE proname = 'fn_ca_cron_failure_watch');
INSERT INTO public.ca_money_rpc_registry (proname, notes)
VALUES ('fn_ca_cron_health', 'parallel session reporting fn (interval arg), read-only')
ON CONFLICT DO NOTHING;;

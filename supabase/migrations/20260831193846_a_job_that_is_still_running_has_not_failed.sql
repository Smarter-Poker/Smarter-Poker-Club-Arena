-- ===========================================================================
-- A JOB THAT IS STILL RUNNING HAS NOT FAILED (2026-08-31)
--
-- fn_ca_cron_health shipped minutes ago and its first narrow-window run found
-- its own false positive:
--
--   [cron-health] over 10 minutes
--     CRITICAL rake-bbj-invariant-audit-hourly   0 failed / 1 runs
--
-- Zero failures, and it was called critical. pg_cron writes a row when a job
-- STARTS, so a run in flight has a status of 'running' - neither 'succeeded'
-- nor 'failed'. The verdict said "ran, and no success yet, therefore broken",
-- which for any job whose period is longer than the window is simply "it is
-- working right now".
--
-- An alarm that calls a healthy job critical is worse than no alarm: it is the
-- reason people stop reading alarms. Fixed before it was ever read.
--
-- The verdict now counts only FINISHED runs. If nothing has finished in the
-- window there is no evidence either way, and the honest answer is `idle` -
-- the same thing said about a weekly job inside a 24-hour window.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'fn_ca_cron_health') then
    raise exception 'PRE-FLIGHT: fn_ca_cron_health does not exist';
  end if;
end $$;

-- THE CHANGE
create or replace function public.fn_ca_cron_health(p_window interval default interval '24 hours')
returns table(
  jobname     text,
  schedule    text,
  verdict     text,
  runs        bigint,
  failures    bigint,
  successes   bigint,
  last_run_at timestamptz,
  last_error  text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with runs as (
    select j.jobname,
           j.schedule,
           count(r.*)                                     as runs,
           count(*) filter (where r.status = 'failed')    as failures,
           count(*) filter (where r.status = 'succeeded') as successes,
           max(r.start_time)                              as last_run_at,
           left(max(r.return_message) filter (where r.status = 'failed'), 200) as last_error
      from cron.job j
      left join cron.job_run_details r
        on r.jobid = j.jobid
       and r.start_time > now() - p_window
     where j.active
     group by j.jobname, j.schedule
  )
  select x.jobname, x.schedule,
         case
           -- Only FINISHED runs are evidence. pg_cron logs a row at START, so
           -- a job mid-flight has status 'running' and counts as neither.
           when x.failures + x.successes = 0 then 'idle'
           when x.successes = 0              then 'critical'
           when x.failures  > 0              then 'warn'
           else 'ok'
         end as verdict,
         x.runs, x.failures, x.successes, x.last_run_at, x.last_error
    from runs x
   order by
     case
       when x.failures + x.successes = 0 then 3
       when x.successes = 0              then 0
       when x.failures  > 0              then 1
       else 2
     end,
     x.failures desc,
     x.jobname;
$function$;

revoke all on function public.fn_ca_cron_health(interval) from public, anon, authenticated;
grant execute on function public.fn_ca_cron_health(interval) to service_role;

-- POST-APPLY: BOTH HALVES
do $$
declare
  v_jobs bigint;
  v_bad  bigint;
begin
  -- HALF ONE: a job with runs but nothing finished is no longer critical.
  select count(*) into v_bad
    from public.fn_ca_cron_health(interval '10 minutes')
   where verdict = 'critical' and failures = 0;
  if v_bad > 0 then
    raise exception 'POST-APPLY: % job(s) are still called critical with zero failures', v_bad;
  end if;

  -- ...over any window, critical now implies at least one observed failure.
  select count(*) into v_bad
    from public.fn_ca_cron_health(interval '24 hours')
   where verdict = 'critical' and failures = 0;
  if v_bad > 0 then
    raise exception 'POST-APPLY: 24h window still calls % zero-failure job(s) critical', v_bad;
  end if;

  -- HALF TWO: it still sees every active job and still says when one IS broken.
  select count(*) into v_jobs from public.fn_ca_cron_health();
  if v_jobs < (select count(*) from cron.job where active) then
    raise exception 'POST-APPLY: only % rows for % active jobs',
      v_jobs, (select count(*) from cron.job where active);
  end if;

  if not exists (select 1 from public.fn_ca_cron_health(interval '24 hours')
                  where verdict = 'critical' and failures > 0) then
    raise notice 'POST-APPLY: no genuinely broken job in the 24h window right now';
  end if;

  if has_function_privilege('anon', 'public.fn_ca_cron_health(interval)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.fn_ca_cron_health(interval)', 'EXECUTE') then
    raise exception 'POST-APPLY: a browser role can execute fn_ca_cron_health';
  end if;
  if not has_function_privilege('service_role', 'public.fn_ca_cron_health(interval)', 'EXECUTE') then
    raise exception 'POST-APPLY: service_role cannot execute it';
  end if;

  raise notice 'POST-APPLY: % active job(s) judged on finished runs only', v_jobs;
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - restores the verdict that called an in-flight job broken:
--   ... when count(*) filter (where r.status = 'succeeded') = 0 then 'critical'
-- ===========================================================================

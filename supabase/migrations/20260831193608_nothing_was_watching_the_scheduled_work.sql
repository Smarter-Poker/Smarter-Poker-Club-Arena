-- ===========================================================================
-- NOTHING WAS WATCHING THE SCHEDULED WORK (2026-08-31)
--
-- sp_upcoming_tournament_pushes ran every minute and FAILED 4,017 CONSECUTIVE
-- TIMES between 2026-08-28 19:49 and 2026-08-31 19:29 - nearly three days, zero
-- successes. It joins public.user_presence, a table that does not exist. It
-- sends the "your tournament starts in 15 minutes" reminders, so for three days
-- no player was reminded of anything.
--
-- Nobody knew. Not because it was hidden - cron.job_run_details had every one
-- of the 4,017 rows - but because nothing reads it.
--
-- ---------------------------------------------------------------------------
-- THERE WAS A WATCHER, AND IT WAS LOOKING AT THREE JOBS
--
-- v_system_health_cron already existed and already read cron.job_run_details.
-- Its filter:
--
--     WHERE jobname LIKE 'home%' OR jobname LIKE 'pnm%' OR jobname LIKE 'flag-garbage%'
--
-- Three name prefixes, out of 75 active jobs. Every scheduled thing the
-- platform has learned to do since that view was written has been outside it -
-- the reconcilers, the sweeps, the pushes, the rake repair. Scoped to the
-- instances that existed on the day it was written, which is the same shape as
-- a definer-view sweep that a new view walks straight past.
--
-- cron_health_log exists too and holds ZERO rows; the World Hub admin endpoint
-- that reads it says so in its own comments and calls filling it "a separate
-- piece of work".
--
-- So: widen the view to every job, and give the estate one function that says
-- plainly which scheduled work is failing.
--
-- ---------------------------------------------------------------------------
-- WHAT COUNTS AS BAD
--
--   critical  ran in the window and NEVER ONCE SUCCEEDED. This is the shape
--             that hid for three days: a job that is not flaky, it is broken.
--   warn      failed at least once but also succeeded - flaky, deadlocks,
--             timeouts. Worth seeing, not worth waking anyone.
--   ok        ran and never failed.
--   idle      active but did not run in the window at all. Normal for a weekly
--             job inside a 24-hour window, so it is NOT an alarm - it is said
--             out loud rather than silently dropped, because "no runs" and "no
--             failures" look identical in a count and only one of them is fine.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
begin
  if to_regclass('cron.job') is null or to_regclass('cron.job_run_details') is null then
    raise exception 'PRE-FLIGHT: pg_cron tables are not present';
  end if;
  if to_regclass('public.v_system_health_cron') is null then
    raise exception 'PRE-FLIGHT: v_system_health_cron does not exist - widening it is the point';
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
  select j.jobname,
         j.schedule,
         case
           when count(r.*) = 0                                   then 'idle'
           when count(*) filter (where r.status = 'succeeded') = 0 then 'critical'
           when count(*) filter (where r.status = 'failed')    > 0 then 'warn'
           else 'ok'
         end                                                     as verdict,
         count(r.*)                                              as runs,
         count(*) filter (where r.status = 'failed')             as failures,
         count(*) filter (where r.status = 'succeeded')          as successes,
         max(r.start_time)                                       as last_run_at,
         left(max(r.return_message) filter (where r.status = 'failed'), 200) as last_error
    from cron.job j
    left join cron.job_run_details r
      on r.jobid = j.jobid
     and r.start_time > now() - p_window
   where j.active
   group by j.jobname, j.schedule
   order by
     case
       when count(r.*) = 0                                     then 3
       when count(*) filter (where r.status = 'succeeded') = 0 then 0
       when count(*) filter (where r.status = 'failed')    > 0 then 1
       else 2
     end,
     count(*) filter (where r.status = 'failed') desc,
     j.jobname;
$function$;

revoke all on function public.fn_ca_cron_health(interval) from public, anon, authenticated;
grant execute on function public.fn_ca_cron_health(interval) to service_role;

-- AND THE VIEW THAT WAS LOOKING AT THREE JOBS NOW LOOKS AT ALL OF THEM.
-- Same columns, so anything reading it keeps working; it simply stops filtering
-- the platform down to the three prefixes that existed when it was written.
create or replace view public.v_system_health_cron as
  select j.jobid,
         j.jobname,
         j.schedule,
         j.active,
         (select d.status from cron.job_run_details d
           where d.jobid = j.jobid order by d.start_time desc limit 1) as last_status,
         (select d.start_time from cron.job_run_details d
           where d.jobid = j.jobid order by d.start_time desc limit 1) as last_run_at,
         (select d.end_time - d.start_time from cron.job_run_details d
           where d.jobid = j.jobid order by d.start_time desc limit 1) as last_run_duration,
         (select count(*) from cron.job_run_details d
           where d.jobid = j.jobid
             and d.start_time > now() - interval '24 hours'
             and d.status = 'failed') as failures_24h
    from cron.job j;

-- POST-APPLY: BOTH HALVES
do $$
declare
  v_jobs      bigint;
  v_view_jobs bigint;
  v_critical  bigint;
  v_cols      bigint;
begin
  -- HALF ONE: it sees every active job, and the view does too.
  select count(*) into v_jobs from public.fn_ca_cron_health();
  if v_jobs < (select count(*) from cron.job where active) then
    raise exception 'POST-APPLY: fn_ca_cron_health returned % rows for % active jobs',
      v_jobs, (select count(*) from cron.job where active);
  end if;

  select count(*) into v_view_jobs from public.v_system_health_cron;
  if v_view_jobs < (select count(*) from cron.job) then
    raise exception 'POST-APPLY: v_system_health_cron still filters (% rows for % jobs)',
      v_view_jobs, (select count(*) from cron.job);
  end if;

  -- ...and it can actually say something is wrong. The push job that failed
  -- 4,017 times was fixed minutes ago, so a 24h window still contains its
  -- failures; assert the function is capable of a non-ok verdict rather than
  -- asserting a specific job is broken, which would rot the moment it is fixed.
  if not exists (select 1 from public.fn_ca_cron_health() where verdict in ('critical','warn')) then
    raise notice 'POST-APPLY: no failing jobs in the window - the estate is clean right now';
  end if;

  select count(*) into v_critical from public.fn_ca_cron_health() where verdict = 'critical';
  raise notice 'POST-APPLY: % active job(s) visible, % critical', v_jobs, v_critical;

  -- HALF TWO: the promises not to break anything. The view keeps its columns,
  -- so the World Hub admin surface that selects from it does not break...
  select count(*) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'v_system_health_cron'
     and column_name in ('jobid','jobname','schedule','active','last_status',
                         'last_run_at','last_run_duration','failures_24h');
  if v_cols <> 8 then
    raise exception 'POST-APPLY: v_system_health_cron lost a column (% of 8 present)', v_cols;
  end if;

  -- ...and neither the function nor the view answers a browser.
  if has_function_privilege('anon', 'public.fn_ca_cron_health(interval)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.fn_ca_cron_health(interval)', 'EXECUTE') then
    raise exception 'POST-APPLY: a browser role can execute fn_ca_cron_health';
  end if;
  if not has_function_privilege('service_role', 'public.fn_ca_cron_health(interval)', 'EXECUTE') then
    raise exception 'POST-APPLY: service_role cannot execute it, so CI could not call it';
  end if;
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - returns the estate to noticing a broken cron job by accident:
--
--   DROP FUNCTION IF EXISTS public.fn_ca_cron_health(interval);
--   CREATE OR REPLACE VIEW public.v_system_health_cron AS ... WHERE jobname
--     LIKE 'home%' OR jobname LIKE 'pnm%' OR jobname LIKE 'flag-garbage%';
-- ===========================================================================

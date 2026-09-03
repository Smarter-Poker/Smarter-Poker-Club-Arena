-- 20260823023000_prune_snapshots_batch_keeps_up.sql
--
-- Follow-on to 20260822233000_prune_snapshots_bounded_scan.sql. That migration
-- made sp_prune_hand_state_snapshots stop full-scanning the table (51s mean ->
-- 137ms). This one makes the SCHEDULE able to use it.
--
-- WHAT WAS STILL WRONG. pg_cron job 119 runs the pruner every 5 minutes with a
-- batch of 2,000 under a 30s statement_timeout. That batch size was chosen when
-- every call was an unbounded scan, so it existed to stay under the timeout,
-- not to match the row rate. Measured 2026-08-23 02:20 UTC, after the scan fix:
--
--   prunable backlog 02:20Z         21,200 rows   (2,942 at 20:30Z - GROWING)
--   job 119 last 6h                 64 succeeded, 37 failed
--   the 37 failures                 'job startup timeout' - pg_cron worker
--                                   contention, not this function
--
-- ~12 effective runs/hour x 2,000 = 24k/hour of capacity against a table that
-- ages rows past the 7-day boundary faster than that, so the backlog rises
-- forever and the 6.3GB never comes back.
--
-- THE FIX IS THE BATCH, NOT THE SCHEDULE. Measured on production just now:
--
--   select public.sp_prune_hand_state_snapshots(10000);
--   -> 10,000 rows deleted in 7.83s     (well inside the 30s timeout)
--
-- 10,000 every 5 minutes is 120k/hour of capacity - five times the row rate -
-- so the backlog drains instead of accumulating, and it does it in FEWER runs,
-- which also reduces exposure to the startup-timeout contention above.
--
-- Everything else about the job is deliberately untouched: same schedule, same
-- advisory lock (a slow run can never overlap the next), same 30s timeout, same
-- retention policy (complete 7d, incomplete 30d).

select cron.alter_job(
  119,
  command => $cmd$
select case
         when pg_try_advisory_lock(hashtext('sp-prune-hand-state-snapshots'))
           then (select set_config('statement_timeout','30s',true) is not null
                    and public.sp_prune_hand_state_snapshots(10000) >= 0)::text
         else 'skipped: previous run still in progress'
       end;
$cmd$
);

-- Post-apply assertion: the job must still exist, still be active, still run
-- every 5 minutes, and now carry the larger batch.
do $$
declare
  j record;
begin
  select schedule, active, command into j from cron.job where jobid = 119;
  if j is null then
    raise exception 'cron job 119 (sp-prune-hand-state-snapshots) is missing - rollback';
  end if;
  if j.active is not true or j.schedule <> '*/5 * * * *' then
    raise exception 'cron job 119 schedule/active changed unexpectedly: % / %', j.schedule, j.active;
  end if;
  if position('sp_prune_hand_state_snapshots(10000)' in j.command) = 0 then
    raise exception 'cron job 119 did not take the new batch size - rollback';
  end if;
end $$;

-- ROLLBACK (paste to revert):
--   select cron.alter_job(119, command => $cmd$
--   select case
--            when pg_try_advisory_lock(hashtext('sp-prune-hand-state-snapshots'))
--              then (select set_config('statement_timeout','30s',true) is not null
--                       and public.sp_prune_hand_state_snapshots(2000) >= 0)::text
--            else 'skipped: previous run still in progress'
--          end;
--   $cmd$);

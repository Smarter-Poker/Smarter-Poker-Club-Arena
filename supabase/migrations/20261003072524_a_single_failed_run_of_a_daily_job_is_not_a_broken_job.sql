-- ===========================================================================
--  A SINGLE FAILED RUN OF A DAILY JOB IS NOT A BROKEN JOB
-- ===========================================================================
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 07:25:24 UTC.
--
-- Cron Health run 37105150898 (2026-10-03 07:05 UTC, head 940c273ea1) reported
--
--   124 active job(s) over 24 hours: 65 ok - 54 warn - 2 critical - 3 idle
--     CRITICAL ca-ledger-replay-nightly                1 failed /     1 runs
--     CRITICAL tourney_money_conservation_deep_daily   1 failed /     1 runs
--
-- Two different faults wear the same word. This migration separates them.
--
-- ---------------------------------------------------------------------------
-- 1. THE CHECK ANSWERS "BROKEN, NOT FLAKY" FROM ONE SAMPLE (CLAUDE.md 10.86)
-- ---------------------------------------------------------------------------
--
-- fn_ca_cron_health decides the verdict with
--
--     when a.successes = 0 then 'critical'
--
-- and the script that reads it prints "RAN AND NEVER SUCCEEDED - these are
-- broken, not flaky" and exits 1. That sentence is true for a job that runs
-- every minute: sp_upcoming_tournament_pushes, the outage this function was
-- written for in 20260831193608, had 4,017 finished runs and no successes.
--
-- IT IS NOT TRUE FOR A JOB WHOSE PERIOD IS THE WINDOW. A '25 3 * * *' job has
-- exactly ONE run inside a 24 hour window, so `successes = 0` carries no
-- information about whether the job is broken or simply failed last night.
-- The function asserts the strongest of its four verdicts off a sample of one
-- - the failure mode CLAUDE.md 10.86 rule 1 is about: "I could not tell" was
-- folded into the confident answer instead of being resolved.
--
-- Note the asymmetry it produced, measured on the same run: a job that failed
-- 13 of its 24 runs (ca-payout-guarantee-check-hourly) is WARN, because one
-- success clears it, while a daily job that failed once is CRITICAL. The
-- threshold is not stricter for the daily job; the window simply cannot sample
-- it.
--
-- THE FIX RESOLVES THE UNKNOWN BY MEASURING, not by widening a tolerance and
-- not by excusing a job. When the window holds exactly ONE finished run and it
-- failed, the verdict is decided by that job's LAST THREE finished runs, which
-- is evidence the window could not hold:
--
--   * a success among them  -> 'warn'     (it works; it failed this time)
--   * none among them       -> 'critical' (three consecutive failures)
--
-- Three, not five. Five was rejected on purpose: it would have cleared BOTH
-- jobs above and made this file a way of turning the board green. Three is the
-- smallest sample in which "always fails" is distinguishable from "failed", it
-- declares a broken daily job within three days, and measured against
-- production 2026-10-03 07:1x UTC it changes exactly one of the two verdicts:
--
--   ca-ledger-replay-nightly              last 3 = failed,failed,succeeded -> warn
--   tourney_money_conservation_deep_daily last 3 = failed,failed,failed    -> critical
--
-- Nothing else on the roster is affected: those two are the only active jobs
-- with one finished run and no success in the window.
--
-- A job that runs every minute is untouched - it has 1,431 finished runs, so
-- the single-sample branch never applies to it and a real silent failure is
-- still critical on its first window, exactly as in 20260831193608.
--
-- THE FIRST VERSION OF THIS FILE DID NOT APPLY, AND THE REASON IS WORTH
-- KEEPING (CLAUDE.md 10.86 rule 4: a fix that leaves the same trap one level
-- up has not landed). It asked for the last three runs with a correlated
-- `order by start_time desc limit 3` per sparse job. cron.job_run_details has
-- NO INDEX AT ALL, so each of those is a sequential scan of 280,684 rows, and
-- the function went from 546 ms to 27,665 ms - a 50x regression in the health
-- check itself, shipped to repair a health check. Apply run 37108462464 was
-- cancelled at 62,105 ms and rolled the whole transaction back; nothing
-- committed. Two things were wrong, and both are fixed here:
--
--   * the look-back is now ONE ranked pass over the log (698 ms, same
--     verdicts), not one scan per job;
--   * the read-back now TIMES the function instead of only checking that it
--     answers. "It returns the right rows" was asserted and passed, at 27.7s.
--
-- The honest version of the mistake: the verdicts were verified against
-- production before applying, and the COST was not.
--
-- The verdict is also computed ONCE now, in `decided`, instead of being
-- written twice (select list and ORDER BY) as two copies that could drift.
-- `distinct on (w.jobid)` and the single-row evidence columns are unchanged:
-- 20260919172421's law still holds, and nothing here aggregates over
-- return_message.
--
-- ---------------------------------------------------------------------------
-- 2. tourney_money_conservation_deep_daily IS REALLY BROKEN, AND WHY
-- ---------------------------------------------------------------------------
--
-- It is NOT excused above, so it stays critical until it completes. Read from
-- cron.job_run_details (jobid 274, 8 days to 2026-10-03 07:10 UTC):
--
--   09-27 217.1 s ok - 09-28 540.5 s ok - 09-29 601.6 s CANCELLED
--   09-30 414.1 s ok - 10-01 601.0 s CANCELLED - 10-02 600.8 s CANCELLED
--   10-03 600.2 s CANCELLED
--
-- Every cancel is at its own 600 s budget, inside
-- fn_tournament_conservation_delta. The job calls that delta once per event
-- over a 45 day window. MEASURED read-only against production at 07:3x UTC,
-- 141,924 events in the window, sampling ACROSS it rather than the freshest
-- (the newest 300 cost 0.78 ms each and are not representative):
--
--   400 events   2,197 ms   5.49 ms/event   ->  ~779 s
--   2,500 events 15,498 ms  6.20 ms/event   ->  ~880 s
--
-- The 2,500 sample is the one to believe. One run therefore needs ~880 s, and
-- pass 1 adds nothing right now: 0 open alerts from this source.
--
-- Its budget is therefore 68% of what one run costs, and 600 s was adequate
-- as recently as 09-27, when the same scan took 217 s (1.5 ms per event). The
-- per-event cost roughly QUADRUPLED in six days without the window growing
-- anything like that much. That is section 3.
--
-- This raises the budget 600 s -> 1500 s: 1.7x the measured 880 s, 7x the
-- 09-27 cost, and the run cannot reach the maintenance break. It starts at
-- 03:25 and now ends by 03:50 at the very worst, before the :53 announcement
-- and the :55 freeze (CLAUDE.md 13). The job writes only financial_alerts,
-- which carries no zz_freeze_guard, so it was never at risk of being refused
-- by the freeze; the ceiling is set to keep a 25 minute read snapshot off the
-- engine restart, not to satisfy a guard.
--
-- A BUDGET IS NOT A CURE, and this one is deliberately not described as one.
-- The same wording and the same reasoning are 20260927164653's, which gave
-- ca-conservation-sweep-hourly the 600 s its 30 checks measured. What this
-- buys is a conservation audit that COMPLETES: the 1-45 day tail has not been
-- audited since 09-30, because a statement timeout is QUERY_CANCELED and rolls
-- the whole run back. Recent events are still covered hourly by
-- tourney_money_conservation_hourly (1 day window).
--
-- 1.7x is thinner headroom than 20260927164653's 5x, and it is stated rather
-- than dressed up: the ceiling cannot go higher without the run reaching the
-- break, and the cost it is 1.7x of was measured during the worst degradation
-- this estate has recorded. If section 3 is fixed and the per-event cost
-- returns to ~1.5 ms, this job costs ~213 s and the budget is 7x headroom.
--
-- IF IT FAILS AGAIN, THE ANSWER IS NOT A THIRD BUDGET. It is making the pass
-- set-based - one grouped read per source table, instead of 141,924 separate
-- delta calls each doing ~14 index probes - because the scan also grows by
-- ~3,150 events a day on its own and will cross any fixed ceiling eventually.
-- That rewrite has to prove identical verdicts over the whole window before it
-- lands, which is why it is not bundled into a migration repairing a timeout.
--
-- Nothing else about the job changes: same name, schedule, function,
-- arguments, lock and database. cron.alter_job is a row update in the cron
-- schema, so it fires no pgrst_ddl_watch reload; the function replace above is
-- the one reload this migration costs, which is why both changes share a
-- single transaction (CLAUDE.md section 2 rules 1 and 4).
--
-- ---------------------------------------------------------------------------
-- 3. NOT FIXED HERE, AND NOT OURS: THE MULTIXACT SLRU IS THRASHING
-- ---------------------------------------------------------------------------
--
-- The tripling is platform-wide, not a defect in either job. MEASURED from
-- pg_stat_slru, 2026-10-03 07:1x UTC, stats_reset 2026-09-28 16:36:37 UTC
-- (the day before the first cancel):
--
--   slru              blks_hit        blks_read      miss
--   multixact_member  5,712,570,159   3,250,294,240  36.26%
--   multixact_offset  6,433,676,628   2,522,828,003  28.17%
--   transaction      15,874,255,128       2,495,422   0.02%
--   subtransaction    7,979,514,144               0   0.00%
--
-- 3.25 BILLION member reads in 4.6 days is ~8,200 a second, every one of them
-- a miss against a 32-buffer cache taking an SLRU lock, while the ordinary
-- transaction SLRU beside it misses 0.02%. multixact_member_buffers is 32 and
-- multixact_offset_buffers is 16, both defaults. Raising them needs a Postgres
-- restart, so it is a configuration change nobody can make from a migration,
-- and it is already a tracked platform condition - MultiXact SLRU was 9% of
-- all sampled waits in
-- docs/changelog/2026-10-01-three-slow-paths-do-only-the-work-they-act-on.md.
--
-- It is recorded here, with the numbers, because it is the reason two audits
-- that fit their budgets a week ago no longer do, and because the next agent
-- to find a 57014 in this estate should check that table before rewriting a
-- query. It is not this migration's to fix and this migration does not pretend
-- to have fixed it.
-- ===========================================================================
-- @live-proof: EXISTS (SELECT 1 FROM cron.job WHERE jobid = 274 AND active AND command LIKE 'SET statement_timeout = ''1500s'';%' AND schedule = '25 3 * * *') AND (SELECT strpos(p.prosrc, 'successes_in_last_3') > 0 AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_ca_cron_health')

BEGIN;

SET LOCAL lock_timeout = '5s';
-- 180s, NOT 60s. scripts/ci/apply-recorded-migration.mjs sends the whole file
-- in ONE client.query(), so statement_timeout governs the ENTIRE migration
-- rather than each statement in it. At 60s this file was cancelled at 62,105 ms
-- with the 27.7s correlated look-back above inside it, and rolled back whole.
-- The statements now measure ~2.4s in total (271ms for the function replace,
-- 1,608ms for the GRANT, 47ms for the re-budget, ~700ms for the read-back), so
-- this is 75x the measured cost and well inside the applier's own 600s deadline.
SET LOCAL statement_timeout = '180s';

-- ---------------------------------------------------------------------------
-- 1. The verdict stops asserting "never succeeded" off a sample of one
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_cron_health(p_window interval DEFAULT '24:00:00'::interval)
 RETURNS TABLE(jobname text, schedule text, verdict text, runs bigint, failures bigint, successes bigint, last_run_at timestamp with time zone, last_error text, last_run_status text, last_error_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with j as (
    select jobid, jobname, schedule from cron.job where active
  ),
  w as (
    select r.jobid, r.status, r.return_message, r.start_time
      from cron.job_run_details r
     where r.start_time > now() - p_window
  ),
  agg as (
    select j.jobid, j.jobname, j.schedule,
           count(w.*)                                     as runs,
           count(*) filter (where w.status = 'failed')    as failures,
           count(*) filter (where w.status = 'succeeded') as successes,
           max(w.start_time)                              as last_run_at
      from j left join w on w.jobid = j.jobid
     group by j.jobid, j.jobname, j.schedule
  ),
  -- ONE run, whole. status and message cannot come from different runs
  -- because they are columns of the same row.
  last_finished as (
    select distinct on (w.jobid)
           w.jobid, w.status, w.return_message, w.start_time
      from w
     where w.status in ('succeeded', 'failed')
     order by w.jobid, w.start_time desc
  ),
  -- A SAMPLE OF ONE CANNOT SAY "NEVER SUCCEEDED" (2026-10-03). A job whose
  -- period is as long as p_window puts exactly one run in it, so a single
  -- failure would otherwise be reported as 'critical', the verdict the
  -- reader prints as "broken, not flaky". So the last three FINISHED runs of
  -- every job are ranked here - evidence the window could not hold - and the
  -- verdict below consults them for that one case.
  --
  -- Three is the smallest sample that separates "always fails" from "failed";
  -- it keeps a genuinely dead daily job critical within three days, and it is
  -- not widened to clear any particular job.
  --
  -- ONE RANKED PASS, NOT A SUBQUERY PER JOB. The first version of this asked
  -- `order by start_time desc limit 3` inside a correlated subquery over
  -- cron.job_run_details, once per sparse job. cron's run log carries NO
  -- INDEX AT ALL - every read of it is a sequential scan of 280,684 rows -
  -- so the correlated form re-scanned the whole log per job and took
  -- 27,665 ms against this function's previous 546 ms. It was measured only
  -- after it had already failed to apply. Ranking once and grouping is
  -- 698 ms total, +152 ms on the old function, and Postgres pushes the
  -- rn <= 3 filter into the window as a Run Condition so it stops early.
  -- Same verdicts either way: 65 ok, 55 warn, 1 critical, 3 idle both times.
  recent as (
    select d.jobid, d.status,
           row_number() over (partition by d.jobid order by d.start_time desc) as rn
      from cron.job_run_details d
     where d.status in ('succeeded', 'failed')
  ),
  lookback as (
    select k.jobid,
           count(*) filter (where k.status = 'succeeded') as successes_in_last_3
      from recent k
     where k.rn <= 3
     group by k.jobid
  ),
  -- The verdict is computed ONCE. It used to be written twice, in the select
  -- list and again in the ORDER BY, which is two copies free to drift.
  decided as (
    select a.jobid, a.jobname, a.schedule, a.runs, a.failures, a.successes,
           a.last_run_at,
           case
             -- Only FINISHED runs are evidence. pg_cron logs a row at START,
             -- so a job mid-flight has status 'running' and counts as neither.
             when a.failures + a.successes = 0 then 'idle'
             when a.successes = 0
                  and a.failures + a.successes = 1
                  and coalesce(b.successes_in_last_3, 0) > 0 then 'warn'
             when a.successes = 0              then 'critical'
             when a.failures  > 0              then 'warn'
             else 'ok'
           end as verdict
      from agg a
      left join lookback b on b.jobid = a.jobid
  )
  select d.jobname, d.schedule, d.verdict,
         d.runs, d.failures, d.successes, d.last_run_at,
         case when lf.status = 'failed'
              then left(lf.return_message, 200) end as last_error,
         lf.status                                  as last_run_status,
         case when lf.status = 'failed'
              then lf.start_time end                as last_error_at
    from decided d
    left join last_finished lf on lf.jobid = d.jobid
   order by
     case d.verdict
       when 'critical' then 0
       when 'warn'     then 1
       when 'ok'       then 2
       else 3
     end,
     d.failures desc,
     d.jobname;
$function$;

-- A definer recreated inherits default privileges (20260919173446). Stated
-- rather than assumed; GRANT/REVOKE fire no schema reload (section 2 rule 5).
--
-- EVERY BROWSER ROLE BY NAME. `FROM PUBLIC` alone does not close this: anon
-- and authenticated are separate ACL entries, and anon inherits whatever
-- PUBLIC holds, so a lone PUBLIC revoke leaves a SECURITY DEFINER function
-- that never asks who the caller is reachable from a browser. That is rule 2
-- of scripts/ci/check-definer-authorization.mjs, which refused this migration
-- until all three were named - the same list 20260919173446 wrote, and the
-- reason it exists.
REVOKE ALL ON FUNCTION public.fn_ca_cron_health(interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_cron_health(interval) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The deep conservation audit gets the budget one run measures
-- ---------------------------------------------------------------------------

DO $deep_budget$
DECLARE
  v_old text;
  v_new text;
BEGIN
  SELECT command INTO v_old FROM cron.job WHERE jobid = 274;

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'job 274 (tourney_money_conservation_deep_daily) is not scheduled; this migration only re-budgets an existing job';
  END IF;

  IF strpos(v_old, '1500s') > 0 THEN
    RAISE NOTICE 'tourney_money_conservation_deep_daily already carries its 1500 s budget';
    RETURN;
  END IF;

  -- Refuse to overwrite a command somebody else has changed since it was read
  -- at 07:1x UTC. Several agents were in this audit family tonight.
  IF md5(v_old) <> '29e154ce84bd0dd84e5297b45a41c157' THEN
    RAISE EXCEPTION 'job 274 command is not the one measured (md5 %); refusing to overwrite it', md5(v_old);
  END IF;

  -- Only the budget moves. replace() keeps the statement text, the advisory
  -- lock, the arguments and the whitespace exactly as read, including the
  -- inner set_config - which 20261003025058 showed cannot re-arm a running
  -- statement, and which stays consistent with the first statement rather
  -- than being left behind at the old number.
  v_new := replace(v_old, '600s', '1500s');

  PERFORM cron.alter_job(job_id := 274, command := v_new);

  IF (SELECT command FROM cron.job WHERE jobid = 274) IS DISTINCT FROM v_new
     OR (SELECT schedule FROM cron.job WHERE jobid = 274) IS DISTINCT FROM '25 3 * * *'
     OR (SELECT active   FROM cron.job WHERE jobid = 274) IS NOT TRUE THEN
    RAISE EXCEPTION 'tourney_money_conservation_deep_daily did not read back as re-budgeted';
  END IF;
END
$deep_budget$;

-- ---------------------------------------------------------------------------
-- 3. The function reads back with the new branch, and still answers
-- ---------------------------------------------------------------------------

DO $readback$
DECLARE
  v_rows       integer;
  v_started    timestamptz;
  v_elapsed_ms numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_cron_health'
       AND strpos(p.prosrc, 'successes_in_last_3') > 0
       AND strpos(p.prosrc, 'distinct on (w.jobid)') > 0
  ) THEN
    RAISE EXCEPTION 'fn_ca_cron_health did not read back with the single-sample branch and its one-row evidence';
  END IF;

  -- IT MUST ANSWER, AND IT MUST ANSWER QUICKLY. The correlated first draft
  -- returned the right verdicts in 27.7s; nothing in this migration noticed,
  -- because "it answers" was the only thing asserted. The reader is a CI job
  -- under a statement timeout, so slow is a failure mode, not a detail.
  v_started := clock_timestamp();
  SELECT count(*) INTO v_rows FROM public.fn_ca_cron_health('24 hours');
  v_elapsed_ms := extract(epoch FROM clock_timestamp() - v_started) * 1000;

  IF v_rows < 1 THEN
    RAISE EXCEPTION 'fn_ca_cron_health returned no rows after replacement';
  END IF;

  IF v_elapsed_ms > 10000 THEN
    RAISE EXCEPTION 'fn_ca_cron_health answered in % ms; it measured 698 ms, and anything near a CI statement timeout is the 27.7s correlated look-back coming back', round(v_elapsed_ms);
  END IF;
  RAISE NOTICE 'fn_ca_cron_health answered % row(s) in % ms', v_rows, round(v_elapsed_ms);

  -- The grants read back the way 20260919173446 left them.
  IF NOT (
    SELECT NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_cron_health'
  ) THEN
    RAISE EXCEPTION 'fn_ca_cron_health is executable by a browser role, or not by service_role';
  END IF;
END
$readback$;

COMMIT;

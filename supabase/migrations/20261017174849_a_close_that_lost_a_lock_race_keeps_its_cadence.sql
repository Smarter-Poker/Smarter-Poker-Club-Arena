-- 20261017174849_a_close_that_lost_a_lock_race_keeps_its_cadence
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 17:48:49 UTC.
--
-- A CLOSE THAT LOST A LOCK RACE KEEPS ITS CADENCE (2026-10-17)
--
-- Job 272 (union-weekly-rakeback-close) calls the close every 5 minutes only
-- while a book is mid-close ('running' with a committed chunk), or failed on
-- weekly_scope_time_budget_exhausted in the last 3 hours, or a few other
-- named cases. Any other failure waits for the :40-:44 tick.
--
-- Read on production 2026-10-17: the 2026-10-05 Midway close had paid rounds
-- 1 and 2 and was 'running'. Its round-3 attempts deadlocked (40P01) at
-- 12:15, 15:10 and 17:16 UTC; the cause is fixed by 20261017161610. A
-- deadlocked attempt is rolled back and the run is marked 'failed', which drops
-- it from the 5-minute cadence. From then on it was called once an hour. The
-- report that makes an attempt fit its budget is kept for 30 minutes
-- (20261017131056), so every hourly attempt found it expired, re-proved it,
-- hit the 240 s statement timeout and was rolled back without changing the
-- run. The book could not reach round 3 again on its own.
--
-- THE FIX: a run that failed on a transient lock error, deadlock (40P01),
-- serialization (40001) or lock not available (55P03), is retried on the same
-- 5-minute cadence and for the same 3 hours as a time-budget failure. Those
-- errors say the attempt lost a race, not that the book is wrong; the attempt
-- was rolled back whole, so a retry is what it is owed. Every other failure
-- keeps today's hourly retry. The call itself, its budgets, timeout and
-- schedule are unchanged: only one disjunct is added to the gate.
--
-- GUARDS: refuses in the break window and while frozen; job 272 must exist
-- with the exact command preimage (b8be947f..., read on production) or already
-- the postimage (c74214f0..., derived read-only on production with replace());
-- the anchor occurs exactly once; schedule '*/5 * * * *' and active are kept;
-- the readback must be the exact postimage.
-- @live-proof: (SELECT md5(command)='c74214f0f7e65064769601dbe867ec28' AND schedule='*/5 * * * *' AND active FROM cron.job WHERE jobname='union-weekly-rakeback-close')

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'CLOSE_CADENCE_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'CLOSE_CADENCE_REFUSED: the platform is frozen' USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $job$
DECLARE
  j bigint; c text; s text; act boolean;
  c_old constant text := $o$ AND q.result->>'error'='weekly_scope_time_budget_exhausted' AND q.finished_at>now()-interval '3 hours')$o$;
  c_new constant text := $n$ AND q.result->>'error'='weekly_scope_time_budget_exhausted' AND q.finished_at>now()-interval '3 hours') OR EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.status='failed' AND q.result->>'sqlstate' IN ('40P01','40001','55P03') AND q.finished_at>now()-interval '3 hours')$n$;
BEGIN
  SELECT jobid, command, schedule, active INTO j, c, s, act FROM cron.job WHERE jobname = 'union-weekly-rakeback-close';
  IF NOT FOUND THEN RAISE EXCEPTION 'close cadence: job 272 missing' USING ERRCODE = '55000'; END IF;
  IF md5(c) = 'c74214f0f7e65064769601dbe867ec28' THEN RETURN; END IF;
  IF md5(c) <> 'b8be947fc591eeac63d2c194932fac66' THEN
    RAISE EXCEPTION 'close cadence: job 272 command preimage %', md5(c) USING ERRCODE = '55000';
  END IF;
  IF s <> '*/5 * * * *' OR act IS NOT TRUE THEN
    RAISE EXCEPTION 'close cadence: job 272 schedule or state changed (% %)', s, act USING ERRCODE = '55000';
  END IF;
  IF (length(c) - length(replace(c, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION 'close cadence: anchor is not exactly once';
  END IF;
  c := replace(c, c_old, c_new);
  IF md5(c) <> 'c74214f0f7e65064769601dbe867ec28' THEN
    RAISE EXCEPTION 'close cadence: computed postimage is %', md5(c);
  END IF;
  PERFORM cron.alter_job(j, schedule := '*/5 * * * *', command := c, active := true);
  IF (SELECT command FROM cron.job WHERE jobid = j) IS DISTINCT FROM c
     OR (SELECT schedule FROM cron.job WHERE jobid = j) <> '*/5 * * * *'
     OR (SELECT active FROM cron.job WHERE jobid = j) IS NOT TRUE THEN
    RAISE EXCEPTION 'close cadence: job 272 postimage differs';
  END IF;
END
$job$;

COMMIT;

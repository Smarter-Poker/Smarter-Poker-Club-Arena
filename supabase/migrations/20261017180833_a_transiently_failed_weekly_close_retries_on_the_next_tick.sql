-- 20261017180833_a_transiently_failed_weekly_close_retries_on_the_next_tick.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A TRANSIENTLY FAILED WEEKLY CLOSE RETRIES ON THE NEXT TICK. Full account:
-- docs/changelog/2026-10-17-a-transiently-failed-weekly-close-retries-on-the-next-tick.md.
--
-- WHAT BROKE. Job 272 calls the weekly cascade outside minutes :40-:44 only
-- when a close is running with a committed chunk, the week has just come due,
-- a gate or seal is in progress, or a close FAILED with
-- weekly_scope_time_budget_exhausted in the last 3 hours. Any other failure
-- waits for the next :40 tick. On 2026-10-17 the 2026-10-05 Midway close paid
-- rounds 1 and 2, then:
--   17:16:58 UTC round 3 deadlocked (40P01, fixed by 20261017161610), so the
--     week was not attempted again until 17:40;
--   17:40 the attempt re-proved the 82 s union P&L evidence report (its kept
--     READY receipt, 20261017131056, lasts 30 minutes and was from 17:08) and
--     hit the 240 s statement timeout before round 3. That rolls the run row
--     back, so the row still read 'deadlock detected' and the next attempt was
--     18:40, where the report has expired again.
-- An hourly attempt can never reuse a 30 minute receipt, so the close cannot
-- reach round 3. A rolled-back diagnostic at 18:02 measured the pre-cascade
-- work: evidence report 82 s, week clubs 8 s + 35 s, cash refusals 21 s,
-- recompute checks 28 s, cash commission check 11 s; it stopped at the 3
-- minute scope deadline at 196 s, before the cascade.
--
-- WHAT CHANGES. Only job 272's admission predicate: a close that FAILED in the
-- last 3 hours is also re-run every tick when its failure was transient (a
-- deadlock 40P01, a serialization failure 40001 or a lock wait 55P03), or when
-- its scope's last scheduler visit hit the statement timeout in the last 3
-- hours (a timed-out visit cannot write the run row; the scheduler records it
-- in weekly_accounting_scheduler_visits). The time-budget case is unchanged.
-- Nothing else in the command changes: the 240 s statement bound, the 3
-- minute scope budget, one attempt per tick, the chunked mode, and every
-- other admission condition. No function, rate, payee, amount, routing,
-- receipt, idempotency key, refusal or proof lifetime changes.
--
-- @live-proof: (SELECT md5(command)='e5c941909e8efd80b930ffd616f0f69e' AND schedule='*/5 * * * *' AND active FROM cron.job WHERE jobname='union-weekly-rakeback-close')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
 before_job cron.job%ROWTYPE; after_job jsonb; command_after text;
 v_anchor constant text:=$a$EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.status='failed' AND q.result->>'error'='weekly_scope_time_budget_exhausted' AND q.finished_at>now()-interval '3 hours')$a$;
 v_new constant text:=$r$EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.status='failed' AND q.finished_at>now()-interval '3 hours' AND (q.result->>'error'='weekly_scope_time_budget_exhausted' OR q.result->>'sqlstate' IN ('40P01','40001','55P03') OR EXISTS(SELECT 1 FROM public.weekly_accounting_scheduler_visits v WHERE v.scope_kind=q.scope_kind AND v.scope_id=q.scope_id AND v.last_outcome='statement_timeout' AND v.last_visit_at>now()-interval '3 hours')))$r$;
BEGIN
 SELECT * INTO STRICT before_job FROM cron.job WHERE jobname='union-weekly-rakeback-close';
 IF before_job.jobid<>272 OR before_job.schedule<>'*/5 * * * *' OR NOT before_job.active
   OR md5(before_job.command)<>'b8be947fc591eeac63d2c194932fac66' THEN
   RAISE EXCEPTION 'weekly close cron preimage %',md5(before_job.command) USING ERRCODE='55000';
 END IF;
 IF (length(before_job.command)-length(replace(before_job.command,v_anchor,'')))/length(v_anchor)<>1 THEN
   RAISE EXCEPTION 'weekly close cron anchor not found exactly once' USING ERRCODE='55000';
 END IF;
 command_after:=replace(before_job.command,v_anchor,v_new);
 IF md5(command_after)<>'e5c941909e8efd80b930ffd616f0f69e' THEN
   RAISE EXCEPTION 'weekly close cron postimage %',md5(command_after) USING ERRCODE='55000';
 END IF;
 PERFORM cron.alter_job(before_job.jobid,command:=command_after);
 SELECT to_jsonb(j) INTO after_job FROM cron.job j WHERE j.jobid=before_job.jobid;
 IF after_job IS DISTINCT FROM jsonb_set(to_jsonb(before_job),'{command}',to_jsonb(command_after)) THEN
   RAISE EXCEPTION 'weekly close cron changed beyond its command' USING ERRCODE='55000';
 END IF;
END
$mig$;

COMMIT;

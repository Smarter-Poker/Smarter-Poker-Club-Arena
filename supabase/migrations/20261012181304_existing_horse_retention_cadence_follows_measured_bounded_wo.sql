-- Existing product retention ran once per ten minutes, while its bounded
-- twenty-second owner retired about1,000 requests and ingress added about7,468
-- over one observed ten-minute interval. Alter only that existing job's cadence;
-- capacity still needs actual readback. Do not enable a safety-held job here.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
DO $cadence$
DECLARE original cron.job%ROWTYPE; actual cron.job%ROWTYPE;
BEGIN
 SELECT * INTO original FROM cron.job WHERE jobid=117;
 IF NOT FOUND OR original.jobname IS DISTINCT FROM 'sp_prune_hand_history_10m'
 OR original.schedule IS DISTINCT FROM '3,13,23,33,43,53 * * * *'
 OR md5(original.command) IS DISTINCT FROM '96244362bf46b39e75ef1100b1372203'
 OR original.username IS DISTINCT FROM 'postgres' OR original.database IS DISTINCT FROM 'postgres'
 OR original.nodename IS DISTINCT FROM 'localhost' OR original.nodeport IS DISTINCT FROM 5432
 OR original.active IS NULL THEN
  RAISE EXCEPTION 'HORSE_RETENTION_JOB_SOURCE_CHANGED_OR_ALREADY_INSTALLED' USING ERRCODE='55000'; END IF;
 -- The original command holds its original advisory owner and thirty-second
 -- timeout. Preserve the smaller original loop budget rather than extending it.
 IF position('v_budget constant interval := interval ''20 seconds'';' IN pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))=0
 OR position('LIMIT LEAST(GREATEST(p_batch,1),250)' IN pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'HORSE_RETENTION_ORIGINAL_BUDGET_CHANGED' USING ERRCODE='55000'; END IF;
 -- The provider's supported C API owns the UPDATE row lock. PostgreSQL's
 -- caller can read jobs and invoke that API without direct table UPDATE.
 -- The exact full postimage below rejects concurrent foreign-field drift.
 PERFORM cron.alter_job(original.jobid,schedule:='* * * * *');
 SELECT * INTO actual FROM cron.job WHERE jobid=original.jobid;
 IF actual.schedule IS DISTINCT FROM '* * * * *'
 OR (to_jsonb(actual)-'schedule') IS DISTINCT FROM (to_jsonb(original)-'schedule') THEN
  RAISE EXCEPTION 'HORSE_RETENTION_JOB_POSTIMAGE_CHANGED' USING ERRCODE='55000'; END IF;
END $cadence$;
COMMIT;

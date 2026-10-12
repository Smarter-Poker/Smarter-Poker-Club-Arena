-- @live-proof: (SELECT count(*)=1 AND bool_and(schedule='30 seconds' AND active AND md5(command)='96244362bf46b39e75ef1100b1372203' AND jobname='sp_prune_hand_history_10m' AND username='postgres' AND database='postgres' AND nodename='localhost' AND nodeport=5432) FROM cron.job WHERE jobid=117)
-- Existing minute passes compacted22,000 requests while33,733 arrived over
-- 44m38s on October12. All18 sampled executions succeeded in22.86–27.50s.
-- Keep the original command,20s soft budget,250hand rounds and30s timeout.
-- Change only its supported interval. Two nominal opportunities per minute
-- are not measured production throughput; live verification is still required.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
DO $cadence$
DECLARE original cron.job%ROWTYPE; actual cron.job%ROWTYPE;
BEGIN
 SELECT * INTO original FROM cron.job WHERE jobid=117;
 IF NOT FOUND OR original.jobname IS DISTINCT FROM 'sp_prune_hand_history_10m'
 OR original.schedule IS DISTINCT FROM '* * * * *'
 OR md5(original.command) IS DISTINCT FROM '96244362bf46b39e75ef1100b1372203'
 OR original.username IS DISTINCT FROM 'postgres' OR original.database IS DISTINCT FROM 'postgres'
 OR original.nodename IS DISTINCT FROM 'localhost' OR original.nodeport IS DISTINCT FROM 5432
 OR original.active IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron' AND extversion LIKE '1.6%') THEN
  RAISE EXCEPTION 'HORSE_RETENTION_SUBMINUTE_SOURCE_CHANGED_OR_ALREADY_INSTALLED' USING ERRCODE='55000'; END IF;
 IF md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)) IS DISTINCT FROM '379f83a598ff822ce30f25647bcf9bd1'
 OR position('v_budget constant interval := interval ''20 seconds'';' IN pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))=0
 OR position('LIMIT LEAST(GREATEST(p_batch,1),250)' IN pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'HORSE_RETENTION_SUBMINUTE_ORIGINAL_BUDGET_CHANGED' USING ERRCODE='55000'; END IF;
 -- pg_cron serializes instances of one job; overlong invocations queue rather
 -- than overlap. The unchanged command also refuses a competing owner using
 -- its original advisory lock. Do not extend either timeout here.
 -- Supported C API owns the row lock; caller has SELECT/API, not tableUPDATE.
 PERFORM cron.alter_job(original.jobid,schedule:='30 seconds');
 SELECT * INTO actual FROM cron.job WHERE jobid=original.jobid;
 IF actual.schedule IS DISTINCT FROM '30 seconds'
 OR (to_jsonb(actual)-'schedule') IS DISTINCT FROM (to_jsonb(original)-'schedule') THEN
  RAISE EXCEPTION 'HORSE_RETENTION_SUBMINUTE_POSTIMAGE_CHANGED' USING ERRCODE='55000'; END IF;
END $cadence$;
COMMIT;

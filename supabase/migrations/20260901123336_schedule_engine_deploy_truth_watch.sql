-- The watchdog only counts if something runs it. Ten minutes is well inside
-- the eight-hour staleness threshold it enforces, and the advisory lock
-- matches every other alarm here so a slow run never doubles up.
SELECT cron.schedule(
  'ca-engine-deploy-truth-10m',
  '*/10 * * * *',
  $job$
  SELECT CASE
           WHEN pg_try_advisory_lock(hashtext('ca-engine-deploy-truth'))
           THEN (SELECT 1 FROM public.fn_ca_engine_deploy_truth_watch())
           ELSE 0
         END;
  $job$
);

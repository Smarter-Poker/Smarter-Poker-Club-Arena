-- The schedule IS the requested product: one end-of-day owner settlement.
-- It never publishes, repairs game results or retries failed financial operations.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN
 IF COALESCE(current_setting('cron.timezone',true),'') NOT IN('GMT','UTC','Etc/UTC') THEN
  RAISE EXCEPTION 'Daily Diamond Settlement Requires The Verified UTC Cron Clock';
 END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='diamond-spin-daily-settlement') THEN
  RAISE EXCEPTION 'Daily Diamond Settlement Already Has A Scheduler';
 END IF;
END $guard$;
-- pg_cron uses UTC here. Both DST possibilities are explicit; only the actual
-- Chicago midnight fires. 00:05 is after the ordinary hourly maintenance thaw.
SELECT cron.schedule('diamond-spin-daily-settlement','5 5,6 * * *',
 $job$SELECT public.fn_diamond_spin_settle_daily()
 WHERE to_char(clock_timestamp() AT TIME ZONE 'America/Chicago','HH24:MI')='00:05';$job$);
COMMIT;

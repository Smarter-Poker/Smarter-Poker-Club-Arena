-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424014508 "20260421181000_hg_rate_limit_cleanup_cron"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 273351fa093c653f37d860a2877ef7b9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Bug hunt fix: commander_rate_limits rows for (user, endpoint) pairs
-- persist forever after the window closes. Without cleanup, this table
-- grows linearly with unique (user, endpoint) pairs over time.
--
-- Rows older than 7 days with no recent activity are stale and can
-- be pruned — in-window counters are not affected (window is max
-- hours in practice, not days). Scheduled daily at 03:17 UTC to
-- avoid peak + avoid clashing with other home-* crons.

CREATE OR REPLACE FUNCTION public.fn_prune_stale_rate_limits()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE v_deleted int;
BEGIN
  DELETE FROM public.commander_rate_limits
   WHERE last_request_at < NOW() - INTERVAL '7 days'
     AND (is_blocked = false OR blocked_until < NOW());
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$fn$;

-- Schedule daily
DO $do$
BEGIN
  PERFORM cron.unschedule('rate-limit-prune') WHERE EXISTS
    (SELECT 1 FROM cron.job WHERE jobname='rate-limit-prune');
EXCEPTION WHEN OTHERS THEN NULL;
END $do$;

SELECT cron.schedule(
  'rate-limit-prune',
  '17 3 * * *',   -- daily at 03:17 UTC
  $$ SELECT public.fn_prune_stale_rate_limits(); $$
);

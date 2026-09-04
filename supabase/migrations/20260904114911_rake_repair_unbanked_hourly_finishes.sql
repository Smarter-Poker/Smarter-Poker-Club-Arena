-- rake-repair-unbanked-hourly has timed out on every run since at least
-- 05:52 UTC today: its candidate query walks every cash hand of the last 48
-- hours (228,174 rows, 151 seconds measured with EXPLAIN ANALYZE) and probes
-- rake_records for each, to find - each time - nothing to repair. The
-- function's own SET statement_timeout '540s' cannot rescue a statement
-- already running under the session's shorter timeout (lesson 3,
-- 2026-09-03). Two changes, both to the schedule and neither to the money
-- path: the timeout is a leading statement of its own, and the window is
-- six hours - an hourly job gives each hand six attempts, and the queue path
-- (ca-redrive-unbanked-rake-15m) already covers everything that was queued.
-- The command below is the existing one, wrapped, not rewritten.
DO $$
DECLARE v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'rake-repair-unbanked-hourly';
  IF v_cmd IS NULL THEN RAISE EXCEPTION 'rake-repair-unbanked-hourly is not scheduled'; END IF;
  IF position('fn_rake_repair_unbanked(48, 200)' IN v_cmd) = 0 THEN
    RAISE EXCEPTION 'rake-repair-unbanked-hourly command is not the one this migration expected: %', v_cmd;
  END IF;
  v_cmd := replace(v_cmd, 'fn_rake_repair_unbanked(48, 200)', 'fn_rake_repair_unbanked(6, 200)');
  v_cmd := 'SET statement_timeout = ''300s'';' || v_cmd;
  PERFORM cron.unschedule('rake-repair-unbanked-hourly');
  PERFORM cron.schedule('rake-repair-unbanked-hourly', '52 * * * *', v_cmd);
  IF to_regprocedure('public.fn_rake_repair_unbanked(integer, integer)') IS NULL THEN
    RAISE EXCEPTION 'fn_rake_repair_unbanked(integer, integer) does not resolve';
  END IF;
END $$;

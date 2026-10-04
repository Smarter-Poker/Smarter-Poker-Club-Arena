-- 20261004003115_the_seven_day_equity_coverage_is_measured_once_an_hour.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE SEVEN-DAY EQUITY COVERAGE IS MEASURED ONCE AN HOUR (phase 7 of 9:
-- availability). Full account:
-- docs/changelog/2026-10-04-the-seven-day-equity-coverage-is-measured-once-an-hour.md.
--
-- Job 263 (ca-stats-witness-audit-15m, :09/:24/:39/:54) runs
-- ca_stats_witness_audit(10, 90): 96 runs a day, 106 s on average (max 660 s),
-- about 10,000 s of database time a day (cron.job_run_details, 24 h to 00:30
-- UTC 2026-10-04). Section 2f, the seven-day all-in equity coverage (927,565
-- owed seats), measured 78.4 s on its own, 75-80% of every run, and its two
-- counts move by a few seats an hour (929,615 / 1,433 at 00:24 against
-- 927,929 / 1,436 at 23:39).
--
-- 2f is now measured on the run in the first quarter of the hour (the :09 run)
-- or whenever no earlier reading exists; the other three runs carry the last
-- measured pair forward unchanged, so every row still carries a reading and
-- ca_stats_health, which reads the latest row, shows a figure at most an hour
-- old. Whenever 2f runs it runs exactly as before. The 10-minute sections
-- (2a-2e) are untouched. No job or schedule changes.
--
-- Applied as a substitution of two fragments on the md5-pinned live text;
-- the post-image md5 was computed read-only on production beforehand.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.ca_stats_witness_audit(integer,integer)'::regprocedure)) = '962ed3ca1dd6346e25d7a1c6edd7246e')

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  v_sig regprocedure := 'public.ca_stats_witness_audit(integer,integer)'::regprocedure;
  v_def text; v_after text; v_acl text;
  v_old1 text; v_new1 text; v_old2 text; v_new2 text;
BEGIN
  v_def := pg_get_functiondef(v_sig);
  IF md5(v_def) <> '0260f227fb49030f22a7e2019a755796' THEN
    RAISE EXCEPTION 'ca_stats_witness_audit is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'  SELECT count(*) FILTER (WHERE x.has_eq OR NOT coalesce(x.betting_continued, true))::int,\n';
  v_new1 := E'  /* 2f IS MEASURED ONCE AN HOUR (2026-10-04). The seven-day all-in equity\n'
        || E'     coverage read is 75-80% of every run (78.4 s of a ~100 s run, over\n'
        || E'     927,565 owed seats) and moves by a few seats an hour, yet it ran every\n'
        || E'     15 minutes: about 7,500 s of database time a day. It is now measured on\n'
        || E'     the run in the first quarter of the hour (the :09 run of job 263) or\n'
        || E'     whenever no earlier reading exists; the other runs carry the last\n'
        || E'     measured pair forward unchanged. ca_stats_health reads the latest row,\n'
        || E'     so the figure it shows is at most an hour old. */\n'
        || E'  SELECT l.allin_showdown_7d, l.allin_showdown_without_equity_7d\n'
        || E'    INTO v_allin_sd, v_allin_sd_no_eq\n'
        || E'    FROM public.ca_stats_witness_audit_log l\n'
        || E'   ORDER BY l.ran_at DESC, l.id DESC\n'
        || E'   LIMIT 1;\n'
        || E'  IF NOT FOUND OR v_allin_sd IS NULL OR v_allin_sd_no_eq IS NULL\n'
        || E'     OR extract(minute FROM now()) < 15 THEN\n'
        || E'  SELECT count(*) FILTER (WHERE x.has_eq OR NOT coalesce(x.betting_continued, true))::int,\n';
  v_old2 := E'    OFFSET 0\n'
        || E'  ) x;\n';
  v_new2 := E'    OFFSET 0\n'
        || E'  ) x;\n'
        || E'  END IF;\n';
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1
     OR (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
    RAISE EXCEPTION 'ca_stats_witness_audit: a replaced fragment does not occur exactly once';
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_sig;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  v_after := pg_get_functiondef(v_sig);
  IF md5(v_after) <> '962ed3ca1dd6346e25d7a1c6edd7246e'
     OR md5(replace(replace(v_after, v_new2, v_old2), v_new1, v_old1)) <> '0260f227fb49030f22a7e2019a755796' THEN
    RAISE EXCEPTION 'ca_stats_witness_audit is not its pinned post-image (md5 %)', md5(v_after);
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'ca_stats_witness_audit: its privileges changed';
  END IF;
END $subs$;

COMMIT;

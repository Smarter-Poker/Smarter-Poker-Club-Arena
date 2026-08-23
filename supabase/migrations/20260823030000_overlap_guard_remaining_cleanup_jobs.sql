-- 20260823030000_overlap_guard_remaining_cleanup_jobs.sql
--
-- The new fn_db_saturation_selftest (20260823020000) was run immediately after
-- being installed and reported five more cleanup jobs carrying the same defect
-- that took the platform down on 2026-08-22: no overlap guard.
--
--   jobid   9  cleanup-hole-cards       0 */6 * * *
--   jobid  13  home-group-stale-sweep   0 2 * * *
--   jobid  25  home-view-log-prune      0 3 * * *
--   jobid  27  rate-limit-prune         17 3 * * *
--   jobid 123  union-integrity-sweep    35 * * * *
--
-- pg_cron will start a second copy of a job whose previous run is still going.
-- That is precisely how sp_prune_hand_history and sp_prune_hand_state_snapshots
-- came to pin the instance. union-integrity-sweep is hourly and was already
-- failing 5 runs out of 6 during the incident, so it is not hypothetical.
--
-- These are fixed here rather than left as known-but-accepted findings. A guard
-- that always reports breaches is a guard people learn to ignore, and "the fix
-- was correct but incomplete, and nothing was watching" is exactly how the
-- 2026-08-22 outage recurred three hours after its first fix. The self-test must
-- read zero breaches so that a NEW breach means something.
--
-- Each job keeps its existing behaviour and schedule. The only additions are the
-- house advisory-lock guard (job 76 pattern) and a statement_timeout backstop so
-- no single run can monopolise I/O. Locks are session-scoped and released when
-- the run ends, including on error, so they cannot wedge a schedule.

DO $mig$
DECLARE
  r          record;
  v_new      text;
  v_expected int := 5;
  v_done     int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('cleanup-hole-cards',     'PERFORM public.cleanup_old_hole_cards();'),
      ('home-group-stale-sweep', 'PERFORM public.fn_home_group_stale_sweep(35, 45);'),
      ('home-view-log-prune',
         'DELETE FROM public.commander_home_group_view_log  WHERE inserted_at < now() - interval ''7 days'';'
      || 'DELETE FROM public.commander_home_group_share_log WHERE inserted_at < now() - interval ''7 days'';'),
      ('rate-limit-prune',       'PERFORM public.fn_prune_stale_rate_limits();'),
      ('union-integrity-sweep',  'PERFORM public.fn_union_integrity_sweep_all();')
    ) AS t(jobname, body)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = r.jobname) THEN
      RAISE EXCEPTION 'cron job % not found - refusing to continue', r.jobname;
    END IF;

    v_new :=
      'DO $job$ BEGIN'
      || ' IF pg_try_advisory_lock(hashtext(' || quote_literal(r.jobname) || ')) THEN'
      || '   PERFORM set_config(''statement_timeout'', ''120s'', true);'
      || '   ' || r.body
      || ' ELSE'
      || '   RAISE NOTICE ''skipped: previous run still in progress'';'
      || ' END IF;'
      || ' END $job$;';

    PERFORM cron.alter_job(
      (SELECT jobid FROM cron.job WHERE jobname = r.jobname),
      command := v_new
    );
    v_done := v_done + 1;
  END LOOP;

  IF v_done <> v_expected THEN
    RAISE EXCEPTION 'expected to guard % jobs, guarded %', v_expected, v_done;
  END IF;
END $mig$;

-- Post-apply assertion: the self-test must now report ZERO unguarded cleanup
-- jobs. This is the check that keeps the guard's signal meaningful.
DO $assert$
DECLARE
  v_unguarded int;
BEGIN
  SELECT count(*) INTO v_unguarded
    FROM cron.job
   WHERE active
     AND (jobname ILIKE '%prune%' OR command ILIKE '%sp_prune_%'
          OR jobname ILIKE '%cleanup%' OR jobname ILIKE '%sweep%')
     AND command NOT ILIKE '%pg_try_advisory_lock%';

  IF v_unguarded > 0 THEN
    RAISE EXCEPTION '% cleanup job(s) still have no overlap guard', v_unguarded;
  END IF;
END $assert$;

-- ROLLBACK (restores unguarded commands - do not use)
--   select cron.alter_job((select jobid from cron.job where jobname='cleanup-hole-cards'),
--          command := 'SELECT cleanup_old_hole_cards()');
--   select cron.alter_job((select jobid from cron.job where jobname='home-group-stale-sweep'),
--          command := 'SELECT public.fn_home_group_stale_sweep(35, 45);');
--   select cron.alter_job((select jobid from cron.job where jobname='home-view-log-prune'),
--          command := 'DELETE FROM public.commander_home_group_view_log WHERE inserted_at < NOW() - INTERVAL ''7 days'';
--      DELETE FROM public.commander_home_group_share_log WHERE inserted_at < NOW() - INTERVAL ''7 days'';');
--   select cron.alter_job((select jobid from cron.job where jobname='rate-limit-prune'),
--          command := ' SELECT public.fn_prune_stale_rate_limits(); ');
--   select cron.alter_job((select jobid from cron.job where jobname='union-integrity-sweep'),
--          command := 'SELECT public.fn_union_integrity_sweep_all();');

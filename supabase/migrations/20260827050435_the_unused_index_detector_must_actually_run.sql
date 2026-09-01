-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827050435; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE UNUSED-INDEX DETECTOR MUST ACTUALLY RUN
-- ═══════════════════════════════════════════════════════════════════════════
-- `20260826_index_usage_snapshots_so_unused_can_be_proven.sql` built exactly
-- the right thing: a snapshot table that records idx_scan alongside
-- postmaster_start, so a counter reset by a restart cannot be mistaken for an
-- index nobody uses. `fn_snapshot_index_usage()` captures it and
-- `fn_truly_unused_indexes()` reads it.
--
-- It was never scheduled. One snapshot exists, taken 2026-08-26 20:29:59, and
-- that is the entire historical record.
--
-- The consequence, found tonight: hand_history carries 8 indexes weighing
-- 1,189 MB against a 2,356 MB table, and every one of them is maintained on
-- 460,000 inserts a day. Two show zero scans -- but over a 2.4-hour window and
-- a single snapshot, which proves nothing. `idx_hand_history_tournament_created`
-- (105 MB) is plausibly dead; a tournament report that runs nightly would look
-- exactly the same from here. So it stays, and the evidence starts
-- accumulating instead.
--
-- (`uq_hand_history_global_hand_number` also shows zero scans and must NEVER be
-- dropped on that basis: it is UNIQUE, so it is a CONSTRAINT being enforced on
-- every insert, not an access path anyone queries.)
--
-- Daily at 04:41 UTC -- a minute nothing else uses, per the stagger rule in
-- `20260823050000_stagger_maintenance_jobs_off_the_same_minute.sql`. This is
-- database maintenance, which is what the other 41 pg_cron jobs here are; it
-- is not application logic, so CLAUDE.md section 11 routing to Open Claw does
-- not apply.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_existing int;
BEGIN
  SELECT count(*) INTO v_existing FROM cron.job WHERE jobname = 'index-usage-snapshot-daily';
  IF v_existing > 0 THEN
    PERFORM cron.unschedule('index-usage-snapshot-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'index-usage-snapshot-daily',
  '41 4 * * *',
  $$SELECT public.fn_snapshot_index_usage();$$
);

-- Take one now, so the record has two points rather than one and the clock
-- starts tonight rather than tomorrow.
SELECT public.fn_snapshot_index_usage();

DO $$
DECLARE v_job int; v_snaps int;
BEGIN
  SELECT count(*) INTO v_job FROM cron.job WHERE jobname = 'index-usage-snapshot-daily';
  IF v_job <> 1 THEN RAISE EXCEPTION 'snapshot job not scheduled (found %)', v_job; END IF;

  SELECT count(DISTINCT taken_at) INTO v_snaps FROM public.index_usage_snapshots;
  IF v_snaps < 2 THEN RAISE EXCEPTION 'expected at least 2 snapshots, found %', v_snaps; END IF;

  RAISE NOTICE 'index usage snapshot scheduled; % snapshots on record', v_snaps;
END $$;

-- three_watchers_whose_defects_were_fixed_stop_running
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- "No watcher shall stand in place of a fix." These three ran 1,152 times a
-- day between them and repaired nothing, because the defects they were built
-- for were each fixed at the root and nobody went back for the watcher.
--
-- A job that repairs nothing is not free. It is read as coverage. Every one
-- of these made a real defect look watched.
--
-- ===========================================================================
-- 1. union-seat-provenance-heal (jobid 122, every 5 minutes)
--
-- fn_heal_seat_provenance() back-filled table_seats.club_id and
-- tournament_players.club_id where they were NULL.
--
-- The writer is trg_table_seats_stamp_club, and on 2026-08-21 it was found to
-- carry the exact defect this job was covering. Its own migration says it:
-- the guard existed in two places and only one had been found, and the
-- TRIGGER carried `WHEN ((new.club_id IS NULL))`, so a caller supplying a
-- club_id never reached the function at all. That WHEN clause was removed.
-- Verified again today, reading the live catalog rather than the migration:
--
--   BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW
--     EXECUTE FUNCTION fn_stamp_seat_club()
--
-- No WHEN. No UPDATE OF list. Every insert and every update goes through it,
-- and it calls the same resolver the healer called.
--
-- Measured: 641,564 seats and 617,271 entries in 30 days. Thousands of NULLs
-- a day through 2026-08-20, none from 08-21, a burst of 670 + 1,006 on 09-01,
-- then 4, then 1, then seventeen days of zero. Healable backlog now 0 and 0.
--
-- One residual, recorded rather than papered over: fn_seat_club_for_user
-- returns NULL when the seated player holds no qualifying club_members row,
-- and nothing re-resolves provenance if that membership arrives afterwards.
-- Zero occurrences in seventeen days. If it ever recurs the fix is an AFTER
-- trigger on club_members, not this job back.
--
-- ===========================================================================
-- 2. ca-bbj-repair-unbanked-15m (jobid 167, every 15 minutes)
--
-- fn_bbj_repair_unbanked(3, 200) banked BBJ contributions that rake_records
-- recorded and bbj_contributions never received.
--
-- The function now disqualifies itself. Its own guard reads:
--
--   AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits c
--                    WHERE c.hand_id = rr.hand_id
--                      AND c.post_commit_payload IS NOT NULL)
--
-- with the note that accepted hands have one immutable obligation processor
-- and the legacy repair must not create a second receipt shape. Measured:
-- 208,249 of 208,249 BBJ-contributing rake_records in the last 7 days carry
-- such a commit row. Every one. Its candidate set is empty by construction,
-- not by luck, and ca-post-commit-orphan-drain-10m already owns the retry.
--
-- THE FUNCTION IS NOT DROPPED. fn_ca_auto_reconcile_tick(), job 164, still
-- calls fn_bbj_repair_unbanked(24, 200), but only when a ca_drift_incidents
-- row classified incorrect_rake or bbj_error is open. That caller is
-- incident-gated and stays. What goes is the unconditional sweep.
--
-- ===========================================================================
-- 3. reconcile-club-table-counts-nightly (jobid 124, 03:40 daily)
--
-- fn_reconcile_club_table_counts() reset clubs.table_count from
-- fn_live_table_count(club_id).
--
-- fn_live_table_count reads exactly five columns of tables: tournament_id,
-- is_deleted, status, club_id, union_id. trg_tables_sync_club_counts_upd
-- fires UPDATE OF those same five with a WHEN on the same five, and the ins
-- and del triggers carry no WHEN at all. The other input, the club-to-union
-- map, has trg_union_clubs_sync_table_counts with no column list and no WHEN,
-- recomputing both sides. Both sync functions recompute from
-- fn_live_table_count rather than incrementing, so they are idempotent and
-- self-correcting. Current drift: 0 clubs.
--
-- THE TWO DRIFT FUNCTIONS GO IN THE SAME CHANGE. increment_club_table_count
-- and decrement_club_table_count write clubs.table_count by blind +1 and
-- GREATEST(0, x-1) instead of recomputing, and no trigger on clubs guards
-- that column. They are the one surviving way the count can drift, and
-- deleting the reconciler while leaving them is how the defect outlives its
-- net. Nothing in the repository calls them: the only references are the CI
-- schema manifest, a historical fixture and their creating migration.
--
-- ===========================================================================
-- WHAT IS DELIBERATELY NOT TOUCHED
--
-- ca-redrive-unbanked-rake-15m stays. pending_fee_distributions is not drift,
-- it is an outbox the engine writes on purpose when it cannot bank a fee, and
-- draining it is the second half of a two-phase money write. There is no
-- defect under it to fix. A backlog of zero is what a healthy queue drainer
-- looks like, and deleting it strands real chips in precisely the failure it
-- exists for.
--
-- spin_repair_missing_multiplier stays, for reasons recorded earlier: its
-- named superseder is UPDATE-scoped, has no INSERT path, and refuses rather
-- than stamps, and 115 zero-multiplier spins sit in REGISTERING today.
--
-- RESTORED TO THE REPOSITORY 2026-09-24. This file was reconstructed byte for
-- byte from supabase_migrations.schema_migrations.statements, which is what
-- production actually ran on 2026-09-20. The proof directive below is the one
-- addition: what was applied carried none, because this migration creates no
-- persistent object (it retires three schedules and drops two functions), so
-- tests/a-merged-migration-must-be-live.law.test.ts has nothing to look up.
-- The line is a comment and changes no SQL. It was checked against production
-- before it was written here, and it reads true.
--
-- @live-proof: (SELECT count(*) FROM cron.job WHERE jobname IN ('union-seat-provenance-heal', 'ca-bbj-repair-unbanked-15m', 'reconcile-club-table-counts-nightly')) = 0 AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('increment_club_table_count', 'decrement_club_table_count')) = 0
-- ===========================================================================

DO $retire$
DECLARE
  v_jobid bigint;
  v_name  text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'union-seat-provenance-heal',
    'ca-bbj-repair-unbanked-15m',
    'reconcile-club-table-counts-nightly'
  ] LOOP
    SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = v_name;
    IF v_jobid IS NULL THEN
      RAISE NOTICE 'already retired: %', v_name;
    ELSE
      PERFORM cron.unschedule(v_name);
      RAISE NOTICE 'retired % (jobid %)', v_name, v_jobid;
    END IF;
  END LOOP;
END;
$retire$;

DROP FUNCTION IF EXISTS public.increment_club_table_count(uuid);
DROP FUNCTION IF EXISTS public.decrement_club_table_count(uuid);

DO $verify$
DECLARE
  v_left  int;
  v_names text;
BEGIN
  SELECT count(*), coalesce(string_agg(jobname, ', '), '')
    INTO v_left, v_names
    FROM cron.job
   WHERE jobname IN ('union-seat-provenance-heal',
                     'ca-bbj-repair-unbanked-15m',
                     'reconcile-club-table-counts-nightly');
  IF v_left > 0 THEN
    RAISE EXCEPTION 'still scheduled: %', v_names;
  END IF;

  -- The drift writers must be gone, or the reconciler was removed from a
  -- defect that can still recur.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('increment_club_table_count', 'decrement_club_table_count')
  ) THEN
    RAISE EXCEPTION 'a blind club table_count writer survives the reconciler';
  END IF;

  -- The writers that made each deletion safe must still be in place. If any
  -- of these is missing, this migration removed a net from an open defect.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.table_seats'::regclass
       AND t.tgname = 'trg_table_seats_stamp_club'
       AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE ON%'
       AND pg_get_triggerdef(t.oid) NOT LIKE '%WHEN %'
  ) THEN
    RAISE EXCEPTION 'the seat club stamp is absent, disabled or narrowed again';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.tables'::regclass
       AND t.tgname = 'trg_tables_sync_club_counts_upd' AND t.tgenabled = 'O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.union_clubs'::regclass
       AND t.tgname = 'trg_union_clubs_sync_table_counts' AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'a club table_count sync trigger is absent or disabled';
  END IF;

  -- fn_bbj_repair_unbanked must survive for the incident-gated caller.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_repair_unbanked'
  ) THEN
    RAISE EXCEPTION 'fn_bbj_repair_unbanked was dropped; job 164 now calls nothing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-auto-reconcile-tick' AND active) THEN
    RAISE EXCEPTION 'the incident-gated caller is gone, so the BBJ repair has no owner';
  END IF;

  -- And the queue drainer that is NOT a watcher must be untouched.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-redrive-unbanked-rake-15m' AND active) THEN
    RAISE EXCEPTION 'the unbanked rake outbox drain was removed; that is a real queue';
  END IF;

  RAISE NOTICE 'PASS: three watchers retired, every writer that replaced them verified in place';
END;
$verify$;
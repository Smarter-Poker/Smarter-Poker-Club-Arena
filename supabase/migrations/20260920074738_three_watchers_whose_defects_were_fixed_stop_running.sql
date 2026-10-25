-- 20260920074738_three_watchers_whose_defects_were_fixed_stop_running
--
-- Applied to production as version 20260920070402 (the apply transport stamps
-- its own version; match by name, never by version).
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- RECORDED AFTER THE FACT. This change was applied to production through the
-- Supabase MCP and was never written into the repository. The live state it
-- describes was read back out of the catalog: the three schedules are gone
-- from cron.job and the two counter functions are gone from pg_proc.
--
-- ===========================================================================
-- WHAT THIS RETIRES, AND WHY EACH ONE IS NOW UNNECESSARY
--
-- CLAUDE.md 10.11 and 10.12: a detector is not a fix, and a repair job is not
-- allowed to exist as a fix. The other side of that rule is the part nobody
-- gets round to: once the root defect IS fixed, the compensation has to go.
-- Left running it costs real work every minute, and worse, it keeps the estate
-- believing a guard is protecting something when the thing it guarded against
-- can no longer happen. Each of these three had its root cause closed by an
-- earlier change, and each was measured finding nothing before it was retired.
--
-- 1. union-seat-provenance-heal
--
-- It existed to back-fill the club stamp on seat rows that were written
-- without one. The writer it was compensating for is
-- trg_table_seats_stamp_club, and since 2026-08-21 that trigger has been
--
--   BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW
--
-- with NO WHEN clause and no UPDATE OF column list, so it runs on every write
-- to the table and stamps the row before it lands. The healer reads the same
-- rows, from the same columns, with the same expression. There is no state in
-- which it can compute a value the writer did not already compute: it cannot
-- be right when the trigger is wrong, because it is the trigger's own logic
-- running later against the trigger's own output.
--
-- 2. ca-bbj-repair-unbanked-15m
--
-- fn_bbj_repair_unbanked repairs bad beat jackpot rake rows that were never
-- banked, and it EXCLUDES any hand that carries a
-- hand_atomic_commits.post_commit_payload, because a hand that committed
-- atomically banked its rake in the same transaction and has nothing to
-- repair. Measured over seven days, 208,249 of 208,249 BBJ rake rows carry
-- that payload. Every row in the window the job looks at is a row it is
-- required to skip, so the schedule has been paying for a scan whose answer
-- cannot be anything but zero.
--
-- THE FUNCTION IS KEPT, ONLY THE SCHEDULE GOES. fn_ca_auto_reconcile_tick
-- still calls it behind an incident gate, which is the correct shape: the
-- repair exists for the day the atomic commit path is bypassed, and it runs
-- then, rather than every fifteen minutes against a population that is
-- already whole.
--
-- 3. reconcile-club-table-counts-nightly
--
-- This rewrote clubs.table_count every night from the truth. The truth is
-- fn_live_table_count, and it reads exactly five columns of public.tables:
-- tournament_id, is_deleted, status, club_id and union_id. Those are exactly
-- the five that trg_tables_sync_club_counts_upd names in its UPDATE OF list
-- and repeats in its WHEN clause, and the ins and del triggers cover the other
-- two ways a row can appear or leave. A change that could move the count
-- therefore cannot happen without firing the trigger that maintains it.
--
-- That left exactly one way for the number to drift, and it is the pair this
-- migration drops with the schedule: increment_club_table_count(uuid) and
-- decrement_club_table_count(uuid) adjusted clubs.table_count BY A DELTA
-- rather than deriving it. A delta applied twice, or applied while the trigger
-- also fired, is drift that no column-scoped trigger can see, because the
-- write was to clubs and not to tables. Deleting them is what makes the
-- nightly rewrite genuinely redundant rather than merely usually redundant.
--
-- ===========================================================================
-- WHAT IS DELIBERATELY NOT RETIRED
--
-- ca-redrive-unbanked-rake-15m STAYS, and it is the job most likely to be
-- mistaken for a fourth member of this set, because its name shares a word
-- with the second one above.
--
-- It is not a watcher and it is not compensating for a defect.
-- pending_fee_distributions is an OUTBOX: rows are written there on purpose,
-- by a healthy system, to be delivered later, and the job is the thing that
-- delivers them. An outbox with nothing draining it is not a tidy outbox, it
-- is a queue of undelivered money. Retiring it because it looks like the
-- others would stop real work, not redundant work.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- Three cron.job rows removed. Two functions dropped. No table is read or
-- written, and no other schedule is touched.
--
-- Every removal is guarded by an existence check, because this file has
-- already been applied to production and must also apply cleanly to a fresh
-- rebuild where two of these three schedules were never created in the first
-- place: union-seat-provenance-heal was created directly against production
-- and is scheduled by no migration in this repository.
--
-- @live-proof: (SELECT count(*) = 0 FROM cron.job WHERE jobname IN ('union-seat-provenance-heal','ca-bbj-repair-unbanked-15m','reconcile-club-table-counts-nightly'))
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $retire$
DECLARE
  v_job  text;
  v_gone int := 0;
BEGIN
  FOREACH v_job IN ARRAY ARRAY[
    'union-seat-provenance-heal',
    'ca-bbj-repair-unbanked-15m',
    'reconcile-club-table-counts-nightly'
  ] LOOP
    -- cron.unschedule raises when the job is not there, and on a fresh
    -- rebuild two of these three never existed. Ask first.
    IF EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = v_job) THEN
      PERFORM cron.unschedule(v_job);
      v_gone := v_gone + 1;
      RAISE NOTICE 'retired schedule %', v_job;
    ELSE
      RAISE NOTICE 'schedule % was already absent', v_job;
    END IF;
  END LOOP;

  RAISE NOTICE '% schedule(s) removed by this run', v_gone;
END
$retire$;

-- THE ONE REMAINING WAY THE COUNT COULD DRIFT. These adjusted
-- clubs.table_count by a delta instead of deriving it from the rows, which is
-- a write the column-scoped triggers on public.tables cannot observe.
DROP FUNCTION IF EXISTS public.increment_club_table_count(uuid);
DROP FUNCTION IF EXISTS public.decrement_club_table_count(uuid);

DO $verify$
DECLARE
  v_left       int;
  v_counters   int;
  v_triggers   int;
  v_stamp_def  text;
  v_redrive    text;
BEGIN
  ---------------------------------------------------------------------------
  -- THE THREE SCHEDULES ARE GONE.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_left
    FROM cron.job j
   WHERE j.jobname IN ('union-seat-provenance-heal',
                       'ca-bbj-repair-unbanked-15m',
                       'reconcile-club-table-counts-nightly');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'failed: % retired schedule(s) are still in cron.job', v_left;
  END IF;

  ---------------------------------------------------------------------------
  -- THE DELTA COUNTERS ARE GONE.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_counters
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('increment_club_table_count', 'decrement_club_table_count');
  IF v_counters <> 0 THEN
    RAISE EXCEPTION 'failed: % delta counter function(s) survive, so clubs.table_count can still drift', v_counters;
  END IF;

  ---------------------------------------------------------------------------
  -- WHAT MUST SURVIVE, BECAUSE IT IS WHY THE THREE COULD GO.
  --
  -- Retiring a compensation is only safe while the thing that replaced it is
  -- still standing. If a later change removes one of these, the nightly
  -- rewrite is needed again and this migration has become wrong.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_triggers
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tables'::regclass
     AND NOT t.tgisinternal
     AND t.tgname IN ('trg_tables_sync_club_counts_ins',
                      'trg_tables_sync_club_counts_upd',
                      'trg_tables_sync_club_counts_del');
  IF v_triggers <> 3 THEN
    RAISE EXCEPTION 'failed: only % of the 3 club count triggers exist; the nightly reconciler was retired on the strength of all three', v_triggers;
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_stamp_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.table_seats'::regclass
     AND t.tgname = 'trg_table_seats_stamp_club';
  IF v_stamp_def IS NULL THEN
    RAISE EXCEPTION 'failed: trg_table_seats_stamp_club is gone, so the seat provenance healer was needed after all';
  END IF;
  IF position('BEFORE INSERT OR UPDATE' in v_stamp_def) = 0 THEN
    RAISE EXCEPTION 'failed: the seat club stamp no longer runs on every write: %', v_stamp_def;
  END IF;
  IF position(' WHEN ' in v_stamp_def) > 0 THEN
    RAISE EXCEPTION 'failed: the seat club stamp gained a WHEN clause, so it can now skip rows the healer used to catch: %', v_stamp_def;
  END IF;

  -- THE REPAIR FUNCTION IS NOT THE SCHEDULE. fn_ca_auto_reconcile_tick still
  -- calls it behind an incident gate; dropping it would break that caller.
  IF to_regprocedure('public.fn_bbj_repair_unbanked(integer,integer,boolean)') IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_repair_unbanked') THEN
    RAISE EXCEPTION 'failed: fn_bbj_repair_unbanked was dropped; only its schedule should have been retired';
  END IF;

  ---------------------------------------------------------------------------
  -- THE OUTBOX DRAIN IS NOT ONE OF THESE. Reported, never asserted: on a
  -- fresh rebuild the schedule may not have been created yet.
  ---------------------------------------------------------------------------
  SELECT CASE WHEN j.active THEN 'present and active' ELSE 'present but inactive' END
    INTO v_redrive
    FROM cron.job j WHERE j.jobname = 'ca-redrive-unbanked-rake-15m';
  RAISE NOTICE 'ca-redrive-unbanked-rake-15m is %, and is deliberately not retired: pending_fee_distributions is an outbox, not drift',
               COALESCE(v_redrive, 'not scheduled in this database');

  RAISE NOTICE 'three watchers whose defects were fixed have stopped running';
END
$verify$;

COMMIT;

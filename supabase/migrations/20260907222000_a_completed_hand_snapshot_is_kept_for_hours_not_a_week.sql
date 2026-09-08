-- ============================================================================
--  PHASE 8 (relieve the database), part 1: A COMPLETED HAND SNAPSHOT IS DEAD
--  WEIGHT AFTER THE HAND, SO IT IS KEPT FOR HOURS, NOT A WEEK
--
--  Measured 2026-09-07 21:55 UTC: hand_state_snapshots is 9.2 GB for 3.7 M
--  rows - as many rows as hand_history itself - because
--  sp_prune_hand_state_snapshots keeps COMPLETED snapshots for seven days.
--  Nothing reads a completed snapshot. Every reader of this table filters
--  is_complete = false: the engine's restart recovery
--  (services/supabase/snapshots.ts getActiveHandSnapshotFull), the tournament
--  balancer's "is this table mid-hand" check (TournamentManager
--  waitForHandComplete), and the browser's own RLS-scoped read
--  (20260719_hand_state_snapshots_rls.sql). The completed row's only purpose
--  was to exist until a hand-boundary row replaced it; the hand it describes
--  is in hand_history (with its own, deliberate, 7-day horse retention).
--
--  So the table is 3.7 M rows of write amplification - every hand writes a
--  snapshot row, every row is then carried for a week through vacuum, index
--  maintenance and the 2-minute pruner's ORDER BY - on a 2-core database whose
--  saturation is the root cause behind the hourly crons timing out at 2 min
--  (payout shortfalls, conservation sweep, stats witness, rake rollup) and the
--  refresh-player-stats deadlocks (10/day). Dropping the retention of
--  completed snapshots to six hours keeps every debugging use anyone has ever
--  made of them (the last few hours of a table) and removes ~95% of the table.
--
--  INCOMPLETE snapshots are untouched: they are the in-flight hand and the
--  30-day backstop for a table whose engine never came back stays.
--
--  The pruner keeps its 2-minute cron and 30s statement budget but now works
--  in 2,000-row rounds until 20s have passed (a single 10,000-row delete
--  measured 19-30s under load, which the 30s budget would have cut off whole).
--  The backlog (~3.6 M completed rows) drains at ~32,000 rows per run (measured:
--  32,000 in 20.4s, rolled back), i.e. inside four or five hours.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.sp_prune_hand_state_snapshots(p_batch integer DEFAULT 5000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- A time budget, like sp_prune_hand_history: the cron gives this call a 30s
  -- statement_timeout, and a single 10,000-row delete measured 19-30s under
  -- load (2026-09-07). One over-budget statement rolls back WHOLE and deletes
  -- nothing, so the backlog would never drain. Rounds of 2,000 (~4-6s each)
  -- until 20s have passed keep the WHOLE call inside the cron's 30s, so it
  -- is never cut off - the rounds share one transaction; the budget is what
  -- protects it.
  v_budget   constant interval := interval '20 seconds';
  v_round    constant integer  := 2000;
  v_deadline timestamptz := clock_timestamp() + v_budget;
  v_deleted  int := 0;
  v_n        int;
begin
  loop
    with doomed as (
      select id from public.hand_state_snapshots
       where (is_complete = true  and created_at < now() - interval '6 hours')
          or (is_complete = false and created_at < now() - interval '30 days')
       order by created_at
       limit least(v_round, greatest(p_batch, 1))
    )
    delete from public.hand_state_snapshots h using doomed d where h.id = d.id;
    get diagnostics v_n = row_count;
    v_deleted := v_deleted + v_n;
    exit when v_n = 0 or clock_timestamp() >= v_deadline;
  end loop;
  return v_deleted;
end
$function$;

COMMENT ON FUNCTION public.sp_prune_hand_state_snapshots(integer) IS
  'Every 2 minutes (sp_prune_hand_state_snapshots_2m): deletes completed hand snapshots older than 6 hours and incomplete ones older than 30 days, oldest first, in rounds of up to 2,000 until a 20s budget is spent, which keeps the call inside the cron''s 30s statement_timeout. Nothing reads a completed snapshot; the hand lives in hand_history.';

REVOKE ALL ON FUNCTION public.sp_prune_hand_state_snapshots(integer) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_def text := pg_get_functiondef('public.sp_prune_hand_state_snapshots(integer)'::regprocedure);
BEGIN
  IF position($q$interval '6 hours'$q$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'completed snapshots must be pruned after 6 hours';
  END IF;
  IF position($q$is_complete = false and created_at < now() - interval '30 days'$q$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'incomplete snapshots keep their 30-day backstop';
  END IF;
END $$;

COMMIT;

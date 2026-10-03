-- ============================================================================
-- A HAND COMMIT STARTS NO PARALLEL WORKERS
-- ============================================================================
--
-- WHAT WAS WRONG, MEASURED ON PRODUCTION 2026-10-03 17:00-17:15 UTC
--
-- Every raked cash hand's post-commit transaction (fn_ca_process_hand_post_
-- commit_obligations) credits the union's ONE union_wallets row and then, at
-- COMMIT, runs the deferred club-rake-daily rollup:
--
--   smarter_private.ca_club_rake_daily_at_commit (deferred constraint trigger)
--     -> fn_ca_club_rake_daily_apply(ARRAY[rake_record_id])
--       -> fn_ca_club_rake_daily_compute(now(), now(), p_ids)   (LANGUAGE sql)
--
-- A LANGUAGE sql function is planned without its argument values, so the
-- planner costs the date-range arm of the UNION ALL as if it might run and
-- chooses  Gather (Workers Planned: 2) -> Parallel Append  for a lookup of ONE
-- rake_records row by primary key. Every raked hand therefore launched two
-- parallel workers inside its COMMIT, while still holding the union_wallets
-- row. Sampling union_wallets.xmax every 0.2 s found the row held by a
-- post-commit backend sitting in COMMIT with wait_event IPC:ExecuteGather or
-- IPC:BgworkerShutdown in roughly 30% of the held samples, and a
-- pg_stat_activity parallel-worker sample showed the workers running exactly
-- this "WITH src AS (...)" query with a COMMIT leader. The union's next hands
-- queue on that row (the union_wallets statement timeouts in
-- atomic_distribute_rake line 250).
--
-- Measured on production for one rake record, same session, six calls each:
--   max_parallel_workers_per_gather = 2 (current):  30, 20.6, 23.7, 19.7, 14.3, 17.8 ms
--   max_parallel_workers_per_gather = 0:            2.0, 1.8, 1.8, 1.7, 1.7, 1.8 ms
-- and that is before worker-slot contention (max_worker_processes = 8 is
-- shared by every backend; ~7 hand commits a second asked for two each).
--
-- THE FIX
--
-- fn_ca_club_rake_daily_apply is the per-commit path and is only ever called
-- with a short list of rake record ids (its only caller is the at-commit
-- trigger, one id per call). It now runs with
-- max_parallel_workers_per_gather = 0, which applies to the planning of the
-- compute query it calls. Nothing else changes: same body, owner, grants,
-- SECURITY DEFINER and search_path; the same rows are summed into the same
-- ca_club_rake_daily totals. fn_ca_club_rake_daily_compute itself is left as
-- is, so a date-range catch-up that does benefit from parallel workers keeps
-- them. No chip, wallet or ledger row is involved; this is a reporting rollup.
-- ============================================================================

-- @live-proof: (SELECT 'max_parallel_workers_per_gather=0' = ANY (proconfig) AND 'search_path=public' = ANY (proconfig) FROM pg_proc WHERE oid = 'public.fn_ca_club_rake_daily_apply(uuid[])'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

ALTER FUNCTION public.fn_ca_club_rake_daily_apply(uuid[]) SET max_parallel_workers_per_gather = 0;

DO $assert$
DECLARE v_cfg text[];
BEGIN
  SELECT proconfig INTO v_cfg FROM pg_proc
   WHERE oid = 'public.fn_ca_club_rake_daily_apply(uuid[])'::regprocedure;
  IF NOT ('max_parallel_workers_per_gather=0' = ANY (v_cfg))
     OR NOT ('search_path=public' = ANY (v_cfg)) THEN
    RAISE EXCEPTION 'fn_ca_club_rake_daily_apply config is not as intended: %', v_cfg;
  END IF;
END
$assert$;

COMMIT;

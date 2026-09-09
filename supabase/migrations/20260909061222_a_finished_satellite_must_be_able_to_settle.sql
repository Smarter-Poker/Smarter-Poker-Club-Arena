-- A FINISHED SATELLITE MUST BE ABLE TO SETTLE (2026-09-09)
--
-- 22 heads-up satellites have sat in COMPLETING for up to 27 hours holding
-- 1,919.00 chips of prize money. Every one has a clean finish: exactly one
-- winner at position 1, one eliminated at position 2, a frozen economics
-- snapshot, a settled rake row, and prize_pool_finalized = true.
--
-- THE DEADLOCK, read from the two functions themselves:
--   fn_settle_satellite_finish_atomic refuses with `entry_window_not_finalized`
--   because fn_materialize_satellite_entitlements_locked requires a
--   tournament_entry_close_receipts row - and 21 of the 22 have none.
--   fn_close_tournament_entry_window, the only writer of that row, refuses with
--   `tournament_not_running` once the tournament reaches COMPLETING.
-- So the receipt can never be written and the money can never leave. Nothing
-- retries, which is why they accumulated instead of resolving.
--
-- These are 2-player SNG satellites that fill and finish in minutes. The entry
-- close is driven by a deadline, a level change or a manager wake; on an event
-- this short none of those necessarily fires before the finish, so the window
-- is never formally closed even though the pool IS finalized.
--
-- THE BACKFILL IS A RECONSTRUCTION, NOT AN INVENTION. Every field is taken from
-- authoritative frozen state, and the shape is copied exactly from the one
-- satellite that does have a receipt (31de6b14, written 2026-09-09 04:10):
--   final_prize_pool          = tournaments.prize_pool, which is finalized
--   payout_structure_snapshot = [{place 1, 100%}], a one-seat satellite
--   close_mode                = 'immediate'
-- The materializer asserts final_prize_pool = tournaments.prize_pool, so a
-- wrong number aborts rather than mis-pays.
--
-- Settlement is then driven through the platform's own door with its own
-- source, `engine.satellite_finish`. Each satellite settles in its own
-- subtransaction: one failure cannot roll back another's payment. Any that
-- refuse (the four-table limit is transient - a winner already sitting in four
-- games cannot be given a fifth seat this second) are left exactly as they are,
-- now unblocked, for the next attempt.
--
-- ROLLBACK: delete the tournament_entry_close_receipts rows this created
-- (close_mode 'immediate' with reprice_completed_at = created_at, for
-- tournaments in COMPLETING). Settlements that succeeded are real payments and
-- are not reversed.

BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '240s';

DO $mig$
DECLARE
  r record; v jsonb; v_ok int := 0; v_refused int := 0; v_backfilled int := 0;
BEGIN
  -- 1. Backfill the missing entry-close receipts.
  FOR r IN
    SELECT t.id, round(t.prize_pool,2) AS pool
      FROM public.tournaments t
      JOIN public.tournament_escrow e ON e.tournament_id = t.id
     WHERE t.tournament_type = 'SATELLITE'
       AND t.status = 'COMPLETING'
       AND COALESCE(t.prize_pool_finalized,false) = true
       AND e.prize_balance > 0
       AND EXISTS (SELECT 1 FROM public.tournament_satellite_economic_snapshots s
                    WHERE s.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_entry_close_receipts x
                        WHERE x.tournament_id = t.id)
  LOOP
    INSERT INTO public.tournament_entry_close_receipts
      (tournament_id, close_mode, entry_closed_at, final_prize_pool,
       payout_structure_snapshot, reprice_completed_at)
    VALUES (r.id, 'immediate', now(), r.pool,
            jsonb_build_array(jsonb_build_object('place',1,'percentage',100)), now())
    ON CONFLICT (tournament_id) DO NOTHING;
    v_backfilled := v_backfilled + 1;
  END LOOP;

  IF v_backfilled = 0 THEN
    RAISE EXCEPTION 'no satellite needed a receipt; re-read before applying';
  END IF;

  -- 2. Drive settlement, each in its own subtransaction.
  FOR r IN
    SELECT t.id, t.name
      FROM public.tournaments t
      JOIN public.tournament_escrow e ON e.tournament_id = t.id
     WHERE t.tournament_type = 'SATELLITE'
       AND t.status = 'COMPLETING'
       AND e.prize_balance > 0
     ORDER BY e.prize_balance DESC
  LOOP
    BEGIN
      v := public.fn_settle_satellite_finish_atomic(r.id, 'engine.satellite_finish');
      IF COALESCE((v->>'settled')::boolean,false) THEN v_ok := v_ok + 1;
      ELSE v_refused := v_refused + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_refused := v_refused + 1;
    END;
  END LOOP;

  RAISE NOTICE 'receipts backfilled: %, settled: %, refused: %',
               v_backfilled, v_ok, v_refused;

  -- The receipts must exist afterwards whatever settlement did.
  IF EXISTS (
    SELECT 1 FROM public.tournaments t
      JOIN public.tournament_escrow e ON e.tournament_id = t.id
     WHERE t.tournament_type='SATELLITE' AND t.status='COMPLETING'
       AND e.prize_balance > 0
       AND COALESCE(t.prize_pool_finalized,false) = true
       AND NOT EXISTS (SELECT 1 FROM public.tournament_entry_close_receipts x
                        WHERE x.tournament_id = t.id)) THEN
    RAISE EXCEPTION 'a finalized satellite still has no entry-close receipt';
  END IF;
END $mig$;

COMMIT;

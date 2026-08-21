-- ═══════════════════════════════════════════════════════════════════════════════
-- RELEASE SEATS AT FINISHED TOURNAMENT TABLES
-- Dan 2026-08-21: "ONCE A SPIN OR SIT N GO FINISHES, YOU KICK THE CURRENT
-- PLAYERS, PAY OUT THE WINNER(S) AND MOVE THEM TO THE LOBBY."
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG
-- TournamentManagerEliminations closed a finished tournament's TABLES but never
-- released the SEATS, so every table_seats row stayed with left_at IS NULL
-- permanently. Measured before this ran: 1,476 live seats across 1,420 closed
-- tournament tables.
--
-- That column is not decorative. `table_seats WHERE left_at IS NULL` is the
-- query MultiTablePage's server-truth rebuild uses to answer "which tables am I
-- playing", so a player who finished a spin days ago still had that dead table
-- restored as a tab on every return, and the Take Seat bar counted it as a live
-- seat to send them back to.
--
-- The engine now releases seats as part of the finish path. This migration is
-- the BACKLOG cleanup for everything that finished before it shipped.
--
-- SCOPE: hard-bounded to seats whose tournament is already COMPLETED or
-- CANCELLED. A seat at a live tournament, or at any cash table, is untouched.
--
-- ROLLBACK: none possible, and none wanted. left_at is set to the tournament's
-- own end time, which is when the player really stopped playing. The prior
-- state (NULL) asserted they are STILL seated at a closed table, which was
-- never true of anyone.
--
-- TIER 2 (data repair, no schema change).

BEGIN;

DO $$
DECLARE v_before int; v_after int;
BEGIN
  SELECT count(*) INTO v_before
    FROM table_seats ts
    JOIN tables t       ON t.id = ts.table_id
    JOIN tournaments tr ON tr.id = t.tournament_id
   WHERE ts.left_at IS NULL
     AND tr.status IN ('COMPLETED','CANCELLED');

  UPDATE table_seats ts
     SET left_at = COALESCE(tr.ended_at, tr.updated_at, now())
    FROM tables t, tournaments tr
   WHERE ts.table_id = t.id
     AND t.tournament_id = tr.id
     AND ts.left_at IS NULL
     AND tr.status IN ('COMPLETED','CANCELLED');

  SELECT count(*) INTO v_after
    FROM table_seats ts
    JOIN tables t       ON t.id = ts.table_id
    JOIN tournaments tr ON tr.id = t.tournament_id
   WHERE ts.left_at IS NULL
     AND tr.status IN ('COMPLETED','CANCELLED');

  RAISE NOTICE 'released % stranded seats, % remain', v_before - v_after, v_after;

  -- Post-apply assertion: the whole point is that none are left.
  IF v_after > 0 THEN
    RAISE EXCEPTION 'seat release incomplete: % seats still open at finished tournaments', v_after;
  END IF;
END $$;

COMMIT;

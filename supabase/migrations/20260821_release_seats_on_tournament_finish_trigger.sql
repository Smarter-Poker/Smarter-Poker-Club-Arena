-- ═══════════════════════════════════════════════════════════════════════════════
-- SEATS ARE RELEASED WHEN A TOURNAMENT FINISHES - ENFORCED IN THE DATABASE
-- Dan 2026-08-21: "ONCE A SPIN OR SIT N GO FINISHES, YOU KICK THE CURRENT
-- PLAYERS ... AND MOVE THEM TO THE LOBBY."
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- The application releases seats in TWO places now: the normal finish path in
-- TournamentManagerEliminations, and GameServer's orphan-table sweep. Neither
-- is a guarantee. A tournament can reach COMPLETED or CANCELLED from a crashed
-- engine, the stuck-COMPLETING recovery, the 12-hour idle sweep, a manual admin
-- update, or any path written next year - and the orphan sweep only runs at
-- startup, so leaks accumulate between restarts. Two stranded seats reappeared
-- within hours of the first fix shipping, which is what prompted this.
--
-- `table_seats.left_at IS NULL` means "this player is still sitting here". It is
-- the query the multi-table container uses to rebuild a player's tabs, so a seat
-- left open at a finished tournament follows that player around as a dead tab.
-- That claim must stop being true the moment the tournament ends, regardless of
-- which code noticed.
--
-- A trigger is the only place that holds for EVERY writer. The application fixes
-- stay - they release immediately and emit the right events. This is the floor.
--
-- Verified live before shipping: a RUNNING spin with 3 open seats flipped to
-- COMPLETED inside a transaction showed 3 -> 0 open seats, then rolled back.
--
-- TIER 3 (adds a trigger).
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_release_seats_on_tournament_finish ON public.tournaments;
--   DROP FUNCTION IF EXISTS public.fn_release_seats_on_tournament_finish();

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_release_seats_on_tournament_finish()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Only on the TRANSITION into a finished state. Firing on every update of an
  -- already-finished row would rewrite left_at timestamps that are correct.
  IF NEW.status IN ('COMPLETED','CANCELLED')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN

    UPDATE table_seats ts
       SET left_at = COALESCE(NEW.ended_at, now())
      FROM tables t
     WHERE ts.table_id = t.id
       AND t.tournament_id = NEW.id
       AND ts.left_at IS NULL;

  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_release_seats_on_tournament_finish ON public.tournaments;

CREATE TRIGGER trg_release_seats_on_tournament_finish
  AFTER UPDATE OF status ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_release_seats_on_tournament_finish();

COMMENT ON FUNCTION public.fn_release_seats_on_tournament_finish() IS
  'Dan 2026-08-21: a finished tournament must not leave players seated. table_seats.left_at IS NULL is read as "still playing" by the multi-table tab rebuild, so a seat held at a finished event follows the player as a dead tab. Fires only on the transition into COMPLETED/CANCELLED.';

UPDATE table_seats ts
   SET left_at = COALESCE(tr.ended_at, now())
  FROM tables t, tournaments tr
 WHERE ts.table_id = t.id
   AND t.tournament_id = tr.id
   AND ts.left_at IS NULL
   AND tr.status IN ('COMPLETED','CANCELLED');

DO $$
DECLARE v_bad int; v_trg int;
BEGIN
  SELECT count(*) INTO v_trg FROM pg_trigger
   WHERE tgname = 'trg_release_seats_on_tournament_finish' AND NOT tgisinternal;
  IF v_trg <> 1 THEN
    RAISE EXCEPTION 'trigger was not created';
  END IF;

  SELECT count(*) INTO v_bad
    FROM table_seats ts
    JOIN tables t       ON t.id = ts.table_id
    JOIN tournaments tr ON tr.id = t.tournament_id
   WHERE ts.left_at IS NULL AND tr.status IN ('COMPLETED','CANCELLED');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'still % stranded seats after cleanup', v_bad;
  END IF;
END $$;

COMMIT;

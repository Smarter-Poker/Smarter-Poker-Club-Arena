-- ============================================================================
-- current_players is COUNTED, not NARRATED
--
-- Dan, 2026-08-22: "I registered, said final table, then I was booted and said
-- i finished 4th somehow" -- in a THREE-handed game.
--
-- THE SHAPE OF THE BUG
-- Every writer on the platform maintained tournaments.current_players by hand:
-- register a player, remember to add one; unregister, remember to subtract.
-- Miss one path and the number drifts, and a drifted number is worse than no
-- number, because everything downstream believes it:
--
--   * the LOBBY renders "2/3", inviting a fourth entrant into a full game --
--     which is how a three-handed Spin produced a fourth-place finish;
--   * GameServer.discoverTournaments decides a seat-first game is full with
--     `current_players >= max_players`, so an undercount means the game NEVER
--     STARTS. Live right now: two Spins with three paid entrants and three
--     bodies in three seats, counter stuck on 2, sitting in REGISTERING for
--     fourteen and ten hours respectively while the top-up loop is asked,
--     every five seconds, to find a third player for a game that has three.
--
-- Both symptoms are the same root: a cached count nobody owns.
--
-- THE FIX
-- Make the count derived. The rows in tournament_players ARE the field, so the
-- database recomputes the counter from them on every registration change --
-- there is no longer a path that can forget.
--
-- WHY ONLY BEFORE THE GAME STARTS
-- Once a tournament is RUNNING, current_players stops meaning "how many are
-- in the lobby" and starts meaning TOTAL ENTRANTS: the fee and prize math in
-- TournamentManagerEliminations reads it long after players have busted. If
-- this trigger kept recomputing, every elimination would shrink the entrant
-- total and silently corrupt the payouts. So it reconciles for ANNOUNCED and
-- REGISTERING only -- exactly the window where the lobby and the start gate
-- read it -- and never touches a game in flight.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_sync_tournament_current_players()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tid uuid;
  v_count integer;
BEGIN
  v_tid := COALESCE(NEW.tournament_id, OLD.tournament_id);
  IF v_tid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- 'registered' and 'playing' both mean IN THE FIELD. A player mid-start has
  -- already been migrated to 'playing' and is still an entrant; counting only
  -- 'registered' is the exact mistake that stranded two MTTs for nine hours
  -- on 2026-08-20 (see TournamentManagerBase.start).
  SELECT count(*) INTO v_count
  FROM public.tournament_players
  WHERE tournament_id = v_tid
    AND status IN ('registered', 'playing');

  UPDATE public.tournaments
     SET current_players = v_count
   WHERE id = v_tid
     AND status IN ('ANNOUNCED', 'REGISTERING')
     AND current_players IS DISTINCT FROM v_count;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.fn_sync_tournament_current_players() IS
  'Recomputes tournaments.current_players from tournament_players rows while the game is pre-start. Added 2026-08-23: the hand-maintained counter drifted, which both invited a fourth entrant into a three-handed Spin and left full games unable to start.';

DROP TRIGGER IF EXISTS trg_sync_tournament_current_players ON public.tournament_players;
CREATE TRIGGER trg_sync_tournament_current_players
  AFTER INSERT OR DELETE OR UPDATE OF status, tournament_id
  ON public.tournament_players
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sync_tournament_current_players();

-- ── ONE-SHOT REPAIR ────────────────────────────────────────────────────────
-- Every pre-start game whose counter already disagrees with its own field.
-- This is what unbricks the two Spins; from here the trigger keeps them true.
WITH truth AS (
  SELECT t.id,
         t.current_players AS was,
         (SELECT count(*) FROM public.tournament_players tp
           WHERE tp.tournament_id = t.id
             AND tp.status IN ('registered', 'playing'))::int AS is_really
  FROM public.tournaments t
  WHERE t.status IN ('ANNOUNCED', 'REGISTERING')
)
UPDATE public.tournaments t
   SET current_players = truth.is_really
  FROM truth
 WHERE t.id = truth.id
   AND truth.was IS DISTINCT FROM truth.is_really;

-- ── ASSERTIONS ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_drift integer;
BEGIN
  SELECT count(*) INTO v_drift
  FROM public.tournaments t
  WHERE t.status IN ('ANNOUNCED', 'REGISTERING')
    AND t.current_players IS DISTINCT FROM (
      SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id = t.id AND tp.status IN ('registered', 'playing'));
  IF v_drift > 0 THEN
    RAISE EXCEPTION 'current_players still disagrees with the field on % pre-start tournament(s)', v_drift;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_sync_tournament_current_players' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'trg_sync_tournament_current_players was not created';
  END IF;
END $$;

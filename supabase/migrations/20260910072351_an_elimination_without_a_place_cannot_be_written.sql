-- an_elimination_without_a_place_cannot_be_written
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- The second half of the_knockout_door_owns_every_bust_a_hand_took (read its
-- header first). That migration stopped the sweeps that wrote eliminated rows
-- with no finishing place and returned the 1,270 busts they had taken to the
-- engine's knockout door. This one makes the row impossible to write again:
-- a constraint trigger on tournament_players refuses status = 'eliminated'
-- with position NULL in a RUNNING, COMPLETING or COMPLETED tournament.
-- DEFERRED, so fn_normalize_tournament_final_standings' clear-then-assign
-- inside one transaction still passes and a cancel that flips the event to
-- CANCELLED in the same transaction is untouched.
--
-- It is its own migration because CREATE TRIGGER takes a table lock on
-- tournament_players for the rest of the transaction; combined with the row
-- return it deadlocked against an engine hand commit (production DDL policy
-- rule 7: DDL in its own short transaction, lock_timeout set).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- an elimination without a place cannot be written
CREATE OR REPLACE FUNCTION public.fn_tournament_elimination_has_a_place()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_status text;
BEGIN
  /* THE KNOCKOUT DOOR OWNS EVERY BUST A HAND TOOK (2026-09-10). An eliminated
     row is a finishing place: fn_complete_tournament_entry_reprice reads a row
     without one as an unfinished reprice and refuses the event for ever, and
     the engine's elimination sweep will not run until that proof passes. Only
     a cancelled event may hold eliminated rows with no place. Deferred, so the
     finish normalizer's clear-then-assign inside one transaction is untouched;
     it fires on the row as it will be committed. */
  IF NEW.status = 'eliminated' AND NEW.position IS NULL THEN
    SELECT t.status INTO v_status FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    IF v_status IN ('RUNNING', 'COMPLETING', 'COMPLETED') THEN
      RAISE EXCEPTION 'tournament % player % was recorded eliminated with no finishing place; a bust is recorded through the knockout door, which assigns the place',
        NEW.tournament_id, NEW.user_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_tournament_elimination_has_a_place() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tournament_elimination_has_a_place ON public.tournament_players;
CREATE CONSTRAINT TRIGGER tournament_elimination_has_a_place
  AFTER INSERT OR UPDATE OF status, "position" ON public.tournament_players
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_elimination_has_a_place();

COMMIT;

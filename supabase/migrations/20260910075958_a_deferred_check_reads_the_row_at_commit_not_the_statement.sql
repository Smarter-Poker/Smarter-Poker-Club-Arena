-- a_deferred_check_reads_the_row_at_commit_not_the_statement
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A DEFECT IN MY OWN GUARD, FOUND BY THE THING IT BROKE, FIXED IN 12 MINUTES.
--
-- 20260910072351 added the constraint trigger tournament_elimination_has_a_place
-- so that no path could record an eliminated roster row with no finishing place
-- in a live event. It is DEFERRABLE INITIALLY DEFERRED precisely so that a
-- settlement which writes the status first and the place second still passes.
--
-- It does not, because a deferred constraint trigger DOES NOT SEE THE ROW AS IT
-- WILL BE COMMITTED. Postgres queues the event with the tuple version produced
-- by the statement that fired it, and hands that NEW to the function at commit.
-- So a settlement that runs
--
--     UPDATE tournament_players SET status='eliminated' WHERE ...;   -- place still NULL
--     UPDATE tournament_players SET position=2       WHERE ...;   -- place assigned
--
-- queues an event whose NEW.position is NULL, and my check refused the whole
-- transaction on a row that was about to be correct.
--
-- Measured cost: five satellites could not finish between 07:24 and 07:52 -
-- 19b22b48, 0c007b41, 56deda8a, df08cfbf and 84d3755b, each down to its last
-- player (600 or 160,000 chips on the felt), each refused with
-- `Tournament.atomic_satellite_finish_refused ... was recorded eliminated with
-- no finishing place`. The same trap was waiting for
-- fn_normalize_tournament_final_standings, which clears every eliminated
-- position and reassigns inside one transaction.
--
-- THE FIX: a deferred check re-reads the row it is checking. NEW is a snapshot
-- of one statement; the question "does this row hold a place" can only be
-- answered at commit, from the row itself. The invariant is unchanged and the
-- original defect is still refused - the sweeps wrote a placeless eliminated
-- row and never assigned anything afterwards, so the re-read finds exactly what
-- NEW held.
--
-- No money moved wrongly in the window: every refusal aborted its own
-- transaction, so those five events simply retried and are settled by the
-- engine's own door once this lands.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_tournament_elimination_has_a_place()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_status text;
  v_position integer;
  v_tournament text;
BEGIN
  /* THE KNOCKOUT DOOR OWNS EVERY BUST A HAND TOOK (2026-09-10). An eliminated
     row is a finishing place: fn_complete_tournament_entry_reprice reads a row
     without one as an unfinished reprice and refuses the event for ever, and
     the engine's elimination sweep will not run until that proof passes.

     A DEFERRED CHECK READS THE ROW AT COMMIT, NOT THE STATEMENT. NEW is the
     tuple the firing statement produced, so a settlement that writes the status
     first and the place second would be refused on a row that is about to be
     correct - which is what happened to five satellites between 07:24 and
     07:52. Re-read; if the row is gone, there is nothing to judge. */
  SELECT tp.status, tp.position INTO v_status, v_position
    FROM public.tournament_players tp
   WHERE tp.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_status = 'eliminated' AND v_position IS NULL THEN
    SELECT t.status INTO v_tournament FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    IF v_tournament IN ('RUNNING', 'COMPLETING', 'COMPLETED') THEN
      RAISE EXCEPTION 'tournament % player % was recorded eliminated with no finishing place; a bust is recorded through the knockout door, which assigns the place',
        NEW.tournament_id, NEW.user_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_tournament_elimination_has_a_place() FROM PUBLIC, anon, authenticated;

DO $body$
DECLARE v_bad integer;
BEGIN
  -- the invariant the guard exists for still holds right now
  SELECT count(*) INTO v_bad
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE t.status IN ('RUNNING', 'COMPLETING', 'COMPLETED')
     AND tp.status = 'eliminated' AND tp.position IS NULL;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% eliminated row(s) with no finishing place in a live event', v_bad;
  END IF;
END
$body$;

COMMIT;

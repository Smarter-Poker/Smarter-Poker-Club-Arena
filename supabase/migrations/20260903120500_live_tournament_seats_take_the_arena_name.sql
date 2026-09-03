-- ============================================================================
-- LIVE TOURNAMENT SEATS TAKE THE ARENA NAME
--
-- Companion DML to 20260903120000_the_arena_name_is_the_alias_in_sql_too.sql.
-- Separate on purpose: that one is DDL and triggers a ~28s PostgREST schema
-- reload, and holding a write lock on a 245k-row table across that reload is
-- how you turn a rename into an outage (CLAUDE.md, production DDL policy).
--
-- tournament_players.username is DENORMALISED - trg_tournament_player_name
-- stamps it at INSERT, and the tournament lobby, the results screen, knockout
-- announcements and mystery-bounty reveals all render that stored string. So
-- correcting the resolver does nothing for the rows already written: 18,873 of
-- them held a value equal to the player's own full_name when this was measured.
--
-- SCOPE: tournaments that have not finished, exactly as
-- 20260823020000_tournament_player_name_respects_alias.sql scoped its own
-- backfill. A COMPLETED or CANCELLED tournament is a settled record and its
-- result sheet is history; CLAUDE.md 10.9 says correct forward, never rewrite
-- a settled record quietly. Names on finished events stay as they were
-- reported at the time. New entries into any future tournament get the arena
-- name from the trigger.
--
-- ROLLBACK: none needed - this only rewrites a display string on live rows,
-- and re-running it after reverting the resolver would restore the previous
-- values. No money, no seat, no result is touched.
-- ============================================================================

BEGIN;

UPDATE public.tournament_players tp
   SET username = public.fn_player_display_name(tp.user_id)
  FROM public.tournaments t
 WHERE t.id = tp.tournament_id
   AND t.status NOT IN ('COMPLETED', 'CANCELLED')
   AND tp.username IS DISTINCT FROM public.fn_player_display_name(tp.user_id);

DO $$
DECLARE v_left integer;
BEGIN
  -- No live seat may still be showing a real name.
  SELECT count(*) INTO v_left
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
    JOIN public.profiles p ON p.id = tp.user_id
   WHERE t.status NOT IN ('COMPLETED', 'CANCELLED')
     AND nullif(btrim(p.full_name), '') IS NOT NULL
     AND lower(tp.username) = lower(btrim(p.full_name))
     -- ...except the 3 documented accounts whose username IS their full name
     -- and who have nothing else to be called. See the companion migration.
     AND nullif(btrim(p.alias), '') IS NOT NULL;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% live tournament seats still show a real name', v_left;
  END IF;
END $$;

COMMIT;

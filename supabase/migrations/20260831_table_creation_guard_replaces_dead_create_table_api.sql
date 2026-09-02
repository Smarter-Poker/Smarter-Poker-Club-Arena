-- 2026-08-31 TABLE CREATION GUARD (applied to production via Supabase MCP the
-- same day; this file is the auditable record).
--
-- The World Hub route pages/api/club-arena/create-table.js was DEAD CODE with
-- zero callers: every table a club owner creates comes from the client insert
-- in TableConfigPage, so none of that route's validation ever ran. The route
-- is deleted (World Hub PR #1051); the validation that matters moves here,
-- where it applies to every writer.
--
-- SEAT LAW (cash only) mirrors src/config/tableSeating.ts; over-seating makes
-- PokerEngine.deal() throw and the table can never deal a hand. Tournaments
-- are exempt by that same law. Blinds sanity / buy-in order are cash+INSERT
-- only (1,193 CLOSED rows carry sb=bb=10,000,000 from tournament level
-- escalation, and a guard that stops the engine finishing a hand is worse than
-- the bug it stops). Action time floor is 10 (engine floor; the client slider
-- offered 5). Name is trimmed, bounded and angle-bracket stripped.
--
-- NOT enforced here and left for Dan: the official stakes schedule, rake/BBJ
-- tier auto-fill, and the settings JSONB payload the dead route also carried.

CREATE OR REPLACE FUNCTION public.fn_tables_creation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_variant text := lower(coalesce(NEW.game_variant, 'nlh'));
  v_cap integer;
  v_name text;
BEGIN
  v_name := btrim(coalesce(NEW.name, ''));
  v_name := replace(replace(v_name, '<', ''), '>', '');
  IF length(v_name) = 0 THEN
    RAISE EXCEPTION 'table name is required';
  END IF;
  IF length(v_name) > 60 THEN
    v_name := left(v_name, 60);
  END IF;
  NEW.name := v_name;

  IF NEW.action_time_seconds IS NOT NULL
     AND (NEW.action_time_seconds < 10 OR NEW.action_time_seconds > 120) THEN
    RAISE EXCEPTION 'action_time_seconds must be between 10 and 120 (got %)', NEW.action_time_seconds;
  END IF;

  IF coalesce(NEW.game_type, '') = 'cash' THEN
    v_cap := CASE v_variant
               WHEN 'plo6' THEN 6
               WHEN 'plo5' THEN 7
               WHEN 'plo4' THEN 8
               WHEN 'plo8' THEN 8
               WHEN 'flo8' THEN 8
               ELSE 9
             END;
    IF coalesce(NEW.max_players, 0) < 2 THEN
      RAISE EXCEPTION 'a cash table needs at least 2 seats (got %)', NEW.max_players;
    END IF;
    IF NEW.max_players > v_cap THEN
      RAISE EXCEPTION 'seat law: % allows at most % seats (got %) - the deck cannot fund three run-it boards above that',
        v_variant, v_cap, NEW.max_players;
    END IF;

    IF coalesce(NEW.small_blind, 0) <= 0 OR coalesce(NEW.big_blind, 0) <= 0 THEN
      RAISE EXCEPTION 'blinds must be positive (sb=%, bb=%)', NEW.small_blind, NEW.big_blind;
    END IF;
    IF NEW.big_blind <= NEW.small_blind THEN
      RAISE EXCEPTION 'big blind must exceed small blind (sb=%, bb=%)', NEW.small_blind, NEW.big_blind;
    END IF;

    IF NEW.min_buy_in IS NOT NULL AND NEW.max_buy_in IS NOT NULL
       AND NEW.min_buy_in > NEW.max_buy_in THEN
      RAISE EXCEPTION 'min_buy_in (%) cannot exceed max_buy_in (%)', NEW.min_buy_in, NEW.max_buy_in;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tables_creation_guard ON public.tables;
CREATE TRIGGER trg_tables_creation_guard
  BEFORE INSERT ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_tables_creation_guard();

-- ROLLBACK:
--   DROP TRIGGER trg_tables_creation_guard ON public.tables;
--   DROP FUNCTION public.fn_tables_creation_guard();

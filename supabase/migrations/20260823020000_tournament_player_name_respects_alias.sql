-- ═══════════════════════════════════════════════════════════════════════════
-- THE TABLE WAS SHOWING PEOPLE'S REAL NAMES AGAINST THEIR SETTING
-- 2026-08-23, Cowork session 11g
-- ALREADY APPLIED TO PROD as `tournament_player_name_respects_alias`.
--
-- Dan: "it's calling me Marcus Chen instead of KingFish."
--
-- profiles carries FOUR name columns and a preference:
--   alias 'KingFish' | username 'kingfish' | display_name 'Marcus Chen'
--   use_real_name = false   <- he opted OUT of showing the real one
--
-- Both registration RPCs resolved the seat name as
-- COALESCE(display_name, username, 'Player') — ignoring `alias` AND ignoring
-- `use_real_name` — so the real name of anyone with a display_name was
-- stamped onto tournament_players.username and broadcast at the table, in
-- knockout announcements and in mystery-bounty reveals. A privacy defect:
-- the one setting that keeps a real name off the felt did nothing.
--
-- Fixed with a helper + BEFORE INSERT trigger rather than by rewriting the
-- two large RPCs: the trigger catches EVERY path into the table at once
-- (human register, horse register, satellite seat award, any future writer)
-- and cannot drift from them.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_player_display_name(p_user_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
           CASE WHEN COALESCE(p.use_real_name, false)
                THEN NULLIF(btrim(p.display_name), '') END,
           NULLIF(btrim(p.alias), ''),
           NULLIF(btrim(p.username), ''),
           NULLIF(btrim(p.display_name), ''),
           'Player')
    FROM public.profiles p WHERE p.id = p_user_id;
$function$;

CREATE OR REPLACE FUNCTION public.trg_tournament_player_name()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_name text;
BEGIN
  v_name := public.fn_player_display_name(NEW.user_id);
  IF v_name IS NOT NULL AND v_name <> '' THEN
    NEW.username := v_name;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tournament_player_name ON public.tournament_players;
CREATE TRIGGER tournament_player_name
  BEFORE INSERT ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_player_name();

UPDATE public.tournament_players tp
   SET username = public.fn_player_display_name(tp.user_id)
  FROM public.tournaments t
 WHERE t.id = tp.tournament_id
   AND t.status NOT IN ('COMPLETED', 'CANCELLED')
   AND tp.username IS DISTINCT FROM public.fn_player_display_name(tp.user_id);

DO $$
DECLARE v_name text;
BEGIN
  SELECT public.fn_player_display_name('47965354-0e56-43ef-931c-ddaab82af765') INTO v_name;
  IF v_name <> 'KingFish' THEN
    RAISE EXCEPTION 'alias not honoured: got %', v_name;
  END IF;
END $$;

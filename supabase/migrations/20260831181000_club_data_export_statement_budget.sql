-- Club Data final certification: complete exports need a complete statement budget.
--
-- Production's authenticated role has an eight-second statement_timeout. The
-- exact Shark Club Games export materializes more than 44,000 immutable rows
-- and takes about sixteen seconds on a warm database, so the role default
-- cancels valid exports before they can return their preparation receipt.
-- Keep the global browser-role limit intact and raise it only while these two
-- authorized, maximum-92-day, short-lived export builders are executing.

ALTER FUNCTION public.ca_club_game_export_start(
  uuid,date,date,text,text,text,text,uuid
) SET statement_timeout TO '120s';

ALTER FUNCTION public.ca_club_player_export_start(
  uuid,date,date,text,uuid
) SET statement_timeout TO '120s';

DO $assert$
DECLARE
  v_game_config text[];
  v_player_config text[];
BEGIN
  SELECT p.proconfig INTO v_game_config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.oid='public.ca_club_game_export_start(uuid,date,date,text,text,text,text,uuid)'::regprocedure;
  SELECT p.proconfig INTO v_player_config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.oid='public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure;

  IF NOT COALESCE(v_game_config,'{}'::text[]) @> ARRAY['statement_timeout=120s'] THEN
    RAISE EXCEPTION 'game export statement budget was not installed';
  END IF;
  IF NOT COALESCE(v_player_config,'{}'::text[]) @> ARRAY['statement_timeout=120s'] THEN
    RAISE EXCEPTION 'player export statement budget was not installed';
  END IF;
END;
$assert$;

-- PostgreSQL does not guarantee short-circuit evaluation for the optional
-- search OR-chain in the SQL helper. On the 42k-row Shark Club report it kept
-- evaluating the ILIKE path even with p_search NULL. Give the overwhelmingly
-- common no-search request a function with no search expressions in its plan.

ALTER FUNCTION public.fn_ca_club_games(uuid,date,date,text,text,text)
  RENAME TO fn_ca_club_games_searched;

CREATE OR REPLACE FUNCTION public.fn_ca_club_games_unsearched(
  p_club_id uuid,p_start date,p_end date,p_game text DEFAULT 'ALL'::text,
  p_stakes text DEFAULT 'ALL'::text
)
RETURNS TABLE(kind text,id text,name text,variant text,game_class text,
  stakes_tier text,small_blind numeric,big_blind numeric,rake_percent numeric,
  started_at timestamptz,created_by uuid,status text,fee numeric,winnings numeric,
  hands bigint,players integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH cash AS (
    SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands) hands,
           MAX(c.players) players FROM public.club_table_daily c
     WHERE c.club_id=p_club_id AND c.stat_date BETWEEN p_start AND p_end GROUP BY c.table_id
  ), tournament_facts AS MATERIALIZED (
    SELECT d.tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
      FROM public.ca_club_tournament_daily d WHERE d.club_id=p_club_id
       AND d.stat_date BETWEEN p_start AND p_end GROUP BY d.tournament_id
  ), tournament_players AS MATERIALIZED (
    SELECT p.tournament_id,count(DISTINCT p.user_id)::integer players
      FROM public.ca_club_tournament_player_daily p WHERE p.club_id=p_club_id
       AND p.stat_date BETWEEN p_start AND p_end GROUP BY p.tournament_id
  ), all_rows AS (
    SELECT 'CASH'::text kind,t.id::text id,COALESCE(t.name,'Unnamed') name,
      UPPER(COALESCE(t.game_variant,'nlh')) variant,
      CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
           WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
           ELSE 'HOLDEM' END game_class,COALESCE(t.small_blind,0) small_blind,
      COALESCE(t.big_blind,0) big_blind,
      CASE WHEN COALESCE(t.rake_percent,-1)>=0 THEN t.rake_percent END rake_percent,
      t.created_at started_at,t.created_by,t.status,round(c.fee,2) fee,
      round(c.winnings,2) winnings,c.hands::bigint,c.players::integer
      FROM cash c JOIN public.tables t ON t.id=c.table_id
    UNION ALL
    SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,
      tr.id::text,COALESCE(tr.name,'Tournament'),UPPER(COALESCE(tr.variant,tr.game_type,'nlh')),
      CASE WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,
      0::numeric,0::numeric,NULL::numeric,tr.start_time,NULL::uuid,tr.status,
      round(COALESCE(f.fee,0),2),round(COALESCE(f.winnings,0),2),0::bigint,
      COALESCE(tp.players,0)::integer
      FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
      LEFT JOIN tournament_players tp ON tp.tournament_id=f.tournament_id
  ), tagged AS (
    SELECT r.*,CASE WHEN r.game_class IN('MTT','SNG') THEN 'NA'
      WHEN r.big_blind<1 THEN 'MICRO' WHEN r.big_blind<5 THEN 'SMALL'
      WHEN r.big_blind<25 THEN 'MID' ELSE 'HIGH' END stakes_tier FROM all_rows r
  )
  SELECT t.kind,t.id,t.name,t.variant,t.game_class,t.stakes_tier,t.small_blind,
    t.big_blind,t.rake_percent,t.started_at,t.created_by,t.status,t.fee,t.winnings,
    t.hands,t.players FROM tagged t
   WHERE (UPPER(COALESCE(NULLIF(p_game,''),'ALL'))='ALL' OR t.game_class=UPPER(p_game))
     AND (UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'))='ALL' OR t.stakes_tier=UPPER(p_stakes));
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_games(
  p_club_id uuid,p_start date,p_end date,p_game text DEFAULT 'ALL'::text,
  p_stakes text DEFAULT 'ALL'::text,p_search text DEFAULT NULL::text
)
RETURNS TABLE(kind text,id text,name text,variant text,game_class text,
  stakes_tier text,small_blind numeric,big_blind numeric,rake_percent numeric,
  started_at timestamptz,created_by uuid,status text,fee numeric,winnings numeric,
  hands bigint,players integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(btrim(COALESCE(p_search,'')),'') IS NULL THEN
    RETURN QUERY SELECT * FROM public.fn_ca_club_games_unsearched(
      p_club_id,p_start,p_end,p_game,p_stakes
    );
  ELSE
    RETURN QUERY SELECT * FROM public.fn_ca_club_games_searched(
      p_club_id,p_start,p_end,p_game,p_stakes,p_search
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_games_searched(uuid,date,date,text,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_club_games_unsearched(uuid,date,date,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_games_unsearched(uuid,date,date,text,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_club_games(uuid,date,date,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_games(uuid,date,date,text,text,text)
  TO service_role;


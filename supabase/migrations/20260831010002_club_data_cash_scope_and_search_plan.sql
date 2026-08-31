-- Two production parity findings:
--  1. cash wallet activity on tournament tables must not be treated as cash;
--  2. fn_ca_club_games' correlated creator search was planned even when the
--     search argument was NULL, multiplying a 42k-row report into a timeout.

ALTER FUNCTION public.ca_refresh_reporting_rollups(date,date)
  RENAME TO ca_refresh_reporting_rollups_base;

CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_cash_rollup(
  p_start date,p_end date
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_start date:=LEAST(p_start,p_end); v_end date:=GREATEST(p_start,p_end);
  v_from timestamptz; v_to timestamptz; v_rows bigint;
BEGIN
  IF v_start IS NULL OR v_end IS NULL OR v_end-v_start>400 THEN
    RAISE EXCEPTION 'cash reporting refresh requires a 0-400 day range'; END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  v_from:=v_start::timestamp AT TIME ZONE 'UTC';
  v_to:=(v_end+1)::timestamp AT TIME ZONE 'UTC';
  UPDATE public.ca_club_player_daily SET cash_net=0,updated_at=now()
   WHERE stat_date BETWEEN v_start AND v_end AND cash_net<>0;
  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON(uc.union_id,cm.user_id) uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), cash AS (
    SELECT h.club_id,wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date stat_date,
           SUM(CASE WHEN wt.type='credit' THEN wt.amount
                    WHEN wt.type='debit' THEN -wt.amount ELSE 0 END) cash_net
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NOT NULL
       AND tb.tournament_id IS NULL
      JOIN home h ON h.union_id=tb.union_id AND h.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN('buyin','cashout') AND wt.table_id IS NOT NULL
     GROUP BY 1,2,3
  )
  INSERT INTO public.ca_club_player_daily AS d
    (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
  SELECT club_id,user_id,stat_date,cash_net,0,now() FROM cash
  ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
   SET cash_net=EXCLUDED.cash_net,updated_at=now();
  SELECT count(*) INTO v_rows FROM public.ca_club_player_daily
   WHERE stat_date BETWEEN v_start AND v_end AND cash_net<>0;
  RETURN jsonb_build_object('start',v_start,'end',v_end,'cash_facts',v_rows,'refreshed_at',now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_rollups(
  p_start date,p_end date
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_base jsonb; v_cash jsonb;
BEGIN
  v_base:=public.ca_refresh_reporting_rollups_base(p_start,p_end);
  v_cash:=public.ca_refresh_reporting_cash_rollup(p_start,p_end);
  RETURN v_base || jsonb_build_object('cash_repair',v_cash);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_wallet_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid; v_union uuid; v_is_tournament_table boolean; v_day date;
  v_cash numeric:=0; v_tournament numeric:=0; r record;
BEGIN
  IF NOT ((NEW.category IN('buyin','cashout') AND NEW.table_id IS NOT NULL)
    OR (NEW.category IN('tournament_buyin','prize','bounty') AND NEW.related_entity_id IS NOT NULL))
    THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.category IN('buyin','cashout') THEN
    SELECT t.union_id,(t.tournament_id IS NOT NULL) INTO v_union,v_is_tournament_table
      FROM public.tables t WHERE t.id=NEW.table_id;
    IF v_union IS NULL OR v_is_tournament_table THEN RETURN NULL; END IF;
    SELECT cm.club_id INTO v_club FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id=cm.club_id AND uc.union_id=v_union
     WHERE cm.user_id=NEW.user_id
     ORDER BY cm.joined_at ASC NULLS LAST,cm.club_id LIMIT 1;
    v_cash:=CASE WHEN NEW.type='credit' THEN NEW.amount
                 WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    IF v_club IS NOT NULL THEN
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(v_club,NEW.user_id,v_day,v_cash,0,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET cash_net=d.cash_net+EXCLUDED.cash_net,updated_at=now();
    END IF;
  ELSE
    v_tournament:=CASE WHEN NEW.category='tournament_buyin' THEN -NEW.amount ELSE NEW.amount END;
    FOR r IN SELECT * FROM public.ca_reporting_tournament_clubs_for_user(NEW.user_id) LOOP
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(r.club_id,NEW.user_id,v_day,0,v_tournament,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET tournament_net=d.tournament_net+EXCLUDED.tournament_net,updated_at=now();
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,winnings,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,v_day,v_tournament,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET winnings=d.winnings+EXCLUDED.winnings,updated_at=now();
      INSERT INTO public.ca_club_tournament_player_daily
        (club_id,tournament_id,user_id,stat_date,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,NEW.user_id,v_day,now())
      ON CONFLICT(club_id,tournament_id,user_id,stat_date) DO UPDATE SET updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data wallet rollup failed for tx %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_games(
  p_club_id uuid,p_start date,p_end date,p_game text DEFAULT 'ALL'::text,
  p_stakes text DEFAULT 'ALL'::text,p_search text DEFAULT NULL::text
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
      round(c.winnings,2) winnings,c.hands::bigint,c.players::integer,
      COALESCE(pr.username,'') creator_username
      FROM cash c JOIN public.tables t ON t.id=c.table_id
      LEFT JOIN public.profiles pr ON pr.id=t.created_by
    UNION ALL
    SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,
      tr.id::text,COALESCE(tr.name,'Tournament'),UPPER(COALESCE(tr.variant,tr.game_type,'nlh')),
      CASE WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,
      0::numeric,0::numeric,NULL::numeric,tr.start_time,NULL::uuid,tr.status,
      round(COALESCE(f.fee,0),2),round(COALESCE(f.winnings,0),2),0::bigint,
      COALESCE(tp.players,0)::integer,''::text
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
     AND (UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'))='ALL' OR t.stakes_tier=UPPER(p_stakes))
     AND (NULLIF(btrim(COALESCE(p_search,'')),'') IS NULL
       OR t.name ILIKE '%'||btrim(p_search)||'%'
       OR t.id ILIKE '%'||btrim(p_search)||'%'
       OR t.creator_username ILIKE '%'||btrim(p_search)||'%');
$function$;

SELECT public.ca_refresh_reporting_cash_rollup(
  ((now() AT TIME ZONE 'UTC')::date-185),(now() AT TIME ZONE 'UTC')::date
);

REVOKE ALL ON FUNCTION public.ca_refresh_reporting_rollups_base(date,date)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ca_refresh_reporting_cash_rollup(date,date)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_refresh_reporting_rollups(date,date)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_reporting_rollups(date,date) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_club_games(uuid,date,date,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_games(uuid,date,date,text,text,text) TO service_role;


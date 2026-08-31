-- A set-returning function must materialize every returned tuple before an
-- outer LIMIT can consume it. Shark Club has 42k game rows, so the otherwise
-- indexed helper still spent ~5.6s copying wide tuples. Split the snapshot into
-- one in-database aggregate and one in-database top-N JSON query. Only the 100
-- visible rows now cross a function boundary.

CREATE OR REPLACE FUNCTION public.fn_ca_club_game_summary(
  p_club_id uuid,p_start date,p_end date,p_game text,p_stakes text,p_search text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  EXECUTE $query$
    WITH cash AS (
      SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands) hands
        FROM public.club_table_daily c WHERE c.club_id=$1
         AND c.stat_date BETWEEN $2 AND $3 GROUP BY c.table_id
    ), tournament_facts AS (
      SELECT d.tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
        FROM public.ca_club_tournament_daily d WHERE d.club_id=$1
         AND d.stat_date BETWEEN $2 AND $3 GROUP BY d.tournament_id
    ), all_rows AS (
      SELECT CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%'
                    OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                  WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%'
                    OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                  ELSE 'HOLDEM' END game_class,
             CASE WHEN COALESCE(t.big_blind,0)<1 THEN 'MICRO'
                  WHEN COALESCE(t.big_blind,0)<5 THEN 'SMALL'
                  WHEN COALESCE(t.big_blind,0)<25 THEN 'MID' ELSE 'HIGH' END stakes_tier,
             t.id::text id,COALESCE(t.name,'Unnamed') name,
             COALESCE(pr.username,'') creator_name,c.fee,c.winnings,c.hands::bigint
        FROM cash c JOIN public.tables t ON t.id=c.table_id
        LEFT JOIN public.profiles pr ON pr.id=t.created_by
      UNION ALL
      SELECT CASE WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,'NA',
             tr.id::text,COALESCE(tr.name,'Tournament'),'',f.fee,f.winnings,0::bigint
        FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
    ), filtered AS (
      SELECT * FROM all_rows r
       WHERE (UPPER(COALESCE(NULLIF($4,''),'ALL'))='ALL' OR r.game_class=UPPER($4))
         AND (UPPER(COALESCE(NULLIF($5,''),'ALL'))='ALL' OR r.stakes_tier=UPPER($5))
         AND (NULLIF(btrim(COALESCE($6,'')),'') IS NULL
           OR r.name ILIKE '%'||btrim($6)||'%' OR r.id ILIKE '%'||btrim($6)||'%'
           OR r.creator_name ILIKE '%'||btrim($6)||'%')
    )
    SELECT jsonb_build_object(
      'games',count(*),
      'total_winnings',round(COALESCE(SUM(winnings),0),2),
      'mtt_winnings',round(COALESCE(SUM(winnings) FILTER(WHERE game_class IN('MTT','SNG')),0),2),
      'cash_winnings',round(COALESCE(SUM(winnings) FILTER(WHERE game_class NOT IN('MTT','SNG')),0),2),
      'fee',round(COALESCE(SUM(fee),0),2),
      'cash_fee',round(COALESCE(SUM(fee) FILTER(WHERE game_class NOT IN('MTT','SNG')),0),2),
      'mtt_fee',round(COALESCE(SUM(fee) FILTER(WHERE game_class IN('MTT','SNG')),0),2),
      'hands',COALESCE(SUM(hands),0)) FROM filtered
  $query$ INTO v_out USING p_club_id,p_start,p_end,p_game,p_stakes,p_search;
  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_game_rows(
  p_club_id uuid,p_start date,p_end date,p_game text,p_stakes text,p_search text,
  p_limit integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  EXECUTE $query$
    WITH cash AS (
      SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands) hands,
             MAX(c.players)::integer players FROM public.club_table_daily c
       WHERE c.club_id=$1 AND c.stat_date BETWEEN $2 AND $3 GROUP BY c.table_id
    ), tournament_facts AS (
      SELECT d.tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
        FROM public.ca_club_tournament_daily d WHERE d.club_id=$1
         AND d.stat_date BETWEEN $2 AND $3 GROUP BY d.tournament_id
    ), all_rows AS (
      SELECT 'CASH'::text kind,t.id::text id,COALESCE(t.name,'Unnamed') name,
        UPPER(COALESCE(t.game_variant,'nlh')) variant,
        CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
             WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
             ELSE 'HOLDEM' END game_class,
        CASE WHEN COALESCE(t.big_blind,0)<1 THEN 'MICRO'
             WHEN COALESCE(t.big_blind,0)<5 THEN 'SMALL'
             WHEN COALESCE(t.big_blind,0)<25 THEN 'MID' ELSE 'HIGH' END stakes_tier,
        COALESCE(t.small_blind,0) small_blind,COALESCE(t.big_blind,0) big_blind,
        CASE WHEN COALESCE(t.rake_percent,-1)>=0 THEN t.rake_percent END rake_percent,
        t.created_at started_at,t.created_by,t.status,round(c.fee,2) fee,
        round(c.winnings,2) winnings,c.hands::bigint,c.players,
        COALESCE(pr.username,'') creator_name,pr.avatar_url creator_avatar
        FROM cash c JOIN public.tables t ON t.id=c.table_id
        LEFT JOIN public.profiles pr ON pr.id=t.created_by
      UNION ALL
      SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,
        tr.id::text,COALESCE(tr.name,'Tournament'),UPPER(COALESCE(tr.variant,tr.game_type,'nlh')),
        CASE WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,'NA',
        0::numeric,0::numeric,NULL::numeric,tr.start_time,NULL::uuid,tr.status,
        round(COALESCE(f.fee,0),2),round(COALESCE(f.winnings,0),2),0::bigint,0::integer,
        ''::text,NULL::text
        FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
    ), bounded AS MATERIALIZED (
      SELECT * FROM all_rows r
       WHERE (UPPER(COALESCE(NULLIF($4,''),'ALL'))='ALL' OR r.game_class=UPPER($4))
         AND (UPPER(COALESCE(NULLIF($5,''),'ALL'))='ALL' OR r.stakes_tier=UPPER($5))
         AND (NULLIF(btrim(COALESCE($6,'')),'') IS NULL
           OR r.name ILIKE '%'||btrim($6)||'%' OR r.id ILIKE '%'||btrim($6)||'%'
           OR r.creator_name ILIKE '%'||btrim($6)||'%')
       ORDER BY r.started_at DESC NULLS LAST LIMIT $7
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'kind',q.kind,'id',q.id,'name',q.name,'variant',q.variant,
      'game_class',q.game_class,'stakes_tier',q.stakes_tier,
      'blinds',CASE WHEN q.big_blind>0 THEN
        trim(trailing '.' from trim(trailing '0' from q.small_blind::text))||'/'||
        trim(trailing '.' from trim(trailing '0' from q.big_blind::text)) END,
      'rake_percent',q.rake_percent,'started_at',q.started_at,'status',q.status,
      'creator_id',q.created_by,'creator_name',NULLIF(q.creator_name,''),
      'creator_avatar',q.creator_avatar,'fee',q.fee,'winnings',q.winnings,
      'hands',q.hands,'players',CASE WHEN q.kind='CASH' THEN q.players ELSE COALESCE((
        SELECT count(DISTINCT p.user_id)::integer FROM public.ca_club_tournament_player_daily p
         WHERE p.club_id=$1 AND p.tournament_id=q.id::uuid
           AND p.stat_date BETWEEN $2 AND $3),0) END)
      ORDER BY q.started_at DESC NULLS LAST),'[]'::jsonb) FROM bounded q
  $query$ INTO v_out USING p_club_id,p_start,p_end,p_game,p_stakes,p_search,p_limit;
  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_data_snapshot(
  p_club_id uuid,p_start date DEFAULT NULL::date,p_end date DEFAULT NULL::date,
  p_game text DEFAULT 'ALL'::text,p_stakes text DEFAULT 'ALL'::text,
  p_search text DEFAULT NULL::text,p_limit integer DEFAULT 100
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_today date:=(now() AT TIME ZONE 'UTC')::date;
  v_end date:=LEAST(COALESCE(p_end,v_today),v_today);
  v_start date:=COALESCE(p_start,v_end-13); v_days int; v_pstart date; v_pend date;
  v_game text:=UPPER(COALESCE(NULLIF(p_game,''),'ALL'));
  v_stakes text:=UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'));
  v_q text:=NULLIF(btrim(COALESCE(p_search,'')),'');
  v_lim int:=GREATEST(LEAST(COALESCE(p_limit,100),500),1);
  v_union uuid; v_cur jsonb; v_prev jsonb; v_rows jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  IF v_start<v_end-92 THEN v_start:=v_end-92; END IF;
  IF v_start>v_end THEN v_start:=v_end; END IF;
  v_days:=(v_end-v_start)+1; v_pend:=v_start-1; v_pstart:=v_pend-(v_days-1);
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
  v_cur:=public.fn_ca_club_game_summary(p_club_id,v_start,v_end,v_game,v_stakes,v_q);
  v_prev:=public.fn_ca_club_game_summary(p_club_id,v_pstart,v_pend,v_game,v_stakes,v_q);
  v_rows:=public.fn_ca_club_game_rows(p_club_id,v_start,v_end,v_game,v_stakes,v_q,v_lim);
  RETURN jsonb_build_object(
    'range',jsonb_build_object('start',v_start,'end',v_end,'days',v_days),
    'previous_range',jsonb_build_object('start',v_pstart,'end',v_pend,'days',v_days),
    'filters',jsonb_build_object('game',v_game,'stakes',v_stakes,'search',v_q),
    'summary',v_cur,'previous',v_prev,'delta',jsonb_build_object(
      'fee_pct',CASE WHEN COALESCE((v_prev->>'fee')::numeric,0)=0 THEN NULL ELSE round(((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric)/abs((v_prev->>'fee')::numeric)*100,1) END,
      'games_pct',CASE WHEN COALESCE((v_prev->>'games')::numeric,0)=0 THEN NULL ELSE round(((v_cur->>'games')::numeric-(v_prev->>'games')::numeric)/abs((v_prev->>'games')::numeric)*100,1) END,
      'winnings_abs',round((v_cur->>'total_winnings')::numeric-(v_prev->>'total_winnings')::numeric,2),
      'fee_abs',round((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric,2)),
    'rows',v_rows,'row_count',(v_cur->>'games')::int,'union_id',v_union,
    'data_updated_at',GREATEST(
      (SELECT max(c.updated_at) FROM public.club_table_daily c WHERE c.club_id=p_club_id AND c.stat_date BETWEEN v_start AND v_end),
      (SELECT max(d.updated_at) FROM public.ca_club_tournament_daily d WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end)),
    'generated_at',now());
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_game_summary(uuid,date,date,text,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_club_game_rows(uuid,date,date,text,text,text,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_game_summary(uuid,date,date,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_game_rows(uuid,date,date,text,text,text,integer) TO service_role;
REVOKE ALL ON FUNCTION public.ca_club_data_snapshot(uuid,date,date,text,text,text,integer)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_snapshot(uuid,date,date,text,text,text,integer)
  TO authenticated,service_role;


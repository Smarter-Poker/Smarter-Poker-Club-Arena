-- Club Data phase 2: complete, deterministic browsing.
--
-- The snapshot RPC deliberately returns a bounded first slice.  It must not be
-- stretched back into a 42k-row response just to support scrolling.  These two
-- authorized page RPCs keep the summary contract small while giving Games and
-- Players stable server-side ordering and keyset cursors.  A cursor contains
-- only sort keys from the last visible row; it grants no authority and every
-- request repeats the finance capability check.

CREATE OR REPLACE FUNCTION public.ca_club_game_page(
  p_club_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_game text DEFAULT 'ALL'::text,
  p_stakes text DEFAULT 'ALL'::text,
  p_search text DEFAULT NULL::text,
  p_sort text DEFAULT 'recent'::text,
  p_cursor jsonb DEFAULT NULL::jsonb,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end,v_today),v_today);
  v_start date := COALESCE(p_start,v_end-13);
  v_game text := UPPER(COALESCE(NULLIF(p_game,''),'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'));
  v_search text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := LOWER(COALESCE(NULLIF(p_sort,''),'recent'));
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit,100),200),1);
  v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501';
  END IF;
  IF v_start < v_end-92 THEN v_start := v_end-92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_sort NOT IN ('recent','fee','winnings','hands') THEN v_sort := 'recent'; END IF;

  -- EXECUTE forces a plan for this club/window.  Shark Club previously crossed
  -- 20 seconds when PostgreSQL reused a generic parameter plan here.
  EXECUTE $query$
    WITH cash AS (
      SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands)::bigint hands,
             MAX(c.players)::integer players
        FROM public.club_table_daily c
       WHERE c.club_id=$1 AND c.stat_date BETWEEN $2 AND $3
       GROUP BY c.table_id
    ), tournament_facts AS MATERIALIZED (
      SELECT d.tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
        FROM public.ca_club_tournament_daily d
       WHERE d.club_id=$1 AND d.stat_date BETWEEN $2 AND $3
       GROUP BY d.tournament_id
    ), tournament_players AS MATERIALIZED (
      SELECT p.tournament_id,count(DISTINCT p.user_id)::integer players
        FROM public.ca_club_tournament_player_daily p
       WHERE p.club_id=$1 AND p.stat_date BETWEEN $2 AND $3
       GROUP BY p.tournament_id
    ), all_rows AS (
      SELECT 'CASH'::text kind,t.id::text id,COALESCE(t.name,'Unnamed') name,
             UPPER(COALESCE(t.game_variant,'nlh')) variant,
             CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%'
                        OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                  WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%'
                        OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                  ELSE 'HOLDEM' END game_class,
             CASE WHEN COALESCE(t.big_blind,0)<1 THEN 'MICRO'
                  WHEN COALESCE(t.big_blind,0)<5 THEN 'SMALL'
                  WHEN COALESCE(t.big_blind,0)<25 THEN 'MID' ELSE 'HIGH' END stakes_tier,
             COALESCE(t.small_blind,0) small_blind,COALESCE(t.big_blind,0) big_blind,
             CASE WHEN COALESCE(t.rake_percent,-1)>=0 THEN t.rake_percent END rake_percent,
             t.created_at started_at,t.created_by,t.status,round(c.fee,2) fee,
             round(c.winnings,2) winnings,c.hands,c.players,
             COALESCE(pr.username,'') creator_name,pr.avatar_url creator_avatar
        FROM cash c JOIN public.tables t ON t.id=c.table_id
        LEFT JOIN public.profiles pr ON pr.id=t.created_by
      UNION ALL
      SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,
             tr.id::text,COALESCE(tr.name,'Tournament'),
             UPPER(COALESCE(tr.variant,tr.game_type,'nlh')),
             CASE WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,
             'NA',0::numeric,0::numeric,NULL::numeric,tr.start_time,NULL::uuid,tr.status,
             round(COALESCE(f.fee,0),2),round(COALESCE(f.winnings,0),2),0::bigint,
             COALESCE(tp.players,0)::integer,''::text,NULL::text
        FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
        LEFT JOIN tournament_players tp ON tp.tournament_id=f.tournament_id
    ), filtered AS MATERIALIZED (
      SELECT r.* FROM all_rows r
       WHERE ($4='ALL' OR r.game_class=$4)
         AND ($5='ALL' OR r.stakes_tier=$5)
         AND ($6 IS NULL OR r.name ILIKE '%'||$6||'%' OR r.id ILIKE '%'||$6||'%'
              OR r.creator_name ILIKE '%'||$6||'%')
    ), scored AS MATERIALIZED (
      SELECT f.*,
             CASE $7 WHEN 'fee' THEN f.fee
                     WHEN 'winnings' THEN f.winnings
                     WHEN 'hands' THEN f.hands::numeric
                     ELSE extract(epoch FROM COALESCE(f.started_at,'0001-01-01'::timestamptz))::numeric
              END sort_value,
             extract(epoch FROM COALESCE(f.started_at,'0001-01-01'::timestamptz))::numeric sort_time
        FROM filtered f
    ), page_plus_one AS MATERIALIZED (
      SELECT s.* FROM scored s
       WHERE $8 IS NULL OR ROW(s.sort_value,s.sort_time,s.kind,s.id) < ROW(
         ($8->>'value')::numeric,($8->>'time')::numeric,$8->>'kind',$8->>'id')
       ORDER BY s.sort_value DESC,s.sort_time DESC,s.kind DESC,s.id DESC
       LIMIT $9+1
    ), visible AS MATERIALIZED (
      SELECT * FROM page_plus_one
       ORDER BY sort_value DESC,sort_time DESC,kind DESC,id DESC LIMIT $9
    ), last_row AS (
      SELECT * FROM visible ORDER BY sort_value ASC,sort_time ASC,kind ASC,id ASC LIMIT 1
    )
    SELECT jsonb_build_object(
      'sort',$7,
      'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'kind',q.kind,'id',q.id,'name',q.name,'variant',q.variant,
        'game_class',q.game_class,'stakes_tier',q.stakes_tier,
        'blinds',CASE WHEN q.big_blind>0 THEN
          trim(trailing '.' from trim(trailing '0' from q.small_blind::text))||'/'||
          trim(trailing '.' from trim(trailing '0' from q.big_blind::text)) END,
        'rake_percent',q.rake_percent,'started_at',q.started_at,'status',q.status,
        'creator_id',q.created_by,'creator_name',NULLIF(q.creator_name,''),
        'creator_avatar',q.creator_avatar,'fee',q.fee,'winnings',q.winnings,
        'hands',q.hands,'players',q.players)
        ORDER BY q.sort_value DESC,q.sort_time DESC,q.kind DESC,q.id DESC) FROM visible q),'[]'::jsonb),
      'next_cursor',CASE WHEN (SELECT count(*) FROM page_plus_one)>$9 THEN
        (SELECT jsonb_build_object('value',l.sort_value,'time',l.sort_time,'kind',l.kind,'id',l.id)
           FROM last_row l) ELSE NULL END,
      'has_more',(SELECT count(*) FROM page_plus_one)>$9,
      'filtered_count',(SELECT count(*) FROM filtered),
      'generated_at',now())
  $query$ INTO v_out
  USING p_club_id,v_start,v_end,v_game,v_stakes,v_search,v_sort,p_cursor,v_limit;

  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_player_page(
  p_club_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_sort text DEFAULT 'winners'::text,
  p_search text DEFAULT NULL::text,
  p_cursor jsonb DEFAULT NULL::jsonb,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end,v_today),v_today);
  v_start date := COALESCE(p_start,v_end-13);
  v_sort text := LOWER(COALESCE(NULLIF(p_sort,''),'winners'));
  v_search text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit,100),200),1);
  v_union uuid;
  v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501';
  END IF;
  IF v_start < v_end-92 THEN v_start := v_end-92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_sort NOT IN ('winners','losers','rake','hands') THEN v_sort := 'winners'; END IF;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc
   WHERE uc.club_id=p_club_id LIMIT 1;

  WITH att_club AS MATERIALIZED (
    SELECT a.user_id FROM (
      SELECT DISTINCT ON(cm.user_id) cm.user_id,cm.club_id
        FROM public.club_members cm JOIN public.union_clubs uc
          ON uc.club_id=cm.club_id AND uc.union_id=v_union
       WHERE v_union IS NOT NULL
       ORDER BY cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id) a
     WHERE a.club_id=p_club_id
    UNION
    SELECT cm.user_id FROM public.club_members cm
     WHERE v_union IS NULL AND cm.club_id=p_club_id
  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) cash_net,SUM(d.tournament_net) tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) rake
      FROM public.union_rake_paid_daily_user u JOIN att_club a ON a.user_id=u.user_id
     WHERE u.union_id=v_union AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
  ), hands AS (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s JOIN att_club a ON a.user_id=s.user_id
     WHERE s.club_id=p_club_id AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
  ), merged AS MATERIALIZED (
    SELECT a.user_id,COALESCE(pr.display_name,pr.username,'Player') username,
           pr.avatar_url,COALESCE(pr.is_horse,false) is_horse,
           round(COALESCE(w.cash_net,0),2) cash_net,
           round(COALESCE(w.tournament_net,0),2) tournament_net,
           round(COALESCE(w.cash_net,0)+COALESCE(w.tournament_net,0),2) net,
           round(COALESCE(r.rake,0),2) rake,COALESCE(h.hands,0) hands
      FROM att_club a LEFT JOIN wallet_pnl w ON w.user_id=a.user_id
      LEFT JOIN rake r ON r.user_id=a.user_id LEFT JOIN hands h ON h.user_id=a.user_id
      LEFT JOIN public.profiles pr ON pr.id=a.user_id
     WHERE COALESCE(w.cash_net,0)<>0 OR COALESCE(w.tournament_net,0)<>0
        OR COALESCE(r.rake,0)<>0 OR COALESCE(h.hands,0)<>0
  ), filtered AS MATERIALIZED (
    SELECT m.* FROM merged m
     WHERE v_search IS NULL OR m.username ILIKE '%'||v_search||'%'
        OR m.user_id::text ILIKE '%'||v_search||'%'
  ), scored AS MATERIALIZED (
    SELECT f.*,CASE v_sort WHEN 'losers' THEN -f.net
                           WHEN 'rake' THEN f.rake
                           WHEN 'hands' THEN f.hands::numeric
                           ELSE f.net END sort_value
      FROM filtered f
  ), page_plus_one AS MATERIALIZED (
    SELECT s.* FROM scored s
     WHERE p_cursor IS NULL OR ROW(s.sort_value,s.user_id::text) <
       ROW((p_cursor->>'value')::numeric,p_cursor->>'id')
     ORDER BY s.sort_value DESC,s.user_id::text DESC LIMIT v_limit+1
  ), visible AS MATERIALIZED (
    SELECT * FROM page_plus_one
     ORDER BY sort_value DESC,user_id::text DESC LIMIT v_limit
  ), last_row AS (
    SELECT * FROM visible ORDER BY sort_value ASC,user_id::text ASC LIMIT 1
  )
  SELECT jsonb_build_object(
    'sort',v_sort,
    'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'user_id',q.user_id,'username',q.username,'avatar_url',q.avatar_url,
      'is_horse',q.is_horse,'net',q.net,'cash_net',q.cash_net,
      'tournament_net',q.tournament_net,'rake',q.rake,'hands',q.hands)
      ORDER BY q.sort_value DESC,q.user_id::text DESC) FROM visible q),'[]'::jsonb),
    'next_cursor',CASE WHEN (SELECT count(*) FROM page_plus_one)>v_limit THEN
      (SELECT jsonb_build_object('value',l.sort_value,'id',l.user_id) FROM last_row l)
      ELSE NULL END,
    'has_more',(SELECT count(*) FROM page_plus_one)>v_limit,
    'filtered_count',(SELECT count(*) FROM filtered),
    'generated_at',now()) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer)
  TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)
  TO authenticated,service_role;

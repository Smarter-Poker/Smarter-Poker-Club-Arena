-- Club Data phase 2 production follow-up: first-paint cursor continuity.
--
-- The bounded snapshot is now the source of the default Recent first page.
-- Its old ORDER BY stopped at started_at, while ca_club_game_page uses
-- (started_at, kind, id). Add the identical tie-breakers here so a cursor made
-- from the snapshot's last row can neither skip nor repeat games that share a
-- timestamp.

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
       ORDER BY r.started_at DESC NULLS LAST,r.kind DESC,r.id DESC LIMIT $7
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
      ORDER BY q.started_at DESC NULLS LAST,q.kind DESC,q.id DESC),'[]'::jsonb)
      FROM bounded q
  $query$ INTO v_out USING p_club_id,p_start,p_end,p_game,p_stakes,p_search,p_limit;
  RETURN v_out;
END;
$function$;


-- Club Data phase 2 production follow-up: concurrent cold first paint.
--
-- The default dashboard snapshot paid for three complete game-level plans:
-- current summary, previous summary, and recent rows.  A warm request passed,
-- but two owners opening the ledger together could push both authenticated
-- statements beyond the platform timeout.  Keep the existing filtered/search
-- plans intact and route the overwhelmingly common ALL / ALL / no-search path
-- through narrow fact aggregates plus top-N candidate lookups.

ALTER FUNCTION public.fn_ca_club_game_summary(uuid,date,date,text,text,text)
  RENAME TO fn_ca_club_game_summary_filtered;

CREATE OR REPLACE FUNCTION public.fn_ca_club_game_summary(
  p_club_id uuid,p_start date,p_end date,p_game text,p_stakes text,p_search text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  IF UPPER(COALESCE(NULLIF(p_game,''),'ALL')) <> 'ALL'
     OR UPPER(COALESCE(NULLIF(p_stakes,''),'ALL')) <> 'ALL'
     OR NULLIF(btrim(COALESCE(p_search,'')),'') IS NOT NULL THEN
    RETURN public.fn_ca_club_game_summary_filtered(
      p_club_id,p_start,p_end,p_game,p_stakes,p_search
    );
  END IF;

  SELECT jsonb_build_object(
    'games',COALESCE(c.games,0)+COALESCE(t.games,0),
    'total_winnings',round(COALESCE(c.winnings,0)+COALESCE(t.winnings,0),2),
    'mtt_winnings',round(COALESCE(t.winnings,0),2),
    'cash_winnings',round(COALESCE(c.winnings,0),2),
    'fee',round(COALESCE(c.fee,0)+COALESCE(t.fee,0),2),
    'cash_fee',round(COALESCE(c.fee,0),2),
    'mtt_fee',round(COALESCE(t.fee,0),2),
    'hands',COALESCE(c.hands,0))
    INTO v_out
    FROM (
      SELECT count(DISTINCT d.table_id)::bigint games,
             COALESCE(sum(d.rake),0) fee,COALESCE(sum(d.net),0) winnings,
             COALESCE(sum(d.hands),0)::bigint hands
        FROM public.club_table_daily d
       WHERE d.club_id=p_club_id AND d.stat_date BETWEEN p_start AND p_end
    ) c
    CROSS JOIN (
      SELECT count(DISTINCT d.tournament_id)::bigint games,
             COALESCE(sum(d.fee),0) fee,COALESCE(sum(d.winnings),0) winnings
        FROM public.ca_club_tournament_daily d
       WHERE d.club_id=p_club_id AND d.stat_date BETWEEN p_start AND p_end
    ) t;
  RETURN v_out;
END;
$function$;

ALTER FUNCTION public.fn_ca_club_game_rows(uuid,date,date,text,text,text,integer)
  RENAME TO fn_ca_club_game_rows_filtered;

CREATE OR REPLACE FUNCTION public.fn_ca_club_game_rows(
  p_club_id uuid,p_start date,p_end date,p_game text,p_stakes text,p_search text,
  p_limit integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  IF UPPER(COALESCE(NULLIF(p_game,''),'ALL')) <> 'ALL'
     OR UPPER(COALESCE(NULLIF(p_stakes,''),'ALL')) <> 'ALL'
     OR NULLIF(btrim(COALESCE(p_search,'')),'') IS NOT NULL THEN
    RETURN public.fn_ca_club_game_rows_filtered(
      p_club_id,p_start,p_end,p_game,p_stakes,p_search,p_limit
    );
  END IF;

  EXECUTE $query$
    WITH recent_cash_ids AS MATERIALIZED (
      SELECT tb.id
        FROM public.tables tb
       WHERE EXISTS (
         SELECT 1 FROM public.club_table_daily d
          WHERE d.club_id=$1 AND d.table_id=tb.id
            AND d.stat_date BETWEEN $2 AND $3
       )
       ORDER BY tb.created_at DESC NULLS LAST,tb.id DESC
       LIMIT $4
    ), cash AS MATERIALIZED (
      SELECT tb.id,COALESCE(tb.name,'Unnamed') name,
             UPPER(COALESCE(tb.game_variant,'nlh')) variant,
             CASE WHEN COALESCE(tb.game_variant,'') ILIKE '%plo%'
                        OR COALESCE(tb.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                  WHEN COALESCE(tb.game_variant,'') ILIKE '%mixed%'
                        OR COALESCE(tb.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                  ELSE 'HOLDEM' END game_class,
             CASE WHEN COALESCE(tb.big_blind,0)<1 THEN 'MICRO'
                  WHEN COALESCE(tb.big_blind,0)<5 THEN 'SMALL'
                  WHEN COALESCE(tb.big_blind,0)<25 THEN 'MID' ELSE 'HIGH' END stakes_tier,
             COALESCE(tb.small_blind,0) small_blind,
             COALESCE(tb.big_blind,0) big_blind,
             CASE WHEN COALESCE(tb.rake_percent,-1)>=0 THEN tb.rake_percent END rake_percent,
             tb.created_at started_at,tb.created_by,tb.status,
             round(sum(d.rake),2) fee,round(sum(d.net),2) winnings,
             sum(d.hands)::bigint hands,max(d.players)::integer players
        FROM recent_cash_ids r
        JOIN public.tables tb ON tb.id=r.id
        JOIN public.club_table_daily d ON d.club_id=$1 AND d.table_id=r.id
          AND d.stat_date BETWEEN $2 AND $3
       GROUP BY tb.id,tb.name,tb.game_variant,tb.game_mode,tb.big_blind,
                tb.small_blind,tb.rake_percent,tb.created_at,tb.created_by,tb.status
    ), recent_tournament_ids AS MATERIALIZED (
      SELECT tr.id
        FROM public.tournaments tr
       WHERE EXISTS (
         SELECT 1 FROM public.ca_club_tournament_daily d
          WHERE d.club_id=$1 AND d.tournament_id=tr.id
            AND d.stat_date BETWEEN $2 AND $3
       )
       ORDER BY tr.start_time DESC NULLS LAST,tr.id DESC
       LIMIT $4
    ), tournament_facts AS MATERIALIZED (
      SELECT r.id,round(sum(d.fee),2) fee,round(sum(d.winnings),2) winnings
        FROM recent_tournament_ids r
        JOIN public.ca_club_tournament_daily d
          ON d.club_id=$1 AND d.tournament_id=r.id
         AND d.stat_date BETWEEN $2 AND $3
       GROUP BY r.id
    ), tournament_players AS MATERIALIZED (
      SELECT r.id,count(DISTINCT p.user_id)::integer players
        FROM recent_tournament_ids r
        LEFT JOIN public.ca_club_tournament_player_daily p
          ON p.club_id=$1 AND p.tournament_id=r.id
         AND p.stat_date BETWEEN $2 AND $3
       GROUP BY r.id
    ), all_rows AS (
      SELECT 'CASH'::text kind,c.id::text id,c.name,c.variant,c.game_class,
             c.stakes_tier,c.small_blind,c.big_blind,c.rake_percent,c.started_at,
             c.created_by,c.status,c.fee,c.winnings,c.hands,c.players,
             COALESCE(pr.username,'') creator_name,pr.avatar_url creator_avatar
        FROM cash c LEFT JOIN public.profiles pr ON pr.id=c.created_by
      UNION ALL
      SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,
             tr.id::text,COALESCE(tr.name,'Tournament'),
             UPPER(COALESCE(tr.variant,tr.game_type,'nlh')),
             CASE WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,
             'NA',0::numeric,0::numeric,NULL::numeric,tr.start_time,NULL::uuid,
             tr.status,f.fee,f.winnings,0::bigint,COALESCE(tp.players,0),
             ''::text,NULL::text
        FROM tournament_facts f
        JOIN public.tournaments tr ON tr.id=f.id
        LEFT JOIN tournament_players tp ON tp.id=f.id
    ), bounded AS MATERIALIZED (
      SELECT * FROM all_rows r
       ORDER BY r.started_at DESC NULLS LAST,r.kind DESC,r.id DESC
       LIMIT $4
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
      'hands',q.hands,'players',q.players)
      ORDER BY q.started_at DESC NULLS LAST,q.kind DESC,q.id DESC),'[]'::jsonb)
      FROM bounded q
  $query$ INTO v_out USING p_club_id,p_start,p_end,p_limit;
  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_game_summary_filtered(uuid,date,date,text,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_club_game_rows_filtered(uuid,date,date,text,text,text,integer)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_club_game_summary(uuid,date,date,text,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_club_game_rows(uuid,date,date,text,text,text,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_game_summary_filtered(uuid,date,date,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_game_rows_filtered(uuid,date,date,text,text,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_game_summary(uuid,date,date,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_game_rows(uuid,date,date,text,text,text,integer)
  TO service_role;

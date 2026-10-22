CREATE OR REPLACE FUNCTION public.ca_club_game_export_start(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'recent'::text, p_request_id uuid DEFAULT gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end,v_today),v_today);
  v_start date := COALESCE(p_start,v_end-13);
  v_game text := UPPER(COALESCE(NULLIF(p_game,''),'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'));
  v_search text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := LOWER(COALESCE(NULLIF(p_sort,''),'recent'));
  v_request uuid := COALESCE(p_request_id,gen_random_uuid());
  v_export_id uuid;
  v_total integer;
BEGIN
  IF v_user IS NULL OR NOT public.ca_can_view_whole_club_report(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501';
  END IF;
  IF v_start < v_end-92 THEN v_start := v_end-92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_sort NOT IN ('recent','fee','winnings','hands') THEN v_sort := 'recent'; END IF;

  -- A retried HTTP request must resume the same immutable export, not create a
  -- second 43k-row copy. The advisory lock serializes that tiny idempotency key.
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('ca-club-data-export-user:' || v_user::text, 0)
  ) THEN
    RAISE EXCEPTION 'Another Club Data export is already being prepared.'
      USING ERRCODE = '55000';
  END IF;
  -- Expiry is owned by the doors: the caller's own slot below, then the bounded prune at the end of this call.
  SELECT id,total_rows INTO v_export_id,v_total
    FROM public.ca_club_data_exports
   WHERE user_id = v_user AND request_id = v_request AND status = 'ready'
     AND expires_at >= now() AND kind = 'games';
  -- A request id replays only a job of this door's own kind. The same id
  -- held by a live job of another kind is a different request: refused,
  -- never replayed as this kind and never rebuilt over it.
  IF v_export_id IS NULL AND EXISTS (
    SELECT 1
      FROM public.ca_club_data_exports other_kind
     WHERE other_kind.user_id = v_user
       AND other_kind.request_id = v_request
       AND other_kind.kind <> 'games'
       AND other_kind.expires_at >= now()
  ) THEN
    RAISE EXCEPTION 'Club Data request id was already used for different inputs'
      USING ERRCODE = '22023';
  END IF;
  IF v_export_id IS NOT NULL THEN
    RETURN jsonb_build_object('export_id',v_export_id,'total_rows',v_total,'status','ready');
  END IF;

  -- The expired job owned by the caller is reclaimed first, and never behind
  -- the shared prune's try-lock: an owner whose previous export lost its
  -- cleanup must not be locked out of the next one. Bounded to one export
  -- (50,000 rows exceeds anything a door can prepare); SKIP LOCKED so a
  -- prune retiring the same parent from another session is never waited on.
  DELETE FROM public.ca_club_data_export_rows own_row
   USING (
     SELECT stale_row.export_id, stale_row.ordinal
       FROM public.ca_club_data_export_rows stale_row
       JOIN public.ca_club_data_exports expired_slot
         ON expired_slot.id = stale_row.export_id
      WHERE expired_slot.user_id = v_user
        AND expired_slot.expires_at < now()
      ORDER BY stale_row.export_id, stale_row.ordinal
      LIMIT 50000
      FOR UPDATE OF stale_row SKIP LOCKED
   ) doomed
   WHERE own_row.export_id = doomed.export_id
     AND own_row.ordinal = doomed.ordinal;

  DELETE FROM public.ca_club_data_exports expired_slot
   USING (
     SELECT reclaimable.id
       FROM public.ca_club_data_exports reclaimable
      WHERE reclaimable.user_id = v_user
        AND reclaimable.expires_at < now()
      FOR UPDATE SKIP LOCKED
   ) reclaimed
   WHERE expired_slot.id = reclaimed.id
     AND NOT EXISTS (
       SELECT 1
         FROM public.ca_club_data_export_rows export_row
        WHERE export_row.export_id = expired_slot.id
     );

  IF EXISTS (
    SELECT 1
      FROM public.ca_club_data_exports active_slot
     WHERE active_slot.user_id = v_user
  ) THEN
    RAISE EXCEPTION 'Another Club Data export is already being prepared, downloaded, or cleaned up.'
      USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.ca_club_data_exports(user_id,club_id,request_id,kind)
  VALUES(v_user,p_club_id,v_request,'games') RETURNING id INTO v_export_id;

  WITH cash AS MATERIALIZED (
    SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands)::bigint hands,
           MAX(c.players)::integer players
      FROM public.club_table_daily c
     WHERE c.club_id=p_club_id AND c.stat_date BETWEEN v_start AND v_end
     GROUP BY c.table_id
  ), tournament_facts AS MATERIALIZED (
    SELECT d.tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
      FROM public.ca_club_tournament_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.tournament_id
  ), tournament_players AS MATERIALIZED (
    SELECT p.tournament_id,count(DISTINCT p.user_id)::integer players
      FROM public.ca_club_tournament_player_daily p
     WHERE p.club_id=p_club_id AND p.stat_date BETWEEN v_start AND v_end
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
     WHERE (v_game='ALL' OR r.game_class=v_game)
       AND (v_stakes='ALL' OR r.stakes_tier=v_stakes)
       AND (v_search IS NULL OR r.name ILIKE '%'||v_search||'%' OR r.id ILIKE '%'||v_search||'%'
            OR r.creator_name ILIKE '%'||v_search||'%')
  ), scored AS (
    SELECT f.*,
           CASE v_sort WHEN 'fee' THEN f.fee WHEN 'winnings' THEN f.winnings
                       WHEN 'hands' THEN f.hands::numeric
                       ELSE extract(epoch FROM COALESCE(f.started_at,'0001-01-01'::timestamptz))::numeric
            END sort_value,
           extract(epoch FROM COALESCE(f.started_at,'0001-01-01'::timestamptz))::numeric sort_time
      FROM filtered f
  ), ordered AS (
    SELECT row_number() OVER (
             ORDER BY sort_value DESC,sort_time DESC,kind DESC,id DESC
           )::integer ordinal,
           jsonb_build_object(
             'kind',kind,'id',id,'name',name,'variant',variant,
             'game_class',game_class,'stakes_tier',stakes_tier,
             'blinds',CASE WHEN big_blind>0 THEN
               trim(trailing '.' from trim(trailing '0' from small_blind::text))||'/'||
               trim(trailing '.' from trim(trailing '0' from big_blind::text)) END,
             'rake_percent',rake_percent,'started_at',started_at,'status',status,
             'creator_id',created_by,'creator_name',NULLIF(creator_name,''),
             'creator_avatar',creator_avatar,
             'fee',fee,'winnings',winnings,'hands',hands,'players',players
           ) payload
      FROM scored
  )
  INSERT INTO public.ca_club_data_export_rows(export_id,ordinal,payload)
  SELECT v_export_id,ordinal,payload FROM ordered;

  GET DIAGNOSTICS v_total = ROW_COUNT;
  UPDATE public.ca_club_data_exports
     SET total_rows=v_total,status='ready'
   WHERE id=v_export_id;

  -- Somebody else's stranded expired job, if any: bounded, non-blocking,
  -- and last, so the row locks it takes are held only until this commit.
  PERFORM public.ca_prune_expired_club_data_exports(2000);
  RETURN jsonb_build_object('export_id',v_export_id,'total_rows',v_total,'status','ready');
END;
$function$;
REVOKE ALL ON FUNCTION public.ca_club_game_export_start(uuid,date,date,text,text,text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_game_export_start(uuid,date,date,text,text,text,text,uuid) TO authenticated,service_role;

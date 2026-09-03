-- Club Data phase 3: exact, immutable, cancellable exports.
--
-- The interactive page is deliberately bounded. Reusing its 200-row cursor
-- RPC for a 43k-row CSV would rebuild the same expensive reporting relation
-- hundreds of times and could mix rows from different moments. An export is
-- instead materialized once under the requesting operator, read in cheap
-- ordinal pages, and deleted on cancel or after fifteen minutes.

CREATE TABLE IF NOT EXISTS public.ca_club_data_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  club_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('games','players')),
  total_rows integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','ready')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  UNIQUE (user_id, request_id)
);

CREATE TABLE IF NOT EXISTS public.ca_club_data_export_rows (
  export_id uuid NOT NULL REFERENCES public.ca_club_data_exports(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (export_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_ca_club_data_exports_expiry
  ON public.ca_club_data_exports(expires_at);

ALTER TABLE public.ca_club_data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_club_data_export_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_club_data_exports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ca_club_data_export_rows FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ca_club_game_export_start(
  p_club_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_game text DEFAULT 'ALL'::text,
  p_stakes text DEFAULT 'ALL'::text,
  p_search text DEFAULT NULL::text,
  p_sort text DEFAULT 'recent'::text,
  p_request_id uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
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
  IF v_user IS NULL OR NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501';
  END IF;
  IF v_start < v_end-92 THEN v_start := v_end-92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_sort NOT IN ('recent','fee','winnings','hands') THEN v_sort := 'recent'; END IF;

  -- A retried HTTP request must resume the same immutable export, not create a
  -- second 43k-row copy. The advisory lock serializes that tiny idempotency key.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text||':'||v_request::text,0));
  DELETE FROM public.ca_club_data_exports WHERE expires_at < now();
  SELECT id,total_rows INTO v_export_id,v_total
    FROM public.ca_club_data_exports
   WHERE user_id=v_user AND request_id=v_request AND status='ready';
  IF v_export_id IS NOT NULL THEN
    RETURN jsonb_build_object('export_id',v_export_id,'total_rows',v_total,'status','ready');
  END IF;

  DELETE FROM public.ca_club_data_exports
   WHERE user_id=v_user AND request_id=v_request;
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
  RETURN jsonb_build_object('export_id',v_export_id,'total_rows',v_total,'status','ready');
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_player_export_start(
  p_club_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_sort text DEFAULT 'winners'::text,
  p_request_id uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end,v_today),v_today);
  v_start date := COALESCE(p_start,v_end-13);
  v_sort text := LOWER(COALESCE(NULLIF(p_sort,''),'winners'));
  v_request uuid := COALESCE(p_request_id,gen_random_uuid());
  v_union uuid;
  v_export_id uuid;
  v_total integer;
BEGIN
  IF v_user IS NULL OR NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501';
  END IF;
  IF v_start < v_end-92 THEN v_start := v_end-92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_sort NOT IN ('winners','losers','rake','hands') THEN v_sort := 'winners'; END IF;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc
   WHERE uc.club_id=p_club_id LIMIT 1;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text||':'||v_request::text,0));
  DELETE FROM public.ca_club_data_exports WHERE expires_at < now();
  SELECT id,total_rows INTO v_export_id,v_total
    FROM public.ca_club_data_exports
   WHERE user_id=v_user AND request_id=v_request AND status='ready';
  IF v_export_id IS NOT NULL THEN
    RETURN jsonb_build_object('export_id',v_export_id,'total_rows',v_total,'status','ready');
  END IF;
  DELETE FROM public.ca_club_data_exports
   WHERE user_id=v_user AND request_id=v_request;
  INSERT INTO public.ca_club_data_exports(user_id,club_id,request_id,kind)
  VALUES(v_user,p_club_id,v_request,'players') RETURNING id INTO v_export_id;

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
  ), scored AS (
    SELECT m.*,CASE v_sort WHEN 'losers' THEN -m.net WHEN 'rake' THEN m.rake
                           WHEN 'hands' THEN m.hands::numeric ELSE m.net END sort_value
      FROM merged m
  ), ordered AS (
    SELECT row_number() OVER (ORDER BY sort_value DESC,user_id::text DESC)::integer ordinal,
           jsonb_build_object(
             'user_id',user_id,'username',username,'avatar_url',avatar_url,
             'is_horse',is_horse,'net',net,'cash_net',cash_net,
             'tournament_net',tournament_net,'rake',rake,'hands',hands
           ) payload
      FROM scored
  )
  INSERT INTO public.ca_club_data_export_rows(export_id,ordinal,payload)
  SELECT v_export_id,ordinal,payload FROM ordered;

  GET DIAGNOSTICS v_total = ROW_COUNT;
  UPDATE public.ca_club_data_exports
     SET total_rows=v_total,status='ready'
   WHERE id=v_export_id;
  RETURN jsonb_build_object('export_id',v_export_id,'total_rows',v_total,'status','ready');
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_data_export_page(
  p_export_id uuid,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_job public.ca_club_data_exports%ROWTYPE;
  v_offset integer := GREATEST(COALESCE(p_offset,0),0);
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit,1000),2000),1);
  v_rows jsonb;
BEGIN
  SELECT * INTO v_job FROM public.ca_club_data_exports
   WHERE id=p_export_id AND user_id=v_user AND expires_at>=now();
  IF v_job.id IS NULL OR NOT public.ca_can_view_club_finances(v_job.club_id) THEN
    RAISE EXCEPTION 'export not found or no longer authorized' USING ERRCODE='42501';
  END IF;
  SELECT COALESCE(jsonb_agg(r.payload ORDER BY r.ordinal),'[]'::jsonb)
    INTO v_rows
    FROM public.ca_club_data_export_rows r
   WHERE r.export_id=p_export_id
     AND r.ordinal>v_offset AND r.ordinal<=v_offset+v_limit;
  RETURN jsonb_build_object(
    'rows',v_rows,
    'total_rows',v_job.total_rows,
    'next_offset',LEAST(v_offset+jsonb_array_length(v_rows),v_job.total_rows),
    'has_more',v_offset+jsonb_array_length(v_rows)<v_job.total_rows,
    'expires_at',v_job.expires_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_data_export_cancel(p_export_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM public.ca_club_data_exports
   WHERE id=p_export_id AND user_id=auth.uid();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted=1;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_game_export_start(uuid,date,date,text,text,text,text,uuid)
  FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_player_export_start(uuid,date,date,text,uuid)
  FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_data_export_page(uuid,integer,integer)
  FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ca_club_data_export_cancel(uuid)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_game_export_start(uuid,date,date,text,text,text,text,uuid)
  TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_player_export_start(uuid,date,date,text,uuid)
  TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_data_export_page(uuid,integer,integer)
  TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_data_export_cancel(uuid)
  TO authenticated,service_role;

COMMENT ON TABLE public.ca_club_data_exports IS
  'Short-lived immutable Club Data CSV jobs. Direct access is denied; authorized RPCs own every read and delete.';
COMMENT ON TABLE public.ca_club_data_export_rows IS
  'Ordered payload rows for a short-lived Club Data export; cascades when the owning job expires or is cancelled.';

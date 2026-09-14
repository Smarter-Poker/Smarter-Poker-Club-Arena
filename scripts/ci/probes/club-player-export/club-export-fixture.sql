CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
CREATE TABLE profiles(id uuid PRIMARY KEY,role text,is_admin boolean,is_horse boolean,alias text,username text,display_name text,first_name text,last_name text,full_name text,avatar_url text);
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid);
CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text,joined_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE TABLE union_clubs(union_id uuid,club_id uuid UNIQUE);
CREATE TABLE ca_club_player_daily(club_id uuid,user_id uuid,stat_date date,cash_net numeric,tournament_net numeric);
CREATE TABLE union_rake_paid_daily_user(union_id uuid,user_id uuid,day date,rake_amount numeric);
CREATE TABLE club_rake_daily_user(club_id uuid,user_id uuid,day date,rake_amount numeric,hands bigint DEFAULT 0,computed_at timestamptz DEFAULT now(),PRIMARY KEY(club_id,day,user_id));
CREATE TABLE club_member_daily_stats(club_id uuid,user_id uuid,stat_date date,hands_played bigint);
CREATE TABLE ca_club_data_exports(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,club_id uuid NOT NULL,request_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('games','players')),total_rows integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'preparing' CHECK(status IN('preparing','ready')),created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',UNIQUE(user_id,request_id));
CREATE TABLE ca_club_data_export_rows(export_id uuid NOT NULL REFERENCES ca_club_data_exports(id) ON DELETE CASCADE,ordinal integer NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(export_id,ordinal));
CREATE INDEX idx_ca_club_data_exports_expiry ON ca_club_data_exports(expires_at);
ALTER TABLE ca_club_data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE ca_club_data_export_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.fn_arena_name(p_alias text, p_username text, p_display_name text, p_first_name text, p_last_name text, p_full_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH real_name AS (
    SELECT COALESCE(
             NULLIF(btrim(p_full_name), ''),
             NULLIF(btrim(concat_ws(' ',
               NULLIF(btrim(p_first_name), ''),
               NULLIF(btrim(p_last_name),  ''))), '')
           ) AS rn
  )
  SELECT COALESCE(
           NULLIF(btrim(p_alias), ''),
           NULLIF(btrim(p_username), ''),
           CASE
             WHEN NULLIF(btrim(p_display_name), '') IS NOT NULL
              AND (SELECT rn FROM real_name) IS NOT NULL
              AND lower(btrim(p_display_name)) = lower((SELECT rn FROM real_name))
             THEN NULL
             ELSE NULLIF(btrim(p_display_name), '')
           END,
           'Player')
$function$;
REVOKE ALL ON FUNCTION public.fn_arena_name(text,text,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_arena_name(text,text,text,text,text,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_is_platform_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  RETURN v_role IN ('admin', 'superadmin', 'god');
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_is_platform_admin() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_is_platform_admin() TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.ca_can_view_club_finances(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    session_user IN ('postgres', 'supabase_admin')
    OR coalesce(auth.role(), '') = 'service_role'
    OR (
      auth.uid() IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM club_members cm
           WHERE cm.club_id = p_club_id
             AND cm.user_id = auth.uid()
             AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
             AND cm.role IN ('owner', 'co_owner', 'admin', 'super_agent')
        )
        OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())
        OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND coalesce(pr.is_admin, false))
      )
    );
$function$;
REVOKE ALL ON FUNCTION public.ca_can_view_club_finances(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_can_view_club_finances(uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.ca_club_data_export_page(p_export_id uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_job public.ca_club_data_exports%ROWTYPE;
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit, 1000), 2000), 1);
  v_rows jsonb;
BEGIN
  SELECT *
    INTO v_job
    FROM public.ca_club_data_exports
   WHERE id = p_export_id
     AND user_id = v_user
     AND expires_at >= now();

  IF v_job.id IS NULL OR NOT public.ca_can_view_club_finances(v_job.club_id) THEN
    RAISE EXCEPTION 'export not found or no longer authorized' USING ERRCODE = '42501';
  END IF;

  -- A player job prepared while this viewer was entitled can contain facts a
  -- super agent may not know. Recheck before EVERY page; if a later page sees
  -- the downgrade, fetchClubDataExport discards every earlier page and never
  -- hands a mixed result to the downloader.
  IF v_job.kind = 'players'
     AND NOT COALESCE(public.fn_can_see_horse_flag(v_job.club_id), false)
     AND EXISTS (
       SELECT 1
         FROM public.ca_club_data_export_rows sensitive
        WHERE sensitive.export_id = p_export_id
          AND sensitive.payload @> '{"is_horse": true}'::jsonb
     ) THEN
    RAISE EXCEPTION 'player export permissions changed; prepare a new export'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(jsonb_agg(r.payload ORDER BY r.ordinal), '[]'::jsonb)
    INTO v_rows
    FROM public.ca_club_data_export_rows r
   WHERE r.export_id = p_export_id
     AND r.ordinal > v_offset
     AND r.ordinal <= v_offset + v_limit;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total_rows', v_job.total_rows,
    'next_offset', LEAST(v_offset + jsonb_array_length(v_rows), v_job.total_rows),
    'has_more', v_offset + jsonb_array_length(v_rows) < v_job.total_rows,
    'expires_at', v_job.expires_at
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.ca_club_data_export_page(uuid,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_data_export_page(uuid,integer,integer) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.ca_club_player_export_start(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_sort text DEFAULT 'winners'::text, p_request_id uuid DEFAULT gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
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
    SELECT a.user_id,COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name),pr.username,'Player') username,
           pr.avatar_url,(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false)) is_horse,
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
REVOKE ALL ON FUNCTION public.ca_club_player_export_start(uuid,date,date,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_player_export_start(uuid,date,date,text,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.ca_club_player_page(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_sort text DEFAULT 'winners'::text, p_search text DEFAULT NULL::text, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
     WHERE v_union IS NOT NULL AND u.union_id=v_union AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
    UNION ALL
    SELECT c.user_id,SUM(c.rake_amount)
      FROM public.club_rake_daily_user c JOIN att_club a ON a.user_id=c.user_id
     WHERE v_union IS NULL AND c.club_id=p_club_id AND c.day BETWEEN v_start AND v_end GROUP BY c.user_id
  ), hands AS (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s JOIN att_club a ON a.user_id=s.user_id
     WHERE s.club_id=p_club_id AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
  ), merged AS MATERIALIZED (
    SELECT a.user_id,COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name),pr.username,'Player') username,
           pr.avatar_url,(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false)) is_horse,
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
REVOKE ALL ON FUNCTION public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_can_see_horse_flag(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    public.fn_is_platform_admin(),
    false
  ) OR EXISTS (
    SELECT 1 FROM public.club_members cm
    WHERE cm.club_id = p_club_id
      AND cm.user_id = auth.uid()
      AND COALESCE(cm.status,'active') IN ('active','approved')
      AND cm.role IN ('owner','co_owner','admin')
  );
$function$;
REVOKE ALL ON FUNCTION public.fn_can_see_horse_flag(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_can_see_horse_flag(uuid) TO authenticated,service_role;

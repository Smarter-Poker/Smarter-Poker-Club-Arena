-- Standalone player exports must use the same scoped rake branch as the player page.
-- This changes a reporting reader only; no financial source rows are rewritten.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$
DECLARE p pg_proc%ROWTYPE;
BEGIN
 SELECT * INTO STRICT p FROM pg_proc WHERE oid='public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure;
 IF md5(pg_get_functiondef(p.oid)) NOT IN ('b95e25b503dfec870986fb5f4cc8037f','563881446c064edd64de3b9013711726')
    OR NOT p.prosecdef OR pg_get_userbyid(p.proowner)<>'postgres'
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public','statement_timeout=120s']
    OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
  RAISE EXCEPTION 'Player export definition or authority drifted; review the current preimage';
 END IF;
END
$guard$;
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
DO $verify$
BEGIN
 IF md5(pg_get_functiondef('public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure)) <> '563881446c064edd64de3b9013711726' THEN
  RAISE EXCEPTION 'Player export postimage mismatch';
 END IF;
END
$verify$;
COMMIT;

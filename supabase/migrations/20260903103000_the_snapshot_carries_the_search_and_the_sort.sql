-- THE SNAPSHOT CARRIES THE SEARCH AND THE SORT.
--
-- The panel calls exactly one RPC, so search and sort have to travel through
-- it to reach the helper that does the work.
--
-- They come back as applied_search and applied_sort, and that echo is the
-- point: the client can then tell "the server ran my search and three rows
-- matched" apart from "the server ignored a parameter it did not understand
-- and returned everything". A UI that shows a Sort control the server is
-- quietly disregarding is worse than one with no control at all.
--
-- Which is why the fallback happens HERE, before the helper is called, and
-- the NORMALISED value is what gets echoed. An earlier cut passed the raw
-- string through and echoed it back untouched: asking for a sort that does
-- not exist got rake ordering and a payload claiming the nonsense sort had
-- been applied. The whitelists differ by list - only the agent breakdown has
-- a cost or a player count to sort on - so each branch normalises to its own.
--
-- The eight-argument version is dropped rather than left beside this one.
-- Both take defaults for every parameter, so an eight-argument call would
-- match both and Postgres would refuse it as ambiguous: the exact failure
-- that broke every call the first time paging added a parameter.

CREATE OR REPLACE FUNCTION public.ca_rake_snapshot(
  p_scope text DEFAULT 'club', p_club_id uuid DEFAULT NULL, p_union_id uuid DEFAULT NULL,
  p_start date DEFAULT NULL, p_end date DEFAULT NULL, p_agent_user_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50, p_offset integer DEFAULT 0,
  p_search text DEFAULT NULL, p_sort text DEFAULT 'rake'
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_scope text := lower(COALESCE(NULLIF(btrim(p_scope),''),'club'));
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end - 6);
  v_off int := GREATEST(COALESCE(p_offset,0),0);
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort),''),'rake'));
  v_days int; v_pstart date; v_pend date; v_bucket text;
  v_union uuid; v_clubs uuid[];
  v_cur jsonb; v_prev jsonb; v_series jsonb;
  v_pack jsonb := jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0);
  v_kind text := 'none'; v_label text;
  v_agent jsonb; v_agent_p jsonb; v_live boolean := false;
BEGIN
  IF v_scope NOT IN ('club','union','agent') THEN
    RAISE EXCEPTION 'unknown scope %', v_scope USING ERRCODE='22023'; END IF;
  IF v_start < v_end - 730 THEN v_start := v_end - 730; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  v_days := (v_end - v_start) + 1; v_pend := v_start - 1; v_pstart := v_pend - (v_days - 1);
  v_bucket := CASE WHEN v_days <= 62 THEN 'day' WHEN v_days <= 400 THEN 'week' ELSE 'month' END;

  IF v_scope = 'agent' THEN
    IF p_club_id IS NULL THEN RAISE EXCEPTION 'agent scope needs a club' USING ERRCODE='22023'; END IF;
    v_agent := public.fn_agent_downline_rake_summary(p_agent_user_id, p_club_id,
      (v_start::timestamp AT TIME ZONE 'UTC'), ((v_end+1)::timestamp AT TIME ZONE 'UTC'));
    v_agent_p := public.fn_agent_downline_rake_summary(p_agent_user_id, p_club_id,
      (v_pstart::timestamp AT TIME ZONE 'UTC'), ((v_pend+1)::timestamp AT TIME ZONE 'UTC'));
    IF v_sort NOT IN ('rake','name','hands') THEN v_sort := 'rake'; END IF;
    v_pack := public.fn_ca_rake_by_downline(p_agent_user_id, p_club_id,
      (v_start::timestamp AT TIME ZONE 'UTC'), ((v_end+1)::timestamp AT TIME ZONE 'UTC'),
      p_limit, v_off, v_q, v_sort);
    SELECT COALESCE(c.name,'Club') INTO v_label FROM public.clubs c WHERE c.id = p_club_id;
    RETURN jsonb_build_object(
      'scope','agent','scope_label',COALESCE(v_label,'Downline'),'club_id',p_club_id,
      'union_id',NULL,'agent_user_id',p_agent_user_id,
      'range',jsonb_build_object('start',v_start,'end',v_end,'days',v_days),
      'previous_range',jsonb_build_object('start',v_pstart,'end',v_pend,'days',v_days),
      'summary',jsonb_build_object(
        'fee',round(COALESCE((v_agent->>'rake_generated')::numeric,0),2),
        'cash_fee',NULL,'mtt_fee',NULL,'games',NULL,
        'hands',COALESCE((v_agent->>'hands')::bigint,0),
        'total_winnings',NULL,'mtt_winnings',NULL,
        'members',COALESCE((v_agent->>'members')::int,0),
        'active',COALESCE((v_agent->>'active')::int,0),
        'commission_rate',(v_agent->>'commission_rate')::numeric,
        'estimated_commission',round(COALESCE((v_agent->>'estimated_commission')::numeric,0),2)),
      'previous',jsonb_build_object('fee',round(COALESCE((v_agent_p->>'rake_generated')::numeric,0),2),
        'hands',COALESCE((v_agent_p->>'hands')::bigint,0)),
      'delta',jsonb_build_object(
        'fee_pct',CASE WHEN COALESCE((v_agent_p->>'rake_generated')::numeric,0)=0 THEN NULL
          ELSE round((COALESCE((v_agent->>'rake_generated')::numeric,0)-(v_agent_p->>'rake_generated')::numeric)
               /abs((v_agent_p->>'rake_generated')::numeric)*100,1) END,
        'fee_abs',round(COALESCE((v_agent->>'rake_generated')::numeric,0)-COALESCE((v_agent_p->>'rake_generated')::numeric,0),2),
        'games_pct',NULL,'winnings_abs',NULL),
      'series','[]'::jsonb,'series_bucket',v_bucket,
      'breakdown',v_pack->'rows','breakdown_kind','downline',
      'breakdown_total',(v_pack->>'total_direct')::numeric,
      'breakdown_count',(v_pack->>'total')::int,
      'breakdown_offset',v_off,'commission_total',(v_pack->>'total_commission')::numeric,
      'breakdown_live',true,'rake_complete_through',NULL,
      'applied_search',v_q,'applied_sort',v_sort,
      'top_earner',v_agent->'top_earner','generated_at',now());
  END IF;

  IF v_scope = 'union' THEN
    v_union := p_union_id;
    IF v_union IS NULL AND p_club_id IS NOT NULL THEN
      SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1; END IF;
    IF v_union IS NULL THEN RAISE EXCEPTION 'no union for this context' USING ERRCODE='22023'; END IF;
    IF NOT public.ca_can_oversee_union(v_union) THEN
      RAISE EXCEPTION 'not authorized for this union' USING ERRCODE='42501'; END IF;
    SELECT ARRAY(SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=v_union) INTO v_clubs;
    SELECT u.name INTO v_label FROM public.unions u WHERE u.id=v_union;
    IF v_sort NOT IN ('rake','name','hands') THEN v_sort := 'rake'; END IF;
    v_pack := public.fn_ca_rake_by_club(v_clubs, v_start, v_end, p_limit, v_off, v_q, v_sort);
    v_kind := 'club'; v_live := false;
  ELSE
    IF p_club_id IS NULL THEN RAISE EXCEPTION 'club scope needs a club' USING ERRCODE='22023'; END IF;
    IF NOT public.ca_can_view_club_finances(p_club_id) THEN
      RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
    v_clubs := ARRAY[p_club_id];
    SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
    SELECT c.name INTO v_label FROM public.clubs c WHERE c.id=p_club_id;
    IF v_sort NOT IN ('rake','name','cost','players') THEN v_sort := 'rake'; END IF;
    v_pack := public.fn_ca_rake_by_agent(p_club_id, v_start, v_end, p_limit, v_off, v_q, v_sort);
    v_kind := 'agent'; v_live := true;
  END IF;

  IF v_clubs IS NULL OR array_length(v_clubs,1) IS NULL THEN v_clubs := ARRAY[]::uuid[]; END IF;

  v_cur := public.fn_ca_rake_window(v_clubs, v_start, v_end);
  v_prev := public.fn_ca_rake_window(v_clubs, v_pstart, v_pend);
  v_series := public.fn_ca_rake_series(v_clubs, v_start, v_end, v_bucket);

  RETURN jsonb_build_object(
    'scope',v_scope,'scope_label',COALESCE(v_label,initcap(v_scope)),
    'club_id',p_club_id,'union_id',v_union,'club_count',array_length(v_clubs,1),
    'range',jsonb_build_object('start',v_start,'end',v_end,'days',v_days),
    'previous_range',jsonb_build_object('start',v_pstart,'end',v_pend,'days',v_days),
    'summary',v_cur,'previous',v_prev,
    'delta',jsonb_build_object(
      'fee_pct',CASE WHEN COALESCE((v_prev->>'fee')::numeric,0)=0 THEN NULL
        ELSE round(((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric)/abs((v_prev->>'fee')::numeric)*100,1) END,
      'games_pct',CASE WHEN COALESCE((v_prev->>'games')::numeric,0)=0 THEN NULL
        ELSE round(((v_cur->>'games')::numeric-(v_prev->>'games')::numeric)/abs((v_prev->>'games')::numeric)*100,1) END,
      'fee_abs',round((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric,2),
      'winnings_abs',round((v_cur->>'total_winnings')::numeric-(v_prev->>'total_winnings')::numeric,2)),
    'series',v_series,'series_bucket',v_bucket,
    'breakdown',v_pack->'rows','breakdown_kind',v_kind,
    'breakdown_total',(v_pack->>'total_direct')::numeric,
    'breakdown_count',(v_pack->>'total')::int,
    'breakdown_offset',v_off,'commission_total',(v_pack->>'total_commission')::numeric,
    'breakdown_live',v_live,'rake_complete_through',NULL,
    'applied_search',v_q,'applied_sort',v_sort,
    'data_updated_at',GREATEST(
      (SELECT max(c.updated_at) FROM public.club_table_daily c
        WHERE c.club_id = ANY(v_clubs) AND c.stat_date BETWEEN v_start AND v_end),
      (SELECT max(d.updated_at) FROM public.ca_club_tournament_daily d
        WHERE d.club_id = ANY(v_clubs) AND d.stat_date BETWEEN v_start AND v_end)),
    'generated_at',now());
END;
$function$;

DROP FUNCTION IF EXISTS public.ca_rake_snapshot(text, uuid, uuid, date, date, uuid, integer, integer);
REVOKE ALL ON FUNCTION public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text)
  TO authenticated, service_role;

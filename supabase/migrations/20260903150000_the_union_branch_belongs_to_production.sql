-- THE UNION BRANCH BELONGS TO PRODUCTION, NOT TO EVERY CLUB RPC.
--
-- An hour ago I added a union-overseer branch to ca_can_view_club_finances so
-- that a union lead could open a member club from the union breakdown. That
-- was the right ENTITLEMENT and the wrong PLACE.
--
-- ca_can_view_club_finances is not the rake snapshot's gate. It is the gate
-- for NINE other RPCs as well:
--
--   ca_club_data_snapshot        ca_club_player_breakdown
--   ca_club_data_export_page     ca_club_player_page
--   ca_club_game_page            ca_club_player_export_start
--   ca_club_game_export_start    ca_club_union_invoices
--   ca_club_insurance_report
--
-- So widening it did not open one row on one page. It handed every union
-- overseer the whole club data page for every member club - the game ledger,
-- the per-player breakdown, the insurance report and the CSV exports - while
-- the commit that did it described the change as opening a drill-down. On
-- this estate the difference is invisible, because its only union lead already
-- owns both member clubs; on the next union it is a silent expansion of one
-- operator's visibility into another operator's business.
--
-- The gate goes back to its four branches. The wider claim gets its own name
-- and reaches exactly two places: the club scope of the rake snapshot, and the
-- can_drill flag that has to predict it.
--
-- PRODUCTION IS NOT THE SAME CLAIM AS FINANCES. What a club produced is what a
-- union bills against and already reads in aggregate on the union page. Its
-- player list, its hands and its cost structure are not, and stay where they
-- were.
--
-- Measured after: the lead still sees two union rows, both drillable, and
-- still opens a member club; the finances gate no longer carries a union
-- branch; all nine other RPCs still sit on it unchanged; and an outsider is
-- refused by both.

-- ---------------------------------------------------- the gate, as it was ---
CREATE OR REPLACE FUNCTION public.ca_can_view_club_finances(p_club_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT
    auth.uid() IS NULL
    OR EXISTS (
      SELECT 1 FROM club_members cm
       WHERE cm.club_id = p_club_id
         AND cm.user_id = auth.uid()
         AND COALESCE(cm.status, 'active') NOT IN ('banned', 'suspended')
         AND cm.role IN ('owner', 'co_owner', 'admin', 'super_agent')
    )
    OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND COALESCE(pr.is_admin, false));
$function$;

-- ------------------------------------------ the narrower claim, by itself ---
CREATE OR REPLACE FUNCTION public.ca_can_read_club_production(p_club_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT
    public.ca_can_view_club_finances(p_club_id)
    -- Overseeing a union the club belongs to. Scoped through union_clubs, so
    -- it never reaches a club that is not in a union this caller oversees.
    OR EXISTS (
      SELECT 1 FROM union_clubs uc
       WHERE uc.club_id = p_club_id
         AND public.fn_is_union_overseer(uc.union_id, auth.uid())
    );
$function$;

REVOKE ALL ON FUNCTION public.ca_can_read_club_production(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_can_read_club_production(uuid) TO authenticated, service_role;

-- ------------------------------- the only two places the wider claim goes ---
-- Both re-declared in full rather than patched, so that the file which last
-- defines each function is the file that describes what runs.

CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_club(
  p_club_ids uuid[], p_start date, p_end date, p_limit integer,
  p_offset integer DEFAULT 0, p_search text DEFAULT NULL, p_sort text DEFAULT 'rake'
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH rows_in AS (
    SELECT c.club_id, c.rake AS fee, c.net AS winnings,
           COALESCE(c.hands,0)::bigint AS hands,
           'c:' || c.table_id::text AS gid, false AS is_mtt
      FROM public.club_table_daily c
     WHERE c.club_id = ANY (p_club_ids) AND c.stat_date BETWEEN p_start AND p_end
    UNION ALL
    SELECT t.club_id, t.fee, t.winnings, 0::bigint,
           't:' || t.tournament_id::text, true
      FROM public.ca_club_tournament_daily t
     WHERE t.club_id = ANY (p_club_ids) AND t.stat_date BETWEEN p_start AND p_end
  ), agg AS (
    SELECT r.club_id,
           round(SUM(r.fee),2) AS fee,
           round(SUM(r.fee) FILTER (WHERE r.is_mtt),2) AS mtt_fee,
           round(SUM(r.fee) FILTER (WHERE NOT r.is_mtt),2) AS cash_fee,
           round(SUM(r.winnings),2) AS winnings,
           SUM(r.hands) AS hands,
           COUNT(DISTINCT r.gid) AS games
      FROM rows_in r GROUP BY r.club_id
  ), listed AS (
    SELECT a.club_id, COALESCE(cl.name,'Club') AS name, cl.code,
           COALESCE(cl.avatar_url, cl.logo_url) AS avatar_url,
           COALESCE(a.fee,0) AS fee, COALESCE(a.cash_fee,0) AS cash_fee,
           COALESCE(a.mtt_fee,0) AS mtt_fee, COALESCE(a.winnings,0) AS winnings,
           COALESCE(a.hands,0) AS hands, a.games,
           -- The same gate the club scope enforces.
           public.ca_can_read_club_production(a.club_id) AS can_drill
      FROM agg a JOIN public.clubs cl ON cl.id = a.club_id
  ), totals AS (
    -- Before the filter, deliberately: the denominator is the whole set.
    SELECT COALESCE(SUM(l.fee),0) AS total_direct FROM listed l
  ), filtered AS (
    SELECT l.* FROM listed l
     WHERE NULLIF(btrim(COALESCE(p_search,'')),'') IS NULL
        OR l.name ILIKE '%' || public.fn_like_escape(btrim(p_search)) || '%' ESCAPE '\'
        OR COALESCE(l.code,'') ILIKE '%' || public.fn_like_escape(btrim(p_search)) || '%' ESCAPE '\'
  ), page AS (
    SELECT f.* FROM filtered f
     ORDER BY
       CASE WHEN lower(COALESCE(p_sort,'rake')) = 'name'  THEN f.name END ASC,
       CASE WHEN lower(COALESCE(p_sort,'rake')) = 'hands' THEN f.hands END DESC,
       CASE WHEN lower(COALESCE(p_sort,'rake')) NOT IN ('name','hands') THEN f.fee END DESC,
       f.name ASC
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM page p), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'total_direct', (SELECT t.total_direct FROM totals t),
    'total_commission', NULL);
$function$;

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
    IF NOT public.ca_can_read_club_production(p_club_id) THEN
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

REVOKE ALL ON FUNCTION public.fn_ca_rake_by_club(uuid[],date,date,integer,integer,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_club(uuid[],date,date,integer,integer,text,text) TO service_role;

REVOKE ALL ON FUNCTION public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text)
  TO authenticated, service_role;

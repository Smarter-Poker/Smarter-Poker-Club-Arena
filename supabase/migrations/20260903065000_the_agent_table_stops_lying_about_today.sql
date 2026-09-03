-- THE AGENT TABLE STOPS LYING ABOUT TODAY.
--
-- fn_ca_rake_by_agent read club_rake_daily_user and nothing else. That rollup
-- finalises COMPLETE UTC days, so on the period an operator uses most - Day -
-- the agent table showed 0.00 underneath a five-figure headline, because the
-- headline comes from a live table and the table under it did not. Deep Stack
-- Society on the day this was written: headline five figures, agent column
-- empty, and a gold notice explaining the emptiness rather than fixing it.
--
-- fn_agent_downline_rake already solved this and the shape is copied from it
-- rather than reinvented. club_rake_rollup_complete says which (club, day)
-- pairs are actually finished; those come from the rollup, and everything else
-- - the live tail, and any day in the middle the rollup never wrote - is read
-- from rake_records and split with fn_rake_shares_for_record, the same
-- canonical allocator the rollup itself uses. Rollup where it is trustworthy,
-- live where it is not, FULL OUTER JOINed so a player appearing in only one of
-- them is not dropped.
--
-- Head and tail are both handled even though a date-bounded window has no
-- partial head today: p_start is midnight, so the head slice is empty and the
-- expression collapses. Keeping it costs nothing and means this does not
-- quietly lose the first hours if the signature ever takes timestamps.
--
-- VERIFIED against Deep Stack Society at the time of writing: for today the
-- breakdown's direct column sums to exactly what rake_records holds for the
-- club over the same window, where the previous implementation returned
-- nothing at all.
--
-- WHAT THIS EXPOSES, and why the second function below changes with it. The
-- agent table is now current to the second. The headline beside it is
-- club_table_daily, written by club-rake-rollup-catchup on `25 * * * *`. So
-- during the hour the agent column can legitimately exceed the club total.
-- That is the inverse of the bug being fixed and just as confusing, so
-- ca_rake_snapshot now declares which side is live instead of leaving an
-- operator to discover the discrepancy and distrust both numbers.

CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_agent(
  p_club_id uuid, p_start date, p_end date, p_limit integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_now   timestamptz := now();
  v_from  timestamptz := p_start::timestamptz;
  -- Exclusive, and never the future: an end date of today must not open a
  -- window running to tomorrow midnight and scan hands that do not exist.
  v_to    timestamptz := LEAST((p_end + 1)::timestamptz, v_now);
  v_out   jsonb;
BEGIN
  IF v_to <= v_from THEN RETURN '[]'::jsonb; END IF;

  WITH RECURSIVE ok_days AS MATERIALIZED (
    -- Only a day the marker calls finished may be read from the rollup. Every
    -- other instant in the window - the partial first day, the live tail, and
    -- any day in between the rollup never wrote - is read live below.
    SELECT rc.day
      FROM public.club_rake_rollup_complete rc
     WHERE rc.club_id = p_club_id
       AND rc.day >= date_trunc('day', v_from)::date
       AND rc.day <  date_trunc('day', v_to)::date
  ), from_rollup AS (
    SELECT rd.user_id, SUM(rd.rake_amount) AS rake, SUM(rd.hands)::bigint AS hands
      FROM public.club_rake_daily_user rd
      JOIN ok_days o ON o.day = rd.day
     WHERE rd.club_id = p_club_id
     GROUP BY rd.user_id
  ), edge_hands AS MATERIALIZED (
    -- ONE range scan, not one per day. The first version of this generated a
    -- row per calendar day in the window and joined rake_records to each, so a
    -- year-long window produced 359 separate per-day scans. Anti-joining a
    -- single range against ok_days is exactly equivalent - the head, the tail
    -- and the gaps are precisely the instants NOT inside a finished day - and
    -- it rides idx_rake_records_club_created, which is partial on
    -- rake_amount > 0, the same predicate this needs.
    --
    -- The cost that remains is the per-hand allocator below, and it is bounded
    -- by how much play is NOT yet rolled up rather than by the window: a Day
    -- and a Year on the same club read the same live hands and cost the same.
    SELECT r.hand_id, r.rake_amount, r.player_contributions, r.rake_method
      FROM public.rake_records r
     WHERE r.club_id = p_club_id
       AND r.created_at >= v_from AND r.created_at < v_to
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM ok_days o
          WHERE o.day = (r.created_at AT TIME ZONE 'UTC')::date)
  ), from_live AS (
    -- Cents, then divided once. Summing rounded currency per hand and rounding
    -- again at the end is how a per-player column drifts from its own total.
    SELECT s.user_id,
           SUM(round(s.credit * 100)::bigint)::numeric / 100 AS rake,
           count(*)::bigint AS hands
      FROM edge_hands eh
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        eh.hand_id, eh.rake_amount, eh.player_contributions,
        COALESCE(eh.rake_method, 'DEALT_EQUAL')) s
     GROUP BY s.user_id
  ), earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id, b.user_id) AS user_id,
           COALESCE(a.rake, 0)  + COALESCE(b.rake, 0)  AS rake,
           COALESCE(a.hands, 0) + COALESCE(b.hands, 0) AS hands
      FROM from_rollup a
      FULL OUTER JOIN from_live b ON b.user_id = a.user_id
  ), club_agents AS (
    SELECT a.id, a.user_id, a.parent_agent_id, a.role, a.commission_rate
      FROM public.agents a
     WHERE a.club_id = p_club_id AND a.status = 'active'
  ), direct AS (
    SELECT cm.agent_id,
           COUNT(*)                                         AS players,
           COUNT(*) FILTER (WHERE COALESCE(e.rake, 0) <> 0) AS active,
           COALESCE(SUM(e.rake), 0)                         AS rake,
           COALESCE(SUM(e.hands), 0)::bigint                AS hands
      FROM public.club_members cm
      LEFT JOIN earned e ON e.user_id = cm.user_id
     WHERE cm.club_id = p_club_id
     GROUP BY cm.agent_id
  ), tree AS (
    -- parent_agent_id is a plain uuid column with no cycle constraint. One bad
    -- edge without this cap spins until the statement timeout kills the page.
    SELECT ca.id AS root_id, ca.id AS node_id, 0 AS depth FROM club_agents ca
    UNION ALL
    SELECT t.root_id, c.id, t.depth + 1
      FROM tree t JOIN club_agents c ON c.parent_agent_id = t.node_id
     WHERE t.depth < 12
  ), network AS (
    SELECT t.root_id,
           COALESCE(SUM(d.rake), 0)    AS rake,
           COALESCE(SUM(d.players), 0) AS players,
           COUNT(*) FILTER (WHERE t.node_id <> t.root_id) AS sub_agents
      FROM (SELECT DISTINCT root_id, node_id FROM tree) t
      JOIN club_agents n ON n.id = t.node_id
      LEFT JOIN direct d ON d.agent_id = n.user_id
     GROUP BY t.root_id
  ), listed AS (
    SELECT ca.user_id AS agent_user_id, COALESCE(pr.username,'Agent') AS name,
           pr.avatar_url, ca.role, ca.commission_rate,
           COALESCE(dr.players,0) AS direct_players,
           COALESCE(dr.active,0)  AS direct_active,
           round(COALESCE(dr.rake,0),2) AS direct_rake,
           COALESCE(dr.hands,0)   AS direct_hands,
           COALESCE(nw.players,0) AS network_players,
           round(COALESCE(nw.rake,0),2) AS network_rake,
           COALESCE(nw.sub_agents,0) AS sub_agents,
           false AS is_unassigned
      FROM club_agents ca
      LEFT JOIN direct  dr ON dr.agent_id = ca.user_id
      LEFT JOIN network nw ON nw.root_id  = ca.id
      LEFT JOIN public.profiles pr ON pr.id = ca.user_id
    UNION ALL
    -- Players with no agent are not nobody's rake. Dropping them makes the
    -- column sum to less than the club total with nothing saying why.
    SELECT NULL,'Unassigned',NULL,'none',NULL,
           d.players,d.active,round(d.rake,2),d.hands,
           d.players,round(d.rake,2),0,true
      FROM direct d WHERE d.agent_id IS NULL AND d.players > 0
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x.is_unassigned, x.network_rake DESC NULLS LAST),'[]'::jsonb)
    INTO v_out
    FROM (SELECT * FROM listed ORDER BY is_unassigned, network_rake DESC NULLS LAST
           LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)) x;

  RETURN COALESCE(v_out,'[]'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- ca_rake_snapshot: the club-scope breakdown now reads live, so the
-- "complete through" disclosure it carried is no longer true. It is replaced
-- by the one that IS true - breakdown_live - which the panel uses to say that
-- the agent table is current to the second while the headline beside it is an
-- hourly rollup. Union scope stays false: its per-club figures come from the
-- same rollup as the headline, so the two move together and there is nothing
-- to declare.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_rake_snapshot(
  p_scope text DEFAULT 'club'::text, p_club_id uuid DEFAULT NULL::uuid,
  p_union_id uuid DEFAULT NULL::uuid, p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date, p_agent_user_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_scope text := lower(COALESCE(NULLIF(btrim(p_scope), ''), 'club'));
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end - 6);
  v_days int; v_pstart date; v_pend date; v_bucket text;
  v_union uuid; v_clubs uuid[];
  v_cur jsonb; v_prev jsonb; v_series jsonb;
  v_break jsonb := '[]'::jsonb; v_kind text := 'none'; v_label text;
  v_agent jsonb; v_agent_p jsonb; v_btotal numeric := NULL;
  v_live boolean := false;
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
    v_break := public.fn_ca_rake_by_downline(p_agent_user_id, p_club_id,
      (v_start::timestamp AT TIME ZONE 'UTC'), ((v_end+1)::timestamp AT TIME ZONE 'UTC'), p_limit);
    SELECT COALESCE(c.name,'Club') INTO v_label FROM public.clubs c WHERE c.id = p_club_id;
    SELECT COALESCE(SUM((e->>'rake')::numeric),0) INTO v_btotal FROM jsonb_array_elements(v_break) e;
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
      'series','[]'::jsonb,'series_bucket',v_bucket,'breakdown',v_break,
      'breakdown_kind','downline','breakdown_total',v_btotal,
      'breakdown_live',true,'rake_complete_through',NULL,
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
    v_break := public.fn_ca_rake_by_club(v_clubs, v_start, v_end, p_limit);
    v_kind := 'club';
    -- Per-club figures come from the same hourly rollup as the headline, so
    -- they move together. Nothing to disclose.
    v_live := false;
  ELSE
    IF p_club_id IS NULL THEN RAISE EXCEPTION 'club scope needs a club' USING ERRCODE='22023'; END IF;
    IF NOT public.ca_can_view_club_finances(p_club_id) THEN
      RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
    v_clubs := ARRAY[p_club_id];
    SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
    SELECT c.name INTO v_label FROM public.clubs c WHERE c.id=p_club_id;
    v_break := public.fn_ca_rake_by_agent(p_club_id, v_start, v_end, p_limit);
    v_kind := 'agent';
    -- The agent table now reads the rollup for finished days and rake_records
    -- for everything after them, so it is current to the second. The headline
    -- beside it is club_table_daily, written by an hourly catch-up job. During
    -- the hour the agent column can legitimately exceed the club total, which
    -- looks like an error and is not - so it is declared rather than left to
    -- be discovered.
    v_live := true;
  END IF;

  IF v_clubs IS NULL OR array_length(v_clubs,1) IS NULL THEN v_clubs := ARRAY[]::uuid[]; END IF;

  -- DIRECT rake, never network rake: every player is assigned to exactly one
  -- agent or to none, so direct counts each player's rake once. Network
  -- deliberately double-counts up the chain.
  SELECT COALESCE(SUM(COALESCE((e->>'direct_rake')::numeric,(e->>'fee')::numeric,0)),0)
    INTO v_btotal FROM jsonb_array_elements(v_break) e;

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
    'series',v_series,'series_bucket',v_bucket,'breakdown',v_break,
    'breakdown_kind',v_kind,'breakdown_total',v_btotal,
    'breakdown_live',v_live,'rake_complete_through',NULL,
    'data_updated_at',GREATEST(
      (SELECT max(c.updated_at) FROM public.club_table_daily c
        WHERE c.club_id = ANY(v_clubs) AND c.stat_date BETWEEN v_start AND v_end),
      (SELECT max(d.updated_at) FROM public.ca_club_tournament_daily d
        WHERE d.club_id = ANY(v_clubs) AND d.stat_date BETWEEN v_start AND v_end)),
    'generated_at',now());
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer) TO authenticated, service_role;

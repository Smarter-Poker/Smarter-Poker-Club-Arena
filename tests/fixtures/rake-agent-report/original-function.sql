CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_agent(p_club_id uuid, p_start date, p_end date, p_limit integer, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now  timestamptz := now();
  v_from timestamptz := p_start::timestamptz;
  v_to   timestamptz := LEAST((p_end + 1)::timestamptz, v_now);
  v_uid  uuid    := auth.uid();
  v_cost boolean := public.fn_is_club_admin_uid(p_club_id);
  v_over boolean := EXISTS (SELECT 1 FROM public.union_clubs uc
                             WHERE uc.club_id = p_club_id
                               AND public.fn_is_union_overseer(uc.union_id, v_uid));
  v_q    text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort),''),'rake'));
  v_out  jsonb;
BEGIN
  IF v_to <= v_from THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL);
  END IF;

  WITH RECURSIVE ok_days AS MATERIALIZED (
    SELECT rc.day FROM public.club_rake_rollup_complete rc
     WHERE rc.club_id = p_club_id
       AND rc.day >= date_trunc('day', v_from)::date
       AND rc.day <  date_trunc('day', v_to)::date
  ), from_rollup AS (
    SELECT rd.user_id, SUM(rd.rake_amount) AS rake, SUM(rd.hands)::bigint AS hands
      FROM public.club_rake_daily_user rd
      JOIN ok_days o ON o.day = rd.day
     WHERE rd.club_id = p_club_id
     GROUP BY rd.user_id
  ), from_live AS (
    -- THE DAYS NOT YET SEALED, read from the incremental rollup the triggers
    -- on rake_attributions keep exact. This used to scan the attributions
    -- themselves, which is fine at 04:00 and a third of a million rows by
    -- midnight - the panel healed every morning and failed every evening.
    -- Same cents, same rounding, same source table as the sealed days.
    SELECT du.user_id,
           du.rake_cents::numeric / 100 AS rake,
           du.hands
      FROM public.ca_club_rake_daily_user du
     WHERE du.club_id = p_club_id
       AND du.day >= date_trunc('day', v_from)::date
       -- A DAY IS IN RANGE WHEN ITS OWN MIDNIGHT IS BEFORE THE EXCLUSIVE END,
       -- never `<= date_trunc('day', v_to)`. v_to is either a midnight (ask
       -- for a range ending yesterday and it is TODAY's midnight) or now()
       -- itself (ask for a range ending today). The inclusive form got the
       -- second case right and the first case wrong, and put TODAY's rake into
       -- a report for YESTERDAY. Caught by comparing old against new under one
       -- snapshot before this shipped; four ranges agreed and that one did not.
       AND du.day::timestamptz < v_to
       AND NOT EXISTS (SELECT 1 FROM ok_days o WHERE o.day = du.day)
  ), earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id,b.user_id) AS user_id,
           COALESCE(a.rake,0)+COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0)+COALESCE(b.hands,0) AS hands
      FROM from_rollup a FULL OUTER JOIN from_live b ON b.user_id = a.user_id
  ), paid_cut AS MATERIALIZED (
    -- EVERY INSTANT IN [v_from, v_to) AT WHICH "PAID" CAN CHANGE, AND v_from.
    -- fn_agent_commission_paid_by_period is SELECT EXISTS (...), and a SQL
    -- body with a sublink is never inlined, so asking it inside the FILTERs
    -- below made it a function call, twice for every open commission row in
    -- the range: 4,024,562 calls and 42 s for SHARK CLUB's month. For any
    -- agent the answer can only change where one of this club's paid periods
    -- starts or ends. Between two consecutive cuts it is constant, so it is
    -- asked once per stretch, at the stretch's first instant.
    SELECT v_from AS cut
    UNION
    SELECT s.period_start FROM public.agent_commission_settlements s
     WHERE s.club_id = p_club_id AND s.period_start > v_from AND s.period_start < v_to
    UNION
    SELECT s.period_end FROM public.agent_commission_settlements s
     WHERE s.club_id = p_club_id AND s.period_end > v_from AND s.period_end < v_to
  ), stretch AS MATERIALIZED (
    -- [lo, hi) stretches that tile [v_from, v_to) exactly: no gap, no overlap.
    SELECT c.cut AS lo, COALESCE(lead(c.cut) OVER (ORDER BY c.cut), v_to) AS hi
      FROM paid_cut c
  ), commission_part AS (
    -- One range read of idx_agent_commissions_club_created per stretch, summed
    -- per (agent, own settled_at set or not). No function call per row. The
    -- half-open window of fn_club_commission_accrued (>= since, < until) is
    -- stated outright as well: the stretches tile it exactly, so it removes
    -- nothing, and no stretch can ever widen what is summed.
    SELECT st.lo, x.user_id, x.open, x.amount
      FROM stretch st
      CROSS JOIN LATERAL (
        SELECT ac.user_id, ac.settled_at IS NULL AS open, SUM(ac.amount) AS amount
          FROM public.agent_commissions ac
         WHERE ac.club_id = p_club_id
           AND ac.created_at >= v_from AND ac.created_at < v_to
           AND ac.created_at >= st.lo AND ac.created_at < st.hi
         GROUP BY ac.user_id, ac.settled_at IS NULL) x
  ), commission AS (
    -- The same predicate and the same two FILTERs, asked once per stretch.
    -- Every sum covers exactly the rows it did (numeric addition is exact and
    -- keeps the largest input scale), and is NULL exactly when it was.
    SELECT cp.user_id,
           SUM(cp.amount)                                          AS earned,
           SUM(cp.amount) FILTER (WHERE cp.open AND NOT public.fn_agent_commission_paid_by_period(p_club_id, cp.user_id, cp.lo)) AS outstanding,
           SUM(cp.amount) FILTER (WHERE NOT cp.open OR public.fn_agent_commission_paid_by_period(p_club_id, cp.user_id, cp.lo)) AS settled
      FROM commission_part cp
     GROUP BY cp.user_id
  ), club_agents AS (
    SELECT a.id, a.user_id, a.parent_agent_id, a.role, a.commission_rate
      FROM public.agents a WHERE a.club_id = p_club_id AND a.status='active'
  ), direct AS (
    SELECT cm.agent_id, COUNT(*) AS players,
           COUNT(*) FILTER (WHERE COALESCE(e.rake,0) <> 0) AS active,
           COALESCE(SUM(e.rake),0) AS rake, COALESCE(SUM(e.hands),0)::bigint AS hands
      FROM public.club_members cm
      LEFT JOIN earned e ON e.user_id = cm.user_id
     WHERE cm.club_id = p_club_id
     GROUP BY cm.agent_id
  ), tree AS (
    SELECT ca.id AS root_id, ca.id AS node_id, 0 AS depth FROM club_agents ca
    UNION ALL
    SELECT t.root_id, c.id, t.depth+1
      FROM tree t JOIN club_agents c ON c.parent_agent_id = t.node_id
     WHERE t.depth < 12
  ), network AS (
    SELECT t.root_id, COALESCE(SUM(d.rake),0) AS rake,
           COALESCE(SUM(d.players),0) AS players,
           COUNT(*) FILTER (WHERE t.node_id <> t.root_id) AS sub_agents
      FROM (SELECT DISTINCT root_id, node_id FROM tree) t
      JOIN club_agents n ON n.id = t.node_id
      LEFT JOIN direct d ON d.agent_id = n.user_id
     GROUP BY t.root_id
  ), unlisted AS (
    SELECT SUM(cs.earned) AS earned, SUM(cs.outstanding) AS outstanding,
           SUM(cs.settled) AS settled, count(*)::int AS recipients
      FROM commission cs
     WHERE NOT EXISTS (SELECT 1 FROM club_agents ca WHERE ca.user_id = cs.user_id)
  ), listed AS (
    SELECT ca.user_id AS agent_user_id,
           COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                         pr.first_name, pr.last_name, pr.full_name),
                    pr.username, 'Agent') AS name,
           pr.avatar_url, ca.role, ca.commission_rate,
           COALESCE(dr.players,0) AS direct_players,
           COALESCE(dr.active,0)  AS direct_active,
           round(COALESCE(dr.rake,0),2) AS direct_rake,
           COALESCE(dr.hands,0) AS direct_hands,
           COALESCE(nw.players,0) AS network_players,
           round(COALESCE(nw.rake,0),2) AS network_rake,
           COALESCE(nw.sub_agents,0) AS sub_agents,
           CASE WHEN v_cost THEN round(COALESCE(cs.earned,0),2)      END AS commission_earned,
           CASE WHEN v_cost THEN round(COALESCE(cs.outstanding,0),2) END AS commission_outstanding,
           CASE WHEN v_cost THEN round(COALESCE(cs.settled,0),2)     END AS commission_settled,
           -- The same three conditions the downline walker enforces.
           (v_cost OR v_over OR ca.user_id = v_uid
            OR public.fn_is_agent_ancestor(v_uid, ca.user_id, p_club_id)) AS can_drill,
           false AS is_unassigned, false AS is_residual
      FROM club_agents ca
      LEFT JOIN direct dr ON dr.agent_id = ca.user_id
      LEFT JOIN network nw ON nw.root_id = ca.id
      LEFT JOIN commission cs ON cs.user_id = ca.user_id
      LEFT JOIN public.profiles pr ON pr.id = ca.user_id
    UNION ALL
    SELECT NULL,'Unassigned',NULL,'none',NULL,
           d.players,d.active,round(d.rake,2),d.hands,
           d.players,round(d.rake,2),0,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           false, true, false
      FROM direct d WHERE d.agent_id IS NULL AND d.players > 0
    UNION ALL
    SELECT NULL,'Unlisted Recipients',NULL,'none',NULL,
           0,0,0::numeric,0::bigint,
           u.recipients,0::numeric,0,
           round(u.earned,2), round(u.outstanding,2), round(u.settled,2),
           false, true, true
      FROM unlisted u
     WHERE v_cost AND COALESCE(u.earned,0) <> 0
  ), totals AS (
    -- Before the filter. The denominator is the club, not the search result.
    SELECT COALESCE(SUM(l.direct_rake),0) AS total_direct,
           SUM(l.commission_earned)       AS total_commission
      FROM listed l
  ), filtered AS (
    SELECT l.* FROM listed l
     WHERE v_q IS NULL OR l.name ILIKE '%' || public.fn_like_escape(v_q) || '%' ESCAPE '\'
  ), ranked AS (
    SELECT f.*, row_number() OVER (
             ORDER BY f.is_unassigned,
               CASE WHEN v_sort = 'name'    THEN f.name END ASC,
               CASE WHEN v_sort = 'cost'    THEN f.commission_earned END DESC NULLS LAST,
               CASE WHEN v_sort = 'players' THEN f.network_players END DESC,
               CASE WHEN v_sort NOT IN ('name','cost','players')
                    THEN f.network_rake END DESC NULLS LAST,
               f.name ASC,
               f.agent_user_id::text ASC NULLS LAST) AS rn
      FROM filtered f
  ), sliced AS (
    SELECT r.* FROM ranked r ORDER BY r.rn
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg((to_jsonb(s) - 'rn') ORDER BY s.rn) FROM sliced s), '[]'::jsonb),
    -- Counted, not taken from a window over the page: ask for an offset past
    -- the end and a windowed count would answer "nothing matches".
    'total', (SELECT count(*) FROM filtered),
    'total_direct', (SELECT t.total_direct FROM totals t),
    'total_commission', (SELECT t.total_commission FROM totals t))
    INTO v_out;

  RETURN COALESCE(v_out,
    jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL));
END;
$function$;


REVOKE ALL ON FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text) TO service_role;

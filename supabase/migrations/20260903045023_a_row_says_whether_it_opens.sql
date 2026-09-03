-- 20260903045023_a_row_says_whether_it_opens.sql
-- RECOVERED 2026-09-03 from supabase_migrations.schema_migrations.
-- This migration was APPLIED to production on 2026-09-03 at 04:50:23 UTC but was never committed, so the repo
-- could not reproduce the database and applied-migrations-recorded.yml was red.
-- The body below is the exact SQL the database recorded; it is NOT a
-- reconstruction. Re-applying it is a no-op - it is already in production.

-- A ROW SAYS WHETHER IT OPENS.
--
-- Club scope lists agents and their network totals. Until now those rows were
-- a dead end: you could see that an agent's network produced 30,634 and had no
-- way to ask who inside it did the work.
--
-- Making the row clickable exposed a second problem first. The downline walker
-- admitted only the agent themselves, an agent ABOVE them, or a union overseer
-- - so the CLUB OWNER was refused the composition of a number their own club
-- data page had just shown them. That is incoherent, and it is fixed in the
-- companion migration: a club admin may open an agent in their own club.
--
-- Peer agents are still refused. A club admin overseeing the club is not the
-- same as one agent reading a rival's player list, and widening the gate to
-- every super agent would have done exactly that.
--
-- can_drill exists so the panel never offers a door that will not open. It is
-- computed from the SAME three conditions the walker enforces, so the button
-- and the gate cannot disagree - a row that says it opens, opens.

CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_agent(
  p_club_id uuid, p_start date, p_end date, p_limit integer,
  p_offset integer DEFAULT 0, p_search text DEFAULT NULL, p_sort text DEFAULT 'rake'
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
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
  ), edge_hands AS MATERIALIZED (
    SELECT r.hand_id, r.rake_amount, r.player_contributions, r.rake_method
      FROM public.rake_records r
     WHERE r.club_id = p_club_id
       AND r.created_at >= v_from AND r.created_at < v_to
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ok_days o
                        WHERE o.day = (r.created_at AT TIME ZONE 'UTC')::date)
  ), from_live AS (
    SELECT s.user_id,
           SUM(round(s.credit * 100)::bigint)::numeric / 100 AS rake,
           count(*)::bigint AS hands
      FROM edge_hands eh
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        eh.hand_id, eh.rake_amount, eh.player_contributions,
        COALESCE(eh.rake_method,'DEALT_EQUAL')) s
     GROUP BY s.user_id
  ), earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id,b.user_id) AS user_id,
           COALESCE(a.rake,0)+COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0)+COALESCE(b.hands,0) AS hands
      FROM from_rollup a FULL OUTER JOIN from_live b ON b.user_id = a.user_id
  ), commission AS (
    SELECT ac.user_id,
           SUM(ac.amount)                                          AS earned,
           SUM(ac.amount) FILTER (WHERE ac.settled_at IS NULL)     AS outstanding,
           SUM(ac.amount) FILTER (WHERE ac.settled_at IS NOT NULL) AS settled
      FROM public.agent_commissions ac
     WHERE ac.club_id = p_club_id
       AND ac.created_at >= v_from AND ac.created_at < v_to
     GROUP BY ac.user_id
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
    SELECT ca.user_id AS agent_user_id, COALESCE(pr.username,'Agent') AS name,
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
     WHERE v_q IS NULL OR l.name ILIKE '%' || v_q || '%'
  ), ranked AS (
    SELECT f.*, row_number() OVER (
             ORDER BY f.is_unassigned,
               CASE WHEN v_sort = 'name'    THEN f.name END ASC,
               CASE WHEN v_sort = 'cost'    THEN f.commission_earned END DESC NULLS LAST,
               CASE WHEN v_sort = 'players' THEN f.network_players END DESC,
               CASE WHEN v_sort NOT IN ('name','cost','players')
                    THEN f.network_rake END DESC NULLS LAST,
               f.name ASC) AS rn
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
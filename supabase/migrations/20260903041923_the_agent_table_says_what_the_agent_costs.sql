-- 20260903041923_the_agent_table_says_what_the_agent_costs.sql
-- RECOVERED 2026-09-03 from supabase_migrations.schema_migrations.
-- This migration was APPLIED to production on 2026-09-03 at 04:19:23 UTC but was never committed, so the repo
-- could not reproduce the database and applied-migrations-recorded.yml was red.
-- The body below is the exact SQL the database recorded; it is NOT a
-- reconstruction. Re-applying it is a no-op - it is already in production.

-- THE AGENT TABLE SAYS WHAT THE AGENT COSTS.
--
-- The breakdown ranked agents by the rake they produced and never said what any
-- of them earns from it. A super agent topping the chart on 30,634 of network
-- rake at a 70% commission rate is a different proposition from an agent
-- second on the list at 45%, and the page could not tell them apart.
--
-- WHAT agent_commissions ACTUALLY IS, because the column names mislead. Every
-- row is an ACCRUAL, not a payment: source_type 'rake_settlement' names the
-- rake event that produced the commission, not the commission being settled.
-- All 1.7m rows are positive, there are no reversals, and settled_at is written
-- only by fn_agent_claim_commission - when an agent claims. Nobody has claimed
-- anything yet, so every row is outstanding, and that is a real fact about the
-- club rather than a gap in the data.
--
-- Commission CASCADES: an upline earns on their downline's rake and gets their
-- OWN rows for it (22,931 of Deep Stack Society's rows belong to super agents,
-- 41,100 to agents). So per-recipient aggregation is complete, and unlike
-- network_rake this column genuinely SUMS - each row has exactly one recipient,
-- so the column total is the club's commission bill for the window.
--
-- It is NOT rake x rate. It is the cascade, so it does not correspond to the
-- direct rake column beside it, and the panel says so rather than inviting the
-- arithmetic.
--
-- ADMIN ONLY, and this is the second time this shape has come up. The estate's
-- own reader fn_club_commission_accrued gates on fn_is_club_admin_uid - owner,
-- co-owner, admin, manager. ca_rake_snapshot runs under
-- ca_can_view_club_finances, which ALSO admits super_agent. Adding these columns
-- without their own gate would show a super agent the club's commission bill,
-- including what their peers earn, through a door the estate deliberately
-- closed. So the gate is applied per column.
--
-- Masked as NULL, not 0. A zero here reads as "this agent costs nothing", which
-- is false; the panel renders null as a dash, which is "not disclosed". The
-- horse flag masks to false because for a boolean that is the safe default and
-- the ambiguity does not arise. For money it does.

CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_agent(
  p_club_id uuid, p_start date, p_end date, p_limit integer,
  p_offset integer DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_now  timestamptz := now();
  v_from timestamptz := p_start::timestamptz;
  v_to   timestamptz := LEAST((p_end + 1)::timestamptz, v_now);
  -- Owner / co-owner / admin / manager. Deliberately NOT the finances gate.
  v_cost boolean := public.fn_is_club_admin_uid(p_club_id);
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
    -- Half-open on created_at, matching fn_club_commission_accrued exactly, so
    -- the per-agent column and the club total cannot disagree about a boundary.
    SELECT ac.user_id,
           SUM(ac.amount)                                              AS earned,
           SUM(ac.amount) FILTER (WHERE ac.settled_at IS NULL)         AS outstanding,
           SUM(ac.amount) FILTER (WHERE ac.settled_at IS NOT NULL)     AS settled
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
           false AS is_unassigned
      FROM club_agents ca
      LEFT JOIN direct dr ON dr.agent_id = ca.user_id
      LEFT JOIN network nw ON nw.root_id = ca.id
      LEFT JOIN commission cs ON cs.user_id = ca.user_id
      LEFT JOIN public.profiles pr ON pr.id = ca.user_id
    UNION ALL
    -- Players with no agent earn nobody a commission, which is a real zero
    -- rather than an undisclosed one - so it stays 0 even for a viewer who
    -- would otherwise see nulls.
    SELECT NULL,'Unassigned',NULL,'none',NULL,
           d.players,d.active,round(d.rake,2),d.hands,
           d.players,round(d.rake,2),0,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           true
      FROM direct d WHERE d.agent_id IS NULL AND d.players > 0
  ), page AS (
    SELECT l.*, count(*) OVER () AS total_rows,
           COALESCE(SUM(l.direct_rake) OVER (), 0) AS total_direct,
           -- Sums cleanly: one recipient per row, so this is the club's
           -- commission bill for the window, not a double-counted cascade.
           SUM(l.commission_earned) OVER () AS total_commission
      FROM listed l
     ORDER BY l.is_unassigned, l.network_rake DESC NULLS LAST
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(jsonb_agg(
              (to_jsonb(p) - 'total_rows' - 'total_direct' - 'total_commission')
              ORDER BY p.is_unassigned, p.network_rake DESC NULLS LAST), '[]'::jsonb),
    'total', COALESCE(MAX(p.total_rows), 0),
    'total_direct', COALESCE(MAX(p.total_direct), 0),
    'total_commission', MAX(p.total_commission))
    INTO v_out
    FROM page p;

  RETURN COALESCE(v_out,
    jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer) TO service_role;
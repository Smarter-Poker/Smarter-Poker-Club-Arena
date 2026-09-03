-- 20260903042107_commission_that_belongs_to_nobody_listed_is_still_owed.sql
-- RECOVERED 2026-09-03 from supabase_migrations.schema_migrations.
-- This migration was APPLIED to production on 2026-09-03 at 04:21:07 UTC but was never committed, so the repo
-- could not reproduce the database and applied-migrations-recorded.yml was red.
-- The body below is the exact SQL the database recorded; it is NOT a
-- reconstruction. Re-applying it is a no-op - it is already in production.

-- COMMISSION THAT BELONGS TO NOBODY LISTED IS STILL OWED.
--
-- The per-agent column summed to 22,378.97 while fn_club_commission_accrued
-- said 22,460.11 for the same window. The 81.14 difference is commission earned
-- by 59 recipients who have NO agents row in this club at all - not inactive
-- ones, since every agents row here is active. They earned through the cascade
-- and are no longer listed, or never were.
--
-- Dropping them would make the column quietly disagree with the club's own
-- total, which is the third time this shape has come up in this page and the
-- answer is the same as it was for players with no agent: give it a row and
-- name it. A residual that is visible is a question an owner can ask; a
-- residual that is absent is a number nobody can reconcile.
--
-- The row carries no rake and no players, because it is not an agent - it is
-- money owed to people the agent table does not list.

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
    -- Commission earned by someone with no agents row in this club.
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
           true, false
      FROM direct d WHERE d.agent_id IS NULL AND d.players > 0
    UNION ALL
    SELECT NULL,'Unlisted Recipients',NULL,'none',NULL,
           0,0,0::numeric,0::bigint,
           u.recipients,0::numeric,0,
           round(u.earned,2), round(u.outstanding,2), round(u.settled,2),
           true, true
      FROM unlisted u
     WHERE v_cost AND COALESCE(u.earned,0) <> 0
  ), page AS (
    SELECT l.*, count(*) OVER () AS total_rows,
           COALESCE(SUM(l.direct_rake) OVER (), 0) AS total_direct,
           SUM(l.commission_earned) OVER () AS total_commission
      FROM listed l
     ORDER BY l.is_unassigned, l.network_rake DESC NULLS LAST, l.commission_earned DESC NULLS LAST
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(jsonb_agg(
              (to_jsonb(p) - 'total_rows' - 'total_direct' - 'total_commission')
              ORDER BY p.is_unassigned, p.network_rake DESC NULLS LAST,
                       p.commission_earned DESC NULLS LAST), '[]'::jsonb),
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
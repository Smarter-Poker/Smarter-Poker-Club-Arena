-- ═══════════════════════════════════════════════════════════════════════════
--  THE AGENT BREAKDOWN READS THE ATTRIBUTIONS INSTEAD OF RE-DERIVING THEM
--  Club Operations upgrade, phase 7 of 8. The item phase 6's gate handed over.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Opening `/clubs/<slug>/data` in a browser:
--
--     ca_club_data_snapshot   200 in   300-1,000ms
--     ca_rake_snapshot        500 in  ~8,200ms  (57014 statement timeout)
--
-- and the page re-issued that failing call seven times in fourteen seconds
-- until the retry storm was fixed. Inside `ca_rake_snapshot`,
-- `fn_ca_rake_window` is 0.6s and `fn_ca_rake_series` 0.13s;
-- **`fn_ca_rake_by_agent` is 29.7 seconds**.
--
-- Its `from_live` CTE exists to cover the days not yet in
-- `club_rake_rollup_complete` - which always includes today - and it covers
-- them by calling `fn_rake_shares_for_record` ONCE PER RAKED HAND. That
-- function's first act is to look up `rake_attributions` by hand_id, so the
-- work is 61,156 index lookups plus a NOT EXISTS each, every time an operator
-- opens the page. Expanding the same rows set-based from
-- `player_contributions` instead still costs 11.5 seconds, so this was never a
-- query to tune: the per-player live edge had to stop being re-derived, in the
-- same way phase 6 stopped re-deriving the club-level figure.
--
-- It does not need a new rollup, because the rollup already exists one layer
-- down. `rake_attributions` IS the per-player credit, written by the engine as
-- the hand is raked, and `club_rake_daily_user` - the completed-day rollup
-- this function already trusts - is built from it by
-- `fn_club_rake_rollup_day`. So the live edge reads the same table the
-- completed days were built from, grouped, behind an index.
--
-- THIS MAKES THE LIVE EDGE AGREE WITH THE ROLLED-UP DAYS BY CONSTRUCTION, and
-- that is a change worth stating plainly. The old path could also recompute a
-- share for a raked hand that has no attribution rows at all; measured on
-- 2026-09-03 that is 191 hands of 93,465 (0.2%), and those hands are ALREADY
-- absent from every completed day, because the rollup they feed is built from
-- attributions too. Today therefore stops being counted on a different basis
-- from yesterday - which is the whole point of this programme - and the small
-- set that is missing is missing consistently rather than only after midnight.
-- If those hands matter, the fix is to write the attributions, not to
-- reconstruct them differently in one report.
--
-- THE INDEX THAT SERVES THIS READ SHIPS SEPARATELY, in
-- 20260905042500, because it is the only part that needs the maintenance
-- freeze: `rake_attributions` is written on every raked hand and a plain
-- CREATE INDEX blocks those writers for the length of its scan (1,131,048
-- rows / 456 MB). This half needs no lock and lands first, because even
-- unindexed a single grouped scan beats 61,156 per-hand lookups by an order
-- of magnitude - there is no reason to leave the page failing until the
-- next freeze.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '0';

CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_agent(p_club_id uuid, p_start date, p_end date, p_limit integer, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
    -- THE DAYS NOT YET ROLLED UP, read from the table the rollup is built
    -- from. This called fn_rake_shares_for_record once per raked hand -
    -- 61,156 lookups on the busiest club, 29.7 seconds, past every timeout.
    -- Same column and same rounding as fn_club_rake_rollup_day, so the live
    -- edge and the completed days are one number.
    SELECT ra.player_id AS user_id,
           SUM(round(ra.rake_amount * 100)::bigint)::numeric / 100 AS rake,
           count(*)::bigint AS hands
      FROM public.rake_attributions ra
     WHERE ra.club_id = p_club_id
       AND ra.created_at >= v_from AND ra.created_at < v_to
       AND ra.rake_amount > 0
       AND NOT EXISTS (SELECT 1 FROM ok_days o
                        WHERE o.day = (ra.created_at AT TIME ZONE 'UTC')::date)
     GROUP BY ra.player_id
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

REVOKE ALL ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer, integer, text, text) TO authenticated, service_role;

DO $$
DECLARE v_src text;
BEGIN
  -- Comment lines stripped first: the body NAMES the old call in the comment
  -- that explains why it is gone, and an assertion that cannot tell code from
  -- prose fails on its own explanation (it did, on the first apply).
  SELECT string_agg(line, chr(10)) INTO v_src
    FROM (SELECT line FROM regexp_split_to_table(
            (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_rake_by_agent'
              AND pronamespace = 'public'::regnamespace), chr(10)) AS line
           WHERE btrim(line) NOT LIKE '--%') q;
  IF v_src LIKE '%fn_rake_shares_for_record%' THEN
    RAISE EXCEPTION 'the agent breakdown still re-derives a share per raked hand';
  END IF;
  IF v_src NOT LIKE '%FROM public.rake_attributions ra%' THEN
    RAISE EXCEPTION 'the live edge no longer reads the attributions the rollup is built from';
  END IF;
END $$;

COMMIT;

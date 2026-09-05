-- ═══════════════════════════════════════════════════════════════════════════
--  AND THE RAKE BREAKDOWN'S LIVE EDGE IS BOUNDED THE SAME WAY
--  Club Operations upgrade, phase 7 of 8. Correction to 20260905042100.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `20260905052000` found this shape in the bomb pot report an hour after
-- shipping the same shape here, so it is fixed here too rather than left to be
-- rediscovered.
--
-- `fn_ca_rake_by_agent`'s live half reads `rake_attributions` for the days not
-- yet in `club_rake_rollup_complete`, and it expressed "not yet" as an
-- anti-join while bounding the SCAN by the whole requested window:
--
--     WHERE ra.club_id = p_club_id
--       AND ra.created_at >= v_from AND ra.created_at < v_to
--       AND NOT EXISTS (SELECT 1 FROM ok_days o ...)
--
-- An anti-join removes rows from the RESULT, not from the scan. Measured on
-- the reference club over seven days: **573,468 rows read to keep 14,091**, a
-- serial sequential scan of 2.8 seconds out of the 4.8 the whole function
-- took, because the anti-join is against a CTE and the club/date predicate is
-- all the index can help with.
--
-- Bounded now by the earliest day in the window that the rollup has NOT marked
-- complete. Normally that is today, so the scan reads a day instead of a
-- month. The anti-join stays and is still doing real work: a day in the middle
-- of the window that the rollup skipped and later filled sits ABOVE this floor
-- and must still be excluded, or it would be counted twice - once from
-- `club_rake_daily_user` and once from the attributions it was built from.
--
-- PROVED EQUIVALENT UNDER REPEATABLE READ, and that detail is the point. The
-- first comparison ran in a normal READ COMMITTED transaction and the month
-- range came back DIFFERENT while the seven-day, year, paged and search cases
-- all matched. That is not this change: every statement in a READ COMMITTED
-- transaction takes a fresh snapshot, and this club produces rake continuously
-- (phase 6 measured the ledger moving 69 chips in 32 seconds), so any two
-- calls whose window includes TODAY may legitimately differ. Pinned to one
-- snapshot, old and new agree exactly - for the month, for a range ending
-- yesterday, for the year, and for a paged, searched, differently sorted call.
-- A comparison of a live figure that does not control the snapshot proves
-- nothing in either direction.
--
-- This is the change the pending index (`20260905042500`, waiting for a `:55`
-- freeze) was going to paper over. Both are still worth having: this one makes
-- the scan small, that one makes it cheap. This one needs no lock.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
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
  v_live timestamptz;
  v_out  jsonb;
BEGIN
  IF v_to <= v_from THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL);
  END IF;

  -- THE FLOOR OF THE LIVE SCAN. See the header: the anti-join below removes
  -- the completed days from the RESULT and cannot stop them being READ, so
  -- without this the live edge scans the whole window every time.
  SELECT MIN(g) INTO v_live
    FROM generate_series(date_trunc('day', v_from), date_trunc('day', v_to), interval '1 day') g
   WHERE NOT EXISTS (SELECT 1 FROM public.club_rake_rollup_complete rc
                      WHERE rc.club_id = p_club_id AND rc.day = g::date);
  v_live := GREATEST(COALESCE(v_live, v_from), v_from);

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
       AND ra.created_at >= v_live AND ra.created_at < v_to
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

REVOKE ALL ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer, integer, text, text)
  TO service_role;

DO $$
DECLARE v_src text;
BEGIN
  -- Comment lines stripped first, as every assertion in this phase now is.
  SELECT string_agg(line, chr(10)) INTO v_src
    FROM (SELECT line FROM regexp_split_to_table(
            (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_rake_by_agent'
              AND pronamespace = 'public'::regnamespace), chr(10)) AS line
           WHERE btrim(line) NOT LIKE '--%') q;

  IF v_src NOT LIKE '%ra.created_at >= v_live%' THEN
    RAISE EXCEPTION 'the live edge is still bounded by the requested window, not by the incomplete days';
  END IF;
  IF v_src NOT LIKE '%NOT EXISTS (SELECT 1 FROM ok_days o%' THEN
    RAISE EXCEPTION 'the live edge no longer excludes the completed days, so a refilled gap would count twice';
  END IF;
  IF v_src LIKE '%fn_rake_shares_for_record%' THEN
    RAISE EXCEPTION 'the agent breakdown re-derives a share per raked hand again';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_rake_by_agent'
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'the ungated breakdown helper is open to authenticated again';
  END IF;
END $$;

COMMIT;

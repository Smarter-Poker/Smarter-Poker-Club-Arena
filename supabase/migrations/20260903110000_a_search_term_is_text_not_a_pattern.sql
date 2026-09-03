-- A SEARCH TERM IS TEXT, NOT A PATTERN.
--
-- The search shipped an hour ago pasted what the operator typed straight
-- between two percent signs. LIKE reads that string as a PATTERN, so two
-- ordinary characters stopped being characters:
--
--   %   matched everything. Typing one percent sign returned all 34 agents,
--       rather than the none whose names contain a percent sign.
--
--   _   matched ANY single character. Fourteen usernames on this estate carry
--       an underscore - bigtony_chi among them - so searching that name also
--       matched bigtonyXchi, and there was no way to ask for the literal one.
--
-- This is NOT an injection. The term is a bound parameter and never reaches
-- the planner as SQL. It is a correctness bug, and the underscore makes it one
-- an operator meets by accident rather than by trying.
--
-- The backslash is replaced FIRST. Doing it last would escape the backslashes
-- the other two replacements had just introduced, and turn every search
-- containing a percent sign into a search for a literal backslash.
--
-- ESCAPE '\' is already the default for LIKE. It is written out anyway,
-- because a reader should not have to know the default to see that the
-- escaping is wired up.
--
-- fn_ca_rake_by_agent is RE-DECLARED here in full rather than patched. Its
-- laws read "the migration that last defines this function" - patch it
-- elsewhere and that file stops describing what is deployed, so the laws would
-- go on testing a version of the function that no longer exists.

CREATE OR REPLACE FUNCTION public.fn_like_escape(p_term text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $function$
  SELECT replace(replace(replace(p_term, '\', '\\'), '%', '\%'), '_', '\_');
$function$;

REVOKE ALL ON FUNCTION public.fn_like_escape(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_like_escape(text) TO authenticated, anon, service_role;

-- ---------------------------------------------------------------- by club ---
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
           COALESCE(a.hands,0) AS hands, a.games
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

-- ------------------------------------------------------------ by downline ---
CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_downline(
  p_agent_user_id uuid, p_club_id uuid,
  p_since timestamptz, p_until timestamptz, p_limit integer,
  p_offset integer DEFAULT 0, p_search text DEFAULT NULL, p_sort text DEFAULT 'rake'
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH listed AS (
    -- The walker is asked for EVERYTHING and filtered here, not asked for the
    -- match. Its own p_search would shrink the set the denominator is taken
    -- from, so a share would change as the operator typed.
    SELECT d.* FROM public.fn_agent_downline_rake(
      p_agent_user_id, p_club_id, p_since, p_until, NULL, 5000) d
  ), totals AS (
    SELECT COALESCE(SUM(l.rake_generated),0) AS total_direct FROM listed l
  ), filtered AS (
    SELECT l.* FROM listed l
     WHERE NULLIF(btrim(COALESCE(p_search,'')),'') IS NULL
        OR COALESCE(l.username,'') ILIKE '%' || public.fn_like_escape(btrim(p_search)) || '%' ESCAPE '\'
  ), page AS (
    SELECT f.* FROM filtered f
     ORDER BY
       CASE WHEN lower(COALESCE(p_sort,'rake')) = 'name'  THEN f.username END ASC,
       CASE WHEN lower(COALESCE(p_sort,'rake')) = 'hands' THEN f.hands END DESC,
       CASE WHEN lower(COALESCE(p_sort,'rake')) NOT IN ('name','hands')
            THEN f.rake_generated END DESC,
       f.username ASC
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,100),500),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'player_id', p.player_id,
              'name', COALESCE(p.username,'Player'),
              'role', p.role,
              'depth', p.depth,
              'upline_user_id', p.upline_user_id,
              'upline_name', p.upline_name,
              'rake', round(COALESCE(p.rake_generated,0),2),
              'hands', COALESCE(p.hands,0),
              'last_hand_at', p.last_hand_at,
              'downline_players', COALESCE(p.downline_players,0),
              'downline_rake', round(COALESCE(p.downline_rake,0),2))) FROM page p), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'total_direct', (SELECT t.total_direct FROM totals t),
    'total_commission', NULL);
$function$;

-- --------------------------------------------------------------- by agent ---
-- Re-declared in full, unchanged but for the filter line, so that the file
-- which last defines this function is the file that describes what runs.
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
           -- The same conditions the downline walker enforces.
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

-- CREATE OR REPLACE keeps whatever privileges the function already had, so on
-- THIS database the three helpers stayed revoked and nothing was exposed.
--
-- That is not the case a rebuild faces. Create these from an empty database
-- and they are born with PUBLIC EXECUTE; if the migration that last defines
-- them does not revoke, a player can call the definer helper directly and read
-- another club's book. The grants are therefore restated with every
-- re-declaration rather than assumed to have carried.
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_club(uuid[],date,date,integer,integer,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_downline(uuid,uuid,timestamptz,timestamptz,integer,integer,text,text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_club(uuid[],date,date,integer,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_downline(uuid,uuid,timestamptz,timestamptz,integer,integer,text,text) TO service_role;

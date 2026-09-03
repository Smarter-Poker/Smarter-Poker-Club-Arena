-- A LIST THAT STOPS AT FIFTY SAYS SO.
--
-- All three breakdowns took p_limit, defaulted it to 50, capped it at 200 and
-- returned a bare array. A union with fifty-one clubs showed fifty and said
-- nothing; the fifty-first was indistinguishable from a club that produced no
-- rake at all. Same for an agent's fifty-first player. The silence is the bug -
-- an operator cannot audit a list that will not admit it is incomplete.
--
-- Each helper now returns an OBJECT rather than an array:
--   rows          the requested page
--   total         how many rows exist behind it
--   total_direct  the money sum over EVERY row, not the page
--
-- total_direct matters more than the paging itself. ca_rake_snapshot computed
-- breakdown_total by summing the array it was handed, which was correct while
-- the array WAS the whole list. Paginate that same code and the denominator
-- silently becomes the page: every share on screen becomes a percentage of the
-- first fifty rows, and every one of them CHANGES as the operator pages. The
-- sums are taken with a window over the full set, because window functions run
-- before OFFSET and LIMIT - which is the whole reason the count and the sum
-- come back attached to the page for free.
--
-- Verified: three pages of ten over a thirty-three row list returned thirty
-- rows with thirty distinct identities (no overlap, no duplicate), and
-- breakdown_total was 83,909.72 on every page and on the unpaged read.
--
-- The old arities are dropped at the end. Adding p_offset with a DEFAULT
-- creates a SECOND definition rather than replacing the first, and a call with
-- the old argument count then matches both - which Postgres resolves by
-- erroring, on the page.

-- ---------------------------------------------------------------- by club ---
CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_club(
  p_club_ids uuid[], p_start date, p_end date, p_limit integer,
  p_offset integer DEFAULT 0
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
           round(SUM(r.fee),2)                                AS fee,
           round(SUM(r.fee) FILTER (WHERE r.is_mtt),2)        AS mtt_fee,
           round(SUM(r.fee) FILTER (WHERE NOT r.is_mtt),2)    AS cash_fee,
           round(SUM(r.winnings),2)                           AS winnings,
           SUM(r.hands)                                       AS hands,
           COUNT(DISTINCT r.gid)                              AS games
      FROM rows_in r GROUP BY r.club_id
  ), listed AS (
    SELECT a.club_id, COALESCE(cl.name,'Club') AS name, cl.code,
           COALESCE(cl.avatar_url, cl.logo_url) AS avatar_url,
           COALESCE(a.fee,0) AS fee, COALESCE(a.cash_fee,0) AS cash_fee,
           COALESCE(a.mtt_fee,0) AS mtt_fee, COALESCE(a.winnings,0) AS winnings,
           COALESCE(a.hands,0) AS hands, a.games
      FROM agg a JOIN public.clubs cl ON cl.id = a.club_id
  ), page AS (
    -- count(*) and SUM(...) OVER () span the WHOLE set: window functions are
    -- evaluated before OFFSET and LIMIT trim it.
    SELECT l.*, count(*) OVER () AS total_rows,
           COALESCE(SUM(l.fee) OVER (), 0) AS total_direct
      FROM listed l
     ORDER BY l.fee DESC NULLS LAST
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(jsonb_agg(
              (to_jsonb(p) - 'total_rows' - 'total_direct')
              ORDER BY p.fee DESC NULLS LAST), '[]'::jsonb),
    'total', COALESCE(MAX(p.total_rows), 0),
    'total_direct', COALESCE(MAX(p.total_direct), 0))
  FROM page p;
$function$;

-- ------------------------------------------------------------ by downline ---
CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_downline(
  p_agent_user_id uuid, p_club_id uuid,
  p_since timestamptz, p_until timestamptz, p_limit integer,
  p_offset integer DEFAULT 0
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH listed AS (
    -- The inner cap is deliberately far above any page: fn_agent_downline_rake
    -- is the gate as well as the reader, and asking it for one page at a time
    -- would make `total` a lie about how many people are beneath this agent.
    -- fn_agent_downline_rake_summary already calls it with 100000.
    SELECT d.* FROM public.fn_agent_downline_rake(
      p_agent_user_id, p_club_id, p_since, p_until, NULL, 5000) d
  ), page AS (
    SELECT l.*, count(*) OVER () AS total_rows,
           COALESCE(SUM(l.rake_generated) OVER (), 0) AS total_direct
      FROM listed l
     ORDER BY l.rake_generated DESC NULLS LAST
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,100),500),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(jsonb_agg(jsonb_build_object(
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
              'downline_rake', round(COALESCE(p.downline_rake,0),2))
              ORDER BY p.rake_generated DESC NULLS LAST), '[]'::jsonb),
    'total', COALESCE(MAX(p.total_rows), 0),
    'total_direct', COALESCE(MAX(p.total_direct), 0))
  FROM page p;
$function$;

-- --------------------------------------------------------------- by agent ---
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
  v_out  jsonb;
BEGIN
  IF v_to <= v_from THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0);
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
    -- ONE range scan anti-joined against the finished days: the head, the tail
    -- and any gap are precisely the instants NOT inside a completed day.
    SELECT r.hand_id, r.rake_amount, r.player_contributions, r.rake_method
      FROM public.rake_records r
     WHERE r.club_id = p_club_id
       AND r.created_at >= v_from AND r.created_at < v_to
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ok_days o
                        WHERE o.day = (r.created_at AT TIME ZONE 'UTC')::date)
  ), from_live AS (
    -- Cents, then divided once.
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
    -- parent_agent_id has no cycle constraint; one bad edge without this cap
    -- spins until the statement timeout kills the page.
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
           false AS is_unassigned
      FROM club_agents ca
      LEFT JOIN direct dr ON dr.agent_id = ca.user_id
      LEFT JOIN network nw ON nw.root_id = ca.id
      LEFT JOIN public.profiles pr ON pr.id = ca.user_id
    UNION ALL
    -- Players with no agent are not nobody's rake.
    SELECT NULL,'Unassigned',NULL,'none',NULL,
           d.players,d.active,round(d.rake,2),d.hands,
           d.players,round(d.rake,2),0,true
      FROM direct d WHERE d.agent_id IS NULL AND d.players > 0
  ), page AS (
    SELECT l.*, count(*) OVER () AS total_rows,
           COALESCE(SUM(l.direct_rake) OVER (), 0) AS total_direct
      FROM listed l
     ORDER BY l.is_unassigned, l.network_rake DESC NULLS LAST
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(jsonb_agg(
              (to_jsonb(p) - 'total_rows' - 'total_direct')
              ORDER BY p.is_unassigned, p.network_rake DESC NULLS LAST), '[]'::jsonb),
    'total', COALESCE(MAX(p.total_rows), 0),
    'total_direct', COALESCE(MAX(p.total_direct), 0))
    INTO v_out
    FROM page p;

  RETURN COALESCE(v_out, jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0));
END;
$function$;

-- The old arities must go, or a call with the previous argument count matches
-- both definitions and Postgres resolves the ambiguity by erroring.
DROP FUNCTION IF EXISTS public.fn_ca_rake_by_agent(uuid, date, date, integer);
DROP FUNCTION IF EXISTS public.fn_ca_rake_by_club(uuid[], date, date, integer);
DROP FUNCTION IF EXISTS public.fn_ca_rake_by_downline(uuid, uuid, timestamptz, timestamptz, integer);

REVOKE ALL ON FUNCTION public.fn_ca_rake_by_club(uuid[],date,date,integer,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_downline(uuid,uuid,timestamptz,timestamptz,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_club(uuid[],date,date,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_downline(uuid,uuid,timestamptz,timestamptz,integer,integer) TO service_role;

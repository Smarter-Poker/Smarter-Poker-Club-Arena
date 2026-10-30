CREATE OR REPLACE FUNCTION public.fn_agent_downline_rake(p_agent_user_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 500)
 RETURNS TABLE(player_id uuid, username text, club_id uuid, club_name text, role text, depth integer, upline_user_id uuid, upline_name text, rake_generated numeric, hands bigint, last_hand_at timestamp with time zone, downline_players integer, downline_rake numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_root uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_to   timestamptz := COALESCE(p_until, now());
  v_caller uuid := auth.uid();
  v_today  timestamptz := date_trunc('day', now());
  v_day_lo date;
  v_day_hi date;
  v_head_end   timestamptz;
  v_tail_start timestamptz;
  v_authorized_clubs uuid[];
BEGIN
  IF v_root IS NULL THEN RAISE EXCEPTION 'no_agent'; END IF;

  IF NOT EXISTS (SELECT 1 FROM agents a
                  WHERE a.user_id = v_root AND a.status='active'
                    AND a.role IN ('super_agent','agent','sub_agent')
                    AND (p_club_id IS NULL OR a.club_id = p_club_id)) THEN
    RAISE EXCEPTION 'not_an_agent' USING ERRCODE = '42501';
  END IF;

  v_authorized_clubs := public.fn_ca_authorized_agent_data_clubs(v_root, p_club_id);

  v_day_lo := date_trunc('day', v_from)::date;
  IF date_trunc('day', v_from) < v_from THEN v_day_lo := v_day_lo + 1; END IF;
  v_day_hi := LEAST(date_trunc('day', v_to), v_today)::date;
  IF v_day_hi < v_day_lo THEN v_day_hi := v_day_lo; END IF;

  v_head_end   := LEAST(v_day_lo::timestamptz, v_to);
  v_tail_start := GREATEST(v_day_hi::timestamptz, v_from);

  RETURN QUERY
  WITH RECURSIVE chain AS (
    SELECT a.id, a.user_id, a.club_id, a.role, a.parent_agent_id, 0 AS depth, ARRAY[a.id]::uuid[] AS path
      FROM agents a
     WHERE a.user_id = v_root AND a.status = 'active'
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND a.club_id = ANY(v_authorized_clubs)
    UNION ALL
    SELECT c.id, c.user_id, c.club_id, c.role, c.parent_agent_id, ch.depth + 1, ch.path || c.id
      FROM agents c JOIN chain ch ON c.parent_agent_id = ch.id
     WHERE c.status = 'active'
       AND c.club_id = ch.club_id AND c.club_id = ANY(v_authorized_clubs)
       AND c.id <> ALL(ch.path)
  ),
  roster AS (
    SELECT DISTINCT cm.user_id AS player_id, cm.club_id, cm.agent_id AS upline_user_id,
           ch.depth + 1 AS depth
      FROM club_members cm
      JOIN chain ch ON ch.user_id = cm.agent_id AND ch.club_id = cm.club_id
     WHERE cm.agent_id IS NOT NULL
  ),
  everyone AS MATERIALIZED (
    SELECT player_id, club_id, upline_user_id, depth FROM roster
    UNION
    SELECT ch.user_id, ch.club_id,
           (SELECT p.user_id FROM agents p WHERE p.id = ch.parent_agent_id),
           ch.depth
      FROM chain ch WHERE ch.depth > 0
  ),
  in_scope_clubs AS MATERIALIZED (SELECT DISTINCT club_id FROM everyone),
  launch_scope AS MATERIALIZED (SELECT club_id, public.fn_ca_launch_accounting_cutoff('club',club_id) AS cutoff FROM in_scope_clubs),
  ok_days AS MATERIALIZED (
    SELECT rc.club_id, rc.day
      FROM club_rake_rollup_complete rc
      JOIN in_scope_clubs c ON c.club_id = rc.club_id
     WHERE rc.day >= v_day_lo AND rc.day < v_day_hi
  ),
  gap_days AS MATERIALIZED (
    SELECT c.club_id, g::date AS day
      FROM in_scope_clubs c
      CROSS JOIN generate_series(v_day_lo, v_day_hi - 1, interval '1 day') g
     WHERE v_day_hi > v_day_lo
       AND NOT EXISTS (SELECT 1 FROM ok_days o
                        WHERE o.club_id = c.club_id AND o.day = g::date)
  ),
  from_rollup AS (
    SELECT rd.user_id, rd.club_id,
           SUM(rd.rake_amount) AS rake,
           SUM(rd.hands)::bigint AS hands,
           MAX((rd.day + 1)::timestamptz) AS last_at
      FROM club_rake_daily_user rd
      JOIN ok_days o  ON o.club_id = rd.club_id AND o.day = rd.day
      JOIN everyone e ON e.player_id = rd.user_id AND e.club_id = rd.club_id
     GROUP BY rd.user_id, rd.club_id
  ),
  -- FUNDED-CLUB LIVE RAKE (2026-10-19). Days not yet rolled up read the same
  -- rows the nightly rollup reads: rake_attributions under the club the rake
  -- is credited to, with the same launch-accounting rule. Union hands are
  -- filed under the union club in rake_records, so the old live read found
  -- none of them for a member club and today showed 0.00. Cash rake only.
  edge_periods AS MATERIALIZED (
    SELECT c.club_id, v_from AS lo, v_head_end AS hi FROM in_scope_clubs c
    UNION ALL
    SELECT c.club_id, v_tail_start, v_to FROM in_scope_clubs c
    UNION ALL
    SELECT gd.club_id, gd.day::timestamptz, (gd.day+1)::timestamptz FROM gap_days gd
  ),
  edge_totals AS MATERIALIZED (
    SELECT a.player_id AS user_id, p.club_id,
           SUM(round(a.rake_amount*100)::bigint)::numeric/100 AS rake,
           count(*)::bigint AS hands, max(a.created_at) AS last_at
      FROM launch_scope lc JOIN edge_periods p ON p.club_id=lc.club_id
      CROSS JOIN LATERAL (
        SELECT a.player_id,a.rake_amount,a.created_at FROM rake_attributions a
        WHERE lc.cutoff IS NULL AND a.club_id=p.club_id AND a.created_at>=p.lo AND a.created_at<p.hi
          AND a.rake_amount>0 AND a.player_id IS NOT NULL
        OFFSET 0
      ) a
     GROUP BY a.player_id,p.club_id
    UNION ALL
    SELECT a.player_id, p.club_id,
           SUM(round(a.rake_amount*100)::bigint)::numeric/100,
           count(*)::bigint, max(a.created_at)
      FROM launch_scope lc JOIN edge_periods p ON p.club_id=lc.club_id
      CROSS JOIN LATERAL (
        SELECT a.player_id,a.rake_amount,a.created_at FROM rake_attributions a
        JOIN rake_records rr ON rr.id=a.rake_record_id
        WHERE lc.cutoff IS NOT NULL AND a.club_id=p.club_id AND a.created_at>=p.lo AND a.created_at<p.hi
          AND a.rake_amount>0 AND a.player_id IS NOT NULL
          AND rr.created_at IS NOT NULL AND isfinite(rr.created_at) AND rr.created_at>=lc.cutoff
        OFFSET 0
      ) a
     GROUP BY a.player_id,p.club_id
  ),
  from_live AS (
    SELECT t.user_id,t.club_id,SUM(t.rake) AS rake,SUM(t.hands)::bigint AS hands,MAX(t.last_at) AS last_at
    FROM edge_totals t JOIN everyone e ON e.player_id=t.user_id AND e.club_id=t.club_id
    GROUP BY t.user_id,t.club_id
  ),
  earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id, b.user_id) AS user_id,
           COALESCE(a.club_id, b.club_id) AS club_id,
           COALESCE(a.rake,0) + COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0) + COALESCE(b.hands,0) AS hands,
           GREATEST(COALESCE(a.last_at,'-infinity'::timestamptz),
                    COALESCE(b.last_at,'-infinity'::timestamptz)) AS last_at
      FROM from_rollup a
      FULL OUTER JOIN from_live b ON b.user_id = a.user_id AND b.club_id = a.club_id
  ),
  downline_agg AS MATERIALIZED (
    SELECT cm.agent_id AS upline, cm.club_id, SUM(ea.rake) AS rake
      FROM earned ea
      JOIN club_members cm ON cm.user_id = ea.user_id AND cm.club_id = ea.club_id
     WHERE cm.agent_id IS NOT NULL
     GROUP BY cm.agent_id, cm.club_id
  ),
  downline_cnt AS MATERIALIZED (
    SELECT cm.agent_id AS upline, cm.club_id, count(*)::int AS players
      FROM club_members cm
     WHERE cm.agent_id IN (SELECT player_id FROM everyone)
     GROUP BY cm.agent_id, cm.club_id
  )
  SELECT e.player_id,
         COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, left(e.player_id::text, 8)),
         e.club_id, cl.name,
         COALESCE(ag.role, 'player'),
         e.depth, e.upline_user_id,
         COALESCE(public.fn_arena_name(up.alias, up.username, up.display_name, up.first_name, up.last_name, up.full_name), up.username),
         COALESCE(ea.rake, 0), COALESCE(ea.hands, 0),
         NULLIF(ea.last_at, '-infinity'::timestamptz),
         COALESCE(dc.players, 0), COALESCE(da.rake, 0)
    FROM everyone e
    LEFT JOIN earned ea       ON ea.user_id = e.player_id AND ea.club_id = e.club_id
    LEFT JOIN downline_agg da ON da.upline  = e.player_id AND da.club_id = e.club_id
    LEFT JOIN downline_cnt dc ON dc.upline  = e.player_id AND dc.club_id = e.club_id
    LEFT JOIN profiles pr ON pr.id = e.player_id
    LEFT JOIN profiles up ON up.id = e.upline_user_id
    LEFT JOIN clubs cl    ON cl.id = e.club_id
    LEFT JOIN agents ag   ON ag.user_id = e.player_id AND ag.club_id = e.club_id
                         AND ag.status = 'active'
   WHERE (p_search IS NULL OR p_search = ''
          OR COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, '') ILIKE '%' || p_search || '%')
   ORDER BY COALESCE(ea.rake, 0) DESC
   LIMIT GREATEST(COALESCE(p_limit, 500), 1);
END $function$

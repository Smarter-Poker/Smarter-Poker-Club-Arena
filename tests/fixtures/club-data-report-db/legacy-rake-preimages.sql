-- Captured production Data reader definitions; no data or credentials.
-- Qualified by source_md5 in the migration and this native fixture.
-- fn_agent_downline_rake: 2235095280ba23d879d7318bc889e833
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
  v_overseer_clubs uuid[];
BEGIN
  IF v_root IS NULL THEN RAISE EXCEPTION 'no_agent'; END IF;

  IF NOT EXISTS (SELECT 1 FROM agents a
                  WHERE a.user_id = v_root AND a.status='active'
                    AND a.role IN ('super_agent','agent','sub_agent')
                    AND (p_club_id IS NULL OR a.club_id = p_club_id)) THEN
    RAISE EXCEPTION 'not_an_agent';
  END IF;

  IF v_caller IS NOT NULL
     AND v_caller <> v_root
     AND NOT public.fn_is_agent_ancestor(v_caller, v_root, p_club_id)
     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))
  THEN
    -- Only the overseer alternative is scoped here; retain self, ancestor,
    -- explicit club-admin and existing null-caller service behavior above.
    SELECT array_agg(DISTINCT a.club_id) INTO v_overseer_clubs
      FROM agents a
      JOIN union_clubs uc ON uc.club_id = a.club_id
     WHERE a.user_id = v_root AND a.status = 'active'
       AND a.role IN ('super_agent','agent','sub_agent')
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND public.fn_is_union_overseer(uc.union_id, v_caller);
    IF COALESCE(cardinality(v_overseer_clubs), 0) = 0 THEN
      RAISE EXCEPTION 'not_authorised';
    END IF;
  END IF;

  v_day_lo := date_trunc('day', v_from)::date;
  IF date_trunc('day', v_from) < v_from THEN v_day_lo := v_day_lo + 1; END IF;
  v_day_hi := LEAST(date_trunc('day', v_to), v_today)::date;
  IF v_day_hi < v_day_lo THEN v_day_hi := v_day_lo; END IF;

  v_head_end   := LEAST(v_day_lo::timestamptz, v_to);
  v_tail_start := GREATEST(v_day_hi::timestamptz, v_from);

  RETURN QUERY
  WITH RECURSIVE chain AS (
    SELECT a.id, a.user_id, a.club_id, a.role, a.parent_agent_id, 0 AS depth
      FROM agents a
     WHERE a.user_id = v_root AND a.status = 'active'
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND (v_overseer_clubs IS NULL OR a.club_id = ANY(v_overseer_clubs))
    UNION ALL
    SELECT c.id, c.user_id, c.club_id, c.role, c.parent_agent_id, ch.depth + 1
      FROM agents c JOIN chain ch ON c.parent_agent_id = ch.id
     WHERE c.status = 'active'
       AND (v_overseer_clubs IS NULL OR c.club_id = ANY(v_overseer_clubs))
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
  edge_att AS MATERIALIZED (
    SELECT a.player_id AS user_id, a.club_id, a.created_at, a.rake_amount, a.rake_record_id
      FROM rake_attributions a
      JOIN in_scope_clubs c ON c.club_id = a.club_id
     WHERE a.created_at >= v_from AND a.created_at < v_head_end
       AND a.rake_amount > 0 AND a.player_id IS NOT NULL
    UNION ALL
    SELECT a.player_id, a.club_id, a.created_at, a.rake_amount, a.rake_record_id
      FROM rake_attributions a
      JOIN in_scope_clubs c ON c.club_id = a.club_id
     WHERE a.created_at >= v_tail_start AND a.created_at < v_to
       AND a.rake_amount > 0 AND a.player_id IS NOT NULL
    UNION ALL
    SELECT a.player_id, a.club_id, a.created_at, a.rake_amount, a.rake_record_id
      FROM gap_days gd
      JOIN rake_attributions a
        ON a.club_id = gd.club_id
       AND a.created_at >= gd.day::timestamptz
       AND a.created_at <  (gd.day + 1)::timestamptz
     WHERE a.rake_amount > 0 AND a.player_id IS NOT NULL
  ),
  edge_split AS MATERIALIZED (
    SELECT ea.user_id, ea.club_id, ea.created_at,
           round(ea.rake_amount * 100)::bigint AS cents, ea.rake_record_id
      FROM edge_att ea
      JOIN everyone e ON e.player_id = ea.user_id AND e.club_id = ea.club_id
  ),
  from_live AS (
    SELECT s.user_id, s.club_id,
           SUM(s.cents)::numeric / 100 AS rake,
           count(*)::bigint AS hands,
           max(s.created_at) AS last_at
      FROM edge_split s
     WHERE public.fn_ca_launch_accounting_accepts(s.club_id,
             (SELECT rr.created_at FROM rake_records rr WHERE rr.id = s.rake_record_id))
     GROUP BY s.user_id, s.club_id
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
;

-- fn_agent_downline_rake_summary: 98baca865fd8c9f04ad0dcbdfc49dca7
CREATE OR REPLACE FUNCTION public.fn_agent_downline_rake_summary(p_agent_user_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_root uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_to   timestamptz := COALESCE(p_until, now());
  v_rate numeric;
  v_members int := 0; v_active int := 0; v_direct int := 0; v_subs int := 0;
  v_hands bigint := 0; v_rake numeric := 0; v_last timestamptz;
  v_top_name text; v_top_rake numeric;
BEGIN
  SELECT a.commission_rate INTO v_rate
    FROM agents a
   WHERE a.user_id = v_root AND a.status='active'
     AND (p_club_id IS NULL OR a.club_id = p_club_id)
   ORDER BY a.commission_rate DESC NULLS LAST
   LIMIT 1;

  -- One execution, one pass.
  SELECT count(*),
         count(*) FILTER (WHERE d.hands > 0),
         count(*) FILTER (WHERE d.depth = 1),
         count(*) FILTER (WHERE d.role IN ('agent','sub_agent','super_agent')),
         COALESCE(SUM(d.hands), 0),
         COALESCE(ROUND(SUM(d.rake_generated), 2), 0),
         MAX(d.last_hand_at),
         (array_agg(d.username     ORDER BY d.rake_generated DESC))[1],
         (array_agg(d.rake_generated ORDER BY d.rake_generated DESC))[1]
    INTO v_members, v_active, v_direct, v_subs, v_hands, v_rake, v_last,
         v_top_name, v_top_rake
    FROM public.fn_agent_downline_rake(v_root, p_club_id, v_from, v_to, NULL, 100000) d;

  RETURN jsonb_build_object(
    'period_start', v_from,
    'period_end',   v_to,
    'members',      v_members,
    'active',       v_active,
    'direct',       v_direct,
    'sub_agents',   v_subs,
    'hands',        v_hands,
    'rake_generated', v_rake,
    'commission_rate', COALESCE(v_rate, 0),
    'estimated_commission', ROUND(v_rake * COALESCE(v_rate, 0), 2),
    'last_hand_at', v_last,
    'top_earner', CASE WHEN v_top_name IS NULL THEN NULL
                       ELSE jsonb_build_object('username', v_top_name, 'rake', v_top_rake) END
  );
END $function$
;


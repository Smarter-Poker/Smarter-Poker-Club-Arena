-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829164257; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- PR-A part 3: fn_agent_downline_rake's edge window reads the ledger too
-- (same fn_rake_shares_for_record helper, allocator fallback). Body otherwise
-- identical to the live definition.
CREATE OR REPLACE FUNCTION public.fn_agent_downline_rake(p_agent_user_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 500)
 RETURNS TABLE(player_id uuid, username text, club_id uuid, club_name text, role text, depth integer, upline_user_id uuid, upline_name text, rake_generated numeric, hands bigint, last_hand_at timestamp with time zone, downline_players integer, downline_rake numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_root uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_since, date_trunc('week', now()));
  v_to   timestamptz := COALESCE(p_until, now());
  v_caller uuid := auth.uid();
  v_today  timestamptz := date_trunc('day', now());
  v_day_lo date;
  v_day_hi date;
  v_head_end   timestamptz;
  v_tail_start timestamptz;
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
     AND NOT EXISTS (
       SELECT 1 FROM union_clubs uc
        WHERE (p_club_id IS NULL OR uc.club_id = p_club_id)
          AND public.fn_is_union_overseer(uc.union_id, v_caller))
  THEN
    RAISE EXCEPTION 'not_authorised';
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
    UNION ALL
    SELECT c.id, c.user_id, c.club_id, c.role, c.parent_agent_id, ch.depth + 1
      FROM agents c JOIN chain ch ON c.parent_agent_id = ch.id
     WHERE c.status = 'active'
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
  edge_hands AS MATERIALIZED (
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM rake_records r
     WHERE r.created_at >= v_from AND r.created_at < v_head_end
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
    UNION ALL
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM rake_records r
     WHERE r.created_at >= v_tail_start AND r.created_at < v_to
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
    UNION ALL
    SELECT r.id, r.hand_id, r.club_id, r.created_at, r.rake_amount, r.player_contributions, r.rake_method
      FROM gap_days gd
      JOIN rake_records r
        ON r.club_id = gd.club_id
       AND r.created_at >= gd.day::timestamptz
       AND r.created_at <  (gd.day + 1)::timestamptz
     WHERE r.rake_amount > 0 AND r.player_contributions IS NOT NULL
  ),
  -- LEDGER-READ (2026-08-29): stored per-player credits when present, the
  -- canonical allocator when not.
  edge_split AS MATERIALIZED (
    SELECT s.user_id, eh.club_id, eh.created_at,
           round(s.credit * 100)::bigint AS cents
      FROM edge_hands eh
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        eh.hand_id, eh.rake_amount, eh.player_contributions, COALESCE(eh.rake_method, 'DEALT_EQUAL')
      ) s
  ),
  from_live AS (
    SELECT s.user_id, s.club_id,
           SUM(s.cents)::numeric / 100 AS rake,
           count(*)::bigint AS hands,
           max(s.created_at) AS last_at
      FROM edge_split s
      JOIN everyone e ON e.player_id = s.user_id AND e.club_id = s.club_id
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
         COALESCE(pr.display_name, pr.username, left(e.player_id::text, 8)),
         e.club_id, cl.name,
         COALESCE(ag.role, 'player'),
         e.depth, e.upline_user_id,
         COALESCE(up.display_name, up.username),
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
          OR COALESCE(pr.display_name, pr.username, '') ILIKE '%' || p_search || '%')
   ORDER BY COALESCE(ea.rake, 0) DESC
   LIMIT GREATEST(COALESCE(p_limit, 500), 1);
END $function$;

-- Functional smoke: recompute yesterday's rollup for the busiest club through
-- the new ledger path and require it to write rows without error.
DO $$
DECLARE v_club uuid; v_rows int;
BEGIN
  SELECT r.club_id INTO v_club FROM rake_records r
   WHERE r.created_at >= (current_date - 1)::timestamptz AND r.created_at < current_date::timestamptz
     AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
   GROUP BY r.club_id ORDER BY count(*) DESC LIMIT 1;
  IF v_club IS NULL THEN
    RAISE NOTICE 'smoke: no raked hands yesterday — skipping rollup smoke';
    RETURN;
  END IF;
  v_rows := public.fn_club_rake_rollup_day(v_club, current_date - 1);
  IF v_rows <= 0 THEN
    RAISE EXCEPTION 'smoke: rollup wrote no rows for club % on %', v_club, current_date - 1;
  END IF;
  RAISE NOTICE 'smoke: rollup rewrote % rows for club % via ledger path', v_rows, v_club;
END $$;

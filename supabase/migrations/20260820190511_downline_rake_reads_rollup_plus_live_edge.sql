-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820190511 "downline_rake_reads_rollup_plus_live_edge"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cc7a66bacc8f6ff1102b4a3d3121a805 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Hybrid read: completed days come from club_rake_daily_user, and only the
-- partial edges of the window — today, plus any part-day at the start — are
-- expanded live from rake_records. Same even-split arithmetic in both halves,
-- so the boundary is invisible and the figure still matches what gets paid.
--
-- Before: ~12s for a week, ~35s for 30 days, and a statement timeout before
-- the earlier optimisation pass.

CREATE OR REPLACE FUNCTION public.fn_agent_downline_rake(
  p_agent_user_id uuid DEFAULT NULL,
  p_club_id       uuid DEFAULT NULL,
  p_since         timestamptz DEFAULT NULL,
  p_until         timestamptz DEFAULT NULL,
  p_search        text DEFAULT NULL,
  p_limit         integer DEFAULT 500
) RETURNS TABLE (
  player_id       uuid,
  username        text,
  club_id         uuid,
  club_name       text,
  role            text,
  depth           integer,
  upline_user_id  uuid,
  upline_name     text,
  rake_generated  numeric,
  hands           bigint,
  last_hand_at    timestamptz,
  downline_players integer,
  downline_rake   numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_root uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_since, date_trunc('week', now()));
  v_to   timestamptz := COALESCE(p_until, now());
  v_caller uuid := auth.uid();
  v_today timestamptz := date_trunc('day', now());
  v_roll_from date;
  v_roll_to   date;   -- exclusive
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

  -- Whole days only, and never today (today is still accumulating).
  v_roll_from := date_trunc('day', v_from)::date;
  IF date_trunc('day', v_from) < v_from THEN
    v_roll_from := v_roll_from + 1;   -- partial first day stays live
  END IF;
  v_roll_to := LEAST(date_trunc('day', v_to), v_today)::date;
  IF v_roll_to < v_roll_from THEN v_roll_to := v_roll_from; END IF;

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
  ids AS MATERIALIZED (
    SELECT array_agg(DISTINCT player_id::text) AS keys FROM everyone
  ),
  -- COMPLETED DAYS — indexed lookup, no jsonb expansion.
  from_rollup AS (
    SELECT rd.user_id, rd.club_id,
           SUM(rd.rake_amount) AS rake,
           SUM(rd.hands)::bigint AS hands,
           MAX((rd.day + 1)::timestamptz) AS last_at
      FROM club_rake_daily_user rd
      JOIN everyone e ON e.player_id = rd.user_id AND e.club_id = rd.club_id
     WHERE rd.day >= v_roll_from AND rd.day < v_roll_to
     GROUP BY rd.user_id, rd.club_id
  ),
  -- PARTIAL EDGES — today, and any part-day at the start of the window.
  edge_hands AS MATERIALIZED (
    SELECT r.id, r.club_id, r.created_at, r.rake_amount, r.player_contributions
      FROM rake_records r, ids
     WHERE r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
       AND ids.keys IS NOT NULL
       AND r.player_contributions ?| ids.keys
       AND (
         (r.created_at >= v_from AND r.created_at < v_roll_from::timestamptz)
         OR
         (r.created_at >= GREATEST(v_roll_to::timestamptz, v_from) AND r.created_at < v_to)
       )
  ),
  edge_split AS MATERIALIZED (
    SELECT (k.key)::uuid AS user_id, eh.club_id, eh.created_at,
           (round(eh.rake_amount * 100)::bigint / count(*) OVER (PARTITION BY eh.id))
           + CASE WHEN row_number() OVER (PARTITION BY eh.id ORDER BY k.key)
                       <= (round(eh.rake_amount * 100)::bigint % count(*) OVER (PARTITION BY eh.id))
                  THEN 1 ELSE 0 END AS cents
      FROM edge_hands eh
      JOIN LATERAL jsonb_each(eh.player_contributions) k
        ON (CASE WHEN jsonb_typeof(k.value) = 'number'
                 THEN (k.value)::numeric ELSE 0 END) > 0
  ),
  from_live AS (
    SELECT s.user_id, s.club_id,
           SUM(s.cents)::numeric / 100 AS rake,
           count(*)::bigint AS hands,
           max(s.created_at) AS last_at
      FROM edge_split s
     GROUP BY s.user_id, s.club_id
  ),
  earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id, b.user_id) AS user_id,
           COALESCE(a.club_id, b.club_id) AS club_id,
           COALESCE(a.rake,0) + COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0) + COALESCE(b.hands,0) AS hands,
           GREATEST(COALESCE(a.last_at, '-infinity'::timestamptz),
                    COALESCE(b.last_at, '-infinity'::timestamptz)) AS last_at
      FROM from_rollup a
      FULL OUTER JOIN from_live b
        ON b.user_id = a.user_id AND b.club_id = a.club_id
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
         e.club_id,
         cl.name,
         COALESCE(ag.role, 'player'),
         e.depth,
         e.upline_user_id,
         COALESCE(up.display_name, up.username),
         COALESCE(ea.rake, 0),
         COALESCE(ea.hands, 0),
         NULLIF(ea.last_at, '-infinity'::timestamptz),
         COALESCE(dc.players, 0),
         COALESCE(da.rake, 0)
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

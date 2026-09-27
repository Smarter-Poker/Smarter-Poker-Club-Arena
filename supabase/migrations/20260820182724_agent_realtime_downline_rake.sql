-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820182724 "agent_realtime_downline_rake"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1770c8ef3020a2699b9749cf60db31c0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- REAL-TIME DOWNLINE RAKE.
--
-- Until now the only way an agent could see rake was fn_agent_roster_report,
-- which reads settled/periodised data. Rake is generated continuously and an
-- agent needs to watch it as it happens, for their whole downline and for any
-- individual member of it.
--
-- ATTRIBUTION. rake_records.player_contributions lists who was in the hand.
-- fn_rakeback_recompute_periods splits a hand's rake EVENLY between the
-- contributing players (not proportionally to contribution), distributing the
-- remainder cents to the lowest-sorted keys. This view must use the identical
-- rule or an agent's live figure would disagree with the statement they are
-- eventually paid on. Same arithmetic, expressed with a window function
-- instead of a correlated subquery so it is fast enough for a live screen.
--
-- VISIBILITY. Rake stats are an agent privilege. A plain player calling this
-- gets not_authorised — the role gate is here, not only in the UI.

-- Is p_ancestor somewhere above p_descendant in the agent tree?
CREATE OR REPLACE FUNCTION public.fn_is_agent_ancestor(
  p_ancestor_user_id uuid, p_descendant_user_id uuid, p_club_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH RECURSIVE up AS (
    SELECT a.id, a.user_id, a.parent_agent_id
      FROM agents a
     WHERE a.user_id = p_descendant_user_id
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
    UNION ALL
    SELECT p.id, p.user_id, p.parent_agent_id
      FROM agents p JOIN up ON up.parent_agent_id = p.id
  )
  SELECT EXISTS (SELECT 1 FROM up WHERE up.user_id = p_ancestor_user_id
                                    AND up.user_id <> p_descendant_user_id);
$$;

-- What agent roles does the caller hold, and where? Drives whether the UI
-- shows the Rake tab at all.
CREATE OR REPLACE FUNCTION public.fn_my_agent_roles()
RETURNS TABLE (club_id uuid, club_name text, role text, agent_id uuid, is_overseer boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT a.club_id,
         c.name,
         a.role,
         a.id,
         COALESCE(public.fn_is_union_overseer(uc.union_id, auth.uid()), false)
    FROM agents a
    JOIN clubs c ON c.id = a.club_id
    LEFT JOIN union_clubs uc ON uc.club_id = a.club_id
   WHERE a.user_id = auth.uid()
     AND a.status = 'active'
     AND a.role IN ('super_agent','agent','sub_agent')
   ORDER BY c.name;
$$;

-- Per-player live rake for an agent's entire downline.
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
AS $$
DECLARE
  v_root uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_since, date_trunc('week', now()));
  v_to   timestamptz := COALESCE(p_until, now());
  v_caller uuid := auth.uid();
BEGIN
  IF v_root IS NULL THEN
    RAISE EXCEPTION 'no_agent';
  END IF;

  -- The root must actually be an agent. Players have no downline and no
  -- entitlement to rake reporting.
  IF NOT EXISTS (SELECT 1 FROM agents a
                  WHERE a.user_id = v_root AND a.status='active'
                    AND a.role IN ('super_agent','agent','sub_agent')
                    AND (p_club_id IS NULL OR a.club_id = p_club_id)) THEN
    RAISE EXCEPTION 'not_an_agent';
  END IF;

  -- Caller may read their own book, anything below them, or anything in a
  -- union they oversee. Service role (NULL uid) is unrestricted.
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

  RETURN QUERY
  WITH RECURSIVE chain AS (
    -- the agent themselves
    SELECT a.id, a.user_id, a.club_id, a.role, a.parent_agent_id, 0 AS depth
      FROM agents a
     WHERE a.user_id = v_root
       AND a.status = 'active'
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
    UNION ALL
    -- every agent beneath them
    SELECT c.id, c.user_id, c.club_id, c.role, c.parent_agent_id, ch.depth + 1
      FROM agents c
      JOIN chain ch ON c.parent_agent_id = ch.id
     WHERE c.status = 'active'
  ),
  -- every player reporting to anyone in the chain, in the chain's clubs
  roster AS (
    SELECT DISTINCT cm.user_id AS player_id, cm.club_id, cm.agent_id AS upline_user_id,
           ch.depth + 1 AS depth
      FROM club_members cm
      JOIN chain ch ON ch.user_id = cm.agent_id AND ch.club_id = cm.club_id
     WHERE cm.agent_id IS NOT NULL
  ),
  -- the agents themselves are also rake-generating members
  everyone AS (
    SELECT player_id, club_id, upline_user_id, depth FROM roster
    UNION
    SELECT ch.user_id, ch.club_id,
           (SELECT p.user_id FROM agents p WHERE p.id = ch.parent_agent_id),
           ch.depth
      FROM chain ch
     WHERE ch.depth > 0
  ),
  -- per-hand even split, matching fn_rakeback_recompute_periods exactly
  split AS (
    SELECT (k.key)::uuid AS user_id,
           r.club_id,
           r.created_at,
           (round(r.rake_amount * 100)::bigint / count(*) OVER (PARTITION BY r.id))
           + CASE WHEN row_number() OVER (PARTITION BY r.id ORDER BY k.key)
                       <= (round(r.rake_amount * 100)::bigint % count(*) OVER (PARTITION BY r.id))
                  THEN 1 ELSE 0 END AS cents
      FROM rake_records r
      JOIN LATERAL jsonb_each(r.player_contributions) k ON (k.value)::numeric > 0
     WHERE r.created_at >= v_from
       AND r.created_at <  v_to
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
       AND (p_club_id IS NULL OR r.club_id = p_club_id)
  ),
  earned AS (
    SELECT s.user_id, s.club_id,
           SUM(s.cents)::numeric / 100 AS rake,
           count(*)::bigint AS hands,
           max(s.created_at) AS last_at
      FROM split s
     WHERE EXISTS (SELECT 1 FROM everyone e
                    WHERE e.player_id = s.user_id AND e.club_id = s.club_id)
     GROUP BY s.user_id, s.club_id
  )
  SELECT e.player_id,
         COALESCE(pr.display_name, pr.username, left(e.player_id::text, 8)) AS username,
         e.club_id,
         cl.name,
         COALESCE(ag.role, 'player') AS role,
         e.depth,
         e.upline_user_id,
         COALESCE(up.display_name, up.username) AS upline_name,
         COALESCE(ea.rake, 0) AS rake_generated,
         COALESCE(ea.hands, 0) AS hands,
         ea.last_at,
         -- if this member is themselves an agent, how big is their own book
         COALESCE((SELECT count(*)::int FROM club_members cm2
                    WHERE cm2.agent_id = e.player_id AND cm2.club_id = e.club_id), 0),
         COALESCE((SELECT SUM(x.cents)::numeric / 100
                     FROM split x
                    WHERE x.club_id = e.club_id
                      AND EXISTS (SELECT 1 FROM club_members cm3
                                   WHERE cm3.user_id = x.user_id
                                     AND cm3.club_id = e.club_id
                                     AND cm3.agent_id = e.player_id)), 0)
    FROM everyone e
    LEFT JOIN earned ea ON ea.user_id = e.player_id AND ea.club_id = e.club_id
    LEFT JOIN profiles pr ON pr.id = e.player_id
    LEFT JOIN profiles up ON up.id = e.upline_user_id
    LEFT JOIN clubs cl ON cl.id = e.club_id
    LEFT JOIN agents ag ON ag.user_id = e.player_id AND ag.club_id = e.club_id
                       AND ag.status = 'active'
   WHERE (p_search IS NULL OR p_search = ''
          OR COALESCE(pr.display_name, pr.username, '') ILIKE '%' || p_search || '%')
   ORDER BY COALESCE(ea.rake, 0) DESC
   LIMIT GREATEST(COALESCE(p_limit, 500), 1);
END $$;

REVOKE ALL ON FUNCTION public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer) TO service_role;

REVOKE ALL ON FUNCTION public.fn_is_agent_ancestor(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_is_agent_ancestor(uuid,uuid,uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_is_agent_ancestor(uuid,uuid,uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_my_agent_roles() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_my_agent_roles() FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_my_agent_roles() TO authenticated, service_role;

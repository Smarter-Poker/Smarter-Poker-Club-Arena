-- 20261022044452_player_record_shows_the_full_upline_agent_chain.sql
--
-- Version is the one the Supabase MCP recorded when this was applied to
-- production (2026-10-22 04:44 UTC), so the file and schema_migrations agree.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-21: "WHEN YOU CLICK ON ANY PLAYER INSIDE MY CLUB, I SHOULD BE
-- ABLE TO SEE WHO IS UPLINE AGENT(S) ARE." The Player Record only printed the
-- direct agent (ca_club_member_detail.identity.upline_name), on one line near
-- the bottom of the Membership Record card. A player under a sub agent under a
-- super agent showed one name and hid the rest of the chain.
--
-- ca_club_member_upline_chain(club, user) walks club_members.agent_id upward
-- inside the club, from the player's direct agent to the top of the chain,
-- and returns every level in order: depth, user id, Arena name, player number
-- and club role. It is a separate read so ca_club_member_detail (and the laws
-- pinned to its newest definition) is untouched.
--
-- Access is the same gate the record's financial view uses: only a viewer
-- that ca_club_roster_access grants staff, downline or service sees the
-- chain; anyone else gets NULL, exactly as upline_name is nulled for them.
-- The walk is cycle safe (path array) and capped at 20 levels, the same cap
-- the record's downline tree uses. Deleted profiles are skipped, matching the
-- record's upline join. Measured on production before apply: 1.2 ms for a
-- three-level chain (Newmania24 -> TomTomTamale -> kingfish).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION public.ca_club_member_upline_chain(p_club_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_out jsonb;
BEGIN
  IF v_access IS NULL OR v_access NOT IN ('staff', 'downline', 'service') THEN
    RETURN NULL;
  END IF;

  WITH RECURSIVE chain AS (
    SELECT first_agent.agent_id AS uid, 1 AS depth,
           ARRAY[p_user_id, first_agent.agent_id] AS path
      FROM (
        SELECT cm.agent_id
          FROM public.club_members cm
         WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id
           AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         ORDER BY public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
         LIMIT 1
      ) first_agent
     WHERE first_agent.agent_id IS NOT NULL AND first_agent.agent_id <> p_user_id
    UNION ALL
    SELECT nxt.agent_id, c.depth + 1, c.path || nxt.agent_id
      FROM chain c
      CROSS JOIN LATERAL (
        SELECT cm.agent_id
          FROM public.club_members cm
         WHERE cm.club_id = p_club_id AND cm.user_id = c.uid
           AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         ORDER BY public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
         LIMIT 1
      ) nxt
     WHERE nxt.agent_id IS NOT NULL
       AND NOT nxt.agent_id = ANY (c.path)
       AND c.depth < 20
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'depth', c.depth,
           'user_id', c.uid,
           'name', coalesce(nullif(btrim(u.alias), ''),
                            nullif(btrim(public.fn_arena_name(u.alias, u.username, u.display_name, u.first_name, u.last_name, u.full_name)), ''),
                            u.username),
           'player_number', u.player_number,
           'role', r.role
         ) ORDER BY c.depth), '[]'::jsonb)
    INTO v_out
    FROM chain c
    JOIN public.profiles u ON u.id = c.uid AND u.status IS DISTINCT FROM 'deleted'
    LEFT JOIN LATERAL (
      SELECT cm.role
        FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = c.uid
         AND coalesce(cm.status, 'approved') IN ('active', 'approved')
       ORDER BY public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
       LIMIT 1
    ) r ON true;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_member_upline_chain(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_upline_chain(uuid, uuid) TO authenticated, service_role;

COMMIT;

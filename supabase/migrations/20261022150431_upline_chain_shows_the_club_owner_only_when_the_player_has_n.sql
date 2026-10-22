-- 20261022150431_upline_chain_shows_the_club_owner_only_when_the_player_has_n.sql
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-22: "kingfish is never the upline agent if they have an agent,
-- only if they don't have an agent."
--
-- ca_club_member_upline_chain walked club_members.agent_id all the way up, and
-- every top agent's agent_id is the club owner, so a player under DarthBayter
-- printed "Upline Level 2 (Owner) KingFish". The club owner is the default
-- home for players nobody brought in, not a level above every agent.
--
-- Now:
--   * the walk stops at the club owner; the owner is never printed above an
--     agent;
--   * a player whose direct agent IS the owner still shows the owner as Direct
--     Upline (the owner is genuinely their agent);
--   * a player with no agent (joined without a referral code) shows the club
--     owner as Direct Upline, marked "assigned": false so the player record's
--     Assign To Agent control knows the stored agent is empty.
--   * every row carries "assigned" (true for a real agent_id link).
--
-- Access, cycle safety, the 20-level cap and deleted-profile skipping are
-- unchanged from 20261022044452.
--
-- Wrap ALL DDL for one change in ONE transaction (club-arena CLAUDE.md).

BEGIN;

CREATE OR REPLACE FUNCTION public.ca_club_member_upline_chain(p_club_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_owner  uuid;
  v_out    jsonb;
BEGIN
  IF v_access IS NULL OR v_access NOT IN ('staff', 'downline', 'service') THEN
    RETURN NULL;
  END IF;

  SELECT c.owner_id INTO v_owner FROM public.clubs c WHERE c.id = p_club_id;

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
       AND c.uid IS DISTINCT FROM v_owner          -- the owner is the top; stop there
       AND nxt.agent_id IS DISTINCT FROM v_owner   -- never print the owner above an agent
       AND NOT nxt.agent_id = ANY (c.path)
       AND c.depth < 20
  ),
  levels AS (
    SELECT c.uid, c.depth, true AS assigned FROM chain c
    UNION ALL
    -- No agent: the player sits directly under the club owner.
    SELECT v_owner, 1, false
     WHERE v_owner IS NOT NULL AND v_owner <> p_user_id
       AND NOT EXISTS (SELECT 1 FROM chain)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'depth', l.depth,
           'user_id', l.uid,
           'name', coalesce(nullif(btrim(u.alias), ''),
                            nullif(btrim(public.fn_arena_name(u.alias, u.username, u.display_name, u.first_name, u.last_name, u.full_name)), ''),
                            u.username),
           'player_number', u.player_number,
           'role', coalesce(r.role, CASE WHEN l.uid = v_owner THEN 'owner' END),
           'assigned', l.assigned
         ) ORDER BY l.depth), '[]'::jsonb)
    INTO v_out
    FROM levels l
    JOIN public.profiles u ON u.id = l.uid AND u.status IS DISTINCT FROM 'deleted'
    LEFT JOIN LATERAL (
      SELECT cm.role
        FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = l.uid
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

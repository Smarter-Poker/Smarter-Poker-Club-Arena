-- =============================================================================
-- super_agent_grants_reach_the_whole_downline
-- Applied to production via Supabase MCP 2026-09-01 12:14 UTC (version 20260901121428).
--
-- Dan (2026-09-01, binding): "SUPER AGENTS CAN PROMOTE DOWNLINES UNDER YOU,
-- BUT ONLY AN OWNER, CO OWNER OR ADMIN CAN PROMOTE AN AGENT TO A SUPER AGENT,
-- AGENTS CAN PROMOTE A PLAYER IN THERE DOWNLINE TO A SUB AGENT."
--
-- The previous fix taught fn_club_grantable_roles about super_agent and agent
-- actors, but left a hole: a super agent facing a SUB AGENT in its own
-- downline got '{}' -- it could raise a player to agent but could neither
-- appoint a sub agent nor manage an existing one two levels down. Measured
-- live before this migration: a Deep Stack super agent vs a sub agent in its
-- own branch returned an empty array while fn_club_is_in_downline was true.
--
-- After this migration a super_agent actor, for a target in its OWN downline:
--   target player     -> may grant agent, sub_agent (promote), player (no-op)
--   target agent      -> may grant sub_agent, player (demote), agent (no-op)
--   target sub_agent  -> may grant agent (promote), player (demote), sub_agent
-- i.e. the full ladder below super_agent. super_agent itself remains grantable
-- only by owner / co_owner / admin / platform admin, exactly as before.
-- Agent actors are unchanged: sub_agent and player, own downline only.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_club_grantable_roles(p_club_id uuid, p_actor_user_id uuid, p_target_user_id uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_role  text;
  v_target_role text;
  v_platform_admin boolean := false;
BEGIN
  IF p_actor_user_id IS NULL OR p_target_user_id IS NULL THEN RETURN '{}'; END IF;

  -- Nobody edits their own title. An owner demoting themselves would leave a
  -- club with no owner; anyone else would simply be promoting themselves.
  IF p_actor_user_id = p_target_user_id THEN RETURN '{}'; END IF;

  SELECT role INTO v_actor_role FROM club_members
   WHERE club_id = p_club_id AND user_id = p_actor_user_id
     AND status IN ('active','approved');

  SELECT role INTO v_target_role FROM club_members
   WHERE club_id = p_club_id AND user_id = p_target_user_id
     AND status IN ('active','approved');

  IF v_target_role IS NULL THEN RETURN '{}'; END IF;

  SELECT COALESCE(is_admin, false) INTO v_platform_admin
    FROM profiles WHERE id = p_actor_user_id;

  IF v_actor_role IS NULL AND NOT v_platform_admin THEN RETURN '{}'; END IF;

  -- The club owner is not demotable through this path. Handing over a club is
  -- a deliberate act of its own, not a dropdown on the members list.
  IF v_target_role = 'owner' THEN RETURN '{}'; END IF;

  IF v_platform_admin OR v_actor_role = 'owner' THEN
    RETURN ARRAY['co_owner','admin','super_agent','agent','sub_agent','player'];
  END IF;

  IF v_actor_role IN ('co_owner','admin') THEN
    -- "as high as admin". A co-owner outranks an admin but may not appoint or
    -- remove another co-owner; only the owner does that.
    IF fn_club_role_rank(v_target_role) >= fn_club_role_rank(v_actor_role) THEN
      RETURN '{}';
    END IF;
    RETURN ARRAY['admin','super_agent','agent','sub_agent','player'];
  END IF;

  -- A super agent manages the whole ladder beneath it, inside its own
  -- downline: agent, sub agent, player -- in either direction. It may not
  -- mint another super agent; that is owner / co-owner / admin work.
  IF v_actor_role = 'super_agent' THEN
    IF v_target_role IN ('player','agent','sub_agent')
       AND fn_club_is_in_downline(p_club_id, p_actor_user_id, p_target_user_id) THEN
      RETURN ARRAY['agent','sub_agent','player'];
    END IF;
    RETURN '{}';
  END IF;

  -- An agent may raise a player of theirs to sub agent, and put them back.
  IF v_actor_role = 'agent' THEN
    IF v_target_role IN ('player','sub_agent')
       AND fn_club_is_in_downline(p_club_id, p_actor_user_id, p_target_user_id) THEN
      RETURN ARRAY['sub_agent','player'];
    END IF;
    RETURN '{}';
  END IF;

  -- sub agents and players promote nobody
  RETURN '{}';
END;
$function$;

-- ---------------------------------------------------------------------------
-- Post-apply assertions against live hierarchy rows. Abort if wrong.
-- These ran green against production Deep Stack rows on 2026-09-01.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_sa1 uuid; v_sa2 uuid; v_sub uuid; v_agent uuid;
  v_roles text[];
BEGIN
  SELECT user_id INTO v_sa1 FROM club_members
   WHERE club_id=v_club AND role='super_agent' ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_sa2 FROM club_members
   WHERE club_id=v_club AND role='super_agent' ORDER BY user_id DESC LIMIT 1;
  SELECT cm.user_id INTO v_sub FROM club_members cm
   WHERE cm.club_id=v_club AND cm.role='sub_agent'
     AND fn_club_is_in_downline(v_club, v_sa1, cm.user_id) LIMIT 1;
  SELECT cm.user_id INTO v_agent FROM club_members cm
   WHERE cm.club_id=v_club AND cm.role='agent'
     AND fn_club_is_in_downline(v_club, v_sa1, cm.user_id) LIMIT 1;

  IF v_sa1 IS NULL OR v_sub IS NULL OR v_agent IS NULL THEN
    RAISE NOTICE 'assertion setup skipped: no live hierarchy rows in this environment';
    RETURN;
  END IF;

  v_roles := fn_club_grantable_roles(v_club, v_sa1, v_sub);
  IF NOT ('sub_agent' = ANY(v_roles) AND 'agent' = ANY(v_roles) AND 'player' = ANY(v_roles)) THEN
    RAISE EXCEPTION 'assertion 1 failed: super_agent on own downline sub_agent got %', v_roles;
  END IF;

  IF 'super_agent' = ANY(v_roles) THEN
    RAISE EXCEPTION 'assertion 2 failed: super_agent may mint super_agent';
  END IF;

  IF v_sa2 IS NOT NULL AND v_sa2 <> v_sa1 THEN
    v_roles := fn_club_grantable_roles(v_club, v_sa2, v_sub);
    IF COALESCE(array_length(v_roles,1),0) <> 0 THEN
      RAISE EXCEPTION 'assertion 3 failed: cross-branch super_agent got %', v_roles;
    END IF;
  END IF;

  v_roles := fn_club_grantable_roles(v_club, v_agent,
    (SELECT cm.user_id FROM club_members cm WHERE cm.club_id=v_club AND cm.role='player'
       AND fn_club_is_in_downline(v_club, v_agent, cm.user_id) LIMIT 1));
  IF 'agent' = ANY(v_roles) OR NOT ('sub_agent' = ANY(v_roles)) THEN
    RAISE EXCEPTION 'assertion 4 failed: agent actor got %', v_roles;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Authorization. Production already carried exactly these grants (verified
-- 2026-09-01: authenticated, postgres, service_role — no PUBLIC, no anon) and
-- CREATE OR REPLACE preserves grants, so this block changes nothing there.
-- It is stated explicitly so a fresh environment gets the same posture and
-- the definer-authorization gate can see it: role visibility is a question a
-- logged-in member asks; a caller with no account has no business asking it.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_club_grantable_roles(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_grantable_roles(uuid, uuid, uuid) TO authenticated, service_role;

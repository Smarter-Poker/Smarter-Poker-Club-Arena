-- ═══════════════════════════════════════════════════════════════════════════
--  AN UNAUTHENTICATED CALLER MUST NOT BE ABLE TO NAME ITSELF THE ACTOR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_club_set_member_role decided who was acting with:
--
--     v_actor := COALESCE(auth.uid(), p_actor_user_id);
--
-- auth.uid() is NULL for `anon` BY DEFINITION, so for an unauthenticated
-- caller that COALESCE falls through to p_actor_user_id - a value the CALLER
-- supplies. Everything downstream then authorises against that spoofed
-- identity: fn_club_grantable_roles(p_club_id, v_actor, p_user_id) decides
-- what roles may be granted, and the audit_trail row is written naming the
-- spoofed actor as the person who did it.
--
-- The function holds EXECUTE for PUBLIC and for anon (verified in pg_proc.proacl:
-- `=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres`),
-- and it is reachable over PostgREST as /rest/v1/rpc/fn_club_set_member_role.
-- So anyone holding only the publishable anon key could pass any club owner's
-- uuid as p_actor_user_id and set any member's role in that club - including
-- granting co_owner or admin. Club uuids and user uuids are not secrets; they
-- travel in ordinary listing payloads.
--
-- NOT PROVEN BY EXPLOITING IT. CLAUDE.md 11.5 forbids probing a live privilege
-- path against production, so this was established by reading the definition,
-- the ACL and the grant history - not by calling it. The grant arrives in
-- 20260822_club_roles_rpcs.sql:105, `TO authenticated, anon`, on a THREE-argument
-- version of the function; the live one has six arguments and the COALESCE,
-- so the anon grant outlived the shape it was written for.
--
-- THE FIX IS TWO INDEPENDENT LAYERS, because either alone would be enough and
-- neither alone is trustworthy:
--
--   1. The function refuses to take its actor from a parameter unless the
--      caller is a trusted backend. auth.uid() is the only identity a browser
--      can establish. The service_role escape hatch uses the house pattern
--      documented in scripts/ci/check-definer-authorization.mjs:
--      COALESCE(auth.role(),'service_role') = 'service_role' - true only when
--      there is no JWT at all (a direct backend connection) or the JWT is
--      literally service_role. For anon over PostgREST auth.role() is 'anon',
--      so it is false.
--
--   2. PUBLIC and anon lose EXECUTE outright. No legitimate caller is
--      affected: the only caller in the codebase is
--      src/pages/MemberManagementPage.tsx:746, and it passes p_club_id,
--      p_user_id and p_role ONLY - it has never supplied p_actor_user_id and
--      relies on auth.uid() already.
--
-- The parameter is deliberately KEPT rather than dropped. Dropping it changes
-- the signature, and PostgREST resolves overloads by argument names, so a
-- caller sending the old shape would get a confusing 404 instead of a clear
-- refusal. It now means "a trusted backend is naming the actor", which is a
-- real use, rather than "anyone may claim to be anyone".

BEGIN;

-- ── Layer 1: the function asks, and no longer accepts the caller's answer ──
CREATE OR REPLACE FUNCTION public.fn_club_set_member_role(
  p_club_id uuid,
  p_user_id uuid,
  p_role text,
  p_actor_user_id uuid DEFAULT NULL::uuid,
  p_commission_rate numeric DEFAULT NULL::numeric,
  p_player_rakeback_rate numeric DEFAULT NULL::numeric
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor      uuid;
  v_old_role   text;
  v_actor_role text;
  v_allowed    text[];
  v_downline   int;
  v_agent_id   uuid;
  v_parent     uuid;
  v_set_upline boolean := false;
  v_is_agent   boolean;
  v_is_staff   boolean;
  v_comm       numeric;
  v_rake       numeric;
  v_have_row   boolean := false;
  v_cap_comm   numeric;
  v_cap_rake   numeric;
BEGIN
  -- IDENTITY. auth.uid() is the ONLY identity a browser can establish; it is
  -- NULL for anon, and a NULL here used to mean "believe p_actor_user_id".
  -- A caller-supplied actor is now accepted from a trusted backend only.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    IF COALESCE(auth.role(), 'service_role') = 'service_role'
       AND p_actor_user_id IS NOT NULL THEN
      v_actor := p_actor_user_id;
    ELSE
      RETURN jsonb_build_object('success', false, 'error', 'actor identity required');
    END IF;
  END IF;

  IF p_role IS NULL OR p_role NOT IN
     ('co_owner','admin','super_agent','agent','sub_agent','player') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid role: ' || COALESCE(p_role,'null'));
  END IF;

  v_is_agent := p_role IN ('super_agent','agent','sub_agent');
  v_is_staff := p_role IN ('co_owner','admin');

  IF NOT v_is_agent
     AND (COALESCE(p_commission_rate, 0) <> 0 OR COALESCE(p_player_rakeback_rate, 0) <> 0) THEN
    RETURN jsonb_build_object('success', false,
      'error', CASE WHEN v_is_staff
                    THEN 'co owners and admins receive no rakeback, so no rate may be set for one'
                    ELSE 'only an agent role carries a commission or rakeback rate' END);
  END IF;

  SELECT role INTO v_old_role FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id
     AND status IN ('active','approved')
   FOR UPDATE;

  IF v_old_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'target is not a member of this club');
  END IF;

  IF v_old_role = p_role THEN
    RETURN jsonb_build_object('success', true, 'unchanged', true, 'role', p_role);
  END IF;

  v_allowed := fn_club_grantable_roles(p_club_id, v_actor, p_user_id);
  IF NOT (p_role = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not permitted to set this role',
      'allowed', COALESCE(to_jsonb(v_allowed), '[]'::jsonb));
  END IF;

  SELECT role INTO v_actor_role FROM club_members
   WHERE club_id = p_club_id AND user_id = v_actor AND status IN ('active','approved');

  IF fn_club_role_rank(v_old_role) > fn_club_role_rank(p_role)
     AND v_old_role IN ('super_agent','agent','sub_agent') THEN
    SELECT count(*) INTO v_downline FROM club_members
     WHERE club_id = p_club_id AND agent_id = p_user_id;
    IF v_downline > 0 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'this member still has ' || v_downline || ' player'
                 || CASE WHEN v_downline = 1 THEN '' ELSE 's' END
                 || ' reporting to them. Move them to another agent first.',
        'downline_count', v_downline);
    END IF;
  END IF;

  v_set_upline := v_actor_role IN ('super_agent','agent')
                  AND p_role IN ('agent','sub_agent');

  -- The rate is CHOSEN. It used to be invented here, differently per tier, and
  -- not applied at all when the agents row already existed.
  IF v_is_agent THEN
    SELECT a.commission_rate, a.player_rakeback_rate
      INTO v_comm, v_rake
      FROM agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id;
    v_have_row := FOUND;

    v_comm := COALESCE(p_commission_rate, v_comm);
    v_rake := COALESCE(p_player_rakeback_rate, v_rake);

    IF v_comm IS NULL OR v_rake IS NULL THEN
      RETURN jsonb_build_object('success', false, 'needs_rates', true,
        'error', 'a commission rate and a player rakeback rate must be chosen when granting an agent role');
    END IF;
    IF v_comm < 0 OR v_comm > 0.70 THEN
      RETURN jsonb_build_object('success', false, 'error', 'the commission rate must be between 0 and 0.70');
    END IF;
    IF v_rake < 0 OR v_rake > 0.50 THEN
      RETURN jsonb_build_object('success', false, 'error', 'the player rakeback rate must be between 0 and 0.50');
    END IF;
    IF v_rake > v_comm THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the player rakeback rate cannot exceed the commission rate it is paid out of');
    END IF;

    IF v_set_upline THEN
      SELECT id, commission_rate, player_rakeback_rate
        INTO v_parent, v_cap_comm, v_cap_rake
        FROM agents WHERE club_id = p_club_id AND user_id = v_actor;
    ELSIF v_have_row THEN
      SELECT p.commission_rate, p.player_rakeback_rate
        INTO v_cap_comm, v_cap_rake
        FROM agents a JOIN agents p ON p.id = a.parent_agent_id
       WHERE a.club_id = p_club_id AND a.user_id = p_user_id;
    END IF;

    IF v_cap_comm IS NOT NULL AND v_comm > v_cap_comm THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the commission rate cannot exceed the upline rate of ' || v_cap_comm);
    END IF;
    IF v_cap_rake IS NOT NULL AND v_rake > v_cap_rake THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the player rakeback rate cannot exceed the upline rate of ' || v_cap_rake);
    END IF;
  END IF;

  PERFORM set_config('app.club_role_change', 'on', true);

  UPDATE club_members
     SET role                = p_role,
         agent_id            = CASE WHEN v_set_upline THEN v_actor ELSE agent_id END,
         player_rakeback_pct = CASE WHEN v_is_staff THEN 0 ELSE player_rakeback_pct END,
         rakeback_rate       = CASE WHEN v_is_staff THEN 0 ELSE rakeback_rate END,
         commission_rate     = CASE WHEN v_is_staff THEN 0 ELSE commission_rate END,
         updated_at          = now()
   WHERE club_id = p_club_id AND user_id = p_user_id;

  PERFORM set_config('app.club_role_change', '', true);

  IF v_is_agent THEN
    SELECT id INTO v_agent_id FROM agents
     WHERE club_id = p_club_id AND user_id = p_user_id;

    IF v_agent_id IS NOT NULL THEN
      UPDATE agents
         SET role = p_role, status = 'active',
             parent_agent_id = COALESCE(v_parent, parent_agent_id),
             commission_rate = v_comm, player_rakeback_rate = v_rake,
             updated_at = now()
       WHERE id = v_agent_id;
    ELSE
      INSERT INTO agents (club_id, user_id, role, status, parent_agent_id,
                          commission_rate, player_rakeback_rate, credit_limit)
      VALUES (p_club_id, p_user_id, p_role, 'active', v_parent, v_comm, v_rake, 0)
      RETURNING id INTO v_agent_id;
    END IF;
  ELSE
    UPDATE agents
       SET status = CASE WHEN v_old_role IN ('super_agent','agent','sub_agent')
                         THEN 'suspended' ELSE status END,
           commission_rate      = CASE WHEN v_is_staff THEN 0 ELSE commission_rate END,
           player_rakeback_rate = CASE WHEN v_is_staff THEN 0 ELSE player_rakeback_rate END,
           updated_at = now()
     WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  INSERT INTO audit_trail (actor_id, actor_role, action, target_type, target_id,
                           club_id, before_state, after_state, reason)
  VALUES (v_actor, COALESCE(v_actor_role, 'platform_admin'), 'set_member_role',
          'club_member', p_user_id, p_club_id,
          jsonb_build_object('role', v_old_role),
          jsonb_build_object('role', p_role, 'upline_set', v_set_upline,
                             'commission_rate', v_comm, 'player_rakeback_rate', v_rake),
          'Role changed via fn_club_set_member_role');

  RETURN jsonb_build_object('success', true, 'old_role', v_old_role, 'new_role', p_role,
    'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
    'reports_to', CASE WHEN v_set_upline THEN v_actor ELSE NULL END);
END;
$function$;

-- ── Layer 2: a browser without a session cannot reach it at all ────────────
-- PUBLIC is revoked as well as anon: proacl carried `=X/postgres`, so revoking
-- anon alone would have left the same access through the PUBLIC grant.
REVOKE ALL ON FUNCTION public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric)
  TO authenticated, service_role;

-- ── Assertions: this migration must not silently no-op ────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric)'::regprocedure,
       'EXECUTE') THEN
    RAISE EXCEPTION 'anon still holds EXECUTE on fn_club_set_member_role';
  END IF;

  IF NOT has_function_privilege('authenticated',
       'public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric)'::regprocedure,
       'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated LOST EXECUTE - the member management page would break';
  END IF;

  IF pg_get_functiondef(
       'public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric)'::regprocedure
     ) ~ 'COALESCE\(auth\.uid\(\), p_actor_user_id\)' THEN
    RAISE EXCEPTION 'the spoofable COALESCE is still present in the body';
  END IF;
END $$;

COMMIT;

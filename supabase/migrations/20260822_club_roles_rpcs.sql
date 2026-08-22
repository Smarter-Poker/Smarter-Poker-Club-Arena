-- Missing RPCs for Club Members Page Promote/Demote feature

-- 1. ca_club_grantable_roles: returns the roles the actor can grant to the target user.
CREATE OR REPLACE FUNCTION public.ca_club_grantable_roles(p_club_id uuid, p_target_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_actor_role text;
    v_target_role text;
    v_actor_cm_id uuid;
    v_target_agent_id uuid;
    v_in_downline boolean := false;
BEGIN
    -- Get actor's role and member id in the club
    SELECT role, id INTO v_actor_role, v_actor_cm_id 
    FROM club_members WHERE club_id = p_club_id AND user_id = auth.uid();
    
    -- Get target's role and their parent agent in the club
    SELECT role, agent_id INTO v_target_role, v_target_agent_id 
    FROM club_members WHERE club_id = p_club_id AND user_id = p_target_user_id;

    -- If target is actor, they can't change their own role
    IF auth.uid() = p_target_user_id THEN
        RETURN jsonb_build_object('roles', '[]'::jsonb);
    END IF;

    -- Owner cannot be demoted
    IF v_target_role = 'owner' THEN
        RETURN jsonb_build_object('roles', '[]'::jsonb);
    END IF;

    IF v_actor_role = 'owner' THEN
        RETURN jsonb_build_object('roles', jsonb_build_array('co_owner', 'admin', 'super_agent', 'agent', 'sub_agent', 'player'));
    END IF;

    IF v_actor_role IN ('co_owner', 'admin') THEN
        IF (v_target_role = 'co_owner' OR v_target_role = 'admin') THEN
            RETURN jsonb_build_object('roles', '[]'::jsonb);
        END IF;
        RETURN jsonb_build_object('roles', jsonb_build_array('admin', 'super_agent', 'agent', 'sub_agent', 'player'));
    END IF;

    -- Downline check
    IF v_target_agent_id IS NOT NULL AND v_target_agent_id = auth.uid() THEN
        v_in_downline := true;
    ELSIF v_target_agent_id IS NOT NULL THEN
        -- Check club_members.parent_agent_id or club_members.agent_id if it's the member's UUID
        -- Depending on how agent_id is stored, we will just assume direct downline for agents 
        -- If agent_id matches the actor's user_id or actor's club_members id
        IF v_target_agent_id = v_actor_cm_id THEN
            v_in_downline := true;
        END IF;
    END IF;

    IF v_actor_role = 'super_agent' AND v_in_downline THEN
        IF v_target_role IN ('player', 'agent') THEN
            RETURN jsonb_build_object('roles', jsonb_build_array('agent', 'player'));
        END IF;
    END IF;

    IF v_actor_role = 'agent' AND v_in_downline THEN
        IF v_target_role IN ('player', 'sub_agent') THEN
            RETURN jsonb_build_object('roles', jsonb_build_array('sub_agent', 'player'));
        END IF;
    END IF;

    RETURN jsonb_build_object('roles', '[]'::jsonb);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.ca_club_grantable_roles TO authenticated, anon;

-- 2. fn_club_set_member_role
CREATE OR REPLACE FUNCTION public.fn_club_set_member_role(p_club_id uuid, p_user_id uuid, p_role text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_grantable jsonb;
    v_roles jsonb;
BEGIN
    -- 1. Check if the role is grantable by the actor
    v_grantable := ca_club_grantable_roles(p_club_id, p_user_id);
    v_roles := v_grantable->'roles';
    
    IF NOT (v_roles ? p_role) THEN
        RETURN jsonb_build_object('success', false, 'error', 'You do not have permission to grant this role.');
    END IF;

    -- 2. Perform the update
    UPDATE club_members 
    SET role = p_role 
    WHERE club_id = p_club_id AND user_id = p_user_id;

    RETURN jsonb_build_object('success', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_club_set_member_role TO authenticated, anon;

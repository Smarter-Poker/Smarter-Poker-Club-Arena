-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815154851 "fix_conversation_authz_allow_service_role"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 08a26cfa1b87f7fdaca14a9491875c94 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- fn_get_or_create_conversation: keep the IDOR fix, restore the server path
-- ═══════════════════════════════════════════════════════════════════════════
-- The 2026-08-15 security fix correctly stopped a browser caller from passing
-- someone else's id (SECURITY DEFINER + identity-as-parameter = IDOR). But it
-- rejected EVERY call where auth.uid() IS NULL -- which includes the trusted
-- server routes that reach this RPC with the service_role key after they have
-- already authenticated the user from the JWT:
--     pages/api/messenger/start-conversation.js   (all messenger DMs)
--     pages/api/club-arena/approve-cashout.js     (cashout notification thread)
--     pages/api/club-arena/request-cashout.js
-- Result: messenger conversation creation returned 'not authorized' for
-- everyone, personal and club alike.
--
-- Same allowance used by atomic_chip_transfer: a service_role caller is trusted
-- (it authorized upstream); any other caller must BE p_user_id.
--
-- Also revokes EXECUTE from anon on the 4-arg overload -- the earlier fix
-- revoked it on the 2-arg overload only, leaving the unauthenticated spam
-- vector open on this one.

CREATE OR REPLACE FUNCTION public.fn_get_or_create_conversation(
  p_user_id uuid,
  p_other_user_id uuid,
  p_context_entity_id uuid,
  p_context_entity_type text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_existing_id uuid;
    v_new_id uuid;
BEGIN
    IF p_user_id IS NULL OR p_other_user_id IS NULL OR p_user_id = p_other_user_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid user pair');
    END IF;

    -- IDOR guard (2026-08-15) + service_role allowance: a JWT caller may only
    -- act as themselves; service_role has already authenticated upstream.
    IF COALESCE(auth.role(), '') <> 'service_role'
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;

    SELECT c.id INTO v_existing_id
      FROM social_conversations c
      JOIN social_conversation_participants p1
        ON p1.conversation_id = c.id AND p1.user_id = p_user_id
      JOIN social_conversation_participants p2
        ON p2.conversation_id = c.id AND p2.user_id = p_other_user_id
     WHERE c.is_group = false
       AND p1.context_entity_id IS NOT DISTINCT FROM p_context_entity_id
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', true, 'conversation_id', v_existing_id, 'created', false);
    END IF;

    INSERT INTO social_conversations (is_group, context_entity_id, context_entity_type)
    VALUES (false, p_context_entity_id, p_context_entity_type)
    RETURNING id INTO v_new_id;

    INSERT INTO social_conversation_participants
        (conversation_id, user_id, context_entity_id, context_entity_type)
    VALUES
        (v_new_id, p_user_id, p_context_entity_id, p_context_entity_type),
        (v_new_id, p_other_user_id, NULL, NULL);

    RETURN jsonb_build_object('success', true, 'conversation_id', v_new_id, 'created', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_or_create_conversation(
  p_user_id uuid,
  p_other_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_existing_id uuid;
    v_new_id uuid;
BEGIN
    IF p_user_id IS NULL OR p_other_user_id IS NULL OR p_user_id = p_other_user_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid user pair');
    END IF;

    IF COALESCE(auth.role(), '') <> 'service_role'
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;

    SELECT c.id INTO v_existing_id
      FROM social_conversations c
      JOIN social_conversation_participants p1
        ON p1.conversation_id = c.id AND p1.user_id = p_user_id
      JOIN social_conversation_participants p2
        ON p2.conversation_id = c.id AND p2.user_id = p_other_user_id
     WHERE c.is_group = false
       AND p1.context_entity_id IS NOT DISTINCT FROM NULL
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', true, 'conversation_id', v_existing_id, 'created', false);
    END IF;

    INSERT INTO social_conversations (is_group) VALUES (false) RETURNING id INTO v_new_id;
    INSERT INTO social_conversation_participants (conversation_id, user_id)
    VALUES (v_new_id, p_user_id), (v_new_id, p_other_user_id);

    RETURN jsonb_build_object('success', true, 'conversation_id', v_new_id, 'created', true);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_get_or_create_conversation(uuid, uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_get_or_create_conversation(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_get_or_create_conversation(uuid, uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_or_create_conversation(uuid, uuid) TO authenticated, service_role;

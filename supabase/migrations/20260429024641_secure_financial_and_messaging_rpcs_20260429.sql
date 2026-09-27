-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429024641 "secure_financial_and_messaging_rpcs_20260429"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 360bd3123e8b902b088d008d6e9bf582 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

REVOKE EXECUTE ON FUNCTION public.fn_send_message(uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_send_message(uuid, uuid, text, text, jsonb) FROM anon;

CREATE OR REPLACE FUNCTION public.fn_send_message(
  p_conversation_id uuid, p_sender_id uuid, p_content text,
  p_message_type text DEFAULT 'text'::text, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_message_id uuid; v_is_participant boolean; v_caller_role text; v_caller_uid uuid;
BEGIN
    IF p_conversation_id IS NULL OR p_sender_id IS NULL OR COALESCE(p_content,'') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing conversation/sender/content');
    END IF;
    v_caller_role := COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
    v_caller_uid := auth.uid();
    IF v_caller_role = 'authenticated' THEN
        IF v_caller_uid IS NULL OR p_sender_id <> v_caller_uid THEN
            RETURN jsonb_build_object('success', false, 'error', 'forbidden: cannot send messages as another user');
        END IF;
    ELSIF v_caller_role = 'anon' OR v_caller_role = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden: anonymous callers cannot send messages');
    END IF;
    SELECT EXISTS (SELECT 1 FROM social_conversation_participants WHERE conversation_id = p_conversation_id AND user_id = p_sender_id) INTO v_is_participant;
    IF NOT v_is_participant THEN
        RETURN jsonb_build_object('success', false, 'error', 'sender is not a participant');
    END IF;
    INSERT INTO social_messages (conversation_id, sender_id, content, message_type)
    VALUES (p_conversation_id, p_sender_id, p_content, COALESCE(p_message_type, 'text'))
    RETURNING id INTO v_message_id;
    RETURN jsonb_build_object('success', true, 'message_id', v_message_id, 'conversation_id', p_conversation_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_add_chips(uuid, uuid, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_add_chips(uuid, uuid, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_add_chips(uuid, uuid, numeric) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_add_diamonds(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_add_diamonds(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_add_diamonds(uuid, integer) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_add_prepaid_credit_atomic(uuid, uuid, numeric, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_add_prepaid_credit_atomic(uuid, uuid, numeric, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_add_prepaid_credit_atomic(uuid, uuid, numeric, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_create_settlement_period(uuid, uuid, date, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_create_settlement_period(uuid, uuid, date, date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_create_settlement_period(uuid, uuid, date, date) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_create_media_upload(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_create_media_upload(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_create_media_upload(uuid, text, text) FROM authenticated;

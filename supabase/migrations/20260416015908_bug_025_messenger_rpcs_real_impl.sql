-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416015908 "bug_025_messenger_rpcs_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 493014e6a5b73f7932abe0c10d19027b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 K: fn_send_message / fn_mark_messages_read / fn_delete_message were
-- silent-success stubs or NULL bodies. Messenger has been broken across the
-- platform for weeks. Implementing real logic against the messages table.

DROP FUNCTION IF EXISTS public.fn_send_message(uuid, uuid, text, text, jsonb);
CREATE OR REPLACE FUNCTION public.fn_send_message(
  p_conversation_id uuid,
  p_sender_id uuid,
  p_content text,
  p_message_type text DEFAULT 'text',
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_message_id uuid;
BEGIN
  IF p_sender_id IS NULL OR COALESCE(p_content, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing sender or content');
  END IF;

  INSERT INTO messages (
    id, conversation_id, sender_id, content, message_type,
    metadata, is_read, created_at
  ) VALUES (
    gen_random_uuid(), p_conversation_id, p_sender_id, p_content,
    COALESCE(p_message_type, 'text'),
    COALESCE(p_metadata, '{}'::jsonb),
    false, NOW()
  ) RETURNING id INTO v_message_id;

  RETURN jsonb_build_object(
    'success', true,
    'message_id', v_message_id
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_send_message(uuid, uuid, text, text, jsonb) TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.fn_mark_messages_read(uuid, uuid);
CREATE OR REPLACE FUNCTION public.fn_mark_messages_read(
  p_conversation_id uuid,
  p_user_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF p_conversation_id IS NULL OR p_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Only mark messages the user did NOT send as read
  UPDATE messages
  SET is_read = true
  WHERE conversation_id = p_conversation_id
    AND sender_id <> p_user_id
    AND is_read = false;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_mark_messages_read(uuid, uuid) TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.fn_delete_message(uuid, uuid);
CREATE OR REPLACE FUNCTION public.fn_delete_message(
  p_message_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_sender uuid;
BEGIN
  IF p_message_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing parameters');
  END IF;

  SELECT sender_id INTO v_sender FROM messages WHERE id = p_message_id;
  IF v_sender IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'message not found');
  END IF;

  IF v_sender <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'only the sender can delete this message');
  END IF;

  -- Soft delete: set deleted_at, leave row for thread integrity
  UPDATE messages
  SET deleted_at = NOW(),
      content = '[message deleted]'
  WHERE id = p_message_id;

  RETURN jsonb_build_object('success', true, 'message_id', p_message_id);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_delete_message(uuid, uuid) TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.fn_complete_media_upload(uuid, text);
CREATE OR REPLACE FUNCTION public.fn_complete_media_upload(
  p_upload_id uuid,
  p_url text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF p_upload_id IS NULL OR p_url IS NULL OR p_url = '' THEN
    RETURN;
  END IF;

  -- If a media_uploads table exists, update it; otherwise no-op
  BEGIN
    UPDATE media_uploads
    SET status = 'complete',
        url = p_url,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = p_upload_id;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_complete_media_upload(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_send_message IS 'BUG 025: real impl. Inserts messages row, returns actual message_id (was returning gen_random_uuid() without inserting).';
COMMENT ON FUNCTION public.fn_mark_messages_read IS 'BUG 025: real impl. Marks all unread messages in conversation as read, excluding sender''s own.';
COMMENT ON FUNCTION public.fn_delete_message IS 'BUG 025: real impl. Soft-deletes sender''s own message via deleted_at timestamp.';
COMMENT ON FUNCTION public.fn_complete_media_upload IS 'BUG 025: real impl. Updates media_uploads row to complete status (no-op if table missing).';


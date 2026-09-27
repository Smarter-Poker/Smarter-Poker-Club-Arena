-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820235830 "club_messenger_delivers_when_owner_is_union_owner"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ce0a48e00e74fccf2d10c8b6ba63a033 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FIX: the first cut of fn_union_send_club_message delivered NOTHING.
--
-- It skipped any recipient equal to the sender, on the reasonable-looking
-- ground that you do not message yourself. On Midway that is every recipient:
-- the union owner and the owner of both member clubs are the same account, so
-- the statement had nowhere to go and messenger_deliveries came back 0.
--
-- That is not only a test-data quirk. A union owner who also runs a member
-- club is a normal arrangement, and when it happens the statement for that
-- club must still land somewhere they can read it. So the thread is now built
-- from the DISTINCT participant set: two people give a normal two-way thread,
-- one person gives a self-thread, which the messenger lists correctly because
-- it matches conversations on participant_ids containing the viewer and
-- counts unread on messages.receiver_id.
--
-- Applied to production via Supabase MCP as
-- 'club_messenger_delivers_when_owner_is_union_owner'.
CREATE OR REPLACE FUNCTION public.fn_union_send_club_message(
  p_union_id   uuid,
  p_club_id    uuid,
  p_content    text,
  p_metadata   jsonb DEFAULT '{}'::jsonb,
  p_message_type text DEFAULT 'message')
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_sender uuid;
  v_conv   uuid;
  v_parts  uuid[];
  v_sent   int := 0;
  r        record;
BEGIN
  SELECT u.owner_id INTO v_sender FROM unions u WHERE u.id = p_union_id;
  IF v_sender IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union has no owner to send as');
  END IF;

  FOR r IN
    SELECT DISTINCT x.uid
      FROM (
        SELECT c.owner_id AS uid FROM clubs c
         WHERE c.id = p_club_id AND c.owner_id IS NOT NULL
        UNION
        SELECT cm.user_id FROM club_members cm
         WHERE cm.club_id = p_club_id
           AND cm.role IN ('owner','admin')
           AND COALESCE(cm.status,'active') NOT IN ('banned','suspended')
      ) x
     WHERE x.uid IS NOT NULL
       AND EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = x.uid)
  LOOP
    -- one participant when the union owner IS the club owner, two otherwise
    SELECT ARRAY(SELECT DISTINCT p FROM unnest(ARRAY[v_sender, r.uid]) p) INTO v_parts;

    SELECT c.id INTO v_conv
      FROM conversations c
     WHERE c.category = 'club'
       AND c.club_id = p_club_id
       AND c.participant_ids @> v_parts
       AND array_length(c.participant_ids, 1) = array_length(v_parts, 1)
     ORDER BY c.created_at ASC
     LIMIT 1;

    IF v_conv IS NULL THEN
      INSERT INTO conversations (participant_ids, category, club_id, created_by)
      VALUES (v_parts, 'club', p_club_id, v_sender)
      RETURNING id INTO v_conv;
    END IF;

    INSERT INTO messages (conversation_id, sender_id, receiver_id, recipient_id,
                          club_id, content, message_type, metadata, is_read)
    VALUES (v_conv, v_sender, r.uid, r.uid, p_club_id,
            p_content, p_message_type, p_metadata, false);

    UPDATE conversations SET updated_at = now() WHERE id = v_conv;
    v_sent := v_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'delivered', v_sent);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_send_club_message(uuid, uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;

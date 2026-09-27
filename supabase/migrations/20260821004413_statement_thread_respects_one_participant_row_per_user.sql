-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821004413 "statement_thread_respects_one_participant_row_per_user"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cce6d1c5096bfdb2e26f9916cd3d7d44 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FIX: social_conversation_participants has UNIQUE (conversation_id, user_id).
--
-- The first cut gave the union owner a participant row carrying the UNION page
-- context and then gave each club owner/admin a row carrying the CLUB page
-- context, so the same thread would surface under both identities. On Midway
-- the union owner IS both club owners, so the second insert hit
--   23505 social_conversation_participants_conversation_id_user_id_key
-- and no statement was delivered at all.
--
-- One row per user is the rule, so the context has to be chosen, not layered.
-- A statement is FOR the club, so the club context wins: recipients are seated
-- first with the club's page id, and the union owner is only seated afterwards
-- (with the union's page id) if they are not already in the thread. A union
-- owner who also owns the club therefore reads it in that club's inbox, which
-- is where a club statement belongs.
--
-- Applied to production via Supabase MCP as
-- 'statement_thread_respects_one_participant_row_per_user'.
CREATE OR REPLACE FUNCTION public.fn_union_send_club_message(
  p_union_id   uuid,
  p_club_id    uuid,
  p_content    text,
  p_metadata   jsonb DEFAULT '{}'::jsonb,
  p_message_type text DEFAULT 'text')
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_sender      uuid;
  v_union_name  text;
  v_union_page  uuid;
  v_club_page   uuid;
  v_conv        uuid;
  v_title       text;
  v_msg_id      uuid;
  v_recipients  int := 0;
  r             record;
BEGIN
  SELECT u.owner_id, u.name INTO v_sender, v_union_name
    FROM unions u WHERE u.id = p_union_id;
  IF v_sender IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union has no owner to send as');
  END IF;

  SELECT sp.id INTO v_union_page FROM social_pages sp
   WHERE sp.linked_entity_id = p_union_id::text AND sp.linked_entity_type = 'club' LIMIT 1;
  SELECT sp.id INTO v_club_page FROM social_pages sp
   WHERE sp.linked_entity_id = p_club_id::text AND sp.linked_entity_type = 'club' LIMIT 1;

  v_title := COALESCE(v_union_name, 'Union') || ' Statements';

  SELECT c.id INTO v_conv
    FROM social_conversations c
   WHERE c.is_group = true
     AND c.group_name = v_title
     AND c.context_entity_id IS NOT DISTINCT FROM v_club_page
   ORDER BY c.created_at ASC
   LIMIT 1;

  IF v_conv IS NULL THEN
    INSERT INTO social_conversations (is_group, group_name, context_entity_id, context_entity_type)
    VALUES (true, v_title, v_club_page, CASE WHEN v_club_page IS NULL THEN NULL ELSE 'club' END)
    RETURNING id INTO v_conv;
  END IF;

  -- RECIPIENTS FIRST, seated under the CLUB identity.
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
    INSERT INTO social_conversation_participants
      (conversation_id, user_id, context_entity_id, context_entity_type)
    VALUES (v_conv, r.uid, v_club_page,
            CASE WHEN v_club_page IS NULL THEN NULL ELSE 'club' END)
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
    v_recipients := v_recipients + 1;
  END LOOP;

  IF v_recipients = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'club has no owner or admin with a profile',
                              'conversation_id', v_conv);
  END IF;

  -- The union owner joins under the UNION identity only if they are not
  -- already seated as a club recipient (one row per user is enforced).
  INSERT INTO social_conversation_participants
    (conversation_id, user_id, context_entity_id, context_entity_type)
  VALUES (v_conv, v_sender, v_union_page,
          CASE WHEN v_union_page IS NULL THEN NULL ELSE 'club' END)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  INSERT INTO social_messages (conversation_id, sender_id, content, message_type, media_metadata)
  VALUES (v_conv, v_sender, p_content,
          COALESCE(NULLIF(p_message_type, ''), 'text'),
          CASE WHEN p_metadata = '{}'::jsonb OR p_metadata IS NULL THEN NULL ELSE p_metadata END)
  RETURNING id INTO v_msg_id;

  UPDATE social_conversations
     SET last_message_at = now(),
         last_message_preview = left(regexp_replace(p_content, E'\\s+', ' ', 'g'), 100),
         updated_at = now()
   WHERE id = v_conv;

  RETURN jsonb_build_object('success', true, 'delivered', v_recipients,
                            'conversation_id', v_conv, 'message_id', v_msg_id,
                            'club_page', v_club_page, 'union_page', v_union_page);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_send_club_message(uuid, uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;

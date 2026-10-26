-- =====================================================================
-- 20261024200633_messenger_named_threads_and_read_clears_notifications.sql
-- =====================================================================
-- TIER:        2
-- AUTHOR:      Claude (owner request, 2026-10-24)
-- AFFECTS:     fn_get_user_conversations, fn_mark_messages_read_through,
--              fn_deliver_club_messenger_welcome,
--              notifications (DML: stale new_message rows marked read)
-- IRREVERSIBLE: no (rollback section below restores both functions)
--
-- WHY:
--   Owner: "REMOVE ANY AND ALL MESSAGES FROM UNKNOWN AND NEW PLAYERS SHOULD
--   NEVER BE UNKNOWN" and "NOTIFICATIONS COUNTER SHOULD DISAPPEAR AFTER YOU
--   CLICK AND READ MESSAGES".
--   1. 435 one-to-one threads had no other participant. 433 of them are the
--      club agent welcome (fn_send_club_welcome_text inserts BOTH people);
--      every recipient account was deleted afterwards, deletion removed the
--      recipient's participant row, and the surviving side rendered the
--      thread as "Unknown". The inbox reader joined the missing person with
--      a LEFT JOIN and returned the orphan anyway.
--   2. The name was COALESCE(display_name, username) only; three live
--      profiles have neither and rendered as "Unknown".
--   3. Reading a thread moved last_read_at but never touched the user's
--      new_message notifications, so the bell kept counting messages that
--      were already read (all 4 unread new_message rows at write time).
--
-- HOW (high level):
--   - fn_get_user_conversations: a non-group thread is returned only when the
--     other person still has a profile. The name falls back through
--     display_name, username, alias, then "Player #<number>". full_name is
--     deliberately excluded: it is a column-protected real name.
--     Signature, auth check and ordering are unchanged. Nothing is deleted:
--     orphaned threads are simply never listed or counted.
--   - fn_mark_messages_read_through: in the same transaction, marks the
--     reader's new_message notifications for that thread read, up to the
--     first message that is still unread (a later message keeps its alert).
--   - fn_deliver_club_messenger_welcome: the agent welcome is never sent to
--     certification equipment (fn_ca_is_cert_account), which stops new
--     orphaned threads at the source. Horses are never equipment and keep it.
--   - One-time: mark the already-stale new_message notifications read.
-- =====================================================================

--
-- =====================================================================
-- ROLLBACK (copy-paste): restore the previous definitions.
--   fn_get_user_conversations: name = COALESCE(ou.display_name, ou.username)
--     and remove the "AND (COALESCE(c.is_group,false) OR ou.id IS NOT NULL)"
--     line.
--   fn_mark_messages_read_through: remove the v_next_unread SELECT and the
--     UPDATE notifications block.
--   fn_deliver_club_messenger_welcome: remove the fn_ca_is_cert_account line.
-- Notifications marked read by the one-time repair were for already-read
-- threads and are not restored.
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
    IF to_regprocedure('public.fn_get_user_conversations(uuid,uuid)') IS NULL
       OR to_regprocedure('public.fn_mark_messages_read_through(uuid,uuid,uuid)') IS NULL THEN
        RAISE EXCEPTION 'pre-flight failed: messenger inbox functions missing';
    END IF;
    IF to_regprocedure('public.fn_deliver_club_messenger_welcome()') IS NULL
       OR to_regprocedure('public.fn_ca_is_cert_account(uuid)') IS NULL THEN
        RAISE EXCEPTION 'pre-flight failed: welcome trigger or certification predicate missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='player_number')
       OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='alias')
       OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='notifications' AND column_name='is_read')
       OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='notifications' AND column_name='read_at') THEN
        RAISE EXCEPTION 'pre-flight failed: expected profile/notification columns missing';
    END IF;
END $$;

-- This repository's history last defined the one-argument reader. Production
-- already serves only the two-argument one (read 2026-10-24), so this drop is a
-- no-op there; it keeps exactly one door by name wherever an older copy lives.
DROP FUNCTION IF EXISTS public.fn_get_user_conversations(uuid);

CREATE OR REPLACE FUNCTION public.fn_get_user_conversations(p_user_id uuid, p_context_entity_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(conversation_id uuid, title text, is_group boolean, last_message_at timestamp with time zone, unread_count bigint, other_user_id uuid, other_user_username text, other_user_avatar text, context_entity_id uuid, context_entity_type text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() IS DISTINCT FROM p_user_id)) THEN
        RAISE EXCEPTION 'fn_get_user_conversations: not authorized to read another user''s inbox';
    END IF;

    RETURN QUERY
    SELECT
        c.id AS conversation_id,
        COALESCE(c.group_name, NULL) AS title,
        c.is_group,
        c.last_message_at,
        (
            SELECT COUNT(*)
              FROM social_messages m
             WHERE m.conversation_id = c.id
               AND m.sender_id != p_user_id
               AND COALESCE(m.is_deleted, false) = false
               AND NOT EXISTS(SELECT 1 FROM public.messenger_hidden_messages hidden WHERE hidden.user_id=p_user_id AND hidden.message_id=m.id)
               AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)
        ) AS unread_count,
        ou.id AS other_user_id,
        -- Never nameless: every profile carries a player number.
        COALESCE(
            NULLIF(btrim(ou.display_name), ''),
            NULLIF(btrim(ou.username), ''),
            NULLIF(btrim(ou.alias), ''),
            CASE WHEN ou.id IS NOT NULL THEN 'Player #' || COALESCE(NULLIF(btrim(ou.player_number), ''), left(ou.id::text, 8)) END
        ) AS other_user_username,
        ou.avatar_url AS other_user_avatar,
        p.context_entity_id,
        p.context_entity_type
    FROM social_conversations c
    JOIN social_conversation_participants p
      ON p.conversation_id = c.id AND p.user_id = p_user_id
    LEFT JOIN social_conversation_participants op
      ON op.conversation_id = c.id AND op.user_id <> p_user_id
    LEFT JOIN profiles ou ON ou.id = op.user_id
    WHERE p.context_entity_id IS NOT DISTINCT FROM p_context_entity_id
      -- A one-to-one thread whose other person no longer exists (deleted
      -- account) is never listed or counted: it would render as "Unknown".
      AND (COALESCE(c.is_group, false) OR ou.id IS NOT NULL)
      AND EXISTS (
        SELECT 1 FROM public.social_messages m
        WHERE m.conversation_id = c.id
          AND NOT EXISTS (
            SELECT 1 FROM public.accounting_invoice_deliveries d
            JOIN public.settlement_invoices si ON si.id = d.invoice_id
            WHERE d.message_id = m.id
              AND si.invoice_type IS DISTINCT FROM 'cashier_cashout'
          )
      )
    ORDER BY c.last_message_at DESC NULLS LAST;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_mark_messages_read_through(p_conversation_id uuid, p_user_id uuid, p_through_message_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_through timestamptz;
  v_next_unread timestamptz;
  v_count integer;
BEGIN
  IF p_conversation_id IS NULL OR p_user_id IS NULL OR p_through_message_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing parameters');
  END IF;
  -- Serialize receipts for one reader without locking other readers or sends.
  PERFORM 1 FROM social_conversation_participants
   WHERE conversation_id=p_conversation_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not a participant');
  END IF;
  SELECT created_at INTO v_through FROM social_messages
   WHERE id=p_through_message_id AND conversation_id=p_conversation_id
     AND COALESCE(is_deleted, false)=false;
  IF v_through IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid read boundary');
  END IF;
  WITH inserted AS (
    INSERT INTO social_message_reads(message_id,user_id,read_at)
    SELECT m.id,p_user_id,NOW() FROM social_messages m
     WHERE m.conversation_id=p_conversation_id
       AND m.created_at<=v_through
       AND m.sender_id IS DISTINCT FROM p_user_id
       AND COALESCE(m.is_deleted,false)=false
    ON CONFLICT(message_id,user_id) DO NOTHING RETURNING 1
  ) SELECT COUNT(*) INTO v_count FROM inserted;
  UPDATE social_conversation_participants
     SET last_read_at=GREATEST(last_read_at,v_through)
   WHERE conversation_id=p_conversation_id AND user_id=p_user_id;

  -- Reading the thread clears its message alerts. A notification created
  -- before the next still-unread message existed can only announce a message
  -- that is now read; a later message keeps its own alert.
  SELECT min(m.created_at) INTO v_next_unread FROM social_messages m
   WHERE m.conversation_id=p_conversation_id
     AND m.created_at>v_through
     AND m.sender_id IS DISTINCT FROM p_user_id
     AND COALESCE(m.is_deleted,false)=false;
  UPDATE notifications
     SET read=true, is_read=true, read_at=COALESCE(read_at, NOW()), updated_at=NOW()
   WHERE user_id=p_user_id
     AND type='new_message'
     AND data->>'conversationId'=p_conversation_id::text
     AND (read IS DISTINCT FROM true OR is_read IS DISTINCT FROM true)
     AND created_at < COALESCE(v_next_unread, 'infinity'::timestamptz);

  RETURN jsonb_build_object('success',true,'marked',v_count,'readThrough',v_through);
END $function$;

-- 4. Root cause of the nameless threads: post-deploy certification probes
--    (ca-customization-cert-postdeploy-%@example.invalid) join the owner's
--    club, receive the agent welcome, and are deleted ~52 s later. The
--    welcome never goes to certification equipment. fn_ca_is_cert_account
--    never classifies a horse as equipment (CLAUDE.md 10.5), so every horse
--    and every person still gets the welcome exactly as before.
CREATE OR REPLACE FUNCTION public.fn_deliver_club_messenger_welcome()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_member record; v_admission record; v_sender uuid; v_owner uuid; v_template record; v_result jsonb;
BEGIN
 SELECT * INTO v_member FROM public.club_members WHERE club_id=NEW.club_id AND user_id=NEW.user_id;
 IF NOT FOUND OR v_member.is_active IS NOT TRUE OR v_member.status NOT IN ('active','approved') OR v_member.membership_lifecycle_status<>'active' THEN RETURN NEW; END IF;
 IF public.fn_ca_is_cert_account(NEW.user_id) THEN RETURN NEW; END IF;
 SELECT * INTO v_admission FROM public.club_messenger_admissions WHERE club_id=NEW.club_id AND user_id=NEW.user_id AND active AND transaction_id=txid_current() FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.club_messenger_welcome_deliveries WHERE generation=v_admission.generation) THEN RETURN NEW; END IF;
 SELECT owner_id INTO v_owner FROM public.clubs WHERE id=NEW.club_id;
 v_sender:=v_member.agent_id;
 IF v_sender IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.agents WHERE club_id=NEW.club_id AND user_id=v_sender AND status='active') THEN v_sender:=NULL; END IF;
 IF v_sender IS NULL OR public.fn_club_messenger_staff_role(NEW.club_id,v_sender) IS NULL THEN v_sender:=v_owner; END IF;
 IF v_sender IS NULL OR v_sender=NEW.user_id THEN RETURN NEW; END IF;
 SELECT * INTO v_template FROM public.club_messenger_welcome_templates WHERE club_id=NEW.club_id AND user_id=v_sender AND enabled FOR SHARE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 v_result:=public.fn_send_club_welcome_text(NEW.club_id,NEW.user_id,v_sender,v_template.content,v_template.revision,'downline');
 IF v_result->>'status'='cancelled' THEN RETURN NEW; END IF;
 INSERT INTO public.club_messenger_welcome_deliveries(generation,club_id,recipient_id,sender_id,template_revision,conversation_id,message_id,status)
 VALUES(v_admission.generation,NEW.club_id,NEW.user_id,v_sender,v_template.revision,(v_result->>'conversation_id')::uuid,(v_result->>'message_id')::uuid,v_result->>'status');
 IF v_result->>'status'='sent' AND v_owner<>NEW.user_id THEN
  INSERT INTO public.club_messenger_owner_followups(generation,club_id,recipient_id,sender_id,content,template_revision,due_at)
  SELECT v_admission.generation,NEW.club_id,NEW.user_id,v_owner,t.content,t.revision,clock_timestamp()+interval '10 minutes'
  FROM public.club_messenger_owner_welcome_templates t WHERE t.club_id=NEW.club_id AND t.user_id=v_owner AND t.enabled
  ON CONFLICT(generation) DO NOTHING;
 END IF;
 RETURN NEW;
END $function$;

-- One-time repair: alerts for threads the reader has already read past.
UPDATE notifications n
   SET read=true, is_read=true, read_at=COALESCE(n.read_at, NOW()), updated_at=NOW()
  FROM social_conversation_participants p
 WHERE n.type='new_message'
   AND (n.read IS DISTINCT FROM true OR n.is_read IS DISTINCT FROM true)
   AND p.user_id=n.user_id
   AND p.conversation_id::text=n.data->>'conversationId'
   AND p.last_read_at IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM social_messages m
        WHERE m.conversation_id=p.conversation_id
          AND m.created_at>p.last_read_at
          AND m.created_at<=n.created_at
          AND m.sender_id IS DISTINCT FROM p.user_id
          AND COALESCE(m.is_deleted,false)=false);

-- Post-apply assertions.
DO $$
DECLARE v_stale bigint;
BEGIN
    IF position('ou.id IS NOT NULL' in (SELECT prosrc FROM pg_proc WHERE oid='public.fn_get_user_conversations(uuid,uuid)'::regprocedure)) = 0
       OR position('''Player #''' in (SELECT prosrc FROM pg_proc WHERE oid='public.fn_get_user_conversations(uuid,uuid)'::regprocedure)) = 0 THEN
        RAISE EXCEPTION 'post-check failed: inbox reader did not take the named-thread rule';
    END IF;
    IF position('new_message' in (SELECT prosrc FROM pg_proc WHERE oid='public.fn_mark_messages_read_through(uuid,uuid,uuid)'::regprocedure)) = 0 THEN
        RAISE EXCEPTION 'post-check failed: read receipt does not clear message notifications';
    END IF;
    IF position('fn_ca_is_cert_account(NEW.user_id)' in (SELECT prosrc FROM pg_proc WHERE oid='public.fn_deliver_club_messenger_welcome()'::regprocedure)) = 0 THEN
        RAISE EXCEPTION 'post-check failed: welcome still reaches certification equipment';
    END IF;
    SELECT count(*) INTO v_stale
      FROM notifications n
      JOIN social_conversation_participants p ON p.user_id=n.user_id AND p.conversation_id::text=n.data->>'conversationId'
     WHERE n.type='new_message' AND (n.read IS DISTINCT FROM true OR n.is_read IS DISTINCT FROM true)
       AND p.last_read_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM social_messages m WHERE m.conversation_id=p.conversation_id
                        AND m.created_at>p.last_read_at AND m.created_at<=n.created_at
                        AND m.sender_id IS DISTINCT FROM p.user_id AND COALESCE(m.is_deleted,false)=false);
    IF v_stale <> 0 THEN
        RAISE EXCEPTION 'post-check failed: % stale message notifications remain', v_stale;
    END IF;
END $$;

COMMIT;

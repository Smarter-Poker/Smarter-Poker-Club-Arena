-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819232831 "mirror_trigger_discriminating_push_tag"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 64323ad1ed25f3d289d66353ae6e5a07 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Mirror trigger -- stop collapsing distinct notifications into one banner
-- ============================================================================
-- fn_mirror_notification_to_push_outbox tagged every push `type || ':' || user_id`.
-- A Web Push `tag` REPLACES any existing notification carrying the same tag, so:
--
--   * two messages from two different people  -> ONE banner, latest sender only
--   * two friend requests from two people     -> ONE banner, latest only
--
-- and friend_request/new_message are the highest-volume types on the platform.
-- The earlier item vanishes from the notification shade entirely; the user has
-- no idea it existed.
--
-- Collapsing IS right for status-style types where only the newest state
-- matters (a challenge refresh, a venue alert, a system notice). So: collapse
-- by type for those, and discriminate per-conversation / per-actor / per-row for
-- everything else.
--
-- The inline path (enqueuePush) usually passes no tag at all, so it never had
-- this problem -- which is also why the two paths behaved differently for
-- identical events.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_mirror_notification_to_push_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_tag text;
BEGIN
  -- The JS gateway already decided about push for this row.
  IF NEW.data IS NOT NULL AND (NEW.data ->> '_push') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NULL OR NEW.title IS NULL OR btrim(NEW.title) = '' THEN
    RETURN NEW;
  END IF;

  -- Types where only the newest item matters: collapse them on purpose so a
  -- burst does not stack five identical banners.
  IF NEW.type IN (
    'system', 'daily_challenge', 'venue_alert', 'bonus', 'vip',
    'live', 'poker_news', 'diamond', 'achievement'
  ) THEN
    v_tag := NEW.type || ':' || NEW.user_id::text;
  ELSE
    -- Everything else must stay individually visible. Prefer the natural
    -- grouping key (a conversation), then the actor, then the row id so two
    -- distinct events can never share a tag.
    v_tag := NEW.type || ':' || COALESCE(
      NULLIF(btrim(COALESCE(NEW.data ->> 'conversationId', '')), ''),
      NULLIF(btrim(COALESCE(NEW.data ->> 'conversation_id', '')), ''),
      NEW.actor_id::text,
      NEW.id::text
    );
  END IF;

  BEGIN
    INSERT INTO public.push_outbox (
      recipient_user_id, title, body, url, event, tag, status, related_entity_id
    )
    VALUES (
      NEW.user_id,
      left(NEW.title, 120),
      left(COALESCE(NEW.message, NEW.title), 500),
      COALESCE(NULLIF(btrim(NEW.link), ''), NULLIF(btrim(NEW.action_url), ''), '/hub'),
      NEW.type,
      v_tag,
      'pending',
      NEW.id
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'mirror_notification_to_push_outbox failed for notification %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$fn$;

-- POST-APPLY ASSERTIONS -- prove both branches behave.
DO $$
DECLARE
  v_uid uuid;
  v_a uuid; v_b uuid;
  v_tag_a text; v_tag_b text;
  v_sys_a text; v_sys_b text;
BEGIN
  SELECT id INTO v_uid FROM public.profiles ORDER BY created_at LIMIT 1;
  IF v_uid IS NULL THEN RETURN; END IF;

  -- Two DISTINCT message notifications must produce DIFFERENT tags.
  INSERT INTO public.notifications (user_id, type, title, message, read, is_read)
  VALUES (v_uid, 'new_message', 'tagtest A', 'a', false, false) RETURNING id INTO v_a;
  INSERT INTO public.notifications (user_id, type, title, message, read, is_read)
  VALUES (v_uid, 'new_message', 'tagtest B', 'b', false, false) RETURNING id INTO v_b;

  SELECT tag INTO v_tag_a FROM public.push_outbox WHERE related_entity_id = v_a;
  SELECT tag INTO v_tag_b FROM public.push_outbox WHERE related_entity_id = v_b;
  IF v_tag_a IS NULL OR v_tag_b IS NULL THEN
    RAISE EXCEPTION 'mirror did not run for the test rows';
  END IF;
  IF v_tag_a = v_tag_b THEN
    RAISE EXCEPTION 'distinct messages still collapse to one tag: %', v_tag_a;
  END IF;

  -- Two `system` notifications SHOULD still collapse.
  INSERT INTO public.notifications (user_id, type, title, message, read, is_read)
  VALUES (v_uid, 'system', 'tagtest C', 'c', false, false) RETURNING id INTO v_a;
  INSERT INTO public.notifications (user_id, type, title, message, read, is_read)
  VALUES (v_uid, 'system', 'tagtest D', 'd', false, false) RETURNING id INTO v_b;
  SELECT tag INTO v_sys_a FROM public.push_outbox WHERE related_entity_id = v_a;
  SELECT tag INTO v_sys_b FROM public.push_outbox WHERE related_entity_id = v_b;
  IF v_sys_a IS DISTINCT FROM v_sys_b THEN
    RAISE EXCEPTION 'system notifications should collapse but did not: % vs %', v_sys_a, v_sys_b;
  END IF;

  -- Clean up every trace of the test.
  DELETE FROM public.push_outbox WHERE title LIKE 'tagtest %';
  DELETE FROM public.notifications WHERE title LIKE 'tagtest %';
END $$;

-- ROLLBACK
-- (restore the single-form tag: NEW.type || ':' || NEW.user_id::text)

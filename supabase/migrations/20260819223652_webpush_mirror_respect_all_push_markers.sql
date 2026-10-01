-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819223652 "webpush_mirror_respect_all_push_markers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 49b65fa2407f042ee579a8ff5c323707 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Mirror trigger: skip on ANY _push marker, not just 'inline'.
--
-- notify() has two cases the mirror must keep its hands off:
--   _push = 'inline' -> notify already queued the push itself (double send)
--   _push = 'none'   -> the caller passed withPush:false, meaning "bell only".
--                       Mirroring those would push exactly the notifications a
--                       feature deliberately marked silent -- including
--                       push-health's own "push is not reaching you" alerts,
--                       which would then try to reach the user by push.
-- Any marker at all means "the JS layer has already decided about push".
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_mirror_notification_to_push_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- The JS gateway already decided about push for this row.
  IF NEW.data IS NOT NULL AND (NEW.data ->> '_push') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NULL OR NEW.title IS NULL OR btrim(NEW.title) = '' THEN
    RETURN NEW;
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
      NEW.type || ':' || NEW.user_id::text,
      'pending',
      NEW.id
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'mirror_notification_to_push_outbox failed for notification %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$fn$;

DO $$
DECLARE v_user uuid; v_notif uuid; v_n int;
BEGIN
  SELECT id INTO v_user FROM auth.users LIMIT 1;

  -- unmarked -> mirrored
  INSERT INTO public.notifications (user_id, type, title, message)
  VALUES (v_user, 'system', 'mirror assert 2', 'b') RETURNING id INTO v_notif;
  SELECT count(*) INTO v_n FROM public.push_outbox WHERE related_entity_id = v_notif;
  IF v_n <> 1 THEN RAISE EXCEPTION 'unmarked row not mirrored (%)', v_n; END IF;
  DELETE FROM public.push_outbox WHERE related_entity_id = v_notif;
  DELETE FROM public.notifications WHERE id = v_notif;

  -- _push=none  -> NOT mirrored
  INSERT INTO public.notifications (user_id, type, title, message, data)
  VALUES (v_user, 'system', 'none assert', 'b', '{"_push":"none"}'::jsonb) RETURNING id INTO v_notif;
  SELECT count(*) INTO v_n FROM public.push_outbox WHERE related_entity_id = v_notif;
  IF v_n <> 0 THEN RAISE EXCEPTION '_push=none was mirrored (%)', v_n; END IF;
  DELETE FROM public.notifications WHERE id = v_notif;

  -- _push=inline -> NOT mirrored
  INSERT INTO public.notifications (user_id, type, title, message, data)
  VALUES (v_user, 'system', 'inline assert 2', 'b', '{"_push":"inline"}'::jsonb) RETURNING id INTO v_notif;
  SELECT count(*) INTO v_n FROM public.push_outbox WHERE related_entity_id = v_notif;
  IF v_n <> 0 THEN RAISE EXCEPTION '_push=inline was mirrored (%)', v_n; END IF;
  DELETE FROM public.notifications WHERE id = v_notif;

  RAISE NOTICE 'all mirror marker assertions passed';
END $$;


-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830042027; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_mirror_notification_to_push_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tag     text;
  v_pending int;
  c_max_pending CONSTANT int      := 20;
  c_max_age     CONSTANT interval := interval '30 minutes';
BEGIN
  IF NEW.data IS NOT NULL AND (NEW.data ->> '_push') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NULL OR NEW.title IS NULL OR btrim(NEW.title) = '' THEN
    RETURN NEW;
  END IF;

  IF NEW.created_at IS NOT NULL AND NEW.created_at < (now() - c_max_age) THEN
    RETURN NEW;
  END IF;

  IF NEW.type IN (
    'waitlist_seat_open', 'waitlist_offer_expired',
    'seat_available', 'waitlist_ready', 'table_ready'
  ) THEN
    v_tag := 'seat_offer:' || COALESCE(
      NULLIF(btrim(COALESCE(NEW.data ->> 'table_id', '')), ''),
      NEW.id::text
    );
  ELSIF NEW.type IN (
    'system', 'daily_challenge', 'venue_alert', 'bonus', 'vip',
    'live', 'poker_news', 'diamond', 'achievement'
  ) THEN
    v_tag := NEW.type || ':' || NEW.user_id::text;
  ELSE
    v_tag := NEW.type || ':' || COALESCE(
      NULLIF(btrim(COALESCE(NEW.data ->> 'conversationId', '')), ''),
      NULLIF(btrim(COALESCE(NEW.data ->> 'conversation_id', '')), ''),
      NEW.actor_id::text,
      NEW.id::text
    );
  END IF;

  BEGIN
    SELECT count(*) INTO v_pending
    FROM public.push_outbox
    WHERE recipient_user_id = NEW.user_id
      AND status IN ('pending', 'processing');

    IF v_pending >= c_max_pending THEN
      RETURN NEW;
    END IF;

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
$function$;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('public.fn_mirror_notification_to_push_outbox'::regproc) INTO v_def;

  IF v_def NOT LIKE '%seat_offer:%' THEN
    RAISE EXCEPTION 'post-apply failed: the seat-offer tag branch is not in the live function';
  END IF;
  IF v_def NOT LIKE '%_push%' THEN
    RAISE EXCEPTION 'post-apply failed: the gateway opt-out guard is gone';
  END IF;
  IF v_def NOT LIKE '%c_max_pending%' THEN
    RAISE EXCEPTION 'post-apply failed: the per-user pending cap is gone';
  END IF;
  IF v_def NOT LIKE '%c_max_age%' THEN
    RAISE EXCEPTION 'post-apply failed: the replayed-row guard is gone';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'notifications'
       AND t.tgname = 'trg_mirror_notification_to_push_outbox'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'post-apply failed: trg_mirror_notification_to_push_outbox is not attached';
  END IF;
END $$;

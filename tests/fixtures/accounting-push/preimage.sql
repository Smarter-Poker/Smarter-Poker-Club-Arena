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

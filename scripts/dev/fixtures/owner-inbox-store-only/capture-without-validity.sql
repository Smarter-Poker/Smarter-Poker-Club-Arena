-- fn_capture_owner_notification_destination WITHOUT the validity clause: the
-- post-image the previous revision of
-- supabase/migrations/20260927235053_owner_operational_notifications_are_delivered_to_the_operati.sql
-- installed (md5 of pg_get_functiondef f35b8c2677dd42f5f8567406912a0497).
-- Used only by scripts/dev/probe-owner-inbox-store-only.sh, to show that the
-- clause is what refuses a row PostgreSQL would have refused.
CREATE OR REPLACE FUNCTION public.fn_capture_owner_notification_destination()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF public.fn_is_owner_operational_notification(NEW.user_id,NEW.type,NEW.title,NEW.data) THEN
    INSERT INTO public.operational_notification_destinations(notification_id,recipient_user_id,original_notification)
      VALUES(NEW.id,NEW.user_id,to_jsonb(NEW));
    PERFORM public.fn_try_record_owner_notification(NEW.id);
    -- STORE-ONLY DELIVERY (2026-09-27). The owner's operational original is
    -- delivered to the operational task and to nothing else. Its complete
    -- original is the destination row above and the operational_alert_events
    -- receipt it names; a pending receipt is retried from that destination
    -- row, never from a personal inbox row. Returning NULL means no personal
    -- inbox row is written, so no feed, Realtime channel, unread count, push
    -- mirror or SECURITY DEFINER reader can surface it, whatever it filters on.
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;

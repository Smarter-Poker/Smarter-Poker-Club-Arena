CREATE OR REPLACE FUNCTION public.fn_ca_owner_route_reader_silence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  -- The newest timestamp any reader wrote into an investigation before this
  -- column existed (measured 2026-10-03). Never "now": an unread inbox must
  -- not look freshly read because the stamp is new.
  c_measured_last_read CONSTANT timestamptz := '2026-10-01 20:02:05+00';
  c_silence CONSTANT interval := interval '12 hours';
  c_title CONSTANT text := 'Production Alerts Has Stopped Reading';
  v_last timestamptz;
  v_waiting integer;
BEGIN
  SELECT GREATEST(c_measured_last_read, max(e.investigation_touched_at))
    INTO v_last
    FROM public.operational_alert_events e
   WHERE e.investigation_touched_at IS NOT NULL;
  v_last := COALESCE(v_last, c_measured_last_read);

  IF v_last > now() - c_silence THEN
    RETURN NULL;  -- somebody is reading; the route works as designed
  END IF;

  -- One page per silence. A later critical while the reader is still silent
  -- adds to the count the next reader sees, not to the owner's phone.
  IF EXISTS (SELECT 1 FROM public.notifications n
              WHERE n.user_id = NEW.recipient_user_id
                AND n.type = 'system'
                AND n.title = c_title
                AND n.created_at > v_last) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_waiting
    FROM public.operational_notification_destinations d
   WHERE d.recipient_user_id = NEW.recipient_user_id
     AND d.captured_at > v_last;

  PERFORM public.fn_raise_notification(
    NEW.recipient_user_id, 'system', c_title,
    format('Nothing in the Production Alerts inbox has been read since %s UTC, and %s owner alert(s) have arrived since. The latest: %s',
           to_char(v_last AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'), v_waiting,
           left(COALESCE(NEW.original_notification->>'title', 'an owner alert'), 200)),
    '/hub/club-arena/financial-incidents',
    jsonb_build_object('source', 'owner-route-reader-silence',
                       'last_read_at', v_last,
                       'waiting', v_waiting,
                       'notification_id', NEW.notification_id));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- The capture of the alert itself must never fail because of this page.
  RAISE WARNING 'fn_ca_owner_route_reader_silence failed for %: %', NEW.notification_id, SQLERRM;
  RETURN NULL;
END;
$function$


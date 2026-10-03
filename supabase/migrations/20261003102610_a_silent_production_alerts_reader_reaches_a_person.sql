-- 20261003102610_a_silent_production_alerts_reader_reaches_a_person.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A SILENT PRODUCTION ALERTS READER REACHES A PERSON (phase 5 of 9: alerts
-- reach a person). Full account:
-- docs/changelog/2026-10-03-a-silent-production-alerts-reader-reaches-a-person.md.
--
-- Since 20260916111614 the owner's financial incidents, guarantee shortfalls
-- and failed engine breaks are not pushed to his phone. They are captured into
-- operational_alert_events for the Production Alerts fleet, whose lanes
-- investigate and record what they found on each event. That route has one
-- reader, and nothing told anyone when the reader stopped.
--
-- Measured 2026-10-03: the newest timestamp written into any event's
-- investigation is 2026-10-01 20:02:05 UTC, and the fleet's board (issue #5070)
-- was last posted 2026-10-01 16:37. Eight owner alerts arrived after that and
-- were read by nobody, among them "KILL SWITCH: fn_ca_supply_snapshot read
-- -100005.30" (2026-10-02 15:05) and "More Chips Needed To Cover Guarantees"
-- (2026-10-02 11:02). The push-deliverability light could not see it either:
-- since 20261002165500 it counts the route as live when the inbox RECEIVED a
-- row, which says nothing about whether anyone read it (CLAUDE.md 10.86).
--
-- The routing stays exactly as it is. What changes:
--   1. operational_alert_events.investigation_touched_at is stamped whenever
--      a reader changes an event's investigation or investigation_status - the
--      one thing every lane does when it reads - so "when was the inbox last
--      read" is a column, not a guess.
--   2. When a critical owner alert (financial_incident, guarantee_bank_short,
--      engine_break_failed) is captured while nothing has been read for 12
--      hours, the owner gets ONE push, "Production Alerts Has Stopped
--      Reading", naming when it last read, how many alerts have waited since,
--      and the newest one. One page per silence: a later critical in the same
--      silence does not page again. The push goes through the ordinary
--      notification and push-outbox path; it is not an owner-operational type,
--      so it is never routed back into the inbox nobody is reading.
-- Until the first stamp is written, the last read is the measured 2026-10-01
-- 20:02:05 above, never "now".
--
-- Rehearsed on production in one rolled-back call: the page was not diverted,
-- reached push_outbox as 'pending' (8 owner alerts waiting), was not captured
-- into the inbox, and a second critical in the same silence was skipped.
--
-- Event-driven: no job is added or rescheduled. No chips move.
--
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.operational_alert_events'::regclass AND attname = 'investigation_touched_at' AND NOT attisdropped) AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'a_operational_alert_investigation_touched' AND tgrelid = 'public.operational_alert_events'::regclass AND tgenabled = 'O') AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_owner_route_reader_silence' AND tgrelid = 'public.operational_notification_destinations'::regclass AND tgenabled = 'O'))

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.operational_alert_events'::regclass
               AND attname = 'investigation_touched_at' AND NOT attisdropped)
     OR to_regprocedure('public.fn_operational_alert_investigation_touched()') IS NOT NULL
     OR to_regprocedure('public.fn_ca_owner_route_reader_silence()') IS NOT NULL THEN
    RAISE EXCEPTION 'READER_SILENCE_PREIMAGE_CHANGED';
  END IF;
  -- The page must never be routed into the inbox it is reporting on.
  IF public.fn_is_owner_operational_notification('47965354-0e56-43ef-931c-ddaab82af765'::uuid, 'system',
       'Production Alerts Has Stopped Reading', jsonb_build_object('source', 'owner-route-reader-silence')) THEN
    RAISE EXCEPTION 'READER_SILENCE_PAGE_WOULD_BE_DIVERTED';
  END IF;
END
$pre$;

ALTER TABLE public.operational_alert_events ADD COLUMN investigation_touched_at timestamptz;

CREATE FUNCTION public.fn_operational_alert_investigation_touched()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  -- A reader recorded something on this event. That is what "read" means for
  -- this inbox, so it is stamped here rather than inferred from the JSON.
  NEW.investigation_touched_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER a_operational_alert_investigation_touched
  BEFORE UPDATE OF investigation, investigation_status ON public.operational_alert_events
  FOR EACH ROW
  WHEN (OLD.investigation IS DISTINCT FROM NEW.investigation
        OR OLD.investigation_status IS DISTINCT FROM NEW.investigation_status)
  EXECUTE FUNCTION public.fn_operational_alert_investigation_touched();

CREATE INDEX operational_alert_events_investigation_touched_idx
  ON public.operational_alert_events (investigation_touched_at)
  WHERE investigation_touched_at IS NOT NULL;

CREATE FUNCTION public.fn_ca_owner_route_reader_silence()
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
$function$;

CREATE TRIGGER zz_owner_route_reader_silence
  AFTER INSERT ON public.operational_notification_destinations
  FOR EACH ROW
  WHEN ((NEW.original_notification->>'type') IN ('financial_incident', 'guarantee_bank_short', 'engine_break_failed'))
  EXECUTE FUNCTION public.fn_ca_owner_route_reader_silence();

REVOKE ALL ON FUNCTION public.fn_operational_alert_investigation_touched() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_owner_route_reader_silence() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_operational_alert_investigation_touched() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_owner_route_reader_silence() TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'a_operational_alert_investigation_touched'
                   AND tgrelid = 'public.operational_alert_events'::regclass AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_owner_route_reader_silence'
                   AND tgrelid = 'public.operational_notification_destinations'::regclass AND tgenabled = 'O')
     OR has_function_privilege('anon', 'public.fn_ca_owner_route_reader_silence()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_owner_route_reader_silence()', 'EXECUTE') THEN
    RAISE EXCEPTION 'READER_SILENCE_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;

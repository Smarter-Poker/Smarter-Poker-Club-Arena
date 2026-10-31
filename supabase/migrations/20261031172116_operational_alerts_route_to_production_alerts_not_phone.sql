-- Dan, 2026-10-09 and again 2026-10-31: operational alerts (Money Check Failed,
-- Engine Restart Storm, Tables Have Stopped Dealing, ...) go to Production Alerts
-- and are fixed automatically; they are never pushed to his phone. The in-app
-- notification and the operational_alert_events record are untouched; only the
-- device push is skipped. Device-health notices about his own phone still push.
CREATE OR REPLACE FUNCTION public.fn_platform_push_recipient_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF (TG_OP='INSERT' OR NEW.status IN ('pending','processing'))
    AND public.fn_is_platform_operational_alert(NEW.event,NEW.title,'{}'::jsonb) THEN
  IF NOT public.fn_is_platform_alert_recipient(NEW.recipient_user_id) THEN
   NEW.status:='skipped'; NEW.claimed_at:=NULL;
   NEW.failure_reason:='platform_alert_recipient_not_allowed';
  ELSIF COALESCE(NEW.title,'') NOT IN ('Push Health Alert','Notifications May Not Be Reaching This Device','Push Notifications Are Off') THEN
   NEW.status:='skipped'; NEW.claimed_at:=NULL;
   NEW.failure_reason:='routed_to_production_alerts';
  END IF;
 END IF;
 RETURN NEW;
END $function$;
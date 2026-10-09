BEGIN;

CREATE TRIGGER zz_owner_route_reader_silence
  AFTER INSERT ON public.operational_notification_destinations
  FOR EACH ROW
  WHEN ((NEW.original_notification->>'type') IN ('financial_incident', 'guarantee_bank_short', 'engine_break_failed'))
  EXECUTE FUNCTION public.fn_ca_owner_route_reader_silence();

CREATE TRIGGER zz_a_real_alert_reaches_the_owner
  AFTER INSERT ON public.operational_alert_events
  FOR EACH ROW
  WHEN (NEW.status = 'firing')
  EXECUTE FUNCTION public.fn_ca_a_real_alert_reaches_the_owner();

COMMIT;

-- Enforce the seven-day browser-event retention specified by 20260311_bus_event_log.
-- These are browser diagnostics, not chip ledgers, settlement replay keys or
-- authoritative hand records. User requested daily/weekly disposable-data cleanup.
-- One bounded daily batch; no gameplay, financial or managed Realtime cleanup.
-- Existing backlog is not deleted by installation. Current/unknown-age rows stay.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';

CREATE FUNCTION public.fn_prune_bus_event_log(p_batch integer DEFAULT 50000)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE deleted integer;
BEGIN
 IF p_batch IS NULL OR p_batch<1 OR p_batch>50000 THEN
   RAISE EXCEPTION 'Batch must be between 1 and 50000' USING ERRCODE='22023';
 END IF;
 WITH expired AS (
   SELECT id FROM public.bus_event_log
   WHERE created_at < statement_timestamp()-interval '7 days'
   LIMIT p_batch FOR UPDATE SKIP LOCKED
 )
 DELETE FROM public.bus_event_log b USING expired e
 WHERE b.id=e.id AND b.created_at < statement_timestamp()-interval '7 days';
 GET DIAGNOSTICS deleted=ROW_COUNT;
 RETURN deleted;
END $$;
REVOKE ALL ON FUNCTION public.fn_prune_bus_event_log(integer)
 FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_prune_bus_event_log(integer) IS
 'Owner-only, at most 50000 diagnostic browser events older than the original seven-day retention per daily call. Skips row locks; preserves current/unknown dates. No financial or managed Realtime data.';
SELECT cron.schedule('bus-event-log-retention-daily','41 6 * * *',
 $job$SET statement_timeout='5s'; SET lock_timeout='500ms'; SELECT public.fn_prune_bus_event_log(50000);$job$);
COMMIT;

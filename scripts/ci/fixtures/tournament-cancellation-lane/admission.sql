CREATE OR REPLACE FUNCTION smarter_private.cancellation_lane(p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
 g bigint := hashtextextended('ca:tournament-terminal-settlement:v1',0);
 b bigint := hashtextextended('ca:hand-settlement-barrier:v1',0);
 held text := COALESCE(current_setting('ca.finish_lane_tournament',true),'');
 scope text := COALESCE(current_setting('ca.finish_lane_scope',true),'');
 gx boolean; bx boolean; gs boolean; prior_t boolean;
BEGIN
 IF p_tournament_id IS NULL THEN
  RAISE EXCEPTION 'Tournament id is required' USING ERRCODE='22004';
 END IF;
 SELECT COALESCE(bool_or(k.key=g AND l.mode='ExclusiveLock'),false),
        COALESCE(bool_or(k.key=b AND l.mode='ExclusiveLock'),false),
        COALESCE(bool_or(k.key=g AND l.mode IN('ShareLock','ExclusiveLock')),false)
 INTO gx,bx,gs
 FROM pg_catalog.pg_locks l JOIN (VALUES(g),(b)) k(key)
 ON l.classid=((k.key>>32)&4294967295)::oid AND l.objid=(k.key&4294967295)::oid
 WHERE l.pid=pg_backend_pid() AND l.locktype='advisory' AND l.objsubid=1
 AND l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()) AND l.granted;
 -- A batch already holding the original G/B barrier keeps that authority.
 -- Do not manufacture a single-event marker for its multiple-event work.
 IF gx THEN
  IF NOT bx THEN RAISE EXCEPTION 'CANCELLATION_GLOBAL_AUTHORITY_INCOMPLETE' USING ERRCODE='55000'; END IF;
  RETURN;
 END IF;
 -- A marker alone is never authority. Validate its existing global/event
 -- identity and reject bank scope. F is not this admission's authority:
 -- every success must still acquire the full original exclusive G/B below.
 IF held<>'' OR scope<>'' THEN
  IF NOT gs OR scope<>'' THEN
   RAISE EXCEPTION 'CANCELLATION_FINISH_AUTHORITY_INCOMPLETE' USING ERRCODE='55000';
  END IF;
  SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l
   WHERE l.pid=pg_backend_pid() AND l.locktype='advisory' AND l.objsubid=1
   AND l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
   AND l.classid=((hashtextextended('ca:tournament-terminal-settlement:v1:'||held,0)>>32)&4294967295)::oid
   AND l.objid=(hashtextextended('ca:tournament-terminal-settlement:v1:'||held,0)&4294967295)::oid
   AND l.mode='ExclusiveLock' AND l.granted) INTO prior_t;
  IF held<>p_tournament_id::text OR NOT prior_t THEN
   RAISE EXCEPTION 'CANCELLATION_EVENT_AUTHORITY_INCOMPLETE' USING ERRCODE='55000';
  END IF;
 END IF;
 -- Preserve the original complete financial exclusion. A try-lock never
 -- queues an exclusive global request ahead of subsequent hand readers.
 -- Busy callers receive an authoritative refusal before cancellation writes.
 IF NOT pg_try_advisory_xact_lock(g) THEN
  RAISE EXCEPTION 'CANCELLATION_GLOBAL_LANE_BUSY' USING ERRCODE='55P03';
 END IF;
 IF NOT pg_try_advisory_xact_lock(b) THEN
  RAISE EXCEPTION 'CANCELLATION_BARRIER_BUSY' USING ERRCODE='55P03';
 END IF;
 -- Do not change existing finish scope or manufacture event authority.
 -- Raising above rolls back this admission's partial locks with its caller.
END;
$function$;
REVOKE ALL ON FUNCTION smarter_private.cancellation_lane(uuid) FROM PUBLIC,anon,authenticated,service_role;

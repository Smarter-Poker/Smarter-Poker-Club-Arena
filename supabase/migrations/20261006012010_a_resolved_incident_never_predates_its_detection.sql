-- 20261006012010_a_resolved_incident_never_predates_its_detection.sql
--
-- Version checked against origin/main and all fetched remote branch histories
-- before creation, so it does not collide with another reserved migration.
--
-- THE DEFECT. One resolved drift incident currently has resolved_at 19.2
-- seconds before detected_at. Its financial alert was resolved from an
-- accepted-hand receipt timestamp, then a later alert echo was attached to
-- the existing incident. fn_ca_alert_resolution_reaches_the_incident copied
-- that earlier evidence time into the later incident. The strict dashboard
-- reader correctly refused the impossible timeline, but the old client turned
-- the refusal into an empty green queue.
--
-- This repairs only that operational timestamp invariant. It moves no chips,
-- changes no ledger, settlement, alert resolution, incident status or source
-- financial evidence. The known alert mirror bounds its derived incident
-- timestamp at the incident's own detection instant. Every other impossible
-- deadline, resolution ordering or status/timestamp contradiction is refused
-- instead of silently rewritten. A validated constraint makes both invariants
-- durable for every writer.
--
-- @live-proof: (SELECT count(*) = 0 FROM public.ca_drift_incidents WHERE deadline_at < detected_at OR resolved_at < detected_at OR ((status = 'resolved') IS DISTINCT FROM (resolved_at IS NOT NULL)))
-- @live-proof: (SELECT convalidated AND pg_get_constraintdef(oid) = 'CHECK (((deadline_at >= detected_at) AND ((resolved_at IS NULL) OR (resolved_at >= detected_at)) AND ((status = ''resolved''::text) = (resolved_at IS NOT NULL))))' FROM pg_constraint WHERE conrelid='public.ca_drift_incidents'::regclass AND conname='ca_drift_incidents_timeline_check')
-- @live-proof: (SELECT md5(prosrc)='0e11283b0fb32102007958c70d631773' AND md5(pg_get_functiondef(oid))='e4a7c3e2099706adf19c4bd3885c6dbb' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=public']::text[] FROM pg_proc WHERE oid='public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='cbb93e769afe3ff462fb68e6d8f23e4a' AND md5(pg_get_functiondef(oid))='86e3c04a77d99595901a1810b291ca3f' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog']::text[] FROM pg_proc WHERE oid='public.fn_ca_drift_incident_timeline_guard()'::regprocedure)
-- @live-proof: (SELECT pg_get_triggerdef(oid)='CREATE TRIGGER trg_ca_drift_incident_timeline BEFORE INSERT OR UPDATE OF status, detected_at, deadline_at, resolved_at ON public.ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_drift_incident_timeline_guard()' FROM pg_trigger WHERE tgrelid='public.ca_drift_incidents'::regclass AND tgname='trg_ca_drift_incident_timeline' AND tgenabled='O' AND NOT tgisinternal)

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE
  v_invalid bigint;
BEGIN
  IF pg_get_userbyid((SELECT relowner FROM pg_class
       WHERE oid='public.ca_drift_incidents'::regclass)) <> 'postgres'
     OR NOT (SELECT relrowsecurity FROM pg_class
              WHERE oid='public.ca_drift_incidents'::regclass)
     OR (SELECT count(*) FROM pg_attribute
          WHERE attrelid='public.ca_drift_incidents'::regclass
            AND attnum > 0 AND NOT attisdropped
            AND ((attname='detected_at' AND atttypid='timestamptz'::regtype AND attnotnull)
              OR (attname='deadline_at' AND atttypid='timestamptz'::regtype AND attnotnull)
              OR (attname='resolved_at' AND atttypid='timestamptz'::regtype AND NOT attnotnull)
              OR (attname='status' AND atttypid='text'::regtype AND attnotnull))) <> 4 THEN
    RAISE EXCEPTION 'DRIFT_INCIDENT_TIMELINE_TABLE_PREIMAGE_CHANGED';
  END IF;

  IF to_regprocedure('public.fn_ca_drift_incident_timeline_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid='public.ca_drift_incidents'::regclass
                   AND tgname='trg_ca_drift_incident_timeline')
     OR EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.ca_drift_incidents'::regclass
                   AND conname='ca_drift_incidents_timeline_check') THEN
    RAISE EXCEPTION 'DRIFT_INCIDENT_TIMELINE_OBJECT_ALREADY_EXISTS';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid='public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure
       AND pg_get_userbyid(p.proowner)='postgres'
       AND p.prorettype='trigger'::regtype
       AND p.prosecdef
       AND p.provolatile='v'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,service_role=X/postgres}'
       AND md5(p.prosrc)='40ab72a641e2ea070426866e36f626be'
       AND md5(pg_get_functiondef(p.oid))='dbe622139f98faf98bca7bc30db0155c'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid='public.financial_alerts'::regclass
       AND t.tgname='zz_ca_alert_resolution_reaches_the_incident'
       AND t.tgfoid='public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure
       AND t.tgenabled='O'
       AND NOT t.tgisinternal
       AND pg_get_triggerdef(t.oid)=
         'CREATE TRIGGER zz_ca_alert_resolution_reaches_the_incident AFTER UPDATE OF resolved ON public.financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_alert_resolution_reaches_the_incident()'
  ) THEN
    RAISE EXCEPTION 'DRIFT_INCIDENT_ALERT_MIRROR_PREIMAGE_CHANGED';
  END IF;

  SELECT count(*) INTO v_invalid
    FROM public.ca_drift_incidents
   WHERE deadline_at < detected_at
      OR resolved_at < detected_at
      OR ((status = 'resolved') IS DISTINCT FROM (resolved_at IS NOT NULL));
  IF v_invalid <> 1
     OR EXISTS (
       SELECT 1 FROM public.ca_drift_incidents
        WHERE (deadline_at < detected_at
               OR resolved_at < detected_at
               OR ((status = 'resolved') IS DISTINCT FROM (resolved_at IS NOT NULL)))
          AND NOT (
            id='e4766bae-5db1-4ed2-b2a1-a46dc3e908ed'::uuid
            AND source='financial_alerts:postHandTasks.hand_history_failed'
            AND status='resolved'
            AND deadline_at >= detected_at
            AND detected_at='2026-09-28 23:18:19.476277+00'::timestamptz
            AND resolved_at='2026-09-28 23:18:00.275816+00'::timestamptz
          )
     ) THEN
    RAISE EXCEPTION 'DRIFT_INCIDENT_TIMELINE_DATA_PREIMAGE_CHANGED';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_ca_alert_resolution_reaches_the_incident()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_state text; v_msg text;
BEGIN
  IF NOT COALESCE(NEW.resolved,false) OR COALESCE(OLD.resolved,false) THEN
    RETURN NEW;
  END IF;
  UPDATE public.ca_drift_incidents i
     SET status      = 'resolved',
         resolved_at = GREATEST(COALESCE(NEW.resolved_at, now()), i.detected_at),
         correction_ref = COALESCE(NULLIF(i.correction_ref,''),
                                   'verified: closed with financial alert ' || NEW.id::text),
         root_cause  = COALESCE(NULLIF(i.root_cause,''),
                        'This incident is a mirror of financial alert ' || NEW.id::text
                        || ', raised by ' || COALESCE(NEW.source,'an unnamed source')
                        || '. The condition it describes was diagnosed and closed on that '
                        || 'alert; this row exists only because the alert was copied onto '
                        || 'the drift board when it was raised.'),
         resolution  = COALESCE(NULLIF(i.resolution,'') || ' | ', '')
                       || 'Closed with the financial alert it mirrors ('
                       || NEW.id::text || '): '
                       || COALESCE(NULLIF(NEW.resolution,''), 'no note given on the alert')
   WHERE i.status <> 'resolved'
     AND i.metadata->>'alert_id' ~ '^[0-9a-fA-F-]{36}$'
     AND (i.metadata->>'alert_id')::uuid = NEW.id;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  /* Never roll back the resolve that triggered us - but never disappear
     either. RAISE WARNING alone is how this defect hid from its own author. */
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  BEGIN
    INSERT INTO public.ca_incident_file_failures
      (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
    VALUES ('fn_ca_alert_resolution_reaches_the_incident',
            'propagate:alert->incident:' || NEW.id::text,
            'unknown', 'warning', 0, v_state,
            'a resolved alert did not close the incident mirroring it: ' || v_msg);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RAISE WARNING 'fn_ca_alert_resolution_reaches_the_incident failed: %', v_msg;
  RETURN NEW;
END $fn$;

ALTER FUNCTION public.fn_ca_alert_resolution_reaches_the_incident() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_alert_resolution_reaches_the_incident()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_alert_resolution_reaches_the_incident()
  TO postgres, service_role;

SELECT public.fn_ca_declare_guard_redefinition(
  'fn_ca_alert_resolution_reaches_the_incident',
  'migration 20261006012010_a_resolved_incident_never_predates_its_detection'
);

CREATE FUNCTION public.fn_ca_drift_incident_timeline_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.deadline_at < NEW.detected_at THEN
    RAISE EXCEPTION 'drift incident deadline cannot precede detection'
      USING ERRCODE='23514';
  END IF;
  IF NEW.resolved_at IS NOT NULL AND NEW.resolved_at < NEW.detected_at THEN
    RAISE EXCEPTION 'drift incident resolution cannot precede detection'
      USING ERRCODE='23514';
  END IF;
  IF (NEW.status = 'resolved') IS DISTINCT FROM (NEW.resolved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'drift incident resolved status must match its resolution time'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_ca_drift_incident_timeline_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_drift_incident_timeline_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_drift_incident_timeline_guard()
  TO postgres, service_role;

UPDATE public.ca_drift_incidents
   SET resolved_at = detected_at
 WHERE id='e4766bae-5db1-4ed2-b2a1-a46dc3e908ed'::uuid
   AND source='financial_alerts:postHandTasks.hand_history_failed'
   AND status='resolved'
   AND deadline_at >= detected_at
   AND detected_at='2026-09-28 23:18:19.476277+00'::timestamptz
   AND resolved_at='2026-09-28 23:18:00.275816+00'::timestamptz;

ALTER TABLE public.ca_drift_incidents
  ADD CONSTRAINT ca_drift_incidents_timeline_check
  CHECK (
    deadline_at >= detected_at
    AND (resolved_at IS NULL OR resolved_at >= detected_at)
    AND ((status = 'resolved') = (resolved_at IS NOT NULL))
  ) NOT VALID;

ALTER TABLE public.ca_drift_incidents
  VALIDATE CONSTRAINT ca_drift_incidents_timeline_check;

CREATE TRIGGER trg_ca_drift_incident_timeline
  BEFORE INSERT OR UPDATE OF status, detected_at, deadline_at, resolved_at
  ON public.ca_drift_incidents
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_drift_incident_timeline_guard();

CREATE TEMP TABLE pg_temp.ca_drift_incident_timeline_probe (
  id smallint PRIMARY KEY,
  status text NOT NULL,
  detected_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  resolved_at timestamptz
) ON COMMIT DROP;

CREATE TRIGGER trg_ca_drift_incident_timeline_probe
  BEFORE INSERT OR UPDATE OF status, detected_at, deadline_at, resolved_at
  ON pg_temp.ca_drift_incident_timeline_probe
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_drift_incident_timeline_guard();

DO $negative$
DECLARE
  v_refused integer := 0;
BEGIN
  BEGIN
    INSERT INTO pg_temp.ca_drift_incident_timeline_probe
      VALUES (1, 'open', '2026-10-06 00:00:00+00',
              '2026-10-05 23:59:59+00', NULL);
    RAISE EXCEPTION 'EARLY_DEADLINE_WAS_ACCEPTED';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM <> 'drift incident deadline cannot precede detection' THEN RAISE; END IF;
    v_refused := v_refused + 1;
  END;

  BEGIN
    INSERT INTO pg_temp.ca_drift_incident_timeline_probe
      VALUES (2, 'resolved', '2026-10-06 00:00:00+00',
              '2026-10-06 00:20:00+00', '2026-10-05 23:59:59+00');
    RAISE EXCEPTION 'EARLY_RESOLUTION_WAS_ACCEPTED';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM <> 'drift incident resolution cannot precede detection' THEN RAISE; END IF;
    v_refused := v_refused + 1;
  END;

  BEGIN
    INSERT INTO pg_temp.ca_drift_incident_timeline_probe
      VALUES (3, 'resolved', '2026-10-06 00:00:00+00',
              '2026-10-06 00:20:00+00', NULL);
    RAISE EXCEPTION 'RESOLVED_WITHOUT_TIME_WAS_ACCEPTED';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM <> 'drift incident resolved status must match its resolution time' THEN RAISE; END IF;
    v_refused := v_refused + 1;
  END;

  BEGIN
    INSERT INTO pg_temp.ca_drift_incident_timeline_probe
      VALUES (4, 'open', '2026-10-06 00:00:00+00',
              '2026-10-06 00:20:00+00', '2026-10-06 00:01:00+00');
    RAISE EXCEPTION 'OPEN_WITH_RESOLUTION_TIME_WAS_ACCEPTED';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM <> 'drift incident resolved status must match its resolution time' THEN RAISE; END IF;
    v_refused := v_refused + 1;
  END;

  INSERT INTO pg_temp.ca_drift_incident_timeline_probe
    VALUES (5, 'open', '2026-10-06 00:00:00+00',
            '2026-10-06 00:20:00+00', NULL);
  BEGIN
    UPDATE pg_temp.ca_drift_incident_timeline_probe
       SET status='resolved'
     WHERE id=5;
    RAISE EXCEPTION 'STATUS_ONLY_RESOLUTION_WAS_ACCEPTED';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM <> 'drift incident resolved status must match its resolution time' THEN RAISE; END IF;
    v_refused := v_refused + 1;
  END;

  INSERT INTO pg_temp.ca_drift_incident_timeline_probe
    VALUES (6, 'resolved', '2026-10-06 00:00:00+00',
            '2026-10-06 00:20:00+00', '2026-10-06 00:01:00+00');

  IF v_refused <> 5
     OR (SELECT count(*) FROM pg_temp.ca_drift_incident_timeline_probe) <> 2 THEN
    RAISE EXCEPTION 'DRIFT_INCIDENT_TIMELINE_NEGATIVE_PROBE_FAILED';
  END IF;
END
$negative$;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents
              WHERE deadline_at < detected_at
                 OR resolved_at < detected_at
                 OR ((status = 'resolved') IS DISTINCT FROM (resolved_at IS NOT NULL))) THEN
    RAISE EXCEPTION 'DRIFT_INCIDENT_TIMELINE_REPAIR_FAILED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid='public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure
       AND pg_get_userbyid(p.proowner)='postgres'
       AND p.prorettype='trigger'::regtype
       AND p.prosecdef
       AND p.provolatile='v'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,service_role=X/postgres}'
       AND md5(p.prosrc)='0e11283b0fb32102007958c70d631773'
       AND md5(pg_get_functiondef(p.oid))='e4a7c3e2099706adf19c4bd3885c6dbb'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.ca_guard_defs d
     WHERE d.proname='fn_ca_alert_resolution_reaches_the_incident'
       AND d.declared_ref=
         'migration 20261006012010_a_resolved_incident_never_predates_its_detection'
       AND d.def_hash='e4a7c3e2099706adf19c4bd3885c6dbb'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid='public.financial_alerts'::regclass
       AND t.tgname='zz_ca_alert_resolution_reaches_the_incident'
       AND t.tgfoid='public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure
       AND t.tgenabled='O'
       AND NOT t.tgisinternal
       AND pg_get_triggerdef(t.oid)=
         'CREATE TRIGGER zz_ca_alert_resolution_reaches_the_incident AFTER UPDATE OF resolved ON public.financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_alert_resolution_reaches_the_incident()'
  ) THEN
    RAISE EXCEPTION 'DRIFT_INCIDENT_ALERT_MIRROR_POSTIMAGE_FAILED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid='public.fn_ca_drift_incident_timeline_guard()'::regprocedure
       AND pg_get_userbyid(p.proowner)='postgres'
       AND p.prosecdef
       AND p.provolatile='v'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,service_role=X/postgres}'
       AND md5(p.prosrc)='cbb93e769afe3ff462fb68e6d8f23e4a'
       AND md5(pg_get_functiondef(p.oid))='86e3c04a77d99595901a1810b291ca3f'
  ) THEN
    RAISE EXCEPTION 'DRIFT_INCIDENT_TIMELINE_FUNCTION_POSTIMAGE_FAILED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid='public.ca_drift_incidents'::regclass
       AND c.conname='ca_drift_incidents_timeline_check'
       AND c.contype='c'
       AND c.convalidated
       AND pg_get_constraintdef(c.oid) =
         'CHECK (((deadline_at >= detected_at) AND ((resolved_at IS NULL) OR (resolved_at >= detected_at)) AND ((status = ''resolved''::text) = (resolved_at IS NOT NULL))))'
  ) THEN
    RAISE EXCEPTION 'DRIFT_INCIDENT_TIMELINE_CONSTRAINT_POSTIMAGE_FAILED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid='public.ca_drift_incidents'::regclass
       AND t.tgname='trg_ca_drift_incident_timeline'
       AND t.tgfoid='public.fn_ca_drift_incident_timeline_guard()'::regprocedure
       AND t.tgenabled='O'
       AND NOT t.tgisinternal
       AND pg_get_triggerdef(t.oid) =
         'CREATE TRIGGER trg_ca_drift_incident_timeline BEFORE INSERT OR UPDATE OF status, detected_at, deadline_at, resolved_at ON public.ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_drift_incident_timeline_guard()'
  ) THEN
    RAISE EXCEPTION 'DRIFT_INCIDENT_TIMELINE_TRIGGER_POSTIMAGE_FAILED';
  END IF;
END
$post$;

COMMIT;

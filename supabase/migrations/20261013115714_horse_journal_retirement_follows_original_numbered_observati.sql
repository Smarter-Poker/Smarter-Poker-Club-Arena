-- Forward-only. Production ICU en-US orders the punctuation sentinel before
-- admitted UUID:number observations. Every original valid suffix is 0..4095;
-- inclusive :0..:9999 bounds retain the existing default-collated primary key.
-- Version2 records completed original raw/statistics/fence transition, separate
-- from the immutable already-recorded retired time. Legacy0 is never completion.
-- The same chronological pending index/cursor retires genuinely eligible old
-- false retirements exactly once; protected originals stay pending. No new job.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE p pg_proc;
BEGIN
 IF md5(pg_get_functiondef('smarter_private.retire_horse_adaptive_hand(uuid)'::regprocedure)) IS DISTINCT FROM '7c496d653e11035d3de0933243790fac'
 OR md5(pg_get_functiondef('smarter_private.horse_adaptive_disposal_certificate_immutable()'::regprocedure)) IS DISTINCT FROM '1e47b89d6b6aa88c249fbb7c864ea472'
 OR md5(pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure)) IS DISTINCT FROM 'ae358dd5be5586e0fbdf44f083afe92d'
 OR (SELECT enabled FROM smarter_private.horse_adaptive_retention_activation WHERE singleton) IS DISTINCT FROM false
 OR pg_get_indexdef('smarter_private.horse_adaptive_disposal_pending'::regclass) IS DISTINCT FROM 'CREATE INDEX horse_adaptive_disposal_pending ON smarter_private.horse_adaptive_disposal_certificates USING btree (qualified_at, hand_id) WHERE (retired_at IS NULL)'
 THEN RAISE EXCEPTION 'ADAPTIVE_NUMBERED_RETIREMENT_PREIMAGE_CHANGED_OR_ENABLED'; END IF;
 FOR p IN SELECT * FROM pg_proc WHERE oid IN (
  'smarter_private.retire_horse_adaptive_hand(uuid)'::regprocedure,
  'smarter_private.horse_adaptive_disposal_certificate_immutable()'::regprocedure,
  'public.fn_prune_horse_adaptive_journal()'::regprocedure) LOOP
  IF p.proowner<>'postgres'::regrole OR NOT p.prosecdef
  OR p.proacl::text IS DISTINCT FROM (CASE WHEN p.proname='fn_prune_horse_adaptive_journal'
   THEN '{postgres=X/postgres,service_role=X/postgres}' ELSE '{postgres=X/postgres}' END)
  OR p.proconfig IS DISTINCT FROM (CASE WHEN p.proname='horse_adaptive_disposal_certificate_immutable'
   THEN ARRAY['search_path=pg_catalog, public, smarter_private']
   ELSE ARRAY['search_path=pg_catalog, public, smarter_private','lock_timeout=2s'] END)
  THEN RAISE EXCEPTION 'ADAPTIVE_NUMBERED_RETIREMENT_AUTHORITY_CHANGED'; END IF;
 END LOOP;
END $guard$;
ALTER TABLE smarter_private.horse_adaptive_disposal_certificates
 ADD COLUMN raw_format_version smallint NOT NULL DEFAULT 0
 CHECK(raw_format_version IN(0,2));
DROP INDEX smarter_private.horse_adaptive_disposal_pending;
CREATE INDEX horse_adaptive_disposal_pending ON smarter_private.horse_adaptive_disposal_certificates(qualified_at,hand_id)
 WHERE retired_at IS NULL OR raw_format_version<2;
CREATE OR REPLACE FUNCTION smarter_private.horse_adaptive_disposal_certificate_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE s smarter_private.hand_submissions; d smarter_private.hand_submission_disposals;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=NEW.hand_id;
  SELECT * INTO d FROM smarter_private.hand_submission_disposals WHERE submission_id=NEW.hand_id AND table_id=NEW.table_id AND hand_number=NEW.hand_number;
  IF NOT smarter_private.horse_request_payload_disposable(NEW.hand_id)
  OR s.request#>'{p_hand_row,has_human}' IS DISTINCT FROM 'false'::jsonb
  OR NEW.table_id IS DISTINCT FROM s.table_id OR NEW.hand_number IS DISTINCT FROM s.hand_number
  OR NEW.request_hash IS DISTINCT FROM s.request_hash OR NEW.hand_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.hand_id::text,'UTF8')),'hex')
  OR NEW.retired_at IS NOT NULL OR NEW.raw_format_version IS DISTINCT FROM 0 OR NOT isfinite(NEW.qualified_at)
  OR NEW.qualified_at>clock_timestamp() OR NEW.qualified_at<transaction_timestamp()
  OR NEW.certificate->>'version' IS DISTINCT FROM 'settled-horse-adaptive-disposal-v1'
  OR NEW.certificate->'original_horse_only' IS DISTINCT FROM 'true'::jsonb
  OR NEW.certificate->'original_has_human' IS DISTINCT FROM 'false'::jsonb
  OR NEW.certificate->'retained_at' IS DISTINCT FROM to_jsonb(s.retained_at)
  OR NEW.certificate->>'request_hash' IS DISTINCT FROM s.request_hash
  OR NEW.certificate->>'classifier_definition_md5' IS DISTINCT FROM md5(pg_get_functiondef('smarter_private.horse_request_payload_disposable(uuid)'::regprocedure))
  OR NEW.certificate->'disposal' IS DISTINCT FROM d.expected THEN RAISE EXCEPTION 'ADAPTIVE_DISPOSAL_CERTIFICATE_UNQUALIFIED'; END IF;
  RETURN NEW;
 ELSIF TG_OP='UPDATE' AND OLD.raw_format_version=0 AND NEW.raw_format_version=2
 AND (to_jsonb(NEW)-'retired_at'-'raw_format_version') IS NOT DISTINCT FROM (to_jsonb(OLD)-'retired_at'-'raw_format_version')
 AND NEW.retired_at IS NOT NULL AND isfinite(NEW.retired_at)
 AND NEW.retired_at>=OLD.qualified_at AND NEW.retired_at<=clock_timestamp()
 AND (OLD.retired_at IS NULL OR NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at)
 AND EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_retention_activation WHERE singleton AND enabled)
 AND NOT EXISTS(SELECT 1 FROM public.horse_adaptive_observation_journal j WHERE j.observation_id>=OLD.hand_id::text||':0' AND j.observation_id<=OLD.hand_id::text||':9999' AND j.hand_id=OLD.hand_id)
 THEN RETURN NEW;
 END IF;
 RAISE EXCEPTION 'ADAPTIVE_DISPOSAL_CERTIFICATE_IMMUTABLE';
END $function$;

CREATE OR REPLACE FUNCTION smarter_private.retire_horse_adaptive_hand(p_hand uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
 SET lock_timeout TO '2s'
AS $function$
DECLARE c smarter_private.horse_adaptive_disposal_certificates; b record; kept jsonb; key text; n integer;
BEGIN
 SELECT * INTO c FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id=p_hand FOR UPDATE;
 IF NOT FOUND THEN RETURN 0; END IF;
 IF NOT smarter_private.horse_adaptive_disposal_certificate_matches(c.hand_id,c.table_id,c.hand_number,c.request_hash) THEN RETURN 0; END IF;
 IF c.raw_format_version=2 THEN
  IF EXISTS(SELECT 1 FROM public.horse_adaptive_observation_journal j
   WHERE j.observation_id>=p_hand::text||':0' AND j.observation_id<=p_hand::text||':9999' AND j.hand_id=p_hand)
  THEN RAISE EXCEPTION 'ADAPTIVE_COMPLETED_FORMAT_HAS_RAW'; END IF;
  RETURN 0;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_retention_activation WHERE singleton AND enabled)
 OR NOT pg_try_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0)) THEN RETURN 0; END IF;
 -- Qualification was made at the original disposal boundary. Never acquire a
 -- new classification from current player/actor origin or an erased roster.
 IF EXISTS(SELECT 1 FROM public.hand_history WHERE id=p_hand AND (has_human IS true OR reported IS true))
 OR smarter_private.f06_hand_cards_unresolved(c.table_id,c.hand_number)
 OR smarter_private.f06_movement_boundary_retained(c.table_id,c.hand_number)
 OR EXISTS(SELECT 1 FROM public.bbj_payouts WHERE table_id=c.table_id AND hand_number=c.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE hand_id=p_hand)
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates WHERE hand_id=p_hand AND state='pending') THEN RETURN 0; END IF;
 IF EXISTS(SELECT 1 FROM public.horse_adaptive_journal_work w
 WHERE w.state<>'completed' AND EXISTS(SELECT 1 FROM jsonb_array_elements(w.payload::jsonb->7) v
 WHERE (v.value#>>'{}')::jsonb->>2=p_hand::text)) THEN RETURN 0; END IF;
 -- Until the bounded existing retention owner has qualified every legacy
 -- batch's exact membership, no hand is declared fully retired. Fresh inserts
 -- register through their original write event, including an old in-flight
 -- writer whose function body predates this migration.
 IF EXISTS(SELECT 1 FROM public.horse_adaptive_observation_batches WHERE NOT retention_membership_ready LIMIT 1) THEN RETURN 0; END IF;
 FOR key IN SELECT batch_key FROM smarter_private.horse_adaptive_batch_hand_membership WHERE hand_digest=c.hand_digest LOOP
  IF EXISTS(SELECT 1 FROM public.horse_adaptive_journal_work WHERE batch_key=key AND state<>'completed') THEN RETURN 0; END IF;
 END LOOP;
 -- Every original fact must remain canonical before aggregation. One malformed
 -- or conflicting hand/session/partition relationship aborts the whole transition.
 IF EXISTS(SELECT 1 FROM public.horse_adaptive_observation_journal j
 WHERE j.observation_id>=p_hand::text||':0' AND j.observation_id<=p_hand::text||':9999' AND j.hand_id=p_hand
 AND (jsonb_typeof(j.payload::jsonb) IS DISTINCT FROM 'array' OR jsonb_array_length(j.payload::jsonb)<>12
 OR j.payload::jsonb->0 IS DISTINCT FROM '1'::jsonb OR j.payload::jsonb->>1 IS DISTINCT FROM j.observation_id OR j.payload::jsonb->>2 IS DISTINCT FROM p_hand::text
 OR j.payload::jsonb->>3 IS DISTINCT FROM j.actor_key OR j.payload::jsonb->>4 IS DISTINCT FROM j.session_key
 OR j.payload::jsonb->>5 IS DISTINCT FROM j.observed_at_ms::text OR j.payload::jsonb->>6 IS DISTINCT FROM j.partition
 OR j.payload::jsonb->>7 IS DISTINCT FROM j.scope_key OR j.payload::jsonb->>11 IS DISTINCT FROM j.origin
 OR jsonb_typeof(j.payload::jsonb->10) IS DISTINCT FROM 'boolean' OR encode(sha256(convert_to(j.payload::jsonb->>8,'UTF8')),'hex') IS DISTINCT FROM j.scope_key OR j.payload::jsonb->>9 NOT IN('fold','check','call','bet','raise'))) THEN RAISE EXCEPTION 'ADAPTIVE_RETENTION_INVALID_FACT'; END IF;
 IF EXISTS(SELECT 1 FROM public.horse_adaptive_observation_journal j
 WHERE j.observation_id>=p_hand::text||':0' AND j.observation_id<=p_hand::text||':9999' AND j.hand_id=p_hand
 GROUP BY actor_key HAVING count(DISTINCT session_key)>1 OR count(DISTINCT partition)>1)
 THEN RAISE EXCEPTION 'ADAPTIVE_RETENTION_PARTITION_CONFLICT'; END IF;
 INSERT INTO smarter_private.horse_adaptive_observation_fences
 SELECT encode(sha256(convert_to(j.observation_id,'UTF8')),'hex'),c.hand_digest,encode(sha256(convert_to(j.payload,'UTF8')),'hex')
 FROM public.horse_adaptive_observation_journal j
 WHERE j.observation_id>=p_hand::text||':0' AND j.observation_id<=p_hand::text||':9999' AND j.hand_id=p_hand;
 INSERT INTO smarter_private.horse_adaptive_statistics
 SELECT c.hand_digest,j.actor_key,j.session_key,j.partition,j.scope_key,j.origin,j.observed_at_ms,j.payload::jsonb->>9,count(*)::integer
 FROM public.horse_adaptive_observation_journal j
 WHERE j.observation_id>=p_hand::text||':0' AND j.observation_id<=p_hand::text||':9999' AND j.hand_id=p_hand
 GROUP BY j.actor_key,j.session_key,j.partition,j.scope_key,j.origin,j.observed_at_ms,j.payload::jsonb->>9;
 -- Retire only eligible tuples within a batch. Human/other-hand tuples stay
 -- byte-identical strings. Originalbatch digest remains the immutable replay fence;
 -- recovery explicitly refuses this partially retired representation.
 FOR b IN SELECT batch_key FROM smarter_private.horse_adaptive_batch_hand_membership WHERE hand_digest=c.hand_digest
 LOOP
  SELECT canonical_payload::jsonb INTO kept FROM public.horse_adaptive_observation_batches WHERE batch_key=b.batch_key FOR UPDATE;
  IF kept IS NOT NULL THEN
   kept:=jsonb_set(kept,'{7}',COALESCE((SELECT jsonb_agg(value ORDER BY ordinality)
    FROM jsonb_array_elements(kept->7) WITH ORDINALITY
    WHERE (value#>>'{}')::jsonb->>2 IS DISTINCT FROM p_hand::text),'[]'::jsonb));
   UPDATE public.horse_adaptive_observation_batches SET canonical_payload=kept::text,retention_compacted=true WHERE batch_key=b.batch_key;
  END IF;
 END LOOP;
 DELETE FROM public.horse_adaptive_observation_journal j
 WHERE j.observation_id>=p_hand::text||':0' AND j.observation_id<=p_hand::text||':9999' AND j.hand_id=p_hand;
 GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE smarter_private.horse_adaptive_disposal_certificates
 SET retired_at=COALESCE(c.retired_at,clock_timestamp()),raw_format_version=2 WHERE hand_id=p_hand;
 RETURN n;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_prune_horse_adaptive_journal()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
 SET lock_timeout TO '2s'
AS $function$
DECLARE candidate record; batch record; membership_count integer:=0; membership_bytes bigint:=0;
 n integer; work_count integer; statistics_count integer:=0; raw_count integer:=0; retired_count integer:=0;
 deadline timestamptz:=clock_timestamp()+interval '2 seconds'; budget_reached boolean:=false;
 membership_pending boolean; retirement_pending boolean:=false; hands_scanned integer:=0;
 scan smarter_private.horse_adaptive_retention_activation; remaining_window boolean;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0)) THEN
  RETURN jsonb_build_object('version',3,'status','unavailable','reason','capacity_busy'); END IF;
 WITH candidate AS (SELECT batch_key FROM public.horse_adaptive_journal_work
  WHERE state='completed' AND completed_at<clock_timestamp()-interval '32 days'
  ORDER BY completed_at,batch_key LIMIT 100 FOR UPDATE SKIP LOCKED)
 DELETE FROM public.horse_adaptive_journal_work w USING candidate c WHERE w.batch_key=c.batch_key;
 GET DIAGNOSTICS work_count=ROW_COUNT;
 FOR batch IN SELECT batch_key,COALESCE(octet_length(canonical_payload),0) bytes
 FROM public.horse_adaptive_observation_batches WHERE NOT retention_membership_ready
 ORDER BY recorded_at,batch_key LIMIT 250 FOR UPDATE SKIP LOCKED LOOP
  IF clock_timestamp()>=deadline OR membership_bytes+batch.bytes>16777216 THEN
   budget_reached:=true; EXIT; END IF;
  PERFORM smarter_private.register_horse_adaptive_batch_membership(batch.batch_key);
  membership_count:=membership_count+1; membership_bytes:=membership_bytes+batch.bytes;
 END LOOP;
 membership_pending:=EXISTS(SELECT 1 FROM public.horse_adaptive_observation_batches WHERE NOT retention_membership_ready LIMIT 1);
 -- No futile per-hand locks while legacy membership is incomplete or the
 -- versioned serving consumer has not been explicitly enabled.
 SELECT * INTO scan FROM smarter_private.horse_adaptive_retention_activation WHERE singleton FOR UPDATE;
 IF NOT membership_pending AND scan.enabled THEN
  IF scan.scan_through_qualified_at IS NULL THEN
   SELECT qualified_at,hand_id INTO scan.scan_through_qualified_at,scan.scan_through_hand_id
   FROM smarter_private.horse_adaptive_disposal_certificates WHERE (retired_at IS NULL OR raw_format_version<2)
   ORDER BY qualified_at DESC,hand_id DESC LIMIT 1;
  END IF;
  -- Fixed high-water bounds one pass despite continuing incoming certificates.
  -- Advancing means attempted, never settled: the original helper remains the
  -- only authority and protected hands are revisited after the pass wraps.
  IF scan.scan_through_qualified_at IS NOT NULL THEN
   FOR candidate IN SELECT hand_id,qualified_at FROM smarter_private.horse_adaptive_disposal_certificates
    WHERE (retired_at IS NULL OR raw_format_version<2)
    AND (qualified_at,hand_id)<=(scan.scan_through_qualified_at,scan.scan_through_hand_id)
    AND (scan.scan_after_qualified_at IS NULL OR
     (qualified_at,hand_id)>(scan.scan_after_qualified_at,scan.scan_after_hand_id))
    ORDER BY qualified_at,hand_id LIMIT 250 FOR UPDATE SKIP LOCKED LOOP
    IF clock_timestamp()>=deadline THEN budget_reached:=true; EXIT; END IF;
    n:=smarter_private.retire_horse_adaptive_hand(candidate.hand_id); raw_count:=raw_count+n;
    hands_scanned:=hands_scanned+1;
    IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates
     WHERE hand_id=candidate.hand_id AND retired_at IS NOT NULL AND raw_format_version=2) THEN retired_count:=retired_count+1; END IF;
    scan.scan_after_qualified_at:=candidate.qualified_at;scan.scan_after_hand_id:=candidate.hand_id;
   END LOOP;
   remaining_window:=EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates
    WHERE (retired_at IS NULL OR raw_format_version<2)
    AND (qualified_at,hand_id)<=(scan.scan_through_qualified_at,scan.scan_through_hand_id)
    AND (scan.scan_after_qualified_at IS NULL OR
     (qualified_at,hand_id)>(scan.scan_after_qualified_at,scan.scan_after_hand_id)) LIMIT 1);
   retirement_pending:=remaining_window OR EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates
    WHERE (retired_at IS NULL OR raw_format_version<2) AND (qualified_at,hand_id)>(scan.scan_through_qualified_at,scan.scan_through_hand_id) LIMIT 1);
   IF NOT remaining_window THEN
    scan.scan_after_qualified_at:=NULL;scan.scan_after_hand_id:=NULL;
    scan.scan_through_qualified_at:=NULL;scan.scan_through_hand_id:=NULL;
   END IF;
   UPDATE smarter_private.horse_adaptive_retention_activation SET
    scan_after_qualified_at=scan.scan_after_qualified_at,scan_after_hand_id=scan.scan_after_hand_id,
    scan_through_qualified_at=scan.scan_through_qualified_at,scan_through_hand_id=scan.scan_through_hand_id WHERE singleton;
  END IF;
 END IF;
 IF clock_timestamp()<deadline THEN
  WITH expired AS (SELECT ctid FROM smarter_private.horse_adaptive_statistics
   WHERE observed_at_ms<floor(extract(epoch FROM (clock_timestamp()-interval '30 days'))*1000)::bigint LIMIT 1000)
  DELETE FROM smarter_private.horse_adaptive_statistics s USING expired e WHERE s.ctid=e.ctid;
  GET DIAGNOSTICS statistics_count=ROW_COUNT;
 ELSE
  -- Deadline exhaustion only requests fast continuation when actual expired
  -- statistics remain. A completed protected-only scan must not burn at 5s.
  IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_statistics
   WHERE observed_at_ms<floor(extract(epoch FROM (clock_timestamp()-interval '30 days'))*1000)::bigint LIMIT 1)
  THEN budget_reached:=true; END IF;
 END IF;
 RETURN jsonb_build_object('version',3,'status','pruned','completedWork',work_count,'batches',0,
  'observations',raw_count,'retiredHands',retired_count,'statisticsExpired',statistics_count,
  'membershipsRegistered',membership_count,'membershipPending',membership_pending,
  'handsScanned',hands_scanned,'retirementPending',retirement_pending,'budgetReached',budget_reached);
END $function$;
-- Old high-water excludes already-marked legacy certificates. Reset pairs only
-- in this guarded inactive transaction; original chronology/caps remain exact.
UPDATE smarter_private.horse_adaptive_retention_activation SET
 scan_after_qualified_at=NULL,scan_after_hand_id=NULL,
 scan_through_qualified_at=NULL,scan_through_hand_id=NULL WHERE singleton;
REVOKE ALL ON FUNCTION smarter_private.retire_horse_adaptive_hand(uuid),
 smarter_private.horse_adaptive_disposal_certificate_immutable() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_prune_horse_adaptive_journal() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_prune_horse_adaptive_journal() TO service_role;
COMMIT;


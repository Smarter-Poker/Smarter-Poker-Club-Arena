-- 20261015001400_adaptive_batch_once_finds_touched_batches_through_the_hand_i.sql
--
-- Forward-only regression repair for 20261014231333 (#6883).
--
-- Measured on production 2026-10-15 00:12 UTC, minutes after #6883 installed:
-- zero adaptive hands retired in five minutes (the predecessor retired ~490 per
-- minute), and one owner call held the capacity lock for 38+ seconds in
-- DataFileRead. Cause, read from the plan: the once-per-batch compaction finds
-- touched batches with `c.hand_id::text=ANY(retired_hands)`. Casting the
-- primary key to text cannot use horse_adaptive_disposal_certificates_pkey, so
-- every call sequentially scanned all ~3.9M certificates (planner cost
-- ~813,000). Comparing the uuid column to the same hands as uuid[] is an index
-- scan on the primary key (planner cost ~52) and selects exactly the same rows:
-- retired_hands holds only hand_id::text values produced from that uuid column.
--
-- Change: that one predicate. Everything else in the owner is the installed
-- #6883 body byte-for-byte (the 250-hand / 2-second / 16 MiB budgets, capacity
-- lock, cursor, high-water, compaction semantics, statistics expiry, receipt,
-- owner, security definer, search path, lock timeout and ACLs). No job,
-- schedule, repair or backfill is added. Refuses unless the installed owner is
-- exactly the #6883 postimage.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure)) IS DISTINCT FROM 'cbc454dbbdbe7ea0bcfb629b5218dd2d'
 THEN RAISE EXCEPTION 'ADAPTIVE_BATCH_INDEX_PREIMAGE_CHANGED'; END IF;
END $guard$;

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
 retired_hands text[]:='{}'; kept jsonb;
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
    n:=smarter_private.retire_horse_adaptive_hand_deferred(candidate.hand_id); raw_count:=raw_count+n;
    hands_scanned:=hands_scanned+1;
    IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates
     WHERE hand_id=candidate.hand_id AND retired_at IS NOT NULL AND raw_format_version=2) THEN
     retired_count:=retired_count+1; retired_hands:=retired_hands||candidate.hand_id::text;
    END IF;
    scan.scan_after_qualified_at:=candidate.qualified_at;scan.scan_after_hand_id:=candidate.hand_id;
   END LOOP;
   -- Retire only the completed hands' tuples within each touched batch, once.
   -- Human/other-hand/still-protected tuples stay byte-identical strings. The
   -- original batch digest remains the immutable replay fence; recovery
   -- explicitly refuses this partially retired representation.
   IF cardinality(retired_hands)>0 THEN
    FOR batch IN SELECT DISTINCT m.batch_key FROM smarter_private.horse_adaptive_batch_hand_membership m
     JOIN smarter_private.horse_adaptive_disposal_certificates c ON c.hand_digest=m.hand_digest
     WHERE c.hand_id=ANY(retired_hands::uuid[]) ORDER BY m.batch_key LOOP
     SELECT canonical_payload::jsonb INTO kept FROM public.horse_adaptive_observation_batches WHERE batch_key=batch.batch_key FOR UPDATE;
     IF kept IS NOT NULL THEN
      kept:=jsonb_set(kept,'{7}',COALESCE((SELECT jsonb_agg(value ORDER BY ordinality)
       FROM jsonb_array_elements(kept->7) WITH ORDINALITY
       WHERE NOT COALESCE((value#>>'{}')::jsonb->>2=ANY(retired_hands),false)),'[]'::jsonb));
      UPDATE public.horse_adaptive_observation_batches SET canonical_payload=kept::text,retention_compacted=true WHERE batch_key=batch.batch_key;
     END IF;
    END LOOP;
   END IF;
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
REVOKE ALL ON FUNCTION public.fn_prune_horse_adaptive_journal() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_prune_horse_adaptive_journal() TO service_role;

DO $post$
BEGIN
 IF position('c.hand_id=ANY(retired_hands::uuid[])' IN pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure))=0
 OR position('hand_id::text=ANY(retired_hands)' IN pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure))>0
 THEN RAISE EXCEPTION 'ADAPTIVE_BATCH_INDEX_POSTIMAGE_MISSING'; END IF;
END $post$;
COMMIT;

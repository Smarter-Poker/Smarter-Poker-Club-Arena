-- Horse adaptive retirement groups hands by shared batch.
--
-- Production, 2026-10-15 01:13-01:29 UTC, after 20261015001555: one owner call
-- attempted 250 hands in qualified order and then rewrote 291 distinct
-- batches (46 MB of canonical JSON, about 166 KB each) to remove about 2.5
-- tuples from each. A continuous drain retired about 17.5 hands per second
-- against about 13.5 arriving, so the 988,441-hand backlog would have taken
-- about 70 hours and roughly 1 TB of WAL; each call also exceeded the engine
-- lane's 5-second transport timeout. Measured on production: the 108 pending
-- hands of one seed batch touch only 17 batches in total.
--
-- Change, candidate selection only: the owner still walks seeds in the
-- original (qualified_at, hand_id) window order under the same fixed
-- high-water. For each seed not already attempted in this call it reads the
-- seed's own batch payloads (membership by hand_digest, the primary key
-- prefix), collects the hand ids they name, and attempts the seed first and
-- then its pending window batch-mates at or after the seed, in order, until
-- the same 250-hand budget or 2-second deadline. The cursor advances only to
-- seeds. Batch-mates retired early leave the window; a protected batch-mate
-- stays pending and is attempted again when the cursor reaches it, exactly as
-- a protected hand is today. retire_horse_adaptive_hand_deferred remains the
-- only authority; compaction of each touched batch once per call, statistics
-- expiry, receipt, capacity lock, budgets, owner, security definer, search
-- path, lock timeout and ACLs are unchanged. No job, schedule, repair or
-- backfill. Refuses to apply unless the installed owner is exactly the
-- 20261015001555 postimage.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure)) IS DISTINCT FROM 'fddfaad43a953a3a24d2803ca72c09d5'
  OR to_regprocedure('smarter_private.retire_horse_adaptive_hand_deferred(uuid)') IS NULL
 THEN RAISE EXCEPTION 'ADAPTIVE_GROUPED_RETIREMENT_PREIMAGE_CHANGED'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_prune_horse_adaptive_journal()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
 SET lock_timeout TO '2s'
AS $function$
DECLARE candidate record; member record; attempted uuid[]:='{}'; member_ids uuid[]; batch record; membership_count integer:=0; membership_bytes bigint:=0;
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
    EXIT WHEN hands_scanned>=250;
    IF clock_timestamp()>=deadline THEN budget_reached:=true; EXIT; END IF;
    IF NOT candidate.hand_id=ANY(attempted) THEN
     -- The seed's own batches name every hand that shares them. Attempting
     -- the seed together with its pending batch-mates lets each touched batch
     -- be rewritten once for many hands instead of once per scattered hand.
     member_ids:=ARRAY(SELECT DISTINCT x.h::uuid FROM (
      SELECT (t.value#>>'{}')::jsonb->>2 h
      FROM smarter_private.horse_adaptive_disposal_certificates s
      JOIN smarter_private.horse_adaptive_batch_hand_membership m ON m.hand_digest=s.hand_digest
      JOIN public.horse_adaptive_observation_batches b ON b.batch_key=m.batch_key
      CROSS JOIN LATERAL jsonb_array_elements(b.canonical_payload::jsonb->7) t
      WHERE s.hand_id=candidate.hand_id) x
      WHERE x.h ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')||candidate.hand_id;
     -- Same window, never behind the seed, the seed itself first.
     FOR member IN SELECT c.hand_id FROM smarter_private.horse_adaptive_disposal_certificates c
      WHERE c.hand_id=ANY(member_ids) AND NOT c.hand_id=ANY(attempted)
      AND (c.retired_at IS NULL OR c.raw_format_version<2)
      AND (c.qualified_at,c.hand_id)>=(candidate.qualified_at,candidate.hand_id)
      AND (c.qualified_at,c.hand_id)<=(scan.scan_through_qualified_at,scan.scan_through_hand_id)
      ORDER BY c.hand_id<>candidate.hand_id,c.qualified_at,c.hand_id
      LIMIT 250-hands_scanned FOR UPDATE SKIP LOCKED LOOP
      IF member.hand_id<>candidate.hand_id AND clock_timestamp()>=deadline THEN budget_reached:=true; EXIT; END IF;
      n:=smarter_private.retire_horse_adaptive_hand_deferred(member.hand_id); raw_count:=raw_count+n;
      hands_scanned:=hands_scanned+1; attempted:=attempted||member.hand_id;
      IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates
       WHERE hand_id=member.hand_id AND retired_at IS NOT NULL AND raw_format_version=2) THEN
       retired_count:=retired_count+1; retired_hands:=retired_hands||member.hand_id::text;
      END IF;
     END LOOP;
    END IF;
    -- The cursor still advances only through seeds, in the original order.
    -- Batch-mates ahead of it are retired early and drop out of the window;
    -- a protected batch-mate stays pending and is attempted again as a seed.
    scan.scan_after_qualified_at:=candidate.qualified_at;scan.scan_after_hand_id:=candidate.hand_id;
    EXIT WHEN budget_reached;
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
COMMIT;

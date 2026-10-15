-- Forward-only. Root fix for the adaptive retention capacity deficit measured on
-- production 2026-10-14: incoming certificates qualify at ~39.7k/hour while the
-- single original capacity lane retired ~22.5k/hour, so the pending backlog grew
-- ~17k/hour (926,181 pending at 23:03 UTC).
--
-- Cause, read from rows: smarter_private.retire_horse_adaptive_hand (installed
-- md5 f1147867f410f36e244e8849df4ac6d7) rewrote EVERY observation batch that
-- contains the hand, once per hand. A batch carries ~198 hands in a ~130 KB
-- canonical payload and a hand belongs to ~2.56 batches, so each batch was
-- parsed, filtered, re-serialised and re-TOASTed ~198 times over its life
-- (~50 ms per hand, ~20 hands/s ceiling on the one lane; plus the TOAST churn
-- behind the batches/journal growth).
--
-- Change: the public owner fn_prune_horse_adaptive_journal (installed md5
-- d287d2dc4fd96d9aa2a2e179ff156ff3) retires each hand through
-- smarter_private.retire_horse_adaptive_hand_deferred, which is the original
-- body byte-for-byte except that the per-hand batch compaction loop is removed.
-- After its bounded hand loop the owner compacts each touched batch ONCE,
-- removing every hand it retired in this call. Same transaction, same final
-- committed state as the per-hand path: retired tuples removed in original
-- order, human / other-hand / still-protected tuples byte-identical, the
-- original batch digest remains the immutable replay fence, and
-- retention_compacted is set exactly where the original set it. The original
-- 250-hand / 2-second / 16 MiB budgets, capacity lock, cursor, high-water,
-- statistics expiry and receipt shape are unchanged. The original one-argument
-- retire_horse_adaptive_hand stays installed and unchanged. No job, schedule,
-- repair or backfill is added.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE p pg_proc;
BEGIN
 IF md5(pg_get_functiondef('smarter_private.retire_horse_adaptive_hand(uuid)'::regprocedure)) IS DISTINCT FROM 'f1147867f410f36e244e8849df4ac6d7'
 OR md5(pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure)) IS DISTINCT FROM 'd287d2dc4fd96d9aa2a2e179ff156ff3'
 OR md5(pg_get_functiondef('smarter_private.horse_adaptive_disposal_certificate_immutable()'::regprocedure)) IS DISTINCT FROM '2497e31c1f8c6c955e2b082fdc0a3df0'
 OR to_regprocedure('smarter_private.retire_horse_adaptive_hand_deferred(uuid)') IS NOT NULL
 THEN RAISE EXCEPTION 'ADAPTIVE_BATCH_ONCE_PREIMAGE_CHANGED'; END IF;
 FOR p IN SELECT * FROM pg_proc WHERE oid IN (
  'smarter_private.retire_horse_adaptive_hand(uuid)'::regprocedure,
  'public.fn_prune_horse_adaptive_journal()'::regprocedure) LOOP
  IF p.proowner<>'postgres'::regrole OR NOT p.prosecdef
  OR p.proacl::text IS DISTINCT FROM (CASE WHEN p.proname='fn_prune_horse_adaptive_journal'
   THEN '{postgres=X/postgres,service_role=X/postgres}' ELSE '{postgres=X/postgres}' END)
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private','lock_timeout=2s']
  THEN RAISE EXCEPTION 'ADAPTIVE_BATCH_ONCE_AUTHORITY_CHANGED'; END IF;
 END LOOP;
END $guard$;

CREATE FUNCTION smarter_private.retire_horse_adaptive_hand_deferred(p_hand uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
 SET lock_timeout TO '2s'
AS $function$
DECLARE c smarter_private.horse_adaptive_disposal_certificates; key text; n integer;
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
 -- Batch compaction is deliberately NOT done here. The only caller,
 -- fn_prune_horse_adaptive_journal, compacts each touched batch once for every
 -- hand this function completed, inside the same transaction.
 DELETE FROM public.horse_adaptive_observation_journal j
 WHERE j.observation_id>=p_hand::text||':0' AND j.observation_id<=p_hand::text||':9999' AND j.hand_id=p_hand;
 GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE smarter_private.horse_adaptive_disposal_certificates
 SET retired_at=COALESCE(c.retired_at,clock_timestamp()),raw_format_version=2 WHERE hand_id=p_hand;
 RETURN n;
END $function$;
ALTER FUNCTION smarter_private.retire_horse_adaptive_hand_deferred(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.retire_horse_adaptive_hand_deferred(uuid) FROM PUBLIC,anon,authenticated,service_role;

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
     WHERE c.hand_id::text=ANY(retired_hands) ORDER BY m.batch_key LOOP
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

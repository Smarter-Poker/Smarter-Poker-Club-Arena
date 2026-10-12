-- Finite, explicit legacy tournament request compaction. Historical retention
-- receipts predate completion timestamps. An immutable accepted F06 permit
-- with exact original hand evidence proves postcommit finished; retention's
-- unresolved-permit exclusion proves it finished before the disposal row was
-- created. The disposal creation timestamp is a conservative completion bound.
-- No cash-only inference, monetary writes, scheduler, scan or automatic cursor.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $pins$
DECLARE sig text; digest text;
BEGIN
 IF to_regclass('smarter_private.legacy_horse_request_certificates') IS NOT NULL THEN
  RAISE EXCEPTION 'LEGACY_HORSE_REQUEST_CERTIFICATES_ALREADY_INSTALLED' USING ERRCODE='55000'; END IF;
 FOR sig,digest IN SELECT * FROM (VALUES
  ('smarter_private.f06_accept_hand()','6a0ab2a61b4fb7f741a423b8a0a99353'),
  ('smarter_private.f06_immutable_identity()','0fe40a0711ef6d196c6883d3b9e8b86f'),
  ('smarter_private.horse_request_payload_disposable(uuid)','af3f0cb0c28dfcaad264919c1bb93cda')
 ) x(signature,definition_hash) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc f WHERE f.oid=sig::regprocedure
    AND md5(pg_get_functiondef(f.oid))=digest AND f.proowner='postgres'::regrole
    AND f.prosecdef AND f.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN
   RAISE EXCEPTION 'LEGACY_HORSE_REQUEST_SOURCE_CHANGED: %',sig USING ERRCODE='55000'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_atomic_commits'::regclass
  AND tgname='zzzz_f06_accepted_hand' AND tgenabled='O'
  AND tgfoid='smarter_private.f06_accept_hand()'::regprocedure
  AND pg_get_triggerdef(oid)='CREATE TRIGGER zzzz_f06_accepted_hand AFTER INSERT OR UPDATE OF post_commit_completed_at ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_accept_hand()')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_hand_permits'::regclass
  AND tgname='f06_hand_permits_immutable' AND tgenabled='O'
  AND tgfoid='smarter_private.f06_immutable_identity()'::regprocedure
  AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_hand_permits_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity()') THEN
  RAISE EXCEPTION 'LEGACY_HORSE_REQUEST_ACCEPTANCE_BINDING_CHANGED' USING ERRCODE='55000'; END IF;
END $pins$;

CREATE TABLE smarter_private.legacy_horse_request_certificates (
 submission_id uuid PRIMARY KEY,
 request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),
 proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object'),
 certified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE smarter_private.legacy_horse_request_compaction_batches (
 batch_id uuid PRIMARY KEY,
 submission_ids uuid[] NOT NULL CHECK(cardinality(submission_ids)<=250),
 result jsonb NOT NULL,
 completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE smarter_private.legacy_horse_request_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.legacy_horse_request_compaction_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.legacy_horse_request_certificates,
 smarter_private.legacy_horse_request_compaction_batches FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.qualify_legacy_horse_tournament_request(p_submission_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE s smarter_private.hand_submissions; d smarter_private.hand_submission_disposals;
 p smarter_private.f06_hand_permits; tour uuid; players jsonb; item jsonb; user_text text; created timestamptz;
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=p_submission_id;
 IF NOT FOUND OR s.request='{}'::jsonb
 OR s.request#>'{p_hand_row,has_human}' IS DISTINCT FROM 'false'::jsonb
 OR s.request#>>'{p_hand_row,reported}'='true'
 OR NOT isfinite(s.retained_at) OR s.retained_at>=now()-interval '8 days'
 OR (SELECT horse_retention_days FROM public.hand_history_retention_policy LIMIT 1) IS DISTINCT FROM 8
 THEN RETURN NULL; END IF;
 SELECT * INTO d FROM smarter_private.hand_submission_disposals
 WHERE submission_id=s.submission_id AND table_id=s.table_id AND hand_number=s.hand_number;
 IF NOT FOUND OR d.expected->>'kind' IS DISTINCT FROM 'retention_pruned_settled_hand'
 OR d.expected->>'settled' IS DISTINCT FROM 'true' OR d.expected ? 'settlement_completed'
 OR d.receipt_id IS DISTINCT FROM md5('hand:disposal:retention:'||s.submission_id::text)::uuid
 OR d.expected->>'request_hash' IS DISTINCT FROM s.request_hash
 OR d.expected->>'submission_id' IS DISTINCT FROM s.submission_id::text
 OR d.expected->>'table_id' IS DISTINCT FROM s.table_id::text
 OR d.expected->>'hand_number' IS DISTINCT FROM s.hand_number::text
 OR d.expected->>'dealer_generation' IS DISTINCT FROM s.lease_generation::text
 OR d.expected->>'pruned_hand_id' IS DISTINCT FROM s.submission_id::text
 OR NOT isfinite(d.created_at) OR d.created_at>=now()-interval '8 days' THEN RETURN NULL; END IF;
 BEGIN
  created:=(d.expected->>'hand_created_at')::timestamptz;
  tour:=(s.request#>>'{p_hand_row,tournament_id}')::uuid;
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
 END;
 IF created IS NULL OR NOT isfinite(created) OR created>=now()-interval '8 days'
 OR d.created_at<created OR d.created_at<s.retained_at OR tour IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO p FROM smarter_private.f06_hand_permits
 WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF NOT FOUND OR p.state IS DISTINCT FROM 'accepted' OR p.evidence_id IS DISTINCT FROM s.submission_id
 OR p.generation IS DISTINCT FROM s.lease_generation OR p.tournament_id IS DISTINCT FROM tour THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=s.table_id AND t.tournament_id=tour)
 OR NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=tour
  AND upper(COALESCE(t.status::text,'')) IN('COMPLETED','CANCELLED','CANCELED')
  AND COALESCE(t.bounty_pool,0)<=COALESCE(t.bounty_pool_paid,0))
 OR EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=tour AND e.closed_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=s.submission_id)
 OR smarter_private.f06_hand_cards_unresolved(s.table_id,s.hand_number)
 OR smarter_private.f06_movement_boundary_retained(s.table_id,s.hand_number)
 OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=s.table_id AND b.hand_number=s.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=s.submission_id)
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates k WHERE k.hand_id=s.submission_id AND k.state='pending')
 THEN RETURN NULL; END IF;
 players:=s.request#>'{p_hand_row,players}';
 IF jsonb_typeof(players) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 IF jsonb_array_length(players)=0 THEN RETURN NULL; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(players) LOOP
  user_text:=item->>'userId';
  IF user_text IS NULL OR user_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles pr WHERE pr.id=user_text::uuid AND pr.is_horse IS true) THEN RETURN NULL; END IF;
 END LOOP;
 RETURN jsonb_build_object('version',1,'basis','accepted_f06_before_retention_disposal',
  'submission_id',s.submission_id,'table_id',s.table_id,'hand_number',s.hand_number,
  'request_hash',s.request_hash,'permit_id',p.permit_id,'lease_generation',s.lease_generation,
  'tournament_id',tour,'disposal_receipt_id',d.receipt_id,
  'completion_latest_at',d.created_at,'original_has_human',false);
END $function$;
REVOKE ALL ON FUNCTION smarter_private.qualify_legacy_horse_tournament_request(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.legacy_horse_certificate_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'LEGACY_HORSE_CERTIFICATE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='legacy_horse_request_certificates' AND
  (NEW.proof IS DISTINCT FROM smarter_private.qualify_legacy_horse_tournament_request(NEW.submission_id)
   OR NEW.request_hash IS DISTINCT FROM NEW.proof->>'request_hash') THEN
  RAISE EXCEPTION 'LEGACY_HORSE_CERTIFICATE_PROOF_REQUIRED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.legacy_horse_certificate_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER legacy_horse_certificate_guard BEFORE INSERT OR UPDATE OR DELETE
 ON smarter_private.legacy_horse_request_certificates FOR EACH ROW EXECUTE FUNCTION smarter_private.legacy_horse_certificate_guard();
CREATE TRIGGER legacy_horse_certificate_no_truncate BEFORE TRUNCATE
 ON smarter_private.legacy_horse_request_certificates FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.legacy_horse_certificate_guard();
CREATE TRIGGER legacy_horse_compaction_batch_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.legacy_horse_request_compaction_batches FOR EACH ROW EXECUTE FUNCTION smarter_private.legacy_horse_certificate_guard();
CREATE TRIGGER legacy_horse_compaction_batch_no_truncate BEFORE TRUNCATE
 ON smarter_private.legacy_horse_request_compaction_batches FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.legacy_horse_certificate_guard();

CREATE FUNCTION smarter_private.horse_request_completion_bound(p_submission_id uuid)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE d smarter_private.hand_submission_disposals; c smarter_private.legacy_horse_request_certificates;
 proof jsonb;
BEGIN
 SELECT * INTO d FROM smarter_private.hand_submission_disposals WHERE submission_id=p_submission_id;
 IF d.expected->>'settlement_completed'='true' THEN
  BEGIN RETURN (d.expected->>'settlement_completed_at')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL; END;
 END IF;
 SELECT * INTO c FROM smarter_private.legacy_horse_request_certificates WHERE submission_id=p_submission_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 proof:=smarter_private.qualify_legacy_horse_tournament_request(p_submission_id);
 IF proof IS NULL OR c.proof IS DISTINCT FROM proof OR c.request_hash IS DISTINCT FROM proof->>'request_hash' THEN RETURN NULL; END IF;
 RETURN d.created_at;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.horse_request_completion_bound(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $qualifier_patch$
DECLARE src text; anchor text;
BEGIN
 src:=pg_get_functiondef('smarter_private.horse_request_payload_disposable(uuid)'::regprocedure);
 anchor:=$old$ OR d.expected->>'settlement_completed' IS DISTINCT FROM 'true'$old$;
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'LEGACY_HORSE_COMPLETION_FLAG_ANCHOR_CHANGED'; END IF;
 src:=replace(src,anchor,$new$ OR smarter_private.horse_request_completion_bound(s.submission_id) IS NULL$new$);
 anchor:=$old$(d.expected->>'settlement_completed_at')::timestamptz$old$;
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>3 THEN RAISE EXCEPTION 'LEGACY_HORSE_COMPLETION_TIME_ANCHOR_CHANGED'; END IF;
 EXECUTE replace(src,anchor,'smarter_private.horse_request_completion_bound(s.submission_id)');
END $qualifier_patch$;

CREATE FUNCTION smarter_private.compact_legacy_horse_tournament_request_batch(p_batch_id uuid,p_submission_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE ids uuid[]; sid uuid; prior smarter_private.legacy_horse_request_compaction_batches;
 s smarter_private.hand_submissions; proof jsonb; erased integer:=0; already integer:=0;
 protected integer:=0; n integer; result jsonb;
BEGIN
 IF p_batch_id IS NULL OR p_submission_ids IS NULL OR cardinality(p_submission_ids)>250
 OR EXISTS(SELECT 1 FROM unnest(p_submission_ids)x WHERE x IS NULL) THEN
  RAISE EXCEPTION 'LEGACY_HORSE_COMPACTION_BOUNDED_IDS_REQUIRED' USING ERRCODE='22023'; END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO ids FROM unnest(p_submission_ids)x;
 ids:=COALESCE(ids,ARRAY[]::uuid[]);
 IF cardinality(ids)<>cardinality(p_submission_ids) THEN RAISE EXCEPTION 'LEGACY_HORSE_COMPACTION_DUPLICATE_IDS' USING ERRCODE='22023'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('legacy:horse:compaction:'||p_batch_id::text,0)) THEN
  RAISE EXCEPTION 'LEGACY_HORSE_COMPACTION_BATCH_BUSY' USING ERRCODE='55P03'; END IF;
 SELECT * INTO prior FROM smarter_private.legacy_horse_request_compaction_batches WHERE batch_id=p_batch_id;
 IF FOUND THEN
  IF prior.submission_ids IS DISTINCT FROM ids THEN RAISE EXCEPTION 'LEGACY_HORSE_COMPACTION_BATCH_ID_REUSED' USING ERRCODE='55000'; END IF;
  RETURN prior.result||jsonb_build_object('replay',true);
 END IF;
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) OR public.fn_platform_frozen() THEN
  RAISE EXCEPTION 'LEGACY_HORSE_COMPACTION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 FOREACH sid IN ARRAY ids LOOP
  BEGIN
   SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=sid FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN protected:=protected+1;CONTINUE; END;
  IF NOT FOUND THEN protected:=protected+1;CONTINUE; END IF;
  IF s.request='{}'::jsonb THEN already:=already+1;CONTINUE; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0)) THEN protected:=protected+1;CONTINUE; END IF;
  proof:=smarter_private.qualify_legacy_horse_tournament_request(sid);
  IF proof IS NULL THEN protected:=protected+1;CONTINUE; END IF;
  INSERT INTO smarter_private.legacy_horse_request_certificates(submission_id,request_hash,proof)
   VALUES(sid,s.request_hash,proof) ON CONFLICT(submission_id) DO NOTHING;
  n:=smarter_private.compact_settled_horse_requests(ARRAY[sid]);
  erased:=erased+n;protected:=protected+1-n;
 END LOOP;
 result:=jsonb_build_object('batch_id',p_batch_id,'examined',cardinality(ids),'erased',erased,
  'already_compacted',already,'protected',protected,'replay',false,'credit',0);
 INSERT INTO smarter_private.legacy_horse_request_compaction_batches(batch_id,submission_ids,result)
 VALUES(p_batch_id,ids,result);
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.compact_legacy_horse_tournament_request_batch(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;

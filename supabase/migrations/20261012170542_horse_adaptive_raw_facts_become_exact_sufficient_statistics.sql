-- Reserved through scripts/new-migration.mjs. Original per-hand public learning
-- tuples survived the owner's eight-day settled horse retention. Preserve exact
-- timestamp/count sufficient statistics and immutable replay digests, never
-- synthesize raw tuples or delete a human/mixed/unknown original. This transaction
-- installs an inactive compactor; the operation owner enables it only after the
-- versioned consumer is serving. Original qualified disposal captures its durable
-- certificate immediately, so independent request retention is not blocked.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_append_horse_adaptive_observations(text)'::regprocedure)) IS DISTINCT FROM '497a5c0653dc94c37799e3a2039c41a0'
 OR md5(pg_get_functiondef('public.fn_prune_horse_adaptive_journal()'::regprocedure)) IS DISTINCT FROM '5afb72bb25daafd1f0d2eb545baaf081'
 OR md5(pg_get_functiondef('public.fn_claim_horse_journaled_model(uuid)'::regprocedure)) IS DISTINCT FROM '8ab843ba186225da1107c3bc7c9cf7e8'
 OR md5(pg_get_functiondef('public.fn_horse_adaptive_journal_batch(text)'::regprocedure)) IS DISTINCT FROM '4c9fa765c3ed0e64f00f21a526a341f8'
 OR md5(pg_get_functiondef('public.fn_queue_horse_adaptive_batch(text)'::regprocedure)) IS DISTINCT FROM '789db07380d5039844b857ef33fef871'
 OR md5(pg_get_functiondef('public.fn_finish_horse_journaled_model(uuid,text)'::regprocedure)) IS DISTINCT FROM 'ae963e054b553e695a0cd7ef36cae7a7'
 OR md5(pg_get_functiondef('smarter_private.horse_request_payload_disposable(uuid)'::regprocedure)) IS DISTINCT FROM 'af3f0cb0c28dfcaad264919c1bb93cda'
 OR md5(pg_get_functiondef('smarter_private.compact_settled_horse_requests(uuid[])'::regprocedure)) IS DISTINCT FROM 'a715adfb7928e918cc015563af0b6448'
 THEN RAISE EXCEPTION 'ADAPTIVE_RETENTION_PREIMAGE_CHANGED'; END IF;
END $guard$;
CREATE TABLE smarter_private.horse_adaptive_disposal_certificates(
 hand_id uuid PRIMARY KEY, hand_digest text NOT NULL UNIQUE CHECK(hand_digest~'^[a-f0-9]{64}$'),
 table_id uuid NOT NULL, hand_number bigint NOT NULL, request_hash text NOT NULL,
 qualified_at timestamptz NOT NULL, retired_at timestamptz,
 certificate jsonb NOT NULL CHECK(certificate->>'version'='settled-horse-adaptive-disposal-v1')
);
CREATE INDEX horse_adaptive_disposal_pending ON smarter_private.horse_adaptive_disposal_certificates(qualified_at,hand_id) WHERE retired_at IS NULL;
CREATE TABLE smarter_private.horse_adaptive_statistics(
 hand_digest text NOT NULL,actor_key text NOT NULL,session_key text NOT NULL,
 partition text NOT NULL CHECK(partition IN('training','holdout')),scope_key text NOT NULL,
 origin text NOT NULL CHECK(origin IN('player','pre_action','horse_policy')),
 observed_at_ms bigint NOT NULL, action text NOT NULL CHECK(action IN('fold','check','call','bet','raise')),
 observations integer NOT NULL CHECK(observations BETWEEN 1 AND 4096),
 PRIMARY KEY(hand_digest,actor_key,session_key,partition,scope_key,origin,observed_at_ms,action),
 CHECK(hand_digest~'^[a-f0-9]{64}$' AND actor_key~'^[a-f0-9]{64}$' AND session_key~'^[a-f0-9]{64}$' AND scope_key~'^[a-f0-9]{64}$')
);
CREATE INDEX horse_adaptive_statistics_scope ON smarter_private.horse_adaptive_statistics(actor_key,scope_key,partition,origin,observed_at_ms);
CREATE INDEX horse_adaptive_statistics_age ON smarter_private.horse_adaptive_statistics(observed_at_ms);
CREATE TABLE smarter_private.horse_adaptive_observation_fences(
 observation_digest text PRIMARY KEY CHECK(observation_digest~'^[a-f0-9]{64}$'),
 hand_digest text NOT NULL,payload_digest text NOT NULL CHECK(payload_digest~'^[a-f0-9]{64}$')
);
CREATE TABLE smarter_private.horse_adaptive_retention_activation(
 singleton boolean PRIMARY KEY CHECK(singleton),enabled boolean NOT NULL DEFAULT false,
 consumer_release text CHECK(consumer_release~'^[a-f0-9]{40}$')
);
INSERT INTO smarter_private.horse_adaptive_retention_activation VALUES(true,false,NULL);
ALTER TABLE public.horse_adaptive_observation_batches ADD COLUMN retention_compacted boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.horse_adaptive_observation_batches.canonical_payload IS 'Exact original batch while retention_compacted=false; after qualified retirement only protected original tuple strings remain, with original digest preserved and exact recovery explicitly unavailable.';
ALTER TABLE public.horse_adaptive_observation_batches ADD COLUMN retention_membership_ready boolean NOT NULL DEFAULT false;
CREATE INDEX horse_adaptive_batches_membership_pending ON public.horse_adaptive_observation_batches(recorded_at,batch_key) WHERE NOT retention_membership_ready;
CREATE TABLE smarter_private.horse_adaptive_batch_hand_membership(
 hand_digest text NOT NULL CHECK(hand_digest~'^[a-f0-9]{64}$'),batch_key text NOT NULL CHECK(batch_key~'^[a-f0-9]{64}$'),PRIMARY KEY(hand_digest,batch_key)
);
REVOKE ALL ON smarter_private.horse_adaptive_batch_hand_membership FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON smarter_private.horse_adaptive_disposal_certificates,smarter_private.horse_adaptive_statistics,
 smarter_private.horse_adaptive_observation_fences,smarter_private.horse_adaptive_retention_activation FROM PUBLIC,anon,authenticated,service_role;

-- The durable boundary certificate is independent of learner activation. Its
-- core never changes; only the exact successful payload transition can mark it
-- retired. Direct elevated writes cannot manufacture an original classifier.
CREATE FUNCTION smarter_private.horse_adaptive_disposal_certificate_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE s smarter_private.hand_submissions; d smarter_private.hand_submission_disposals;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=NEW.hand_id;
  SELECT * INTO d FROM smarter_private.hand_submission_disposals WHERE submission_id=NEW.hand_id AND table_id=NEW.table_id AND hand_number=NEW.hand_number;
  IF NOT smarter_private.horse_request_payload_disposable(NEW.hand_id)
  OR s.request#>'{p_hand_row,has_human}' IS DISTINCT FROM 'false'::jsonb
  OR NEW.table_id IS DISTINCT FROM s.table_id OR NEW.hand_number IS DISTINCT FROM s.hand_number
  OR NEW.request_hash IS DISTINCT FROM s.request_hash OR NEW.hand_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.hand_id::text,'UTF8')),'hex')
  OR NEW.retired_at IS NOT NULL OR NOT isfinite(NEW.qualified_at)
  OR NEW.qualified_at>clock_timestamp() OR NEW.qualified_at<transaction_timestamp()
  OR NEW.certificate->>'version' IS DISTINCT FROM 'settled-horse-adaptive-disposal-v1'
  OR NEW.certificate->'original_horse_only' IS DISTINCT FROM 'true'::jsonb
  OR NEW.certificate->'original_has_human' IS DISTINCT FROM 'false'::jsonb
  OR NEW.certificate->'retained_at' IS DISTINCT FROM to_jsonb(s.retained_at)
  OR NEW.certificate->>'request_hash' IS DISTINCT FROM s.request_hash
  OR NEW.certificate->>'classifier_definition_md5' IS DISTINCT FROM md5(pg_get_functiondef('smarter_private.horse_request_payload_disposable(uuid)'::regprocedure))
  OR NEW.certificate->'disposal' IS DISTINCT FROM d.expected THEN RAISE EXCEPTION 'ADAPTIVE_DISPOSAL_CERTIFICATE_UNQUALIFIED'; END IF;
  RETURN NEW;
 ELSIF TG_OP='UPDATE' AND OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
 AND (to_jsonb(NEW)-'retired_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'retired_at')
 AND isfinite(NEW.retired_at) AND NEW.retired_at>=OLD.qualified_at AND NEW.retired_at<=clock_timestamp()
 AND EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_retention_activation WHERE singleton AND enabled)
 AND NOT EXISTS(SELECT 1 FROM public.horse_adaptive_observation_journal j WHERE j.observation_id>=OLD.hand_id::text||':' AND j.observation_id<OLD.hand_id::text||';' AND j.hand_id=OLD.hand_id)
 THEN RETURN NEW;
 END IF;
 RAISE EXCEPTION 'ADAPTIVE_DISPOSAL_CERTIFICATE_IMMUTABLE';
END $fn$;
CREATE TRIGGER horse_adaptive_disposal_certificate_immutable BEFORE INSERT OR UPDATE OR DELETE ON smarter_private.horse_adaptive_disposal_certificates FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_adaptive_disposal_certificate_immutable();
CREATE TRIGGER horse_adaptive_disposal_certificate_no_truncate BEFORE TRUNCATE ON smarter_private.horse_adaptive_disposal_certificates FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.horse_adaptive_disposal_certificate_immutable();
REVOKE ALL ON FUNCTION smarter_private.horse_adaptive_disposal_certificate_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.horse_adaptive_disposal_certificate_matches(p_hand uuid,p_table uuid,p_number bigint,p_hash text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE c smarter_private.horse_adaptive_disposal_certificates; d jsonb; t timestamptz;
BEGIN
 IF (SELECT horse_retention_days FROM public.hand_history_retention_policy LIMIT 1) IS DISTINCT FROM 8 THEN RETURN false; END IF;
 SELECT * INTO c FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id=p_hand;
 IF NOT FOUND OR p_table IS NULL OR p_number IS NULL OR p_hash IS NULL
 OR c.table_id IS DISTINCT FROM p_table OR c.hand_number IS DISTINCT FROM p_number OR c.request_hash IS DISTINCT FROM p_hash
 OR c.hand_digest IS DISTINCT FROM encode(sha256(convert_to(p_hand::text,'UTF8')),'hex')
 OR c.certificate->>'version' IS DISTINCT FROM 'settled-horse-adaptive-disposal-v1'
 OR c.certificate->'original_horse_only' IS DISTINCT FROM 'true'::jsonb
 OR c.certificate->'original_has_human' IS DISTINCT FROM 'false'::jsonb
 OR c.certificate->>'request_hash' IS DISTINCT FROM p_hash
 OR COALESCE(c.certificate->>'classifier_definition_md5','')!~'^[a-f0-9]{32}$'
 OR NOT isfinite(c.qualified_at) OR c.qualified_at>clock_timestamp() THEN RETURN false; END IF;
 d:=c.certificate->'disposal';
 IF d->>'kind' IS DISTINCT FROM 'retention_pruned_settled_hand'
 OR d->'settled' IS DISTINCT FROM 'true'::jsonb OR d->'settlement_completed' IS DISTINCT FROM 'true'::jsonb
 OR d->>'submission_id' IS DISTINCT FROM p_hand::text OR d->>'pruned_hand_id' IS DISTINCT FROM p_hand::text
 OR d->>'table_id' IS DISTINCT FROM p_table::text OR d->>'hand_number' IS DISTINCT FROM p_number::text
 OR d->>'request_hash' IS DISTINCT FROM p_hash THEN RETURN false; END IF;
 FOR t IN SELECT value::timestamptz FROM (VALUES(c.certificate->>'retained_at'),(d->>'hand_created_at'),(d->>'settlement_completed_at')) v(value) LOOP
  IF t IS NULL OR NOT isfinite(t) OR t>=statement_timestamp()-interval '8 days' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.horse_adaptive_disposal_certificate_matches(uuid,uuid,bigint,text) FROM PUBLIC,anon,authenticated,service_role;

-- Only the release owner can enable a serving versioned consumer. Installation
-- and engine adoption remain distinct, and old workers continue safely meanwhile.
CREATE FUNCTION smarter_private.enable_horse_adaptive_retention(p_release text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
BEGIN
 IF p_release IS NULL OR p_release!~'^[a-f0-9]{40}$' THEN RAISE EXCEPTION 'ADAPTIVE_CONSUMER_RELEASE_REQUIRED'; END IF;
 UPDATE smarter_private.horse_adaptive_retention_activation SET enabled=true,consumer_release=p_release WHERE singleton;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.enable_horse_adaptive_retention(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.retire_horse_adaptive_hand(p_hand uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET lock_timeout='2s' AS $fn$
DECLARE c smarter_private.horse_adaptive_disposal_certificates; b record; kept jsonb; key text; n integer;
BEGIN
 SELECT * INTO c FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id=p_hand FOR UPDATE;
 IF NOT FOUND THEN RETURN 0; END IF;
 IF NOT smarter_private.horse_adaptive_disposal_certificate_matches(c.hand_id,c.table_id,c.hand_number,c.request_hash) THEN RETURN 0; END IF;
 IF c.retired_at IS NOT NULL THEN RETURN 0; END IF;
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
 WHERE j.observation_id>=p_hand::text||':' AND j.observation_id<p_hand::text||';' AND j.hand_id=p_hand
 AND (jsonb_typeof(j.payload::jsonb) IS DISTINCT FROM 'array' OR jsonb_array_length(j.payload::jsonb)<>12
 OR j.payload::jsonb->0 IS DISTINCT FROM '1'::jsonb OR j.payload::jsonb->>1 IS DISTINCT FROM j.observation_id OR j.payload::jsonb->>2 IS DISTINCT FROM p_hand::text
 OR j.payload::jsonb->>3 IS DISTINCT FROM j.actor_key OR j.payload::jsonb->>4 IS DISTINCT FROM j.session_key
 OR j.payload::jsonb->>5 IS DISTINCT FROM j.observed_at_ms::text OR j.payload::jsonb->>6 IS DISTINCT FROM j.partition
 OR j.payload::jsonb->>7 IS DISTINCT FROM j.scope_key OR j.payload::jsonb->>11 IS DISTINCT FROM j.origin
 OR jsonb_typeof(j.payload::jsonb->10) IS DISTINCT FROM 'boolean' OR encode(sha256(convert_to(j.payload::jsonb->>8,'UTF8')),'hex') IS DISTINCT FROM j.scope_key OR j.payload::jsonb->>9 NOT IN('fold','check','call','bet','raise'))) THEN RAISE EXCEPTION 'ADAPTIVE_RETENTION_INVALID_FACT'; END IF;
 IF EXISTS(SELECT 1 FROM public.horse_adaptive_observation_journal j
 WHERE j.observation_id>=p_hand::text||':' AND j.observation_id<p_hand::text||';' AND j.hand_id=p_hand
 GROUP BY actor_key HAVING count(DISTINCT session_key)>1 OR count(DISTINCT partition)>1)
 THEN RAISE EXCEPTION 'ADAPTIVE_RETENTION_PARTITION_CONFLICT'; END IF;
 INSERT INTO smarter_private.horse_adaptive_observation_fences
 SELECT encode(sha256(convert_to(j.observation_id,'UTF8')),'hex'),c.hand_digest,encode(sha256(convert_to(j.payload,'UTF8')),'hex')
 FROM public.horse_adaptive_observation_journal j
 WHERE j.observation_id>=p_hand::text||':' AND j.observation_id<p_hand::text||';' AND j.hand_id=p_hand;
 INSERT INTO smarter_private.horse_adaptive_statistics
 SELECT c.hand_digest,j.actor_key,j.session_key,j.partition,j.scope_key,j.origin,j.observed_at_ms,j.payload::jsonb->>9,count(*)::integer
 FROM public.horse_adaptive_observation_journal j
 WHERE j.observation_id>=p_hand::text||':' AND j.observation_id<p_hand::text||';' AND j.hand_id=p_hand
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
 WHERE j.observation_id>=p_hand::text||':' AND j.observation_id<p_hand::text||';' AND j.hand_id=p_hand;
 GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE smarter_private.horse_adaptive_disposal_certificates SET retired_at=clock_timestamp() WHERE hand_id=p_hand;
 RETURN n;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.retire_horse_adaptive_hand(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.capture_horse_adaptive_disposals(p_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE id uuid; n integer:=0;
BEGIN
 IF cardinality(p_ids)>10000 THEN RAISE EXCEPTION 'ADAPTIVE_DISPOSAL_BATCH_TOO_LARGE'; END IF;
 FOR id IN SELECT unnest(p_ids) LOOP
  IF smarter_private.horse_request_payload_disposable(id) AND EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE submission_id=id AND request#>'{p_hand_row,has_human}'='false'::jsonb) THEN
   INSERT INTO smarter_private.horse_adaptive_disposal_certificates
   SELECT s.submission_id,encode(sha256(convert_to(s.submission_id::text,'UTF8')),'hex'),s.table_id,s.hand_number,s.request_hash,clock_timestamp(),NULL,
    jsonb_build_object('version','settled-horse-adaptive-disposal-v1','original_horse_only',true,'original_has_human',s.request#>'{p_hand_row,has_human}',
     'retained_at',s.retained_at,'classifier_definition_md5',md5(pg_get_functiondef('smarter_private.horse_request_payload_disposable(uuid)'::regprocedure)),
     'request_hash',s.request_hash,'disposal',d.expected)
   FROM smarter_private.hand_submissions s JOIN smarter_private.hand_submission_disposals d
    ON d.table_id=s.table_id AND d.hand_number=s.hand_number AND d.submission_id=s.submission_id
   WHERE s.submission_id=id ON CONFLICT(hand_id) DO NOTHING;
   n:=n+1;
  END IF;
 END LOOP;
 RETURN n;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.capture_horse_adaptive_disposals(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
DO $hook$ DECLARE src text; anchor text:=E' UPDATE smarter_private.hand_submissions s SET request=''{}''::jsonb'; BEGIN
 src:=pg_get_functiondef('smarter_private.compact_settled_horse_requests(uuid[])'::regprocedure);
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'ADAPTIVE_REQUEST_HOOK_CHANGED'; END IF;
 EXECUTE replace(src,anchor,E' PERFORM smarter_private.capture_horse_adaptive_disposals(p_submission_ids);\n'||anchor);
END $hook$;

-- Admission and retirement share the original capacity lock. An old observation
-- can only replay its exact digest, never reinsert rawcontent via a new batch.
DO $append$ DECLARE src text; anchor text:=E'  b := p_batch::jsonb;'; insert_anchor text:=E'    INSERT INTO public.horse_adaptive_observation_journal'; BEGIN
 src:=pg_get_functiondef('public.fn_append_horse_adaptive_observations(text)'::regprocedure);
 IF strpos(src,anchor)=0 OR strpos(src,insert_anchor)=0 THEN RAISE EXCEPTION 'ADAPTIVE_APPEND_ANCHOR_CHANGED'; END IF;
 src:=replace(src,anchor,E'  IF NOT pg_try_advisory_xact_lock(hashtextextended(''horse-adaptive-work-capacity-v1'',0)) THEN RAISE EXCEPTION ''ADAPTIVE_RETENTION_BUSY''; END IF;\n'||anchor);
 src:=replace(src,insert_anchor,E'    IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_digest=encode(sha256(convert_to(o->>2,''UTF8'')),''hex'') AND retired_at IS NOT NULL) THEN\n      IF NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_observation_fences WHERE observation_digest=encode(sha256(convert_to(o->>1,''UTF8'')),''hex'') AND payload_digest=encode(sha256(convert_to(row_text,''UTF8'')),''hex'')) THEN RAISE EXCEPTION ''ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT''; END IF;\n      CONTINUE;\n    END IF;\n'||insert_anchor);
 EXECUTE src;
END $append$;
DO $recovery$ DECLARE src text; BEGIN
 src:=pg_get_functiondef('public.fn_horse_adaptive_journal_batch(text)'::regprocedure);
 src:=replace(src,E'  IF b.canonical_payload IS NULL THEN',E'  IF b.retention_compacted THEN RETURN jsonb_build_object(''version'',1,''status'',''unavailable'',''reason'',''retention_compacted''); END IF;\n  IF b.canonical_payload IS NULL THEN');
 EXECUTE src;
 src:=pg_get_functiondef('public.fn_queue_horse_adaptive_batch(text)'::regprocedure);
 src:=replace(src,E'    IF receipt.canonical_payload IS NULL THEN',E'    IF receipt.retention_compacted THEN RETURN jsonb_build_object(''version'',1,''status'',''unavailable'',''reason'',''retention_compacted''); END IF;\n    IF receipt.canonical_payload IS NULL THEN');
 EXECUTE src;
END $recovery$;
-- Existing observer-driven prune now processes qualified pending certificates;
-- it never deletes human/unknown raw facts merely because they reached32days.
CREATE OR REPLACE FUNCTION public.fn_prune_horse_adaptive_journal()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private SET lock_timeout='2s' AS $fn$
DECLARE id uuid; batch record; membership_count integer:=0; membership_bytes bigint:=0; n integer; work_count integer; statistics_count integer; raw_count integer:=0; retired_count integer:=0;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0)) THEN RETURN jsonb_build_object('version',2,'status','unavailable','reason','capacity_busy'); END IF;
 WITH candidate AS (SELECT batch_key FROM public.horse_adaptive_journal_work WHERE state='completed' AND completed_at<clock_timestamp()-interval '32 days' ORDER BY completed_at,batch_key LIMIT 100 FOR UPDATE SKIP LOCKED)
 DELETE FROM public.horse_adaptive_journal_work w USING candidate c WHERE w.batch_key=c.batch_key;
 GET DIAGNOSTICS work_count=ROW_COUNT;
 FOR batch IN SELECT batch_key,COALESCE(octet_length(canonical_payload),0) bytes FROM public.horse_adaptive_observation_batches WHERE NOT retention_membership_ready ORDER BY recorded_at,batch_key LIMIT 25 FOR UPDATE SKIP LOCKED LOOP
  IF membership_count>0 AND membership_bytes+batch.bytes>16777216 THEN EXIT; END IF;
  PERFORM smarter_private.register_horse_adaptive_batch_membership(batch.batch_key);
  membership_count:=membership_count+1; membership_bytes:=membership_bytes+batch.bytes;
 END LOOP;
 FOR id IN SELECT hand_id FROM smarter_private.horse_adaptive_disposal_certificates WHERE retired_at IS NULL ORDER BY qualified_at,hand_id LIMIT 25 LOOP
  n:=smarter_private.retire_horse_adaptive_hand(id); raw_count:=raw_count+n;
  IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id=id AND retired_at IS NOT NULL) THEN retired_count:=retired_count+1; END IF;
 END LOOP;
 WITH expired AS (SELECT ctid FROM smarter_private.horse_adaptive_statistics WHERE observed_at_ms<floor(extract(epoch FROM (clock_timestamp()-interval '30 days'))*1000)::bigint LIMIT 1000)
 DELETE FROM smarter_private.horse_adaptive_statistics s USING expired e WHERE s.ctid=e.ctid;
 GET DIAGNOSTICS statistics_count=ROW_COUNT;
 RETURN jsonb_build_object('version',2,'status','pruned','completedWork',work_count,'batches',0,'observations',raw_count,'retiredHands',retired_count,'statisticsExpired',statistics_count,'membershipsRegistered',membership_count,'membershipPending',EXISTS(SELECT 1 FROM public.horse_adaptive_observation_batches WHERE NOT retention_membership_ready LIMIT 1));
END $fn$;


CREATE FUNCTION smarter_private.adaptive_retained_batch(p_batch text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
 SELECT jsonb_set(p_batch::jsonb,'{7}',COALESCE((SELECT jsonb_agg(v.value ORDER BY v.ordinality)
 FROM jsonb_array_elements(p_batch::jsonb->7) WITH ORDINALITY v
 WHERE NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates c
 WHERE c.hand_digest=encode(sha256(convert_to((v.value#>>'{}')::jsonb->>2,'UTF8')),'hex') AND c.retired_at IS NOT NULL)),'[]'::jsonb))::text
$fn$;
REVOKE ALL ON FUNCTION smarter_private.adaptive_retained_batch(text) FROM PUBLIC,anon,authenticated,service_role;
DO $copies$ DECLARE src text; anchor text; BEGIN
 src:=pg_get_functiondef('public.fn_append_horse_adaptive_observations(text)'::regprocedure);
 anchor:=E'  SELECT * INTO prior FROM public.horse_adaptive_observation_batches q WHERE q.batch_key=v_batch_key;\n  IF prior.batch_digest IS DISTINCT';
 IF strpos(src,anchor)=0 THEN RAISE EXCEPTION 'ADAPTIVE_BATCH_WRITE_CHANGED'; END IF;
 EXECUTE replace(src,anchor,E'  IF EXISTS(SELECT 1 FROM jsonb_array_elements(b->7) v WHERE EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates c WHERE c.hand_digest=encode(sha256(convert_to((v.value#>>''{}'')::jsonb->>2,''UTF8'')),''hex'') AND c.retired_at IS NOT NULL)) THEN UPDATE public.horse_adaptive_observation_batches SET canonical_payload=smarter_private.adaptive_retained_batch(p_batch),retention_compacted=true WHERE batch_key=v_batch_key; END IF;\n'||anchor);
 src:=pg_get_functiondef('public.fn_queue_horse_adaptive_batch(text)'::regprocedure);
 anchor:=E'  -- Try, never wait behind';
 IF strpos(src,anchor)=0 THEN RAISE EXCEPTION 'ADAPTIVE_QUEUE_ADMISSION_CHANGED'; END IF;
 EXECUTE replace(src,anchor,E'  IF EXISTS(SELECT 1 FROM jsonb_array_elements(b->7) v WHERE EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates c WHERE c.hand_digest=encode(sha256(convert_to((v.value#>>''{}'')::jsonb->>2,''UTF8'')),''hex'') AND c.retired_at IS NOT NULL)) THEN RETURN jsonb_build_object(''version'',1,''status'',''unavailable'',''reason'',''retention_compacted''); END IF;\n'||anchor);
END $copies$;

-- Metadata qualification is part of existing bounded retention, not another
-- job or scan loop. The append event makes all future batch membership exact.
CREATE FUNCTION smarter_private.register_horse_adaptive_batch_membership(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE b public.horse_adaptive_observation_batches; v jsonb; hand text; sanitized text;
BEGIN
 SELECT * INTO b FROM public.horse_adaptive_observation_batches WHERE batch_key=p_key FOR UPDATE;
 IF NOT FOUND OR b.retention_membership_ready THEN RETURN; END IF;
 IF b.canonical_payload IS NOT NULL THEN
  IF octet_length(b.canonical_payload)>16777216 OR jsonb_typeof(b.canonical_payload::jsonb) IS DISTINCT FROM 'array'
  OR jsonb_array_length(b.canonical_payload::jsonb)<>8 OR jsonb_typeof(b.canonical_payload::jsonb->7) IS DISTINCT FROM 'array'
  OR jsonb_array_length(b.canonical_payload::jsonb->7)>20000 THEN RAISE EXCEPTION 'ADAPTIVE_BATCH_MEMBERSHIP_INVALID'; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(b.canonical_payload::jsonb->7) LOOP
   hand:=(v#>>'{}')::jsonb->>2;
   IF hand IS NULL OR hand!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   THEN RAISE EXCEPTION 'ADAPTIVE_BATCH_MEMBERSHIP_INVALID'; END IF;
   INSERT INTO smarter_private.horse_adaptive_batch_hand_membership VALUES(encode(sha256(convert_to(hand,'UTF8')),'hex'),p_key) ON CONFLICT DO NOTHING;
  END LOOP;
  sanitized:=smarter_private.adaptive_retained_batch(b.canonical_payload);
  IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_batch_hand_membership m JOIN smarter_private.horse_adaptive_disposal_certificates c USING(hand_digest) WHERE m.batch_key=p_key AND c.retired_at IS NOT NULL) THEN
   UPDATE public.horse_adaptive_observation_batches SET canonical_payload=sanitized,retention_compacted=true WHERE batch_key=p_key;
  END IF;
 END IF;
 UPDATE public.horse_adaptive_observation_batches SET retention_membership_ready=true WHERE batch_key=p_key;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.register_horse_adaptive_batch_membership(text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.horse_adaptive_batch_membership_on_append() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
BEGIN
 PERFORM smarter_private.register_horse_adaptive_batch_membership(NEW.batch_key);
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.horse_adaptive_batch_membership_on_append() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_adaptive_batch_membership_on_append AFTER INSERT ON public.horse_adaptive_observation_batches FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_adaptive_batch_membership_on_append();
-- Authoritative insert fence also protects a statement still executing the old
-- cached writer body. Exact retired replays cannot create a new raw row.
CREATE FUNCTION smarter_private.horse_adaptive_raw_retirement_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_digest=encode(sha256(convert_to(NEW.hand_id::text,'UTF8')),'hex') AND retired_at IS NOT NULL) THEN
  IF NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_observation_fences WHERE observation_digest=encode(sha256(convert_to(NEW.observation_id,'UTF8')),'hex') AND payload_digest=encode(sha256(convert_to(NEW.payload,'UTF8')),'hex')) THEN RAISE EXCEPTION 'ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT'; END IF;
  RETURN NULL;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.horse_adaptive_raw_retirement_fence() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_adaptive_raw_retirement_fence BEFORE INSERT ON public.horse_adaptive_observation_journal FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_adaptive_raw_retirement_fence();

-- Version2 snapshot carries explicit compactstatistics separately from rawrows.
-- Exact observation timestamps preserve arbitrary30day cutoff, sessionweighted
-- fitting and represented-observation limits. No invented original tuples.
CREATE FUNCTION public.fn_claim_horse_journaled_model_statistics(p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private SET lock_timeout='2s' AS $fn$
DECLARE s public.horse_journaled_model_sweep; a text; k text;
 v_to bigint:=floor(extract(epoch FROM statement_timestamp())*1000)::bigint; v_from bigint;
 n integer; b bigint; rows jsonb; statistics jsonb; ev text; snap text; pop text;
BEGIN
 IF p_lease_token IS NULL THEN RAISE EXCEPTION 'MODEL_INVALID_TOKEN'; END IF;
 SELECT * INTO s FROM public.horse_journaled_model_sweep WHERE singleton FOR UPDATE SKIP LOCKED;
 IF NOT FOUND OR s.lease_until>statement_timestamp() THEN RETURN jsonb_build_object('version',2,'status','idle'); END IF;
 SELECT actor_key,scope_key INTO a,k FROM (
 (SELECT actor_key,scope_key FROM public.horse_adaptive_observation_journal WHERE (actor_key,scope_key)>(s.cursor_actor,s.cursor_scope) ORDER BY actor_key,scope_key LIMIT 1)
 UNION ALL (SELECT actor_key,scope_key FROM smarter_private.horse_adaptive_statistics WHERE (actor_key,scope_key)>(s.cursor_actor,s.cursor_scope) ORDER BY actor_key,scope_key LIMIT 1)
 ) q ORDER BY actor_key,scope_key LIMIT 1;
 IF a IS NULL THEN SELECT actor_key,scope_key INTO a,k FROM (
 (SELECT actor_key,scope_key FROM public.horse_adaptive_observation_journal ORDER BY actor_key,scope_key LIMIT 1)
 UNION ALL (SELECT actor_key,scope_key FROM smarter_private.horse_adaptive_statistics ORDER BY actor_key,scope_key LIMIT 1)) q ORDER BY actor_key,scope_key LIMIT 1; END IF;
 IF a IS NULL THEN RETURN jsonb_build_object('version',2,'status','idle'); END IF;
 v_from:=v_to-2592000000;
 WITH raw AS MATERIALIZED (
 SELECT j.observation_id,j.payload FROM (VALUES('training','player'),('training','pre_action'),('training','horse_policy'),('holdout','player'),('holdout','pre_action'),('holdout','horse_policy')) arm(partition,origin)
 CROSS JOIN LATERAL (SELECT observation_id,payload FROM public.horse_adaptive_observation_journal
 WHERE actor_key=a AND scope_key=k AND partition=arm.partition AND origin=arm.origin AND observed_at_ms>=v_from AND observed_at_ms<v_to LIMIT 20001) j LIMIT 20001
 ), compact AS MATERIALIZED (
 SELECT jsonb_build_array(1,hand_digest,actor_key,session_key,partition,scope_key,origin,observed_at_ms,action,observations)::text payload,observations
 FROM smarter_private.horse_adaptive_statistics WHERE actor_key=a AND scope_key=k AND observed_at_ms>=v_from AND observed_at_ms<v_to
 LIMIT 20001
 ), totals AS (SELECT (SELECT count(*) FROM raw)+COALESCE((SELECT sum(observations) FROM compact),0) n,
 COALESCE((SELECT sum(octet_length(payload)) FROM raw),0)+COALESCE((SELECT sum(octet_length(payload)) FROM compact),0) b)
 SELECT LEAST(t.n,2147483647)::integer,t.b,
 CASE WHEN t.n<=20000 AND t.b<=16777216 THEN (SELECT COALESCE(jsonb_agg(payload ORDER BY observation_id),'[]'::jsonb) FROM raw) ELSE '[]'::jsonb END,
 CASE WHEN t.n<=20000 AND t.b<=16777216 THEN (SELECT COALESCE(jsonb_agg(payload ORDER BY payload),'[]'::jsonb) FROM compact) ELSE '[]'::jsonb END,
 CASE WHEN t.n<=20000 AND t.b<=16777216 THEN encode(sha256(convert_to(
 COALESCE((SELECT string_agg(payload,E'\n' ORDER BY observation_id) FROM raw),'')||E'\n--statistics-v1--\n'||COALESCE((SELECT string_agg(payload,E'\n' ORDER BY payload) FROM compact),''),'UTF8')),'hex')
 ELSE encode(sha256(convert_to(concat_ws('|','bounded-statistics-refusal',t.n,t.b),'UTF8')),'hex') END,pg_current_snapshot()::text INTO n,b,rows,statistics,ev,snap FROM totals t;
 pop:=CASE WHEN n>20000 THEN 'observation_budget_exceeded' WHEN b>16777216 THEN 'byte_budget_exceeded' ELSE 'snapshot' END;
 UPDATE public.horse_journaled_model_sweep SET lease_token=p_lease_token,lease_until=statement_timestamp()+interval '60 seconds',actor_key=a,scope_key=k,from_ms=v_from,to_ms=v_to,snapshot_id=snap,evidence_digest=ev,population_status=pop WHERE singleton;
 RETURN jsonb_build_object('version',2,'status','claimed','leaseToken',p_lease_token,'actorKey',a,'scopeKey',k,'fromMs',v_from,'toMs',v_to,'snapshotId',snap,'populationStatus',pop,'evidenceDigest',ev,'observations',n,'bytes',b,'rows',rows,'statistics',statistics);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_claim_horse_journaled_model_statistics(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_claim_horse_journaled_model_statistics(uuid) TO service_role;
DO $finish$ DECLARE src text; BEGIN
 src:=pg_get_functiondef('public.fn_finish_horse_journaled_model(uuid,text)'::regprocedure);
 src:=replace(src,'fn_finish_horse_journaled_model(', 'fn_finish_horse_journaled_model_statistics(');
 src:=replace(src,'''horse-journaled-model-report-v1''','''horse-journaled-model-report-v2''');
 src:=replace(src,'''journaled_qualified_observations''','''journaled_qualified_observations_and_disposed_statistics''');
 EXECUTE src;
END $finish$;
REVOKE ALL ON FUNCTION public.fn_finish_horse_journaled_model_statistics(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_finish_horse_journaled_model_statistics(uuid,text) TO service_role;
COMMIT;

-- Version reserved by scripts/new-migration.mjs. Owner explicitly authorized a
-- one-time legacy TEST-LEARNING purge on 2026-10-15. This is NOT a financial
-- settlement/disposal certificate and never changes human hand histories,
-- financial records, statistics, normal disposal qualification or schedules.
-- Fixed cohort: every remaining observation for the hand is on/before
-- 2026-10-04T23:59:59.999Z. Missing old settlement evidence is waived ONLY for
-- these raw learning copies. Explicit original human evidence still protects.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE item record; p pg_proc;
BEGIN
 FOR item IN SELECT * FROM (VALUES
 ('public.fn_append_horse_adaptive_observations(text)','4d7e7959d27afd57ef4f88f61dc301df'),
 ('public.fn_queue_horse_adaptive_batch(text)','1ef887d58848827bb5124dc95861c1bf'),
 ('smarter_private.adaptive_retained_batch(text)','87b690971fe0b3b95943991ac5480308'),
 ('smarter_private.horse_adaptive_raw_retirement_fence()','7e60907320b24c14cea58ea34552e106'),
 ('smarter_private.register_horse_adaptive_batch_membership(text)','f03ff088bd059eeff9c74f0acda7d19f')) v(signature,digest) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=item.signature::regprocedure;
  IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM item.digest
  OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef
  OR p.proacl::text IS DISTINCT FROM (CASE WHEN p.pronamespace='public'::regnamespace
   THEN '{postgres=X/postgres,service_role=X/postgres}' ELSE '{postgres=X/postgres}' END)
  OR p.proconfig IS DISTINCT FROM (CASE WHEN p.pronamespace='public'::regnamespace
   THEN ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=2s']
   ELSE ARRAY['search_path=pg_catalog, public, smarter_private'] END)
  THEN RAISE EXCEPTION 'LEGACY_LEARNING_PREIMAGE_CHANGED: %',item.signature; END IF;
 END LOOP;
 IF to_regclass('smarter_private.horse_adaptive_legacy_learning_purges') IS NOT NULL
 THEN RAISE EXCEPTION 'LEGACY_LEARNING_ALREADY_INSTALLED'; END IF;
END $guard$;

CREATE TABLE smarter_private.horse_adaptive_legacy_learning_purges(
 hand_id uuid PRIMARY KEY,
 hand_digest text NOT NULL UNIQUE CHECK(hand_digest~'^[a-f0-9]{64}$'),
 observed_through_ms bigint NOT NULL CHECK(observed_through_ms=1791158399999),
 authorized_reason text NOT NULL CHECK(authorized_reason='owner-one-time-legacy-test-learning-20261015'),
 purged_at timestamptz NOT NULL,
 observations_deleted integer NOT NULL CHECK(observations_deleted>=0),
 batches_compacted integer NOT NULL CHECK(batches_compacted>=0)
);
ALTER TABLE smarter_private.horse_adaptive_legacy_learning_purges OWNER TO postgres;
ALTER TABLE smarter_private.horse_adaptive_legacy_learning_purges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.horse_adaptive_legacy_learning_purges FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE smarter_private.horse_adaptive_legacy_learning_purges IS
 'Immutable one-time owner-authorized TEST-LEARNING erasure fence. No assertion of settlement, human classification, accounting completion or financial disposal. Fixed October 4 cohort only.';

CREATE FUNCTION smarter_private.legacy_learning_purge_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE context text;
BEGIN
 IF TG_OP='INSERT' THEN
  GET DIAGNOSTICS context=PG_CONTEXT;
  IF context !~ E'(^|\n)PL/pgSQL function (smarter_private\\.)?purge_legacy_horse_learning\\(uuid\\[\\]\\) line [0-9]+ at SQL statement'
  OR NEW.hand_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.hand_id::text,'UTF8')),'hex')
  OR NOT isfinite(NEW.purged_at) OR NEW.purged_at<transaction_timestamp() OR NEW.purged_at>clock_timestamp()
  THEN RAISE EXCEPTION 'LEGACY_LEARNING_PURGE_UNAUTHORIZED'; END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'LEGACY_LEARNING_PURGE_IMMUTABLE';
END $fn$;
ALTER FUNCTION smarter_private.legacy_learning_purge_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.legacy_learning_purge_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER legacy_learning_purge_immutable BEFORE INSERT OR UPDATE OR DELETE
 ON smarter_private.horse_adaptive_legacy_learning_purges FOR EACH ROW
 EXECUTE FUNCTION smarter_private.legacy_learning_purge_immutable();
CREATE TRIGGER legacy_learning_purge_no_truncate BEFORE TRUNCATE
 ON smarter_private.horse_adaptive_legacy_learning_purges FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.legacy_learning_purge_immutable();

-- The original insert trigger fences even a statement using a cached old writer.
DO $raw_guard$ DECLARE src text; anchor text:=E'BEGIN\n'; addition text;
BEGIN
 src:=pg_get_functiondef('smarter_private.horse_adaptive_raw_retirement_fence()'::regprocedure);
 addition:=E' IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_legacy_learning_purges WHERE hand_id=NEW.hand_id) THEN RAISE EXCEPTION ''ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT''; END IF;\n';
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'LEGACY_LEARNING_RAW_ANCHOR_CHANGED'; END IF;
 EXECUTE replace(src,anchor,anchor||addition);
END $raw_guard$;

-- New batches cannot resurrect a purged hand. Existing identical batch receipts
-- remain idempotent; their compacted payload is never replaced with caller data.
DO $append_guard$ DECLARE src text; anchor text:=E'  IF v_from_ms<now_ms-2592000000 OR v_through_ms>now_ms THEN'; addition text;
BEGIN
 src:=pg_get_functiondef('public.fn_append_horse_adaptive_observations(text)'::regprocedure);
 addition:=E'  IF EXISTS(SELECT 1 FROM jsonb_array_elements(b->7) v JOIN smarter_private.horse_adaptive_legacy_learning_purges p ON p.hand_digest=encode(sha256(convert_to((v.value#>>''{}'')::jsonb->>2,''UTF8'')),''hex'')) THEN RAISE EXCEPTION ''ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT''; END IF;\n';
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'LEGACY_LEARNING_APPEND_ANCHOR_CHANGED'; END IF;
 EXECUTE replace(src,anchor,addition||anchor);
END $append_guard$;
DO $queue_guard$ DECLARE src text; anchor text:=E'  -- Try, never wait behind'; addition text;
BEGIN
 src:=pg_get_functiondef('public.fn_queue_horse_adaptive_batch(text)'::regprocedure);
 addition:=E'  IF EXISTS(SELECT 1 FROM jsonb_array_elements(b->7) v JOIN smarter_private.horse_adaptive_legacy_learning_purges p ON p.hand_digest=encode(sha256(convert_to((v.value#>>''{}'')::jsonb->>2,''UTF8'')),''hex'')) THEN RETURN jsonb_build_object(''version'',1,''status'',''unavailable'',''reason'',''retention_compacted''); END IF;\n';
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'LEGACY_LEARNING_QUEUE_ANCHOR_CHANGED'; END IF;
 EXECUTE replace(src,anchor,addition||anchor);
END $queue_guard$;

CREATE OR REPLACE FUNCTION smarter_private.adaptive_retained_batch(p_batch text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
 SELECT jsonb_set(p_batch::jsonb,'{7}',COALESCE((SELECT jsonb_agg(v.value ORDER BY v.ordinality)
 FROM jsonb_array_elements(p_batch::jsonb->7) WITH ORDINALITY v
 WHERE NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates c
 WHERE c.hand_digest=encode(sha256(convert_to((v.value#>>'{}')::jsonb->>2,'UTF8')),'hex') AND c.retired_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_legacy_learning_purges p
 WHERE p.hand_digest=encode(sha256(convert_to((v.value#>>'{}')::jsonb->>2,'UTF8')),'hex'))),'[]'::jsonb))::text
$fn$;
DO $membership_guard$ DECLARE src text; anchor text; replacement text;
BEGIN
 src:=pg_get_functiondef('smarter_private.register_horse_adaptive_batch_membership(text)'::regprocedure);
 anchor:=') retired) END) THEN';
 replacement:=') retired) END) OR EXISTS(SELECT 1 FROM unnest(hands) h(hand) JOIN smarter_private.horse_adaptive_legacy_learning_purges p ON p.hand_digest=encode(sha256(convert_to(hand,''UTF8'')),''hex'')) THEN';
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'LEGACY_LEARNING_MEMBERSHIP_ANCHOR_CHANGED'; END IF;
 EXECUTE replace(src,anchor,replacement);
END $membership_guard$;

CREATE FUNCTION smarter_private.purge_legacy_horse_learning(p_hand_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private SET lock_timeout='2s' AS $fn$
DECLARE v_hand uuid; digest text; s smarter_private.hand_submissions; d smarter_private.hand_submission_disposals;
 b record; v jsonb; raw_count integer; raw_total integer:=0; purged uuid[]:='{}'; protected uuid[]:='{}'; already_purged uuid[]:='{}';
 keys text[]:='{}'; candidate_keys text[]; all_keys text[]; kept jsonb; batches integer:=0;
 deadline timestamptz:=clock_timestamp()+interval '2 seconds'; budget boolean:=false;
 exists_raw boolean; bad boolean; touched integer;
BEGIN
 IF p_hand_ids IS NULL OR cardinality(p_hand_ids)>250 OR array_position(p_hand_ids,NULL) IS NOT NULL
 THEN RAISE EXCEPTION 'LEGACY_LEARNING_INVALID_IDS'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN
  RETURN jsonb_build_object('status','unavailable','reason','maintenance_frozen'); END IF;
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RETURN jsonb_build_object('status','unavailable','reason','maintenance_busy'); END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN
  RETURN jsonb_build_object('status','unavailable','reason','maintenance_frozen'); END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0)) THEN
  RETURN jsonb_build_object('status','unavailable','reason','capacity_busy'); END IF;
 IF (SELECT horse_retention_days FROM public.hand_history_retention_policy LIMIT 1) IS DISTINCT FROM 8
 OR EXISTS(SELECT 1 FROM public.horse_adaptive_observation_batches WHERE NOT retention_membership_ready LIMIT 1)
 THEN RETURN jsonb_build_object('status','unavailable','reason','retention_not_ready'); END IF;
 FOR v_hand IN SELECT DISTINCT unnest(p_hand_ids) ORDER BY 1 LOOP
  IF clock_timestamp()>=deadline THEN budget:=true; EXIT; END IF;
  IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_legacy_learning_purges WHERE hand_id=v_hand) THEN already_purged:=already_purged||v_hand; CONTINUE; END IF;
  digest:=encode(sha256(convert_to(v_hand::text,'UTF8')),'hex');
  SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=v_hand;
  SELECT * INTO d FROM smarter_private.hand_submission_disposals WHERE submission_id=v_hand;
  IF EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id=v_hand)
  OR EXISTS(SELECT 1 FROM public.hand_history WHERE hand_history.id=v_hand)
  OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE hand_id=v_hand)
  OR s.request#>>'{p_hand_row,has_human}'='true'
  OR s.request#>>'{p_hand_row,reported}'='true'
  OR d.expected->>'original_has_human'='true'
  OR EXISTS(SELECT 1 FROM public.cash_hand_provenance_receipts p WHERE p.hand_id=v_hand
   AND (p.accepted_request#>>'{hand_row,has_human}'='true'
    OR p.accepted_request#>>'{hand_row,reported}'='true'))
  OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE hand_id=v_hand)
  OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates WHERE hand_id=v_hand AND state='pending')
  THEN protected:=protected||v_hand; CONTINUE; END IF;
  IF s.table_id IS NOT NULL AND (
    EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number=s.hand_number)
    OR smarter_private.f06_hand_cards_unresolved(s.table_id,s.hand_number)
    OR smarter_private.f06_movement_boundary_retained(s.table_id,s.hand_number)
    OR EXISTS(SELECT 1 FROM public.bbj_payouts WHERE table_id=s.table_id AND hand_number=s.hand_number))
  THEN protected:=protected||v_hand; CONTINUE; END IF;
  IF d.table_id IS NOT NULL AND (
    EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=d.table_id AND hand_number=d.hand_number)
    OR smarter_private.f06_hand_cards_unresolved(d.table_id,d.hand_number)
    OR smarter_private.f06_movement_boundary_retained(d.table_id,d.hand_number)
    OR EXISTS(SELECT 1 FROM public.bbj_payouts WHERE table_id=d.table_id AND hand_number=d.hand_number))
  THEN protected:=protected||v_hand; CONTINUE; END IF;
  -- The unfinished queue is capped by its original admission at 256 items.
  IF EXISTS(SELECT 1 FROM public.horse_adaptive_journal_work w WHERE w.state<>'completed'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(w.payload::jsonb->7) v WHERE (v.value#>>'{}')::jsonb->>2=v_hand::text))
  THEN protected:=protected||v_hand; CONTINUE; END IF;
  candidate_keys:=ARRAY(SELECT batch_key FROM smarter_private.horse_adaptive_batch_hand_membership WHERE hand_digest=digest ORDER BY batch_key);
  all_keys:=ARRAY(SELECT DISTINCT unnest(keys||candidate_keys) ORDER BY 1);
  IF (SELECT COALESCE(sum(octet_length(canonical_payload)),0) FROM public.horse_adaptive_observation_batches WHERE batch_key=ANY(all_keys))>16777216
  THEN budget:=true; EXIT; END IF;
  PERFORM 1 FROM public.horse_adaptive_observation_journal j
   WHERE j.observation_id>=v_hand::text||':0' AND j.observation_id<=v_hand::text||':9999' AND j.hand_id=v_hand FOR UPDATE;
  SELECT EXISTS(SELECT 1 FROM public.horse_adaptive_observation_journal j
   WHERE j.observation_id>=v_hand::text||':0' AND j.observation_id<=v_hand::text||':9999' AND j.hand_id=v_hand),
   EXISTS(SELECT 1 FROM public.horse_adaptive_observation_journal j
   WHERE j.observation_id>=v_hand::text||':0' AND j.observation_id<=v_hand::text||':9999' AND j.hand_id=v_hand
   AND (j.observed_at_ms>1791158399999 OR j.payload::jsonb->>2 IS DISTINCT FROM v_hand::text
    OR j.payload::jsonb->>5 IS DISTINCT FROM j.observed_at_ms::text)) INTO exists_raw,bad;
  IF bad THEN protected:=protected||v_hand; CONTINUE; END IF;
  touched:=0;
  FOR b IN SELECT batch_key,canonical_payload FROM public.horse_adaptive_observation_batches
   WHERE batch_key=ANY(candidate_keys) ORDER BY batch_key FOR UPDATE LOOP
   IF EXISTS(SELECT 1 FROM public.horse_adaptive_journal_work WHERE batch_key=b.batch_key AND state<>'completed') THEN bad:=true; EXIT; END IF;
   FOR v IN SELECT value FROM jsonb_array_elements(b.canonical_payload::jsonb->7) LOOP
    IF (v#>>'{}')::jsonb->>2=v_hand::text THEN
     exists_raw:=true; touched:=touched+1;
     IF jsonb_typeof((v#>>'{}')::jsonb->5) IS DISTINCT FROM 'number'
      OR ((v#>>'{}')::jsonb->>5)!~'^[0-9]{1,16}$'
      OR ((v#>>'{}')::jsonb->>5)::bigint>1791158399999 THEN bad:=true; EXIT; END IF;
    END IF;
   END LOOP;
   IF bad THEN EXIT; END IF;
  END LOOP;
  IF bad OR NOT exists_raw THEN protected:=protected||v_hand; CONTINUE; END IF;
  DELETE FROM public.horse_adaptive_observation_journal j
   WHERE j.observation_id>=v_hand::text||':0' AND j.observation_id<=v_hand::text||':9999' AND j.hand_id=v_hand;
  GET DIAGNOSTICS raw_count=ROW_COUNT;
  INSERT INTO smarter_private.horse_adaptive_legacy_learning_purges VALUES
   (v_hand,digest,1791158399999,'owner-one-time-legacy-test-learning-20261015',clock_timestamp(),raw_count,(SELECT count(*)::integer FROM public.horse_adaptive_observation_batches WHERE batch_key=ANY(candidate_keys) AND canonical_payload IS NOT NULL));
  raw_total:=raw_total+raw_count; purged:=purged||v_hand; keys:=all_keys;
 END LOOP;
 -- Exactly one rewrite of each touched batch in this transaction. Original
 -- receipt, count and digest remain unchanged; only retained raw tuple strings
 -- are removed. Exact original payload recovery already refuses compacted data.
 FOR b IN SELECT batch_key,canonical_payload FROM public.horse_adaptive_observation_batches
  WHERE batch_key=ANY(keys) ORDER BY batch_key FOR UPDATE LOOP
  IF b.canonical_payload IS NOT NULL THEN
   kept:=jsonb_set(b.canonical_payload::jsonb,'{7}',COALESCE((SELECT jsonb_agg(value ORDER BY ordinality)
    FROM jsonb_array_elements(b.canonical_payload::jsonb->7) WITH ORDINALITY
    WHERE NOT COALESCE((value#>>'{}')::jsonb->>2=ANY(purged::text[]),false)),'[]'::jsonb));
   UPDATE public.horse_adaptive_observation_batches SET canonical_payload=kept::text,retention_compacted=true WHERE batch_key=b.batch_key;
   batches:=batches+1;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('status','purged','handsPurged',cardinality(purged),'observationsDeleted',raw_total,
  'batchesCompacted',batches,'purgedHands',purged,'protectedHands',protected,'alreadyPurgedHands',already_purged,'budgetReached',budget);
END $fn$;
ALTER FUNCTION smarter_private.purge_legacy_horse_learning(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.purge_legacy_horse_learning(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;

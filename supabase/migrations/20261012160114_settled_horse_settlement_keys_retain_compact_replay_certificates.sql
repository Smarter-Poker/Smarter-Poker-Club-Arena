-- Erase only the settlement key's duplicated request. Immutable original cash
-- provenance remains the response source; human/mixed/unknown evidence stays full.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $absent$ BEGIN
 IF to_regclass('smarter_private.horse_settlement_key_certificates') IS NOT NULL THEN
  RAISE EXCEPTION 'HORSE_SETTLEMENT_KEY_RETENTION_ALREADY_INSTALLED' USING ERRCODE='55000'; END IF;
END $absent$;
CREATE TABLE smarter_private.horse_settlement_key_certificates (
 table_id uuid NOT NULL, stack_hand_id uuid NOT NULL, hand_number bigint NOT NULL,
 history_hand_id uuid NOT NULL, manifest_id uuid NOT NULL,
 original_result_sha256 text NOT NULL CHECK(original_result_sha256 ~ '^[0-9a-f]{64}$'),
 original_request_sha256 text NOT NULL CHECK(original_request_sha256 ~ '^[0-9a-f]{64}$'),
 compact_result jsonb NOT NULL CHECK(NOT compact_result ? 'request'),
 accounting_evidence_sha256 text NOT NULL CHECK(accounting_evidence_sha256 ~ '^[0-9a-f]{64}$'),
 settled_at timestamptz NOT NULL CHECK(isfinite(settled_at)),
 compacted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(table_id,stack_hand_id), UNIQUE(table_id,hand_number)
);
ALTER TABLE smarter_private.horse_settlement_key_certificates OWNER TO postgres;
REVOKE ALL ON smarter_private.horse_settlement_key_certificates FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.horse_settlement_certificate_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'HORSE_SETTLEMENT_CERTIFICATE_IMMUTABLE' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION smarter_private.horse_settlement_certificate_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_settlement_certificate_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.horse_settlement_key_certificates FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_settlement_certificate_immutable();
CREATE TRIGGER horse_settlement_certificate_no_truncate BEFORE TRUNCATE
 ON smarter_private.horse_settlement_key_certificates FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.horse_settlement_certificate_immutable();

-- A compacted key is a permanent replay fence. Preserve its identity/status
-- against later generic key edits/deletion; permit only the original certified
-- full-result to compact-result transition, with every other column identical.
CREATE FUNCTION smarter_private.horse_settlement_key_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE cert smarter_private.horse_settlement_key_certificates;
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM smarter_private.horse_settlement_key_certificates) THEN
   RAISE EXCEPTION 'HORSE_SETTLEMENT_KEY_PERMANENT' USING ERRCODE='55000'; END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO cert FROM smarter_private.horse_settlement_key_certificates WHERE table_id=OLD.table_id AND stack_hand_id=OLD.hand_id;
 IF NOT FOUND THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'result') IS NOT DISTINCT FROM (to_jsonb(OLD)-'result')
 AND NEW.result IS NOT DISTINCT FROM cert.compact_result
 AND encode(extensions.digest(convert_to(OLD.result::text,'UTF8'),'sha256'),'hex')=cert.original_result_sha256 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'HORSE_SETTLEMENT_KEY_PERMANENT' USING ERRCODE='55000';
END $$;
ALTER FUNCTION smarter_private.horse_settlement_key_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.horse_settlement_key_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_settlement_key_guard BEFORE UPDATE OR DELETE ON public.settlement_idempotency_keys
 FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_settlement_key_guard();
CREATE TRIGGER horse_settlement_keys_no_truncate BEFORE TRUNCATE ON public.settlement_idempotency_keys
 FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.horse_settlement_key_guard();

-- Preserve the exact pre-compaction replay response and accounting comparison.
-- Missing/conflicting retained originals fail closed, never return an empty success.
CREATE FUNCTION smarter_private.horse_settlement_original_result(p_table uuid,p_stack_hand uuid,p_result jsonb)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE cert smarter_private.horse_settlement_key_certificates; original jsonb;
BEGIN
 SELECT * INTO cert FROM smarter_private.horse_settlement_key_certificates
 WHERE table_id=p_table AND stack_hand_id=p_stack_hand;
 IF NOT FOUND THEN RETURN p_result; END IF;
 SELECT p.atomic_receipt->'stack_result' INTO original FROM public.cash_hand_provenance_receipts p
 WHERE p.table_id=cert.table_id AND p.hand_number=cert.hand_number AND p.hand_id=cert.history_hand_id
 AND p.manifest_id=cert.manifest_id;
 IF p_result IS DISTINCT FROM cert.compact_result OR original IS NULL
 OR encode(extensions.digest(convert_to(original::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM cert.original_result_sha256
 OR encode(extensions.digest(convert_to((original->'request')::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM cert.original_request_sha256
 OR original-'request' IS DISTINCT FROM cert.compact_result THEN
  RAISE EXCEPTION 'HORSE_SETTLEMENT_COMPACT_ORIGINAL_CONFLICT' USING ERRCODE='55000'; END IF;
 RETURN original;
END $$;
ALTER FUNCTION smarter_private.horse_settlement_original_result(uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.horse_settlement_original_result(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.compact_horse_settlement_keys(p_hands uuid[])
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.hand_history; a public.hand_atomic_commits; p public.cash_hand_provenance_receipts;
 m public.cash_hand_participant_manifests; k public.settlement_idempotency_keys;
 evidence jsonb; stack_hand uuid; count_compacted integer:=0;
BEGIN
 IF p_hands IS NULL OR cardinality(p_hands)>250 THEN
  RAISE EXCEPTION 'HORSE_SETTLEMENT_COMPACTION_BATCH_INVALID' USING ERRCODE='22023'; END IF;
 FOR h IN SELECT * FROM public.hand_history WHERE id=ANY(p_hands) ORDER BY table_id,hand_number FOR UPDATE LOOP
  -- Cash only. Exactly eight elapsed days for both original history and final
  -- obligations; original manifest classification, never current profiles.
  IF h.table_id IS NULL OR h.tournament_id IS NOT NULL OR h.has_human IS DISTINCT FROM FALSE OR h.reported IS TRUE
  OR h.created_at IS NULL OR NOT isfinite(h.created_at) OR h.created_at>=now()-interval '8 days'
  OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=h.id)
  OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=h.table_id AND b.hand_number=h.hand_number)
  OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates t WHERE t.hand_id=h.id AND t.state='pending')
  OR smarter_private.f06_hand_cards_unresolved(h.table_id,h.hand_number::bigint)
  OR smarter_private.f06_movement_boundary_retained(h.table_id,h.hand_number::bigint) THEN CONTINUE; END IF;
  SELECT * INTO a FROM public.hand_atomic_commits WHERE hand_id=h.id AND table_id=h.table_id AND hand_number=h.hand_number FOR UPDATE;
  IF NOT FOUND OR a.post_commit_completed_at IS NULL OR NOT isfinite(a.post_commit_completed_at) OR a.post_commit_completed_at>=now()-interval '8 days'
  OR a.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR a.stack_result->>'success' IS DISTINCT FROM 'true'
  OR a.stack_result->>'conservation_checked' IS DISTINCT FROM 'true'
  OR jsonb_typeof(a.stack_result->'request') IS DISTINCT FROM 'object'
  OR NOT pg_input_is_valid(a.stack_result->>'hand_id','uuid') THEN CONTINUE; END IF;
  stack_hand:=(a.stack_result->>'hand_id')::uuid;
  IF EXISTS(SELECT 1 FROM smarter_private.horse_settlement_key_certificates c WHERE c.table_id=h.table_id AND c.stack_hand_id=stack_hand) THEN CONTINUE; END IF;
  SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=h.table_id AND hand_number=h.hand_number;
  IF NOT FOUND OR p.hand_id IS DISTINCT FROM h.id OR p.payload_hash IS DISTINCT FROM a.payload_hash
  OR p.atomic_receipt->'stack_result' IS DISTINCT FROM a.stack_result
  OR p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS NOT TRUE OR p.all_players_included IS NOT TRUE
  OR p.issues IS DISTINCT FROM '[]'::jsonb THEN CONTINUE; END IF;
  SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id AND table_id=h.table_id AND hand_number=h.hand_number;
  IF NOT FOUND OR m.funding_provenance_complete IS NOT TRUE OR m.issues IS DISTINCT FROM '[]'::jsonb
  OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array' OR jsonb_array_length(m.participants) NOT BETWEEN 2 AND 10
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.participants) x WHERE x->'is_horse' IS DISTINCT FROM 'true'::jsonb)
  OR jsonb_typeof(h.players) IS DISTINCT FROM 'array'
  OR jsonb_array_length(h.players) IS DISTINCT FROM jsonb_array_length(m.participants)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(h.players) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.participants) y WHERE y->>'user_id'=x->>'userId'))
  THEN CONTINUE; END IF;
  SELECT * INTO k FROM public.settlement_idempotency_keys WHERE table_id=h.table_id AND hand_id=stack_hand FOR UPDATE;
  IF NOT FOUND OR k.status IS DISTINCT FROM 'succeeded' OR k.completed_at IS NULL OR k.error IS NOT NULL
  OR k.result IS DISTINCT FROM a.stack_result OR NOT k.result ? 'request' THEN CONTINUE; END IF;
  evidence:=public.fn_pnl_cash_hand_evidence(h.table_id,h.hand_number::bigint);
  IF evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
  OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb THEN CONTINUE; END IF;
  INSERT INTO smarter_private.horse_settlement_key_certificates(table_id,stack_hand_id,hand_number,history_hand_id,manifest_id,
   original_result_sha256,original_request_sha256,compact_result,accounting_evidence_sha256,settled_at)
  VALUES(h.table_id,stack_hand,h.hand_number,h.id,m.id,
   encode(extensions.digest(convert_to(k.result::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to((k.result->'request')::text,'UTF8'),'sha256'),'hex'),k.result-'request',
   encode(extensions.digest(convert_to(evidence::text,'UTF8'),'sha256'),'hex'),a.post_commit_completed_at);
  UPDATE public.settlement_idempotency_keys SET result=result-'request' WHERE table_id=h.table_id AND hand_id=stack_hand;
  count_compacted:=count_compacted+1;
 END LOOP;
 RETURN count_compacted;
END $$;
ALTER FUNCTION smarter_private.compact_horse_settlement_keys(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.compact_horse_settlement_keys(uuid[]) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE target oid:='public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF md5(source) IS DISTINCT FROM '7b7b090aa1d6eab13d677fcc5e821e77' THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_SOURCE_CHANGED: %',target::regprocedure USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}' AND prosecdef=true AND proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_PREIMAGE_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'    IF v_prior.status = ''succeeded'' THEN
','')))/length('    IF v_prior.status = ''succeeded'' THEN
')<>1 THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'    IF v_prior.status = ''succeeded'' THEN
','    IF EXISTS(SELECT 1 FROM smarter_private.horse_settlement_key_certificates c WHERE c.table_id=p_table_id AND c.stack_hand_id=v_hand) AND v_prior.status IS DISTINCT FROM ''succeeded'' THEN
      RAISE EXCEPTION ''HORSE_SETTLEMENT_COMPACT_STATUS_CONFLICT'' USING ERRCODE=''55000'';
    END IF;
    IF v_prior.status = ''succeeded'' THEN
      v_prior.result:=smarter_private.horse_settlement_original_result(p_table_id,v_hand,v_prior.result);
');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;

DO $patch$
DECLARE target oid:='public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF md5(source) IS DISTINCT FROM 'b8b7db281d39408871751bdd1c181615' THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_SOURCE_CHANGED: %',target::regprocedure USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef=true AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_PREIMAGE_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'k.result IS DISTINCT FROM a.stack_result','')))/length('k.result IS DISTINCT FROM a.stack_result')<>1 THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'k.result IS DISTINCT FROM a.stack_result','smarter_private.horse_settlement_original_result(k.table_id,k.hand_id,k.result) IS DISTINCT FROM a.stack_result');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;

DO $patch$
DECLARE target oid:='public.sp_prune_hand_history(integer)'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF md5(source) IS DISTINCT FROM 'a8fe6ac66ed558c21e8e2840468a8bfc' THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_SOURCE_CHANGED: %',target::regprocedure USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}' AND prosecdef=false AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_PREIMAGE_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);','')))/length('      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);')<>1 THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);','      PERFORM smarter_private.compact_horse_settlement_keys(v_doomed);
      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HORSE_SETTLEMENT_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;
COMMIT;

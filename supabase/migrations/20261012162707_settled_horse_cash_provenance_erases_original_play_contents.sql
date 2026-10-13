-- Original settled horse cash play contents expire through existing retention.
-- Keep exact monetary stacks/claims/manifests and immutable financial certificates.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preimage$ BEGIN
 IF to_regclass('smarter_private.horse_cash_payload_certificates') IS NOT NULL THEN
  RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_ALREADY_INSTALLED' USING ERRCODE='55000'; END IF;
 IF md5(pg_get_functiondef('smarter_private.horse_settlement_original_result(uuid,uuid,jsonb)'::regprocedure)) IS DISTINCT FROM '9b34ace9a694e65a7bd0b3917c4a70fd' THEN
  RAISE EXCEPTION 'HORSE_CASH_KEY_PREDECESSOR_CHANGED' USING ERRCODE='55000'; END IF;
END $preimage$;
-- Indexed UUID lookup keeps the existing capped per-hand batch bounded.
CREATE UNIQUE INDEX horse_settlement_key_history_idx ON smarter_private.horse_settlement_key_certificates(history_hand_id);
CREATE TABLE smarter_private.horse_cash_payload_certificates (
 table_id uuid NOT NULL, hand_number bigint NOT NULL, hand_id uuid NOT NULL UNIQUE,
 manifest_id uuid NOT NULL, original_request_sha256 text NOT NULL,
 original_atomic_sha256 text NOT NULL, compact_request_sha256 text NOT NULL,
 compact_atomic_sha256 text NOT NULL, immutable_financial_sha256 text NOT NULL,
 live_atomic_sha256 text NOT NULL, accounting_evidence_sha256 text NOT NULL,
 accepted_at timestamptz NOT NULL, settled_at timestamptz NOT NULL,
 compacted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(table_id,hand_number),
 CHECK(isfinite(accepted_at) AND isfinite(settled_at)),
 CHECK(original_request_sha256 ~ '^[0-9a-f]{64}$' AND original_atomic_sha256 ~ '^[0-9a-f]{64}$'
 AND compact_request_sha256 ~ '^[0-9a-f]{64}$' AND compact_atomic_sha256 ~ '^[0-9a-f]{64}$'
 AND immutable_financial_sha256 ~ '^[0-9a-f]{64}$' AND live_atomic_sha256 ~ '^[0-9a-f]{64}$'
 AND accounting_evidence_sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE smarter_private.horse_cash_payload_certificates OWNER TO postgres;
REVOKE ALL ON smarter_private.horse_cash_payload_certificates FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_cash_payload_certificate_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.horse_cash_payload_certificates FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_settlement_certificate_immutable();
CREATE TRIGGER horse_cash_payload_certificate_no_truncate BEFORE TRUNCATE
 ON smarter_private.horse_cash_payload_certificates FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.horse_settlement_certificate_immutable();

CREATE FUNCTION smarter_private.horse_cash_compact_request(p_request jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_set(p_request,'{hand_row}',coalesce((SELECT jsonb_object_agg(key,value)
 FROM jsonb_each(p_request->'hand_row') WHERE key=ANY(ARRAY['has_human','tournament_id','pot_size','big_blind','rake_amount','bbj_amount','_accepted_post_commit_facts'])),'{}'::jsonb))
 #- '{hand_row,_accepted_post_commit_facts,stats_facts}'
$$;
REVOKE ALL ON FUNCTION smarter_private.horse_cash_compact_request(jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.horse_cash_compact_atomic(p_atomic jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT p_atomic #- '{post_commit_payload,accepted_hand_facts,stats_facts}'
$$;
REVOKE ALL ON FUNCTION smarter_private.horse_cash_compact_atomic(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- The original hash remains evidence of accepted bytes. A certificate binds
-- the exact smaller representation; it cannot certify changed financial data.
CREATE FUNCTION smarter_private.horse_cash_retained_request_matches(p_table uuid,p_number bigint,p_hash text,p_request jsonb)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c smarter_private.horse_cash_payload_certificates; p public.cash_hand_provenance_receipts;
BEGIN
 SELECT * INTO c FROM smarter_private.horse_cash_payload_certificates WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND THEN RETURN encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex') IS NOT DISTINCT FROM p_hash; END IF;
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
 RETURN FOUND AND p.hand_id=c.hand_id AND p.manifest_id=c.manifest_id AND p.accepted_at=c.accepted_at
 AND p_hash=c.original_request_sha256 AND p.payload_hash=p_hash
 AND p.accepted_request IS NOT DISTINCT FROM p_request
 AND encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex')=c.compact_request_sha256
 AND encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex')=c.compact_atomic_sha256
 AND encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex')=c.immutable_financial_sha256;
END $$;
ALTER FUNCTION smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.horse_cash_retained_atomic_matches(p_table uuid,p_number bigint,p_original jsonb,p_live jsonb,p_request jsonb)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c smarter_private.horse_cash_payload_certificates;
BEGIN
 SELECT * INTO c FROM smarter_private.horse_cash_payload_certificates WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND THEN RETURN public.fn_cash_atomic_original_matches(p_original,p_live,p_request); END IF;
 RETURN smarter_private.horse_cash_retained_request_matches(p_table,p_number,c.original_request_sha256,p_request)
 AND encode(extensions.digest(convert_to(p_original::text,'UTF8'),'sha256'),'hex')=c.compact_atomic_sha256
 AND encode(extensions.digest(convert_to(p_live::text,'UTF8'),'sha256'),'hex')=c.live_atomic_sha256;
END $$;
ALTER FUNCTION smarter_private.horse_cash_retained_atomic_matches(uuid,bigint,jsonb,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.horse_cash_retained_atomic_matches(uuid,bigint,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.compact_horse_cash_play_contents(p_hands uuid[])
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k smarter_private.horse_settlement_key_certificates; p public.cash_hand_provenance_receipts;
 m public.cash_hand_participant_manifests; a public.hand_atomic_commits; h public.hand_history;
 request_after jsonb; atomic_after jsonb; evidence jsonb; n integer:=0;
BEGIN
 IF p_hands IS NULL OR cardinality(p_hands)>250 THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_BATCH_INVALID' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT * FROM smarter_private.horse_settlement_key_certificates WHERE history_hand_id=ANY(p_hands) ORDER BY table_id,hand_number LOOP
  IF k.settled_at>=now()-interval '8 days' OR NOT isfinite(k.settled_at)
  OR EXISTS(SELECT 1 FROM smarter_private.horse_cash_payload_certificates c WHERE c.table_id=k.table_id AND c.hand_number=k.hand_number) THEN CONTINUE; END IF;
  SELECT * INTO h FROM public.hand_history WHERE id=k.history_hand_id AND table_id=k.table_id AND hand_number=k.hand_number FOR UPDATE;
  IF NOT FOUND OR h.has_human IS DISTINCT FROM FALSE OR h.reported IS TRUE OR h.tournament_id IS NOT NULL
  OR h.created_at IS NULL OR NOT isfinite(h.created_at) OR h.created_at>=now()-interval '8 days'
  OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=h.id)
  OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=h.table_id AND b.hand_number=h.hand_number)
  OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates t WHERE t.hand_id=h.id AND t.state='pending') THEN CONTINUE; END IF;
  SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=k.table_id AND hand_number=k.hand_number AND hand_id=k.history_hand_id FOR UPDATE;
  -- This transition belongs before original history deletion. Legacy certificates
  -- without the live completed boundary do not invent later qualification.
  IF NOT FOUND OR a.post_commit_completed_at IS DISTINCT FROM k.settled_at OR a.post_commit_result->>'ok' IS DISTINCT FROM 'true'
  OR smarter_private.f06_hand_cards_unresolved(k.table_id,k.hand_number)
  OR smarter_private.f06_movement_boundary_retained(k.table_id,k.hand_number) THEN CONTINUE; END IF;
  SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=k.table_id AND hand_number=k.hand_number FOR UPDATE;
  IF NOT FOUND OR p.hand_id IS DISTINCT FROM k.history_hand_id OR p.manifest_id IS DISTINCT FROM k.manifest_id
  OR p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS NOT TRUE OR p.all_players_included IS NOT TRUE
  OR p.accepted_request#>'{hand_row,has_human}' IS DISTINCT FROM 'false'::jsonb
  OR p.accepted_request#>'{hand_row,tournament_id}' IS DISTINCT FROM 'null'::jsonb
  OR encode(extensions.digest(convert_to(p.accepted_request::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p.payload_hash
  OR p.atomic_receipt->'stack_result' IS DISTINCT FROM a.stack_result THEN CONTINUE; END IF;
  SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id AND table_id=k.table_id AND hand_number=k.hand_number;
  IF NOT FOUND OR m.funding_provenance_complete IS NOT TRUE OR m.issues IS DISTINCT FROM '[]'::jsonb
  OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array' OR jsonb_array_length(m.participants) NOT BETWEEN 2 AND 10
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.participants) x WHERE x->'is_horse' IS DISTINCT FROM 'true'::jsonb) THEN CONTINUE; END IF;
  -- Original blocked accounting/link evidence stays whole for its authoritative
  -- repair consumer. Do not convert a fresh direct reader into a historical seal.
  IF NOT EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes o WHERE o.table_id=k.table_id AND o.hand_number=k.hand_number
   AND o.hand_id=p.hand_id AND o.payload_hash=p.payload_hash AND o.game_scope=p.game_scope
   AND o.evidence->>'status'='ready' AND o.evidence->'basis_certified'='true'::jsonb AND o.evidence->'all_players_included'='true'::jsonb)
  THEN CONTINUE; END IF;
  evidence:=public.fn_pnl_cash_hand_evidence(k.table_id,k.hand_number);
  IF evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
  OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb
  OR encode(extensions.digest(convert_to(evidence::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM k.accounting_evidence_sha256 THEN CONTINUE; END IF;
  request_after:=smarter_private.horse_cash_compact_request(p.accepted_request);
  atomic_after:=smarter_private.horse_cash_compact_atomic(p.atomic_receipt);
  IF request_after IS NOT DISTINCT FROM p.accepted_request AND atomic_after IS NOT DISTINCT FROM p.atomic_receipt THEN CONTINUE; END IF;
  INSERT INTO smarter_private.horse_cash_payload_certificates(table_id,hand_number,hand_id,manifest_id,original_request_sha256,original_atomic_sha256,
   compact_request_sha256,compact_atomic_sha256,immutable_financial_sha256,live_atomic_sha256,accounting_evidence_sha256,accepted_at,settled_at)
  VALUES(p.table_id,p.hand_number,p.hand_id,p.manifest_id,p.payload_hash,
   encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(request_after::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(atomic_after::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(to_jsonb(a)::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(evidence::text,'UTF8'),'sha256'),'hex'),p.accepted_at,k.settled_at);
  UPDATE public.cash_hand_provenance_receipts SET accepted_request=request_after,atomic_receipt=atomic_after WHERE table_id=p.table_id AND hand_number=p.hand_number;
  n:=n+1;
 END LOOP;
 RETURN n;
END $$;
ALTER FUNCTION smarter_private.compact_horse_cash_play_contents(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.compact_horse_cash_play_contents(uuid[]) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE target oid:='public.fn_cash_provenance_immutable()'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}' AND prosecdef=false AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_PREIMAGE_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF md5(source) IS DISTINCT FROM '77e5fcec76b8682e7648573fd60e0a71' THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_SOURCE_CHANGED: %',target::regprocedure USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'BEGIN ','')))/length('BEGIN ')<>1 THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'BEGIN ','BEGIN
 IF TG_OP=''UPDATE'' AND TG_TABLE_SCHEMA=''public'' AND TG_TABLE_NAME=''cash_hand_provenance_receipts'' THEN
  IF (to_jsonb(NEW)-ARRAY[''accepted_request'',''atomic_receipt'']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY[''accepted_request'',''atomic_receipt''])
  AND NEW.accepted_request IS NOT DISTINCT FROM smarter_private.horse_cash_compact_request(OLD.accepted_request)
  AND NEW.atomic_receipt IS NOT DISTINCT FROM smarter_private.horse_cash_compact_atomic(OLD.atomic_receipt)
  AND EXISTS(SELECT 1 FROM smarter_private.horse_cash_payload_certificates c WHERE c.table_id=OLD.table_id AND c.hand_number=OLD.hand_number
   AND c.hand_id=OLD.hand_id AND c.manifest_id=OLD.manifest_id AND c.accepted_at=OLD.accepted_at
   AND c.original_request_sha256=OLD.payload_hash
   AND c.original_request_sha256=encode(extensions.digest(convert_to(OLD.accepted_request::text,''UTF8''),''sha256''),''hex'')
   AND c.original_atomic_sha256=encode(extensions.digest(convert_to(OLD.atomic_receipt::text,''UTF8''),''sha256''),''hex'')
   AND c.compact_request_sha256=encode(extensions.digest(convert_to(NEW.accepted_request::text,''UTF8''),''sha256''),''hex'')
   AND c.compact_atomic_sha256=encode(extensions.digest(convert_to(NEW.atomic_receipt::text,''UTF8''),''sha256''),''hex'')
   AND c.immutable_financial_sha256=encode(extensions.digest(convert_to((to_jsonb(OLD)-ARRAY[''accepted_request'',''atomic_receipt'',''accepted_at''])::text,''UTF8''),''sha256''),''hex''))
  THEN RETURN NEW; END IF;
 END IF;
');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;

DO $patch$
DECLARE target oid:='public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef=true AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_PREIMAGE_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF md5(source) IS DISTINCT FROM '0da5659d7dd0ffec0c8c86683f248725' THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_SOURCE_CHANGED: %',target::regprocedure USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'public.fn_cash_atomic_original_matches(p.atomic_receipt,v_live_atomic,p.accepted_request)','')))/length('public.fn_cash_atomic_original_matches(p.atomic_receipt,v_live_atomic,p.accepted_request)')<>1 THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'public.fn_cash_atomic_original_matches(p.atomic_receipt,v_live_atomic,p.accepted_request)','smarter_private.horse_cash_retained_atomic_matches(p_table_id,p_hand_number,p.atomic_receipt,v_live_atomic,p.accepted_request)');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;

DO $patch$
DECLARE target oid:='public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef=true AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_PREIMAGE_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'encode(extensions.digest(convert_to(p.accepted_request::text,''UTF8''),''sha256''),''hex'') IS DISTINCT FROM a.payload_hash','')))/length('encode(extensions.digest(convert_to(p.accepted_request::text,''UTF8''),''sha256''),''hex'') IS DISTINCT FROM a.payload_hash')<>1 THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'encode(extensions.digest(convert_to(p.accepted_request::text,''UTF8''),''sha256''),''hex'') IS DISTINCT FROM a.payload_hash','NOT smarter_private.horse_cash_retained_request_matches(p_table_id,p_hand_number,a.payload_hash,p.accepted_request)');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;

DO $patch$
DECLARE target oid:='public.sp_prune_hand_history(integer)'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}' AND prosecdef=false AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_PREIMAGE_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF md5(source) IS DISTINCT FROM 'e8a0078c0ef9b8f17adc589bba25d401' THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_SOURCE_CHANGED: %',target::regprocedure USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'      PERFORM smarter_private.compact_horse_settlement_keys(v_doomed);','')))/length('      PERFORM smarter_private.compact_horse_settlement_keys(v_doomed);')<>1 THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'      PERFORM smarter_private.compact_horse_settlement_keys(v_doomed);','      PERFORM smarter_private.compact_horse_settlement_keys(v_doomed);
      PERFORM smarter_private.compact_horse_cash_play_contents(v_doomed);');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;
COMMIT;

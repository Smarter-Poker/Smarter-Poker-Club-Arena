-- Align cash retention with the actual producer phases. The cash snapshot
-- predates accepted post-commit stats; an absent stats path is not a conflict.
-- Keep every original boundary for uncertified accounting. Later compaction
-- requires independent immutable original completion/classification evidence.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $pins$ BEGIN
 IF to_regclass('smarter_private.horse_cash_postprune_certificates') IS NOT NULL THEN
  RAISE EXCEPTION 'HORSE_CASH_PHASE_RETENTION_ALREADY_INSTALLED'; END IF;
 IF md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)) IS DISTINCT FROM '39818b69df17f2fa9ac4e64abd4d156c' THEN RAISE EXCEPTION 'HORSE_CASH_PHASE_SOURCE_CHANGED: sp_prune_hand_history(integer)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.compact_horse_settlement_keys(uuid[])'::regprocedure)) IS DISTINCT FROM 'b05849141a6bb3931dcd2941401f5617' THEN RAISE EXCEPTION 'HORSE_CASH_PHASE_SOURCE_CHANGED: smarter_private.compact_horse_settlement_keys(uuid[])'; END IF;
 IF md5(pg_get_functiondef('smarter_private.compact_horse_cash_play_contents(uuid[])'::regprocedure)) IS DISTINCT FROM '3259a13f3a1357f46930b3f32ead1450' THEN RAISE EXCEPTION 'HORSE_CASH_PHASE_SOURCE_CHANGED: smarter_private.compact_horse_cash_play_contents(uuid[])'; END IF;
 IF md5(pg_get_functiondef('smarter_private.horse_snapshot_disposable(uuid)'::regprocedure)) IS DISTINCT FROM 'f72e315a044813cf080e105f2f557a6b' THEN RAISE EXCEPTION 'HORSE_CASH_PHASE_SOURCE_CHANGED: smarter_private.horse_snapshot_disposable(uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_cash_provenance_immutable()'::regprocedure)) IS DISTINCT FROM '6d1d8db10a6cc3597e1caf2e5a294701' THEN RAISE EXCEPTION 'HORSE_CASH_PHASE_SOURCE_CHANGED: fn_cash_provenance_immutable()'; END IF;
 IF md5(pg_get_functiondef('smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure)) IS DISTINCT FROM '33412200aafaa81844d75c54bbf9ed64' THEN RAISE EXCEPTION 'HORSE_CASH_PHASE_SOURCE_CHANGED: smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.horse_cash_retained_atomic_matches(uuid,bigint,jsonb,jsonb,jsonb)'::regprocedure)) IS DISTINCT FROM 'cf2723ba7662e304df165b66db196196' THEN RAISE EXCEPTION 'HORSE_CASH_PHASE_SOURCE_CHANGED: smarter_private.horse_cash_retained_atomic_matches(uuid,bigint,jsonb,jsonb,jsonb)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.hand_submission_immutable()'::regprocedure)) IS DISTINCT FROM '51308b125a966a5e9341c0d2d0b5afc2' THEN RAISE EXCEPTION 'HORSE_CASH_PHASE_SOURCE_CHANGED: smarter_private.hand_submission_immutable()'; END IF;
END $pins$;

CREATE FUNCTION smarter_private.horse_cash_retention_accounting_ready(p_table uuid,p_number bigint)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE p public.cash_hand_provenance_receipts; m public.cash_hand_participant_manifests;
 k public.settlement_idempotency_keys; sealed smarter_private.horse_settlement_key_certificates; evidence jsonb;
BEGIN
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
 -- Only a verified tournament owner or the explicit unattached fixture may
 -- have no cash receipt. A missing cash/unknown owner stays original evidence.
 IF NOT FOUND THEN RETURN p_table IS NULL OR EXISTS(SELECT 1 FROM public.tables t WHERE t.id=p_table AND t.tournament_id IS NOT NULL); END IF;
 IF p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS NOT TRUE
 OR p.all_players_included IS NOT TRUE OR p.issues IS DISTINCT FROM '[]'::jsonb
 OR p.accepted_request#>'{hand_row,has_human}' IS DISTINCT FROM 'false'::jsonb
 OR p.accepted_request#>'{hand_row,tournament_id}' IS DISTINCT FROM 'null'::jsonb
 OR NOT smarter_private.horse_cash_retained_request_matches(p_table,p_number,p.payload_hash,p.accepted_request)
 OR smarter_private.f06_hand_cards_unresolved(p_table,p_number)
 OR smarter_private.f06_movement_boundary_retained(p_table,p_number)
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=p.hand_id AND (h.has_human IS DISTINCT FROM false OR h.reported IS true))
 OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=p_table AND b.hand_number=p_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=p.hand_id)
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates t WHERE t.hand_id=p.hand_id AND t.state='pending')
 THEN RETURN false; END IF;
 SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id AND table_id=p_table AND hand_number=p_number;
 IF NOT FOUND OR m.funding_provenance_complete IS NOT TRUE OR m.issues IS DISTINCT FROM '[]'::jsonb
 OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array' OR jsonb_array_length(m.participants) NOT BETWEEN 2 AND 10
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.participants) x WHERE x->'is_horse' IS DISTINCT FROM 'true'::jsonb)
 OR NOT EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes o WHERE o.table_id=p_table AND o.hand_number=p_number
  AND (o.hand_id,o.payload_hash,o.game_scope) IS NOT DISTINCT FROM (p.hand_id,p.payload_hash,p.game_scope)
  AND o.evidence->>'status'='ready' AND o.evidence->'basis_certified'='true'::jsonb AND o.evidence->'all_players_included'='true'::jsonb)
 OR NOT pg_input_is_valid(p.atomic_receipt#>>'{stack_result,hand_id}','uuid') THEN RETURN false; END IF;
 SELECT * INTO k FROM public.settlement_idempotency_keys WHERE table_id=p_table AND hand_id=(p.atomic_receipt#>>'{stack_result,hand_id}')::uuid;
 IF NOT FOUND OR k.status IS DISTINCT FROM 'succeeded' OR k.error IS NOT NULL OR k.completed_at IS NULL
 OR NOT isfinite(k.completed_at) THEN RETURN false; END IF;
 SELECT * INTO sealed FROM smarter_private.horse_settlement_key_certificates WHERE table_id=p_table AND stack_hand_id=k.hand_id;
 IF FOUND THEN
  IF (sealed.history_hand_id,sealed.hand_number,sealed.manifest_id) IS DISTINCT FROM (p.hand_id,p_number,p.manifest_id)
  OR encode(extensions.digest(convert_to((p.atomic_receipt->'stack_result')::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM sealed.original_result_sha256
  OR encode(extensions.digest(convert_to(smarter_private.horse_settlement_original_result(p_table,k.hand_id,k.result)::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM sealed.original_result_sha256
  THEN RETURN false; END IF;
 ELSE
  IF k.result IS DISTINCT FROM p.atomic_receipt->'stack_result' OR NOT k.result ? 'request' THEN RETURN false; END IF;
 END IF;
 evidence:=public.fn_pnl_cash_hand_evidence(p_table,p_number);
 IF evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
 OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb
 OR (sealed.table_id IS NOT NULL AND encode(extensions.digest(convert_to(evidence::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM sealed.accounting_evidence_sha256)
 THEN RETURN false; END IF;
 RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.horse_cash_retention_accounting_ready(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.horse_cash_retained_boundary_digest(p_table uuid,p_number bigint)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE p public.cash_hand_provenance_receipts; c smarter_private.horse_adaptive_disposal_certificates;
 b smarter_private.horse_retained_stats_basis; k smarter_private.horse_settlement_key_certificates;
BEGIN
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND OR NOT smarter_private.horse_cash_retention_accounting_ready(p_table,p_number)
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=p.hand_id)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=p_table AND a.hand_number=p_number)
 THEN RETURN NULL; END IF;
 SELECT * INTO c FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id=p.hand_id;
 IF NOT FOUND OR NOT smarter_private.horse_adaptive_disposal_certificate_matches(p.hand_id,p_table,p_number,c.request_hash) THEN RETURN NULL; END IF;
 SELECT * INTO k FROM smarter_private.horse_settlement_key_certificates WHERE history_hand_id=p.hand_id;
 IF NOT FOUND OR (k.table_id,k.hand_number,k.manifest_id) IS DISTINCT FROM (p_table,p_number,p.manifest_id)
 OR k.settled_at IS DISTINCT FROM (c.certificate#>>'{disposal,settlement_completed_at}')::timestamptz
 OR NOT isfinite(k.settled_at) OR k.settled_at>=statement_timestamp()-interval '8 days' THEN RETURN NULL; END IF;
 SELECT * INTO b FROM smarter_private.horse_retained_stats_basis WHERE hand_id=p.hand_id;
 IF NOT FOUND OR (b.table_id,b.hand_number,b.request_hash) IS DISTINCT FROM (p_table,p_number,c.request_hash) THEN RETURN NULL; END IF;
 RETURN encode(extensions.digest(convert_to(jsonb_build_object('version','retained-original-completed-cash-boundary-v1',
  'hand_id',p.hand_id,'table_id',p_table,'hand_number',p_number,'original_horse_completion',c.certificate,
  'key_certificate',to_jsonb(k),'stats_sha256',b.original_stats_sha256,'original_request_hash',b.request_hash)::text,'UTF8'),'sha256'),'hex');
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.horse_cash_retained_boundary_digest(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;

-- This separate certificate deliberately has no live-atomic-row hash: no
-- original live row remains on this route, and a missing row is not fabricated.
CREATE TABLE smarter_private.horse_cash_postprune_certificates (
 table_id uuid NOT NULL,hand_number bigint NOT NULL,hand_id uuid NOT NULL UNIQUE,manifest_id uuid NOT NULL,
 original_request_sha256 text NOT NULL,original_atomic_sha256 text NOT NULL,
 compact_request_sha256 text NOT NULL,compact_atomic_sha256 text NOT NULL,
 immutable_financial_sha256 text NOT NULL,accounting_evidence_sha256 text NOT NULL,
 original_boundary_sha256 text NOT NULL,accepted_at timestamptz NOT NULL,settled_at timestamptz NOT NULL,
 compacted_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(table_id,hand_number),
 CHECK(isfinite(accepted_at) AND isfinite(settled_at)),
 CHECK(original_request_sha256~'^[a-f0-9]{64}$' AND original_atomic_sha256~'^[a-f0-9]{64}$'
  AND compact_request_sha256~'^[a-f0-9]{64}$' AND compact_atomic_sha256~'^[a-f0-9]{64}$'
  AND immutable_financial_sha256~'^[a-f0-9]{64}$' AND accounting_evidence_sha256~'^[a-f0-9]{64}$'
  AND original_boundary_sha256~'^[a-f0-9]{64}$')
);
ALTER TABLE smarter_private.horse_cash_postprune_certificates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.horse_cash_postprune_certificates FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.horse_cash_postprune_certificate_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE p public.cash_hand_provenance_receipts; k smarter_private.horse_settlement_key_certificates;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'HORSE_CASH_POSTPRUNE_CERTIFICATE_IMMUTABLE'; END IF;
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 SELECT * INTO k FROM smarter_private.horse_settlement_key_certificates WHERE history_hand_id=p.hand_id;
 IF p.hand_id IS NULL OR (NEW.hand_id,NEW.manifest_id,NEW.accepted_at,NEW.settled_at)
  IS DISTINCT FROM (p.hand_id,p.manifest_id,p.accepted_at,k.settled_at)
 OR NEW.original_boundary_sha256 IS DISTINCT FROM smarter_private.horse_cash_retained_boundary_digest(NEW.table_id,NEW.hand_number)
 OR NOT smarter_private.horse_stats_basis_matches(p.hand_id,p.table_id,p.hand_number,p.accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}')
 OR (p.atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}' IS NOT NULL
  AND p.atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}' IS DISTINCT FROM p.accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}')
 OR NEW.original_request_sha256 IS DISTINCT FROM p.payload_hash
 OR NEW.original_request_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(p.accepted_request::text,'UTF8'),'sha256'),'hex')
 OR NEW.original_atomic_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex')
 OR NEW.compact_request_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(smarter_private.horse_cash_compact_request(p.accepted_request)::text,'UTF8'),'sha256'),'hex')
 OR NEW.compact_atomic_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(smarter_private.horse_cash_compact_atomic(p.atomic_receipt)::text,'UTF8'),'sha256'),'hex')
 OR NEW.immutable_financial_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex')
 OR NEW.accounting_evidence_sha256 IS DISTINCT FROM k.accounting_evidence_sha256 THEN RAISE EXCEPTION 'HORSE_CASH_POSTPRUNE_ORIGINAL_BOUNDARY_REQUIRED'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.horse_cash_postprune_certificate_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER horse_cash_postprune_certificate_immutable BEFORE INSERT OR UPDATE OR DELETE ON smarter_private.horse_cash_postprune_certificates
 FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_cash_postprune_certificate_immutable();
CREATE TRIGGER horse_cash_postprune_certificate_no_truncate BEFORE TRUNCATE ON smarter_private.horse_cash_postprune_certificates
 FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.horse_cash_postprune_certificate_immutable();
CREATE OR REPLACE FUNCTION smarter_private.horse_cash_retained_request_matches(p_table uuid, p_number bigint, p_hash text, p_request jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE c smarter_private.horse_cash_payload_certificates; p public.cash_hand_provenance_receipts; retained smarter_private.horse_cash_postprune_certificates;
BEGIN
 SELECT * INTO c FROM smarter_private.horse_cash_payload_certificates WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND THEN
  SELECT * INTO retained FROM smarter_private.horse_cash_postprune_certificates WHERE table_id=p_table AND hand_number=p_number;
  IF NOT FOUND THEN RETURN encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex') IS NOT DISTINCT FROM p_hash; END IF;
  SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
  RETURN FOUND AND (p.hand_id,p.manifest_id,p.accepted_at,p.payload_hash) IS NOT DISTINCT FROM
   (retained.hand_id,retained.manifest_id,retained.accepted_at,retained.original_request_sha256)
   AND p_hash=retained.original_request_sha256 AND p.accepted_request IS NOT DISTINCT FROM p_request
   AND encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex')=retained.compact_request_sha256
   AND encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex')=retained.compact_atomic_sha256
   AND encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex')=retained.immutable_financial_sha256;
 END IF;
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
 RETURN FOUND AND p.hand_id=c.hand_id AND p.manifest_id=c.manifest_id AND p.accepted_at=c.accepted_at
 AND p_hash=c.original_request_sha256 AND p.payload_hash=p_hash
 AND p.accepted_request IS NOT DISTINCT FROM p_request
 AND encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex')=c.compact_request_sha256
 AND encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex')=c.compact_atomic_sha256
 AND encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex')=c.immutable_financial_sha256;
END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.horse_cash_retained_atomic_matches(p_table uuid, p_number bigint, p_original jsonb, p_live jsonb, p_request jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE c smarter_private.horse_cash_payload_certificates;
BEGIN
 IF EXISTS(SELECT 1 FROM smarter_private.horse_cash_postprune_certificates WHERE table_id=p_table AND hand_number=p_number) THEN RETURN false; END IF;
 SELECT * INTO c FROM smarter_private.horse_cash_payload_certificates WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND THEN RETURN public.fn_cash_atomic_original_matches(p_original,p_live,p_request); END IF;
 RETURN smarter_private.horse_cash_retained_request_matches(p_table,p_number,c.original_request_sha256,p_request)
 AND encode(extensions.digest(convert_to(p_original::text,'UTF8'),'sha256'),'hex')=c.compact_atomic_sha256
 AND encode(extensions.digest(convert_to(p_live::text,'UTF8'),'sha256'),'hex')=c.live_atomic_sha256;
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_provenance_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='cash_hand_provenance_receipts' THEN
  IF (to_jsonb(NEW)-ARRAY['accepted_request','atomic_receipt']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['accepted_request','atomic_receipt'])
  AND smarter_private.horse_stats_basis_matches(OLD.hand_id,OLD.table_id,OLD.hand_number,OLD.accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}')
  AND (OLD.atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}' IS NULL OR COALESCE(OLD.atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}','null'::jsonb) IS NOT DISTINCT FROM COALESCE(OLD.accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}','null'::jsonb))
  AND NEW.accepted_request IS NOT DISTINCT FROM smarter_private.horse_cash_compact_request(OLD.accepted_request)
  AND NEW.atomic_receipt IS NOT DISTINCT FROM smarter_private.horse_cash_compact_atomic(OLD.atomic_receipt)
  AND (EXISTS(SELECT 1 FROM smarter_private.horse_cash_payload_certificates c WHERE c.table_id=OLD.table_id AND c.hand_number=OLD.hand_number
   AND c.hand_id=OLD.hand_id AND c.manifest_id=OLD.manifest_id AND c.accepted_at=OLD.accepted_at
   AND c.original_request_sha256=OLD.payload_hash
   AND c.original_request_sha256=encode(extensions.digest(convert_to(OLD.accepted_request::text,'UTF8'),'sha256'),'hex')
   AND c.original_atomic_sha256=encode(extensions.digest(convert_to(OLD.atomic_receipt::text,'UTF8'),'sha256'),'hex')
   AND c.compact_request_sha256=encode(extensions.digest(convert_to(NEW.accepted_request::text,'UTF8'),'sha256'),'hex')
   AND c.compact_atomic_sha256=encode(extensions.digest(convert_to(NEW.atomic_receipt::text,'UTF8'),'sha256'),'hex')
   AND c.immutable_financial_sha256=encode(extensions.digest(convert_to((to_jsonb(OLD)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex')) OR EXISTS(SELECT 1 FROM smarter_private.horse_cash_postprune_certificates c
 WHERE (c.table_id,c.hand_number,c.hand_id,c.manifest_id,c.accepted_at)
 IS NOT DISTINCT FROM (OLD.table_id,OLD.hand_number,OLD.hand_id,OLD.manifest_id,OLD.accepted_at)
 AND c.original_request_sha256=OLD.payload_hash
 AND c.original_request_sha256=encode(extensions.digest(convert_to(OLD.accepted_request::text,'UTF8'),'sha256'),'hex')
 AND c.original_atomic_sha256=encode(extensions.digest(convert_to(OLD.atomic_receipt::text,'UTF8'),'sha256'),'hex')
 AND c.compact_request_sha256=encode(extensions.digest(convert_to(NEW.accepted_request::text,'UTF8'),'sha256'),'hex')
 AND c.compact_atomic_sha256=encode(extensions.digest(convert_to(NEW.atomic_receipt::text,'UTF8'),'sha256'),'hex')
 AND c.immutable_financial_sha256=encode(extensions.digest(convert_to((to_jsonb(OLD)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex')) )
  THEN RETURN NEW; END IF;
 END IF;
RAISE EXCEPTION 'Original cash provenance is immutable' USING ERRCODE='55000'; END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.compact_horse_cash_play_contents(p_hands uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE k smarter_private.horse_settlement_key_certificates; p public.cash_hand_provenance_receipts;
 m public.cash_hand_participant_manifests; a public.hand_atomic_commits; h public.hand_history;
 request_after jsonb; atomic_after jsonb; evidence jsonb; n integer:=0; live_present boolean; retained_boundary text;
BEGIN
 IF p_hands IS NULL OR cardinality(p_hands)>250 THEN RAISE EXCEPTION 'HORSE_CASH_PAYLOAD_BATCH_INVALID' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT * FROM smarter_private.horse_settlement_key_certificates WHERE history_hand_id=ANY(p_hands) ORDER BY table_id,hand_number LOOP
  IF k.settled_at>=now()-interval '8 days' OR NOT isfinite(k.settled_at)
  OR EXISTS(SELECT 1 FROM smarter_private.horse_cash_payload_certificates c WHERE c.table_id=k.table_id AND c.hand_number=k.hand_number)
  OR EXISTS(SELECT 1 FROM smarter_private.horse_cash_postprune_certificates c WHERE c.table_id=k.table_id AND c.hand_number=k.hand_number) THEN CONTINUE; END IF;
  SELECT * INTO h FROM public.hand_history WHERE id=k.history_hand_id AND table_id=k.table_id AND hand_number=k.hand_number FOR UPDATE;
  live_present:=FOUND;
  IF live_present THEN
  IF h.has_human IS DISTINCT FROM FALSE OR h.reported IS TRUE OR h.tournament_id IS NOT NULL
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
  ELSE
   IF EXISTS(SELECT 1 FROM public.hand_atomic_commits original WHERE original.table_id=k.table_id AND original.hand_number=k.hand_number) THEN CONTINUE; END IF;
  END IF;
  SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=k.table_id AND hand_number=k.hand_number FOR UPDATE;
  IF NOT FOUND OR p.hand_id IS DISTINCT FROM k.history_hand_id OR p.manifest_id IS DISTINCT FROM k.manifest_id
  OR p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS NOT TRUE OR p.all_players_included IS NOT TRUE
  OR p.accepted_request#>'{hand_row,has_human}' IS DISTINCT FROM 'false'::jsonb
  OR p.accepted_request#>'{hand_row,tournament_id}' IS DISTINCT FROM 'null'::jsonb
  OR encode(extensions.digest(convert_to(p.accepted_request::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p.payload_hash
  OR (live_present AND p.atomic_receipt->'stack_result' IS DISTINCT FROM a.stack_result) THEN CONTINUE; END IF;
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
  -- An erased raw request must leave the exact accepted derived basis.
  IF NOT EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b
   WHERE b.hand_id=p.hand_id AND b.table_id=p.table_id AND b.hand_number=p.hand_number
   AND b.original_stats_sha256=encode(extensions.digest(convert_to(COALESCE(p.accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}','null'::jsonb)::text,'UTF8'),'sha256'),'hex')
   AND b.compact_stats IS NOT DISTINCT FROM smarter_private.horse_compact_stats_basis(p.accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}')
   AND (p.atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}' IS NULL OR COALESCE(p.atomic_receipt#>'{post_commit_payload,accepted_hand_facts,stats_facts}','null'::jsonb) IS NOT DISTINCT FROM COALESCE(p.accepted_request#>'{hand_row,_accepted_post_commit_facts,stats_facts}','null'::jsonb))) THEN CONTINUE; END IF;
  IF NOT live_present THEN
   retained_boundary:=smarter_private.horse_cash_retained_boundary_digest(k.table_id,k.hand_number);
   IF retained_boundary IS NULL THEN CONTINUE; END IF;
  END IF;
  request_after:=smarter_private.horse_cash_compact_request(p.accepted_request);
  atomic_after:=smarter_private.horse_cash_compact_atomic(p.atomic_receipt);
  IF request_after IS NOT DISTINCT FROM p.accepted_request AND atomic_after IS NOT DISTINCT FROM p.atomic_receipt THEN CONTINUE; END IF;
  IF live_present THEN
  INSERT INTO smarter_private.horse_cash_payload_certificates(table_id,hand_number,hand_id,manifest_id,original_request_sha256,original_atomic_sha256,
   compact_request_sha256,compact_atomic_sha256,immutable_financial_sha256,live_atomic_sha256,accounting_evidence_sha256,accepted_at,settled_at)
  VALUES(p.table_id,p.hand_number,p.hand_id,p.manifest_id,p.payload_hash,
   encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(request_after::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(atomic_after::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(to_jsonb(a)::text,'UTF8'),'sha256'),'hex'),
   encode(extensions.digest(convert_to(evidence::text,'UTF8'),'sha256'),'hex'),p.accepted_at,k.settled_at);
  ELSE
   INSERT INTO smarter_private.horse_cash_postprune_certificates(table_id,hand_number,hand_id,manifest_id,original_request_sha256,
    original_atomic_sha256,compact_request_sha256,compact_atomic_sha256,immutable_financial_sha256,accounting_evidence_sha256,
    original_boundary_sha256,accepted_at,settled_at)
   VALUES(p.table_id,p.hand_number,p.hand_id,p.manifest_id,p.payload_hash,
    encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to(request_after::text,'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to(atomic_after::text,'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex'),
    k.accounting_evidence_sha256,retained_boundary,p.accepted_at,k.settled_at);
  END IF;
  UPDATE public.cash_hand_provenance_receipts SET accepted_request=request_after,atomic_receipt=atomic_after WHERE table_id=p.table_id AND hand_number=p.hand_number;
  n:=n+1;
 END LOOP;
 RETURN n;
END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.hand_submission_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_SCHEMA='smarter_private' AND TG_TABLE_NAME='hand_submissions' THEN
  IF NEW.request='{}'::jsonb AND OLD.request<>'{}'::jsonb
  AND (to_jsonb(NEW)-'request') IS NOT DISTINCT FROM (to_jsonb(OLD)-'request')
  AND smarter_private.horse_request_payload_disposable(OLD.submission_id)
  AND smarter_private.horse_cash_retention_accounting_ready(OLD.table_id,OLD.hand_number)
  AND smarter_private.horse_adaptive_disposal_certificate_matches(OLD.submission_id,OLD.table_id,OLD.hand_number,OLD.request_hash)
  AND smarter_private.horse_stats_basis_matches(OLD.submission_id,OLD.table_id,OLD.hand_number,OLD.request#>'{p_hand_row,_accepted_post_commit_facts,stats_facts}')
  AND EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b WHERE b.hand_id=OLD.submission_id AND b.request_hash=OLD.request_hash) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'HAND_SUBMISSION_IMMUTABLE' USING ERRCODE='55000';
END $function$
;
CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_budget constant interval := interval '20 seconds';
  v_deadline timestamptz := clock_timestamp()+v_budget;
  v_days integer;
  v_window interval;
  v_doomed uuid[];
  v_keepers uuid[];
  v_deleted integer := 0;
  v_round integer;
BEGIN
  SELECT greatest(coalesce(horse_retention_days,8),1)
    INTO v_days FROM public.hand_history_retention_policy LIMIT 1;
  IF v_days IS NULL THEN v_days := 8; END IF;
  v_window := make_interval(days=>v_days);

  LOOP
    v_doomed := NULL;
    v_keepers := NULL;
    WITH candidates AS (
      SELECT hh.id,hh.players,
             (hh.table_id IS NULL AND hh.tournament_id IS NULL
              AND hh.players = '[]'::jsonb) AS unattached
        FROM public.hand_history hh
       WHERE hh.has_human IS FALSE
         AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submissions original
           WHERE original.table_id=hh.table_id AND original.hand_number=hh.hand_number
             AND (original.request#>'{p_hand_row,has_human}') IS DISTINCT FROM 'false'::jsonb)
         AND hh.reported IS NOT true
         AND smarter_private.horse_cash_retention_accounting_ready(hh.table_id,hh.hand_number)
         AND (hh.table_id IS NULL OR EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.hand_id=hh.id AND a.table_id=hh.table_id AND a.hand_number=hh.hand_number AND isfinite(a.post_commit_completed_at) AND a.post_commit_completed_at<now()-v_window AND a.post_commit_result->>'ok'='true'))
         AND hh.created_at<now()-v_window
         AND NOT EXISTS (
           SELECT 1 FROM public.bbj_payouts bp
            WHERE bp.table_id=hh.table_id AND bp.hand_number=hh.hand_number)
         AND NOT EXISTS (
           SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=hh.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')
         -- AN UNSETTLED TOURNAMENT KEEPS ITS HANDS (2026-10-02). A tournament
         -- hand is evidence until its event's money is settled: the event is
         -- COMPLETED or CANCELLED, its bounty pool is fully paid, and its
         -- escrow, when it has one, is closed. PKO 3f19bd70 lost the only record
         -- of who knocked out whom while 2,310.00 of its bounty pool was unpaid.
         -- Cash rake records are never deleted here (20260925143224), so a cash
         -- week keeps its per-player rakeback basis settled or not.
         -- Migration 20261002082452.
         AND (hh.tournament_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM public.tournaments ut
            WHERE ut.id=hh.tournament_id
              AND (upper(COALESCE(ut.status::text,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED')
                   OR COALESCE(ut.bounty_pool,0)>COALESCE(ut.bounty_pool_paid,0)
                   OR EXISTS (SELECT 1 FROM public.tournament_escrow ue
                               WHERE ue.tournament_id=ut.id AND ue.closed_at IS NULL))))
         -- A hand whose F06 permit is still 'reserved' is unresolved, and this
         -- row is original evidence for it:
         -- smarter_private.f06_retired_origin_snapshot and
         -- smarter_private.f06_retained_mtt_abort_snapshot both read
         -- public.hand_history and public.hand_atomic_commits. All four DELETEs
         -- below key off the ids chosen here, so excluding the hand at this one
         -- point retains its history, atomic commit, rake attribution and
         -- player-index rows together. Excluding it from the candidate set
         -- rather than from each DELETE also keeps it out of v_keepers, so no
         -- has_human=true is written that would retain it past its permit, and
         -- it never consumes a p_batch slot. Retention ends when the permit
         -- leaves 'reserved'; every other row prunes on the same boundary as
         -- before. The lookup goes through the SECURITY DEFINER helper added by
         -- migration 20260920232341, because this function is SECURITY INVOKER
         -- and its search_path does not include smarter_private.
         AND NOT smarter_private.f06_hand_cards_unresolved(hh.table_id,hh.hand_number::bigint)
         -- AND the hand that IS the table's current movement boundary, for a
         -- table F06 can still be asked to move. The guard above protects the
         -- unresolved HAND -- which never started and has no row here -- so it
         -- reached straight past the hands the table already dealt, and
         -- smarter_private.f06_movement_prior loads the last of those by
         -- max(hand_number) and validates its post-commit payload hash,
         -- request hash and stack receipt out of it. Delete it and that table
         -- raises F06_MOVEMENT_PRIOR_INCOMPLETE for ever: on 2026-09-25 one
         -- seated player in a RUNNING freeroll was about six retention runs
         -- from exactly that. One hand per live table, and it stops being the
         -- boundary as soon as the table deals another. Migration
         -- 20260925210126.
         AND NOT smarter_private.f06_movement_boundary_retained(hh.table_id,hh.hand_number::bigint)
         -- Missing/blank classification or conflicting ownership stays retained.
         -- A known Spin's history remains evidence until canonical terminal
         -- state commits; do not require a first legacy receipt to exist.
         -- AN UNATTACHED ROW IS NOT A HAND ANYBODY PLAYED (2026-10-05). A row
         -- with no table, no tournament and nobody dealt in is the settled-hand
         -- fixture tests/e2e/production-daily-missions.spec.ts inserts and
         -- deletes; a run killed before its finally block leaves it behind.
         -- The engine never writes one. tb.id=hh.table_id is never true for a
         -- NULL table_id, so the EXISTS below excluded such a row from every
         -- run, and even admitted, an empty player list classifies as human
         -- below and would be kept for ever. Every guard above still governs
         -- it (both f06 helpers read false for a NULL table_id, measured on
         -- all eight such rows). Migration 20261005111120.
         AND ((hh.table_id IS NULL AND hh.tournament_id IS NULL
               AND hh.players = '[]'::jsonb) OR EXISTS (
           SELECT 1 FROM public.tables tb
           LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
            WHERE tb.id=hh.table_id
              AND (hh.tournament_id IS NULL
                   OR hh.tournament_id=tb.tournament_id)
              AND (
                (hh.tournament_id IS NULL AND tb.tournament_id IS NULL)
                OR (
                  t.id IS NOT NULL
                  AND NULLIF(btrim(t.variant::text),'') IS NOT NULL
                  AND NULLIF(btrim(t.tournament_type::text),'') IS NOT NULL
                  AND (
                    (lower(t.variant::text)<>'spin'
                     AND upper(t.tournament_type::text)<>'SPIN')
                    OR (upper(COALESCE(t.status::text,''))='COMPLETED'
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_terminal_settlements terminal
                           WHERE terminal.tournament_id=t.id))
                    OR (upper(COALESCE(t.status::text,'')) IN ('CANCELLED','CANCELED')
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_cancellation_receipts cancellation
                           WHERE cancellation.tournament_id=t.id))
                  )
                )
              )
         ))
       ORDER BY hh.created_at
       LIMIT LEAST(GREATEST(p_batch,1),250)
       FOR UPDATE SKIP LOCKED
    ), classified AS (
      SELECT c.id,
        CASE
          WHEN c.unattached THEN false
          WHEN jsonb_typeof(c.players) IS DISTINCT FROM 'array' THEN true
          WHEN jsonb_array_length(c.players)=0 THEN true
          ELSE EXISTS (
            SELECT 1
              FROM jsonb_array_elements(c.players) e
              LEFT JOIN public.profiles p ON p.id=(CASE
                WHEN length(e.value->>'userId')=36
                 AND (e.value->>'userId') ~
                   '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN (e.value->>'userId')::uuid END)
             WHERE p.id IS NULL OR p.is_horse IS NOT true)
        END AS is_human
        FROM candidates c
    )
    SELECT array_agg(id) FILTER (WHERE is_human IS false),
           array_agg(id) FILTER (WHERE is_human IS DISTINCT FROM false)
      INTO v_doomed,v_keepers FROM classified;

    EXIT WHEN v_doomed IS NULL AND v_keepers IS NULL;
    IF v_keepers IS NOT NULL AND cardinality(v_keepers)>0 THEN
      UPDATE public.hand_history SET has_human=true WHERE id=ANY(v_keepers);
    END IF;
    IF v_doomed IS NOT NULL AND cardinality(v_doomed)>0 THEN
      -- A RECORDED EARNING SOURCE IS NOT HAND HISTORY (2026-09-25).
      -- This line used to delete the pruned hands rake attributions, and
      -- every run of sp_prune_hand_history_10m raised
      -- recorded_cash_earning_source_is_immutable for it: the trigger
      -- accounting_cash_source_immutable refuses to move an attribution once
      -- accounting_cash_accrual_batches holds a batch for its rake record.
      -- The trigger is right and the DELETE was never required: there is no
      -- foreign key from rake_attributions.hand_id to hand_history.id. It
      -- also fired trg_ca_club_rake_daily_user_del, which would have
      -- decremented the per-club per-user daily rake rollup - the rakeback
      -- basis - for every horse in every pruned hand (CLAUDE.md 10.5).
      -- Retention is a storage decision about hand HISTORY (10.5, eight
      -- days); the money ledger is not pruned, so attributions are kept.
      -- RETENTION CLOSES THE SETTLEMENT REQUEST IT PRUNES (2026-09-28).
      -- The commit row below is how fn_ca_resume_hand_submission knows a
      -- hand finished. Deleting it without closing the request leaves the
      -- table looking mid-hand for ever, and the next successor refuses to
      -- start it (HAND_SUBMISSION_HANDOFF_STATE_CHANGED). Receipted here,
      -- in the same transaction, while table_id and hand_number are still
      -- readable from the rows about to go.
      PERFORM smarter_private.hand_submission_retention_disposal(v_doomed,
        'Retention pruned this settled hand under the horse hand-history policy; its durable record (atomic commit and history) has aged out, so the retained settlement request is closed here and must never be applied again. Zero credit: the hand settled when it was played.');
      PERFORM smarter_private.compact_horse_settlement_keys(v_doomed);
      PERFORM smarter_private.compact_horse_cash_play_contents(v_doomed);
      PERFORM smarter_private.archive_pruned_hand_index(v_doomed);
      DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_history WHERE id=ANY(v_doomed);
      GET DIAGNOSTICS v_round=ROW_COUNT;
      v_deleted := v_deleted+v_round;
    END IF;
    EXIT WHEN clock_timestamp()>=v_deadline;
  END LOOP;
  RETURN v_deleted;
END;
$function$
;
CREATE OR REPLACE FUNCTION smarter_private.horse_snapshot_disposable(p_snapshot uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE s public.hand_state_snapshots; c smarter_private.horse_adaptive_disposal_certificates;
BEGIN
 SELECT * INTO s FROM public.hand_state_snapshots WHERE id=p_snapshot;
 IF NOT FOUND OR NOT isfinite(s.created_at) OR NOT isfinite(s.updated_at)
 OR s.created_at>=statement_timestamp()-interval '8 days' OR s.updated_at>=statement_timestamp()-interval '8 days'
 OR jsonb_typeof(s.players_json) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(s.players_json)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.players_json) p
  WHERE jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->'is_horse' IS DISTINCT FROM 'true'::jsonb
  OR COALESCE(p->>'user_id','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') THEN RETURN false; END IF;
 SELECT * INTO c FROM smarter_private.horse_adaptive_disposal_certificates d WHERE d.table_id=s.table_id AND d.hand_number=s.hand_number LIMIT 1;
 IF NOT FOUND OR NOT smarter_private.horse_adaptive_disposal_certificate_matches(c.hand_id,c.table_id,c.hand_number,c.request_hash)
 OR NOT smarter_private.horse_cash_retention_accounting_ready(s.table_id,s.hand_number)
 OR smarter_private.f06_hand_cards_unresolved(s.table_id,s.hand_number)
 OR smarter_private.f06_movement_boundary_retained(s.table_id,s.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.table_id=s.table_id AND p.hand_number=s.hand_number AND p.state='reserved')
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=c.hand_id AND (h.reported IS true OR h.has_human IS DISTINCT FROM false))
 OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=s.table_id AND b.hand_number=s.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=c.hand_id)
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates k WHERE k.hand_id=c.hand_id AND k.state='pending')
 THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=s.table_id)
 OR EXISTS(SELECT 1 FROM public.tables tab WHERE tab.id=s.table_id AND tab.tournament_id IS NOT NULL
  AND (NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=tab.tournament_id
   AND upper(COALESCE(t.status::text,'')) IN('COMPLETED','CANCELLED','CANCELED')
   AND COALESCE(t.bounty_pool,0)<=COALESCE(t.bounty_pool_paid,0))
   OR EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=tab.tournament_id AND e.closed_at IS NULL))) THEN RETURN false; END IF;
 RETURN true;
END $function$
;
ALTER FUNCTION smarter_private.horse_cash_retention_accounting_ready(uuid,bigint) OWNER TO postgres;
ALTER FUNCTION smarter_private.horse_cash_retained_boundary_digest(uuid,bigint) OWNER TO postgres;
ALTER FUNCTION smarter_private.horse_cash_postprune_certificate_immutable() OWNER TO postgres;
ALTER TABLE smarter_private.horse_cash_postprune_certificates OWNER TO postgres;
COMMIT;

-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure))='865391e842ed009b45ec7727efe7e85b' AND md5(pg_get_functiondef('public.fn_union_pnl_prove_posthand_escrow(uuid,bigint)'::regprocedure))='c0554046c74ab6997805d312c1848c76' AND md5(pg_get_functiondef('smarter_private.posthand_escrow_certificate_immutable()'::regprocedure))='14b1ddb37d4e3e83a9a42a34438e4b6e' AND md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)'::regprocedure))='f1d7fbfbe0bcebb63579b19bc3143a95' AND md5(pg_get_functiondef('public.fn_union_pnl_certify_posthand_escrow(uuid,bigint,text,text)'::regprocedure))='bda800236c5847110d78003a41bf45dd' AND md5(pg_get_functiondef('smarter_private.posthand_escrow_project_evidence(jsonb,jsonb)'::regprocedure))='95ef5461c27ea58c3ff77e6f8d47df88' AND md5(pg_get_functiondef('smarter_private.posthand_escrow_original_snapshot(uuid,bigint)'::regprocedure))='bc7c33d508a74b028f3614ba2d3d7c6d' AND md5(pg_get_functiondef('smarter_private.posthand_escrow_certified_evidence(uuid,bigint)'::regprocedure))='4484361142c05fcc70437b8d7a2b1407' AND md5(pg_get_functiondef('public.fn_union_pnl_posthand_escrow_participants(union_pnl_cash_outcomes)'::regprocedure))='2db7263f8d42e2e0e5a45b42b7198e4d' AND md5(pg_get_functiondef('public.fn_union_pnl_posthand_escrow_touch(union_pnl_cash_outcome_touches)'::regprocedure))='ea07d6fa0e981ae635e6c5a6f8aeb067' AND md5(pg_get_functiondef('public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)'::regprocedure))='0c69388b1406858f3bed04f54639fab6')
-- Prove original unplayed escrow applied only after its signed hand.
-- Preserve original outcomes, signed hashes, p/m classification and private retention ownership.
-- One card-free exact original completion certificate; no wallet/ledger/seat/membership mutation.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preimages$
BEGIN
 IF to_regclass('smarter_private.posthand_escrow_certificates') IS NOT NULL THEN RAISE EXCEPTION 'POSTHAND_ESCROW_ALREADY_INSTALLED' USING ERRCODE='55000';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'POSTHAND_ESCROW_INSTALLATION_REQUIRES_THAW' USING ERRCODE='55000';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'POSTHAND_ESCROW_ORIGINAL_READER_OPERATION_OWNED' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure)) IS DISTINCT FROM 'd713d072b45e30b81cc52ef90ae77f6b' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: public.fn_pnl_cash_hand_evidence(uuid,bigint)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)'::regprocedure)) IS DISTINCT FROM '7e443fd75f3b1ece7cd0713a6b8fc0a5' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM '8826ad945a9af4f9534ebd4c31bad4f7' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('smarter_private.horse_cash_compact_atomic(jsonb)'::regprocedure)) IS DISTINCT FROM 'c89eb6b4c2a250cbfeaf09c02f2723b8' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: smarter_private.horse_cash_compact_atomic(jsonb)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_cash_atomic_original_matches(jsonb,jsonb,jsonb)'::regprocedure)) IS DISTINCT FROM '740dbfc1511991df7ac864eb4396b0b0' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: public.fn_cash_atomic_original_matches(jsonb,jsonb,jsonb)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('smarter_private.horse_cash_retained_atomic_matches(uuid,bigint,jsonb,jsonb,jsonb)'::regprocedure)) IS DISTINCT FROM '9a2d9d07dcb0034af1c9437606f37f70' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: smarter_private.horse_cash_retained_atomic_matches(uuid,bigint,jsonb,jsonb,jsonb)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_pnl_evidence_cents(jsonb)'::regprocedure)) IS DISTINCT FROM '8d712bd799c3dfa691f2d8d9ff5101e8' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: public.fn_pnl_evidence_cents(jsonb)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM 'bb74ae7693dc40b812fce685cfc3c294' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure)) IS DISTINCT FROM '4d7431e0be2290bb7ebf84df286119d4' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure)) IS DISTINCT FROM '1b2960aedb5878428409fafb8242bb06' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('smarter_private.horse_settlement_original_result(uuid,uuid,jsonb)'::regprocedure)) IS DISTINCT FROM '9b34ace9a694e65a7bd0b3917c4a70fd' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: smarter_private.horse_settlement_original_result(uuid,uuid,jsonb)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_prove_late_settlement(uuid)'::regprocedure)) IS DISTINCT FROM '0ff6de5baff6a5939003718e6f6a5d90' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: public.fn_union_pnl_prove_late_settlement(uuid)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM '4132bd1a9fadde8bb8ae40e5e493e155' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM 'b9acdceb99c92dc9c472eaa73b1194d8' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_PREIMAGE_CHANGED: public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261012201712' AND array_length(statements,1)=1 AND octet_length(statements[1])=59262 AND md5(statements[1])='11744fcbfbf8b67ccc602704d1837546') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_QUALIFIED_FLOW_PREDECESSOR_NOT_INSTALLED' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=ANY(ARRAY['public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)'::regprocedure,'public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean)'::regprocedure]) AND (pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']))
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'POSTHAND_ESCROW_ORIGINAL_READER_ACCESS_CHANGED' USING ERRCODE='55000';END IF;
END $preimages$;
CREATE TABLE smarter_private.posthand_escrow_certificates (
 table_id uuid NOT NULL,hand_number bigint NOT NULL,hand_id uuid NOT NULL UNIQUE,
 original jsonb NOT NULL,original_sha256 text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(table_id,hand_number),
 CHECK(jsonb_typeof(original)='object' AND original_sha256~'^[a-f0-9]{64}$' AND isfinite(recorded_at))
);
ALTER TABLE smarter_private.posthand_escrow_certificates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE smarter_private.posthand_escrow_certificates FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.posthand_escrow_project_evidence(p_evidence jsonb,p_proof jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
 SELECT p_evidence||jsonb_build_object('status','ready','basis_certified',true,'payment_authorized',false,'issues','[]'::jsonb,
  'participants',(SELECT jsonb_agg(o.participant||jsonb_build_object('earning_club_id',p.participant->'earning_club_id','ownership_certified',true) ORDER BY o.n)
   FROM jsonb_array_elements(p_evidence->'participants') WITH ORDINALITY o(participant,n)
   JOIN LATERAL jsonb_array_elements(p_proof->'participants') p(participant) ON p.participant->>'user_id'=o.participant->>'user_id'),
  'qualified_basis','original_unplayed_escrow_applied_after_signed_hand');
$function$;
REVOKE ALL ON FUNCTION smarter_private.posthand_escrow_project_evidence(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
-- Original unplayed escrow, applied only after
-- this signed hand, is distinct from a played stack or a late seat credit.
CREATE OR REPLACE FUNCTION public.fn_union_pnl_prove_posthand_escrow(p_table uuid,p_number bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC'
AS $function$
DECLARE o union_pnl_cash_outcomes; p cash_hand_provenance_receipts; m cash_hand_participant_manifests;
 a hand_atomic_commits; prev cash_hand_provenance_receipts; f cash_participant_funding_receipts; app cash_funding_application_receipts;
 cert smarter_private.posthand_escrow_certificates; retained boolean; live boolean; completed_at timestamptz; pending_ids jsonb; result jsonb;
 affected uuid; part jsonb; original jsonb; lin jsonb; ref jsonb; owned uuid; refs uuid[]; total numeric:=0;
 before_stack numeric; after_stack numeric; prev_stack numeric; submitted jsonb; proof_people jsonb:='[]'; witness union_pnl_inventory_events;
BEGIN
 SELECT * INTO o FROM union_pnl_cash_outcomes WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND OR o.evidence->>'status' IS DISTINCT FROM 'blocked'
  OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb
  OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope
  OR o.transaction_id IS NULL OR o.recognized_at IS NULL OR NOT isfinite(o.recognized_at)
  OR NOT EXISTS(SELECT 1 FROM union_pnl_transaction_frames fr WHERE fr.transaction_id=o.transaction_id AND fr.observed_at=o.recognized_at) THEN RAISE EXCEPTION 'escrow_refused:blocked_original_population_required';END IF;
 SELECT * INTO STRICT p FROM cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
 SELECT * INTO STRICT m FROM cash_hand_participant_manifests WHERE id=p.manifest_id;
 IF (p.table_id,p.hand_number,p.hand_id,p.payload_hash,p.game_scope) IS DISTINCT FROM (o.table_id,o.hand_number,o.hand_id,o.payload_hash,o.game_scope)
  OR (m.table_id,m.hand_number,m.game_scope) IS DISTINCT FROM (p_table,p_number,o.game_scope)
  OR m.issues IS DISTINCT FROM p.issues OR p.status IS DISTINCT FROM 'uncertified'
  OR p.funding_provenance_complete IS DISTINCT FROM false OR p.all_players_included IS DISTINCT FROM true
  OR p.accepted_at IS NULL OR NOT isfinite(p.accepted_at) OR m.captured_at IS NULL OR NOT isfinite(m.captured_at) OR m.captured_at>o.recognized_at OR o.recognized_at>p.accepted_at
  OR o.game_scope->>'asset' IS DISTINCT FROM 'chips' OR o.game_scope->'unit_scale' IS DISTINCT FROM '2'::jsonb
  OR o.game_scope->'tournament_id' IS DISTINCT FROM 'null'::jsonb
  OR pg_input_is_valid(o.game_scope->>'host_club_id','uuid') IS DISTINCT FROM true
  OR pg_input_is_valid(o.game_scope->>'game_union_id','uuid') IS DISTINCT FROM true
  OR jsonb_typeof(o.game_scope->'is_private') IS DISTINCT FROM 'boolean'
  OR NOT o.game_scope ?& ARRAY['host_club_id','game_union_id','asset','unit_scale','is_private','tournament_id']
  OR p.accepted_request->>'table_id' IS DISTINCT FROM p_table::text OR p.accepted_request->>'hand_number' IS DISTINCT FROM p_number::text
  OR NOT public.fn_cash_signed_retained_request_matches(p_table,p_number,p.payload_hash,p.accepted_request) THEN
  RAISE EXCEPTION 'escrow_refused:original_identity_or_signature_disagrees';END IF;
 SELECT min((x->>'user_id'))::uuid INTO affected FROM jsonb_array_elements(m.issues) x;
 IF affected IS NULL OR jsonb_array_length(m.issues)<>2
  OR NOT m.issues @> jsonb_build_array(jsonb_build_object('reason','pending_funding_application_unproven','user_id',affected),jsonb_build_object('reason','original_cash_move_lineage_unproven','user_id',affected,'details',jsonb_build_array('pending_funding_application_unproven')))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.issues) x WHERE x->>'user_id' IS DISTINCT FROM affected::text
    OR NOT (x=jsonb_build_object('reason','pending_funding_application_unproven','user_id',affected)
      OR x=jsonb_build_object('reason','original_cash_move_lineage_unproven','user_id',affected,'details',jsonb_build_array('pending_funding_application_unproven'))))
  OR o.evidence->'issues' IS DISTINCT FROM (jsonb_build_array('original_cash_funding_incomplete')||m.issues||
    jsonb_build_array(jsonb_build_object('reason','participant_earning_ownership_receipt_invalid','user_id',affected))) THEN
  RAISE EXCEPTION 'escrow_refused:only_exact_pending_escrow_defects_qualify';END IF;
 SELECT * INTO cert FROM smarter_private.posthand_escrow_certificates WHERE table_id=p_table AND hand_number=p_number;
 retained:=FOUND;
 IF retained AND (cert.hand_id IS DISTINCT FROM o.hand_id
  OR cert.original_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(cert.original::text,'UTF8'),'sha256'),'hex')
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['source_financial_request_sha256','original_accounting_evidence_sha256','qualified_evidence_sha256','original_participant_roster_sha256','immutable_financial_sha256','original_atomic_sha256','compact_atomic_sha256','original_stack_result_sha256','original_stack_request_sha256','postcommit_payload_sha256','postcommit_request_sha256','postcommit_result_sha256']) name WHERE jsonb_typeof(cert.original->name) IS DISTINCT FROM 'string' OR cert.original->>name !~ '^[a-f0-9]{64}$')
  OR cert.original->'version' IS DISTINCT FROM '1'::jsonb
  OR cert.original->>'table_id' IS DISTINCT FROM p_table::text OR cert.original->>'hand_number' IS DISTINCT FROM p_number::text
  OR cert.original->>'hand_id' IS DISTINCT FROM o.hand_id::text OR cert.original->>'manifest_id' IS DISTINCT FROM p.manifest_id::text
  OR (cert.original->>'accepted_at')::timestamptz IS DISTINCT FROM p.accepted_at
  OR cert.original->>'source_financial_request_sha256' IS DISTINCT FROM p.payload_hash
  OR cert.original->>'original_accounting_evidence_sha256' IS DISTINCT FROM encode(extensions.digest(convert_to(o.evidence::text,'UTF8'),'sha256'),'hex')
  OR cert.original->>'original_participant_roster_sha256' IS DISTINCT FROM encode(extensions.digest(convert_to(p.participants::text,'UTF8'),'sha256'),'hex')
  OR cert.original->>'immutable_financial_sha256' IS DISTINCT FROM encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex')
  OR (encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM cert.original->>'original_atomic_sha256'
   AND encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM cert.original->>'compact_atomic_sha256')
  OR cert.original->>'stack_hand_id' IS DISTINCT FROM p.atomic_receipt#>>'{stack_result,hand_id}'
  OR cert.original->>'original_stack_result_sha256' IS DISTINCT FROM encode(extensions.digest(convert_to((p.atomic_receipt->'stack_result')::text,'UTF8'),'sha256'),'hex')
  OR cert.original->>'original_stack_request_sha256' IS DISTINCT FROM encode(extensions.digest(convert_to((p.atomic_receipt#>'{stack_result,request}')::text,'UTF8'),'sha256'),'hex')
  OR cert.original->>'postcommit_payload_sha256' IS NULL OR cert.original->>'postcommit_payload_sha256' !~ '^[a-f0-9]{64}$'
  OR cert.original->>'postcommit_request_sha256' IS NULL OR cert.original->>'postcommit_request_sha256' !~ '^[a-f0-9]{64}$'
  OR cert.original->>'postcommit_result_sha256' IS NULL OR cert.original->>'postcommit_result_sha256' !~ '^[a-f0-9]{64}$'
  OR jsonb_typeof(cert.original->'pending_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(cert.original->'pending_ids')<>1
  OR NOT pg_input_is_valid(cert.original#>>'{pending_ids,0}','uuid')
  OR cert.original->>'committed_at' IS NULL OR cert.original->>'completed_at' IS NULL
  OR NOT isfinite((cert.original->>'committed_at')::timestamptz) OR NOT isfinite((cert.original->>'completed_at')::timestamptz)
  OR (cert.original->>'completed_at')::timestamptz<(cert.original->>'committed_at')::timestamptz) THEN
  RAISE EXCEPTION 'escrow_refused:immutable_original_postcommit_certificate_disagrees';END IF;
 SELECT * INTO a FROM hand_atomic_commits WHERE table_id=p_table AND hand_number=p_number;
 live:=FOUND;
 IF live THEN
 IF a.hand_id IS DISTINCT FROM o.hand_id OR a.payload_hash IS DISTINCT FROM o.payload_hash
  OR a.stack_result IS DISTINCT FROM p.atomic_receipt->'stack_result'
  OR p.atomic_receipt->>'table_id' IS DISTINCT FROM p_table::text OR p.atomic_receipt->>'hand_number' IS DISTINCT FROM p_number::text
  OR a.stack_result->'success' IS DISTINCT FROM 'true'::jsonb OR a.stack_result->'conservation_checked' IS DISTINCT FROM 'true'::jsonb
  OR a.post_commit_completed_at IS NULL OR NOT isfinite(a.post_commit_completed_at) OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
  OR p.stack_claim->>'status' IS DISTINCT FROM 'succeeded' OR p.stack_claim->'result' IS DISTINCT FROM a.stack_result
  OR p.stack_settlement->>'state' IS DISTINCT FROM 'final'
  OR p.stack_claim->>'table_id' IS DISTINCT FROM p_table::text
  OR p.stack_claim->>'hand_id' IS DISTINCT FROM a.stack_result->>'hand_id'
  OR p.stack_settlement->>'hand_id' IS DISTINCT FROM a.stack_result->>'hand_id'
  OR NOT EXISTS(SELECT 1 FROM settlement_idempotency_keys k WHERE k.table_id=p_table AND k.hand_id=(a.stack_result->>'hand_id')::uuid
    AND k.status='succeeded' AND smarter_private.horse_settlement_original_result(k.table_id,k.hand_id,k.result)=a.stack_result)
  OR NOT EXISTS(SELECT 1 FROM ca_settlements c WHERE c.table_id=p_table AND c.hand_id=(a.stack_result->>'hand_id')::uuid
    AND c.state='final' AND c.totals=p.stack_settlement->'totals') THEN RAISE EXCEPTION 'escrow_refused:original_atomic_completion_required';END IF;
 submitted:=a.post_commit_payload-'accepted_hand_facts';
 IF jsonb_typeof(a.post_commit_payload) IS DISTINCT FROM 'object'
  OR a.post_commit_payload->>'version' IS DISTINCT FROM '1'
  OR jsonb_typeof(a.post_commit_payload->'accepted_hand_facts') IS DISTINCT FROM 'object'
  OR jsonb_typeof(a.post_commit_payload#>'{pending_addons,ids}') IS DISTINCT FROM 'array'
  OR encode(extensions.digest(convert_to(a.post_commit_payload::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_payload_hash
  OR a.post_commit_result->>'hand_id' IS DISTINCT FROM a.hand_id::text
  OR a.post_commit_result->>'hand_number' IS DISTINCT FROM a.hand_number::text
  OR a.committed_at IS NULL OR NOT isfinite(a.committed_at) OR a.post_commit_completed_at<a.committed_at THEN
  RAISE EXCEPTION 'escrow_refused:original_postcommit_seal_disagrees';END IF;
 submitted:=submitted#-'{pending_addons,ids}';
 IF encode(extensions.digest(convert_to(submitted::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_request_hash THEN
  RAISE EXCEPTION 'escrow_refused:original_postcommit_request_disagrees';END IF;

  completed_at:=a.post_commit_completed_at;pending_ids:=a.post_commit_payload#>'{pending_addons,ids}';
  IF retained AND (cert.original->>'postcommit_payload_sha256' IS DISTINCT FROM a.post_commit_payload_hash
   OR cert.original->>'postcommit_request_sha256' IS DISTINCT FROM a.post_commit_request_hash
   OR cert.original->>'postcommit_result_sha256' IS DISTINCT FROM encode(extensions.digest(convert_to(a.post_commit_result::text,'UTF8'),'sha256'),'hex')
   OR (cert.original->>'committed_at')::timestamptz IS DISTINCT FROM a.committed_at
   OR (cert.original->>'completed_at')::timestamptz IS DISTINCT FROM a.post_commit_completed_at
   OR cert.original->'pending_ids' IS DISTINCT FROM pending_ids) THEN
   RAISE EXCEPTION 'escrow_refused:retained_postcommit_certificate_conflicts_with_original_live';END IF;
 ELSE
  IF NOT retained OR p.atomic_receipt->>'table_id' IS DISTINCT FROM p_table::text
   OR p.atomic_receipt->>'hand_number' IS DISTINCT FROM p_number::text
   OR p.atomic_receipt->>'hand_id' IS DISTINCT FROM o.hand_id::text OR p.atomic_receipt->>'payload_hash' IS DISTINCT FROM o.payload_hash
   OR p.atomic_receipt#>'{stack_result,success}' IS DISTINCT FROM 'true'::jsonb
   OR p.atomic_receipt#>'{stack_result,conservation_checked}' IS DISTINCT FROM 'true'::jsonb
   OR p.stack_claim->>'status' IS DISTINCT FROM 'succeeded' OR p.stack_claim->'result' IS DISTINCT FROM p.atomic_receipt->'stack_result'
   OR p.stack_settlement->>'state' IS DISTINCT FROM 'final'
   OR NOT EXISTS(SELECT 1 FROM settlement_idempotency_keys k WHERE k.table_id=p_table AND k.hand_id=(p.atomic_receipt#>>'{stack_result,hand_id}')::uuid
    AND k.status='succeeded' AND smarter_private.horse_settlement_original_result(k.table_id,k.hand_id,k.result)=p.atomic_receipt->'stack_result')
   OR NOT EXISTS(SELECT 1 FROM ca_settlements c WHERE c.table_id=p_table AND c.hand_id=(p.atomic_receipt#>>'{stack_result,hand_id}')::uuid
    AND c.state='final' AND c.totals=p.stack_settlement->'totals') THEN
   RAISE EXCEPTION 'escrow_refused:retained_original_atomic_completion_required';END IF;
  IF EXISTS(SELECT 1 FROM smarter_private.horse_settlement_key_certificates k WHERE k.table_id=p_table AND k.hand_number=p_number
   AND ((k.history_hand_id,k.manifest_id,k.stack_hand_id) IS DISTINCT FROM (o.hand_id,p.manifest_id,(p.atomic_receipt#>>'{stack_result,hand_id}')::uuid)
    OR k.original_result_sha256 IS DISTINCT FROM cert.original->>'original_stack_result_sha256'
    OR k.original_request_sha256 IS DISTINCT FROM cert.original->>'original_stack_request_sha256'
    OR k.accounting_evidence_sha256 IS DISTINCT FROM cert.original->>'qualified_evidence_sha256'
    OR k.settled_at IS DISTINCT FROM (cert.original->>'completed_at')::timestamptz)) THEN
   RAISE EXCEPTION 'escrow_refused:original_retention_key_certificate_disagrees';END IF;
  completed_at:=(cert.original->>'completed_at')::timestamptz;pending_ids:=cert.original->'pending_ids';
 END IF;
 IF jsonb_typeof(p.participants) IS DISTINCT FROM 'array' OR jsonb_array_length(p.participants) NOT BETWEEN 2 AND 10
  OR jsonb_array_length(p.participants)<>jsonb_array_length(m.participants)
  OR jsonb_array_length(p.participants)<>jsonb_array_length(o.evidence->'participants')
  OR jsonb_array_length(p.participants)<>jsonb_array_length(p.accepted_request->'stacks')
  OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(p.participants) x)<>jsonb_array_length(p.participants) THEN
  RAISE EXCEPTION 'escrow_refused:full_original_roster_required';END IF;
 FOR part IN SELECT x FROM jsonb_array_elements(p.participants) x LOOP
  before_stack:=fn_pnl_evidence_cents(part->'stack_before');after_stack:=fn_pnl_evidence_cents(part->'stack_after');
  IF before_stack IS NULL OR after_stack IS NULL OR before_stack<0 OR after_stack<0
   OR jsonb_typeof(part->'is_horse') IS DISTINCT FROM 'boolean' OR part->>'user_id' IS NULL OR part->>'seat_id' IS NULL OR part->>'occupancy_id' IS NULL OR part->>'seat_joined_at' IS NULL THEN
   RAISE EXCEPTION 'escrow_refused:strict_original_stack_and_identity_required';END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(m.participants) x WHERE x->>'user_id'=part->>'user_id'
    AND x->>'seat_id'=part->>'seat_id' AND x->>'occupancy_id'=part->>'occupancy_id'
    AND x->>'seat_joined_at'=part->>'seat_joined_at' AND x->'is_horse'=part->'is_horse' AND x->'stack_before'=part->'stack_before'
    AND x->'funding_lineage'=part->'funding_lineage')<>1
   OR (SELECT count(*) FROM jsonb_array_elements(p.accepted_request->'stacks') x WHERE x->>'user_id'=part->>'user_id'
    AND x->>'seat_id'=part->>'seat_id' AND x->>'occupancy_id'=part->>'occupancy_id'
    AND x->>'seat_joined_at'=part->>'seat_joined_at' AND fn_pnl_evidence_cents(x->'stack_before')=before_stack
    AND fn_pnl_evidence_cents(x->'stack')=after_stack)<>1
   OR (SELECT count(*) FROM jsonb_array_elements(p.atomic_receipt#>'{stack_result,request,stacks}') x WHERE x->>'user_id'=part->>'user_id'
    AND x->>'seat_id'=part->>'seat_id' AND x->>'seat_joined_at'=part->>'seat_joined_at'
    AND fn_pnl_evidence_cents(x->'stack_before')=before_stack AND fn_pnl_evidence_cents(x->'stack')=after_stack)<>1 THEN
   RAISE EXCEPTION 'escrow_refused:signed_original_player_disagrees';END IF;
  lin:=fn_cash_original_funding_lineage((part->>'user_id')::uuid,p_table,(part->>'seat_id')::uuid,(part->>'occupancy_id')::uuid,
   (part->>'seat_joined_at')::timestamptz,(part#>>'{funding_lineage,observed_at}')::timestamptz,false);
  IF lin->'issues' IS DISTINCT FROM '[]'::jsonb OR (lin-'issues') IS DISTINCT FROM ((part->'funding_lineage')-'issues')
   OR part#>'{funding_lineage,issues}' IS DISTINCT FROM (CASE WHEN part->>'user_id'=affected::text THEN '["pending_funding_application_unproven"]'::jsonb ELSE '[]'::jsonb END)
   OR jsonb_array_length(lin->'funding_receipts')=0 THEN RAISE EXCEPTION 'escrow_refused:original_lineage_disagrees';END IF;
  owned:=NULL;refs:=ARRAY[]::uuid[];
  FOR ref IN SELECT x FROM jsonb_array_elements(lin->'funding_receipts') x LOOP
   SELECT * INTO STRICT f FROM cash_participant_funding_receipts WHERE id=(ref->>'id')::uuid;
   IF f.id=ANY(refs) OR f.user_id IS DISTINCT FROM (part->>'user_id')::uuid OR f.account_type IS DISTINCT FROM 'player_wallet'
    OR f.account_entity_id IS DISTINCT FROM f.user_id OR f.funding_club_id IS NULL OR (owned IS NOT NULL AND owned<>f.funding_club_id)
    OR f.funding_union_id::text IS DISTINCT FROM o.game_scope->>'game_union_id' OR f.asset IS DISTINCT FROM 'chips' OR f.unit_scale IS DISTINCT FROM 2
    OR f.amount IS NULL OR f.amount<=0 OR f.amount<>round(f.amount,2) OR f.amount::text IN('NaN','Infinity','-Infinity')
    OR f.balance_before-f.balance_after IS DISTINCT FROM f.amount THEN RAISE EXCEPTION 'escrow_refused:original_wallet_owner_or_debit_disagrees';END IF;
   owned:=f.funding_club_id;refs:=array_append(refs,f.id);
  END LOOP;
  IF (SELECT count(*) FROM cash_participant_funding_receipts WHERE id=ANY(refs) AND operation_kind='buyin')<>1
   OR (SELECT count(*) FROM jsonb_array_elements(o.evidence->'participants') x WHERE x->>'user_id'=part->>'user_id'
    AND x->'is_horse'=part->'is_horse' AND fn_pnl_evidence_cents(x->'observed_stack_delta')=after_stack-before_stack
    AND x->>'ownership_scope'='original_chip_funding_club'
    AND (SELECT array_agg(id ORDER BY id) FROM jsonb_array_elements_text(x->'funding_receipt_ids') t(id))=
        (SELECT array_agg(id::text ORDER BY id::text) FROM unnest(refs) t(id))
    AND CASE WHEN part->>'user_id'=affected::text THEN x->'ownership_certified'='false'::jsonb AND x->'earning_club_id'='null'::jsonb
      ELSE x->'ownership_certified'='true'::jsonb AND x->>'earning_club_id'=owned::text END)<>1 THEN
   RAISE EXCEPTION 'escrow_refused:original_earning_ownership_disagrees';END IF;
  total:=total+after_stack-before_stack;
  proof_people:=proof_people||jsonb_build_array(jsonb_build_object('user_id',part->>'user_id','earning_club_id',owned,'funding_receipt_ids',refs,'poker_delta',after_stack-before_stack));
 END LOOP;
 IF p.signed_external_net IS DISTINCT FROM 0 OR fn_pnl_evidence_cents(p.accepted_request->'inflow') IS DISTINCT FROM 0
  OR p.rake IS NULL OR p.bbj IS NULL OR p.rake<0 OR p.bbj<0 OR total+p.rake+p.bbj IS DISTINCT FROM 0
  OR fn_pnl_evidence_cents(o.evidence->'accepted_rake') IS DISTINCT FROM p.rake
  OR fn_pnl_evidence_cents(o.evidence->'accepted_bbj') IS DISTINCT FROM p.bbj
  OR fn_pnl_evidence_cents(o.evidence->'accepted_external_net') IS DISTINCT FROM p.signed_external_net
  OR fn_pnl_evidence_cents(o.evidence->'observed_delta_total') IS DISTINCT FROM total
  OR fn_pnl_evidence_cents(p.accepted_request->'rake') IS DISTINCT FROM p.rake OR fn_pnl_evidence_cents(p.accepted_request->'bbj') IS DISTINCT FROM p.bbj THEN
  RAISE EXCEPTION 'escrow_refused:original_played_conservation_disagrees';END IF;
 SELECT x INTO STRICT part FROM jsonb_array_elements(p.participants) x WHERE x->>'user_id'=affected::text;
 IF part#>'{funding_lineage,moves}' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'escrow_refused:pending_escrow_moved_occupancy';END IF;
 SELECT pr.* INTO STRICT prev FROM cash_hand_provenance_receipts pr CROSS JOIN LATERAL jsonb_array_elements(pr.participants) x
  WHERE pr.table_id=p_table AND pr.hand_number<p_number AND x->>'occupancy_id'=part->>'occupancy_id' ORDER BY pr.hand_number DESC LIMIT 1;
 SELECT fn_pnl_evidence_cents(x->'stack_after') INTO STRICT prev_stack FROM jsonb_array_elements(prev.participants) x
  WHERE x->>'user_id'=affected::text AND x->>'seat_id'=part->>'seat_id' AND x->>'occupancy_id'=part->>'occupancy_id'
   AND x->>'seat_joined_at'=part->>'seat_joined_at';
 IF prev.accepted_at IS NULL OR NOT isfinite(prev.accepted_at) OR prev.accepted_at>=m.captured_at
  OR prev.game_scope IS DISTINCT FROM o.game_scope OR prev_stack IS DISTINCT FROM fn_pnl_evidence_cents(part->'stack_before')
  OR NOT fn_cash_signed_retained_request_matches(p_table,prev.hand_number,prev.payload_hash,prev.accepted_request)
  OR prev.atomic_receipt->>'hand_id' IS DISTINCT FROM prev.hand_id::text
  OR prev.atomic_receipt->>'payload_hash' IS DISTINCT FROM prev.payload_hash
  OR prev.atomic_receipt->'stack_result'->'success' IS DISTINCT FROM 'true'::jsonb
  OR prev.atomic_receipt->'stack_result'->'conservation_checked' IS DISTINCT FROM 'true'::jsonb
  OR (SELECT count(*) FROM jsonb_array_elements(prev.accepted_request->'stacks') x WHERE x->>'user_id'=affected::text
    AND x->>'seat_id'=part->>'seat_id' AND x->>'occupancy_id'=part->>'occupancy_id'
    AND x->>'seat_joined_at'=part->>'seat_joined_at' AND fn_pnl_evidence_cents(x->'stack')=prev_stack)<>1
  OR (SELECT count(*) FROM jsonb_array_elements(prev.atomic_receipt#>'{stack_result,request,stacks}') x WHERE x->>'user_id'=affected::text
    AND x->>'seat_id'=part->>'seat_id' AND x->>'seat_joined_at'=part->>'seat_joined_at' AND fn_pnl_evidence_cents(x->'stack')=prev_stack)<>1
  OR NOT EXISTS(SELECT 1 FROM union_pnl_cash_outcomes old WHERE old.table_id=p_table AND old.hand_number=prev.hand_number
    AND old.hand_id=prev.hand_id AND old.payload_hash=prev.payload_hash AND old.game_scope=prev.game_scope AND fn_union_pnl_cash_outcome_accepted(old)) THEN
  RAISE EXCEPTION 'escrow_refused:equal_original_accepted_predecessor_required';END IF;
 SELECT r.* INTO STRICT f FROM cash_participant_funding_receipts r WHERE r.occupancy_id=(part->>'occupancy_id')::uuid
  AND r.recorded_at>prev.accepted_at AND r.recorded_at<=m.captured_at;
 SELECT * INTO STRICT app FROM cash_funding_application_receipts WHERE funding_receipt_id=f.id;
 IF f.operation_kind IS DISTINCT FROM 'addon' OR f.pending_addon_id IS NULL OR f.user_id IS DISTINCT FROM affected
  OR f.table_id IS DISTINCT FROM p_table OR f.seat_id::text IS DISTINCT FROM part->>'seat_id'
  OR f.seat_joined_at IS DISTINCT FROM (part->>'seat_joined_at')::timestamptz
  OR app.pending_addon_id IS DISTINCT FROM f.pending_addon_id OR app.original_occupancy_id IS DISTINCT FROM f.occupancy_id
  OR app.applied_occupancy_id IS DISTINCT FROM f.occupancy_id OR app.applied IS DISTINCT FROM f.amount OR app.refunded IS DISTINCT FROM 0
  OR app.transaction_id IS NULL OR app.applied_at IS NULL OR NOT isfinite(app.applied_at)
  OR app.applied_at<=p.accepted_at OR app.applied_at>completed_at
  OR pending_ids IS DISTINCT FROM jsonb_build_array(f.pending_addon_id)
  OR EXISTS(SELECT 1 FROM cash_funding_application_receipts ap JOIN cash_participant_funding_receipts fr ON fr.id=ap.funding_receipt_id
    WHERE fr.occupancy_id=f.occupancy_id AND ap.applied>0 AND ap.applied_at>prev.accepted_at AND ap.applied_at<=m.captured_at) THEN
  RAISE EXCEPTION 'escrow_refused:unplayed_exact_posthand_application_required';END IF;
 SELECT e.* INTO STRICT witness FROM union_pnl_inventory_events e
  WHERE e.transaction_id=app.transaction_id AND e.source_name='table_seats' AND e.row_id=f.seat_id;
 IF witness.operation IS DISTINCT FROM 'UPDATE' OR witness.before_row->>'occupancy_id' IS DISTINCT FROM f.occupancy_id::text
  OR witness.after_row->>'occupancy_id' IS DISTINCT FROM f.occupancy_id::text
  OR witness.before_row->>'user_id' IS DISTINCT FROM affected::text OR witness.after_row->>'user_id' IS DISTINCT FROM affected::text
  OR witness.before_row->>'id' IS DISTINCT FROM f.seat_id::text OR witness.after_row->>'id' IS DISTINCT FROM f.seat_id::text
  OR witness.before_row->>'club_id' IS DISTINCT FROM f.funding_club_id::text OR witness.after_row->>'club_id' IS DISTINCT FROM f.funding_club_id::text
  OR (witness.before_row->>'joined_at')::timestamptz IS DISTINCT FROM f.seat_joined_at
  OR (witness.after_row->>'joined_at')::timestamptz IS DISTINCT FROM f.seat_joined_at
  OR witness.observed_at IS NULL OR NOT isfinite(witness.observed_at) OR witness.observed_at<=p.accepted_at OR witness.observed_at>app.applied_at
  OR witness.before_row->>'table_id' IS DISTINCT FROM p_table::text OR witness.after_row->>'table_id' IS DISTINCT FROM p_table::text
  OR witness.before_row->'left_at' IS DISTINCT FROM 'null'::jsonb OR witness.after_row->'left_at' IS DISTINCT FROM 'null'::jsonb
  OR fn_pnl_evidence_cents(witness.before_row->'stack') IS DISTINCT FROM fn_pnl_evidence_cents(part->'stack_after')
  OR fn_pnl_evidence_cents(witness.after_row->'stack')-fn_pnl_evidence_cents(witness.before_row->'stack') IS DISTINCT FROM f.amount
  OR NOT EXISTS(SELECT 1 FROM union_pnl_transaction_frames fr WHERE fr.transaction_id=app.transaction_id AND fr.observed_at=witness.observed_at) THEN
  RAISE EXCEPTION 'escrow_refused:original_posthand_felt_conservation_required';END IF;
 result:=jsonb_build_object('status','proven','resolution_kind','original_unplayed_escrow_applied_after_signed_hand','table_id',p_table,
  'hand_number',p_number,'hand_id',o.hand_id,'outcome_payload_hash',o.payload_hash,'outcome_evidence_md5',md5(o.evidence::text),
  'pending_funding_receipt',f.id,'pending_addon_id',f.pending_addon_id,'escrow_amount',f.amount,
  'previous_hand',prev.hand_number,'played_stack_before',fn_pnl_evidence_cents(part->'stack_before'),
  'played_stack_after',fn_pnl_evidence_cents(part->'stack_after'),'posthand_stack',fn_pnl_evidence_cents(witness.after_row->'stack'),
  'application_transaction',app.transaction_id::text,'participants',proof_people,'current_membership_used',false,'current_seats_used',false);
 IF retained AND (cert.original->'proof' IS DISTINCT FROM result
  OR cert.original->>'qualified_evidence_sha256' IS DISTINCT FROM encode(extensions.digest(convert_to(smarter_private.posthand_escrow_project_evidence(o.evidence,result)::text,'UTF8'),'sha256'),'hex')) THEN
  RAISE EXCEPTION 'escrow_refused:immutable_original_posthand_proof_disagrees';END IF;
 RETURN result;
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'escrow_refused:%' THEN RETURN jsonb_build_object('status','refused','reason',SQLERRM);END IF;RAISE;
 WHEN no_data_found OR too_many_rows OR invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN
  RETURN jsonb_build_object('status','refused','reason','missing_duplicate_or_malformed_original');
END $function$;
CREATE FUNCTION smarter_private.posthand_escrow_original_snapshot(p_table uuid,p_number bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET TimeZone='UTC'
AS $function$
DECLARE a public.hand_atomic_commits;p public.cash_hand_provenance_receipts;o public.union_pnl_cash_outcomes;proof jsonb;
BEGIN
 SELECT * INTO STRICT a FROM public.hand_atomic_commits WHERE table_id=p_table AND hand_number=p_number;
 SELECT * INTO STRICT p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
 SELECT * INTO STRICT o FROM public.union_pnl_cash_outcomes WHERE table_id=p_table AND hand_number=p_number;
 proof:=public.fn_union_pnl_prove_posthand_escrow(p_table,p_number);
 IF proof->>'status' IS DISTINCT FROM 'proven' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_ORIGINAL_UNPROVEN' USING ERRCODE='55000';END IF;
 RETURN jsonb_build_object('version',1,'table_id',p_table,'hand_number',p_number,'hand_id',a.hand_id,
  'manifest_id',p.manifest_id,'accepted_at',p.accepted_at,'source_financial_request_sha256',p.payload_hash,
  'original_accounting_evidence_sha256',encode(extensions.digest(convert_to(o.evidence::text,'UTF8'),'sha256'),'hex'),
  'qualified_evidence_sha256',encode(extensions.digest(convert_to(smarter_private.posthand_escrow_project_evidence(o.evidence,proof)::text,'UTF8'),'sha256'),'hex'),
  'original_participant_roster_sha256',encode(extensions.digest(convert_to(p.participants::text,'UTF8'),'sha256'),'hex'),
  'immutable_financial_sha256',encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex'),
  'original_atomic_sha256',encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex'),
  'compact_atomic_sha256',encode(extensions.digest(convert_to(smarter_private.horse_cash_compact_atomic(p.atomic_receipt)::text,'UTF8'),'sha256'),'hex'),
  'stack_hand_id',a.stack_result->>'hand_id',
  'original_stack_result_sha256',encode(extensions.digest(convert_to(a.stack_result::text,'UTF8'),'sha256'),'hex'),
  'original_stack_request_sha256',encode(extensions.digest(convert_to((a.stack_result->'request')::text,'UTF8'),'sha256'),'hex'),
  'committed_at',a.committed_at,'completed_at',a.post_commit_completed_at,
  'postcommit_payload_sha256',a.post_commit_payload_hash,'postcommit_request_sha256',a.post_commit_request_hash,
  'postcommit_result_sha256',encode(extensions.digest(convert_to(a.post_commit_result::text,'UTF8'),'sha256'),'hex'),
  'pending_ids',a.post_commit_payload#>'{pending_addons,ids}',
  'proof',proof);
END $function$;
REVOKE ALL ON FUNCTION smarter_private.posthand_escrow_original_snapshot(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.posthand_escrow_certificate_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE original jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_CERTIFICATE_IMMUTABLE' USING ERRCODE='55000';END IF;
 original:=smarter_private.posthand_escrow_original_snapshot(NEW.table_id,NEW.hand_number);
 IF NEW.hand_id::text IS DISTINCT FROM original->>'hand_id' OR NEW.original IS DISTINCT FROM original
  OR NEW.original_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(original::text,'UTF8'),'sha256'),'hex') THEN
  RAISE EXCEPTION 'POSTHAND_ESCROW_EXACT_ORIGINAL_REQUIRED' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.posthand_escrow_certificate_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER posthand_escrow_certificate_immutable BEFORE INSERT OR UPDATE OR DELETE ON smarter_private.posthand_escrow_certificates FOR EACH ROW EXECUTE FUNCTION smarter_private.posthand_escrow_certificate_immutable();
CREATE TRIGGER posthand_escrow_certificate_no_truncate BEFORE TRUNCATE ON smarter_private.posthand_escrow_certificates FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.posthand_escrow_certificate_immutable();
CREATE FUNCTION public.fn_union_pnl_certify_posthand_escrow(p_table uuid,p_number bigint,p_expected_proof_md5 text,p_expected_original_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET TimeZone='UTC'
AS $function$
DECLARE original jsonb;
BEGIN
 IF p_table IS NULL OR p_number IS NULL OR p_number<1 THEN RAISE EXCEPTION 'POSTHAND_ESCROW_INVALID_ORIGINAL_ID' USING ERRCODE='22023';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'POSTHAND_ESCROW_PLATFORM_FROZEN' USING ERRCODE='55000';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('posthand-escrow-original:'||p_table::text||':'||p_number::text,0)) THEN
  RAISE EXCEPTION 'POSTHAND_ESCROW_ORIGINAL_EVENT_OWNED' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.posthand_escrow_certificates WHERE table_id=p_table AND hand_number=p_number) THEN
  RAISE EXCEPTION 'POSTHAND_ESCROW_CERTIFICATE_ALREADY_EXISTS' USING ERRCODE='55000';END IF;
 original:=smarter_private.posthand_escrow_original_snapshot(p_table,p_number);
 IF p_expected_original_sha256 IS NULL OR p_expected_original_sha256!~'^[a-f0-9]{64}$'
  OR encode(extensions.digest(convert_to(original::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p_expected_original_sha256
  OR p_expected_proof_md5 IS NULL OR p_expected_proof_md5!~'^[a-f0-9]{32}$' OR md5((original->'proof')::text) IS DISTINCT FROM p_expected_proof_md5 THEN
  RAISE EXCEPTION 'POSTHAND_ESCROW_EXPECTED_ORIGINAL_PROOF_CHANGED' USING ERRCODE='55000';END IF;
 INSERT INTO smarter_private.posthand_escrow_certificates(table_id,hand_number,hand_id,original,original_sha256)
 VALUES(p_table,p_number,(original->>'hand_id')::uuid,original,encode(extensions.digest(convert_to(original::text,'UTF8'),'sha256'),'hex'));
 RETURN jsonb_build_object('status','certified','table_id',p_table,'hand_number',p_number,'original_sha256',encode(extensions.digest(convert_to(original::text,'UTF8'),'sha256'),'hex'));
END $function$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_certify_posthand_escrow(uuid,bigint,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_certify_posthand_escrow(uuid,bigint,text,text) TO service_role;
CREATE FUNCTION smarter_private.posthand_escrow_certified_evidence(p_table uuid,p_number bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET TimeZone='UTC'
AS $function$
DECLARE o public.union_pnl_cash_outcomes;proof jsonb;projected jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM smarter_private.posthand_escrow_certificates WHERE table_id=p_table AND hand_number=p_number) THEN RETURN NULL;END IF;
 SELECT * INTO o FROM public.union_pnl_cash_outcomes WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND THEN RETURN NULL;END IF;
 proof:=public.fn_union_pnl_prove_posthand_escrow(p_table,p_number);
 IF proof->>'status' IS DISTINCT FROM 'proven' THEN RETURN NULL;END IF;
 projected:=smarter_private.posthand_escrow_project_evidence(o.evidence,proof);
 IF projected->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR projected->'game_scope' IS DISTINCT FROM o.game_scope THEN RETURN NULL;END IF;
 RETURN projected;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.posthand_escrow_certified_evidence(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_cash_outcome_accepted(o public.union_pnl_cash_outcomes)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT o.evidence->'all_players_included' IS NOT DISTINCT FROM 'true'::jsonb
  AND o.evidence->'game_scope' IS NOT DISTINCT FROM o.game_scope
  AND ((o.evidence->>'status' IS NOT DISTINCT FROM 'ready' AND o.evidence->'basis_certified' IS NOT DISTINCT FROM 'true'::jsonb)
   OR EXISTS(SELECT 1 FROM public.union_pnl_cash_outcome_resolutions r WHERE r.table_id=o.table_id AND r.hand_number=o.hand_number
    AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text))
   OR EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes actual
     WHERE actual.table_id=o.table_id AND actual.hand_number=o.hand_number
      AND to_jsonb(actual) IS NOT DISTINCT FROM to_jsonb(o)
      AND smarter_private.posthand_escrow_certified_evidence(o.table_id,o.hand_number) IS NOT NULL))
$function$;
-- Qualified read projection only. Original outcomes and their signed hashes remain immutable.
CREATE OR REPLACE FUNCTION public.fn_union_pnl_posthand_escrow_participants(o public.union_pnl_cash_outcomes)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC'
AS $function$
DECLARE actual public.union_pnl_cash_outcomes; proof jsonb; projected jsonb;
BEGIN
 SELECT * INTO actual FROM public.union_pnl_cash_outcomes q WHERE q.table_id=o.table_id AND q.hand_number=o.hand_number;
 IF NOT FOUND OR to_jsonb(actual) IS DISTINCT FROM to_jsonb(o) THEN RAISE EXCEPTION 'posthand_escrow_projection_original_disagrees' USING ERRCODE='55000';END IF;
 IF smarter_private.posthand_escrow_certified_evidence(o.table_id,o.hand_number) IS NULL THEN RETURN o.evidence->'participants';END IF;
 proof:=public.fn_union_pnl_prove_posthand_escrow(o.table_id,o.hand_number);
 IF proof->>'status' IS DISTINCT FROM 'proven' THEN RETURN o.evidence->'participants';END IF;
 IF proof->>'table_id' IS DISTINCT FROM o.table_id::text OR proof->>'hand_number' IS DISTINCT FROM o.hand_number::text
  OR proof->>'hand_id' IS DISTINCT FROM o.hand_id::text OR proof->>'outcome_payload_hash' IS DISTINCT FROM o.payload_hash
  OR proof->>'outcome_evidence_md5' IS DISTINCT FROM md5(o.evidence::text)
  OR jsonb_array_length(proof->'participants')<>jsonb_array_length(o.evidence->'participants') THEN
  RAISE EXCEPTION 'posthand_escrow_projection_proof_disagrees' USING ERRCODE='55000';END IF;
 SELECT jsonb_agg(original.participant||jsonb_build_object('earning_club_id',p.participant->'earning_club_id','ownership_certified',true) ORDER BY original.n)
 INTO projected FROM jsonb_array_elements(o.evidence->'participants') WITH ORDINALITY original(participant,n)
 JOIN LATERAL jsonb_array_elements(proof->'participants') p(participant) ON p.participant->>'user_id'=original.participant->>'user_id'
  AND public.fn_pnl_evidence_cents(original.participant->'observed_stack_delta')=public.fn_pnl_evidence_cents(p.participant->'poker_delta');
 IF projected IS NULL OR jsonb_array_length(projected)<>jsonb_array_length(o.evidence->'participants') THEN
  RAISE EXCEPTION 'posthand_escrow_projection_original_roster_disagrees' USING ERRCODE='55000';END IF;
 RETURN projected;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_posthand_escrow_touch(h public.union_pnl_cash_outcome_touches)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC'
AS $function$
DECLARE o public.union_pnl_cash_outcomes;
BEGIN
 SELECT q.* INTO o FROM public.union_pnl_cash_outcomes q WHERE q.table_id=h.table_id AND q.hand_number=h.hand_number;
 IF NOT FOUND OR o.recognized_at IS DISTINCT FROM h.recognized_at
  OR o.game_scope->>'game_union_id' IS DISTINCT FROM h.game_union_id
  OR o.evidence->>'accepted_rake' IS DISTINCT FROM h.accepted_rake
  OR o.evidence->'participants' IS DISTINCT FROM h.participants THEN
  RAISE EXCEPTION 'posthand_escrow_projection_touch_disagrees' USING ERRCODE='55000';END IF;
 RETURN public.fn_union_pnl_posthand_escrow_participants(o);
END $function$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_hand_lines(p_union_id uuid,p_start timestamptz,p_end timestamptz,p_projected boolean)
RETURNS TABLE(hand_accepted_rake text,hand_participants jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY SELECT h.accepted_rake,
   CASE WHEN h.shaped AND cert.hand_number IS NOT NULL THEN public.fn_union_pnl_posthand_escrow_touch(h) ELSE h.participants END
   FROM public.union_pnl_cash_outcome_touches h
   LEFT JOIN smarter_private.posthand_escrow_certificates cert ON (cert.table_id,cert.hand_number)=(h.table_id,h.hand_number)
   WHERE h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end;
 ELSE
  RETURN QUERY SELECT o.evidence->>'accepted_rake',
   CASE WHEN cert.hand_number IS NOT NULL THEN public.fn_union_pnl_posthand_escrow_participants(o) ELSE o.evidence->'participants' END
   FROM public.union_pnl_cash_outcomes o
   LEFT JOIN smarter_private.posthand_escrow_certificates cert ON (cert.table_id,cert.hand_number)=(o.table_id,o.hand_number)
   WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end;
 END IF;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_pnl_cash_hand_evidence(p_table_id uuid, p_hand_number bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_posthand_original jsonb; a public.hand_atomic_commits%ROWTYPE; v_live_atomic jsonb; p public.cash_hand_provenance_receipts%ROWTYPE;
 m public.cash_hand_participant_manifests%ROWTYPE; f public.cash_participant_funding_receipts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; app public.cash_funding_application_receipts%ROWTYPE;
 v_lineage jsonb; v_lineage_at timestamptz; x jsonb; y jsonb; submitted jsonb; original jsonb; ref jsonb; v_request jsonb; v_stack_hand uuid; v_people jsonb:='[]';
 v_issues jsonb:='[]'; v_seen uuid[]:=ARRAY[]::uuid[]; v_funding_seen uuid[];
 v_user uuid; v_club uuid; v_account jsonb; v_funding_account jsonb;
 v_before numeric; v_after numeric; v_delta numeric:=0; v_rake numeric; v_bbj numeric; v_inflow numeric;
 v_initial integer; v_owned boolean; v_population boolean:=false;
BEGIN
 v_posthand_original:=smarter_private.posthand_escrow_certified_evidence(p_table_id,p_hand_number);
 IF v_posthand_original IS NOT NULL THEN RETURN v_posthand_original;END IF;
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','basis_certified',false,
  'all_players_included',false,'reason','original_cash_provenance_missing'); END IF;
 IF jsonb_typeof(p.atomic_receipt) IS DISTINCT FROM 'object'
  OR p.atomic_receipt->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.atomic_receipt->>'hand_number' IS DISTINCT FROM p_hand_number::text THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','retained_atomic_receipt_missing'); END IF;
 SELECT * INTO a FROM jsonb_populate_record(NULL::public.hand_atomic_commits,p.atomic_receipt);
 SELECT to_jsonb(live) INTO v_live_atomic FROM public.hand_atomic_commits live
  WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF FOUND AND NOT smarter_private.horse_cash_retained_atomic_matches(p_table_id,p_hand_number,p.atomic_receipt,v_live_atomic,p.accepted_request) THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','live_atomic_receipt_conflicts_with_original'); END IF;
 v_request:=a.stack_result->'request';
 IF a.committed_at IS NULL OR NOT isfinite(a.committed_at)
  OR a.stack_result->'success' IS DISTINCT FROM 'true'::jsonb
  OR a.stack_result->>'mode' IS DISTINCT FROM 'delta'
  OR jsonb_typeof(v_request->'stacks') IS DISTINCT FROM 'array'
  OR NOT a.stack_result ? 'tournament_id' OR a.stack_result->'tournament_id' IS DISTINCT FROM 'null'::jsonb THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','accepted_cash_delta_request_missing');
 END IF;
 IF p.version<>1 OR p.hand_id IS DISTINCT FROM a.hand_id OR p.payload_hash IS DISTINCT FROM a.payload_hash
  OR p.accepted_at IS NULL OR NOT isfinite(p.accepted_at) OR p.accepted_at<a.committed_at
  OR jsonb_typeof(p.accepted_request) IS DISTINCT FROM 'object'
  OR p.accepted_request->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.accepted_request->>'hand_number' IS DISTINCT FROM p_hand_number::text
  OR NOT smarter_private.horse_cash_retained_request_matches(p_table_id,p_hand_number,a.payload_hash,p.accepted_request)
  OR jsonb_typeof(p.accepted_request->'stacks') IS DISTINCT FROM 'array'
  OR p.manifest_id IS NULL OR jsonb_typeof(p.participants) IS DISTINCT FROM 'array'
  OR jsonb_typeof(p.issues) IS DISTINCT FROM 'array' THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','accepted_cash_provenance_link_missing');
 END IF;
 SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id;
 IF NOT FOUND OR m.table_id IS DISTINCT FROM p_table_id OR m.hand_number IS DISTINCT FROM p_hand_number
  OR m.captured_at IS NULL OR NOT isfinite(m.captured_at) OR m.captured_at>p.accepted_at
  OR m.game_scope IS DISTINCT FROM p.game_scope OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array'
  OR jsonb_array_length(m.participants)<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.participants)<>jsonb_array_length(v_request->'stacks')
  OR jsonb_array_length(p.participants)<>jsonb_array_length(p.accepted_request->'stacks')
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(v_request->'stacks'))<>jsonb_array_length(p.participants)
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(p.accepted_request->'stacks'))<>jsonb_array_length(p.participants)
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(m.participants))<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.participants)<2 OR jsonb_array_length(p.participants)>10
  OR p.all_players_included IS DISTINCT FROM true THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','original_cash_population_link_missing');
 END IF;
 v_stack_hand:=(a.stack_result->>'hand_id')::uuid;
 IF p.stack_claim->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.stack_claim->>'hand_id' IS DISTINCT FROM v_stack_hand::text
  OR p.stack_claim->>'status' IS DISTINCT FROM 'succeeded'
  OR (p.stack_claim->>'completed_at') IS NULL OR p.stack_claim->'result' IS DISTINCT FROM a.stack_result
  OR p.stack_settlement->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.stack_settlement->>'hand_id' IS DISTINCT FROM v_stack_hand::text
  OR p.stack_settlement->>'settlement_type' IS DISTINCT FROM 'hand_stacks'
  OR p.stack_settlement->>'state' IS DISTINCT FROM 'final'
  OR EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k WHERE k.table_id=p_table_id AND k.hand_id=v_stack_hand
    AND (k.status IS DISTINCT FROM 'succeeded' OR smarter_private.horse_settlement_original_result(k.table_id,k.hand_id,k.result) IS DISTINCT FROM a.stack_result OR k.completed_at IS NULL))
  OR EXISTS(SELECT 1 FROM public.ca_settlements c WHERE c.table_id=p_table_id AND c.hand_id=v_stack_hand
    AND c.settlement_type='hand_stacks' AND c.state IS DISTINCT FROM 'final') THEN
  v_issues:=v_issues||'"accepted_stack_receipt_link_missing"'::jsonb;
 END IF;
 IF p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS DISTINCT FROM true
  OR m.funding_provenance_complete IS DISTINCT FROM true OR p.issues<>'[]'::jsonb OR m.issues<>'[]'::jsonb THEN
  v_issues:=v_issues||'"original_cash_funding_incomplete"'::jsonb||p.issues;
 END IF;
 IF jsonb_typeof(p.game_scope) IS DISTINCT FROM 'object'
  OR NOT p.game_scope ?& ARRAY['host_club_id','game_union_id','is_private','tournament_id','asset','unit_scale']
  OR p.game_scope->>'asset' IS DISTINCT FROM 'chips' OR p.game_scope->'unit_scale' IS DISTINCT FROM '2'::jsonb
  OR p.game_scope->'tournament_id' IS DISTINCT FROM 'null'::jsonb
  OR jsonb_typeof(p.game_scope->'is_private') IS DISTINCT FROM 'boolean'
  OR (p.game_scope->'is_private'='true'::jsonb AND p.game_scope->'game_union_id' IS DISTINCT FROM 'null'::jsonb)
  OR (p.game_scope->'is_private'='false'::jsonb AND (p.game_scope->>'game_union_id') IS NULL) THEN
  v_issues:=v_issues||'"historical_game_asset_and_union_receipt_invalid"'::jsonb;
 END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p.participants) LOOP
  v_user:=(x->>'user_id')::uuid;
  SELECT value INTO y FROM jsonb_array_elements(v_request->'stacks') WHERE value->>'user_id'=x->>'user_id';
  SELECT value INTO submitted FROM jsonb_array_elements(p.accepted_request->'stacks') WHERE value->>'user_id'=x->>'user_id';
  SELECT value INTO original FROM jsonb_array_elements(m.participants) WHERE value->>'user_id'=x->>'user_id';
  v_before:=public.fn_pnl_evidence_cents(x->'stack_before'); v_after:=public.fn_pnl_evidence_cents(x->'stack_after');
  IF v_user IS NULL OR v_user=ANY(v_seen) OR y IS NULL OR original IS NULL
   OR submitted IS NULL OR original IS DISTINCT FROM (x-'stack_after'-'poker_delta')
   OR v_before IS NULL OR v_after IS NULL OR v_before<0 OR v_after<0
   OR public.fn_pnl_evidence_cents(x->'poker_delta') IS DISTINCT FROM v_after-v_before
   OR public.fn_pnl_evidence_cents(y->'stack_before') IS DISTINCT FROM v_before
   OR public.fn_pnl_evidence_cents(y->'stack') IS DISTINCT FROM v_after
   OR y->>'seat_id' IS DISTINCT FROM x->>'seat_id'
   OR public.fn_pnl_evidence_cents(submitted->'stack_before') IS DISTINCT FROM v_before
   OR public.fn_pnl_evidence_cents(submitted->'stack') IS DISTINCT FROM v_after
   OR submitted->>'seat_id' IS DISTINCT FROM x->>'seat_id'
   OR submitted->>'occupancy_id' IS DISTINCT FROM x->>'occupancy_id'
   OR (submitted->>'seat_joined_at')::timestamptz IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz
   OR (y->>'seat_joined_at')::timestamptz IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz
   OR submitted->>'funding_manifest_id' IS DISTINCT FROM p.manifest_id::text THEN
   RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
    'reason','original_cash_participant_mismatch');
  END IF;
  v_seen:=array_append(v_seen,v_user); v_delta:=v_delta+v_after-v_before;
  v_owned:=true; v_initial:=0; v_club:=NULL; v_account:=NULL; v_funding_seen:=ARRAY[]::uuid[];
  v_lineage:=NULL;
  IF x ? 'funding_lineage' THEN
   v_lineage_at:=(x#>>'{funding_lineage,observed_at}')::timestamptz;
   IF v_lineage_at IS NULL OR NOT isfinite(v_lineage_at) OR v_lineage_at>m.captured_at THEN v_owned:=false; END IF;
   v_lineage:=public.fn_cash_original_funding_lineage(v_user,p_table_id,(x->>'seat_id')::uuid,
    (x->>'occupancy_id')::uuid,(x->>'seat_joined_at')::timestamptz,v_lineage_at,false);
   IF v_lineage IS DISTINCT FROM x->'funding_lineage' OR v_lineage->'issues'<>'[]'::jsonb
    OR v_lineage->'funding_receipts' IS DISTINCT FROM x->'funding_receipts' THEN v_owned:=false; END IF;
  END IF;
  IF jsonb_typeof(x->'funding_receipts') IS DISTINCT FROM 'array'  OR x->'funding_receipts'='[]'::jsonb THEN
   v_owned:=false;
  ELSE
   FOR ref IN SELECT value FROM jsonb_array_elements(x->'funding_receipts') LOOP
    SELECT * INTO f FROM public.cash_participant_funding_receipts WHERE id=(ref->>'id')::uuid;
    IF NOT FOUND THEN v_owned:=false; CONTINUE; END IF;
    IF f.id=ANY(v_funding_seen) THEN v_owned:=false; END IF;
    v_funding_seen:=array_append(v_funding_seen,f.id);
    v_funding_account:=jsonb_build_array(f.funding_club_id,f.funding_union_id,f.asset);
    IF v_account IS NULL THEN v_account:=v_funding_account; v_club:=f.funding_club_id;
    ELSIF v_account IS DISTINCT FROM v_funding_account THEN v_owned:=false; END IF;
    IF f.operation_kind='buyin' THEN v_initial:=v_initial+1; END IF;
    IF f.user_id IS DISTINCT FROM v_user OR (v_lineage IS NULL AND (f.table_id IS DISTINCT FROM p_table_id
     OR f.seat_id::text IS DISTINCT FROM x->>'seat_id' OR f.occupancy_id::text IS DISTINCT FROM x->>'occupancy_id'
     OR f.seat_joined_at IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz))
     OR f.recorded_at>m.captured_at OR NOT isfinite(f.recorded_at) OR f.asset<>'chips' OR f.unit_scale<>2
     OR f.account_type IS DISTINCT FROM ref->>'account_type'
     OR f.account_entity_id::text IS DISTINCT FROM ref->>'account_entity_id'
     OR f.funding_club_id::text IS DISTINCT FROM ref->>'funding_club_id'
     OR f.funding_union_id::text IS DISTINCT FROM ref->>'funding_union_id'
     OR f.pending_addon_id::text IS DISTINCT FROM ref->>'pending_addon_id'
     OR f.amount<=0 OR f.amount<>round(f.amount,2) OR f.amount::text IN ('NaN','Infinity','-Infinity')
     OR f.balance_before-f.balance_after IS DISTINCT FROM f.amount THEN v_owned:=false; END IF;
    SELECT * INTO l FROM public.chip_ledger WHERE id=f.source_ledger_id;
    IF NOT FOUND OR l.status IS DISTINCT FROM 'posted' OR l.club_id IS DISTINCT FROM f.funding_club_id
     OR l.from_type IS DISTINCT FROM f.account_type OR l.from_entity_id IS DISTINCT FROM f.account_entity_id
     OR l.to_type IS DISTINCT FROM 'table_stack' OR l.to_entity_id IS DISTINCT FROM f.table_id
     OR l.category IS DISTINCT FROM f.operation_kind OR l.amount IS DISTINCT FROM f.amount THEN v_owned:=false; END IF;
    IF f.pending_addon_id IS NOT NULL THEN
     SELECT * INTO app FROM public.cash_funding_application_receipts WHERE pending_addon_id=f.pending_addon_id;
     IF NOT FOUND OR app.funding_receipt_id IS DISTINCT FROM f.id OR app.original_occupancy_id IS DISTINCT FROM f.occupancy_id
      OR NOT isfinite(app.applied_at) OR app.applied+app.refunded IS DISTINCT FROM f.amount
      OR (app.applied>0 AND app.applied_occupancy_id IS DISTINCT FROM f.occupancy_id) THEN v_owned:=false; END IF;
    END IF;
   END LOOP;
  END IF;
  IF v_initial<>1 THEN v_owned:=false; END IF;
  IF NOT v_owned THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','participant_earning_ownership_receipt_invalid','user_id',v_user)); END IF;
  v_people:=v_people||jsonb_build_array(jsonb_build_object('user_id',v_user,'is_horse',x->'is_horse',
   'observed_stack_delta',v_after-v_before,'earning_club_id',CASE WHEN v_owned THEN v_club ELSE NULL END,
   'ownership_certified',v_owned,'ownership_scope','original_chip_funding_club','funding_receipt_ids',to_jsonb(v_funding_seen)));
 END LOOP;
 v_population:=true;
 v_rake:=public.fn_pnl_evidence_cents(v_request->'rake'); v_bbj:=public.fn_pnl_evidence_cents(v_request->'bbj');
 v_inflow:=public.fn_pnl_evidence_cents(v_request->'inflow');
 IF v_request->'rake'='null'::jsonb THEN v_rake:=0; END IF;
 IF v_request->'bbj'='null'::jsonb THEN v_bbj:=0; END IF;
 IF v_request->'inflow'='null'::jsonb THEN v_inflow:=0; END IF;
 IF v_rake IS NULL OR v_bbj IS NULL OR v_inflow IS NULL OR v_rake<0 OR v_bbj<0
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'rake','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_rake
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'bbj','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_bbj
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'inflow','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_inflow
  OR v_rake IS DISTINCT FROM p.rake OR v_bbj IS DISTINCT FROM p.bbj OR v_inflow IS DISTINCT FROM p.signed_external_net THEN
  v_issues:=v_issues||'"hand_conservation_inputs_missing"'::jsonb;
 ELSIF v_delta+v_rake+v_bbj<>v_inflow THEN v_issues:=v_issues||'"hand_delta_conservation_mismatch"'::jsonb;
 END IF;
 -- Signed insurance/external movements conserve but need their own bank linkage.
 IF v_inflow<>0 THEN v_issues:=v_issues||'"external_bank_receipt_not_certified"'::jsonb; END IF;
 RETURN jsonb_build_object('status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
  'basis_certified',v_issues='[]'::jsonb,'scope','single_accepted_cash_hand','payment_authorized',false,
  'hand_id',a.hand_id,'table_id',p_table_id,'hand_number',p_hand_number,'observed_commit_at',a.committed_at,
  'observed_delta_total',v_delta,'participants',v_people,'issues',v_issues,'game_scope',p.game_scope,
  'current_seats_used',false,'current_membership_used',false,'all_players_included',v_population);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,'reason','malformed_original_cash_evidence');
END $function$
;
REVOKE ALL ON FUNCTION public.fn_union_pnl_prove_posthand_escrow(uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_prove_posthand_escrow(uuid,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_posthand_escrow_participants(public.union_pnl_cash_outcomes),public.fn_union_pnl_posthand_escrow_touch(public.union_pnl_cash_outcome_touches),public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean),public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) TO service_role;
DO $postimages$
BEGIN
 IF md5(pg_get_functiondef('public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure)) IS DISTINCT FROM '865391e842ed009b45ec7727efe7e85b' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_POSTIMAGE_CHANGED: public.fn_pnl_cash_hand_evidence(uuid,bigint)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_prove_posthand_escrow(uuid,bigint)'::regprocedure)) IS DISTINCT FROM 'c0554046c74ab6997805d312c1848c76' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_POSTIMAGE_CHANGED: public.fn_union_pnl_prove_posthand_escrow(uuid,bigint)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('smarter_private.posthand_escrow_certificate_immutable()'::regprocedure)) IS DISTINCT FROM '14b1ddb37d4e3e83a9a42a34438e4b6e' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_POSTIMAGE_CHANGED: smarter_private.posthand_escrow_certificate_immutable()' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)'::regprocedure)) IS DISTINCT FROM 'f1d7fbfbe0bcebb63579b19bc3143a95' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_POSTIMAGE_CHANGED: public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_certify_posthand_escrow(uuid,bigint,text,text)'::regprocedure)) IS DISTINCT FROM 'bda800236c5847110d78003a41bf45dd' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_POSTIMAGE_CHANGED: public.fn_union_pnl_certify_posthand_escrow(uuid,bigint,text,text)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('smarter_private.posthand_escrow_project_evidence(jsonb,jsonb)'::regprocedure)) IS DISTINCT FROM '95ef5461c27ea58c3ff77e6f8d47df88' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_POSTIMAGE_CHANGED: smarter_private.posthand_escrow_project_evidence(jsonb,jsonb)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('smarter_private.posthand_escrow_original_snapshot(uuid,bigint)'::regprocedure)) IS DISTINCT FROM 'bc7c33d508a74b028f3614ba2d3d7c6d' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_POSTIMAGE_CHANGED: smarter_private.posthand_escrow_original_snapshot(uuid,bigint)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('smarter_private.posthand_escrow_certified_evidence(uuid,bigint)'::regprocedure)) IS DISTINCT FROM '4484361142c05fcc70437b8d7a2b1407' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_POSTIMAGE_CHANGED: smarter_private.posthand_escrow_certified_evidence(uuid,bigint)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_posthand_escrow_participants(union_pnl_cash_outcomes)'::regprocedure)) IS DISTINCT FROM '2db7263f8d42e2e0e5a45b42b7198e4d' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_POSTIMAGE_CHANGED: public.fn_union_pnl_posthand_escrow_participants(union_pnl_cash_outcomes)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_posthand_escrow_touch(union_pnl_cash_outcome_touches)'::regprocedure)) IS DISTINCT FROM 'ea07d6fa0e981ae635e6c5a6f8aeb067' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_POSTIMAGE_CHANGED: public.fn_union_pnl_posthand_escrow_touch(union_pnl_cash_outcome_touches)' USING ERRCODE='55000';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)'::regprocedure)) IS DISTINCT FROM '0c69388b1406858f3bed04f54639fab6' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_POSTIMAGE_CHANGED: public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef=true AND proconfig=ARRAY['search_path=public, pg_temp'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_AUTHORITY_CHANGED: public.fn_pnl_cash_hand_evidence(uuid,bigint)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_prove_posthand_escrow(uuid,bigint)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef=true AND proconfig=ARRAY['search_path=public, pg_temp','TimeZone=UTC'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_AUTHORITY_CHANGED: public.fn_union_pnl_prove_posthand_escrow(uuid,bigint)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.posthand_escrow_certificate_immutable()'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef=true AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'] AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_AUTHORITY_CHANGED: smarter_private.posthand_escrow_certificate_immutable()' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef=false AND proconfig=ARRAY['search_path=public, pg_temp'] AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_AUTHORITY_CHANGED: public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_certify_posthand_escrow(uuid,bigint,text,text)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef=true AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private','TimeZone=UTC'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_AUTHORITY_CHANGED: public.fn_union_pnl_certify_posthand_escrow(uuid,bigint,text,text)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.posthand_escrow_project_evidence(jsonb,jsonb)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef=false AND proconfig=ARRAY['search_path=pg_catalog'] AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_AUTHORITY_CHANGED: smarter_private.posthand_escrow_project_evidence(jsonb,jsonb)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.posthand_escrow_original_snapshot(uuid,bigint)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef=true AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private','TimeZone=UTC'] AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_AUTHORITY_CHANGED: smarter_private.posthand_escrow_original_snapshot(uuid,bigint)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.posthand_escrow_certified_evidence(uuid,bigint)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef=true AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private','TimeZone=UTC'] AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_AUTHORITY_CHANGED: smarter_private.posthand_escrow_certified_evidence(uuid,bigint)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_posthand_escrow_participants(union_pnl_cash_outcomes)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef=true AND proconfig=ARRAY['search_path=public, pg_temp','TimeZone=UTC'] AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_AUTHORITY_CHANGED: public.fn_union_pnl_posthand_escrow_participants(union_pnl_cash_outcomes)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_posthand_escrow_touch(union_pnl_cash_outcome_touches)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef=true AND proconfig=ARRAY['search_path=public, pg_temp','TimeZone=UTC'] AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_AUTHORITY_CHANGED: public.fn_union_pnl_posthand_escrow_touch(union_pnl_cash_outcome_touches)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND prosecdef=true AND proconfig=ARRAY['search_path=public, pg_temp'] AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_SOURCE_AUTHORITY_CHANGED: public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='smarter_private.posthand_escrow_certificates'::regclass AND relrowsecurity AND relowner='postgres'::regrole AND relacl::text='{postgres=arwdDxtm/postgres}') THEN RAISE EXCEPTION 'POSTHAND_ESCROW_PRIVATE_AUTHORITY_CHANGED' USING ERRCODE='55000';END IF;
END $postimages$;
COMMIT;

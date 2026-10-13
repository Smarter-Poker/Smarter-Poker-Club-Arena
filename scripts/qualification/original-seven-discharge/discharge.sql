-- Finite original seven cash bases only. Existing cashier/mint writers remain unchanged.
-- Historical receivable is owed at 2026-10-12 07Z. Discharge is current issuance
-- followed by canonical deleted-account bank custody; it is never backdated.
CREATE TABLE smarter_private.original_erased_cash_base_discharges (
 event_id bigint PRIMARY KEY, witness_md5 text NOT NULL,
 occupancy_id uuid NOT NULL UNIQUE, user_id uuid NOT NULL, funding_club_id uuid NOT NULL,
 base_cents bigint NOT NULL CHECK(base_cents>0), restoration_key text NOT NULL UNIQUE,
 discharged_at timestamptz NOT NULL CHECK(discharged_at>'2026-10-12 07:00Z'),
 evidence jsonb NOT NULL, evidence_md5 text NOT NULL CHECK(evidence_md5=md5(evidence::text)),
 CHECK(restoration_key='retired_completed_cash_base:'||occupancy_id::text),
 CHECK(witness_md5 ~ '^[0-9a-f]{32}$')
);
ALTER TABLE smarter_private.original_erased_cash_base_discharges OWNER TO postgres;
ALTER TABLE smarter_private.original_erased_cash_base_discharges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.original_erased_cash_base_discharges FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.original_erased_cash_base_discharge_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $b$
BEGIN RAISE EXCEPTION 'original_cash_discharge_is_immutable' USING ERRCODE='55000';END$b$;
REVOKE ALL ON FUNCTION smarter_private.original_erased_cash_base_discharge_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_cash_discharge_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
ON smarter_private.original_erased_cash_base_discharges FOR EACH STATEMENT
EXECUTE FUNCTION smarter_private.original_erased_cash_base_discharge_immutable();

-- Literal original monetary witnesses, separate from the case's scope additions.
CREATE FUNCTION smarter_private.original_erased_cash_base_expected_hash(e bigint)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $b$
 SELECT CASE e
 WHEN 42309154 THEN 'dcc2248b35d55e8c3239044f5e5e2869'
 WHEN 42346932 THEN '4a806deeace376da57411d584cc90491'
 WHEN 42399949 THEN '2d6149ab417c6ade798d2aae7a7f7af1'
 WHEN 42407664 THEN '6463819644005aba4cc1817b20f9f21d'
 WHEN 42586570 THEN 'ca1904c2f019f5ec7864b113c2119db6'
 WHEN 42607253 THEN 'd4e0d142973bc8f8226ece46950e13c0'
 WHEN 42626673 THEN '503edc03d357862da655c3867b51240c' END
$b$;
REVOKE ALL ON FUNCTION smarter_private.original_erased_cash_base_expected_hash(bigint) FROM PUBLIC,anon,authenticated,service_role;

-- This reader judges retained financial rows, not current wallet balances.
-- Subsequent legitimate bank business must not invalidate an immutable discharge.
CREATE FUNCTION smarter_private.original_erased_cash_base_discharge_receipt(e bigint,h text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $b$
DECLARE c record;r jsonb;f jsonb;p jsonb;s jsonb;v record;n integer;refs jsonb;
BEGIN
 IF h IS NULL OR h IS DISTINCT FROM smarter_private.original_erased_cash_base_expected_hash(e) THEN
 RETURN jsonb_build_object('status','blocked','reason','unknown_original_cash_discharge');END IF;
 r:=smarter_private.original_erased_cash_base_request(e,h);
 IF r->>'status' IS DISTINCT FROM 'ready' OR r->'financial_admission' IS DISTINCT FROM 'false'::jsonb
 OR r->>'witness_md5' IS DISTINCT FROM h OR md5((r->'witness')::text) IS DISTINCT FROM h
 OR md5((r->'proof')::text) IS DISTINCT FROM r->>'proof_md5' THEN
 RETURN jsonb_build_object('status','blocked','reason','original_cash_source_changed');END IF;
 f:=r->'witness';p:=r->'proof';
 SELECT * INTO c FROM smarter_private.original_erased_cash_base_discharges WHERE event_id=e;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','pending','event_id',e);END IF;
 s:=c.evidence;
 IF c.witness_md5 IS DISTINCT FROM h OR c.evidence_md5 IS DISTINCT FROM md5(s::text)
 OR c.user_id::text IS DISTINCT FROM p#>>'{holding,user_id}'
 OR c.funding_club_id::text IS DISTINCT FROM p#>>'{holding,club_id}'
 OR c.base_cents IS DISTINCT FROM ((p->>'original_base')::numeric*100)::bigint
 OR c.occupancy_id::text IS DISTINCT FROM f#>>'{signed,occupancy_id}'
 OR s->>'restoration_key' IS DISTINCT FROM c.restoration_key
 OR (s->>'discharged_at')::timestamptz IS DISTINCT FROM c.discharged_at
 OR s->>'custody' IS DISTINCT FROM 'canonical_deleted_account_bank'
 OR s->'final_player_wallet' IS DISTINCT FROM '0'::jsonb THEN
 RETURN jsonb_build_object('status','blocked','reason','original_cash_certificate_changed');END IF;
 refs:=s->'financial_refs';
 IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs) IS DISTINCT FROM 6
 OR (SELECT count(DISTINCT jsonb_build_array(x->>'kind',x->>'id')) FROM jsonb_array_elements(refs)x)<>6 THEN
 RETURN jsonb_build_object('status','blocked','reason','original_cash_financial_refs_refused');END IF;
 FOR v IN SELECT value ref FROM jsonb_array_elements(refs) LOOP
 IF v.ref->>'md5' IS NULL OR v.ref->>'md5' !~ '^[0-9a-f]{32}$'
 OR smarter_private.original_inventory_source_ref_md5(v.ref) IS DISTINCT FROM v.ref->>'md5' THEN
 RETURN jsonb_build_object('status','blocked','reason','original_cash_financial_rows_changed');END IF;
 END LOOP;
 IF NOT smarter_private.original_erased_cash_base_discharge_evidence_valid(e,h,s) THEN RETURN jsonb_build_object('status','blocked','reason','original_cash_financial_association_refused');END IF;
 RETURN s||jsonb_build_object('status','discharged','event_id',e,'witness_md5',h,'evidence_md5',c.evidence_md5);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RETURN jsonb_build_object('status','blocked','reason','malformed_original_cash_discharge');
END$b$;
REVOKE ALL ON FUNCTION smarter_private.original_erased_cash_base_discharge_receipt(bigint,text) FROM PUBLIC,anon,authenticated,service_role;

-- INSERT is guarded too: operator ownership is not originality authority.
-- Every exported field is recomputed from the current source-qualified request
-- and the six exact immutable financial rows, including their associations.
CREATE FUNCTION smarter_private.original_erased_cash_base_discharge_evidence_valid(e bigint,h text,s jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $b$
DECLARE r jsonb;f jsonb;p jsonb;k text;u uuid;club uuid;occ uuid;tbl uuid;a numeric;
 mt record;il record;cl record;bt record;ct record;ik record;refs jsonb;at_time timestamptz;n integer;
BEGIN
 IF s IS NULL OR jsonb_typeof(s) IS DISTINCT FROM 'object' OR NOT(s ?& ARRAY['status','event_id','custody','occupancy_id','user_id','funding_club_id','base_cents','amount','restoration_key','discharged_at','mint_id','issuance_leg_id','base_credit_transaction_id','bank_claim_leg_id','bank_claim_transaction_id','bank_claim_operation_id','final_player_wallet','bank_increment','bank_before','bank_after','bank_owner_id','preserved_played_delta','financial_refs']) OR s-ARRAY['status','event_id','custody','occupancy_id','user_id','funding_club_id','base_cents','amount','restoration_key','discharged_at','mint_id','issuance_leg_id','base_credit_transaction_id','bank_claim_leg_id','bank_claim_transaction_id','bank_claim_operation_id','final_player_wallet','bank_increment','bank_before','bank_after','bank_owner_id','preserved_played_delta','financial_refs'] IS DISTINCT FROM '{}'::jsonb OR h IS NULL
 OR h IS DISTINCT FROM smarter_private.original_erased_cash_base_expected_hash(e) THEN RETURN false;END IF;
 r:=smarter_private.original_erased_cash_base_request(e,h);
 IF r->>'status' IS DISTINCT FROM 'ready' OR r->'financial_admission' IS DISTINCT FROM 'false'::jsonb
 OR r->>'witness_md5' IS DISTINCT FROM h OR md5((r->'witness')::text) IS DISTINCT FROM h THEN RETURN false;END IF;
 f:=r->'witness';p:=smarter_private.original_erased_cash_base_proof(f,'2026-10-12 07:00Z');
 IF p IS DISTINCT FROM r->'proof' OR p->>'status' IS DISTINCT FROM 'ready' THEN RETURN false;END IF;
 u:=(p#>>'{holding,user_id}')::uuid;club:=(p#>>'{holding,club_id}')::uuid;
 occ:=(f#>>'{signed,occupancy_id}')::uuid;tbl:=(f#>>'{event,before_row,table_id}')::uuid;
 a:=(p->>'original_base')::numeric;k:='retired_completed_cash_base:'||occ;
 at_time:=(s->>'discharged_at')::timestamptz;
 IF at_time IS NULL OR NOT isfinite(at_time) OR at_time<='2026-10-12 07:00Z'
 OR s->>'status' IS DISTINCT FROM 'discharged' OR (s->>'event_id')::bigint IS DISTINCT FROM e
 OR s->>'custody' IS DISTINCT FROM 'canonical_deleted_account_bank'
 OR s->>'user_id' IS DISTINCT FROM u::text OR s->>'funding_club_id' IS DISTINCT FROM club::text
 OR s->>'occupancy_id' IS DISTINCT FROM occ::text OR s->>'restoration_key' IS DISTINCT FROM k
 OR (s->>'base_cents')::bigint IS DISTINCT FROM (a*100)::bigint
 OR (s->>'amount')::numeric IS DISTINCT FROM a OR (s->>'bank_increment')::numeric IS DISTINCT FROM a
 OR (s->>'bank_after')::numeric-(s->>'bank_before')::numeric IS DISTINCT FROM a
 OR s->'final_player_wallet' IS DISTINCT FROM '0'::jsonb
 OR s->'preserved_played_delta' IS DISTINCT FROM p->'preserved_played_delta' THEN RETURN false;END IF;
 SELECT count(*) INTO n FROM public.ca_mint_ledger WHERE op_id=k;
 IF n<>1 THEN RETURN false;END IF;
 SELECT * INTO mt FROM public.ca_mint_ledger WHERE op_id=k;
 SELECT count(*) INTO n FROM public.chip_ledger WHERE idempotency_key=k;
 IF n<>1 THEN RETURN false;END IF;
 SELECT * INTO il FROM public.chip_ledger WHERE idempotency_key=k;
 SELECT * INTO ik FROM public.wallet_credit_idempotency WHERE key=k;
 IF NOT FOUND OR ik.user_id IS DISTINCT FROM u OR ik.amount IS DISTINCT FROM a THEN RETURN false;END IF;
 SELECT * INTO ct FROM public.chip_transactions WHERE id=(s->>'base_credit_transaction_id')::uuid;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO bt FROM public.chip_transactions WHERE id=(s->>'bank_claim_transaction_id')::uuid;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT count(*) INTO n FROM public.chip_ledger WHERE idempotency_key='deleted_account_bank_return:'||(bt.metadata->>'op_id');
 IF n<>1 THEN RETURN false;END IF;
 SELECT * INTO cl FROM public.chip_ledger WHERE idempotency_key='deleted_account_bank_return:'||(bt.metadata->>'op_id');
 IF mt.id::text IS DISTINCT FROM s->>'mint_id' OR mt.chip_ledger_id IS DISTINCT FROM il.id
 OR mt.holder_id IS DISTINCT FROM u OR mt.holder_type IS DISTINCT FROM 'player'
 OR mt.action IS DISTINCT FROM 'mint' OR mt.asset IS DISTINCT FROM 'chips' OR mt.amount IS DISTINCT FROM a
 OR mt.balance_after-mt.balance_before IS DISTINCT FROM a OR mt.created_at IS DISTINCT FROM at_time
 OR il.id::text IS DISTINCT FROM s->>'issuance_leg_id' OR il.amount IS DISTINCT FROM a
 OR il.club_id IS DISTINCT FROM club OR il.to_entity_id IS DISTINCT FROM u
 OR il.from_type IS DISTINCT FROM 'issuance_reserve' OR il.to_type IS DISTINCT FROM 'player_wallet'
 OR il.category IS DISTINCT FROM 'refund' OR il.created_at IS DISTINCT FROM at_time
 OR ct.to_user_id IS DISTINCT FROM u OR ct.club_id IS DISTINCT FROM club OR ct.table_id IS DISTINCT FROM tbl
 OR ct.amount IS DISTINCT FROM a OR ct.transaction_type IS DISTINCT FROM 'seat_credit_restored'
 OR ct.metadata->>'restore_key' IS DISTINCT FROM k OR ct.metadata->>'source' IS DISTINCT FROM 'issuance_reserve'
 OR ct.created_at IS DISTINCT FROM at_time OR ct.balance_after IS DISTINCT FROM a
 OR bt.to_user_id::text IS DISTINCT FROM s->>'bank_owner_id' OR s->>'bank_owner_id' IS NULL
 OR bt.from_user_id IS DISTINCT FROM u OR bt.club_id IS DISTINCT FROM club OR bt.amount IS DISTINCT FROM a
 OR bt.transaction_type IS DISTINCT FROM 'club_bank_claim' OR bt.created_at IS DISTINCT FROM at_time
 OR bt.metadata->>'reason' IS DISTINCT FROM 'deleted_account' OR bt.metadata->>'direction' IS DISTINCT FROM 'into_bank'
 OR bt.metadata->>'source' IS DISTINCT FROM 'player_wallet'
 OR bt.metadata->>'op_id' IS DISTINCT FROM s->>'bank_claim_operation_id'
 OR bt.balance_after IS DISTINCT FROM (s->>'bank_after')::numeric
 OR (bt.metadata->>'bank_after')::numeric IS DISTINCT FROM (s->>'bank_after')::numeric
 OR cl.id::text IS DISTINCT FROM s->>'bank_claim_leg_id' OR cl.club_id IS DISTINCT FROM club
 OR cl.from_entity_id IS DISTINCT FROM u OR cl.to_entity_id IS DISTINCT FROM club
 OR cl.from_type IS DISTINCT FROM 'player_wallet' OR cl.to_type IS DISTINCT FROM 'club_treasury'
 OR cl.amount IS DISTINCT FROM a OR cl.category IS DISTINCT FROM 'club_bank_claim'
 OR cl.correlation_id IS DISTINCT FROM (bt.metadata->>'op_id')::uuid OR cl.created_at IS DISTINCT FROM at_time
 THEN RETURN false;END IF;
 refs:=jsonb_build_array(
 jsonb_build_object('kind','wallet_credit_idempotency','id',k,'md5',md5(to_jsonb(ik)::text)),
 jsonb_build_object('kind','mint_ledger','id',k,'md5',md5(to_jsonb(mt)::text)),
 jsonb_build_object('kind','chip_ledger','id',il.id,'md5',md5(to_jsonb(il)::text)),
 jsonb_build_object('kind','chip_ledger','id',cl.id,'md5',md5(to_jsonb(cl)::text)),
 jsonb_build_object('kind','chip_transaction','id',ct.id,'md5',md5(to_jsonb(ct)::text)),
 jsonb_build_object('kind','chip_transaction','id',bt.id,'md5',md5(to_jsonb(bt)::text)));
 RETURN refs IS NOT DISTINCT FROM s->'financial_refs';
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN false;
END$b$;
REVOKE ALL ON FUNCTION smarter_private.original_erased_cash_base_discharge_evidence_valid(bigint,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.original_erased_cash_base_discharge_insert_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,smarter_private AS $b$
BEGIN
 IF NEW.evidence_md5 IS DISTINCT FROM md5(NEW.evidence::text)
 OR NOT smarter_private.original_erased_cash_base_discharge_evidence_valid(NEW.event_id,NEW.witness_md5,NEW.evidence)
 OR NEW.occupancy_id::text IS DISTINCT FROM NEW.evidence->>'occupancy_id'
 OR NEW.user_id::text IS DISTINCT FROM NEW.evidence->>'user_id'
 OR NEW.funding_club_id::text IS DISTINCT FROM NEW.evidence->>'funding_club_id'
 OR NEW.base_cents IS DISTINCT FROM (NEW.evidence->>'base_cents')::bigint
 OR NEW.restoration_key IS DISTINCT FROM NEW.evidence->>'restoration_key'
 OR NEW.discharged_at IS DISTINCT FROM (NEW.evidence->>'discharged_at')::timestamptz THEN
 RAISE EXCEPTION 'original_cash_discharge_insert_evidence_refused' USING ERRCODE='55000';END IF;
 RETURN NEW;
END$b$;
REVOKE ALL ON FUNCTION smarter_private.original_erased_cash_base_discharge_insert_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_cash_discharge_insert_guard BEFORE INSERT
ON smarter_private.original_erased_cash_base_discharges FOR EACH ROW
EXECUTE FUNCTION smarter_private.original_erased_cash_base_discharge_insert_guard();

CREATE OR REPLACE FUNCTION smarter_private.original_erased_cash_base_discharge(e bigint,h text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $b$
DECLARE r jsonb;f jsonb;p jsonb;k text;u uuid;club uuid;occ uuid;tbl uuid;a numeric;
 bank_before numeric;bank_after numeric;owner_id uuid;profile_status text;member record;
 before_receipts uuid[];base_tx record;bank_tx record;issuance record;claim record;mint record;idem record;
 n integer;before_late text;after_late text;refs jsonb;s jsonb;pin record;old jsonb;
BEGIN
 IF session_user IS DISTINCT FROM 'postgres' OR current_user IS DISTINCT FROM 'postgres'
 OR nullif(current_setting('request.jwt.claim.role',true),'') IS NOT NULL
 OR nullif(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN
 RAISE EXCEPTION 'original_cash_discharge_caller_refused' USING ERRCODE='42501';END IF;
 IF h IS NULL OR h IS DISTINCT FROM smarter_private.original_erased_cash_base_expected_hash(e) THEN
 RAISE EXCEPTION 'original_cash_discharge_unknown_request' USING ERRCODE='55000';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('original-seven-cash-discharge',0)) THEN
 RAISE EXCEPTION 'original_cash_discharge_writer_busy' USING ERRCODE='55000';END IF;
 -- Exact current producer contract. Getter pin supplied by the combined finite245 source.
 IF md5(pg_get_functiondef('smarter_private.original_erased_cash_base_request(bigint,text)'::regprocedure)) IS DISTINCT FROM '1467e44cc7f7871b34eff07f7038019d'
 OR md5(pg_get_functiondef('smarter_private.original_inventory_finite_witness(bigint)'::regprocedure)) IS DISTINCT FROM '0ef0a8a5b9e85633cf4bf8b0cd15c8d7'
 OR md5(pg_get_functiondef('smarter_private.original_inventory_source_ref_md5(jsonb)'::regprocedure)) IS DISTINCT FROM '1411d22a7ad914a80922aeed8bfcf7e6'
 OR md5(pg_get_functiondef('smarter_private.original_erased_cash_base_proof(jsonb,timestamptz)'::regprocedure)) IS DISTINCT FROM 'a2d5ac28a5f07929ed99d6e871dddfa2' THEN
 RAISE EXCEPTION 'original_cash_discharge_source_changed' USING ERRCODE='55000';END IF;
 FOR pin IN SELECT * FROM (VALUES
 ('public.fn_ca_balance_has_its_ledger_row()','2df7b3f67e95b8a6c0abe7ba3faff63c'),
 ('public.fn_ca_chip_ledger_enrich()','5931f47d922eea26ab1ea2b12f3f7c8c'),
 ('public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])','2eb458ce27b0116d2f7ad4603ca719dd'),
 ('public.fn_ca_deleted_wallet_credit()','90411405ee2614026ea0a5cc4b19f590'),
 ('public.fn_ca_issuance_leg_is_registered()','abdf1fd11d589957da51f8bd7554324d'),
 ('public.fn_ca_restore_erased_seat_credit(text,uuid,uuid,numeric,uuid,text)','6307d1d0ae4f208de54dd5a0e13985d5'),
 ('public.fn_club_members_ledger_writer()','d9b0429e6c88b7a2dc4e732edab6ed10'),
 ('public.fn_ensure_club_wallet(uuid,uuid)','dd462a9943724d4b94fbe683ed364250'),
 ('public.fn_platform_frozen()','ec683805e052fceeae74789e82dce4cc'),
 ('public.fn_active_maintenance_release_boundary()','05b537b57c9f51a5164e20a1cd0e67e0'),
 ('public.fn_ca_assert_emergency_path(text)','a37722a7445d65bd0c9bdcf62ff36649'),
 ('public.fn_ca_current_epoch()','6a803a80ab2b368acdbded9435112f98'),
 ('public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text)','bccd30228fd808adb885cf3c7f47db88'),
 ('public.fn_ca_ledger_tally_add(text,text,numeric)','03b49d93d25551e4e74dedbb5dc7c08e'),
 ('public.fn_ca_ledger_tally_key(text,uuid,uuid)','7d8c761d9d43c0429448c4b8b588d6ac'),
 ('public.fn_ca_mint_issued_24h(text,uuid)','e0bf5ff9e14f1d9d070fde617b85ea7c'),
 ('public.fn_ca_noncirculating_chip_stores()','0b1f2c1035aa66ee67f3d1f553b8f334'),
 ('public.fn_ca_register_issuance_leg(uuid)','8d3d5e1feccd96fcf0045afefdb9fcdc'),
 ('public.fn_ca_tally_pair(text,numeric,text,numeric)','54e8f073910b0a538bf26d8e625cce33'),
 ('public.fn_cashier_assert_active_actor(uuid)','3ceb097db1a05a550e8b2a42fe931d36'),
 ('public.fn_freeze_bypass_active()','2bfad412c70b965fd9d2c72b2ad83310'),
 ('auth.role()','8a3e05459e07e0633d43c6fba2a2cdf4'),
 ('auth.uid()','ea3b41bf29e2ad573067939329aa088e'),
 ('public.fn_ca_assert_player_action(uuid,text,text)','1f5e930010ce5204e5407001268bd880'),
 ('public.fn_ca_chip_store_declared()','d5b08956826e56a0d414db4bfd022d3b'),
 ('public.fn_ca_felt_counts_table(uuid)','f927a7f671c765112799d5e36bd552ba'),
 ('public.fn_ca_tournament_counts(uuid)','86e9255968e9dbf6e114b41b22f3649a'),
 ('public.fn_club_settlement_frozen(uuid)','93579cd20397b592447167d5ac512189'),
 ('public.fn_union_week_start(timestamp with time zone)','103f192a228084dad0e4268c36c82c4b'),
 ('public.fn_ca_emergency_issuance_guard()','ad9f6b99951af4374934a526fe52660e'),
 ('public.fn_ca_mint_register_append_only()','664af2474324260146684edf8ea9c220'),
 ('public.enforce_chip_ledger_performed_by()','ed92ea331aeddaffca0ae46a7f6801ea'),
 ('public.fn_ca_tally_ledger_leg()','9b3ab2f5a78cb7fa0adfb377706ecb85'),
 ('public.zz_chip_ledger_key_is_claimed_once()','57a2b2eb1bc5b1c5ac36394c2ac23bcd'),
 ('public.fn_refuse_while_frozen()','3a866372172806a8a69cc3d37413f0cc'),
 ('public.fn_cashier_operation_intent_guard()','d89888ea95f0fba54a976fe966804649'),
 ('public.fn_ca_refuse_restricted_transfer()','65a2cb12ec806144a074efc2614563d1'),
 ('public.fn_refuse_operator_move_while_settling()','4dd93ff68d573144d73edc71e166f36f'),
 ('public.fn_cashier_balance_actor_guard()','178146284da8fbab643c2e6fcbb8bd42'),
 ('public.fn_cashier_operation_mutex_guard()','344aae5352ca162b3f89971599fcda78'),
 ('public.fn_ca_autoledger()','852f2e9b202459d7450407b71b7cb6f8'),
 ('public.fn_ca_tally_balance_move()','b7911a245d4bf33134a9a2f474c1f410'),
 ('public.fn_ca_tally_store_move()','ba64376ceff72886b399349b53fcd2fa'),
 ('public.fn_admin_holds_no_player_wallet()','3c54c86c548917606c846febfadf704b'),
 ('public.fn_block_browser_balance_writes()','c7390598f411e7d6bc4b8daf00e12c6e'),
 ('public.fn_guard_retired_club_mutation()','941df8f6c1a4857d46885ddf7c1941d8')) v(signature,body_md5) LOOP
 IF to_regprocedure(pin.signature) IS NULL OR md5(pg_get_functiondef(to_regprocedure(pin.signature))) IS DISTINCT FROM pin.body_md5 THEN RAISE EXCEPTION 'original_cash_discharge_money_source_changed:%',pin.signature USING ERRCODE='55000';END IF;
 END LOOP;
 r:=smarter_private.original_erased_cash_base_request(e,h);
 IF r->>'status' IS DISTINCT FROM 'ready' OR r->'financial_admission' IS DISTINCT FROM 'false'::jsonb
 OR r->>'witness_md5' IS DISTINCT FROM h OR md5((r->'witness')::text) IS DISTINCT FROM h
 OR md5((r->'proof')::text) IS DISTINCT FROM r->>'proof_md5' THEN
 RAISE EXCEPTION 'original_cash_discharge_source_refused' USING ERRCODE='55000';END IF;
 f:=r->'witness';p:=smarter_private.original_erased_cash_base_proof(f,'2026-10-12 07:00:00Z');
 IF p IS DISTINCT FROM r->'proof' OR p->>'status' IS DISTINCT FROM 'ready' THEN
 RAISE EXCEPTION 'original_cash_discharge_proof_refused' USING ERRCODE='55000';END IF;
 u:=(p#>>'{holding,user_id}')::uuid;club:=(p#>>'{holding,club_id}')::uuid;
 a:=(p->>'original_base')::numeric;occ:=(f#>>'{signed,occupancy_id}')::uuid;
 tbl:=(f#>>'{event,before_row,table_id}')::uuid;k:='retired_completed_cash_base:'||occ;
 IF a IS NULL OR a<=0 OR a*100<>trunc(a*100) OR u IS NULL OR club IS NULL OR occ IS NULL OR tbl IS NULL THEN
 RAISE EXCEPTION 'original_cash_discharge_identity_refused' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.original_erased_cash_base_discharges WHERE event_id=e) THEN
 old:=smarter_private.original_erased_cash_base_discharge_receipt(e,h);
 IF old->>'status' IS DISTINCT FROM 'discharged' THEN
 RAISE EXCEPTION 'original_cash_discharge_durable_receipt_refused' USING ERRCODE='55000';END IF;
 RETURN old||jsonb_build_object('replayed',true,'financial_payment',false);END IF;
 -- Reject every orphan/partial key before the raw writer's swallowed unique branch.
 IF EXISTS(SELECT 1 FROM public.wallet_credit_idempotency WHERE key=k)
 OR EXISTS(SELECT 1 FROM public.ca_mint_ledger WHERE op_id=k)
 OR EXISTS(SELECT 1 FROM public.chip_ledger WHERE idempotency_key=k)
 OR EXISTS(SELECT 1 FROM public.chip_transactions WHERE club_id=club AND table_id=tbl AND to_user_id=u AND created_at>='2026-10-06 00:00Z' AND metadata->>'restore_key'=k) THEN
 RAISE EXCEPTION 'original_cash_discharge_orphan_or_partial_key' USING ERRCODE='55000';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN
 RAISE EXCEPTION 'original_cash_discharge_frozen' USING ERRCODE='55000';END IF;
 SELECT chip_treasury,c.owner_id INTO bank_before,owner_id FROM public.clubs c
 WHERE id=club AND asset='chips' AND lifecycle_status='active' FOR UPDATE NOWAIT;
 IF NOT FOUND OR bank_before IS NULL OR owner_id IS NULL THEN
 RAISE EXCEPTION 'original_cash_discharge_bank_changed' USING ERRCODE='55000';END IF;
 SELECT status INTO profile_status FROM public.profiles WHERE id=u FOR SHARE NOWAIT;
 IF NOT FOUND OR profile_status IS DISTINCT FROM 'deleted' THEN
 RAISE EXCEPTION 'original_cash_discharge_deleted_status_changed' USING ERRCODE='55000';END IF;
 SELECT * INTO member FROM public.club_members WHERE club_id=club AND user_id=u FOR UPDATE NOWAIT;
 IF NOT FOUND OR member.status NOT IN('active','approved') OR member.status IS NULL
 OR member.chip_balance IS DISTINCT FROM 0::numeric OR member.held_chips IS DISTINCT FROM 0::numeric
 OR member.locked_chips IS DISTINCT FROM 0::numeric THEN
 RAISE EXCEPTION 'original_cash_discharge_wallet_changed' USING ERRCODE='55000';END IF;
 SELECT md5(to_jsonb(l)::text) INTO before_late FROM public.chip_ledger l WHERE id=(f#>>'{late_ledger,id}')::uuid;
 IF before_late IS NULL OR before_late IS DISTINCT FROM (SELECT x->>'md5' FROM smarter_private.original_inventory_restoration_cases c CROSS JOIN LATERAL jsonb_array_elements(c.source_refs)x WHERE c.event_id=e AND x->>'kind'='chip_ledger' AND x->>'id'=f#>>'{late_ledger,id}') THEN
 RAISE EXCEPTION 'original_cash_discharge_played_ledger_changed' USING ERRCODE='55000';END IF;
 SELECT coalesce(array_agg(t.id),ARRAY[]::uuid[]) INTO before_receipts FROM public.chip_transactions t
 WHERE t.club_id=club AND t.from_user_id=u AND t.transaction_type='club_bank_claim' AND t.amount=a;
 SET CONSTRAINTS ALL DEFERRED;
 r:=public.fn_ca_restore_erased_seat_credit(k,u,club,a,tbl,
 'Original erased cash base restitution; deleted-account funding-club bank custody; event '||e);
 IF r->>'restored' IS DISTINCT FROM 'true' THEN
 RAISE EXCEPTION 'original_cash_discharge_raw_writer_refused' USING ERRCODE='55000';END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 SELECT count(*) INTO n FROM public.chip_ledger WHERE idempotency_key=k;
 IF n<>1 THEN RAISE EXCEPTION 'original_cash_discharge_issuance_leg_count';END IF;
 SELECT * INTO issuance FROM public.chip_ledger WHERE idempotency_key=k;
 SELECT * INTO idem FROM public.wallet_credit_idempotency WHERE key=k;
 SELECT count(*) INTO n FROM public.ca_mint_ledger WHERE op_id=k;
 IF n<>1 THEN RAISE EXCEPTION 'original_cash_discharge_mint_key_refused';END IF;
 SELECT * INTO mint FROM public.ca_mint_ledger WHERE op_id=k;
 IF issuance.id IS NULL OR issuance.id::text IS DISTINCT FROM r->>'chip_ledger_id'
 OR issuance.from_type IS DISTINCT FROM 'issuance_reserve' OR issuance.to_type IS DISTINCT FROM 'player_wallet'
 OR issuance.to_entity_id IS DISTINCT FROM u OR issuance.club_id IS DISTINCT FROM club
 OR issuance.amount IS DISTINCT FROM a OR issuance.category IS DISTINCT FROM 'refund'
 OR issuance.epoch_id IS DISTINCT FROM public.fn_ca_current_epoch()
 OR issuance.created_at IS DISTINCT FROM transaction_timestamp()
 OR mint.chip_ledger_id IS DISTINCT FROM issuance.id OR mint.holder_id IS DISTINCT FROM u
 OR mint.holder_type IS DISTINCT FROM 'player' OR mint.action IS DISTINCT FROM 'mint'
 OR mint.asset IS DISTINCT FROM 'chips' OR mint.amount IS DISTINCT FROM a
 OR mint.created_at IS DISTINCT FROM transaction_timestamp()
 OR idem.user_id IS DISTINCT FROM u OR idem.amount IS DISTINCT FROM a THEN
 RAISE EXCEPTION 'original_cash_discharge_issuance_refused' USING ERRCODE='55000';END IF;
 SELECT count(*) INTO n FROM public.chip_transactions t WHERE t.club_id=club AND t.table_id=tbl AND t.to_user_id=u AND t.created_at>='2026-10-06 00:00Z' AND t.metadata->>'restore_key'=k;
 IF n<>1 THEN RAISE EXCEPTION 'original_cash_discharge_base_receipt_count';END IF;
 SELECT * INTO base_tx FROM public.chip_transactions t WHERE t.club_id=club AND t.table_id=tbl AND t.to_user_id=u AND t.created_at>='2026-10-06 00:00Z' AND t.metadata->>'restore_key'=k;
 IF base_tx.to_user_id IS DISTINCT FROM u OR base_tx.club_id IS DISTINCT FROM club
 OR base_tx.table_id IS DISTINCT FROM tbl OR base_tx.amount IS DISTINCT FROM a
 OR base_tx.transaction_type IS DISTINCT FROM 'seat_credit_restored'
 OR base_tx.metadata->>'source' IS DISTINCT FROM 'issuance_reserve'
 OR base_tx.created_at IS DISTINCT FROM transaction_timestamp() THEN
 RAISE EXCEPTION 'original_cash_discharge_base_receipt_refused';END IF;
 SELECT count(*) INTO n FROM public.chip_transactions t WHERE t.club_id=club AND t.from_user_id=u
 AND t.transaction_type='club_bank_claim' AND t.amount=a AND NOT(t.id=ANY(before_receipts));
 IF n<>1 THEN RAISE EXCEPTION 'original_cash_discharge_new_bank_receipt_count';END IF;
 SELECT * INTO bank_tx FROM public.chip_transactions t WHERE t.club_id=club AND t.from_user_id=u
 AND t.transaction_type='club_bank_claim' AND t.amount=a AND NOT(t.id=ANY(before_receipts));
 SELECT count(*) INTO n FROM public.chip_ledger WHERE idempotency_key='deleted_account_bank_return:'||(bank_tx.metadata->>'op_id');
 IF n<>1 THEN RAISE EXCEPTION 'original_cash_discharge_bank_leg_count';END IF;
 SELECT * INTO claim FROM public.chip_ledger WHERE idempotency_key='deleted_account_bank_return:'||(bank_tx.metadata->>'op_id');
 IF bank_tx.to_user_id IS DISTINCT FROM owner_id OR bank_tx.metadata->>'reason' IS DISTINCT FROM 'deleted_account'
 OR bank_tx.metadata->>'direction' IS DISTINCT FROM 'into_bank' OR bank_tx.metadata->>'source' IS DISTINCT FROM 'player_wallet'
 OR bank_tx.created_at IS DISTINCT FROM transaction_timestamp()
 OR claim.from_type IS DISTINCT FROM 'player_wallet' OR claim.from_entity_id IS DISTINCT FROM u
 OR claim.to_type IS DISTINCT FROM 'club_treasury' OR claim.to_entity_id IS DISTINCT FROM club
 OR claim.club_id IS DISTINCT FROM club OR claim.amount IS DISTINCT FROM a
 OR claim.category IS DISTINCT FROM 'club_bank_claim'
 OR claim.correlation_id IS DISTINCT FROM (bank_tx.metadata->>'op_id')::uuid
 OR claim.created_at IS DISTINCT FROM transaction_timestamp() THEN
 RAISE EXCEPTION 'original_cash_discharge_bank_receipt_refused';END IF;
 SELECT chip_treasury INTO bank_after FROM public.clubs WHERE id=club;
 IF bank_after-bank_before IS DISTINCT FROM a OR bank_tx.balance_after IS DISTINCT FROM bank_after
 OR (bank_tx.metadata->>'bank_after')::numeric IS DISTINCT FROM bank_after
 OR EXISTS(SELECT 1 FROM public.club_members WHERE user_id=u AND club_id=club
 AND (chip_balance IS DISTINCT FROM 0::numeric OR held_chips IS DISTINCT FROM member.held_chips
 OR locked_chips IS DISTINCT FROM member.locked_chips)) THEN
 RAISE EXCEPTION 'original_cash_discharge_custody_postimage_refused';END IF;
 SELECT md5(to_jsonb(l)::text) INTO after_late FROM public.chip_ledger l WHERE id=(f#>>'{late_ledger,id}')::uuid;
 IF after_late IS DISTINCT FROM before_late
 OR smarter_private.original_erased_cash_base_request(e,h) IS DISTINCT FROM
 jsonb_build_object('status','ready','financial_admission',false,'event_id',e,
 'case_witness_md5',(smarter_private.original_erased_cash_base_request(e,h)->>'case_witness_md5'),
 'witness_md5',h,'witness',f,'proof',p,'proof_md5',md5(p::text)) THEN
 RAISE EXCEPTION 'original_cash_discharge_originals_changed';END IF;
 refs:=jsonb_build_array(
 jsonb_build_object('kind','wallet_credit_idempotency','id',k,'md5',md5(to_jsonb(idem)::text)),
 jsonb_build_object('kind','mint_ledger','id',k,'md5',md5(to_jsonb(mint)::text)),
 jsonb_build_object('kind','chip_ledger','id',issuance.id,'md5',md5(to_jsonb(issuance)::text)),
 jsonb_build_object('kind','chip_ledger','id',claim.id,'md5',md5(to_jsonb(claim)::text)),
 jsonb_build_object('kind','chip_transaction','id',base_tx.id,'md5',md5(to_jsonb(base_tx)::text)),
 jsonb_build_object('kind','chip_transaction','id',bank_tx.id,'md5',md5(to_jsonb(bank_tx)::text)));
 s:=jsonb_build_object('status','discharged','event_id',e,'custody','canonical_deleted_account_bank',
 'occupancy_id',occ,'user_id',u,'funding_club_id',club,'base_cents',(a*100)::bigint,
 'amount',a,'restoration_key',k,'discharged_at',transaction_timestamp(),
 'mint_id',mint.id,'issuance_leg_id',issuance.id,'base_credit_transaction_id',base_tx.id,
 'bank_claim_leg_id',claim.id,'bank_claim_transaction_id',bank_tx.id,'bank_claim_operation_id',bank_tx.metadata->>'op_id',
 'final_player_wallet',0,'bank_increment',a,'bank_before',bank_before,'bank_after',bank_after,'bank_owner_id',owner_id,
 'preserved_played_delta',p->'preserved_played_delta','financial_refs',refs);
 INSERT INTO smarter_private.original_erased_cash_base_discharges
 (event_id,witness_md5,occupancy_id,user_id,funding_club_id,base_cents,restoration_key,discharged_at,evidence,evidence_md5)
 VALUES(e,h,occ,u,club,(a*100)::bigint,k,transaction_timestamp(),s,md5(s::text));
 old:=smarter_private.original_erased_cash_base_discharge_receipt(e,h);
 IF old->>'status' IS DISTINCT FROM 'discharged' THEN
 RAISE EXCEPTION 'original_cash_discharge_consumer_refused';END IF;
 RETURN old||jsonb_build_object('replayed',false,'financial_payment',true);
END$b$;
ALTER FUNCTION smarter_private.original_erased_cash_base_discharge(bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_erased_cash_base_discharge(bigint,text) FROM PUBLIC,anon,authenticated,service_role;

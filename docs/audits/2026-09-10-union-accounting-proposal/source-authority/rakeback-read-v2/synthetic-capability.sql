-- NATIVE FIXTURE ONLY. This is not a production cutover witness.
DO $native$
BEGIN
 IF to_regclass('public.test_owner_requests') IS NULL OR to_regprocedure('public.test_funding_state()') IS NULL
  OR inet_server_addr() IS NOT NULL THEN RAISE EXCEPTION 'Native private fixture required';END IF;
 INSERT INTO public.ca_captured_rakeback_release_authority(activation_id,schema_version,source_contract_version,
  cutover_status,integration_evidence_sha256,component_pins)
 SELECT test_id(1599999),2,1,'complete_cascade_and_legacy_exclusion_verified',
  encode(extensions.digest('SYNTHETIC GETTER CAPABILITY TEST ONLY; LEGACY OWNERS ARE NOT EXCLUDED','sha256'),'hex'),
  jsonb_object_agg(k,jsonb_build_object('signature',sig,'definition_md5',md5(pg_get_functiondef(to_regprocedure(sig)))))
 FROM (VALUES
 ('accepted_owner','public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'),
 ('source_boundary','public.fn_ca_capture_first_cash_envelope()'),
 ('bank_receipt_assert','public.fn_ca_assert_cash_bank_receipt(uuid)'),
 ('accepted_source','public.fn_ca_capture_cash_commission_source(uuid,jsonb)'),
 ('bank','public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'),
 ('club_release','public.fn_release_captured_club_funding(uuid,timestamptz,uuid,uuid)'),
 ('agent_payment','public.fn_pay_captured_agent_funding(uuid,uuid,date)'),
 ('player_payment','public.fn_pay_captured_player_funding(uuid,uuid,uuid,date)'),
 ('payment_dto','public.fn_ca_captured_player_payment_dto(uuid)'),
 ('read','public.fn_get_captured_rakeback(uuid)'),
 ('claim','public.fn_claim_captured_rakeback(uuid,uuid,uuid)'),
 ('legacy_player','public.fn_claim_rakeback(uuid)'),
 ('legacy_union','public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'),
 ('legacy_union_basis','public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz,boolean)'),
 ('legacy_round2','public.fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz)'),
 ('legacy_direct_agent','public.fn_agent_claim_commission(uuid,uuid,integer)')
 ) pins(k,sig);
END $native$;

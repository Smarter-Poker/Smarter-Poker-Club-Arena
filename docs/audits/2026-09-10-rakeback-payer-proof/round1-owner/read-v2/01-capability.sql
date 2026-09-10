-- Unactivated prospective capability. No production witness is inserted here.
CREATE TABLE public.ca_captured_rakeback_release_authority(
 activation_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 activation_id uuid NOT NULL UNIQUE, schema_version integer NOT NULL CHECK(schema_version=2),
 source_contract_version integer NOT NULL CHECK(source_contract_version=1),
 cutover_status text NOT NULL CHECK(cutover_status='complete_cascade_and_legacy_exclusion_verified'),
 integration_evidence_sha256 text NOT NULL CHECK(integration_evidence_sha256 ~ '^[0-9a-f]{64}$'),
 component_pins jsonb NOT NULL CHECK(jsonb_typeof(component_pins)='object'),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.ca_captured_rakeback_release_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_captured_rakeback_release_authority FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_captured_v2_manifest_matches(p_pins jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path TO public,pg_temp AS $f$
 SELECT coalesce(jsonb_typeof(p_pins)='object'
 AND p_pins ?& ARRAY['accepted_source','accepted_owner','source_boundary','bank','bank_receipt_assert','club_release','agent_payment','player_payment',
  'payment_dto','read','claim','legacy_player','legacy_union','legacy_union_basis','legacy_round2','legacy_direct_agent']
 AND NOT EXISTS(SELECT 1 FROM jsonb_each(p_pins) e
  LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.value->>'signature')
  WHERE p.oid IS NULL OR jsonb_typeof(e.value)<>'object'
   OR e.value->>'definition_md5' IS DISTINCT FROM md5(pg_get_functiondef(p.oid)))
 AND to_regprocedure(p_pins->'accepted_owner'->>'signature')=to_regprocedure('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)')
 AND to_regprocedure(p_pins->'source_boundary'->>'signature')=to_regprocedure('public.fn_ca_capture_first_cash_envelope()')
 AND to_regprocedure(p_pins->'bank_receipt_assert'->>'signature')=to_regprocedure('public.fn_ca_assert_cash_bank_receipt(uuid)')
 AND to_regprocedure(p_pins->'accepted_source'->>'signature')=to_regprocedure('public.fn_ca_capture_cash_commission_source(uuid,jsonb)')
 AND to_regprocedure(p_pins->'bank'->>'signature')=to_regprocedure('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)')
 AND to_regprocedure(p_pins->'legacy_player'->>'signature')=to_regprocedure('public.fn_claim_rakeback(uuid)')
 AND to_regprocedure(p_pins->'legacy_union'->>'signature')=to_regprocedure('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)')
 AND to_regprocedure(p_pins->'legacy_union_basis'->>'signature')=to_regprocedure('public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz,boolean)')
 AND to_regprocedure(p_pins->'legacy_round2'->>'signature')=to_regprocedure('public.fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz)')
 AND to_regprocedure(p_pins->'legacy_direct_agent'->>'signature')=to_regprocedure('public.fn_agent_claim_commission(uuid,uuid,integer)')
 AND to_regprocedure(p_pins->'read'->>'signature')=to_regprocedure('public.fn_get_captured_rakeback(uuid)')
 AND to_regprocedure(p_pins->'claim'->>'signature')=to_regprocedure('public.fn_claim_captured_rakeback(uuid,uuid,uuid)')
 AND to_regprocedure(p_pins->'player_payment'->>'signature')=to_regprocedure('public.fn_pay_captured_player_funding(uuid,uuid,uuid,date)')
 AND to_regprocedure(p_pins->'payment_dto'->>'signature')=to_regprocedure('public.fn_ca_captured_player_payment_dto(uuid)')
 AND to_regprocedure(p_pins->'club_release'->>'signature')=to_regprocedure('public.fn_release_captured_club_funding(uuid,timestamptz,uuid,uuid)')
 AND to_regprocedure(p_pins->'agent_payment'->>'signature')=to_regprocedure('public.fn_pay_captured_agent_funding(uuid,uuid,date)'),false)
$f$;
CREATE FUNCTION public.fn_captured_rakeback_v2_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
 SELECT coalesce((SELECT schema_version=2 AND source_contract_version=1
  AND cutover_status='complete_cascade_and_legacy_exclusion_verified'
  AND public.fn_ca_captured_v2_manifest_matches(component_pins)
  FROM public.ca_captured_rakeback_release_authority ORDER BY activation_seq DESC LIMIT 1),false)
$f$;
CREATE FUNCTION public.fn_ca_captured_v2_authority_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Coordinated release witnesses are immutable' USING ERRCODE='55000';END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(proowner) FROM pg_proc
  WHERE oid=to_regprocedure('public.fn_get_captured_rakeback(uuid)'))
  OR NOT public.fn_ca_captured_v2_manifest_matches(NEW.component_pins)
 THEN RAISE EXCEPTION 'Only the reviewed coordinated owner may record a complete release witness' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER captured_v2_authority_immutable BEFORE INSERT OR UPDATE OR DELETE
 ON public.ca_captured_rakeback_release_authority FOR EACH ROW EXECUTE FUNCTION public.fn_ca_captured_v2_authority_guard();
CREATE TRIGGER captured_v2_authority_no_truncate BEFORE TRUNCATE
 ON public.ca_captured_rakeback_release_authority FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_captured_v2_authority_guard();
REVOKE ALL ON FUNCTION public.fn_ca_captured_v2_manifest_matches(jsonb),public.fn_ca_captured_v2_authority_guard()
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_captured_rakeback_v2_active() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_captured_rakeback_v2_active() TO authenticated,service_role;

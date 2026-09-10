-- Gated version2 claim wrapper. Requires the real getter and coordinated release
-- capability contract; does not activate that contract or retire legacy RPCs.
CREATE TABLE public.ca_source_player_claim_requests(
 request_id uuid PRIMARY KEY,actor_id uuid NOT NULL,club_id uuid,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE ca_source_player_claim_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ca_source_player_claim_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON ca_source_player_claim_requests TO service_role;
CREATE TRIGGER ca_source_player_claim_immutable BEFORE UPDATE OR DELETE ON ca_source_player_claim_requests
 FOR EACH ROW EXECUTE FUNCTION fn_ca_source_capacity_immutable();
CREATE TRIGGER ca_source_player_claim_no_truncate BEFORE TRUNCATE ON ca_source_player_claim_requests
 FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_source_capacity_immutable();
CREATE OR REPLACE FUNCTION public.fn_claim_captured_rakeback(p_request_id uuid,p_expected_user_id uuid,p_club_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_actor uuid:=auth.uid();v_old ca_source_player_claim_requests%ROWTYPE;
 v_clubs uuid[];v_read jsonb;b jsonb;r jsonb;v_payment jsonb;v_scope jsonb;v_scopes jsonb:='[]';
 v_payments jsonb:='[]';v_ids jsonb;v_deferred jsonb;v_total numeric:=0;v_amount numeric;v_cutoff date;v_result jsonb;
BEGIN
 IF v_actor IS NULL OR p_expected_user_id IS DISTINCT FROM v_actor OR p_request_id IS NULL
 THEN RAISE EXCEPTION 'captured_claim_account_or_request_mismatch' USING ERRCODE='42501';END IF;
 -- A committed immutable result can be recovered even during freeze or capability
 -- withdrawal. It moves no money and never changes its original receipt.
 SELECT * INTO v_old FROM ca_source_player_claim_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_old.actor_id IS DISTINCT FROM v_actor OR v_old.club_id IS DISTINCT FROM p_club_id
  THEN RAISE EXCEPTION 'captured_claim_request_scope_conflict' USING ERRCODE='23514';END IF;
  RETURN v_old.result;
 END IF;
 SELECT coalesce(array_agg(DISTINCT club_id ORDER BY club_id),'{}') INTO v_clubs FROM(
  SELECT f.booked_club_id club_id FROM ca_cash_commission_facts f WHERE f.player_id=v_actor AND f.booked_club_id IS NOT NULL
  UNION SELECT s.club_id FROM ca_source_player_cash_payments p JOIN ca_source_funding_pools s ON s.id=p.pool_id WHERE p.player_id=v_actor
 ) c WHERE p_club_id IS NULL OR club_id=p_club_id;
 PERFORM fn_lock_rakeback_payer_clubs(v_clubs);
 PERFORM pg_advisory_xact_lock(hashtextextended('club-arena:captured-player-request:'||p_request_id::text,0));
 SELECT * INTO v_old FROM ca_source_player_claim_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_old.actor_id IS DISTINCT FROM v_actor OR v_old.club_id IS DISTINCT FROM p_club_id
  THEN RAISE EXCEPTION 'captured_claim_request_scope_conflict' USING ERRCODE='23514';END IF;
  RETURN v_old.result;
 END IF;
 IF fn_captured_rakeback_v2_active() IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'captured_rakeback_v2_not_active' USING ERRCODE='55000';END IF;
 v_read:=fn_get_captured_rakeback(p_club_id);
 IF v_read->>'schema_version' IS DISTINCT FROM '2' OR v_read->>'source_active' IS DISTINCT FROM 'true'
  OR v_read->>'beneficiary_user_id' IS DISTINCT FROM v_actor::text OR jsonb_typeof(v_read->'balances') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'captured_read_contract_mismatch' USING ERRCODE='23514';END IF;
 v_cutoff:=(v_read->>'earning_closed_through')::date;
 IF v_cutoff IS DISTINCT FROM date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date
 THEN RAISE EXCEPTION 'captured_read_earning_boundary_mismatch' USING ERRCODE='23514';END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(v_read->'balances')
  ORDER BY value->'scope'->>'club_id',value->>'pool_id',value->'scope'->>'payer_user_id'
 LOOP
  v_scope:=b->'scope';v_ids:='[]';v_deferred:='[]';v_amount:=0;
  IF jsonb_typeof(v_scope) IS DISTINCT FROM 'object' OR v_scope->>'club_id' IS NULL
   OR v_scope->>'payer_user_id' IS NULL OR v_scope->>'contract_version' IS DISTINCT FROM '1'
   OR (v_scope->>'funding_route' IN('union_rake_wallet','club_chip_treasury')) IS DISTINCT FROM true
   OR v_scope IS DISTINCT FROM jsonb_build_object('club_id',(v_scope->>'club_id')::uuid,
    'funding_union_id',(v_scope->>'funding_union_id')::uuid,'funding_route',v_scope->>'funding_route',
    'contract_version',1,'payer_user_id',(v_scope->>'payer_user_id')::uuid)
   OR ((v_scope->>'funding_route'='union_rake_wallet') IS DISTINCT FROM (v_scope->>'funding_union_id' IS NOT NULL))
  THEN RAISE EXCEPTION 'captured_read_scope_malformed' USING ERRCODE='23514';END IF;
  IF ((v_scope->>'club_id')::uuid=ANY(v_clubs)) IS DISTINCT FROM true THEN
   -- Source discovery cannot make this invocation acquire a new unsorted club.
   v_deferred:=jsonb_build_array(jsonb_build_object('reason','source_discovered_after_scope_admission'));
  ELSIF b->>'pool_id' IS NULL THEN
   v_deferred:=jsonb_build_array(jsonb_build_object('reason','source_bank_funding_pending'));
  ELSE
   IF NOT EXISTS(SELECT 1 FROM ca_source_funding_pools z WHERE z.id=(b->>'pool_id')::uuid
    AND jsonb_build_object('club_id',z.club_id,'funding_union_id',z.funding_union_id,'funding_route',z.funding_route,
     'contract_version',z.contract_version,'payer_user_id',(v_scope->>'payer_user_id')::uuid)=v_scope)
   THEN RAISE EXCEPTION 'captured_read_pool_scope_mismatch' USING ERRCODE='23514';END IF;
   r:=fn_pay_captured_player_funding((b->>'pool_id')::uuid,v_actor,(v_scope->>'payer_user_id')::uuid,v_cutoff);
   IF r->>'success' IS DISTINCT FROM 'true' OR r->>'source_final' IS DISTINCT FROM 'false'
    OR jsonb_typeof(r->'new_payout') IS DISTINCT FROM 'number'
   THEN RAISE EXCEPTION 'captured_player_owner_contract_mismatch' USING ERRCODE='23514';END IF;
   v_amount:=(r->>'new_payout')::numeric;
   IF v_amount<0 OR v_amount<>round(v_amount,2) OR v_amount::text IN('NaN','Infinity','-Infinity')
   THEN RAISE EXCEPTION 'captured_player_owner_cash_invalid' USING ERRCODE='23514';END IF;
   IF r->>'deferred' IS NOT NULL THEN v_deferred:=jsonb_build_array(jsonb_build_object('reason',r->>'deferred'));END IF;
   IF v_amount>0 THEN
    v_payment:=fn_ca_captured_player_payment_dto((r->>'payment_id')::uuid);
    IF v_payment IS NULL OR v_payment->>'beneficiary_user_id' IS DISTINCT FROM v_actor::text
     OR v_payment->'scope' IS DISTINCT FROM v_scope OR v_payment->>'pool_id' IS DISTINCT FROM b->>'pool_id'
     OR (v_payment->>'amount')::numeric IS DISTINCT FROM v_amount
    THEN RAISE EXCEPTION 'captured_player_new_receipt_mismatch' USING ERRCODE='23514';END IF;
    v_payments:=v_payments||jsonb_build_array(v_payment);v_ids:=jsonb_build_array(v_payment->>'payment_id');
   ELSIF r->>'payment_id' IS NOT NULL THEN RAISE EXCEPTION 'zero_player_payment_has_receipt' USING ERRCODE='23514';END IF;
   IF r ? 'exact_entitlement' AND (r->>'exact_entitlement')::numeric<(b->>'closed_entitlement_exact')::numeric THEN
    v_deferred:=v_deferred||jsonb_build_array(jsonb_build_object('reason','source_recipient_funding_pending'));
   END IF;
  END IF;
  v_total:=v_total+v_amount;
  v_scopes:=v_scopes||jsonb_build_array(jsonb_build_object('scope',v_scope,'pool_id',b->'pool_id',
   'new_payout',round(v_amount,2)::text,'payment_ids',v_ids,'deferred',v_deferred));
 END LOOP;
 v_result:=jsonb_build_object('schema_version',2,'success',true,'request_id',p_request_id,'beneficiary_user_id',v_actor,
  'club_id',p_club_id,'earning_closed_through',v_cutoff::text,'new_payout',round(v_total,2)::text,
  'payment_count',jsonb_array_length(v_payments),'payments',v_payments,'scopes',v_scopes,'source_final',false);
 INSERT INTO ca_source_player_claim_requests(request_id,actor_id,club_id,result) VALUES(p_request_id,v_actor,p_club_id,v_result);
 RETURN v_result;
END $f$;
REVOKE ALL ON FUNCTION fn_claim_captured_rakeback(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION fn_claim_captured_rakeback(uuid,uuid,uuid) TO authenticated,service_role;

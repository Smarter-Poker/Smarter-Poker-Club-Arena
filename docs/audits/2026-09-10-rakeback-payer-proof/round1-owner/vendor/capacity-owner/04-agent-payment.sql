-- Canonical prospective Round2 candidate; source discovery and money capacity are independent.
CREATE FUNCTION public.fn_pay_captured_agent_funding(p_pool uuid,p_recipient uuid,p_earning_closed_through date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE p public.ca_source_funding_pools%ROWTYPE;r record;v_exact numeric;v_paid numeric;v_due numeric;
 v_available numeric;v_pay numeric;v_high bigint;v_cutoff date;v_digest text;v_id uuid;v_tx uuid;v_debit_tx uuid;v_leg uuid;
 v_bank numeric;v_wallet numeric;v_bank_after numeric;v_wallet_after numeric;v_debit jsonb;
 v_old_club text;v_old_member text;v_remaining numeric;v_slice numeric;v_admitted integer:=0;
BEGIN
 IF p_pool IS NULL OR p_recipient IS NULL OR p_earning_closed_through IS NULL
  OR extract(isodow FROM p_earning_closed_through)<>1
  OR p_earning_closed_through>date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date THEN
  RAISE EXCEPTION 'Invalid closed earning boundary' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT p FROM ca_source_funding_pools WHERE id=p_pool AND contract_version=1;
 IF NOT fn_caller_is_engine() AND (auth.uid() IS NULL OR (auth.uid()<>p_recipient AND NOT fn_is_platform_admin()
  AND NOT EXISTS(SELECT 1 FROM clubs WHERE id=p.club_id AND owner_id=auth.uid())
  AND NOT (p.funding_union_id IS NOT NULL AND fn_is_union_overseer(p.funding_union_id,auth.uid())))) THEN
  RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 PERFORM fn_lock_rakeback_payer_clubs(ARRAY[p.club_id]);
 IF fn_platform_frozen() THEN RETURN jsonb_build_object('success',false,'pool_id',p_pool,'new_payout',0,'deferred','platform_frozen','source_final',false);END IF;
 -- A later applied accrual may arrive after club funding. Revisit only original
 -- admitted pool sources, never arbitrary current Union membership or wallet value.
 FOR r IN SELECT DISTINCT hand_id FROM ca_source_club_funding_admissions WHERE pool_id=p_pool ORDER BY hand_id LOOP
  PERFORM fn_ca_admit_source_funding(r.hand_id,p.club_id);
 END LOOP;
 INSERT INTO ca_source_recipient_funding_admissions(hand_id,contributor_id,agent_id,pool_id,recipient_id,earning_closed_through)
 SELECT a.hand_id,a.contributor_id,a.agent_id,a.pool_id,a.recipient_id,p_earning_closed_through
 FROM ca_source_recipient_accruals a JOIN ca_source_club_funding_admissions c USING(hand_id,contributor_id)
 WHERE a.pool_id=p_pool AND c.pool_id=p_pool AND a.recipient_id=p_recipient AND a.earning_week+7<=p_earning_closed_through
 ORDER BY a.hand_id,a.contributor_id,a.agent_id ON CONFLICT(hand_id,contributor_id,agent_id) DO NOTHING;
 GET DIAGNOSTICS v_admitted=ROW_COUNT;
 SELECT coalesce(sum(x.exact_entitlement),0),coalesce(max(a.admission_seq),0),max(a.earning_closed_through),
  md5(coalesce(string_agg(x.hand_id::text||':'||x.contributor_id::text||':'||x.agent_id::text||':'||x.exact_entitlement::text,',' ORDER BY x.hand_id,x.contributor_id,x.agent_id),''))
 INTO v_exact,v_high,v_cutoff,v_digest FROM ca_source_recipient_funding_admissions a
 JOIN ca_source_recipient_accruals x USING(hand_id,contributor_id,agent_id)
 WHERE a.pool_id=p_pool AND a.recipient_id=p_recipient;
 SELECT coalesce(sum(amount),0) INTO v_paid FROM ca_source_agent_cash_payments WHERE pool_id=p_pool AND recipient_id=p_recipient;
 SELECT (SELECT coalesce(sum(amount),0) FROM ca_source_club_cash_releases WHERE pool_id=p_pool)
  -(SELECT coalesce(sum(c.amount),0) FROM ca_source_club_cash_consumptions c JOIN ca_source_club_cash_releases r ON r.id=c.release_id WHERE r.pool_id=p_pool)
 INTO v_available;
 v_due:=floor(v_exact*100)/100-v_paid;
 IF v_due<0 OR v_available<0 THEN RAISE EXCEPTION 'Captured commission entitlement or cash capacity already exceeded' USING ERRCODE='23514';END IF;
 v_pay:=least(v_due,floor(v_available*100)/100);
 IF v_pay>0 THEN
  -- Pooled capacity is fungible, but every admitted source's contract has already
  -- independently passed its captured club budget and hierarchy margin checks.
  SELECT chip_treasury INTO v_bank FROM clubs WHERE id=p.club_id FOR UPDATE;
  SELECT chip_balance INTO v_wallet FROM club_members WHERE club_id=p.club_id AND user_id=p_recipient FOR UPDATE;
  IF v_bank IS NULL OR v_wallet IS NULL OR v_bank<v_pay THEN
   RETURN jsonb_build_object('success',true,'new_payout',0,'pool_id',p_pool,'exact_entitlement',v_exact,
    'paid',v_paid,'fractional_liability',v_exact-v_paid,'released_capacity',v_available,
    'deferred','captured_recipient_wallet_unavailable_or_club_short','source_final',false);
  END IF;
  v_id:=gen_random_uuid();v_leg:=gen_random_uuid();
  v_old_club:=current_setting('app.ledger_autoskip_clubs',true);
  v_old_member:=current_setting('app.ledger_autoskip_club_members',true);
  PERFORM set_config('app.ledger_autoskip_clubs','1',true);
  v_debit:=fn_debit_treasury(p.club_id,v_pay,'Captured Source Agent Commission',
   jsonb_build_object('payment_id',v_id,'pool_id',p_pool,'earning_closed_through',v_cutoff));
  PERFORM set_config('app.ledger_autoskip_clubs',coalesce(v_old_club,''),true);
  IF (v_debit->>'success')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Locked captured commission debit failed' USING ERRCODE='23514';END IF;
  SELECT id INTO STRICT v_debit_tx FROM chip_transactions
   WHERE club_id=p.club_id AND transaction_type='treasury_debit' AND metadata->>'payment_id'=v_id::text;
  PERFORM set_config('app.ledger_autoskip_club_members','1',true);
  UPDATE club_members SET chip_balance=chip_balance+v_pay,updated_at=now()
   WHERE club_id=p.club_id AND user_id=p_recipient RETURNING chip_balance INTO v_wallet_after;
  PERFORM set_config('app.ledger_autoskip_club_members',coalesce(v_old_member,''),true);
  SELECT chip_treasury INTO v_bank_after FROM clubs WHERE id=p.club_id;
  IF v_bank_after IS NULL OR v_wallet_after IS NULL OR v_bank-v_bank_after IS DISTINCT FROM v_pay OR v_wallet_after-v_wallet IS DISTINCT FROM v_pay THEN
   RAISE EXCEPTION 'Captured commission movement did not conserve' USING ERRCODE='23514';END IF;
  INSERT INTO wallet_transactions(user_id,wallet_type,amount,type,category,description,related_entity_id,balance_after)
  VALUES(p_recipient,'PLAYER',v_pay,'credit','commission','Captured Source Agent Commission',v_id,v_wallet_after) RETURNING id INTO v_tx;
  INSERT INTO chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
   amount,category,club_id,union_id,idempotency_key,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,metadata)
  VALUES(v_leg,coalesce(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),'club_treasury',p.club_id,
   'player_wallet',p_recipient,v_pay,'commission',p.club_id,p.funding_union_id,'captured-agent:'||v_id,
   v_bank,v_bank_after,v_wallet,v_wallet_after,jsonb_build_object('payment_id',v_id,'pool_id',p_pool,
    'wallet_transaction_id',v_tx,'treasury_transaction_id',v_debit_tx,'source_digest',v_digest,'exact_entitlement',v_exact));
  INSERT INTO ca_source_agent_cash_payments(id,club_id,recipient_id,pool_id,earning_closed_through,
   amount,cumulative_exact,cumulative_paid,admission_seq_high_water,source_digest,treasury_transaction_id,wallet_transaction_id,ledger_id)
  VALUES(v_id,p.club_id,p_recipient,p_pool,v_cutoff,v_pay,v_exact,v_paid+v_pay,v_high,v_digest,v_debit_tx,v_tx,v_leg);
  v_remaining:=v_pay;
  FOR r IN SELECT a.hand_id,a.contributor_id,a.agent_id,x.exact_entitlement
    -coalesce((SELECT sum(z.amount) FROM ca_source_agent_payment_slices z WHERE z.hand_id=a.hand_id AND z.contributor_id=a.contributor_id AND z.agent_id=a.agent_id),0) AS remaining
   FROM ca_source_recipient_funding_admissions a JOIN ca_source_recipient_accruals x USING(hand_id,contributor_id,agent_id)
   WHERE a.pool_id=p_pool AND a.recipient_id=p_recipient AND a.admission_seq<=v_high
   ORDER BY x.earning_week,a.hand_id,a.contributor_id,a.agent_id LOOP
   v_slice:=least(v_remaining,r.remaining);
   IF v_slice>0 THEN
    INSERT INTO ca_source_agent_payment_slices(payment_id,hand_id,contributor_id,agent_id,amount)
     VALUES(v_id,r.hand_id,r.contributor_id,r.agent_id,v_slice);
    v_remaining:=v_remaining-v_slice;
   END IF;
   EXIT WHEN v_remaining=0;
  END LOOP;
  IF v_remaining<>0 THEN RAISE EXCEPTION 'Recipient source attribution did not cover actual cash' USING ERRCODE='23514';END IF;
  v_remaining:=v_pay;
  FOR r IN SELECT x.id,x.amount-coalesce((SELECT sum(c.amount) FROM ca_source_club_cash_consumptions c WHERE c.release_id=x.id),0) AS remaining
   FROM ca_source_club_cash_releases x WHERE x.pool_id=p_pool ORDER BY x.release_seq LOOP
   v_slice:=least(v_remaining,r.remaining);
   IF v_slice>0 THEN INSERT INTO ca_source_club_cash_consumptions(payment_id,release_id,amount) VALUES(v_id,r.id,v_slice);
    v_remaining:=v_remaining-v_slice;END IF;
   EXIT WHEN v_remaining=0;
  END LOOP;
  IF v_remaining<>0 THEN RAISE EXCEPTION 'Released cash did not cover actual agent payment' USING ERRCODE='23514';END IF;
  PERFORM fn_ca_assert_source_agent_payment(v_id);
 END IF;
 RETURN jsonb_build_object('success',true,'pool_id',p_pool,'new_payout',v_pay,'exact_entitlement',v_exact,
  'paid',v_paid+v_pay,'fractional_liability',v_exact-v_paid-v_pay,'cash_due',v_due-v_pay,
  'released_capacity',v_available-v_pay,'admissions_added',v_admitted,
  'deferred',CASE WHEN v_due>v_pay THEN 'released_capacity_short' WHEN v_exact>v_paid+v_pay THEN 'fraction_pending' ELSE NULL END,
  'source_final',false);
END $f$;
REVOKE ALL ON FUNCTION public.fn_pay_captured_agent_funding(uuid,uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pay_captured_agent_funding(uuid,uuid,date) TO service_role;
CREATE TABLE public.ca_source_agent_funding_requests (
 request_id uuid PRIMARY KEY,actor_id uuid NOT NULL,club_id uuid NOT NULL,requested_closed_through date NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.ca_source_agent_funding_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_source_agent_funding_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_source_agent_funding_requests TO service_role;
CREATE TRIGGER ca_source_agent_request_immutable BEFORE UPDATE OR DELETE ON public.ca_source_agent_funding_requests
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_source_capacity_immutable();
CREATE TRIGGER ca_source_agent_request_no_truncate BEFORE TRUNCATE ON public.ca_source_agent_funding_requests
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_source_capacity_immutable();
CREATE FUNCTION public.fn_claim_captured_agent_funding(p_club uuid,p_expected_user uuid,p_request uuid,p_closed_through date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_actor uuid:=auth.uid();v_old public.ca_source_agent_funding_requests%ROWTYPE;r record;
 v_result jsonb;v_results jsonb:='[]';v_total numeric:=0;v_success boolean:=true;v_amount numeric;
BEGIN
 IF v_actor IS NULL OR p_club IS NULL OR p_expected_user IS NULL OR p_request IS NULL THEN
  RAISE EXCEPTION 'authentication_and_request_required' USING ERRCODE='42501';END IF;
 IF v_actor<>p_expected_user THEN RAISE EXCEPTION 'captured_claim_account_changed' USING ERRCODE='42501';END IF;
 IF p_closed_through IS NULL OR extract(isodow FROM p_closed_through)<>1
  OR p_closed_through>date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date THEN
  RAISE EXCEPTION 'Invalid closed earning boundary' USING ERRCODE='22023';END IF;
 PERFORM fn_lock_rakeback_payer_clubs(ARRAY[p_club]);
 PERFORM pg_advisory_xact_lock(hashtext('club-arena:captured-agent-request'),hashtext(p_request::text));
 SELECT * INTO v_old FROM ca_source_agent_funding_requests WHERE request_id=p_request;
 IF FOUND THEN
  IF v_old.actor_id<>v_actor OR v_old.club_id<>p_club OR v_old.requested_closed_through<>p_closed_through THEN
   RAISE EXCEPTION 'captured_request_scope_conflict' USING ERRCODE='23514';END IF;
  RETURN v_old.result;
 END IF;
 FOR r IN SELECT id FROM ca_source_funding_pools WHERE club_id=p_club AND contract_version=1 ORDER BY id LOOP
  v_result:=fn_pay_captured_agent_funding(r.id,v_actor,p_closed_through);
  IF jsonb_typeof(v_result->'success') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(v_result->'new_payout') IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'Captured pool payer returned malformed contract' USING ERRCODE='23514';END IF;
  v_amount:=(v_result->>'new_payout')::numeric;
  IF v_amount<0 OR v_amount::text IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'Captured pool payer returned invalid payout' USING ERRCODE='23514';END IF;
  v_success:=v_success AND (v_result->>'success')::boolean;
  v_total:=v_total+v_amount;
  v_results:=v_results||jsonb_build_array(v_result);
 END LOOP;
 v_result:=jsonb_build_object('success',v_success,'request_id',p_request,'amount',v_total,'pools',v_results,'source_final',false);
 INSERT INTO ca_source_agent_funding_requests(request_id,actor_id,club_id,requested_closed_through,result)
 VALUES(p_request,v_actor,p_club,p_closed_through,v_result);
 RETURN v_result;
END $f$;
REVOKE ALL ON FUNCTION public.fn_claim_captured_agent_funding(uuid,uuid,uuid,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_claim_captured_agent_funding(uuid,uuid,uuid,date) TO authenticated,service_role;
CREATE FUNCTION public.fn_captured_agent_funding_report(p_pool uuid,p_recipient uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
 WITH weekly AS(
  SELECT x.earning_week,sum(x.exact_entitlement) AS exact_entitlement,
   sum(coalesce((SELECT sum(s.amount) FROM ca_source_agent_payment_slices s
    WHERE s.hand_id=x.hand_id AND s.contributor_id=x.contributor_id AND s.agent_id=x.agent_id),0)) AS cash_attributed
  FROM ca_source_recipient_accruals x JOIN ca_source_recipient_funding_admissions a USING(hand_id,contributor_id,agent_id)
  WHERE a.pool_id=p_pool AND a.recipient_id=p_recipient GROUP BY x.earning_week
 )
 SELECT jsonb_build_object('pool_id',p_pool,'recipient_id',p_recipient,
  'exact_entitlement',coalesce((SELECT sum(exact_entitlement) FROM weekly),0),
  'cash_paid',coalesce((SELECT sum(amount) FROM ca_source_agent_cash_payments WHERE pool_id=p_pool AND recipient_id=p_recipient),0),
  'weekly_attribution',coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY earning_week) FROM weekly w),'[]'),
  'weekly_amounts_are_exact_attribution',true,'source_final',false)
$f$;
REVOKE ALL ON FUNCTION public.fn_captured_agent_funding_report(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_captured_agent_funding_report(uuid,uuid) TO service_role;
CREATE FUNCTION public.fn_ca_source_payment_money_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM ca_source_agent_cash_payments) THEN
   RAISE EXCEPTION 'Captured commission money evidence is immutable' USING ERRCODE='55000';END IF;
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM ca_source_agent_cash_payments p WHERE
  (TG_TABLE_NAME='wallet_transactions' AND p.wallet_transaction_id=OLD.id)
  OR (TG_TABLE_NAME='chip_transactions' AND p.treasury_transaction_id=OLD.id)
  OR (TG_TABLE_NAME='chip_ledger' AND p.ledger_id=OLD.id)) THEN
  IF TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
   RAISE EXCEPTION 'Captured commission money evidence is immutable' USING ERRCODE='55000';END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_source_payment_money_immutable() FROM PUBLIC,anon,authenticated,service_role;
DO $triggers$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['wallet_transactions','chip_transactions','chip_ledger'] LOOP
  EXECUTE format('CREATE TRIGGER aa_captured_agent_money_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_ca_source_payment_money_immutable()',t);
  EXECUTE format('CREATE TRIGGER aa_captured_agent_money_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_source_payment_money_immutable()',t);
 END LOOP;
END $triggers$;

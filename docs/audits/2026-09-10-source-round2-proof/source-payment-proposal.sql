-- Review prototype only. No production migration or final-source assertion.
BEGIN;
CREATE TABLE public.ca_agent_source_accruals (
 hand_id uuid NOT NULL,contributor_id uuid NOT NULL,agent_id uuid NOT NULL,
 club_id uuid NOT NULL,recipient_id uuid NOT NULL,earning_week date NOT NULL,
 payload_hash text NOT NULL,exact_entitlement numeric NOT NULL,
 contract_rate numeric NOT NULL,downline_rate numeric NOT NULL,
 PRIMARY KEY(hand_id,contributor_id,agent_id),
 FOREIGN KEY(hand_id,contributor_id) REFERENCES public.ca_cash_commission_facts(hand_id,player_id),
 CHECK(extract(isodow FROM earning_week)=1),
 CHECK(exact_entitlement>=0 AND exact_entitlement::text NOT IN ('NaN','Infinity','-Infinity')),
 CHECK(contract_rate BETWEEN 0 AND .70 AND downline_rate BETWEEN 0 AND contract_rate)
);
CREATE INDEX ca_agent_source_accrual_recipient_week ON public.ca_agent_source_accruals(club_id,recipient_id,earning_week);
CREATE TABLE public.ca_agent_source_payments (
 id uuid PRIMARY KEY,club_id uuid NOT NULL,recipient_id uuid NOT NULL,earning_week date NOT NULL,
 amount numeric NOT NULL,cumulative_exact numeric NOT NULL,cumulative_paid numeric NOT NULL,
 source_digest text NOT NULL,source_count integer NOT NULL,
 wallet_transaction_id uuid NOT NULL REFERENCES public.wallet_transactions(id),
 ledger_id uuid NOT NULL REFERENCES public.chip_ledger(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(club_id,recipient_id,earning_week,source_digest),
 CHECK(amount>0 AND amount=round(amount,2)),
 CHECK(cumulative_paid=floor(cumulative_exact*100)/100),
 CHECK(cumulative_exact::text NOT IN ('NaN','Infinity','-Infinity'))
);
CREATE INDEX ca_agent_source_payment_recipient_week ON public.ca_agent_source_payments(club_id,recipient_id,earning_week);
CREATE TABLE public.ca_agent_source_requests (
 request_id uuid PRIMARY KEY,actor_id uuid NOT NULL,club_id uuid NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION public.fn_agent_source_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN RAISE EXCEPTION 'Source commission evidence is immutable' USING ERRCODE='55000'; END $f$;
REVOKE ALL ON FUNCTION public.fn_agent_source_evidence_immutable() FROM PUBLIC,anon,authenticated,service_role;
DO $roles$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['ca_agent_source_accruals','ca_agent_source_payments','ca_agent_source_requests'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',n);
  EXECUTE format('GRANT SELECT ON public.%I TO service_role',n);
  EXECUTE format('CREATE TRIGGER source_evidence_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_agent_source_evidence_immutable()',n);
  EXECUTE format('CREATE TRIGGER source_evidence_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_agent_source_evidence_immutable()',n);
 END LOOP;
END $roles$;

-- Same admission order as player claims, batch and the enclosing Union cascade.
CREATE OR REPLACE FUNCTION public.fn_lock_rakeback_payer_clubs(p_club_ids uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE c uuid;
BEGIN
 FOR c IN SELECT DISTINCT x FROM unnest(p_club_ids) x WHERE x IS NOT NULL ORDER BY x LOOP
  PERFORM pg_advisory_xact_lock(hashtext('club-arena:rakeback-payer'),hashtext(c::text));
 END LOOP;
END $f$;
REVOKE ALL ON FUNCTION public.fn_lock_rakeback_payer_clubs(uuid[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_pay_source_agent_week(p_club uuid,p_recipient uuid,p_week date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE f record;a jsonb;v_exact numeric;v_paid numeric;v_due numeric;v_count integer;
 v_digest text;v_id uuid;v_tx uuid;v_leg uuid;v_bank numeric;v_wallet numeric;
 v_bank_after numeric;v_wallet_after numeric;v_old_club text;v_old_member text;
 v_debit jsonb;v_receipts jsonb;v_added integer:=0;
BEGIN
 IF p_club IS NULL OR p_recipient IS NULL OR p_week IS NULL OR extract(isodow FROM p_week)<>1 THEN
  RAISE EXCEPTION 'Invalid source commission scope' USING ERRCODE='22023'; END IF;
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR (auth.uid()<>p_recipient
 AND NOT public.fn_is_platform_admin() AND NOT EXISTS(SELECT 1 FROM clubs WHERE id=p_club AND owner_id=auth.uid())
 AND NOT EXISTS(SELECT 1 FROM union_clubs uc WHERE uc.club_id=p_club AND public.fn_is_union_overseer(uc.union_id,auth.uid())))) THEN
  RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY[p_club]);
 IF public.fn_platform_frozen() THEN RETURN jsonb_build_object('success',false,'deferred','platform_frozen'); END IF;
 -- The applied receipt is an accrual witness only. This prototype still lacks
 -- the required immutable Union-to-club source funding bridge. It is not deployable.
 -- Neither old ac.amount rows nor current membership create a new entitlement.
 FOR f IN SELECT s.hand_id,s.accepted_payload_hash,facts.player_id,facts.rake_credit,r.allocations
  FROM public.ca_cash_commission_sources s JOIN public.ca_cash_commission_facts facts USING(hand_id)
  JOIN public.ca_cash_commission_authority cut ON cut.singleton AND cut.contract_version=1
  JOIN public.hand_atomic_commits h ON h.hand_id=s.hand_id AND h.commission_capture_version=cut.contract_version
   AND h.post_commit_payload_hash=s.accepted_payload_hash
  JOIN public.ca_commission_contributor_receipts r ON r.source_type='rake_settlement'
   AND r.source_id=s.hand_id AND r.contributing_user_id=facts.player_id
   AND r.booked_club_id=facts.booked_club_id AND r.rake_credit=facts.rake_credit AND r.state='applied'
  WHERE facts.booked_club_id=p_club AND facts.errors='[]'::jsonb
   AND s.settled_at>=(p_week::timestamp AT TIME ZONE 'UTC')
   AND s.settled_at<((p_week+7)::timestamp AT TIME ZONE 'UTC')
  ORDER BY s.hand_id,facts.player_id
 LOOP
  FOR a IN SELECT value FROM jsonb_array_elements(f.allocations) WHERE value->>'user_id'=p_recipient::text LOOP
   IF a->>'amount_authority' IS DISTINCT FROM 'compatibility_projection_only'
    OR (a->>'exact_entitlement')::numeric IS DISTINCT FROM f.rake_credit*((a->>'contract_rate')::numeric-(a->>'downline_contract_rate')::numeric)
    OR (a->>'exact_cumulative_entitlement')::numeric IS DISTINCT FROM f.rake_credit*(a->>'contract_rate')::numeric THEN
    RAISE EXCEPTION 'Exact source allocation witness missing or contradictory' USING ERRCODE='23514'; END IF;
   INSERT INTO public.ca_agent_source_accruals(hand_id,contributor_id,agent_id,club_id,recipient_id,
    earning_week,payload_hash,exact_entitlement,contract_rate,downline_rate)
   VALUES(f.hand_id,f.player_id,(a->>'agent_id')::uuid,p_club,p_recipient,p_week,
    f.accepted_payload_hash,(a->>'exact_entitlement')::numeric,(a->>'contract_rate')::numeric,(a->>'downline_contract_rate')::numeric)
   ON CONFLICT(hand_id,contributor_id,agent_id) DO NOTHING;
   IF FOUND THEN v_added:=v_added+1; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.ca_agent_source_accruals x WHERE x.hand_id=f.hand_id
    AND x.contributor_id=f.player_id AND x.agent_id=(a->>'agent_id')::uuid AND x.club_id=p_club
    AND x.recipient_id=p_recipient AND x.earning_week=p_week AND x.payload_hash=f.accepted_payload_hash
    AND x.exact_entitlement=(a->>'exact_entitlement')::numeric
    AND x.contract_rate=(a->>'contract_rate')::numeric AND x.downline_rate=(a->>'downline_contract_rate')::numeric) THEN
    RAISE EXCEPTION 'Source commission accrual conflicts with accepted allocation' USING ERRCODE='23514'; END IF;
  END LOOP;
 END LOOP;
 SELECT coalesce(sum(exact_entitlement),0),count(*)::integer,
  md5(coalesce(string_agg(hand_id::text||':'||contributor_id::text||':'||agent_id::text||':'||payload_hash,',' ORDER BY hand_id,contributor_id,agent_id),''))
 INTO v_exact,v_count,v_digest FROM public.ca_agent_source_accruals
 WHERE club_id=p_club AND recipient_id=p_recipient AND earning_week=p_week;
 SELECT coalesce(sum(amount),0) INTO v_paid FROM public.ca_agent_source_payments
 WHERE club_id=p_club AND recipient_id=p_recipient AND earning_week=p_week;
 v_due:=floor(v_exact*100)/100-v_paid;
 IF v_due<0 THEN RAISE EXCEPTION 'Source receipts exceed provisional exact entitlement' USING ERRCODE='23514'; END IF;
 IF v_due>0 THEN
  SELECT chip_treasury INTO v_bank FROM public.clubs WHERE id=p_club FOR UPDATE;
  SELECT chip_balance INTO v_wallet FROM public.club_members WHERE club_id=p_club AND user_id=p_recipient FOR UPDATE;
  IF v_bank IS NULL OR v_wallet IS NULL OR v_bank<v_due THEN
   RETURN jsonb_build_object('success',true,'new_payout',0,'exact_entitlement',v_exact,'paid',v_paid,
    'deferred','captured_recipient_wallet_unavailable_or_club_short','source_final',false);
  END IF;
  v_id:=gen_random_uuid();v_leg:=gen_random_uuid();
  v_old_club:=current_setting('app.ledger_autoskip_clubs',true);
  v_old_member:=current_setting('app.ledger_autoskip_club_members',true);
  PERFORM set_config('app.ledger_autoskip_clubs','1',true);
  v_debit:=public.fn_debit_treasury(p_club,v_due,'Captured Source Agent Commission',jsonb_build_object('payment_id',v_id,'earning_week',p_week));
  PERFORM set_config('app.ledger_autoskip_clubs',coalesce(v_old_club,''),true);
  IF (v_debit->>'success')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Locked source commission debit failed'; END IF;
  PERFORM set_config('app.ledger_autoskip_club_members','1',true);
  UPDATE public.club_members SET chip_balance=chip_balance+v_due,updated_at=now()
   WHERE club_id=p_club AND user_id=p_recipient RETURNING chip_balance INTO v_wallet_after;
  PERFORM set_config('app.ledger_autoskip_club_members',coalesce(v_old_member,''),true);
  SELECT chip_treasury INTO v_bank_after FROM public.clubs WHERE id=p_club;
  IF v_wallet_after IS NULL OR v_bank-v_bank_after<>v_due OR v_wallet_after-v_wallet<>v_due THEN
   RAISE EXCEPTION 'Source commission movement did not conserve' USING ERRCODE='23514'; END IF;
  INSERT INTO public.wallet_transactions(user_id,wallet_type,amount,type,category,description,related_entity_id,balance_after)
  VALUES(p_recipient,'PLAYER',v_due,'credit','commission','Captured Source Agent Commission',v_id,v_wallet_after) RETURNING id INTO v_tx;
  INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
   amount,category,club_id,idempotency_key,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,metadata)
  VALUES(v_leg,coalesce(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),'club_treasury',p_club,
   'player_wallet',p_recipient,v_due,'commission',p_club,'commission-source:'||v_id,
   v_bank,v_bank_after,v_wallet,v_wallet_after,jsonb_build_object('payment_id',v_id,'earning_week',p_week,
    'wallet_transaction_id',v_tx,'source_count',v_count,'source_digest',v_digest,'exact_entitlement',v_exact));
  INSERT INTO public.ca_agent_source_payments(id,club_id,recipient_id,earning_week,amount,
   cumulative_exact,cumulative_paid,source_digest,source_count,wallet_transaction_id,ledger_id)
  VALUES(v_id,p_club,p_recipient,p_week,v_due,v_exact,v_paid+v_due,v_digest,v_count,v_tx,v_leg);
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY created_at,id),'[]') INTO v_receipts
 FROM public.ca_agent_source_payments p WHERE club_id=p_club AND recipient_id=p_recipient AND earning_week=p_week;
 RETURN jsonb_build_object('success',true,'new_payout',v_due,'exact_entitlement',v_exact,
  'paid',v_paid+v_due,'fractional_liability',v_exact-(v_paid+v_due),'source_accruals_added',v_added,
  'paid_receipts',v_receipts,'source_final',false);
END $f$;
REVOKE ALL ON FUNCTION public.fn_pay_source_agent_week(uuid,uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pay_source_agent_week(uuid,uuid,date) TO service_role;

CREATE FUNCTION public.fn_claim_source_agent_commission(p_club uuid,p_expected_user uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_actor uuid:=auth.uid();v_old record;r record;v_result jsonb;v_results jsonb:='[]';v_total numeric:=0;
BEGIN
 IF v_actor IS NULL OR p_club IS NULL OR p_expected_user IS NULL OR p_request IS NULL THEN RAISE EXCEPTION 'authentication_and_request_required' USING ERRCODE='42501'; END IF;
 IF v_actor<>p_expected_user THEN RAISE EXCEPTION 'source_claim_account_changed' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('club-arena:source-agent-request'),hashtext(p_request::text));
 SELECT * INTO v_old FROM public.ca_agent_source_requests WHERE request_id=p_request;
 IF FOUND THEN
  IF v_old.actor_id<>v_actor OR v_old.club_id<>p_club THEN RAISE EXCEPTION 'source_request_scope_conflict' USING ERRCODE='23514'; END IF;
  RETURN v_old.result;
 END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY[p_club]);
 FOR r IN SELECT DISTINCT date_trunc('week',s.settled_at AT TIME ZONE 'UTC')::date AS week
  FROM public.ca_cash_commission_sources s JOIN public.ca_cash_commission_facts f USING(hand_id)
  JOIN public.ca_cash_commission_authority a ON a.singleton AND a.contract_version=1
  JOIN public.hand_atomic_commits h ON h.hand_id=s.hand_id AND h.commission_capture_version=a.contract_version
   AND h.post_commit_payload_hash=s.accepted_payload_hash
  WHERE f.booked_club_id=p_club ORDER BY week LOOP
  v_result:=public.fn_pay_source_agent_week(p_club,v_actor,r.week);
  v_total:=v_total+coalesce((v_result->>'new_payout')::numeric,0);v_results:=v_results||jsonb_build_array(v_result);
 END LOOP;
 v_result:=jsonb_build_object('success',true,'request_id',p_request,'amount',v_total,'periods',v_results,'source_final',false);
 INSERT INTO public.ca_agent_source_requests(request_id,actor_id,club_id,result) VALUES(p_request,v_actor,p_club,v_result);
 RETURN v_result;
END $f$;
REVOKE ALL ON FUNCTION public.fn_claim_source_agent_commission(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_claim_source_agent_commission(uuid,uuid,uuid) TO authenticated,service_role;
CREATE FUNCTION public.fn_agent_source_paid_money_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.ca_agent_source_payments) THEN
   RAISE EXCEPTION 'Source commission money evidence is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM public.ca_agent_source_payments p WHERE
   (TG_TABLE_NAME='wallet_transactions' AND p.wallet_transaction_id=OLD.id)
   OR (TG_TABLE_NAME='chip_ledger' AND p.ledger_id=OLD.id)) THEN
  IF TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
   RAISE EXCEPTION 'Source commission money evidence is immutable' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $f$;
REVOKE ALL ON FUNCTION public.fn_agent_source_paid_money_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER aa_agent_source_money_immutable BEFORE UPDATE OR DELETE ON public.wallet_transactions
 FOR EACH ROW EXECUTE FUNCTION public.fn_agent_source_paid_money_immutable();
CREATE TRIGGER aa_agent_source_money_immutable BEFORE UPDATE OR DELETE ON public.chip_ledger
 FOR EACH ROW EXECUTE FUNCTION public.fn_agent_source_paid_money_immutable();
CREATE TRIGGER aa_agent_source_money_no_truncate BEFORE TRUNCATE ON public.wallet_transactions
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_agent_source_paid_money_immutable();
CREATE TRIGGER aa_agent_source_money_no_truncate BEFORE TRUNCATE ON public.chip_ledger
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_agent_source_paid_money_immutable();
COMMIT;

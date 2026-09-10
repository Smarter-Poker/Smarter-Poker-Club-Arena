-- PROPOSAL ONLY: cumulative player funding bridge; no RPC cutover or activation.
CREATE TABLE public.ca_source_player_funding_admissions(
 admission_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,hand_id uuid NOT NULL,player_id uuid NOT NULL,
 agent_id uuid NOT NULL,pool_id uuid NOT NULL REFERENCES ca_source_funding_pools(id),payer_user_id uuid NOT NULL,
 earning_week date NOT NULL,earning_closed_through date NOT NULL,exact_entitlement numeric NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(hand_id,player_id),
 FOREIGN KEY(hand_id,player_id,agent_id) REFERENCES ca_source_recipient_funding_admissions(hand_id,contributor_id,agent_id),
 CHECK(player_id<>payer_user_id),CHECK(exact_entitlement>=0 AND exact_entitlement::text NOT IN ('NaN','Infinity','-Infinity')),
 CHECK(extract(isodow FROM earning_week)=1 AND extract(isodow FROM earning_closed_through)=1 AND earning_week+7<=earning_closed_through));
CREATE INDEX ca_source_player_admission_scope ON ca_source_player_funding_admissions(pool_id,player_id,payer_user_id,admission_seq);
CREATE TABLE public.ca_source_player_cash_payments(
 payment_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,id uuid PRIMARY KEY,
 pool_id uuid NOT NULL REFERENCES ca_source_funding_pools(id),player_id uuid NOT NULL,payer_user_id uuid NOT NULL,
 amount numeric NOT NULL,cumulative_exact numeric NOT NULL,cumulative_paid numeric NOT NULL,
 admission_seq_high_water bigint NOT NULL,source_digest text NOT NULL,earning_closed_through date NOT NULL,
 debit_transaction_id uuid NOT NULL UNIQUE REFERENCES wallet_transactions(id),
 credit_transaction_id uuid NOT NULL UNIQUE REFERENCES wallet_transactions(id),
 ledger_id uuid NOT NULL UNIQUE REFERENCES chip_ledger(id),paid_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(player_id<>payer_user_id),CHECK(amount>0 AND amount=round(amount,2) AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 CHECK(cumulative_exact>=0 AND cumulative_exact::text NOT IN ('NaN','Infinity','-Infinity')),
 CHECK(cumulative_paid>=amount AND cumulative_paid<=floor(cumulative_exact*100)/100));
CREATE INDEX ca_source_player_cash_scope ON ca_source_player_cash_payments(pool_id,player_id,payer_user_id,payment_seq);
CREATE TABLE public.ca_source_player_payment_slices(
 payment_id uuid NOT NULL REFERENCES ca_source_player_cash_payments(id),hand_id uuid NOT NULL,player_id uuid NOT NULL,
 amount numeric NOT NULL,PRIMARY KEY(payment_id,hand_id,player_id),
 FOREIGN KEY(hand_id,player_id) REFERENCES ca_source_player_funding_admissions(hand_id,player_id),
 CHECK(amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity')));
CREATE TABLE public.ca_source_agent_cash_consumptions(
 payment_id uuid NOT NULL REFERENCES ca_source_player_cash_payments(id),
 agent_payment_id uuid NOT NULL REFERENCES ca_source_agent_cash_payments(id),amount numeric NOT NULL,
 PRIMARY KEY(payment_id,agent_payment_id),CHECK(amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity')));
CREATE INDEX ca_source_agent_cash_consumption_receipt ON ca_source_agent_cash_consumptions(agent_payment_id,payment_id);
DO $acl$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['ca_source_player_funding_admissions','ca_source_player_cash_payments','ca_source_player_payment_slices','ca_source_agent_cash_consumptions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);
 EXECUTE format('CREATE TRIGGER ca_player_evidence_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION fn_ca_source_capacity_immutable()',t);
 EXECUTE format('CREATE TRIGGER ca_player_evidence_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_source_capacity_immutable()',t);
 END LOOP;END $acl$;
CREATE FUNCTION public.fn_ca_assert_source_player_admission(p_hand uuid,p_player uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE a ca_source_player_funding_admissions%ROWTYPE;
BEGIN
 SELECT * INTO STRICT a FROM ca_source_player_funding_admissions WHERE hand_id=p_hand AND player_id=p_player;
 PERFORM fn_ca_assert_source_accrual(a.hand_id,a.player_id,a.agent_id);
 IF NOT EXISTS(SELECT 1 FROM ca_source_recipient_funding_admissions r
  JOIN ca_source_recipient_accruals x USING(hand_id,contributor_id,agent_id)
  JOIN ca_cash_commission_facts f ON f.hand_id=r.hand_id AND f.player_id=r.contributor_id
  WHERE r.hand_id=a.hand_id AND r.contributor_id=a.player_id AND r.agent_id=a.agent_id
   AND r.pool_id=a.pool_id AND r.recipient_id=a.payer_user_id AND x.is_direct_payer
   AND x.earning_week=a.earning_week AND f.direct_agent_id=a.agent_id AND f.payer_user_id=a.payer_user_id
   AND f.assignment_state='assigned' AND f.errors='[]'::jsonb
   AND f.player_rebate_rate>=0 AND f.direct_commission_rate<=.70
   AND f.player_rebate_rate<=greatest(f.direct_commission_rate-.10,0)
   AND f.player_rebate_entitlement=f.rake_credit*f.player_rebate_rate
   AND a.exact_entitlement=f.player_rebate_entitlement)
  OR a.earning_closed_through>date_trunc('week',a.admitted_at AT TIME ZONE 'UTC')::date
 THEN RAISE EXCEPTION 'Player source admission contradicts captured payer or funded source' USING ERRCODE='23514';END IF;
END $f$;
CREATE FUNCTION public.fn_ca_assert_source_player_payment(p_payment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE p ca_source_player_cash_payments%ROWTYPE;v_exact numeric;v_paid numeric;v_digest text;v_cutoff date;
 s ca_source_funding_pools%ROWTYPE;l chip_ledger%ROWTYPE;d wallet_transactions%ROWTYPE;c wallet_transactions%ROWTYPE;
BEGIN
 SELECT * INTO STRICT p FROM ca_source_player_cash_payments WHERE id=p_payment;
 SELECT * INTO STRICT s FROM ca_source_funding_pools WHERE id=p.pool_id;
 SELECT coalesce(sum(exact_entitlement),0),max(earning_closed_through),
 md5(coalesce(string_agg(hand_id::text||':'||player_id::text||':'||payer_user_id::text||':'||exact_entitlement::text,',' ORDER BY hand_id,player_id),''))
 INTO v_exact,v_cutoff,v_digest FROM ca_source_player_funding_admissions
 WHERE pool_id=p.pool_id AND player_id=p.player_id AND payer_user_id=p.payer_user_id AND admission_seq<=p.admission_seq_high_water;
 SELECT coalesce(sum(amount),0) INTO v_paid FROM ca_source_player_cash_payments
 WHERE pool_id=p.pool_id AND player_id=p.player_id AND payer_user_id=p.payer_user_id AND payment_seq<=p.payment_seq;
 IF p.cumulative_exact IS DISTINCT FROM v_exact OR p.cumulative_paid IS DISTINCT FROM v_paid
  OR p.earning_closed_through IS DISTINCT FROM v_cutoff OR p.source_digest IS DISTINCT FROM v_digest
  OR p.amount IS DISTINCT FROM (SELECT sum(amount) FROM ca_source_player_payment_slices WHERE payment_id=p.id)
  OR p.amount IS DISTINCT FROM (SELECT sum(amount) FROM ca_source_agent_cash_consumptions WHERE payment_id=p.id)
  OR EXISTS(SELECT 1 FROM ca_source_player_payment_slices z JOIN ca_source_player_funding_admissions a USING(hand_id,player_id)
   WHERE z.payment_id=p.id AND (a.pool_id<>p.pool_id OR a.player_id<>p.player_id OR a.payer_user_id<>p.payer_user_id
    OR a.admission_seq>p.admission_seq_high_water OR
    (SELECT sum(z2.amount) FROM ca_source_player_payment_slices z2 WHERE z2.hand_id=z.hand_id AND z2.player_id=z.player_id)>a.exact_entitlement))
  OR EXISTS(SELECT 1 FROM ca_source_agent_cash_consumptions z JOIN ca_source_agent_cash_payments a ON a.id=z.agent_payment_id
   WHERE z.payment_id=p.id AND (a.pool_id<>p.pool_id OR a.recipient_id<>p.payer_user_id OR
    (SELECT sum(z2.amount) FROM ca_source_agent_cash_consumptions z2 WHERE z2.agent_payment_id=a.id)>a.amount))
 THEN RAISE EXCEPTION 'Player cash exceeds admitted source rights or actual agent cash capacity' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT l FROM chip_ledger WHERE id=p.ledger_id;
 SELECT * INTO STRICT d FROM wallet_transactions WHERE id=p.debit_transaction_id;
 SELECT * INTO STRICT c FROM wallet_transactions WHERE id=p.credit_transaction_id;
 IF l.status IS DISTINCT FROM 'posted' OR l.category IS DISTINCT FROM 'rakeback'
  OR l.club_id IS DISTINCT FROM s.club_id OR l.union_id IS DISTINCT FROM s.funding_union_id
  OR l.from_type IS DISTINCT FROM 'player_wallet' OR l.from_entity_id IS DISTINCT FROM p.payer_user_id
  OR l.to_type IS DISTINCT FROM 'player_wallet' OR l.to_entity_id IS DISTINCT FROM p.player_id
  OR l.amount IS DISTINCT FROM p.amount OR l.idempotency_key IS DISTINCT FROM 'source-player:'||p.id::text
  OR l.pre_from_balance-l.post_from_balance IS DISTINCT FROM p.amount OR l.post_to_balance-l.pre_to_balance IS DISTINCT FROM p.amount
  OR l.metadata->>'payment_id' IS DISTINCT FROM p.id::text OR l.metadata->>'pool_id' IS DISTINCT FROM p.pool_id::text
  OR l.metadata->>'source_digest' IS DISTINCT FROM p.source_digest
  OR l.metadata->>'debit_transaction_id' IS DISTINCT FROM p.debit_transaction_id::text
  OR l.metadata->>'credit_transaction_id' IS DISTINCT FROM p.credit_transaction_id::text
  OR d.user_id IS DISTINCT FROM p.payer_user_id OR d.wallet_type IS DISTINCT FROM 'PLAYER'
  OR d.type IS DISTINCT FROM 'debit' OR d.category IS DISTINCT FROM 'rakeback' OR d.amount IS DISTINCT FROM p.amount
  OR d.related_entity_id IS DISTINCT FROM p.id OR d.balance_after IS DISTINCT FROM l.post_from_balance
  OR c.user_id IS DISTINCT FROM p.player_id OR c.wallet_type IS DISTINCT FROM 'PLAYER'
  OR c.type IS DISTINCT FROM 'credit' OR c.category IS DISTINCT FROM 'rakeback' OR c.amount IS DISTINCT FROM p.amount
  OR c.related_entity_id IS DISTINCT FROM p.id OR c.balance_after IS DISTINCT FROM l.post_to_balance
 THEN RAISE EXCEPTION 'Player actual money receipt mismatch' USING ERRCODE='23514';END IF;
END $f$;
CREATE FUNCTION public.fn_ca_source_player_assert_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
BEGIN
 IF TG_TABLE_NAME='ca_source_player_funding_admissions' THEN
  PERFORM fn_ca_assert_source_player_admission(NEW.hand_id,NEW.player_id);
 ELSIF TG_TABLE_NAME='ca_source_player_cash_payments' THEN PERFORM fn_ca_assert_source_player_payment(NEW.id);
 ELSE PERFORM fn_ca_assert_source_player_payment(NEW.payment_id);END IF;
 RETURN NULL;
END $f$;
DO $tr$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['ca_source_player_funding_admissions','ca_source_player_cash_payments','ca_source_player_payment_slices','ca_source_agent_cash_consumptions'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER ca_source_player_assert AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_source_player_assert_trigger()',t);
 END LOOP;END $tr$;
REVOKE ALL ON FUNCTION fn_ca_assert_source_player_admission(uuid,uuid),fn_ca_assert_source_player_payment(uuid),
 fn_ca_source_player_assert_trigger() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_pay_captured_player_funding(p_pool uuid,p_player uuid,p_payer uuid,p_closed_through date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE p ca_source_funding_pools%ROWTYPE;r record;v_exact numeric;v_paid numeric;v_due numeric;v_available numeric;v_pay numeric;
 v_seq bigint;v_digest text;v_cutoff date;v_before numeric;v_after numeric;v_player_before numeric;v_player_after numeric;
 v_skip text;v_id uuid;v_debit uuid;v_credit uuid;v_ledger uuid;v_left numeric;v_take numeric;v_count integer;
BEGIN
 IF p_player IS NULL OR p_payer IS NULL OR p_player=p_payer OR p_closed_through IS NULL
  OR extract(isodow FROM p_closed_through)<>1 OR p_closed_through>date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date
 THEN RAISE EXCEPTION 'invalid_closed_player_scope' USING ERRCODE='22023';END IF;
 SELECT * INTO STRICT p FROM ca_source_funding_pools WHERE id=p_pool AND contract_version=1;
 IF NOT fn_caller_is_engine() AND (auth.uid() IS NULL OR (auth.uid()<>p_player AND NOT fn_is_platform_admin()
  AND NOT EXISTS(SELECT 1 FROM clubs WHERE id=p.club_id AND owner_id=auth.uid())
  AND NOT (p.funding_union_id IS NOT NULL AND fn_is_union_overseer(p.funding_union_id,auth.uid()))))
 THEN RAISE EXCEPTION 'not_authorised_for_original_player_scope' USING ERRCODE='42501';END IF;
 PERFORM fn_lock_rakeback_payer_clubs(ARRAY[p.club_id]);
 IF fn_platform_frozen() THEN RETURN jsonb_build_object('success',true,'new_payout',0,'payment_id',NULL,'deferred','platform_frozen','source_final',false);END IF;
 INSERT INTO ca_source_player_funding_admissions(hand_id,player_id,agent_id,pool_id,payer_user_id,earning_week,earning_closed_through,exact_entitlement)
 SELECT a.hand_id,a.contributor_id,a.agent_id,a.pool_id,a.recipient_id,x.earning_week,p_closed_through,f.player_rebate_entitlement
 FROM ca_source_recipient_funding_admissions a JOIN ca_source_recipient_accruals x USING(hand_id,contributor_id,agent_id)
 JOIN ca_cash_commission_facts f ON f.hand_id=a.hand_id AND f.player_id=a.contributor_id
 WHERE a.pool_id=p_pool AND a.recipient_id=p_payer AND a.contributor_id=p_player AND x.is_direct_payer
  AND x.earning_week+7<=p_closed_through AND f.assignment_state='assigned' AND f.errors='[]'::jsonb
  AND f.payer_user_id=p_payer AND f.direct_agent_id=a.agent_id AND f.player_rebate_entitlement>=0
  AND f.player_rebate_entitlement=f.rake_credit*f.player_rebate_rate
  AND f.player_rebate_rate<=greatest(f.direct_commission_rate-.10,0)
 ORDER BY a.hand_id,a.contributor_id ON CONFLICT(hand_id,player_id) DO NOTHING;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 SELECT coalesce(sum(exact_entitlement),0),coalesce(max(admission_seq),0),max(earning_closed_through),
 md5(coalesce(string_agg(hand_id::text||':'||player_id::text||':'||payer_user_id::text||':'||exact_entitlement::text,',' ORDER BY hand_id,player_id),''))
 INTO v_exact,v_seq,v_cutoff,v_digest FROM ca_source_player_funding_admissions
 WHERE pool_id=p_pool AND player_id=p_player AND payer_user_id=p_payer;
 SELECT coalesce(sum(amount),0) INTO v_paid FROM ca_source_player_cash_payments WHERE pool_id=p_pool AND player_id=p_player AND payer_user_id=p_payer;
 SELECT (SELECT coalesce(sum(amount),0) FROM ca_source_agent_cash_payments WHERE pool_id=p_pool AND recipient_id=p_payer)-
 (SELECT coalesce(sum(c.amount),0) FROM ca_source_agent_cash_consumptions c JOIN ca_source_agent_cash_payments a ON a.id=c.agent_payment_id WHERE a.pool_id=p_pool AND a.recipient_id=p_payer)
 INTO v_available;
 v_due:=floor(v_exact*100)/100-v_paid;
 IF v_due<0 OR v_available<0 THEN RAISE EXCEPTION 'player_source_or_capacity_already_exceeded' USING ERRCODE='23514';END IF;
 v_pay:=least(v_due,floor(v_available*100)/100);
 IF v_pay>0 THEN
  PERFORM 1 FROM club_members WHERE club_id=p.club_id AND user_id=ANY(ARRAY[p_player,p_payer]) ORDER BY user_id FOR UPDATE;
  SELECT chip_balance INTO v_before FROM club_members WHERE club_id=p.club_id AND user_id=p_payer;
  SELECT chip_balance INTO v_player_before FROM club_members WHERE club_id=p.club_id AND user_id=p_player;
  IF v_before IS NULL OR v_player_before IS NULL OR v_before<v_pay THEN
   RETURN jsonb_build_object('success',true,'new_payout',0,'payment_id',NULL,'admissions_added',v_count,'deferred','captured_player_or_payer_wallet_unavailable_or_short','source_final',false);
  END IF;
  v_id:=gen_random_uuid();v_ledger:=gen_random_uuid();v_skip:=current_setting('app.ledger_autoskip_club_members',true);
  PERFORM set_config('app.ledger_autoskip_club_members','1',true);
  UPDATE club_members SET chip_balance=chip_balance-v_pay,updated_at=now() WHERE club_id=p.club_id AND user_id=p_payer RETURNING chip_balance INTO v_after;
  IF NOT FOUND THEN RAISE EXCEPTION 'captured_payer_wallet_update_missing' USING ERRCODE='23514';END IF;
  UPDATE club_members SET chip_balance=chip_balance+v_pay,updated_at=now() WHERE club_id=p.club_id AND user_id=p_player RETURNING chip_balance INTO v_player_after;
  IF NOT FOUND OR v_before-v_after IS DISTINCT FROM v_pay OR v_player_after-v_player_before IS DISTINCT FROM v_pay
  THEN RAISE EXCEPTION 'captured_player_wallet_did_not_conserve' USING ERRCODE='23514';END IF;
  PERFORM set_config('app.ledger_autoskip_club_members',coalesce(v_skip,''),true);
  INSERT INTO wallet_transactions(user_id,wallet_type,amount,type,category,description,related_entity_id,balance_after)
  VALUES(p_payer,'PLAYER',v_pay,'debit','rakeback','Captured Source Player Rakeback',v_id,v_after) RETURNING id INTO v_debit;
  INSERT INTO wallet_transactions(user_id,wallet_type,amount,type,category,description,related_entity_id,balance_after)
  VALUES(p_player,'PLAYER',v_pay,'credit','rakeback','Captured Source Player Rakeback',v_id,v_player_after) RETURNING id INTO v_credit;
  INSERT INTO chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,
   idempotency_key,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,metadata)
  VALUES(v_ledger,coalesce(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),'player_wallet',p_payer,'player_wallet',p_player,
   v_pay,'rakeback',p.club_id,p.funding_union_id,'source-player:'||v_id::text,v_before,v_after,v_player_before,v_player_after,
   jsonb_build_object('payment_id',v_id,'pool_id',p_pool,'source_digest',v_digest,'debit_transaction_id',v_debit,'credit_transaction_id',v_credit));
  INSERT INTO ca_source_player_cash_payments(id,pool_id,player_id,payer_user_id,amount,cumulative_exact,cumulative_paid,
   admission_seq_high_water,source_digest,earning_closed_through,debit_transaction_id,credit_transaction_id,ledger_id)
  VALUES(v_id,p_pool,p_player,p_payer,v_pay,v_exact,v_paid+v_pay,v_seq,v_digest,v_cutoff,v_debit,v_credit,v_ledger);
  v_left:=v_pay;
  FOR r IN SELECT a.*,a.exact_entitlement-coalesce((SELECT sum(s.amount) FROM ca_source_player_payment_slices s WHERE s.hand_id=a.hand_id AND s.player_id=a.player_id),0) remaining
   FROM ca_source_player_funding_admissions a WHERE pool_id=p_pool AND player_id=p_player AND payer_user_id=p_payer AND admission_seq<=v_seq
   ORDER BY earning_week,hand_id,player_id LOOP
   v_take:=least(v_left,r.remaining);
   IF v_take>0 THEN INSERT INTO ca_source_player_payment_slices(payment_id,hand_id,player_id,amount) VALUES(v_id,r.hand_id,r.player_id,v_take);v_left:=v_left-v_take;END IF;
   EXIT WHEN v_left=0;END LOOP;
  IF v_left<>0 THEN RAISE EXCEPTION 'player_exact_source_slices_short' USING ERRCODE='23514';END IF;
  v_left:=v_pay;
  FOR r IN SELECT a.id,a.amount-coalesce((SELECT sum(c.amount) FROM ca_source_agent_cash_consumptions c WHERE c.agent_payment_id=a.id),0) remaining
   FROM ca_source_agent_cash_payments a WHERE pool_id=p_pool AND recipient_id=p_payer ORDER BY payment_seq LOOP
   v_take:=least(v_left,r.remaining);
   IF v_take>0 THEN INSERT INTO ca_source_agent_cash_consumptions(payment_id,agent_payment_id,amount) VALUES(v_id,r.id,v_take);v_left:=v_left-v_take;END IF;
   EXIT WHEN v_left=0;END LOOP;
  IF v_left<>0 THEN RAISE EXCEPTION 'actual_agent_cash_capacity_short' USING ERRCODE='23514';END IF;
  PERFORM fn_ca_assert_source_player_payment(v_id);
 END IF;
 RETURN jsonb_build_object('success',true,'pool_id',p_pool,'player_id',p_player,'payer_user_id',p_payer,'new_payout',v_pay,
  'payment_id',v_id,'admissions_added',v_count,'exact_entitlement',v_exact,'paid',v_paid+v_pay,'remaining_exact',v_exact-v_paid-v_pay,
  'deferred',CASE WHEN v_due>v_pay THEN 'actual_agent_cash_capacity_short' WHEN v_exact>v_paid+v_pay THEN 'fraction_pending' ELSE NULL END,'source_final',false);
END $f$;
REVOKE ALL ON FUNCTION fn_pay_captured_player_funding(uuid,uuid,uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fn_pay_captured_player_funding(uuid,uuid,uuid,date) TO service_role;
CREATE FUNCTION public.fn_ca_source_player_money_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM ca_source_player_cash_payments) THEN RAISE EXCEPTION 'Player funding money evidence is immutable' USING ERRCODE='55000';END IF;
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM ca_source_player_cash_payments p WHERE
  (TG_TABLE_NAME='chip_ledger' AND p.ledger_id=OLD.id) OR
  (TG_TABLE_NAME='wallet_transactions' AND OLD.id IN(p.debit_transaction_id,p.credit_transaction_id))) THEN
  IF TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
   RAISE EXCEPTION 'Player funding money evidence is immutable' USING ERRCODE='55000';END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $f$;
REVOKE ALL ON FUNCTION fn_ca_source_player_money_immutable() FROM PUBLIC,anon,authenticated,service_role;
DO $tr$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['chip_ledger','wallet_transactions'] LOOP
 EXECUTE format('CREATE TRIGGER aa_source_player_money_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION fn_ca_source_player_money_immutable()',t);
 EXECUTE format('CREATE TRIGGER aa_source_player_money_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_source_player_money_immutable()',t);
 END LOOP;END $tr$;

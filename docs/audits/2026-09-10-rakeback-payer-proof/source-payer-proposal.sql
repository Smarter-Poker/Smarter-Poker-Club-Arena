-- Prospective source payer prototype. Not a production migration.
-- Requires the independently captured cash commission source contract.
BEGIN;
CREATE TABLE public.ca_rakeback_source_accruals (
 hand_id uuid NOT NULL,player_id uuid NOT NULL,club_id uuid NOT NULL,payer_user_id uuid,
 period_start date NOT NULL,period_end date NOT NULL,source_payload_hash text NOT NULL,
 rake_credit numeric NOT NULL,rebate_rate numeric NOT NULL,exact_entitlement numeric NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(hand_id,player_id),
 FOREIGN KEY(hand_id,player_id) REFERENCES public.ca_cash_commission_facts(hand_id,player_id),
 CHECK(exact_entitlement>=0 AND exact_entitlement=rake_credit*rebate_rate),
 CHECK(rebate_rate>=0 AND rebate_rate<=1),
 CHECK(exact_entitlement::text NOT IN ('NaN','Infinity','-Infinity'))
);
CREATE TABLE public.ca_rakeback_source_payments (
 id uuid PRIMARY KEY,period_id uuid NOT NULL REFERENCES public.rakeback_periods(id),
 player_id uuid NOT NULL,club_id uuid NOT NULL,payer_user_id uuid NOT NULL,
 period_start date NOT NULL,period_end date NOT NULL,amount numeric NOT NULL,
 cumulative_entitlement numeric NOT NULL,cumulative_paid numeric NOT NULL,
 source_count integer NOT NULL,source_digest text NOT NULL,
 wallet_transaction_id uuid NOT NULL REFERENCES public.wallet_transactions(id),
 ledger_id uuid NOT NULL REFERENCES public.chip_ledger(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(club_id,player_id,payer_user_id,period_start,source_digest),
 CHECK(amount>0 AND amount=round(amount,2)),
 CHECK(cumulative_paid=round(cumulative_entitlement,2)),
 CHECK(amount::text NOT IN ('NaN','Infinity','-Infinity'))
);
ALTER TABLE public.ca_rakeback_source_accruals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_rakeback_source_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_rakeback_source_accruals,public.ca_rakeback_source_payments
 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_rakeback_source_accruals,public.ca_rakeback_source_payments TO service_role;
CREATE FUNCTION public.fn_ca_rakeback_source_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN RAISE EXCEPTION 'Captured rakeback evidence is immutable' USING ERRCODE='55000'; END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_rakeback_source_evidence_immutable()
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER rakeback_source_accrual_immutable BEFORE UPDATE OR DELETE
 ON public.ca_rakeback_source_accruals FOR EACH ROW EXECUTE FUNCTION public.fn_ca_rakeback_source_evidence_immutable();
CREATE TRIGGER rakeback_source_payment_immutable BEFORE UPDATE OR DELETE
 ON public.ca_rakeback_source_payments FOR EACH ROW EXECUTE FUNCTION public.fn_ca_rakeback_source_evidence_immutable();
CREATE TRIGGER rakeback_source_accrual_no_truncate BEFORE TRUNCATE
 ON public.ca_rakeback_source_accruals FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_rakeback_source_evidence_immutable();
CREATE TRIGGER rakeback_source_payment_no_truncate BEFORE TRUNCATE
 ON public.ca_rakeback_source_payments FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_rakeback_source_evidence_immutable();

CREATE FUNCTION public.fn_lock_rakeback_payer_clubs(p_club_ids uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_club uuid;
BEGIN
 FOR v_club IN SELECT DISTINCT c FROM unnest(p_club_ids) c WHERE c IS NOT NULL ORDER BY c
 LOOP
  PERFORM pg_advisory_xact_lock(hashtext('club-arena:rakeback-payer'),hashtext(v_club::text));
 END LOOP;
END $f$;
REVOKE ALL ON FUNCTION public.fn_lock_rakeback_payer_clubs(uuid[])
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_pay_captured_rakeback_period(p_period_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE
 v_period record;v_club uuid;v_authority record;f record;g record;v_week date;
 v_amount numeric;v_paid numeric;v_payer_before numeric;v_player_before numeric;
 v_payer_after numeric;v_player_after numeric;v_auto text;v_id uuid;v_tx uuid;v_leg uuid;
 v_receipts jsonb:='[]';v_total numeric:=0;v_accrued integer:=0;v_deferred jsonb:='[]';
BEGIN
 SELECT club_id INTO v_club FROM public.rakeback_periods WHERE id=p_period_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','period_not_found'); END IF;
 -- Every multi-period wrapper must acquire ALL involved clubs, sorted, before
 -- taking any period or wallet lock. This primitive covers a single-club caller.
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY[v_club]);
 SELECT * INTO v_period FROM public.rakeback_periods WHERE id=p_period_id FOR UPDATE;
 IF NOT FOUND OR v_period.club_id IS DISTINCT FROM v_club THEN
  RAISE EXCEPTION 'Rakeback period changed during scope lock' USING ERRCODE='40001';
 END IF;
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR (
  auth.uid()<>v_period.user_id AND NOT public.fn_is_platform_admin()
  AND NOT EXISTS(SELECT 1 FROM clubs WHERE id=v_club AND owner_id=auth.uid())
  AND NOT EXISTS(SELECT 1 FROM union_clubs uc WHERE uc.club_id=v_club
   AND public.fn_is_union_overseer(uc.union_id,auth.uid())))) THEN
  RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501';
 END IF;
 IF v_period.user_id IS NULL OR v_period.status NOT IN ('pending','paid') THEN
  RETURN jsonb_build_object('success',false,'deferred','invalid_period_state');
 END IF;
 IF v_period.period_end>=(now() AT TIME ZONE 'UTC')::date THEN
  RETURN jsonb_build_object('success',false,'deferred','period_not_closed');
 END IF;
 SELECT * INTO v_authority FROM public.ca_cash_commission_authority WHERE singleton;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('success',false,'deferred','source_contract_not_active');
 END IF;
 IF public.fn_platform_frozen() THEN
  RETURN jsonb_build_object('success',false,'deferred','platform_frozen');
 END IF;

 -- Sources captured before the prospective authority boundary are ineligible.
 -- Legacy period estimates and current membership rates are never a payer input.
 FOR f IN SELECT facts.*,s.accepted_payload_hash,s.settled_at
  FROM public.ca_cash_commission_facts facts
  JOIN public.ca_cash_commission_sources s USING(hand_id)
  WHERE facts.booked_club_id=v_club AND facts.player_id=v_period.user_id
   AND s.accepted_at>=v_authority.activated_at
   AND s.settled_at>=(v_period.period_start::timestamp AT TIME ZONE 'UTC')
   AND s.settled_at<((v_period.period_end+1)::timestamp AT TIME ZONE 'UTC')
  ORDER BY facts.hand_id,facts.player_id
 LOOP
  v_week:=date_trunc('week',f.settled_at AT TIME ZONE 'UTC')::date;
  IF v_period.period_start<>v_week OR v_period.period_end<>v_week+6 THEN
   RAISE EXCEPTION 'Rakeback period does not match the canonical earning week' USING ERRCODE='23514';
  END IF;
  IF f.errors<>'[]'::jsonb OR coalesce(f.player_terms->'errors','[]'::jsonb)<>'[]'::jsonb
   OR f.player_rebate_entitlement IS NULL OR f.player_rebate_rate IS NULL
   OR f.player_rebate_entitlement<>f.rake_credit*f.player_rebate_rate
   OR f.player_rebate_entitlement<0
   OR (f.assignment_state='assigned' AND
    (f.payer_user_id IS NULL OR f.payer_user_id=f.player_id OR f.direct_commission_rate IS NULL
     OR f.player_rebate_rate>f.direct_commission_rate-.10))
   OR (f.assignment_state='self_agent' AND (f.player_rebate_entitlement<>0 OR f.player_rebate_rate<>0))
   OR f.assignment_state NOT IN ('assigned','self_agent') THEN
   v_deferred:=v_deferred||jsonb_build_object('hand_id',f.hand_id,'reason','captured_terms_unresolved');
   CONTINUE;
  END IF;
  INSERT INTO public.ca_rakeback_source_accruals(hand_id,player_id,club_id,payer_user_id,
   period_start,period_end,source_payload_hash,rake_credit,rebate_rate,exact_entitlement)
  VALUES(f.hand_id,f.player_id,v_club,f.payer_user_id,v_week,v_week+6,
   f.accepted_payload_hash,f.rake_credit,f.player_rebate_rate,f.player_rebate_entitlement)
  ON CONFLICT(hand_id,player_id) DO NOTHING;
  IF FOUND THEN v_accrued:=v_accrued+1; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.ca_rakeback_source_accruals a
   WHERE a.hand_id=f.hand_id AND a.player_id=f.player_id AND a.club_id=v_club
    AND a.payer_user_id IS NOT DISTINCT FROM f.payer_user_id AND a.period_start=v_week
    AND a.source_payload_hash=f.accepted_payload_hash AND a.rake_credit=f.rake_credit
    AND a.rebate_rate=f.player_rebate_rate AND a.exact_entitlement=f.player_rebate_entitlement)
  THEN RAISE EXCEPTION 'Captured rakeback source conflicts with its immutable accrual' USING ERRCODE='23514'; END IF;
 END LOOP;

 FOR g IN SELECT a.payer_user_id,sum(a.exact_entitlement) exact_total,count(*)::integer source_count,
    md5(string_agg(a.hand_id::text||':'||a.source_payload_hash,',' ORDER BY a.hand_id)) source_digest
  FROM public.ca_rakeback_source_accruals a
  WHERE a.club_id=v_club AND a.player_id=v_period.user_id
   AND a.period_start=v_period.period_start AND a.period_end=v_period.period_end
   AND a.payer_user_id IS NOT NULL GROUP BY a.payer_user_id ORDER BY a.payer_user_id
 LOOP
  SELECT coalesce(sum(amount),0) INTO v_paid FROM public.ca_rakeback_source_payments p
   WHERE p.club_id=v_club AND p.player_id=v_period.user_id AND p.payer_user_id=g.payer_user_id
    AND p.period_start=v_period.period_start AND p.period_end=v_period.period_end;
  v_amount:=round(g.exact_total,2)-v_paid;
  IF v_amount<0 THEN RAISE EXCEPTION 'Rakeback receipts exceed exact captured entitlement' USING ERRCODE='23514'; END IF;
  CONTINUE WHEN v_amount=0;
  PERFORM 1 FROM public.club_members WHERE club_id=v_club
   AND user_id=ANY(ARRAY[g.payer_user_id,v_period.user_id]) ORDER BY user_id FOR UPDATE;
  SELECT chip_balance INTO v_payer_before FROM public.club_members
   WHERE club_id=v_club AND user_id=g.payer_user_id;
  SELECT chip_balance INTO v_player_before FROM public.club_members
   WHERE club_id=v_club AND user_id=v_period.user_id;
  IF v_payer_before IS NULL OR v_player_before IS NULL OR v_payer_before<v_amount THEN
   v_deferred:=v_deferred||jsonb_build_object('payer_id',g.payer_user_id,'reason','source_wallet_unavailable_or_short');
   CONTINUE;
  END IF;
  v_id:=gen_random_uuid();v_leg:=gen_random_uuid();
  v_auto:=current_setting('app.ledger_autoskip_club_members',true);
  PERFORM set_config('app.ledger_autoskip_club_members','1',true);
  UPDATE public.club_members SET chip_balance=chip_balance-v_amount,updated_at=now()
   WHERE club_id=v_club AND user_id=g.payer_user_id RETURNING chip_balance INTO v_payer_after;
  UPDATE public.club_members SET chip_balance=chip_balance+v_amount,updated_at=now()
   WHERE club_id=v_club AND user_id=v_period.user_id RETURNING chip_balance INTO v_player_after;
  PERFORM set_config('app.ledger_autoskip_club_members',coalesce(v_auto,''),true);
  IF v_payer_before-v_payer_after<>v_amount OR v_player_after-v_player_before<>v_amount THEN
   RAISE EXCEPTION 'Captured rakeback movement failed balance conservation' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.wallet_transactions(user_id,wallet_type,amount,type,category,description,related_entity_id,balance_after)
  VALUES(v_period.user_id,'PLAYER',v_amount,'credit','rakeback','Captured source rakeback',v_id,v_player_after) RETURNING id INTO v_tx;
  INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
   amount,category,club_id,idempotency_key,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,metadata)
  VALUES(v_leg,coalesce(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
   'player_wallet',g.payer_user_id,'player_wallet',v_period.user_id,v_amount,'rakeback',v_club,
   'rakeback-source:'||v_id,v_payer_before,v_payer_after,v_player_before,v_player_after,
   jsonb_build_object('payment_id',v_id,'period_id',p_period_id,'wallet_transaction_id',v_tx,
    'source_count',g.source_count,'source_digest',g.source_digest,'exact_entitlement',g.exact_total));
  INSERT INTO public.ca_rakeback_source_payments(id,period_id,player_id,club_id,payer_user_id,
   period_start,period_end,amount,cumulative_entitlement,cumulative_paid,source_count,source_digest,wallet_transaction_id,ledger_id)
  VALUES(v_id,p_period_id,v_period.user_id,v_club,g.payer_user_id,v_period.period_start,v_period.period_end,
   v_amount,g.exact_total,v_paid+v_amount,g.source_count,g.source_digest,v_tx,v_leg);
  v_total:=v_total+v_amount;
 END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at,p.id),'[]') INTO v_receipts
  FROM public.ca_rakeback_source_payments p WHERE p.club_id=v_club
   AND p.player_id=v_period.user_id AND p.period_start=v_period.period_start AND p.period_end=v_period.period_end;
 -- No calendar/source-finality assertion and no mutation of legacy paid periods.
 RETURN jsonb_build_object('success',true,'period_id',p_period_id,'new_payout',v_total,
  'source_accruals_added',v_accrued,'paid_receipts',v_receipts,'deferred',v_deferred,'source_final',false);
END $f$;
REVOKE ALL ON FUNCTION public.fn_pay_captured_rakeback_period(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pay_captured_rakeback_period(uuid) TO service_role;

-- Referenced wallet/journal evidence is part of the immutable payment receipt.
CREATE FUNCTION public.fn_ca_rakeback_paid_money_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.ca_rakeback_source_payments) THEN
   RAISE EXCEPTION 'Captured rakeback money evidence cannot be truncated' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM public.ca_rakeback_source_payments p WHERE
   (TG_TABLE_NAME='wallet_transactions' AND p.wallet_transaction_id=OLD.id)
   OR (TG_TABLE_NAME='chip_ledger' AND p.ledger_id=OLD.id)) THEN
  IF TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
   RAISE EXCEPTION 'Captured rakeback money evidence is immutable' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_rakeback_paid_money_immutable()
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER aaa_rakeback_paid_money_immutable BEFORE UPDATE OR DELETE
 ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_ca_rakeback_paid_money_immutable();
CREATE TRIGGER aaa_rakeback_paid_money_immutable BEFORE UPDATE OR DELETE
 ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.fn_ca_rakeback_paid_money_immutable();
CREATE TRIGGER aaa_rakeback_paid_money_no_truncate BEFORE TRUNCATE
 ON public.wallet_transactions FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_rakeback_paid_money_immutable();
CREATE TRIGGER aaa_rakeback_paid_money_no_truncate BEFORE TRUNCATE
 ON public.chip_ledger FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_rakeback_paid_money_immutable();

COMMIT;

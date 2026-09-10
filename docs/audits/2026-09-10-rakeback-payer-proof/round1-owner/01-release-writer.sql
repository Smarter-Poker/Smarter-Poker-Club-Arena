-- PROPOSAL ONLY. Requires the reviewed source, bank and capacity owner stages.
-- This file does not activate source capture or replace the legacy Union close.
CREATE TABLE public.ca_source_club_release_requests(
 request_id uuid PRIMARY KEY,pool_id uuid NOT NULL REFERENCES public.ca_source_funding_pools(id),
 actor_id uuid,requested_bank_closed_through timestamptz NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE public.ca_source_club_release_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_source_club_release_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_source_club_release_requests TO service_role;
CREATE TRIGGER ca_source_club_release_request_immutable BEFORE UPDATE OR DELETE
 ON public.ca_source_club_release_requests FOR EACH ROW EXECUTE FUNCTION public.fn_ca_source_capacity_immutable();
CREATE TRIGGER ca_source_club_release_request_no_truncate BEFORE TRUNCATE
 ON public.ca_source_club_release_requests FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_source_capacity_immutable();

CREATE FUNCTION public.fn_ca_assert_source_club_release_money(p_release_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE r public.ca_source_club_cash_releases%ROWTYPE;p public.ca_source_funding_pools%ROWTYPE;
BEGIN
 SELECT * INTO STRICT r FROM public.ca_source_club_cash_releases WHERE id=p_release_id;
 SELECT * INTO STRICT p FROM public.ca_source_funding_pools WHERE id=r.pool_id;
 IF r.release_kind='union_to_club' THEN
  IF p.funding_route<>'union_rake_wallet' OR NOT EXISTS(
   SELECT 1 FROM public.chip_ledger l
   JOIN public.chip_transactions t ON t.id=r.treasury_transaction_id
   JOIN public.union_wallet_transactions u ON u.id=r.union_debit_transaction_id
   WHERE l.id=r.ledger_id AND l.status='posted' AND l.category='rakeback'
    AND l.from_type='union_wallet' AND l.from_entity_id=p.funding_union_id
    AND l.to_type='club_treasury' AND l.to_entity_id=p.club_id
    AND l.club_id=p.club_id AND l.union_id=p.funding_union_id AND l.amount=r.amount
    AND l.pre_from_balance-l.post_from_balance=r.amount
    AND l.post_to_balance-l.pre_to_balance=r.amount
    AND l.idempotency_key='source-club-release:'||r.id::text
    AND l.metadata->>'source_club_release_id'=r.id::text
    AND l.metadata->>'pool_id'=p.id::text AND l.metadata->>'source_digest'=r.source_digest
    AND l.metadata->>'treasury_transaction_id'=r.treasury_transaction_id::text
    AND l.metadata->>'union_debit_transaction_id'=r.union_debit_transaction_id::text
    AND t.club_id=p.club_id AND t.transaction_type='treasury_credit' AND t.amount=r.amount
    AND t.balance_after=l.post_to_balance
    AND t.metadata->>'source_club_release_id'=r.id::text AND t.metadata->>'pool_id'=p.id::text
    AND u.union_id=p.funding_union_id AND u.club_id=p.club_id AND u.amount=r.amount
    AND u.wallet='rake_wallet' AND u.direction='debit' AND u.tx_type='rakeback'
    AND u.balance_after=l.post_from_balance
    AND u.notes='Captured source club allocation '||r.id::text
  ) THEN RAISE EXCEPTION 'Source club release conflicts with actual Union money receipts' USING ERRCODE='23514'; END IF;
 ELSE
  PERFORM public.fn_ca_assert_cash_bank_receipt(r.bank_receipt_hand_id);
  IF p.funding_route<>'club_chip_treasury' OR NOT EXISTS(
   SELECT 1 FROM public.ca_cash_bank_receipts b
   WHERE b.hand_id=r.bank_receipt_hand_id AND b.funding_route=p.funding_route
    AND b.funding_union_id IS NULL AND b.requested_club_id=p.club_id
    AND b.chip_ledger_id=r.ledger_id AND b.credited_amount>=r.amount
    AND b.contract_version=p.contract_version
  ) THEN RAISE EXCEPTION 'Direct club capacity conflicts with its actual bank receipt' USING ERRCODE='23514'; END IF;
 END IF;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_assert_source_club_release_money(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_slice_source_club_release(p_release_id uuid,p_only_hand_id uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE r public.ca_source_club_cash_releases%ROWTYPE;l record;v_left numeric;v_take numeric;
BEGIN
 SELECT * INTO STRICT r FROM public.ca_source_club_cash_releases WHERE id=p_release_id;
 v_left:=r.amount;
 FOR l IN
  SELECT f.hand_id,f.contributor_id,f.exact_club_entitlement-coalesce((
    SELECT sum(s.amount) FROM public.ca_source_club_release_slices s
    WHERE s.hand_id=f.hand_id AND s.contributor_id=f.contributor_id),0) remaining
  FROM public.ca_source_funding_lots f
  JOIN public.ca_source_club_funding_admissions a USING(hand_id,contributor_id,pool_id)
  WHERE f.pool_id=r.pool_id AND a.admission_seq<=r.admission_seq_high_water AND (p_only_hand_id IS NULL OR f.hand_id=p_only_hand_id)
  ORDER BY f.bank_period_start,f.earning_week,f.hand_id,f.contributor_id
 LOOP
  IF l.remaining<0 THEN RAISE EXCEPTION 'Source club slices exceed exact entitlement' USING ERRCODE='23514'; END IF;
  EXIT WHEN v_left=0;
  v_take:=least(v_left,l.remaining);
  IF v_take>0 THEN
   INSERT INTO public.ca_source_club_release_slices(release_id,hand_id,contributor_id,amount)
   VALUES(r.id,l.hand_id,l.contributor_id,v_take);
   v_left:=v_left-v_take;
  END IF;
 END LOOP;
 IF v_left<>0 THEN RAISE EXCEPTION 'Source club release lacks admitted exact rights' USING ERRCODE='23514'; END IF;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_slice_source_club_release(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_release_captured_club_funding(p_pool_id uuid,p_bank_closed_through timestamptz,
 p_request_id uuid,p_expected_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE p public.ca_source_funding_pools%ROWTYPE;v_actor uuid:=auth.uid();v_old record;h record;
 v_seq bigint;v_exact numeric;v_paid numeric;v_due numeric;v_total numeric:=0;v_highwater timestamptz;
 v_release uuid;v_ledger uuid;v_tx uuid;v_debit uuid;v_credit jsonb;v_metadata jsonb;v_digest text;
 v_union_before numeric;v_union_after numeric;v_club_before numeric;v_club_after numeric;
 v_skip_union text;v_skip_clubs text;v_deferred jsonb:='[]';v_ids uuid[]:='{}';v_result jsonb;
BEGIN
 IF p_request_id IS NULL OR v_actor IS DISTINCT FROM p_expected_user_id THEN
  RAISE EXCEPTION 'release_actor_or_request_mismatch' USING ERRCODE='42501';
 END IF;
 IF p_bank_closed_through IS NULL OR NOT isfinite(p_bank_closed_through)
  OR p_bank_closed_through IS DISTINCT FROM public.fn_union_week_start(p_bank_closed_through)
  OR p_bank_closed_through>public.fn_union_week_start(clock_timestamp()) THEN
  RAISE EXCEPTION 'closed_pacific_bank_boundary_required' USING ERRCODE='22023';
 END IF;
 SELECT * INTO STRICT p FROM public.ca_source_funding_pools WHERE id=p_pool_id;
 IF NOT public.fn_caller_is_engine() AND (v_actor IS NULL OR (
  NOT public.fn_is_platform_admin()
  AND NOT (p.funding_union_id IS NOT NULL AND public.fn_is_union_overseer(p.funding_union_id,v_actor))
  AND NOT (p.funding_union_id IS NULL AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p.club_id AND c.owner_id=v_actor))
 )) THEN RAISE EXCEPTION 'not_authorised_for_original_funding_scope' USING ERRCODE='42501'; END IF;
 -- Outer callers preadmit all clubs; this single-club writer takes no other club lock.
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY[p.club_id]);
 PERFORM pg_advisory_xact_lock(hashtextextended('source-club-release-request:'||p_request_id::text,0));
 SELECT * INTO v_old FROM public.ca_source_club_release_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_old.pool_id<>p_pool_id OR v_old.actor_id IS DISTINCT FROM v_actor
   OR v_old.requested_bank_closed_through<>p_bank_closed_through THEN
   RAISE EXCEPTION 'release_request_scope_conflict' USING ERRCODE='23514';
  END IF;
  RETURN v_old.result;
 END IF;
 PERFORM 1 FROM public.ca_source_funding_pools WHERE id=p_pool_id FOR UPDATE;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'platform_frozen' USING ERRCODE='55000'; END IF;
 -- Bank receipt ownership, original rate and hierarchy checks belong to the common admission helper.
 FOR h IN SELECT DISTINCT b.hand_id FROM public.ca_cash_bank_receipts b
  JOIN public.ca_cash_commission_facts f ON f.hand_id=b.hand_id
  WHERE f.booked_club_id=p.club_id AND b.funding_union_id IS NOT DISTINCT FROM p.funding_union_id
   AND b.funding_route=p.funding_route AND b.contract_version=p.contract_version
   AND b.bank_credit_at<p_bank_closed_through ORDER BY b.hand_id
 LOOP
  PERFORM public.fn_ca_admit_source_funding(h.hand_id,p.club_id);
 END LOOP;
 INSERT INTO public.ca_source_club_funding_admissions(hand_id,contributor_id,pool_id,bank_closed_through)
 SELECT hand_id,contributor_id,pool_id,p_bank_closed_through
 FROM public.ca_source_funding_lots WHERE pool_id=p_pool_id AND bank_period_end<=p_bank_closed_through
 ON CONFLICT(hand_id,contributor_id) DO NOTHING;
 -- All explicit admissions survive a later request for an older cutoff.
 SELECT coalesce(max(admission_seq),0) INTO v_seq FROM public.ca_source_club_funding_admissions WHERE pool_id=p_pool_id;
 SELECT coalesce(sum(l.exact_club_entitlement),0),coalesce(max(a.bank_closed_through),p_bank_closed_through),
  md5(coalesce(string_agg(l.hand_id::text||':'||l.contributor_id::text||':'||l.accepted_payload_hash||':'||l.exact_club_entitlement::text,
   ',' ORDER BY l.hand_id,l.contributor_id),''))
 INTO v_exact,v_highwater,v_digest
 FROM public.ca_source_funding_lots l
 JOIN public.ca_source_club_funding_admissions a USING(hand_id,contributor_id,pool_id)
 WHERE l.pool_id=p_pool_id AND a.admission_seq<=v_seq;
 SELECT coalesce(sum(amount),0) INTO v_paid FROM public.ca_source_club_cash_releases WHERE pool_id=p_pool_id;
 v_due:=floor(v_exact*100)/100-v_paid;
 IF v_due<0 THEN RAISE EXCEPTION 'Source club cash exceeds admitted exact rights' USING ERRCODE='23514'; END IF;
 IF p.funding_route='club_chip_treasury' THEN
  -- The upstream bank already credited this treasury. Register only each hand's admitted exact rights.
  FOR h IN SELECT b.hand_id,b.chip_ledger_id,b.credited_amount,sum(l.exact_club_entitlement) exact_amount
   FROM public.ca_cash_bank_receipts b JOIN public.ca_source_funding_lots l ON l.hand_id=b.hand_id
   JOIN public.ca_source_club_funding_admissions a ON a.hand_id=l.hand_id AND a.contributor_id=l.contributor_id AND a.pool_id=l.pool_id
   WHERE l.pool_id=p_pool_id AND a.admission_seq<=v_seq AND NOT EXISTS(SELECT 1 FROM public.ca_source_club_cash_releases r WHERE r.bank_receipt_hand_id=b.hand_id)
   GROUP BY b.hand_id,b.chip_ledger_id,b.credited_amount ORDER BY b.hand_id
  LOOP
   IF h.exact_amount<>floor(h.exact_amount*100)/100 OR h.exact_amount>h.credited_amount THEN
    RAISE EXCEPTION 'Direct bank allocation is not a verified whole-cent club right' USING ERRCODE='23514';
   END IF;
   CONTINUE WHEN h.exact_amount=0;
   v_release:=gen_random_uuid();v_paid:=v_paid+h.exact_amount;v_total:=v_total+h.exact_amount;
   INSERT INTO public.ca_source_club_cash_releases(id,pool_id,admission_seq_high_water,bank_closed_through,amount,cumulative_exact,
    cumulative_released,source_digest,release_kind,ledger_id,bank_receipt_hand_id)
   VALUES(v_release,p_pool_id,v_seq,v_highwater,h.exact_amount,v_exact,v_paid,v_digest,'bank_direct',h.chip_ledger_id,h.hand_id);
   PERFORM public.fn_ca_slice_source_club_release(v_release,h.hand_id);
   PERFORM public.fn_ca_assert_source_club_release(v_release);
   v_ids:=array_append(v_ids,v_release);
  END LOOP;
 ELSIF v_due>0 THEN
  SELECT rake_wallet INTO v_union_before FROM public.union_wallets WHERE union_id=p.funding_union_id FOR UPDATE;
  SELECT chip_treasury INTO v_club_before FROM public.clubs WHERE id=p.club_id FOR UPDATE;
  IF v_union_before IS NULL OR v_club_before IS NULL OR v_union_before<v_due THEN
   v_deferred:=jsonb_build_array(jsonb_build_object('reason','original_union_treasury_missing_or_short'));
  ELSE
   v_release:=gen_random_uuid();v_ledger:=gen_random_uuid();
   v_metadata:=jsonb_build_object('source_club_release_id',v_release,'pool_id',p_pool_id,'source_digest',v_digest,
    'requested_bank_closed_through',p_bank_closed_through,'bank_closed_through',v_highwater);
   v_skip_union:=current_setting('app.ledger_autoskip_union_wallets',true);
   v_skip_clubs:=current_setting('app.ledger_autoskip_clubs',true);
   PERFORM set_config('app.ledger_autoskip_union_wallets','1',true);
   PERFORM set_config('app.ledger_autoskip_clubs','1',true);
   v_credit:=public.fn_credit_treasury(p.club_id,v_due,'Captured source club allocation',v_metadata,'source-club-release:'||v_release::text);
   IF (v_credit->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Source club treasury credit failed' USING ERRCODE='23514';
   END IF;
   SELECT chip_treasury INTO STRICT v_club_after FROM public.clubs WHERE id=p.club_id;
   UPDATE public.union_wallets SET rake_wallet=rake_wallet-v_due,updated_at=clock_timestamp()
    WHERE union_id=p.funding_union_id RETURNING rake_wallet INTO v_union_after;
   IF NOT FOUND OR v_union_after IS NULL OR v_club_after-v_club_before<>v_due
    OR v_union_before-v_union_after<>v_due THEN
    RAISE EXCEPTION 'Source club movement failed actual balance conservation' USING ERRCODE='23514';
   END IF;
   PERFORM set_config('app.ledger_autoskip_union_wallets',coalesce(v_skip_union,''),true);
   PERFORM set_config('app.ledger_autoskip_clubs',coalesce(v_skip_clubs,''),true);
   SELECT id INTO STRICT v_tx FROM public.chip_transactions
    WHERE club_id=p.club_id AND metadata->>'source_club_release_id'=v_release::text;
   INSERT INTO public.union_wallet_transactions(union_id,club_id,amount,tx_type,wallet,direction,balance_after,notes)
   VALUES(p.funding_union_id,p.club_id,v_due,'rakeback','rake_wallet','debit',v_union_after,
    'Captured source club allocation '||v_release::text) RETURNING id INTO v_debit;
   v_metadata:=v_metadata||jsonb_build_object('treasury_transaction_id',v_tx,'union_debit_transaction_id',v_debit);
   INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
    amount,category,club_id,union_id,idempotency_key,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,metadata)
   VALUES(v_ledger,coalesce(v_actor,'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    'union_wallet',p.funding_union_id,'club_treasury',p.club_id,v_due,'rakeback',p.club_id,p.funding_union_id,
    'source-club-release:'||v_release::text,v_union_before,v_union_after,v_club_before,v_club_after,v_metadata);
   INSERT INTO public.ca_source_club_cash_releases(id,pool_id,admission_seq_high_water,bank_closed_through,amount,cumulative_exact,
    cumulative_released,source_digest,release_kind,ledger_id,treasury_transaction_id,union_debit_transaction_id)
   VALUES(v_release,p_pool_id,v_seq,v_highwater,v_due,v_exact,v_paid+v_due,v_digest,'union_to_club',v_ledger,v_tx,v_debit);
   PERFORM public.fn_ca_slice_source_club_release(v_release);
   PERFORM public.fn_ca_assert_source_club_release(v_release);
   v_ids:=array_append(v_ids,v_release);v_total:=v_due;
  END IF;
 END IF;
 v_result:=jsonb_build_object('success',true,'request_id',p_request_id,'pool_id',p_pool_id,
  'requested_bank_closed_through',p_bank_closed_through,'bank_closed_through',v_highwater,
  'new_release',v_total,'exact_club_entitlement',v_exact,'release_ids',v_ids,'deferred',v_deferred,'source_final',false);
 INSERT INTO public.ca_source_club_release_requests(request_id,pool_id,actor_id,requested_bank_closed_through,result)
 VALUES(p_request_id,p_pool_id,v_actor,p_bank_closed_through,v_result);
 RETURN v_result;
END $f$;
REVOKE ALL ON FUNCTION public.fn_release_captured_club_funding(uuid,timestamptz,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_release_captured_club_funding(uuid,timestamptz,uuid,uuid) TO service_role;

CREATE FUNCTION public.fn_ca_source_club_release_money_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.ca_source_club_cash_releases r WHERE
   TG_TABLE_NAME='chip_ledger' OR (TG_TABLE_NAME='chip_transactions' AND r.treasury_transaction_id IS NOT NULL)
    OR (TG_TABLE_NAME='union_wallet_transactions' AND r.union_debit_transaction_id IS NOT NULL)) THEN
   RAISE EXCEPTION 'Source club release money cannot be truncated' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM public.ca_source_club_cash_releases r WHERE
  (TG_TABLE_NAME='chip_ledger' AND r.ledger_id=OLD.id)
  OR (TG_TABLE_NAME='chip_transactions' AND r.treasury_transaction_id=OLD.id)
  OR (TG_TABLE_NAME='union_wallet_transactions' AND r.union_debit_transaction_id=OLD.id)) THEN
  IF TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
   RAISE EXCEPTION 'Source club release money is immutable' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_source_club_release_money_immutable() FROM PUBLIC,anon,authenticated,service_role;
DO $money$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['chip_ledger','chip_transactions','union_wallet_transactions'] LOOP
  EXECUTE format('CREATE TRIGGER ca_source_club_release_money_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_ca_source_club_release_money_immutable()',t);
  EXECUTE format('CREATE TRIGGER ca_source_club_release_money_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_source_club_release_money_immutable()',t);
 END LOOP;
END $money$;

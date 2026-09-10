-- Deferred assertions bind immutable exact rights to actual cash witnesses.
CREATE FUNCTION public.fn_ca_assert_source_lot(p_hand uuid,p_contributor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE l public.ca_source_funding_lots%ROWTYPE;f public.ca_cash_commission_facts%ROWTYPE;
 s public.ca_cash_commission_sources%ROWTYPE;b public.ca_cash_bank_receipts%ROWTYPE;
 p public.ca_source_funding_pools%ROWTYPE;v_top numeric;v_state text;v_exact numeric;
BEGIN
 SELECT * INTO STRICT l FROM ca_source_funding_lots WHERE hand_id=p_hand AND contributor_id=p_contributor;
 SELECT * INTO STRICT f FROM ca_cash_commission_facts WHERE hand_id=p_hand AND player_id=p_contributor;
 SELECT * INTO STRICT s FROM ca_cash_commission_sources WHERE hand_id=p_hand;
 SELECT * INTO STRICT b FROM ca_cash_bank_receipts WHERE hand_id=p_hand;
 SELECT * INTO STRICT p FROM ca_source_funding_pools WHERE id=l.pool_id;
 PERFORM fn_ca_assert_cash_bank_receipt(p_hand);
 IF p.contract_version<>1 OR p.club_id IS DISTINCT FROM f.booked_club_id
  OR p.funding_union_id IS DISTINCT FROM s.funding_union_id OR p.funding_route IS DISTINCT FROM s.funding_route
  OR f.funding_union_id IS DISTINCT FROM s.funding_union_id
  OR f.funding_state IS NULL OR f.funding_state NOT IN ('union_member','club_treasury_owner')
  OR l.accepted_payload_hash IS DISTINCT FROM s.accepted_payload_hash
  OR l.rake_credit IS DISTINCT FROM f.rake_credit OR l.captured_club_rate IS DISTINCT FROM f.funding_club_rate
  OR l.earning_week IS DISTINCT FROM date_trunc('week',s.settled_at AT TIME ZONE 'UTC')::date
  OR l.bank_period_start IS DISTINCT FROM fn_union_week_start(b.bank_credit_at)
  OR l.bank_period_end IS DISTINCT FROM ((l.bank_period_start AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles'
 THEN RAISE EXCEPTION 'Funding lot contradicts its captured source and bank' USING ERRCODE='23514'; END IF;
 v_state:='terms_unresolved';v_exact:=NULL;
 IF jsonb_typeof(f.hierarchy)='array' AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(f.hierarchy) j WHERE j->>'contract_rate' IS NULL
   OR j->>'contract_rate' IN ('NaN','Infinity','-Infinity')
   OR (j->>'contract_rate')::numeric<0 OR (j->>'contract_rate')::numeric>.70) THEN
  SELECT coalesce(max((j->>'contract_rate')::numeric),0) INTO v_top FROM jsonb_array_elements(f.hierarchy) j;
  v_exact:=f.rake_credit*v_top;
  IF f.errors='[]'::jsonb THEN v_state:=CASE WHEN v_exact>l.exact_club_entitlement THEN 'overpromised' ELSE 'eligible' END;END IF;
 END IF;
 IF l.contract_state IS DISTINCT FROM v_state OR l.exact_hierarchy_entitlement IS DISTINCT FROM v_exact THEN
  RAISE EXCEPTION 'Funding lot contract eligibility contradicts immutable terms' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM ca_source_recipient_accruals a WHERE a.hand_id=p_hand AND a.contributor_id=p_contributor)
  AND (l.contract_state<>'eligible' OR
   (SELECT sum(a.exact_entitlement) FROM ca_source_recipient_accruals a WHERE a.hand_id=p_hand AND a.contributor_id=p_contributor)>l.exact_hierarchy_entitlement) THEN
  RAISE EXCEPTION 'Recipient source allocations exceed their own captured contract' USING ERRCODE='23514'; END IF;
END $f$;
CREATE FUNCTION public.fn_ca_assert_source_accrual(p_hand uuid,p_contributor uuid,p_agent uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE a public.ca_source_recipient_accruals%ROWTYPE;l public.ca_source_funding_lots%ROWTYPE;
 f public.ca_cash_commission_facts%ROWTYPE;r public.ca_commission_contributor_receipts%ROWTYPE;h jsonb;x jsonb;v_previous numeric;
BEGIN
 PERFORM fn_ca_assert_source_lot(p_hand,p_contributor);
 SELECT * INTO STRICT a FROM ca_source_recipient_accruals WHERE hand_id=p_hand AND contributor_id=p_contributor AND agent_id=p_agent;
 SELECT * INTO STRICT l FROM ca_source_funding_lots WHERE hand_id=p_hand AND contributor_id=p_contributor;
 SELECT * INTO STRICT f FROM ca_cash_commission_facts WHERE hand_id=p_hand AND player_id=p_contributor;
 SELECT value INTO STRICT h FROM jsonb_array_elements(f.hierarchy) WHERE (value->>'agent_id')::uuid=p_agent;
 SELECT coalesce(max((value->>'contract_rate')::numeric),0) INTO v_previous FROM jsonb_array_elements(f.hierarchy)
 WHERE (value->>'depth')::integer<(h->>'depth')::integer;
 SELECT r0.* INTO STRICT r FROM ca_commission_contributor_receipts r0 JOIN ca_cash_commission_sources s ON s.hand_id=r0.source_id
 WHERE r0.source_type='rake_settlement' AND r0.source_id=p_hand AND r0.contributing_user_id=p_contributor
  AND r0.state='applied' AND r0.booked_club_id=f.booked_club_id AND r0.requested_club_id=s.requested_club_id AND r0.rake_credit=f.rake_credit;
 SELECT value INTO STRICT x FROM jsonb_array_elements(r.allocations) WHERE (value->>'agent_id')::uuid=p_agent;
 IF l.contract_state<>'eligible' OR a.pool_id<>l.pool_id OR a.earning_week<>l.earning_week
  OR a.recipient_id IS DISTINCT FROM (h->>'user_id')::uuid OR a.contract_rate IS DISTINCT FROM (h->>'contract_rate')::numeric
  OR a.downline_rate<>v_previous OR a.exact_entitlement<>l.rake_credit*(a.contract_rate-v_previous)
  OR a.is_direct_payer IS DISTINCT FROM (a.agent_id=f.direct_agent_id)
  OR ((h->>'depth')::integer>1 AND a.contract_rate-v_previous<.10)
  OR x->>'amount_authority' IS DISTINCT FROM 'compatibility_projection_only'
  OR (x->>'user_id')::uuid IS DISTINCT FROM a.recipient_id
  OR (x->>'contract_rate')::numeric IS DISTINCT FROM a.contract_rate
  OR (x->>'downline_contract_rate')::numeric IS DISTINCT FROM a.downline_rate
  OR (x->>'exact_entitlement')::numeric IS DISTINCT FROM a.exact_entitlement
  OR (x->>'exact_cumulative_entitlement')::numeric IS DISTINCT FROM l.rake_credit*a.contract_rate
 THEN RAISE EXCEPTION 'Recipient accrual contradicts captured hierarchy' USING ERRCODE='23514'; END IF;
END $f$;
CREATE FUNCTION public.fn_ca_assert_source_club_release(p_release uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE r public.ca_source_club_cash_releases%ROWTYPE;v_exact numeric;v_paid numeric;v_digest text;v_cutoff timestamptz;
BEGIN
 SELECT * INTO STRICT r FROM ca_source_club_cash_releases WHERE id=p_release;
 SELECT coalesce(sum(l.exact_club_entitlement),0),
  md5(coalesce(string_agg(l.hand_id::text||':'||l.contributor_id::text||':'||l.accepted_payload_hash||':'||l.exact_club_entitlement::text,',' ORDER BY l.hand_id,l.contributor_id),'')),
  max(a.bank_closed_through)
 INTO v_exact,v_digest,v_cutoff FROM ca_source_club_funding_admissions a JOIN ca_source_funding_lots l USING(hand_id,contributor_id)
 WHERE a.pool_id=r.pool_id AND a.admission_seq<=r.admission_seq_high_water;
 SELECT coalesce(sum(amount),0) INTO v_paid FROM ca_source_club_cash_releases WHERE pool_id=r.pool_id AND release_seq<=r.release_seq;
 IF r.cumulative_exact<>v_exact OR r.source_digest<>v_digest OR r.bank_closed_through IS DISTINCT FROM v_cutoff
  OR r.cumulative_released<>v_paid OR r.amount IS DISTINCT FROM (SELECT sum(amount) FROM ca_source_club_release_slices WHERE release_id=p_release)
  OR EXISTS(SELECT 1 FROM ca_source_club_release_slices z JOIN ca_source_funding_lots l USING(hand_id,contributor_id)
   LEFT JOIN ca_source_club_funding_admissions a USING(hand_id,contributor_id)
   WHERE z.release_id=p_release AND (l.pool_id<>r.pool_id OR a.pool_id IS DISTINCT FROM r.pool_id OR a.admission_seq>r.admission_seq_high_water))
  OR EXISTS(SELECT 1 FROM ca_source_club_release_slices z JOIN ca_source_funding_lots l USING(hand_id,contributor_id)
   WHERE z.release_id=p_release AND (SELECT sum(z2.amount) FROM ca_source_club_release_slices z2 WHERE z2.hand_id=z.hand_id AND z2.contributor_id=z.contributor_id)>l.exact_club_entitlement)
  OR (r.release_kind='bank_direct' AND (
    EXISTS(SELECT 1 FROM ca_source_club_release_slices z WHERE z.release_id=p_release AND z.hand_id<>r.bank_receipt_hand_id)
    OR r.amount IS DISTINCT FROM (SELECT sum(l.exact_club_entitlement) FROM ca_source_funding_lots l
      JOIN ca_source_club_funding_admissions a USING(hand_id,contributor_id)
      WHERE l.pool_id=r.pool_id AND l.hand_id=r.bank_receipt_hand_id AND a.admission_seq<=r.admission_seq_high_water)))
  OR (SELECT coalesce(sum(amount),0) FROM ca_source_club_cash_consumptions WHERE release_id=p_release)>r.amount
 THEN RAISE EXCEPTION 'Club release source allocation or consumption mismatch' USING ERRCODE='23514'; END IF;
 PERFORM fn_ca_assert_source_club_release_money(p_release);
END $f$;
CREATE FUNCTION public.fn_ca_assert_source_agent_payment(p_payment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE p public.ca_source_agent_cash_payments%ROWTYPE;v_exact numeric;v_paid numeric;v_digest text;v_cutoff date;
 t public.wallet_transactions%ROWTYPE;l public.chip_ledger%ROWTYPE;d public.chip_transactions%ROWTYPE;
BEGIN
 SELECT * INTO STRICT p FROM ca_source_agent_cash_payments WHERE id=p_payment;
 SELECT coalesce(sum(x.exact_entitlement),0),
  md5(coalesce(string_agg(x.hand_id::text||':'||x.contributor_id::text||':'||x.agent_id::text||':'||x.exact_entitlement::text,',' ORDER BY x.hand_id,x.contributor_id,x.agent_id),'')),
  max(a.earning_closed_through)
 INTO v_exact,v_digest,v_cutoff FROM ca_source_recipient_funding_admissions a JOIN ca_source_recipient_accruals x USING(hand_id,contributor_id,agent_id)
 WHERE a.pool_id=p.pool_id AND a.recipient_id=p.recipient_id AND a.admission_seq<=p.admission_seq_high_water;
 SELECT coalesce(sum(amount),0) INTO v_paid FROM ca_source_agent_cash_payments
 WHERE pool_id=p.pool_id AND recipient_id=p.recipient_id AND payment_seq<=p.payment_seq;
 IF p.club_id IS DISTINCT FROM (SELECT club_id FROM ca_source_funding_pools WHERE id=p.pool_id)
  OR p.cumulative_exact<>v_exact OR p.source_digest<>v_digest OR p.earning_closed_through IS DISTINCT FROM v_cutoff OR p.cumulative_paid<>v_paid
  OR p.amount IS DISTINCT FROM (SELECT sum(amount) FROM ca_source_agent_payment_slices WHERE payment_id=p_payment)
  OR p.amount IS DISTINCT FROM (SELECT sum(amount) FROM ca_source_club_cash_consumptions WHERE payment_id=p_payment)
  OR EXISTS(SELECT 1 FROM ca_source_agent_payment_slices z JOIN ca_source_recipient_accruals x USING(hand_id,contributor_id,agent_id)
   LEFT JOIN ca_source_recipient_funding_admissions a USING(hand_id,contributor_id,agent_id)
   WHERE z.payment_id=p_payment AND (x.pool_id<>p.pool_id OR x.recipient_id<>p.recipient_id
    OR a.pool_id IS DISTINCT FROM p.pool_id OR a.admission_seq>p.admission_seq_high_water
    OR (SELECT sum(z2.amount) FROM ca_source_agent_payment_slices z2 WHERE z2.hand_id=z.hand_id AND z2.contributor_id=z.contributor_id AND z2.agent_id=z.agent_id)>x.exact_entitlement))
  OR EXISTS(SELECT 1 FROM ca_source_club_cash_consumptions c JOIN ca_source_club_cash_releases r ON r.id=c.release_id
   WHERE c.payment_id=p_payment AND (r.pool_id<>p.pool_id OR (SELECT sum(c2.amount) FROM ca_source_club_cash_consumptions c2 WHERE c2.release_id=r.id)>r.amount))
 THEN RAISE EXCEPTION 'Agent payment exceeds its admitted entitlement or released capacity' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT t FROM wallet_transactions WHERE id=p.wallet_transaction_id;
 SELECT * INTO STRICT l FROM chip_ledger WHERE id=p.ledger_id;
 SELECT * INTO STRICT d FROM chip_transactions WHERE id=p.treasury_transaction_id;
 IF t.user_id IS DISTINCT FROM p.recipient_id OR t.wallet_type IS DISTINCT FROM 'PLAYER' OR t.type IS DISTINCT FROM 'credit' OR t.category IS DISTINCT FROM 'commission'
  OR t.amount IS DISTINCT FROM p.amount OR t.related_entity_id IS DISTINCT FROM p.id
  OR d.club_id IS DISTINCT FROM p.club_id OR d.transaction_type IS DISTINCT FROM 'treasury_debit' OR d.amount IS DISTINCT FROM p.amount OR d.metadata->>'payment_id' IS DISTINCT FROM p.id::text
  OR l.club_id IS DISTINCT FROM p.club_id OR l.from_type IS DISTINCT FROM 'club_treasury' OR l.from_entity_id IS DISTINCT FROM p.club_id
  OR l.to_type IS DISTINCT FROM 'player_wallet' OR l.to_entity_id IS DISTINCT FROM p.recipient_id OR l.amount IS DISTINCT FROM p.amount OR l.category IS DISTINCT FROM 'commission' OR l.status IS DISTINCT FROM 'posted'
  OR l.union_id IS DISTINCT FROM (SELECT funding_union_id FROM ca_source_funding_pools WHERE id=p.pool_id)
  OR l.idempotency_key IS DISTINCT FROM 'captured-agent:'||p.id
  OR l.metadata->>'payment_id' IS DISTINCT FROM p.id::text
  OR l.metadata->>'pool_id' IS DISTINCT FROM p.pool_id::text
  OR l.metadata->>'source_digest' IS DISTINCT FROM p.source_digest
  OR l.metadata->>'wallet_transaction_id' IS DISTINCT FROM p.wallet_transaction_id::text
  OR l.metadata->>'treasury_transaction_id' IS DISTINCT FROM p.treasury_transaction_id::text
  OR l.pre_from_balance-l.post_from_balance IS DISTINCT FROM p.amount
  OR l.post_to_balance-l.pre_to_balance IS DISTINCT FROM p.amount
  OR t.balance_after IS DISTINCT FROM l.post_to_balance OR d.balance_after IS DISTINCT FROM l.post_from_balance
 THEN RAISE EXCEPTION 'Agent payment actual money witness mismatch' USING ERRCODE='23514'; END IF;
END $f$;
CREATE FUNCTION public.fn_ca_source_capacity_assert_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE r record;
BEGIN
 CASE TG_TABLE_NAME
 WHEN 'ca_source_funding_lots' THEN PERFORM fn_ca_assert_source_lot(NEW.hand_id,NEW.contributor_id);
 WHEN 'ca_source_recipient_accruals' THEN PERFORM fn_ca_assert_source_accrual(NEW.hand_id,NEW.contributor_id,NEW.agent_id);
 WHEN 'ca_source_club_funding_admissions' THEN
  IF NOT EXISTS(SELECT 1 FROM ca_source_funding_lots l WHERE l.hand_id=NEW.hand_id AND l.contributor_id=NEW.contributor_id
    AND l.pool_id=NEW.pool_id AND l.bank_period_end<=NEW.bank_closed_through)
   OR NEW.bank_closed_through<>fn_union_week_start(NEW.bank_closed_through)
   OR NEW.bank_closed_through>fn_union_week_start(NEW.admitted_at) THEN
   RAISE EXCEPTION 'Club funding admission has wrong source, pool, or closed calendar boundary' USING ERRCODE='23514'; END IF;
 WHEN 'ca_source_recipient_funding_admissions' THEN
  IF NOT EXISTS(SELECT 1 FROM ca_source_recipient_accruals a JOIN ca_source_club_funding_admissions c USING(hand_id,contributor_id)
   WHERE a.hand_id=NEW.hand_id AND a.contributor_id=NEW.contributor_id AND a.agent_id=NEW.agent_id
    AND a.pool_id=NEW.pool_id AND c.pool_id=NEW.pool_id AND a.recipient_id=NEW.recipient_id AND a.earning_week+7<=NEW.earning_closed_through)
   OR NEW.earning_closed_through>date_trunc('week',NEW.admitted_at AT TIME ZONE 'UTC')::date THEN
   RAISE EXCEPTION 'Recipient funding admission has wrong source, pool, recipient, or closed earning boundary' USING ERRCODE='23514'; END IF;
 WHEN 'ca_source_club_cash_releases' THEN PERFORM fn_ca_assert_source_club_release(NEW.id);
 WHEN 'ca_source_club_release_slices' THEN PERFORM fn_ca_assert_source_club_release(NEW.release_id);
 WHEN 'ca_source_agent_cash_payments' THEN PERFORM fn_ca_assert_source_agent_payment(NEW.id);
 WHEN 'ca_source_agent_payment_slices' THEN PERFORM fn_ca_assert_source_agent_payment(NEW.payment_id);
 WHEN 'ca_source_club_cash_consumptions' THEN
  PERFORM fn_ca_assert_source_agent_payment(NEW.payment_id);PERFORM fn_ca_assert_source_club_release(NEW.release_id);
 END CASE;
 RETURN NULL;
END $f$;
DO $triggers$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['ca_source_funding_lots','ca_source_recipient_accruals','ca_source_club_funding_admissions',
 'ca_source_recipient_funding_admissions','ca_source_club_cash_releases','ca_source_club_release_slices',
 'ca_source_agent_cash_payments','ca_source_agent_payment_slices','ca_source_club_cash_consumptions'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER ca_source_capacity_assert AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_ca_source_capacity_assert_trigger()',t);
 END LOOP;
END $triggers$;
REVOKE ALL ON FUNCTION public.fn_ca_assert_source_lot(uuid,uuid),public.fn_ca_assert_source_accrual(uuid,uuid,uuid),
 public.fn_ca_assert_source_club_release(uuid),public.fn_ca_assert_source_agent_payment(uuid),
 public.fn_ca_source_capacity_assert_trigger() FROM PUBLIC,anon,authenticated,service_role;

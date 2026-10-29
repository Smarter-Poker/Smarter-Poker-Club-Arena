-- New interpretation evidence is separate from every original v3 row shape.
-- No foreign keys to game, club or wallet tables. Trigger DDL is installed
-- only by the existing daily-maintenance migration route.
CREATE TABLE public.accounting_rakeback_wallet_contracts(
 calculation_id bigint NOT NULL,payer_kind text NOT NULL CHECK(payer_kind IN('club','agent')),
 payer_entity_id uuid NOT NULL,payer_user_id uuid,destination_kind text NOT NULL CHECK(destination_kind IN('player_wallet','agent_wallet')),
 amount numeric NOT NULL CHECK(amount>=0 AND amount=round(amount,2)AND amount::text NOT IN('NaN','Infinity','-Infinity')),unrounded numeric NOT NULL CHECK(unrounded>=0 AND unrounded::text NOT IN('NaN','Infinity','-Infinity')),
 rake numeric NOT NULL CHECK(rake>=0 AND rake=round(rake,2)AND rake::text NOT IN('NaN','Infinity','-Infinity')),source_count bigint NOT NULL CHECK(source_count>0),source_fingerprint text NOT NULL,
 PRIMARY KEY(calculation_id,payer_kind,payer_entity_id,destination_kind),CHECK((payer_kind='agent')=(payer_user_id IS NOT NULL))
);
CREATE TABLE public.accounting_rakeback_wallet_transfers(
 payout_id uuid NOT NULL,calculation_id bigint NOT NULL,period_id uuid NOT NULL,payer_kind text NOT NULL CHECK(payer_kind IN('club','agent')),
 payer_entity_id uuid NOT NULL,destination_kind text NOT NULL CHECK(destination_kind IN('player_wallet','agent_wallet')),
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2)AND amount::text NOT IN('NaN','Infinity','-Infinity')),ledger_id uuid NOT NULL UNIQUE,wallet_transaction_id uuid NOT NULL UNIQUE,
 PRIMARY KEY(payout_id,payer_kind,payer_entity_id,destination_kind)
);
ALTER TABLE public.accounting_rakeback_wallet_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_rakeback_wallet_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_rakeback_wallet_contracts,public.accounting_rakeback_wallet_transfers FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER own_agent_wallet_contract_immutable BEFORE UPDATE OR DELETE ON public.accounting_rakeback_wallet_contracts FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER own_agent_wallet_contract_no_truncate BEFORE TRUNCATE ON public.accounting_rakeback_wallet_contracts FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER own_agent_wallet_transfer_immutable BEFORE UPDATE OR DELETE ON public.accounting_rakeback_wallet_transfers FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER own_agent_wallet_transfer_no_truncate BEFORE TRUNCATE ON public.accounting_rakeback_wallet_transfers FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

CREATE FUNCTION smarter_private.rakeback_wallet_plan(p_allocations jsonb,p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $plan$
DECLARE original jsonb;result jsonb;
BEGIN
 original:=smarter_private.rakeback_payer_plan(p_allocations,p_amount);
 IF EXISTS(SELECT FROM jsonb_array_elements(p_allocations)a WHERE a?'destination_kind'AND(a->>'destination_kind'IS DISTINCT FROM'agent_wallet'OR a->>'interpretation_version'IS DISTINCT FROM'own-agent-v1'OR jsonb_typeof(a->'destination_agreement')IS DISTINCT FROM'object'))THEN RAISE EXCEPTION 'rakeback_wallet_destination_invalid' USING ERRCODE='23514';END IF;
 WITH groups AS(
  SELECT a->>'payer_kind'kind,NULLIF(a->>'payer_user_id','')::uuid payer,coalesce(a->>'destination_kind','player_wallet')destination,
   sum((a->>'rake_credit')::numeric)rake,sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)unrounded,count(*)n
  FROM jsonb_array_elements(p_allocations)a GROUP BY 1,2,3
 ),cents AS(
  SELECT g.*,floor(g.unrounded*100)whole,row_number()OVER(PARTITION BY g.kind,g.payer ORDER BY g.unrounded*100-floor(g.unrounded*100)DESC,g.destination)rank,
   (p->>'amount')::numeric*100-sum(floor(g.unrounded*100))OVER(PARTITION BY g.kind,g.payer)extra
  FROM groups g JOIN jsonb_array_elements(original)p ON p->>'payer_kind'=g.kind AND NULLIF(p->>'payer_user_id','')::uuid IS NOT DISTINCT FROM g.payer
 )SELECT jsonb_agg(jsonb_build_object('payer_kind',kind,'payer_user_id',payer,'destination_kind',destination,'rake',rake,'unrounded',unrounded,'source_count',n,'amount',(whole+CASE WHEN rank<=extra THEN 1 ELSE 0 END)/100)ORDER BY kind,payer NULLS FIRST,destination)INTO result FROM cents;
 IF(SELECT sum((p->>'amount')::numeric)FROM jsonb_array_elements(result)p)IS DISTINCT FROM p_amount THEN RAISE EXCEPTION 'rakeback_wallet_plan_not_conserved' USING ERRCODE='23514';END IF;
 RETURN result;
END $plan$;
REVOKE ALL ON FUNCTION smarter_private.rakeback_wallet_plan(jsonb,numeric)FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.record_rakeback_wallet_contracts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $record$
DECLARE allocation jsonb;actual jsonb;authority jsonb;plan jsonb;n int;
BEGIN
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(NEW.source_allocations)a WHERE a?'destination_kind')THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT FROM public.rakeback_periods r WHERE r.id=NEW.period_id AND r.status='pending')THEN RAISE EXCEPTION 'typed_wallet_certificate_requires_unpaid_period' USING ERRCODE='23514';END IF;
 FOR allocation IN SELECT a FROM jsonb_array_elements(NEW.source_allocations)a WHERE a?'destination_kind'LOOP
  SELECT count(*),(jsonb_agg(to_jsonb(s)))->0 INTO n,actual FROM public.accounting_payable_earning_sources s WHERE s.source_type=allocation->>'source_type'AND s.source_id=(allocation->>'source_id')::uuid;
  IF n<>1 OR actual->>'club_id'IS DISTINCT FROM NEW.club_id::text OR actual->>'player_id'IS DISTINCT FROM NEW.player_id::text THEN RAISE EXCEPTION 'typed_wallet_source_identity_changed' USING ERRCODE='23514';END IF;
  authority:=smarter_private.own_agent_destination_contract(actual->'contract',NEW.club_id,NEW.player_id,(allocation->>'agreement_at')::timestamptz);
  IF authority IS NULL OR authority IS DISTINCT FROM allocation->'destination_agreement'OR allocation->>'interpretation_version'IS DISTINCT FROM'own-agent-v1'OR allocation->>'destination_kind'IS DISTINCT FROM'agent_wallet'OR(allocation->>'rate')::numeric IS DISTINCT FROM .70 OR actual#>>'{contract,membership,terms,role}'NOT IN('super_agent','agent','sub_agent')THEN RAISE EXCEPTION 'typed_wallet_historical_destination_not_observed' USING ERRCODE='23514';END IF;
 END LOOP;
 plan:=smarter_private.rakeback_wallet_plan(NEW.source_allocations,NEW.rakeback_amount);
 INSERT INTO public.accounting_rakeback_wallet_contracts(calculation_id,payer_kind,payer_entity_id,payer_user_id,destination_kind,amount,unrounded,rake,source_count,source_fingerprint)
 SELECT NEW.id,p->>'payer_kind',coalesce(NULLIF(p->>'payer_user_id','')::uuid,NEW.club_id),NULLIF(p->>'payer_user_id','')::uuid,p->>'destination_kind',(p->>'amount')::numeric,(p->>'unrounded')::numeric,(p->>'rake')::numeric,(p->>'source_count')::bigint,NEW.source_fingerprint FROM jsonb_array_elements(plan)p;
 RETURN NULL;
END $record$;
REVOKE ALL ON FUNCTION smarter_private.record_rakeback_wallet_contracts()FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER zz_accounting_rakeback_wallet_contracts AFTER INSERT ON public.accounting_rakeback_period_calculations FOR EACH ROW EXECUTE FUNCTION smarter_private.record_rakeback_wallet_contracts();

CREATE FUNCTION smarter_private.rakeback_certificate_wallets(p_calculation bigint)
RETURNS TABLE(payer_kind text,payer_user uuid,payer_entity uuid,owed numeric,destination_kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $payers$
DECLARE c public.accounting_rakeback_period_calculations%ROWTYPE;plan jsonb;
BEGIN
 SELECT*INTO STRICT c FROM public.accounting_rakeback_period_calculations WHERE id=p_calculation;
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(c.source_allocations)a WHERE a?'destination_kind')THEN
  RETURN QUERY SELECT g.payer_kind,g.payer_user,g.payer_entity,g.owed,'player_wallet'::text FROM smarter_private.rakeback_certificate_payers(p_calculation)g;RETURN;
 END IF;
 -- Preserve and verify the original per-payer contract and cent allocation.
 PERFORM*FROM smarter_private.rakeback_certificate_payers(p_calculation);
 plan:=smarter_private.rakeback_wallet_plan(c.source_allocations,c.rakeback_amount);
 IF(SELECT count(*)FROM public.accounting_rakeback_wallet_contracts w WHERE w.calculation_id=c.id)<>jsonb_array_length(plan)
 OR EXISTS(SELECT FROM jsonb_array_elements(plan)p LEFT JOIN public.accounting_rakeback_wallet_contracts w ON w.calculation_id=c.id AND w.payer_kind=p->>'payer_kind'AND w.payer_entity_id=coalesce(NULLIF(p->>'payer_user_id','')::uuid,c.club_id)AND w.destination_kind=p->>'destination_kind'WHERE w.calculation_id IS NULL OR w.amount IS DISTINCT FROM(p->>'amount')::numeric OR w.unrounded IS DISTINCT FROM(p->>'unrounded')::numeric OR w.rake IS DISTINCT FROM(p->>'rake')::numeric OR w.source_count IS DISTINCT FROM(p->>'source_count')::bigint OR w.source_fingerprint IS DISTINCT FROM c.source_fingerprint OR w.payer_user_id=c.player_id)
 THEN RAISE EXCEPTION 'typed_wallet_contract_disagrees' USING ERRCODE='23514';END IF;
 RETURN QUERY SELECT w.payer_kind,w.payer_user_id,w.payer_entity_id,w.amount,w.destination_kind FROM public.accounting_rakeback_wallet_contracts w WHERE w.calculation_id=c.id ORDER BY w.payer_kind,w.payer_entity_id,w.destination_kind;
END $payers$;
REVOKE ALL ON FUNCTION smarter_private.rakeback_certificate_wallets(bigint)FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.rakeback_wallet_payout_complete(p_payout uuid,p_calculation bigint)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $complete$
DECLARE pp public.rakeback_period_payouts%ROWTYPE;c public.accounting_rakeback_period_calculations%ROWTYPE;
BEGIN
 SELECT*INTO pp FROM public.rakeback_period_payouts WHERE id=p_payout;
 SELECT*INTO c FROM public.accounting_rakeback_period_calculations WHERE id=p_calculation;
 IF pp.id IS NULL OR c.id IS NULL OR pp.status IS DISTINCT FROM'paid'OR pp.rakeback_period_id IS DISTINCT FROM c.period_id OR pp.club_id IS DISTINCT FROM c.club_id OR pp.user_id IS DISTINCT FROM c.player_id OR pp.payout_amount IS DISTINCT FROM c.rakeback_amount
 OR NOT EXISTS(SELECT FROM public.rakeback_periods r WHERE r.id=c.period_id AND r.status='paid')
 OR NOT EXISTS(SELECT FROM public.accounting_rakeback_wallet_contracts w WHERE w.calculation_id=c.id AND w.destination_kind='agent_wallet')THEN RETURN false;END IF;
 IF(SELECT count(*)FROM public.accounting_rakeback_wallet_transfers t WHERE t.payout_id=pp.id)<>(SELECT count(*)FROM smarter_private.rakeback_certificate_wallets(c.id)g WHERE g.owed>0)THEN RETURN false;END IF;
 RETURN NOT EXISTS(
 SELECT FROM smarter_private.rakeback_certificate_wallets(c.id)g
 LEFT JOIN public.accounting_rakeback_wallet_transfers t ON t.payout_id=pp.id AND t.payer_kind=g.payer_kind AND t.payer_entity_id=g.payer_entity AND t.destination_kind=g.destination_kind
 LEFT JOIN public.chip_ledger l ON l.id=t.ledger_id LEFT JOIN public.wallet_transactions w ON w.id=t.wallet_transaction_id
 CROSS JOIN LATERAL(SELECT CASE WHEN g.payer_kind='club'OR g.payer_user IS NULL OR(l.from_type='club_treasury'AND l.metadata->>'owner_share_payer'=g.payer_user::text)THEN'club_treasury'ELSE'agent_wallet'END kind)funded
 WHERE g.owed>0 AND(t.payout_id IS NULL OR t.calculation_id IS DISTINCT FROM c.id OR t.period_id IS DISTINCT FROM c.period_id OR t.amount IS DISTINCT FROM g.owed
 OR l.amount IS DISTINCT FROM g.owed OR l.club_id IS DISTINCT FROM c.club_id OR l.from_type IS DISTINCT FROM funded.kind OR l.from_entity_id IS DISTINCT FROM CASE WHEN funded.kind='club_treasury'THEN c.club_id ELSE g.payer_user END
 OR l.to_type IS DISTINCT FROM g.destination_kind OR l.to_entity_id IS DISTINCT FROM c.player_id OR l.category IS DISTINCT FROM'rakeback'OR l.status IS DISTINCT FROM'posted'
 OR l.idempotency_key IS DISTINCT FROM'round3-period:own-agent-v1:'||c.period_id||':payer:'||g.payer_kind||':'||g.payer_entity||':destination:'||g.destination_kind
 OR l.metadata?'certificate_kind'OR l.metadata->>'routing_version'IS DISTINCT FROM'3'
 OR l.metadata->>'accounting_scope_kind'IS DISTINCT FROM CASE WHEN c.coordinator_union_id IS NULL THEN'club'ELSE'union'END
 OR l.metadata->>'accounting_scope_id'IS DISTINCT FROM coalesce(c.coordinator_union_id,c.club_id)::text
 OR(l.metadata->>'period_start')::timestamptz IS DISTINCT FROM(c.period_start::timestamp AT TIME ZONE'America/Los_Angeles')
 OR(l.metadata->>'period_end')::timestamptz IS DISTINCT FROM((c.period_end+1)::timestamp AT TIME ZONE'America/Los_Angeles')
 OR l.metadata->>'wallet_transaction_id'IS DISTINCT FROM t.wallet_transaction_id::text
 OR l.metadata->>'paid_from'IS DISTINCT FROM funded.kind
 OR l.metadata->>'payee_role_at_transfer'IS DISTINCT FROM CASE WHEN g.destination_kind='agent_wallet'THEN'agent'ELSE'player'END
 OR l.metadata->>'wallet_destination_version'IS DISTINCT FROM'own-agent-v1'OR l.metadata->>'destination_kind'IS DISTINCT FROM g.destination_kind
 OR l.metadata->>'certificate_id'IS DISTINCT FROM c.id::text OR l.metadata->>'payout_id'IS DISTINCT FROM pp.id::text OR l.metadata->>'period_id'IS DISTINCT FROM c.period_id::text OR l.metadata->>'source_fingerprint'IS DISTINCT FROM c.source_fingerprint
 OR l.pre_from_balance-l.post_from_balance IS DISTINCT FROM g.owed OR l.post_to_balance-l.pre_to_balance IS DISTINCT FROM g.owed
 OR w.user_id IS DISTINCT FROM c.player_id OR w.type IS DISTINCT FROM'credit'OR w.amount IS DISTINCT FROM g.owed OR w.wallet_type IS DISTINCT FROM CASE WHEN g.destination_kind='agent_wallet'THEN'BUSINESS'ELSE'PLAYER'END
 OR w.category IS DISTINCT FROM'rakeback'OR w.related_entity_id IS DISTINCT FROM pp.id OR w.balance_after IS DISTINCT FROM l.post_to_balance
 OR(SELECT count(*)FROM public.settlement_invoices i WHERE i.source_ledger_id=l.id AND i.status='paid'AND i.chips_transferred AND i.message_sent AND i.net_amount=g.owed AND i.gross_amount=g.owed AND i.deductions=0)<>1));
EXCEPTION WHEN check_violation OR data_exception OR no_data_found THEN RETURN false;
END $complete$;
REVOKE ALL ON FUNCTION smarter_private.rakeback_wallet_payout_complete(uuid,bigint)FROM PUBLIC,anon,authenticated,service_role;

-- @live-proof: (SELECT count(*)=2 FROM smarter_private.existing_rakeback_transfer_instructions WHERE source_thread='01a17898-6e1d-76e1-8122-375ccaf2925e') AND md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='38e8a0bf0b309b973391107e3bd934d0'
-- Existing original-stage discharge, no new beneficiary credit.
-- Financial probes MUST SET CONSTRAINTS ALL IMMEDIATE before capturing or ROLLBACK.
BEGIN;
SET LOCAL lock_timeout='1500ms';
DO $preimage$ BEGIN
 IF md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'f1dc7ad2a540edc392cf2e5fcbc1378c'THEN RAISE EXCEPTION 'existing_transfer_owner_preimage_changed: fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)';END IF;
 IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '76807aa6c2534cc5a89b1af136039838'THEN RAISE EXCEPTION 'existing_transfer_owner_preimage_changed: fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)';END IF;
 IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'c9a28a0a12e117fd7a8539e5aca54e82'THEN RAISE EXCEPTION 'existing_transfer_owner_preimage_changed: fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure)) IS DISTINCT FROM '6b151d00df78c2857dcc05f9abd1ff8d'THEN RAISE EXCEPTION 'existing_transfer_owner_preimage_changed: fn_ca_settlement_correctness_check()';END IF;
 IF md5(pg_get_functiondef('public.ca_player_stats_financial_report(uuid,uuid,integer,text,text)'::regprocedure)) IS DISTINCT FROM '2576399c7ff0510ed6fab2a4d70e17fc'THEN RAISE EXCEPTION 'existing_transfer_owner_preimage_changed: ca_player_stats_financial_report(uuid,uuid,integer,text,text)';END IF;
END $preimage$;
-- Private leaf support for the existing R2/R3 transactions, never a separate RPC.
CREATE TABLE smarter_private.existing_rakeback_transfer_instructions(
 id uuid PRIMARY KEY,club_id uuid NOT NULL,beneficiary_id uuid NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,
 original_ledger_id uuid NOT NULL UNIQUE,evidence_ledger_ids uuid[] NOT NULL,roles text[] NOT NULL,
 owner_instruction text NOT NULL,source_thread text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(club_id,beneficiary_id,period_start,period_end));
CREATE TABLE smarter_private.existing_rakeback_transfer_allocations(
 id uuid PRIMARY KEY,instruction_id uuid NOT NULL,obligation_role text NOT NULL CHECK(obligation_role IN('player','commission')),
 obligation_id uuid NOT NULL,certificate_id bigint,source_fingerprint text NOT NULL,club_id uuid NOT NULL,beneficiary_id uuid NOT NULL,
 period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,original_ledger_id uuid NOT NULL,original_transaction_id uuid NOT NULL,
 original_operation_id uuid NOT NULL,original_payer_id uuid NOT NULL,actual_destination text NOT NULL CHECK(actual_destination='player_wallet'),
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2)),original_credit numeric NOT NULL CHECK(original_credit>=amount),
 canonical_funded_from text NOT NULL CHECK(canonical_funded_from='club_treasury'),reimbursement_ledger_id uuid NOT NULL UNIQUE,
 payout_id uuid,original_evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(obligation_role,obligation_id),UNIQUE(instruction_id,obligation_role));
REVOKE ALL ON smarter_private.existing_rakeback_transfer_instructions,smarter_private.existing_rakeback_transfer_allocations FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER existing_transfer_instruction_immutable BEFORE UPDATE OR DELETE ON smarter_private.existing_rakeback_transfer_instructions FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER existing_transfer_instruction_no_truncate BEFORE TRUNCATE ON smarter_private.existing_rakeback_transfer_instructions FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER existing_transfer_allocation_immutable BEFORE UPDATE OR DELETE ON smarter_private.existing_rakeback_transfer_allocations FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER existing_transfer_allocation_no_truncate BEFORE TRUNCATE ON smarter_private.existing_rakeback_transfer_allocations FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

CREATE FUNCTION smarter_private.existing_rakeback_transfer_plan(p_club uuid,p_user uuid,p_start timestamptz,p_end timestamptz,p_role text,p_period uuid DEFAULT NULL,p_certificate bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET TimeZone='UTC' AS $body$
DECLARE ins smarter_private.existing_rakeback_transfer_instructions%ROWTYPE;l public.chip_ledger%ROWTYPE;
 tx public.chip_transactions%ROWTYPE;op public.cashier_rpc_operation_intents%ROWTYPE;c public.accounting_rakeback_period_calculations%ROWTYPE;
 rp public.rakeback_periods%ROWTYPE;prior smarter_private.existing_rakeback_transfer_allocations%ROWTYPE;
 club_owner uuid;owed numeric;allocated numeric;source_hash text;scope_source_hash text;obligation uuid;extra public.chip_ledger%ROWTYPE;
BEGIN
 SELECT * INTO ins FROM smarter_private.existing_rakeback_transfer_instructions WHERE club_id=p_club AND beneficiary_id=p_user AND period_start=p_start AND period_end=p_end;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF public.fn_caller_is_engine() IS DISTINCT FROM true OR public.fn_platform_frozen() IS DISTINCT FROM false OR NOT(p_role=ANY(ins.roles))
 THEN RAISE EXCEPTION 'existing_transfer_admission_refused' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('existing-rakeback-transfer:'||ins.original_ledger_id::text,0));
 SELECT owner_id INTO club_owner FROM public.clubs WHERE id=p_club;
 SELECT * INTO l FROM public.chip_ledger WHERE id=ins.original_ledger_id FOR SHARE;
 IF NOT FOUND OR l.status IS DISTINCT FROM 'posted' OR l.category IS DISTINCT FROM 'agent_send' OR l.club_id IS DISTINCT FROM p_club
 OR l.from_type IS DISTINCT FROM 'agent_wallet' OR l.from_entity_id IS DISTINCT FROM club_owner OR l.to_type IS DISTINCT FROM 'player_wallet'
 OR l.to_entity_id IS DISTINCT FROM p_user OR l.amount IS NULL OR l.amount<=0 OR l.amount<>round(l.amount,2)
 OR l.amount::text IN('NaN','Infinity','-Infinity') OR l.idempotency_key IS DISTINCT FROM 'agent_send:'||l.correlation_id::text
 OR l.created_at<p_end OR l.correlation_id IS NULL THEN RAISE EXCEPTION 'existing_transfer_original_credit_required' USING ERRCODE='23514';END IF;
 SELECT * INTO op FROM public.cashier_rpc_operation_intents WHERE operation_id=l.correlation_id FOR SHARE;
 IF NOT FOUND OR op.actor_user_id IS DISTINCT FROM club_owner OR op.club_id IS DISTINCT FROM p_club OR op.action IS DISTINCT FROM 'agent_wallet_send'
 OR op.completed_at IS NULL OR op.receipt->>'success' IS DISTINCT FROM 'true' OR op.receipt->>'op_id' IS DISTINCT FROM op.operation_id::text
 OR op.operation_intent->>'actor' IS DISTINCT FROM club_owner::text OR op.operation_intent->>'club' IS DISTINCT FROM p_club::text
 OR op.operation_intent->>'target' IS DISTINCT FROM p_user::text OR op.operation_intent->>'action' IS DISTINCT FROM 'agent_wallet_send'
 OR op.operation_intent->>'requested_destination' IS DISTINCT FROM 'player_wallet' OR op.receipt->>'destination' IS DISTINCT FROM 'player_wallet'
 OR (op.operation_intent->>'amount')::numeric IS DISTINCT FROM l.amount OR(op.receipt->>'amount')::numeric IS DISTINCT FROM l.amount
 OR(op.receipt->>'credit_drawn')::numeric IS DISTINCT FROM 0 OR(op.receipt->>'agent_wallet_before')::numeric-(op.receipt->>'agent_wallet_after')::numeric IS DISTINCT FROM l.amount
 THEN RAISE EXCEPTION 'existing_transfer_completed_cashier_receipt_required' USING ERRCODE='23514';END IF;
 SELECT * INTO tx FROM public.chip_transactions WHERE id=(op.receipt->>'transaction_id')::uuid FOR SHARE;
 IF NOT FOUND OR tx.club_id IS DISTINCT FROM p_club OR tx.from_user_id IS DISTINCT FROM club_owner OR tx.to_user_id IS DISTINCT FROM p_user
 OR tx.amount IS DISTINCT FROM l.amount OR tx.transaction_type IS DISTINCT FROM 'agent_wallet_send' OR tx.is_reversed IS DISTINCT FROM false OR tx.clawed_back IS DISTINCT FROM false
 OR tx.metadata->>'op_id' IS DISTINCT FROM op.operation_id::text OR tx.metadata->>'destination' IS DISTINCT FROM 'player_wallet'
 OR(tx.metadata->>'claimed_back')::numeric IS DISTINCT FROM 0 OR tx.balance_after IS DISTINCT FROM(op.receipt->>'agent_wallet_after')::numeric
 OR(tx.metadata->>'recipient_balance_after')::numeric IS DISTINCT FROM(op.receipt->>'recipient_balance_after')::numeric
 OR(tx.metadata->>'agent_wallet_before')::numeric-(tx.metadata->>'agent_wallet_after')::numeric IS DISTINCT FROM l.amount
 OR tx.reversible_until IS NULL OR tx.reversible_until>=clock_timestamp()
 THEN RAISE EXCEPTION 'existing_transfer_unreversed_original_transaction_required' USING ERRCODE='23514';END IF;
 FOR extra IN SELECT * FROM public.chip_ledger WHERE id=ANY(ins.evidence_ledger_ids) LOOP
  IF extra.status IS DISTINCT FROM 'posted' OR extra.category IS DISTINCT FROM 'agent_send' OR extra.club_id IS DISTINCT FROM p_club
  OR extra.from_type IS DISTINCT FROM 'agent_wallet' OR extra.from_entity_id IS DISTINCT FROM club_owner OR extra.to_type IS DISTINCT FROM 'player_wallet' OR extra.to_entity_id IS DISTINCT FROM p_user
  THEN RAISE EXCEPTION 'existing_transfer_extra_evidence_disagrees' USING ERRCODE='23514';END IF;
 END LOOP;
 IF(SELECT count(*)FROM public.chip_ledger WHERE id=ANY(ins.evidence_ledger_ids))<>cardinality(ins.evidence_ledger_ids)
 THEN RAISE EXCEPTION 'existing_transfer_extra_evidence_missing' USING ERRCODE='23514';END IF;
 IF p_role='player' THEN
  SELECT * INTO rp FROM public.rakeback_periods WHERE id=p_period FOR UPDATE;
  SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE period_id=p_period ORDER BY id DESC LIMIT 1;
  IF rp.id IS NULL OR c.id IS DISTINCT FROM p_certificate OR c.accounting_version IS DISTINCT FROM 2 OR c.club_id IS DISTINCT FROM p_club OR c.player_id IS DISTINCT FROM p_user
  OR c.period_start IS DISTINCT FROM(p_start AT TIME ZONE 'America/Los_Angeles')::date OR c.period_end IS DISTINCT FROM((p_end AT TIME ZONE 'America/Los_Angeles')::date-1)
  OR c.rakeback_amount IS DISTINCT FROM rp.rakeback_amount OR c.rakeback_amount IS DISTINCT FROM rp.rakeback_earned OR c.rake_generated IS DISTINCT FROM rp.rake_generated
  OR c.rake_generated IS DISTINCT FROM rp.total_rake_paid OR c.display_rate IS DISTINCT FROM rp.rakeback_rate OR rp.club_id IS DISTINCT FROM p_club OR rp.user_id IS DISTINCT FROM p_user
  OR c.source_fingerprint IS DISTINCT FROM md5(jsonb_build_object('allocations',c.source_allocations,'rake',c.rake_generated,'amount',c.rakeback_amount,'rate',c.display_rate)::text)
  OR(SELECT count(*)FROM smarter_private.rakeback_certificate_payers(c.id)g)<>1 OR NOT EXISTS(SELECT FROM smarter_private.rakeback_certificate_payers(c.id)g WHERE g.payer_kind='agent'AND g.payer_user=club_owner AND g.payer_entity=club_owner AND g.owed=c.rakeback_amount)
  THEN RAISE EXCEPTION 'existing_transfer_latest_owner_payer_certificate_required' USING ERRCODE='23514';END IF;
  owed:=c.rakeback_amount;source_hash:=c.source_fingerprint;obligation:=rp.id;
 ELSIF p_role='commission' THEN
  IF to_regclass('pg_temp._routed_nodes') IS NULL OR to_regclass('pg_temp._routed_prior_discharge_context') IS NULL OR to_regclass('pg_temp._routed_edges') IS NULL
  OR(SELECT count(*)FROM pg_class WHERE oid=ANY(ARRAY[to_regclass('pg_temp._routed_nodes'),to_regclass('pg_temp._routed_edges'),to_regclass('pg_temp._routed_prior_discharge_context')])AND pg_get_userbyid(relowner)='postgres')<>3
  THEN RAISE EXCEPTION 'existing_transfer_original_commission_stage_required' USING ERRCODE='42501';END IF;
  -- Only the original whole-club request can establish that the latest
  -- certificates cover every human and horse. A page-only request remains
  -- pending in fn_rakeback_recompute_periods and cannot establish zero here.
  IF NOT EXISTS(SELECT FROM public.accounting_period_recompute_requests q WHERE q.club_id=p_club
    AND q.period_start=(p_start AT TIME ZONE 'America/Los_Angeles')::date AND q.period_end=((p_end AT TIME ZONE 'America/Los_Angeles')::date-1)
    AND q.status='complete'AND q.attempted_at IS NOT NULL AND q.last_requested_at<=q.attempted_at
    AND q.last_result->>'accounting_version'='2'AND q.last_result->>'status'='ready'AND q.last_result->>'club_id'=p_club::text
    AND q.last_result->>'period_start'=q.period_start::text AND q.last_result->>'period_end'=q.period_end::text
    AND NOT EXISTS(SELECT FROM(SELECT s.earned_at FROM public.accounting_cash_rake_sources s
      WHERE s.club_id=p_club AND s.recorded_at>q.attempted_at-interval '1 minute'OFFSET 0)s WHERE s.earned_at>=p_start AND s.earned_at<p_end)
    AND NOT EXISTS(SELECT FROM(SELECT h.source_id FROM public.accounting_cash_atomic_contract_admissions h
      WHERE h.admitted_at>q.attempted_at-interval '1 minute'OFFSET 0)h CROSS JOIN LATERAL(
      SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s WHERE s.id=h.source_id OFFSET 0)s
      WHERE s.club_id=p_club AND s.earned_at>=p_start AND s.earned_at<p_end)
    AND NOT EXISTS(SELECT FROM(SELECT h.source_id,h.funding_club_id FROM public.accounting_cash_funding_contract_admissions h
      WHERE h.admitted_at>q.attempted_at-interval '1 minute'OFFSET 0)h CROSS JOIN LATERAL(
      SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s WHERE s.id=h.source_id OFFSET 0)s
      WHERE(s.club_id=p_club OR h.funding_club_id=p_club)AND s.earned_at>=p_start AND s.earned_at<p_end)
    AND NOT EXISTS(SELECT FROM public.accounting_tournament_fee_sources f WHERE f.club_id=p_club AND f.charged_at<p_end AND f.recorded_at>q.attempted_at-interval '1 minute'))
  THEN RAISE EXCEPTION 'existing_transfer_current_whole_club_calculation_required' USING ERRCODE='23514';END IF;
  SELECT source_fingerprint INTO scope_source_hash FROM pg_temp._routed_prior_discharge_context WHERE stage_round=2 AND period_start=p_start AND period_end=p_end AND p_club=ANY(club_ids);
  SELECT own_amount INTO owed FROM pg_temp._routed_nodes WHERE club_id=p_club AND user_id=p_user;
  IF owed IS NULL OR scope_source_hash IS NULL
  OR EXISTS(SELECT FROM pg_temp._routed_edges WHERE club_id=p_club AND payee_user=p_user AND payer_user IS NOT NULL)
  THEN RAISE EXCEPTION 'existing_transfer_original_commission_payer_required' USING ERRCODE='23514';END IF;
  -- Descendant-agent pass-through is retained by the original edges. A
  -- positive direct PLAYER liability is different: discharging its gross
  -- funding as personal income would pay that funding twice. This narrowly
  -- scoped admission refuses that case instead of inventing a new advance.
  IF EXISTS(SELECT FROM(SELECT DISTINCT ON(z.period_id)z.*FROM public.accounting_rakeback_period_calculations z
    WHERE z.club_id=p_club AND z.period_start=(p_start AT TIME ZONE 'America/Los_Angeles')::date
    AND z.period_end=((p_end AT TIME ZONE 'America/Los_Angeles')::date-1)ORDER BY z.period_id,z.id DESC)latest
    CROSS JOIN LATERAL smarter_private.rakeback_certificate_payers(latest.id)g WHERE latest.player_id<>p_user AND g.payer_kind='agent'AND g.payer_user=p_user AND g.owed>0)
  THEN RAISE EXCEPTION 'existing_transfer_commission_player_pass_through_requires_net_discharge' USING ERRCODE='23514';END IF;
  source_hash:=md5(jsonb_build_array('commission_own',p_club,p_user,p_start,p_end,scope_source_hash,owed)::text);
  obligation:=md5('prior-commission:'||p_club::text||':'||p_user::text||':'||p_start::text||':'||p_end::text)::uuid;
 ELSE RAISE EXCEPTION 'existing_transfer_role_refused' USING ERRCODE='23514';END IF;
 IF owed IS NULL OR owed<=0 OR owed<>round(owed,2) OR owed::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'existing_transfer_positive_certified_obligation_required' USING ERRCODE='23514';END IF;
 SELECT * INTO prior FROM smarter_private.existing_rakeback_transfer_allocations WHERE obligation_role=p_role AND obligation_id=obligation;
 IF FOUND THEN
  IF prior.instruction_id IS DISTINCT FROM ins.id OR prior.amount IS DISTINCT FROM owed OR prior.source_fingerprint IS DISTINCT FROM source_hash OR prior.certificate_id IS DISTINCT FROM p_certificate
  THEN RAISE EXCEPTION 'existing_transfer_obligation_changed_after_discharge' USING ERRCODE='23514';END IF;
  RETURN to_jsonb(prior)||jsonb_build_object('duplicate',true);
 END IF;
 IF p_role='player'AND(rp.status IS DISTINCT FROM 'pending'OR EXISTS(SELECT FROM public.rakeback_period_payouts WHERE rakeback_period_id=rp.id))
 THEN RAISE EXCEPTION 'existing_transfer_unpaid_original_period_required' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(amount),0)INTO allocated FROM smarter_private.existing_rakeback_transfer_allocations WHERE original_ledger_id=l.id;
 IF allocated+owed>l.amount THEN RAISE EXCEPTION 'existing_transfer_credit_already_allocated' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('instruction_id',ins.id,'obligation_role',p_role,'obligation_id',obligation,'certificate_id',p_certificate,'source_fingerprint',source_hash,
 'club_id',p_club,'beneficiary_id',p_user,'period_start',p_start,'period_end',p_end,'original_ledger_id',l.id,'original_transaction_id',tx.id,'original_operation_id',op.operation_id,
 'original_payer_id',club_owner,'actual_destination','player_wallet','amount',owed,'original_credit',l.amount,'canonical_funded_from','club_treasury',
 'original_evidence',jsonb_build_object('instruction',to_jsonb(ins),'ledger',to_jsonb(l),'transaction',to_jsonb(tx),'cashier_operation',to_jsonb(op)),
 'id',gen_random_uuid(),'reimbursement_ledger_id',gen_random_uuid(),'payout_id',CASE WHEN p_role='player'THEN gen_random_uuid()END,'duplicate',false);
END $body$;
REVOKE ALL ON FUNCTION smarter_private.existing_rakeback_transfer_plan(uuid,uuid,timestamptz,timestamptz,text,uuid,bigint)FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.existing_rakeback_transfer_complete(p_role text,p_obligation uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET TimeZone='UTC' AS $body$
DECLARE a smarter_private.existing_rakeback_transfer_allocations%ROWTYPE;i smarter_private.existing_rakeback_transfer_instructions%ROWTYPE;
 l public.chip_ledger%ROWTYPE;r public.chip_ledger%ROWTYPE;tx public.chip_transactions%ROWTYPE;op public.cashier_rpc_operation_intents%ROWTYPE;
BEGIN
 SELECT * INTO a FROM smarter_private.existing_rakeback_transfer_allocations WHERE obligation_role=p_role AND obligation_id=p_obligation;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO i FROM smarter_private.existing_rakeback_transfer_instructions WHERE id=a.instruction_id;
 SELECT * INTO l FROM public.chip_ledger WHERE id=a.original_ledger_id;
 SELECT * INTO tx FROM public.chip_transactions WHERE id=a.original_transaction_id;
 SELECT * INTO op FROM public.cashier_rpc_operation_intents WHERE operation_id=a.original_operation_id;
 SELECT * INTO r FROM public.chip_ledger WHERE id=a.reimbursement_ledger_id;
 IF i.id IS NULL OR l.id IS NULL OR tx.id IS NULL OR op.operation_id IS NULL OR r.id IS NULL
 OR a.club_id IS DISTINCT FROM i.club_id OR a.beneficiary_id IS DISTINCT FROM i.beneficiary_id OR a.period_start IS DISTINCT FROM i.period_start OR a.period_end IS DISTINCT FROM i.period_end
 OR NOT(a.obligation_role=ANY(i.roles)) OR a.original_ledger_id IS DISTINCT FROM i.original_ledger_id
 OR a.original_evidence->'instruction'IS DISTINCT FROM to_jsonb(i)OR a.original_evidence->'ledger'IS DISTINCT FROM to_jsonb(l)
 OR a.original_evidence->'transaction'IS DISTINCT FROM to_jsonb(tx)OR a.original_evidence->'cashier_operation'IS DISTINCT FROM to_jsonb(op)
 OR l.status IS DISTINCT FROM 'posted'OR l.category IS DISTINCT FROM 'agent_send'OR l.amount IS DISTINCT FROM a.original_credit
 OR tx.is_reversed IS DISTINCT FROM false OR tx.clawed_back IS DISTINCT FROM false OR(tx.metadata->>'claimed_back')::numeric IS DISTINCT FROM 0
 OR(SELECT sum(amount)FROM smarter_private.existing_rakeback_transfer_allocations WHERE original_ledger_id=l.id)>l.amount
 OR r.status IS DISTINCT FROM 'posted'OR r.category IS DISTINCT FROM 'treasury_transfer'OR r.club_id IS DISTINCT FROM a.club_id
 OR r.from_type IS DISTINCT FROM 'club_treasury'OR r.from_entity_id IS DISTINCT FROM a.club_id OR r.to_type IS DISTINCT FROM 'agent_wallet'OR r.to_entity_id IS DISTINCT FROM a.original_payer_id
 OR r.amount IS DISTINCT FROM a.amount OR r.pre_from_balance-r.post_from_balance IS DISTINCT FROM a.amount OR r.post_to_balance-r.pre_to_balance IS DISTINCT FROM a.amount
 OR r.idempotency_key IS DISTINCT FROM 'existing-rakeback-reimbursement:v1:'||a.obligation_role||':'||a.obligation_id::text
 OR r.metadata->>'payment_method'IS DISTINCT FROM 'owner_confirmed_existing_transfer'
 OR(r.metadata->>'period_start')::timestamptz IS DISTINCT FROM a.period_start OR(r.metadata->>'period_end')::timestamptz IS DISTINCT FROM a.period_end
 OR r.metadata->>'existing_transfer_allocation_id'IS DISTINCT FROM a.id::text OR r.metadata->>'original_ledger_id'IS DISTINCT FROM a.original_ledger_id::text
 OR r.metadata->>'beneficiary_id'IS DISTINCT FROM a.beneficiary_id::text OR r.metadata->>'obligation_role'IS DISTINCT FROM a.obligation_role
 OR r.metadata->>'actual_prior_destination'IS DISTINCT FROM 'player_wallet'OR r.metadata->>'source_fingerprint'IS DISTINCT FROM a.source_fingerprint
 OR(SELECT count(*)FROM public.settlement_invoices d WHERE d.source_ledger_id=r.id AND d.status='paid'AND d.chips_transferred AND d.message_sent AND d.gross_amount=a.amount AND d.net_amount=a.amount AND d.deductions=0)<>1
 THEN RETURN false;END IF;
 IF a.obligation_role='player' THEN
  RETURN EXISTS(SELECT FROM public.rakeback_periods rp JOIN public.accounting_rakeback_period_calculations c ON c.period_id=rp.id
   JOIN public.rakeback_period_payouts pp ON pp.id=a.payout_id AND pp.rakeback_period_id=rp.id
   WHERE rp.id=a.obligation_id AND rp.status='paid'AND rp.paid_at IS NOT NULL AND rp.user_id=a.beneficiary_id AND rp.club_id=a.club_id AND rp.rakeback_amount=a.amount
   AND c.id=a.certificate_id AND c.id=(SELECT max(z.id)FROM public.accounting_rakeback_period_calculations z WHERE z.period_id=rp.id)
   AND c.source_fingerprint=a.source_fingerprint AND c.rakeback_amount=a.amount AND c.player_id=a.beneficiary_id AND c.club_id=a.club_id
   AND pp.status='paid'AND pp.paid_at IS NOT NULL AND pp.user_id=a.beneficiary_id AND pp.club_id=a.club_id AND pp.payout_amount=a.amount AND pp.wallet_transaction_id IS NULL);
 END IF;
 RETURN a.obligation_role='commission'AND a.certificate_id IS NULL AND a.payout_id IS NULL
 AND(SELECT count(*)FROM public.agent_commission_settlements cs WHERE cs.club_id=a.club_id AND cs.user_id=a.beneficiary_id AND cs.period_start=a.period_start AND cs.period_end=a.period_end AND cs.amount=a.amount AND cs.paid_at IS NOT NULL)=1;
EXCEPTION WHEN data_exception OR check_violation OR no_data_found THEN RETURN false;
END $body$;
REVOKE ALL ON FUNCTION smarter_private.existing_rakeback_transfer_complete(text,uuid)FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.apply_existing_rakeback_transfer(p_scope_kind text,p_scope_id uuid,p_start timestamptz,p_end timestamptz,p_role text,p_club uuid,p_user uuid,p_period uuid DEFAULT NULL,p_certificate bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET TimeZone='UTC' AS $body$
DECLARE plan jsonb;scope record;a smarter_private.existing_rakeback_transfer_allocations%ROWTYPE;
 payer_before numeric;payer_after numeric;recipient_before numeric;recipient_after numeric;paid_before numeric;paid_after numeric;
 saved_club text;saved_member text;saved_agent text;docs bigint;
BEGIN
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_start,p_end);
 IF public.fn_caller_is_engine()IS DISTINCT FROM true OR public.fn_platform_frozen()IS DISTINCT FROM false
 OR current_setting('app.accounting_routing_context',true)IS DISTINCT FROM scope.routing_context OR NOT(p_club=ANY(scope.club_ids))
 THEN RAISE EXCEPTION 'existing_transfer_original_stage_context_required' USING ERRCODE='42501';END IF;
 IF p_role='player'AND(to_regclass('pg_temp._routed_player_items')IS NULL OR NOT EXISTS(SELECT FROM pg_class WHERE oid=to_regclass('pg_temp._routed_player_items')AND pg_get_userbyid(relowner)='postgres'))
 THEN RAISE EXCEPTION 'existing_transfer_original_player_stage_required' USING ERRCODE='42501';END IF;
 plan:=smarter_private.existing_rakeback_transfer_plan(p_club,p_user,p_start,p_end,p_role,p_period,p_certificate);
 IF plan IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO a FROM jsonb_populate_record(NULL::smarter_private.existing_rakeback_transfer_allocations,plan);
 a.created_at:=clock_timestamp();
 IF p_role='player'THEN
  IF NOT EXISTS(SELECT FROM pg_temp._routed_player_items WHERE period_id=p_period AND certificate_id=p_certificate AND club_id=p_club AND user_id=p_user AND owed=a.amount AND fingerprint=a.source_fingerprint)
  THEN RAISE EXCEPTION 'existing_transfer_original_player_item_required' USING ERRCODE='42501';END IF;
 END IF;
 IF(plan->>'duplicate')::boolean THEN
  IF NOT smarter_private.existing_rakeback_transfer_complete(p_role,a.obligation_id)THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
  RETURN plan;
 END IF;
 PERFORM id FROM public.clubs WHERE id=p_club FOR NO KEY UPDATE;
 PERFORM id FROM public.agents WHERE club_id=p_club AND user_id=a.original_payer_id FOR NO KEY UPDATE;
 SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=p_club;
 SELECT agent_wallet_balance INTO recipient_before FROM public.agents WHERE club_id=p_club AND user_id=a.original_payer_id;
 SELECT chip_balance INTO paid_before FROM public.club_members WHERE club_id=p_club AND user_id=p_user;
 IF payer_before IS NULL OR recipient_before IS NULL OR paid_before IS NULL OR payer_before<a.amount
 OR payer_before<>round(payer_before,2)OR recipient_before<>round(recipient_before,2)OR payer_before::text IN('NaN','Infinity','-Infinity')OR recipient_before::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'existing_transfer_reimbursement_accounts_invalid' USING ERRCODE='23514';END IF;
 saved_club:=current_setting('app.ledger_autoskip_clubs',true);saved_member:=current_setting('app.ledger_autoskip_club_members',true);saved_agent:=current_setting('app.ledger_autoskip_agents',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);PERFORM set_config('app.ledger_autoskip_agents','1',true);
 IF p_role='player'THEN
  INSERT INTO public.rakeback_period_payouts(id,rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
  SELECT a.payout_id,r.id,r.club_id,r.user_id,r.rake_generated,round(r.rakeback_rate*100,2),a.amount,'paid',clock_timestamp()FROM public.rakeback_periods r WHERE r.id=p_period;
 END IF;
 UPDATE public.clubs SET chip_treasury=chip_treasury-a.amount WHERE id=p_club AND chip_treasury>=a.amount RETURNING chip_treasury INTO payer_after;
 UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+a.amount,updated_at=now()WHERE club_id=p_club AND user_id=a.original_payer_id RETURNING agent_wallet_balance INTO recipient_after;
 IF payer_after IS NULL OR recipient_after IS NULL OR payer_before-payer_after IS DISTINCT FROM a.amount OR recipient_after-recipient_before IS DISTINCT FROM a.amount
 THEN RAISE EXCEPTION 'existing_transfer_reimbursement_not_conserved' USING ERRCODE='23514';END IF;
 INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
 VALUES(a.reimbursement_ledger_id,COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'),'club_treasury',p_club,'agent_wallet',a.original_payer_id,a.amount,'treasury_transfer',p_club,scope.union_id,
 'Certified prior payout reimbursement; beneficiary was already credited',
 'existing-rakeback-reimbursement:v1:'||p_role||':'||a.obligation_id::text,
 jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_start,'period_end',p_end,
 'payment_method','owner_confirmed_existing_transfer','existing_transfer_allocation_id',a.id,'original_ledger_id',a.original_ledger_id,'original_transaction_id',a.original_transaction_id,
 'original_operation_id',a.original_operation_id,'beneficiary_id',p_user,'obligation_role',p_role,'actual_prior_destination','player_wallet','canonical_funded_from','club_treasury',
 'certificate_id',p_certificate,'period_id',p_period,'source_fingerprint',a.source_fingerprint,'payee_role_at_transfer','agent','owner_prefunding_reimbursement',true),
 payer_before,payer_after,recipient_before,recipient_after);
 SELECT count(*)INTO docs FROM public.settlement_invoices WHERE source_ledger_id=a.reimbursement_ledger_id AND status='paid'AND chips_transferred AND message_sent AND gross_amount=a.amount AND net_amount=a.amount AND deductions=0;
 IF docs<>1 THEN RAISE EXCEPTION 'existing_transfer_reimbursement_invoice_required' USING ERRCODE='23514';END IF;
 INSERT INTO smarter_private.existing_rakeback_transfer_allocations SELECT a.*;
 IF p_role='player'THEN UPDATE public.rakeback_periods SET status='paid',paid_at=clock_timestamp()WHERE id=p_period;END IF;
 SELECT chip_balance INTO paid_after FROM public.club_members WHERE club_id=p_club AND user_id=p_user;
 IF paid_after IS DISTINCT FROM paid_before THEN RAISE EXCEPTION 'existing_transfer_beneficiary_was_credited_twice' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(saved_club,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(saved_member,''),true);PERFORM set_config('app.ledger_autoskip_agents',COALESCE(saved_agent,''),true);
 IF p_role='player'AND NOT smarter_private.existing_rakeback_transfer_complete(p_role,a.obligation_id)THEN RAISE EXCEPTION 'existing_transfer_final_receipt_incomplete' USING ERRCODE='23514';END IF;
 RETURN to_jsonb(a)||jsonb_build_object('duplicate',false);
END $body$;
REVOKE ALL ON FUNCTION smarter_private.apply_existing_rakeback_transfer(text,uuid,timestamptz,timestamptz,text,uuid,uuid,uuid,bigint)FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.existing_transfer_discharge_guard()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $body$
BEGIN
 IF smarter_private.existing_rakeback_transfer_complete(NEW.obligation_role,NEW.obligation_id)IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'existing_transfer_discharge_evidence_incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $body$;
REVOKE ALL ON FUNCTION smarter_private.existing_transfer_discharge_guard()FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER existing_transfer_allocation_complete AFTER INSERT ON smarter_private.existing_rakeback_transfer_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION smarter_private.existing_transfer_discharge_guard();

CREATE FUNCTION smarter_private.existing_rakeback_transfer_scope_receipts(p_scope_kind text,p_scope_id uuid,p_start timestamptz,p_end timestamptz,p_role text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $body$
 SELECT coalesce(jsonb_agg(jsonb_build_object('allocation_id',a.id,'obligation_id',a.obligation_id,'obligation_role',a.obligation_role,'beneficiary_id',a.beneficiary_id,
 'amount',a.amount,'actual_prior_destination',a.actual_destination,'original_ledger_id',a.original_ledger_id,'original_transaction_id',a.original_transaction_id,'original_operation_id',a.original_operation_id,
 'reimbursement_ledger_id',a.reimbursement_ledger_id,'certificate_id',a.certificate_id,'payout_id',a.payout_id,'source_fingerprint',a.source_fingerprint,
 'payment_method','owner_confirmed_existing_transfer','verified',smarter_private.existing_rakeback_transfer_complete(a.obligation_role,a.obligation_id))ORDER BY a.obligation_role,a.obligation_id),'[]'::jsonb)
 FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger l ON l.id=a.reimbursement_ledger_id
 WHERE a.period_start=p_start AND a.period_end=p_end AND a.obligation_role=p_role AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
$body$;
REVOKE ALL ON FUNCTION smarter_private.existing_rakeback_transfer_scope_receipts(text,uuid,timestamptz,timestamptz,text)FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.existing_rakeback_transfer_player_receipt(p_period uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $body$
 SELECT jsonb_build_object('payment_method','owner_confirmed_existing_transfer','actual_prior_destination',a.actual_destination,'actual_prior_paid_at',a.original_evidence#>'{ledger,created_at}','allocated_amount',a.amount,'original_credit',a.original_credit,
 'original_ledger_id',a.original_ledger_id,'original_transaction_id',a.original_transaction_id,'original_operation_id',a.original_operation_id,'reimbursement_ledger_id',a.reimbursement_ledger_id,
 'allocation_id',a.id,'verified',smarter_private.existing_rakeback_transfer_complete('player',p_period))
 FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='player'AND a.obligation_id=p_period
$body$;
REVOKE ALL ON FUNCTION smarter_private.existing_rakeback_transfer_player_receipt(uuid)FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.existing_rakeback_transfer_scope_economic_plan(p_scope_kind text,p_scope_id uuid,p_start timestamptz,p_end timestamptz,p_role text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $body$
 SELECT coalesce(jsonb_agg(jsonb_build_object('role',a.obligation_role,'club_id',a.club_id,'beneficiary_id',a.beneficiary_id,'period_start',a.period_start,'period_end',a.period_end,
 'certificate_id',a.certificate_id,'source_fingerprint',a.source_fingerprint,'original_ledger_id',a.original_ledger_id,'original_transaction_id',a.original_transaction_id,'original_operation_id',a.original_operation_id,
 'owed',a.amount,'canonical_payer_bank',a.club_id,'canonical_funded_from',a.canonical_funded_from,'actual_historical_payer',a.original_payer_id,'actual_historical_source','agent_wallet',
 'actual_historical_destination',a.actual_destination,'payment_method','owner_confirmed_existing_transfer')ORDER BY a.obligation_role,a.club_id,a.beneficiary_id),'[]'::jsonb)
 FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger l ON l.id=a.reimbursement_ledger_id
 WHERE a.period_start=p_start AND a.period_end=p_end AND a.obligation_role=p_role AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
$body$;
REVOKE ALL ON FUNCTION smarter_private.existing_rakeback_transfer_scope_economic_plan(text,uuid,timestamptz,timestamptz,text)FROM PUBLIC,anon,authenticated,service_role;

-- Owner confirmed these actual sends already satisfied personal rakeback. No
-- amounts are supplied here: the original R2/R3 certificates derive every cent.
INSERT INTO smarter_private.existing_rakeback_transfer_instructions(id,club_id,beneficiary_id,period_start,period_end,original_ledger_id,evidence_ledger_ids,roles,owner_instruction,source_thread)VALUES
('f70f2413-3e72-4dc0-93ef-f97d2cb13d35','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','69f2cefa-017d-49f3-ac3e-61505633747c','2026-10-19 07:00Z','2026-10-26 07:00Z','313ab455-d6a0-4404-bf68-ad2149e62055',ARRAY['313ab455-d6a0-4404-bf68-ad2149e62055'::uuid,'dd7d5fca-a929-4a68-8a0f-9e7df28cf5cf'::uuid],ARRAY['player'],'Owner: DO NOT GIVE RAKEBACK TO WOOWOO OR MIKEY; both already paid. YES confirms the listed prior sends. Earliest WooWoo500 selected; second500 retained only as evidence.','01a17898-6e1d-76e1-8122-375ccaf2925e'),
('4a641982-770d-4a0c-8b03-ddae8fd0dfe3','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','b52f183b-c0fc-4dcc-8d96-7d2a1cdb7216','2026-10-19 07:00Z','2026-10-26 07:00Z','363c3d6c-b63e-4055-83d1-508d9deeeeb0',ARRAY['363c3d6c-b63e-4055-83d1-508d9deeeeb0'::uuid],ARRAY['player','commission'],'Owner: DO NOT GIVE RAKEBACK TO WOOWOO OR MIKEY; both already paid. YES confirms the listed125 prior send. Actual PLAYER destination preserved for any certified personal commission discharge; other-player pass-through must remain funded.','01a17898-6e1d-76e1-8122-375ccaf2925e');

CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE prior_plan jsonb;prior_node record;prior_saved_context text;scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;agent_skip text;owner_retained numeric:=0;v4_ok boolean:=true;v_comb jsonb;
 deleted_deferral text; v_deleted record; v_deleted_before numeric; v_deleted_held numeric; v_deleted_locked numeric;
 v_deleted_bank numeric; v_deleted_return jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_commission_invalid_period' USING ERRCODE='22023'; END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_commission_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_commission_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 run_key:='round2:v3:'||scope.scope_key||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 -- WEEKLY CLOSE SCALE (20260928): one read of the week's sources keeps only
 -- what this stage uses (tiers, the contract's club and each row's own md5),
 -- instead of copying every full contract into a temp table. The fingerprint
 -- is the same md5 over the same per-row md5s in the same order. Anything
 -- this path cannot read exactly as the original did is answered by the
 -- original, byte-for-byte, as public.fn_settle_accounting_commission_stage_v3.
 -- CHUNKED CLOSE WINDOWS (20261003): inside a chunked close the plan below
 -- is combined from the week's proved two-hour windows
 -- (fn_settle_accounting_commission_window, fn_settle_accounting_commission_combine),
 -- exactly as these reads build it; outside one, or with any window missing,
 -- the week is read here as before.
 v_comb:=CASE WHEN COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  THEN public.fn_settle_accounting_commission_combine(p_scope_kind,p_scope_id,p_period_start,p_period_end) END;
 IF v_comb IS NOT NULL THEN
  IF (v_comb->>'read_failed')::boolean THEN
   RAISE EXCEPTION 'routed_commission_window_needs_full_path' USING ERRCODE='55000'; END IF;
  fingerprint:=v_comb->>'fingerprint'; source_count:=(v_comb->>'sources')::int;
  SELECT * INTO previous FROM public.accounting_routed_settlement_runs
   WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
  IF FOUND THEN
   IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger l ON l.id=a.reimbursement_ledger_id
   WHERE a.obligation_role='commission'AND a.period_start=p_period_start AND a.period_end=p_period_end AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
   AND NOT smarter_private.existing_rakeback_transfer_complete('commission',a.obligation_id))THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
    AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
   OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
     AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
  THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
  IF (v_comb->>'unclassified')::bigint>0 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
  -- A contract only the original v3 path can read is not paid from windows,
  -- and v3 is never run here in one long transaction: nothing is paid.
  IF (v_comb->>'full_path')::boolean THEN RAISE EXCEPTION 'routed_commission_window_needs_full_path' USING ERRCODE='55000'; END IF;
  IF (v_comb->>'hierarchy_bad')::boolean THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
  IF (v_comb->>'entitlement_bad')::boolean THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 ELSE
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _routed_sources_v4(source_type text,source_id uuid,club_id uuid,earned_at timestamptz,tiers jsonb,tiers_type text,contract_club text,row_md5 text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
  TRUNCATE pg_temp._routed_sources_v4;
  INSERT INTO pg_temp._routed_sources_v4 SELECT source_type,source_id,club_id,earned_at,contract->'tiers',jsonb_typeof(contract->'tiers'),contract->>'club_id',
   md5((CASE WHEN source_type='cash_rake_accrual' THEN jsonb_build_array(source_id,club_id,earned_at,contract) ELSE jsonb_build_array(source_type,source_id,club_id,earned_at,contract) END)::text)
   FROM public.accounting_payable_earning_sources
   WHERE (coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND coordinator_union_id IS NULL AND club_id=standalone_club)) AND earned_at>=p_period_start AND earned_at<p_period_end;
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end); END IF;
 SELECT count(*),md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type||'',source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources_v4;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger l ON l.id=a.reimbursement_ledger_id
   WHERE a.obligation_role='commission'AND a.period_start=p_period_start AND a.period_end=p_period_end AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
   AND NOT smarter_private.existing_rakeback_transfer_complete('commission',a.obligation_id))THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 -- Any source matching (type,id,club,earned_at=created_at) of a commission row
 -- of these clubs created this week is itself one of these clubs' sources
 -- earned this week, so one hashed read of that slice answers every row. The
 -- tests are counted, not EXISTS: an EXISTS is planned for its first row and
 -- a clean book has none, so it would be a nested loop over the whole week.
 IF (WITH club_week AS MATERIALIZED (
   SELECT rs.source_type,rs.source_id,rs.club_id,rs.earned_at FROM public.accounting_payable_earning_sources rs
    WHERE rs.club_id=ANY(scope.club_ids) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end)
  SELECT count(*) FROM public.agent_commissions ac
   LEFT JOIN club_week rs ON rs.source_type=ac.source_type AND rs.source_id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at
  WHERE ac.created_at>=public.fn_ca_launch_accounting_start('club',ac.club_id,p_period_start) AND ac.created_at<p_period_end
  AND (ac.club_id=ANY(scope.club_ids))
  AND (ac.source_type IS NULL OR ac.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual') OR ac.settled_at IS NOT NULL OR rs.source_id IS NULL))>0
 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_tiers(source_type text,source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
  parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_type,source_id,depth)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_tiers;
 -- One set insert of every tier. A contract the original loop would refuse,
 -- or a tier value it would fail to read, is answered by the original.
 IF EXISTS(SELECT 1 FROM pg_temp._routed_sources_v4 s WHERE s.tiers_type IS DISTINCT FROM 'array' OR s.contract_club IS DISTINCT FROM s.club_id::text) THEN
  RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 END IF;
 BEGIN
  INSERT INTO pg_temp._routed_tiers SELECT s.source_type,s.source_id,s.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM pg_temp._routed_sources_v4 s CROSS JOIN LATERAL jsonb_array_elements(s.tiers) WITH ORDINALITY x(j,ord);
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end); END IF;
 ANALYZE pg_temp._routed_tiers;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
   OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
   OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
   OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._routed_tiers u WHERE u.source_type=t.source_type AND u.source_id=t.source_id AND u.depth=t.depth+1))
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY source_type,source_id,user_id HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1 OR count(DISTINCT role)<>1)
 THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
 -- Every commission row of every source, read once by its (source_id,
 -- source_type) index in source order, whatever its club or time; the three
 -- original tests are then answered from that set.
 CREATE TEMP TABLE IF NOT EXISTS _routed_ac_v4(source_type text,source_id uuid,club_id uuid,user_id uuid,amount numeric,commission_rate numeric,settled_at timestamptz) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_ac_v4;
 INSERT INTO pg_temp._routed_ac_v4 SELECT a.* FROM (SELECT s.source_type,s.source_id FROM pg_temp._routed_sources_v4 s ORDER BY s.source_id,s.source_type) s
  CROSS JOIN LATERAL (SELECT ac.source_type,ac.source_id,ac.club_id,ac.user_id,ac.amount,ac.commission_rate,ac.settled_at FROM public.agent_commissions ac
   WHERE ac.source_id=s.source_id AND ac.source_type=s.source_type OFFSET 0) a;
 ANALYZE pg_temp._routed_ac_v4;
 IF (SELECT count(*) FROM pg_temp._routed_tiers t WHERE t.own_amount>0 AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_ac_v4 ac
    WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
     AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL))>0
  OR (SELECT count(*) FROM pg_temp._routed_tiers t LEFT JOIN (SELECT ac.source_type,ac.source_id,ac.user_id,count(*) AS n FROM pg_temp._routed_ac_v4 ac GROUP BY 1,2,3) c
    ON c.source_type=t.source_type AND c.source_id=t.source_id AND c.user_id=t.user_id
   WHERE COALESCE(c.n,0)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)>0
  OR (SELECT count(*) FROM pg_temp._routed_ac_v4 ac
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_type=ac.source_type AND t.source_id=ac.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))>0
 THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT club_id,user_id,min(agent_id::text)::uuid,min(role),sum(own_amount),count(*) FILTER(WHERE own_amount>0)
  FROM pg_temp._routed_tiers GROUP BY club_id,user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 -- The same per-tier running sum (depth is unique within a source).
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum(t.upto),min(t.role)
 FROM (SELECT t.*,sum(t.own_amount) OVER(PARTITION BY t.source_type,t.source_id ORDER BY t.depth ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS upto
  FROM pg_temp._routed_tiers t) t
 LEFT JOIN pg_temp._routed_tiers parent ON parent.source_type=t.source_type AND parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum(t.upto)>0;
 CREATE TEMP TABLE IF NOT EXISTS _routed_clubs(club_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_clubs;
 INSERT INTO pg_temp._routed_clubs SELECT DISTINCT club_id FROM pg_temp._routed_sources_v4;
 END IF;
 SELECT count(*) INTO node_count FROM pg_temp._routed_nodes;
 WHILE finished<node_count LOOP
  step:=step+1;
  UPDATE pg_temp._routed_nodes n SET sort_order=step WHERE sort_order IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_nodes p ON p.club_id=e.club_id AND p.user_id=e.payer_user
   WHERE e.club_id=n.club_id AND e.payee_user=n.user_id AND p.sort_order IS NULL);
  GET DIAGNOSTICS progress=ROW_COUNT;
  IF progress=0 THEN RAISE EXCEPTION 'routed_commission_weekly_hierarchy_cycle' USING ERRCODE='23514'; END IF;
  finished:=finished+progress;
 END LOOP;
 UPDATE pg_temp._routed_edges e SET sort_order=n.sort_order FROM pg_temp._routed_nodes n WHERE n.club_id=e.club_id AND n.user_id=e.payee_user;
 SELECT COALESCE(sum(own_amount),0) INTO own_total FROM pg_temp._routed_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.own_amount IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- COMMISSION LANDS IN AGENT WALLETS; THE OWNER'S SHARE STAYS IN THE CLUB BANK
 -- (20261022, Dan). The club owner (clubs.owner_id) is never paid commission
 -- into any personal wallet: the owner's own tier is not moved out of
 -- clubs.chip_treasury at all, and what the recorded hierarchy passes down
 -- through the owner is paid to the child agent straight from the club bank.
 -- Every other payee is credited in agents.agent_wallet_balance, never in
 -- club_members.chip_balance.
 CREATE TEMP TABLE IF NOT EXISTS _routed_owner_nodes(club_id uuid,user_id uuid,own_amount numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_owner_nodes;
 INSERT INTO pg_temp._routed_owner_nodes SELECT n.club_id,n.user_id,n.own_amount FROM pg_temp._routed_nodes n JOIN public.clubs c ON c.id=n.club_id AND c.owner_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payee_user WHERE e.payer_user IS NOT NULL)
 THEN RAISE EXCEPTION 'routed_commission_owner_below_agent' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges_paid(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges_paid;
 INSERT INTO pg_temp._routed_edges_paid(club_id,payer_user,payee_user,amount,role,sort_order)
 SELECT e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user,sum(e.amount),min(e.role),min(e.sort_order)
  FROM pg_temp._routed_edges e LEFT JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payer_user
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes p WHERE p.club_id=e.club_id AND p.user_id=e.payee_user)
  GROUP BY e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role,sort_order)
  SELECT club_id,payer_user,payee_user,amount,role,sort_order FROM pg_temp._routed_edges_paid;
 SELECT COALESCE(sum(own_amount),0) INTO owner_retained FROM pg_temp._routed_owner_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total+owner_retained<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE
   (CASE WHEN EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) THEN 0 ELSE n.own_amount END) IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_owner_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- Original tiers, entitlement rows, complete hierarchy and full gross
 -- conservation have already been proved. Remove only the subject's own
 -- discharged share, preserving every descendant's genuine pass-through.
 CREATE TEMP TABLE IF NOT EXISTS _routed_prior_discharge_context(stage_round int,period_start timestamptz,period_end timestamptz,club_ids uuid[],source_fingerprint text)ON COMMIT DROP;
 TRUNCATE pg_temp._routed_prior_discharge_context;
 INSERT INTO pg_temp._routed_prior_discharge_context VALUES(2,p_period_start,p_period_end,scope.club_ids,fingerprint);
 prior_saved_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 FOR prior_node IN SELECT n.* FROM pg_temp._routed_nodes n JOIN smarter_private.existing_rakeback_transfer_instructions q
  ON q.club_id=n.club_id AND q.beneficiary_id=n.user_id AND q.period_start=p_period_start AND q.period_end=p_period_end
  WHERE 'commission'=ANY(q.roles)AND n.own_amount>0 ORDER BY n.club_id,n.user_id LOOP
  prior_plan:=smarter_private.apply_existing_rakeback_transfer(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission',prior_node.club_id,prior_node.user_id);
  IF prior_plan IS NULL THEN RAISE EXCEPTION 'existing_transfer_expected_commission_instruction_required';END IF;
  UPDATE pg_temp._routed_edges SET amount=amount-(prior_plan->>'amount')::numeric WHERE club_id=prior_node.club_id AND payee_user=prior_node.user_id AND payer_user IS NULL;
  IF NOT FOUND OR EXISTS(SELECT FROM pg_temp._routed_edges WHERE amount<0)THEN RAISE EXCEPTION 'existing_transfer_commission_edge_not_conserved';END IF;
 END LOOP;
 DELETE FROM pg_temp._routed_edges WHERE amount=0;
 PERFORM set_config('app.accounting_routing_context',COALESCE(prior_saved_context,''),true);
 IF EXISTS(SELECT FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id)
  AND n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)
  IS DISTINCT FROM COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)-COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'existing_transfer_commission_adjusted_plan_not_conserved';END IF;
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route. A retired agent keeps the earned entitlement; the
 -- existing agent wallet (agents row) and immutable source contract remain mandatory.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_clubs) ORDER BY c.id FOR NO KEY UPDATE;
 PERFORM a.id FROM public.agents a JOIN pg_temp._routed_nodes n ON n.club_id=a.club_id AND n.user_id=a.user_id
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) ORDER BY a.club_id,a.user_id FOR NO KEY UPDATE OF a;
 UPDATE pg_temp._routed_nodes n SET opening_balance=a.agent_wallet_balance FROM public.agents a WHERE a.club_id=n.club_id AND a.user_id=n.user_id
  AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND (n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2)))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 deleted_deferral:=current_setting('app.deleted_wallet_routing_stage',true);
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);agent_skip:=current_setting('app.ledger_autoskip_agents',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.deleted_wallet_routing_stage','commission',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);PERFORM set_config('app.ledger_autoskip_agents','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT agent_wallet_balance INTO payee_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT agent_wallet_balance INTO payer_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND agent_wallet_balance>=v_edge.amount RETURNING agent_wallet_balance INTO payer_after;
  END IF;
  UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING agent_wallet_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  -- Agent wallets are journalled by the chip_ledger leg and its receipt below,
  -- exactly as every other agent-wallet door; no player-wallet transaction.
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'agent_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'agent_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)FROM pg_temp._routed_nodes n WHERE n.club_id=v_edge.club_id AND n.user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL,'paid_to','agent_wallet'),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);PERFORM set_config('app.ledger_autoskip_agents',COALESCE(agent_skip,''),true);
 PERFORM set_config('app.deleted_wallet_routing_stage',COALESCE(deleted_deferral,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n LEFT JOIN public.agents a ON a.club_id=n.club_id AND a.user_id=n.user_id
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND a.agent_wallet_balance IS DISTINCT FROM n.opening_balance+n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0))
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 -- All original transfer, invoice and net-wallet checks above still decide
 -- whether this stage may finish. Return only free net chips afterward,
 -- retaining published unpaid player obligations across bounded chunks.
 FOR v_deleted IN
  SELECT a.club_id,a.user_id FROM public.agents a
  JOIN public.profiles dp ON dp.id=a.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_edges e WHERE e.club_id=a.club_id AND e.payee_user=a.user_id AND e.amount>0) ORDER BY a.club_id,a.user_id
 LOOP
  SELECT a.agent_wallet_balance INTO STRICT v_deleted_before FROM public.agents a
   WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id;
  SELECT dwr_bank.chip_treasury INTO STRICT v_deleted_bank FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id;
  v_deleted_return:=public.fn_ca_deleted_wallet_bank_return(v_deleted.club_id,v_deleted.user_id,'agent_wallet');
  IF v_deleted_return->'success' IS DISTINCT FROM 'true'::jsonb
   OR v_deleted_return->>'reserved_rakeback' IS NULL OR (v_deleted_return->>'reserved_rakeback')::numeric<0
   OR (v_deleted_return->>'reserved_rakeback')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (v_deleted_return->>'amount')::numeric IS DISTINCT FROM greatest(v_deleted_before-(v_deleted_return->>'reserved_rakeback')::numeric,0)
   OR (v_deleted_return->>'agent_chips')::numeric IS DISTINCT FROM (v_deleted_return->>'amount')::numeric
   OR (v_deleted_return->>'player_chips')::numeric IS DISTINCT FROM 0::numeric
   OR NOT EXISTS(SELECT FROM public.agents a WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id
     AND a.agent_wallet_balance=v_deleted_before-(v_deleted_return->>'amount')::numeric)
   OR NOT EXISTS(SELECT FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id AND dwr_bank.chip_treasury=v_deleted_bank+(v_deleted_return->>'amount')::numeric)
  THEN RAISE EXCEPTION 'deleted_weekly_net_bank_return_not_conserved' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);

 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count-(SELECT count(*)::int FROM pg_temp._routed_owner_nodes),'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'owner_retained_in_club_bank',owner_retained,'paid_to','agent_wallet',
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 result:=result||jsonb_build_object('existing_transfer_economic_plan',smarter_private.existing_rakeback_transfer_scope_economic_plan(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'),
  'existing_transfer_receipts',smarter_private.existing_rakeback_transfer_scope_receipts(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'));
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage_v3(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE prior_plan jsonb;prior_node record;prior_saved_context text;scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;agent_skip text;owner_retained numeric:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_commission_invalid_period' USING ERRCODE='22023'; END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_commission_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_commission_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 run_key:='round2:v3:'||scope.scope_key||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 CREATE TEMP TABLE IF NOT EXISTS _routed_sources(source_type text,source_id uuid,club_id uuid,contract jsonb,earned_at timestamptz,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_sources;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 INSERT INTO pg_temp._routed_sources SELECT source_type,source_id,club_id,contract,earned_at FROM public.accounting_payable_earning_sources
  WHERE (coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND coordinator_union_id IS NULL AND club_id=standalone_club)) AND earned_at>=p_period_start AND earned_at<p_period_end;
 SELECT count(*),md5(COALESCE(string_agg(md5((CASE WHEN source_type='cash_rake_accrual' THEN jsonb_build_array(source_id,club_id,earned_at,contract) ELSE jsonb_build_array(source_type,source_id,club_id,earned_at,contract) END)::text),'' ORDER BY source_type,source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger l ON l.id=a.reimbursement_ledger_id
   WHERE a.obligation_role='commission'AND a.period_start=p_period_start AND a.period_end=p_period_end AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
   AND NOT smarter_private.existing_rakeback_transfer_complete('commission',a.obligation_id))THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.created_at>=p_period_start AND ac.created_at<p_period_end
  AND (ac.club_id=ANY(scope.club_ids))
  AND (ac.source_type IS NULL OR ac.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual') OR ac.settled_at IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.source_type=ac.source_type AND rs.source_id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at)))
 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_tiers(source_type text,source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
  parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_type,source_id,depth)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_tiers;
 FOR v_source IN SELECT * FROM pg_temp._routed_sources ORDER BY source_type,source_id LOOP
  IF jsonb_typeof(v_source.contract->'tiers') IS DISTINCT FROM 'array' OR v_source.contract->>'club_id' IS DISTINCT FROM v_source.club_id::text
  THEN RAISE EXCEPTION 'routed_commission_contract_invalid' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_tiers SELECT v_source.source_type,v_source.source_id,v_source.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM jsonb_array_elements(v_source.contract->'tiers') WITH ORDINALITY x(j,ord);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
   OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
   OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
   OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._routed_tiers u WHERE u.source_type=t.source_type AND u.source_id=t.source_id AND u.depth=t.depth+1))
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY source_type,source_id,user_id HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1 OR count(DISTINCT role)<>1)
 THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE (t.own_amount>0 AND (SELECT count(*) FROM public.agent_commissions ac
   WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
    AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL)=0)
   OR (SELECT count(*) FROM public.agent_commissions ac WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.user_id=t.user_id)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)
  OR EXISTS(SELECT 1 FROM public.agent_commissions ac JOIN pg_temp._routed_sources s ON s.source_type=ac.source_type AND s.source_id=ac.source_id
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_type=s.source_type AND t.source_id=s.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))
 THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT club_id,user_id,min(agent_id::text)::uuid,min(role),sum(own_amount),count(*) FILTER(WHERE own_amount>0)
  FROM pg_temp._routed_tiers GROUP BY club_id,user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_type=t.source_type AND child.source_id=t.source_id AND child.depth<=t.depth)),min(t.role)
 FROM pg_temp._routed_tiers t LEFT JOIN pg_temp._routed_tiers parent ON parent.source_type=t.source_type AND parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_type=t.source_type AND child.source_id=t.source_id AND child.depth<=t.depth))>0;
 SELECT count(*) INTO node_count FROM pg_temp._routed_nodes;
 WHILE finished<node_count LOOP
  step:=step+1;
  UPDATE pg_temp._routed_nodes n SET sort_order=step WHERE sort_order IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_nodes p ON p.club_id=e.club_id AND p.user_id=e.payer_user
   WHERE e.club_id=n.club_id AND e.payee_user=n.user_id AND p.sort_order IS NULL);
  GET DIAGNOSTICS progress=ROW_COUNT;
  IF progress=0 THEN RAISE EXCEPTION 'routed_commission_weekly_hierarchy_cycle' USING ERRCODE='23514'; END IF;
  finished:=finished+progress;
 END LOOP;
 UPDATE pg_temp._routed_edges e SET sort_order=n.sort_order FROM pg_temp._routed_nodes n WHERE n.club_id=e.club_id AND n.user_id=e.payee_user;
 SELECT COALESCE(sum(own_amount),0) INTO own_total FROM pg_temp._routed_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.own_amount IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- COMMISSION LANDS IN AGENT WALLETS; THE OWNER'S SHARE STAYS IN THE CLUB BANK
 -- (20261022, Dan). The club owner (clubs.owner_id) is never paid commission
 -- into any personal wallet: the owner's own tier is not moved out of
 -- clubs.chip_treasury at all, and what the recorded hierarchy passes down
 -- through the owner is paid to the child agent straight from the club bank.
 -- Every other payee is credited in agents.agent_wallet_balance, never in
 -- club_members.chip_balance.
 CREATE TEMP TABLE IF NOT EXISTS _routed_owner_nodes(club_id uuid,user_id uuid,own_amount numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_owner_nodes;
 INSERT INTO pg_temp._routed_owner_nodes SELECT n.club_id,n.user_id,n.own_amount FROM pg_temp._routed_nodes n JOIN public.clubs c ON c.id=n.club_id AND c.owner_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payee_user WHERE e.payer_user IS NOT NULL)
 THEN RAISE EXCEPTION 'routed_commission_owner_below_agent' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges_paid(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges_paid;
 INSERT INTO pg_temp._routed_edges_paid(club_id,payer_user,payee_user,amount,role,sort_order)
 SELECT e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user,sum(e.amount),min(e.role),min(e.sort_order)
  FROM pg_temp._routed_edges e LEFT JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payer_user
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes p WHERE p.club_id=e.club_id AND p.user_id=e.payee_user)
  GROUP BY e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role,sort_order)
  SELECT club_id,payer_user,payee_user,amount,role,sort_order FROM pg_temp._routed_edges_paid;
 SELECT COALESCE(sum(own_amount),0) INTO owner_retained FROM pg_temp._routed_owner_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total+owner_retained<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE
   (CASE WHEN EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) THEN 0 ELSE n.own_amount END) IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_owner_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- Original tiers, entitlement rows, complete hierarchy and full gross
 -- conservation have already been proved. Remove only the subject's own
 -- discharged share, preserving every descendant's genuine pass-through.
 CREATE TEMP TABLE IF NOT EXISTS _routed_prior_discharge_context(stage_round int,period_start timestamptz,period_end timestamptz,club_ids uuid[],source_fingerprint text)ON COMMIT DROP;
 TRUNCATE pg_temp._routed_prior_discharge_context;
 INSERT INTO pg_temp._routed_prior_discharge_context VALUES(2,p_period_start,p_period_end,scope.club_ids,fingerprint);
 prior_saved_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 FOR prior_node IN SELECT n.* FROM pg_temp._routed_nodes n JOIN smarter_private.existing_rakeback_transfer_instructions q
  ON q.club_id=n.club_id AND q.beneficiary_id=n.user_id AND q.period_start=p_period_start AND q.period_end=p_period_end
  WHERE 'commission'=ANY(q.roles)AND n.own_amount>0 ORDER BY n.club_id,n.user_id LOOP
  prior_plan:=smarter_private.apply_existing_rakeback_transfer(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission',prior_node.club_id,prior_node.user_id);
  IF prior_plan IS NULL THEN RAISE EXCEPTION 'existing_transfer_expected_commission_instruction_required';END IF;
  UPDATE pg_temp._routed_edges SET amount=amount-(prior_plan->>'amount')::numeric WHERE club_id=prior_node.club_id AND payee_user=prior_node.user_id AND payer_user IS NULL;
  IF NOT FOUND OR EXISTS(SELECT FROM pg_temp._routed_edges WHERE amount<0)THEN RAISE EXCEPTION 'existing_transfer_commission_edge_not_conserved';END IF;
 END LOOP;
 DELETE FROM pg_temp._routed_edges WHERE amount=0;
 PERFORM set_config('app.accounting_routing_context',COALESCE(prior_saved_context,''),true);
 IF EXISTS(SELECT FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id)
  AND n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)
  IS DISTINCT FROM COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)-COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'existing_transfer_commission_adjusted_plan_not_conserved';END IF;
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route. A retired agent keeps the earned entitlement; the
 -- existing agent wallet (agents row) and immutable source contract remain mandatory.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources) ORDER BY c.id FOR NO KEY UPDATE;
 PERFORM a.id FROM public.agents a JOIN pg_temp._routed_nodes n ON n.club_id=a.club_id AND n.user_id=a.user_id
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) ORDER BY a.club_id,a.user_id FOR NO KEY UPDATE OF a;
 UPDATE pg_temp._routed_nodes n SET opening_balance=a.agent_wallet_balance FROM public.agents a WHERE a.club_id=n.club_id AND a.user_id=n.user_id
  AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND (n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2)))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);agent_skip:=current_setting('app.ledger_autoskip_agents',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);PERFORM set_config('app.ledger_autoskip_agents','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT agent_wallet_balance INTO payee_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT agent_wallet_balance INTO payer_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND agent_wallet_balance>=v_edge.amount RETURNING agent_wallet_balance INTO payer_after;
  END IF;
  UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING agent_wallet_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  -- Agent wallets are journalled by the chip_ledger leg and its receipt below,
  -- exactly as every other agent-wallet door; no player-wallet transaction.
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'agent_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'agent_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)FROM pg_temp._routed_nodes n WHERE n.club_id=v_edge.club_id AND n.user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL,'paid_to','agent_wallet'),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);PERFORM set_config('app.ledger_autoskip_agents',COALESCE(agent_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n LEFT JOIN public.agents a ON a.club_id=n.club_id AND a.user_id=n.user_id
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND a.agent_wallet_balance IS DISTINCT FROM n.opening_balance+n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0))
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count-(SELECT count(*)::int FROM pg_temp._routed_owner_nodes),'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'owner_retained_in_club_bank',owner_retained,'paid_to','agent_wallet',
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 result:=result||jsonb_build_object('existing_transfer_economic_plan',smarter_private.existing_rakeback_transfer_scope_economic_plan(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'),
  'existing_transfer_receipts',smarter_private.existing_rakeback_transfer_scope_receipts(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'));
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_rakeback_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE prior_plan jsonb;prior_item record;prior_saved_context text;legacy_paid_cash_replay boolean:=false;scope record;p_union_id uuid;standalone_club uuid;
 r record;c public.accounting_rakeback_period_calculations%ROWTYPE;g record;
 previous public.accounting_routed_settlement_runs%ROWTYPE;fingerprint text;result jsonb;
 from_date date;to_date date;allocation_count int;matched_count int;actual_count int;
 generated numeric;unrounded numeric;display_rate numeric;amount numeric;paid numeric:=0;
 payer_before numeric;payer_after numeric;player_before numeric;player_after numeric;
 payout_id uuid;wallet_id uuid;ledger_id uuid;receipt_count int;payees int:=0;
 club_skip text;member_skip text;maintenance text;routing_context text;agent_skip text;v4_ok boolean:=false;
 v_plan jsonb;v_plan_used boolean:=false;v_batched boolean:=false;v_stop timestamptz;v_remaining bigint:=0;
 v_paid_before numeric:=0;v_payees_before int:=0;
 deleted_deferral text; v_deleted record; v_deleted_before numeric; v_deleted_held numeric; v_deleted_locked numeric;
 v_deleted_bank numeric; v_deleted_return jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_rakeback_invalid_period' USING ERRCODE='22023'; END IF;
 IF public.fn_ca_launch_accounting_waived(p_scope_kind,p_scope_id,p_period_end) THEN
  RETURN jsonb_build_object('success',true,'waived',true,'paid',false,'reason','owner_directed_launch_waiver');
 END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF p_union_id IS NOT NULL THEN PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_period_start,p_period_end); END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_rakeback_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 from_date:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 to_date:=(p_period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_rakeback_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 -- Only a completed cash-only run can read its original untyped allocation
 -- again. Pending certificates need explicit source types before any payment.
 legacy_paid_cash_replay:=FOUND AND previous.routing_version=3 AND previous.result->>'source_version'='2'
  AND NOT(previous.result ? 'source_contract_version');
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_items(period_id uuid PRIMARY KEY,certificate_id bigint,club_id uuid,user_id uuid,
  payer_kind text,payer_user uuid,owed numeric,rake numeric,rate numeric,fingerprint text,status text) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_items;
 -- CHUNKED CLOSE (20261003, round 3 read once): in a chunked close attempt the
 -- week's reads and allocation tests may come from the attempt that read them
 -- (fn_settle_accounting_rakeback_plan); see below for when they are used.
 v_plan:=public.fn_settle_accounting_rakeback_plan_get(p_scope_kind,p_scope_id,p_period_start,p_period_end,scope.club_ids,p_union_id,standalone_club,legacy_paid_cash_replay);
 CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_nonhouse(club_id uuid,player_id uuid,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._rr3_plan_nonhouse;
 CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
 -- WEEKLY CLOSE SCALE (20260928): the per-period proof, read as sets. The
 -- periods are locked in the original order; the latest certificate of each,
 -- every allocation of every certificate and this scope's sources of the week
 -- are each read once, and every original test is evaluated on them. Only a
 -- book that passes every test takes this path. Any refusal, and anything
 -- this path cannot read, runs the original per-period loop below, unchanged,
 -- which raises exactly what it always raised.
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _rr3_periods_v4(ord bigint,LIKE public.rakeback_periods) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_periods_v4;
  -- WEEKLY CLOSE SCALE (20261003): a period of a club outside scope.club_ids
  -- is admitted when this scope earned from its player in the week. Those
  -- (club, player) pairs are read once, for exactly the clubs of such
  -- periods, in this same statement, instead of a scan of the club's whole
  -- week of sources per period (887 s in the 2026-10-01 Midway close: 382
  -- standalone periods). A period whose club is not in that set (only a row
  -- changed under EvalPlanQual) still asks the sources directly.
  INSERT INTO pg_temp._rr3_periods_v4 SELECT row_number() OVER(ORDER BY x.club_id,x.user_id,x.id),x.*
   FROM (WITH pclubs AS MATERIALIZED (SELECT DISTINCT p2.club_id FROM public.rakeback_periods p2
      WHERE p2.period_start<=to_date AND p2.period_end>=from_date AND p2.club_id IS NOT NULL AND (p2.club_id=ANY(scope.club_ids)) IS NOT TRUE),
    pairs AS MATERIALIZED (SELECT DISTINCT rs.club_id,rs.player_id FROM public.accounting_payable_earning_sources rs
      WHERE rs.club_id IN(SELECT pc.club_id FROM pclubs pc)
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
      AND v_plan IS NULL
     UNION SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'pairs') e
      WHERE v_plan IS NOT NULL AND (e->>0)::uuid IN(SELECT pc.club_id FROM pclubs pc))
   SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  -- A standalone book never owns a valid Union certificate without any of
  -- its own original earning sources. Unknown certificates remain admitted
  -- to the original refusal path; any standalone source defeats exclusion.
  -- The identical certificate tests are read once per close as one set
  -- (fn_standalone_foreign_certificate_periods), never once per period.
  AND NOT(p_scope_kind='club' AND rp.club_id=standalone_club
    AND rp.period_start=from_date AND rp.period_end=to_date
    AND rp.id IN(SELECT foreign_set.period_id FROM public.fn_standalone_foreign_certificate_periods(
      p_scope_kind,standalone_club,from_date,to_date,p_period_start,p_period_end)foreign_set))
  AND (rp.club_id=ANY(scope.club_ids)
    OR CASE WHEN rp.club_id IN(SELECT pc.club_id FROM pclubs pc)
     THEN EXISTS(SELECT 1 FROM pairs q WHERE q.club_id=rp.club_id AND q.player_id=rp.user_id)
     ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end) END)
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE OF rp) x;
  CREATE TEMP TABLE IF NOT EXISTS _rr3_certs_v4(period_id uuid PRIMARY KEY,id bigint,accounting_version integer,source_fingerprint text,club_id uuid,player_id uuid,
   coordinator_union_id uuid,period_start date,period_end date,rake_generated numeric,rakeback_amount numeric,display_rate numeric,payer_kind text,payer_user_id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_certs_v4;
  INSERT INTO pg_temp._rr3_certs_v4 SELECT DISTINCT ON(x.period_id) x.period_id,x.id,x.accounting_version,x.source_fingerprint,x.club_id,x.player_id,
   x.coordinator_union_id,x.period_start,x.period_end,x.rake_generated,x.rakeback_amount,x.display_rate,x.payer_kind,x.payer_user_id
   FROM public.accounting_rakeback_period_calculations x WHERE x.period_id IN(SELECT id FROM pg_temp._rr3_periods_v4) ORDER BY x.period_id,x.id DESC;
  IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 pr LEFT JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
    WHERE COALESCE(pc.id IS NULL OR pc.accounting_version<>2 OR pc.coordinator_union_id IS DISTINCT FROM p_union_id OR pr.period_start<>from_date OR pr.period_end<>to_date
   OR pc.club_id IS DISTINCT FROM pr.club_id OR pc.player_id IS DISTINCT FROM pr.user_id
   OR pc.period_start IS DISTINCT FROM pr.period_start OR pc.period_end IS DISTINCT FROM pr.period_end
   OR pc.rake_generated IS DISTINCT FROM pr.rake_generated OR pc.rake_generated IS DISTINCT FROM pr.total_rake_paid
   OR pc.rakeback_amount IS DISTINCT FROM pr.rakeback_amount OR pc.rakeback_amount IS DISTINCT FROM pr.rakeback_earned
   OR pc.display_rate IS DISTINCT FROM pr.rakeback_rate OR pc.rakeback_amount<0 OR pc.rakeback_amount<>round(pc.rakeback_amount,2)
   OR pc.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR pc.payer_kind NOT IN('agent','club','split')
   OR (pc.payer_kind='agent') IS DISTINCT FROM(pc.payer_user_id IS NOT NULL) OR pc.payer_user_id=pr.user_id,false))=0 THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_wn_v4(club_id uuid,player_id uuid,n bigint,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_wn_v4;
   IF v_plan IS NOT NULL THEN
    CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_alloc(period_id uuid PRIMARY KEY,cert_id bigint,club_id uuid,user_id uuid,allocation_count bigint,matched_count bigint,
     generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
    TRUNCATE pg_temp._rr3_plan_alloc;
    INSERT INTO pg_temp._rr3_plan_alloc SELECT (e->>0)::uuid,(e->>1)::bigint,(e->>2)::uuid,(e->>3)::uuid,(e->>4)::bigint,(e->>5)::bigint,
     (e->>6)::numeric,(e->>7)::numeric,(e->>8)::boolean FROM jsonb_array_elements(v_plan->'alloc') e;
    IF NOT EXISTS(SELECT 1 FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
      WHERE NOT EXISTS(SELECT 1 FROM pg_temp._rr3_plan_alloc a WHERE a.period_id=pr.id AND a.cert_id=pc.id AND a.club_id=pr.club_id AND a.user_id=pr.user_id)) THEN
     v_plan_used:=true;
    END IF;
   END IF;
   IF NOT v_plan_used THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_week_v4;
   -- house_text (20261003): the source's is_union_house as written, read in
   -- this one pass so the missing-period check below need not read the week
   -- of sources again.
   INSERT INTO pg_temp._rr3_week_v4 SELECT rs.source_type,rs.source_id,rs.club_id,rs.player_id,rs.coordinator_union_id,rs.earned_at,rs.rake_credit,rs.rake_record_id,
    (CASE WHEN (((rs.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=0.70 OR rs.contract->'tiers'->0 IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=rs.club_id AND owner_club.owner_id=NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid)) THEN NULL::uuid ELSE NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid END)::text,rs.contract->>'is_union_house'
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
     AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
   ANALYZE pg_temp._rr3_week_v4;
   END IF;
   CREATE TEMP TABLE IF NOT EXISTS _rr3_alloc_v4(period_id uuid PRIMARY KEY,allocation_count bigint,matched_count bigint,generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_alloc_v4;
   -- A source of this allocation that is not in this scope's week slice is
   -- outside the scope or the week, which the original test refuses too.
   IF v_plan_used THEN
    INSERT INTO pg_temp._rr3_alloc_v4 SELECT a.period_id,a.allocation_count,a.matched_count,a.generated,a.unrounded,a.any_bad
     FROM pg_temp._rr3_plan_alloc a JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=a.period_id AND pc.id=a.cert_id;
    INSERT INTO pg_temp._rr3_wn_v4 SELECT (e->>0)::uuid,(e->>1)::uuid,(e->>2)::bigint FROM jsonb_array_elements(v_plan->'counts') e;
    INSERT INTO pg_temp._rr3_plan_nonhouse SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'nonhouse') e;
   ELSE
   INSERT INTO pg_temp._rr3_alloc_v4 SELECT pc.period_id,count(*),
    count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),
    sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric),
    COALESCE(bool_or(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>pr.club_id OR rs.player_id<>pr.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR (pc.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM pc.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM pc.payer_user_id)) OR (pc.payer_kind='split' AND(a->>'payer_kind' NOT IN('agent','club') OR(a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','')IS NOT NULL)))
      OR NULLIF(rs.agent_text,'')::uuid IS DISTINCT FROM NULLIF(a->>'payer_user_id','')::uuid),false)
    FROM pg_temp._rr3_certs_v4 pc JOIN pg_temp._rr3_periods_v4 pr ON pr.id=pc.period_id
    JOIN public.accounting_rakeback_period_calculations cc ON cc.id=pc.id
    CROSS JOIN LATERAL jsonb_array_elements(cc.source_allocations) a
    LEFT JOIN pg_temp._rr3_week_v4 rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
    GROUP BY pc.period_id;
   INSERT INTO pg_temp._rr3_wn_v4 SELECT w.club_id,w.player_id,count(*) FROM pg_temp._rr3_week_v4 w GROUP BY w.club_id,w.player_id;
   END IF;
   IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
     LEFT JOIN pg_temp._rr3_alloc_v4 ag ON ag.period_id=pr.id
     LEFT JOIN pg_temp._rr3_wn_v4 w ON w.club_id=pr.club_id AND w.player_id=pr.user_id
     WHERE COALESCE((COALESCE(ag.allocation_count,0)=0 OR COALESCE(ag.allocation_count,0)<>COALESCE(ag.matched_count,0) OR COALESCE(ag.allocation_count,0)<>COALESCE(w.n,0)
       OR ag.generated IS DISTINCT FROM pc.rake_generated
       OR round(ag.unrounded,2) IS DISTINCT FROM pc.rakeback_amount
       OR pc.display_rate IS DISTINCT FROM (CASE WHEN ag.generated>0 THEN round(ag.unrounded/ag.generated,4) ELSE 0 END))
      OR COALESCE(ag.any_bad,false),false))=0 THEN
    INSERT INTO pg_temp._routed_player_items SELECT pr.id,pc.id,pr.club_id,pr.user_id,pc.payer_kind,pc.payer_user_id,pc.rakeback_amount,pc.rake_generated,pc.display_rate,pc.source_fingerprint,pr.status
     FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id;
    v4_ok:=true;
   END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN
 TRUNCATE pg_temp._routed_player_items;
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  -- A standalone book never owns a valid Union certificate without any of
  -- its own original earning sources. Unknown certificates remain admitted
  -- to the original refusal path; any standalone source defeats exclusion.
  -- The identical certificate tests are read once per close as one set
  -- (fn_standalone_foreign_certificate_periods), never once per period.
  AND NOT(p_scope_kind='club' AND rp.club_id=standalone_club
    AND rp.period_start=from_date AND rp.period_end=to_date
    AND rp.id IN(SELECT foreign_set.period_id FROM public.fn_standalone_foreign_certificate_periods(
      p_scope_kind,standalone_club,from_date,to_date,p_period_start,p_period_end)foreign_set))
  AND (rp.club_id=ANY(scope.club_ids)
    OR EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end))
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE
 LOOP
  SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE period_id=r.id ORDER BY id DESC LIMIT 1;
  IF NOT FOUND OR c.accounting_version<>2 OR c.coordinator_union_id IS DISTINCT FROM p_union_id OR r.period_start<>from_date OR r.period_end<>to_date
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS DISTINCT FROM r.rake_generated OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.display_rate IS DISTINCT FROM r.rakeback_rate OR c.rakeback_amount<0 OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR c.payer_kind NOT IN('agent','club','split')
   OR (c.payer_kind='agent') IS DISTINCT FROM(c.payer_user_id IS NOT NULL) OR c.payer_user_id=r.user_id
  THEN RAISE EXCEPTION 'routed_rakeback_certificate_required' USING ERRCODE='55000'; END IF;
  SELECT count(*),count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)
   INTO allocation_count,matched_count,generated,unrounded FROM jsonb_array_elements(c.source_allocations) a;
  SELECT count(*) INTO actual_count FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=r.club_id AND rs.player_id=r.user_id
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
  IF allocation_count=0 OR allocation_count<>matched_count OR allocation_count<>actual_count OR generated IS DISTINCT FROM c.rake_generated
    OR round(unrounded,2) IS DISTINCT FROM c.rakeback_amount
    OR c.display_rate IS DISTINCT FROM (CASE WHEN generated>0 THEN round(unrounded/generated,4) ELSE 0 END)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_allocations) a LEFT JOIN public.accounting_payable_earning_sources rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
     WHERE COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>r.club_id OR rs.player_id<>r.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR (c.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM c.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM c.payer_user_id)) OR (c.payer_kind='split' AND(a->>'payer_kind' NOT IN('agent','club') OR(a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','')IS NOT NULL)))
      OR (CASE WHEN (((rs.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=0.70 OR rs.contract->'tiers'->0 IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=rs.club_id AND owner_club.owner_id=NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid)) THEN NULL::uuid ELSE NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid END) IS DISTINCT FROM NULLIF(a->>'payer_user_id','')::uuid)
  THEN RAISE EXCEPTION 'routed_rakeback_sources_disagree_with_certificate' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_player_items VALUES(r.id,c.id,r.club_id,r.user_id,c.payer_kind,c.payer_user_id,c.rakeback_amount,c.rake_generated,c.display_rate,c.source_fingerprint,r.status);
 END LOOP;
 END IF;
 -- Missing periods are obligations too: every source player in this scope must
 -- have an admitted certificate, including zero-entitlement players.
 -- 20261003: when the set path admitted the book, _rr3_week_v4 holds exactly
 -- these rows (same predicate, read under this scope's week lock, which every
 -- accrual of the week shares), so they are not read a second time.
 PERFORM set_config('app.accounting_round3_plan_used',CASE WHEN v4_ok AND v_plan_used THEN 'on' ELSE '' END,true);
 IF (CASE WHEN v4_ok AND v_plan_used THEN EXISTS(SELECT 1 FROM pg_temp._rr3_plan_nonhouse rs
     WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  WHEN v4_ok THEN EXISTS(SELECT 1 FROM pg_temp._rr3_week_v4 rs
    WHERE COALESCE((rs.house_text)::boolean,false) IS FALSE
     AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club))
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id)) END)
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;
 SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(i.period_id,i.certificate_id,i.club_id,i.user_id,i.payer_kind,i.payer_user,i.owed,i.rake,i.rate,i.fingerprint) ORDER BY i.period_id),'[]'::jsonb)::text)
  INTO fingerprint FROM pg_temp._routed_player_items i;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 IF FOUND THEN
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN pg_temp._routed_player_items i ON i.period_id=a.obligation_id WHERE a.obligation_role='player'AND NOT smarter_private.existing_rakeback_transfer_complete('player',i.period_id)) OR previous.source_fingerprint<>fingerprint OR EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status<>'paid' OR NOT EXISTS(
   SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.user_id=i.user_id AND pp.club_id=i.club_id AND pp.status='paid' AND pp.payout_amount=i.owed AND(CASE WHEN i.payer_kind='split' THEN smarter_private.split_rakeback_payout_complete(pp.id,i.certificate_id) ELSE true END)))
  THEN RAISE EXCEPTION 'routed_rakeback_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 -- CHUNKED CLOSE (20261003, round 3 in batches): inside a chunked close attempt
 -- a period an earlier batch of THIS round paid is recognised by its own
 -- evidence and not paid again; outside one nothing is.
 v_batched:=COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_done(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_done;
 IF EXISTS(SELECT FROM pg_temp._routed_player_items i JOIN smarter_private.existing_rakeback_transfer_allocations a ON a.obligation_role='player'AND a.obligation_id=i.period_id WHERE NOT smarter_private.existing_rakeback_transfer_complete('player',i.period_id)) THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
 INSERT INTO pg_temp._routed_player_done SELECT i.period_id FROM pg_temp._routed_player_items i JOIN smarter_private.existing_rakeback_transfer_allocations a ON a.obligation_role='player'AND a.obligation_id=i.period_id WHERE smarter_private.existing_rakeback_transfer_complete('player',i.period_id);
 IF v_batched THEN
  INSERT INTO pg_temp._routed_player_done SELECT i.period_id FROM pg_temp._routed_player_items i
   WHERE i.status='paid' AND (SELECT count(*) FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id)=1
    AND EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.club_id=i.club_id AND pp.user_id=i.user_id
     AND pp.status='paid' AND pp.payout_amount=i.owed
     AND CASE WHEN i.payer_kind='split' THEN smarter_private.split_rakeback_payout_complete(pp.id,i.certificate_id) WHEN i.owed>0 THEN EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key='round3-period:v3:'||i.period_id::text
       AND l.amount=i.owed AND l.club_id=i.club_id AND l.to_type='player_wallet' AND l.to_entity_id=i.user_id AND l.category='rakeback'
       AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
       AND l.metadata->>'certificate_id'=i.certificate_id::text AND l.metadata->>'payout_id'=pp.id::text
       AND l.metadata->>'source_fingerprint' IS NOT DISTINCT FROM i.fingerprint) ELSE true END) ON CONFLICT DO NOTHING;
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_todo(LIKE pg_temp._routed_player_items) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_todo;
 INSERT INTO pg_temp._routed_player_todo SELECT i.* FROM pg_temp._routed_player_items i
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_done d WHERE d.period_id=i.period_id);
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_now(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_now;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_todo i WHERE i.status IS DISTINCT FROM 'pending'
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds sr WHERE sr.union_id=p_union_id AND sr.round_no=3
   AND sr.period_start<p_period_end AND sr.period_end>p_period_start AND (sr.amount>0 OR sr.payees>0 OR sr.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_rakeback_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 -- Discharge only owner-confirmed actual transfers AFTER the original whole
 -- source/certificate/refusal checks and BEFORE new wallet funding is planned.
 prior_saved_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 FOR prior_item IN SELECT i.* FROM pg_temp._routed_player_todo i JOIN smarter_private.existing_rakeback_transfer_instructions q
  ON q.club_id=i.club_id AND q.beneficiary_id=i.user_id AND q.period_start=p_period_start AND q.period_end=p_period_end WHERE 'player'=ANY(q.roles)
  ORDER BY i.club_id,i.user_id,i.period_id LOOP
  prior_plan:=smarter_private.apply_existing_rakeback_transfer(p_scope_kind,p_scope_id,p_period_start,p_period_end,'player',prior_item.club_id,prior_item.user_id,prior_item.period_id,prior_item.certificate_id);
  IF prior_plan IS NULL THEN RAISE EXCEPTION 'existing_transfer_expected_player_instruction_required';END IF;
  INSERT INTO pg_temp._routed_player_done VALUES(prior_item.period_id)ON CONFLICT DO NOTHING;
  DELETE FROM pg_temp._routed_player_todo WHERE period_id=prior_item.period_id;
  UPDATE pg_temp._routed_player_items SET status='paid'WHERE period_id=prior_item.period_id;
 END LOOP;
 PERFORM set_config('app.accounting_routing_context',COALESCE(prior_saved_context,''),true);
 -- RAKEBACK IS PAID FROM WHERE COMMISSION LANDS (20261022, Dan). A real agent
 -- pays its players from its agent wallet (agents.agent_wallet_balance), where
 -- its weekly commission is credited. A share the certificate records for the
 -- club owner, or for no agent, is paid from the club bank, never from the
 -- owner's wallet. The certificate's payer identity is unchanged.
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_funding(period_id uuid,payer_kind text,payer_user uuid,payer_entity uuid,owed numeric,club_id uuid,funded_from text,PRIMARY KEY(period_id,payer_kind,payer_entity)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_funding;
 INSERT INTO pg_temp._routed_player_funding SELECT i.period_id,fp.payer_kind,fp.payer_user,fp.payer_entity,fp.owed,i.club_id,
  CASE WHEN fp.payer_kind='club' OR fp.payer_user IS NULL OR fp.payer_user=owner_club.owner_id THEN 'club_treasury' ELSE 'agent_wallet' END
 FROM pg_temp._routed_player_todo i JOIN public.clubs owner_club ON owner_club.id=i.club_id
 CROSS JOIN LATERAL smarter_private.rakeback_certificate_payers(i.certificate_id)fp;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_todo i WHERE i.owed IS DISTINCT FROM(SELECT sum(fp.owed)FROM pg_temp._routed_player_funding fp WHERE fp.period_id=i.period_id))
 THEN RAISE EXCEPTION 'routed_rakeback_payer_funding_not_conserved' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_wallets;
 INSERT INTO pg_temp._routed_player_wallets(club_id,user_id,delta)
 SELECT club_id,user_id,sum(owed) FROM pg_temp._routed_player_todo GROUP BY club_id,user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_agent_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_agent_wallets;
 INSERT INTO pg_temp._routed_agent_wallets(club_id,user_id,delta)
 SELECT club_id,payer_user,-sum(owed) FROM pg_temp._routed_player_funding WHERE funded_from='agent_wallet' GROUP BY club_id,payer_user;
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_todo) ORDER BY id FOR NO KEY UPDATE;
 FOR r IN SELECT i.* FROM pg_temp._routed_player_todo i WHERE i.owed>0
  AND NOT EXISTS(SELECT FROM public.club_members cm WHERE cm.club_id=i.club_id AND cm.user_id=i.user_id)
  ORDER BY i.club_id,i.user_id,i.period_id LOOP
  PERFORM smarter_private.preserve_historical_rakeback_wallet(r.period_id,r.certificate_id,p_period_start,p_period_end);
 END LOOP;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR NO KEY UPDATE OF cm;
 UPDATE pg_temp._routed_player_wallets w SET opening=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=w.club_id AND cm.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_account_missing_or_invalid' USING ERRCODE='23514'; END IF;
 PERFORM a.id FROM public.agents a JOIN pg_temp._routed_agent_wallets w ON w.club_id=a.club_id AND w.user_id=a.user_id
  ORDER BY a.club_id,a.user_id FOR NO KEY UPDATE OF a;
 UPDATE pg_temp._routed_agent_wallets w SET opening=a.agent_wallet_balance FROM public.agents a WHERE a.club_id=w.club_id AND a.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_agent_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_agent_wallet_missing_or_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_funding WHERE funded_from='agent_wallet' GROUP BY club_id,payer_user) x
  JOIN pg_temp._routed_agent_wallets w ON w.club_id=x.club_id AND w.user_id=x.payer_user WHERE w.opening<x.owed)
 THEN RAISE EXCEPTION 'routed_rakeback_agent_funding_shortfall' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_funding WHERE funded_from='club_treasury' GROUP BY club_id) x
  LEFT JOIN public.clubs bank ON bank.id=x.club_id WHERE bank.chip_treasury IS NULL OR bank.chip_treasury<x.owed
   OR bank.chip_treasury<>round(bank.chip_treasury,2) OR bank.chip_treasury::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 deleted_deferral:=current_setting('app.deleted_wallet_routing_stage',true);
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);agent_skip:=current_setting('app.ledger_autoskip_agents',true);
 maintenance:=current_setting('app.ledger_maintenance',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.deleted_wallet_routing_stage','rakeback',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);PERFORM set_config('app.ledger_autoskip_agents','1',true);
 v_stop:=clock_timestamp()+interval '90 seconds';
 FOR r IN SELECT * FROM pg_temp._routed_player_todo ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
  amount:=r.owed;
  INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.user_id,r.rake,round(r.rate*100,2),amount,'paid',now()) RETURNING id INTO payout_id;
  IF amount>0 THEN
   FOR g IN SELECT * FROM pg_temp._routed_player_funding WHERE period_id=r.period_id ORDER BY payer_kind,payer_entity LOOP
    amount:=g.owed;
    IF amount=0 THEN CONTINUE; END IF;
   SELECT chip_balance INTO player_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
   IF g.funded_from='club_treasury' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-amount WHERE id=r.club_id AND chip_treasury>=amount RETURNING chip_treasury INTO payer_after;
   ELSE
    SELECT agent_wallet_balance INTO payer_before FROM public.agents WHERE club_id=r.club_id AND user_id=g.payer_user;
    UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-amount,updated_at=now() WHERE club_id=r.club_id AND user_id=g.payer_user AND agent_wallet_balance>=amount RETURNING agent_wallet_balance INTO payer_after;
   END IF;
   UPDATE public.club_members SET chip_balance=chip_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO player_after;
   IF payer_after IS NULL OR player_after IS NULL OR payer_before-payer_after<>amount OR player_after-player_before<>amount
   THEN RAISE EXCEPTION 'routed_rakeback_transfer_not_conserved' USING ERRCODE='23514'; END IF;
   -- A debit of an agent wallet or the club bank is journalled by its leg below.
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.user_id,'PLAYER','credit',amount,'rakeback','Weekly rakeback received under recorded agreement',player_after,payout_id) RETURNING id INTO wallet_id;
   IF r.payer_kind<>'split' THEN
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   END IF;
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
    VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN g.funded_from='club_treasury' THEN 'club_treasury' ELSE 'agent_wallet' END,
     CASE WHEN g.funded_from='club_treasury' THEN r.club_id ELSE g.payer_user END,'player_wallet',r.user_id,amount,'rakeback',r.club_id,p_union_id,'Weekly rakeback from certified historical payer',
     'round3-period:v3:'||r.period_id::text||CASE WHEN r.payer_kind='split' THEN ':payer:'||g.payer_kind||':'||g.payer_entity::text ELSE '' END,jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_id',r.period_id,'period_start',p_period_start,'period_end',p_period_end,
       'certificate_id',r.certificate_id,'source_fingerprint',r.fingerprint,'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer','player',
       'paid_from',g.funded_from,'owner_share_payer',CASE WHEN g.payer_kind='agent' AND g.funded_from='club_treasury' THEN g.payer_user END),
      payer_before,payer_after,player_before,player_after) RETURNING id INTO ledger_id;
   IF r.payer_kind='split' THEN
    INSERT INTO public.accounting_rakeback_payer_transfers(payout_id,calculation_id,period_id,payer_kind,payer_entity_id,amount,ledger_id,wallet_transaction_id)
    VALUES(payout_id,r.certificate_id,r.period_id,g.payer_kind,g.payer_entity,amount,ledger_id,wallet_id);
   END IF;
   SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
    AND i.chips_transferred AND i.message_sent AND i.net_amount=amount AND i.gross_amount=amount AND i.deductions=0;
   IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_rakeback_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   END LOOP;
   paid:=paid+r.owed;payees:=payees+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
  INSERT INTO pg_temp._routed_player_now VALUES(r.period_id);
  IF v_batched AND clock_timestamp()>v_stop THEN EXIT; END IF;
 END LOOP;
 SELECT count(*) INTO v_remaining FROM pg_temp._routed_player_todo t WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_now n WHERE n.period_id=t.period_id);
 IF v_remaining>0 THEN
  -- A batch: every locked wallet must hold exactly what this batch paid it.
  UPDATE pg_temp._routed_player_wallets w SET delta=COALESCE((SELECT sum(x.delta) FROM(
   SELECT t.club_id,t.user_id,t.owed AS delta FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id
   ) x
   WHERE x.club_id=w.club_id AND x.user_id=w.user_id),0);
  UPDATE pg_temp._routed_agent_wallets w SET delta=-COALESCE((SELECT sum(t.owed) FROM pg_temp._routed_player_funding t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id
   WHERE t.funded_from='agent_wallet' AND t.club_id=w.club_id AND t.payer_user=w.user_id),0);
 END IF;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);PERFORM set_config('app.ledger_autoskip_agents',COALESCE(agent_skip,''),true);
 PERFORM set_config('app.deleted_wallet_routing_stage',COALESCE(deleted_deferral,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets w JOIN public.club_members cm ON cm.club_id=w.club_id AND cm.user_id=w.user_id
   WHERE cm.chip_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_agent_wallets w LEFT JOIN public.agents a ON a.club_id=w.club_id AND a.user_id=w.user_id
   WHERE a.agent_wallet_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_agent_wallet_incorrect' USING ERRCODE='23514'; END IF;
 -- All original transfer, invoice and net-wallet checks above still decide
 -- whether this stage may finish. Return only free net chips afterward,
 -- retaining published unpaid player obligations across bounded chunks.
 FOR v_deleted IN
  SELECT cm.club_id,cm.user_id FROM public.club_members cm
  JOIN public.profiles dp ON dp.id=cm.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_player_wallets w WHERE w.club_id=cm.club_id AND w.user_id=cm.user_id) AND EXISTS(SELECT FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now done ON done.period_id=t.period_id WHERE t.club_id=cm.club_id AND t.user_id=cm.user_id) ORDER BY cm.club_id,cm.user_id
 LOOP
  SELECT cm.chip_balance,coalesce(cm.held_chips,0),coalesce(cm.locked_chips,0)
   INTO STRICT v_deleted_before,v_deleted_held,v_deleted_locked FROM public.club_members cm
   WHERE cm.club_id=v_deleted.club_id AND cm.user_id=v_deleted.user_id;
  SELECT dwr_bank.chip_treasury INTO STRICT v_deleted_bank FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id;
  v_deleted_return:=public.fn_ca_deleted_wallet_bank_return(v_deleted.club_id,v_deleted.user_id,'player_wallet');
  IF v_deleted_return->'success' IS DISTINCT FROM 'true'::jsonb
   OR v_deleted_return->>'reserved_rakeback' IS NULL OR (v_deleted_return->>'reserved_rakeback')::numeric<0
   OR (v_deleted_return->>'reserved_rakeback')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (v_deleted_return->>'amount')::numeric IS DISTINCT FROM greatest(v_deleted_before-v_deleted_held-v_deleted_locked-(v_deleted_return->>'reserved_rakeback')::numeric,0)
   OR (v_deleted_return->>'player_chips')::numeric IS DISTINCT FROM (v_deleted_return->>'amount')::numeric
   OR (v_deleted_return->>'agent_chips')::numeric IS DISTINCT FROM 0::numeric
   OR NOT EXISTS(SELECT FROM public.club_members cm WHERE cm.club_id=v_deleted.club_id AND cm.user_id=v_deleted.user_id
     AND cm.chip_balance=v_deleted_before-(v_deleted_return->>'amount')::numeric
     AND coalesce(cm.held_chips,0)=v_deleted_held AND coalesce(cm.locked_chips,0)=v_deleted_locked)
   OR NOT EXISTS(SELECT FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id AND dwr_bank.chip_treasury=v_deleted_bank+(v_deleted_return->>'amount')::numeric)
  THEN RAISE EXCEPTION 'deleted_weekly_net_bank_return_not_conserved' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOR v_deleted IN
  SELECT a.club_id,a.user_id FROM public.agents a
  JOIN public.profiles dp ON dp.id=a.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_agent_wallets w WHERE w.club_id=a.club_id AND w.user_id=a.user_id)
   AND EXISTS(SELECT FROM pg_temp._routed_player_funding f JOIN pg_temp._routed_player_now done ON done.period_id=f.period_id
    WHERE f.club_id=a.club_id AND f.funded_from='agent_wallet' AND f.payer_user=a.user_id) ORDER BY a.club_id,a.user_id
 LOOP
  SELECT a.agent_wallet_balance INTO STRICT v_deleted_before FROM public.agents a
   WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id;
  SELECT dwr_bank.chip_treasury INTO STRICT v_deleted_bank FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id;
  v_deleted_return:=public.fn_ca_deleted_wallet_bank_return(v_deleted.club_id,v_deleted.user_id,'agent_wallet');
  IF v_deleted_return->'success' IS DISTINCT FROM 'true'::jsonb
   OR v_deleted_return->>'reserved_rakeback' IS NULL OR (v_deleted_return->>'reserved_rakeback')::numeric<0
   OR (v_deleted_return->>'reserved_rakeback')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (v_deleted_return->>'amount')::numeric IS DISTINCT FROM greatest(v_deleted_before-(v_deleted_return->>'reserved_rakeback')::numeric,0)
   OR (v_deleted_return->>'agent_chips')::numeric IS DISTINCT FROM (v_deleted_return->>'amount')::numeric
   OR (v_deleted_return->>'player_chips')::numeric IS DISTINCT FROM 0::numeric
   OR NOT EXISTS(SELECT FROM public.agents a WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id
     AND a.agent_wallet_balance=v_deleted_before-(v_deleted_return->>'amount')::numeric)
   OR NOT EXISTS(SELECT FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id AND dwr_bank.chip_treasury=v_deleted_bank+(v_deleted_return->>'amount')::numeric)
  THEN RAISE EXCEPTION 'deleted_weekly_net_bank_return_not_conserved' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);

 IF v_remaining>0 THEN
  RETURN jsonb_build_object('success',false,'batch_committed',true,'round',3,'routing_version',3,'source_version',2,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
   'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'paid_periods',(SELECT count(*) FROM pg_temp._routed_player_done)+(SELECT count(*) FROM pg_temp._routed_player_now),
   'remaining',v_remaining,'source_fingerprint',fingerprint,'plan_used',v_plan_used);
 END IF;
 -- The round's totals include what earlier batches of it paid.
 SELECT COALESCE(sum(i.owed),0),count(*) INTO v_paid_before,v_payees_before FROM pg_temp._routed_player_items i
  JOIN pg_temp._routed_player_done d ON d.period_id=i.period_id WHERE i.owed>0;
 paid:=paid+v_paid_before;payees:=payees+v_payees_before;
 result:=jsonb_build_object('success',true,'round',3,'name','certified_payer_to_players','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'amount',paid,'payees',payees,'shortfalls',0,'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'detail','[]'::jsonb);
 result:=result||jsonb_build_object('existing_transfer_economic_plan',smarter_private.existing_rakeback_transfer_scope_economic_plan(p_scope_kind,p_scope_id,p_period_start,p_period_end,'player'),
  'existing_transfer_receipts',smarter_private.existing_rakeback_transfer_scope_receipts(p_scope_kind,p_scope_id,p_period_start,p_period_end,'player'));
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(p_union_id,standalone_club,p_period_start,p_period_end,3,fingerprint,result);
 RETURN result;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_settlement_correctness_check()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; n integer := 0;
BEGIN
  -- B. Cross-club direct postings (last 60 min)
  FOR r IN
    SELECT l.id, l.from_type, l.from_entity_id, l.to_type, l.to_entity_id, l.amount, l.category
    FROM public.chip_ledger l
    WHERE l.created_at > now() - interval '60 minutes'
      AND l.from_type IN ('club_treasury','club_wallet')
      AND l.to_type   IN ('club_treasury','club_wallet')
      AND l.from_entity_id IS DISTINCT FROM l.to_entity_id
      AND l.category NOT IN ('treasury_transfer','pnl_settlement','horse_funding','correction')
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:cross_club', 'cross_club_posting', 'warning',
      'cross-club:' || COALESCE(r.from_entity_id::text,'?') || ':' || COALESCE(r.to_entity_id::text,'?'),
      r.amount, NULL, NULL, 'ledger', 'chip_ledger', NULL,
      r.from_entity_id, NULL, NULL, NULL, NULL, NULL, NULL, ARRAY[r.id],
      'chips moved directly between two different clubs (' || r.category || ', '
        || r.from_type || '→' || r.to_type || ') outside the allowed cross-club categories',
      NULL, jsonb_build_object('ledger_row', r.id, 'category', r.category));
    n := n + 1;
  END LOOP;

  -- C1. Rakeback over-attribution (last 24 h)
  FOR r IN
    WITH attributed AS MATERIALIZED (
      SELECT rr.id AS record_id, rr.club_id, rr.rake_amount, round(sum(ra.rake_amount),2) AS attributed
      FROM public.rake_records rr
      JOIN public.rake_attributions ra ON ra.rake_record_id = rr.id
      WHERE rr.created_at > now() - interval '24 hours'
      GROUP BY rr.id, rr.club_id, rr.rake_amount
      HAVING round(sum(ra.rake_amount),2) > round(rr.rake_amount,2) + 0.01
    )
    SELECT * FROM attributed LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'incorrect_rakeback', 'warning',
      'rakeback-overattr:' || r.record_id::text,
      round(r.attributed - r.rake_amount, 2), r.rake_amount, r.attributed,
      'reporting', 'rake_attributions', r.record_id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'rake attributions exceed the rake actually collected for this record - the rakeback chain would over-accrue',
      NULL, jsonb_build_object('rake_record_id', r.record_id));
    n := n + 1;
  END LOOP;

  -- C2. Rakeback over-payout (paid more than the player contributed, last 7 d)
  FOR r IN
    SELECT p.id, p.club_id, p.user_id, p.payout_amount, p.user_rake_contribution
    FROM public.rakeback_period_payouts p
    WHERE p.status = 'paid' AND p.paid_at > now() - interval '7 days'
      AND p.payout_amount > COALESCE(p.user_rake_contribution, 0) + 0.01
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'incorrect_rakeback', 'critical',
      'rakeback-overpay:' || r.id::text,
      round(r.payout_amount - COALESCE(r.user_rake_contribution,0), 2),
      r.user_rake_contribution, r.payout_amount,
      'settlement', 'rakeback_period_payouts', r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a rakeback payout exceeds the player''s ENTIRE rake contribution - impossible under any percentage',
      NULL, jsonb_build_object('payout_id', r.id, 'user_id', r.user_id));
    n := n + 1;
  END LOOP;

  -- C3. Rakeback dual-write evidence gaps (last 7 d)
  /* A ZERO PAYOUT HAS NO MONEY SIDE TO POINT AT (2026-10-03). The routed
     and legacy rakeback stages write one 'paid' payout row per certified
     period, including a period whose rakeback rounds to 0.00 (0.08 of rake
     at 5% is 0.004), and move chips only when the amount is above zero. A
     0.00 row therefore never has a wallet transaction, and asking it for one
     filed a permanent evidence warning (period payout e7f0b9bc, 2026-10-02).
     Only a payout or transfer that moved chips owes an evidence pointer. */
  FOR r IN
    SELECT 'period_payout' AS src, p.id, p.club_id FROM public.rakeback_period_payouts p
     WHERE p.status = 'paid' AND p.paid_at > now() - interval '7 days' AND p.wallet_transaction_id IS NULL
       AND p.payout_amount > 0
       AND NOT EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='player'AND a.obligation_id=p.rakeback_period_id AND smarter_private.existing_rakeback_transfer_complete('player',p.rakeback_period_id))
       AND NOT EXISTS(SELECT 1 FROM(SELECT c.id,c.payer_kind FROM public.accounting_rakeback_period_calculations c
        WHERE c.period_id=p.rakeback_period_id ORDER BY c.id DESC LIMIT 1)cert
        WHERE cert.payer_kind='split' AND smarter_private.split_rakeback_payout_complete(p.id,cert.id))
    UNION ALL
    SELECT 'distribution', d.id, d.club_id FROM public.rakeback_distributions d
     WHERE d.status IN ('transferred','paid') AND d.transferred_at > now() - interval '7 days'
       AND d.chip_transfer_id IS NULL
       AND d.rakeback_amount > 0
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'reporting_mismatch', 'warning',
      'rakeback-evidence:' || r.src || ':' || r.id::text,
      0, NULL, NULL, 'reporting', 'rakeback_' || r.src, r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'rakeback marked paid/transferred with no linked wallet/chip transaction - the money side has no evidence pointer',
      NULL, jsonb_build_object('kind', r.src, 'row_id', r.id));
    n := n + 1;
  END LOOP;

  -- D. Ticket conservation
  FOR r IN
    SELECT t.id, t.club_id, t.status, t.value,
           CASE WHEN t.status='redeemed' AND t.redeemed_at IS NULL THEN 'redeemed_without_timestamp'
                WHEN t.status='cancelled' AND t.cancelled_at IS NULL THEN 'cancelled_without_timestamp'
                WHEN t.status NOT IN ('redeemed','cancelled') AND COALESCE(t.value,0) <= 0 THEN 'active_nonpositive_value'
           END AS why
    FROM public.tournament_tickets t
    WHERE (t.status='redeemed' AND t.redeemed_at IS NULL)
       OR (t.status='cancelled' AND t.cancelled_at IS NULL)
       OR (t.status NOT IN ('redeemed','cancelled') AND COALESCE(t.value,0) <= 0)
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:tickets', 'reporting_mismatch', 'warning',
      'ticket:' || r.id::text,
      COALESCE(r.value,0), NULL, NULL, 'reporting', 'tournament_tickets', r.id, r.club_id,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'ticket conservation violation: ' || r.why,
      NULL, jsonb_build_object('ticket_id', r.id, 'status', r.status, 'why', r.why));
    n := n + 1;
  END LOOP;

  -- E. Insurance pair-match (net must equal payout − premium; last 24 h)
  FOR r IN
    SELECT i.id, i.club_id, i.union_id, i.premium, i.payout, i.net_result
    FROM public.insurance_transactions i
    WHERE i.created_at > now() - interval '24 hours'
      AND round(COALESCE(i.payout,0) - COALESCE(i.premium,0), 2) <> round(COALESCE(i.net_result,0), 2)
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:insurance', 'reporting_mismatch', 'warning',
      'insurance-pair:' || r.id::text,
      round((COALESCE(r.payout,0) - COALESCE(r.premium,0)) - COALESCE(r.net_result,0), 2),
      round(COALESCE(r.payout,0) - COALESCE(r.premium,0), 2), r.net_result,
      'reporting', 'insurance_transactions', r.id, r.club_id, r.union_id,
      NULL, NULL, NULL, NULL, NULL, NULL,
      'insurance row does not pair: net_result must equal payout minus premium exactly',
      NULL, jsonb_build_object('insurance_id', r.id));
    n := n + 1;
  END LOOP;

  -- F. Ticket VALUE conservation (phase 2b): every redeemed/cancelled
  -- ticket must have exactly one credit receipt of exactly its value.
  FOR r IN
    SELECT t.id, t.club_id, t.value, t.status,
           (SELECT count(*) FROM public.chip_transactions ct
             /* A TICKET ENTRY IS AN ENTRY (2026-09-10): an entry-only ticket is
                redeemed by the entry door, whose receipt is
                tournament_ticket_entry; the cash door writes
                tournament_ticket_redeem. Both are the one receipt. */
             WHERE ct.transaction_type = ANY (CASE t.status WHEN 'redeemed'
                     THEN ARRAY['tournament_ticket_redeem','tournament_ticket_entry']
                     ELSE ARRAY['tournament_ticket_cancel'] END)
               AND ct.metadata->>'ticket_id' = t.id::text) AS receipts,
           (SELECT COALESCE(sum(ct.amount),0) FROM public.chip_transactions ct
             /* A TICKET ENTRY IS AN ENTRY (2026-09-10): an entry-only ticket is
                redeemed by the entry door, whose receipt is
                tournament_ticket_entry; the cash door writes
                tournament_ticket_redeem. Both are the one receipt. */
             WHERE ct.transaction_type = ANY (CASE t.status WHEN 'redeemed'
                     THEN ARRAY['tournament_ticket_redeem','tournament_ticket_entry']
                     ELSE ARRAY['tournament_ticket_cancel'] END)
               AND ct.metadata->>'ticket_id' = t.id::text) AS receipt_value
    FROM public.tournament_tickets t
    WHERE t.status IN ('redeemed','cancelled')
      AND COALESCE(t.redeemed_at, t.cancelled_at) > now() - interval '24 hours'
    LIMIT 50
  LOOP
    IF r.receipts <> 1 OR round(r.receipt_value,2) <> round(r.value,2) THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settlement_correctness_check:ticket_value', 'reporting_mismatch', 'warning',
        'ticket-value:' || r.id::text,
        round(r.receipt_value - r.value, 2), r.value, r.receipt_value,
        'settlement', 'tournament_tickets', r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'ticket value conservation broken: ' || r.status || ' ticket worth ' || r.value
          || ' has ' || r.receipts || ' receipt(s) totalling ' || r.receipt_value,
        NULL, jsonb_build_object('ticket_id', r.id));
      n := n + 1;
    END IF;
  END LOOP;

  -- G. All-player atomic coverage: both windows count the same hand identities.
  -- The common commit receipt covers ordinary and diamond hands. The existing
  -- claims metadata keys remain compatible, and now mean matched receipts.
  DECLARE
    v_hands_24h bigint; v_claims_24h bigint; v_hands_1h bigint; v_claims_1h bigint;
  BEGIN
    /* THE HOUR FIRST, THE DAY ONLY WHEN THE HOUR ACCUSES (2026-10-03).
       An incident needs BOTH the 24-hour adoption gate and the 1-hour
       shortfall. Reading the day first materialised ~885,000 hands and as
       many receipts every hour and was cancelled in 3 of 6 runs. The hour is
       read alone (the same hands: created_at > now() - 60 min is inside the
       24 h set, and a receipt that matches a hand's hand_number is inside the
       set's hand_number range by construction; hand_atomic_commits.hand_id is
       unique, so the join cannot duplicate). The day is read, exactly as
       before, only when the hour would fire; otherwise its counts stay NULL
       and the gate below is false, which is the verdict the hour already
       gave. Measured: 17.3 s for the hour on production. */
    SELECT count(*), count(c.hand_id)
      INTO v_hands_1h, v_claims_1h
      FROM public.hand_history h
      LEFT JOIN public.hand_atomic_commits c
        ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number
     WHERE h.created_at>now()-interval '60 minutes';
    IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
      WITH recent AS MATERIALIZED (
        SELECT id,table_id,hand_number,created_at
        FROM public.hand_history WHERE created_at>now()-interval '24 hours'
      ), receipts AS MATERIALIZED (
        SELECT hand_id,table_id,hand_number FROM public.hand_atomic_commits
        WHERE hand_number BETWEEN (SELECT min(hand_number) FROM recent)
                              AND (SELECT max(hand_number) FROM recent)
      )
      SELECT count(*) AS hands_24h,count(c.hand_id) AS commits_24h
      INTO v_hands_24h,v_claims_24h
      FROM recent h LEFT JOIN receipts c
       ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number;
    END IF;
    IF v_hands_24h > 100 AND v_claims_24h >= v_hands_24h / 2 THEN
      IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_settlement_correctness_check:fallback_regression', 'settlement_error', 'warning',
          'fallback-regression:' || to_char(now(), 'YYYY-MM-DD-HH24'),
          0, v_hands_1h, v_claims_1h, 'settlement', 'hand_atomic_commits',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          'atomic hand settlement coverage fell to ' || v_claims_1h || '/' || v_hands_1h
            || ' hands in the last hour after adoption - matching atomic hand receipts are missing',
          NULL, jsonb_build_object('claims_1h', v_claims_1h, 'hands_1h', v_hands_1h));
        n := n + 1;
      END IF;
    END IF;
  END;

  -- ═══════════════════════════════════════════════════════════════════════
  --  H. THE SETTLER'S WATERMARK IS THE UNION CASCADE'S GATE (2026-09-21)
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- fn_process_weekly_accounting_scope raises
  -- `weekly_rake_source_not_fully_accrued` when any cash rake record inside
  -- the week being settled still sits above
  -- daemon_state.rakeback_settler.high_water_mark. That refusal is correct and
  -- must stay - settling a week on a source that is not fully accrued posts an
  -- understated week. What was missing is that the CONDITION causing it was
  -- invisible.
  --
  -- Measured 2026-09-21T15:26:06Z: the watermark was 2026-09-21T14:34:09Z, 52
  -- minutes stale, with 985 rake_records above it, while
  -- engine.smarter.poker/health reported settlementStatus "ok" and
  -- blockedSettlementCount 0, and fn_settler_lag_check - which nothing in the
  -- codebase or the cron schedule ever called - returned healthy:true.
  --
  -- No new job, timer, watcher or repair loop: this hourly settlement
  -- correctness check already runs and already raises durable, deduped,
  -- escalatable incidents. It now also asks the settler probe, and the probe
  -- now knows what the settler's interval is and what the cascade needs.
  DECLARE
    v_settler jsonb;
    v_blocked boolean;
  BEGIN
    v_settler := public.fn_settler_lag_check();
    IF COALESCE((v_settler->>'healthy')::boolean, true) IS NOT TRUE THEN
      v_blocked := COALESCE((v_settler->>'week_settlement_blocked')::boolean, false);
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settlement_correctness_check:settler_lag', 'settlement_error',
        CASE WHEN v_blocked THEN 'critical' ELSE 'warning' END,
        'settler-lag:' || CASE WHEN v_blocked THEN 'blocking:' ELSE 'stalled:' END
          || to_char(now(), 'YYYY-MM-DD-HH24'),
        0, NULL, NULLIF(v_settler->>'backlog_rows','')::numeric,
        'settlement', 'daemon_state', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        CASE WHEN v_blocked THEN
          'the union weekly cascade WILL refuse this week: '
            || COALESCE(v_settler->>'week_unaccrued_rows','?')
            || ' cash rake record(s) inside the week now due to settle are still above the'
            || ' rakeback settler watermark (' || COALESCE(v_settler->>'cursor','?')
            || '). fn_process_weekly_accounting_scope raises'
            || ' weekly_rake_source_not_fully_accrued on exactly this state and settles nothing.'
        ELSE
          'the rakeback settler watermark has not advanced for '
            || COALESCE(v_settler->>'last_save_minutes_ago','?') || ' minute(s) while '
            || COALESCE(v_settler->>'backlog_rows','?') || ' rake record(s) wait above it.'
            || ' The settler interval is ' || COALESCE(v_settler->>'interval_minutes','?')
            || ' minutes, so the drain has skipped a cycle - and a watermark left behind the'
            || ' week end blocks the whole union settlement cascade.'
        END,
        NULL, v_settler);
      n := n + 1;
    END IF;
  END;

  RETURN n;
END $function$;
CREATE OR REPLACE FUNCTION public.ca_player_stats_financial_report(p_user uuid, p_club_id uuid DEFAULT NULL::uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'::text, p_asset text DEFAULT 'chips'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_days integer; v_tz text; v_from timestamptz; v_to timestamptz;
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_asset NOT IN ('chips','diamonds') THEN RAISE EXCEPTION 'unknown stats asset' USING ERRCODE='22023'; END IF;
  IF p_club_id IS NOT NULL THEN PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset); END IF;
  SELECT b.range_days,b.range_tz,b.from_at,b.to_at INTO v_days,v_tz,v_from,v_to
    FROM public.ca_stats_calendar_bounds(p_days,p_tz) b;
  RETURN (WITH eligible AS MATERIALIZED (
    SELECT DISTINCT c.id FROM public.club_members m JOIN public.clubs c ON c.id=m.club_id
    WHERE m.user_id=p_user AND m.status IN ('active','approved')
      AND coalesce(c.lifecycle_status,'active')<>'retired' AND coalesce(c.asset,'chips')=p_asset
      AND (p_club_id IS NULL OR c.id=p_club_id)
  ), tx AS MATERIALIZED (
    SELECT w.id,w.created_at,w.related_entity_id tournament_id,t.club_id,w.type,w.category,
      round(w.amount,2) amount,w.balance_after,w.description
    FROM public.wallet_transactions w JOIN public.tournaments t ON t.id=w.related_entity_id
    JOIN eligible e ON e.id=t.club_id
    WHERE w.user_id=p_user AND p_asset='chips'
      AND lower(w.category) IN ('tournament_buyin','rebuy','addon','refund','tournament_refund',
        'tournament_prize','tournament_winnings','tournament_cashout','bounty','ticket_issue',
        'ticket_redeem','correction','reversal','prize_reversal')
      AND (v_from IS NULL OR w.created_at>=v_from) AND (v_to IS NULL OR w.created_at<v_to)
  ), categories AS (
    SELECT lower(category) category,lower(type) direction,count(*)::integer entries,round(sum(amount),2) amount
    FROM tx GROUP BY 1,2
  ), tournament_totals AS (
    SELECT count(*)::integer journal_rows,
      round(coalesce(sum(amount) FILTER(WHERE lower(type)='debit'),0),2) debits,
      round(coalesce(sum(amount) FILTER(WHERE lower(type)='credit'),0),2) credits,
      round(coalesce(sum(CASE WHEN lower(type)='credit' THEN amount
        WHEN lower(type)='debit' THEN -amount ELSE 0 END),0),2) net
    FROM tx
  ), periods AS MATERIALIZED (
    SELECT r.id,r.club_id,r.period_start,r.period_end,r.rake_generated,r.rakeback_rate,
      coalesce(r.rakeback_amount,r.rakeback_earned,0) amount,r.status,r.paid_at,
      r.deferred_reason,r.deferred_at,r.defer_count
    FROM public.rakeback_periods r JOIN eligible e ON e.id=r.club_id
    WHERE r.user_id=p_user AND p_asset='chips'
      AND (v_from IS NULL OR r.period_end>=v_from) AND (v_to IS NULL OR r.period_start<v_to)
  ), payouts AS MATERIALIZED (
    SELECT p.id,p.rakeback_period_id,p.club_id,p.payout_amount,p.currency,p.status,p.paid_at,
      p.wallet_transaction_id,p.failure_reason,p.created_at,
      smarter_private.existing_rakeback_transfer_player_receipt(p.rakeback_period_id)AS existing_transfer_discharge,
      coalesce((SELECT jsonb_agg(jsonb_build_object('wallet_transaction_id',t.wallet_transaction_id,'amount',t.amount)ORDER BY t.payer_kind,t.payer_entity_id)
       FROM public.accounting_rakeback_payer_transfers t WHERE t.payout_id=p.id AND t.period_id=p.rakeback_period_id),'[]'::jsonb) AS wallet_transactions
    FROM public.rakeback_period_payouts p JOIN eligible e ON e.id=p.club_id
    WHERE p.user_id=p_user AND p_asset='chips'
      AND (v_from IS NULL OR coalesce(p.paid_at,p.created_at)>=v_from)
      AND (v_to IS NULL OR coalesce(p.paid_at,p.created_at)<v_to)
  ) SELECT jsonb_build_object('contract_version',2,'scope',jsonb_build_object(
      'target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,'range_days',v_days,
      'range_tz',v_tz,'visibility','owner'),'generated_at',now(),
    'availability',jsonb_build_object(
      'tournament_wallet',p_asset='chips','rakeback',p_asset='chips',
      'bankroll_ledger',false,'bankroll_reason','no_club_scoped_authoritative_player_balance_series',
      'cash_sessions',false,'cash_sessions_reason','session_identity_has_no_final_stack_or_hand_foreign_key'),
    'tournament_wallet',jsonb_build_object('source','wallet_transactions',
      'totals',(SELECT to_jsonb(tournament_totals) FROM tournament_totals),
      'categories',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY category,direction) FROM categories c),'[]'::jsonb),
      'entries',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY created_at DESC,id DESC) FROM
        (SELECT * FROM tx ORDER BY created_at DESC,id DESC LIMIT 250) x),'[]'::jsonb),
      'capped',(SELECT count(*)>250 FROM tx)),
    'rakeback',jsonb_build_object('source','rakeback_periods+rakeback_period_payouts',
      'pending_amount',coalesce((SELECT round(sum(amount),2) FROM periods WHERE status='pending'),0),
      'paid_amount',coalesce((SELECT round(sum(payout_amount),2) FROM payouts WHERE status='paid'),0),
      'periods',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY period_end DESC,id DESC) FROM periods p),'[]'::jsonb),
      'payout_receipts',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY coalesce(paid_at,created_at) DESC,id DESC) FROM payouts p),'[]'::jsonb)),
    'bankroll',jsonb_build_object('available',false,'series','[]'::jsonb),
    'cash_sessions',jsonb_build_object('available',false,'sessions','[]'::jsonb)));
END;$function$;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_settlement_correctness_check','migration 20261027034254_existing_player_transfers_discharge_the_same_week_once');
DO $postimage$ BEGIN
 IF md5(pg_get_functiondef('public.ca_player_stats_financial_report(uuid,uuid,integer,text,text)'::regprocedure)) IS DISTINCT FROM '79d56064bddddd2025c17310127a62e5'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: ca_player_stats_financial_report(uuid,uuid,integer,text,text)';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure)) IS DISTINCT FROM 'aff58a0089c75f8e152e77e9d96fb7c8'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: fn_ca_settlement_correctness_check()';END IF;
 IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '9742b2ff89b72cf4d9f77f6db085af3e'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)';END IF;
 IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '1d9bcaa16d4bb9ae26eeb172fe7c3535'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)';END IF;
 IF md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '38e8a0bf0b309b973391107e3bd934d0'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)';END IF;
 IF md5(pg_get_functiondef('smarter_private.apply_existing_rakeback_transfer(text,uuid,timestamp with time zone,timestamp with time zone,text,uuid,uuid,uuid,bigint)'::regprocedure)) IS DISTINCT FROM '4e9f2af239d76039367c6cd7864754b3'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: smarter_private.apply_existing_rakeback_transfer(text,uuid,timestamp with time zone,timestamp with time zone,text,uuid,uuid,uuid,bigint)';END IF;
 IF md5(pg_get_functiondef('smarter_private.existing_rakeback_transfer_complete(text,uuid)'::regprocedure)) IS DISTINCT FROM '74956867ed71a467035dce0390cd47b3'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: smarter_private.existing_rakeback_transfer_complete(text,uuid)';END IF;
 IF md5(pg_get_functiondef('smarter_private.existing_rakeback_transfer_plan(uuid,uuid,timestamp with time zone,timestamp with time zone,text,uuid,bigint)'::regprocedure)) IS DISTINCT FROM '07067e8f2a841a8339d3bdde73a5f296'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: smarter_private.existing_rakeback_transfer_plan(uuid,uuid,timestamp with time zone,timestamp with time zone,text,uuid,bigint)';END IF;
 IF md5(pg_get_functiondef('smarter_private.existing_rakeback_transfer_player_receipt(uuid)'::regprocedure)) IS DISTINCT FROM '93080527dcbe86ffa904af596040833d'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: smarter_private.existing_rakeback_transfer_player_receipt(uuid)';END IF;
 IF md5(pg_get_functiondef('smarter_private.existing_rakeback_transfer_scope_economic_plan(text,uuid,timestamp with time zone,timestamp with time zone,text)'::regprocedure)) IS DISTINCT FROM '9a9eadead5e586774b86f7873fe1b08d'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: smarter_private.existing_rakeback_transfer_scope_economic_plan(text,uuid,timestamp with time zone,timestamp with time zone,text)';END IF;
 IF md5(pg_get_functiondef('smarter_private.existing_rakeback_transfer_scope_receipts(text,uuid,timestamp with time zone,timestamp with time zone,text)'::regprocedure)) IS DISTINCT FROM '5273b9b7ebda51abfd1fb57fff7a1278'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: smarter_private.existing_rakeback_transfer_scope_receipts(text,uuid,timestamp with time zone,timestamp with time zone,text)';END IF;
 IF md5(pg_get_functiondef('smarter_private.existing_transfer_discharge_guard()'::regprocedure)) IS DISTINCT FROM '73d2c61a7b46620acee2e23c85dc34a1'THEN RAISE EXCEPTION 'existing_transfer_postimage_changed: smarter_private.existing_transfer_discharge_guard()';END IF;
 IF EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='smarter_private'AND(p.proname LIKE'existing_rakeback_transfer_%'OR p.proname IN('apply_existing_rakeback_transfer','existing_transfer_discharge_guard'))AND(has_function_privilege('service_role',p.oid,'EXECUTE')OR has_function_privilege('authenticated',p.oid,'EXECUTE')OR has_function_privilege('anon',p.oid,'EXECUTE')))THEN RAISE EXCEPTION 'existing_transfer_private_function_exposed';END IF;
END $postimage$;
COMMIT;

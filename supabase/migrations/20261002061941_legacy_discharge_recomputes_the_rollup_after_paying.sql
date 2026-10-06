-- 20261002061941_legacy_discharge_recomputes_the_rollup_after_paying.sql
--
-- THE LEGACY DISCHARGE RECOMPUTES THE COMMISSION ROLLUP AFTER PAYING
--
-- 20261002025516 (payment of the certified week of 2026-09-14) was refused at
-- 2026-10-02 06:18Z with 40P01 deadlock "while inserting index tuple in
-- relation agent_commission_unsettled_rollup": the in-transaction rollup
-- recompute met a live commission insert recomputing the same agents in
-- another order. Rolled back whole; nothing paid (19aa02d6 still certified).
--
-- The rollup is a derived read model and moves no chips, so
-- fn_accounting_legacy_pay_week no longer recomputes it inside the payment;
-- 20261002062004 recomputes those agents in its own short transaction right
-- after. Nothing else in the function changes.
--
-- @live-proof: (SELECT position('fn_agent_commission_rollup_recompute' IN pg_get_functiondef('public.fn_accounting_legacy_pay_week(uuid)'::regprocedure)) = 0)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_accounting_legacy_pay_week(uuid)'::regprocedure)) <> '9a041e7414f194f3524eb8eaaaa79b2f' THEN
    RAISE EXCEPTION 'fn_accounting_legacy_pay_week is not the 20261002052506 preimage';
  END IF;
  IF (SELECT state FROM public.accounting_owner_legacy_operations WHERE operation_id = '19aa02d6-1023-441a-9979-3e65ceab6240') IS DISTINCT FROM 'certified' THEN
    RAISE EXCEPTION 'the week of 2026-09-14 is not certified and unpaid; this fix is for before its payment';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_accounting_legacy_pay_week(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
 op public.accounting_owner_legacy_operations%ROWTYPE; r record; sc record;
 v_from date; v_to date; v_ctx_union text; v_ctx text; v_members uuid[]; v_standalone uuid[];
 club_skip text; member_skip text; union_skip text; routing_context text; maintenance text; v_category text;
 payer_before numeric; payer_after numeric; payee_before numeric; payee_after numeric;
 payout_id uuid; wallet_id uuid; ledger_id uuid; v_credit jsonb; v_total numeric; v_rw_before numeric; v_rw_after numeric;
 v_shortfalls jsonb; v_settled bigint; v_settled_amount numeric; v_closed bigint; v_legs int:=0; v_amount numeric:=0;
 v_result jsonb; v_r1 numeric:=0; v_r2 numeric:=0; v_r3 numeric:=0; v_r2_legs int:=0; v_r3_payees int:=0; v_r3_periods int:=0;
 v_opening jsonb; v_fingerprint text; v_scope uuid;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF public.fn_platform_frozen() OR extract(minute FROM clock_timestamp())>=45 OR extract(minute FROM clock_timestamp())<4 THEN
  RAISE EXCEPTION 'legacy_discharge_outside_the_maintenance_window_only' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN
  RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 SELECT * INTO op FROM public.accounting_owner_legacy_operations WHERE operation_id=p_operation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'legacy_discharge_not_certified' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('owner-legacy-discharge:'||extract(epoch FROM op.period_start)::text,0));
 SELECT * INTO op FROM public.accounting_owner_legacy_operations WHERE operation_id=p_operation_id FOR UPDATE;
 IF op.state='paid' THEN RETURN op.result||jsonb_build_object('duplicate',true); END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_deferred_obligations d WHERE d.period_start=op.period_start AND d.period_end=op.period_end AND d.discharged_operation_id IS NOT NULL)
 THEN RAISE EXCEPTION 'legacy_discharge_already_discharged' USING ERRCODE='55000'; END IF;
 v_from:=(op.period_start AT TIME ZONE 'America/Los_Angeles')::date;
 v_to:=(op.period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 v_members:=ARRAY(SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=op.union_id AND uc.club_id<>op.union_id ORDER BY 1);
 v_standalone:=ARRAY(SELECT d.scope_id FROM public.accounting_deferred_obligations d WHERE d.period_start=op.period_start AND d.period_end=op.period_end AND d.scope_kind='club' ORDER BY 1);
 PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||op.union_id::text||':'||extract(epoch FROM op.period_start)::text||':'||extract(epoch FROM op.period_end)::text,0));
 FOR r IN SELECT unnest(v_standalone) AS club_id ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('club-accounting:'||r.club_id::text||':'||extract(epoch FROM op.period_start)::text||':'||extract(epoch FROM op.period_end)::text,0));
 END LOOP;
 -- No certified period may have been touched since certification.
 IF EXISTS(SELECT 1 FROM public.accounting_legacy_rakeback_certificates c JOIN public.rakeback_periods rp ON rp.id=c.period_id
   WHERE c.operation_id=op.operation_id AND (rp.status<>'pending' OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=rp.id)))
  OR EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs x WHERE x.period_start=op.period_start AND x.period_end=op.period_end
   AND (x.union_id=op.union_id OR x.standalone_club_id=ANY(v_standalone)))
 THEN RAISE EXCEPTION 'legacy_discharge_period_changed_after_certification' USING ERRCODE='55000'; END IF;

 -- Every account the operation moves, with its opening balance.
 CREATE TEMP TABLE _lp_acct(kind text,club_id uuid,user_id uuid,opening numeric,delta numeric NOT NULL DEFAULT 0,PRIMARY KEY(kind,club_id,user_id)) ON COMMIT DROP;
 INSERT INTO _lp_acct(kind,club_id,user_id) SELECT 'member',club_id,player_id FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id
  ON CONFLICT DO NOTHING;
 INSERT INTO _lp_acct(kind,club_id,user_id) SELECT 'member',club_id,payer_user_id FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id AND payer_kind='agent'
  ON CONFLICT DO NOTHING;
 INSERT INTO _lp_acct(kind,club_id,user_id) SELECT 'member',club_id,payee_id FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id AND round_no=2
  ON CONFLICT DO NOTHING;
 INSERT INTO _lp_acct(kind,club_id,user_id) SELECT 'member',club_id,payer_id FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id AND round_no=2 AND payer_kind='agent'
  ON CONFLICT DO NOTHING;
 INSERT INTO _lp_acct(kind,club_id,user_id) SELECT DISTINCT 'club',club_id,club_id FROM (
   SELECT club_id FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id
   UNION SELECT club_id FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id AND payer_kind='club') q
  ON CONFLICT DO NOTHING;
 INSERT INTO _lp_acct(kind,club_id,user_id) VALUES('union',op.union_id,op.union_id);
 -- Planned deltas.
 UPDATE _lp_acct a SET delta=a.delta+q.d FROM (SELECT q0.kind,q0.club_id,q0.user_id,sum(q0.d) AS d FROM (
   SELECT 'member' AS kind,club_id,player_id AS user_id,sum(rakeback_amount) AS d FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id GROUP BY 2,3
   UNION ALL SELECT 'member',club_id,payer_user_id,-sum(rakeback_amount) FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id AND payer_kind='agent' GROUP BY 2,3
   UNION ALL SELECT 'club',club_id,club_id,-sum(rakeback_amount) FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id AND payer_kind='club' GROUP BY 2,3
   UNION ALL SELECT 'union',op.union_id,op.union_id,-sum(rakeback_amount) FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id AND payer_kind='union'
   UNION ALL SELECT CASE WHEN payee_kind='club' THEN 'club' ELSE 'member' END,club_id,payee_id,sum(amount) FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id GROUP BY 1,2,3
   UNION ALL SELECT CASE payer_kind WHEN 'union' THEN 'union' WHEN 'club' THEN 'club' ELSE 'member' END,CASE WHEN payer_kind='union' THEN op.union_id ELSE club_id END,payer_id,-sum(amount)
    FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id GROUP BY 1,2,3) q0 WHERE q0.d IS NOT NULL GROUP BY 1,2,3) q
 WHERE a.kind=q.kind AND a.club_id=q.club_id AND a.user_id=q.user_id AND q.d IS NOT NULL;
 IF (SELECT sum(delta) FROM _lp_acct)<>0 THEN RAISE EXCEPTION 'legacy_discharge_plan_does_not_conserve' USING ERRCODE='23514'; END IF;

 -- The recorded commission rows this payment supersedes are settled the way
 -- the weekly commission stage settles them: one agent_commission_settlements
 -- row per (club, agent) for the period, which the unsettled rollup excludes.
 -- Every agent the payment pays and every agent with a recorded row of the
 -- week gets one, so no recorded row of the week is left owed. (Stamping
 -- settled_at on 1.8M rows outlasted the apply door: 2026-10-02 05:26Z.)
 IF op.mode='legacy_cascade' THEN
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<op.period_end AND cs.period_end>op.period_start
    AND (cs.union_id=op.union_id OR cs.club_id=op.union_id OR cs.club_id=ANY(v_standalone||v_members)))
  THEN RAISE EXCEPTION 'legacy_discharge_recorded_commissions_moved' USING ERRCODE='55000'; END IF;
  CREATE TEMP TABLE _lp_rec ON COMMIT DROP AS
   SELECT ac.club_id,ac.user_id,count(*)::int AS n,sum(ac.amount) AS amount FROM public.agent_commissions ac
    WHERE ac.created_at>=op.period_start AND ac.created_at<op.period_end AND ac.settled_at IS NULL
      AND ac.source_type IN('rake_settlement','cash_rake_accrual') AND (ac.club_id=op.union_id OR ac.club_id=ANY(v_standalone||v_members))
    GROUP BY 1,2;
  SELECT COALESCE(sum(n),0) INTO v_settled FROM _lp_rec;
  IF v_settled<>(op.certification->'recorded_commission_rows'->>'rows')::bigint
   OR (SELECT COALESCE(sum(amount),0) FROM _lp_rec)<>(op.certification->'recorded_commission_rows'->>'amount')::numeric THEN
   RAISE EXCEPTION 'legacy_discharge_recorded_commissions_moved' USING ERRCODE='55000'; END IF;
  INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT k.club_id,k.user_id,CASE WHEN k.club_id=ANY(v_standalone) THEN NULL ELSE op.union_id END,op.period_start,op.period_end,
   COALESCE((SELECT sum(l.own_amount) FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=op.operation_id AND l.round_no=2
     AND l.club_id=k.club_id AND l.payee_id=k.user_id),0),
   COALESCE((SELECT lr.n FROM _lp_rec lr WHERE lr.club_id=k.club_id AND lr.user_id=k.user_id),0),now(),'owner_legacy:'||op.operation_id::text
  FROM (SELECT club_id,user_id FROM _lp_rec UNION SELECT club_id,payee_id FROM public.accounting_legacy_settlement_legs
         WHERE operation_id=op.operation_id AND round_no=2) k;
  -- The unsettled rollup of these agents is recomputed by its own short
  -- transaction after this one commits (a recompute here deadlocked against a
  -- live commission insert on 2026-10-02 06:18Z); it moves no chips.
  IF EXISTS(SELECT 1 FROM _lp_rec lr WHERE NOT EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.settlement_ref='owner_legacy:'||op.operation_id::text
    AND cs.club_id=lr.club_id AND cs.user_id=lr.user_id)) THEN
   RAISE EXCEPTION 'legacy_discharge_recorded_commissions_moved' USING ERRCODE='55000'; END IF;
 END IF;

 -- Lock order: the union's rake treasury FIRST, then clubs, then member
 -- wallets. A union hand's settlement takes the union row before the member
 -- rows it pays, so taking the union row last deadlocked against live play on
 -- 2026-10-02 04:12Z (40P01, rolled back whole, nothing paid). A standalone
 -- club's treasury also receives live rake, so it is locked (and read) only
 -- when its own scope is paid, last. The union is still debited once, at the end.
 PERFORM 1 FROM public.union_wallets WHERE union_id=op.union_id FOR UPDATE;
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM _lp_acct WHERE kind='club' AND NOT club_id=ANY(v_standalone)) ORDER BY id FOR UPDATE;
 PERFORM cm.user_id FROM public.club_members cm JOIN _lp_acct a ON a.kind='member' AND a.club_id=cm.club_id AND a.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE _lp_acct a SET opening=cm.chip_balance FROM public.club_members cm WHERE a.kind='member' AND cm.club_id=a.club_id AND cm.user_id=a.user_id;
 UPDATE _lp_acct a SET opening=c.chip_treasury FROM public.clubs c WHERE a.kind='club' AND c.id=a.club_id;
 UPDATE _lp_acct a SET opening=w.rake_wallet FROM public.union_wallets w WHERE a.kind='union' AND w.union_id=a.club_id;
 IF EXISTS(SELECT 1 FROM _lp_acct WHERE opening IS NULL OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'legacy_discharge_account_missing_or_invalid' USING ERRCODE='23514',
  DETAIL=(SELECT jsonb_agg(jsonb_build_object('kind',kind,'club_id',club_id,'user_id',user_id)) FROM _lp_acct WHERE opening IS NULL)::text; END IF;
 -- Funding: every payer covers what it owes. Order within the operation is
 -- union -> clubs -> agents top down -> players, so a payer's receipts land
 -- before its payments; the final balance is the binding test.
 SELECT jsonb_agg(jsonb_build_object('kind',kind,'club_id',club_id,'user_id',user_id,'opening',opening,'net',delta,'shortfall',-(opening+delta)) ORDER BY kind,club_id,user_id)
  INTO v_shortfalls FROM _lp_acct WHERE opening+delta<0;
 IF v_shortfalls IS NOT NULL THEN RAISE EXCEPTION 'legacy_discharge_payer_shortfall' USING ERRCODE='23514',DETAIL=v_shortfalls::text; END IF;
 SELECT jsonb_agg(jsonb_build_object('kind',kind,'club_id',club_id,'user_id',user_id,'opening',opening,'delta',delta) ORDER BY kind,club_id,user_id) INTO v_opening FROM _lp_acct;

 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 union_skip:=current_setting('app.ledger_autoskip_union_wallets',true);routing_context:=current_setting('app.accounting_routing_context',true);
 maintenance:=current_setting('app.ledger_maintenance',true);v_category:=current_setting('app.ledger_category',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 PERFORM set_config('app.ledger_autoskip_union_wallets','1',true);
 v_ctx_union:=op.union_id::text||':'||op.period_start::text||':'||op.period_end::text;

 -- ROUND 1: the union rake treasury funds each member club (union_wallet -> club_treasury).
 FOR r IN SELECT * FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id AND round_no=1 ORDER BY club_id LOOP
  PERFORM public.fn_ca_declare_ledger('rakeback','union_wallet',op.union_id,NULL,NULL,ARRAY['union_wallets','clubs']);
  v_credit:=public.fn_credit_treasury(r.club_id,r.amount,'Owner-authorized legacy union rakeback '||to_char(op.period_start,'YYYY-MM-DD')||'..'||to_char(op.period_end,'YYYY-MM-DD'),
   jsonb_build_object('union_id',op.union_id,'period_start',op.period_start,'period_end',op.period_end,'legacy_operation_id',op.operation_id,'plan_leg_id',r.id),
   'owner_legacy:'||op.operation_id::text||':round1:'||r.club_id::text);
  IF COALESCE((v_credit->>'success')::boolean,false) IS NOT TRUE OR (v_credit->>'balance_after')::numeric-(v_credit->>'balance_before')::numeric<>r.amount THEN
   RAISE EXCEPTION 'legacy_discharge_round1_credit_failed' USING ERRCODE='23514',DETAIL=v_credit::text; END IF;
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,pre_to_balance,post_to_balance)
  VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),'union_wallet',op.union_id,'club_treasury',r.club_id,r.amount,'rakeback',r.club_id,op.union_id,
   'Owner-authorized legacy union rakeback from recorded cash earnings','owner_legacy:'||op.operation_id::text||':round1:'||r.club_id::text,
   jsonb_build_object('legacy_operation_id',op.operation_id,'certificate_kind','owner_legacy_v1','plan_leg_id',r.id,'period_start',op.period_start,'period_end',op.period_end,
    'rake_basis',r.measurement->'rake_in','rate',r.measurement->'rate'),
   (v_credit->>'balance_before')::numeric,(v_credit->>'balance_after')::numeric) RETURNING id INTO ledger_id;
  IF NOT EXISTS(SELECT 1 FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid' AND i.net_amount=r.amount AND i.chips_transferred AND i.message_sent
    AND EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id)) THEN
   RAISE EXCEPTION 'legacy_discharge_round1_receipt_missing' USING ERRCODE='23514'; END IF;
  v_r1:=v_r1+r.amount; v_legs:=v_legs+1;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 PERFORM set_config('app.ledger_autoskip_union_wallets','1',true);

 -- Rounds 2 and 3 per accounting scope: the union's scope first, then each
 -- standalone club, whose treasury is locked and read only at that point.
 FOREACH v_scope IN ARRAY (ARRAY[NULL::uuid]||v_standalone) LOOP
 IF v_scope IS NOT NULL THEN
  PERFORM id FROM public.clubs WHERE id=v_scope FOR UPDATE;
  UPDATE _lp_acct a SET opening=c.chip_treasury FROM public.clubs c WHERE a.kind='club' AND a.club_id=v_scope AND c.id=v_scope;
  IF EXISTS(SELECT 1 FROM _lp_acct WHERE kind='club' AND club_id=v_scope AND (opening IS NULL OR opening+delta<0)) THEN
   RAISE EXCEPTION 'legacy_discharge_payer_shortfall' USING ERRCODE='23514',
    DETAIL=(SELECT jsonb_agg(jsonb_build_object('kind',kind,'club_id',club_id,'opening',opening,'net',delta,'shortfall',-(opening+delta))) FROM _lp_acct WHERE kind='club' AND club_id=v_scope)::text; END IF;
 END IF;
 -- ROUND 2: clubs pay the recorded hierarchy, top down (club_treasury/player_wallet -> player_wallet).
 FOR r IN SELECT * FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id AND round_no=2
   AND ((v_scope IS NULL AND scope_kind='union') OR (v_scope IS NOT NULL AND scope_kind='club' AND club_id=v_scope)) ORDER BY sort_order,club_id,payer_kind DESC,payer_id,payee_id LOOP
  v_ctx:=CASE WHEN r.scope_kind='union' THEN v_ctx_union ELSE 'club:'||r.club_id::text||':'||op.period_start::text||':'||op.period_end::text END;
  PERFORM set_config('app.accounting_routing_context',v_ctx,true);
  SELECT chip_balance INTO payee_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payee_id;
  IF r.payer_kind='club' THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-r.amount WHERE id=r.club_id AND chip_treasury>=r.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payer_id;
   UPDATE public.club_members SET chip_balance=chip_balance-r.amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payer_id AND chip_balance>=r.amount RETURNING chip_balance INTO payer_after;
  END IF;
  UPDATE public.club_members SET chip_balance=chip_balance+r.amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payee_id RETURNING chip_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>r.amount OR payee_after-payee_before<>r.amount THEN
   RAISE EXCEPTION 'legacy_discharge_round2_transfer_not_conserved' USING ERRCODE='23514',DETAIL=jsonb_build_object('leg',r.id,'payer_before',payer_before)::text; END IF;
  IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(r.payer_id,'PLAYER','debit',r.amount,'commission','Recorded weekly commission budget passed to child agent (owner-authorized legacy week)',payer_after); END IF;
  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(r.payee_id,'PLAYER','credit',r.amount,'commission','Recorded weekly commission budget received (owner-authorized legacy week)',payee_after);
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN r.payer_kind='club' THEN 'club_treasury' ELSE 'player_wallet' END,r.payer_id,
   'player_wallet',r.payee_id,r.amount,'commission',r.club_id,CASE WHEN r.scope_kind='union' THEN op.union_id END,
   'Weekly commission through recorded earning hierarchy (owner-authorized legacy week)','owner_legacy:'||op.operation_id::text||':round2:'||r.club_id::text||':'||r.payer_id::text||':'||r.payee_id::text,
   jsonb_build_object('routing_version',3,'accounting_scope_kind',r.scope_kind,'accounting_scope_id',r.scope_id,'period_start',op.period_start,'period_end',op.period_end,
    'payee_role_at_transfer',r.payee_role,'own_commission',r.own_amount,'pass_through',r.payer_kind='agent','legacy_operation_id',op.operation_id,
    'certificate_kind','owner_legacy_v1','plan_leg_id',r.id),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  IF (SELECT count(*) FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid' AND i.chips_transferred AND i.message_sent
    AND i.net_amount=r.amount AND i.gross_amount=r.amount AND i.deductions=0)<>1 THEN
   RAISE EXCEPTION 'legacy_discharge_round2_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
  v_r2:=v_r2+CASE WHEN r.payer_kind='club' THEN r.amount ELSE 0 END; v_r2_legs:=v_r2_legs+1; v_legs:=v_legs+1;
 END LOOP;

 -- ROUND 3: each certified period to its payee (agent/club/union -> player_wallet).
 IF op.mode='union_direct' THEN
  PERFORM public.fn_ca_declare_ledger('rakeback','union_wallet',op.union_id,NULL,NULL,ARRAY['union_wallets','club_members']);
 END IF;
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 PERFORM set_config('app.ledger_autoskip_union_wallets','1',true);
 FOR r IN SELECT c.*,rp.club_id AS period_club_id FROM public.accounting_legacy_rakeback_certificates c JOIN public.rakeback_periods rp ON rp.id=c.period_id
   WHERE c.operation_id=op.operation_id
     AND ((v_scope IS NULL AND (c.payer_kind='union' OR c.club_id=ANY(v_members) OR c.club_id=op.union_id))
       OR (v_scope IS NOT NULL AND c.club_id=v_scope AND c.payer_kind<>'union')) ORDER BY c.club_id,c.payer_user_id NULLS FIRST,c.player_id,c.period_id LOOP
  -- The scope a disputing player is shown the payment under.
  IF r.payer_kind='union' OR r.club_id=ANY(v_members) OR r.club_id=op.union_id THEN
   v_ctx:=v_ctx_union;
  ELSE
   v_ctx:='club:'||r.club_id::text||':'||op.period_start::text||':'||op.period_end::text;
  END IF;
  PERFORM set_config('app.accounting_routing_context',v_ctx,true);
  INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.player_id,r.rake_generated,round(r.display_rate*100,2),r.rakeback_amount,'paid',now()) RETURNING id INTO payout_id;
  IF r.rakeback_amount>0 THEN
   SELECT chip_balance INTO payee_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.player_id;
   IF r.payer_kind='club' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-r.rakeback_amount WHERE id=r.club_id AND chip_treasury>=r.rakeback_amount RETURNING chip_treasury INTO payer_after;
   ELSIF r.payer_kind='agent' THEN
    SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payer_user_id;
    UPDATE public.club_members SET chip_balance=chip_balance-r.rakeback_amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payer_user_id AND chip_balance>=r.rakeback_amount RETURNING chip_balance INTO payer_after;
   ELSE
    -- The union's rake treasury is debited once, after every leg, so the row
    -- the engine writes rake to is held only for the final statement.
    payer_before:=NULL; payer_after:=NULL;
   END IF;
   UPDATE public.club_members SET chip_balance=chip_balance+r.rakeback_amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.player_id RETURNING chip_balance INTO payee_after;
   IF payee_after IS NULL OR payee_after-payee_before<>r.rakeback_amount
    OR (r.payer_kind<>'union' AND (payer_after IS NULL OR payer_before-payer_after<>r.rakeback_amount)) THEN
    RAISE EXCEPTION 'legacy_discharge_round3_transfer_not_conserved' USING ERRCODE='23514',DETAIL=r.period_id::text; END IF;
   IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.payer_user_id,'PLAYER','debit',r.rakeback_amount,'rakeback','Weekly rakeback paid under recorded agreement (owner-authorized legacy week)',payer_after,payout_id); END IF;
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.player_id,'PLAYER','credit',r.rakeback_amount,'rakeback',
     CASE WHEN r.payer_kind='union' THEN 'Weekly rakeback paid by the union (owner-authorized legacy week)' ELSE 'Weekly rakeback received under recorded agreement (owner-authorized legacy week)' END,
     payee_after,payout_id) RETURNING id INTO wallet_id;
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
     pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    CASE r.payer_kind WHEN 'club' THEN 'club_treasury' WHEN 'agent' THEN 'player_wallet' ELSE 'union_wallet' END,r.payer_entity_id,
    'player_wallet',r.player_id,r.rakeback_amount,'rakeback',r.club_id,CASE WHEN v_ctx=v_ctx_union THEN op.union_id END,
    CASE WHEN r.payer_kind='union' THEN 'Weekly rakeback paid by the union from its rake treasury (owner-authorized legacy week)' ELSE 'Weekly rakeback from certified legacy payer (owner-authorized legacy week)' END,
    'owner_legacy:round3:'||r.period_id::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',CASE WHEN v_ctx=v_ctx_union THEN 'union' ELSE 'club' END,
     'accounting_scope_id',CASE WHEN v_ctx=v_ctx_union THEN op.union_id ELSE r.club_id END,'period_id',r.period_id,
     'period_start',op.period_start,'period_end',op.period_end,'certificate_id',r.id,'certificate_kind','owner_legacy_v1','legacy_operation_id',op.operation_id,
     'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer','player','recorded_period_club_id',r.period_club_id),
    payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
   IF (SELECT count(*) FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
     AND i.chips_transferred AND i.message_sent AND i.net_amount=r.rakeback_amount AND i.gross_amount=r.rakeback_amount AND i.deductions=0)<>1 THEN
    RAISE EXCEPTION 'legacy_discharge_round3_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   v_r3:=v_r3+r.rakeback_amount; v_r3_payees:=v_r3_payees+1; v_legs:=v_legs+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'legacy_discharge_period_changed_after_certification' USING ERRCODE='55000'; END IF;
  v_r3_periods:=v_r3_periods+1;
 END LOOP;

 END LOOP;

 -- The union treasury: one debit for everything it paid in this operation.
 SELECT -COALESCE(delta,0) INTO v_total FROM _lp_acct WHERE kind='union';
 IF v_total>0 THEN
  SELECT rake_wallet INTO v_rw_before FROM public.union_wallets WHERE union_id=op.union_id FOR UPDATE;
  UPDATE public.union_wallets SET rake_wallet=rake_wallet-v_total,total_settlements=COALESCE(total_settlements,0)+v_r1,updated_at=now()
   WHERE union_id=op.union_id AND rake_wallet>=v_total RETURNING rake_wallet INTO v_rw_after;
  IF v_rw_after IS NULL OR v_rw_before-v_rw_after<>v_total THEN
   RAISE EXCEPTION 'legacy_discharge_payer_shortfall' USING ERRCODE='23514',
    DETAIL=jsonb_build_array(jsonb_build_object('kind','union','union_id',op.union_id,'opening',v_rw_before,'owed',v_total,'shortfall',v_total-v_rw_before))::text; END IF;
  INSERT INTO public.union_wallet_transactions(union_id,club_id,amount,tx_type,wallet,direction,balance_after,notes)
  SELECT op.union_id,x.club_id,x.amount,'rakeback','rake_wallet','debit',v_rw_before-sum(x.amount) OVER (ORDER BY x.ord),x.note FROM (
   SELECT 1 AS grp,l.club_id,l.amount,'Owner-authorized legacy weekly rakeback to club '||to_char(op.period_start,'YYYY-MM-DD')||'..'||to_char(op.period_end,'YYYY-MM-DD')||' (operation '||op.operation_id::text||')' AS note,
     row_number() OVER (ORDER BY l.club_id) AS ord FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=op.operation_id AND l.round_no=1
   UNION ALL SELECT 2,c.club_id,sum(c.rakeback_amount),'Owner-authorized union payment of deferred player rakeback '||to_char(op.period_start,'YYYY-MM-DD')||'..'||to_char(op.period_end,'YYYY-MM-DD')||' to members of this club (operation '||op.operation_id::text||')',
     1000+row_number() OVER (ORDER BY c.club_id)
    FROM public.accounting_legacy_rakeback_certificates c WHERE c.operation_id=op.operation_id AND c.payer_kind='union' AND c.rakeback_amount>0 GROUP BY c.club_id) x;
 END IF;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.ledger_autoskip_union_wallets',COALESCE(union_skip,''),true);PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 PERFORM set_config('app.ledger_category',COALESCE(v_category,''),true);PERFORM set_config('app.ledger_counterparty','',true);PERFORM set_config('app.ledger_counterparty_entity','',true);

 -- CONSERVATION, asserted on the balances themselves.
 IF EXISTS(SELECT 1 FROM _lp_acct a LEFT JOIN public.club_members cm ON a.kind='member' AND cm.club_id=a.club_id AND cm.user_id=a.user_id
   LEFT JOIN public.clubs cl ON a.kind='club' AND cl.id=a.club_id LEFT JOIN public.union_wallets w ON a.kind='union' AND w.union_id=a.club_id
   WHERE a.kind<>'union' AND COALESCE(cm.chip_balance,cl.chip_treasury) IS DISTINCT FROM a.opening+a.delta)
 THEN RAISE EXCEPTION 'legacy_discharge_final_balance_incorrect' USING ERRCODE='23514'; END IF;

 -- Run identity the payout legs are shown under (same run table, explicit source).
 v_fingerprint:=md5(op.certification::text);
 FOR sc IN SELECT DISTINCT CASE WHEN x.scope='union' THEN op.union_id END AS union_id, CASE WHEN x.scope='club' THEN x.club_id END AS club_id FROM (
    SELECT CASE WHEN payer_kind='union' OR club_id=ANY(v_members) OR club_id=op.union_id THEN 'union' ELSE 'club' END AS scope,club_id
     FROM public.accounting_legacy_rakeback_certificates WHERE operation_id=op.operation_id
    UNION SELECT scope_kind,club_id FROM public.accounting_legacy_settlement_legs WHERE operation_id=op.operation_id AND round_no=2) x LOOP
  IF EXISTS(SELECT 1 FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=op.operation_id AND l.round_no=2
     AND ((sc.union_id IS NOT NULL AND l.scope_kind='union') OR (sc.club_id IS NOT NULL AND l.scope_kind='club' AND l.club_id=sc.club_id))) THEN
   INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
   VALUES(sc.union_id,sc.club_id,op.period_start,op.period_end,2,v_fingerprint,jsonb_build_object('success',true,'round',2,'name','owner_legacy_recorded_commission_hierarchy',
    'routing_version',3,'source','owner_legacy_discharge_v1','legacy_operation_id',op.operation_id,'authorized_by',op.authorized_by,'shortfalls',0,
    'payees',(SELECT count(DISTINCT l.payee_id) FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=op.operation_id AND l.round_no=2
      AND ((sc.union_id IS NOT NULL AND l.scope_kind='union') OR (sc.club_id IS NOT NULL AND l.club_id=sc.club_id AND l.scope_kind='club'))),
    'amount',(SELECT COALESCE(sum(l.amount),0) FROM public.accounting_legacy_settlement_legs l WHERE l.operation_id=op.operation_id AND l.round_no=2 AND l.payer_kind='club'
      AND ((sc.union_id IS NOT NULL AND l.scope_kind='union') OR (sc.club_id IS NOT NULL AND l.club_id=sc.club_id AND l.scope_kind='club')))));
  END IF;
  INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(sc.union_id,sc.club_id,op.period_start,op.period_end,3,v_fingerprint,jsonb_build_object('success',true,'round',3,'name','owner_legacy_certified_payer_to_players',
   'routing_version',3,'source','owner_legacy_discharge_v1','legacy_operation_id',op.operation_id,'authorized_by',op.authorized_by,'shortfalls',0,
   'amount',(SELECT COALESCE(sum(x.rakeback_amount),0) FROM public.accounting_legacy_rakeback_certificates x WHERE x.operation_id=op.operation_id
     AND ((sc.union_id IS NOT NULL AND (x.payer_kind='union' OR x.club_id=ANY(v_members) OR x.club_id=op.union_id))
       OR (sc.club_id IS NOT NULL AND x.club_id=sc.club_id AND x.payer_kind<>'union')))));
 END LOOP;

 -- Recorded legacy rows superseded by the measured periods are closed, not deleted.
 IF op.mode='legacy_cascade' THEN
  UPDATE public.rakeback_periods rp SET status='closed',deferred_at=now(),
   deferred_reason='Superseded by owner-authorized operation '||op.operation_id::text||': this recorded row (rake '||rp.rake_generated::text||', rakeback '||rp.rakeback_amount::text
    ||') came from the stalled legacy daily writer and carries no measured cash payable in this club. The cash rakeback of the week was paid on its measured periods; any tournament-fee rakeback it included is outside the recorded obligation and was not paid by this operation.'
  WHERE rp.id IN(SELECT (x->>'period_id')::uuid FROM jsonb_array_elements(op.certification->'superseded') x) AND rp.status='pending';
  GET DIAGNOSTICS v_closed=ROW_COUNT;
  IF v_closed<>jsonb_array_length(op.certification->'superseded') THEN
   RAISE EXCEPTION 'legacy_discharge_superseded_rows_moved' USING ERRCODE='55000'; END IF;
 END IF;

 -- Discharge the record: never delete it. A certificate counts toward the
 -- obligation row of the scope its period was recorded under.
 WITH m AS (
  SELECT CASE WHEN q.s=op.union_id OR q.s=ANY(v_members) THEN 'union' ELSE 'club' END AS kind,
   CASE WHEN q.s=op.union_id OR q.s=ANY(v_members) THEN op.union_id ELSE q.s END AS id, q.amt
  FROM (SELECT CASE WHEN op.mode='union_direct' THEN rp.club_id ELSE x.club_id END AS s, x.rakeback_amount AS amt
   FROM public.accounting_legacy_rakeback_certificates x JOIN public.rakeback_periods rp ON rp.id=x.period_id WHERE x.operation_id=op.operation_id) q),
 agg AS (SELECT kind,id,count(*)::int AS periods,sum(amt) AS amount FROM m GROUP BY 1,2)
 UPDATE public.accounting_deferred_obligations d SET discharged_operation_id=op.operation_id,discharged_at=now(),
  discharged_amount=agg.amount,discharged_periods=agg.periods,
  discharge_note=CASE WHEN op.mode='union_direct' THEN
    'Paid by the union rake treasury under owner-authorized operation '||op.operation_id::text||' ('||op.authorized_by||'): each recorded pending period was paid to its payee with a receipt, Messenger record and notification, and closed. Recorded '||d.pending_amount::text||', paid '||agg.amount::text||'.'
   ELSE 'Paid through the legacy cascade (union -> clubs -> recorded hierarchy -> players) under owner-authorized operation '||op.operation_id::text||' ('||op.authorized_by||') on the measured cash basis. Recorded '||d.pending_amount::text||', paid '||agg.amount::text
    ||CASE WHEN agg.amount<>d.pending_amount THEN '; the difference of '||(d.pending_amount-agg.amount)::text||' arises because the recorded figure was rounded once over the whole scope while each payee is paid in whole cents, and, in a union scope, because the earning-club split of rake whose attribution rows hand retention removed after the 2026-09-21 measurement could not be re-read; no payee is invented for it' ELSE '' END||'.' END
 FROM agg WHERE d.period_start=op.period_start AND d.period_end=op.period_end AND d.scope_kind=agg.kind AND d.scope_id=agg.id AND d.discharged_operation_id IS NULL;
 IF EXISTS(SELECT 1 FROM public.accounting_deferred_obligations d WHERE d.period_start=op.period_start AND d.period_end=op.period_end AND d.discharged_operation_id IS NULL)
 THEN RAISE EXCEPTION 'legacy_discharge_obligation_not_discharged' USING ERRCODE='55000'; END IF;

 v_result:=jsonb_build_object('success',true,'legacy_operation_id',op.operation_id,'mode',op.mode,'period_start',op.period_start,'period_end',op.period_end,
  'round1_union_to_clubs',v_r1,'round2_club_direct',v_r2,'round2_legs',v_r2_legs,'round3_amount',v_r3,'round3_payees',v_r3_payees,'round3_periods',v_r3_periods,
  'legs',v_legs,'recorded_commission_rows_settled',v_settled,'superseded_periods_closed',v_closed,'union_rake_wallet_before',v_rw_before,'union_rake_wallet_after',v_rw_after,
  'accounts',v_opening);
 UPDATE public.accounting_owner_legacy_operations SET state='paid',paid_at=now(),result=v_result WHERE operation_id=op.operation_id;
 RETURN v_result-'accounts';
END $fn$;

REVOKE ALL ON FUNCTION public.fn_accounting_legacy_pay_week(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_legacy_pay_week(uuid) TO service_role;

DO $post$
DECLARE d text := pg_get_functiondef('public.fn_accounting_legacy_pay_week(uuid)'::regprocedure);
BEGIN
  IF position('PERFORM 1 FROM public.union_wallets WHERE union_id=op.union_id FOR UPDATE;' IN d) = 0
     OR position('PERFORM 1 FROM public.union_wallets WHERE union_id=op.union_id FOR UPDATE;' IN d) > position('PERFORM id FROM public.clubs WHERE id IN(' IN d)
     OR position('fn_agent_commission_rollup_recompute' IN d) > 0
     OR position('INSERT INTO public.agent_commission_settlements' IN d) = 0
     OR NOT has_function_privilege('service_role', 'public.fn_accounting_legacy_pay_week(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_accounting_legacy_pay_week(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_accounting_legacy_pay_week(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_accounting_legacy_pay_week readback failed';
  END IF;
END $post$;

COMMIT;

-- Independent fixed historical transfers; every value is prescribed here.
-- Original R2/R3 and invoice owners do the new settlement, not this fixture.
CREATE FUNCTION public.ed_send(label text,beneficiary text,amount numeric)RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE club uuid:=caw_u('club');sender uuid:=caw_u('O');payee uuid:=caw_u(beneficiary);
 op uuid:=caw_u('op-'||label);tx uuid:=caw_u('tx-'||label);leg uuid:=caw_u('ledger-'||label);before_agent numeric;after_agent numeric;before_player numeric;after_player numeric;
 stamp timestamptz:=now()-interval '1 day';
BEGIN
 SELECT agent_wallet_balance INTO before_agent FROM agents WHERE club_id=club AND user_id=sender;
 SELECT chip_balance INTO before_player FROM club_members WHERE club_id=club AND user_id=payee;
 PERFORM set_config('app.ledger_autoskip_agents','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 UPDATE agents SET agent_wallet_balance=agent_wallet_balance-amount WHERE club_id=club AND user_id=sender RETURNING agent_wallet_balance INTO after_agent;
 UPDATE club_members SET chip_balance=chip_balance+amount WHERE club_id=club AND user_id=payee RETURNING chip_balance INTO after_player;
 INSERT INTO chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,metadata,balance_after,created_at,is_reversed,clawed_back,reversible_until)
 VALUES(tx,club,sender,payee,amount,'agent_wallet_send',jsonb_build_object('op_id',op,'destination','player_wallet','claimed_back',0,'agent_wallet_before',before_agent,'agent_wallet_after',after_agent,'recipient_balance_after',after_player),after_agent,stamp,false,false,stamp+interval '10 minutes');
 INSERT INTO cashier_rpc_operation_intents(operation_id,actor_user_id,action,club_id,operation_intent,intent_fingerprint,receipt,created_at,completed_at)
 VALUES(op,sender,'agent_wallet_send',club,jsonb_build_object('actor',sender,'club',club,'target',payee,'action','agent_wallet_send','requested_destination','player_wallet','amount',amount),md5(label),
 jsonb_build_object('success',true,'op_id',op,'amount',amount,'destination','player_wallet','credit_drawn',0,'transaction_id',tx,'agent_wallet_before',before_agent,'agent_wallet_after',after_agent,'recipient_balance_after',after_player),stamp,stamp+interval '1 second');
 INSERT INTO chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,idempotency_key,correlation_id,created_at,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
 VALUES(leg,sender,'agent_wallet',sender,'player_wallet',payee,amount,'agent_send',club,'agent_send:'||op::text,op,stamp,before_agent,after_agent,before_player,after_player);
 PERFORM set_config('app.ledger_autoskip_agents','',true);PERFORM set_config('app.ledger_autoskip_club_members','',true);
 RETURN leg;
END $$;

CREATE FUNCTION public.ed_seed()RETURNS void LANGUAGE plpgsql AS $$
DECLARE member jsonb;cid bigint;extra uuid;
BEGIN
 PERFORM caw_seed(false);
 UPDATE agents SET agent_wallet_balance=2000 WHERE user_id=caw_u('O');
 -- S (the Mikey analogue) owns9.73, while A's40 must still pass through S.
 UPDATE accounting_cash_rake_sources SET contract=jsonb_set(jsonb_set(contract,'{tiers,1,amount}','3'),'{tiers,1,rate}','0.03')WHERE id=caw_u('s1');
 UPDATE accounting_cash_rake_sources SET contract=jsonb_set(jsonb_set(contract,'{tiers,1,amount}','6.73'),'{tiers,1,rate}','0.0673')WHERE id=caw_u('s4a');
 UPDATE agent_commissions SET amount=3,commission_rate=.03 WHERE source_id=caw_u('s1')AND user_id=caw_u('S');
 UPDATE agent_commissions SET amount=6.73,commission_rate=.0673 WHERE source_id=caw_u('s4a')AND user_id=caw_u('S');
 -- P3 (the WooWoo analogue) has a certified426.03 obligation.
 UPDATE accounting_cash_rake_sources SET rake_credit=1500,contract=jsonb_set(jsonb_set(contract,'{tiers,0,amount}','600'),'{tiers,0,rate}','0.4')WHERE id=caw_u('s3');
 UPDATE agent_commissions SET amount=600,commission_rate=.4 WHERE source_id=caw_u('s3')AND user_id=caw_u('O');
 UPDATE rakeback_periods SET rake_generated=1500,total_rake_paid=1500,rakeback_rate=.2840,rakeback_amount=426.03,rakeback_earned=426.03 WHERE user_id=caw_u('P3');
 UPDATE accounting_rakeback_period_calculations SET rake_generated=1500,rakeback_amount=426.03,display_rate=.2840,source_allocations=jsonb_set(jsonb_set(source_allocations,'{0,rake_credit}','1500'),'{0,rate}','0.28402')WHERE player_id=caw_u('P3');
 -- S also earned32.26 as a player, paid from the owner's canonical bank.
 INSERT INTO accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract)
 VALUES(caw_u('s5'),caw_u('r5'),caw_u('S'),caw_u('club'),'2026-10-06 12:00Z',100,jsonb_build_object('club_id',caw_u('club'),'is_union_house',false,'membership',jsonb_build_object('terms',jsonb_build_object('agent_id',caw_u('O'))),'tiers',jsonb_build_array(jsonb_build_object('agent_id',caw_u('agentO'),'user_id',caw_u('O'),'role','agent','amount',50,'rate',.5,'agreement',jsonb_build_object('terms',jsonb_build_object('parent_agent_id',''))))));
 INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at)VALUES(caw_u('club'),caw_u('O'),50,.5,'cash_rake_accrual',caw_u('s5'),'2026-10-06 12:00Z');
 cid:=caw_period('S',jsonb_build_array(caw_alloc('s5','r5',.3226,'agent',caw_u('O'))),32.26,.3226,'agent',caw_u('O'),100);
 UPDATE accounting_rakeback_period_calculations SET source_fingerprint=md5(jsonb_build_object('allocations',source_allocations,'rake',rake_generated,'amount',rakeback_amount,'rate',display_rate)::text);
 UPDATE accounting_rakeback_payer_contracts pc SET source_fingerprint=c.source_fingerprint FROM accounting_rakeback_period_calculations c WHERE c.id=pc.calculation_id;
 PERFORM ed_send('Woo-first','P3',500);extra:=ed_send('Woo-extra','P3',500);PERFORM ed_send('Mikey','S',125);
 INSERT INTO smarter_private.existing_rakeback_transfer_instructions(id,club_id,beneficiary_id,period_start,period_end,original_ledger_id,evidence_ledger_ids,roles,owner_instruction,source_thread)
 VALUES(caw_u('instruction-Woo'),caw_u('club'),caw_u('P3'),'2026-10-05 07:00Z','2026-10-12 07:00Z',caw_u('ledger-Woo-first'),ARRAY[caw_u('ledger-Woo-first'),extra],ARRAY['player'],'No further rakeback; already paid; both existing credits retained as evidence','native-owner-instruction'),
 (caw_u('instruction-Mikey'),caw_u('club'),caw_u('S'),'2026-10-05 07:00Z','2026-10-12 07:00Z',caw_u('ledger-Mikey'),ARRAY[caw_u('ledger-Mikey')],ARRAY['player','commission'],'No further rakeback or commission; already paid; actual prior destination remains player wallet','native-owner-instruction');
 INSERT INTO accounting_period_recompute_requests(club_id,period_start,period_end,status,last_requested_at,attempted_at,last_result)VALUES(caw_u('club'),'2026-10-05','2026-10-11','complete',now()-interval '1 hour',now(),jsonb_build_object('accounting_version',2,'status','ready','club_id',caw_u('club'),'period_start','2026-10-05','period_end','2026-10-11'));
END $$;

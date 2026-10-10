import assert from 'node:assert/strict';
import fs from 'node:fs';
export const actor='10000000-0000-4000-8000-000000000001';
export const checker='10000000-0000-4000-8000-000000000002';
export const player='10000000-0000-4000-8000-000000000003';
export const chip='30000000-0000-4000-8000-000000000001';
export const diamond='30000000-0000-4000-8000-000000000002';
export async function qualify(query) {
 let count=0;
 const scalar=async sql=>(await query(sql)).rows[0].result;
 const denied=async(sql,code)=>{await query('SAVEPOINT expected_refusal');try {await query(sql);assert.fail('expected authoritative refusal '+code);}catch(error){assert.equal(error.code,code,error.message+" SQL: "+sql);}finally{await query('ROLLBACK TO SAVEPOINT expected_refusal');await query('RELEASE SAVEPOINT expected_refusal');}count++;};
 const cancel=(event,op,who=actor,reason='Qualification refund reason')=>`SELECT fn_ca_operator_cancel_tournament('${event}','${op}','${reason}','${who}','qualification') result`;
 await query('BEGIN');
 // Both production overloads coexist: the former name-only preflight was ambiguous.
 assert.equal(await scalar("SELECT count(*)::integer result FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_spin_core'"),2);count++;
 await denied("SELECT (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_wheel_spin_core')",'21000');
 for(const [signature,hash] of [['uuid,uuid,text,boolean,uuid','d2d449daa747be0d4ae53006cf0c8eba'],['uuid,uuid,text,boolean','4c9c2645c10f7440951f15ffeca63d68']]) {
  assert.equal(await scalar(`SELECT md5(pg_get_functiondef(to_regprocedure('public.fn_wheel_spin_core(${signature})'))) result`),hash);count++;
 }
 await query("SELECT set_config('request.jwt.claims','{}',true)");
 const signedOut=await scalar("SELECT public.fn_wheel_spin_core(NULL::uuid,NULL::uuid,'qualification',false) result");
 assert.deepEqual(signedOut,{ok:false,error:'Sign In To Spin'});count++;
 await denied(cancel(chip,'60000000-0000-4000-8000-000000000010',player),'42501');
 await query(`UPDATE tournaments SET started_at=now(),status='RUNNING' WHERE id='${chip}'`);
 await denied(cancel(chip,'60000000-0000-4000-8000-000000000010'),'55000');
 await query(`UPDATE tournaments SET started_at=NULL,status='REGISTERING' WHERE id='${chip}'`);
 await query('UPDATE ca_operator_policy SET approvals_enabled=true,allow_self_approve_when_alone=false,cashout_threshold=50');
 const op='60000000-0000-4000-8000-000000000001';
 const pending=await scalar(cancel(chip,op));assert.equal(pending.pending,true);count++;
 assert.equal(await scalar(`SELECT chip_balance result FROM club_members WHERE user_id='${player}'`),'7.00');count++;
 const self=await scalar(`SELECT fn_ca_operator_decide_approval('${pending.approval_id}','approve','${actor}','qualification') result`);
 assert.equal(self.reason,'self_approval_refused');count++;
 const approved=await scalar(`SELECT fn_ca_operator_decide_approval('${pending.approval_id}','approve','${checker}','qualification') result`);assert.equal(approved.status,'approved');count++;
 await denied(cancel(chip,op,actor,'Changed material reason'),'22023');
 await query(`UPDATE tournaments SET prize_pool=101 WHERE id='${chip}'`);
 await denied(cancel(chip,op),'40001');
 await query(`UPDATE tournaments SET prize_pool=100 WHERE id='${chip}'`);
 // All emergency stops are closed: funded chip and Diamond refunds remain legal.
 for(const [index,path] of ['tournament_registration','positive_issuance','cashout'].entries()) {
  const stopped=await scalar(`SELECT fn_ca_set_emergency_stop('${path}',true,0,'Qualification stop reason','90000000-0000-4000-8000-00000000000${index+1}','${actor}','qualification') result`);
  assert.equal(stopped.ok,true);count++;
  const replay=await scalar(`SELECT fn_ca_set_emergency_stop('${path}',true,0,'Qualification stop reason','90000000-0000-4000-8000-00000000000${index+1}','${actor}','qualification') result`);
  assert.equal(replay.replayed,true);count++;
  await denied(`SELECT fn_ca_set_emergency_stop('${path}',false,0,'Qualification changed reason','90000000-0000-4000-8000-00000000001${index+1}','${actor}','qualification')`,'40001');
  await denied(`SELECT fn_ca_assert_emergency_path('${path}')`,'P0410');
 }
 await denied(`INSERT INTO tournament_players(tournament_id,user_id,status) VALUES('${chip}','${checker}','registered')`,'P0410');
 await denied(`UPDATE tournament_players SET rebuys=rebuys+1 WHERE tournament_id='${chip}'`,'P0410');
 await denied(`INSERT INTO ca_mint_ledger(op_id,action,asset,holder_type,holder_id,amount,reason) VALUES('qualification-mint','mint','chips','player','${player}',1,'Qualification issuance')`,'P0410');
 await denied(`INSERT INTO ca_mint_ledger(op_id,action,asset,holder_type,holder_id,amount,reason) VALUES('qualification-diamond-mint','mint','diamonds','player','${player}',1,'Qualification issuance')`,'P0410');
 await denied(`SELECT add_diamonds_to_balance('${player}',1,'bonus','Qualification issuance','qualification-reward')`,'P0410');
 await denied(`SELECT fn_ca_fund_club('20000000-0000-4000-8000-000000000001',1,'Qualification issuance','qualification-fund')`,'P0410');
 await query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`);
 const start=await scalar("SELECT fn_union_week_start(clock_timestamp()-interval '14 days')::text result");
 const end=await scalar(`SELECT fn_union_week_start('${start}'::timestamptz+interval '8 days')::text result`);
 await query(`INSERT INTO accounting_cash_bank_receipts(rake_record_id,club_id,club_ledger_id,amount,banked_at) VALUES('50000000-0000-4000-8000-000000000091','20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000090',10,'${start}'::timestamptz+interval '1 day')`);
 const owed=await scalar(`SELECT fn_bank_standalone_week_rake('20000000-0000-4000-8000-000000000001','${start}','${end}') result`);
 assert.equal(owed.ok,true);assert.equal(owed.amount,10);assert.equal(owed.cash_rake,10);count++;
 const bankReplay=await scalar(`SELECT fn_bank_standalone_week_rake('20000000-0000-4000-8000-000000000001','${start}','${end}') result`);assert.equal(bankReplay.replayed,true);count++;
 await denied(`SELECT fn_ca_fund_club('20000000-0000-4000-8000-000000000001',11,'Weekly bank of standalone rake','standalone-rake-bank:20000000-0000-4000-8000-000000000001:1990-01-01T00:00:00Z..1990-01-08T00:00:00Z')`,'P0410');
 await denied(`INSERT INTO cashout_requests(player_id,status) VALUES('${player}','pending')`,'P0410');
 // The final durable owner-row write fails AFTER money, proving whole-request rollback.
 await query(`CREATE FUNCTION pg_temp.fail_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='completed' THEN RAISE EXCEPTION 'qualified late fault' USING ERRCODE='PZ013'; END IF; RETURN NEW; END $$; CREATE TRIGGER qualification_late_fault BEFORE UPDATE ON ca_operator_tournament_operations FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_completion()`);
 await denied(cancel(chip,op),'PZ013');
 assert.equal(await scalar(`SELECT chip_balance result FROM club_members WHERE user_id='${player}'`),'7.00');
 assert.equal(await scalar('SELECT count(*)::integer result FROM tournament_cancellation_receipts'),0);count++;
 await query('DROP TRIGGER qualification_late_fault ON ca_operator_tournament_operations');
 const done=await scalar(cancel(chip,op));assert.equal(done.receipt.fully_settled,true);assert.equal(done.receipt.total_refunded,100);count++;
 assert.equal(await scalar(`SELECT chip_balance result FROM club_members WHERE user_id='${player}'`),'107.00');count++;
 const replay=await scalar(cancel(chip,op));assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,done.receipt);count++;
 assert.equal(await scalar('SELECT count(*)::integer result FROM tournament_refund_tranches'),1);count++;
 await query('UPDATE ca_operator_policy SET approvals_enabled=false');
 const diamonds=await scalar(cancel(diamond,'60000000-0000-4000-8000-000000000002'));
 assert.equal(diamonds.receipt.asset,'diamonds');assert.equal(diamonds.receipt.total_refunded,100);assert.equal(diamonds.receipt.fully_settled,true);count++;
 assert.equal(await scalar(`SELECT diamonds::integer result FROM profiles WHERE id='${player}'`),107);count++;
 assert.equal(await scalar(`SELECT balance::integer result FROM poker_diamond_custody WHERE user_id='${player}'`),0);count++;
 assert.equal((await scalar(cancel(diamond,'60000000-0000-4000-8000-000000000002'))).replayed,true);count++;
 assert.equal(await scalar(`SELECT count(*)::integer result FROM poker_diamond_tournament_ledger WHERE kind='refund'`),1);count++;
 // Real non-Arena refund owners must restore provable original debits while
 // every issuance stop remains closed. Labels alone never authorize a return.
 await query(`INSERT INTO diamond_transactions(id,user_id,amount,type,reference_id,balance_after) VALUES('81000000-0000-4000-8000-000000000001','${player}',-10,'shop_purchase','qualification-shop-original',7),('81000000-0000-4000-8000-000000000002','${player}',-20,'merch_purchase','qualification-merch-original',7),('81000000-0000-4000-8000-000000000003','${player}',-30,'ad_purchase','adcamp:82000000-0000-4000-8000-000000000003',7)`);
 await query(`INSERT INTO club_shop_purchases(id,club_id,buyer_id,price_paid,currency,charge_reference,stock_claimed) VALUES('82000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','${player}',10,'diamonds','qualification-shop-original',false); INSERT INTO club_shop_inventory(id,purchase_id,status) VALUES('83000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001','owned')`);
 const shop=await scalar(`SELECT fn_refund_shop_purchase('20000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001','${actor}','Qualification paid refund') result`);assert.equal(shop.success,true);count++;
 assert.equal((await scalar(`SELECT fn_refund_shop_purchase('20000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001','${actor}','Qualification paid refund') result`)).already_refunded,true);count++;
 await query(`INSERT INTO merchandise_orders(id,user_id,payment_method,diamonds_spent,refunded_diamonds,purchase_reference,status,stock_restored,fulfillment_version,metadata) VALUES('82000000-0000-4000-8000-000000000002','${player}','diamonds',20,0,'qualification-merch-original','paid',true,0,'{}')`);
 const merch=await scalar(`SELECT refund_diamond_merch_order_atomic_v2('82000000-0000-4000-8000-000000000002','${actor}',0,'qualification-merch-refund') result`);assert.equal(merch.success,true);assert.equal(merch.refunded_diamonds,20);count++;
 assert.equal((await scalar(`SELECT refund_diamond_merch_order_atomic_v2('82000000-0000-4000-8000-000000000002','${actor}',0,'qualification-merch-refund') result`)).duplicate,true);count++;
 await query(`INSERT INTO ad_campaign(id,submitted_by,diamonds_charged,diamonds_refunded,name,status) VALUES('82000000-0000-4000-8000-000000000003','${player}',30,0,'Qualified Original Campaign','submitted')`);
 const campaign=await scalar(`SELECT fn_ad_campaign_review('82000000-0000-4000-8000-000000000003','reject','Qualification refund') result`);assert.equal(campaign.ok,true);assert.equal(campaign.diamonds_refunded,30);count++;
 assert.equal(await scalar(`SELECT diamonds::integer result FROM profiles WHERE id='${player}'`),167);count++;
 assert.equal(await scalar("SELECT count(*)::integer result FROM ca_emergency_refund_provenance WHERE state='consumed'"),3);count++;
 assert.equal(await scalar("SELECT count(*)::integer result FROM ca_mint_ledger m JOIN ca_emergency_refund_provenance p ON p.journal_id=m.diamond_tx_id AND p.amount=m.amount WHERE p.state='consumed'"),3);count++;
 await denied(`SELECT fn_ca_authorize_funded_return('shop','82000000-0000-4000-8000-000000000001','diamonds','${checker}',10,'ca-shop-refund-82000000-0000-4000-8000-000000000001')`,'P0404');
 await denied(`SELECT fn_diamond_game_pay_diamonds('${player}','${checker}',999999,'Unfunded Direct Owner','qualification-empty-bank')`,'P0001');
 await denied(`SELECT add_diamonds_to_balance('${player}',10,'test_bypass',E'Forged\\nPL/pgSQL function fn_poker_diamond_release(uuid,uuid) line 1 at PERFORM ','qualification-forged-context')`,'P0410');
 for(const label of ['test_bypass','signup_bonus','arena_withdraw','transfer']) await denied(`SELECT add_diamonds_to_balance('${player}',10,'${label}','Forged issuance class','qualification-forged-${label}')`,'P0410');
 await denied(`SELECT add_diamonds_to_balance('${player}',10,'refund','Arbitrary alleged refund','qualification-unfunded-refund')`,'P0410');
 await query(`INSERT INTO trivia_pvp_matches(id,player1_id,player2_id,stake_amount,status,questions,created_at) VALUES('82000000-0000-4000-8000-000000000004','${player}','${checker}',10,'active',(SELECT jsonb_agg(gen_random_uuid()::text) FROM generate_series(1,20)),now()-interval '1 hour')`);
 await query(`INSERT INTO diamond_transactions(user_id,amount,type,transaction_type,reference_id,balance_after) VALUES('${player}',-10,'pvp_stake','pvp_stake','pvp_stake_82000000-0000-4000-8000-000000000004_${player}',7),('${checker}',-10,'pvp_stake','pvp_stake','pvp_stake_82000000-0000-4000-8000-000000000004_${checker}',0)`);
 const pvp=await scalar(`SELECT decide_trivia_pvp_settlement_v1('82000000-0000-4000-8000-000000000004',true) result`);assert.equal(pvp.state,'decided');assert.equal(pvp.decision.kind,'refund');assert.equal(pvp.credited_amount,20);count++;
 assert.equal((await scalar(`SELECT decide_trivia_pvp_settlement_v1('82000000-0000-4000-8000-000000000004',true) result`)).replayed,true);count++;
 await denied(`SELECT fn_ca_authorize_funded_return('pvp','82000000-0000-4000-8000-000000000004','diamonds','${player}',10,'pvp_tie_refund_82000000-0000-4000-8000-000000000004_${player}')`,'P0404');

 for(const [n,kind,scores,forced] of [[12,'win',[17,8],false],[13,'tie',[12,12],false],[14,'win',[17,null],true]]) {
  const event='82000000-0000-4000-8000-'+String(n).padStart(12,'0');
  await query(`INSERT INTO trivia_pvp_matches(id,player1_id,player2_id,stake_amount,status,questions,created_at) VALUES('${event}','${player}','${checker}',10,'active',(SELECT jsonb_agg(gen_random_uuid()::text) FROM generate_series(1,20)),now()-interval '1 hour'); INSERT INTO diamond_transactions(user_id,amount,type,transaction_type,reference_id,balance_after) VALUES('${player}',-10,'pvp_stake','pvp_stake','pvp_stake_${event}_${player}',7),('${checker}',-10,'pvp_stake','pvp_stake','pvp_stake_${event}_${checker}',0)`);
  for(let side=1;side<=2;side++) {
   const who=side===1?player:checker,score=scores[side-1];const session='84000000-0000-4000-8000-'+String(n*10+side).padStart(12,'0');
   await query(`INSERT INTO trivia_sessions(id,user_id,mode,status,entry_state,entry_cost,question_ids,created_at,expires_at,submitted_at,correct_count) SELECT '${session}','${who}','pvp','${score===null?'expired':'submitted'}','charged',10,ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(questions)),created_at,created_at+interval '20 minutes',${score===null?'NULL':"created_at+interval '10 minutes'"},${score===null?'NULL':score} FROM trivia_pvp_matches WHERE id='${event}'; INSERT INTO trivia_pvp_session_links(match_id,side,user_id,session_id) VALUES('${event}',${side},'${who}','${session}')`);
  }
  const decision=await scalar(`SELECT decide_trivia_pvp_settlement_v1('${event}',${forced}) result`);
  assert.equal(decision.state,'decided',JSON.stringify(decision));assert.equal(decision.decision.kind,kind);assert.equal(decision.decision.forfeit,forced);assert.equal(decision.credited_amount,kind==='tie'?20:18);count++;
  assert.equal((await scalar(`SELECT decide_trivia_pvp_settlement_v1('${event}',${forced}) result`)).replayed,true);count++;
  assert.equal(await scalar(`SELECT sum(amount)::integer result FROM ca_emergency_refund_provenance WHERE source_owner='pvp' AND source_id='${event}' AND state='consumed'`),kind==='tie'?20:18);count++;
  await denied(`SELECT fn_ca_authorize_funded_return('pvp','${event}','diamonds','${checker}',10,'pvp_refund_${event}_${checker}')`,'P0404');
 }

 for(const n of [15,16]) {
  const event='82000000-0000-4000-8000-'+String(n).padStart(12,'0');
  await query(`INSERT INTO trivia_pvp_matches(id,player1_id,player2_id,stake_amount,status,questions,created_at) VALUES('${event}','${player}','${checker}',10,'active',(SELECT jsonb_agg(gen_random_uuid()::text) FROM generate_series(1,20)),now()-interval '1 hour')`);
  if(n===15) await query(`INSERT INTO diamond_transactions(user_id,amount,type,transaction_type,reference_id,balance_after) VALUES('${player}',-10,'pvp_stake','pvp_stake','pvp_stake_${event}_${player}',7)`);
  const decision=await scalar(`SELECT decide_trivia_pvp_settlement_v1('${event}',true) result`);
  assert.equal(decision.state,'decided');assert.equal(decision.decision.kind,n===15?'refund':'void');assert.equal(decision.credited_amount,n===15?10:0);assert.equal(decision.credit_count,n===15?1:0);count++;
 }
 await query(`INSERT INTO diamond_transactions(user_id,amount,type,reference_id,balance_after) VALUES('${player}',-12,'merch_purchase','qualification-merch-v1-original',7),('${player}',-13,'ad_purchase','adcamp:82000000-0000-4000-8000-000000000006',7)`);
 await query(`INSERT INTO merchandise_orders(id,user_id,payment_method,diamonds_spent,refunded_diamonds,purchase_reference,status,stock_restored,fulfillment_version,metadata) VALUES('82000000-0000-4000-8000-000000000005','${player}','diamonds',12,0,'qualification-merch-v1-original','paid',true,0,'{}')`);
 assert.equal((await scalar(`SELECT refund_diamond_merch_order_atomic('82000000-0000-4000-8000-000000000005','${actor}','qualification-merch-v1-refund') result`)).success,true);count++;
 await query(`SELECT set_config('request.jwt.claims','{"role":"service_role","sub":"${actor}"}',true)`);
 await query(`INSERT INTO club_members(club_id,user_id,role,status,chip_balance) VALUES('20000000-0000-4000-8000-000000000001','${actor}','admin','active',0); INSERT INTO ad_campaign(id,club_id,submitted_by,diamonds_charged,diamonds_refunded,name,status) VALUES('82000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000001','${player}',13,0,'Qualified Cancel Campaign','submitted')`);
 assert.equal((await scalar(`SELECT fn_club_ad_cancel('82000000-0000-4000-8000-000000000006') result` )).ok,true);count++;

 await query(`INSERT INTO diamond_transactions(id,user_id,amount,type,reference_id,balance_after) VALUES('81000000-0000-4000-8000-000000000008','${player}',-18,'commerce','qualification-commerce-origin',7),('81000000-0000-4000-8000-000000000009','${player}',-150,'vip_daily','card-redemption:82000000-0000-4000-8000-000000000009',7)`);
 await query(`INSERT INTO ca_commerce_purchases(id,payer_id,scope_kind,scope_id,net,diamond_tx_id,lines,lot_allocation) VALUES('82000000-0000-4000-8000-000000000008','${player}','club','20000000-0000-4000-8000-000000000001',18,'81000000-0000-4000-8000-000000000008','[{"index":0,"net":18}]','[]')`);
 assert.equal((await scalar(`SELECT fn_ca_commerce_refund('82000000-0000-4000-8000-000000000008',0,10,'Qualified Original Refund','qualification-commerce-partial') result`)).success,true);count++;
 assert.equal((await scalar(`SELECT fn_ca_commerce_refund('82000000-0000-4000-8000-000000000008',0,10,'Qualified Original Refund','qualification-commerce-partial') result`)).is_replay,true);count++;
 assert.equal((await scalar(`SELECT fn_ca_commerce_refund('82000000-0000-4000-8000-000000000008',0,9,'Qualified Original Refund','qualification-commerce-over') result`)).error,'exceeds_refundable');count++;
 assert.equal((await scalar(`SELECT fn_ca_commerce_refund('82000000-0000-4000-8000-000000000008',0,8,'Qualified Original Refund','qualification-commerce-rest') result`)).success,true);count++;
 await query(`UPDATE profiles SET vip_tier='daily',vip_expires_at=now()+interval '1 day',is_vip=true WHERE id='${player}'; INSERT INTO diamond_purchases(id,user_id,status,diamonds_amount,bonus_diamonds,metadata) VALUES('82000000-0000-4000-8000-000000000009','${player}','completed',150,0,jsonb_build_object('redemption_status','completed','redemption_intent',jsonb_build_object('kind','vip_daily'),'redemption_result',jsonb_build_object('expires_at',now()+interval '1 day')))`);
 assert.equal((await scalar(`SELECT fn_diamond_purchase_refund('82000000-0000-4000-8000-000000000009',100,100) result`)).redemption_refund_status,'revoked');count++;
 assert.equal(await scalar(`SELECT count(*)::integer result FROM ca_emergency_refund_provenance WHERE source_owner='vip_card' AND state='consumed'`),1);count++;

 await query(`INSERT INTO chip_ledger(id,club_id,from_type,from_entity_id,to_type,to_entity_id,amount,category,idempotency_key) VALUES('81000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000001','player_wallet','${player}','issuance_reserve',NULL,11,'burn','qualification-shop-chips-origin'); INSERT INTO club_shop_purchases(id,club_id,buyer_id,price_paid,currency,charge_reference,stock_claimed) VALUES('82000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000001','${player}',11,'chips','qualification-shop-chips-origin',false); INSERT INTO club_shop_inventory(id,purchase_id,status) VALUES('83000000-0000-4000-8000-000000000010','82000000-0000-4000-8000-000000000010','owned')`);
 assert.equal((await scalar(`SELECT fn_refund_shop_purchase('20000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000010','${actor}','Qualified original chips refund') result`)).success,true);count++;
 assert.equal(await scalar(`SELECT count(*)::integer result FROM ca_emergency_refund_provenance WHERE asset='chips' AND source_owner='shop' AND state='consumed'`),1,JSON.stringify((await query("SELECT to_jsonb(p) p FROM ca_emergency_refund_provenance p WHERE asset='chips' UNION ALL SELECT to_jsonb(l) FROM chip_ledger l WHERE idempotency_key LIKE 'ca-shop%'")).rows));count++;


 await query(`INSERT INTO diamond_transactions(id,user_id,amount,type,reference_id,balance_after) VALUES('81000000-0000-4000-8000-000000000011','${player}',-9,'shop_purchase','qualification-refund-late-original',7); INSERT INTO club_shop_purchases(id,club_id,buyer_id,price_paid,currency,charge_reference,stock_claimed) VALUES('82000000-0000-4000-8000-000000000011','20000000-0000-4000-8000-000000000001','${player}',9,'diamonds','qualification-refund-late-original',false); INSERT INTO club_shop_inventory(id,purchase_id,status) VALUES('83000000-0000-4000-8000-000000000011','82000000-0000-4000-8000-000000000011','owned')`);
 const beforeRefundFault=await scalar(`SELECT diamonds::integer result FROM profiles WHERE id='${player}'`);
 await query(`CREATE FUNCTION pg_temp.reject_original_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='82000000-0000-4000-8000-000000000011' AND NEW.refunded_at IS NOT NULL THEN RAISE EXCEPTION 'qualification original-owner late failure' USING ERRCODE='PZ017'; END IF; RETURN NEW; END $$; CREATE TRIGGER qualification_original_refund_failure AFTER UPDATE ON club_shop_purchases FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_original_refund()`);
 await denied(`SELECT fn_refund_shop_purchase('20000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000011','${actor}','Qualified retry retained origin')`,'PZ017');
 assert.equal(await scalar(`SELECT count(*)::integer result FROM ca_emergency_refund_provenance WHERE source_id='82000000-0000-4000-8000-000000000011'`),0);count++;
 assert.equal(await scalar(`SELECT diamonds::integer result FROM profiles WHERE id='${player}'`),beforeRefundFault);count++;
 await query('DROP TRIGGER qualification_original_refund_failure ON club_shop_purchases');
 assert.equal((await scalar(`SELECT fn_refund_shop_purchase('20000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000011','${actor}','Qualified retry retained origin') result`)).success,true);count++;
 assert.equal(await scalar(`SELECT count(*)::integer result FROM ca_emergency_refund_provenance WHERE source_id='82000000-0000-4000-8000-000000000011' AND state='consumed'`),1);count++;
 // Existing cashier owner creates a real hold while open, then stop refuses
 // new holds, approval and execute while cancellation/decline return custody.
 await query(`UPDATE clubs SET owner_id='${actor}' WHERE id='20000000-0000-4000-8000-000000000001'; UPDATE club_members SET agent_id='${actor}',is_active=true WHERE user_id='${player}'`);
 await scalar(`SELECT fn_ca_set_emergency_stop('cashout',false,1,'Qualification temporary open','90000000-0000-4000-8000-000000000021','${actor}','qualification') result`);
 await query(`SELECT set_config('request.jwt.claims','{"role":"service_role","sub":"${player}"}',true)`);
 for(let i=1;i<=1;i++) await scalar(`SELECT fn_cashout_request_v2('20000000-0000-4000-8000-000000000001',1,'${player}','91000000-0000-4000-8000-00000000000${i}','Qualified custody hold') result`);
 const holds=(await query(`SELECT id FROM cashout_requests WHERE player_id='${player}' ORDER BY created_at,id`)).rows;
 await scalar(`SELECT fn_ca_set_emergency_stop('cashout',true,2,'Qualification close again','90000000-0000-4000-8000-000000000022','${actor}','qualification') result`);
 await query(`SELECT set_config('request.jwt.claims','{"role":"service_role","sub":"${checker}"}',true)`);
 await denied(`SELECT fn_cashout_request_v2('20000000-0000-4000-8000-000000000001',1,'${checker}','91000000-0000-4000-8000-000000000004','Blocked new hold')`,'P0410');
 assert.equal(await scalar(`SELECT chip_balance result FROM club_members WHERE user_id='${checker}'`),'10.00');count++;
 await query(`SELECT set_config('request.jwt.claims','{"role":"service_role","sub":"${actor}"}',true)`);
 await denied(`SELECT fn_cashout_approve_v2('${holds[0].id}','20000000-0000-4000-8000-000000000001',1,'${actor}','91000000-0000-4000-8000-000000000005','Blocked approval')`,'P0410');
 assert.equal(await scalar(`SELECT count(*)::integer result FROM agents WHERE user_id='${actor}'`),0);count++;
 await denied(`SELECT fn_complete_cashout('${holds[0].id}','${actor}')`,'P0410');
 assert.equal((await scalar(`SELECT fn_cashout_release_v2('${holds[0].id}','20000000-0000-4000-8000-000000000001',1,'${actor}','91000000-0000-4000-8000-000000000006','Allowed decline refund') result` )).success,true);count++;
 await query(`SELECT set_config('request.jwt.claims','{"role":"service_role","sub":"${player}"}',true)`);
 await scalar(`SELECT fn_ca_set_emergency_stop('cashout',false,3,'Qualification second hold','90000000-0000-4000-8000-000000000023','${actor}','qualification') result`);
 const secondHold=await scalar(`SELECT fn_cashout_request_v2('20000000-0000-4000-8000-000000000001',1,'${player}','91000000-0000-4000-8000-000000000002','Qualified second custody hold') result`);
 await scalar(`SELECT fn_ca_set_emergency_stop('cashout',true,4,'Qualification second stop','90000000-0000-4000-8000-000000000024','${actor}','qualification') result`);
 assert.equal((await scalar(`SELECT fn_cashout_release_v2('${secondHold.request.id}','20000000-0000-4000-8000-000000000001',1,'${player}','91000000-0000-4000-8000-000000000007','Allowed cancellation refund') result` )).success,true);count++;
 assert.equal(await scalar(`SELECT chip_balance result FROM club_members WHERE user_id='${player}'`),'118.00');count++;
 assert.equal(await scalar(`SELECT count(*)::integer result FROM accounting_cashier_events WHERE event_kind IN ('cancellation','decline')`),2);count++;
 assert.equal((await scalar(`SELECT fn_cashout_release_v2('${secondHold.request.id}','20000000-0000-4000-8000-000000000001',1,'${player}','91000000-0000-4000-8000-000000000007','Allowed cancellation refund') result`)).replayed,true);count++;
 await query('SAVEPOINT qualified_recovery');
 await query(fs.readFileSync(new URL('./rollback.sql',import.meta.url),'utf8'));
 assert.equal(await scalar(`SELECT count(*)::integer result FROM pg_trigger WHERE tgname IN ('ca_emergency_registration','ca_emergency_positive_issuance','aa_ca_emergency_diamond_issuance','ca_emergency_cashout','zz_ca_funded_return_journal')`),0);count++;
 await query('ROLLBACK TO SAVEPOINT qualified_recovery');
 await query('ROLLBACK');
 assert.equal(await scalar(`SELECT chip_balance result FROM club_members WHERE user_id='${player}'`),'7.00');
 assert.equal(await scalar('SELECT count(*)::integer result FROM ca_operator_tournament_operations'),0);count++;
 return {assertionGroups:count,realChipRefund:true,realDiamondRefund:true,lateFaultAtomicity:true,makerChecker:true,rollback:true};
}

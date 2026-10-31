-- Synthetic earning-time history. Prefix is disjoint from every live UUID.
CREATE FUNCTION own_history(p_id bigint,p_type text,p_key text,p_at timestamptz,p_terms jsonb)RETURNS void LANGUAGE sql AS $$
 INSERT INTO accounting_agreement_history(id,entity_type,entity_key,club_id,subject_user_id,observed_at,transaction_id,after_terms)
 VALUES(p_id,p_type,p_key,(p_terms->>'club_id')::uuid,NULLIF(p_terms->>'user_id','')::uuid,p_at,p_id,p_terms)$$;
CREATE FUNCTION own_playing_seed(p_fee boolean DEFAULT false,p_own_count int DEFAULT 1,p_mixed boolean DEFAULT false)RETURNS void LANGUAGE plpgsql AS $$
DECLARE club uuid:=caw_u('club');terms jsonb;src uuid;rr uuid;hand uuid;attribution uuid;journal uuid;contract jsonb;n int;earned timestamptz;amt numeric;
BEGIN
 INSERT INTO clubs(id,name,owner_id,chip_treasury,is_union,asset,lifecycle_status)VALUES(club,'Own playing synthetic '||club,caw_u('O'),1000,false,'chips','active');
 INSERT INTO profiles(id,status)SELECT caw_u(v),'active'FROM unnest(ARRAY['O','S','A'])v;
 INSERT INTO club_members(club_id,user_id,role,chip_balance)VALUES(club,caw_u('O'),'owner',200),(club,caw_u('S'),'super_agent',300),(club,caw_u('A'),'agent',1000);
 INSERT INTO agents(id,club_id,user_id,role,status,parent_agent_id,commission_rate,player_rakeback_rate,agent_wallet_balance)VALUES
 (caw_u('agentO'),club,caw_u('O'),'super_agent','active',NULL,.1,.15,500),
 (caw_u('agentS'),club,caw_u('S'),'super_agent','active',caw_u('agentO'),.2,.15,0),
 (caw_u('agentA'),club,caw_u('A'),'agent','active',caw_u('agentS'),.3,.15,0);
 FOR n IN 1..3 LOOP
  SELECT jsonb_build_object('id',a.id,'club_id',club,'user_id',a.user_id,'role',a.role,'status',a.status,'parent_agent_id',a.parent_agent_id,'commission_rate',a.commission_rate,'player_rakeback_rate',a.player_rakeback_rate)INTO terms FROM agents a WHERE a.id=caw_u(CASE n WHEN 1 THEN'agentO'WHEN 2 THEN'agentS'ELSE'agentA'END);
  PERFORM own_history(10000+n,'agents',terms->>'id',CASE WHEN n=3 THEN'2026-10-20'::timestamptz ELSE'2026-10-15'::timestamptz END,terms);
 END LOOP;
 PERFORM own_history(10011,'club_members',club||':'||caw_u('A'),'2026-10-15',jsonb_build_object('club_id',club,'user_id',caw_u('A'),'agent_id',caw_u('O'),'role','player','status','active','is_active',true,'player_rakeback_pct',.70));
 PERFORM own_history(10012,'club_members',club||':'||caw_u('A'),'2026-10-21',jsonb_build_object('club_id',club,'user_id',caw_u('A'),'agent_id',caw_u('O'),'role','agent','status','active','is_active',true,'player_rakeback_pct',.70));
 PERFORM own_history(10013,'club_members',club||':'||caw_u('A'),'2026-10-23',jsonb_build_object('club_id',club,'user_id',caw_u('A'),'agent_id',caw_u('S'),'role','agent','status','active','is_active',true,'player_rakeback_pct',.15));
 IF p_mixed THEN PERFORM own_history(10014,'club_members',club||':'||caw_u('A'),'2026-10-19 08:00Z',jsonb_build_object('club_id',club,'user_id',caw_u('A'),'agent_id',caw_u('S'),'role','agent','status','active','is_active',true,'player_rakeback_pct',.15));END IF;
 FOR n IN 1..(p_own_count+2)LOOP
  src:=caw_u('own-source-'||n);rr:=caw_u('own-record-'||n);hand:=caw_u('own-hand-'||n);attribution:=caw_u('own-attribution-'||n);journal:=caw_u('own-bank-'||n);
  earned:=CASE n WHEN 1 THEN'2026-10-19 12:00Z'::timestamptz WHEN 2 THEN'2026-10-22 12:00Z'::timestamptz ELSE CASE WHEN p_mixed AND n%2=0 THEN'2026-10-19 18:00Z'::timestamptz ELSE'2026-10-24 12:00Z'::timestamptz END END;amt:=CASE WHEN n>=3 THEN 100 ELSE 1 END;
  IF p_fee AND n=3 THEN
   INSERT INTO rake_records(id,table_id,club_id,rake_amount,created_at,is_tournament,tournament_id,metadata)VALUES(rr,caw_u('table'),club,amt,earned,true,caw_u('event'),jsonb_build_object('accounting_source_version',2,'union_id',NULL));
   contract:=public.own_original_earning_contract(club,caw_u('A'),amt,NULL,earned);
   INSERT INTO accounting_tournament_fee_sources(id,rake_record_id,tournament_id,player_id,club_id,game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)VALUES(src,rr,caw_u('event'),caw_u('A'),club,'mtt',caw_u('registration'),caw_u('fee-charge'),caw_u('fee-entitlement'),earned,amt,contract);
   INSERT INTO accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,status,source_manifest,rake_amount)SELECT rr,caw_u('event'),fn_accounting_tournament_fee_fingerprint(r),'captured','{}',amt FROM rake_records r WHERE r.id=rr;
   INSERT INTO accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,bank_club_id,bank_journal_id,source_fingerprint,plan)VALUES(caw_u('event'),earned+interval '1 hour','recognized',amt,club,caw_u('fee-bank'),(fn_accounting_tournament_fee_net_plan(caw_u('event'))->>'source_fingerprint'),fn_accounting_tournament_fee_net_plan(caw_u('event')));
   INSERT INTO accounting_tournament_recognized_sources(source_id,tournament_id,recognized_at,disposition,rake_credit)VALUES(src,caw_u('event'),earned+interval '1 hour','earned',amt);
   PERFORM public.fn_post_accounting_commission_source(src,'tournament_fee_accrual',earned+interval '1 hour',contract);
   CONTINUE;
  END IF;
  INSERT INTO rake_records(id,hand_id,table_id,club_id,rake_amount,created_at,is_tournament,metadata)VALUES(rr,hand,caw_u('table'),club,amt,earned,false,jsonb_build_object('accounting_source_version',2,'union_id',NULL));
  INSERT INTO rake_attributions(id,hand_id,player_id,club_id,rake_amount,rake_record_id,weighted_rake_credit)VALUES(attribution,hand,caw_u('A'),club,amt,rr,amt);
  INSERT INTO chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,created_at,idempotency_key,description)
  VALUES(journal,caw_u('O'),'table_stack',caw_u('table'),'chip_retirement',NULL,amt,'burn',club,earned,'synthetic-own-bank:'||rr,'Synthetic original earning disposition');
  INSERT INTO accounting_cash_bank_receipts(rake_record_id,club_id,club_ledger_id,banked_at,amount)VALUES(rr,club,journal,earned,amt);
  contract:=public.own_original_earning_contract(club,caw_u('A'),amt,NULL,earned)||jsonb_build_object('attribution_id',attribution);
  INSERT INTO accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract)VALUES(src,rr,caw_u('A'),club,earned,amt,contract);
  INSERT INTO accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan)
  SELECT rr,hand,earned,md5(jsonb_build_object('record',r.id,'hand',r.hand_id,'rake',r.rake_amount,'earned_at',r.created_at,'shares',(SELECT coalesce(jsonb_agg(jsonb_build_array(a.id,a.player_id,a.club_id,a.weighted_rake_credit)ORDER BY a.player_id),'[]'::jsonb)FROM rake_attributions a WHERE a.rake_record_id=r.id))::text),'accrued',jsonb_build_object('source_version',2,'rake_record_id',rr,'hand_id',hand,'earned_at',earned,'rake',r.rake_amount,'players',jsonb_build_array(contract))FROM rake_records r WHERE r.id=rr;
  PERFORM public.fn_post_accounting_commission_source(src,'cash_rake_accrual',earned,contract);
 END LOOP;
END $$;

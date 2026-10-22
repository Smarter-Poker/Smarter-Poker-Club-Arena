-- Independently fixed board for the 2026-10-22 owner rules. Not computed by
-- any settlement implementation; every expected number is written by hand.
--
-- Club C, owner O. Hierarchy O (top) -> S (super agent) -> A (agent).
-- Sources (rake 100 each unless noted), contract tiers deepest first:
--   s1  P1, agent A : A 30, S 20, O 50
--   s2  P2, no agent: O 40                    (owner's own player)
--   s3  P3, agent O : O 10                    (certificate payer is the owner)
--   s4a P4, agent A : A 10, S 5, O 5
--   s4b P4, agent O : O 10                    (P4 is a split certificate A + O)
-- Own commission: A 40, S 25, O 115 (total 180). Round 2 must pay
-- bank -> S 65 and S -> A 40 (agent wallets), and keep O's 115 in the bank.
-- Rakeback: P1 9 (A), P2 4 (club), P3 5 (owner -> club bank), P4 10 split
-- (A 5, owner 5 -> club bank). A pays 14 from its agent wallet; the bank
-- pays 4 + 5 + 5 = 14 for the owner/no-agent shares.
CREATE FUNCTION public.caw_u(label text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('commission-agent-wallet:'||label)::uuid $$;
CREATE FUNCTION public.caw_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'caw_assert:%',label; END IF; END $$;
CREATE FUNCTION public.caw_seed(deleted_agent boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c uuid:=caw_u('club'); t_s1 jsonb; t_s4a jsonb; t_o jsonb; amt numeric; n text; cid bigint;
 earned timestamptz:='2026-10-06 12:00+00';
BEGIN
 INSERT INTO public.accounting_cash_accrual_cutover(singleton,starts_at) VALUES(true,'2026-08-01');
 INSERT INTO public.clubs(id,name,owner_id,chip_treasury,is_union,asset,lifecycle_status) VALUES(c,'Owner rules native',caw_u('O'),1000,false,'chips','active');
 FOREACH n IN ARRAY ARRAY['O','S','A','P1','P2','P3','P4'] LOOP
  INSERT INTO public.profiles VALUES(caw_u(n),CASE WHEN deleted_agent AND n='A' THEN 'deleted' ELSE 'active' END);
 END LOOP;
 -- Player wallets. The owner and both agents hold player-wallet chips that no
 -- settlement may touch (rules 1, 3, 4 and 5).
 INSERT INTO public.club_members(club_id,user_id,role,chip_balance) VALUES
  (c,caw_u('O'),'owner',200),(c,caw_u('S'),'super_agent',300),(c,caw_u('A'),'agent',1000),
  (c,caw_u('P1'),'player',0),(c,caw_u('P2'),'player',0),(c,caw_u('P3'),'player',0),(c,caw_u('P4'),'player',0);
 -- Agent wallets. The owner's agent wallet must not move either.
 INSERT INTO public.agents(id,club_id,user_id,agent_wallet_balance) VALUES
  (caw_u('agentO'),c,caw_u('O'),500),(caw_u('agentS'),c,caw_u('S'),0),(caw_u('agentA'),c,caw_u('A'),0);
 t_o:=jsonb_build_object('agent_id',caw_u('agentO'),'user_id',caw_u('O'),'role','agent','rate',0.1,'agreement',jsonb_build_object('terms',jsonb_build_object('parent_agent_id','')));
 t_s1:=jsonb_build_array(
  jsonb_build_object('agent_id',caw_u('agentA'),'user_id',caw_u('A'),'role','agent','amount',30,'rate',0.3,'agreement',jsonb_build_object('terms',jsonb_build_object('parent_agent_id',caw_u('agentS')))),
  jsonb_build_object('agent_id',caw_u('agentS'),'user_id',caw_u('S'),'role','super_agent','amount',20,'rate',0.2,'agreement',jsonb_build_object('terms',jsonb_build_object('parent_agent_id',caw_u('agentO')))),
  t_o||jsonb_build_object('amount',50,'rate',0.5));
 t_s4a:=jsonb_build_array(
  jsonb_build_object('agent_id',caw_u('agentA'),'user_id',caw_u('A'),'role','agent','amount',10,'rate',0.1,'agreement',jsonb_build_object('terms',jsonb_build_object('parent_agent_id',caw_u('agentS')))),
  jsonb_build_object('agent_id',caw_u('agentS'),'user_id',caw_u('S'),'role','super_agent','amount',5,'rate',0.05,'agreement',jsonb_build_object('terms',jsonb_build_object('parent_agent_id',caw_u('agentO')))),
  t_o||jsonb_build_object('amount',5,'rate',0.05));
 INSERT INTO public.accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract) VALUES
  (caw_u('s1'),caw_u('r1'),caw_u('P1'),c,earned,100,jsonb_build_object('club_id',c,'is_union_house',false,'membership',jsonb_build_object('terms',jsonb_build_object('agent_id',caw_u('A'))),'tiers',t_s1)),
  (caw_u('s2'),caw_u('r2'),caw_u('P2'),c,earned,100,jsonb_build_object('club_id',c,'is_union_house',false,'membership',jsonb_build_object('terms',jsonb_build_object('agent_id',NULL)),'tiers',jsonb_build_array(t_o||jsonb_build_object('amount',40,'rate',0.4)))),
  (caw_u('s3'),caw_u('r3'),caw_u('P3'),c,earned,100,jsonb_build_object('club_id',c,'is_union_house',false,'membership',jsonb_build_object('terms',jsonb_build_object('agent_id',caw_u('O'))),'tiers',jsonb_build_array(t_o||jsonb_build_object('amount',10,'rate',0.1)))),
  (caw_u('s4a'),caw_u('r4a'),caw_u('P4'),c,earned,100,jsonb_build_object('club_id',c,'is_union_house',false,'membership',jsonb_build_object('terms',jsonb_build_object('agent_id',caw_u('A'))),'tiers',t_s4a)),
  (caw_u('s4b'),caw_u('r4b'),caw_u('P4'),c,earned,100,jsonb_build_object('club_id',c,'is_union_house',false,'membership',jsonb_build_object('terms',jsonb_build_object('agent_id',caw_u('O'))),'tiers',jsonb_build_array(t_o||jsonb_build_object('amount',10,'rate',0.1))));
 INSERT INTO public.agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at)
  SELECT c,(t->>'user_id')::uuid,(t->>'amount')::numeric,(t->>'rate')::numeric,'cash_rake_accrual',s.id,s.earned_at
  FROM public.accounting_cash_rake_sources s CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers') t WHERE (t->>'amount')::numeric>0;
 -- Rakeback periods and their certificates, exactly as the calculator records them.
 PERFORM caw_period('P1',jsonb_build_array(caw_alloc('s1','r1',0.09,'agent',caw_u('A'))),9,0.09,'agent',caw_u('A'),100);
 PERFORM caw_period('P2',jsonb_build_array(caw_alloc('s2','r2',0.04,'club',NULL)),4,0.04,'club',NULL,100);
 PERFORM caw_period('P3',jsonb_build_array(caw_alloc('s3','r3',0.05,'agent',caw_u('O'))),5,0.05,'agent',caw_u('O'),100);
 cid:=caw_period('P4',jsonb_build_array(caw_alloc('s4a','r4a',0.05,'agent',caw_u('A')),caw_alloc('s4b','r4b',0.05,'agent',caw_u('O'))),10,0.05,'split',NULL,200);
 INSERT INTO public.accounting_rakeback_payer_contracts(calculation_id,payer_kind,payer_entity_id,payer_user_id,amount,unrounded,rake,source_count,source_fingerprint)
  SELECT cid,p->>'payer_kind',COALESCE(NULLIF(p->>'payer_user_id','')::uuid,c),NULLIF(p->>'payer_user_id','')::uuid,(p->>'amount')::numeric,(p->>'unrounded')::numeric,(p->>'rake')::numeric,(p->>'source_count')::bigint,md5('cert-P4')
  FROM jsonb_array_elements(smarter_private.rakeback_payer_plan((SELECT source_allocations FROM public.accounting_rakeback_period_calculations WHERE id=cid),10)) p;
END $$;
CREATE FUNCTION public.caw_alloc(src text,rr text,rate numeric,kind text,payer uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('source_type','cash_rake_accrual','source_id',caw_u(src),'rake_record_id',caw_u(rr),'rake_credit',100,'rate',rate,'payer_kind',kind,'payer_user_id',payer) $$;
CREATE FUNCTION public.caw_period(player text,allocs jsonb,amt numeric,rate numeric,kind text,payer uuid,rake numeric) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE cid bigint;
BEGIN
 INSERT INTO public.rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
  VALUES(caw_u('period-'||player),caw_u(player),caw_u('club'),'2026-10-05','2026-10-11',rake,rate,amt,amt,rake,'pending');
 INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
  VALUES(caw_u('period-'||player),md5('cert-'||player),caw_u('club'),caw_u(player),NULL,'2026-10-05','2026-10-11',rake,amt,rate,kind,payer,allocs) RETURNING id INTO cid;
 RETURN cid;
END $$;
-- Every financial row a case may move; compared before and after each rolled-back case.
CREATE FUNCTION public.caw_money() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT md5(jsonb_build_object(
  'clubs',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.clubs x),
  'members',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY club_id,user_id),'[]') FROM public.club_members x),
  'agents',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.agents x),
  'ledger',(SELECT count(*) FROM public.chip_ledger),'wallet_tx',(SELECT count(*) FROM public.wallet_transactions),
  'payouts',(SELECT count(*) FROM public.rakeback_period_payouts),'runs',(SELECT count(*) FROM public.accounting_routed_settlement_runs))::text) $$;

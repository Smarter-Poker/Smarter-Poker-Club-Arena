-- Deterministic synthetic club week: one club (standalone, or a union member
-- when p_union), a three-level agent tree, players with and without agents,
-- multi-player cash hands with their sources, commission rows, private bank
-- deposits and burn legs, recognized tournaments, and one certified pending
-- rakeback period per player - the shape the weekly close reads. Every id and
-- amount is derived from md5 of a label, so two runs build byte-equal books.
CREATE OR REPLACE FUNCTION public.wcs_u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('wcs:'||p)::uuid $$;
CREATE OR REPLACE FUNCTION public.wcs_r(p text) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT (('x'||substr(md5('wcsr:'||p),1,8))::bit(32)::bigint)::numeric/4294967296 $$;
CREATE OR REPLACE FUNCTION public.wcs_generate(p_players int, p_hands int, p_union boolean DEFAULT false, p_tournaments int DEFAULT 4)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
 wf timestamptz:='2026-08-31 07:00+00'; wt timestamptz:='2026-09-07 07:00+00';
 c uuid:=wcs_u('club'); u uuid:=CASE WHEN p_union THEN wcs_u('union') END; owner uuid:=wcs_u('owner');
 h int; k int; n int; pl int; ag int; ts timestamptz; credit numeric; total numeric; rr uuid; src uuid; tiers jsonb; hist bigint:=0;
 sub_n int; agt_n int; sup_n int;
BEGIN
 PERFORM set_config('wcs.club',c::text,false);
 INSERT INTO public.accounting_cash_accrual_cutover(singleton,starts_at) VALUES(true,'2026-08-01 00:00+00');
 INSERT INTO public.clubs(id,name,owner_id,chip_treasury,is_union,union_id) VALUES(c,'Harness Club',owner,100000000,false,u);
 IF p_union THEN
  INSERT INTO public.unions(id,name,owner_id,slug) VALUES(u,'Harness Union',owner,'harness-union');
  INSERT INTO public.union_clubs(union_id,club_id) VALUES(u,c);
 END IF;
 -- agents: 2 super, 6 agents, 18 sub agents
 FOR n IN 0..25 LOOP
  INSERT INTO public.club_members(club_id,user_id,role,chip_balance)
  VALUES(c,wcs_u('agent:'||n),CASE WHEN n<2 THEN 'super_agent' WHEN n<8 THEN 'agent' ELSE 'sub_agent' END,1000000);
 END LOOP;
 FOR pl IN 0..p_players-1 LOOP
  INSERT INTO public.club_members(club_id,user_id,role,chip_balance) VALUES(c,wcs_u('player:'||pl),'player',100);
 END LOOP;
 CREATE TEMP TABLE IF NOT EXISTS wcs_src(source_type text,source_id uuid,rake_record_id uuid,player int,credit numeric,earned_at timestamptz,tournament int) ON COMMIT DROP;
 TRUNCATE wcs_src;
 FOR h IN 0..p_hands-1 LOOP
  ts:=wf+(h::numeric*604000/p_hands)*interval '1 second'+interval '100 seconds';
  rr:=wcs_u('hand:'||h); total:=0;
  FOR k IN 0..1+(h%3) LOOP
   pl:=((h*7+k*13)%p_players);
   credit:=round(0.01+wcs_r('credit:'||h||':'||k)*3,2);
   src:=wcs_u('src:'||h||':'||k);
   INSERT INTO wcs_src VALUES('cash_rake_accrual',src,rr,pl,credit,ts,NULL);
   INSERT INTO public.rake_attributions(hand_id,player_id,rake_amount,rake_record_id,club_id,weighted_rake_credit,created_at)
    VALUES(wcs_u('handid:'||h),wcs_u('player:'||pl),credit,rr,c,credit,ts);
   total:=total+credit;
  END LOOP;
  INSERT INTO public.rake_records(id,hand_id,table_id,club_id,rake_amount,created_at,is_tournament,tournament_id,metadata)
   VALUES(rr,wcs_u('handid:'||h),wcs_u('table:'||(h%9)),c,total,ts,false,NULL,jsonb_build_object('hand_number',(1000000+h)::text));
  INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan) VALUES(rr,wcs_u('handid:'||h),ts,md5(rr::text),'accrued','{}');
  IF u IS NULL THEN
   INSERT INTO public.chip_ledger(id,from_type,to_type,amount,category,club_id,created_at,status,metadata)
    VALUES(wcs_u('burn:'||h),'table_stack','chip_retirement',total,'burn',c,ts,'posted','{}');
   INSERT INTO public.accounting_cash_bank_receipts(rake_record_id,union_id,club_id,club_ledger_id,banked_at,amount) VALUES(rr,NULL,c,wcs_u('burn:'||h),ts,total);
  ELSE
   INSERT INTO public.accounting_cash_bank_receipts(rake_record_id,union_id,club_id,union_transaction_id,banked_at,amount) VALUES(rr,u,c,wcs_u('utx:'||h),ts,total);
  END IF;
 END LOOP;
 FOR n IN 0..p_tournaments-1 LOOP
  ts:=wf+((n%6)+1)*interval '1 day'+interval '3 hours'+n*interval '1 minute'; total:=0;
  FOR k IN 0..2 LOOP
   pl:=((n*11+k*5)%p_players); credit:=round(0.5+wcs_r('tcredit:'||n||':'||k)*4,2);
   INSERT INTO wcs_src VALUES('tournament_fee_accrual',wcs_u('tsrc:'||n||':'||k),wcs_u('trr:'||n||':'||k),pl,credit,ts,n);
   total:=total+credit;
  END LOOP;
  INSERT INTO public.accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,union_id,bank_club_id,union_wallet_transaction_id,bank_journal_id,source_fingerprint,plan)
   VALUES(wcs_u('tour:'||n),ts,'recognized',total,u,c,CASE WHEN u IS NOT NULL THEN wcs_u('utt:'||n) END,CASE WHEN u IS NULL THEN wcs_u('tburn:'||n) END,md5('t'||n),'{}');
  IF u IS NULL THEN
   INSERT INTO public.chip_ledger(id,from_type,from_entity_id,to_type,amount,category,club_id,created_at,status,metadata)
    VALUES(wcs_u('tburn:'||n),'prize_liability',wcs_u('tour:'||n),'chip_retirement',total,'burn',c,ts,'posted','{}');
  END IF;
 END LOOP;
 -- sources, tiers and commission rows
 FOR src,pl,credit,ts,rr,n,h IN SELECT s.source_id,s.player,s.credit,s.earned_at,s.rake_record_id,s.tournament,
   (row_number() OVER (ORDER BY s.source_type,s.source_id))::int FROM wcs_src s LOOP
  IF pl%7=0 THEN tiers:='[]';
  ELSE
   sub_n:=8+(pl%18); agt_n:=2+((sub_n-8)/3); sup_n:=(agt_n-2)/3;
   tiers:=jsonb_build_array(
    jsonb_build_object('depth',1,'role','sub_agent','agent_id',wcs_u('agentrow:'||sub_n),'user_id',wcs_u('agent:'||sub_n),'rate',0.05,'amount',round(credit*0.05,2),
     'agreement',jsonb_build_object('history_id',1000+sub_n,'terms',jsonb_build_object('parent_agent_id',wcs_u('agentrow:'||agt_n),'player_rakeback_rate',0.10))),
    jsonb_build_object('depth',2,'role','agent','agent_id',wcs_u('agentrow:'||agt_n),'user_id',wcs_u('agent:'||agt_n),'rate',0.03,'amount',round(credit*0.03,2),
     'agreement',jsonb_build_object('history_id',1000+agt_n,'terms',jsonb_build_object('parent_agent_id',wcs_u('agentrow:'||sup_n)))),
    jsonb_build_object('depth',3,'role','super_agent','agent_id',wcs_u('agentrow:'||sup_n),'user_id',wcs_u('agent:'||sup_n),'rate',0.02,'amount',round(credit*0.02,2),
     'agreement',jsonb_build_object('history_id',1000+sup_n,'terms',jsonb_build_object('parent_agent_id','')))
   );
  END IF;
  IF n IS NULL THEN
   INSERT INTO public.accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract)
   VALUES(src,rr,wcs_u('player:'||pl),c,u,u,ts,credit,jsonb_build_object('club_id',c,'player_id',wcs_u('player:'||pl),'attribution_id',wcs_u('attr:'||src),
    'union_id',u,'coordinator_union_id',u,'is_union_house',false,'rake_credit',credit,
    'membership',jsonb_build_object('history_id',h,'terms',jsonb_build_object('club_id',c,'user_id',wcs_u('player:'||pl),'status','active','is_active',true,
      'agent_id',CASE WHEN pl%7=0 THEN '' ELSE wcs_u('agent:'||(8+(pl%18)))::text END,'player_rakeback_pct',0)),'tiers',tiers));
  ELSE
   INSERT INTO public.accounting_tournament_fee_sources(id,rake_record_id,tournament_id,player_id,club_id,union_id,coordinator_union_id,game_type,registration_id,
     source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)
   VALUES(src,rr,wcs_u('tour:'||n),wcs_u('player:'||pl),c,u,u,'mtt',wcs_u('reg:'||src),wcs_u('chg:'||src),wcs_u('ent:'||src),ts-interval '1 hour',credit,
    jsonb_build_object('club_id',c,'player_id',wcs_u('player:'||pl),'union_id',u,'coordinator_union_id',u,'is_union_house',false,'rake_credit',credit,
    'membership',jsonb_build_object('history_id',h,'terms',jsonb_build_object('club_id',c,'user_id',wcs_u('player:'||pl),'status','active','is_active',true,
      'agent_id',CASE WHEN pl%7=0 THEN '' ELSE wcs_u('agent:'||(8+(pl%18)))::text END,'player_rakeback_pct',0)),'tiers',tiers));
   INSERT INTO public.accounting_tournament_recognized_sources(source_id,tournament_id,recognized_at,disposition,rake_credit) VALUES(src,wcs_u('tour:'||n),ts,'earned',credit);
  END IF;
  INSERT INTO public.agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at)
  SELECT c,(t->>'user_id')::uuid,(t->>'amount')::numeric,(t->>'rate')::numeric,CASE WHEN n IS NULL THEN 'cash_rake_accrual' ELSE 'tournament_fee_accrual' END,src,ts
  FROM jsonb_array_elements(tiers) t WHERE (t->>'amount')::numeric>0;
 END LOOP;
 -- certified pending periods (club payer for players without an agent)
 INSERT INTO public.rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
 SELECT wcs_u('period:'||s.player),wcs_u('player:'||s.player),c,'2026-08-31','2026-09-06',sum(s.credit),
  CASE WHEN sum(s.credit)>0 THEN round(sum(s.credit*0.10)/sum(s.credit),4) ELSE 0 END,round(sum(s.credit*0.10),2),round(sum(s.credit*0.10),2),sum(s.credit),'pending'
 FROM wcs_src s GROUP BY s.player;
 INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,
  rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
 SELECT wcs_u('period:'||s.player),md5('fp:'||s.player),c,wcs_u('player:'||s.player),u,'2026-08-31','2026-09-06',sum(s.credit),round(sum(s.credit*0.10),2),
  CASE WHEN sum(s.credit)>0 THEN round(sum(s.credit*0.10)/sum(s.credit),4) ELSE 0 END,
  CASE WHEN s.player%7=0 THEN 'club' ELSE 'agent' END,CASE WHEN s.player%7=0 THEN NULL ELSE wcs_u('agent:'||(8+(s.player%18))) END,
  jsonb_agg(jsonb_build_object('source_type',s.source_type,'source_id',s.source_id,'rake_record_id',s.rake_record_id,'rake_credit',s.credit,'rate',0.10,
   'unrounded_rakeback',s.credit*0.10,'earned_at',s.earned_at,'payer_kind',CASE WHEN s.player%7=0 THEN 'club' ELSE 'agent' END,
   'payer_user_id',CASE WHEN s.player%7=0 THEN NULL ELSE wcs_u('agent:'||(8+(s.player%18))) END) ORDER BY s.earned_at,s.source_type,s.rake_record_id,s.source_id)
 FROM wcs_src s GROUP BY s.player;
 INSERT INTO public.settlement_periods(id,club_id,union_id,period_number,year,start_at,end_at,status) VALUES(wcs_u('sp'),c,u,36,2026,wf,wt,'settled');
END $$;

-- Independently fixed board, not calculated by either settlement implementation.
-- Contract tiers are deepest first. Own amounts 100+80+50 imply gross230,180,100.
CREATE FUNCTION public.dr_seed(player_deleted boolean DEFAULT false, n_players integer DEFAULT 1) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c uuid:=dr_u('club'); pl uuid; src uuid; rr uuid; tiers jsonb; n integer; amount numeric:=90/n_players;
BEGIN
 INSERT INTO public.accounting_cash_accrual_cutover(singleton,starts_at) VALUES(true,'2026-08-01');
 INSERT INTO public.clubs(id,name,owner_id,chip_treasury,is_union,asset,lifecycle_status) VALUES(c,'Deleted routed native',dr_u('owner'),1000,false,'chips','active');
 FOR n IN 1..3 LOOP
  INSERT INTO public.profiles VALUES(dr_u('agent'||n),'deleted');
  INSERT INTO public.club_members(club_id,user_id,role,chip_balance,membership_lifecycle_status,departed_at,departure_reason,is_active,status)
  VALUES(c,dr_u('agent'||n),(ARRAY['super_agent','agent','sub_agent'])[n],0,'departed','2026-10-13','native',false,'inactive');
 END LOOP;
 tiers:=jsonb_build_array(
 jsonb_build_object('agent_id',dr_u('agentrow3'),'user_id',dr_u('agent3'),'role','sub_agent','amount',100,'rate',0.1,'agreement',jsonb_build_object('terms',jsonb_build_object('parent_agent_id',dr_u('agentrow2')))),
 jsonb_build_object('agent_id',dr_u('agentrow2'),'user_id',dr_u('agent2'),'role','agent','amount',80,'rate',0.08,'agreement',jsonb_build_object('terms',jsonb_build_object('parent_agent_id',dr_u('agentrow1')))),
 jsonb_build_object('agent_id',dr_u('agentrow1'),'user_id',dr_u('agent1'),'role','super_agent','amount',50,'rate',0.05,'agreement',jsonb_build_object('terms',jsonb_build_object('parent_agent_id',''))));
 FOR n IN 1..n_players LOOP
  pl:=dr_u('player'||n);src:=dr_u('source'||n);rr:=dr_u('rake'||n);
  INSERT INTO public.profiles VALUES(pl,CASE WHEN player_deleted THEN 'deleted' ELSE 'active' END);
  INSERT INTO public.club_members(club_id,user_id,role,chip_balance) VALUES(c,pl,'player',0);
  INSERT INTO public.accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract)
  VALUES(src,rr,pl,c,'2026-10-06 12:00+00',1000/n_players,jsonb_build_object('club_id',c,'is_union_house',false,
   'membership',jsonb_build_object('terms',jsonb_build_object('agent_id',dr_u('agent3'))),'tiers',CASE WHEN n=1 THEN tiers ELSE '[]'::jsonb END));
  IF n=1 THEN INSERT INTO public.agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at)
   SELECT c,(t->>'user_id')::uuid,(t->>'amount')::numeric,(t->>'rate')::numeric,'cash_rake_accrual',src,'2026-10-06 12:00+00' FROM jsonb_array_elements(tiers) t; END IF;
  INSERT INTO public.rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
   VALUES(dr_u('period'||n),pl,c,'2026-10-05','2026-10-11',1000/n_players,0.09,amount,amount,1000/n_players,'pending');
  INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
   VALUES(dr_u('period'||n),md5('source'||n),c,pl,NULL,'2026-10-05','2026-10-11',1000/n_players,amount,0.09,'agent',dr_u('agent3'),jsonb_build_array(jsonb_build_object('source_type','cash_rake_accrual','source_id',src,'rake_record_id',rr,'rake_credit',1000/n_players,'rate',0.09,'payer_kind','agent','payer_user_id',dr_u('agent3'))));
 END LOOP;
END $$;

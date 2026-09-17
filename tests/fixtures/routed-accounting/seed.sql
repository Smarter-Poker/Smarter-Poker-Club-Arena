SET timezone='UTC';
INSERT INTO unions VALUES(u(1));
INSERT INTO union_settlement_floor VALUES(u(1),'2026-09-07');
INSERT INTO accounting_cash_accrual_cutover VALUES(true,'2026-09-07T07:00:00Z');
INSERT INTO union_clubs VALUES(u(1),u(11));
INSERT INTO clubs VALUES(u(11),200);
INSERT INTO agents VALUES(u(101),u(11),u(201),'sub_agent',u(102),0.2,'active'),(u(102),u(11),u(202),'agent',u(103),0.1,'active'),(u(103),u(11),u(203),'super_agent',NULL,0.1,'active');
INSERT INTO club_members(club_id,user_id,chip_balance,agent_id) VALUES(u(11),u(201),0,NULL),(u(11),u(202),0,NULL),(u(11),u(203),0,NULL),
 (u(11),u(301),0,u(999)),(u(11),u(302),0,u(999)),(u(11),u(303),0,u(999));
-- Current membership deliberately disagrees with historical payer. The source is authoritative.
INSERT INTO accounting_cash_rake_sources VALUES
 (u(401),u(501),u(301),u(11),u(1),u(1),'2026-09-08',100,jsonb_build_object('club_id',u(11),'membership',jsonb_build_object('terms',jsonb_build_object('agent_id',u(201))),
  'tiers',jsonb_build_array(tier(101,201,102,'sub_agent',20,.2),tier(102,202,103,'agent',0,0),tier(103,203,NULL,'super_agent',8,.1)))),
 (u(402),u(502),u(302),u(11),NULL,u(1),'2026-09-09',50,jsonb_build_object('club_id',u(11),'membership',jsonb_build_object('terms',jsonb_build_object('agent_id',u(201))),
  'tiers',jsonb_build_array(tier(101,201,102,'sub_agent',10,.2),tier(102,202,103,'agent',4,.1),tier(103,203,NULL,'super_agent',3.6,.1)))),
 (u(403),u(503),u(303),u(11),NULL,u(1),'2026-09-10',20,jsonb_build_object('club_id',u(11),'membership',jsonb_build_object('terms',jsonb_build_object('agent_id',NULL)),'tiers','[]'::jsonb));
INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at)
 SELECT s.club_id,(t->>'user_id')::uuid,(t->>'amount')::numeric,(t->>'rate')::numeric,'cash_rake_accrual',s.id,s.earned_at
 FROM accounting_cash_rake_sources s CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers')t WHERE (t->>'amount')::numeric>0;
INSERT INTO rakeback_periods SELECT u(600+n),u(300+n),u(11),'2026-09-07','2026-09-13',rake,rate,round(rake*rate,2),'pending',NULL,round(rake*rate,2),rake
 FROM (VALUES(1,100::numeric,.10::numeric),(2,50,.10),(3,20,.05))x(n,rake,rate);
INSERT INTO accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
 SELECT rp.id,'fixture:'||rp.id::text,rp.club_id,rp.user_id,u(1),rp.period_start,rp.period_end,rp.rake_generated,rp.rakeback_amount,rp.rakeback_rate,
  CASE WHEN s.player_id=u(303) THEN 'club' ELSE 'agent' END,CASE WHEN s.player_id=u(303) THEN NULL ELSE u(201) END,
  jsonb_build_array(jsonb_build_object('source_type','cash_rake_accrual','source_id',s.id,'rake_record_id',s.rake_record_id,'rake_credit',s.rake_credit,'rate',rp.rakeback_rate,
   'payer_kind',CASE WHEN s.player_id=u(303) THEN 'club' ELSE 'agent' END,'payer_user_id',CASE WHEN s.player_id=u(303) THEN NULL ELSE u(201) END))
 FROM rakeback_periods rp JOIN accounting_cash_rake_sources s ON s.player_id=rp.user_id;

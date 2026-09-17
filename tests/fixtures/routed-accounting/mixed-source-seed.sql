-- The cash UUID and tournament UUID intentionally collide. Source type is identity.
INSERT INTO accounting_tournament_fee_sources VALUES(u(401),u(801),u(701),u(301),u(11),u(1),u(1),'2026-09-01',40,
 jsonb_build_object('club_id',u(11),'terms_at','2026-09-01','membership',jsonb_build_object('terms',jsonb_build_object('agent_id',u(201))),
 'tiers',jsonb_build_array(tier(101,201,102,'sub_agent',8,.2),tier(102,202,103,'agent',3.2,.1),tier(103,203,NULL,'super_agent',2.88,.1))));
INSERT INTO accounting_tournament_fee_recognitions VALUES(u(701),'2026-09-10','recognized',40,u(1));
INSERT INTO accounting_tournament_recognized_sources VALUES(u(401),u(701),'2026-09-10','earned',40);
INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at)
 SELECT s.club_id,(t->>'user_id')::uuid,(t->>'amount')::numeric,(t->>'rate')::numeric,'tournament_fee_accrual',s.id,r.recognized_at
 FROM accounting_tournament_fee_sources s JOIN accounting_tournament_recognized_sources r ON r.source_id=s.id CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers')t;
UPDATE accounting_rakeback_period_calculations c SET source_allocations=(SELECT jsonb_agg(a||jsonb_build_object('source_type','cash_rake_accrual')) FROM jsonb_array_elements(c.source_allocations)a);
UPDATE rakeback_periods SET rake_generated=140,total_rake_paid=140,rakeback_amount=14,rakeback_earned=14 WHERE id=u(601);
UPDATE accounting_rakeback_period_calculations SET rake_generated=140,rakeback_amount=14,source_fingerprint='fixture:mixed:601',source_allocations=source_allocations||jsonb_build_array(jsonb_build_object('source_type','tournament_fee_accrual','source_id',u(401),'rake_record_id',u(801),'rake_credit',40,'rate',.1,'payer_kind','agent','payer_user_id',u(201))) WHERE period_id=u(601);

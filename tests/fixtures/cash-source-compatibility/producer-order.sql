-- These are the actual producer's bank and attribution writes, then the
-- actual compatibility wrapper, in the same transaction and original order.
INSERT INTO tables VALUES(u(230),true,NULL),(u(240),false,u(20));
INSERT INTO hand_history(id,table_id,hand_number,started_at) VALUES(u(231),u(230),1000010,now()-interval '1 minute'),(u(241),u(240),1000011,now()-interval '1 minute');
INSERT INTO table_seats VALUES(u(240),u(12),u(10),now()-interval '2 minutes',NULL);
BEGIN;
SELECT * FROM atomic_distribute_rake(u(230),u(40),u(231),1000010,1,0,20,1,jsonb_build_object(u(41)::text,20),NULL,NULL,'WEIGHTED_CONTRIBUTED');
SELECT calculate_cascading_commission(u(231),u(40),u(41),20,NULL,u(230));
COMMIT;
SELECT assert_true(EXISTS(SELECT 1 FROM accounting_cash_source_work w JOIN rake_records r ON r.id=w.rake_record_id WHERE r.hand_id=u(231) AND w.status='accrued') AND EXISTS(SELECT 1 FROM rakeback_stats_applied a JOIN rake_records r ON r.id=a.rake_record_id WHERE r.hand_id=u(231) AND a.user_id=u(41) AND a.hands=1 AND a.rake=1),'actual private producer completes canonical no-agent source in original same-transaction order');
BEGIN;
SELECT * FROM atomic_distribute_rake(u(240),u(20),u(241),1000011,1,0,20,1,jsonb_build_object(u(12)::text,20),NULL,NULL,'WEIGHTED_CONTRIBUTED');
SELECT calculate_cascading_commission(u(241),u(20),u(12),20,NULL,u(240));
COMMIT;
SELECT assert_true(EXISTS(SELECT 1 FROM accounting_cash_source_work w JOIN rake_records r ON r.id=w.rake_record_id WHERE r.hand_id=u(241) AND w.status='accrued') AND (SELECT count(*) FROM agent_commissions ac JOIN accounting_cash_rake_sources s ON s.id=ac.source_id JOIN rake_records r ON r.id=s.rake_record_id WHERE r.hand_id=u(241))=3,'actual union producer bank and seat attribution precede canonical whole-hierarchy compatibility accrual');
SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE proname IN('credit_agent_commission_from_rake','calculate_cascading_commission');

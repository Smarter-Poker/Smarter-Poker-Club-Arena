-- Optional local scalability evidence. All generated rows and results roll back.
BEGIN;
SELECT set_config('test.engine','true',true);
INSERT INTO rake_records(id,hand_id,club_id,table_id,rake_amount,is_tournament,created_at,metadata)
 SELECT u(n),u(n+100000),u(30),u(401),0.01,false,'2026-08-04Z','{}' FROM generate_series(50001,70000)n;
INSERT INTO rake_attributions(id,rake_record_id,hand_id,player_id,club_id,weighted_rake_credit)
 SELECT u(n+200000),u(n),u(n+100000),u(503),u(20),0.01 FROM generate_series(50001,70000)n;
INSERT INTO accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan)
 SELECT u(n),u(n+100000),'2026-08-04Z','benchmark'||n,'accrued','{}' FROM generate_series(50001,70000)n;
INSERT INTO accounting_cash_rake_sources(rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract)
 SELECT u(n),u(503),u(20),u(40),u(40),'2026-08-04Z',0.01,
  jsonb_build_object('player_id',u(503),'club_id',u(20),'attribution_id',u(n+200000),'rake_credit',0.01,
   'union_id',u(40),'coordinator_union_id',u(40),'tiers','[]'::jsonb,
   'membership',fn_accounting_terms_at('club_members',u(20)::text||':'||u(503)::text,'2026-08-04Z'))
 FROM generate_series(50001,70000)n;
ANALYZE rake_records;ANALYZE rake_attributions;ANALYZE accounting_cash_rake_sources;
DO $benchmark$
DECLARE started timestamptz:=clock_timestamp(); result jsonb;
BEGIN
 result:=fn_rakeback_recompute_periods(u(20),'2026-08-03','2026-08-09');
 PERFORM assert_true(result->>'status'='ready' AND result->>'written'='1','20,000-source weekly writer completes with one certified period');
 PERFORM assert_true((SELECT rake_generated=200 AND rakeback_amount=20 FROM rakeback_periods WHERE club_id=u(20) AND period_start='2026-08-03'),'20,000 small source credits conserve weekly entitlement');
 RAISE NOTICE 'BENCHMARK: 20,000 source credits processed in % seconds',extract(epoch FROM clock_timestamp()-started);
END $benchmark$;
ROLLBACK;

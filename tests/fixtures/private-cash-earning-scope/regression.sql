-- UNRUN. Protected native input appended after the existing cash compatibility
-- producer fixtures, then forward component20260914160000. Do not execute directly.
-- Uses actual atomic_distribute_rake, allocator, shared planner and source worker.
BEGIN;
CREATE TEMP TABLE private_scope_baseline AS SELECT
 (SELECT chip_treasury FROM clubs WHERE id=u(40)) AS treasury,
 (SELECT COALESCE(sum(rake_wallet),0) FROM union_wallets) AS union_bank;
INSERT INTO tables(id,is_private,union_id) VALUES
 (u(8000),true,NULL),(u(8010),false,NULL),(u(8020),true,NULL),
 (u(8030),true,NULL),(u(8040),false,NULL),(u(8050),true,NULL);
INSERT INTO hand_history(id,table_id,hand_number,started_at) VALUES
 (u(8001),u(8000),1000800,now()-interval '1 minute'),
 (u(8011),u(8010),1000801,now()-interval '1 minute'),
 (u(8021),u(8020),1000802,now()-interval '1 minute'),
 (u(8031),u(8030),1000803,NULL),
 (u(8041),u(8040),1000804,now()-interval '1 minute'),
 (u(8051),u(8050),1000805,now()-interval '1 minute');
INSERT INTO table_seats(table_id,user_id,club_id,joined_at,left_at) VALUES
 (u(8000),u(12),u(10),now()-interval '2 minutes',now()-interval '30 seconds'),
 (u(8000),u(12),u(40),now()-interval '20 seconds',NULL),
 (u(8020),u(41),u(40),now()-interval '2 minutes',NULL),
 (u(8040),u(12),u(10),now()-interval '2 minutes',NULL),
 (u(8040),u(12),u(40),now()-interval '2 minutes',NULL),
 (u(8050),u(12),u(10),now()-interval '2 minutes',NULL),
 (u(8050),u(12),NULL,now()-interval '2 minutes',NULL);
SELECT assert_true(fn_cash_earning_club(u(8001),u(8000),u(12),u(40),NULL)=u(10),
 'private earning club preserves the prior funded seat instead of host or later re-seat');
SELECT assert_true(fn_cash_earning_club(u(8011),u(8010),u(13),u(40),NULL) IS NULL,
 'missing standalone seat stays unknown despite available current membership');
SELECT assert_true(fn_cash_earning_club(u(8031),u(8030),u(12),u(40),NULL) IS NULL,
 'missing private hand-start evidence stays unknown without aborting bank completion');
SELECT assert_true(fn_cash_earning_club(u(8041),u(8040),u(12),u(40),NULL) IS NULL
 AND fn_cash_earning_club(u(8051),u(8050),u(12),u(40),NULL) IS NULL,
 'overlapping different or unknown seat clubs cannot become private host attribution');
SELECT assert_true(refuses('SELECT fn_cash_earning_club(u(8011),u(8010),u(13),u(20),u(20))','23514')
 AND refuses('SELECT fn_cash_earning_club(u(8041),u(8040),u(12),u(20),u(20))','23514'),
 'shared union missing and ambiguous seat contracts retain their existing strict refusal');

CREATE TEMP TABLE private_scope_cases(table_id uuid,hand_id uuid,hand_number int,player_id uuid,expected_club uuid,expected_reason text);
INSERT INTO private_scope_cases VALUES
 (u(8000),u(8001),1000800,u(12),u(10),'cash_commission_earning_club_not_observed'),
 (u(8010),u(8011),1000801,u(13),NULL,'cash_commission_attribution_incomplete'),
 (u(8020),u(8021),1000802,u(41),u(40),NULL),
 (u(8030),u(8031),1000803,u(12),NULL,'cash_commission_attribution_incomplete'),
 (u(8040),u(8041),1000804,u(12),NULL,'cash_commission_attribution_incomplete'),
 (u(8050),u(8051),1000805,u(12),NULL,'cash_commission_attribution_incomplete');
CREATE TEMP TABLE private_scope_bank AS SELECT c.hand_id,b.* FROM private_scope_cases c
 CROSS JOIN LATERAL atomic_distribute_rake(c.table_id,u(40),c.hand_id,c.hand_number,1,0,20,1,
  jsonb_build_object(c.player_id::text,20),NULL,NULL,'WEIGHTED_CONTRIBUTED') b;
SELECT assert_true(count(*)=6 AND bool_and(applied AND spendable_route='chip_retirement' AND spendable_amount=0 AND club_net_credit=0 AND union_id_out IS NULL),
 'all six rake dispositions retire chips without spendable credit, including unsupported earning scope') FROM private_scope_bank;
SELECT assert_true(count(*)=6 AND bool_and(a.club_id IS NOT DISTINCT FROM c.expected_club)
 AND sum(a.weighted_rake_credit)=6,'original allocator credits survive with observed or explicit unknown earning club')
 FROM private_scope_cases c JOIN rake_attributions a ON a.hand_id=c.hand_id;
SELECT assert_true((SELECT chip_treasury FROM clubs WHERE id=u(40))=(SELECT treasury FROM private_scope_baseline)
 AND (SELECT COALESCE(sum(rake_wallet),0) FROM union_wallets)=(SELECT union_bank FROM private_scope_baseline),
 'seat attribution never credits club treasury or Union wallet for private cash');
SELECT assert_true(count(*)=6 AND count(DISTINCT b.club_ledger_id)=6 AND sum(b.amount)=6
 AND bool_and(b.club_id=u(40) AND b.union_id IS NULL AND l.from_type='table_stack' AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL AND l.category='burn' AND l.amount=b.amount AND l.created_at=b.banked_at),
 'each original private cash operation keeps exactly one immutable retirement receipt')
 FROM private_scope_bank k JOIN accounting_cash_bank_receipts b ON b.rake_record_id=k.rake_record_id JOIN chip_ledger l ON l.id=b.club_ledger_id;

CREATE TEMP TABLE private_scope_processed AS SELECT b.hand_id,fn_process_cash_accounting_source(b.rake_record_id) AS result FROM private_scope_bank b;
SELECT assert_true(count(*)=5 AND bool_and((r.result->>'status'='blocked' AND r.result->>'reason'=c.expected_reason
 AND r.result->'credits'='[]'::jsonb AND r.result->>'recorded'='true') IS TRUE),
 'unsupported observed and unknown private scope becomes durable Q refusal after retirement')
 FROM private_scope_processed r JOIN private_scope_cases c USING(hand_id) WHERE c.expected_reason IS NOT NULL;
SELECT assert_true(result->>'status'='accrued' AND jsonb_array_length(result->'credits')=1
 AND result->'credits'->0->>'club_id'=u(40)::text,'proved same-club private source still accrues through the one shared writer')
 FROM private_scope_processed WHERE hand_id=u(8021);
SELECT assert_true(count(*)=6 AND bool_and((w.receipt_id=(r.result->>'receipt_id')::uuid AND a.result=r.result) IS TRUE),
 'every batch outcome names its actual durable source/work receipt')
 FROM private_scope_processed r JOIN private_scope_bank b USING(hand_id)
 JOIN accounting_cash_source_work w ON w.rake_record_id=b.rake_record_id JOIN accounting_cash_source_receipts a ON a.id=w.receipt_id;
SELECT assert_true(NOT EXISTS(SELECT 1 FROM private_scope_cases c JOIN rake_records r ON r.hand_id=c.hand_id
 JOIN accounting_cash_rake_sources s ON s.rake_record_id=r.id WHERE c.expected_reason IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM private_scope_cases c JOIN rake_records r ON r.hand_id=c.hand_id
 JOIN rakeback_stats_applied s ON s.rake_record_id=r.id WHERE c.expected_reason IS NOT NULL),
 'blocked scope creates no guessed commission source or player statistic');
CREATE TEMP TABLE private_scope_rebank AS SELECT c.hand_id,b.* FROM private_scope_cases c
 CROSS JOIN LATERAL atomic_distribute_rake(c.table_id,u(40),c.hand_id,c.hand_number,1,0,20,1,
  jsonb_build_object(c.player_id::text,20),NULL,NULL,'WEIGHTED_CONTRIBUTED') b;
SELECT assert_true(count(*)=6 AND bool_and(already_processed AND NOT applied)
 AND (SELECT chip_treasury FROM clubs WHERE id=u(40))=(SELECT treasury FROM private_scope_baseline),
 'source replay neither rewrites unknown attribution nor duplicates a retirement') FROM private_scope_rebank;
CREATE TEMP TABLE private_scope_retry AS SELECT b.hand_id,fn_process_cash_accounting_source(b.rake_record_id) AS result FROM private_scope_bank b;
SELECT assert_true(count(*)=5 AND bool_and((r.result->>'status'='blocked' AND r.result->>'reason'=c.expected_reason
 AND r.result->>'attempt'='2') IS TRUE),'Q retry keeps unsupported scope explicit without reassigning its club')
 FROM private_scope_retry r JOIN private_scope_cases c USING(hand_id) WHERE c.expected_reason IS NOT NULL;
SELECT assert_true(result->>'duplicate'='true' AND (SELECT count(*) FROM rakeback_stats_applied s
 JOIN rake_records r ON r.id=s.rake_record_id WHERE r.hand_id=u(8021))=1,
 'healthy private retry returns its one source and one original statistic') FROM private_scope_retry WHERE hand_id=u(8021);
ROLLBACK;

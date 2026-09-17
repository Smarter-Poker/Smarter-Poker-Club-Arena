BEGIN;
SELECT test_source(801,501,10,10,'2026-08-25Z');
SELECT test_fee_source(802,501,10,15,'2026-08-18Z',40,40,(SELECT id FROM accounting_cash_rake_sources WHERE rake_record_id=u(801)));
SELECT test_fee_recognition(802,'2026-08-26Z');
CREATE TEMP TABLE mixed_result AS SELECT fn_rakeback_recompute_periods(u(10),'2026-08-24','2026-08-30',NULL) result;
SELECT assert_true((SELECT result->>'status'='ready' AND result->>'request_state'='complete' AND result->>'written'='1' FROM mixed_result),'one durable full-week request certifies cash plus recognized tournament fees');
SELECT assert_true((SELECT rake_generated=25 AND rakeback_amount=5 AND rakeback_rate=.2 FROM rakeback_periods WHERE club_id=u(10) AND period_start='2026-08-24'),'mixed player liability uses exact source sums and the recorded negotiated rate');
SELECT assert_true((SELECT count(DISTINCT a->>'source_type')=2 AND count(DISTINCT a->>'source_id')=1 FROM accounting_rakeback_period_calculations c CROSS JOIN LATERAL jsonb_array_elements(c.source_allocations)a WHERE c.club_id=u(10) AND c.period_start='2026-08-24'),'the certificate preserves typed source identity when cash and tournament UUIDs collide');
SELECT assert_true((SELECT bool_and((a->>'earned_at')::timestamptz='2026-08-26Z' AND (a->>'agreement_at')::timestamptz='2026-08-18Z') FROM accounting_rakeback_period_calculations c CROSS JOIN LATERAL jsonb_array_elements(c.source_allocations)a WHERE c.period_start='2026-08-24' AND a->>'source_type'='tournament_fee_accrual'),'tournament allocation exposes separate recognition and agreement timestamps');
SELECT assert_true(fn_rakeback_recompute_periods(u(10),'2026-08-24','2026-08-30')->>'written'='0' AND (SELECT count(*)=1 FROM accounting_rakeback_period_calculations WHERE period_start='2026-08-24'),'mixed source retry keeps the exact same immutable certificate');
ROLLBACK;
BEGIN;
SELECT test_fee_source(811,501,10,10,'2026-08-18Z');
SELECT assert_true(fn_rakeback_recompute_periods(u(10),'2026-08-17','2026-08-23')->>'status'='ready'
 AND NOT EXISTS(SELECT 1 FROM rakeback_periods WHERE club_id=u(10) AND period_start='2026-08-17'),'open captured fees create no premature rebate in the charge week');
INSERT INTO accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 VALUES('club_members',u(10)::text||':'||u(501)::text,u(10),u(501),'UPDATE','2026-08-24Z',jsonb_build_object('club_id',u(10),'user_id',u(501),'agent_id',u(511),'is_active',true,'status','active','player_rakeback_pct',.4));
SELECT test_fee_recognition(811,'2026-09-01Z');SELECT test_source(812,501,10,10,'2026-09-02Z');
CREATE TEMP TABLE later_result AS SELECT fn_rakeback_recompute_periods(u(10),'2026-08-31','2026-09-06') result;
SELECT assert_true((SELECT result->>'status'='ready' FROM later_result)
 AND (SELECT rake_generated=20 AND rakeback_amount=6 AND rakeback_rate=.3 FROM rakeback_periods WHERE club_id=u(10) AND period_start='2026-08-31'),'later recognition joins its own week while earlier fee and later cash retain different observed deals');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM rakeback_periods WHERE club_id=u(10) AND period_start='2026-08-17'),'recognition never backfills a historical charge-week payment');
ROLLBACK;
BEGIN;
SELECT test_fee_source(821,503,20,10,'2026-08-18Z');
INSERT INTO rake_records(id,club_id,rake_amount,is_tournament,tournament_id,created_at,metadata,source)
 VALUES(u(822),u(30),-10,true,u(1821),'2026-08-19Z',jsonb_build_object('user_id',u(503),'original_rake_record_id',u(821)),'fn_unregister_from_tournament');
INSERT INTO tournament_unregistration_receipts VALUES(u(1821),u(503),ARRAY[u(822)],ARRAY[u(821)]);
INSERT INTO tournament_cancellation_receipts VALUES(u(1821),'2026-08-25Z','{}',0,0,0);
SELECT test_fee_recognition(821,'2026-08-25Z','cancelled');
SELECT assert_true(fn_accounting_tournament_week_quality(u(20),'2026-08-24Z','2026-08-31Z')->>'status'='ready','full refund cancellation passes the actual immutable net-source proof');
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30')->>'status'='ready'
 AND NOT EXISTS(SELECT 1 FROM rakeback_periods WHERE club_id=u(20)),'refunded fee sources create no weekly rake or rebate liability');
ROLLBACK;
BEGIN;
SELECT test_fee_source(831,503,20,10,'2026-08-18Z');SELECT test_fee_recognition(831,'2026-08-25Z','banked_accrual_deferred');
CREATE TEMP TABLE deferred_result AS SELECT fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30') result;
SELECT assert_true((SELECT result->>'status'='blocked' AND result->>'reason'='tournament_recognition_deferred' AND result->>'request_state'='blocked' FROM deferred_result),'deferred terminal recognition blocks its whole actual week with a durable failure receipt');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM rakeback_periods WHERE club_id=u(20)) AND NOT EXISTS(SELECT 1 FROM accounting_rakeback_period_calculations WHERE club_id=u(20)),'deferred evidence writes no partial player liabilities');
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-17','2026-08-23')->>'status'='ready','a later deferred recognition does not rewrite its earlier charge week');
ROLLBACK;
BEGIN;
INSERT INTO rake_records(id,club_id,rake_amount,is_tournament,tournament_id,created_at,metadata,source) VALUES(u(841),u(99),5,true,u(1841),'2026-08-18Z','{}','legacy');
INSERT INTO tournament_rake_settlements VALUES(u(1841),u(99),NULL,5,'2026-08-25Z');
INSERT INTO accounting_tournament_fee_recognitions VALUES(u(1841),'2026-08-25Z','banked_accrual_deferred',5,NULL,u(99),'unknown','{}');
SELECT assert_true(fn_accounting_tournament_week_quality(u(20),'2026-08-24Z','2026-08-31Z')->>'unknown_scope'='true'
 AND fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30')->>'reason'='tournament_recognition_deferred','private legacy fees without historical scope cannot silently become someone else standalone income');
ROLLBACK;
BEGIN;
SELECT test_fee_source(851,503,20,10,'2026-08-18Z');
INSERT INTO tournament_terminal_settlements VALUES(u(1851),'2026-08-25Z','2026-08-25Z');
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30')->>'reason'='tournament_terminal_recognition_missing','durable normal completion without bank or recognition blocks its terminal week');
ROLLBACK;
BEGIN;
SELECT test_fee_source(861,503,20,10,'2026-08-18Z');INSERT INTO tournament_satellite_settlements VALUES(u(1861),'2026-08-25Z');
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30')->>'reason'='tournament_terminal_recognition_missing','durable satellite completion without recognition cannot disappear from the weekly book');
ROLLBACK;
BEGIN;
SELECT test_fee_source(871,503,20,10,'2026-08-18Z');SELECT test_fee_recognition(871,'2026-08-25Z');
UPDATE accounting_tournament_recognized_sources SET rake_credit=9 WHERE tournament_id=u(1871);
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30')->>'reason'='tournament_recognized_source_receipts_incomplete','recognized fee amount drift cannot produce a subset certificate');
ROLLBACK;
BEGIN;
SELECT test_fee_source(881,503,20,10,'2026-08-18Z');SELECT test_fee_recognition(881,'2026-08-25Z');
UPDATE tournament_rake_settlements SET settled_at='2026-09-01Z' WHERE tournament_id=u(1881);
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30')->>'reason'='tournament_recognition_bank_disagrees'
 AND fn_rakeback_recompute_periods(u(20),'2026-08-31','2026-09-06')->>'reason'='tournament_recognition_bank_disagrees','mismatched bank and recognition times block both implicated weeks');
ROLLBACK;
BEGIN;
SELECT test_fee_source(891,501,10,10,'2026-08-18Z');
INSERT INTO accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 VALUES('club_members',u(10)::text||':'||u(501)::text,u(10),u(501),'UPDATE','2026-08-24Z',jsonb_build_object('club_id',u(10),'user_id',u(501),'agent_id',u(511),'is_active',true,'status','active','player_rakeback_pct',.4));
UPDATE accounting_tournament_fee_sources SET contract=jsonb_set(contract,'{membership}',fn_accounting_terms_at('club_members',u(10)::text||':'||u(501)::text,'2026-08-25Z')) WHERE tournament_id=u(1891);
SELECT test_fee_recognition(891,'2026-09-01Z');
SELECT assert_true(fn_rakeback_recompute_periods(u(10),'2026-08-31','2026-09-06')->>'reason'='period_membership_contract_invalid','an agreement first observed after fee charge cannot replace the original charge-time membership');
ROLLBACK;
BEGIN;
INSERT INTO accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 VALUES('agents',u(901)::text,u(10),u(511),'UPDATE','2026-08-01Z',jsonb_build_object('id',u(901),'club_id',u(10),'user_id',u(511),'status','active','commission_rate',0,'player_rakeback_rate',.2));
SELECT test_fee_source(901,501,10,10,'2026-08-18Z');SELECT test_fee_recognition(901,'2026-08-25Z');
CREATE TEMP TABLE zero_cap_result AS SELECT fn_rakeback_recompute_periods(u(10),'2026-08-24','2026-08-30') result;
SELECT assert_true((SELECT result->>'status'='ready' FROM zero_cap_result)
 AND (SELECT rakeback_amount=2 FROM rakeback_periods WHERE club_id=u(10) AND period_start='2026-08-24'),'audit evidence preserves the installed zero-agent-cap behavior pending an explicit commercial decision');
ROLLBACK;
BEGIN;
SELECT test_fee_source(911,503,20,10,'2026-08-18Z');SELECT test_fee_recognition(911,'2026-08-25Z');
DELETE FROM accounting_tournament_fee_recognitions WHERE tournament_id=u(1911);
INSERT INTO tournament_terminal_settlements VALUES(u(1911),'2026-09-01Z','2026-09-01Z');
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30')->>'reason'='tournament_terminal_recognition_missing'
 AND fn_rakeback_recompute_periods(u(20),'2026-08-31','2026-09-06')->>'status'='ready','original bank timing governs missing recognition even when terminal completion occurs later');
ROLLBACK;
SELECT assert_true(NOT has_function_privilege('service_role','fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)','EXECUTE')
 AND NOT has_function_privilege('service_role','fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])','EXECUTE'),'mixed quality and calculation remain private behind the unchanged durable request wrapper');
BEGIN;
SELECT test_fee_source(921,501,10,10,'2026-08-18Z',NULL,NULL);SELECT test_fee_recognition(921,'2026-08-25Z','banked_accrual_deferred');
SELECT assert_true(fn_accounting_tournament_week_quality(u(20),'2026-08-24Z','2026-08-31Z')->>'status'='ready','a deferred private fee with complete observed standalone scope does not block an unrelated club');
SELECT assert_true(fn_accounting_tournament_week_quality(u(10),'2026-08-24Z','2026-08-31Z')->>'reason'='tournament_recognition_deferred'
 AND fn_accounting_tournament_week_quality(u(10),'2026-08-24Z','2026-08-31Z')->>'unknown_scope'='false','known standalone scope remains blocked only for its own unresolved terminal obligation');
ROLLBACK;

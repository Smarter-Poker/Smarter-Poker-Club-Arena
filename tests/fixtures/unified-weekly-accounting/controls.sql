-- Only the clock dependency is replaced after the exact migration MD5 is
-- printed, matching the established native coordinator fixture technique.
DO $$DECLARE d text;BEGIN SELECT pg_get_functiondef(COALESCE(to_regprocedure('fn_process_weekly_accounting_scope(uuid,uuid)'),to_regprocedure('fn_process_weekly_accounting(uuid)'))) INTO d;EXECUTE replace(d,'clock_timestamp()','public.test_clock()');END$$;
SET test.clock='2026-09-14T09:20:00Z';
INSERT INTO daemon_state VALUES('rakeback_settler','2026-09-14 06:59Z','ffffffff-ffff-ffff-ffff-ffffffffffff',now());
UPDATE clubs SET union_id=u(1);
INSERT INTO accounting_agreement_history VALUES(1,u(11)::text,'union_clubs','2026-09-06',jsonb_build_object('club_id',u(11),'union_id',u(1)));
INSERT INTO rake_records(id,club_id,hand_id,table_id,rake_amount,is_tournament,created_at) SELECT rake_record_id,club_id,u(800),u(801),rake_credit,false,earned_at FROM accounting_cash_rake_sources;
INSERT INTO accounting_cash_accrual_batches SELECT id,'accrued' FROM rake_records;
INSERT INTO accounting_cash_bank_receipts(rake_record_id,union_id,club_id,club_ledger_id,banked_at,amount)
 SELECT s.rake_record_id,NULL,s.club_id,s.rake_record_id,s.earned_at,s.rake_credit FROM accounting_cash_rake_sources s;
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,created_at)
 SELECT rake_record_id,'table_stack',u(801),'chip_retirement',NULL,rake_credit,'burn',club_id,earned_at FROM accounting_cash_rake_sources;
SELECT assert_true(to_char('2026-09-07 07:00Z'::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')='2026-09-07T07:00:00Z','fixture close identity is the canonical production format without literal backslashes');

SELECT assert_true((SELECT scope_kind='union' AND scope_id=u(999) AND standalone_club_id IS NULL AND attempts=7 AND result @> '{"original":true}' FROM union_accounting_runs WHERE union_id=u(999)),'run-journal schema upgrade preserves prior union scope, attempts and original result');
DELETE FROM union_accounting_runs WHERE union_id=u(999);

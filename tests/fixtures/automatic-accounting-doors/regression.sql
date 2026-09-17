\set ON_ERROR_STOP on
-- Claims execute against the actual replaced functions, not mocks.
SELECT set_actor(u(10),'authenticated');
DO $$DECLARE r jsonb;BEGIN
 r:=fn_agent_claim_commission(u(3),u(700),1000);
 PERFORM assert_true(r->>'success'='false' AND r->>'code'='automatic_weekly_settlement' AND r->'amount'='0'::jsonb AND r->'rows_settled'='0'::jsonb AND r->'more'='false'::jsonb AND r->>'op_id'=u(700)::text,'agent manual claim reports no payment and preserves legacy result keys');
 PERFORM assert_true(fn_agent_claim_commission(u(3),u(700),5000)=r,'same old operation id remains a no-payment refusal');
 r:=fn_claim_rakeback(u(3));
 PERFORM assert_true(r->>'success'='false' AND r->>'code'='automatic_weekly_settlement' AND r->'periods_claimed'='0'::jsonb AND r->'total_payout'='0'::jsonb,'player manual claim reports no payout without closing periods');
 PERFORM assert_true(fn_claim_rakeback(NULL)->>'code'='automatic_weekly_settlement','global old player claim is metadata only');
 PERFORM assert_true(fn_agent_claim_commission(u(4))->>'code' IS NULL,'agent cannot obtain a claim response for another club');
 PERFORM assert_true(fn_claim_rakeback(u(4))->>'code' IS NULL,'player claim rejects nonmembership in requested club');
END$$;
SELECT set_actor(u(30),'authenticated');
SELECT assert_true(fn_agent_claim_commission(u(3))->>'code' IS NULL AND fn_claim_rakeback(u(3))->>'code' IS NULL,'inactive membership remains refused');
SELECT set_actor(NULL,'authenticated');
SELECT assert_true(fn_agent_claim_commission(u(3))->>'code' IS NULL AND fn_claim_rakeback(NULL)->>'code' IS NULL,'missing actor cannot claim');
SELECT set_actor(u(11),'authenticated');
SELECT assert_true(settle_club_rakeback(u(3))->>'code'='automatic_weekly_settlement','club owner manual settlement is scheduled only');
SELECT assert_true(fn_execute_union_rakeback(u(1),now(),now())->>'code'='automatic_weekly_settlement','union owner manual round-one request is scheduled only');
SELECT assert_true(settle_club_rakeback(u(4))->>'error'='not_authorised','club owner cannot trigger another clubs accounting');
SELECT assert_true(fn_execute_union_rakeback(u(2),now(),now())->>'error'='not_authorized','union owner cannot trigger another unions accounting');
SELECT assert_true(fn_run_pending_rakeback_settlement(500)->>'error'='not_authorized','ordinary member cannot use platform admin wrapper');
SELECT set_actor(u(99),'authenticated');
SELECT assert_true(fn_run_pending_rakeback_settlement(500)->>'code'='automatic_weekly_settlement','platform admin button cannot create a second payment run');
SELECT assert_true(books()=(SELECT snapshot FROM before_books),'all legacy human requests preserve exact balances, pending claims, invoices and notifications');
SELECT assert_true(NOT has_function_privilege('anon','fn_agent_claim_commission(uuid,uuid,integer)','EXECUTE') AND NOT has_function_privilege('anon','fn_claim_rakeback(uuid)','EXECUTE'),'anonymous clients have no manual claim access');
SELECT assert_true(NOT has_function_privilege('authenticated','fn_close_settlement_period(uuid)','EXECUTE') AND NOT has_function_privilege('service_role','fn_close_settlement_period(uuid)','EXECUTE'),'legacy period payer is not directly callable by either API role');
SELECT assert_true(md5(pg_get_functiondef('fn_close_settlement_period(uuid)'::regprocedure))='e129b4ff2ba84faa8f0dee88b494d21f','legacy period payer body remains intact for historical audit');
SELECT assert_true(NOT has_function_privilege('authenticated','fn_settle_club_rakeback_batch(uuid,integer,numeric,integer)','EXECUTE'),'browser cannot call private compatibility batch');

-- Keep the real J coordinator body and invoke it after recording boundary
-- arguments. The fixture freezes financial processing, so actual scope and
-- actor checks execute but no mocked payer can manufacture completion.
ALTER FUNCTION fn_process_weekly_accounting_scope(uuid,uuid) RENAME TO fixture_actual_weekly_scope;
CREATE TABLE scope_calls(union_id uuid,club_id uuid);
CREATE FUNCTION fn_process_weekly_accounting_scope(p_union_id uuid,p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$DECLARE r jsonb;BEGIN
 r:=public.fixture_actual_weekly_scope(p_union_id,p_club_id);
 INSERT INTO scope_calls VALUES(p_union_id,p_club_id);
 RETURN r;
END$$;
REVOKE ALL ON FUNCTION fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
SELECT set_actor(NULL,'service_role');
SELECT assert_true(settle_club_rakeback(u(3))->>'reason'='maintenance_window','trusted legacy club wrapper returns the real coordinators not-due/maintenance result');
SELECT assert_true((SELECT count(*) FROM scope_calls)=1 AND EXISTS(SELECT 1 FROM scope_calls WHERE union_id IS NULL AND club_id=u(3)),'club wrapper delegates the exact standalone club and never all scopes');
TRUNCATE scope_calls;
SELECT assert_true(fn_settle_club_rakeback_batch(u(4),1,0.01,0)->>'reason'='maintenance_window','trusted old batch knobs cannot bypass coordinator gating');
SELECT assert_true((SELECT count(*) FROM scope_calls)=1 AND EXISTS(SELECT 1 FROM scope_calls WHERE union_id IS NULL AND club_id=u(4)),'batch wrapper preserves exact other-club scope');
TRUNCATE scope_calls;
SELECT assert_true(fn_execute_union_rakeback(u(2),fn_union_prev_week_start(now()),fn_union_week_start(now()))->>'reason'='maintenance_window','trusted round-one compatibility call enters the actual full coordinator');
SELECT assert_true((SELECT count(*) FROM scope_calls)=1 AND EXISTS(SELECT 1 FROM scope_calls WHERE union_id=u(2) AND club_id IS NULL),'union wrapper delegates only the requested union');
TRUNCATE scope_calls;
SELECT assert_true(fn_execute_union_rakeback(u(2),now(),now())->>'error'='requested_period_requires_weekly_accounting' AND NOT EXISTS(SELECT 1 FROM scope_calls),'arbitrary historical or partial requested period cannot silently invoke another period');
SELECT assert_true(fn_run_pending_rakeback_settlement(1)->>'reason'='maintenance_window','trusted platform wrapper forwards the actual coordinator result');
SELECT assert_true((SELECT count(*) FROM scope_calls)=1 AND EXISTS(SELECT 1 FROM scope_calls WHERE union_id IS NULL AND club_id IS NULL),'global trusted wrapper is the only all-scopes compatibility request');
TRUNCATE scope_calls;
SELECT assert_true(settle_club_rakeback(NULL)->>'error'='club_not_found' AND settle_club_rakeback(u(1))->>'error'='club_not_found' AND settle_club_rakeback(u(999))->>'error'='club_not_found' AND NOT EXISTS(SELECT 1 FROM scope_calls),'missing, union-house and unknown club IDs never broaden to all scopes');
SELECT set_actor(u(10),'authenticated');
DO $$BEGIN
 BEGIN PERFORM fn_process_weekly_accounting(u(1));RAISE EXCEPTION 'unexpected coordinator acceptance';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 PERFORM assert_true(NOT EXISTS(SELECT 1 FROM scope_calls),'real coordinator still refuses a human actor even inside the definer chain');
END$$;
SELECT assert_true(books()=(SELECT snapshot FROM before_books),'trusted not-due/maintenance calls preserve financial and document state');
SELECT count(*) AS passed_assertions FROM assertion_count;

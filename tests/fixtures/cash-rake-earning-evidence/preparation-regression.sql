INSERT INTO union_clubs(id,club_id,union_id,club_commission_rate) VALUES(u(44),u(20),u(40),.9);
SELECT test_source(701,501,10,10,'2026-08-11Z');
SELECT test_source(702,503,20,20,'2026-08-12Z');
SELECT assert_true((SELECT array_agg(club_id ORDER BY club_id)=ARRAY[u(10),u(20)] FROM fn_accounting_week_clubs(u(40),NULL,'2026-08-10T07:00Z','2026-08-17T07:00Z')),'preparation includes recorded earning clubs after their current union relationship changed');
CREATE TEMP TABLE prepared AS SELECT fn_prepare_accounting_week(u(40),NULL,'2026-08-10T07:00Z','2026-08-17T07:00Z') r;
SELECT assert_true((SELECT r->>'success'='true' AND r->>'clubs'='2' FROM prepared),'the single preparation drains every exact club in the closed week');
SELECT assert_true((SELECT count(*)=2 AND bool_and(status='complete') FROM accounting_period_recompute_requests),'preparation independently confirms durable complete requests');
SELECT assert_true((SELECT count(*)=2 AND sum(rakeback_amount)=4 FROM rakeback_periods),'preparation uses the actual canonical period writer and exact historical deals');
SELECT assert_true(fn_prepare_accounting_week(u(40),NULL,'2026-08-10T07:00Z','2026-08-17T07:00Z')->>'success'='true'
 AND(SELECT count(*)=2 FROM accounting_rakeback_period_calculations),'preparation replay leaves immutable calculations unchanged');
SELECT assert_true(refuses('SELECT fn_prepare_accounting_week(u(40),NULL,''2026-08-10T00:00Z'',''2026-08-17T00:00Z'')','22023'),'UTC dates cannot masquerade as the Pacific accounting week');
SELECT assert_true(refuses('SELECT fn_prepare_accounting_week(u(40),u(20),''2026-08-10T07:00Z'',''2026-08-17T07:00Z'')','22023'),'preparation requires exactly one union or club scope');
SELECT assert_true(refuses('SELECT fn_prepare_accounting_week(u(40),NULL,''2030-08-12T07:00Z'',''2030-08-19T07:00Z'')','22023'),'future weeks cannot be prepared for payment');
CREATE TEMP TABLE blocked AS SELECT fn_prepare_accounting_week(u(40),NULL,'2025-12-22T08:00Z','2025-12-29T08:00Z') r;
SELECT assert_true((SELECT r->>'success'='false' FROM blocked),'unobserved historical week blocks the coordinator before wallet writes');
SELECT assert_true((SELECT count(*)=1 AND bool_and(status='blocked') FROM accounting_period_recompute_requests WHERE period_start='2025-12-22'),'failed preparation retains its durable retry request');
SELECT assert_true(NOT has_function_privilege('authenticated','fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)','EXECUTE')
 AND NOT has_function_privilege('service_role','fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)','EXECUTE'),'preparation is private to the one coordinator');
BEGIN;
CREATE OR REPLACE FUNCTION fn_rakeback_recompute_periods(p_club_id uuid,p_period_start date,p_period_end date,p_user_ids uuid[] DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,
  'status','ready','request_state','complete','request_recorded',true,'request_id',u(999),'requested_at',now())$$;
SELECT assert_true(fn_prepare_accounting_week(u(40),NULL,'2026-08-10T07:00Z','2026-08-17T07:00Z')->>'success'='false','an invented success receipt without its matching durable request cannot authorize payment');
ROLLBACK;
BEGIN;
CREATE OR REPLACE FUNCTION fn_rakeback_recompute_periods(p_club_id uuid,p_period_start date,p_period_end date,p_user_ids uuid[] DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('accounting_version',2,'club_id',u(999),'period_start',p_period_start,'period_end',p_period_end,
  'status','ready','request_state','complete','request_recorded',true)$$;
SELECT assert_true(fn_prepare_accounting_week(u(40),NULL,'2026-08-10T07:00Z','2026-08-17T07:00Z')->>'success'='false','a ready receipt for the wrong club cannot authorize payment');
ROLLBACK;

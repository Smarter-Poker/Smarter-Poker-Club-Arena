INSERT INTO public.clubs VALUES(u(10),u(40),false),(u(20),u(40),false),(u(30),u(40),true);
INSERT INTO auth.users VALUES(u(501)),(u(502)),(u(503));
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms) VALUES
 ('agents',u(901)::text,u(10),u(511),'INSERT','2026-01-01Z',jsonb_build_object('id',u(901),'club_id',u(10),'user_id',u(511),'status','active','commission_rate',0.6,'player_rakeback_rate',0.2)),
 ('club_members',u(10)::text||':'||u(501)::text,u(10),u(501),'INSERT','2026-01-01Z',jsonb_build_object('club_id',u(10),'user_id',u(501),'agent_id',u(511),'is_active',true,'status','approved','player_rakeback_pct',0.2)),
 ('club_members',u(10)::text||':'||u(502)::text,u(10),u(502),'INSERT','2026-01-01Z',jsonb_build_object('club_id',u(10),'user_id',u(502),'agent_id',NULL,'is_active',true,'status','active','player_rakeback_pct',0.1)),
 ('club_members',u(20)::text||':'||u(503)::text,u(20),u(503),'INSERT','2026-01-01Z',jsonb_build_object('club_id',u(20),'user_id',u(503),'agent_id',NULL,'is_active',true,'status','active','player_rakeback_pct',0.1));
CREATE FUNCTION test_source(n int,player_n int,club_n int,credit numeric,at_time timestamptz,deal numeric DEFAULT NULL,game_union_n int DEFAULT 40,coordinator_n int DEFAULT 40) RETURNS void LANGUAGE plpgsql AS $$
DECLARE member jsonb;tiers jsonb:='[]';agent jsonb;contract jsonb;
BEGIN
 INSERT INTO public.rake_records VALUES(u(n),u(n+1000),CASE WHEN game_union_n IS NULL THEN u(club_n) ELSE u(30) END,u(401),credit,false,NULL,at_time,'{}');
 INSERT INTO public.rake_attributions VALUES(u(n+2000),u(n),u(n+1000),u(player_n),u(club_n),credit);
 member:=fn_accounting_terms_at('club_members',u(club_n)::text||':'||u(player_n)::text,at_time);
 IF deal IS NOT NULL THEN member:=jsonb_set(member,'{terms,player_rakeback_pct}',to_jsonb(deal)); END IF;
 IF member->'terms'->>'agent_id' IS NOT NULL THEN
  agent:=fn_accounting_agent_terms_at(u(club_n),(member->'terms'->>'agent_id')::uuid,at_time);
  tiers:=jsonb_build_array(jsonb_build_object('user_id',agent->'terms'->'user_id','depth',1,'rate',agent->'terms'->'commission_rate','agreement',agent));
 END IF;
 contract:=jsonb_build_object('player_id',u(player_n),'club_id',u(club_n),'attribution_id',u(n+2000),'rake_credit',credit,'membership',member,'tiers',tiers,'union_id',u(game_union_n),'coordinator_union_id',u(coordinator_n));
 INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan)
  VALUES(u(n),u(n+1000),at_time,'fixture source '||n,'accrued','{}');
 INSERT INTO public.accounting_cash_rake_sources(rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract)
  VALUES(u(n),u(player_n),u(club_n),u(game_union_n),u(coordinator_n),at_time,credit,contract);
END$$;
SELECT test_source(201,501,10,0.03,'2026-09-10Z');
SELECT test_source(202,501,10,0.03,'2026-09-11Z');
SELECT test_source(203,502,10,5.01,'2026-09-10Z');
CREATE TEMP TABLE first_write AS SELECT fn_rakeback_recompute_periods(u(10),'2026-09-07','2026-09-13',NULL) result;
SELECT assert_true((SELECT result->>'accounting_version'='2' AND result->>'status'='ready' AND result->>'written'='2' FROM first_write),'one writer confirms exact version and both player periods');
SELECT assert_true((SELECT rakeback_amount=0.01 FROM rakeback_periods WHERE user_id=u(501)),'round once weekly: two 0.006 entitlements pay 0.01, not 0.02');
SELECT assert_true((SELECT rakeback_amount=0.50 FROM rakeback_periods WHERE user_id=u(502)),'player deal is calculated from exact weekly volume');
SELECT assert_true((SELECT payer_kind='agent' AND payer_user_id=u(511) FROM accounting_rakeback_period_calculations WHERE player_id=u(501)),'assigned agent payer comes from recorded earning contract');
SELECT assert_true((SELECT payer_kind='club' AND payer_user_id IS NULL FROM accounting_rakeback_period_calculations WHERE player_id=u(502)),'unassigned player retains recorded club payer');
SELECT assert_true(fn_rakeback_recompute_periods(u(10),'2026-09-07','2026-09-13')->>'written'='0' AND (SELECT count(*)=2 FROM accounting_rakeback_period_calculations),'idempotent replay creates no second calculation or liability');
SELECT test_source(204,501,10,0.04,'2026-09-12Z');
CREATE TEMP TABLE second_write AS SELECT fn_rakeback_recompute_periods(u(10),'2026-09-07','2026-09-13') result;
SELECT assert_true((SELECT result->>'written'='1' FROM second_write) AND (SELECT rakeback_amount=0.02 FROM rakeback_periods WHERE user_id=u(501)),'new certified source extends only its own pending period');
SELECT assert_true((SELECT count(*)=3 FROM accounting_rakeback_period_calculations),'changed source set appends historical calculation revision');
SELECT assert_true(refuses('UPDATE accounting_rakeback_period_calculations SET rakeback_amount=99','55000'),'issued calculation evidence is immutable');
UPDATE rakeback_periods SET rakeback_amount=9 WHERE user_id=u(501);
SELECT assert_true(fn_rakeback_recompute_periods(u(10),'2026-09-07','2026-09-13')->>'reason'='certified_period_drift_requires_reconciliation','uncertified changes block rather than overwrite the stored liability');
SELECT assert_true((SELECT rakeback_amount=9 FROM rakeback_periods WHERE user_id=u(501)),'blocked drift remains untouched');
UPDATE rakeback_periods SET rakeback_amount=0.02 WHERE user_id=u(501);
INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,status,rake_generated,rakeback_amount) VALUES(u(899),u(503),u(10),'2026-09-07','2026-09-13','pending',0,0);
SELECT assert_true(fn_rakeback_recompute_periods(u(10),'2026-09-07','2026-09-13')->>'reason'='legacy_or_paid_period_requires_reconciliation','any unowned legacy overlap blocks the whole club book');
DELETE FROM rakeback_periods WHERE id=u(899);
INSERT INTO public.rake_records VALUES(u(299),NULL,u(30),u(401),5,true,u(499),'2026-09-12Z','{}');
SELECT assert_true(fn_rakeback_recompute_periods(u(10),'2026-09-07','2026-09-13')->>'reason'='tournament_earning_evidence_unavailable','unattributed tournament entitlement cannot be discarded from a mixed weekly book');
DELETE FROM rake_records WHERE id=u(299);
INSERT INTO public.rake_records VALUES(u(298),u(1298),u(30),u(401),1,false,NULL,'2026-09-12Z','{}');
INSERT INTO public.rake_attributions VALUES(u(2298),u(298),u(1298),u(501),u(10),1);
SELECT assert_true(fn_rakeback_recompute_periods(u(10),'2026-09-07','2026-09-13')->>'reason'='cash_source_receipts_incomplete','matching attribution without canonical accrual receipt blocks');
DELETE FROM rake_attributions WHERE id=u(2298);DELETE FROM rake_records WHERE id=u(298);
UPDATE rakeback_periods SET status='paid' WHERE user_id=u(501);
SELECT assert_true(fn_rakeback_recompute_periods(u(10),'2026-09-07','2026-09-13')->>'reason'='legacy_or_paid_period_requires_reconciliation','paid week cannot be recalculated');
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2025-12-22','2025-12-28')->>'reason'='historical_week_before_observed_source_cutover','source cutover is not backdated into an earlier week');
SELECT assert_true(NOT has_function_privilege('authenticated','fn_rakeback_recompute_periods(uuid,date,date,uuid[])','EXECUTE'),'client cannot call the authoritative period writer');

BEGIN;
SELECT test_source(601,503,20,10,'2026-08-11Z');
INSERT INTO accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 VALUES('club_members',u(20)::text||':'||u(503)::text,u(20),u(503),'UPDATE','2026-08-12Z',jsonb_build_object('club_id',u(20),'user_id',u(503),'agent_id',NULL,'is_active',true,'status','active','player_rakeback_pct',0.2));
SELECT test_source(602,503,20,10,'2026-08-13Z');
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-10','2026-08-16')->>'status'='ready','a rate change uses each source observed deal');
SELECT assert_true((SELECT rakeback_amount=3 AND rakeback_rate=0.15 FROM rakeback_periods WHERE club_id=u(20)),'weighted effective display rate does not retroactively replace either deal');
ROLLBACK;

BEGIN;
INSERT INTO accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 VALUES('club_members',u(20)::text||':'||u(503)::text,u(20),u(503),'UPDATE','2026-08-01Z',jsonb_build_object('club_id',u(20),'user_id',u(503),'agent_id',NULL,'is_active',true,'status','active','player_rakeback_pct',0));
SELECT test_source(611,503,20,50,'2026-08-11Z');SELECT test_source(612,503,20,60,'2026-08-13Z');
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-10','2026-08-16')->>'status'='ready','no-deal player keeps existing weekly volume ladder');
SELECT assert_true((SELECT rakeback_amount=11 AND rakeback_rate=0.1 FROM rakeback_periods WHERE club_id=u(20)),'both small contributions use the combined weekly tier');
ROLLBACK;

BEGIN;
INSERT INTO accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms) VALUES
 ('club_members',u(10)::text||':'||u(501)::text,u(10),u(501),'UPDATE','2026-08-01Z',jsonb_build_object('club_id',u(10),'user_id',u(501),'agent_id',u(511),'is_active',true,'status','active','player_rakeback_pct',0)),
 ('club_members',u(10)::text||':'||u(501)::text,u(10),u(501),'UPDATE','2026-08-17Z',jsonb_build_object('club_id',u(10),'user_id',u(501),'agent_id',u(511),'is_active',true,'status','active','player_rakeback_pct',0.8));
SELECT test_source(621,501,10,10,'2026-08-11Z');SELECT test_source(622,501,10,10,'2026-08-18Z');
SELECT assert_true(fn_rakeback_recompute_periods(u(10),'2026-08-10','2026-08-16')->>'status'='ready' AND fn_rakeback_recompute_periods(u(10),'2026-08-17','2026-08-23')->>'status'='ready','agent standing offer and negotiated deal paths both certify');
SELECT assert_true((SELECT rakeback_amount=2 FROM rakeback_periods WHERE user_id=u(501) AND period_start='2026-08-10'),'agent standing offer is used when member has no deal');
SELECT assert_true((SELECT rakeback_amount=5 FROM rakeback_periods WHERE user_id=u(501) AND period_start='2026-08-17'),'player deal cannot exceed agent rate minus ten percentage points');
ROLLBACK;

BEGIN;
SELECT test_source(631,503,20,10,'2026-08-11Z');
INSERT INTO accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms) VALUES
 ('agents',u(905)::text,u(20),u(515),'INSERT','2026-08-01Z',jsonb_build_object('id',u(905),'club_id',u(20),'user_id',u(515),'status','active','commission_rate',0.6,'player_rakeback_rate',0.2)),
 ('club_members',u(20)::text||':'||u(503)::text,u(20),u(503),'UPDATE','2026-08-12Z',jsonb_build_object('club_id',u(20),'user_id',u(503),'agent_id',u(515),'is_active',true,'status','active','player_rakeback_pct',0.1));
SELECT test_source(632,503,20,10,'2026-08-13Z');
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-10','2026-08-16')->>'reason'='multiple_historical_payers_require_split_period','changed payer cannot be silently charged to the current agent');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM rakeback_periods WHERE club_id=u(20)),'payer conflict writes no partial player liability');
ROLLBACK;

BEGIN;
SELECT test_source(641,503,20,10,'2026-08-11Z',NULL,40,40);
SELECT test_source(642,503,20,10,'2026-08-13Z',NULL,NULL,40);
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-10','2026-08-16')->>'status'='ready','private and union game earnings may share the same recorded coordinator and payer');
SELECT assert_true((SELECT coordinator_union_id=u(40) AND source_allocations->0->'union_id' IS DISTINCT FROM source_allocations->1->'union_id' FROM accounting_rakeback_period_calculations WHERE club_id=u(20)),'certificate retains separate game union evidence under one coordinator');
ROLLBACK;

BEGIN;
SELECT test_source(651,503,20,10,'2026-08-11Z',NULL,40,40);
SELECT test_source(652,503,20,10,'2026-08-13Z',NULL,41,41);
SELECT assert_true(fn_rakeback_recompute_periods(u(20),'2026-08-10','2026-08-16')->>'reason'='multiple_recorded_coordinators_require_split_period','observed coordinator change cannot be hidden inside one period');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM rakeback_periods WHERE club_id=u(20)),'coordinator conflict preserves an empty liability book');
ROLLBACK;

BEGIN;
SELECT test_source(681,501,10,1,'2026-08-04Z');SELECT test_source(682,502,10,1,'2026-08-04Z',0.7);
SELECT assert_true(fn_rakeback_recompute_periods(u(10),'2026-08-03','2026-08-09')->>'reason'='period_membership_contract_invalid','forged captured terms cannot replace the immutable agreement referenced by their receipt');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM rakeback_periods WHERE club_id=u(10) AND period_start='2026-08-03') AND NOT EXISTS(SELECT 1 FROM accounting_rakeback_period_calculations WHERE club_id=u(10) AND period_start='2026-08-03'),'a later invalid player rolls back earlier player periods and certificates');
ROLLBACK;

SELECT assert_true((SELECT (f.result->>'request_id')::uuid=q.id AND q.status='blocked' AND q.requested_at=(f.result->>'requested_at')::timestamptz FROM first_write f JOIN accounting_period_recompute_requests q ON q.id=(f.result->>'request_id')::uuid),'original durable request identity survives later blocked retries');
CREATE TEMP TABLE blocked_request AS SELECT fn_rakeback_recompute_periods(u(20),'2025-12-22','2025-12-28') result;
SELECT assert_true((SELECT result->>'request_recorded'='true' AND result->>'request_state'='blocked' AND result->>'status'='blocked' FROM blocked_request),'unprovable historical period returns a durable blocked receipt');
SELECT assert_true((SELECT q.status='blocked' AND q.last_result->>'reason'='historical_week_before_observed_source_cutover' FROM accounting_period_recompute_requests q JOIN blocked_request r ON q.id=(r.result->>'request_id')::uuid),'blocked receipt has independently readable stored scope and reason');
SELECT assert_true((fn_rakeback_recompute_periods(u(20),'2025-12-22','2025-12-28')->>'request_id')=(SELECT result->>'request_id' FROM blocked_request),'retry deduplicates the same exact club and week request');
SELECT assert_true(NOT has_function_privilege('service_role','fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])','EXECUTE') AND NOT has_table_privilege('service_role','accounting_period_recompute_requests','UPDATE'),'source clients cannot bypass the request wrapper or edit its proof');
BEGIN;
SELECT test_source(691,503,20,10,'2026-08-04Z');
CREATE TEMP TABLE partial_request AS SELECT fn_rakeback_recompute_periods(u(20),'2026-08-03','2026-08-09',ARRAY[u(503)]) result;
SELECT assert_true((SELECT result->>'status'='ready' AND result->>'request_state'='pending' FROM partial_request),'partial source-page calculation does not certify a complete club week');
CREATE TEMP TABLE complete_request AS SELECT fn_rakeback_recompute_periods(u(20),'2026-08-03','2026-08-09',NULL) result;
SELECT assert_true((SELECT result->>'status'='ready' AND result->>'request_state'='complete' FROM complete_request),'coordinator full-scope drain completes the durable request');
SELECT assert_true((SELECT p.result->>'request_id'=c.result->>'request_id' AND p.result->>'requested_at'=c.result->>'requested_at' FROM partial_request p CROSS JOIN complete_request c),'request identity and creation time remain stable through completion');
ROLLBACK;
BEGIN;
SELECT test_source(695,501,10,10,'2026-08-04Z');SELECT test_source(696,502,10,10,'2026-08-04Z');
CREATE FUNCTION test_certificate_outage() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.player_id=u(502) THEN RAISE EXCEPTION 'certificate_storage_unavailable'; END IF; RETURN NEW; END$$;
CREATE TRIGGER test_certificate_outage BEFORE INSERT ON accounting_rakeback_period_calculations FOR EACH ROW EXECUTE FUNCTION test_certificate_outage();
CREATE TEMP TABLE failed_request AS SELECT fn_rakeback_recompute_periods(u(10),'2026-08-03','2026-08-09') result;
SELECT assert_true((SELECT result->>'reason'='certificate_storage_unavailable' AND result->>'request_state'='blocked' FROM failed_request),'unexpected storage failure becomes an explicit durable request failure');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM rakeback_periods WHERE club_id=u(10) AND period_start='2026-08-03') AND NOT EXISTS(SELECT 1 FROM accounting_rakeback_period_calculations WHERE club_id=u(10) AND period_start='2026-08-03'),'unexpected later failure rolls back every player period and certificate');
SELECT assert_true((SELECT q.status='blocked' FROM accounting_period_recompute_requests q JOIN failed_request f ON q.id=(f.result->>'request_id')::uuid),'durable failure proof survives the calculation rollback');
ROLLBACK;
SELECT set_config('test.engine','false',false);
SELECT assert_true(refuses(format('SELECT fn_rakeback_recompute_periods(%L,''2026-09-07'',''2026-09-13'')',u(10)),'42501'),'writer refuses a caller without engine authority');

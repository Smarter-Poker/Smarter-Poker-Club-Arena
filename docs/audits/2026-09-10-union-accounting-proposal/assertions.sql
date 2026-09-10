BEGIN;
CREATE FUNCTION pg_temp.uid(n bigint) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid $$;
CREATE FUNCTION pg_temp.ok(test boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF test IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION pg_temp.credit(player bigint,amount numeric,source bigint DEFAULT 700) RETURNS void LANGUAGE sql AS $$
 SELECT public.credit_agent_commission_from_rake(pg_temp.uid(player),pg_temp.uid(900),amount,'rake_settlement',pg_temp.uid(source),NULL) $$;

SELECT pg_temp.credit(201,100);
SELECT pg_temp.credit(202,100);
SELECT pg_temp.ok((SELECT count(*)=6 AND sum(amount)=140 FROM agent_commissions),'both contributors earn every tier, total 140 of 200 gross');
SELECT pg_temp.ok((SELECT array_agg(amount ORDER BY user_id)=ARRAY[25,25,20]::numeric[] FROM agent_commissions WHERE contributing_user_id=pg_temp.uid(201)),'one gross basis yields 25 + 25 + 20, 30 remains outside this commission accrual');
SELECT pg_temp.ok((SELECT count(*)=3 FROM agents WHERE club_id=pg_temp.uid(900) AND lifetime_rake_generated=200),'each upline volume reflects all contributors');
SELECT pg_temp.credit(201,100);
SELECT pg_temp.ok((SELECT count(*)=6 AND sum(amount)=140 FROM agent_commissions),'same-payload replay creates no new accrual');
SELECT pg_temp.ok((SELECT count(*)=2 FROM ca_commission_contributor_receipts WHERE state='applied'),'committed contributor receipts cover both contributions');
DO $$ BEGIN
 BEGIN PERFORM pg_temp.credit(201,101); RAISE EXCEPTION 'altered amount accepted';
 EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'PASS: altered amount rejected'; END;
 BEGIN PERFORM credit_agent_commission_from_rake(pg_temp.uid(201),pg_temp.uid(901),100,'rake_settlement',pg_temp.uid(700)); RAISE EXCEPTION 'altered club accepted';
 EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'PASS: altered club rejected'; END;
END $$;
UPDATE agents SET commission_rate=.3 WHERE id=pg_temp.uid(1);
SELECT pg_temp.credit(201,100);
SELECT pg_temp.ok((SELECT sum(amount)=140 FROM agent_commissions),'rate changes after receipt do not reprice old source');
UPDATE agents SET commission_rate=.25 WHERE id=pg_temp.uid(1);

SELECT pg_temp.credit(201,.01,701);
SELECT pg_temp.ok((SELECT sum(amount)=.01 FROM agent_commissions WHERE source_id=pg_temp.uid(701)),'cumulative rounding conserves tiny rake');
DO $$ DECLARE bad numeric; BEGIN
 FOREACH bad IN ARRAY ARRAY[-1,.001,'NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric] LOOP
  BEGIN PERFORM pg_temp.credit(201,bad,702); RAISE EXCEPTION 'invalid amount accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 END LOOP;
 RAISE NOTICE 'PASS: negative, subcent, NaN and infinite amounts rejected';
END $$;
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM ca_commission_contributor_receipts WHERE source_id=pg_temp.uid(702)),'invalid inputs leave no receipt');

SAVEPOINT no_club;
UPDATE club_members SET agent_id=NULL WHERE user_id=pg_temp.uid(201);
SELECT pg_temp.credit(201,100,703);
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM agent_commissions WHERE source_id=pg_temp.uid(703)),'self-agent fallback cannot select foreign club agent');
ROLLBACK TO SAVEPOINT no_club;

SAVEPOINT cross_parent;
UPDATE agents SET club_id=pg_temp.uid(901) WHERE id=pg_temp.uid(2);
DO $$ BEGIN
 BEGIN PERFORM pg_temp.credit(201,100,704); RAISE EXCEPTION 'cross-club parent accepted';
 EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: cross-club parent rejected'; END;
END $$;
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM ca_commission_contributor_receipts WHERE source_id=pg_temp.uid(704)),'invalid hierarchy rolls receipt back');
ROLLBACK TO SAVEPOINT cross_parent;

SAVEPOINT cycle;
UPDATE agents SET parent_agent_id=pg_temp.uid(1) WHERE id=pg_temp.uid(3);
DO $$ BEGIN
 BEGIN PERFORM pg_temp.credit(201,100,705); RAISE EXCEPTION 'cycle accepted';
 EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: full-chain cycle rejected'; END;
END $$;
ROLLBACK TO SAVEPOINT cycle;

SAVEPOINT bad_margin;
UPDATE agents SET commission_rate=.30 WHERE id=pg_temp.uid(2);
SELECT pg_temp.credit(201,100,706);
SELECT pg_temp.ok((SELECT sum(amount)=70 FROM agent_commissions WHERE source_id=pg_temp.uid(706)),'invalid configured gap never over-allocates rake');
SELECT pg_temp.ok((SELECT count(*)=1 FROM test_alerts WHERE source='commission_hierarchy_margin'),'margin violation raises management alert');
SELECT pg_temp.ok((SELECT commission_rate=.30 FROM agents WHERE id=pg_temp.uid(2)),'audit does not rewrite assigned rates');
ROLLBACK TO SAVEPOINT bad_margin;

INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,notes)
 VALUES(pg_temp.uid(900),pg_temp.uid(101),25,.25,'rake_settlement',pg_temp.uid(707),'legacy fixture');
SELECT pg_temp.credit(201,100,707);
SELECT pg_temp.credit(202,100,707);
SELECT pg_temp.ok((SELECT count(*)=1 AND sum(amount)=25 FROM agent_commissions WHERE source_id=pg_temp.uid(707)),'legacy source is preserved without historical repair');
SELECT pg_temp.ok((SELECT count(*)=2 FROM ca_commission_contributor_receipts WHERE source_id=pg_temp.uid(707) AND state='legacy_preserved'),'legacy exclusion remains explicit');

CREATE FUNCTION pg_temp.fail_accrual() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.source_id='00000000-0000-4000-8000-000000000708'::uuid AND NEW.user_id='00000000-0000-4000-8000-000000000102'::uuid THEN RAISE EXCEPTION 'injected accrual failure' USING ERRCODE='P0002'; END IF; RETURN NEW; END $$;
CREATE TRIGGER test_fail_accrual BEFORE INSERT ON agent_commissions FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_accrual();
DO $$ BEGIN
 BEGIN PERFORM pg_temp.credit(201,100,708); RAISE EXCEPTION 'injected error absent';
 EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS: injected middle-tier failure observed'; END;
END $$;
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM agent_commissions WHERE source_id=pg_temp.uid(708)) AND NOT EXISTS(SELECT 1 FROM ca_commission_contributor_receipts WHERE source_id=pg_temp.uid(708)),'middle-tier failure rolls back all accruals and receipt');
DROP TRIGGER test_fail_accrual ON agent_commissions;
SELECT pg_temp.credit(201,100,708);
SELECT pg_temp.ok((SELECT count(*)=3 AND sum(amount)=70 FROM agent_commissions WHERE source_id=pg_temp.uid(708)),'recovery applies whole contributor exactly once');
SELECT pg_temp.ok(NOT has_function_privilege('authenticated','public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text)','execute'),'browser cannot invoke accrual');
SELECT pg_temp.ok(NOT has_function_privilege('authenticated','public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)','execute'),'browser cannot invoke alternate calculator');
SELECT pg_temp.ok(NOT has_table_privilege('authenticated','public.ca_commission_contributor_receipts','select,insert,update,delete'),'browser cannot mutate or enumerate contributor receipts');
SELECT pg_temp.ok((SELECT relrowsecurity FROM pg_class WHERE oid='public.ca_commission_contributor_receipts'::regclass),'new receipt table has RLS');
SELECT pg_temp.ok(NOT has_function_privilege('service_role','public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)','execute'),'alternate source-ID calculator is retired for service callers');
DO $$ BEGIN
 BEGIN PERFORM credit_agent_commission_from_rake(pg_temp.uid(201),pg_temp.uid(900),100,'tournament_fee',pg_temp.uid(709)); RAISE EXCEPTION 'retired domain accepted';
 EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'PASS: retired tournament_fee identity domain rejected'; END;
END $$;
UPDATE clubs SET union_id=pg_temp.uid(950) WHERE id IN(pg_temp.uid(900),pg_temp.uid(903));
INSERT INTO union_clubs VALUES(pg_temp.uid(900),pg_temp.uid(950)),(pg_temp.uid(903),pg_temp.uid(950));
SELECT credit_agent_commission_from_rake(pg_temp.uid(201),pg_temp.uid(903),100,'rake_settlement',pg_temp.uid(710));
SELECT pg_temp.ok((SELECT count(*)=3 AND bool_and(club_id=pg_temp.uid(900)) FROM agent_commissions WHERE source_id=pg_temp.uid(710)),'captured live resolver books union-host play to member club');
SELECT pg_temp.ok((SELECT requested_club_id=pg_temp.uid(903) AND booked_club_id=pg_temp.uid(900) FROM ca_commission_contributor_receipts WHERE source_id=pg_temp.uid(710)),'receipt distinguishes union host context from charged member club');
ROLLBACK;

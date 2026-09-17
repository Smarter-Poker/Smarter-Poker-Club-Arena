-- Controlled fixture bank authorities for the manually constructed source
-- cases. The real producer is exercised later with this fixture trigger gone.
CREATE FUNCTION test_seed_source_bank() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE bank_id uuid;game_union uuid;BEGIN
 IF NEW.metadata->>'accounting_source_version'='2' THEN
  game_union:=NULLIF(NEW.metadata->>'union_id','')::uuid;
  IF game_union IS NOT NULL THEN
   INSERT INTO union_wallet_transactions(union_id,club_id,amount,tx_type,wallet,direction,created_at)
    VALUES(game_union,NEW.club_id,NEW.rake_amount,'rake','rake_wallet','credit',NEW.created_at) RETURNING id INTO bank_id;
   INSERT INTO accounting_cash_bank_receipts VALUES(NEW.id,game_union,NEW.club_id,bank_id,NULL,NEW.created_at,NEW.rake_amount);
  ELSE
   INSERT INTO chip_ledger(from_type,to_type,to_entity_id,club_id,amount,category,created_at)
    VALUES('table_stack','chip_retirement',NULL,NEW.club_id,NEW.rake_amount,'burn',NEW.created_at) RETURNING id INTO bank_id;
   INSERT INTO accounting_cash_bank_receipts VALUES(NEW.id,NULL,NEW.club_id,NULL,bank_id,NEW.created_at,NEW.rake_amount);
  END IF;
 END IF;RETURN NEW;END$$;
CREATE TRIGGER test_seed_source_bank AFTER INSERT ON rake_records FOR EACH ROW EXECUTE FUNCTION test_seed_source_bank();
INSERT INTO clubs VALUES(u(10),u(20),false),(u(20),u(20),true),(u(40),NULL,false);
UPDATE agents SET role='sub_agent',commission_rate=.25,parent_agent_id=u(2) WHERE id=u(1);
INSERT INTO agents(id,club_id,user_id,parent_agent_id,role,status,commission_rate) VALUES(u(2),u(10),u(21),u(3),'agent','active',.5),(u(3),u(10),u(31),NULL,'super_agent','active',.4);
INSERT INTO club_members(club_id,user_id,agent_id,role,status,is_active) VALUES(u(10),u(13),u(11),'player','approved',true),(u(40),u(41),NULL,'player','active',true);
INSERT INTO rake_records(id,hand_id,club_id,rake_amount,created_at,metadata) VALUES(u(100),u(101),u(20),10,clock_timestamp(),jsonb_build_object('accounting_source_version',2,'union_id',u(20),'is_private',false));
INSERT INTO rake_attributions VALUES(u(102),u(100),u(101),u(12),u(10),4),(u(103),u(100),u(101),u(13),u(10),6);
SELECT assert_true((fn_accounting_cash_commission_plan(u(100))->'players'->0->'tiers'->0->>'amount')::numeric=1,'plan uses the recorded direct agreement and cents');
SELECT assert_true(jsonb_array_length(fn_accounting_cash_commission_plan(u(100))->'players'->0->'tiers')=3,'plan walks every recorded hierarchy tier');
SELECT assert_true(fn_accrue_cash_hand_commissions(u(101))->>'status'='accrued','all contributors accrue in one source transaction');
SELECT assert_true((SELECT count(*) FROM agent_commissions)=6 AND (SELECT sum(amount) FROM agent_commissions)=7.75,'two players with one agent both earn through all three tiers');
SELECT assert_true((SELECT count(*) FROM accounting_cash_rake_sources)=2 AND (SELECT count(DISTINCT source_id) FROM agent_commissions)=2,'source identities are actual per-player receipts, not fabricated hand IDs');
SELECT assert_true((SELECT sum((p->>'club_residual')::numeric) FROM accounting_cash_accrual_batches b,LATERAL jsonb_array_elements(b.plan->'players') p)+(SELECT sum(amount) FROM agent_commissions)=10,'agent entitlements and club remainder conserve exact rake');
SELECT assert_true((SELECT lifetime_rake_generated FROM agents WHERE id=u(1))=10 AND (SELECT lifetime_rake_generated FROM agents WHERE id=u(3))=10,'each upline volume counts each contributor once');
SELECT assert_true(fn_accrue_cash_hand_commissions(u(101))->>'duplicate'='true' AND (SELECT count(*) FROM agent_commissions)=6,'whole-hand retry does not accrue or increment counters twice');
SELECT credit_agent_commission_from_rake(u(13),u(10),6,'rake_settlement',u(101));
SELECT assert_true((SELECT count(*) FROM agent_commissions)=6,'per-player legacy wrapper delegates to the same whole-hand receipt');
SELECT assert_true(calculate_cascading_commission(u(101))->>'duplicate'='true','old cascading door cannot compute a second commission');
SELECT assert_true(refuses('SELECT credit_agent_commission_from_rake(u(13),u(40),6,''rake_settlement'',u(101))','23514'),'caller cannot move a source to another club');
SELECT assert_true(refuses('SELECT credit_agent_commission_from_rake(u(13),u(10),7,''rake_settlement'',u(101))','23514'),'caller cannot invent more rake');
SELECT assert_true(refuses('UPDATE rake_attributions SET club_id=u(40) WHERE id=u(102)','55000'),'recorded earning attribution cannot be rewritten');
SELECT assert_true(refuses('UPDATE rake_records SET rake_amount=11 WHERE id=u(100)','55000'),'recorded earning source cannot be rewritten');
SELECT assert_true(refuses('DELETE FROM accounting_cash_rake_sources','55000'),'per-player source receipts are immutable');
SELECT assert_true(refuses('INSERT INTO agent_commissions(club_id,user_id,amount,source_type,source_id) VALUES(u(10),u(11),1,''cash_rake_accrual'',u(250))','23514'),'unbacked source identifiers cannot create commission');
SELECT assert_true(refuses('INSERT INTO agent_commissions(club_id,user_id,amount,source_type,source_id) VALUES(u(10),u(11),1,''rake_settlement'',u(101))','23514'),'parallel legacy source writer is closed after cutover');
-- Current changes do not reprice an already earned or recorded hand.
UPDATE agents SET commission_rate=.9 WHERE id=u(1);
SELECT assert_true((fn_accounting_cash_commission_plan(u(100))->'players'->0->'tiers'->0->>'amount')::numeric=1,'later agreement changes do not reprice old rake');
UPDATE agents SET commission_rate=.25 WHERE id=u(1);
INSERT INTO rake_records(id,hand_id,club_id,rake_amount,created_at,metadata) VALUES(u(110),u(111),u(20),10,clock_timestamp(),jsonb_build_object('accounting_source_version',2,'union_id',u(20),'is_private',false));
INSERT INTO rake_attributions VALUES(u(112),u(110),u(111),u(12),u(10),4),(u(113),u(110),u(111),u(13),u(10),6);
SET test.fail_commission='true';
SELECT assert_true(refuses('SELECT fn_accrue_cash_hand_commissions(u(111))','P0001'),'a later tier journal failure refuses the source');
SELECT assert_true((SELECT count(*) FROM agent_commissions)=6 AND NOT EXISTS(SELECT 1 FROM accounting_cash_accrual_batches WHERE rake_record_id=u(110)) AND (SELECT lifetime_rake_generated FROM agents WHERE id=u(1))=10,'journal failure rolls every prior tier, receipt and counter back');
SET test.fail_commission='false';
SELECT assert_true(fn_accrue_cash_hand_commissions(u(111))->>'status'='accrued','retry of failed complete source posts once');
-- Standalone no-agent players retain a source with no fabricated commission.
INSERT INTO rake_records(id,hand_id,club_id,rake_amount,created_at,metadata) VALUES(u(120),u(121),u(40),.03,clock_timestamp(),jsonb_build_object('accounting_source_version',2,'union_id',NULL,'is_private',true));
INSERT INTO rake_attributions VALUES(u(122),u(120),u(121),u(41),u(40),.03);
SELECT fn_accrue_cash_hand_commissions(u(121));
SELECT assert_true( (SELECT jsonb_array_length(contract->'tiers') FROM accounting_cash_rake_sources WHERE rake_record_id=u(120))=0,'unassigned player retains their source without inventing an agent');
-- A closed source cannot create an unrecorded liability after period payment.
INSERT INTO rake_records(id,hand_id,club_id,rake_amount,created_at,metadata) VALUES(u(130),u(131),u(20),1,clock_timestamp(),jsonb_build_object('accounting_source_version',2,'union_id',u(20),'is_private',false));
INSERT INTO rake_attributions VALUES(u(132),u(130),u(131),u(12),u(10),1);
INSERT INTO agent_commission_settlements VALUES(u(10),u(11),now()-interval '1 hour',now()+interval '1 hour');
SELECT assert_true(refuses('SELECT fn_accrue_cash_hand_commissions(u(131))','23514'),'late accrual in a paid period requires a recorded adjustment');
DELETE FROM agent_commission_settlements;
-- Historical uncertainty is recorded without claiming or repairing a payout.
INSERT INTO rake_records(id,hand_id,club_id,rake_amount,created_at,metadata) VALUES(u(140),u(141),u(20),1,'2026-09-07T08:00Z','{}');
INSERT INTO rake_attributions VALUES(u(142),u(140),u(141),u(12),u(10),1);
SELECT assert_true(fn_accrue_cash_hand_commissions(u(141))->>'status'='legacy_unverified' AND NOT EXISTS(SELECT 1 FROM accounting_cash_rake_sources WHERE rake_record_id=u(140)),'historical source gaps do not silently create a new payable');
SELECT assert_true(refuses('SELECT fn_assert_cash_commission_period(u(20),NULL,''2026-09-07T07:00Z'',''2026-09-14T07:00Z'')','55000'),'weekly completion refuses unverified historical sources');
SELECT fn_assert_cash_commission_period(NULL,u(40),now()-interval '1 hour',now()+interval '1 hour');
SELECT assert_true(true,'exact other-club complete source scope remains usable');
SET test.engine='false';
SELECT assert_true(refuses('SELECT fn_accrue_cash_hand_commissions(u(101))','42501') AND refuses('SELECT calculate_cascading_commission(u(101))','42501') AND refuses('SELECT fn_accounting_cash_commission_plan(u(100))','42501'),'all accrual doors require trusted server authority');
SELECT assert_true(NOT has_function_privilege('authenticated','credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text)','execute') AND NOT has_function_privilege('anon','fn_accrue_cash_hand_commissions(uuid)','execute'),'client and anonymous grants cannot reach commission writers');
SET test.engine='true';

-- A later re-seat cannot change the club that earned the hand.
INSERT INTO hand_history VALUES(u(180),u(181),1000001,now()-interval '5 minutes');
INSERT INTO table_seats VALUES(u(181),u(12),u(10),now()-interval '10 minutes',now()-interval '4 minutes'),(u(181),u(12),u(40),now()-interval '3 minutes',NULL);
SELECT assert_true(fn_cash_earning_club(u(180),u(181),u(12),u(20),u(20))=u(10),'earning club is the seat at hand start, not a later re-seat');
SELECT assert_true(refuses('SELECT fn_cash_earning_club(u(180),u(181),u(13),u(20),u(20))','23514'),'missing union seat provenance cannot fall back to house club');
INSERT INTO table_seats VALUES(u(181),u(12),u(40),now()-interval '10 minutes',NULL);
SELECT assert_true(refuses('SELECT fn_cash_earning_club(u(180),u(181),u(12),u(20),u(20))','23514'),'overlapping different clubs cannot choose an arbitrary earning club');
SELECT assert_true(fn_cash_earning_club(u(180),u(181),u(12),u(40),NULL)=u(40),'a private game retains its game club and never pays union rake');

SELECT assert_true(refuses('UPDATE rake_attributions SET rake_record_id=u(199) WHERE id=u(102)','55000'),'moving a recorded attribution to a different source is forbidden');
SELECT assert_true(refuses('UPDATE rake_records SET id=u(199) WHERE id=u(100)','55000'),'changing the identity of a recorded rake source is forbidden');
SELECT assert_true(refuses('INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at) SELECT NULL,u(11),1,.25,''cash_rake_accrual'',id,earned_at FROM accounting_cash_rake_sources WHERE rake_record_id=u(100) AND player_id=u(12)','23514'),'null club cannot bypass exact source receipt scope');

-- The same person may have two separate agent accounts in different clubs.
INSERT INTO clubs VALUES(u(50),u(20),false);
INSERT INTO union_clubs(id,club_id,union_id,club_commission_rate) VALUES(u(51),u(50),u(20),.9);
INSERT INTO agents(id,club_id,user_id,role,status,commission_rate) VALUES(u(5),u(50),u(11),'agent','active',.25);
INSERT INTO club_members(club_id,user_id,agent_id,role,status,is_active) VALUES(u(50),u(52),u(11),'player','active',true);
INSERT INTO rake_records(id,hand_id,club_id,rake_amount,created_at,metadata) VALUES(u(150),u(151),u(20),8,clock_timestamp(),jsonb_build_object('accounting_source_version',2,'union_id',u(20),'is_private',false));
INSERT INTO rake_attributions VALUES(u(152),u(150),u(151),u(12),u(10),4),(u(153),u(150),u(151),u(52),u(50),4);
SELECT fn_accrue_cash_hand_commissions(u(151));
SELECT assert_true((SELECT count(*) FROM agent_commissions ac JOIN accounting_cash_rake_sources s ON s.id=ac.source_id WHERE s.rake_record_id=u(150) AND ac.user_id=u(11))=2,'same agent user earning in two clubs keeps both club-specific source rows');
SELECT assert_true((SELECT count(DISTINCT ac.club_id) FROM agent_commissions ac JOIN accounting_cash_rake_sources s ON s.id=ac.source_id WHERE s.rake_record_id=u(150) AND ac.user_id=u(11))=2,'cash commission never borrows a different club agent account');
SELECT assert_true(NOT has_table_privilege('service_role','accounting_cash_accrual_batches','INSERT') AND NOT has_table_privilege('service_role','accounting_cash_rake_sources','INSERT') AND NOT has_table_privilege('service_role','accounting_agreement_history','INSERT'),'engine callers cannot forge source receipts or agreement observations outside their private writer');
SELECT assert_true((fn_accounting_earning_contract(u(10),u(12),4,u(20),(SELECT created_at FROM rake_records WHERE id=u(100)))->'union_agreement'->'terms'->>'rate_cash')::numeric=.9,'earning contract preserves the observed union rate with its history identity');
CREATE FUNCTION test_trusted_registration_contract() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$SELECT fn_accounting_earning_contract(u(10),u(12),4,u(20),(SELECT created_at FROM rake_records WHERE id=u(100)))$$;
SET test.engine='false';
SET ROLE authenticated;
SELECT assert_true(refuses('SELECT fn_accounting_earning_contract(u(10),u(12),4,u(20),now())','42501'),'an application user cannot invoke the private contract reader');
SELECT assert_true(refuses('SELECT fn_accounting_terms_at(''agents'',u(1)::text,now())','42501'),'agreement history remains unavailable to direct application callers');
SELECT assert_true(test_trusted_registration_contract()->>'club_id'=u(10)::text,'trusted human registration can capture agreements without a service JWT');
RESET ROLE;
SET test.engine='true';
INSERT INTO club_members(club_id,user_id,role,status,is_active,player_rakeback_pct) VALUES(u(20),u(42),'player','active',true,0);
SELECT assert_true(fn_accounting_earning_contract(u(20),u(42),4,u(20),now())->>'is_union_house'='true'
 AND fn_accounting_earning_contract(u(20),u(42),4,u(20),now())->'union_agreement'='null'::jsonb,'house earning evidence is explicit and never invents a member-club agreement');
INSERT INTO rake_records(id,hand_id,club_id,rake_amount,created_at,metadata) VALUES(u(160),u(161),u(40),1,clock_timestamp(),jsonb_build_object('accounting_source_version',2,'union_id',NULL,'is_private',true));
INSERT INTO rake_attributions VALUES(u(162),u(160),u(161),u(41),u(40),1);
INSERT INTO accounting_routed_settlement_runs(standalone_club_id,period_start,period_end) VALUES(u(40),fn_union_week_start(now()),fn_union_week_start(now()+interval '8 days'));
SELECT assert_true(refuses('SELECT fn_accrue_cash_hand_commissions(u(161))','23514'),'a completed zero-source standalone week still refuses a late accrual');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_cash_accrual_batches WHERE rake_record_id=u(160)),'late source refusal leaves no partial batch');
DELETE FROM accounting_routed_settlement_runs WHERE standalone_club_id=u(40);
DROP TRIGGER test_seed_source_bank ON rake_records;
INSERT INTO rake_records(id,hand_id,club_id,rake_amount,created_at,metadata) VALUES(u(170),u(171),u(40),1,clock_timestamp(),jsonb_build_object('accounting_source_version',2,'union_id',NULL,'is_private',true));
INSERT INTO rake_attributions VALUES(u(172),u(170),u(171),u(41),u(40),1);
SELECT assert_true(refuses('SELECT fn_accrue_cash_hand_commissions(u(171))','23514'),'an unbanked private source cannot create payable commissions');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_cash_accrual_batches WHERE rake_record_id=u(170)),'unbanked source refusal leaves no certified batch');

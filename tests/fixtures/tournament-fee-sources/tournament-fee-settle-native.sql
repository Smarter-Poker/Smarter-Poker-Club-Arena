BEGIN;
CREATE TEMP TABLE settle_results(tournament_id uuid PRIMARY KEY,result jsonb);
SELECT fixture_fee(4000,true,1);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4000),1);
SELECT fn_settle_tournament_rake(u(4000),'fixture');
SELECT assert_true((SELECT balance=0 FROM fixture_tournament_fee_escrow WHERE tournament_id=u(4000)) AND (SELECT balance=1 FROM fixture_banks WHERE bank_kind='union'),'new proven fees move from exact escrow to actual union bank');
SELECT assert_true((fn_settle_tournament_rake(u(4000),'retry')->>'already_settled')::boolean AND (SELECT balance=1 FROM fixture_banks WHERE bank_kind='union'),'settlement retry never repeats bank transfer');
SELECT assert_true((SELECT count(*)=3 FROM agent_commissions WHERE source_id IN(SELECT id FROM accounting_tournament_fee_sources WHERE tournament_id=u(4000))) AND (SELECT count(*)=3 FROM vip_probe WHERE source_id=u(4000)),'terminal settlement preserves all commission contributors and VIP credit');
SELECT fixture_fee(4100,true,1);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4100),1);
SELECT set_config('fixture.stats_fail',u(4113)::text,true);
SELECT assert_sql_refuses('SELECT fn_settle_tournament_rake(u(4100),''fixture'')','injected_stats_failure','downstream failure rolls back fee bank transfer');
SELECT assert_true((SELECT balance=1 FROM fixture_tournament_fee_escrow WHERE tournament_id=u(4100)) AND (SELECT balance=1 FROM fixture_banks WHERE bank_kind='union') AND NOT EXISTS(SELECT 1 FROM tournament_rake_settlements WHERE tournament_id=u(4100)),'failed terminal transaction keeps fee in custody and no settlement claim');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_tournament_fee_recognitions WHERE tournament_id=u(4100)) AND NOT EXISTS(SELECT 1 FROM agent_commissions WHERE source_id IN(SELECT id FROM accounting_tournament_fee_sources WHERE tournament_id=u(4100))),'failed terminal transaction leaves no commission or recognition');
SELECT set_config('fixture.stats_fail','',true);
SELECT fn_settle_tournament_rake(u(4100),'retry');
SELECT assert_true((SELECT balance=2 FROM fixture_banks WHERE bank_kind='union'),'same failed terminal request safely succeeds once on retry');

SELECT fixture_fee(4200,true,1);
UPDATE tournament_players SET registered_at=transaction_timestamp()-interval '2 hours' WHERE tournament_id=u(4200);
UPDATE tournament_refund_entitlements SET created_at=transaction_timestamp()-interval '2 hours' WHERE tournament_id=u(4200);
UPDATE chip_ledger SET created_at=transaction_timestamp()-interval '2 hours' WHERE to_entity_id=u(4200);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4200),1);
SELECT assert_sql_refuses('SELECT fn_settle_tournament_rake(u(4200),''legacy'')',
 'tournament '||u(4200)||' rake attribution incomplete: tournament_fee_sources_require_reconciliation',
 'missing original attribution throws before positive fee banking');
SELECT assert_true((SELECT balance=1 FROM fixture_tournament_fee_escrow WHERE tournament_id=u(4200))
 AND (SELECT balance=2 FROM fixture_banks WHERE bank_kind='union')
 AND NOT EXISTS(SELECT 1 FROM tournament_rake_settlements WHERE tournament_id=u(4200)),
 'direct refusal rolls back its pending claim and retains the exact fee custody');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_tournament_fee_recognitions WHERE tournament_id=u(4200))
 AND NOT EXISTS(SELECT 1 FROM accounting_tournament_recognized_sources WHERE tournament_id=u(4200))
 AND NOT EXISTS(SELECT 1 FROM vip_probe WHERE source_id=u(4200)),
 'missing source proof creates no deferred recognition, guessed earnings or VIP amounts');
SELECT assert_sql_refuses('SELECT fn_defer_accounting_tournament_fees(u(4200),transaction_timestamp(),u(99),u(90),NULL,NULL,''tournament_fee_sources_require_reconciliation'')',
 'tournament_fee_positive_deferral_retired','the private deferral helper cannot bank a positive unattributed fee');
-- Historical incomplete replay is observational: it neither repairs the row
-- nor recredits the fee. This fixture seed is not a new successful settlement.
INSERT INTO tournament_rake_settlements(tournament_id,club_id,union_id,amount,destination,settled_at,attributed_users,attribution_error)
 VALUES(u(4200),u(99),u(90),1,'union:'||u(90)::text,now(),0,'original incomplete attribution');
DO $historical_refusals$
DECLARE fault jsonb;before_row jsonb;receipt jsonb;
BEGIN
 FOR fault IN SELECT value FROM jsonb_array_elements('[
  {"settled_at":null},{"attributed_at":null},{"attributed_users":null},
  {"attributed_users":-1},{"attribution_error":"original refusal"},
  {"destination":null},{"destination":""},{"destination":"pending"}]'::jsonb) LOOP
  UPDATE tournament_rake_settlements SET settled_at=now(),attributed_at=now(),attributed_users=1,
   attribution_error=NULL,destination='union:'||u(90)::text WHERE tournament_id=u(4200);
  SELECT to_jsonb(s)||fault INTO before_row FROM tournament_rake_settlements s WHERE tournament_id=u(4200);
  UPDATE tournament_rake_settlements SET settled_at=(before_row->>'settled_at')::timestamptz,
   attributed_at=(before_row->>'attributed_at')::timestamptz,attributed_users=(before_row->>'attributed_users')::int,
   attribution_error=before_row->>'attribution_error',destination=before_row->>'destination' WHERE tournament_id=u(4200);
  receipt:=fn_settle_tournament_rake(u(4200),'historical');
  PERFORM assert_true(receipt->>'reason'='settlement_attribution_incomplete' AND receipt->>'ok'='false'
   AND (SELECT to_jsonb(s)=before_row FROM tournament_rake_settlements s WHERE tournament_id=u(4200))
   AND (SELECT balance=2 FROM fixture_banks WHERE bank_kind='union'),
   'historical incomplete replay preserves original row: '||fault::text);
 END LOOP;
END $historical_refusals$;
DELETE FROM tournament_rake_settlements WHERE tournament_id=u(4200);

-- Faults are injected in the real canonical recognition writer's downstream
-- stats INSERT. Nontransactional sequence counts observe rolled-back attempts.
CREATE SEQUENCE fixture_recognition_attempts;
CREATE FUNCTION pg_temp.recognition_lock_fault() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE attempt bigint;BEGIN
 IF NEW.raw_id=u(4151) OR NEW.raw_id=u(4161) THEN
  attempt:=nextval('fixture_recognition_attempts');
  IF attempt<=current_setting('fixture.fail_attempts')::int THEN
   RAISE EXCEPTION 'injected recognition lock conflict' USING ERRCODE=current_setting('fixture.fail_state');
  END IF;
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER fixture_recognition_lock_fault BEFORE INSERT ON stats_probe FOR EACH ROW EXECUTE FUNCTION pg_temp.recognition_lock_fault();
SELECT fixture_fee(4150);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4150),1);
SELECT set_config('fixture.fail_attempts','1',true),set_config('fixture.fail_state','55P03',true);
INSERT INTO settle_results VALUES(u(4150),fn_settle_tournament_rake(u(4150),'transient'));
SELECT assert_true((SELECT result->>'attribution_attempts'='2' FROM settle_results WHERE tournament_id=u(4150))
 AND (SELECT last_value=2 FROM fixture_recognition_attempts)
 AND (SELECT balance=3 FROM fixture_banks WHERE bank_kind='union')
 AND (SELECT count(*)=1 FROM stats_probe WHERE raw_id=u(4151)),
 'transient canonical recognition retry retains one bank transfer and one attribution');
ALTER SEQUENCE fixture_recognition_attempts RESTART WITH 1;
SELECT fixture_fee(4160);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4160),1);
SELECT set_config('fixture.fail_attempts','4',true),set_config('fixture.fail_state','40P01',true);
SELECT assert_sql_refuses('SELECT fn_settle_tournament_rake(u(4160),''exhausted'')',
 'injected recognition lock conflict','four transient failures escape the entire owning settlement');
SELECT assert_true((SELECT last_value=4 FROM fixture_recognition_attempts)
 AND (SELECT balance=3 FROM fixture_banks WHERE bank_kind='union')
 AND (SELECT balance=1 FROM fixture_tournament_fee_escrow WHERE tournament_id=u(4160))
 AND NOT EXISTS(SELECT 1 FROM tournament_rake_settlements WHERE tournament_id=u(4160))
 AND NOT EXISTS(SELECT 1 FROM accounting_tournament_fee_recognitions WHERE tournament_id=u(4160))
 AND NOT EXISTS(SELECT 1 FROM stats_probe WHERE raw_id=u(4161))
 AND NOT EXISTS(SELECT 1 FROM agent_commissions WHERE source_id IN(SELECT id FROM accounting_tournament_fee_sources WHERE tournament_id=u(4160))),
 'exhaustion retains custody and no claim, attribution or commission from rolled-back attempts');
DROP TRIGGER fixture_recognition_lock_fault ON stats_probe;

-- Known exact zero remains complete without claiming any positive attribution.
INSERT INTO tournaments(id,club_id,union_id,is_private,tournament_type) VALUES(u(4170),u(99),u(90),false,'MTT');
INSERT INTO settle_results VALUES(u(4170),fn_settle_tournament_rake(u(4170),'zero'));
SELECT assert_true((SELECT result->>'no_attribution_due'='true' FROM settle_results WHERE tournament_id=u(4170))
 AND (SELECT amount=0 AND destination='none' AND attributed_at IS NOT NULL AND attributed_users=0 AND attribution_error IS NULL FROM tournament_rake_settlements WHERE tournament_id=u(4170))
 AND fn_settle_tournament_rake(u(4170),'zero-replay')->>'already_settled'='true',
 'exact zero completes and replays with explicit no-attribution-due proof');
-- Raw +fee/-fee is exact zero, but its historical source identity is missing.
INSERT INTO tournaments(id,club_id,union_id,is_private,tournament_type) VALUES(u(4180),u(99),u(90),false,'MTT');
INSERT INTO rake_records(id,tournament_id,is_tournament,club_id,rake_amount,source,metadata,created_at)
 VALUES(u(4181),u(4180),true,u(99),1,'legacy','{}',transaction_timestamp()-interval '2 hours'),
 (u(4182),u(4180),true,u(99),-1,'legacy','{}',transaction_timestamp()-interval '2 hours');
INSERT INTO settle_results VALUES(u(4180),fn_settle_tournament_rake(u(4180),'zero-history'));
SELECT assert_true((SELECT result->>'no_attribution_due'='true' FROM settle_results WHERE tournament_id=u(4180))
 AND fn_settle_tournament_rake(u(4180),'zero-history-replay')->>'already_settled'='true'
 AND (SELECT amount=0 AND attributed_users=0 AND attributed_at IS NOT NULL FROM tournament_rake_settlements WHERE tournament_id=u(4180))
 AND NOT EXISTS(SELECT 1 FROM accounting_tournament_fee_recognitions WHERE tournament_id=u(4180))
 AND NOT EXISTS(SELECT 1 FROM vip_probe WHERE source_id=u(4180))
 AND (SELECT balance=3 FROM fixture_banks WHERE bank_kind='union'),
 'exact-zero historical gap creates no invented recognition or bank movement');

SELECT fixture_fee(4300);
UPDATE tournaments SET is_private=true WHERE id=u(4300);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4300),1);
SELECT fn_settle_tournament_rake(u(4300),'private');
SELECT assert_true((SELECT union_id IS NULL AND destination='chip_retirement:'||u(99)::text FROM tournament_rake_settlements WHERE tournament_id=u(4300)) AND (SELECT balance=0 FROM fixture_banks WHERE bank_kind='club') AND (SELECT balance=0 FROM fixture_tournament_fee_escrow WHERE tournament_id=u(4300)) AND EXISTS(SELECT 1 FROM chip_ledger WHERE from_type='prize_liability' AND from_entity_id=u(4300) AND to_type='chip_retirement' AND to_entity_id IS NULL AND club_id=u(99) AND amount=1 AND category='burn'),'private tournament retires its fee and never credits either wallet even with a union value on event');
SELECT assert_true((SELECT balance=3 FROM fixture_banks WHERE bank_kind='union'),'private tournament never credits union rake');
SELECT assert_true((fn_settle_tournament_rake(u(4300),'private-replay')->>'already_settled')::boolean
 AND (SELECT count(*)=1 FROM chip_ledger WHERE from_entity_id=u(4300) AND to_type='chip_retirement')
 AND (SELECT total_rake=1 FROM clubs WHERE id=u(99)), 'standalone retry preserves one retirement and one statistics increment');
SELECT fixture_fee(4350);
UPDATE tournaments SET is_private=true WHERE id=u(4350);
INSERT INTO tournament_rake_settlements(tournament_id,club_id,amount,destination,settled_at,attributed_at,attributed_users)
 VALUES(u(4350),u(99),1,'club_treasury:'||u(99)::text,now(),now(),1);
SELECT assert_sql_refuses('SELECT fn_settle_tournament_rake(u(4350),''legacy-replay'')',
 'tournament_fee_legacy_treasury_leg_requires_adjustment','historical treasury settlement cannot be relabeled or repeated as retirement');


SELECT fixture_fee(4400);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4400),0.5);
SELECT assert_sql_refuses('SELECT fn_settle_tournament_rake(u(4400),''unfunded'')','fixture_fee_escrow_insufficient','short fee custody cannot be converted into funded rake');
SELECT fixture_fee(4500);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4500),1);
INSERT INTO accounting_routed_settlement_runs VALUES(u(90),NULL,fn_union_week_start(now()),((fn_union_week_start(now()) AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles');
SELECT assert_sql_refuses('SELECT fn_settle_tournament_rake(u(4500),''late'')','tournament_accrual_closed_period_requires_adjustment','zero-own completed week still refuses late source accrual');
SELECT assert_true((SELECT balance=1 FROM fixture_tournament_fee_escrow WHERE tournament_id=u(4500)) AND NOT EXISTS(SELECT 1 FROM tournament_rake_settlements WHERE tournament_id=u(4500)),'closed period refusal keeps source fee safely in custody');
DELETE FROM accounting_routed_settlement_runs;

INSERT INTO tournaments(id,club_id,union_id,is_private,tournament_type) VALUES(u(4600),u(99),NULL,false,'MTT');
SELECT set_config('fixture.diamond','true',true);
SELECT assert_true(fn_settle_tournament_rake(u(4600),'diamond')->>'asset'='diamonds','original Diamond branch survives verbatim');
SELECT set_config('fixture.diamond','false',true);
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_tournament_fee_recognitions WHERE tournament_id=u(4600)),'Diamond custody is excluded from chip recognition receipts');
SELECT assert_sql_refuses('INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at) VALUES(u(21),u(777),1,.25,''tournament_fee_accrual'',u(9876),now())','tournament_commission_recognized_source_required','forged tournament source UUID cannot create commission');
SELECT assert_sql_refuses('INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at) VALUES(u(21),u(777),1,.25,''tournament_rake_settlement'',u(9876),now())','tournament_commission_requires_canonical_source_writer','legacy commission writer cannot bypass source receipts');
SELECT assert_true(EXISTS(SELECT 1 FROM accounting_period_recompute_requests WHERE club_id=u(21) AND status='pending'),'recognized fee queues the shared weekly period calculation');
SELECT count(*) AS native_assertions FROM assertions;
COMMIT;

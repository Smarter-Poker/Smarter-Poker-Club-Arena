-- ISOLATED PG17 behavioral assertions, all synthetic.
SELECT test_accept('00000000-0000-4000-8000-000000001001');
SELECT test_assert('Whole hierarchy captured',
 (SELECT jsonb_array_length(hierarchy)=3 AND direct_commission_rate=.25
  AND player_rebate_rate=.10 AND player_rebate_entitlement=10 AND errors='[]'
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001001' AND player_id='00000000-0000-4000-8000-000000000201'));
SELECT test_assert('Source count and conserved allocation',
 (SELECT s.contributor_count=2 AND sum(f.rake_credit)=s.rake_total
 FROM ca_cash_commission_sources s JOIN ca_cash_commission_facts f USING(hand_id)
 WHERE hand_id='00000000-0000-4000-8000-000000001001'
 GROUP BY s.contributor_count,s.rake_total));
SELECT test_refuses('No commission before banked source',
 $$SELECT test_accrue('00000000-0000-4000-8000-000000001001')$$,'has not banked');
SELECT test_bank('00000000-0000-4000-8000-000000001001');
SELECT test_accrue('00000000-0000-4000-8000-000000001001');
SELECT test_accrue('00000000-0000-4000-8000-000000001001','00000000-0000-4000-8000-000000000202');
SELECT test_assert('Two contributors pay every tier once',
 (SELECT count(*)=6 AND sum(amount)=140 FROM agent_commissions WHERE source_id='00000000-0000-4000-8000-000000001001'));
SELECT test_assert('Actual transition-table rollup includes every contributor',
 (SELECT sum(owed)=140 AND sum(rows_behind)=6 FROM agent_commission_unsettled_rollup));
UPDATE agents SET commission_rate=.60 WHERE id='00000000-0000-4000-8000-000000000003';
UPDATE club_members SET agent_id='00000000-0000-4000-8000-000000000103',player_rakeback_pct=.20;
SELECT test_accrue('00000000-0000-4000-8000-000000001001');
SELECT test_assert('Replay preserves original payer and terms',
 (SELECT count(*)=6 AND sum(amount)=140 FROM agent_commissions WHERE source_id='00000000-0000-4000-8000-000000001001'));
SELECT test_assert('Captured terms never read reassignment on replay',
 (SELECT payer_user_id='00000000-0000-4000-8000-000000000101' AND player_rebate_rate=.10
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001001' AND player_id='00000000-0000-4000-8000-000000000201'));
SELECT test_refuses('Changed contributor amount refused',
 $$SELECT test_accrue('00000000-0000-4000-8000-000000001001','00000000-0000-4000-8000-000000000201',99)$$,'contradicts accepted');
SELECT test_refuses('Unknown source refused',
 $$SELECT test_accrue('00000000-0000-4000-8000-000000001999')$$,'Unknown cash');
SELECT test_refuses('Corrupt accepted hash refused',
 $$SELECT test_accept('00000000-0000-4000-8000-000000001002',200,
 '{"00000000-0000-4000-8000-000000000201":100,"00000000-0000-4000-8000-000000000202":100}',NULL,true)$$,'does not match');
SELECT test_assert('Corrupt capture rollback includes accepted fixture',
 NOT EXISTS(SELECT 1 FROM hand_atomic_commits WHERE hand_id='00000000-0000-4000-8000-000000001002'));
SELECT test_accept('00000000-0000-4000-8000-000000001003',200,
 '{"00000000-0000-4000-8000-000000000201":100,"00000000-0000-4000-8000-000000000202":100}',
 '[{"user_id":"00000000-0000-4000-8000-000000000201"}]');
SELECT test_assert('Legacy or missing generation never borrows a new seat',
 (SELECT bool_and(assignment_state='seat_unavailable') FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001003'));
UPDATE club_members SET agent_id='00000000-0000-4000-8000-000000000199',player_rakeback_pct=.10;
SELECT test_accept('00000000-0000-4000-8000-000000001004');
SELECT test_assert('Explicit missing assignment is not no-agent',
 (SELECT bool_and(assignment_state='assigned_invalid' AND errors ? 'accepted_assigned_agent_invalid')
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001004'));
UPDATE club_members SET agent_id='00000000-0000-4000-8000-000000000101';
UPDATE agents SET status='inactive' WHERE id='00000000-0000-4000-8000-000000000001';
SELECT test_accept('00000000-0000-4000-8000-000000001005');
SELECT test_assert('Inactive assigned agent does not become unassigned',
 (SELECT bool_and(assignment_state='assigned_invalid') FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001005'));
UPDATE agents SET status='active' WHERE id='00000000-0000-4000-8000-000000000001';
UPDATE club_members SET agent_id=NULL;
SELECT test_accept('00000000-0000-4000-8000-000000001006');
SELECT test_bank('00000000-0000-4000-8000-000000001006');
SELECT test_accrue('00000000-0000-4000-8000-000000001006');
SELECT test_assert('Genuine no-agent commission receipt cannot invent a rebate',
 (SELECT assignment_state='unassigned' AND player_rebate_entitlement IS NULL
   AND player_terms->>'rate_source'='legacy_volume_unbound'
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001006' AND player_id='00000000-0000-4000-8000-000000000201')
 AND NOT EXISTS(SELECT 1 FROM agent_commissions WHERE source_id='00000000-0000-4000-8000-000000001006'));
UPDATE club_members SET agent_id='00000000-0000-4000-8000-000000000101',player_rakeback_pct=.20;
SELECT test_accept('00000000-0000-4000-8000-000000001007');
SELECT test_assert('Player margin violation preserves exact requested rate without clipping',
 (SELECT bool_and(player_rebate_rate=.20 AND player_rebate_entitlement IS NULL AND errors ? 'accepted_player_rebate_margin_invalid')
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001007'));
UPDATE club_members SET player_rakeback_pct=0;
UPDATE agents SET player_rakeback_rate=0 WHERE id='00000000-0000-4000-8000-000000000001';
SELECT test_accept('00000000-0000-4000-8000-000000001008');
SELECT test_assert('Missing assigned terms do not invent a volume ladder',
 (SELECT bool_and(player_rebate_rate IS NULL AND errors ? 'accepted_player_rebate_terms_unavailable')
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001008'));
UPDATE agents SET player_rakeback_rate=.10,commission_rate=CASE WHEN id='00000000-0000-4000-8000-000000000003' THEN .70 ELSE commission_rate END;
SELECT test_accept('00000000-0000-4000-8000-000000001009');
SELECT test_bank('00000000-0000-4000-8000-000000001009');
UPDATE rake_records SET player_contributions='{}' WHERE hand_id='00000000-0000-4000-8000-000000001009';
SELECT test_refuses('Matching total with different contribution envelope is refused',
 $$SELECT test_accrue('00000000-0000-4000-8000-000000001009')$$,'has not banked');
SELECT test_refuses('Final receipt update refused',
 $$UPDATE ca_commission_contributor_receipts SET state='pending'$$,'Final commission');
SELECT test_refuses('Final receipt delete refused',
 $$DELETE FROM ca_commission_contributor_receipts$$,'Final commission');
SELECT test_refuses('Receipt truncate refused',
 $$TRUNCATE ca_commission_contributor_receipts$$,'Final commission');
SELECT test_refuses('Contributor identity guarded in actual append-only trigger stack',
 $$UPDATE agent_commissions SET contributing_user_id='00000000-0000-4000-8000-000000000209'$$,'contributing identity');
SELECT test_refuses('Source facts update refused',
 $$UPDATE ca_cash_commission_facts SET rake_credit=0$$,'source facts are immutable');
SELECT test_refuses('Source facts delete refused',
 $$DELETE FROM ca_cash_commission_facts$$,'source facts are immutable');
SELECT test_refuses('Source facts truncate refused',
 $$TRUNCATE ca_cash_commission_facts$$,'source facts are immutable');
SELECT test_assert('Service reads source facts only despite broad default grants',
 has_table_privilege('service_role','ca_cash_commission_facts','SELECT')
 AND NOT has_table_privilege('service_role','ca_cash_commission_facts','INSERT,UPDATE,DELETE,TRUNCATE'));
SELECT test_assert('Source helper hidden from every API role',
 NOT has_function_privilege('service_role','fn_ca_capture_cash_commission_source(uuid,jsonb)','execute')
 AND NOT has_function_privilege('anon','fn_ca_capture_cash_commission_source(uuid,jsonb)','execute')
 AND NOT has_function_privilege('authenticated','fn_ca_capture_cash_commission_source(uuid,jsonb)','execute'));
SELECT test_assert('Receipts cannot be forged through service table grants',
 NOT has_table_privilege('service_role','ca_commission_contributor_receipts','INSERT,UPDATE,DELETE,TRUNCATE'));
SELECT test_refuses('Service cannot invoke source helper',
 $$SET LOCAL ROLE service_role; SELECT fn_ca_capture_cash_commission_source('00000000-0000-4000-8000-000000001001','[]')$$,'permission denied');
SELECT test_refuses('Service cannot fabricate source facts',
 $$SET LOCAL ROLE service_role; INSERT INTO ca_cash_commission_sources(hand_id) VALUES(gen_random_uuid())$$,'permission denied');
-- Old banked rows remain outside the new admission path, with no adopted receipts.
INSERT INTO rake_records(hand_id,table_id,club_id,rake_amount,player_contributions)
 VALUES('00000000-0000-4000-8000-000000001010','00000000-0000-4000-8000-000000000950',
 '00000000-0000-4000-8000-000000000900',100,'{"00000000-0000-4000-8000-000000000201":100}');
SELECT test_accrue('00000000-0000-4000-8000-000000001010');
SELECT test_assert('Legacy zero-row source is never adopted',
 NOT EXISTS(SELECT 1 FROM ca_commission_contributor_receipts WHERE source_id='00000000-0000-4000-8000-000000001010')
 AND NOT EXISTS(SELECT 1 FROM agent_commissions WHERE source_id='00000000-0000-4000-8000-000000001010'));
SELECT test_accept('00000000-0000-4000-8000-000000001011');
SELECT test_bank('00000000-0000-4000-8000-000000001011');
CREATE FUNCTION test_fail_middle() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN IF NEW.user_id='00000000-0000-4000-8000-000000000102' THEN RAISE EXCEPTION 'middle tier failed'; END IF; RETURN NEW; END $f$;
CREATE TRIGGER test_fail_middle BEFORE INSERT ON agent_commissions FOR EACH ROW EXECUTE FUNCTION test_fail_middle();
SELECT test_refuses('Middle tier failure rolls all attribution back',
 $$SELECT test_accrue('00000000-0000-4000-8000-000000001011')$$,'middle tier failed');
SELECT test_assert('No partial receipt or rows after middle tier rollback',
 NOT EXISTS(SELECT 1 FROM agent_commissions WHERE source_id='00000000-0000-4000-8000-000000001011')
 AND NOT EXISTS(SELECT 1 FROM ca_commission_contributor_receipts WHERE source_id='00000000-0000-4000-8000-000000001011'));
DROP TRIGGER test_fail_middle ON agent_commissions;
SELECT name FROM test_checks ORDER BY name;

SELECT test_assert('Activation binds actual owner patch',
 (SELECT contract_version=1 AND accepted_owner_after_md5=md5(p.prosrc)
 FROM ca_cash_commission_authority a CROSS JOIN pg_proc p
 WHERE p.oid='public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure));
SELECT test_accept('00000000-0000-4000-8000-000000001012',.01,
 '{"00000000-0000-4000-8000-000000000201":1}');
SELECT test_assert('Sub-cent rebate entitlement is never rounded away per hand',
 (SELECT rake_credit=.01 AND player_rebate_rate=.10 AND player_rebate_entitlement=.001
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001012'));

SELECT test_bank('00000000-0000-4000-8000-000000001012');
SELECT test_accrue('00000000-0000-4000-8000-000000001012','00000000-0000-4000-8000-000000000201',.01);
SELECT test_assert('Cash receipt preserves exact differential and cumulative fractions',
 (SELECT count(*)=3 AND bool_and((j->>'exact_cumulative_entitlement')::numeric=.01*(j->>'contract_rate')::numeric)
 AND sum((j->>'exact_entitlement')::numeric)=.007
 AND bool_and(j->>'amount_authority'='compatibility_projection_only')
 FROM ca_commission_contributor_receipts r CROSS JOIN LATERAL jsonb_array_elements(r.allocations) j
 WHERE r.source_id='00000000-0000-4000-8000-000000001012'));

-- Funding terms are source facts, never a substitute for a bank receipt.
UPDATE tables SET union_id='00000000-0000-4000-8000-000000000901';
INSERT INTO union_clubs(club_id,union_id,rate_cash,club_commission_rate)
VALUES('00000000-0000-4000-8000-000000000900','00000000-0000-4000-8000-000000000901',.88,.90);
SELECT test_accept('00000000-0000-4000-8000-000000001113');
UPDATE union_clubs SET rate_cash=.77;
SELECT test_accept('00000000-0000-4000-8000-000000001114');
SELECT test_assert('Union rates retain the exact source-time game rate',
 (SELECT bool_and(funding_union_id='00000000-0000-4000-8000-000000000901' AND funding_club_rate=.88 AND funding_state='union_member')
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001113')
 AND (SELECT bool_and(funding_club_rate=.77) FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001114'));
SELECT test_assert('Funding route binds the accepted hand bank leg identity',
 (SELECT funding_route='union_rake_wallet' AND bank_leg_key=hand_id AND funding_context->>'table_union_id'='00000000-0000-4000-8000-000000000901'
 FROM ca_cash_commission_sources WHERE hand_id='00000000-0000-4000-8000-000000001113'));
UPDATE tables SET is_private=true;
SELECT test_accept('00000000-0000-4000-8000-000000001115');
SELECT test_assert('Private game excludes the Union even with a game Union stamp',
 (SELECT funding_union_id IS NULL AND funding_route='club_chip_treasury' FROM ca_cash_commission_sources WHERE hand_id='00000000-0000-4000-8000-000000001115')
 AND (SELECT bool_and(funding_club_rate=1 AND funding_state='club_treasury_owner') FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001115'));
UPDATE tables SET is_private=false,union_id=NULL;
UPDATE clubs SET union_id='00000000-0000-4000-8000-000000000901' WHERE id='00000000-0000-4000-8000-000000000900';
SELECT test_accept('00000000-0000-4000-8000-000000001116');
SELECT test_assert('Standalone game fallback preserves the accepted host club Union',
 (SELECT funding_union_id='00000000-0000-4000-8000-000000000901' AND funding_context->>'table_union_id' IS NULL
 FROM ca_cash_commission_sources WHERE hand_id='00000000-0000-4000-8000-000000001116'));
DELETE FROM union_clubs;
SELECT test_accept('00000000-0000-4000-8000-000000001117');
SELECT test_assert('Missing Union membership is explicit and never a default-rate payment',
 (SELECT bool_and(funding_state='union_membership_unavailable' AND funding_club_rate IS NULL)
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001117'));
INSERT INTO union_clubs(club_id,union_id,rate_cash,club_commission_rate)
VALUES('00000000-0000-4000-8000-000000000900','00000000-0000-4000-8000-000000000901',1.2,.90);
SELECT test_accept('00000000-0000-4000-8000-000000001118');
SELECT test_assert('Invalid Union rate is preserved without clipping or silent fallback',
 (SELECT bool_and(funding_state='union_rate_invalid' AND funding_club_rate=1.2)
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001118'));
UPDATE union_clubs SET rate_cash=NULL,club_commission_rate=.91;
SELECT test_accept('00000000-0000-4000-8000-000000001119');
SELECT test_assert('Configured Union club fallback preserves its fractional rate',
 (SELECT bool_and(funding_club_rate=.91 AND funding_terms->>'rate_source'='club_rate')
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001119'));
UPDATE union_clubs SET club_commission_rate=NULL;
SELECT test_accept('00000000-0000-4000-8000-000000001120');
SELECT test_assert('Installed default rate is explicit only for existing Union membership',
 (SELECT bool_and(funding_club_rate=.90 AND funding_terms->>'rate_source'='installed_default_90_percent')
 FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001120'));
UPDATE clubs SET union_id=NULL;DELETE FROM union_clubs;

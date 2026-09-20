CREATE FUNCTION spin_fixture.expect_refusal(label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 BEGIN
  PERFORM public.fn_settle_tournament_rake(spin_fixture.u(201),'mixed-cutover-negative');
  RAISE EXCEPTION 'Expected original settlement refusal';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN
  IF SQLERRM NOT LIKE '%rake attribution incomplete:%' THEN RAISE; END IF;
 END;
 PERFORM spin_fixture.assert(NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=spin_fixture.u(201))
  AND NOT EXISTS(SELECT 1 FROM public.accounting_mixed_cutover_spin_fee_proofs WHERE tournament_id=spin_fixture.u(201))
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE tournament_id=spin_fixture.u(201))
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=spin_fixture.u(201)),label);
END $$;
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.managed_game_contract_versions WHERE game_id=spin_fixture.u(201) AND version=1;
SET LOCAL session_replication_role=origin;
SELECT spin_fixture.expect_refusal('Missing original created scope refuses without any financial effect');
ROLLBACK;
BEGIN;
SET LOCAL session_replication_role=replica;
UPDATE public.managed_game_contract_versions SET contract_hash=repeat('0',64) WHERE game_id=spin_fixture.u(201) AND version=1;
SET LOCAL session_replication_role=origin;
SELECT spin_fixture.expect_refusal('False original contract hash refuses without any financial effect');
ROLLBACK;
BEGIN;
SET LOCAL session_replication_role=replica;
UPDATE public.managed_game_contract_versions SET union_id=spin_fixture.u(999) WHERE game_id=spin_fixture.u(201) AND version=1;
SET LOCAL session_replication_role=origin;
SELECT spin_fixture.expect_refusal('Typed and JSON original scope disagreement refuses');
ROLLBACK;
BEGIN;
SET LOCAL session_replication_role=replica;
UPDATE public.chip_ledger SET club_id=spin_fixture.u(999) WHERE tournament_id=spin_fixture.u(201) AND from_entity_id=spin_fixture.u(1) AND category='tournament_buyin';
SET LOCAL session_replication_role=origin;
SELECT spin_fixture.expect_refusal('Original debit funding club corruption refuses');
ROLLBACK;
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.accounting_agreement_history WHERE entity_type='club_members' AND subject_user_id=spin_fixture.u(3);
SET LOCAL session_replication_role=origin;
SELECT spin_fixture.expect_refusal('Missing third original agreement rolls back earlier canonical sources');
ROLLBACK;
BEGIN;
SET LOCAL session_replication_role=replica;
UPDATE public.accounting_tournament_fee_cutover SET starts_at=(SELECT min(registered_at)-interval '1 second' FROM public.tournament_players WHERE tournament_id=spin_fixture.u(201));
SET LOCAL session_replication_role=origin;
SELECT spin_fixture.expect_refusal('An all-post-cutover batch cannot use the mixed-cutover exception');
ROLLBACK;
BEGIN;
SET LOCAL session_replication_role=replica;
UPDATE public.rake_records SET created_at=(SELECT starts_at-interval '1 second' FROM public.accounting_tournament_fee_cutover) WHERE tournament_id=spin_fixture.u(201);
SET LOCAL session_replication_role=origin;
SELECT spin_fixture.expect_refusal('A pre-cutover aggregate fee remains refused');
ROLLBACK;

-- Refuse a downstream recognition only after original proof/source/bank writes.
-- The injected trigger verifies its exact fault location before raising.
CREATE FUNCTION spin_fixture.late_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tournament_id=spin_fixture.u(201) THEN
  IF (SELECT count(*) FROM public.accounting_tournament_fee_sources WHERE tournament_id=NEW.tournament_id)<>3
   OR NOT EXISTS(SELECT 1 FROM public.accounting_mixed_cutover_spin_fee_proofs WHERE tournament_id=NEW.tournament_id)
   OR NOT EXISTS(SELECT 1 FROM public.chip_ledger WHERE tournament_id=NEW.tournament_id AND to_type='chip_retirement') THEN
   RAISE EXCEPTION 'Late fault did not reach original proof and bank'; END IF;
  RAISE EXCEPTION 'injected_after_original_proof_and_bank' USING ERRCODE='P7777';
 END IF;RETURN NEW;END $$;
CREATE TRIGGER mixed_spin_late_test_failure BEFORE INSERT ON public.accounting_tournament_fee_recognitions
 FOR EACH ROW EXECUTE FUNCTION spin_fixture.late_failure();
DO $$ BEGIN
 BEGIN
  PERFORM public.fn_settle_tournament_rake(spin_fixture.u(201),'mixed-cutover-late-fault');
  RAISE EXCEPTION 'Late fault was not executed';
 EXCEPTION WHEN SQLSTATE 'P7777' THEN
  IF SQLERRM<>'injected_after_original_proof_and_bank' THEN RAISE; END IF;
 END;
 PERFORM spin_fixture.assert(NOT EXISTS(SELECT 1 FROM public.accounting_mixed_cutover_spin_fee_proofs WHERE tournament_id=spin_fixture.u(201))
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE tournament_id=spin_fixture.u(201))
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=spin_fixture.u(201))
  AND NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=spin_fixture.u(201))
  AND NOT EXISTS(SELECT 1 FROM public.chip_ledger WHERE tournament_id=spin_fixture.u(201) AND to_type='chip_retirement')
  AND (SELECT fee_balance=.48 FROM public.tournament_escrow WHERE tournament_id=spin_fixture.u(201)),
  'Downstream fault rolls proof sources original bank claim and recognition back atomically');
END $$;
DROP TRIGGER mixed_spin_late_test_failure ON public.accounting_tournament_fee_recognitions;

SELECT spin_fixture.assert(public.fn_settle_tournament_rake(spin_fixture.u(201),'mixed-cutover-proven')->>'ok'='true',
 'Actual original close qualifies and settles the proven mixed Spin');
SELECT spin_fixture.assert((SELECT count(*)=3 AND sum(rake_credit)=.48 FROM public.accounting_tournament_fee_sources WHERE tournament_id=spin_fixture.u(201))
 AND (SELECT count(*)=1 FROM public.accounting_mixed_cutover_spin_fee_proofs WHERE tournament_id=spin_fixture.u(201))
 AND (SELECT count(*)=1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=spin_fixture.u(201))
 AND (SELECT count(*)=1 AND sum(amount)=.48 FROM public.chip_ledger WHERE tournament_id=spin_fixture.u(201) AND to_type='chip_retirement')
 AND (SELECT fee_balance=0 FROM public.tournament_escrow WHERE tournament_id=spin_fixture.u(201)),
 'Three canonical sources conserve exact fee into one bank and recognition');
SELECT spin_fixture.assert((SELECT to_jsonb(b)=o.original FROM public.accounting_tournament_fee_batches b CROSS JOIN spin_fixture.original_batch o WHERE tournament_id=spin_fixture.u(201)),
 'Original legacy batch status manifest and capture timestamp remain exactly unchanged');
SELECT spin_fixture.assert((SELECT p.qualified_at>b.captured_at AND p.source_manifest->>'game_type'='spin'
 AND (p.original_evidence#>>'{scope,union_id}') IS NULL AND p.original_evidence#>>'{scope,asset}'='chips'
 FROM public.accounting_mixed_cutover_spin_fee_proofs p JOIN public.accounting_tournament_fee_batches b USING(rake_record_id) WHERE p.tournament_id=spin_fixture.u(201)),
 'Later proof timestamp and original standalone chip scope are explicit');
SELECT spin_fixture.assert(public.fn_settle_tournament_rake(spin_fixture.u(201),'mixed-cutover-replay')->>'already_settled'='true'
 AND (SELECT count(*)=1 FROM public.chip_ledger WHERE tournament_id=spin_fixture.u(201) AND to_type='chip_retirement'),
 'Duplicate original close returns the original receipt without a second payment');
DO $$ DECLARE command text; BEGIN
 FOREACH command IN ARRAY ARRAY[
  'UPDATE public.accounting_mixed_cutover_spin_fee_proofs SET qualified_at=now()',
  'DELETE FROM public.accounting_mixed_cutover_spin_fee_proofs',
  'TRUNCATE public.accounting_mixed_cutover_spin_fee_proofs'] LOOP
  BEGIN EXECUTE command;RAISE EXCEPTION 'Immutable proof changed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 END LOOP;
 PERFORM spin_fixture.assert(true,'Qualified proof refuses update delete and truncate');
END $$;
SELECT spin_fixture.assert(NOT has_function_privilege('authenticated','public.fn_accounting_qualify_mixed_cutover_spin_fee(uuid)','EXECUTE')
 AND NOT has_function_privilege('service_role','public.fn_accounting_qualify_mixed_cutover_spin_fee(uuid)','EXECUTE')
 AND NOT has_table_privilege('service_role','public.accounting_mixed_cutover_spin_fee_proofs','INSERT'),
 'Qualification stays private to original financial close and proof is read-only');

SELECT spin_fixture.assert(public.fn_accounting_tournament_week_quality(spin_fixture.u(101),now()-interval '1 day',now()+interval '1 day')->>'status'='ready',
 'Existing weekly quality reader accepts the original recognized mixed proof');

SELECT spin_fixture.assert((SELECT count(*)=3 AND sum(amount)=.12 FROM public.agent_commissions
 WHERE source_id IN(SELECT id FROM public.accounting_tournament_fee_sources WHERE tournament_id=spin_fixture.u(201)))
 AND (SELECT commission_rate=.50 FROM public.agents WHERE id=spin_fixture.u(801))
 AND (SELECT bool_and((contract#>>'{tiers,0,rate}')::numeric=.25) FROM public.accounting_tournament_fee_sources WHERE tournament_id=spin_fixture.u(201)),
 'Delayed original sources post the historical agent rate despite a later current rate change');
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.accounting_mixed_cutover_spin_fee_proofs WHERE tournament_id=spin_fixture.u(201);
SET LOCAL session_replication_role=origin;
DO $$ BEGIN
 BEGIN PERFORM public.fn_accounting_tournament_fee_net_plan(spin_fixture.u(201));RAISE EXCEPTION 'Missing proof accepted';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'tournament_fee_sources_require_reconciliation' THEN RAISE;END IF;END;
 PERFORM spin_fixture.assert(true,'Canonical source rows alone never qualify an unchanged legacy batch without its proof');
END $$;
ROLLBACK;
BEGIN;
SET LOCAL session_replication_role=replica;
UPDATE public.accounting_mixed_cutover_spin_fee_proofs SET canonical_sources=jsonb_set(canonical_sources,'{0,rake_credit}','99'::jsonb)
 WHERE tournament_id=spin_fixture.u(201);
SET LOCAL session_replication_role=origin;
DO $$ BEGIN
 BEGIN PERFORM public.fn_accounting_tournament_fee_net_plan(spin_fixture.u(201));RAISE EXCEPTION 'False proof accepted';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'tournament_fee_sources_require_reconciliation' THEN RAISE;END IF;END;
 PERFORM spin_fixture.assert(true,'A proof that does not bind exact canonical source rows is refused');
END $$;
ROLLBACK;

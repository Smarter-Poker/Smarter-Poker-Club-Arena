CREATE FUNCTION assert_sql_refuses(statement text,expected text,name text) RETURNS void LANGUAGE plpgsql AS $$DECLARE message text;BEGIN
 BEGIN EXECUTE statement;EXCEPTION WHEN OTHERS THEN message:=SQLERRM;END;
 PERFORM assert_true(message=expected,name||COALESCE(' ['||message||']',' [unexpected success]'));
END$$;
BEGIN;
SELECT fixture_fee(2000);
UPDATE rake_records SET metadata=metadata-'accounting_source_version'-'accounting_fee_source' WHERE id=u(2001);
SET CONSTRAINTS accounting_tournament_fee_commit_capture IMMEDIATE;
SELECT assert_true(count(*)=1 AND sum(rake_credit)=1,'common producer hook stamps and captures exact existing charge receipts') FROM accounting_tournament_fee_sources WHERE rake_record_id=u(2001);
SELECT assert_true(source_version=2 AND source_manifest->>'game_type'='mtt','producer hook stores durable provenance without rewriting sealed raw evidence') FROM accounting_tournament_fee_batches WHERE rake_record_id=u(2001);
SET CONSTRAINTS accounting_tournament_fee_commit_capture DEFERRED;
SELECT fixture_fee(2100,true,0.01);
SET CONSTRAINTS accounting_tournament_fee_commit_capture IMMEDIATE;
SELECT assert_true(count(*)=3 AND sum(rake_credit)=0.01,'common hook captures all three exact Spin funding receipts') FROM accounting_tournament_fee_sources WHERE rake_record_id=u(2101);
SELECT assert_sql_refuses('UPDATE accounting_tournament_fee_sources SET rake_credit=0 WHERE rake_record_id=u(2001)','accounting_tournament_fee_receipt_is_immutable','source receipts are immutable');
SELECT assert_sql_refuses('UPDATE rake_records SET rake_amount=2 WHERE id=u(2001)','captured_tournament_fee_source_is_immutable','captured raw fee is immutable');
SELECT assert_sql_refuses('DELETE FROM rake_records WHERE id=u(2001)','captured_tournament_fee_source_is_immutable','captured raw fee cannot be deleted');
UPDATE rake_records SET terminal_closed_at=now() WHERE id=u(2001);
SELECT assert_true((fn_stamp_accounting_tournament_fee(u(2001))->>'replayed')::boolean,'terminal stamp preserves original economic source identity');
SELECT assert_sql_refuses('TRUNCATE accounting_tournament_fee_sources','accounting_tournament_fee_receipt_is_immutable','source receipt truncate is refused');
SELECT assert_sql_refuses('UPDATE accounting_tournament_fee_cutover SET starts_at=now()','accounting_tournament_fee_receipt_is_immutable','cutover cannot be moved');
SET CONSTRAINTS accounting_tournament_fee_commit_capture DEFERRED;
DO $$DECLARE msg text;BEGIN
 BEGIN
  PERFORM fixture_fee(2200);
  INSERT INTO tournament_refund_entitlements SELECT u(2299),tournament_id,user_id,refund_wallet_club_id,source_ledger_id,created_at,gross,refund_fee,entitlement_kind,charge_category,registration_id,source_ticket_id,source_satellite_id FROM tournament_refund_entitlements WHERE id=u(2241);
  SET CONSTRAINTS accounting_tournament_fee_commit_capture IMMEDIATE;
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 PERFORM assert_true(msg='tournament_fee_exact_charge_ambiguous' AND NOT EXISTS(SELECT 1 FROM rake_records WHERE id=u(2201)),'ambiguous charge aborts original fee transaction with no source');
END$$;
DO $$DECLARE msg text;BEGIN
 BEGIN
  PERFORM fixture_fee(2300);
  UPDATE rake_records SET source='unknown_producer' WHERE id=u(2301);
  SET CONSTRAINTS accounting_tournament_fee_commit_capture IMMEDIATE;
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 PERFORM assert_true(msg='tournament_fee_source_unsupported' AND NOT EXISTS(SELECT 1 FROM rake_records WHERE id=u(2301)),'unknown fee producer cannot commit unaccounted new charge');
END$$;
SELECT assert_true(NOT has_function_privilege('authenticated','fn_stamp_accounting_tournament_fee(uuid)','execute'),'authenticated caller cannot directly forge a producer stamp');
SELECT assert_true(NOT has_function_privilege('authenticated','fn_accounting_tournament_fee_commit_capture()','execute'),'authenticated caller cannot directly invoke commit trigger');
-- Simulate a producer whose existing terminal evidence has already sealed the
-- raw row before deferred capture. The new accounting hook must only read it.
SELECT fixture_fee(2400);
CREATE FUNCTION fixture_fee_already_sealed() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF OLD.id=u(2401) THEN RAISE EXCEPTION 'fixture_raw_already_sealed';END IF;RETURN NEW;
END$$;
CREATE TRIGGER fixture_fee_already_sealed BEFORE UPDATE ON rake_records FOR EACH ROW EXECUTE FUNCTION fixture_fee_already_sealed();
CREATE TEMP TABLE sealed_fee_before AS SELECT to_jsonb(r) evidence FROM rake_records r WHERE id=u(2401);
SET CONSTRAINTS accounting_tournament_fee_commit_capture IMMEDIATE;
SELECT assert_true(EXISTS(SELECT 1 FROM accounting_tournament_fee_sources WHERE rake_record_id=u(2401)) AND (SELECT to_jsonb(r)=b.evidence FROM rake_records r CROSS JOIN sealed_fee_before b WHERE r.id=u(2401)),'capture succeeds after a producer seals its raw evidence without rewriting that evidence');
DROP TRIGGER fixture_fee_already_sealed ON rake_records;
DROP FUNCTION fixture_fee_already_sealed();
SET CONSTRAINTS accounting_tournament_fee_commit_capture DEFERRED;
SELECT fixture_fee(2500,true,0.03);
SELECT set_config('fixture.missing_player',u(2512)::text,true);
SET CONSTRAINTS accounting_tournament_fee_commit_capture IMMEDIATE;
SELECT assert_true(EXISTS(SELECT 1 FROM rake_records WHERE id=u(2501) AND rake_amount=0.03)
 AND NOT EXISTS(SELECT 1 FROM accounting_tournament_fee_sources WHERE rake_record_id=u(2501)),
 'one missing Spin contributor agreement preserves original charge and rolls back every partial source');
SELECT assert_true(status='legacy_unverified' AND rake_amount=0.03
 AND source_manifest->>'capture_reason'='accounting_terms_not_observed'
 AND jsonb_array_length(source_manifest->'contributors')=3,
 'missing history leaves immutable full funding manifest with exact durable reason')
 FROM accounting_tournament_fee_batches WHERE rake_record_id=u(2501);
SELECT set_config('fixture.missing_player','',true);
SELECT assert_true(fn_stamp_accounting_tournament_fee(u(2501))->>'status'='legacy_unverified'
 AND NOT EXISTS(SELECT 1 FROM accounting_tournament_fee_sources WHERE rake_record_id=u(2501)),
 'later agreement availability cannot retroactively upgrade a deferred original charge');
SELECT count(*) AS native_assertions FROM assertions;
COMMIT;

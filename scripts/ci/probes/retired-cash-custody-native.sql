BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s';
CREATE FUNCTION pg_temp.expect_refusal(q text,expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE denied boolean:=false; BEGIN BEGIN EXECUTE q; EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM=expected; END; IF NOT denied THEN RAISE EXCEPTION 'wrong or missing refusal: %',q; END IF; END$$;
INSERT INTO smarter_private.retired_cash_hand_qualification VALUES('89000000-0000-4000-8000-000000000001','synthetic','89000000-0000-4000-8000-000000000002',1,'{}');
SELECT pg_temp.expect_refusal('UPDATE smarter_private.retired_cash_hand_qualification SET request_hash=''changed''','RETIRED_CASH_QUALIFICATION_IMMUTABLE');
SELECT pg_temp.expect_refusal('DELETE FROM smarter_private.retired_cash_hand_qualification','RETIRED_CASH_QUALIFICATION_IMMUTABLE');
SELECT pg_temp.expect_refusal('TRUNCATE smarter_private.retired_cash_hand_qualification','RETIRED_CASH_QUALIFICATION_IMMUTABLE');
INSERT INTO smarter_private.retired_cash_hand_custody(submission_id,user_id,table_id,hand_number,seat_id,occupancy_id,seat_joined_at,stack_before,stack_after,funding_club_id,original_left_at,original_inventory_event,request_hash,transaction_id,restore_key,issuance_ledger,original_time_bank,state)
VALUES('89000000-0000-4000-8000-000000000001','89000000-0000-4000-8000-000000000003','89000000-0000-4000-8000-000000000002',1,'89000000-0000-4000-8000-000000000004','89000000-0000-4000-8000-000000000005','2020-01-01',10,9,'89000000-0000-4000-8000-000000000006','2020-01-02',1,'synthetic',txid_current(),'synthetic','89000000-0000-4000-8000-000000000007','{"seconds_remaining":20}','held');
SELECT pg_temp.expect_refusal('UPDATE smarter_private.retired_cash_hand_custody SET transaction_id=0','RETIRED_CASH_CUSTODY_TRANSACTION_REQUIRED');
SELECT pg_temp.expect_refusal('UPDATE smarter_private.retired_cash_hand_custody SET stack_before=11','RETIRED_CASH_CUSTODY_TRANSITION_REFUSED');
SELECT pg_temp.expect_refusal('UPDATE smarter_private.retired_cash_hand_custody SET state=''consumed''','RETIRED_CASH_CUSTODY_TRANSITION_REFUSED');
UPDATE smarter_private.retired_cash_hand_custody SET state='consumed',settlement_id='89000000-0000-4000-8000-000000000008';
SELECT pg_temp.expect_refusal('UPDATE smarter_private.retired_cash_hand_custody SET accepted_time_bank=''{}''','RETIRED_CASH_CUSTODY_TRANSITION_REFUSED');
UPDATE smarter_private.retired_cash_hand_custody SET accepted_time_bank=original_time_bank;
SELECT pg_temp.expect_refusal('UPDATE smarter_private.retired_cash_hand_custody SET state=''held''','RETIRED_CASH_CUSTODY_TRANSITION_REFUSED');
SELECT pg_temp.expect_refusal('DELETE FROM smarter_private.retired_cash_hand_custody','RETIRED_CASH_CUSTODY_IMMUTABLE');
SELECT pg_temp.expect_refusal('TRUNCATE smarter_private.retired_cash_hand_custody','RETIRED_CASH_CUSTODY_IMMUTABLE');
DO $$BEGIN
IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r CROSS JOIN unnest(ARRAY['smarter_private.retired_cash_hand_custody','smarter_private.retired_cash_hand_qualification']) t WHERE has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) THEN RAISE EXCEPTION 'private custody ACL changed'; END IF;
IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r WHERE n.nspname='smarter_private' AND has_function_privilege(r,p.oid,'EXECUTE')) THEN RAISE EXCEPTION 'private trigger execute ACL changed';END IF;
IF (SELECT count(*) FROM pg_trigger WHERE tgrelid IN('smarter_private.retired_cash_hand_custody'::regclass,'smarter_private.retired_cash_hand_qualification'::regclass) AND NOT tgisinternal AND tgenabled='O')<>4 THEN RAISE EXCEPTION 'native guard count changed';END IF;
IF (SELECT md5(pg_get_functiondef('smarter_private.retired_cash_custody_guard()'::regprocedure)))<>'c71ea822a1a5af7fe346ef709307a666' OR (SELECT md5(pg_get_functiondef('smarter_private.retired_cash_qualification_immutable()'::regprocedure)))<>'90bf12c7aa691f199a0c79983ab04b02' THEN RAISE EXCEPTION 'native guard postimage changed';END IF;
END$$;
ROLLBACK;
DO $$BEGIN IF EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_custody) OR EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_qualification) THEN RAISE EXCEPTION 'rollback leaked custody';END IF;END$$;
SELECT 'RETIRED_CASH_CUSTODY_NATIVE_PASS';

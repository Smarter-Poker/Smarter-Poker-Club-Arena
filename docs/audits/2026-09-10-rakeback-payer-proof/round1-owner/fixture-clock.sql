-- NATIVE FIXTURE ONLY. These timestamps simulate closed historical calendars.
-- Actual production owner bodies/defaults are unchanged. Current-time cases leave
-- both settings empty and prove open-period refusal before synthetic closed tests.
CREATE FUNCTION public.test_funding_clock() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
 IF TG_TABLE_NAME='hand_atomic_commits' THEN
  v:=nullif(current_setting('test.funding_accepted_at',true),'');
  IF v IS NOT NULL THEN NEW.committed_at:=v::timestamptz; END IF;
 ELSE
  v:=nullif(current_setting('test.funding_bank_at',true),'');
  IF v IS NOT NULL THEN NEW.created_at:=v::timestamptz; END IF;
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER aaa_test_funding_clock BEFORE INSERT ON hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION test_funding_clock();
CREATE TRIGGER aaa_test_funding_clock BEFORE INSERT ON union_wallet_transactions FOR EACH ROW EXECUTE FUNCTION test_funding_clock();
CREATE TRIGGER aaa_test_funding_clock BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION test_funding_clock();

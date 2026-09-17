-- Recreate the observed gap through the actual invoice sender. Only fixture
-- identity/timestamps are deterministic; message/delivery links are real.
INSERT INTO profiles(id,username) VALUES('47965354-0e56-43ef-931c-ddaab82af765','Historical Recipient');
CREATE TEMP TABLE historical_push_expected(ledger_id uuid,invoice_id uuid,notification_id uuid,invoice_number text);
INSERT INTO historical_push_expected VALUES
 (u(906),'20ed34bc-e67e-4314-a1f4-c96f949a9c23','3f4b5fa5-31f3-40fd-90d7-53c5e716c36f','CA-2026-00000021'),
 (u(907),'f83a2043-425d-45c6-958f-e6c6f31c38b3','51372859-0e2f-497b-995b-f6f2913db5ef','CA-2026-00000030'),
 (u(908),'a11e1fc6-0212-404f-8a08-bbba739f1181','c5843eb1-1b7a-4e8f-9723-e9f0ca87cadb','CA-2026-00000081'),
 (u(909),'8795ed62-dabe-4db4-8659-5cac09ecab48','f829e025-54b6-4e0a-a6bc-ac78d7bc2a91','CA-2026-00000036');
CREATE FUNCTION fixture_historical_invoice_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected record; BEGIN
 SELECT invoice_id,invoice_number INTO expected FROM historical_push_expected WHERE ledger_id=NEW.source_ledger_id;
 IF FOUND THEN NEW.id:=expected.invoice_id; NEW.invoice_number:=expected.invoice_number; END IF; RETURN NEW;
END $$;
CREATE FUNCTION fixture_historical_notification_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected uuid; BEGIN
 SELECT notification_id INTO expected FROM historical_push_expected WHERE invoice_id::text=NEW.data->>'invoice_id';
 IF FOUND THEN NEW.id:=expected; NEW.created_at:='2026-09-14 11:34:35.237266+00'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER fixture_historical_invoice_identity BEFORE INSERT ON settlement_invoices FOR EACH ROW EXECUTE FUNCTION fixture_historical_invoice_identity();
CREATE TRIGGER fixture_historical_notification_identity BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fixture_historical_notification_identity();
SELECT fixture_transfer(ledger_id,'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001') FROM historical_push_expected;
DROP TRIGGER fixture_historical_invoice_identity ON settlement_invoices;
DROP TRIGGER fixture_historical_notification_identity ON notifications;
SELECT assert_true((SELECT count(*)=4 FROM accounting_invoice_deliveries d JOIN historical_push_expected e ON e.invoice_id=d.invoice_id AND e.notification_id=d.notification_id WHERE d.recipient_id='47965354-0e56-43ef-931c-ddaab82af765'),'historical fixture uses four actual sender deliveries');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM push_outbox p JOIN historical_push_expected e ON p.related_entity_id=e.notification_id),'old bridge reproduces four missing historical receipts');

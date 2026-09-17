CREATE TRIGGER accounting_invoice_immutable BEFORE UPDATE OR DELETE ON settlement_invoices FOR EACH ROW EXECUTE FUNCTION fn_accounting_document_immutable();
CREATE TRIGGER accounting_message_immutable BEFORE UPDATE OR DELETE ON social_messages FOR EACH ROW EXECUTE FUNCTION fn_accounting_document_immutable();
CREATE TRIGGER accounting_conversation_audience BEFORE INSERT OR UPDATE OR DELETE ON social_conversation_participants FOR EACH ROW EXECUTE FUNCTION fn_accounting_conversation_audience_guard();
CREATE TRIGGER accounting_invoice_deliver AFTER INSERT ON settlement_invoices FOR EACH ROW EXECUTE FUNCTION fn_accounting_invoice_deliver_on_insert();
CREATE TRIGGER accounting_transfer_document AFTER INSERT ON chip_ledger FOR EACH ROW
 WHEN (NEW.status='posted' AND (NEW.from_type IN ('union_wallet','union_bank','club_treasury','player_wallet','agent_wallet') OR (NEW.from_type='settlement_suspense' AND NEW.category='rakeback')) AND NEW.to_type IN ('union_wallet','union_bank','club_treasury','player_wallet','agent_wallet')) EXECUTE FUNCTION fn_accounting_transfer_document_on_insert();
-- Fault injection occurs after an actual invoice and Messenger insertion, inside the real notification path.
CREATE FUNCTION test_real_notification_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('test.delivery_failure',true)=NEW.metadata->'lines'->>'category' THEN RAISE EXCEPTION 'test real notification failure';END IF;
 RETURN NEW;END$$;
CREATE TRIGGER test_real_notification_fault BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION test_real_notification_fault();

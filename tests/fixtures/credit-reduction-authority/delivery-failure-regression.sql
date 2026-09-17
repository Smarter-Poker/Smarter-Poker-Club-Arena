\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Owner-installed faults, actual authenticated operation.
-- No financial function is replaced. Every injected trigger is dropped afterward
-- and the enclosing main fixture rolls its entire catalog/row work back.
RESET ROLE;
CREATE FUNCTION pg_temp.cr_delivery_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_ARGV[0]='suppress' THEN RETURN NULL;END IF;
 IF TG_ARGV[0]='link_only' THEN NEW.link:='/unexpected-credit-destination';RETURN NEW;END IF;
 IF TG_ARGV[0]='missing_credit_source' THEN NEW.source_credit_reduction_operation_id:=NULL;RETURN NEW;END IF;
 IF TG_ARGV[0]='unknown_credit_source' THEN NEW.source_credit_reduction_operation_id:=pg_temp.cr_id(1999);RETURN NEW;END IF;
 IF TG_ARGV[0]='duplicate_credit_source' THEN
  NEW.source_credit_reduction_operation_id:=(SELECT (response->'receipt'->>'receipt_id')::uuid FROM cr_saved WHERE label='main');
  RETURN NEW;
 END IF;
 IF TG_ARGV[0]='wrong_credit_source' THEN
  NEW.source_credit_reduction_operation_id:=(SELECT (response->'receipt'->>'receipt_id')::uuid FROM cr_saved WHERE label='no_change');
  RETURN NEW;
 END IF;
 IF TG_ARGV[0]='mixed_credit_source' THEN NEW.source_ledger_id:=pg_temp.cr_id(1999);RETURN NEW;END IF;
 IF TG_ARGV[0]='ordinary_credit_source' THEN NEW.invoice_type:='transaction_receipt';RETURN NEW;END IF;
 IF TG_TABLE_NAME='accounting_credit_change_documents_v1' THEN NEW.recipient_name:='Tampered recipient';
 ELSIF TG_TABLE_NAME='settlement_invoices' THEN NEW.notes:='Unexpected hidden note';
 ELSIF TG_TABLE_NAME='social_messages' THEN NEW.content:='Tampered credit body';
 ELSIF TG_TABLE_NAME='notifications' THEN NEW.message:='Tampered credit notice';
 ELSIF TG_TABLE_NAME='push_outbox' THEN NEW.body:='Tampered credit push';
 ELSE RAISE EXCEPTION 'unsupported fixture fault target';END IF;
 RETURN NEW;
END$$;
CREATE FUNCTION pg_temp.cr_expect_atomic_failure(q jsonb,wanted_state text,wanted_message text,
 wanted_table text DEFAULT NULL,wanted_column text DEFAULT NULL,force_deferred boolean DEFAULT false)
 RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_book jsonb;got_state text;got_message text;got_table text;got_column text;BEGIN
 before_book:=pg_temp.cr_book();
 BEGIN
  PERFORM pg_temp.cr_apply(q);
  IF force_deferred THEN SET CONSTRAINTS ALL IMMEDIATE;END IF;
  RAISE EXCEPTION 'injected accounting fault was accepted';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS got_state=RETURNED_SQLSTATE,got_message=MESSAGE_TEXT,got_table=TABLE_NAME,got_column=COLUMN_NAME;
  IF got_state IS DISTINCT FROM wanted_state OR (wanted_message IS NOT NULL AND got_message IS DISTINCT FROM wanted_message)
   OR (wanted_table IS NOT NULL AND got_table IS DISTINCT FROM wanted_table)
   OR (wanted_column IS NOT NULL AND got_column IS DISTINCT FROM wanted_column)
  THEN RAISE EXCEPTION 'wrong failure: state=%, message=%, table=%, column=%',got_state,got_message,got_table,got_column;END IF;
 END;
 PERFORM pg_temp.cr_check(pg_temp.cr_book()=before_book,
  'exact full-book rollback after '||COALESCE(wanted_message,wanted_state||':'||wanted_table||':'||wanted_column));
END$$;
GRANT EXECUTE ON FUNCTION pg_temp.cr_expect_atomic_failure(jsonb,text,text,text,text,boolean) TO authenticated;
CREATE TEMP TABLE cr_failure_intent(q jsonb NOT NULL);
SELECT pg_temp.cr_actor(pg_temp.cr_id(1));
INSERT INTO cr_failure_intent SELECT pg_temp.cr_intent(
 public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(20)),pg_temp.cr_id(1201),7,'Exact delivery failure intent');
GRANT SELECT ON cr_failure_intent TO authenticated;
CREATE TRIGGER fixture_credit_document BEFORE INSERT ON public.accounting_credit_change_documents_v1
 FOR EACH ROW EXECUTE FUNCTION pg_temp.cr_delivery_fault('suppress');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_change_provenance_write_missing') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_document ON public.accounting_credit_change_documents_v1;
CREATE TRIGGER fixture_credit_document BEFORE INSERT ON public.accounting_credit_change_documents_v1
 FOR EACH ROW EXECUTE FUNCTION pg_temp.cr_delivery_fault('transform');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_change_provenance_write_missing') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_document ON public.accounting_credit_change_documents_v1;
CREATE TRIGGER fixture_credit_invoice BEFORE INSERT ON public.settlement_invoices FOR EACH ROW
 WHEN(NEW.invoice_type='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('suppress');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_change_invoice_write_missing') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_invoice ON public.settlement_invoices;
CREATE TRIGGER fixture_credit_invoice BEFORE INSERT ON public.settlement_invoices FOR EACH ROW
 WHEN(NEW.invoice_type='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('transform');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_change_document_contract_mismatch') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_invoice ON public.settlement_invoices;
-- One immutable source means an actual operation, never a type-only exception,
-- mixed financial source, ordinary receipt using the new source, or another op.
CREATE TRIGGER fixture_credit_invoice BEFORE INSERT ON public.settlement_invoices FOR EACH ROW
 WHEN(NEW.invoice_type='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('missing_credit_source');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','new row for relation "settlement_invoices" violates check constraint "accounting_invoice_has_one_source"','settlement_invoices') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_invoice ON public.settlement_invoices;
CREATE TRIGGER fixture_credit_invoice BEFORE INSERT ON public.settlement_invoices FOR EACH ROW
 WHEN(NEW.invoice_type='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('unknown_credit_source');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23503','insert or update on table "settlement_invoices" violates foreign key constraint "accounting_invoice_credit_reduction_source_fk"','settlement_invoices') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_invoice ON public.settlement_invoices;
CREATE TRIGGER fixture_credit_invoice BEFORE INSERT ON public.settlement_invoices FOR EACH ROW
 WHEN(NEW.invoice_type='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('duplicate_credit_source');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23505','duplicate key value violates unique constraint "accounting_invoice_credit_reduction_source_unique"','settlement_invoices') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_invoice ON public.settlement_invoices;
CREATE TRIGGER fixture_credit_invoice BEFORE INSERT ON public.settlement_invoices FOR EACH ROW
 WHEN(NEW.invoice_type='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('wrong_credit_source');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_change_document_contract_mismatch') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_invoice ON public.settlement_invoices;
CREATE TRIGGER fixture_credit_invoice BEFORE INSERT ON public.settlement_invoices FOR EACH ROW
 WHEN(NEW.invoice_type='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('mixed_credit_source');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','new row for relation "settlement_invoices" violates check constraint "accounting_invoice_has_one_source"','settlement_invoices') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_invoice ON public.settlement_invoices;
CREATE TRIGGER fixture_credit_invoice BEFORE INSERT ON public.settlement_invoices FOR EACH ROW
 WHEN(NEW.invoice_type='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('ordinary_credit_source');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','new row for relation "settlement_invoices" violates check constraint "accounting_invoice_has_one_source"','settlement_invoices') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_invoice ON public.settlement_invoices;
CREATE TRIGGER fixture_credit_message BEFORE INSERT ON public.social_messages FOR EACH ROW
 WHEN(NEW.media_metadata->>'invoice_type'='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('suppress');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23502',NULL,'accounting_invoice_deliveries','message_id') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_message ON public.social_messages;
CREATE TRIGGER fixture_credit_message BEFORE INSERT ON public.social_messages FOR EACH ROW
 WHEN(NEW.media_metadata->>'invoice_type'='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('transform');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_change_delivery_mismatch') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_message ON public.social_messages;
CREATE TRIGGER fixture_credit_notice BEFORE INSERT ON public.notifications FOR EACH ROW
 WHEN(NEW.data->>'invoice_type'='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('suppress');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23502',NULL,'accounting_invoice_deliveries','notification_id') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_notice ON public.notifications;
CREATE TRIGGER fixture_credit_notice BEFORE INSERT ON public.notifications FOR EACH ROW
 WHEN(NEW.data->>'invoice_type'='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('transform');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_change_delivery_mismatch') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_notice ON public.notifications;
CREATE TRIGGER fixture_credit_notice BEFORE INSERT ON public.notifications FOR EACH ROW
 WHEN(NEW.data->>'invoice_type'='credit_limit_change') EXECUTE FUNCTION pg_temp.cr_delivery_fault('link_only');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_change_delivery_mismatch') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_notice ON public.notifications;
-- The actual existing push trigger runs after delivery; force the real deferred
-- constraints and require its exact durable-outbox refusal, not an early error.
CREATE TRIGGER fixture_credit_push BEFORE INSERT ON public.push_outbox FOR EACH ROW
 WHEN(NEW.event='accounting_invoice') EXECUTE FUNCTION pg_temp.cr_delivery_fault('suppress');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','cashier_push_receipt_missing',NULL,NULL,true) FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_push ON public.push_outbox;
CREATE TRIGGER fixture_credit_push BEFORE INSERT ON public.push_outbox FOR EACH ROW
 WHEN(NEW.event='accounting_invoice') EXECUTE FUNCTION pg_temp.cr_delivery_fault('transform');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','cashier_push_receipt_missing',NULL,NULL,true) FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_push ON public.push_outbox;

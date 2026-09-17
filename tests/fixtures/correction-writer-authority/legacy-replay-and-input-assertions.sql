\set ON_ERROR_STOP on
-- SAME session, after full candidate. Do not reconstruct or delete legacy intent.
BEGIN;
SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='3s';
DO $legacy$ DECLARE w record;before_book jsonb;r jsonb;actual_rows jsonb;expected_rows jsonb;source_shape boolean;BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL OR current_setting('session_replication_role')<>'origin'
  OR to_regclass('public.ca_correction_request_intents_v1') IS NULL THEN RAISE EXCEPTION 'isolated accepted correction successor required';END IF;
 SELECT * INTO STRICT w FROM correction_legacy_witness;
 actual_rows:=pg_temp.cw_legacy_rows(w.ledger_id);
 -- Component37 adds exactly one nullable source column. Preserve the immutable
 -- preinstallation witness and every original value; historical invoices must
 -- gain only this explicit JSON null, never a fabricated operation source.
 source_shape:=(SELECT count(*)>0 AND bool_and(NOT (value ? 'source_credit_reduction_operation_id'))
  FROM jsonb_array_elements(w.original_rows->'invoices'))
  AND (SELECT count(*)>0 AND bool_and((value ? 'source_credit_reduction_operation_id'
  AND value->'source_credit_reduction_operation_id'='null'::jsonb) IS TRUE)
  FROM jsonb_array_elements(actual_rows->'invoices'));
 expected_rows:=jsonb_set(w.original_rows,'{invoices}',(SELECT jsonb_agg(
  value||jsonb_build_object('source_credit_reduction_operation_id',NULL) ORDER BY ordinal)
  FROM jsonb_array_elements(w.original_rows->'invoices') WITH ORDINALITY AS invoice(value,ordinal)),false);
 IF (source_shape AND actual_rows=expected_rows) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'correction writer fixture failed: full installation preserves predecessor ledger, IDs and original document rows'
   USING DETAIL=jsonb_build_object('original_rows',w.original_rows,'expected_rows',expected_rows,'actual_rows',actual_rows)::text;
 END IF;
 PERFORM pg_temp.cw_check(source_shape AND actual_rows=expected_rows,'full installation preserves predecessor ledger, IDs and original document rows');
 PERFORM pg_temp.cw_check(NOT EXISTS(SELECT 1 FROM public.ca_correction_request_intents_v1 WHERE ledger_id=w.ledger_id),
  'installation does not invent legacy full intent');
 before_book:=pg_temp.cw_book();PERFORM pg_temp.cw_actor(pg_temp.cw_id(1),'service_role');EXECUTE 'SET LOCAL ROLE service_role';
 r:=pg_temp.cw_call(w.request);
 PERFORM pg_temp.cw_check(r=jsonb_build_object('ok',false,'reason','legacy_correction_intent_unavailable'),
  'real predecessor request receives exact unresolved legacy refusal');
 EXECUTE 'RESET ROLE';
 PERFORM pg_temp.cw_check(pg_temp.cw_book()=before_book,'legacy refusal makes no persistent row changes');
 PERFORM pg_temp.cw_check((SELECT count(*)=1 FROM correction_fixture_input) AND
  NOT EXISTS(SELECT 1 FROM public.chip_ledger l JOIN correction_fixture_input q ON l.idempotency_key='correction:inc:'||(q.request->>'incident_id')),
  'same-session owner input is fresh and remains available');
END$legacy$;
DO $legacy_audience$ DECLARE w record;d record;p record;expected jsonb;book jsonb;BEGIN
 SELECT * INTO STRICT w FROM correction_legacy_witness;book:=pg_temp.cw_book();
 FOR d IN SELECT a.*,m.conversation_id,i.invoice_type,i.club_id FROM public.accounting_invoice_deliveries a
  JOIN public.settlement_invoices i ON i.id=a.invoice_id JOIN public.social_messages m ON m.id=a.message_id
  WHERE i.source_ledger_id=w.ledger_id ORDER BY a.recipient_id LOOP
  expected:=jsonb_build_object('kind','accounting_invoice','invoice_identity_verified',true,'correction_unverified',true,
   'accounting_verified',false,'correction_verified',false,'invoice_id',d.invoice_id,'invoice_type',d.invoice_type,
   'source_ledger_id',w.ledger_id,'club_id',d.club_id,'union_id',NULL);
  PERFORM pg_temp.cw_actor(d.recipient_id,'authenticated');SET LOCAL ROLE authenticated;
  PERFORM pg_temp.cw_check(NOT EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id=d.invoice_id)
   AND NOT EXISTS(SELECT 1 FROM public.social_messages WHERE id=d.message_id)
   AND NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id=d.invoice_id)
   AND NOT EXISTS(SELECT 1 FROM public.notifications WHERE id=d.notification_id),
   'actual predecessor paid records remain unavailable through raw application reads');
  IF d.recipient_id=pg_temp.cw_id(2) THEN
   SELECT * INTO STRICT p FROM public.fn_messenger_private_message_page(auth.uid(),d.conversation_id) WHERE id=d.message_id;
   PERFORM pg_temp.cw_check(p.media_metadata=expected AND p.content='Correction receipt unavailable.',
    'actual predecessor payee receives only verified identity placeholder');
   SELECT * INTO STRICT p FROM public.fn_messenger_private_search_messages(auth.uid(),ARRAY[d.conversation_id],'receipt unavailable') WHERE id=d.message_id;
   PERFORM pg_temp.cw_check(p.media_metadata=expected,'actual predecessor search has the same identity-only contract');
   SELECT * INTO STRICT p FROM public.fn_messenger_private_accounting_threads(auth.uid(),ARRAY[d.conversation_id]);
   PERFORM pg_temp.cw_check(p.recipient_visible AND p.last_message_preview='Correction receipt unavailable.',
    'actual predecessor payee thread has no payment assertion');
  ELSE
   PERFORM pg_temp.cw_check(NOT EXISTS(SELECT 1 FROM public.fn_messenger_private_message_page(auth.uid(),d.conversation_id))
    AND NOT EXISTS(SELECT 1 FROM public.fn_messenger_private_search_messages(auth.uid(),ARRAY[d.conversation_id],'receipt unavailable')),
    'actual prior issuer delivery does not authorize individual-payee history');
   SELECT * INTO STRICT p FROM public.fn_messenger_private_accounting_threads(auth.uid(),ARRAY[d.conversation_id]);
   PERFORM pg_temp.cw_check(p.recipient_visible=false AND p.last_message_preview IS NULL AND p.last_message_at IS NULL,
    'actual predecessor issuer thread has no payee detail');
  END IF;
  PERFORM pg_temp.cw_check(NOT EXISTS(SELECT 1 FROM public.fn_messenger_private_search_messages(auth.uid(),ARRAY[d.conversation_id],'7.25')),
   'actual predecessor amount does not remain a private search term');
  RESET ROLE;
 END LOOP;
 PERFORM pg_temp.cw_check(pg_temp.cw_book()=book,'actual historical audience probes leave stored rows unchanged');
END$legacy_audience$;
ROLLBACK;

-- SOURCE ONLY / UNRUN. Fragment for one guarded post36 transaction.
-- Load after the operation schema; install the delivery/reader successor in
-- the same transaction before admitting any operation. No alternate payer.
CREATE TABLE public.accounting_credit_change_documents_v1 (
 id uuid PRIMARY KEY,
 invoice_id uuid NOT NULL UNIQUE,
 operation_receipt_id uuid NOT NULL UNIQUE,
 issuer_name text NOT NULL,
 recipient_name text NOT NULL,
 audience_user_ids uuid[] NOT NULL,
 issued_at timestamptz NOT NULL,
 CONSTRAINT credit_change_document_invoice_fk FOREIGN KEY(invoice_id)
  REFERENCES public.settlement_invoices(id) DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT credit_change_document_audience_nonempty CHECK(cardinality(audience_user_ids)>0)
);
ALTER TABLE public.accounting_credit_change_documents_v1 OWNER TO postgres;
ALTER TABLE public.accounting_credit_change_documents_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_credit_change_documents_v1 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_accounting_credit_change_immutable_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 RAISE EXCEPTION 'credit_change_document_is_immutable' USING ERRCODE='23514';
END $function$;
CREATE TRIGGER credit_change_document_immutable_v1 BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.accounting_credit_change_documents_v1 FOR EACH STATEMENT
 EXECUTE FUNCTION public.fn_accounting_credit_change_immutable_v1();

CREATE FUNCTION public.fn_accounting_credit_change_payload_v1(p_document_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE d public.accounting_credit_change_documents_v1%ROWTYPE;
 o public.accounting_credit_reduction_operations_v1%ROWTYPE;
BEGIN
 SELECT * INTO STRICT d FROM public.accounting_credit_change_documents_v1 WHERE id=p_document_id;
 SELECT * INTO STRICT o FROM public.accounting_credit_reduction_operations_v1 WHERE id=d.operation_receipt_id;
 IF o.document_id IS DISTINCT FROM d.id OR o.invoice_id IS DISTINCT FROM d.invoice_id
  OR o.assignment_id IS NULL OR o.applied_reduction IS NULL OR o.applied_reduction<=0
  OR o.applied_reduction::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'credit_change_operation_identity_mismatch' USING ERRCODE='23514';END IF;
 -- Only frozen operation facts. No current agent/audit join on historical reads;
 -- the original assignment is verified while the new document is constructed.
 RETURN jsonb_build_object('contract_version',1,'document_id',d.id,'invoice_id',d.invoice_id,
  'operation_receipt_id',o.id,'operation_id',o.operation_id,'assignment_id',o.assignment_id,
  'club_id',o.club_id,'agent_id',o.agent_id,'target_user_id',o.target_user_id,'actor_user_id',o.actor_user_id,
  'event_kind','credit_limit_reduced','display_state','recorded',
  'amount',round(o.applied_reduction,2)::text,'requested_reduction',round(o.requested_reduction,2)::text,
  'applied_reduction',round(o.applied_reduction,2)::text,
  'before_limit',round(o.before_limit,2)::text,'after_limit',round(o.after_limit,2)::text,
  'before_prepaid',o.before_prepaid,'after_prepaid',o.after_prepaid,
  'before_revision',o.before_revision::text,'after_revision',o.after_revision::text,
  'recorded_at',to_char(o.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'issued_at',to_char(d.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'chip_movement_recorded',false,'payable',false,'amount_due','0.00');
END $function$;

CREATE FUNCTION public.fn_accounting_credit_change_contract_v1(p_invoice_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE d public.accounting_credit_change_documents_v1%ROWTYPE;
 o public.accounting_credit_reduction_operations_v1%ROWTYPE;
 i public.settlement_invoices%ROWTYPE;payload jsonb;audience uuid[];
BEGIN
 SELECT * INTO d FROM public.accounting_credit_change_documents_v1 WHERE invoice_id=p_invoice_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_change_document_missing' USING ERRCODE='23514';END IF;
 SELECT * INTO o FROM public.accounting_credit_reduction_operations_v1 WHERE id=d.operation_receipt_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_change_operation_missing' USING ERRCODE='23514';END IF;
 SELECT array_agg(DISTINCT u ORDER BY u) INTO audience FROM unnest(ARRAY[o.actor_user_id,o.target_user_id])u;
 payload:=public.fn_accounting_credit_change_payload_v1(d.id);
 SELECT * INTO i FROM public.settlement_invoices WHERE id=d.invoice_id;
 IF NOT FOUND OR d.audience_user_ids IS DISTINCT FROM audience OR d.issued_at IS DISTINCT FROM o.recorded_at
  OR i.invoice_type IS DISTINCT FROM 'credit_limit_change' OR i.club_id IS DISTINCT FROM o.club_id
  OR i.from_entity_type IS DISTINCT FROM 'club' OR i.from_entity_id IS DISTINCT FROM o.club_id::text
  OR i.to_entity_type IS DISTINCT FROM 'agent' OR i.to_entity_id IS DISTINCT FROM o.target_user_id::text
  OR i.gross_amount IS DISTINCT FROM o.applied_reduction OR i.net_amount IS DISTINCT FROM o.applied_reduction
  OR i.deductions IS DISTINCT FROM 0 OR i.status IS DISTINCT FROM 'generated'
  OR i.chips_transferred IS DISTINCT FROM false OR i.transferred_at IS NOT NULL OR i.due_at IS NOT NULL
  OR i.chip_transfer_id IS NOT NULL OR i.adjusts_invoice_id IS NOT NULL OR i.period_id IS NOT NULL
  OR i.source_ledger_id IS NOT NULL OR i.source_credit_invoice_id IS NOT NULL OR i.source_credit_payment_id IS NOT NULL
  OR i.overdue_at IS NOT NULL OR i.reminders_sent IS DISTINCT FROM 0 OR i.last_reminder_at IS NOT NULL
  OR i.notes IS NOT NULL OR i.created_at IS DISTINCT FROM d.issued_at
  OR i.invoice_number IS NULL OR i.breakdown IS DISTINCT FROM jsonb_build_object('category','credit_limit_change','credit_change',payload)
 THEN RAISE EXCEPTION 'credit_change_document_contract_mismatch' USING ERRCODE='23514';END IF;
 RETURN payload;
END $function$;

CREATE FUNCTION public.fn_accounting_credit_change_body_v1(p_document_id uuid,p_invoice_number text) RETURNS text
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $function$
DECLARE d public.accounting_credit_change_documents_v1%ROWTYPE;
 o public.accounting_credit_reduction_operations_v1%ROWTYPE;
BEGIN
 SELECT * INTO STRICT d FROM public.accounting_credit_change_documents_v1 WHERE id=p_document_id;
 SELECT * INTO STRICT o FROM public.accounting_credit_reduction_operations_v1 WHERE id=d.operation_receipt_id;
 RETURN 'Credit Line Updated '||p_invoice_number||E'\nIssued By: '||d.issuer_name||E'\nFor: '||d.recipient_name
  ||E'\nRequested Reduction: '||to_char(o.requested_reduction,'FM999,999,999,999,990.00')
  ||E'\nApplied Reduction: '||to_char(o.applied_reduction,'FM999,999,999,999,990.00')
  ||E'\nLimit After This Change: '||to_char(o.after_limit,'FM999,999,999,999,990.00')
  ||E'\nFunding After This Change: '||CASE WHEN o.after_prepaid THEN 'Prepaid' ELSE 'Credit' END
  ||E'\nThis records a credit-capacity change. No chips were transferred and no payment is due.';
END $function$;

CREATE FUNCTION public.fn_accounting_credit_reduction_assert_document(p_operation_receipt_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE o public.accounting_credit_reduction_operations_v1%ROWTYPE;
 c public.accounting_credit_change_documents_v1%ROWTYPE;i public.settlement_invoices%ROWTYPE;
 d record;payload jsonb;actual_users uuid[];expected_body text;expected_meta jsonb;
BEGIN
 SELECT * INTO STRICT o FROM public.accounting_credit_reduction_operations_v1 WHERE id=p_operation_receipt_id;
 IF o.applied_reduction=0 THEN
  IF o.assignment_id IS NOT NULL OR o.document_id IS NOT NULL OR o.invoice_id IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.accounting_credit_change_documents_v1 WHERE operation_receipt_id=o.id)
  THEN RAISE EXCEPTION 'credit_no_change_document_unexpected' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO c FROM public.accounting_credit_change_documents_v1 WHERE operation_receipt_id=o.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_change_document_missing' USING ERRCODE='23514';END IF;
 payload:=public.fn_accounting_credit_change_contract_v1(c.invoice_id);
 SELECT * INTO STRICT i FROM public.settlement_invoices WHERE id=c.invoice_id;
 expected_body:=public.fn_accounting_credit_change_body_v1(c.id,i.invoice_number);
 SELECT array_agg(recipient_id ORDER BY recipient_id) INTO actual_users FROM public.accounting_invoice_deliveries WHERE invoice_id=c.invoice_id;
 IF actual_users IS DISTINCT FROM c.audience_user_ids OR i.message_sent IS DISTINCT FROM true OR i.message_sent_at IS NULL
 THEN RAISE EXCEPTION 'credit_change_delivery_missing' USING ERRCODE='23514';END IF;
 FOR d IN SELECT a.*,m.conversation_id,m.sender_id,m.content,m.message_type,m.media_metadata,
  n.user_id AS notice_user,n.type AS notice_type,n.data AS notice_data,n.metadata AS notice_metadata,
  n.title AS notice_title,n.message AS notice_message,n.action_url AS notice_url,n.link AS notice_link
  FROM public.accounting_invoice_deliveries a LEFT JOIN public.social_messages m ON m.id=a.message_id
  LEFT JOIN public.notifications n ON n.id=a.notification_id WHERE a.invoice_id=c.invoice_id LOOP
  expected_meta:=jsonb_build_object('kind','accounting_invoice','invoice_id',i.id,'invoice_number',i.invoice_number,
   'club_id',i.club_id,'source_ledger_id',NULL,'source_credit_invoice_id',NULL,'source_credit_payment_id',NULL,
   'amount',i.net_amount,'currency','CHIPS','conversationId',d.conversation_id,'conversation_id',d.conversation_id,
   'status','generated','invoice_type','credit_limit_change','from_entity_type',i.from_entity_type,'from_entity_id',i.from_entity_id,
   'to_entity_type',i.to_entity_type,'to_entity_id',i.to_entity_id,'lines',i.breakdown,'credit_change',payload);
  IF d.delivery_mode IS DISTINCT FROM 'immediate' OR d.sender_id IS DISTINCT FROM o.actor_user_id
   OR d.message_type IS DISTINCT FROM 'invoice' OR d.content IS DISTINCT FROM expected_body
   OR d.media_metadata IS DISTINCT FROM expected_meta OR d.notice_metadata IS DISTINCT FROM expected_meta OR d.notice_data IS DISTINCT FROM expected_meta
   OR d.notice_user IS DISTINCT FROM d.recipient_id OR d.notice_type IS DISTINCT FROM 'accounting_invoice'
   OR d.notice_title IS DISTINCT FROM 'Credit Line Updated · '||i.invoice_number
   OR d.notice_message IS DISTINCT FROM 'Credit capacity reduced: '||to_char(i.net_amount,'FM999,999,999,999,990.00')||'. No payment due.'
   OR d.notice_url IS DISTINCT FROM '/hub/messenger?conversation='||d.conversation_id::text
   OR d.notice_link IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM public.accounting_conversations x WHERE x.conversation_id=d.conversation_id
    AND x.scope_id=o.club_id AND x.issuer_type='club' AND x.issuer_id=o.club_id AND x.sender_id=o.actor_user_id AND x.recipient_id=d.recipient_id)
   OR EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id AND p.user_id<>ALL(ARRAY[o.actor_user_id,d.recipient_id]))
   OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id AND p.user_id=d.recipient_id)
   OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=d.conversation_id AND p.user_id=o.actor_user_id)
  THEN RAISE EXCEPTION 'credit_change_delivery_mismatch' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Existing deferred push mirroring performs its own exact outbox readback.
 -- Do not require a deferred output before that constraint has actually run.
 RETURN payload;
END $function$;

CREATE FUNCTION public.fn_accounting_credit_change_on_operation_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $function$
DECLARE intended public.accounting_credit_change_documents_v1%ROWTYPE;
 surviving public.accounting_credit_change_documents_v1%ROWTYPE;invoice_number text;invoice_id uuid;
BEGIN
 IF NEW.applied_reduction=0 THEN
  PERFORM public.fn_accounting_credit_reduction_assert_document(NEW.id);RETURN NEW;
 END IF;
 IF NEW.applied_reduction IS NULL OR NEW.applied_reduction::text IN('NaN','Infinity','-Infinity') OR NEW.applied_reduction<=0
  OR NEW.document_id IS NULL OR NEW.invoice_id IS NULL OR NEW.assignment_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.agents a WHERE a.id=NEW.agent_id AND a.club_id=NEW.club_id AND a.user_id=NEW.target_user_id
   AND a.credit_limit IS NOT DISTINCT FROM NEW.after_limit AND a.credit_used IS NOT DISTINCT FROM NEW.credit_used
   AND a.is_prepaid IS NOT DISTINCT FROM NEW.after_prepaid AND a.credit_control_revision IS NOT DISTINCT FROM NEW.after_revision)
  OR NOT EXISTS(SELECT 1 FROM public.credit_assignments a WHERE a.id=NEW.assignment_id AND a.agent_id=NEW.agent_id
   AND a.assigned_by IS NOT DISTINCT FROM NEW.actor_user_id AND a.old_limit IS NOT DISTINCT FROM NEW.before_limit
   AND a.new_limit IS NOT DISTINCT FROM NEW.after_limit AND a.reason IS NOT DISTINCT FROM NEW.assignment_reason)
 THEN RAISE EXCEPTION 'credit_change_fresh_assignment_unverified' USING ERRCODE='23514';END IF;
 intended.id:=NEW.document_id;intended.invoice_id:=NEW.invoice_id;intended.operation_receipt_id:=NEW.id;
 SELECT name INTO intended.issuer_name FROM public.clubs WHERE id=NEW.club_id;
 SELECT COALESCE(NULLIF(p.display_name,''),NULLIF(p.username,''),u.username,'Member') INTO intended.recipient_name
  FROM public.users u LEFT JOIN public.profiles p ON p.id=u.id WHERE u.id=NEW.target_user_id;
 SELECT array_agg(DISTINCT u ORDER BY u) INTO intended.audience_user_ids FROM unnest(ARRAY[NEW.actor_user_id,NEW.target_user_id])u;
 intended.issued_at:=NEW.recorded_at;
 IF intended.issuer_name IS NULL OR intended.recipient_name IS NULL
  OR EXISTS(SELECT 1 FROM unnest(intended.audience_user_ids)u WHERE u IS NULL OR NOT EXISTS(SELECT 1 FROM public.users p WHERE p.id=u))
 THEN RAISE EXCEPTION 'credit_change_recorded_party_missing' USING ERRCODE='23514';END IF;
 INSERT INTO public.accounting_credit_change_documents_v1 SELECT intended.*;
 SELECT * INTO surviving FROM public.accounting_credit_change_documents_v1 WHERE id=intended.id;
 IF NOT FOUND OR to_jsonb(surviving) IS DISTINCT FROM to_jsonb(intended)
 THEN RAISE EXCEPTION 'credit_change_provenance_write_missing' USING ERRCODE='23514';END IF;
 invoice_number:=public.fn_accounting_next_invoice_number();
 INSERT INTO public.settlement_invoices(id,club_id,invoice_type,invoice_number,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
  gross_amount,net_amount,deductions,breakdown,status,chips_transferred,transferred_at,due_at,notes,source_ledger_id,created_at)
 VALUES(NEW.invoice_id,NEW.club_id,'credit_limit_change',invoice_number,'club',NEW.club_id::text,'agent',NEW.target_user_id::text,
  NEW.applied_reduction,NEW.applied_reduction,0,jsonb_build_object('category','credit_limit_change','credit_change',public.fn_accounting_credit_change_payload_v1(intended.id)),
  'generated',false,NULL,NULL,NULL,NULL,NEW.recorded_at) RETURNING id INTO invoice_id;
 IF NOT FOUND OR invoice_id IS DISTINCT FROM NEW.invoice_id
 THEN RAISE EXCEPTION 'credit_change_invoice_write_missing' USING ERRCODE='23514';END IF;
 PERFORM public.fn_deliver_accounting_invoice(invoice_id);
 PERFORM public.fn_accounting_credit_reduction_assert_document(NEW.id);
 RETURN NEW;
END $function$;
CREATE TRIGGER accounting_credit_change_on_operation_v1 AFTER INSERT
 ON public.accounting_credit_reduction_operations_v1 FOR EACH ROW
 EXECUTE FUNCTION public.fn_accounting_credit_change_on_operation_v1();

CREATE FUNCTION public.fn_accounting_credit_change_deferred_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 PERFORM public.fn_accounting_credit_reduction_assert_document(NEW.id);RETURN NEW;
END $function$;
-- Sort after document construction even when this named constraint is immediate.
CREATE CONSTRAINT TRIGGER zz_accounting_credit_change_deferred_v1 AFTER INSERT
 ON public.accounting_credit_reduction_operations_v1 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.fn_accounting_credit_change_deferred_v1();

ALTER FUNCTION public.fn_accounting_credit_change_immutable_v1() OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_change_payload_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_change_contract_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_change_body_v1(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_reduction_assert_document(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_change_on_operation_v1() OWNER TO postgres;
ALTER FUNCTION public.fn_accounting_credit_change_deferred_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_credit_change_immutable_v1(),public.fn_accounting_credit_change_payload_v1(uuid),
 public.fn_accounting_credit_change_contract_v1(uuid),public.fn_accounting_credit_change_body_v1(uuid,text),
 public.fn_accounting_credit_reduction_assert_document(uuid),public.fn_accounting_credit_change_on_operation_v1(),
 public.fn_accounting_credit_change_deferred_v1() FROM PUBLIC,anon,authenticated,service_role;

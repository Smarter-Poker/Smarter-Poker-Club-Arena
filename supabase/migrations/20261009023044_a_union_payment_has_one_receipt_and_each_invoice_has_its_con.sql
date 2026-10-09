-- One payment operation, one immutable receipt, recipient-correct invoice links.
-- Reserved by scripts/new-migration.mjs. Install before the matching client:
-- old six-argument callers fail visibly with operation_id_required and cannot
-- record a payment. Historical rows and messages are never rewritten.
-- @live-proof: to_regprocedure('public.fn_union_record_presettlement(uuid,uuid,numeric,text,text,text,uuid)') IS NOT NULL AND to_regprocedure('public.fn_union_record_presettlement(uuid,uuid,numeric,text,text,text)') IS NULL AND to_regclass('public.union_presettlements_operation_id_key') IS NOT NULL AND to_regclass('public.settlement_invoices_source_union_presettlement_key') IS NOT NULL AND md5(pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure))='57130e2bf340e0a4676b51b62442b773'
BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $patch$
DECLARE v_oid regprocedure := 'public.fn_deliver_accounting_invoice(uuid)'::regprocedure;
 v_def text := pg_get_functiondef(v_oid);
BEGIN
 IF md5(v_def) <> '5ab7b35537a076f346eaa74a23f2f022' THEN RAISE EXCEPTION 'financial_document_definition_changed: %', v_oid; END IF;
 v_def := replace(v_def,$old$   IF inv.invoice_type IN('cashier_cashout','accounting_correction','credit_limit_change') THEN meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);END IF;$old$,$new$   meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);$new$);
 EXECUTE v_def;
 IF md5(pg_get_functiondef(v_oid)) <> '57130e2bf340e0a4676b51b62442b773' THEN RAISE EXCEPTION 'financial_document_postimage_mismatch: %', v_oid; END IF;
END $patch$;

DO $patch$
DECLARE v_oid regprocedure := 'public.fn_messenger_message_page(uuid,uuid,timestamp with time zone,uuid,integer)'::regprocedure;
 v_def text := pg_get_functiondef(v_oid);
BEGIN
 IF md5(v_def) <> '5912b16bef69c1d16766ef765c51bc33' THEN RAISE EXCEPTION 'financial_document_definition_changed: %', v_oid; END IF;
 v_def := replace(v_def,$old$   CASE WHEN legacy.identity IS NOT NULL THEN legacy.identity$old$,$new$   (CASE WHEN legacy.identity IS NOT NULL THEN legacy.identity$new$);
 v_def := replace(v_def,$old$ELSE '{}'::jsonb END END END$old$,$new$ELSE '{}'::jsonb END END END)
 ||CASE WHEN i.id IS NOT NULL THEN jsonb_build_object('conversation_id',m.conversation_id,'conversationId',m.conversation_id) ELSE '{}'::jsonb END$new$);
 EXECUTE v_def;
 IF md5(pg_get_functiondef(v_oid)) <> '8afbd780d369b747910c4575f4893fb9' THEN RAISE EXCEPTION 'financial_document_postimage_mismatch: %', v_oid; END IF;
END $patch$;

DO $patch$
DECLARE v_oid regprocedure := 'public.fn_messenger_search_messages(uuid,uuid[],text,integer)'::regprocedure;
 v_def text := pg_get_functiondef(v_oid);
BEGIN
 IF md5(v_def) <> 'c6d5050a95ff52ec5c406734e91aa76e' THEN RAISE EXCEPTION 'financial_document_definition_changed: %', v_oid; END IF;
 v_def := replace(v_def,$old$   CASE WHEN legacy.identity IS NOT NULL THEN legacy.identity$old$,$new$   (CASE WHEN legacy.identity IS NOT NULL THEN legacy.identity$new$);
 v_def := replace(v_def,$old$ELSE '{}'::jsonb END END END$old$,$new$ELSE '{}'::jsonb END END END)
 ||CASE WHEN i.id IS NOT NULL THEN jsonb_build_object('conversation_id',m.conversation_id,'conversationId',m.conversation_id) ELSE '{}'::jsonb END$new$);
 EXECUTE v_def;
 IF md5(pg_get_functiondef(v_oid)) <> '7ce56edaec474d492485f3695b5ffa44' THEN RAISE EXCEPTION 'financial_document_postimage_mismatch: %', v_oid; END IF;
END $patch$;

-- Retain the original source invariant byte-for-byte in the old-source arm.
DO $preimage$
BEGIN
 IF md5(pg_get_functiondef('public.fn_union_record_presettlement(uuid,uuid,numeric,text,text,text)'::regprocedure))
    <> '0c96306ad7f5546d8bd24115ccef3b2f' THEN RAISE EXCEPTION 'presettlement_definition_changed'; END IF;
 IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid='public.settlement_invoices'::regclass AND conname='accounting_invoice_has_one_source')
    IS DISTINCT FROM $source$CHECK ((((source_credit_reduction_operation_id IS NULL) AND (invoice_type <> 'credit_limit_change'::text) AND ((num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) <= 1) AND ((period_id IS NOT NULL) OR (num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) = 1)))) OR ((source_credit_reduction_operation_id IS NOT NULL) AND (invoice_type = 'credit_limit_change'::text) AND (period_id IS NULL) AND (num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) = 0))))$source$
 THEN RAISE EXCEPTION 'accounting_invoice_source_constraint_changed'; END IF;
END $preimage$;

ALTER TABLE public.union_presettlements ADD COLUMN operation_id uuid;
CREATE UNIQUE INDEX union_presettlements_operation_id_key
 ON public.union_presettlements(operation_id) WHERE operation_id IS NOT NULL;
ALTER TABLE public.settlement_invoices ADD COLUMN source_union_presettlement_id uuid
 REFERENCES public.union_presettlements(id);
CREATE UNIQUE INDEX settlement_invoices_source_union_presettlement_key
 ON public.settlement_invoices(source_union_presettlement_id)
 WHERE source_union_presettlement_id IS NOT NULL;
ALTER TABLE public.settlement_invoices DROP CONSTRAINT accounting_invoice_has_one_source;
ALTER TABLE public.settlement_invoices ADD CONSTRAINT accounting_invoice_has_one_source CHECK (
 (source_union_presettlement_id IS NULL AND (((source_credit_reduction_operation_id IS NULL) AND (invoice_type <> 'credit_limit_change'::text) AND ((num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) <= 1) AND ((period_id IS NOT NULL) OR (num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) = 1)))) OR ((source_credit_reduction_operation_id IS NOT NULL) AND (invoice_type = 'credit_limit_change'::text) AND (period_id IS NULL) AND (num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) = 0))))
 OR (source_union_presettlement_id IS NOT NULL
  AND invoice_type='transaction_receipt' AND breakdown->>'category' IS NOT DISTINCT FROM 'union_presettlement'
  AND from_entity_type='union' AND to_entity_type='club'
  AND status='paid' AND chips_transferred IS FALSE
  AND period_id IS NULL AND source_ledger_id IS NULL AND source_credit_invoice_id IS NULL
  AND source_credit_payment_id IS NULL AND source_credit_reduction_operation_id IS NULL
  AND transferred_at IS NULL AND due_at IS NULL AND chip_transfer_id IS NULL)
);

DO $patch$
DECLARE v_oid regprocedure := 'public.fn_accounting_document_immutable()'::regprocedure;
 v_def text := pg_get_functiondef(v_oid);
BEGIN
 IF md5(v_def) <> 'd74d501909d5013d30cdbdcbb739eeb6' THEN RAISE EXCEPTION 'accounting_immutable_definition_changed'; END IF;
 v_def := replace(v_def,$old$ IF TG_TABLE_NAME='settlement_invoices' THEN$old$,$new$ IF TG_TABLE_NAME='settlement_invoices' THEN
   IF (OLD.source_union_presettlement_id IS NOT NULL OR
       (TG_OP='UPDATE' AND NEW.source_union_presettlement_id IS NOT NULL)) AND (TG_OP='DELETE' OR
      (to_jsonb(NEW)-ARRAY['message_sent','message_sent_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['message_sent','message_sent_at']))
   THEN RAISE EXCEPTION 'presettlement_receipt_is_immutable' USING ERRCODE='23514';END IF;$new$);
 EXECUTE v_def;
 IF md5(pg_get_functiondef(v_oid)) <> 'd5ee851b04de73ee84c4aae6dec8aea3' THEN RAISE EXCEPTION 'accounting_immutable_postimage_mismatch'; END IF;
END $patch$;

-- A completed operation keeps its original request and receipt forever.
-- The existing settlement application may still attach applied_settlement_id.
CREATE OR REPLACE FUNCTION public.fn_union_presettlement_operation_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
 IF OLD.operation_id IS NOT NULL AND (TG_OP='DELETE' OR
    (to_jsonb(NEW)-'applied_settlement_id') IS DISTINCT FROM (to_jsonb(OLD)-'applied_settlement_id'))
 THEN RAISE EXCEPTION 'presettlement_operation_is_immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_union_presettlement_operation_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER union_presettlement_operation_immutable BEFORE UPDATE OR DELETE ON public.union_presettlements
 FOR EACH ROW EXECUTE FUNCTION public.fn_union_presettlement_operation_immutable();

-- No old signature/weak overload survives. Its existing compatibility wrapper
-- resolves the default NULL and returns a visible refusal until it supplies a key.
DROP FUNCTION public.fn_union_record_presettlement(uuid,uuid,numeric,text,text,text);
CREATE OR REPLACE FUNCTION public.fn_union_record_presettlement(
 p_union_id uuid,p_club_id uuid,p_amount numeric,
 p_method text DEFAULT NULL,p_reference text DEFAULT NULL,p_note text DEFAULT NULL,
 p_operation_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
 v_caller uuid := auth.uid();
 v_service boolean := COALESCE(auth.role()='service_role',false)
   OR COALESCE(current_setting('role',true)='service_role',false)
   OR (session_user IN ('postgres','supabase_admin') AND current_setting('role',true)='none');
 v_row public.union_presettlements%ROWTYPE;
 v_invoice uuid;
 v_duplicate boolean := false;
BEGIN
 IF (v_caller IS NULL AND NOT v_service) OR (v_caller IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_union_id AND u.owner_id=v_caller)
   AND NOT EXISTS(SELECT 1 FROM public.union_admins a WHERE a.union_id=p_union_id AND a.user_id=v_caller))
 THEN RETURN jsonb_build_object('success',false,'error','not authorized'); END IF;
 IF p_operation_id IS NULL THEN
   RETURN jsonb_build_object('success',false,'error','operation_id_required'); END IF;
 IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity')
    OR p_amount<=0 OR p_amount<>round(p_amount,2) OR p_amount>9999999999.99 THEN
   RETURN jsonb_build_object('success',false,'error','positive whole-cent amount required'); END IF;
 IF p_union_id IS NULL OR p_club_id IS NULL THEN
   RETURN jsonb_build_object('success',false,'error','union and club required'); END IF;
 -- Global operation UUID ownership also refuses a key reused in another union.
 PERFORM pg_advisory_xact_lock(hashtextextended('union_presettlement:'||p_operation_id::text,0));
 SELECT * INTO v_row FROM public.union_presettlements WHERE operation_id=p_operation_id FOR UPDATE;
 IF FOUND THEN
   IF ROW(v_row.union_id,v_row.club_id,v_row.amount,v_row.method,v_row.reference,v_row.note,v_row.recorded_by)
      IS DISTINCT FROM ROW(p_union_id,p_club_id,p_amount,p_method,p_reference,p_note,v_caller)
   THEN RETURN jsonb_build_object('success',false,'error','presettlement_operation_conflict'); END IF;
   v_duplicate:=true;
 ELSE
   IF NOT EXISTS(SELECT 1 FROM public.union_clubs c WHERE c.union_id=p_union_id AND c.club_id=p_club_id)
   THEN RETURN jsonb_build_object('success',false,'error','club is not a member of this union'); END IF;
   INSERT INTO public.union_presettlements(union_id,club_id,amount,method,reference,note,recorded_by,operation_id)
    VALUES(p_union_id,p_club_id,p_amount,p_method,p_reference,p_note,v_caller,p_operation_id) RETURNING * INTO v_row;
   -- Its existing AFTER INSERT trigger delivers the invoice, message and
   -- notification together. Any failure rolls the original payment back too.
   INSERT INTO public.settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,
      to_entity_type,to_entity_id,gross_amount,net_amount,deductions,breakdown,status,
      chips_transferred,invoice_number,notes,source_union_presettlement_id)
    VALUES(p_club_id,'transaction_receipt','union',p_union_id::text,'club',p_club_id::text,
      p_amount,p_amount,0,jsonb_build_object('category','union_presettlement','union_id',p_union_id,
       'presettlement_id',v_row.id,'operation_id',p_operation_id,'received_at',v_row.received_at,
       'payment_recorded',true,'chips_transferred',false),
      'paid',false,public.fn_accounting_next_invoice_number(),
      'External payment recorded against this club union balance. No chips were transferred and no payment is due on this receipt.',v_row.id)
    RETURNING id INTO v_invoice;
 END IF;
 SELECT i.id INTO v_invoice FROM public.settlement_invoices i
  WHERE i.source_union_presettlement_id=v_row.id AND i.message_sent IS TRUE;
 IF v_invoice IS NULL THEN RAISE EXCEPTION 'presettlement_receipt_missing' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('success',true,'presettlement_id',v_row.id,'operation_id',v_row.operation_id,
   'union_id',v_row.union_id,'club_id',v_row.club_id,'amount',v_row.amount,
   'received_at',v_row.received_at,'invoice_id',v_invoice,'duplicate',v_duplicate);
END $function$;
REVOKE ALL ON FUNCTION public.fn_union_record_presettlement(uuid,uuid,numeric,text,text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_union_record_presettlement(uuid,uuid,numeric,text,text,text,uuid) TO authenticated,service_role;

COMMIT;

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure))<>'bd3b295eb46413c3cae0d135dcf4872c'
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.push_outbox'::regclass AND attname='accounting_notification_id' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'accounting push bridge changed since review'; END IF;
END $guard$;
ALTER TABLE public.push_outbox ADD COLUMN accounting_notification_id uuid REFERENCES public.notifications(id);
ALTER TABLE public.push_outbox ADD CONSTRAINT accounting_push_notification_identity CHECK(
 accounting_notification_id IS NULL OR (event IS NOT DISTINCT FROM 'accounting_invoice' AND related_entity_id IS NOT DISTINCT FROM accounting_notification_id));
CREATE UNIQUE INDEX accounting_push_one_notification_receipt ON public.push_outbox(accounting_notification_id) WHERE accounting_notification_id IS NOT NULL;
-- Add a typed receipt to existing verifiable rows, including already-sent
-- history. This changes neither status nor content and never resends anything.
UPDATE public.push_outbox p SET accounting_notification_id=n.id
 FROM public.notifications n JOIN public.accounting_invoice_deliveries d ON d.notification_id=n.id AND d.recipient_id=n.user_id
 JOIN public.settlement_invoices i ON i.id=d.invoice_id
 WHERE p.event='accounting_invoice' AND p.related_entity_id=n.id AND p.recipient_user_id=n.user_id
  AND p.accounting_notification_id IS NULL AND n.data->>'invoice_id'=i.id::text;

CREATE OR REPLACE FUNCTION public.fn_mirror_notification_to_push_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE notice public.notifications%ROWTYPE; receipt record; existing public.push_outbox%ROWTYPE;
 v_tag text;v_pending int;state text:='pending';reason text;
 c_max_pending CONSTANT int:=20;c_max_age CONSTANT interval:=interval '30 minutes';
BEGIN
 -- Delivery rows are inserted AFTER their notification. Wait until the whole
 -- transaction is ready to commit before granting the canonical exception.
 IF TG_NAME<>'trg_accounting_push_after_delivery' AND NEW.type='accounting_invoice' THEN RETURN NEW; END IF;
 SELECT * INTO notice FROM public.notifications WHERE id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT d.invoice_id,d.recipient_id,d.delivery_mode,m.conversation_id,m.message_type,m.media_metadata,
  i.invoice_number,i.net_amount INTO receipt
 FROM public.accounting_invoice_deliveries d JOIN public.settlement_invoices i ON i.id=d.invoice_id
 JOIN public.social_messages m ON m.id=d.message_id WHERE d.notification_id=notice.id;
 IF FOUND THEN
  -- A real receipt foreign key, exact recipient and issued document are
  -- required. Arbitrary accounting-looking JSON cannot bypass normal caps.
  IF receipt.recipient_id IS DISTINCT FROM notice.user_id
   OR notice.data->>'invoice_id' IS DISTINCT FROM receipt.invoice_id::text
   OR notice.data->>'invoice_number' IS DISTINCT FROM receipt.invoice_number
   OR notice.data->'amount' IS DISTINCT FROM to_jsonb(receipt.net_amount)
   OR receipt.message_type IS DISTINCT FROM 'invoice'
   OR receipt.media_metadata->>'invoice_id' IS DISTINCT FROM receipt.invoice_id::text
   OR COALESCE(notice.data->>'conversation_id',notice.data->>'conversationId') IS DISTINCT FROM receipt.conversation_id::text
   OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.conversation_id=receipt.conversation_id AND p.user_id=notice.user_id)
  THEN RAISE EXCEPTION 'accounting_push_receipt_provenance_invalid' USING ERRCODE='23514'; END IF;
  IF receipt.delivery_mode='weekly_detail' OR notice.type='accounting_invoice_detail' THEN
   state:='skipped';reason:='accounting_archived_detail';
  ELSIF notice.type IS DISTINCT FROM 'accounting_invoice' THEN
   RAISE EXCEPTION 'accounting_push_notification_type_invalid' USING ERRCODE='23514';
  ELSIF notice.data->>'_push' IS NOT NULL THEN
   state:='skipped';reason:='accounting_source_suppressed:'||(notice.data->>'_push');
  ELSIF notice.created_at<now()-c_max_age THEN
   state:='skipped';reason:='accounting_historical_notification';
  END IF;
  SELECT * INTO existing FROM public.push_outbox WHERE accounting_notification_id=notice.id;
  IF FOUND THEN
   IF existing.recipient_user_id IS DISTINCT FROM notice.user_id OR existing.related_entity_id IS DISTINCT FROM notice.id
    OR existing.event IS DISTINCT FROM 'accounting_invoice' THEN RAISE EXCEPTION 'accounting_push_receipt_collision' USING ERRCODE='23514'; END IF;
   RETURN NEW;
  END IF;
  -- No exception swallowing here. The invoice, message, notification, linked
  -- transfer and durable outbox receipt commit together or all roll back.
  -- Normal dispatcher preference, quiet-hour, device and consent gates remain.
  INSERT INTO public.push_outbox(recipient_user_id,title,body,url,event,tag,status,failure_reason,related_entity_id,accounting_notification_id)
  VALUES(notice.user_id,left(notice.title,120),left(COALESCE(notice.message,notice.title),500),
   COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub'),
   'accounting_invoice','accounting_invoice:'||receipt.conversation_id::text,state,reason,notice.id,notice.id);
  RETURN NEW;
 END IF;

 -- A reserved accounting label with no actual delivery link is invalid,
 -- including a caller that forces this constraint before the link is written.
 -- Fail the transaction rather than silently dropping its accounting push.
 IF notice.type='accounting_invoice' THEN
  RAISE EXCEPTION 'accounting_push_delivery_link_missing' USING ERRCODE='23514';
 END IF;
 IF notice.type='accounting_invoice_detail' THEN RETURN NEW; END IF;
 -- Existing non-accounting notification policy stays intact.
 IF notice.data IS NOT NULL AND notice.data->>'_push' IS NOT NULL THEN RETURN NEW; END IF;
 IF notice.user_id IS NULL OR notice.title IS NULL OR btrim(notice.title)='' THEN RETURN NEW; END IF;
 IF notice.created_at IS NOT NULL AND notice.created_at<now()-c_max_age THEN RETURN NEW; END IF;
 IF notice.type IN('waitlist_seat_open','waitlist_offer_expired','seat_available','waitlist_ready','table_ready') THEN
  v_tag:='seat_offer:'||COALESCE(NULLIF(btrim(COALESCE(notice.data->>'table_id','')),''),notice.id::text);
 ELSIF notice.type IN('system','daily_challenge','venue_alert','bonus','vip','live','poker_news','diamond','achievement') THEN
  v_tag:=notice.type||':'||notice.user_id::text;
 ELSE
  v_tag:=notice.type||':'||COALESCE(NULLIF(btrim(COALESCE(notice.data->>'conversationId','')),''),NULLIF(btrim(COALESCE(notice.data->>'conversation_id','')),''),notice.actor_id::text,notice.id::text);
 END IF;
 BEGIN
  SELECT count(*) INTO v_pending FROM public.push_outbox WHERE recipient_user_id=notice.user_id AND status IN('pending','processing');
  IF v_pending>=c_max_pending THEN RETURN NEW; END IF;
  INSERT INTO public.push_outbox(recipient_user_id,title,body,url,event,tag,status,related_entity_id)
   VALUES(notice.user_id,left(notice.title,120),left(COALESCE(notice.message,notice.title),500),COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub'),notice.type,v_tag,'pending',notice.id);
 EXCEPTION WHEN OTHERS THEN RAISE WARNING 'mirror_notification_to_push_outbox failed for notification %: %',notice.id,SQLERRM;
 END;
 RETURN NEW;
END $function$;
CREATE CONSTRAINT TRIGGER trg_accounting_push_after_delivery AFTER INSERT ON public.notifications
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.type='accounting_invoice')
 EXECUTE FUNCTION public.fn_mirror_notification_to_push_outbox();

-- Four observed historical gaps only. Record the missed enqueue explicitly,
-- without belated device pushes, duplicate invoices or in-app notifications.
INSERT INTO public.push_outbox(recipient_user_id,title,body,url,event,tag,status,failure_reason,related_entity_id,accounting_notification_id)
SELECT n.user_id,left(n.title,120),left(COALESCE(n.message,n.title),500),COALESCE(NULLIF(n.link,''),NULLIF(n.action_url,''),'/hub'),
 'accounting_invoice','accounting_invoice:'||COALESCE(n.data->>'conversation_id',n.data->>'conversationId'),
 'skipped','historical_gap_receipt',n.id,n.id
FROM public.settlement_invoices i
JOIN public.accounting_invoice_deliveries d ON d.invoice_id=i.id
JOIN public.notifications n ON n.id=d.notification_id AND n.user_id=d.recipient_id
WHERE i.invoice_number IN('CA-2026-00000021','CA-2026-00000030','CA-2026-00000081','CA-2026-00000036')
 AND n.created_at='2026-09-14 11:34:35.237266+00'::timestamptz AND n.created_at<now()-interval '30 minutes'
 AND n.type='accounting_invoice' AND d.delivery_mode='immediate' AND n.data->>'invoice_id'=i.id::text
 AND n.data->>'invoice_number'=i.invoice_number
 AND NOT EXISTS(SELECT 1 FROM public.push_outbox p WHERE p.related_entity_id=n.id OR p.accounting_notification_id=n.id)
ON CONFLICT(accounting_notification_id) WHERE accounting_notification_id IS NOT NULL DO NOTHING;
COMMIT;

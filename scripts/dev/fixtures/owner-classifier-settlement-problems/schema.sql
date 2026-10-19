-- =============================================================================
--  FIXTURE: the owner classifier covers settlement problem and push-off notices
-- =============================================================================
-- For scripts/dev/probe-owner-classifier-settlement-problems.sh only; never
-- applied to production. It is loaded after scripts/dev/fixtures/owner-inbox-store-only/
-- (production before store-only delivery) and adds what that fixture leaves
-- out and this proof needs: the push mirror, so that a notification reaching
-- the owner's personal inbox is seen reaching push_outbox as it does in
-- production. Read from production kuklfnapbkmacvwxktbh on 2026-09-28 (UTC):
--   * public.push_outbox with its columns, constraints, the unique index the
--     accounting branch relies on, row-level security and grants (its foreign
--     key to auth.users and its tournament-reminder trigger are omitted);
--   * public.accounting_invoice_deliveries with its columns, constraints,
--     row-level security and grants, and the three tables the mirror joins,
--     reduced to the columns it reads, with their grants;
--   * fn_mirror_notification_to_push_outbox exactly as production prints it
--     (the text of 20260927143752; the probe pins it to production's md5
--     37d724277900f53d00db14fb3c5cd04d) and its two triggers,
--     trg_mirror_notification_to_push_outbox (AFTER INSERT, WHEN NOT the
--     classifier) and the deferred trg_accounting_push_after_delivery, pinned
--     to the md5 of production's pg_get_triggerdef.
-- The two foreign keys into public.notifications are the two production has
-- (NO ACTION), so the held cleanup 20260928000622 can run on this database.
SET client_min_messages = warning;

CREATE TABLE public.settlement_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text,
  net_amount numeric(12,2) NOT NULL,
  invoice_type text NOT NULL
);
CREATE TABLE public.social_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid,
  message_type text,
  media_metadata jsonb
);
CREATE TABLE public.social_conversation_participants (
  conversation_id uuid,
  user_id uuid
);
CREATE TABLE public.accounting_invoice_deliveries (
  invoice_id uuid NOT NULL REFERENCES public.settlement_invoices(id),
  recipient_id uuid NOT NULL REFERENCES public.profiles(id),
  message_id uuid NOT NULL UNIQUE REFERENCES public.social_messages(id),
  notification_id uuid NOT NULL UNIQUE REFERENCES public.notifications(id),
  delivered_at timestamptz NOT NULL DEFAULT now(),
  delivery_mode text NOT NULL DEFAULT 'immediate' CHECK (delivery_mode = ANY (ARRAY['immediate','weekly_detail'])),
  PRIMARY KEY (invoice_id, recipient_id)
);
CREATE TABLE public.push_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid,
  title text NOT NULL,
  body text NOT NULL,
  url text,
  icon_url text,
  badge_url text,
  tag text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status = ANY (ARRAY['pending','processing','sent','failed','skipped'])),
  attempts integer NOT NULL DEFAULT 0,
  failure_reason text,
  related_entity_id uuid,
  event text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  claimed_at timestamptz,
  image_url text,
  accounting_notification_id uuid REFERENCES public.notifications(id),
  next_attempt_at timestamptz,
  CONSTRAINT accounting_push_deferral_requires_typed_receipt
    CHECK (next_attempt_at IS NULL OR (accounting_notification_id IS NOT NULL AND isfinite(next_attempt_at))),
  CONSTRAINT accounting_push_notification_identity
    CHECK (accounting_notification_id IS NULL OR (NOT (event IS DISTINCT FROM 'accounting_invoice')
      AND NOT (related_entity_id IS DISTINCT FROM accounting_notification_id)))
);
CREATE UNIQUE INDEX accounting_push_one_notification_receipt ON public.push_outbox (accounting_notification_id)
  WHERE accounting_notification_id IS NOT NULL;

-- Row-level security and grants as production holds them (the default
-- privileges of the store-only fixture granted more; these are the grants).
ALTER TABLE public.settlement_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_invoice_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.settlement_invoices, public.social_conversation_participants, public.push_outbox,
  public.accounting_invoice_deliveries FROM anon, authenticated;
GRANT SELECT, REFERENCES, TRIGGER ON public.settlement_invoices, public.social_conversation_participants,
  public.push_outbox TO anon, authenticated;
GRANT SELECT ON public.accounting_invoice_deliveries TO authenticated;

-- fn_mirror_notification_to_push_outbox, verbatim (20260927143752)
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
  i.invoice_number,i.net_amount,i.invoice_type INTO receipt
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
  ELSIF notice.user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid THEN
   -- Same owner-operational recipient fn_is_owner_operational_notification()
   -- hard-codes (kept as a literal here, not a shared call, because that
   -- classifier also gates on p_type and would return false for
   -- 'accounting_invoice' -- this is not a second source of truth for WHO
   -- the owner is, only a second reference to the same fixed id). This is
   -- his issuer-side owner/union-owner copy of a receipt whose real payee is
   -- someone else; it must NOT be added to fn_is_owner_operational_
   -- notification's type list, or the capture trigger fires once per
   -- receipt (hundreds per settlement) instead of once per hour, and the
   -- non-accounting mirror predicate below would wrongly suppress it too.
   state:='skipped';reason:='owner_accounting_routed_to_production_alerts';
  END IF;
  SELECT * INTO existing FROM public.push_outbox WHERE accounting_notification_id=notice.id;
  IF FOUND THEN
   IF existing.recipient_user_id IS DISTINCT FROM notice.user_id OR existing.related_entity_id IS DISTINCT FROM notice.id
    OR existing.event IS DISTINCT FROM 'accounting_invoice' THEN RAISE EXCEPTION 'accounting_push_receipt_collision' USING ERRCODE='23514'; END IF;
   IF receipt.invoice_type IN('cashier_cashout','accounting_correction','credit_limit_change') AND ROW(existing.title,existing.body,existing.url,existing.tag) IS DISTINCT FROM
     ROW(left(notice.title,120),left(COALESCE(notice.message,notice.title),500),
       COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub'),
       'accounting_invoice:'||receipt.conversation_id::text)
   THEN RAISE EXCEPTION 'cashier_push_content_mismatch' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
  -- No exception swallowing here. The invoice, message, notification, linked
  -- transfer and durable outbox receipt commit together or all roll back.
  -- Normal dispatcher preference, quiet-hour, device and consent gates remain.
  INSERT INTO public.push_outbox(recipient_user_id,title,body,url,event,tag,status,failure_reason,related_entity_id,accounting_notification_id)
  VALUES(notice.user_id,left(notice.title,120),left(COALESCE(notice.message,notice.title),500),
   COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub'),
   'accounting_invoice','accounting_invoice:'||receipt.conversation_id::text,state,reason,notice.id,notice.id);
  IF reason='owner_accounting_routed_to_production_alerts' THEN
   -- Informational only, coalesced to one row per UTC hour. Must never be
   -- able to roll back the invoice/message/notification/outbox insert above.
   BEGIN
    PERFORM public.fn_record_operational_alert('owner-accounting-notifications',
     'owner-accounting:'||to_char(date_trunc('hour',now() AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24'),
     'Accounting Documents Issued (Owner Copy)','info','info',
     jsonb_build_object('first_notification_id',notice.id,'invoice_number',receipt.invoice_number,
      'invoice_type',receipt.invoice_type,'amount',receipt.net_amount,
      'conversation_id',receipt.conversation_id,
      'hour',to_char(date_trunc('hour',now() AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24')));
   EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'owner_accounting_alert_record_failed for notification %: %',notice.id,SQLERRM;
   END;
  END IF;
  IF receipt.invoice_type IN('cashier_cashout','accounting_correction','credit_limit_change') AND NOT EXISTS(SELECT 1 FROM public.push_outbox o
    WHERE o.accounting_notification_id=notice.id AND o.related_entity_id=notice.id
      AND o.recipient_user_id=notice.user_id AND o.event='accounting_invoice'
      AND o.status=state AND o.failure_reason IS NOT DISTINCT FROM reason
      AND o.title=left(notice.title,120) AND o.body=left(COALESCE(notice.message,notice.title),500)
      AND o.url=COALESCE(NULLIF(btrim(notice.link),''),NULLIF(btrim(notice.action_url),''),'/hub')
      AND o.tag='accounting_invoice:'||receipt.conversation_id::text)
  THEN RAISE EXCEPTION 'cashier_push_receipt_missing' USING ERRCODE='23514';END IF;
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
REVOKE ALL ON FUNCTION public.fn_mirror_notification_to_push_outbox() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mirror_notification_to_push_outbox() TO service_role;
CREATE TRIGGER trg_mirror_notification_to_push_outbox AFTER INSERT ON public.notifications
  FOR EACH ROW WHEN (NOT public.fn_is_owner_operational_notification(NEW.user_id,NEW.type,NEW.title,NEW.data))
  EXECUTE FUNCTION public.fn_mirror_notification_to_push_outbox();
CREATE CONSTRAINT TRIGGER trg_accounting_push_after_delivery AFTER INSERT ON public.notifications
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type = 'accounting_invoice')
  EXECUTE FUNCTION public.fn_mirror_notification_to_push_outbox();

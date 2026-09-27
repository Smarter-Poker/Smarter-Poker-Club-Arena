-- 20260927221309_push_delivery_is_for_reachable_recipients.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Measured read-only on production 2026-09-27 (push_outbox, last 7 days):
--
--     accounting_invoice  sent     88 rows   1 recipient  (a human with a device)
--     accounting_invoice  skipped  71 rows  37 recipients no_subscription
--     bonus               skipped  93 rows  83 recipients no_subscription
--     system              skipped   7 rows   1 recipient  no_subscription
--     page_completion_nudge skipped 2 rows  2 recipients  no_subscription
--
-- Only 2 active push_subscriptions exist. Every no_subscription row was
-- written by fn_mirror_notification_to_push_outbox for a recipient no device
-- could ever reach, then claimed by the dispatcher only to be marked skipped.
-- The reported "97% accounting push failure" is 37 of 38 recipients: those
-- rows, every one addressed to nobody, not a delivery fault.
--
-- THE PREDICATE IS REACHABILITY, NEVER SPECIES (CLAUDE.md 10.5, BINDING).
-- The request that produced this migration asked for an is_horse gate
-- ("horse recipients never enter push delivery"). Every skipped row above
-- does belong to a recipient with no device, and most of those are horses,
-- but CLAUDE.md 10.5 forbids leaving horses out of anything a human would
-- get, and 20260912050723 (prepare_tournament_reminders) already settled this
-- exact question the same way, pinned by
-- tests/a-reminder-needs-a-device.law.test.ts. So the gate here asks about
-- the DEVICE and nothing else: a human with no device is treated exactly like
-- a horse with no device, and a horse that enrols a device is pushed like
-- anybody else. The outcome for today's horse traffic is the same one the
-- request wanted: none of it enters push delivery.
--
--   * ACCOUNTING BRANCH: the durable receipt is still written, so the
--     20260914141405 invariant (one push_outbox receipt per canonical
--     accounting notification, committed with the invoice or not at all)
--     holds unchanged. When the recipient has no active device the receipt is
--     born status='skipped', failure_reason='no_subscription' - the exact
--     string pages/api/cron/push-dispatch.js and accounting-delivery.js write,
--     so fn_push_health_snapshot keeps counting it as not_enrolled. The owner
--     gate from 20260927143752 is evaluated FIRST and is untouched, so the
--     owner's copies still read owner_accounting_routed_to_production_alerts
--     and still coalesce into the hourly Production Alerts info event.
--
--   * NON-ACCOUNTING BRANCH: returns without enqueueing when the recipient
--     has no active device, as prepare_tournament_reminders already does.
--
-- Nothing else in the body changes. The index the predicate rides on,
-- push_subscriptions_user_active_idx ON (user_id) WHERE is_active, is live and
-- in the repo (20260912050723).
--
-- OTHER ENQUEUERS, checked on production:
--   prepare_tournament_reminders   already reachability-gated (20260912050723)
--   fn_diamond_spin_settlement_receipt  NOT an enqueuer: a guard that refuses a
--                                  diamond spin settlement with ANY push_outbox
--                                  row. Nothing to change.
--   World Hub src/lib/push/push-enqueue.js (page_completion_nudge,
--   financial_digest)              out of this repository; its gate writes a
--                                  skipped row per suppression by design.
--
-- Preimage: md5(pg_get_functiondef) of the live body, installed 2026-09-27 by
-- 20260927143752. Postimage: this body's md5, measured in the native harness
-- scripts/dev/test-accounting-push-bridge.sh.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';

DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure))<>'37d724277900f53d00db14fb3c5cd04d'
 THEN RAISE EXCEPTION 'push outbox mirror changed since review'; END IF;
 IF to_regclass('public.push_subscriptions') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.push_subscriptions'::regclass AND attname='is_active' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'push_subscriptions.is_active is required by the reachability predicate'; END IF;
END $guard$;

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
  ELSIF NOT EXISTS(SELECT 1 FROM public.push_subscriptions s WHERE s.user_id=notice.user_id AND s.is_active) THEN
   -- REACHABILITY, NEVER SPECIES (CLAUDE.md 10.5). A recipient with no live
   -- device cannot be pushed by anyone. The durable receipt is still written
   -- (the 20260914141405 invariant), already settled with the SAME reason the
   -- dispatcher would have written a minute later, so it is never claimed and
   -- fn_push_health_snapshot counts it as not_enrolled, never as a fault.
   -- Horse or human alike: a horse that enrols a device is pushed like anyone.
   state:='skipped';reason:='no_subscription';
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
 -- REACHABILITY, NEVER SPECIES (CLAUDE.md 10.5): the same predicate
 -- prepare_tournament_reminders already uses. A row addressed to a recipient
 -- with no active device can only ever be skipped, so it is never written.
 IF NOT EXISTS(SELECT 1 FROM public.push_subscriptions s WHERE s.user_id=notice.user_id AND s.is_active) THEN RETURN NEW; END IF;
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

DO $post$ BEGIN
 IF md5(pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure))<>'4c36223326ba037a1e61f813f509a491'
 THEN RAISE EXCEPTION 'push outbox mirror postimage does not match the reviewed body'; END IF;
 IF has_function_privilege('anon','public.fn_mirror_notification_to_push_outbox()','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_mirror_notification_to_push_outbox()','EXECUTE')
 THEN RAISE EXCEPTION 'push outbox mirror is executable by a client role'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgfoid='public.fn_mirror_notification_to_push_outbox()'::regprocedure
      AND tgrelid='public.notifications'::regclass
      AND tgname IN('trg_accounting_push_after_delivery','trg_mirror_notification_to_push_outbox'))<>2
 THEN RAISE EXCEPTION 'push outbox mirror lost a trigger'; END IF;
END $post$;

COMMIT;

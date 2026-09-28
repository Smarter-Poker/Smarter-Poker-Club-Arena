-- 20260928032225_owner_accounting_alerts_carry_the_fleet_address.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20260927143752 (recorded on production as version 20260927214610) taught
-- fn_mirror_notification_to_push_outbox() to route the owner account's
-- issuer-side accounting copies to Production Alerts: one coalesced 'info'
-- event per UTC hour through fn_record_operational_alert(), under source
-- 'owner-accounting-notifications'. That call's payload carries no
-- target_task_id. The Production Alerts fleet triages
-- public.operational_alert_events by payload.target_task_id, so every one of
-- those rows would reach the store and never reach the lane that reads it -
-- the defect the smarter-poker-workers writers had until 2026-09-26.
--
-- Read-only on production at 2026-09-28T15:31Z: md5(pg_get_functiondef) of
-- the installed body is 37d724277900f53d00db14fb3c5cd04d, position of
-- 'target_task_id' in it is 0, and no row under source
-- 'owner-accounting-notifications' exists yet. So this closes no row; it stops
-- the first one landing unaddressed.
--
-- THREE THINGS, ONE TRANSACTION.
--
-- 1. The sender. The function below is the 20260927143752 body copied
--    verbatim, except that the recorder's payload now opens with
--    'target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca' and its exception
--    handler (item 3) no longer ends at a WARNING. The owner gate, the skipped
--    durable receipt, the hourly event_key, the BEGIN/EXCEPTION that keeps a
--    Production Alerts failure from rolling back a financial document, and the
--    cashier post-check are unchanged. The key has to be on the FIRST call of
--    each hour: fn_record_operational_alert() sets payload only when it
--    inserts; on conflict (source,event_key) it bumps last_received_at and
--    delivery_count and leaves payload alone.
--
-- 2. The store refuses the bad state. operational_alert_events gains
--    operational_alert_events_owner_accounting_addressed: a row under
--    'owner-accounting-notifications' must carry payload.target_task_id equal
--    to the fleet id, as text, exactly as the fleet and
--    scripts/ci/check-operational-alert-addressing.mjs read it. So a later
--    body that drops the key, the batch writer fn_record_operational_alerts(),
--    a direct INSERT, dynamic SQL or an out-of-band apply cannot store an
--    unaddressed row under this source, whatever a text check can see.
--    - IS NOT DISTINCT FROM, not =: a CHECK passes when its expression is
--      NULL, so "OR payload->>'target_task_id' = '<id>'" would let a payload
--      WITHOUT the key through - the exact bad state (measured on PostgreSQL
--      16: such a check accepts '{}').
--    - Narrow on purpose: 43,354 older rows under other sources carry no key
--      (read-only, 15:31Z; none written in the last 24 hours), so a store-wide
--      rule would not validate. For every other source the first disjunct is
--      true, so no INSERT, no ON CONFLICT update from the writer and no fleet
--      investigation update of their rows can be refused.
--    - A CHECK, not a trigger: supabase/components/cash-pot-check-evidence.sql
--      (and its rollback) refuse to install over any user trigger on this
--      table, and a CHECK needs no function whose md5 would have to be pinned.
--      It is the precedent operational_notification_destinations.target_task_id
--      already set (NOT NULL CHECK (target_task_id = the fleet id)).
--    - Validated inside this transaction, so it holds ACCESS EXCLUSIVE on the
--      table for one sequential scan: measured 65-89 ms warm and 852 ms with
--      the OS cache dropped, on a PostgreSQL 16 copy of 140,254 rows with a
--      219 MiB heap; production has 140,254 rows, a 231 MiB heap and about 890
--      inserts an hour (read-only, 15:31Z). The rule only reads payload for
--      rows under this source, so the scan does not detoast. NOT VALID plus
--      VALIDATE would not shorten the lock here: the ADD's lock is held to
--      COMMIT, and one change is one transaction. The ALTER runs last, so the
--      lock is held for the scan and the post-checks only. lock_timeout 3s
--      bounds the wait for the lock; a writer inside the owner-accounting
--      branch that times out waiting is caught by that branch's handler.
--    - The guard below refuses to validate over a row that is already
--      unaddressed (0 today). If the pre-image writes one before this runs,
--      this migration refuses whole and must be rebuilt with a held cleanup.
--
-- 3. A refused recording reaches the fleet. The recorder runs inside a
--    BEGIN/EXCEPTION that only raised a WARNING, which nobody reads. Its
--    handler now records, through the same writer, one addressed 'firing'
--    row per UTC hour under the same source (event_key
--    'owner-accounting-unstored:<hour>', alertname 'Owner Accounting Alert Not
--    Stored') carrying the SQLSTATE, message and constraint name, in a nested
--    block that can fail on its own without touching the document. Nothing in
--    that handler reads or writes push_outbox, so which notifications are
--    pushed, skipped or receipted is unchanged: the harness shows push_outbox
--    identical row for row under the 20260927143752 body and this one
--    (docs/production-alerts/evidence/owner-accounting-unaddressed/README.md).
--
-- WHY THE SENDER AND THE STORE, NOT THE WRITER. Defaulting target_task_id
-- inside fn_record_operational_alert() would change a function whose md5
-- (36601e205494e8768f5a1dce09f4a186) the authority snapshots in
-- 20260917054616 and 20260917062322 pin, and would make the next unaddressed
-- sender look addressed instead of being fixed. The writer is not modified.
-- The direct-intake authority capture of 2026-09-17
-- (supabase/components/direct-operational-source-intake.authority.sql) lists
-- this table's constraints exactly; it already differs from production in
-- ca_drift_incidents and financial_alerts (read-only, 15:31Z), so that
-- component's install and rollback are refused today either way.
--
-- OWNERSHIP. Union accounting owns fn_mirror_notification_to_push_outbox().
-- This is a bounded change to the Production Alerts call that 20260927143752
-- added; no accounting path, receipt or push decision moves.
--
-- SAME PRE-IMAGE AS 20260927221309 (PR #5489, in flight when this was
-- written). That migration also replaces this function from
-- 37d724277900f53d00db14fb3c5cd04d and keeps the unaddressed recorder call.
-- Both guard on that pre-image, so whichever is applied second is refused and
-- rolls back whole; it must then be rebuilt on the other's post-image and
-- carry both changes. After this one, #5489's body could not store its hourly
-- row at all: the store refuses it and the fleet gets the failure row.
--
-- Postimage md5 c0d5fe55644a793450a6ea08828181ce: measured by installing this
-- body over the pre-image on a throwaway PostgreSQL that reproduces the
-- production pre-image md5 byte for byte, and asserted below.
--
-- The function existed before this migration, so its presence in the catalogue
-- proves nothing about whether this ran. The two lines below are what
-- scripts/ci/check-migrations-are-live.mjs asks production instead; they stay
-- true for any later body that keeps the address and the store's rule.
-- @live-proof: position('target_task_id' in pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure)) > 0
-- @live-proof: EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.operational_alert_events'::regclass AND conname='operational_alert_events_owner_accounting_addressed' AND convalidated)
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
 IF EXISTS(SELECT 1 FROM public.operational_alert_events WHERE source='owner-accounting-notifications'
   AND (payload->>'target_task_id') IS DISTINCT FROM '01a09b86-5ba8-7290-8657-1041f13dd3ca')
 THEN RAISE EXCEPTION 'an unaddressed owner-accounting-notifications row already exists; rebuild this with a held cleanup'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_mirror_notification_to_push_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE notice public.notifications%ROWTYPE; receipt record; existing public.push_outbox%ROWTYPE;
 v_tag text;v_pending int;state text:='pending';reason text;
 c_max_pending CONSTANT int:=20;c_max_age CONSTANT interval:=interval '30 minutes';
 v_alert_state text;v_alert_error text;v_alert_constraint text;
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
     jsonb_build_object('target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca','first_notification_id',notice.id,'invoice_number',receipt.invoice_number,
      'invoice_type',receipt.invoice_type,'amount',receipt.net_amount,
      'conversation_id',receipt.conversation_id,
      'hour',to_char(date_trunc('hour',now() AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24')));
   EXCEPTION WHEN OTHERS THEN
    -- The store refused the hour's event (operational_alert_events refuses an
    -- unaddressed row under this source) or could not take it. A WARNING
    -- reaches nobody, so the fleet gets its own addressed row for the hour,
    -- from a nested block: that can fail too, and still never rolls back the
    -- document above or touches the receipt this branch already wrote.
    GET STACKED DIAGNOSTICS v_alert_state=RETURNED_SQLSTATE,v_alert_error=MESSAGE_TEXT,v_alert_constraint=CONSTRAINT_NAME;
    RAISE WARNING 'owner_accounting_alert_record_failed for notification %: %',notice.id,v_alert_error;
    BEGIN
     PERFORM public.fn_record_operational_alert('owner-accounting-notifications',
      'owner-accounting-unstored:'||to_char(date_trunc('hour',now() AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24'),
      'Owner Accounting Alert Not Stored','firing','warning',
      jsonb_build_object('target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca','unstored_event_key',
       'owner-accounting:'||to_char(date_trunc('hour',now() AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24'),
       'first_notification_id',notice.id,'sqlstate',v_alert_state,'error',left(v_alert_error,1000),
       'constraint',NULLIF(v_alert_constraint,''),
       'hour',to_char(date_trunc('hour',now() AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24')));
    EXCEPTION WHEN OTHERS THEN
     RAISE WARNING 'owner_accounting_alert_unstored_record_failed for notification %: %',notice.id,SQLERRM;
    END;
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

ALTER TABLE public.operational_alert_events
 ADD CONSTRAINT operational_alert_events_owner_accounting_addressed
 CHECK (source<>'owner-accounting-notifications'
  OR (payload->>'target_task_id') IS NOT DISTINCT FROM '01a09b86-5ba8-7290-8657-1041f13dd3ca');

DO $post$
DECLARE def text:=pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure); con record;
BEGIN
 IF def NOT LIKE '%jsonb_build_object(''target_task_id'',''01a09b86-5ba8-7290-8657-1041f13dd3ca'',''first_notification_id''%'
  OR def NOT LIKE '%jsonb_build_object(''target_task_id'',''01a09b86-5ba8-7290-8657-1041f13dd3ca'',''unstored_event_key''%'
 THEN RAISE EXCEPTION 'owner accounting Production Alerts event is still not addressed to the fleet'; END IF;
 IF def NOT LIKE '%state:=''skipped'';reason:=''owner_accounting_routed_to_production_alerts'';%'
  OR def NOT LIKE '%AND o.status=state AND o.failure_reason IS NOT DISTINCT FROM reason%'
 THEN RAISE EXCEPTION 'owner accounting routing or its cashier post-check changed'; END IF;
 IF md5(def)<>'c0d5fe55644a793450a6ea08828181ce'
 THEN RAISE EXCEPTION 'push outbox mirror postimage does not match the reviewed body'; END IF;
 SELECT c.convalidated,c.condeferrable,pg_get_constraintdef(c.oid) AS definition INTO con FROM pg_constraint c
 WHERE c.conrelid='public.operational_alert_events'::regclass AND c.conname='operational_alert_events_owner_accounting_addressed' AND c.contype='c';
 IF NOT FOUND OR NOT con.convalidated OR con.condeferrable
  OR con.definition IS DISTINCT FROM 'CHECK (((source <> ''owner-accounting-notifications''::text) OR (NOT ((payload ->> ''target_task_id''::text) IS DISTINCT FROM ''01a09b86-5ba8-7290-8657-1041f13dd3ca''::text))))'
 THEN RAISE EXCEPTION 'the store does not refuse an unaddressed owner accounting row'; END IF;
END $post$;

COMMIT;

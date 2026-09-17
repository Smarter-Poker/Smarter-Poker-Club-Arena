-- SOURCE ONLY / UNRUN. Same one guarded post36 transaction as the credit
-- operation and document fragments. Extend the existing delivery authority.
DO $credit_delivery_preimages$ DECLARE expected jsonb;target oid;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($pins$[{"name":"fn_deliver_accounting_invoice","predecessor_body_md5":"4e2964d3fa3557af65bc4535c334cbf8","predecessor_definition_source_sha256":"3f089eb9e1830248f9ea79e6c580189fea7e3a33dbdd38c503c2112e291b0ddd"},{"name":"fn_accounting_document_immutable","predecessor_body_md5":"23ddceacaa3fe54294910d40faf46a5d","predecessor_definition_source_sha256":"c690d708a8f501d877ad4d62610013f182f433db1829740b0e939d79e2099e94"},{"name":"fn_mirror_notification_to_push_outbox","predecessor_body_md5":"4cad61d22e819db464e0b5b2c41bb4a5","predecessor_definition_source_sha256":"4e369c226631fd9a6e0ae498f930da71d0cc9e76ce0699ae22bb4c4ebade9a53"}]$pins$::jsonb) LOOP
  target:=to_regprocedure('public.'||(expected->>'name')||CASE WHEN expected->>'name'='fn_deliver_accounting_invoice' THEN '(uuid)' ELSE '()' END);
  IF target IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole
    AND prosecdef AND proconfig=ARRAY['search_path=public']::text[] AND md5(prosrc)=expected->>'predecessor_body_md5'
    AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND prokind='f' AND provolatile='v'
    AND NOT proisstrict AND NOT proleakproof AND proparallel='u' AND NOT proretset AND pronargdefaults=0
    AND prorettype=CASE WHEN expected->>'name'='fn_deliver_accounting_invoice' THEN 'jsonb'::regtype ELSE 'trigger'::regtype END
    AND proargnames IS NOT DISTINCT FROM CASE WHEN expected->>'name'='fn_deliver_accounting_invoice' THEN ARRAY['p_invoice_id'] ELSE NULL::text[] END)
   OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=target)
       IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]
  THEN RAISE EXCEPTION 'credit_change_delivery_preimage_changed' USING DETAIL=expected->>'name';END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass
   AND conname='settlement_invoices_invoice_type_check' AND convalidated
   AND pg_get_constraintdef(oid)=$vocabulary$CHECK ((invoice_type = ANY (ARRAY['union_to_club'::text, 'club_to_agent'::text, 'agent_to_subagent'::text, 'agent_to_player'::text, 'union_club_pnl'::text, 'club_to_union'::text, 'union_weekly_squareup'::text, 'union_weekly_credit_note'::text, 'transaction_receipt'::text, 'club_weekly_accounting'::text, 'cashier_cashout'::text, 'accounting_correction'::text])))$vocabulary$)
 THEN RAISE EXCEPTION 'credit_change_invoice_vocabulary_changed';END IF;
END $credit_delivery_preimages$;
ALTER TABLE public.settlement_invoices DROP CONSTRAINT settlement_invoices_invoice_type_check;
ALTER TABLE public.settlement_invoices ADD CONSTRAINT settlement_invoices_invoice_type_check CHECK(invoice_type=ANY(ARRAY['union_to_club','club_to_agent','agent_to_subagent','agent_to_player','union_club_pnl','club_to_union','union_weekly_squareup','union_weekly_credit_note','transaction_receipt','club_weekly_accounting','cashier_cashout','accounting_correction','credit_limit_change']));

CREATE OR REPLACE FUNCTION public.fn_deliver_accounting_invoice(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_variable
DECLARE inv public.settlement_invoices%ROWTYPE; sender uuid; issuer_name text; recipient_name text;
 issuer_kind text; issuer_id uuid; recipient_id uuid; scope_id uuid; page_id uuid; users uuid[]; issuer_users uuid[]; recipient_users uuid[];
 person uuid; conv uuid; msg uuid; note uuid; body text; meta jsonb; count_sent int:=0; n int; line record; cashier public.accounting_cashier_events%ROWTYPE; cashier_payload jsonb; correction public.accounting_correction_documents%ROWTYPE; correction_payload jsonb; credit_change public.accounting_credit_change_documents_v1%ROWTYPE; credit_operation public.accounting_credit_reduction_operations_v1%ROWTYPE; credit_payload jsonb;
BEGIN
 SELECT * INTO inv FROM public.settlement_invoices WHERE id=p_invoice_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_invoice_missing' USING ERRCODE='23514'; END IF;
 IF public.fn_accounting_correction_is_unverified(inv.id)
 THEN RAISE EXCEPTION 'historical_correction_document_unverified' USING ERRCODE='23514';END IF;
 IF inv.net_amount IS NULL OR inv.net_amount::text IN('NaN','Infinity','-Infinity') OR inv.net_amount<>round(inv.net_amount,2)
 THEN RAISE EXCEPTION 'invalid_invoice_amount' USING ERRCODE='23514'; END IF;
 issuer_kind:=inv.from_entity_type; issuer_id:=inv.from_entity_id::uuid; recipient_id:=inv.to_entity_id::uuid;
 scope_id:=COALESCE(inv.club_id,issuer_id);
 IF inv.invoice_type='credit_limit_change' THEN
  credit_payload:=public.fn_accounting_credit_change_contract_v1(inv.id);
  SELECT * INTO STRICT credit_change FROM public.accounting_credit_change_documents_v1 WHERE invoice_id=inv.id;
  SELECT * INTO STRICT credit_operation FROM public.accounting_credit_reduction_operations_v1 WHERE id=credit_change.operation_receipt_id;
  users:=credit_change.audience_user_ids;sender:=credit_operation.actor_user_id;
  issuer_kind:='club';issuer_id:=credit_operation.club_id;scope_id:=credit_operation.club_id;
  issuer_name:=credit_change.issuer_name;recipient_name:=credit_change.recipient_name;
 ELSIF inv.invoice_type='accounting_correction' THEN
  SELECT * INTO correction FROM public.accounting_correction_documents WHERE invoice_id=inv.id;
  IF NOT FOUND OR correction.club_id IS DISTINCT FROM inv.club_id OR correction.source_ledger_id IS DISTINCT FROM inv.source_ledger_id
   OR correction.amount IS DISTINCT FROM inv.net_amount OR inv.breakdown IS DISTINCT FROM jsonb_build_object('category','correction','correction',public.fn_accounting_correction_payload(correction))
   OR inv.status IS DISTINCT FROM 'generated' OR inv.chips_transferred IS DISTINCT FROM false OR inv.transferred_at IS NOT NULL OR inv.due_at IS NOT NULL
  THEN RAISE EXCEPTION 'correction_document_delivery_source_unverified' USING ERRCODE='23514';END IF;
  users:=correction.audience_user_ids;sender:=correction.issuer_representative_id;
  issuer_kind:=correction.issuer_type;issuer_id:=correction.issuer_id;scope_id:=correction.club_id;
  issuer_name:=correction.issuer_name;recipient_name:=correction.payee_name;correction_payload:=public.fn_accounting_correction_payload(correction);
 ELSIF inv.invoice_type='cashier_cashout' THEN
  SELECT * INTO cashier FROM public.accounting_cashier_events WHERE invoice_id=inv.id;
  IF NOT FOUND OR cashier.club_id IS DISTINCT FROM inv.club_id OR cashier.source_ledger_id IS DISTINCT FROM inv.source_ledger_id
    OR cashier.amount IS DISTINCT FROM inv.net_amount OR inv.breakdown->'cashier' IS DISTINCT FROM public.fn_cashier_event_payload(cashier)
  THEN RAISE EXCEPTION 'cashier_delivery_event_missing' USING ERRCODE='23514';END IF;
  users:=cashier.audience_user_ids;sender:=cashier.issuer_representative_id;
  issuer_kind:='club';issuer_id:=cashier.club_id;scope_id:=cashier.club_id;
  issuer_name:=cashier.issuer_name;recipient_name:=cashier.player_name;
  cashier_payload:=public.fn_cashier_event_payload(cashier);
 ELSE
 SELECT array_agg(user_id ORDER BY user_id) INTO issuer_users FROM public.fn_accounting_party_users(inv.from_entity_type,issuer_id);
 SELECT array_agg(user_id ORDER BY user_id) INTO recipient_users FROM public.fn_accounting_party_users(inv.to_entity_type,recipient_id);
 IF COALESCE(cardinality(issuer_users),0)=0 OR COALESCE(cardinality(recipient_users),0)=0
 THEN RAISE EXCEPTION 'accounting_invoice_recipient_missing' USING ERRCODE='23514'; END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO users FROM unnest(issuer_users||recipient_users) x;
 -- Club senders receive one weekly summary; individual payees still get their receipt immediately.
 IF inv.from_entity_type='club' AND inv.to_entity_type IN('agent','player')
    AND inv.source_ledger_id IS NOT NULL AND inv.breakdown->>'category' IN('rakeback','commission') THEN
   users:=recipient_users;
 END IF;
 IF inv.invoice_type IN('union_weekly_squareup','union_weekly_credit_note') THEN
   issuer_kind:='union';issuer_id:=(inv.breakdown->>'union_id')::uuid;
 END IF;
 sender:=CASE WHEN issuer_kind='club' THEN (SELECT owner_id FROM public.clubs WHERE id=issuer_id)
              WHEN issuer_kind='union' THEN (SELECT owner_id FROM public.unions WHERE id=issuer_id)
              ELSE issuer_id END;
 IF sender IS NULL OR NOT sender=ANY(issuer_users||recipient_users) THEN RAISE EXCEPTION 'accounting_invoice_sender_missing' USING ERRCODE='23514'; END IF;
 issuer_name:=CASE WHEN issuer_kind='club' THEN (SELECT name FROM public.clubs WHERE id=issuer_id)
                   WHEN issuer_kind='union' THEN (SELECT name FROM public.unions WHERE id=issuer_id)
                   ELSE (SELECT username FROM public.profiles WHERE id=issuer_id) END;
 recipient_name:=CASE WHEN inv.to_entity_type='club' THEN (SELECT name FROM public.clubs WHERE id=recipient_id)
                      WHEN inv.to_entity_type='union' THEN (SELECT name FROM public.unions WHERE id=recipient_id)
                      ELSE (SELECT username FROM public.profiles WHERE id=recipient_id) END;
 END IF;
 IF inv.invoice_number IS NULL THEN
   UPDATE public.settlement_invoices SET invoice_number=public.fn_accounting_next_invoice_number() WHERE id=inv.id RETURNING invoice_number INTO inv.invoice_number;
 END IF;
 IF inv.invoice_type IN('union_weekly_squareup','union_weekly_credit_note') THEN recipient_name:=(SELECT name FROM public.clubs WHERE id=inv.club_id); END IF;
 body:=CASE WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number||E'\nIssued By: '||COALESCE(issuer_name,inv.from_entity_type)||E'\nFor: '||COALESCE(recipient_name,inv.to_entity_type)
  ||E'\nDirection: '||initcap(inv.from_entity_type)||' To '||initcap(inv.to_entity_type)
  ||E'\nAmount: '||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips'
  ||E'\nStatus: '||initcap(inv.status)
  ||CASE WHEN inv.chips_transferred THEN E'\nTransfer Recorded: '||COALESCE(inv.transferred_at,inv.created_at)::text ELSE '' END
  ||CASE WHEN inv.due_at IS NOT NULL THEN E'\nDue: '||to_char(inv.due_at AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI')||' Chicago Time' ELSE '' END
  ||CASE WHEN inv.breakdown ? 'period_start' THEN E'\nPeriod: '||(inv.breakdown->>'period_start')||' To '||COALESCE(inv.breakdown->>'period_end','') ELSE '' END
  ||CASE WHEN inv.notes IS NOT NULL THEN E'\n'||inv.notes ELSE '' END;
 FOR line IN SELECT key,value FROM jsonb_each_text(COALESCE(inv.breakdown,'{}'))
   WHERE key IN('rake_generated','rakeback_due','union_fee_kept','players_won','settled_in_chips','eco_amount','presettled','rake_earned','union_rake_earned','private_rake_earned','private_rake_banked','total_rake_funding','rake_received','paid_super_agents','paid_agents','paid_sub_agents','paid_players','total_paid_by_club','retained_by_club','downstream_redistributed','downstream_paid_super_agents','downstream_paid_agents','downstream_paid_sub_agents','downstream_paid_players') ORDER BY key
 LOOP
   IF line.value IS NOT NULL THEN body:=body||E'\n'||initcap(replace(line.key,'_',' '))||': '||to_char(line.value::numeric,'FM999,999,999,999,990.00'); END IF;
 END LOOP;
 IF inv.invoice_type='credit_limit_change' THEN body:=public.fn_accounting_credit_change_body_v1(credit_change.id,inv.invoice_number);
 ELSIF inv.invoice_type='cashier_cashout' THEN body:=public.fn_cashier_document_body(cashier.id,inv.invoice_number);
 ELSIF inv.invoice_type='accounting_correction' THEN body:=public.fn_accounting_correction_document_body(correction.id,inv.invoice_number);END IF;
 meta:=jsonb_build_object('kind','accounting_invoice' ,'invoice_id',inv.id,'invoice_number',inv.invoice_number,
   'club_id',inv.club_id,'source_ledger_id',inv.source_ledger_id,'source_credit_invoice_id',inv.source_credit_invoice_id,
   'source_credit_payment_id',inv.source_credit_payment_id,'amount',inv.net_amount,'currency','CHIPS','conversationId',NULL,'status',inv.status,
   'invoice_type',inv.invoice_type,'from_entity_type',inv.from_entity_type,'from_entity_id',inv.from_entity_id,
   'to_entity_type',inv.to_entity_type,'to_entity_id',inv.to_entity_id,'lines',inv.breakdown-'source_ledger_ids');
 IF inv.invoice_type='credit_limit_change' THEN meta:=meta||jsonb_build_object('credit_change',credit_payload);
 ELSIF inv.invoice_type='cashier_cashout' THEN meta:=meta||jsonb_build_object('cashier',cashier_payload);
 ELSIF inv.invoice_type='accounting_correction' THEN meta:=meta||jsonb_build_object('correction',correction_payload);END IF;
 SELECT id INTO page_id FROM public.social_pages WHERE linked_entity_id=scope_id::text AND linked_entity_type='club' ORDER BY id LIMIT 1;
 FOREACH person IN ARRAY users LOOP
   IF EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=inv.id AND d.recipient_id=person) THEN CONTINUE; END IF;
   -- One private accounting conversation per issuer, sender, scope and recipient.
   PERFORM pg_advisory_xact_lock(hashtextextended('accounting_conversation:'||scope_id::text||':'||issuer_id::text||':'||sender::text||':'||person::text,0));
   SELECT conversation_id INTO conv FROM public.accounting_conversations c
    WHERE c.scope_id=scope_id AND c.issuer_type=issuer_kind AND c.issuer_id=issuer_id AND c.sender_id=sender AND c.recipient_id=person;
   IF conv IS NULL THEN
     INSERT INTO public.social_conversations(is_group,group_name,context_entity_id,context_entity_type)
      VALUES(true,COALESCE(issuer_name,'Account')||' Accounting',page_id,CASE WHEN page_id IS NULL THEN NULL ELSE 'club' END) RETURNING id INTO conv;
     INSERT INTO public.social_conversation_participants(conversation_id,user_id,context_entity_id,context_entity_type)
      SELECT conv,x,page_id,CASE WHEN page_id IS NULL THEN NULL ELSE 'club' END FROM (SELECT DISTINCT unnest(ARRAY[sender,person]) AS x) members;
     INSERT INTO public.accounting_conversations(scope_id,issuer_type,issuer_id,sender_id,recipient_id,conversation_id)
      VALUES(scope_id,issuer_kind,issuer_id,sender,person,conv);
   END IF;
   -- Refuse a conversation whose audience changed instead of leaking invoices.
   IF EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id<>ALL(ARRAY[sender,person]))
      OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id=person)
      OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id=sender)
   THEN RAISE EXCEPTION 'accounting_conversation_audience_changed' USING ERRCODE='23514'; END IF;
   IF inv.invoice_type IN('cashier_cashout','accounting_correction','credit_limit_change') THEN meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);END IF;
   INSERT INTO public.social_messages(conversation_id,sender_id,content,message_type,media_metadata)
    VALUES(conv,sender,body,'invoice',meta) RETURNING id INTO msg;
   UPDATE public.social_conversations SET last_message_at=now(),last_message_preview=left(body,100),updated_at=now() WHERE id=conv;
   meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);
   INSERT INTO public.notifications(user_id,type,title,message,data,read,action_url,metadata)
    VALUES(person,'accounting_invoice',CASE WHEN inv.invoice_type='credit_limit_change' THEN 'Credit Line Updated · ' WHEN inv.invoice_type='accounting_correction' THEN 'Correction Recorded · ' WHEN inv.invoice_type='cashier_cashout' THEN CASE cashier.event_kind WHEN 'hold' THEN 'Chips Held · ' WHEN 'approval' THEN 'Cashout Approved · ' ELSE 'Chips Returned · ' END WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number,
     CASE WHEN inv.invoice_type='credit_limit_change' THEN 'Credit capacity reduced: '||to_char(inv.net_amount,'FM999,999,999,999,990.00')||'. No payment due.'
      ELSE CASE WHEN inv.invoice_type='accounting_correction' THEN 'Correction Recorded: ' WHEN inv.invoice_type='cashier_cashout' THEN CASE cashier.event_kind WHEN 'hold' THEN 'Chips Held: ' WHEN 'approval' THEN 'Cashout Approved: ' ELSE 'Chips Returned: ' END WHEN inv.chips_transferred AND inv.breakdown->>'category'='rakeback' THEN 'Rakeback Transfer Recorded: ' WHEN inv.chips_transferred AND inv.breakdown->>'category'='commission' THEN 'Commission Transfer Recorded: ' WHEN inv.chips_transferred THEN 'Transfer Recorded: ' ELSE 'Invoice Issued: ' END||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips' END,
     meta,false,'/hub/messenger?conversation='||conv::text,meta) RETURNING id INTO note;
   INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id) VALUES(inv.id,person,msg,note);
   count_sent:=count_sent+1;
 END LOOP;
 SELECT count(*) INTO n FROM public.accounting_invoice_deliveries WHERE invoice_id=inv.id;
 UPDATE public.settlement_invoices SET message_sent=true,message_sent_at=COALESCE(message_sent_at,now()) WHERE id=inv.id;
 RETURN jsonb_build_object('success',true,'invoice_id',inv.id,'delivered',n,'new_deliveries',count_sent);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_accounting_document_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE issued boolean;
BEGIN
 IF TG_TABLE_NAME='settlement_invoices' THEN
   IF OLD.invoice_type='credit_limit_change' AND (TG_OP='DELETE' OR
      (to_jsonb(NEW)-ARRAY['message_sent','message_sent_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['message_sent','message_sent_at']))
   THEN RAISE EXCEPTION 'credit_change_document_is_immutable' USING ERRCODE='23514';END IF;
   IF OLD.invoice_type='accounting_correction' AND (TG_OP='DELETE' OR
      ROW(NEW.status,NEW.chips_transferred,NEW.transferred_at,NEW.due_at,NEW.chip_transfer_id,NEW.adjusts_invoice_id,
          NEW.source_credit_invoice_id,NEW.source_credit_payment_id,NEW.overdue_at,NEW.reminders_sent,NEW.last_reminder_at)
      IS DISTINCT FROM ROW(OLD.status,OLD.chips_transferred,OLD.transferred_at,OLD.due_at,OLD.chip_transfer_id,OLD.adjusts_invoice_id,
          OLD.source_credit_invoice_id,OLD.source_credit_payment_id,OLD.overdue_at,OLD.reminders_sent,OLD.last_reminder_at))
   THEN RAISE EXCEPTION 'correction_document_payment_claim_is_immutable' USING ERRCODE='23514';END IF;
   IF OLD.invoice_type='cashier_cashout' AND (TG_OP='DELETE' OR
      ROW(NEW.status,NEW.chips_transferred,NEW.transferred_at) IS DISTINCT FROM
      ROW(OLD.status,OLD.chips_transferred,OLD.transferred_at))
   THEN RAISE EXCEPTION 'cashier_document_phase_is_immutable' USING ERRCODE='23514';END IF;
   issued:=COALESCE(OLD.message_sent,false) OR EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id=OLD.id);
   IF issued AND (TG_OP='DELETE' OR
     ROW(NEW.club_id,NEW.period_id,NEW.invoice_type,NEW.invoice_number,NEW.from_entity_type,NEW.from_entity_id,
         NEW.to_entity_type,NEW.to_entity_id,NEW.gross_amount,NEW.net_amount,NEW.deductions,NEW.breakdown,
         NEW.due_at,NEW.notes,NEW.source_ledger_id,NEW.source_credit_invoice_id,NEW.source_credit_payment_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.club_id,OLD.period_id,OLD.invoice_type,OLD.invoice_number,OLD.from_entity_type,OLD.from_entity_id,
         OLD.to_entity_type,OLD.to_entity_id,OLD.gross_amount,OLD.net_amount,OLD.deductions,OLD.breakdown,
         OLD.due_at,OLD.notes,OLD.source_ledger_id,OLD.source_credit_invoice_id,OLD.source_credit_payment_id,OLD.created_at)
     OR NEW.message_sent IS DISTINCT FROM true)
   THEN RAISE EXCEPTION 'issued_accounting_invoice_is_immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='social_messages' THEN
   issued:=EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE message_id=OLD.id);
   IF issued AND (TG_OP='DELETE' OR
      (to_jsonb(NEW)-ARRAY['read_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['read_at','updated_at']))
   THEN RAISE EXCEPTION 'issued_accounting_message_is_immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_mirror_notification_to_push_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

DO $credit_delivery_postconditions$ DECLARE expected jsonb;target oid;who text;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($pins$[{"signature":"public.fn_deliver_accounting_invoice(uuid)","md5":"ebf53a7a5ed7a0464899b124a83454f8","returns":"jsonb","argument_names":["p_invoice_id"]},{"signature":"public.fn_accounting_document_immutable()","md5":"fc0c5dacdef0018bb77a8f10330f694b","returns":"trigger","argument_names":null},{"signature":"public.fn_mirror_notification_to_push_outbox()","md5":"ff981e4bc83ac67d2614c387f9253d3e","returns":"trigger","argument_names":null}]$pins$::jsonb) LOOP
  target:=to_regprocedure(expected->>'signature');
  IF target IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole
    AND prosecdef AND proconfig=ARRAY['search_path=public']::text[] AND md5(prosrc)=expected->>'md5'
    AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND prokind='f' AND provolatile='v'
    AND NOT proisstrict AND NOT proleakproof AND proparallel='u' AND NOT proretset AND pronargdefaults=0
    AND prorettype=(expected->>'returns')::regtype
    AND COALESCE(to_jsonb(proargnames),'null'::jsonb)=expected->'argument_names')
   OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=target)
       IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]
  THEN RAISE EXCEPTION 'credit_change_delivery_postcondition_changed' USING DETAIL=expected->>'signature';END IF;
  FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(who,target,'EXECUTE') IS DISTINCT FROM (who='service_role')
   THEN RAISE EXCEPTION 'credit_change_delivery_effective_access_changed' USING DETAIL=who||':'||(expected->>'signature');END IF;
  END LOOP;
 END LOOP;
END $credit_delivery_postconditions$;

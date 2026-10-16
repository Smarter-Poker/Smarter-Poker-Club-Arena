-- Cashout messages keep reaching people (owner rule, 2026-10-15).
-- A player's cashout request messages their agent; an approval messages the player.
-- Every other invoice stays out of the messenger and in transaction history only.
-- fn_deliver_accounting_invoice is restored from its last full installed body
-- (credit-reduction-v1 successor + 20261006001657 + 20261006044028 + 20261009023044
-- + 20261015102509, fingerprint-verified) with a gate that returns early for every
-- invoice type except cashier_cashout.
DO $pre$ BEGIN
 IF md5(pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure)) <> '0165745c555382efa77f3237644ce898'
 THEN RAISE EXCEPTION 'fn_deliver_accounting_invoice changed since it was read'; END IF;
 IF md5(pg_get_functiondef('public.fn_get_user_conversations(uuid,uuid)'::regprocedure)) <> 'a27627b0a914b22822227f9e30422bfc'
 THEN RAISE EXCEPTION 'fn_get_user_conversations changed since it was read'; END IF;
END $pre$;

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
 -- Owner rule (2026-10-15): only cashout documents reach the messenger (the player's request
 -- reaches their agent, the approval reaches the player). Every other invoice is recorded in
 -- transaction history only and marked delivered so the weekly close is satisfied.
 IF inv.invoice_type IS DISTINCT FROM 'cashier_cashout' THEN
  IF inv.invoice_number IS NULL THEN
   UPDATE public.settlement_invoices SET invoice_number=public.fn_accounting_next_invoice_number() WHERE id=inv.id RETURNING invoice_number INTO inv.invoice_number;
  END IF;
  UPDATE public.settlement_invoices SET message_sent=true,message_sent_at=COALESCE(message_sent_at,now()) WHERE id=inv.id;
  RETURN jsonb_build_object('success',true,'invoice_id',inv.id,'delivered',0,'new_deliveries',0);
 END IF;
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
 SELECT array_agg(user_id ORDER BY user_id) INTO issuer_users FROM public.fn_accounting_invoice_party_users(inv.from_entity_type,issuer_id);
 SELECT array_agg(user_id ORDER BY user_id) INTO recipient_users FROM public.fn_accounting_invoice_party_users(inv.to_entity_type,recipient_id);
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
   'to_entity_type',inv.to_entity_type,'to_entity_id',inv.to_entity_id,'lines',inv.breakdown-ARRAY['source_ledger_ids','private_bank_ledger_ids']);
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
   meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);
   INSERT INTO public.social_messages(conversation_id,sender_id,content,message_type,media_metadata)
    VALUES(conv,sender,body,'invoice',meta) RETURNING id INTO msg;
   UPDATE public.social_conversations SET last_message_at=now(),last_message_preview=left(body,100),updated_at=now() WHERE id=conv;
   meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);
   INSERT INTO public.notifications(user_id,type,title,message,data,read,action_url,metadata)
    VALUES(person,CASE WHEN inv.chips_transferred AND inv.invoice_type NOT IN('credit_limit_change','accounting_correction','cashier_cashout') THEN 'accounting_invoice_detail' ELSE 'accounting_invoice' END,CASE WHEN inv.invoice_type='credit_limit_change' THEN 'Credit Line Updated · ' WHEN inv.invoice_type='accounting_correction' THEN 'Correction Recorded · ' WHEN inv.invoice_type='cashier_cashout' THEN CASE cashier.event_kind WHEN 'hold' THEN 'Chips Held · ' WHEN 'approval' THEN 'Cashout Approved · ' ELSE 'Chips Returned · ' END WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number,
     CASE WHEN inv.invoice_type='credit_limit_change' THEN 'Credit capacity reduced: '||to_char(inv.net_amount,'FM999,999,999,999,990.00')||'. No payment due.'
      ELSE CASE WHEN inv.invoice_type='accounting_correction' THEN 'Correction Recorded: ' WHEN inv.invoice_type='cashier_cashout' THEN CASE cashier.event_kind WHEN 'hold' THEN 'Chips Held: ' WHEN 'approval' THEN 'Cashout Approved: ' ELSE 'Chips Returned: ' END WHEN inv.chips_transferred AND inv.breakdown->>'category'='rakeback' THEN 'Rakeback Transfer Recorded: ' WHEN inv.chips_transferred AND inv.breakdown->>'category'='commission' THEN 'Commission Transfer Recorded: ' WHEN inv.chips_transferred THEN 'Transfer Recorded: ' ELSE 'Invoice Issued: ' END||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips' END,
     meta,(inv.chips_transferred AND inv.invoice_type NOT IN('credit_limit_change','accounting_correction','cashier_cashout')),'/hub/messenger?conversation='||conv::text,meta) RETURNING id INTO note;
   INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id) VALUES(inv.id,person,msg,note);
   count_sent:=count_sent+1;
 END LOOP;
 SELECT count(*) INTO n FROM public.accounting_invoice_deliveries WHERE invoice_id=inv.id;
 UPDATE public.settlement_invoices SET message_sent=true,message_sent_at=COALESCE(message_sent_at,now()) WHERE id=inv.id;
 RETURN jsonb_build_object('success',true,'invoice_id',inv.id,'delivered',n,'new_deliveries',count_sent);
END $function$;

DO $conv$ DECLARE v_def text := pg_get_functiondef('public.fn_get_user_conversations(uuid,uuid)'::regprocedure);
BEGIN
 IF (length(v_def)-length(replace(v_def,$o$          AND NOT EXISTS (
            SELECT 1 FROM public.accounting_invoice_deliveries d
            WHERE d.message_id = m.id
          )$o$,'')))<>length($o$          AND NOT EXISTS (
            SELECT 1 FROM public.accounting_invoice_deliveries d
            WHERE d.message_id = m.id
          )$o$)
 THEN RAISE EXCEPTION 'conversation filter anchor not found exactly once'; END IF;
 EXECUTE replace(v_def,$o$          AND NOT EXISTS (
            SELECT 1 FROM public.accounting_invoice_deliveries d
            WHERE d.message_id = m.id
          )$o$,$n$          AND NOT EXISTS (
            SELECT 1 FROM public.accounting_invoice_deliveries d
            JOIN public.settlement_invoices si ON si.id = d.invoice_id
            WHERE d.message_id = m.id
              AND si.invoice_type IS DISTINCT FROM 'cashier_cashout'
          )$n$);
END $conv$;

DO $post$ BEGIN
 IF md5(pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure)) <> '8419aac1cd0ed1e30ac68621fb95823d'
 THEN RAISE EXCEPTION 'delivery post-image mismatch'; END IF;
 IF position('cashier_cashout' in pg_get_functiondef('public.fn_get_user_conversations(uuid,uuid)'::regprocedure)) = 0
 THEN RAISE EXCEPTION 'conversation filter post-image missing'; END IF;
END $post$;

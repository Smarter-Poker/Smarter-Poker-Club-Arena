BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('fn_deliver_accounting_invoice(uuid)'::regprocedure))<>'ada9f57d9b52453e295657d3ae053d63'
 OR md5(pg_get_functiondef('fn_invoice_accounting_ledger_transfer(uuid)'::regprocedure))<>'5dad1e852f266c349f5675eb791c8286'
 OR md5(pg_get_functiondef('fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure))<>'675c5a1d6c9624569f5317059d5c78c5'
 OR md5(pg_get_functiondef('fn_union_settlement_cascade_due()'::regprocedure))<>'106172c9b37a08992843cbe77e7f9d39'
 THEN RAISE EXCEPTION 'weekly club accounting source changed since review'; END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_club_weekly_accounting_summary','approved','Read-only exact club/period summary of the recorded union close and posted ledger. Club accounting administrators and the owning union only. Separates direct club payments from downstream redistribution; missing period or historical role remains explicit.'),
 ('fn_issue_club_weekly_accounting','approved','One immutable weekly club document per existing settlement period. Only the validated union cascade publishes it. No wallet writes. Delivery uses the existing accounting invoice/message/notification transaction and aborts the whole cascade on failure.'),
 ('fn_messenger_message_page','approved','Read-only participant-authorized message page. Requires verified actor or trusted engine and exact conversation participation. Invoice provenance and current status come from receipt foreign keys; archived club detail messages do not appear as separate bills. No balance writes.');
ALTER TABLE public.settlement_invoices DROP CONSTRAINT settlement_invoices_invoice_type_check;
ALTER TABLE public.settlement_invoices ADD CONSTRAINT settlement_invoices_invoice_type_check CHECK(invoice_type IN
 ('union_to_club','club_to_agent','agent_to_subagent','agent_to_player','union_club_pnl','club_to_union','union_weekly_squareup','union_weekly_credit_note','transaction_receipt','club_weekly_accounting'));
CREATE UNIQUE INDEX accounting_one_club_weekly_statement ON public.settlement_invoices(club_id,period_id) WHERE invoice_type='club_weekly_accounting';
ALTER TABLE public.accounting_invoice_deliveries ADD COLUMN delivery_mode text NOT NULL DEFAULT 'immediate' CHECK(delivery_mode IN('immediate','weekly_detail'));
-- Preserve the issued receipt and immutable message, but remove sender-side
-- individual payout copies from the club inbox and notification feed.
UPDATE public.accounting_invoice_deliveries d SET delivery_mode='weekly_detail'
 FROM public.settlement_invoices i WHERE i.id=d.invoice_id AND i.source_ledger_id IS NOT NULL
   AND i.from_entity_type='club' AND i.to_entity_type IN('agent','player')
   AND i.breakdown->>'category' IN('rakeback','commission') AND d.recipient_id::text<>i.to_entity_id;
UPDATE public.notifications n SET type='accounting_invoice_detail',read=true,is_read=true,read_at=COALESCE(read_at,now())
 FROM public.accounting_invoice_deliveries d WHERE d.notification_id=n.id AND d.delivery_mode='weekly_detail';
ALTER TABLE public.accounting_conversations ADD COLUMN last_discussion_at timestamptz;
CREATE FUNCTION public.fn_accounting_discussion_observed() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 UPDATE public.accounting_conversations SET last_discussion_at=GREATEST(last_discussion_at,NEW.created_at) WHERE conversation_id=NEW.conversation_id;
 RETURN NEW;
END $function$;
CREATE TRIGGER accounting_discussion_observed AFTER INSERT ON public.social_messages FOR EACH ROW
 WHEN (COALESCE(NEW.message_type,'text') NOT IN('invoice','system')) EXECUTE FUNCTION public.fn_accounting_discussion_observed();
REVOKE ALL ON FUNCTION public.fn_accounting_discussion_observed() FROM PUBLIC,anon,authenticated;
UPDATE public.accounting_conversations ac SET last_discussion_at=d.at FROM
 (SELECT m.conversation_id,max(m.created_at) AS at FROM public.social_messages m JOIN public.accounting_conversations c ON c.conversation_id=m.conversation_id
  WHERE COALESCE(m.message_type,'text') NOT IN('invoice','system') AND COALESCE(m.is_deleted,false)=false GROUP BY m.conversation_id) d
 WHERE ac.conversation_id=d.conversation_id;

CREATE OR REPLACE FUNCTION public.fn_deliver_accounting_invoice(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_variable
DECLARE inv public.settlement_invoices%ROWTYPE; sender uuid; issuer_name text; recipient_name text;
 issuer_kind text; issuer_id uuid; recipient_id uuid; scope_id uuid; page_id uuid; users uuid[]; issuer_users uuid[]; recipient_users uuid[];
 person uuid; conv uuid; msg uuid; note uuid; body text; meta jsonb; count_sent int:=0; n int; line record;
BEGIN
 SELECT * INTO inv FROM public.settlement_invoices WHERE id=p_invoice_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_invoice_missing' USING ERRCODE='23514'; END IF;
 IF inv.net_amount IS NULL OR inv.net_amount::text IN('NaN','Infinity','-Infinity') OR inv.net_amount<>round(inv.net_amount,2)
 THEN RAISE EXCEPTION 'invalid_invoice_amount' USING ERRCODE='23514'; END IF;
 issuer_kind:=inv.from_entity_type; issuer_id:=inv.from_entity_id::uuid; recipient_id:=inv.to_entity_id::uuid;
 scope_id:=COALESCE(inv.club_id,issuer_id);
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
   WHERE key IN('rake_generated','rakeback_due','union_fee_kept','players_won','settled_in_chips','eco_amount','presettled','rake_earned','rake_received','paid_super_agents','paid_agents','paid_sub_agents','paid_players','total_paid_by_club','retained_by_club','downstream_redistributed') ORDER BY key
 LOOP
   IF line.value IS NOT NULL THEN body:=body||E'\n'||initcap(replace(line.key,'_',' '))||': '||to_char(line.value::numeric,'FM999,999,999,999,990.00'); END IF;
 END LOOP;
 meta:=jsonb_build_object('kind','accounting_invoice' ,'invoice_id',inv.id,'invoice_number',inv.invoice_number,
   'club_id',inv.club_id,'source_ledger_id',inv.source_ledger_id,'source_credit_invoice_id',inv.source_credit_invoice_id,
   'source_credit_payment_id',inv.source_credit_payment_id,'amount',inv.net_amount,'currency','CHIPS','conversationId',NULL,'status',inv.status,
   'invoice_type',inv.invoice_type,'from_entity_type',inv.from_entity_type,'from_entity_id',inv.from_entity_id,
   'to_entity_type',inv.to_entity_type,'to_entity_id',inv.to_entity_id,'lines',inv.breakdown-'source_ledger_ids');
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
   INSERT INTO public.social_messages(conversation_id,sender_id,content,message_type,media_metadata)
    VALUES(conv,sender,body,'invoice',meta) RETURNING id INTO msg;
   UPDATE public.social_conversations SET last_message_at=now(),last_message_preview=left(body,100),updated_at=now() WHERE id=conv;
   meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);
   INSERT INTO public.notifications(user_id,type,title,message,data,read,action_url,metadata)
    VALUES(person,'accounting_invoice',CASE WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number,
     CASE WHEN inv.chips_transferred AND inv.breakdown->>'category'='rakeback' THEN 'Rakeback Transfer Recorded: ' WHEN inv.chips_transferred AND inv.breakdown->>'category'='commission' THEN 'Commission Transfer Recorded: ' WHEN inv.chips_transferred THEN 'Transfer Recorded: ' ELSE 'Invoice Issued: ' END||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips',
     meta,false,'/hub/messenger?conversation='||conv::text,meta) RETURNING id INTO note;
   INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id) VALUES(inv.id,person,msg,note);
   count_sent:=count_sent+1;
 END LOOP;
 SELECT count(*) INTO n FROM public.accounting_invoice_deliveries WHERE invoice_id=inv.id;
 UPDATE public.settlement_invoices SET message_sent=true,message_sent_at=COALESCE(message_sent_at,now()) WHERE id=inv.id;
 RETURN jsonb_build_object('success',true,'invoice_id',inv.id,'delivered',n,'new_deliveries',count_sent);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_invoice_accounting_ledger_transfer(p_ledger_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE leg public.chip_ledger%ROWTYPE; inv_id uuid; issuer_kind text; issuer_id uuid; payee_kind text; payee_id uuid; kind text;
BEGIN
 SELECT * INTO leg FROM public.chip_ledger WHERE id=p_ledger_id;
 IF NOT FOUND OR leg.status IS DISTINCT FROM 'posted' OR leg.amount IS NULL OR leg.amount<=0
    OR leg.amount::text IN('NaN','Infinity','-Infinity') OR leg.amount<>round(leg.amount,2)
 THEN RAISE EXCEPTION 'invalid_accounting_transfer' USING ERRCODE='23514'; END IF;
 IF leg.from_type IN('union_wallet','union_bank') THEN issuer_kind:='union';issuer_id:=leg.from_entity_id;
 ELSIF leg.from_type='club_treasury' THEN issuer_kind:='club';issuer_id:=leg.from_entity_id;
 ELSIF leg.from_type IN('player_wallet','agent_wallet') THEN issuer_id:=leg.from_entity_id;
   issuer_kind:=CASE WHEN leg.from_type='agent_wallet' OR EXISTS(SELECT 1 FROM public.agents a WHERE a.user_id=issuer_id AND a.club_id=leg.club_id) THEN 'agent' ELSE 'player' END;
 ELSIF leg.from_type='settlement_suspense' AND leg.category='rakeback' AND leg.club_id IS NOT NULL THEN
   -- Club-issued receipt for the existing clearing-account leg; preserve its actual source in breakdown.
   issuer_kind:='club';issuer_id:=leg.club_id;
 ELSE RAISE EXCEPTION 'unsupported_accounting_transfer_source' USING ERRCODE='23514'; END IF;
 -- Game payout journals retain the physical union_wallets.id store identity.
 -- Accounting parties use unions.id. Resolve only a matching, declared host;
 -- never rewrite the original journal or infer a different union.
 IF leg.category IN('wheel_prize','plinko_prize','crash_prize','crossing_prize','mines_prize')
    AND issuer_kind='union' AND leg.union_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.union_wallets w WHERE w.id=issuer_id AND w.union_id=leg.union_id)
 THEN issuer_id:=leg.union_id; END IF;
 IF leg.to_type IN('union_wallet','union_bank') THEN payee_kind:='union';payee_id:=leg.to_entity_id;
 ELSIF leg.to_type='club_treasury' THEN payee_kind:='club';payee_id:=leg.to_entity_id;
 ELSIF leg.to_type IN('player_wallet','agent_wallet') THEN
   payee_id:=leg.to_entity_id;
   payee_kind:=CASE WHEN leg.category='commission' OR EXISTS(SELECT 1 FROM public.agents a WHERE a.user_id=payee_id AND a.club_id=leg.club_id) THEN 'agent' ELSE 'player' END;
 ELSE RAISE EXCEPTION 'unsupported_accounting_transfer_recipient' USING ERRCODE='23514'; END IF;
 kind:=CASE WHEN issuer_kind='union' AND payee_kind='club' THEN 'union_to_club'
            WHEN issuer_kind='club' AND payee_kind='agent' THEN 'club_to_agent'
            WHEN issuer_kind='agent' AND payee_kind='agent' THEN 'agent_to_subagent'
            WHEN issuer_kind='agent' AND payee_kind='player' THEN 'agent_to_player' ELSE 'transaction_receipt' END;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_ledger_invoice:'||leg.id::text,0));
 SELECT id INTO inv_id FROM public.settlement_invoices WHERE source_ledger_id=leg.id;
 IF inv_id IS NULL THEN
   INSERT INTO public.settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    gross_amount,net_amount,deductions,breakdown,status,chips_transferred,transferred_at,notes,source_ledger_id)
   VALUES(COALESCE(leg.club_id,leg.union_id),kind,issuer_kind,issuer_id::text,payee_kind,payee_id::text,leg.amount,leg.amount,0,
    COALESCE(leg.metadata,'{}'::jsonb)||jsonb_build_object('ledger_id',leg.id,'category',leg.category,'ledger_from_type',leg.from_type,
      'ledger_from_entity_id',leg.from_entity_id,'ledger_to_type',leg.to_type,'ledger_to_entity_id',leg.to_entity_id,
      'payee_role_at_transfer',CASE WHEN payee_kind='player' THEN 'player' ELSE (SELECT a.role FROM public.agents a WHERE a.user_id=payee_id AND a.club_id=leg.club_id ORDER BY a.id LIMIT 1) END),
    'paid',true,leg.created_at,'Receipt For A Posted Accounting Transfer. This Does Not Certify The Entire Weekly Close.',leg.id)
   RETURNING id INTO inv_id;
 END IF;
 PERFORM public.fn_deliver_accounting_invoice(inv_id);
 RETURN inv_id;
END $function$
;
CREATE FUNCTION public.fn_club_weekly_accounting_summary(p_period_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE period public.settlement_periods%ROWTYPE; close_row public.ca_settlements%ROWTYPE;
 received numeric; outgoing numeric; downstream numeric; by_role jsonb; unknown_roles int; rows_count int;
 ledger_ids jsonb; run_status text; basis numeric; missing_periods int;
BEGIN
 SELECT * INTO period FROM public.settlement_periods WHERE id=p_period_id;
 IF NOT FOUND OR period.club_id IS NULL OR period.union_id IS NULL THEN
   RAISE EXCEPTION 'club_accounting_period_missing' USING ERRCODE='22023'; END IF;
 IF NOT public.fn_caller_is_engine() AND NOT EXISTS(
   SELECT 1 FROM public.fn_accounting_party_users('club',period.club_id) u WHERE u.user_id=auth.uid())
   AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(period.union_id,auth.uid())) THEN
   RAISE EXCEPTION 'club_accounting_not_authorised' USING ERRCODE='42501'; END IF;
 SELECT * INTO close_row FROM public.ca_settlements s
 WHERE s.union_id=period.union_id AND s.settlement_type='union_rakeback_close' AND s.state='final'
   AND s.external_ref=period.union_id::text||':'||to_char(period.start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ||'..'||to_char(period.end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
 basis:=(close_row.totals->'basis_by_club'->>period.club_id::text)::numeric;
 SELECT status INTO run_status FROM public.union_accounting_runs WHERE union_id=period.union_id
   AND period_start=period.start_at AND period_end=period.end_at;

 WITH transfers AS (
   SELECT l.*,i.to_entity_type,i.breakdown->>'payee_role_at_transfer' AS payee_role
   FROM public.chip_ledger l LEFT JOIN public.settlement_invoices i ON i.source_ledger_id=l.id
   WHERE l.club_id=period.club_id AND l.status='posted' AND l.category IN('rakeback','commission')
     AND (l.settlement_id=close_row.id OR
       ((l.metadata->>'period_start')::timestamptz=period.start_at AND (l.metadata->>'period_end')::timestamptz=period.end_at))
 ), club_out AS (
   SELECT *,CASE WHEN to_entity_type='player' THEN 'player'
       WHEN payee_role IN('super_agent','agent','sub_agent') THEN payee_role ELSE 'unclassified' END AS tier
   FROM transfers WHERE from_type='club_treasury' AND from_entity_id=period.club_id
     AND to_type IN('player_wallet','agent_wallet')
 ), grouped AS (SELECT tier,sum(amount) AS paid FROM club_out GROUP BY tier)
 SELECT (SELECT COALESCE(sum(amount),0) FROM transfers WHERE from_type IN('union_wallet','union_bank')
            AND from_entity_id=period.union_id AND to_type='club_treasury' AND to_entity_id=period.club_id),
        (SELECT COALESCE(sum(amount),0) FROM club_out),
        (SELECT COALESCE(sum(amount),0) FROM transfers WHERE from_type IN('player_wallet','agent_wallet') AND to_type IN('player_wallet','agent_wallet')),
        (SELECT COALESCE(jsonb_object_agg(tier,paid),'{}') FROM grouped),
        (SELECT count(*) FROM club_out WHERE tier='unclassified'),
        (SELECT count(*) FROM transfers),
        (SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]') FROM transfers)
 INTO received,outgoing,downstream,by_role,unknown_roles,rows_count,ledger_ids;

 -- A timestamp alone cannot assign an earning week to an old payout.
 -- Keep the uncertainty visible instead of making the money disappear.
 SELECT count(*) INTO missing_periods FROM public.chip_ledger l
 WHERE l.club_id=period.club_id AND l.status='posted' AND l.category IN('rakeback','commission')
   AND l.from_type IN('club_treasury','player_wallet','agent_wallet')
   AND l.to_type IN('player_wallet','agent_wallet')
   AND l.created_at>=period.start_at AND l.created_at<period.end_at+interval '1 day'
   AND l.metadata->>'period_start' IS NULL AND l.settlement_id IS DISTINCT FROM close_row.id;
 RETURN jsonb_build_object('period_id',period.id,'club_id',period.club_id,'union_id',period.union_id,
   'period_start',period.start_at,'period_end',period.end_at,'currency','CHIPS',
   'rake_earned',basis,'rake_received',received,'expected_union_receipt',close_row.totals->'payout_by_club'->period.club_id::text,
   'paid_super_agents',COALESCE((by_role->>'super_agent')::numeric,0),
   'paid_agents',COALESCE((by_role->>'agent')::numeric,0),'paid_sub_agents',COALESCE((by_role->>'sub_agent')::numeric,0),
   'paid_players',COALESCE((by_role->>'player')::numeric,0),'paid_unclassified',COALESCE((by_role->>'unclassified')::numeric,0),
   'total_paid_by_club',outgoing,'retained_by_club',received-outgoing,'downstream_redistributed',downstream,
   'transfer_count',rows_count,'source_ledger_ids',ledger_ids,'unclassified_role_count',unknown_roles,'missing_period_count',missing_periods,
   'status',CASE WHEN run_status='complete' AND unknown_roles=0 AND missing_periods=0 AND basis IS NOT NULL THEN 'complete' ELSE 'needs_reconciliation' END,
   'run_status',run_status,'basis_source','Recorded Union Close',
   'note','Club Payments Are Counted Once. Downstream Redistribution Is Separate. Figures Show Posted Transfers, Not Unpaid Entitlements.');
END $function$;

CREATE FUNCTION public.fn_issue_club_weekly_accounting(p_union_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE period record; report jsonb; invoice uuid; issued int:=0; expected numeric;
BEGIN
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(p_union_id,auth.uid())) THEN
   RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 IF current_setting('app.union_accounting_validated_period',true) IS DISTINCT FROM p_union_id::text||':'||p_from::text||':'||p_to::text THEN
   RAISE EXCEPTION 'weekly_statement_requires_validated_cascade' USING ERRCODE='23514'; END IF;
 FOR period IN SELECT sp.id,sp.club_id FROM public.settlement_periods sp JOIN public.union_clubs uc ON uc.club_id=sp.club_id AND uc.union_id=sp.union_id
   WHERE sp.union_id=p_union_id AND sp.start_at=p_from AND sp.end_at=p_to ORDER BY sp.club_id
 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('club_weekly_invoice:'||period.id::text,0));
   SELECT id INTO invoice FROM public.settlement_invoices WHERE period_id=period.id AND club_id=period.club_id AND invoice_type='club_weekly_accounting';
   IF invoice IS NOT NULL THEN PERFORM public.fn_deliver_accounting_invoice(invoice); CONTINUE; END IF;
   report:=public.fn_club_weekly_accounting_summary(period.id);
   expected:=(report->>'expected_union_receipt')::numeric;
   IF report->>'rake_earned' IS NULL OR expected IS NULL OR expected IS DISTINCT FROM (report->>'rake_received')::numeric
      OR (report->>'unclassified_role_count')::int<>0 OR (report->>'missing_period_count')::int<>0 THEN
     RAISE EXCEPTION 'club_weekly_statement_requires_reconciliation' USING ERRCODE='23514',DETAIL=report::text; END IF;
   report:=report||jsonb_build_object('status','complete');
   INSERT INTO public.settlement_invoices(club_id,period_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
      gross_amount,net_amount,deductions,breakdown,status,notes)
   VALUES(period.club_id,period.id,'club_weekly_accounting','club',period.club_id::text,'club',period.club_id::text,
      (report->>'rake_received')::numeric,(report->>'retained_by_club')::numeric,(report->>'total_paid_by_club')::numeric,
      report,'generated','Consolidated Weekly Club Accounting. The Net Movement Is Not An Additional Bill Or Transfer.') RETURNING id INTO invoice;
   issued:=issued+1;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.union_id=p_union_id AND uc.club_id<>p_union_id
   AND NOT EXISTS(SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
     WHERE i.club_id=uc.club_id AND i.invoice_type='club_weekly_accounting' AND sp.start_at=p_from AND sp.end_at=p_to AND i.message_sent)) THEN
   RAISE EXCEPTION 'club_weekly_statement_delivery_incomplete' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('success',true,'issued',issued);
END $function$;

REVOKE ALL ON FUNCTION public.fn_club_weekly_accounting_summary(uuid),public.fn_issue_club_weekly_accounting(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_weekly_accounting_summary(uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_issue_club_weekly_accounting(uuid,timestamptz,timestamptz) TO service_role;

CREATE FUNCTION public.fn_messenger_message_page(p_user_id uuid,p_conversation_id uuid,p_before timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid,conversation_id uuid,sender_id uuid,content text,message_type text,media_metadata jsonb,
 created_at timestamptz,updated_at timestamptz,is_deleted boolean,is_edited boolean,profiles jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>200 OR (p_before_id IS NOT NULL AND p_before IS NULL) THEN
   RAISE EXCEPTION 'invalid_message_page' USING ERRCODE='22023'; END IF;
 IF (NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR auth.uid()<>p_user_id))
 OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p WHERE p.user_id=p_user_id AND p.conversation_id=p_conversation_id) THEN
   RAISE EXCEPTION 'message_page_not_authorised' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT m.id,m.conversation_id,m.sender_id,m.content,
   CASE WHEN m.message_type='invoice' AND i.id IS NULL THEN 'text' ELSE m.message_type END,
   COALESCE(m.media_metadata,'{}')||CASE WHEN i.id IS NULL THEN jsonb_build_object('accounting_verified',false)
     ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
       'status',i.status,'chips_transferred',i.chips_transferred) END,
   m.created_at,m.updated_at,m.is_deleted,m.is_edited,
   jsonb_build_object('id',pr.id,'username',pr.username,'avatar_url',pr.avatar_url,'is_vip',pr.is_vip)
 FROM public.social_messages m
 LEFT JOIN public.accounting_invoice_deliveries d ON d.message_id=m.id
 LEFT JOIN public.settlement_invoices i ON i.id=d.invoice_id
 LEFT JOIN public.profiles pr ON pr.id=m.sender_id
 WHERE m.conversation_id=p_conversation_id AND COALESCE(m.is_deleted,false)=false
   AND COALESCE(d.delivery_mode,'immediate')<>'weekly_detail'
   AND (p_before IS NULL OR m.created_at<p_before OR (p_before_id IS NOT NULL AND m.created_at=p_before AND m.id<p_before_id))
 ORDER BY m.created_at DESC,m.id DESC LIMIT p_limit;
END $function$;
REVOKE ALL ON FUNCTION public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb; v_eco jsonb; v_inv jsonb;
  v_floor timestamptz;
  v_club_statements jsonb; v_previous_validated text;
  v_sqlstate text; v_msg text; v_detail text; v_context text;

BEGIN
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_union_overseer(p_union_id, auth.uid()))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- THE FLOOR, checked before anything moves. Round 1 has always honoured it;
  -- nothing above round 1 did, so three further rounds ran on a floored week.
  SELECT f.earliest_period_start INTO v_floor
    FROM union_settlement_floor f WHERE f.union_id = p_union_id;

  IF v_floor IS NOT NULL AND v_from < v_floor THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'before_settlement_floor',
      'period_start', v_from, 'period_end', v_to,
      'settlement_floor', v_floor,
      'note', 'This period is below the union settlement floor and must not be '
              || 'settled. No round was run.'))::text;
  END IF;

  /* WARM THE CACHE BEFORE THE FIRST LOCK (2026-09-09). union_rake_rollup_days
     is a speed cache: a day that is missing is recomputed live and correct,
     but it is recomputed INSIDE the settlement, while it holds treasury rows -
     which is where this union has been deadlocking. Doing it here costs the
     same work at a moment when nothing is locked. A failure is not fatal:
     the live path still answers, just more slowly. */
  BEGIN
    PERFORM public.fn_union_rake_rollup_refresh_day(p_union_id, g.d::date)
       FROM generate_series(v_from::date, (v_to - interval '1 day')::date, interval '1 day') g(d)
      WHERE NOT EXISTS (SELECT 1 FROM public.union_rake_rollup_days rd
                         WHERE rd.union_id = p_union_id AND rd.day = g.d::date)
        AND g.d::date < (now() AT TIME ZONE 'UTC')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'settlement could not warm the rake rollup (%); the live path will answer instead', SQLERRM;
  END;

  -- Serialize every entry point for this union/period. A replay must read
  -- the receipts after the competing transaction commits, before moving chips.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'union-accounting:' || p_union_id::text || ':' || extract(epoch FROM v_from)::text || ':' || extract(epoch FROM v_to)::text, 0));

  -- A union-owned table is not a player's earning club. These outstanding
  -- records are invisible to the member-club join in Round 3. Never certify
  -- completion while they exist, and never guess a replacement beneficiary.
  IF EXISTS (SELECT 1 FROM public.rakeback_periods rp
       WHERE rp.club_id = p_union_id AND rp.status = 'pending'
         AND rp.rakeback_amount > 0
         AND (rp.period_start::timestamp AT TIME ZONE 'UTC') < v_to
         AND ((rp.period_end + 1)::timestamp AT TIME ZONE 'UTC') > v_from) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_rakeback_wrong_club',
      DETAIL = 'Pending player rakeback is booked under the union ID. Reconcile the earning-club evidence before settlement.';
  END IF;

  -- ROUND 1 - union rake treasury pays the clubs their 90%.
  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payers, payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 1, 'union_to_clubs', 1,
          COALESCE((v_r1->>'clubs_paid')::int,0),
          COALESCE((v_r1->>'total_rakeback')::numeric,0), v_r1)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF COALESCE((v_r1->>'success')::boolean, false) IS NOT TRUE
     AND COALESCE(v_r1->>'error','') <> 'already_executed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round1_failed: ' || COALESCE(v_r1->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1,
      'note', 'Rounds 2, 3 and 4 were not run. A club is not asked to pay its '
              || 'agents out of a treasury the union has not funded.'))::text;
  END IF;

  -- ROUND 2 - clubs pay their super agents and agents.
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 2, 'club_to_agents',
          COALESCE((v_r2->>'payees')::int,0), COALESCE((v_r2->>'amount')::numeric,0),
          COALESCE((v_r2->>'shortfalls')::int,0), v_r2)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=union_settlement_rounds.detail || jsonb_build_object('latest_attempt',EXCLUDED.detail);

  -- Round 2 carries no 'success' key: it raises on error and returns
  -- {round,name,payees,amount,shortfalls,detail} otherwise, so a test for
  -- 'success' would be unreachable. Assert the CONTRACT instead - a round that
  -- stops reporting an amount must stop the cascade, not record 0 and carry on.
  IF (v_r2->>'amount') IS NULL OR (v_r2->>'payees') IS NULL
     OR (v_r2->>'shortfalls') IS NULL
     OR jsonb_typeof(v_r2->'shortfalls') IS DISTINCT FROM 'number'
     OR (v_r2 ? 'success' AND COALESCE((v_r2->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r2->>'error','') <> 'already_executed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round2_contract_violated_or_failed: ' || COALESCE(v_r2->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'note', 'Rounds 3 and 4 were not run.'))::text;
  END IF;

  -- ROUND 3 - agents pay their players.
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 3, 'agents_to_players',
          COALESCE((v_r3->>'payees')::int,0), COALESCE((v_r3->>'amount')::numeric,0),
          COALESCE((v_r3->>'shortfalls')::int,0), v_r3)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=union_settlement_rounds.detail || jsonb_build_object('latest_attempt',EXCLUDED.detail);

  -- Same contract assertion for round 3.
  IF (v_r3->>'amount') IS NULL OR (v_r3->>'payees') IS NULL
     OR (v_r3->>'shortfalls') IS NULL
     OR jsonb_typeof(v_r3->'shortfalls') IS DISTINCT FROM 'number'
     OR (v_r3 ? 'success' AND COALESCE((v_r3->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r3->>'error','') <> 'already_executed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round3_contract_violated_or_failed: ' || COALESCE(v_r3->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3,
      'note', 'Round 4 was not run; no statement is issued for a settlement '
              || 'that did not complete.'))::text;
  END IF;

  -- A round can post funded recipients while reporting others still unpaid.
  -- Keep that durable progress, but do not mark the period settled or issue
  -- completion statements until every reported shortfall is zero.
  IF (v_r2->>'shortfalls')::numeric <> 0
     OR (v_r3->>'shortfalls')::numeric <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success',false,'union_id',p_union_id,
      'error','recipient_shortfalls_remaining','period_start',v_from,'period_end',v_to,
      'round1_union_to_clubs',v_r1,'round2_club_to_agents',v_r2,
      'round3_agents_to_players',v_r3))::text;
  END IF;

  IF EXISTS (SELECT 1 FROM public.rakeback_periods rp
      JOIN public.union_clubs uc ON uc.club_id=rp.club_id AND uc.union_id=p_union_id
      WHERE rp.status='pending' AND rp.rakeback_amount>0
        AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
        AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_to) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_player_obligations_remaining';
  END IF;

  -- CONSERVATION, asserted before anything else is written. Raises on a
  -- breach, which rolls this union's whole settlement back.
  PERFORM public.fn_union_settlement_conservation_assert(
            p_union_id, v_from, v_to, v_r1, v_r2, v_r3);

  -- The period is an accounting object, not a by-product of invoicing.
  PERFORM public.fn_union_mark_period_settled(p_union_id, v_from, v_to);

  IF public.fn_union_eco_enabled(p_union_id) THEN
    BEGIN
      v_eco := public.fn_union_eco_record(p_union_id, v_from, v_to, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_eco := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  ELSE
    v_eco := jsonb_build_object('skipped', true, 'reason', 'eco_disabled');
  END IF;

  IF v_eco->>'success' = 'false' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_eco_record_failed', DETAIL = v_eco::text;
  END IF;

  IF public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) <> 1 THEN
    v_inv := jsonb_build_object(
      'success', true, 'skipped', true, 'invoices', 0,
      'reason', 'weekly_invoices_disabled: the union setting weekly_invoices_enabled is 0. '
                || 'Since Phase 6 (20260907) the statement reads the same fn_union_club_rake_basis '
                || 'rows round 1 pays on; switching statements back on is a setting, not a fix.');
  ELSE
    BEGIN
      v_inv := public.fn_union_issue_weekly_invoices(p_union_id, v_from, v_to, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_inv := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  END IF;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 4, 'union_invoices_issued',
          COALESCE((v_inv->>'invoices')::int, 0), 0, v_inv)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=EXCLUDED.detail,payees=EXCLUDED.payees;

  IF COALESCE((v_inv->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round4_invoices_failed: ' || COALESCE(v_inv->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
      'round4_invoices', v_inv))::text;
  END IF;

  IF COALESCE((v_inv->>'skipped')::boolean, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_invoices_not_issued', DETAIL = v_inv::text;
  END IF;

  IF EXISTS (SELECT 1 FROM public.union_clubs uc
    WHERE uc.union_id=p_union_id AND uc.club_id<>p_union_id
      AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
        WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
          AND si.breakdown->>'union_id'=p_union_id::text
          AND (si.breakdown->>'period_start')::timestamptz=v_from
          AND (si.breakdown->>'period_end')::timestamptz=v_to
          AND si.message_sent=true AND si.status<>'cancelled')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_invoice_delivery_incomplete';
  END IF;

  v_previous_validated:=current_setting('app.union_accounting_validated_period',true);
  PERFORM set_config('app.union_accounting_validated_period',p_union_id::text||':'||v_from::text||':'||v_to::text,true);
  v_club_statements:=public.fn_issue_club_weekly_accounting(p_union_id,v_from,v_to);
  PERFORM set_config('app.union_accounting_validated_period',COALESCE(v_previous_validated,''),true);
  RETURN jsonb_build_object('success', true, 'union_id', p_union_id, 'club_weekly_statements',v_club_statements,
    'period_start', v_from, 'period_end', v_to,
    'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
    'round4_invoices', v_inv);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_to timestamptz := public.fn_union_week_start(v_now);
  v_from timestamptz;
  v_first timestamptz;
  v_end timestamptz;
  v_due timestamptz;
  v_union record;
  v_previous jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_orphans integer;
  v_orphan_amount numeric;
  v_complete boolean;
  v_failed integer := 0;
  v_checked integer := 0;
  v_msg text; v_detail text; v_state text;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  -- Transaction locks release on errors and also work in reused connections.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','already_running');
  END IF;
  IF public.fn_platform_frozen() OR extract(minute FROM v_now) >= 45 THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','maintenance_window');
  END IF;

  FOR v_union IN SELECT u.id, f.earliest_period_start
    FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id ORDER BY u.id
  LOOP
    -- Catch up chronologically from the explicit clean-data floor. A union
    -- without one starts at the just-closed week, never an invented history.
    v_first := COALESCE(public.fn_union_week_start(v_union.earliest_period_start),
                        public.fn_union_prev_week_start(v_now));
    IF v_first < v_union.earliest_period_start THEN
      v_first := public.fn_union_week_start(v_first + interval '8 days');
    END IF;
    v_from := v_first;
    WHILE v_from < v_to LOOP
      v_end := public.fn_union_week_start(v_from + interval '8 days');
      v_due := public.fn_union_accounting_run_at(v_end);
      IF v_now < v_due THEN EXIT; END IF;

      SELECT result INTO v_previous FROM public.union_accounting_runs
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      SELECT count(*), COALESCE(sum(rakeback_amount),0) INTO v_orphans,v_orphan_amount
        FROM public.rakeback_periods rp
       WHERE rp.club_id=v_union.id AND rp.status='pending' AND rp.rakeback_amount>0
         AND (rp.period_start::timestamp AT TIME ZONE 'UTC') < v_end
         AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') > v_from;

      SELECT NOT EXISTS (
        SELECT 1 FROM generate_series(1,4) n
        WHERE NOT EXISTS (SELECT 1 FROM public.union_settlement_rounds r
          WHERE r.union_id=v_union.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=n
            AND CASE
              WHEN n=1 THEN r.detail->>'success'='true'
              WHEN n IN(2,3) THEN
                COALESCE(r.detail->'latest_attempt',r.detail)->>'amount' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->>'payees' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->'shortfalls'='0'::jsonb
                AND COALESCE(COALESCE(r.detail->'latest_attempt',r.detail)->>'success','true')='true'
              ELSE r.detail->>'success'='true' AND COALESCE(r.detail->>'skipped','false')='false'
            END)) INTO v_complete;

      v_complete := v_complete AND NOT EXISTS (
        SELECT 1 FROM public.rakeback_periods rp
        JOIN public.union_clubs uc ON uc.club_id=rp.club_id AND uc.union_id=v_union.id
        WHERE rp.status='pending' AND rp.rakeback_amount>0
          AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
          AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_end)
        AND NOT EXISTS (SELECT 1 FROM public.union_clubs uc
          WHERE uc.union_id=v_union.id AND uc.club_id<>v_union.id
            AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
              WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
                AND si.breakdown->>'union_id'=v_union.id::text
                AND (si.breakdown->>'period_start')::timestamptz=v_from
                AND (si.breakdown->>'period_end')::timestamptz=v_end
                AND si.message_sent=true AND si.status<>'cancelled'));

      v_complete:=v_complete AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_union.id AND uc.club_id<>v_union.id AND NOT EXISTS(
          SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
          WHERE i.club_id=uc.club_id AND i.invoice_type='club_weekly_accounting' AND i.message_sent
            AND sp.start_at=v_from AND sp.end_at=v_end));
      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' THEN
        v_from:=v_end; CONTINUE;
      END IF;
      -- Bounded recovery: never let a large history monopolize live wallets.
      IF v_checked>=8 OR clock_timestamp()-v_now>interval '15 minutes'
        OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      INSERT INTO public.union_accounting_runs
        (union_id,period_start,period_end,scheduled_at,status,attempts,started_at)
      VALUES (v_union.id,v_from,v_end,v_due,'running',1,clock_timestamp())
      ON CONFLICT(union_id,period_start,period_end) DO UPDATE
        SET status='running',attempts=union_accounting_runs.attempts+1,started_at=clock_timestamp();

      -- Only this block may move chips. Any refused downstream stage raises
      -- and rolls back the whole union attempt, while the failure record below
      -- survives. Other unions have independent ledgers and transaction scopes.
      BEGIN
        IF v_orphans>0 THEN
          RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_rakeback_wrong_club',
            DETAIL=jsonb_build_object('pending_periods',v_orphans,'pending_amount',v_orphan_amount)::text;
        END IF;
        IF v_complete THEN
          v_result:=jsonb_build_object('success',true,'already_posted',true);
        ELSE
          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);
          IF v_result->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_settlement_incomplete',DETAIL=v_result::text;
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
      END;

      v_checked:=v_checked+1;
      UPDATE public.union_accounting_runs
         SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' ELSE 'failed' END,
             finished_at=clock_timestamp(),result=v_result
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN
        v_failed:=v_failed+1;
        -- Report a new failure or a changed failure, not the same alert every tick.
        IF v_previous IS DISTINCT FROM v_result THEN
          INSERT INTO public.financial_alerts(source,severity,message,context)
          VALUES ('union_accounting_scheduler','critical','Weekly union accounting is incomplete',
            jsonb_build_object('union_id',v_union.id,'period_start',v_from,'period_end',v_end,
                               'scheduled_at',v_due,'result',v_result));
        END IF;
      END IF;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('union_id',v_union.id,
        'period_start',v_from,'period_end',v_end,'result',v_result));
      -- Resolve an older period before posting a later one for the same union.
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT; END IF;
      v_from:=v_end;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
    'observed_at',clock_timestamp(),'detail',v_results);
END $function$
;

COMMIT;

-- Accounting documents commit with their Messenger and notification receipts.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure))<>'f9dc95cc0ace4d16e982c801e900f4a4'
 OR md5(pg_get_functiondef('fn_union_send_club_message(uuid,uuid,text,jsonb,text)'::regprocedure))<>'7189a6d21e9f66338ab1b1cac43f6c10'
 THEN RAISE EXCEPTION 'accounting invoice delivery source changed since review'; END IF;
END $guard$;
ALTER TABLE public.settlement_invoices
 ADD COLUMN source_ledger_id uuid UNIQUE REFERENCES public.chip_ledger(id),
 ADD COLUMN source_credit_invoice_id uuid UNIQUE REFERENCES public.credit_invoices(id),
 ADD COLUMN source_credit_payment_id uuid UNIQUE REFERENCES public.credit_payments(id);
ALTER TABLE public.settlement_invoices DROP CONSTRAINT settlement_invoices_invoice_type_check;
ALTER TABLE public.settlement_invoices ADD CONSTRAINT settlement_invoices_invoice_type_check CHECK(invoice_type IN
 ('union_to_club','club_to_agent','agent_to_subagent','agent_to_player','union_club_pnl','club_to_union','union_weekly_squareup','union_weekly_credit_note','transaction_receipt'));
ALTER TABLE public.settlement_invoices DROP CONSTRAINT settlement_invoices_from_entity_type_check;
ALTER TABLE public.settlement_invoices ADD CONSTRAINT settlement_invoices_from_entity_type_check CHECK(from_entity_type IN('union','club','agent','player'));
CREATE TABLE public.accounting_invoice_counters(year int PRIMARY KEY,next_number bigint NOT NULL CHECK(next_number>0));
CREATE TABLE public.accounting_conversations(
 scope_id uuid NOT NULL,issuer_type text NOT NULL,issuer_id uuid NOT NULL,sender_id uuid NOT NULL REFERENCES public.profiles(id),
 recipient_id uuid NOT NULL REFERENCES public.profiles(id),conversation_id uuid NOT NULL REFERENCES public.social_conversations(id),
 PRIMARY KEY(scope_id,issuer_type,issuer_id,sender_id,recipient_id));
CREATE TABLE public.accounting_invoice_deliveries(
 invoice_id uuid NOT NULL REFERENCES public.settlement_invoices(id),recipient_id uuid NOT NULL REFERENCES public.profiles(id),
 message_id uuid NOT NULL UNIQUE REFERENCES public.social_messages(id),notification_id uuid NOT NULL UNIQUE REFERENCES public.notifications(id),
 delivered_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(invoice_id,recipient_id));
ALTER TABLE public.accounting_invoice_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_invoice_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_invoice_counters,public.accounting_conversations,public.accounting_invoice_deliveries FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.accounting_invoice_counters,public.accounting_conversations,public.accounting_invoice_deliveries TO service_role;
GRANT SELECT ON public.accounting_invoice_deliveries TO authenticated;
CREATE POLICY own_accounting_delivery ON public.accounting_invoice_deliveries FOR SELECT TO authenticated USING(recipient_id=(SELECT auth.uid()));
CREATE POLICY own_accounting_invoice ON public.settlement_invoices FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=settlement_invoices.id AND d.recipient_id=(SELECT auth.uid())));

-- Read flags and payment status can advance; issued financial content cannot be restated.
CREATE FUNCTION public.fn_accounting_document_immutable() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE issued boolean;
BEGIN
 IF TG_TABLE_NAME='settlement_invoices' THEN
   issued:=COALESCE(OLD.message_sent,false) OR EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id=OLD.id);
   IF issued AND (TG_OP='DELETE' OR
     (to_jsonb(NEW)-ARRAY['status','chips_transferred','transferred_at','message_sent','message_sent_at','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','chips_transferred','transferred_at','message_sent','message_sent_at','updated_at'])
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
CREATE TRIGGER accounting_invoice_immutable BEFORE UPDATE OR DELETE ON public.settlement_invoices
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_document_immutable();
CREATE TRIGGER accounting_message_immutable BEFORE UPDATE OR DELETE ON public.social_messages
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_document_immutable();

-- A service-backed Messenger group-membership endpoint must not expose old receipts.
CREATE FUNCTION public.fn_accounting_conversation_audience_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.accounting_conversations c WHERE c.conversation_id=OLD.conversation_id)
   AND (TG_OP='DELETE' OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.user_id IS DISTINCT FROM OLD.user_id)
 THEN RAISE EXCEPTION 'accounting_conversation_audience_is_immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM public.accounting_conversations c WHERE c.conversation_id=NEW.conversation_id
    AND NEW.user_id<>ALL(ARRAY[c.sender_id,c.recipient_id]))
 THEN RAISE EXCEPTION 'accounting_conversation_audience_is_immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER accounting_conversation_audience BEFORE INSERT OR UPDATE OR DELETE ON public.social_conversation_participants
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_conversation_audience_guard();
REVOKE ALL ON FUNCTION public.fn_accounting_document_immutable(),public.fn_accounting_conversation_audience_guard() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.fn_accounting_next_invoice_number() RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE y int:=extract(year FROM now() AT TIME ZONE 'America/Chicago'); n bigint;
BEGIN
 INSERT INTO public.accounting_invoice_counters(year,next_number) VALUES(y,2)
 ON CONFLICT(year) DO UPDATE SET next_number=accounting_invoice_counters.next_number+1
 RETURNING next_number-1 INTO n;
 RETURN 'CA-'||y::text||'-'||lpad(n::text,8,'0');
END $function$;

CREATE FUNCTION public.fn_accounting_party_users(p_kind text,p_id uuid) RETURNS TABLE(user_id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $function$
 SELECT DISTINCT p.id FROM public.profiles p WHERE p.id IN (
  SELECT p_id WHERE p_kind IN('agent','player')
  UNION SELECT c.owner_id FROM public.clubs c WHERE p_kind='club' AND c.id=p_id
  UNION SELECT m.user_id FROM public.club_members m WHERE p_kind='club' AND m.club_id=p_id
   AND m.role IN('owner','co_owner','admin') AND COALESCE(m.status,'active') IN('active','approved')
  UNION SELECT u.owner_id FROM public.unions u WHERE p_kind='union' AND u.id=p_id
  UNION SELECT a.user_id FROM public.union_admins a WHERE p_kind='union' AND a.union_id=p_id
   AND public.fn_is_union_overseer(p_id,a.user_id)
 );
$function$;

CREATE FUNCTION public.fn_deliver_accounting_invoice(p_invoice_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
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
 IF inv.invoice_type IN('union_weekly_squareup','union_weekly_credit_note') THEN
   issuer_kind:='union';issuer_id:=(inv.breakdown->>'union_id')::uuid;
 END IF;
 sender:=CASE WHEN issuer_kind='club' THEN (SELECT owner_id FROM public.clubs WHERE id=issuer_id)
              WHEN issuer_kind='union' THEN (SELECT owner_id FROM public.unions WHERE id=issuer_id)
              ELSE issuer_id END;
 IF sender IS NULL OR NOT sender=ANY(users) THEN RAISE EXCEPTION 'accounting_invoice_sender_missing' USING ERRCODE='23514'; END IF;
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
 body:='Invoice '||inv.invoice_number||E'\nIssued By: '||COALESCE(issuer_name,inv.from_entity_type)||E'\nFor: '||COALESCE(recipient_name,inv.to_entity_type)
  ||E'\nDirection: '||initcap(inv.from_entity_type)||' To '||initcap(inv.to_entity_type)
  ||E'\nAmount: '||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips'
  ||E'\nStatus: '||initcap(inv.status)
  ||CASE WHEN inv.chips_transferred THEN E'\nTransfer Recorded: '||COALESCE(inv.transferred_at,inv.created_at)::text ELSE '' END
  ||CASE WHEN inv.due_at IS NOT NULL THEN E'\nDue: '||to_char(inv.due_at AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI')||' Chicago Time' ELSE '' END
  ||CASE WHEN inv.breakdown ? 'period_start' THEN E'\nPeriod: '||(inv.breakdown->>'period_start')||' To '||COALESCE(inv.breakdown->>'period_end','') ELSE '' END
  ||CASE WHEN inv.notes IS NOT NULL THEN E'\n'||inv.notes ELSE '' END;
 FOR line IN SELECT key,value FROM jsonb_each_text(COALESCE(inv.breakdown,'{}'))
   WHERE key IN('rake_generated','rakeback_due','union_fee_kept','players_won','settled_in_chips','eco_amount','presettled') ORDER BY key
 LOOP
   IF line.value IS NOT NULL THEN body:=body||E'\n'||initcap(replace(line.key,'_',' '))||': '||to_char(line.value::numeric,'FM999,999,999,999,990.00'); END IF;
 END LOOP;
 meta:=jsonb_build_object('kind','accounting_invoice' ,'invoice_id',inv.id,'invoice_number',inv.invoice_number,
   'club_id',inv.club_id,'source_ledger_id',inv.source_ledger_id,'source_credit_invoice_id',inv.source_credit_invoice_id,
   'source_credit_payment_id',inv.source_credit_payment_id,'amount',inv.net_amount,'currency','CHIPS','conversationId',NULL,'status',inv.status,
   'invoice_type',inv.invoice_type,'from_entity_type',inv.from_entity_type,'from_entity_id',inv.from_entity_id,
   'to_entity_type',inv.to_entity_type,'to_entity_id',inv.to_entity_id,'lines',inv.breakdown);
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
    VALUES(person,'accounting_invoice','Invoice '||inv.invoice_number,
     CASE WHEN inv.chips_transferred AND inv.breakdown->>'category'='rakeback' THEN 'Rakeback Transfer Recorded: ' WHEN inv.chips_transferred AND inv.breakdown->>'category'='commission' THEN 'Commission Transfer Recorded: ' WHEN inv.chips_transferred THEN 'Transfer Recorded: ' ELSE 'Invoice Issued: ' END||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips',
     meta,false,'/hub/messenger?conversation='||conv::text,meta) RETURNING id INTO note;
   INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id) VALUES(inv.id,person,msg,note);
   count_sent:=count_sent+1;
 END LOOP;
 SELECT count(*) INTO n FROM public.accounting_invoice_deliveries WHERE invoice_id=inv.id;
 UPDATE public.settlement_invoices SET message_sent=true,message_sent_at=COALESCE(message_sent_at,now()) WHERE id=inv.id;
 RETURN jsonb_build_object('success',true,'invoice_id',inv.id,'delivered',n,'new_deliveries',count_sent);
END $function$;

CREATE FUNCTION public.fn_invoice_accounting_ledger_transfer(p_ledger_id uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
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
      'ledger_from_entity_id',leg.from_entity_id,'ledger_to_type',leg.to_type,'ledger_to_entity_id',leg.to_entity_id),
    'paid',true,leg.created_at,'Receipt For A Posted Accounting Transfer. This Does Not Certify The Entire Weekly Close.',leg.id)
   RETURNING id INTO inv_id;
 END IF;
 PERFORM public.fn_deliver_accounting_invoice(inv_id);
 RETURN inv_id;
END $function$;

CREATE FUNCTION public.fn_accounting_invoice_deliver_on_insert() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 PERFORM public.fn_deliver_accounting_invoice(NEW.id);
 RETURN NEW;
END $function$;
CREATE TRIGGER accounting_invoice_deliver AFTER INSERT ON public.settlement_invoices
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_invoice_deliver_on_insert();
CREATE FUNCTION public.fn_accounting_transfer_document_on_insert() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 PERFORM public.fn_invoice_accounting_ledger_transfer(NEW.id);
 RETURN NEW;
END $function$;
CREATE TRIGGER accounting_transfer_document AFTER INSERT ON public.chip_ledger FOR EACH ROW
 WHEN (NEW.status='posted' AND (NEW.from_type IN ('union_wallet','union_bank','club_treasury','player_wallet','agent_wallet') OR (NEW.from_type='settlement_suspense' AND NEW.category='rakeback'))
   AND NEW.to_type IN ('union_wallet','union_bank','club_treasury','player_wallet','agent_wallet'))
 EXECUTE FUNCTION public.fn_accounting_transfer_document_on_insert();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
 VALUES('chip_ledger','accounting_transfer_document','Only transfers between accounting wallets, treasuries and banks, plus the existing rakeback clearing leg; excludes hand stacks and prize pools. Creates a source-linked invoice and private Messenger plus notification receipts in the same transaction; any failure rolls back the transfer. No balance writes.');

REVOKE ALL ON FUNCTION public.fn_accounting_next_invoice_number(),public.fn_accounting_party_users(text,uuid),public.fn_deliver_accounting_invoice(uuid),public.fn_invoice_accounting_ledger_transfer(uuid),public.fn_accounting_invoice_deliver_on_insert(),public.fn_accounting_transfer_document_on_insert() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_next_invoice_number(),public.fn_accounting_party_users(text,uuid),public.fn_deliver_accounting_invoice(uuid),public.fn_invoice_accounting_ledger_transfer(uuid) TO service_role;

CREATE FUNCTION public.fn_accounting_credit_document_on_insert() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE a public.agents%ROWTYPE; credit public.credit_invoices%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='credit_invoices' THEN
   SELECT * INTO a FROM public.agents WHERE id=NEW.agent_id;
   INSERT INTO public.settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    gross_amount,net_amount,deductions,breakdown,status,chips_transferred,due_at,source_credit_invoice_id,notes)
   VALUES(a.club_id,'transaction_receipt','club',a.club_id::text,'agent',a.user_id::text,
    NEW.debt_owed,NEW.debt_owed,0,jsonb_build_object('kind','credit_invoice','period_start',NEW.period_start,'period_end',NEW.period_end),
    'generated',false,NEW.due_date,NEW.id,'Drawn Credit Invoice. This Amount Is Due From The Agent To The Club.');
 ELSIF TG_TABLE_NAME='credit_payments' THEN
   SELECT * INTO credit FROM public.credit_invoices WHERE id=NEW.invoice_id;
   SELECT * INTO a FROM public.agents WHERE id=credit.agent_id;
   INSERT INTO public.settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    gross_amount,net_amount,deductions,breakdown,status,chips_transferred,transferred_at,source_credit_payment_id,notes)
   VALUES(a.club_id,'transaction_receipt','agent',a.user_id::text,'club',a.club_id::text,
    NEW.amount,NEW.amount,0,jsonb_build_object('kind','credit_payment','credit_invoice_id',NEW.invoice_id,'payment_method',NEW.payment_method,'transaction_id',NEW.transaction_id),
    'paid',NEW.payment_method='wallet',NEW.created_at,NEW.id,'Credit Payment Recorded Against The Referenced Invoice.');
 ELSE RAISE EXCEPTION 'unsupported_credit_document_source'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER accounting_credit_invoice_document AFTER INSERT ON public.credit_invoices FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_credit_document_on_insert();
CREATE TRIGGER accounting_credit_payment_document AFTER INSERT ON public.credit_payments FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_credit_document_on_insert();
REVOKE ALL ON FUNCTION public.fn_accounting_credit_document_on_insert() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.fn_union_issue_weekly_invoices(p_union_id uuid, p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_notify boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_from timestamptz := COALESCE(p_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_end,   public.fn_union_week_start(now()));
  v_due  timestamptz;
  v_union_name text;
  r record;
  v_period_id uuid;
  v_invoice_id uuid;
  v_already_sent boolean;
  v_issued int := 0;
  v_notified int := 0;
  v_notified_batch int := 0;
  v_messaged int := 0;
  v_basis_exact boolean;
  v_msg jsonb;
  v_body text;
  v_number text;
  v_out jsonb := '[]'::jsonb;
BEGIN
  IF v_caller IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_caller)
     AND NOT EXISTS (SELECT 1 FROM union_admins ua
                      WHERE ua.union_id = p_union_id AND ua.user_id = v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized');
  END IF;

  /* THE GUARDS LIVE HERE, NOT ONLY IN THE CASCADE (Phase 6 verification,
     20260908). The Open Claw safety net calls this function directly. */
  IF EXISTS (SELECT 1 FROM public.union_settlement_floor f
              WHERE f.union_id = p_union_id AND v_from < f.earliest_period_start) THEN
    RETURN jsonb_build_object('success', false, 'error', 'before_settlement_floor',
                              'period_start', v_from, 'period_end', v_to);
  END IF;
  IF public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'weekly_invoices_disabled',
                              'period_start', v_from, 'period_end', v_to);
  END IF;
  -- A statement says "rakeback already moved in chips". It is issued only for a
  -- period whose round 1 is final, and then it reads that round's own rows.
  IF NOT EXISTS (SELECT 1 FROM public.ca_settlements s
                  WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
                    AND s.state = 'final'
                    AND s.external_ref = p_union_id::text || ':'
                      || to_char(v_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
                      || to_char(v_to   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'period_not_closed',
                              'period_start', v_from, 'period_end', v_to);
  END IF;

  v_due := v_to + interval '3 days';
  SELECT u.name INTO v_union_name FROM unions u WHERE u.id = p_union_id;

  -- Is the seated-stack baseline this week's ECO rests on an exact one?
  SELECT bool_and(COALESCE(e.baseline_cash_exact, false))
    INTO v_basis_exact
    FROM fn_union_eco_adjustment(p_union_id, v_from, v_to) e;
  v_basis_exact := COALESCE(v_basis_exact, false);

  FOR r IN SELECT * FROM fn_union_club_invoice(p_union_id, v_from, v_to) LOOP
    v_msg := NULL;
    v_invoice_id := NULL;
    v_already_sent := false;

    SELECT sp.id INTO v_period_id
      FROM settlement_periods sp
     WHERE sp.club_id = r.club_id AND sp.union_id = p_union_id
       AND sp.start_at = v_from AND sp.end_at = v_to
     ORDER BY sp.created_at DESC LIMIT 1;

    IF v_period_id IS NULL THEN
      INSERT INTO settlement_periods (club_id, union_id, period_number, year,
                                      start_at, end_at, status)
      VALUES (r.club_id, p_union_id,
              EXTRACT(week FROM v_from)::int, EXTRACT(isoyear FROM v_from)::int,
              v_from, v_to, 'processing')
      RETURNING id INTO v_period_id;
    END IF;

    -- Reuse the number this document already carries. Take a new one ONLY
    -- when there is no document yet: the upsert below may take the ON
    -- CONFLICT path, and a number taken and not used is a gap in the series.
    SELECT si.invoice_number INTO v_number
      FROM settlement_invoices si
     WHERE si.club_id = r.club_id AND si.period_id = v_period_id
       AND si.invoice_type = 'union_weekly_squareup';
    IF NOT FOUND THEN
      v_number := public.fn_next_invoice_number(p_union_id, now());
    END IF;

    INSERT INTO settlement_invoices (
      club_id, period_id, invoice_type, invoice_number,
      from_entity_type, from_entity_id, to_entity_type, to_entity_id,
      gross_amount, net_amount, deductions, breakdown, status,
      chips_transferred, due_at, notes)
    VALUES (
      r.club_id, v_period_id, 'union_weekly_squareup', v_number,
      CASE WHEN r.outstanding >= 0 THEN 'union' ELSE 'club' END,
      CASE WHEN r.outstanding >= 0 THEN p_union_id::text ELSE r.club_id::text END,
      CASE WHEN r.outstanding >= 0 THEN 'club'  ELSE 'union' END,
      CASE WHEN r.outstanding >= 0 THEN r.club_id::text ELSE p_union_id::text END,
      abs(r.outstanding), abs(r.outstanding), 0,
      jsonb_build_object(
        'union_id', p_union_id, 'union_name', v_union_name,
        'club_id', r.club_id, 'club_name', r.club_name,
        'period_start', r.period_start, 'period_end', r.period_end,
        'rake_generated', r.rake_generated,
        'union_fee_kept', r.union_fee_kept,
        'rakeback_due',   r.rakeback_due,
        'players_won',    r.players_won,
        'player_pnl_net', r.player_pnl_net,
        'eco_amount',     r.eco_amount,
        'eco_enabled',    r.eco_enabled,
        'presettled',     r.presettled,
        'settled_in_chips', r.settled_in_chips,
        'outstanding',    r.outstanding,
        'net_position',   r.net_position,
        'direction',      r.direction,
        'baseline_cash_exact', v_basis_exact,
        'computed_at',    now()),
      'generated', false, v_due,
      'Weekly union square-up. settled_in_chips already moved during the week; '
      || 'outstanding is the amount to settle.')
    ON CONFLICT (club_id, period_id, invoice_type)
      WHERE invoice_type = 'union_weekly_squareup'
    DO UPDATE SET
      from_entity_type = EXCLUDED.from_entity_type,
      from_entity_id   = EXCLUDED.from_entity_id,
      to_entity_type   = EXCLUDED.to_entity_type,
      to_entity_id     = EXCLUDED.to_entity_id,
      gross_amount     = EXCLUDED.gross_amount,
      net_amount       = EXCLUDED.net_amount,
      invoice_number   = COALESCE(settlement_invoices.invoice_number, EXCLUDED.invoice_number),
      breakdown        = EXCLUDED.breakdown,
      due_at           = EXCLUDED.due_at,
      updated_at       = now()
    WHERE COALESCE(settlement_invoices.message_sent, false) = false
    RETURNING id, COALESCE(message_sent, false) INTO v_invoice_id, v_already_sent;

    -- The upsert returns nothing when the guard above refused to restate an
    -- already-delivered invoice. That row is the record; read it as it stands.
    IF v_invoice_id IS NULL THEN
      SELECT si.id, COALESCE(si.message_sent, false)
        INTO v_invoice_id, v_already_sent
        FROM settlement_invoices si
       WHERE si.club_id = r.club_id
         AND si.period_id = v_period_id
         AND si.invoice_type = 'union_weekly_squareup';
    END IF;

    v_issued := v_issued + 1;

    -- Delivery is mandatory and shared with every accounting invoice.
    v_msg := public.fn_deliver_accounting_invoice(v_invoice_id);
    v_notified := v_notified + CASE WHEN v_already_sent THEN (v_msg->>'new_deliveries')::int ELSE (v_msg->>'delivered')::int END;
    v_messaged := v_messaged + CASE WHEN v_already_sent THEN (v_msg->>'new_deliveries')::int ELSE (v_msg->>'delivered')::int END;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'club_id', r.club_id, 'club_name', r.club_name,
      'invoice_id', v_invoice_id, 'outstanding', r.outstanding,
      'direction', r.direction, 'due_at', v_due,
      'messaged', COALESCE((v_msg->>'delivered')::int, 0),
      'already_sent', v_already_sent));
  END LOOP;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id,
    'period_start', v_from, 'period_end', v_to, 'due_at', v_due,
    'baseline_cash_exact', v_basis_exact,
    'invoices', v_issued, 'notified', v_notified, 'messenger_deliveries', v_messaged,
    'detail', v_out);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_union_send_club_message(p_union_id uuid, p_club_id uuid, p_content text, p_metadata jsonb DEFAULT '{}'::jsonb, p_message_type text DEFAULT 'text'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sender      uuid;
  v_union_name  text;
  v_union_page  uuid;
  v_club_page   uuid;
  v_conv        uuid;
  v_title       text;
  v_msg_id      uuid;
  v_recipients  int := 0;
  r             record;
BEGIN
  -- Compatibility for existing invoice and credit-note callers. Reminders
  -- retain their distinct message, while issued documents use one delivery receipt.
  IF p_metadata->>'kind' IN ('union_invoice','union_credit_note') THEN
    IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(p_union_id,auth.uid())) THEN
      RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.settlement_invoices si
      WHERE si.id=COALESCE(p_metadata->>'invoice_id',p_metadata->>'credit_note_id')::uuid
        AND si.club_id=p_club_id AND (si.breakdown->>'union_id')::uuid=p_union_id) THEN
      RAISE EXCEPTION 'accounting_invoice_scope_mismatch' USING ERRCODE='42501';
    END IF;
    RETURN public.fn_deliver_accounting_invoice(COALESCE(p_metadata->>'invoice_id',p_metadata->>'credit_note_id')::uuid);
  END IF;
  SELECT u.owner_id, u.name INTO v_sender, v_union_name
    FROM unions u WHERE u.id = p_union_id;
  IF v_sender IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union has no owner to send as');
  END IF;

  SELECT sp.id INTO v_union_page FROM social_pages sp
   WHERE sp.linked_entity_id = p_union_id::text AND sp.linked_entity_type = 'club' LIMIT 1;
  SELECT sp.id INTO v_club_page FROM social_pages sp
   WHERE sp.linked_entity_id = p_club_id::text AND sp.linked_entity_type = 'club' LIMIT 1;

  v_title := COALESCE(v_union_name, 'Union') || ' Statements';

  SELECT c.id INTO v_conv
    FROM social_conversations c
   WHERE c.is_group = true
     AND c.group_name = v_title
     AND c.context_entity_id IS NOT DISTINCT FROM v_club_page
   ORDER BY c.created_at ASC
   LIMIT 1;

  IF v_conv IS NULL THEN
    INSERT INTO social_conversations (is_group, group_name, context_entity_id, context_entity_type)
    VALUES (true, v_title, v_club_page, CASE WHEN v_club_page IS NULL THEN NULL ELSE 'club' END)
    RETURNING id INTO v_conv;
  END IF;

  -- RECIPIENTS FIRST, seated under the CLUB identity.
  FOR r IN
    SELECT DISTINCT x.uid
      FROM (
        SELECT c.owner_id AS uid FROM clubs c
         WHERE c.id = p_club_id AND c.owner_id IS NOT NULL
        UNION
        SELECT cm.user_id FROM club_members cm
         WHERE cm.club_id = p_club_id
           AND cm.role IN ('owner','co_owner','admin')
           AND COALESCE(cm.status,'active') NOT IN ('banned','suspended')
      ) x
     WHERE x.uid IS NOT NULL
       AND EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = x.uid)
  LOOP
    INSERT INTO social_conversation_participants
      (conversation_id, user_id, context_entity_id, context_entity_type)
    VALUES (v_conv, r.uid, v_club_page,
            CASE WHEN v_club_page IS NULL THEN NULL ELSE 'club' END)
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
    v_recipients := v_recipients + 1;
  END LOOP;

  IF v_recipients = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'club has no owner or admin with a profile',
                              'conversation_id', v_conv);
  END IF;

  -- The union owner joins under the UNION identity only if they are not
  -- already seated as a club recipient (one row per user is enforced).
  INSERT INTO social_conversation_participants
    (conversation_id, user_id, context_entity_id, context_entity_type)
  VALUES (v_conv, v_sender, v_union_page,
          CASE WHEN v_union_page IS NULL THEN NULL ELSE 'club' END)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  INSERT INTO social_messages (conversation_id, sender_id, content, message_type, media_metadata)
  VALUES (v_conv, v_sender, p_content,
          COALESCE(NULLIF(p_message_type, ''), 'text'),
          CASE WHEN p_metadata = '{}'::jsonb OR p_metadata IS NULL THEN NULL ELSE p_metadata END)
  RETURNING id INTO v_msg_id;

  UPDATE social_conversations
     SET last_message_at = now(),
         last_message_preview = left(regexp_replace(p_content, E'\\s+', ' ', 'g'), 100),
         updated_at = now()
   WHERE id = v_conv;

  RETURN jsonb_build_object('success', true, 'delivered', v_recipients,
                            'conversation_id', v_conv, 'message_id', v_msg_id,
                            'club_page', v_club_page, 'union_page', v_union_page);
END;
$function$;
COMMIT;

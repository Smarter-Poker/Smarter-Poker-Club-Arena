-- Cashout requests ask the agent to accept or cancel (owner instruction, 2026-10-23).
-- Installed on PokerIQ-Production as version 20261023173104 (apply_migration wraps
-- the body in one transaction; this file keeps the explicit BEGIN/COMMIT).
--
-- 1. The bell/push for a cashier document now says who the player is and what the
--    agent must do ("Cashout Request · WooWoo ... Open Invoices To Accept Or Cancel").
--    The copy is computed only from the immutable cashier event, so the delivery
--    assertion stays deterministic; historical deliveries keep their legacy copy.
-- 2. The owner's issuer copies of accounting receipts stay off push, except a
--    cashout request where the owner IS the assigned agent: that is his to decide.
-- 3. Every request/decision is also auto-posted as a direct message in the club
--    thread between the player and the agent (player -> agent for a request).
-- 4. fn_cashout_request_card gives the messenger the live state of a request and
--    whether the viewer may accept (chips to the agent wallet) or cancel (chips
--    back to the player wallet) through the existing fn_cashout_approve_v2 /
--    fn_cashout_release_v2 transitions. No new money path.
-- 5. Invoice attention: a cashout request needs action only while it is pending,
--    and never for the player who asked.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$ BEGIN
 IF md5(pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure)) <> '24cffb644a4ccad0daf4de38cbc20887'
 THEN RAISE EXCEPTION 'fn_deliver_accounting_invoice changed since it was read'; END IF;
 IF md5(pg_get_functiondef('public.fn_cashier_assert_delivery(uuid)'::regprocedure)) <> 'c01d8c8ab5b148c20e25c609164d74ed'
 THEN RAISE EXCEPTION 'fn_cashier_assert_delivery changed since it was read'; END IF;
 IF md5(pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure)) <> 'c0d5fe55644a793450a6ea08828181ce'
 THEN RAISE EXCEPTION 'fn_mirror_notification_to_push_outbox changed since it was read'; END IF;
 IF md5(pg_get_functiondef('public.fn_messenger_private_invoice_attention(uuid,uuid[])'::regprocedure)) <> '93b38e833def785a4491bc35fd060df8'
 THEN RAISE EXCEPTION 'fn_messenger_private_invoice_attention changed since it was read'; END IF;
END $pre$;

-- 1. Recipient-specific copy, from immutable event fields only
CREATE OR REPLACE FUNCTION public.fn_cashier_notice_copy(e public.accounting_cashier_events, p_recipient uuid, p_invoice_number text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 WITH v AS (SELECT to_char(abs(e.amount),'FM999,999,999,999,990.00')||' Chips' AS amt,
   COALESCE(NULLIF(btrim(e.player_name),''),'A Player') AS who,
   COALESCE(NULLIF(btrim(e.issuer_name),''),'Your Club') AS club,
   p_recipient IS NOT DISTINCT FROM e.player_id AS mine,
   p_recipient IS NOT DISTINCT FROM e.actor_user_id AS acted,
   COALESCE(p_invoice_number,'') AS num)
 SELECT CASE e.event_kind
  WHEN 'hold' THEN CASE WHEN mine
   THEN jsonb_build_object('title','Cashout Requested · '||num,
     'message','Your Cashout Request For '||amt||' Was Sent To Your Agent. Your Chips Are Held Until It Is Accepted Or Cancelled.')
   ELSE jsonb_build_object('title','Cashout Request · '||who,
     'message',who||' Requested A Payout Of '||amt||' In '||club||'. Open Invoices To Accept Or Cancel It. Invoice '||num) END
  WHEN 'approval' THEN CASE WHEN mine
   THEN jsonb_build_object('title','Cashout Approved · '||num,
     'message','Your Cashout Of '||amt||' Was Accepted By Your Agent.')
   WHEN acted THEN jsonb_build_object('title','Payout Accepted · '||who,
     'message','You Accepted '||who||'''s Payout Of '||amt||'. The Chips Were Sent To Your Agent Wallet. Invoice '||num)
   ELSE jsonb_build_object('title','Payout Accepted · '||who,
     'message',who||'''s Payout Of '||amt||' Was Accepted. Invoice '||num) END
  WHEN 'decline' THEN CASE WHEN mine
   THEN jsonb_build_object('title','Cashout Cancelled · '||num,
     'message','Your Agent Cancelled Your Cashout Of '||amt||'. The Chips Were Returned To Your Wallet.')
   ELSE jsonb_build_object('title','Payout Cancelled · '||who,
     'message',who||'''s Payout Of '||amt||' Was Cancelled. The Chips Were Returned To '||who||'''s Wallet. Invoice '||num) END
  WHEN 'cancellation' THEN CASE WHEN mine
   THEN jsonb_build_object('title','Cashout Cancelled · '||num,
     'message','You Cancelled Your Cashout Of '||amt||'. The Chips Were Returned To Your Wallet.')
   ELSE jsonb_build_object('title','Payout Withdrawn · '||who,
     'message',who||' Cancelled Their Payout Request Of '||amt||'. The Chips Were Returned To Their Wallet. Invoice '||num) END
  ELSE CASE WHEN mine
   THEN jsonb_build_object('title','Cashout Expired · '||num,
     'message','Your Cashout Of '||amt||' Expired. The Chips Were Returned To Your Wallet.')
   ELSE jsonb_build_object('title','Payout Expired · '||who,
     'message',who||'''s Payout Request Of '||amt||' Expired. The Chips Were Returned To '||who||'''s Wallet. Invoice '||num) END
 END FROM v;
$function$;
REVOKE ALL ON FUNCTION public.fn_cashier_notice_copy(public.accounting_cashier_events,uuid,text) FROM PUBLIC, anon, authenticated;

-- Splice the copy into the delivery, accept it (or the legacy copy) in the
-- assertion, and give the owner push for the requests he is assigned.
DO $splice$
DECLARE def text; frag text; s int; t int; expr text; occurrences int;
BEGIN
 def:=pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure);
 frag:=$f$CASE WHEN inv.invoice_type='credit_limit_change' THEN 'Credit Line Updated · '$f$;
 s:=position(frag in def); IF s=0 THEN RAISE EXCEPTION 'deliver title start missing'; END IF;
 t:=position($f$ELSE 'Invoice ' END||inv.invoice_number,$f$ in substr(def,s));
 IF t=0 THEN RAISE EXCEPTION 'deliver title end missing'; END IF;
 expr:=substr(def,s,t-1+length($f$ELSE 'Invoice ' END||inv.invoice_number$f$));
 occurrences:=(length(def)-length(replace(def,expr,'')))/length(expr);
 IF occurrences<>1 THEN RAISE EXCEPTION 'deliver title expression not unique (%)',occurrences; END IF;
 def:=replace(def,expr,$r$CASE WHEN inv.invoice_type='cashier_cashout' THEN public.fn_cashier_notice_copy(cashier,person,inv.invoice_number)->>'title' ELSE $r$||expr||' END');
 frag:=$f$CASE WHEN inv.invoice_type='credit_limit_change' THEN 'Credit capacity reduced: '$f$;
 s:=position(frag in def); IF s=0 THEN RAISE EXCEPTION 'deliver message start missing'; END IF;
 t:=position($f$||' Chips' END,$f$ in substr(def,s));
 IF t=0 THEN RAISE EXCEPTION 'deliver message end missing'; END IF;
 expr:=substr(def,s,t-1+length($f$||' Chips' END$f$));
 occurrences:=(length(def)-length(replace(def,expr,'')))/length(expr);
 IF occurrences<>1 THEN RAISE EXCEPTION 'deliver message expression not unique (%)',occurrences; END IF;
 def:=replace(def,expr,$r$CASE WHEN inv.invoice_type='cashier_cashout' THEN public.fn_cashier_notice_copy(cashier,person,inv.invoice_number)->>'message' ELSE $r$||expr||' END');
 EXECUTE def;

 def:=pg_get_functiondef('public.fn_cashier_assert_delivery(uuid)'::regprocedure);
 frag:='OR d.notice_title IS DISTINCT FROM (';
 s:=position(frag in def); IF s=0 THEN RAISE EXCEPTION 'assert title missing'; END IF;
 t:=position('||i.invoice_number)' in substr(def,s));
 expr:=substr(def,s,t-1+length('||i.invoice_number)'));
 def:=replace(def,expr,'OR (d.notice_title IS DISTINCT FROM ('||substr(expr,length(frag)+1)
   ||$r$ AND d.notice_title IS DISTINCT FROM public.fn_cashier_notice_copy(e,d.recipient_id,i.invoice_number)->>'title')$r$);
 frag:='OR d.notice_message IS DISTINCT FROM (';
 s:=position(frag in def); IF s=0 THEN RAISE EXCEPTION 'assert message missing'; END IF;
 t:=position($f$||' Chips')$f$ in substr(def,s));
 expr:=substr(def,s,t-1+length($f$||' Chips')$f$));
 def:=replace(def,expr,'OR (d.notice_message IS DISTINCT FROM ('||substr(expr,length(frag)+1)
   ||$r$ AND d.notice_message IS DISTINCT FROM public.fn_cashier_notice_copy(e,d.recipient_id,i.invoice_number)->>'message')$r$);
 EXECUTE def;

 def:=pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure);
 frag:=$f$ELSIF notice.user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid THEN$f$;
 IF position(frag in def)=0 THEN RAISE EXCEPTION 'mirror owner branch missing'; END IF;
 def:=replace(def,frag,$r$ELSIF notice.user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid
   AND NOT (receipt.invoice_type='cashier_cashout' AND receipt.media_metadata->'cashier'->>'event_kind'='hold'
            AND receipt.media_metadata->'cashier'->>'assigned_agent_id'=notice.user_id::text) THEN$r$);
 EXECUTE def;
END $splice$;

-- 3. Auto-posted direct messages between the player and the agent
CREATE OR REPLACE FUNCTION public.fn_cashier_event_messenger_thread()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE sender uuid; other uuid; page uuid; conv uuid; amt text; body text; note text;
BEGIN
 IF NEW.event_kind NOT IN('hold','approval','decline','cancellation') THEN RETURN NULL; END IF;
 BEGIN
  amt:=to_char(abs(NEW.amount),'FM999,999,999,999,990.00')||' Chips';
  note:=NULLIF(btrim(COALESCE(NEW.accepted_note,'')),'');
  IF NEW.event_kind IN('hold','cancellation') THEN sender:=NEW.player_id; other:=NEW.assigned_agent_id;
  ELSE sender:=NEW.actor_user_id; other:=NEW.player_id; END IF;
  IF sender IS NULL OR other IS NULL OR sender=other THEN RETURN NULL; END IF;
  body:=CASE NEW.event_kind
   WHEN 'hold' THEN 'Cashout Request: '||amt||E'\nPlease Accept Or Cancel My Payout In Invoices.'||COALESCE(E'\nNote: '||note,'')
   WHEN 'cancellation' THEN 'I Cancelled My Cashout Request Of '||amt||'.'
   WHEN 'approval' THEN 'Cashout Approved: '||amt||'. Your Payout Was Accepted.'||COALESCE(E'\nNote: '||note,'')
   ELSE 'Cashout Cancelled: '||amt||' Were Returned To Your Wallet.'||COALESCE(E'\nNote: '||note,'') END;
  SELECT id INTO page FROM public.social_pages WHERE linked_entity_id=NEW.club_id::text AND linked_entity_type='club' ORDER BY id LIMIT 1;
  PERFORM pg_advisory_xact_lock(hashtextextended('cashout-dm:'||COALESCE(page::text,'-')||':'||least(sender,other)::text||':'||greatest(sender,other)::text,0));
  SELECT c.id INTO conv FROM public.social_conversations c
   JOIN public.social_conversation_participants a ON a.conversation_id=c.id AND a.user_id=sender
   JOIN public.social_conversation_participants b ON b.conversation_id=c.id AND b.user_id=other
   WHERE c.is_group=false AND a.context_entity_id IS NOT DISTINCT FROM page AND b.context_entity_id IS NOT DISTINCT FROM page
     AND NOT EXISTS(SELECT 1 FROM public.social_conversation_participants x WHERE x.conversation_id=c.id AND x.user_id NOT IN(sender,other))
   ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1;
  IF conv IS NULL THEN
   INSERT INTO public.social_conversations(is_group,context_entity_id,context_entity_type)
    VALUES(false,page,CASE WHEN page IS NULL THEN NULL ELSE 'club' END) RETURNING id INTO conv;
   INSERT INTO public.social_conversation_participants(conversation_id,user_id,context_entity_id,context_entity_type)
    VALUES(conv,sender,page,CASE WHEN page IS NULL THEN NULL ELSE 'club' END),
          (conv,other,page,CASE WHEN page IS NULL THEN NULL ELSE 'club' END);
  END IF;
  INSERT INTO public.social_messages(conversation_id,sender_id,content,message_type,media_metadata)
   VALUES(conv,sender,body,'text',jsonb_build_object('kind','cashout_request','event_kind',NEW.event_kind,
     'cashout_id',NEW.cashout_id,'club_id',NEW.club_id,'player_id',NEW.player_id,'amount',round(NEW.amount,2)::text,
     'invoice_id',NEW.invoice_id));
  UPDATE public.social_conversations SET last_message_at=now(),last_message_preview=left(body,100),updated_at=now() WHERE id=conv;
 EXCEPTION WHEN OTHERS THEN
  -- The courtesy message never decides a money movement.
  RAISE WARNING 'cashout messenger thread skipped for event %: %',NEW.id,SQLERRM;
 END;
 RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.fn_cashier_event_messenger_thread() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS cashier_event_messenger_thread ON public.accounting_cashier_events;
CREATE TRIGGER cashier_event_messenger_thread AFTER INSERT ON public.accounting_cashier_events
 FOR EACH ROW EXECUTE FUNCTION public.fn_cashier_event_messenger_thread();

-- 4. Live request state for the messenger card
CREATE OR REPLACE FUNCTION public.fn_cashout_request_card(p_cashout_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE me uuid:=auth.uid(); r public.cashout_requests%ROWTYPE; role text; allowed boolean; can_decide boolean;
BEGIN
 IF me IS NULL OR p_cashout_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.cashout_requests WHERE id=p_cashout_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 role:=public.fn_club_bank_role(r.club_id,me);
 allowed:= me=r.player_id OR me=r.agent_id OR COALESCE(role,'') IN('owner','co_owner','admin')
   OR COALESCE(public.fn_club_is_in_downline(r.club_id,me,r.player_id),false);
 IF NOT allowed THEN RETURN NULL; END IF;
 can_decide:= r.status='pending' AND me<>r.player_id
   AND COALESCE(role,'') IN('owner','co_owner','admin','super_agent','agent','sub_agent')
   AND COALESCE(public.fn_club_cashier_can_transact(r.club_id,me,r.player_id),false);
 RETURN jsonb_build_object('cashout_id',r.id,'club_id',r.club_id,
  'club_name',(SELECT name FROM public.clubs WHERE id=r.club_id),
  'player_id',r.player_id,'player_name',public.fn_notify_display_name(r.player_id),
  'agent_id',r.agent_id,'amount',round(r.amount,2)::text,'status',r.status,
  'player_note',r.player_note,'agent_note',r.agent_note,'created_at',r.created_at,
  'is_player',me=r.player_id,'can_decide',can_decide);
END $function$;
REVOKE ALL ON FUNCTION public.fn_cashout_request_card(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cashout_request_card(uuid) TO authenticated;

-- 5. Invoice attention follows the live request
CREATE OR REPLACE FUNCTION public.fn_messenger_private_invoice_attention(p_user_id uuid, p_conversation_ids uuid[])
 RETURNS TABLE(conversation_id uuid, requires_action boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_user_id IS NULL OR p_conversation_ids IS NULL OR cardinality(p_conversation_ids) = 0 OR cardinality(p_conversation_ids) > 100 THEN RAISE EXCEPTION 'Invalid Messenger invoice attention request' USING ERRCODE = '22023'; END IF;
  RETURN QUERY SELECT ac.conversation_id, COALESCE(bool_or(COALESCE(d.delivery_mode, 'immediate') <> 'weekly_detail' AND i.status IN ('pending', 'generated', 'overdue')
     AND (i.invoice_type IS DISTINCT FROM 'cashier_cashout' OR EXISTS (SELECT 1 FROM public.accounting_cashier_events ce JOIN public.cashout_requests cr ON cr.id = ce.cashout_id
        WHERE ce.invoice_id = i.id AND ce.event_kind = 'hold' AND cr.status = 'pending' AND cr.player_id <> p_user_id))), false) AS requires_action
   FROM public.accounting_conversations ac LEFT JOIN public.social_messages m ON m.conversation_id = ac.conversation_id LEFT JOIN public.accounting_invoice_deliveries d ON d.message_id = m.id AND d.recipient_id = p_user_id LEFT JOIN public.settlement_invoices i ON i.id = d.invoice_id WHERE ac.conversation_id = ANY(p_conversation_ids) AND ac.recipient_id = p_user_id AND EXISTS (SELECT 1 FROM public.club_members cm WHERE cm.club_id = ac.scope_id AND cm.user_id = p_user_id AND cm.is_active AND cm.membership_lifecycle_status = 'active' AND cm.status IN ('active', 'approved')) GROUP BY ac.conversation_id;
END
$function$;
-- Server-side reader only (the messenger API calls it with the service role).
REVOKE ALL ON FUNCTION public.fn_messenger_private_invoice_attention(uuid,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_messenger_private_invoice_attention(uuid,uuid[]) TO service_role;

COMMIT;

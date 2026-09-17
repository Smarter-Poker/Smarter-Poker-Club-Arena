-- Isolated Diamond Games invoice dependency fixture; never a production migration.
-- Definitions preserve exact captured pg_get_functiondef bytes, original owner and ACL.
-- Load after invoice-schema.sql and the original Diamond functions.sql, before policies/triggers.
-- General trigger branches remain intact; this fixture exercises only the game bank payout.

-- fn_club_bank_role; captured definition MD5 b36e67efcfaba2f867d62140322a8ed8
CREATE OR REPLACE FUNCTION public.fn_club_bank_role(p_club_id uuid, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when p_club_id is null then null
    when exists (select 1 from public.clubs c
                  where c.id = p_club_id
                    and c.owner_id = coalesce(p_user_id, auth.uid())) then 'owner'
    else (select cm.role from public.club_members cm
           where cm.club_id = p_club_id
             and cm.user_id = coalesce(p_user_id, auth.uid())
             and coalesce(cm.status, 'active') in ('active', 'approved')
           limit 1)
  end;
$function$
;
ALTER FUNCTION public.fn_club_bank_role(uuid,uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_club_bank_role(uuid,uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_club_bank_role(uuid,uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_club_bank_role(uuid,uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.fn_club_bank_role(uuid,uuid) TO "service_role";

-- fn_club_is_in_downline; captured definition MD5 7ef407fa51a823f823a6167e40488e7a
CREATE OR REPLACE FUNCTION public.fn_club_is_in_downline(p_club_id uuid, p_upline_user_id uuid, p_member_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH RECURSIVE dl AS (
    SELECT cm.user_id, 1 AS depth
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.agent_id = p_upline_user_id
       AND p_upline_user_id IS NOT NULL
       AND p_member_user_id IS NOT NULL
       AND p_upline_user_id <> p_member_user_id
    UNION
    SELECT cm.user_id, dl.depth + 1
      FROM public.club_members cm
      JOIN dl ON cm.agent_id = dl.user_id
     WHERE cm.club_id = p_club_id
       AND dl.depth < 20
  )
  SELECT EXISTS (SELECT 1 FROM dl WHERE dl.user_id = p_member_user_id);
$function$
;
ALTER FUNCTION public.fn_club_is_in_downline(uuid,uuid,uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_club_is_in_downline(uuid,uuid,uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_club_is_in_downline(uuid,uuid,uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_club_is_in_downline(uuid,uuid,uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.fn_club_is_in_downline(uuid,uuid,uuid) TO "service_role";

-- fn_club_cashier_scope; captured definition MD5 166dddd19d1419cc8b17861003e0239a
CREATE OR REPLACE FUNCTION public.fn_club_cashier_scope(p_club_id uuid, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case public.fn_club_bank_role(p_club_id, coalesce(p_user_id, auth.uid()))
    when 'owner'       then 'all'
    when 'co_owner'    then 'all'
    when 'admin'       then 'all'
    when 'super_agent' then 'downline'
    when 'agent'       then 'downline'
    when 'sub_agent'   then 'downline'
    else 'none'
  end;
$function$
;
ALTER FUNCTION public.fn_club_cashier_scope(uuid,uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_club_cashier_scope(uuid,uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_club_cashier_scope(uuid,uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_club_cashier_scope(uuid,uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.fn_club_cashier_scope(uuid,uuid) TO "service_role";

-- fn_club_cashier_can_transact; captured definition MD5 a812c44870554f37cddb36edf600e386
CREATE OR REPLACE FUNCTION public.fn_club_cashier_can_transact(p_club_id uuid, p_actor uuid, p_target uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_club_id IS NULL OR p_actor IS NULL OR p_target IS NULL THEN false
    ELSE (
      SELECT CASE s.scope
        WHEN 'all'      THEN true
        WHEN 'downline' THEN public.fn_club_is_in_downline(p_club_id, p_actor, p_target)
        ELSE false
      END
      FROM (SELECT public.fn_club_cashier_scope(p_club_id, p_actor) AS scope) s
    )
  END;
$function$
;
ALTER FUNCTION public.fn_club_cashier_can_transact(uuid,uuid,uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_club_cashier_can_transact(uuid,uuid,uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_club_cashier_can_transact(uuid,uuid,uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_club_cashier_can_transact(uuid,uuid,uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.fn_club_cashier_can_transact(uuid,uuid,uuid) TO "service_role";

-- fn_is_any_union_overseer; captured definition MD5 d028cf7f9aaf723b9552951373233cf4
CREATE OR REPLACE FUNCTION public.fn_is_any_union_overseer(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM unions u WHERE u.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM union_admins a WHERE a.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM clubs c
                WHERE COALESCE(c.is_union, false) AND c.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM club_members m
                JOIN clubs c2 ON c2.id = m.club_id AND COALESCE(c2.is_union, false)
               WHERE m.user_id = p_user_id AND m.role IN ('owner','co_owner','admin')
                 AND m.status IN ('active','approved'))
  );
$function$
;
ALTER FUNCTION public.fn_is_any_union_overseer(uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_is_any_union_overseer(uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_is_any_union_overseer(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_is_any_union_overseer(uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.fn_is_any_union_overseer(uuid) TO "service_role";

-- fn_union_oversees_club; captured definition MD5 fa80c12a2e192bc3cd4e3bea8bf65724
CREATE OR REPLACE FUNCTION public.fn_union_oversees_club(p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_club_id IS NOT NULL AND p_user_id IS NOT NULL AND public.fn_is_union_overseer(
    COALESCE(
      (SELECT uc.union_id FROM public.union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1),
      (SELECT c.union_id FROM public.clubs c WHERE c.id = p_club_id)
    ),
    p_user_id
  );
$function$
;
ALTER FUNCTION public.fn_union_oversees_club(uuid,uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_union_oversees_club(uuid,uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_union_oversees_club(uuid,uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_union_oversees_club(uuid,uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.fn_union_oversees_club(uuid,uuid) TO "service_role";

-- fn_is_club_admin_uid; captured definition MD5 021940a1e457cf22312eb139d3d05267
CREATE OR REPLACE FUNCTION public.fn_is_club_admin_uid(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members cm
    WHERE cm.club_id = p_club_id
      AND cm.user_id = auth.uid()
      AND cm.role IN ('owner','co_owner','admin','manager')
      AND COALESCE(cm.status, 'active') = 'active'
  );
$function$
;
ALTER FUNCTION public.fn_is_club_admin_uid(uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_is_club_admin_uid(uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_is_club_admin_uid(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_is_club_admin_uid(uuid) TO "service_role";
GRANT EXECUTE ON FUNCTION public.fn_is_club_admin_uid(uuid) TO "authenticated";

-- fn_is_platform_admin; captured definition MD5 ed89787c7b832e76a886734e16a27c3d
CREATE OR REPLACE FUNCTION public.fn_is_platform_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  RETURN v_role IN ('admin', 'superadmin', 'god');
END;
$function$
;
ALTER FUNCTION public.fn_is_platform_admin() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_is_platform_admin() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_is_platform_admin() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_is_platform_admin() TO "service_role";
GRANT EXECUTE ON FUNCTION public.fn_is_platform_admin() TO "authenticated";

-- is_admin; captured definition MD5 6894ad8f32e25c765121b281e75e0ba4
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','god')); $function$
;
ALTER FUNCTION public.is_admin() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.is_admin() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO "postgres";
GRANT EXECUTE ON FUNCTION public.is_admin() TO "anon";
GRANT EXECUTE ON FUNCTION public.is_admin() TO "authenticated";
GRANT EXECUTE ON FUNCTION public.is_admin() TO "service_role";

-- fn_accounting_next_invoice_number; captured definition MD5 dcb7a6315174e984f767268d04cfdb8b
CREATE OR REPLACE FUNCTION public.fn_accounting_next_invoice_number()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE y int:=extract(year FROM now() AT TIME ZONE 'America/Chicago'); n bigint;
BEGIN
 INSERT INTO public.accounting_invoice_counters(year,next_number) VALUES(y,2)
 ON CONFLICT(year) DO UPDATE SET next_number=accounting_invoice_counters.next_number+1
 RETURNING next_number-1 INTO n;
 RETURN 'CA-'||y::text||'-'||lpad(n::text,8,'0');
END $function$
;
ALTER FUNCTION public.fn_accounting_next_invoice_number() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_accounting_next_invoice_number() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_accounting_next_invoice_number() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_next_invoice_number() TO "service_role";

-- fn_accounting_party_users; captured definition MD5 2436b25400e0ee73dbbe3158fdb47b0d
CREATE OR REPLACE FUNCTION public.fn_accounting_party_users(p_kind text, p_id uuid)
 RETURNS TABLE(user_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 SELECT DISTINCT p.id FROM public.profiles p WHERE p.id IN (
  SELECT p_id WHERE p_kind IN('agent','player')
  UNION SELECT c.owner_id FROM public.clubs c WHERE p_kind='club' AND c.id=p_id
  UNION SELECT m.user_id FROM public.club_members m WHERE p_kind='club' AND m.club_id=p_id
   AND m.role IN('owner','co_owner','admin') AND COALESCE(m.status,'active') IN('active','approved')
  UNION SELECT u.owner_id FROM public.unions u WHERE p_kind='union' AND u.id=p_id
  UNION SELECT a.user_id FROM public.union_admins a WHERE p_kind='union' AND a.union_id=p_id
   AND public.fn_is_union_overseer(p_id,a.user_id)
 );
$function$
;
ALTER FUNCTION public.fn_accounting_party_users(text,uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_accounting_party_users(text,uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_accounting_party_users(text,uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_party_users(text,uuid) TO "service_role";

-- fn_deliver_accounting_invoice; captured definition MD5 8aeee5f47863f0496c9cdf86490eb084
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
ALTER FUNCTION public.fn_deliver_accounting_invoice(uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_deliver_accounting_invoice(uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_deliver_accounting_invoice(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_deliver_accounting_invoice(uuid) TO "service_role";

-- fn_invoice_accounting_ledger_transfer; captured definition MD5 dd1871aa89f1709b9b45cb16542b5fa9
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
ALTER FUNCTION public.fn_invoice_accounting_ledger_transfer(uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_invoice_accounting_ledger_transfer(uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_invoice_accounting_ledger_transfer(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_invoice_accounting_ledger_transfer(uuid) TO "service_role";

-- fn_accounting_invoice_deliver_on_insert; captured definition MD5 4fb74e8fcf5caa0294c55deeefbbc6b3
CREATE OR REPLACE FUNCTION public.fn_accounting_invoice_deliver_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 PERFORM public.fn_deliver_accounting_invoice(NEW.id);
 RETURN NEW;
END $function$
;
ALTER FUNCTION public.fn_accounting_invoice_deliver_on_insert() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_accounting_invoice_deliver_on_insert() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_accounting_invoice_deliver_on_insert() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_invoice_deliver_on_insert() TO "service_role";

-- fn_accounting_document_immutable; captured definition MD5 a8a356e5a24454bd797643f8551e48e7
CREATE OR REPLACE FUNCTION public.fn_accounting_document_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE issued boolean;
BEGIN
 IF TG_TABLE_NAME='settlement_invoices' THEN
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
END $function$
;
ALTER FUNCTION public.fn_accounting_document_immutable() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_accounting_document_immutable() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_accounting_document_immutable() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_document_immutable() TO "service_role";

-- fn_accounting_conversation_audience_guard; captured definition MD5 c2fcd73c25c19def216af801d3d1d408
CREATE OR REPLACE FUNCTION public.fn_accounting_conversation_audience_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.accounting_conversations c WHERE c.conversation_id=OLD.conversation_id)
   AND (TG_OP='DELETE' OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.user_id IS DISTINCT FROM OLD.user_id)
 THEN RAISE EXCEPTION 'accounting_conversation_audience_is_immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM public.accounting_conversations c WHERE c.conversation_id=NEW.conversation_id
    AND NEW.user_id<>ALL(ARRAY[c.sender_id,c.recipient_id]))
 THEN RAISE EXCEPTION 'accounting_conversation_audience_is_immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$
;
ALTER FUNCTION public.fn_accounting_conversation_audience_guard() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_accounting_conversation_audience_guard() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_accounting_conversation_audience_guard() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_conversation_audience_guard() TO "service_role";

-- fn_accounting_discussion_observed; captured definition MD5 453801a9093b4537bb44f0e9c0962312
CREATE OR REPLACE FUNCTION public.fn_accounting_discussion_observed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 UPDATE public.accounting_conversations SET last_discussion_at=GREATEST(last_discussion_at,NEW.created_at) WHERE conversation_id=NEW.conversation_id;
 RETURN NEW;
END $function$
;
ALTER FUNCTION public.fn_accounting_discussion_observed() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_accounting_discussion_observed() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_accounting_discussion_observed() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_discussion_observed() TO "service_role";

-- fn_accounting_agreement_capture; captured definition MD5 746fab25cd56f6ad761325e7c0d525d5
CREATE OR REPLACE FUNCTION public.fn_accounting_agreement_capture()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE b jsonb; a jsonb; identity_row jsonb; identity_key text; moved boolean;
BEGIN
 b:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE public.fn_accounting_agreement_terms(TG_TABLE_NAME,to_jsonb(OLD)) END;
 a:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE public.fn_accounting_agreement_terms(TG_TABLE_NAME,to_jsonb(NEW)) END;
 IF b IS NOT DISTINCT FROM a THEN RETURN COALESCE(NEW,OLD); END IF;
 identity_row:=COALESCE(b,a);
 identity_key:=CASE WHEN TG_TABLE_NAME='club_members' THEN identity_row->>'club_id'||':'||(identity_row->>'user_id') ELSE identity_row->>'id' END;
 moved:=TG_OP='UPDATE' AND (b->>'id' IS DISTINCT FROM a->>'id'
   OR b->>'club_id' IS DISTINCT FROM a->>'club_id' OR b->>'user_id' IS DISTINCT FROM a->>'user_id');
 INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,actor_id,before_terms,after_terms)
 VALUES(TG_TABLE_NAME,identity_key,(identity_row->>'club_id')::uuid,(identity_row->>'user_id')::uuid,TG_OP,auth.uid(),b,CASE WHEN moved THEN NULL ELSE a END);
 -- A moved identity closes its original key and establishes the new key too.
 -- Both changes are observed in this transaction; neither is backdated.
 IF moved THEN
   identity_key:=CASE WHEN TG_TABLE_NAME='club_members' THEN a->>'club_id'||':'||(a->>'user_id') ELSE a->>'id' END;
   INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,actor_id,before_terms,after_terms)
   VALUES(TG_TABLE_NAME,identity_key,(a->>'club_id')::uuid,(a->>'user_id')::uuid,'UPDATE',auth.uid(),NULL,a);
 END IF;
 RETURN COALESCE(NEW,OLD);
END $function$
;
ALTER FUNCTION public.fn_accounting_agreement_capture() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_accounting_agreement_capture() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_accounting_agreement_capture() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_agreement_capture() TO "service_role";

-- fn_accounting_credit_document_on_insert; captured definition MD5 64b3c2467897361d25e4646613ca6b7d
CREATE OR REPLACE FUNCTION public.fn_accounting_credit_document_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END $function$
;
ALTER FUNCTION public.fn_accounting_credit_document_on_insert() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_accounting_credit_document_on_insert() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_accounting_credit_document_on_insert() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_credit_document_on_insert() TO "service_role";

-- fn_agents_staff_earn_no_rakeback; captured definition MD5 17346b77ec8f5a1d6d42dca3eb06e061
CREATE OR REPLACE FUNCTION public.fn_agents_staff_earn_no_rakeback()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = NEW.club_id AND cm.user_id = NEW.user_id
       AND cm.role IN ('co_owner', 'admin')
  ) THEN
    -- The row survives: it is also the agent wallet. Only the rate goes to zero.
    NEW.commission_rate      := 0;
    NEW.player_rakeback_rate := 0;
  END IF;
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_agents_staff_earn_no_rakeback() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_agents_staff_earn_no_rakeback() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_agents_staff_earn_no_rakeback() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_agents_staff_earn_no_rakeback() TO "service_role";

-- fn_block_message_field_reassignment; captured definition MD5 062e3e25130dc0e627f1f442be26d6a2
CREATE OR REPLACE FUNCTION public.fn_block_message_field_reassignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Service role is the maintenance path and bypasses field locks.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.sender_id IS DISTINCT FROM OLD.sender_id THEN
    RAISE EXCEPTION 'sender_id cannot be changed on an existing message'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
    RAISE EXCEPTION 'conversation_id cannot be changed on an existing message'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'created_at cannot be changed on an existing message'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_block_message_field_reassignment() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_block_message_field_reassignment() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_block_message_field_reassignment() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_block_message_field_reassignment() TO "service_role";

-- fn_ca_autoledger_delete; captured definition MD5 c6d7e02df8b654fbccc3e8844418bd01
CREATE OR REPLACE FUNCTION public.fn_ca_autoledger_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  spec text; col text; acct text;
  o jsonb; oldv numeric;
  v_club uuid; v_union uuid; v_entity uuid; actor uuid;
  v_st text; v_msg text;
BEGIN
  IF current_setting('app.ledger_autoskip_' || TG_TABLE_NAME, true) = '1' THEN
    RETURN OLD;
  END IF;

  o := to_jsonb(OLD);
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  v_club := CASE
    WHEN TG_TABLE_NAME = 'clubs' THEN (o->>'id')::uuid
    WHEN o ? 'club_id' THEN NULLIF(o->>'club_id','')::uuid
    ELSE NULL END;
  v_union := CASE
    WHEN TG_TABLE_NAME = 'unions' THEN (o->>'id')::uuid
    WHEN o ? 'union_id' THEN NULLIF(o->>'union_id','')::uuid
    ELSE NULL END;
  v_entity := CASE
    WHEN TG_TABLE_NAME IN ('agents','club_members') THEN NULLIF(o->>'user_id','')::uuid
    ELSE COALESCE(NULLIF(o->>'id','')::uuid, v_club, v_union) END;

  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    col  := split_part(spec, '=', 1);
    acct := split_part(spec, '=', 2);
    oldv := round(COALESCE(NULLIF(o->>col,'')::numeric, 0), 2);
    CONTINUE WHEN oldv = 0;

    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, union_id, description,
         pre_from_balance, post_from_balance)
      VALUES (actor,
        acct, v_entity, TG_TABLE_NAME || '.' || col,
        'chip_retirement', NULL, NULL,
        abs(oldv), CASE WHEN oldv > 0 THEN 'burn' ELSE 'correction' END,
        v_club, v_union,
        'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' balance ' || oldv::text
          || ' retired on row delete',
        oldv, 0);
    EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;
  END LOOP;

  RETURN OLD;
END $function$
;
ALTER FUNCTION public.fn_ca_autoledger_delete() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_ca_autoledger_delete() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_ca_autoledger_delete() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_ca_autoledger_delete() TO "service_role";

-- fn_ca_reject_automated_user_club_row; captured definition MD5 7c73094df30c90f94a78cbbd5d24f504
CREATE OR REPLACE FUNCTION public.fn_ca_reject_automated_user_club_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club_id uuid;
  v_user_id uuid;
  v_automated boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'club_members' THEN
    v_club_id := NEW.club_id;
    v_user_id := NEW.user_id;
    v_automated := COALESCE(NEW.is_bot, false);
  ELSIF TG_TABLE_NAME = 'agents' THEN
    v_club_id := NEW.club_id;
    v_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'table_seats' THEN
    -- A historical/departed seat remains immutable evidence. Only a live seat
    -- can put an automated player back onto a user-created club table.
    IF NEW.left_at IS NOT NULL THEN RETURN NEW; END IF;
    SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.table_id;
    v_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    SELECT t.club_id INTO v_club_id
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    v_user_id := NEW.user_id;
  ELSE
    RAISE EXCEPTION 'Unsupported Automated-Club Guard Table: %', TG_TABLE_NAME;
  END IF;

  v_automated := v_automated OR COALESCE(
    (SELECT p.is_horse FROM public.profiles p WHERE p.id = v_user_id), false
  );

  IF v_automated AND NOT public.fn_ca_house_board_allows_automation(v_club_id) THEN
    RAISE EXCEPTION 'AUTOMATED_PLAYER_HOUSE_BOARD_ONLY: Automated Players Cannot Enter A User-Created Club'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_ca_reject_automated_user_club_row() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_ca_reject_automated_user_club_row() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_ca_reject_automated_user_club_row() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_ca_reject_automated_user_club_row() TO "service_role";

-- fn_deep_stack_society_cannot_be_deleted_by_accident; captured definition MD5 213a7fa40330c703cb23dc001a99d31e
CREATE OR REPLACE FUNCTION public.fn_deep_stack_society_cannot_be_deleted_by_accident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_allowed boolean := COALESCE(current_setting('app.deep_stack_teardown', true), '') = 'on';
  v_query   text;
BEGIN
  SELECT a.query INTO v_query
    FROM pg_stat_activity a WHERE a.pid = pg_backend_pid();

  INSERT INTO public.deep_stack_delete_attempts
    (source_table, allowed, db_user, db_role, application, client_addr, backend_pid, running_query, old_row)
  VALUES
    (TG_TABLE_NAME, v_allowed, session_user, current_user,
     current_setting('application_name', true), host(COALESCE(inet_client_addr(), '0.0.0.0'::inet)),
     pg_backend_pid(), left(COALESCE(v_query, ''), 4000), to_jsonb(OLD));

  IF NOT v_allowed THEN
    RAISE EXCEPTION
      'DEEP_STACK_PROTECTED: this row belongs to Deep Stack Society (club 11192) and is not deletable'
      USING ERRCODE = '42501',
            HINT = 'The whole club was deleted once with no audit trail. Set app.deep_stack_teardown = ''on'' for your transaction if you really mean it.';
  END IF;

  RETURN OLD;
END;
$function$
;
ALTER FUNCTION public.fn_deep_stack_society_cannot_be_deleted_by_accident() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_deep_stack_society_cannot_be_deleted_by_accident() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_deep_stack_society_cannot_be_deleted_by_accident() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_deep_stack_society_cannot_be_deleted_by_accident() TO "service_role";

-- fn_enforce_agent_commission_bounds; captured definition MD5 3e4f5df422b121391cc40f711ae5b5ee
CREATE OR REPLACE FUNCTION public.fn_enforce_agent_commission_bounds()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_min numeric; v_max numeric; v_rate numeric;
BEGIN
  IF NEW.commission_rate IS NULL THEN RETURN NEW; END IF;

  -- THE RATE IS NOT CHANGING, SO THERE IS NOTHING TO JUDGE.
  -- This trigger is BEFORE UPDATE OF commission_rate, and Postgres fires that
  -- for any UPDATE whose SET list names the column, identical value or not.
  -- Without this, an unrelated write - a status change, a demotion, a parent
  -- reassignment - re-validates a rate nobody touched against a band the row
  -- may never have satisfied, and raises P0001 into a caller that has no idea
  -- why. It is how demoting a co-owner to player failed outright in any club
  -- under a union with a non-zero minimum.
  IF TG_OP = 'UPDATE' AND NEW.commission_rate IS NOT DISTINCT FROM OLD.commission_rate THEN
    RETURN NEW;
  END IF;

  -- A co-owner and an admin earn nothing, by Dan's rule and by
  -- trg_agents_staff_earn_no_rakeback, which sets both of their rates to zero.
  -- The union band says what an EARNING agent may be paid, so it has nothing to
  -- say about a row that is forbidden to earn.
  IF NEW.commission_rate = 0 AND EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = NEW.club_id
       AND cm.user_id = NEW.user_id
       AND cm.role IN ('co_owner', 'admin')
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(uc.union_id, c.union_id) INTO v_union
    FROM clubs c LEFT JOIN union_clubs uc ON uc.club_id = c.id
   WHERE c.id = NEW.club_id LIMIT 1;

  IF v_union IS NULL THEN RETURN NEW; END IF;   -- standalone club: no policy

  v_min := public.fn_union_setting(v_union, 'min_agent_commission', 0);
  v_max := public.fn_union_setting(v_union, 'max_agent_commission', 1);

  -- Rates may be expressed as a fraction (0.5) or whole percent (50).
  v_rate := CASE WHEN NEW.commission_rate > 1 THEN NEW.commission_rate / 100.0
                 ELSE NEW.commission_rate END;

  IF v_rate < v_min OR v_rate > v_max THEN
    RAISE EXCEPTION 'agent commission % is outside the union policy band (% .. %)',
      v_rate, v_min, v_max
      USING HINT = 'Change unions.settings.min_agent_commission / max_agent_commission to widen the band.';
  END IF;

  RETURN NEW;
END $function$
;
ALTER FUNCTION public.fn_enforce_agent_commission_bounds() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_enforce_agent_commission_bounds() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_enforce_agent_commission_bounds() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_enforce_agent_commission_bounds() TO "service_role";

-- fn_guard_retired_club_mutation; captured definition MD5 b82be212e7ccf2a15637c231861ff993
CREATE OR REPLACE FUNCTION public.fn_guard_retired_club_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club_id uuid;
  v_old_club_id uuid;
  v_maintenance boolean :=
    auth.uid() IS NULL
    AND coalesce(current_setting('app.club_retirement_maintenance', true), '') = 'on';
BEGIN
  IF v_maintenance THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := OLD.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = OLD.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t
       WHERE t.id = OLD.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr
       WHERE cr.id = OLD.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
    ELSE
      v_club_id := OLD.club_id;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := NEW.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t
       WHERE t.id = NEW.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr
       WHERE cr.id = NEW.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = NEW.agent_id;
    ELSE
      v_club_id := NEW.club_id;
    END IF;

    -- On UPDATE, check the source scope too. Moving a retained row to an active
    -- club must not become an escape hatch from a retired club's write freeze.
    IF TG_OP = 'UPDATE' THEN
      IF TG_TABLE_NAME = 'unions' THEN
        v_old_club_id := OLD.id;
      ELSIF TG_TABLE_NAME = 'table_seats' THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tables t WHERE t.id = OLD.table_id;
      ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tournaments t
         WHERE t.id = OLD.tournament_id;
      ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
        SELECT cr.club_id INTO v_old_club_id FROM public.cashout_requests cr
         WHERE cr.id = OLD.cashout_request_id;
      ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
        SELECT a.club_id INTO v_old_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
      ELSE
        v_old_club_id := OLD.club_id;
      END IF;
    END IF;
  END IF;

  -- A union row can use a club UUID without an FK back to clubs. Serialize
  -- that conversion with the retirement RPC so it cannot create a union
  -- identity from a club that became retired in the same instant.
  IF TG_TABLE_NAME = 'unions' AND v_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('cashier-hierarchy:' || v_club_id::text, 0)
    );
  END IF;

  IF (v_club_id IS NOT NULL OR v_old_club_id IS NOT NULL) AND EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id IN (v_club_id, v_old_club_id) AND c.lifecycle_status = 'retired'
  ) THEN
    RAISE EXCEPTION 'CLUB_RETIRED: gameplay and cashier records are read-only'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$
;
ALTER FUNCTION public.fn_guard_retired_club_mutation() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_guard_retired_club_mutation() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_guard_retired_club_mutation() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_guard_retired_club_mutation() TO "service_role";

-- fn_mirror_notification_to_push_outbox; captured definition MD5 a726e393ab7ef02aa7a5a9f0622bee64
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
END $function$
;
ALTER FUNCTION public.fn_mirror_notification_to_push_outbox() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_mirror_notification_to_push_outbox() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_mirror_notification_to_push_outbox() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_mirror_notification_to_push_outbox() TO "service_role";

-- fn_notification_action_url; captured definition MD5 b9120a5238a41e1960da7ac244493dab
CREATE OR REPLACE FUNCTION public.fn_notification_action_url(p_type text, p_data jsonb, p_metadata jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
    d          jsonb := COALESCE(p_metadata, '{}'::jsonb) || COALESCE(p_data, '{}'::jsonb);
    t          text  := COALESCE(btrim(p_type), '');
    ca         text  := '/hub/club-arena';
    v_table    text  := COALESCE(d->>'table_id',      d->>'tableId');
    v_union    text  := COALESCE(d->>'union_id',      d->>'unionId');
    v_club     text  := COALESCE(d->>'club_id',       d->>'clubId');
    v_post     text  := COALESCE(d->>'post_id',       d->>'postId');
    v_tourn    text  := COALESCE(d->>'tournament_id', d->>'tournamentId');
    v_convo    text  := COALESCE(d->>'conversation_id', d->>'conversationId');
    v_pagetype text  := COALESCE(d->>'page_type',     d->>'pageType');
    v_pageid   text  := COALESCE(d->>'page_id',       d->>'pageId');
    v_sender   text  := COALESCE(d->>'sender_id',     d->>'actor_id', d->>'senderId');
    v_username text;
    v_is_reel  boolean := (d->>'is_reel') = 'true' OR (d->>'post_type') = 'reel';
BEGIN
    IF t IN ('waitlist_seat_open','seat_available','waitlist_ready','table_ready') THEN
        RETURN CASE WHEN v_table IS NOT NULL THEN ca || '/table/' || v_table ELSE ca || '/waitlist' END;
    END IF;
    IF t IN ('table_invite','your_turn','your_turn_reminder','time_bank_active','hand_won') THEN
        RETURN CASE WHEN v_table IS NOT NULL THEN ca || '/table/' || v_table ELSE NULL END;
    END IF;
    IF t IN ('tournament_starting','tournament_start','tournament_registered') THEN
        RETURN CASE WHEN v_tourn IS NOT NULL THEN ca || '/tournaments/' || v_tourn ELSE ca || '/tournaments' END;
    END IF;
    IF t = 'union_invoice' THEN
        RETURN CASE WHEN v_union IS NOT NULL THEN ca || '/unions/' || v_union || '/statements' ELSE ca || '/unions' END;
    END IF;
    IF t IN ('settlement','settlement_failed') THEN
        IF v_union IS NOT NULL THEN RETURN ca || '/unions/' || v_union || '/settlement'; END IF;
        IF v_club  IS NOT NULL THEN RETURN ca || '/clubs/'  || v_club  || '/settlement'; END IF;
        RETURN ca || '/settlement-dashboard';
    END IF;
    IF t IN ('cashout_request','cashout_approved','cashout_denied') THEN
        RETURN CASE WHEN v_club IS NOT NULL THEN ca || '/clubs/' || v_club || '/financials' ELSE ca || '/wallet' END;
    END IF;
    IF t IN ('club_announcement','club_invite') THEN
        RETURN CASE WHEN v_club IS NOT NULL THEN ca || '/clubs/' || v_club ELSE NULL END;
    END IF;
    IF t IN ('bonus','promotion','rakeback') THEN
        RETURN CASE WHEN v_club IS NOT NULL THEN ca || '/clubs/' || v_club || '/promotions' ELSE ca || '/bonuses' END;
    END IF;
    IF t IN ('achievement','achievement_unlocked') THEN
        RETURN ca || '/achievements';
    END IF;
    IF t IN ('like','comment','mention','post_like','post_comment','reply','tag') THEN
        IF v_post IS NOT NULL THEN
            RETURN CASE WHEN v_is_reel THEN '/hub/reels?id=' || v_post ELSE '/hub/social-media?post=' || v_post END;
        END IF;
        RETURN '/hub/social-media';
    END IF;
    IF t IN ('friend_request','friend_accept','friend_accepted','new_follow','follow','follow_request') THEN
        IF v_sender IS NOT NULL THEN
            BEGIN
                SELECT username INTO v_username FROM public.profiles WHERE id = v_sender::uuid LIMIT 1;
            EXCEPTION WHEN OTHERS THEN
                v_username := NULL;
            END;
        END IF;
        RETURN CASE WHEN v_username IS NOT NULL AND btrim(v_username) <> ''
                    THEN '/hub/user/' || public.fn_url_encode_segment(v_username)
                    ELSE '/hub/friends' END;
    END IF;
    IF t IN ('message','direct_message','new_message') THEN
        RETURN CASE WHEN v_convo IS NOT NULL THEN '/hub/messenger?conversation=' || v_convo ELSE '/hub/messenger' END;
    END IF;
    IF v_pagetype IS NOT NULL AND v_pageid IS NOT NULL THEN
        IF v_pagetype = 'venue'  THEN RETURN '/hub/venues/' || v_pageid; END IF;
        IF v_pagetype = 'tour'   THEN RETURN '/hub/tours/'  || v_pageid; END IF;
        IF v_pagetype = 'series' THEN RETURN '/hub/series/' || v_pageid; END IF;
        RETURN '/club/' || v_pageid;
    END IF;
    IF v_club   IS NOT NULL THEN RETURN '/club/' || v_club; END IF;
    IF v_pageid IS NOT NULL THEN RETURN '/hub/social-pages/' || v_pageid; END IF;
    IF v_post   IS NOT NULL THEN
        RETURN CASE WHEN v_is_reel THEN '/hub/reels?id=' || v_post ELSE '/hub/social-media?post=' || v_post END;
    END IF;
    IF v_tourn  IS NOT NULL THEN RETURN ca || '/tournaments/' || v_tourn; END IF;
    IF v_table  IS NOT NULL THEN RETURN ca || '/table/' || v_table; END IF;
    RETURN NULL;
END $function$
;
ALTER FUNCTION public.fn_notification_action_url(text,jsonb,jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_notification_action_url(text,jsonb,jsonb) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_notification_action_url(text,jsonb,jsonb) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_notification_action_url(text,jsonb,jsonb) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_notification_action_url(text,jsonb,jsonb) TO "anon";
GRANT EXECUTE ON FUNCTION public.fn_notification_action_url(text,jsonb,jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.fn_notification_action_url(text,jsonb,jsonb) TO "service_role";

-- fn_notification_fill_action_url; captured definition MD5 75cf1f6fe863aa76a27bb7f6889f6b4f
CREATE OR REPLACE FUNCTION public.fn_notification_fill_action_url()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NULLIF(btrim(COALESCE(NEW.link, '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(NEW.action_url, '')), '') IS NULL THEN
        BEGIN
            NEW.action_url := public.fn_notification_action_url(NEW.type, NEW.data, NEW.metadata);
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'fn_notification_fill_action_url failed for type %: %', NEW.type, SQLERRM;
        END;
    END IF;
    RETURN NEW;
END $function$
;
ALTER FUNCTION public.fn_notification_fill_action_url() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_notification_fill_action_url() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_notification_fill_action_url() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_notification_fill_action_url() TO "service_role";

-- fn_poker_reject_diamond_hierarchy; captured definition MD5 49037a2bf4322d2a327bc9141a7a7a89
CREATE OR REPLACE FUNCTION public.fn_poker_reject_diamond_hierarchy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id=NEW.club_id AND asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Arena Has No Agents Or Commissions' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$
;
ALTER FUNCTION public.fn_poker_reject_diamond_hierarchy() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_poker_reject_diamond_hierarchy() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_poker_reject_diamond_hierarchy() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_poker_reject_diamond_hierarchy() TO "service_role";

-- fn_update_conversation_last_message; captured definition MD5 e7c6e6e94b5895f256d4dce018789e65
DO $invoice_exact_definition$
BEGIN
  EXECUTE E'CREATE OR REPLACE FUNCTION public.fn_update_conversation_last_message()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO ''public'', ''extensions''\nAS $function$\nBEGIN\n    UPDATE social_conversations\n    SET \n        last_message_at = NEW.created_at,\n        last_message_preview = LEFT(NEW.content, 100),\n        updated_at = now()\n    WHERE id = NEW.conversation_id;\n    RETURN NEW;\nEND;\n$function$\n';
END
$invoice_exact_definition$;
ALTER FUNCTION public.fn_update_conversation_last_message() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_update_conversation_last_message() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_update_conversation_last_message() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_update_conversation_last_message() TO "service_role";

-- fn_url_encode_segment; captured definition MD5 b8ad06c73720e2bf56326c3cd3d05cc6
CREATE OR REPLACE FUNCTION public.fn_url_encode_segment(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
    SELECT CASE WHEN p IS NULL THEN NULL ELSE COALESCE((
        SELECT string_agg(
            CASE WHEN s.c ~ '^[A-Za-z0-9._~-]$' THEN s.c
                 ELSE (SELECT string_agg('%' || upper(lpad(to_hex(get_byte(convert_to(s.c,'UTF8'), i)), 2, '0')), '')
                       FROM generate_series(0, octet_length(convert_to(s.c,'UTF8')) - 1) AS i)
            END, '' ORDER BY s.ord)
        FROM regexp_split_to_table(p, '') WITH ORDINALITY AS s(c, ord)
    ), '') END;
$function$
;
ALTER FUNCTION public.fn_url_encode_segment(text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_url_encode_segment(text) FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.fn_url_encode_segment(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_url_encode_segment(text) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_url_encode_segment(text) TO "anon";
GRANT EXECUTE ON FUNCTION public.fn_url_encode_segment(text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.fn_url_encode_segment(text) TO "service_role";

-- guard_agent_wallet_direct_update; captured definition MD5 736aa9e92265453c3015223562108141
CREATE OR REPLACE FUNCTION public.guard_agent_wallet_direct_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if current_user in ('authenticated','anon') then
    if tg_op='INSERT' and (
      coalesce(new.agent_wallet_balance,0)<>0 or coalesce(new.business_balance,0)<>0 or
      coalesce(new.player_wallet_balance,0)<>0 or coalesce(new.player_balance,0)<>0 or
      coalesce(new.promo_wallet_balance,0)<>0 or coalesce(new.promo_balance,0)<>0 or
      coalesce(new.credit_limit,0)<>0 or coalesce(new.credit_used,0)<>0 or
      coalesce(new.commission_rate,0)<>0 or coalesce(new.player_rakeback_rate,0)<>0
    ) then
      raise exception 'Agent financial accounts may only be created through authorized operations';
    elsif tg_op='UPDATE' and (
      new.agent_wallet_balance is distinct from old.agent_wallet_balance or
      new.business_balance is distinct from old.business_balance or
      new.player_wallet_balance is distinct from old.player_wallet_balance or
      new.player_balance is distinct from old.player_balance or
      new.promo_wallet_balance is distinct from old.promo_wallet_balance or
      new.promo_balance is distinct from old.promo_balance or
      new.credit_limit is distinct from old.credit_limit or
      new.credit_used is distinct from old.credit_used or
      new.commission_rate is distinct from old.commission_rate or
      new.player_rakeback_rate is distinct from old.player_rakeback_rate
    ) then
      raise exception 'Agent financial accounts may only change through authorized operations';
    end if;
  end if;
  return new;
end
$function$
;
ALTER FUNCTION public.guard_agent_wallet_direct_update() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.guard_agent_wallet_direct_update() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.guard_agent_wallet_direct_update() TO "postgres";
GRANT EXECUTE ON FUNCTION public.guard_agent_wallet_direct_update() TO "service_role";

-- sync_agent_wallet_columns; captured definition MD5 3a3d351dd05b5dc13b525b7eb4635e5c
CREATE OR REPLACE FUNCTION public.sync_agent_wallet_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$ BEGIN IF NEW.agent_wallet_balance IS DISTINCT FROM OLD.agent_wallet_balance THEN NEW.business_balance := NEW.agent_wallet_balance; ELSIF NEW.business_balance IS DISTINCT FROM OLD.business_balance THEN NEW.agent_wallet_balance := NEW.business_balance; END IF; IF NEW.player_wallet_balance IS DISTINCT FROM OLD.player_wallet_balance THEN NEW.player_balance := NEW.player_wallet_balance; ELSIF NEW.player_balance IS DISTINCT FROM OLD.player_balance THEN NEW.player_wallet_balance := NEW.player_balance; END IF; IF NEW.promo_wallet_balance IS DISTINCT FROM OLD.promo_wallet_balance THEN NEW.promo_balance := NEW.promo_wallet_balance; ELSIF NEW.promo_balance IS DISTINCT FROM OLD.promo_balance THEN NEW.promo_wallet_balance := NEW.promo_balance; END IF; RETURN NEW; END; $function$
;
ALTER FUNCTION public.sync_agent_wallet_columns() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.sync_agent_wallet_columns() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.sync_agent_wallet_columns() TO "postgres";
GRANT EXECUTE ON FUNCTION public.sync_agent_wallet_columns() TO "service_role";

-- sync_notification_read_state; captured definition MD5 c90c577563f3d7a4ac6cfe2ab75df629
CREATE OR REPLACE FUNCTION public.sync_notification_read_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_read boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_read := COALESCE(NEW.read_at IS NOT NULL, false) OR COALESCE(NEW.is_read, false) OR COALESCE(NEW.read, false);
  ELSE
    IF (NEW.read_at IS DISTINCT FROM OLD.read_at) THEN v_read := NEW.read_at IS NOT NULL;
    ELSIF (NEW.is_read IS DISTINCT FROM OLD.is_read) THEN v_read := COALESCE(NEW.is_read, false);
    ELSIF (NEW.read IS DISTINCT FROM OLD.read) THEN v_read := COALESCE(NEW.read, false);
    ELSE v_read := COALESCE(NEW.read_at IS NOT NULL, false) OR COALESCE(NEW.is_read, false) OR COALESCE(NEW.read, false);
    END IF;
  END IF;
  NEW.is_read := v_read; NEW.read := v_read;
  IF v_read THEN NEW.read_at := COALESCE(NEW.read_at, now()); ELSE NEW.read_at := NULL; END IF;
  RETURN NEW;
END; $function$
;
ALTER FUNCTION public.sync_notification_read_state() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.sync_notification_read_state() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.sync_notification_read_state() TO "postgres";
GRANT EXECUTE ON FUNCTION public.sync_notification_read_state() TO "service_role";

-- trg_claim_tournament_reminder; captured definition MD5 e086e31234939947973c12f857b598e9
CREATE OR REPLACE FUNCTION public.trg_claim_tournament_reminder()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_start timestamptz;
  v_name text;
  v_stage text;
  v_due timestamptz;
  v_expires timestamptz;
  v_tag text;
  v_seated boolean;
  v_claimed boolean;
BEGIN
  IF NEW.event NOT IN ('tournament_reminder_15m', 'tournament_reminder_2m')
     OR NEW.event IS NULL THEN RETURN NEW; END IF;
  IF NEW.status != 'pending' THEN RETURN NEW; END IF;
  -- A reminder needs a device to reach. Reachability, never species: the same
  -- line refuses a human with no subscription and admits a horse with one.
  -- No receipt is claimed here - see the header.
  IF NOT EXISTS (SELECT 1 FROM public.push_subscriptions s
    WHERE s.user_id = NEW.recipient_user_id AND s.is_active) THEN RETURN NULL; END IF;
  v_stage := CASE NEW.event WHEN 'tournament_reminder_15m' THEN '15m' ELSE '2m' END;
  v_tournament := NEW.related_entity_id;
  IF v_tournament IS NULL THEN
    v_tournament := substring(NEW.url FROM '/tournaments/([0-9a-fA-F-]{36})$')::uuid;
  END IF;
  SELECT t.start_time, t.name INTO v_start, v_name
  FROM public.tournaments t
  WHERE t.id = v_tournament AND t.status IN ('ANNOUNCED', 'REGISTERING')
    AND t.game_type != 'spin'
    AND EXISTS (SELECT 1 FROM public.tournament_players tp
      WHERE tp.tournament_id = t.id AND tp.user_id = NEW.recipient_user_id
        AND tp.status IN ('registered', 'playing'));
  IF NOT FOUND OR v_start IS NULL THEN RETURN NULL; END IF;
  v_due := v_start - CASE v_stage WHEN '15m' THEN interval '15 minutes' ELSE interval '2 minutes' END;
  v_expires := v_start - CASE v_stage WHEN '15m' THEN interval '2 minutes' ELSE interval '0' END;
  IF now() < v_due OR now() >= v_expires THEN RETURN NULL; END IF;
  v_tag := 'tr:' || v_tournament || ':' || (extract(epoch FROM v_start) * 1000)::bigint || ':' || v_stage;
  -- An intent selected before a concurrent reschedule cannot acquire its new version.
  IF NEW.tag IS NOT NULL AND NEW.tag != v_tag THEN RETURN NULL; END IF;
  SELECT EXISTS (SELECT 1 FROM public.table_seats ts
    WHERE ts.user_id = NEW.recipient_user_id AND ts.left_at IS NULL) INTO v_seated;
  INSERT INTO public.tournament_reminder_receipts
    (tournament_id, recipient_user_id, scheduled_start_at, stage, outcome, outbox_id)
  VALUES (v_tournament, NEW.recipient_user_id, v_start, v_stage,
    CASE WHEN v_seated THEN 'seated' ELSE 'queued' END,
    CASE WHEN v_seated THEN NULL ELSE NEW.id END)
  ON CONFLICT DO NOTHING RETURNING true INTO v_claimed;
  IF v_claimed IS NOT TRUE OR v_seated THEN RETURN NULL; END IF;
  NEW.related_entity_id := v_tournament;
  NEW.tag := v_tag;
  NEW.url := '/hub/club-arena/tournaments/' || v_tournament;
  NEW.title := 'Tournament Starting Soon';
  NEW.body := CASE v_stage WHEN '15m'
    THEN 'Your Tournament "' || v_name || '" Starts In 15 Minutes!'
    ELSE 'Get Ready! "' || v_name || '" Starts In 2 Minutes!' END;
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.trg_claim_tournament_reminder() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.trg_claim_tournament_reminder() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.trg_claim_tournament_reminder() TO "postgres";
GRANT EXECUTE ON FUNCTION public.trg_claim_tournament_reminder() TO "service_role";

-- trg_fn_live_invite_notification; captured definition MD5 6b52de626a63699541e21df2fe871b60
CREATE OR REPLACE FUNCTION public.trg_fn_live_invite_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_recipient_id uuid;
    v_sender_name text;
BEGIN
    -- Only trigger for [LIVE_INVITE] messages
    IF NEW.content IS NOT NULL AND NEW.content LIKE '[LIVE_INVITE]%' THEN
        -- Find the recipient (the other participant in the direct conversation)
        SELECT user_id INTO v_recipient_id
        FROM public.social_conversation_participants
        WHERE conversation_id = NEW.conversation_id AND user_id != NEW.sender_id
        LIMIT 1;

        -- Get the sender's name
        SELECT COALESCE(full_name, username, 'Someone') INTO v_sender_name
        FROM public.profiles
        WHERE id = NEW.sender_id;

        IF v_recipient_id IS NOT NULL THEN
            -- Insert the notification record
            INSERT INTO public.notifications (
                user_id,
                type,
                title,
                message,
                data,
                read
            ) VALUES (
                v_recipient_id,
                'live_invite',
                'Live Stream Invite',
                v_sender_name || ' invited you to join their live stream as a guest co-host.',
                jsonb_build_object(
                    'conversation_id', NEW.conversation_id,
                    'message_id', NEW.id,
                    'content', NEW.content,
                    'sender_name', v_sender_name
                ),
                false
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.trg_fn_live_invite_notification() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.trg_fn_live_invite_notification() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.trg_fn_live_invite_notification() TO "postgres";
GRANT EXECUTE ON FUNCTION public.trg_fn_live_invite_notification() TO "service_role";

-- zz_closed_period_is_immutable; captured definition MD5 7c50bd632593b3f79950049b427cbd70
CREATE OR REPLACE FUNCTION public.zz_closed_period_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'closed' AND NOT COALESCE(public.fn_is_platform_admin(), false) THEN
      RAISE EXCEPTION 'PERIOD_CLOSED: settlement period % is closed and cannot be deleted', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'closed' AND NOT COALESCE(public.fn_is_platform_admin(), false) THEN
    IF NEW.status                 IS DISTINCT FROM OLD.status
       OR NEW.club_id             IS DISTINCT FROM OLD.club_id
       OR NEW.union_id            IS DISTINCT FROM OLD.union_id
       OR NEW.start_at            IS DISTINCT FROM OLD.start_at
       OR NEW.end_at              IS DISTINCT FROM OLD.end_at
       OR NEW.settled_at          IS DISTINCT FROM OLD.settled_at
       OR NEW.total_rake_collected     IS DISTINCT FROM OLD.total_rake_collected
       OR NEW.total_commissions_paid   IS DISTINCT FROM OLD.total_commissions_paid
       OR NEW.total_player_winnings    IS DISTINCT FROM OLD.total_player_winnings
       OR NEW.total_player_losses      IS DISTINCT FROM OLD.total_player_losses
       OR NEW.total_bbj_contributions  IS DISTINCT FROM OLD.total_bbj_contributions
    THEN
      RAISE EXCEPTION
        'PERIOD_CLOSED: settlement period % is closed. Correct it forward with an adjusting entry; do not edit a closed period.',
        OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END $function$
;
ALTER FUNCTION public.zz_closed_period_is_immutable() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.zz_closed_period_is_immutable() FROM PUBLIC,"anon","authenticated","postgres","service_role";
GRANT EXECUTE ON FUNCTION public.zz_closed_period_is_immutable() TO "postgres";
GRANT EXECUTE ON FUNCTION public.zz_closed_period_is_immutable() TO "authenticated";
GRANT EXECUTE ON FUNCTION public.zz_closed_period_is_immutable() TO "service_role";

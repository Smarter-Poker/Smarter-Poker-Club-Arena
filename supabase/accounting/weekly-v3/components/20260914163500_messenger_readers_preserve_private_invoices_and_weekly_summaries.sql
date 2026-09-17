-- SOURCE CANDIDATE ONLY. UNRUN / UNAPPLIED. Club Arena owner integrates this
-- outside the sealed accounting and monitoring candidates, after source review.
-- Existing participants and genuine discussion messages are not changed.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $guard$
DECLARE r record; expected text; actual text; target_proc_oid regprocedure;
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'messenger_privacy_owner_required'; END IF;
 IF md5(pg_get_functiondef('public.fn_caller_is_engine()'::regprocedure))
    IS DISTINCT FROM 'd9a70f1d932538025e656bfe2b4d091d'
 THEN RAISE EXCEPTION 'messenger_engine_authority_changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('anon','authenticated')
    AND (rolsuper OR rolbypassrls OR pg_has_role(rolname,'service_role','USAGE')))
 THEN RAISE EXCEPTION 'messenger_client_role_bypasses_privacy'; END IF;
 FOR r IN SELECT unnest(ARRAY['social_messages','social_conversations','settlement_invoices',
          'accounting_invoice_deliveries','notifications']) AS name LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=r.name AND c.relkind='r'
      AND c.relowner='postgres'::regrole AND c.relrowsecurity AND NOT c.relforcerowsecurity)
   THEN RAISE EXCEPTION 'messenger_table_authority_changed: %',r.name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN('fn_messenger_invoice_visible_to',
      'fn_messenger_message_visible_to','fn_messenger_notification_visible_to',
      'fn_messenger_safe_accounting_preview','fn_messenger_private_message_page',
      'fn_messenger_private_search_messages','fn_messenger_private_accounting_threads',
      'fn_messenger_private_weekly_summary'))
 THEN RAISE EXCEPTION 'messenger_privacy_contract_already_exists'; END IF;
 -- The weekly wrapper requires the final v3 canonical reader, not the older
 -- union-only reader. Hash is prosrc extracted from the reviewed 14:22:56
 -- weekly-v3 component; it is source custody, not an installed readback claim.
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_club_weekly_accounting_summary(uuid)')
    AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='s' AND NOT p.proretset
    AND p.prorettype='jsonb'::regtype AND p.proconfig=ARRAY['search_path=public']
    AND md5(p.prosrc)='045a427e9ad0a0d9eddb08dca2a4bbb4')
 THEN RAISE EXCEPTION 'messenger_weekly_v3_summary_source_changed'; END IF;
 expected:=$party$
 SELECT DISTINCT p.id FROM public.profiles p WHERE p.id IN (
  SELECT p_id WHERE p_kind IN('agent','player')
  UNION SELECT c.owner_id FROM public.clubs c WHERE p_kind='club' AND c.id=p_id
  UNION SELECT m.user_id FROM public.club_members m WHERE p_kind='club' AND m.club_id=p_id
   AND m.role IN('owner','co_owner','admin') AND COALESCE(m.status,'active') IN('active','approved')
  UNION SELECT u.owner_id FROM public.unions u WHERE p_kind='union' AND u.id=p_id
  UNION SELECT a.user_id FROM public.union_admins a WHERE p_kind='union' AND a.union_id=p_id
   AND public.fn_is_union_overseer(p_id,a.user_id)
 );
$party$;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_accounting_party_users(text,uuid)')
    AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='s' AND p.proretset
    AND p.prorettype='uuid'::regtype AND p.proargnames=ARRAY['p_kind','p_id','user_id']
    AND p.proargmodes=ARRAY['i','i','t']::"char"[]
    AND p.proconfig=ARRAY['search_path=public'] AND p.prosrc=expected)
 OR has_function_privilege('anon','public.fn_accounting_party_users(text,uuid)','EXECUTE')
 OR has_function_privilege('authenticated','public.fn_accounting_party_users(text,uuid)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.fn_accounting_party_users(text,uuid)','EXECUTE')
 OR NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.settlement_periods'::regclass
    AND c.relowner='postgres'::regrole AND c.relkind='r' AND c.relrowsecurity AND NOT c.relforcerowsecurity)
 THEN RAISE EXCEPTION 'messenger_weekly_recipient_authority_changed'; END IF;
 -- Exact function bodies below are the reviewed 12:44 and 13:06 migration
 -- sources. Compare before rewriting; preserve owner, ACL and all attributes.
 FOR r IN SELECT * FROM (VALUES
 ('public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)', $page$
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
END $page$),
 ('public.fn_messenger_accounting_threads(uuid,uuid[])', $threads$
BEGIN
 IF p_user_id IS NULL OR p_conversation_ids IS NULL OR cardinality(p_conversation_ids)>200 THEN
  RAISE EXCEPTION 'invalid_accounting_thread_request' USING ERRCODE='22023'; END IF;
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR auth.uid()<>p_user_id) THEN
  RAISE EXCEPTION 'accounting_threads_not_authorised' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT c.conversation_id,
  EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d JOIN public.social_messages m ON m.id=d.message_id
    WHERE m.conversation_id=c.conversation_id AND d.recipient_id=p_user_id AND d.delivery_mode='immediate' AND COALESCE(m.is_deleted,false)=false),
  visible.content,visible.created_at
 FROM public.accounting_conversations c
 JOIN public.social_conversation_participants p ON p.conversation_id=c.conversation_id AND p.user_id=p_user_id
 LEFT JOIN LATERAL(SELECT m.content,m.created_at FROM public.social_messages m
   LEFT JOIN public.accounting_invoice_deliveries d ON d.message_id=m.id
   WHERE m.conversation_id=c.conversation_id AND COALESCE(m.is_deleted,false)=false
     AND COALESCE(d.delivery_mode,'immediate')<>'weekly_detail'
   ORDER BY m.created_at DESC,m.id DESC LIMIT 1) visible ON true
 WHERE c.conversation_id=ANY(p_conversation_ids) AND (c.sender_id=p_user_id OR c.recipient_id=p_user_id);
END $threads$)
 ) AS originals(signature,body) LOOP
   target_proc_oid:=to_regprocedure(r.signature);
   SELECT p.prosrc INTO actual FROM pg_proc p WHERE p.oid=target_proc_oid;
   IF actual IS DISTINCT FROM r.body OR NOT EXISTS(SELECT 1 FROM pg_proc p
       WHERE p.oid=target_proc_oid AND p.proowner='postgres'::regrole AND p.prosecdef
       AND p.provolatile='s' AND p.proretset AND p.proconfig=ARRAY['search_path=public'])
   THEN RAISE EXCEPTION 'messenger_reader_source_changed: %',r.signature; END IF;
 END LOOP;
 IF md5(pg_get_functiondef('public.fn_messenger_search_messages(uuid,uuid[],text,integer)'::regprocedure))
    IS DISTINCT FROM '8a435bb2242375fd1e00055cba8f50e0'
 THEN RAISE EXCEPTION 'messenger_search_source_changed'; END IF;
 FOR r IN SELECT unnest(ARRAY['public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)',
    'public.fn_messenger_accounting_threads(uuid,uuid[])','public.fn_messenger_search_messages(uuid,uuid[],text,integer)']) AS signature LOOP
   IF has_function_privilege('anon',r.signature,'EXECUTE')
      OR NOT has_function_privilege('authenticated',r.signature,'EXECUTE')
      OR NOT has_function_privilege('service_role',r.signature,'EXECUTE')
   THEN RAISE EXCEPTION 'messenger_reader_acl_changed: %',r.signature; END IF;
 END LOOP;
END $guard$;

-- One STABLE statement snapshot covers actual actor, exact recipient, recorded
-- period and canonical report. This wrapper does no accounting and writes none.
CREATE FUNCTION public.fn_messenger_private_weekly_summary(p_user_id uuid,p_club_id uuid,p_period_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE period public.settlement_periods%ROWTYPE; report jsonb; summary jsonb;
BEGIN
 IF p_user_id IS NULL OR p_club_id IS NULL OR p_period_id IS NULL
    OR (NOT public.fn_caller_is_engine() AND auth.uid() IS DISTINCT FROM p_user_id)
 THEN RAISE EXCEPTION 'weekly_summary_not_authorised' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.fn_accounting_party_users('club',p_club_id) u WHERE u.user_id=p_user_id)
    OR NOT EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=p_user_id
      AND m.is_active AND m.membership_lifecycle_status='active' AND m.status IN('active','approved'))
 THEN RAISE EXCEPTION 'weekly_summary_not_authorised' USING ERRCODE='42501'; END IF;
 SELECT * INTO period FROM public.settlement_periods WHERE id=p_period_id AND club_id=p_club_id;
 IF NOT FOUND OR period.start_at IS NULL OR period.end_at IS NULL
    OR NOT isfinite(period.start_at) OR NOT isfinite(period.end_at)
    OR period.start_at>=period.end_at OR period.end_at>now()
 THEN RAISE EXCEPTION 'weekly_summary_period_unavailable' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_periods other WHERE other.club_id=period.club_id
    AND other.end_at=period.end_at AND other.id<>period.id)
 THEN RAISE EXCEPTION 'weekly_summary_ambiguous_recorded_books' USING ERRCODE='22023'; END IF;
 report:=public.fn_club_weekly_accounting_summary(period.id);
 IF jsonb_typeof(report) IS DISTINCT FROM 'object'
    OR report->'accounting_version' IS DISTINCT FROM '3'::jsonb
    OR report->>'period_id' IS DISTINCT FROM period.id::text
    OR report->>'club_id' IS DISTINCT FROM period.club_id::text
    OR NOT (report ? 'union_id') OR report->>'union_id' IS DISTINCT FROM period.union_id::text
    OR report->>'scope_kind' IS DISTINCT FROM (CASE WHEN period.union_id IS NULL THEN 'club' ELSE 'union' END)
    OR report->>'scope_id' IS DISTINCT FROM COALESCE(period.union_id,period.club_id)::text
    OR report->>'currency' IS DISTINCT FROM 'CHIPS'
    OR COALESCE(report->>'status','') NOT IN('needs_reconciliation','complete')
    OR NOT COALESCE(pg_input_is_valid(report->>'period_start','timestamptz'),false)
    OR NOT COALESCE(pg_input_is_valid(report->>'period_end','timestamptz'),false)
 THEN RAISE EXCEPTION 'weekly_summary_contract_unavailable' USING ERRCODE='23514'; END IF;
 IF (report->>'period_start')::timestamptz IS DISTINCT FROM period.start_at
    OR (report->>'period_end')::timestamptz IS DISTINCT FROM period.end_at
    OR (report->>'status'='complete' AND report->'ready_to_issue' IS DISTINCT FROM 'true'::jsonb)
 THEN RAISE EXCEPTION 'weekly_summary_contract_unavailable' USING ERRCODE='23514'; END IF;
 -- Only aggregate scalar fields cross the Messenger boundary. Bank/source IDs,
 -- source fingerprints, recipient lists and per-tournament diagnostics stay in
 -- the canonical administrative report, never in this recipient preview.
 SELECT COALESCE(jsonb_object_agg(e.key,e.value),'{}'::jsonb) INTO summary
 FROM jsonb_each(report) e WHERE e.key=ANY(ARRAY[
  'accounting_version','scope_kind','scope_id','period_id','club_id','union_id','period_start','period_end','currency',
  'rake_earned','union_rake_earned','private_rake_earned','private_rake_banked','private_rake_burned','rake_received','expected_union_receipt',
  'total_rake_funding','paid_super_agents','paid_agents','paid_sub_agents','paid_players','paid_unclassified',
  'total_paid_by_club','retained_by_club','downstream_redistributed','downstream_paid_super_agents',
  'downstream_paid_agents','downstream_paid_sub_agents','downstream_paid_players','transfer_count','source_count',
  'unclassified_role_count','missing_period_count','receipt_issue_count','source_issue_count','certified_stage_count',
  'ready_to_issue','status','run_status','basis_source','note']) AND jsonb_typeof(e.value) NOT IN('object','array');
 RETURN jsonb_build_object('contract_version',1,'user_id',p_user_id,'club_id',p_club_id,'period_id',p_period_id,'summary',summary);
END $function$;
REVOKE ALL ON FUNCTION public.fn_messenger_private_weekly_summary(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_messenger_private_weekly_summary(uuid,uuid,uuid) TO authenticated,service_role;

-- This is an additional restriction, never a grant of invoice access. Existing
-- own-delivery / club-admin / union-overseer SELECT policies remain underneath.
CREATE FUNCTION public.fn_messenger_invoice_visible_to(p_invoice_id uuid,p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF p_user_id IS NULL OR (NOT public.fn_caller_is_engine() AND auth.uid() IS DISTINCT FROM p_user_id)
 THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM public.settlement_invoices i WHERE i.id=p_invoice_id
   AND (NOT (i.from_entity_type='club' AND i.to_entity_type IN('agent','player')
       AND i.source_ledger_id IS NOT NULL AND COALESCE(i.breakdown->>'category','') IN('rakeback','commission'))
     OR EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d
       WHERE d.invoice_id=i.id AND d.recipient_id=p_user_id AND d.delivery_mode='immediate')));
END $function$;

CREATE FUNCTION public.fn_messenger_message_visible_to(p_message_id uuid,p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF p_user_id IS NULL OR (NOT public.fn_caller_is_engine() AND auth.uid() IS DISTINCT FROM p_user_id)
 THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM public.social_messages m
   JOIN public.social_conversation_participants p ON p.conversation_id=m.conversation_id AND p.user_id=p_user_id
   LEFT JOIN public.accounting_invoice_deliveries d ON d.message_id=m.id
   WHERE m.id=p_message_id AND NOT COALESCE(m.is_deleted,false)
     AND COALESCE(d.delivery_mode,'immediate')<>'weekly_detail'
     AND (d.invoice_id IS NULL OR public.fn_messenger_invoice_visible_to(d.invoice_id,p_user_id)));
END $function$;

CREATE FUNCTION public.fn_messenger_notification_visible_to(p_notification_id uuid,p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF p_user_id IS NULL OR (NOT public.fn_caller_is_engine() AND auth.uid() IS DISTINCT FROM p_user_id)
 THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM public.notifications n
   LEFT JOIN public.accounting_invoice_deliveries d ON d.notification_id=n.id
   WHERE n.id=p_notification_id AND n.user_id=p_user_id AND n.type IS DISTINCT FROM 'accounting_invoice_detail'
     AND COALESCE(d.delivery_mode,'immediate')<>'weekly_detail'
     AND (d.invoice_id IS NULL OR public.fn_messenger_invoice_visible_to(d.invoice_id,p_user_id)));
END $function$;

REVOKE ALL ON FUNCTION public.fn_messenger_invoice_visible_to(uuid,uuid),
 public.fn_messenger_message_visible_to(uuid,uuid),public.fn_messenger_notification_visible_to(uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_messenger_invoice_visible_to(uuid,uuid),
 public.fn_messenger_message_visible_to(uuid,uuid),public.fn_messenger_notification_visible_to(uuid,uuid)
 TO authenticated,service_role;

CREATE POLICY messenger_private_invoice_content ON public.settlement_invoices AS RESTRICTIVE
 FOR SELECT TO authenticated USING(public.fn_messenger_invoice_visible_to(id,(SELECT auth.uid())));
CREATE POLICY messenger_private_message_content ON public.social_messages AS RESTRICTIVE
 FOR SELECT TO authenticated USING(public.fn_messenger_message_visible_to(id,(SELECT auth.uid())));
CREATE POLICY messenger_private_delivery_content ON public.accounting_invoice_deliveries AS RESTRICTIVE
 FOR SELECT TO authenticated USING(delivery_mode='immediate' AND public.fn_messenger_invoice_visible_to(invoice_id,(SELECT auth.uid())));
CREATE POLICY messenger_private_notification_content ON public.notifications AS RESTRICTIVE
 FOR SELECT TO authenticated USING(public.fn_messenger_notification_visible_to(id,(SELECT auth.uid())));
CREATE POLICY messenger_no_anonymous_invoice_content ON public.settlement_invoices AS RESTRICTIVE FOR SELECT TO anon USING(false);
CREATE POLICY messenger_no_anonymous_message_content ON public.social_messages AS RESTRICTIVE FOR SELECT TO anon USING(false);
CREATE POLICY messenger_no_anonymous_delivery_content ON public.accounting_invoice_deliveries AS RESTRICTIVE FOR SELECT TO anon USING(false);
CREATE POLICY messenger_no_anonymous_notification_content ON public.notifications AS RESTRICTIVE FOR SELECT TO anon USING(false);

-- Shared table preview cannot contain recipient-specific invoice text. Readers
-- above compute each participant's permitted preview from actual messages.
CREATE FUNCTION public.fn_messenger_safe_accounting_preview() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM public.accounting_conversations c WHERE c.conversation_id=NEW.id)
 THEN NEW.last_message_preview:='Accounting Conversation'; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_messenger_safe_accounting_preview() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER messenger_safe_accounting_preview BEFORE INSERT OR UPDATE OF last_message_preview
 ON public.social_conversations FOR EACH ROW EXECUTE FUNCTION public.fn_messenger_safe_accounting_preview();
UPDATE public.social_conversations c SET last_message_preview='Accounting Conversation'
 WHERE EXISTS(SELECT 1 FROM public.accounting_conversations ac WHERE ac.conversation_id=c.id)
   AND c.last_message_preview IS DISTINCT FROM 'Accounting Conversation';

DO $rewrite$
DECLARE signature text; definition text; anchor text:='AND COALESCE(d.delivery_mode,''immediate'')<>''weekly_detail''';
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)',
   'public.fn_messenger_search_messages(uuid,uuid[],text,integer)','public.fn_messenger_accounting_threads(uuid,uuid[])'] LOOP
   definition:=pg_get_functiondef(signature::regprocedure);
   IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
   THEN RAISE EXCEPTION 'messenger_private_filter_anchor_changed: %',signature; END IF;
   EXECUTE replace(definition,anchor,anchor||E'\n     AND public.fn_messenger_message_visible_to(m.id,p_user_id)');
 END LOOP;
END $rewrite$;

-- New entry names make old database installations fail closed at the caller.
-- Old entry names remain protected for direct authenticated RPC clients.
CREATE FUNCTION public.fn_messenger_private_message_page(p_user_id uuid,p_conversation_id uuid,
 p_before timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid,conversation_id uuid,sender_id uuid,content text,message_type text,media_metadata jsonb,
 created_at timestamptz,updated_at timestamptz,is_deleted boolean,is_edited boolean,profiles jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $function$
 SELECT * FROM public.fn_messenger_message_page(p_user_id,p_conversation_id,p_before,p_before_id,p_limit);
$function$;
CREATE FUNCTION public.fn_messenger_private_search_messages(p_user_id uuid,p_conversation_ids uuid[],p_query text,p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid,conversation_id uuid,sender_id uuid,content text,created_at timestamptz,message_type text,media_metadata jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $function$
 SELECT * FROM public.fn_messenger_search_messages(p_user_id,p_conversation_ids,p_query,p_limit);
$function$;
CREATE FUNCTION public.fn_messenger_private_accounting_threads(p_user_id uuid,p_conversation_ids uuid[])
RETURNS TABLE(conversation_id uuid,recipient_visible boolean,last_message_preview text,last_message_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $function$
 SELECT * FROM public.fn_messenger_accounting_threads(p_user_id,p_conversation_ids);
$function$;
REVOKE ALL ON FUNCTION public.fn_messenger_private_message_page(uuid,uuid,timestamptz,uuid,integer),
 public.fn_messenger_private_search_messages(uuid,uuid[],text,integer),public.fn_messenger_private_accounting_threads(uuid,uuid[])
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_messenger_private_message_page(uuid,uuid,timestamptz,uuid,integer),
 public.fn_messenger_private_search_messages(uuid,uuid[],text,integer),public.fn_messenger_private_accounting_threads(uuid,uuid[])
 TO authenticated,service_role;
COMMIT;

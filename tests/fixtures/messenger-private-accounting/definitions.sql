\set ON_ERROR_STOP on
-- Exact captured reader definitions; UNRUN, no calls or helper substitutions.
-- Load schema.sql first, then access.sql immediately after this file.
CREATE OR REPLACE FUNCTION public.fn_messenger_message_page(p_user_id uuid, p_conversation_id uuid, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, conversation_id uuid, sender_id uuid, content text, message_type text, media_metadata jsonb, created_at timestamp with time zone, updated_at timestamp with time zone, is_deleted boolean, is_edited boolean, profiles jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

CREATE OR REPLACE FUNCTION public.fn_messenger_accounting_threads(p_user_id uuid, p_conversation_ids uuid[])
 RETURNS TABLE(conversation_id uuid, recipient_visible boolean, last_message_preview text, last_message_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END $function$;

CREATE OR REPLACE FUNCTION public.fn_messenger_search_messages(p_user_id uuid, p_conversation_ids uuid[], p_query text, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, conversation_id uuid, sender_id uuid, content text, created_at timestamp with time zone, message_type text, media_metadata jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_conversation_ids IS NULL OR
    cardinality(p_conversation_ids)>500 OR cardinality(p_conversation_ids)<1 OR
    p_query IS NULL OR length(btrim(p_query))<2 OR length(p_query)>500 THEN
   RAISE EXCEPTION 'invalid_message_search' USING ERRCODE='22023'; END IF;
 IF (NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR auth.uid()<>p_user_id)) OR
    EXISTS(SELECT 1 FROM unnest(p_conversation_ids) AS requested(conversation_id)
      WHERE NOT EXISTS(SELECT 1 FROM public.social_conversation_participants p
        WHERE p.user_id=p_user_id AND p.conversation_id=requested.conversation_id)) THEN
   RAISE EXCEPTION 'message_search_not_authorised' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT m.id,m.conversation_id,m.sender_id,m.content,m.created_at,
   CASE WHEN m.message_type='invoice' AND i.id IS NULL THEN 'text' ELSE m.message_type END,
   COALESCE(m.media_metadata,'{}')||CASE WHEN i.id IS NULL THEN jsonb_build_object('accounting_verified',false)
     ELSE jsonb_build_object('accounting_verified',true,'invoice_id',i.id,'issued_status',m.media_metadata->'status',
       'status',i.status,'chips_transferred',i.chips_transferred) END
 FROM public.social_messages m
 LEFT JOIN public.accounting_invoice_deliveries d ON d.message_id=m.id
 LEFT JOIN public.settlement_invoices i ON i.id=d.invoice_id
 WHERE m.conversation_id=ANY(p_conversation_ids) AND COALESCE(m.is_deleted,false)=false
   AND COALESCE(d.delivery_mode,'immediate')<>'weekly_detail'
   AND strpos(lower(m.content),lower(btrim(p_query)))>0
 ORDER BY m.created_at DESC,m.id DESC LIMIT p_limit;
END $function$;

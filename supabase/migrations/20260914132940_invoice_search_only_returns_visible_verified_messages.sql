-- Message search uses the same participant scope, invoice provenance and
-- archived club-detail exclusion as message paging, before applying the limit.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.fn_messenger_search_messages(p_user_id uuid, p_conversation_ids uuid[], p_query text, p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid, conversation_id uuid, sender_id uuid, content text, created_at timestamptz, message_type text, media_metadata jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
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
REVOKE ALL ON FUNCTION public.fn_messenger_search_messages(uuid,uuid[],text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_messenger_search_messages(uuid,uuid[],text,integer) TO authenticated,service_role;

COMMIT;

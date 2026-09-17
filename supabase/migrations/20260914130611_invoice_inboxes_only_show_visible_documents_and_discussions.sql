BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.fn_messenger_accounting_threads(p_user_id uuid,p_conversation_ids uuid[])
RETURNS TABLE(conversation_id uuid,recipient_visible boolean,last_message_preview text,last_message_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
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
REVOKE ALL ON FUNCTION public.fn_messenger_accounting_threads(uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_messenger_accounting_threads(uuid,uuid[]) TO authenticated,service_role;
COMMIT;

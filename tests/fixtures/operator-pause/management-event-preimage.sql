CREATE OR REPLACE FUNCTION public.fn_emit_game_management_event(
  p_event_type text,
  p_club_id uuid DEFAULT NULL,
  p_union_id uuid DEFAULT NULL,
  p_recipient_id uuid DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_command_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_scope_kind text; v_scope_id uuid; v_union_id uuid;
BEGIN
  IF p_union_id IS NOT NULL THEN
    v_scope_kind := 'union'; v_scope_id := p_union_id; v_union_id := p_union_id;
  ELSIF p_club_id IS NOT NULL THEN
    SELECT s.scope_kind,s.scope_id,s.union_id
      INTO v_scope_kind,v_scope_id,v_union_id
      FROM public.fn_game_management_scope(p_club_id) s;
  END IF;
  INSERT INTO public.game_management_events(
    event_type,scope_kind,scope_id,club_id,union_id,recipient_id,
    entity_type,entity_id,command_id,actor_id,payload
  ) VALUES (
    p_event_type,v_scope_kind,v_scope_id,p_club_id,v_union_id,p_recipient_id,
    p_entity_type,p_entity_id,p_command_id,auth.uid(),COALESCE(p_payload,'{}'::jsonb)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_emit_game_management_event(text,uuid,uuid,uuid,text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_emit_game_management_event(text,uuid,uuid,uuid,text,uuid,uuid,jsonb) TO service_role;

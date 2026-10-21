CREATE OR REPLACE FUNCTION public.fn_audit_club_entry_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_action text; v_club uuid; v_target uuid; v_actor uuid; v_details jsonb;
BEGIN
  IF TG_TABLE_NAME='clubs' THEN
    v_action:='club_created'; v_club:=NEW.id; v_target:=NEW.id;
    v_actor:=COALESCE(auth.uid(),NEW.owner_id);
    v_details:=jsonb_build_object('club_code',NEW.club_id,'requires_approval',NEW.requires_approval);
  ELSIF TG_TABLE_NAME='club_members' THEN
    v_club:=NEW.club_id; v_target:=NEW.user_id;
    v_actor:=COALESCE(auth.uid(),NEW.user_id);
    v_action:=CASE WHEN TG_OP='INSERT' THEN 'club_join_'||NEW.status ELSE 'club_join_status_changed' END;
    v_details:=jsonb_build_object('status',NEW.status,'previous_status',CASE WHEN TG_OP='UPDATE' THEN OLD.status ELSE NULL END);
  ELSE
    v_action:='player_search_privacy_changed'; v_target:=NEW.user_id;
    v_actor:=COALESCE(auth.uid(),NEW.user_id);
    v_details:=jsonb_build_object('discoverable',NEW.discoverable,'show_presence',NEW.show_presence,'show_current_table',NEW.show_current_table);
  END IF;
  INSERT INTO public.audit_trail(
    club_id,actor_id,actor_role,action,target_type,target_id,after_state
  ) VALUES(
    v_club,v_actor,'system',v_action,TG_TABLE_NAME,v_target,jsonb_strip_nulls(v_details)
  );
  RETURN NEW;
END $function$
;

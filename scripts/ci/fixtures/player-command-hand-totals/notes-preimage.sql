CREATE OR REPLACE FUNCTION public.ca_club_member_notes_update(p_club_id uuid, p_target_user_id uuid, p_nickname text, p_remark text, p_request_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[] := public.fn_club_scope_ids(p_club_id);
  v_access text;
  v_member_club uuid;
  v_before_nickname text;
  v_before_remark text;
  v_after_nickname text := nullif(btrim(left(coalesce(p_nickname, ''), 64)), '');
  v_after_remark text := nullif(btrim(left(coalesce(p_remark, ''), 240)), '');
  v_actor_role text;
  v_request_id text := nullif(left(btrim(coalesce(p_request_id, '')), 128), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Member Note Updates Require An Auditable Actor';
  END IF;

  v_access := public.ca_club_roster_access(p_club_id, p_target_user_id);
  IF v_actor = p_target_user_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Member Notes Are Private Staff Context, Not Self-Editable Profile Fields';
  END IF;
  IF v_access NOT IN ('staff', 'downline', 'service') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'You Do Not Have Permission To Edit These Notes';
  END IF;

  IF v_request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.audit_trail a
     WHERE a.actor_id IS NOT DISTINCT FROM v_actor
       AND a.action = 'update_member_notes'
       AND a.target_id = p_target_user_id
       AND a.club_id = p_club_id
       AND a.request_id = v_request_id
  ) THEN
    SELECT cm.nickname, cm.notes
      INTO v_after_nickname, v_after_remark
      FROM public.club_members cm
     WHERE cm.user_id = p_target_user_id AND cm.club_id = ANY(v_scope)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
     LIMIT 1;
    RETURN jsonb_build_object(
      'success', true, 'replayed', true,
      'nickname', v_after_nickname, 'remark', v_after_remark
    );
  END IF;

  SELECT cm.club_id, cm.nickname, cm.notes
    INTO v_member_club, v_before_nickname, v_before_remark
    FROM public.club_members cm
   WHERE cm.user_id = p_target_user_id AND cm.club_id = ANY(v_scope)
     AND coalesce(cm.status, 'approved') IN ('active', 'approved')
   ORDER BY public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
   LIMIT 1 FOR UPDATE;

  IF v_member_club IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Member Not Found');
  END IF;

  PERFORM set_config('app.club_notes_update', 'on', true);
  UPDATE public.club_members
     SET nickname = v_after_nickname, notes = v_after_remark, updated_at = now()
   WHERE club_id = v_member_club AND user_id = p_target_user_id;
  PERFORM set_config('app.club_notes_update', '', true);

  SELECT cm.role INTO v_actor_role FROM public.club_members cm
   WHERE cm.user_id = v_actor AND cm.club_id = ANY(v_scope)
   ORDER BY public.fn_club_role_rank(cm.role) DESC LIMIT 1;

  INSERT INTO public.audit_trail (
    actor_id, actor_role, action, target_type, target_id, club_id,
    before_state, after_state, reason, request_id
  ) VALUES (
    v_actor, coalesce(v_actor_role, 'service_role'), 'update_member_notes',
    'club_member', p_target_user_id, p_club_id,
    jsonb_build_object(
      'nickname_present', v_before_nickname IS NOT NULL,
      'remark_present', v_before_remark IS NOT NULL,
      'nickname_length', length(coalesce(v_before_nickname, '')),
      'remark_length', length(coalesce(v_before_remark, ''))
    ),
    jsonb_build_object(
      'nickname_present', v_after_nickname IS NOT NULL,
      'remark_present', v_after_remark IS NOT NULL,
      'nickname_length', length(coalesce(v_after_nickname, '')),
      'remark_length', length(coalesce(v_after_remark, ''))
    ),
    'Authorized Member Note Update', v_request_id
  );

  RETURN jsonb_build_object(
    'success', true, 'replayed', false,
    'nickname', v_after_nickname, 'remark', v_after_remark
  );
END
$function$;

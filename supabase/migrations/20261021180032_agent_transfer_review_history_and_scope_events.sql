-- Staff-reviewed assignment, searchable history and recipient-only scope invalidation.
-- Existing installed migrations remain immutable. No balances or financial history change.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.club_assignment_operations ADD COLUMN review_snapshot jsonb;
CREATE INDEX club_assignment_history_page_idx ON public.club_assignment_operations(club_id,created_at DESC,id DESC);

-- A recipient can still read this generic event after losing access to moved players.
-- Deterministic event identity coalesces a bulk transaction to one event per affected viewer.
CREATE OR REPLACE FUNCTION public.fn_publish_club_member_scope(p_club uuid,p_roots uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE recipient uuid;
BEGIN
 FOR recipient IN
 INSERT INTO public.game_management_events(event_id,event_type,scope_kind,scope_id,club_id,recipient_id,entity_type,entity_id,payload)
 WITH RECURSIVE uplines(user_id,depth,path) AS (
  SELECT DISTINCT r,0,ARRAY[r] FROM unnest(p_roots) r WHERE r IS NOT NULL
  UNION ALL
  SELECT m.agent_id,u.depth+1,u.path||m.agent_id FROM uplines u
  JOIN public.club_members m ON m.club_id=p_club AND m.user_id=u.user_id
  WHERE m.agent_id IS NOT NULL AND u.depth<20 AND NOT m.agent_id=ANY(u.path)
 )
 SELECT md5('club-private-scope:'||txid_current()::text||':'||p_club::text||':'||user_id::text)::uuid,
  'management_access_changed','club',p_club,p_club,user_id,'club',p_club,
  jsonb_build_object('reason','member_scope_changed') FROM (SELECT DISTINCT user_id FROM uplines) x
 ON CONFLICT(event_id) DO NOTHING RETURNING recipient_id
 LOOP
  -- Reuse the existing exact-owner private account carrier. The hot event table
  -- stays out of the WAL publication and carries no foreign player's identity.
  PERFORM realtime.send(jsonb_build_object('user_id',recipient,'club_id',p_club,
    'reason','member_scope_changed','domains','[]'::jsonb),
    'account_changed','profile-account:'||recipient::text,true);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.fn_publish_club_member_scope(uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_publish_club_member_scope(uuid,uuid[]) TO service_role;
DO $$ BEGIN IF md5(pg_get_functiondef('fn_emit_management_access_event()'::regprocedure)) <> '9963925e6cd6da557b9de6f1749db0fd' THEN RAISE EXCEPTION 'ASSIGNMENT_EVENT_SOURCE_CHANGED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_emit_management_access_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_recipient uuid;
  v_club uuid;
  v_union uuid;
  v_operation text := lower(TG_OP);
BEGIN
  IF TG_TABLE_NAME = 'club_members' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.role IS NOT DISTINCT FROM OLD.role
       AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
       AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
       AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active
       AND NEW.agent_id IS NOT DISTINCT FROM OLD.agent_id THEN
      RETURN NULL;
    END IF;

    IF TG_OP='UPDATE' THEN
      IF NEW.club_id IS DISTINCT FROM OLD.club_id THEN
        PERFORM public.fn_publish_club_member_scope(OLD.club_id,ARRAY[OLD.user_id,OLD.agent_id]);
      END IF;
      PERFORM public.fn_publish_club_member_scope(NEW.club_id,ARRAY[NEW.user_id,OLD.agent_id,NEW.agent_id]);
    ELSIF TG_OP='DELETE' THEN
      PERFORM public.fn_publish_club_member_scope(OLD.club_id,ARRAY[OLD.user_id,OLD.agent_id]);
    ELSE
      PERFORM public.fn_publish_club_member_scope(NEW.club_id,ARRAY[NEW.user_id,NEW.agent_id]);
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed', OLD.club_id, NULL, OLD.user_id,
        'club', OLD.club_id, NULL,
        jsonb_build_object('operation', v_operation, 'side', 'before'));
    END IF;
    IF TG_OP IN ('UPDATE', 'INSERT')
       AND (TG_OP = 'INSERT'
            OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.club_id IS DISTINCT FROM OLD.club_id
            OR NEW.role IS DISTINCT FROM OLD.role
            OR NEW.status IS DISTINCT FROM OLD.status
            OR NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
      -- When the row identity did not move, one after-event is sufficient.
      IF TG_OP = 'INSERT'
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.club_id IS DISTINCT FROM OLD.club_id THEN
        PERFORM public.fn_emit_game_management_event(
          'management_access_changed', NEW.club_id, NULL, NEW.user_id,
          'club', NEW.club_id, NULL,
          jsonb_build_object('operation', v_operation, 'side', 'after'));
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'union_admins' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
       AND NEW.union_id IS NOT DISTINCT FROM OLD.union_id
       AND NEW.role IS NOT DISTINCT FROM OLD.role THEN
      RETURN NULL;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed', NULL, OLD.union_id, OLD.user_id,
        'union', OLD.union_id, NULL,
        jsonb_build_object('operation', v_operation, 'side', 'before'));
    END IF;
    IF TG_OP = 'INSERT'
       OR (TG_OP = 'UPDATE' AND (
         NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.union_id IS DISTINCT FROM OLD.union_id)) THEN
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed', NULL, NEW.union_id, NEW.user_id,
        'union', NEW.union_id, NULL,
        jsonb_build_object('operation', v_operation, 'side', 'after'));
    END IF;

  ELSE
    -- union_clubs. UPDATE was omitted from the original trigger entirely.
    -- Each side gets its own recipient set and its own union scope.
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      v_club := OLD.club_id;
      v_union := OLD.union_id;
      FOR v_recipient IN
        SELECT c.owner_id FROM public.clubs c WHERE c.id = v_club
        UNION SELECT m.user_id FROM public.club_members m
          WHERE m.club_id = v_club
            AND m.role IN ('owner','co_owner','admin')
            AND m.status IN ('active','approved')
            AND COALESCE(m.is_active, true)
        UNION SELECT u.owner_id FROM public.unions u WHERE u.id = v_union
        UNION SELECT a.user_id FROM public.union_admins a WHERE a.union_id = v_union
      LOOP
        PERFORM public.fn_emit_game_management_event(
          'management_access_changed', v_club, v_union, v_recipient,
          'club', v_club, NULL,
          jsonb_build_object('operation', v_operation, 'side', 'before'));
      END LOOP;
    END IF;

    IF TG_OP IN ('UPDATE', 'INSERT') THEN
      v_club := NEW.club_id;
      v_union := NEW.union_id;
      FOR v_recipient IN
        SELECT c.owner_id FROM public.clubs c WHERE c.id = v_club
        UNION SELECT m.user_id FROM public.club_members m
          WHERE m.club_id = v_club
            AND m.role IN ('owner','co_owner','admin')
            AND m.status IN ('active','approved')
            AND COALESCE(m.is_active, true)
        UNION SELECT u.owner_id FROM public.unions u WHERE u.id = v_union
        UNION SELECT a.user_id FROM public.union_admins a WHERE a.union_id = v_union
      LOOP
        PERFORM public.fn_emit_game_management_event(
          'management_access_changed', v_club, v_union, v_recipient,
          'club', v_club, NULL,
          jsonb_build_object('operation', v_operation, 'side', 'after'));
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$
;

DO $$ BEGIN IF md5(pg_get_functiondef('fn_club_is_in_downline(uuid,uuid,uuid)'::regprocedure)) <> '038be1f54953d43ce7dc02be6fc3015c' THEN RAISE EXCEPTION 'DOWNLINE_LOOKUP_SOURCE_CHANGED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_club_is_in_downline(p_club_id uuid,p_upline_user_id uuid,p_member_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE chain(parent,depth,path) AS (
  SELECT m.agent_id,1,ARRAY[m.user_id] FROM public.club_members m
  WHERE m.club_id=p_club_id AND m.user_id=p_member_user_id AND m.agent_id IS NOT NULL
   AND p_upline_user_id IS NOT NULL AND p_member_user_id IS NOT NULL AND p_upline_user_id<>p_member_user_id
   AND public.fn_cashier_member_is_active(m.club_id,m.user_id)
  UNION ALL
  SELECT m.agent_id,c.depth+1,c.path||m.user_id FROM chain c
  JOIN public.club_members m ON m.club_id=p_club_id AND m.user_id=c.parent
  WHERE c.depth<20 AND m.agent_id IS NOT NULL AND NOT m.user_id=ANY(c.path)
   AND public.fn_cashier_member_is_active(m.club_id,m.user_id)
 ) SELECT EXISTS(SELECT 1 FROM chain WHERE parent=p_upline_user_id)
$$;
REVOKE ALL ON FUNCTION public.fn_club_is_in_downline(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_is_in_downline(uuid,uuid,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_preview_club_assignment(p_club_id uuid,p_member_user_ids uuid[],p_agent_user_id uuid,p_expected_agent_user_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ids uuid[]; snapshot jsonb; fingerprint text; affected integer; destination jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(public.fn_can_manage_club_assignments(p_club_id),false) THEN
  RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 ids:=ARRAY(SELECT DISTINCT x FROM unnest(p_member_user_ids) x WHERE x IS NOT NULL ORDER BY x);
 IF cardinality(ids)<1 OR cardinality(ids)>10000 OR p_agent_user_id IS NULL THEN
  RAISE EXCEPTION 'invalid_assignment_selection' USING ERRCODE='22023'; END IF;
 IF p_agent_user_id=ANY(ids) THEN RAISE EXCEPTION 'agent_cannot_report_to_itself' USING ERRCODE='22023'; END IF;
 SELECT jsonb_build_object('user_id',m.user_id,'name',COALESCE(NULLIF(btrim(p.alias),''),NULLIF(btrim(p.username),''),'Player'),'role',m.role)
 INTO destination FROM public.club_members m JOIN public.agents a ON a.club_id=m.club_id AND a.user_id=m.user_id
 LEFT JOIN public.profiles p ON p.id=m.user_id
 WHERE m.club_id=p_club_id AND m.user_id=p_agent_user_id AND a.status='active' AND m.role IN ('super_agent','agent','sub_agent')
 AND public.fn_cashier_member_is_active(m.club_id,m.user_id);
 IF destination IS NULL THEN RAISE EXCEPTION 'agent_not_active_in_club' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=ANY(ids)
  AND public.fn_cashier_member_is_active(m.club_id,m.user_id) AND m.role IN ('member','player','super_agent','agent','sub_agent'))<>cardinality(ids) THEN
  RAISE EXCEPTION 'member_not_active_in_club' USING ERRCODE='22023'; END IF;
 IF p_expected_agent_user_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=ANY(ids)
  AND m.agent_id IS DISTINCT FROM p_expected_agent_user_id) THEN RAISE EXCEPTION 'assignment_changed_reload_members' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ids) x WHERE public.fn_club_is_in_downline(p_club_id,x,p_agent_user_id)) THEN
  RAISE EXCEPTION 'would_create_cycle' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=ANY(ids)
  AND m.role IN ('super_agent','agent','sub_agent') AND public.fn_club_role_rank(m.role)>=public.fn_club_role_rank(destination->>'role')) THEN
  RAISE EXCEPTION 'upline_role_must_rank_above_downline' USING ERRCODE='22023'; END IF;
 SELECT jsonb_agg(jsonb_build_object('user_id',m.user_id,'name',COALESCE(NULLIF(btrim(p.alias),''),NULLIF(btrim(p.username),''),'Player'),
  'role',m.role,'source_user_id',m.agent_id,'source_name',COALESCE(NULLIF(btrim(source.alias),''),NULLIF(btrim(source.username),''),'Unassigned')) ORDER BY m.user_id)
 INTO snapshot FROM public.club_members m LEFT JOIN public.profiles p ON p.id=m.user_id LEFT JOIN public.profiles source ON source.id=m.agent_id
 WHERE m.club_id=p_club_id AND m.user_id=ANY(ids);
 WITH RECURSIVE descendants(user_id,path,depth) AS (
  SELECT x,ARRAY[x],0 FROM unnest(ids) x
  UNION ALL
  SELECT m.user_id,d.path||m.user_id,d.depth+1 FROM descendants d JOIN public.club_members m ON m.club_id=p_club_id AND m.agent_id=d.user_id
  WHERE d.depth<20 AND NOT m.user_id=ANY(d.path) AND public.fn_cashier_member_is_active(m.club_id,m.user_id)
 ) SELECT count(DISTINCT user_id) INTO affected FROM descendants;
 -- Only hierarchy/activity participates: ordinary chip changes cannot invalidate a review.
 SELECT md5(jsonb_build_object('club',p_club_id,'ids',ids,'target',p_agent_user_id,'source',p_expected_agent_user_id,
  'hierarchy',jsonb_agg(jsonb_build_array(m.user_id,m.agent_id,m.role,m.status,a.status,COALESCE(profile_state.status='deleted',false)) ORDER BY m.user_id))::text)
 INTO fingerprint FROM public.club_members m LEFT JOIN public.agents a ON a.club_id=m.club_id AND a.user_id=m.user_id LEFT JOIN public.profiles profile_state ON profile_state.id=m.user_id WHERE m.club_id=p_club_id;
 RETURN jsonb_build_object('club_id',p_club_id,'review_token',fingerprint,'destination',destination,'members',snapshot,'selected_count',cardinality(ids),'affected_count',affected);
END $$;
REVOKE ALL ON FUNCTION public.fn_preview_club_assignment(uuid,uuid[],uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_preview_club_assignment(uuid,uuid[],uuid,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_apply_reviewed_club_assignment(p_club_id uuid,p_member_user_ids uuid[],p_agent_user_id uuid,p_op_id uuid,p_review_token text,p_expected_agent_user_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE review jsonb; receipt jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(public.fn_can_manage_club_assignments(p_club_id),false) THEN RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
 -- The original durable receipt owns retries even after the hierarchy has changed.
 IF EXISTS(SELECT 1 FROM public.club_assignment_operations WHERE id=p_op_id) THEN
  RETURN public.fn_reassign_club_members(p_club_id,p_member_user_ids,p_agent_user_id,p_op_id,p_expected_agent_user_id);
 END IF;
 review:=public.fn_preview_club_assignment(p_club_id,p_member_user_ids,p_agent_user_id,p_expected_agent_user_id);
 IF p_review_token IS NULL OR p_review_token IS DISTINCT FROM review->>'review_token' THEN
  RAISE EXCEPTION 'assignment_review_changed_preview_again' USING ERRCODE='22023'; END IF;
 receipt:=public.fn_reassign_club_members(p_club_id,p_member_user_ids,p_agent_user_id,p_op_id,p_expected_agent_user_id);
 UPDATE public.club_assignment_operations SET review_snapshot=review WHERE id=p_op_id AND actor_id=auth.uid();
 RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.fn_apply_reviewed_club_assignment(uuid,uuid[],uuid,uuid,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_apply_reviewed_club_assignment(uuid,uuid[],uuid,uuid,text,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_club_assignment_history(p_club_id uuid,p_search text DEFAULT '',p_before_at timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL,p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rows jsonb; search text:=left(btrim(COALESCE(p_search,'')),100); take integer:=greatest(1,least(COALESCE(p_limit,25),50));
BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(public.fn_can_manage_club_assignments(p_club_id),false) THEN RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 IF (p_before_at IS NULL)<>(p_before_id IS NULL) THEN RAISE EXCEPTION 'history_cursor_incomplete' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_agg(x.row ORDER BY x.created_at DESC,x.id DESC),'[]'::jsonb) INTO rows FROM (
  SELECT o.id,o.created_at,jsonb_build_object('operation_id',o.id,'created_at',o.created_at,
   'actor_name',COALESCE(NULLIF(btrim(actor.alias),''),NULLIF(btrim(actor.username),''),'Staff'),
   'source_name',COALESCE(NULLIF(btrim(source.alias),''),NULLIF(btrim(source.username),''),'Multiple Or Unrecorded Sources'),
   'destination_name',COALESCE(NULLIF(btrim(dest.alias),''),NULLIF(btrim(dest.username),''),'Agent'),
   'moved',cardinality(o.member_user_ids),'review',o.review_snapshot) AS row
  FROM public.club_assignment_operations o LEFT JOIN public.profiles actor ON actor.id=o.actor_id
   LEFT JOIN public.profiles source ON source.id=o.source_user_id LEFT JOIN public.profiles dest ON dest.id=o.destination_user_id
  WHERE o.club_id=p_club_id AND (p_before_at IS NULL OR (o.created_at,o.id)<(p_before_at,p_before_id))
   AND (search='' OR o.id::text ILIKE '%'||search||'%' OR COALESCE(actor.alias,actor.username,'') ILIKE '%'||search||'%'
    OR COALESCE(source.alias,source.username,'') ILIKE '%'||search||'%' OR COALESCE(dest.alias,dest.username,'') ILIKE '%'||search||'%'
    OR EXISTS(SELECT 1 FROM unnest(o.member_user_ids) selected(user_id) LEFT JOIN public.profiles p ON p.id=selected.user_id
      WHERE selected.user_id::text ILIKE '%'||search||'%' OR COALESCE(p.alias,p.username,'') ILIKE '%'||search||'%'))
  ORDER BY o.created_at DESC,o.id DESC LIMIT take+1
 ) x;
 RETURN jsonb_build_object('rows',rows,'page_size',take);
END $$;
REVOKE ALL ON FUNCTION public.fn_club_assignment_history(uuid,text,timestamptz,uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_assignment_history(uuid,text,timestamptz,uuid,integer) TO authenticated,service_role;
COMMIT;
